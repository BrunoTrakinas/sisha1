const supabase = require('../config/supabaseClient');
const equipmentService = require('./equipmentService');

function cleanText(value) {
  const text = String(value ?? '').trim();
  return text || null;
}

function normalizeCode(value) {
  const text = cleanText(value);
  return text ? text.toUpperCase() : null;
}

function normalizeSn(value) {
  const text = normalizeCode(value);
  if (!text || ['N/A', 'NA', 'S/N', 'SN', 'N.I', 'N/I', '-'].includes(text)) return null;
  return text.replace(/\s+/g, '');
}

function normalizePn(value) {
  return normalizeCode(value);
}

function normalizeDateTime(value) {
  const text = cleanText(value);
  if (!text) return null;
  const dt = new Date(text);
  if (Number.isNaN(dt.getTime())) return null;
  return dt.toISOString();
}

function statusText(row = {}) {
  return [row.status, row.lh_updates, row.bn_comments, row.lh_action, row.gate_description]
    .filter(Boolean)
    .join(' | ')
    .toUpperCase();
}

function isDelivered(row = {}) {
  const text = statusText(row);
  return /\bDELIVERED\b|\bDELIVERY COMPLETE\b|\bRETURNED\b|\bBACK INTO COUNTRY\b/.test(text);
}

function isOnDelivery(row = {}) {
  const text = statusText(row);
  return /ON DELIVERY|IN TRANSIT|SHIPPED|REGRESS|AWAITING COLLECTION/.test(text) && !isDelivered(row);
}

function isClosed(row = {}) {
  return /\bCLOSED\b|\bCOMPLETE\b/.test(statusText(row));
}

