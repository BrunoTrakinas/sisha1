const supabase = require('../config/supabaseClient');
const equipmentService = require('./equipmentService');
const { ensureIdentities } = require('./rawOperationalDocumentImportService');
const { KNOWN_AIRCRAFT_CODES, WORKSHOP_MAP } = require('./osDomainService');

function clean(value) {
  const text = String(value ?? '').trim();
  return text || null;
}
function upper(value) { return String(clean(value) || '').toUpperCase(); }
function normalizePn(value) { return upper(value).replace(/\s+/g, '') || null; }
function normalizeSn(value) { return upper(value).replace(/\s+/g, '') || null; }
function identityKey(pn, sn) { return `${normalizePn(pn) || ''}::${normalizeSn(sn) || ''}`; }
function uniq(values = []) { return [...new Set(values.filter(Boolean))]; }

function masterOsKey(item = {}) {
  return `${upper(item.os_numero_normalizado || item.os_numero)}:${Number(item.os_ano || 0)}`;
}

function locationFromCode(value) {
  const raw = upper(value);
  if (!raw) return null;
  const compact = raw.replace(/\s+/g, '');
  if (KNOWN_AIRCRAFT_CODES.includes(compact)) {
    return { categoria: 'AERONAVE', local: `AERONAVE ${compact}`, aeronave: compact, codigo: compact };
  }
  if (Object.prototype.hasOwnProperty.call(WORKSHOP_MAP, compact)) {
    return { categoria: 'OFICINA', local: compact, aeronave: null, codigo: compact };
  }
  if (compact === 'APOIO' || compact === 'VA') {
    return { categoria: 'OFICINA', local: compact, aeronave: null, codigo: compact };
  }
  if (/CEIMSPA/.test(raw)) return { categoria: 'CEIMSPA', local: 'CEIMSPA', aeronave: null, codigo: 'CEIMSPA' };
  if (/RECEX/.test(raw)) return { categoria: 'RECEX', local: raw, aeronave: null, codigo: 'RECEX' };
  if (/\bPPU\b|PAIOL/.test(raw)) return { categoria: 'PPU', local: raw, aeronave: null, codigo: 'PPU' };
  if (/LEONARDO|GRFLINX|EXTERIOR|TERCEIR/.test(raw)) return { categoria: 'EXTERNO', local: raw, aeronave: null, codigo: 'EXTERNO' };
  return null;
}

function destinationCandidates(item = {}) {
  const raw = upper(item.destino);
  const found = [];
  if (raw) {
    const direct = locationFromCode(raw);
    if (direct) found.push(direct);
    const tokens = raw.split(/[\/,;]|\s+E\s+/).map((token) => token.trim()).filter(Boolean);
    tokens.forEach((token) => {
      const parsed = locationFromCode(token);
      if (parsed) found.push(parsed);
    });
  }

  const description = upper(item.descricao);
  const workshopMatch = description.match(/(?:OFICINA|OF\.?)(?:\s+DE)?\s+(HV|MV|SV|VN|PA|APOIO|VA)\b/);
  if (workshopMatch) {
    const parsed = locationFromCode(workshopMatch[1]);
    if (parsed) found.push(parsed);
  }
  const aircraftMatch = description.match(/(?:PARA|NA|NO|AERONAVE|ANV)\s+(4001|4003|4004|4005|4010|4012|4006|4009)\b/);
  if (aircraftMatch) {
    const parsed = locationFromCode(aircraftMatch[1]);
    if (parsed) found.push(parsed);
  }

  const bySignature = new Map();
  found.forEach((entry) => bySignature.set(`${entry.categoria}|${entry.local}|${entry.aeronave || ''}`, entry));
  return [...bySignature.values()];
}

