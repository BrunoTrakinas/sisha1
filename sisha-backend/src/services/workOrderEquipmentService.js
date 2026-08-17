const supabase = require('../config/supabaseClient');
const equipmentService = require('./equipmentService');

const EXTERNAL_REPAIR_STATUSES = new Set([
  'ENVIADO', 'EMB', 'EM_REPARO', 'AGUARDANDO_ORCAMENTO', 'AGUARDANDO_APROVACAO',
  'REPARADO', 'IRREPARAVEL', 'REGRESSANDO',
]);
const RETURN_STATUSES = new Set(['RECEBIDO', 'REC']);
const CANCEL_STATUSES = new Set(['CAN', 'CANCELADO']);
const RESULT_FINAL = new Set(['REPARADO', 'IRREPARAVEL', 'DEVOLVIDO_SEM_REPARO', 'CANCELADO']);

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
  return text ? text.replace(/\s+/g, '') : null;
}

function normalizeDateTime(value) {
  const text = cleanText(value);
  if (!text) return null;
  const dt = new Date(text);
  return Number.isNaN(dt.getTime()) ? null : dt.toISOString();
}

function money(value) {
  const n = Number(value || 0);
  return Number.isFinite(n) ? n : 0;
}

function repairCondition(wo = {}) {
  const result = normalizeCode(wo.resultado_tecnico || wo.resultado);
  const status = normalizeCode(wo.status);
  if (result === 'IRREPARAVEL' || status === 'IRREPARAVEL') return 'IRREPARAVEL';
  if (result === 'REPARADO' || status === 'REPARADO') return 'REPARADO';
  if (result === 'DEVOLVIDO_SEM_REPARO') return 'DEVOLVIDO_SEM_REPARO';
  return 'EM_REPARO';
}

function costReference(wo = {}, supplements = []) {
  const suplementado = (supplements || [])
    .filter((item) => item?.ativo !== false)
    .reduce((sum, item) => sum + money(item?.valor), 0);
  const base = money(wo.valor_total || wo.valor_total_usd || wo.preco_contrato);
  return {
    tipo_wo: normalizeCode(wo.tipo_wo) || 'PENDENTE',
    resultado_tecnico: normalizeCode(wo.resultado_tecnico || wo.resultado) || 'PENDENTE',
    moeda: normalizeCode(wo.moeda) || 'USD',
    valor_total_informado: base,
    valor_contratado: money(wo.valor_contratado),
    preco_contrato: money(wo.preco_contrato),
    suplementacoes_total: suplementado,
    valor_historico_referencia: base + suplementado,
    referencia_orcamentaria: true,
    nota: 'Valor histórico da WO. Serve como referência de custo do serviço executado; não representa orçamento vigente automaticamente.',
  };
}

function sourceKey(wo, stage, suffix = '') {
  return `WO:${wo.id}:${stage}${suffix ? `:${suffix}` : ''}`;
}

async function findEquipmentByIdentity(pn, sn) {
  const normalizedPn = normalizeCode(pn);
  const normalizedSn = normalizeSn(sn);
  if (!normalizedPn || !normalizedSn) return null;
  const { data, error } = await supabase
    .from('equipamentos_serializados')
    .select('*')
    .ilike('pn', normalizedPn)
    .ilike('sn', normalizedSn)
    .eq('ativo', true)
    .limit(2);
  if (error) throw error;
  return (data || [])[0] || null;
}

async function loadSupplements(wo) {
  if (Array.isArray(wo?.work_order_suplementacoes)) return wo.work_order_suplementacoes;
  if (!wo?.id || String(wo.id).startsWith('orderbook-repair-')) return [];
  const { data, error } = await supabase
    .from('work_order_suplementacoes')
    .select('*')
    .eq('work_order_id', wo.id)
    .eq('ativo', true);
  if (error) throw error;
  return data || [];
}