function extractDateFromText(value) {
  const text = String(value || '');
  const match = text.match(/\b(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{2}|\d{4})\b/);
  if (!match) return null;
  let [, d, m, y] = match;
  if (y.length === 2) y = Number(y) > 50 ? `19${y}` : `20${y}`;
  const iso = `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  return normalizeDateTime(`${iso}T12:00:00Z`);
}

function logicalRef(row = {}) {
  return cleanText(row.documento_referencia)
    || cleanText(row.notification)
    || cleanText(row.delivery_number)
    || cleanText(row.customer_ref)
    || `${row.source_sheet || 'ORDER_BOOK'}:${row.source_row || 'ROW'}`;
}

function sourceKey(row, stage, extra = '') {
  const parts = [
    'ORDER_BOOK',
    normalizeCode(row.source_sheet) || 'SHEET',
    normalizeCode(logicalRef(row)) || 'SEM_REF',
    normalizePn(row.pn) || 'SEM_PN',
    normalizeSn(row.sn) || 'SEM_SN',
    normalizeCode(stage) || 'EVENTO',
    normalizeCode(extra) || '',
  ];
  return parts.join(':').replace(/\s+/g, '_').slice(0, 220);
}

function orderBookPayload(row = {}, extra = {}) {
  return {
    order_book: {
      source_sheet: row.source_sheet || null,
      source_row: row.source_row || null,
      snapshot_date: row.snapshot_date || null,
      documento_referencia: row.documento_referencia || null,
      notification: row.notification || null,
      po_number: row.po_number || null,
      delivery_number: row.delivery_number || null,
      pn_entrada: normalizePn(row.pn),
      pn_saida: normalizePn(row.pn_saida || row.part_delivered),
      sn: normalizeSn(row.sn),
      aeronave: cleanText(row.aeronave),
      status: cleanText(row.status),
      lh_updates: cleanText(row.lh_updates || row.lh_action),
      bn_comments: cleanText(row.bn_comments),
      symptom: cleanText(row.symptom || row.event_report_title),
      warranty_claim: cleanText(row.warranty_claim),
      forecast_date: row.forecast_date || row.data_previsao || null,
      delivery_date: row.delivery_date || null,
      shipment: cleanText(row.shipment),
      case_no: cleanText(row.case_no),
      awb_bol: cleanText(row.awb_bol),
      raw_payload: row.raw_payload || null,
      ...extra,
    },
  };
}

async function findExistingSourceEvent(equipmentId, key) {
  if (!key) return null;
  const { data, error } = await supabase
    .from('equipamento_eventos')
    .select('*')
    .eq('equipamento_id', equipmentId)
    .eq('origem_registro_id', key)
    .limit(1);
  if (error) throw error;
  return (data || [])[0] || null;
}

async function loadEquipmentMap(traceRows = []) {
  const identities = traceRows
    .map((row) => ({ pn: normalizePn(row.pn), sn: normalizeSn(row.sn) }))
    .filter((row) => row.pn && row.sn);
  const pns = [...new Set(identities.map((row) => row.pn))];
  const rows = [];
  for (let i = 0; i < pns.length; i += 100) {
    const { data, error } = await supabase
      .from('equipamentos_serializados')
      .select('*')
      .in('pn', pns.slice(i, i + 100));
    if (error) throw error;
    rows.push(...(data || []));
  }
  return new Map(
    rows
      .filter((item) => item?.ativo !== false)
      .map((item) => [`${normalizePn(item.pn)}::${normalizeSn(item.sn)}`, item]),
  );
}

function deliveryMap(deliveryRows = []) {
  const map = new Map();
  for (const row of deliveryRows) {
    const key = normalizeCode(row.delivery_number);
    if (!key) continue;
    const existing = map.get(key);
    if (!existing || (!existing.delivery_date && row.delivery_date)) map.set(key, row);
  }
  return map;
}

async function addInformationalEvent(equipment, row, stage, input, user, extraPayload = {}) {
  const key = sourceKey(row, stage, input.key_extra || '');
  const existing = await findExistingSourceEvent(equipment.id, key);
  if (existing) return { action: 'ALREADY_RECORDED', event: existing };
  const event = await equipmentService.addEvent(equipment.id, {
    tipo_evento: input.tipo_evento,
    data_evento: input.data_evento || row.snapshot_date || new Date().toISOString(),
    status_resultante: input.status_resultante || equipment.status_atual || 'DESCONHECIDO',
    condicao_resultante: input.condicao_resultante || equipment.condicao_atual || 'DESCONHECIDA',
    confianca: input.confianca || 'ALTA',
    documento_tipo: 'ORDER_BOOK',
    documento: logicalRef(row),
    origem_evento: 'ORDER_BOOK',
    origem_registro_id: key,
    automatico: true,
    motivo: input.motivo,
    observacao: input.observacao || row.bn_comments || row.lh_updates || row.lh_action || null,
    payload: orderBookPayload(row, extraPayload),
  }, user);
  return { action: 'EVENT_CREATED', event };
}

async function registerLocation(equipment, row, stage, candidate, user, options = {}) {
  const key = sourceKey(row, stage, `${candidate.categoria_destino || ''}:${candidate.local_destino || candidate.anv_destino || ''}`);
  const existing = await findExistingSourceEvent(equipment.id, key);
  if (existing) return { action: 'ALREADY_RECORDED', equipment, event: existing };
  const result = await equipmentService.registerLocationEvidence(equipment.id, {
    ...candidate,
    payload: orderBookPayload(row, options.extraPayload || {}),
  }, {
    source_type: 'ORDER_BOOK',
    origin_event: 'ORDER_BOOK',
    source_key: key,
    documento: logicalRef(row),
    data_evento: candidate.data_evento || row.snapshot_date,
    observacao: row.bn_comments || row.lh_updates || row.lh_action || null,
  }, user, { automatico: true, confirmedTransition: options.confirmedTransition === true });

  // Se a evidência confirma exatamente a posição já vigente, o motor central não
  // precisa criar uma nova movimentação. Ainda assim registramos uma evidência
  // informativa com a MESMA chave de origem. Isso preserva o fato documental e,
  // principalmente, impede que um reupload futuro do mesmo Order Book transforme
  // esta evidência antiga em uma movimentação nova só porque o equipamento mudou
  // de posição depois.
  if (result?.action === 'SAME_LOCATION') {
    const evidenceEvent = await equipmentService.addEvent(equipment.id, {
      tipo_evento: `${normalizeCode(candidate.tipo_evento) || 'ORDER_BOOK_LOCALIZACAO'}_EVIDENCIA`,
      data_evento: candidate.data_evento || row.snapshot_date || new Date().toISOString(),
      status_resultante: candidate.status_resultante || equipment.status_atual || 'DESCONHECIDO',
      condicao_resultante: candidate.condicao_resultante || equipment.condicao_atual || 'DESCONHECIDA',
      confianca: candidate.confianca || 'ALTA',
      documento_tipo: 'ORDER_BOOK',
      documento: logicalRef(row),
      origem_evento: 'ORDER_BOOK',
      origem_registro_id: key,
      automatico: true,
      motivo: `${candidate.motivo || 'Order Book confirma a localização já vigente.'} A evidência foi preservada sem gerar nova movimentação física.`,
      observacao: row.bn_comments || row.lh_updates || row.lh_action || null,
      payload: orderBookPayload(row, {
        ...(options.extraPayload || {}),
        same_location_evidence: true,
        confirmed_location: candidate.local_destino || candidate.anv_destino || null,
      }),
    }, user);
    return { action: 'EVIDENCE_CONFIRMED', equipment: result.equipment || equipment, event: evidenceEvent };
  }

  return result;
}

function summarizeResult(acc, action) {
  const key = action || 'UNKNOWN';
  acc[key] = (acc[key] || 0) + 1;
}

async function processEr(row, equipment, user) {
  const date = normalizeDateTime(row.event_date || row.snapshot_date) || new Date().toISOString();
  const aircraft = cleanText(row.aeronave);
  if (aircraft && normalizeCode(aircraft) !== 'ALL') {
    const locationResult = await registerLocation(equipment, row, 'ER_FALHA', {
      tipo_evento: 'ER_FALHA_EM_AERONAVE',
      data_evento: date,
      categoria_destino: 'AERONAVE',
      local_destino: aircraft,
      anv_destino: aircraft,
      status_resultante: `ER_${normalizeCode(row.status) || 'REGISTRADO'}`,
      condicao_resultante: 'POSSIVEL_PANE',
      confianca: 'ALTA',
      motivo: `${logicalRef(row)} registra falha/sintoma deste PN+SN na aeronave ${aircraft}.`,
      observacao: row.symptom || row.lh_action || null,
    }, user);
    if (locationResult.action !== 'SAME_LOCATION') return locationResult;
    const evidenceResult = await addInformationalEvent(equipment, row, 'ER_REGISTRO', {
      tipo_evento: 'ER_FALHA_REPORTADA',
      data_evento: date,
      status_resultante: `ER_${normalizeCode(row.status) || 'REGISTRADO'}`,
      condicao_resultante: 'POSSIVEL_PANE',
      confianca: 'ALTA',
      motivo: `${logicalRef(row)} confirma falha/sintoma quando o equipamento já estava registrado na aeronave ${aircraft}.`,
      observacao: row.symptom || row.lh_action || null,
    }, user);
    return evidenceResult;
  }
  const eventResult = await addInformationalEvent(equipment, row, 'ER_REGISTRO', {
    tipo_evento: 'ER_REGISTRADO',
    data_evento: date,
    status_resultante: `ER_${normalizeCode(row.status) || 'REGISTRADO'}`,
    condicao_resultante: 'POSSIVEL_PANE',
    confianca: 'ALTA',
    motivo: `${logicalRef(row)} vinculado ao equipamento PN ${row.pn} / SN ${row.sn}.`,
    observacao: row.symptom || row.lh_action || null,
  }, user);
  return eventResult;
}

async function processRepairLike(row, equipment, user, deliveries) {
  const results = [];
  let latestEquipment = equipment;
  const isWarranty = normalizeCode(row.trace_type) === 'WARRANTY';
  const category = isWarranty ? 'GARANTIA' : 'REPARO_EXTERNO';
  const local = isWarranty ? 'LEONARDO / GARANTIA' : 'LEONARDO / REPARO';
  const receptionDate = normalizeDateTime(row.reception_date || row.date_received);
  if (receptionDate) {
    const ev = await registerLocation(equipment, row, 'RECEPCAO_LH', {
      tipo_evento: isWarranty ? 'ORDER_BOOK_ENTRADA_GARANTIA' : 'ORDER_BOOK_ENTRADA_REPARO',
      data_evento: receptionDate,
      categoria_destino: category,
      local_destino: local,
      status_resultante: isWarranty ? 'EM_GARANTIA_LEONARDO' : 'EM_REPARO_LEONARDO',
      condicao_resultante: 'EM_REPARO',
      confianca: 'ALTA',
      motivo: `${logicalRef(row)} registra o recebimento do equipamento pela Leonardo para ${isWarranty ? 'garantia' : 'reparo'}.`,
    }, user, { confirmedTransition: false });
    if (ev.action === 'SAME_LOCATION') {
      const infoResult = await addInformationalEvent(equipment, row, 'RECEPCAO_LH_INFO', {
        tipo_evento: isWarranty ? 'ORDER_BOOK_GARANTIA_EVIDENCIA' : 'ORDER_BOOK_REPARO_EVIDENCIA',
        data_evento: receptionDate,
        status_resultante: isWarranty ? 'EM_GARANTIA_LEONARDO' : 'EM_REPARO_LEONARDO',
        condicao_resultante: 'EM_REPARO',
        confianca: 'ALTA',
        motivo: `${logicalRef(row)} confirma o processo de ${isWarranty ? 'garantia' : 'reparo'} quando a localização externa já estava registrada.`,
      }, user);
      results.push(infoResult.action);
    } else {
      results.push(ev.action);
    }
  }

  latestEquipment = await equipmentService.getEquipment(equipment.id) || latestEquipment;
  const delivery = deliveries.get(normalizeCode(row.delivery_number)) || null;
  const commentDate = extractDateFromText(`${row.bn_comments || ''} ${row.lh_updates || ''}`);
  const deliveryDate = normalizeDateTime(row.delivery_date || delivery?.delivery_date) || commentDate;

  if (isOnDelivery(row)) {
    const ev = await registerLocation(equipment, row, 'EM_TRANSITO_RETORNO', {
      tipo_evento: 'ORDER_BOOK_RETORNO_EM_TRANSITO',
      data_evento: normalizeDateTime(row.snapshot_date) || deliveryDate || new Date().toISOString(),
      categoria_destino: 'TRANSITO',
      local_destino: 'EM TRÂNSITO LEONARDO → MARINHA',
      status_resultante: 'RETORNO_EM_TRANSITO',
      condicao_resultante: 'EM_REPARO',
      confianca: 'ALTA',
      motivo: `${logicalRef(row)} indica que o equipamento está em trânsito de retorno da Leonardo.`,
    }, user, { confirmedTransition: ['GARANTIA', 'REPARO_EXTERNO', 'WO_EXTERIOR'].includes(normalizeCode(latestEquipment.categoria_local_atual)) });
    results.push(ev.action);
    latestEquipment = await equipmentService.getEquipment(equipment.id) || latestEquipment;
  }

  if (isDelivered(row) || deliveryDate) {
    const evDate = deliveryDate || normalizeDateTime(row.snapshot_date) || new Date().toISOString();
    // Delivered/Deliveries serve apenas como corroboração da entrega. Mantemos a
    // linha serial de Repairs/Warranty como fonte primária para não perder ER, SN,
    // aeronave e referência comercial, anexando os dados de entrega no payload.
    const deliveredRow = {
      ...(delivery || {}),
      ...row,
      delivery_date: evDate,
      shipment: delivery?.shipment || row.shipment || null,
      case_no: delivery?.case_no || row.case_no || null,
      awb_bol: delivery?.awb_bol || row.awb_bol || null,
    };
    const ev = await registerLocation(equipment, deliveredRow, 'ENTREGUE_MB', {
      tipo_evento: isWarranty ? 'ORDER_BOOK_RETORNO_GARANTIA' : 'ORDER_BOOK_RETORNO_REPARO',
      data_evento: evDate,
      categoria_destino: 'DESCONHECIDO',
      local_destino: 'MARINHA - LOCAL INTERNO A CONFIRMAR',
      status_resultante: 'ENTREGUE_PELA_LEONARDO_LOCAL_A_CONFIRMAR',
      condicao_resultante: 'DESCONHECIDA',
      confianca: deliveryDate ? 'ALTA' : 'MEDIA',
      motivo: `${logicalRef(row)} indica entrega/retorno do equipamento pela Leonardo. O local interno deve ser confirmado por PPU, RECEX, OS/PIM, STC ou conferência física.`,
    }, user, {
      confirmedTransition: ['GARANTIA', 'REPARO_EXTERNO', 'WO_EXTERIOR', 'TRANSITO'].includes(normalizeCode(latestEquipment.categoria_local_atual)),
      extraPayload: delivery ? {
        delivery_evidence: {
          source_sheet: delivery.source_sheet || null,
          source_row: delivery.source_row || null,
          delivery_number: delivery.delivery_number || null,
          delivery_date: delivery.delivery_date || evDate,
          material: delivery.material || null,
          shipment: delivery.shipment || null,
          case_no: delivery.case_no || null,
          awb_bol: delivery.awb_bol || null,
        },
      } : {},
    });
    results.push(ev.action);
  }

  const pnIn = normalizePn(row.pn);
  const pnOut = normalizePn(row.pn_saida || row.part_delivered);
  if (pnIn && pnOut && pnIn !== pnOut) {
    const pnOutResult = await addInformationalEvent(equipment, row, 'PN_SAIDA', {
      tipo_evento: 'ORDER_BOOK_PN_SAIDA_DIFERENTE',
      data_evento: deliveryDate || normalizeDateTime(row.snapshot_date) || receptionDate || new Date().toISOString(),
      status_resultante: equipment.status_atual || 'DESCONHECIDO',
      condicao_resultante: equipment.condicao_atual || 'DESCONHECIDA',
      confianca: 'ALTA',
      motivo: `${logicalRef(row)} informa PN de entrada ${pnIn} e PN de saída ${pnOut}. A relação é preservada como evidência e não altera automaticamente o Cadastro Mestre.`,
      key_extra: `${pnIn}>${pnOut}`,
    }, user, { pn_entrada: pnIn, pn_saida: pnOut });
    results.push(pnOutResult.action);
  }

  if (!receptionDate && !isOnDelivery(row) && !isDelivered(row) && !deliveryDate) {
    const statusResult = await addInformationalEvent(equipment, row, 'STATUS_REPAIR', {
      tipo_evento: isWarranty ? 'ORDER_BOOK_GARANTIA_EVIDENCIA' : 'ORDER_BOOK_REPARO_EVIDENCIA',
      data_evento: normalizeDateTime(row.snapshot_date) || new Date().toISOString(),
      status_resultante: normalizeCode(row.status) || equipment.status_atual || 'DESCONHECIDO',
      condicao_resultante: equipment.condicao_atual || 'DESCONHECIDA',
      confianca: 'MEDIA',
      motivo: `${logicalRef(row)} contém evidência de ${isWarranty ? 'garantia' : 'reparo'} sem uma movimentação física datada suficiente para alterar a localização atual.`,
      key_extra: normalizeCode(statusText(row)).slice(0, 100),
    }, user);
    results.push(statusResult.action);
  }
  return results;
}

async function processProg(row, equipment, user) {
  const receptionDate = normalizeDateTime(row.reception_date);
  const date = receptionDate || normalizeDateTime(row.snapshot_date) || new Date().toISOString();
  if (receptionDate) {
    return registerLocation(equipment, row, 'PROG_REPAIR', {
      tipo_evento: 'ORDER_BOOK_PROGRAMA_REPARO',
      data_evento: receptionDate,
      categoria_destino: 'REPARO_EXTERNO',
      local_destino: cleanText(row.vendor_name) && normalizeCode(row.vendor_name) !== '0' ? `PROGRAMA / ${cleanText(row.vendor_name)}` : 'LEONARDO / PROGRAMA REPARO-UPGRADE',
      status_resultante: normalizeCode(row.gate_description) || 'PROGRAMA_REPARO',
      condicao_resultante: 'EM_REPARO',
      confianca: 'ALTA',
      motivo: `Order Book / Progs registra o recebimento deste PN+SN em programa de reparo/upgrade.`,
      observacao: row.gate_description || row.vendor_name || null,
    }, user, { confirmedTransition: false, extraPayload: { gate: row.gate || null, gate_description: row.gate_description || null, vendor_name: row.vendor_name || null } });
  }
  const infoResult = await addInformationalEvent(equipment, row, 'PROG_REPAIR_INFO', {
    tipo_evento: 'ORDER_BOOK_PROGRAMA_REPARO_EVIDENCIA',
    data_evento: date,
    status_resultante: normalizeCode(row.gate_description) || 'PROGRAMA_REPARO',
    condicao_resultante: equipment.condicao_atual || 'DESCONHECIDA',
    confianca: 'MEDIA',
    motivo: `Order Book / Progs registra este PN+SN em programa de reparo/upgrade, mas sem data de recepção suficiente para alterar a localização atual.`,
    observacao: row.gate_description || row.vendor_name || null,
    key_extra: `${row.notification || ''}:${row.gate || ''}:${row.gate_description || ''}`,
  }, user, { gate: row.gate || null, gate_description: row.gate_description || null, vendor_name: row.vendor_name || null });
  return infoResult;
}

async function syncOrderBookEquipmentTrace({ traceRows = [], deliveryRows = [] } = {}, user = {}) {
  const relevant = (traceRows || []).filter((row) => normalizePn(row.pn) && normalizeSn(row.sn));
  const equipmentMap = await loadEquipmentMap(relevant);
  const deliveries = deliveryMap(deliveryRows || []);
  const results = [];
  const summary = {};
  let pendingIdentity = 0;
  let equipmentNotFound = 0;
  let conflicts = 0;
  let events = 0;

  const ordered = [...(traceRows || [])].sort((a, b) => {
    const da = new Date(a.event_date || a.reception_date || a.date_received || a.snapshot_date || 0).getTime();
    const db = new Date(b.event_date || b.reception_date || b.date_received || b.snapshot_date || 0).getTime();
    return (Number.isFinite(da) ? da : 0) - (Number.isFinite(db) ? db : 0);
  });

  for (const row of ordered) {
    const pn = normalizePn(row.pn);
    const sn = normalizeSn(row.sn);
    if (!pn || !sn) {
      pendingIdentity += 1;
      summarizeResult(summary, 'PENDING_PN_SN');
      continue;
    }
    const equipment = equipmentMap.get(`${pn}::${sn}`);
    if (!equipment) {
      equipmentNotFound += 1;
      summarizeResult(summary, 'EQUIPMENT_NOT_FOUND');
      results.push({ source_sheet: row.source_sheet, ref: logicalRef(row), pn, sn, status: 'EQUIPMENT_NOT_FOUND' });
      continue;
    }

    try {
      let actions = [];
      const type = normalizeCode(row.trace_type);
      if (type === 'ER') {
        const out = await processEr(row, equipment, user);
        actions = [out.action];
      } else if (type === 'REPAIR' || type === 'WARRANTY') {
        actions = await processRepairLike(row, equipment, user, deliveries);
      } else if (type === 'PROGS') {
        const out = await processProg(row, equipment, user);
        actions = [out.action];
      } else {
        summarizeResult(summary, 'SOURCE_ONLY');
        continue;
      }
      actions.forEach((action) => {
        summarizeResult(summary, action);
        if (action === 'CONFLICT') conflicts += 1;
        if (['EVENT_CREATED', 'HISTORICAL_EVENT'].includes(action)) events += 1;
      });
      results.push({ source_sheet: row.source_sheet, ref: logicalRef(row), pn, sn, status: 'SYNCED', actions });
    } catch (error) {
      summarizeResult(summary, 'ERROR');
      results.push({ source_sheet: row.source_sheet, ref: logicalRef(row), pn, sn, status: 'ERROR', message: error.message || 'Falha ao sincronizar evidência Order Book.' });
    }
  }

  const tqsRows = (traceRows || []).filter((row) => normalizeCode(row.trace_type) === 'TQS');
  const erRows = (traceRows || []).filter((row) => normalizeCode(row.trace_type) === 'ER');
  return {
    total_fontes: traceRows.length,
    fontes_serializadas: relevant.length,
    eventos_criados_ou_historicos: events,
    conflitos_localizacao: conflicts,
    pn_sn_pendentes: pendingIdentity,
    equipamento_nao_cadastrado: equipmentNotFound,
    tqs_sem_vinculo_serial: tqsRows.filter((row) => !normalizePn(row.pn) || !normalizeSn(row.sn)).length,
    er_com_pn_sn: erRows.filter((row) => normalizePn(row.pn) && normalizeSn(row.sn)).length,
    summary,
    results: results.slice(0, 250),
  };
}

module.exports = {
  syncOrderBookEquipmentTrace,
  extractDateFromText,
  normalizeSn,
  sourceKey,
};