function movementPlan(item = {}) {
  const movement = item.movimento || {};
  const status = upper(item.status_evidencia);
  if (!movement.detectado) return { state: 'NAO_APLICAVEL', executable: false, reason: 'OS sem verbo inequívoco de instalação/remoção.' };
  if (movement.ambiguo || movement.tipo === 'AMBIGUO') return { state: 'PENDENTE_AMBIGUIDADE', executable: false, reason: 'A mesma descrição contém instalação e remoção; exige revisão.' };
  if (status === 'CANCELADA') return { state: 'CANCELADA', executable: false, reason: 'OS cancelada: preserva intenção, nunca movimenta item.' };
  if (status === 'ABERTA') return { state: 'INTENCAO', executable: false, reason: 'OS aberta: preserva escrituração/intenção, nunca movimenta item.' };
  if (status !== 'FECHADA') return { state: 'PENDENTE_STATUS', executable: false, reason: 'Status da OS não permite confirmar movimentação.' };
  if (item.cronologia_consistente === false) return { state: 'PENDENTE_CRONOLOGIA', executable: false, reason: 'OS fechada com cronologia inconsistente; movimento não é aplicado automaticamente.' };
  if (item.dominio_tipo !== 'ANV' || !KNOWN_AIRCRAFT_CODES.includes(String(item.dominio_codigo || ''))) {
    return { state: 'HISTORICO_OFICINA', executable: false, reason: 'OS de oficina permanece histórica; não presume instalação/remoção da aeronave.' };
  }
  if (movement.tipo === 'INSTALACAO') {
    return {
      state: 'CONFIRMAVEL', executable: true,
      destination: locationFromCode(item.dominio_codigo),
      reason: 'OS de aeronave fechada com instalação: a aeronave da própria OS é o destino confirmado.',
    };
  }
  if (movement.tipo === 'REMOCAO') {
    const destinations = destinationCandidates(item);
    if (destinations.length !== 1) {
      return {
        state: destinations.length ? 'PENDENTE_DESTINO_AMBIGUO' : 'PENDENTE_DESTINO',
        executable: false,
        destination_candidates: destinations,
        reason: destinations.length ? 'Mais de um destino físico plausível foi encontrado.' : 'OS fechada de remoção sem destino físico inequívoco.',
      };
    }
    return { state: 'CONFIRMAVEL', executable: true, destination: destinations[0], reason: 'OS de aeronave fechada com destino inequívoco.' };
  }
  return { state: 'NAO_APLICAVEL', executable: false, reason: 'Movimento não suportado.' };
}

async function fetchEquipmentIndex() {
  const rows = [];
  const pageSize = 1000;
  for (let offset = 0; ; offset += pageSize) {
    const { data, error } = await supabase
      .from('equipamentos_serializados')
      .select('id,pn,sn,nomenclatura,ativo,status_atual,condicao_atual,categoria_local_atual,local_atual,anv_atual')
      .order('id', { ascending: true })
      .range(offset, offset + pageSize - 1);
    if (error) throw error;
    const part = data || [];
    rows.push(...part);
    if (part.length < pageSize) break;
  }
  const byIdentity = new Map();
  const bySn = new Map();
  rows.forEach((row) => {
    byIdentity.set(identityKey(row.pn, row.sn), row);
    const sn = normalizeSn(row.sn);
    if (!sn) return;
    const list = bySn.get(sn) || [];
    list.push(row);
    bySn.set(sn, list);
  });
  return { rows, byIdentity, bySn };
}

function explicitCreationRows(items = []) {
  const rows = [];
  for (const item of items) {
    const movement = item.movimento || {};
    if (!movement.detectado || movement.ambiguo) continue;
    const pns = uniq((movement.pns_explicitos || []).map(normalizePn));
    const sns = uniq((movement.sns_explicitos || []).map(normalizeSn));
    if (pns.length !== 1 || sns.length !== 1) continue;
    rows.push({
      pn: pns[0], sn: sns[0], nomenclatura: null,
      data: item.data_abertura || item.data_fechamento || null,
      source_os: item.os_numero_normalizado,
    });
  }
  return rows;
}