function buildSharedPayload(wo, supplements) {
  return {
    wo_id: wo.id,
    numero_wo: cleanText(wo.numero_wo),
    pn_entrada: normalizeCode(wo.pn),
    pn_saida: normalizeCode(wo.pn_saida),
    sn: normalizeSn(wo.sn),
    empresa: cleanText(wo.empresa || wo.codemp),
    aeronave_informada: cleanText(wo.aeronave),
    status_wo: normalizeCode(wo.status) || 'PENDENTE',
    origem_wo: normalizeCode(wo.origem) || 'SISHA',
    custo_reparo: costReference(wo, supplements),
  };
}

async function addLedgerEvent(equipment, wo, stage, input, user, supplements) {
  const shared = buildSharedPayload(wo, supplements);
  return equipmentService.addEvent(equipment.id, {
    ...input,
    documento_tipo: 'WO',
    documento: wo.numero_wo || `WO ${wo.id}`,
    origem_evento: 'WO',
    origem_registro_id: sourceKey(wo, stage),
    automatico: true,
    payload: {
      ...shared,
      ...(input.payload && typeof input.payload === 'object' ? input.payload : {}),
    },
  }, user);
}

async function syncWorkOrderToEquipment(wo = {}, user = {}, options = {}) {
  if (!wo?.id) return { status: 'PENDING_ID', message: 'WO sem identificador.' };
  if (String(wo.id).startsWith('orderbook-repair-')) {
    return { status: 'ORDER_BOOK_MANAGED_2B8', message: 'Repair/Warranty do Order Book é sincronizado com o Livro durante a importação mensal do Order Book (2B.8).' };
  }

  const pn = normalizeCode(wo.pn);
  const sn = normalizeSn(wo.sn);
  if (!pn) return { status: 'PENDING_PN', message: 'WO sem PN válido.' };
  if (!sn) return { status: 'PENDING_SN', message: 'Informe o SN para vincular esta WO ao Livro do Equipamento.' };

  const equipment = await findEquipmentByIdentity(pn, sn);
  if (!equipment) {
    return {
      status: 'EQUIPMENT_NOT_FOUND',
      pn,
      sn,
      message: `PN ${pn} / SN ${sn} ainda não existe no Cadastro Mestre de Equipamentos. A WO foi preservada, mas nenhum evento foi criado.`,
    };
  }

  const supplements = await loadSupplements(wo);
  const status = normalizeCode(wo.status) || 'PENDENTE';
  const result = normalizeCode(wo.resultado_tecnico || wo.resultado) || 'PENDENTE';
  const events = [];
  const warnings = [];

  const registerDate = normalizeDateTime(wo.data_abertura || wo.data_status || wo.created_at || wo.updated_at) || new Date().toISOString();
  const registered = await addLedgerEvent(equipment, wo, 'REGISTRO', {
    tipo_evento: 'WO_REGISTRADA',
    data_evento: registerDate,
    status_resultante: equipment.status_atual || 'DESCONHECIDO',
    condicao_resultante: equipment.condicao_atual || 'DESCONHECIDA',
    confianca: 'CONFIRMADA',
    motivo: `WO ${wo.numero_wo || wo.id} vinculada ao equipamento PN ${pn} / SN ${sn}.`,
    observacao: cleanText(wo.observacao),
  }, user, supplements);
  events.push({ stage: 'REGISTRO', action: 'EVENT_CREATED', event_id: registered?.id || null });

  if (CANCEL_STATUSES.has(status) || result === 'CANCELADO' || wo.ativo === false) {
    const cancelled = await addLedgerEvent(equipment, wo, 'CANCELAMENTO', {
      tipo_evento: 'WO_CANCELADA',
      data_evento: normalizeDateTime(wo.data_status || wo.updated_at) || new Date().toISOString(),
      status_resultante: equipment.status_atual || 'DESCONHECIDO',
      condicao_resultante: equipment.condicao_atual || 'DESCONHECIDA',
      confianca: 'CONFIRMADA',
      motivo: `WO ${wo.numero_wo || wo.id} cancelada. O histórico anterior permanece preservado.`,
      observacao: cleanText(wo.observacao),
    }, user, supplements);
    events.push({ stage: 'CANCELAMENTO', action: 'EVENT_CREATED', event_id: cancelled?.id || null });
    return { status: 'SYNCED', equipment_id: equipment.id, pn, sn, events, warnings, cancelled: true };
  }

  const sendDetected = Boolean(cleanText(wo.data_envio)) || EXTERNAL_REPAIR_STATUSES.has(status);
  const sendDate = normalizeDateTime(wo.data_envio || wo.data_status || wo.data_abertura);
  if (sendDetected && sendDate) {
    const destination = cleanText(wo.empresa || wo.codemp) || 'REPARO EXTERNO';
    const currentCategory = normalizeCode(equipment.categoria_local_atual);
    const confirmedTransition = currentCategory !== 'AERONAVE';
    const evidence = await equipmentService.registerLocationEvidence(equipment.id, {
      tipo_evento: 'ENVIO_WO_REPARO',
      data_evento: sendDate,
      categoria_destino: 'REPARO_EXTERNO',
      local_destino: destination,
      status_resultante: `WO_${status}`,
      condicao_resultante: repairCondition(wo),
      confianca: cleanText(wo.empresa || wo.codemp) ? 'ALTA' : 'MEDIA',
      motivo: `WO ${wo.numero_wo || wo.id} indica envio/permanência do equipamento em reparo externo.`,
      observacao: cleanText(wo.observacao),
      payload: buildSharedPayload(wo, supplements),
    }, {
      source_type: 'WO',
      origin_event: 'WO',
      source_key: sourceKey(wo, 'ENVIO', `${sendDate.slice(0, 10)}:${normalizeCode(destination)}`),
      documento: wo.numero_wo || `WO ${wo.id}`,
      data_evento: sendDate,
      observacao: cleanText(wo.observacao),
    }, user, { automatico: true, confirmedTransition });
    events.push({ stage: 'ENVIO', action: evidence.action, event_id: evidence.event?.id || evidence.conflict?.id || null });
    if (evidence.action === 'CONFLICT') warnings.push('A WO indica reparo externo, mas o equipamento possui outra localização corrente. Foi criado conflito para confirmação do Admin/Dono.');
  } else if (sendDetected) {
    warnings.push('WO indica envio/reparo, mas não possui data confiável para posicionar o evento na linha do tempo.');
  }

  const returnDetected = Boolean(cleanText(wo.data_retorno)) || RETURN_STATUSES.has(status);
  const returnDate = normalizeDateTime(wo.data_retorno || (RETURN_STATUSES.has(status) ? wo.data_status : null));
  if (returnDetected && returnDate) {
    const returned = await addLedgerEvent(equipment, wo, 'RETORNO', {
      tipo_evento: 'RETORNO_WO_REPARO',
      data_evento: returnDate,
      categoria_destino: 'DESCONHECIDO',
      local_destino: null,
      status_resultante: 'RETORNADO_WO_LOCAL_A_CONFIRMAR',
      condicao_resultante: repairCondition(wo),
      confianca: 'ALTA',
      motivo: `WO ${wo.numero_wo || wo.id} registra retorno do reparo. A localização interna após o retorno deve ser confirmada por inventário, PIM, OS, STC ou registro manual.`,
      observacao: cleanText(wo.observacao),
    }, user, supplements);
    events.push({ stage: 'RETORNO', action: 'EVENT_CREATED', event_id: returned?.id || null });
  }

  if (RESULT_FINAL.has(result) && !returnDetected) {
    const resultEvent = await addLedgerEvent(equipment, wo, 'RESULTADO', {
      tipo_evento: 'RESULTADO_TECNICO_WO',
      data_evento: normalizeDateTime(wo.data_status || wo.updated_at) || registerDate,
      status_resultante: equipment.status_atual || 'DESCONHECIDO',
      condicao_resultante: repairCondition(wo),
      confianca: 'ALTA',
      motivo: `Resultado técnico da WO ${wo.numero_wo || wo.id}: ${result}.`,
      observacao: cleanText(wo.observacao),
    }, user, supplements);
    events.push({ stage: 'RESULTADO', action: 'EVENT_CREATED', event_id: resultEvent?.id || null });
  }

  if (normalizeCode(wo.pn_saida) && normalizeCode(wo.pn_saida) !== pn) {
    warnings.push(`A WO informa PN de saída ${normalizeCode(wo.pn_saida)} diferente do PN de entrada ${pn}. A alteração foi registrada como evidência, mas o Cadastro Mestre não foi reescrito automaticamente.`);
  }

  return { status: 'SYNCED', equipment_id: equipment.id, pn, sn, events, warnings };
}

async function syncWorkOrdersBatch(rows = [], user = {}, options = {}) {
  const results = [];
  const chunkSize = Math.max(1, Math.min(Number(options.concurrency) || 8, 20));
  for (let i = 0; i < rows.length; i += chunkSize) {
    const chunk = rows.slice(i, i + chunkSize);
    const settled = await Promise.all(chunk.map(async (wo) => {
      try {
        return { wo_id: wo.id, numero_wo: wo.numero_wo, ...(await syncWorkOrderToEquipment(wo, user, options)) };
      } catch (error) {
        return { wo_id: wo.id, numero_wo: wo.numero_wo, status: 'ERROR', message: error.message || 'Falha ao sincronizar WO com o Livro.' };
      }
    }));
    results.push(...settled);
  }
  const summary = results.reduce((acc, item) => {
    const key = item.status || 'UNKNOWN';
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});
  return { total: results.length, summary, results };
}

async function syncExistingWorkOrdersToEquipment(user = {}) {
  const all = [];
  const pageSize = 1000;
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await supabase
      .from('work_orders')
      .select('*, work_order_suplementacoes(*)')
      .range(from, from + pageSize - 1);
    if (error) throw error;
    all.push(...(data || []));
    if (!data || data.length < pageSize) break;
  }
  return syncWorkOrdersBatch(all, user, { concurrency: 8 });
}