function resolveEquipmentForItem(item = {}, index = {}) {
  const movement = item.movimento || {};
  const pns = uniq((movement.pns_explicitos || []).map(normalizePn));
  const sns = uniq((movement.sns_explicitos || []).map(normalizeSn));
  const resolved = [];
  const unresolved = [];

  if (!sns.length) {
    return { resolved, unresolved: [{ reason: 'Descrição de movimento sem S/N explícito; identidade física não pode ser confirmada.' }] };
  }

  for (const sn of sns) {
    let matches = [];
    if (pns.length) {
      matches = pns.map((pn) => index.byIdentity.get(identityKey(pn, sn))).filter(Boolean);
    }
    if (!matches.length) matches = index.bySn.get(sn) || [];
    if (pns.length) matches = matches.filter((row) => pns.includes(normalizePn(row.pn)));
    const uniqueById = [...new Map(matches.map((row) => [String(row.id), row])).values()];
    if (uniqueById.length === 1) resolved.push(uniqueById[0]);
    else if (!uniqueById.length) unresolved.push({ sn, pns, reason: 'S/N não encontrou PN+SN canônico no Livro de Equipamentos.' });
    else unresolved.push({ sn, pns, reason: 'S/N corresponde a mais de uma identidade; correlação bloqueada.' });
  }

  return {
    resolved: [...new Map(resolved.map((row) => [String(row.id), row])).values()],
    unresolved,
  };
}

function eventPayload(item, fileName, sourceSha256, extra = {}) {
  return {
    master_os: {
      os_numero: item.os_numero_normalizado,
      os_ano: item.os_ano,
      status_evidencia: item.status_evidencia,
      dominio_tipo: item.dominio_tipo,
      dominio_codigo: item.dominio_codigo,
      data_abertura: item.data_abertura,
      data_fechamento: item.data_fechamento,
      destino: item.destino,
      descricao: item.descricao,
      source_file_name: fileName,
      source_sha256: sourceSha256,
      source_sheet: item.source_sheet,
      source_row: item.source_row,
      movimento: item.movimento || null,
      ...extra,
    },
  };
}

async function addNonMovementEvidence(equipment, item, plan, { fileName, sourceSha256, user } = {}) {
  const typeSuffix = item.movimento?.tipo === 'REMOCAO' ? 'REMOCAO' : item.movimento?.tipo === 'INSTALACAO' ? 'INSTALACAO' : 'MOVIMENTO';
  const eventType = plan.state === 'CANCELADA'
    ? 'MASTER_OS_CANCELADA'
    : plan.state === 'INTENCAO'
      ? `MASTER_OS_INTENCAO_${typeSuffix}`
      : 'MASTER_OS_MOVIMENTO_PENDENTE';
  const date = item.status_evidencia === 'FECHADA' && item.data_fechamento ? item.data_fechamento : item.data_abertura || item.data_fechamento;
  return equipmentService.addEvent(equipment.id, {
    tipo_evento: eventType,
    data_evento: date ? `${date}T12:00:00.000Z` : new Date().toISOString(),
    os: item.os_numero_normalizado,
    status_resultante: equipment.status_atual || 'DESCONHECIDO',
    condicao_resultante: equipment.condicao_atual || 'DESCONHECIDA',
    documento_tipo: 'MASTER_OS',
    documento: `OS ${item.os_numero_normalizado}/${item.os_ano}`,
    origem_evento: 'MASTER_OS',
    origem_registro_id: `MASTEROS:${masterOsKey(item)}:${equipment.id}:${eventType}`,
    confianca: plan.state === 'INTENCAO' || plan.state === 'CANCELADA' ? 'CONFIRMADA' : 'PENDENTE',
    automatico: true,
    motivo: `${plan.reason} Fonte oficial: Master OS da Divisão de Planejamento.`,
    observacao: item.descricao,
    payload: eventPayload(item, fileName, sourceSha256, { orchestration_state: plan.state }),
  }, user);
}