async function decorateWorkOrdersWithEquipmentTrace(rows = []) {
  const pns = [...new Set((rows || []).filter((wo) => normalizeCode(wo.pn) && normalizeSn(wo.sn)).map((wo) => normalizeCode(wo.pn)))];
  const equipmentRows = [];
  for (let i = 0; i < pns.length; i += 100) {
    const { data, error } = await supabase
      .from('equipamentos_serializados')
      .select('id,pn,sn,ativo,local_atual,categoria_local_atual,anv_atual,status_atual')
      .in('pn', pns.slice(i, i + 100));
    if (error) throw error;
    equipmentRows.push(...(data || []));
  }
  const map = new Map(equipmentRows.filter((item) => item.ativo !== false).map((item) => [`${normalizeCode(item.pn)}::${normalizeSn(item.sn)}`, item]));
  return (rows || []).map((wo) => {
    const pn = normalizeCode(wo.pn);
    const sn = normalizeSn(wo.sn);
    const isOrderBook = String(wo.id || '').startsWith('orderbook-repair-') || wo.order_book_ref;
    if (!sn) return { ...wo, equipment_trace: { status: 'PENDING_SN', message: 'SN pendente para vincular ao Livro.' } };
    const equipment = map.get(`${pn}::${sn}`);
    if (!equipment) return { ...wo, equipment_trace: { status: 'EQUIPMENT_NOT_FOUND', message: 'PN+SN não cadastrado no Cadastro Mestre.' } };
    return {
      ...wo,
      equipment_trace: {
        status: isOrderBook ? 'LINKED_ORDER_BOOK' : 'LINKED',
        equipment_id: equipment.id,
        local_atual: equipment.local_atual || null,
        categoria_local_atual: equipment.categoria_local_atual || null,
        anv_atual: equipment.anv_atual || null,
        status_atual: equipment.status_atual || null,
        message: isOrderBook ? 'PN+SN reconhecido no Cadastro Mestre; histórico Order Book é mantido pelo motor 2B.8.' : null,
      },
    };
  });
}

module.exports = {
  syncWorkOrderToEquipment,
  syncWorkOrdersBatch,
  syncExistingWorkOrdersToEquipment,
  decorateWorkOrdersWithEquipmentTrace,
};