async function confirmMovement(equipment, item, plan, { fileName, sourceSha256, user } = {}) {
  const movementType = item.movimento.tipo;
  const date = item.data_fechamento || item.data_abertura;
  const sourceKey = `MASTEROS:${masterOsKey(item)}:${equipment.id}:${movementType}`;
  const sourceAircraft = item.dominio_tipo === 'ANV' ? String(item.dominio_codigo || '') : null;
  const candidate = {
    tipo_evento: movementType === 'INSTALACAO' ? 'INSTALACAO_ANV' : 'REMOCAO_ANV',
    data_evento: `${date}T12:00:00.000Z`,
    local_origem: movementType === 'REMOCAO' && sourceAircraft ? `AERONAVE ${sourceAircraft}` : null,
    categoria_origem: movementType === 'REMOCAO' && sourceAircraft ? 'AERONAVE' : null,
    source_aircraft: movementType === 'REMOCAO' ? sourceAircraft : null,
    categoria_destino: plan.destination.categoria,
    local_destino: plan.destination.local,
    anv_destino: plan.destination.aeronave,
    status_resultante: movementType === 'INSTALACAO' ? 'INSTALADO' : 'REMOVIDO',
    // A OS fechada prova a movimentação física; ela não prova, sozinha, uma nova
    // condição técnica. A condição conhecida é preservada em vez de ser inventada.
    condicao_resultante: equipment.condicao_atual || 'DESCONHECIDA',
    confianca: 'CONFIRMADA',
    motivo: `MASTER OS ${item.os_numero_normalizado}/${item.os_ano} FECHADA pela Divisão de Planejamento confirma ${movementType === 'INSTALACAO' ? 'instalação' : 'remoção'} do PN ${equipment.pn} / SN ${equipment.sn}.`,
    observacao: item.descricao,
    documento_tipo: 'MASTER_OS',
    documento: `OS ${item.os_numero_normalizado}/${item.os_ano}`,
    origem_evento: 'MASTER_OS',
    origem_registro_id: sourceKey,
    automatico: true,
    payload: eventPayload(item, fileName, sourceSha256, {
      orchestration_state: 'CONFIRMADA',
      source_aircraft: sourceAircraft,
      destination: plan.destination,
    }),
  };

  // Diferente das fontes apenas observacionais, uma OS FECHADA da Divisão de
  // Planejamento é uma confirmação operacional. O RPC faz evento + projeção atual
  // de forma ACID, protege evidência temporal mais nova e não fabrica intervalo A2
  // de instalação quando posição/contador não existem no Master.
  const { data, error } = await supabase.rpc('sisha_apply_master_os_movement_atomic', {
    p_equipment_id: Number(equipment.id),
    p_event: candidate,
    p_actor_email: user?.email || null,
    p_actor_role: user?.role || null,
  });
  if (error) throw error;
  return data || { action: 'UNKNOWN' };
}

async function updateEvidenceStatus(sourceSha256, item, movementState, movementSummary) {
  const { error } = await supabase
    .from('os_master_evidencias')
    .update({
      movimento_tipo: item.movimento?.tipo || null,
      movimento_estado: movementState,
      movimento_payload: movementSummary || {},
    })
    .eq('source_sha256', sourceSha256)
    .eq('source_sheet', item.source_sheet)
    .eq('source_row', Number(item.source_row));
  if (error) throw error;
}

async function orchestrateMasterOsEquipment(items = [], { fileName, sourceSha256, user } = {}) {
  const seedRows = explicitCreationRows(items);
  let seeded = { created: 0, existing: 0 };
  if (seedRows.length) {
    seeded = await ensureIdentities(seedRows, { fileName, user, origin: 'MASTER_OS' });
  }
  const index = await fetchEquipmentIndex();
  const summary = {
    os_analisadas: items.length,
    identidades_criadas_por_pn_sn_explicito: seeded.created || 0,
    intencoes_registradas: 0,
    cancelamentos_registrados: 0,
    movimentos_confirmados: 0,
    confirmacoes_mesma_localizacao: 0,
    historicos_sem_regressao: 0,
    intervalos_a2_encerrados: 0,
    conflitos_intervalo_a2: 0,
    pendencias_identidade: 0,
    pendencias_destino: 0,
    pendencias_ambiguidade: 0,
    os_sem_movimento: 0,
    os_oficina_historicas: 0,
    detalhes_pendentes: [],
  };

  for (const item of items) {
    const plan = movementPlan(item);
    const resolution = resolveEquipmentForItem(item, index);
    const movementSummary = {
      plan,
      resolved_equipment_ids: resolution.resolved.map((row) => row.id),
      unresolved: resolution.unresolved,
    };

    if (plan.state === 'NAO_APLICAVEL') {
      summary.os_sem_movimento += 1;
      await updateEvidenceStatus(sourceSha256, item, plan.state, movementSummary);
      continue;
    }
    if (plan.state === 'HISTORICO_OFICINA') summary.os_oficina_historicas += 1;
    if (plan.state.includes('AMBIGUIDADE')) summary.pendencias_ambiguidade += 1;
    if (plan.state.includes('DESTINO')) summary.pendencias_destino += 1;
    if (!resolution.resolved.length) summary.pendencias_identidade += 1;

    let evidenceState = plan.state;
    for (const equipment of resolution.resolved) {
      if (plan.executable) {
        const result = await confirmMovement(equipment, item, plan, { fileName, sourceSha256, user });
        if (result.action === 'HISTORICAL_EVENT') {
          summary.historicos_sem_regressao += 1;
          evidenceState = 'HISTORICO_SEM_REGRESSAO';
        } else if (['SAME_LOCATION', 'A2_CORROBORATED'].includes(result.action)) {
          summary.confirmacoes_mesma_localizacao += 1;
          evidenceState = result.action === 'A2_CORROBORATED' ? 'CONFIRMADA_A2' : 'CONFIRMADA_MESMA_LOCALIZACAO';
        } else if (result.action === 'A2_INTERVAL_CONFLICT') {
          summary.conflitos_intervalo_a2 += 1;
          evidenceState = 'PENDENTE_CONFLITO_A2';
          await addNonMovementEvidence(equipment, item, {
            ...plan,
            state: evidenceState,
            reason: result.reason || 'MASTER OS fechada conflita com intervalo A2 aberto; exige revisão antes de movimentar.',
          }, { fileName, sourceSha256, user });
        } else if (['EVENT_APPLIED', 'IDEMPOTENT'].includes(result.action)) {
          if (result.a2_interval_closed) summary.intervalos_a2_encerrados += 1;
          summary.movimentos_confirmados += 1;
          evidenceState = result.action === 'IDEMPOTENT' ? 'CONFIRMADA_IDEMPOTENTE' : 'MOVIMENTO_CONFIRMADO';
        } else {
          evidenceState = 'PENDENTE_ORQUESTRACAO';
          summary.detalhes_pendentes.push({
            os: item.os_numero_normalizado,
            ano: item.os_ano,
            sheet: item.source_sheet,
            row: item.source_row,
            estado: evidenceState,
            motivo: `Resultado inesperado da orquestração: ${result.action || 'UNKNOWN'}.`,
          });
        }
      } else {
        await addNonMovementEvidence(equipment, item, plan, { fileName, sourceSha256, user });
        if (plan.state === 'INTENCAO') summary.intencoes_registradas += 1;
        if (plan.state === 'CANCELADA') summary.cancelamentos_registrados += 1;
      }
    }

    if (plan.executable && !resolution.resolved.length) evidenceState = 'PENDENTE_IDENTIDADE';
    if ((plan.state === 'INTENCAO' || plan.state === 'CANCELADA') && !resolution.resolved.length) evidenceState = `${plan.state}_SEM_IDENTIDADE`;
    if (resolution.unresolved.length && resolution.resolved.length && !/PENDENTE/.test(evidenceState)) {
      evidenceState = `${evidenceState}_COM_PENDENCIAS`;
    }
    if (resolution.unresolved.length || /PENDENTE/.test(evidenceState)) {
      summary.detalhes_pendentes.push({
        os: item.os_numero_normalizado,
        ano: item.os_ano,
        sheet: item.source_sheet,
        row: item.source_row,
        estado: evidenceState,
        motivo: plan.reason,
        unresolved: resolution.unresolved,
      });
    }
    await updateEvidenceStatus(sourceSha256, item, evidenceState, movementSummary);
  }

  summary.detalhes_pendentes = summary.detalhes_pendentes.slice(0, 100);
  return summary;
}

module.exports = {
  locationFromCode,
  destinationCandidates,
  movementPlan,
  resolveEquipmentForItem,
  orchestrateMasterOsEquipment,
};
