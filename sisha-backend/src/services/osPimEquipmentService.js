const supabase = require('../config/supabaseClient');
const equipmentService = require('./equipmentService');
const {
  ACTIVE_AIRCRAFT_CODES,
  KNOWN_AIRCRAFT_CODES,
  WORKSHOP_MAP,
  parseOsDomain,
} = require('./osDomainService');

const AIRCRAFT_CODES = ACTIVE_AIRCRAFT_CODES;

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
  if (!text) return new Date().toISOString();
  const date = new Date(text);
  if (Number.isNaN(date.getTime())) throw new Error('Data da movimentação inválida.');
  return date.toISOString();
}

function normalizeAircraft(value) {
  const raw = normalizeCode(value);
  if (!raw) return null;
  const match = KNOWN_AIRCRAFT_CODES.find((code) => new RegExp(`(?:^|N[-\\s]*)${code}(?:$|\\b)`).test(raw));
  return match || raw.replace(/^N[-\s]*/, '');
}

function parseOsOrigin(osNumber) {
  const parsed = parseOsDomain(osNumber);
  return { tipo: parsed.tipo, codigo: parsed.codigo, descricao: parsed.descricao };
}

function normalizeMovementType(value) {
  const raw = normalizeCode(value) || '';
  if (/(INSTALL|INSTALA|MONTAG)/.test(raw)) return 'INSTALACAO';
  if (/(REMOV|REMOCA|REMOÇÃO|RETIR|DESINSTAL)/.test(raw)) return 'REMOCAO';
  if (/(TRANSFER|MOVIMENT|TRANSF)/.test(raw)) return 'TRANSFERENCIA';
  return raw || 'MOVIMENTACAO';
}

function normalizeCondition(value, fallback = 'DESCONHECIDA') {
  const raw = normalizeCode(value);
  if (!raw) return fallback;
  if (/(POSSIVEL|PROVAVEL).*PANE/.test(raw)) return 'POSSIVEL_PANE';
  if (/PANE|AVARIAD/.test(raw)) return 'AVARIADO';
  if (/PRONTO|SERVICEABLE/.test(raw)) return 'PRONTO_USO';
  if (/INSTALAD/.test(raw)) return 'INSTALADO';
  return raw;
}

function locationSignature(category, location, aircraft) {
  return [normalizeCode(category) || '', normalizeCode(location) || '', normalizeAircraft(aircraft) || ''].join('|');
}

async function findEquipment(input = {}) {
  if (input.equipment_id) {
    const byId = await equipmentService.getEquipment(input.equipment_id);
    if (byId) return byId;
  }

  const pn = normalizeCode(input.pn);
  const sn = normalizeSn(input.sn);
  if (!pn || !sn) throw new Error('PN e SN são obrigatórios para vincular OS/PIM a um equipamento físico.');

  const { data, error } = await supabase
    .from('equipamentos_serializados')
    .select('*')
    .ilike('pn', pn)
    .ilike('sn', sn)
    .limit(2);
  if (error) throw error;
  if (!(data || []).length) throw new Error(`PN ${pn} / SN ${sn} não existe no Cadastro Mestre de Equipamentos.`);
  if ((data || []).length > 1) throw new Error(`Mais de um equipamento corresponde a PN ${pn} / SN ${sn}. Corrija o Cadastro Mestre antes de movimentar.`);
  return equipmentService.getEquipment(data[0].id);
}

function buildCardKey(equipmentId, input = {}) {
  const os = normalizeCode(input.os || input.os_numero);
  const pim = normalizeCode(input.pim);
  const osr = normalizeCode(input.osr);
  const type = normalizeMovementType(input.tipo_movimento || input.tipo_evento);
  const identity = os || osr || pim;
  if (!identity) throw new Error('Informe ao menos OS, OSR ou PIM para identificar a movimentação.');
  return `OSPIM:${equipmentId}:${identity}:${type}`;
}

function sharedPayload(snapshot, cardKey) {
  return {
    os_pim: {
      card_key: cardKey,
      equipment_id: snapshot.equipment_id,
      pn: snapshot.pn,
      sn: snapshot.sn,
      tipo_movimento: snapshot.tipo_movimento,
      os: snapshot.os,
      osr: snapshot.osr,
      pim: snapshot.pim,
      aeronave: snapshot.aeronave,
      categoria_origem: snapshot.categoria_origem,
      local_origem: snapshot.local_origem,
      anv_origem: snapshot.anv_origem,
      categoria_destino: snapshot.categoria_destino,
      local_destino: snapshot.local_destino,
      anv_destino: snapshot.anv_destino,
      condicao_resultante: snapshot.condicao_resultante,
      motivo_movimento: snapshot.motivo_movimento,
      data_evento: snapshot.data_evento,
      documento_referencia: snapshot.documento_referencia,
      observacao: snapshot.observacao,
      staging_id: snapshot.staging_id || null,
      documento_chat_lince_id: snapshot.documento_chat_lince_id || null,
    },
  };
}

function normalizeMovementInput(input = {}, equipment = {}) {
  const tipo = normalizeMovementType(input.tipo_movimento || input.tipo_evento);
  const os = cleanText(input.os || input.os_numero);
  const osr = cleanText(input.osr);
  const pim = cleanText(input.pim);
  if (!os && !osr && !pim) throw new Error('Informe ao menos OS, OSR ou PIM.');

  const parsedOs = parseOsOrigin(os || osr);
  const explicitAircraft = normalizeAircraft(input.aeronave || input.anv_destino || input.anv_origem);
  const aircraft = explicitAircraft || (parsedOs.tipo === 'ANV' ? parsedOs.codigo : null);

  let categoriaOrigem = normalizeCode(input.categoria_origem);
  let localOrigem = cleanText(input.local_origem);
  let anvOrigem = normalizeAircraft(input.anv_origem);
  let categoriaDestino = normalizeCode(input.categoria_destino);
  let localDestino = cleanText(input.local_destino);
  let anvDestino = normalizeAircraft(input.anv_destino);

  if (tipo === 'INSTALACAO') {
    anvDestino = anvDestino || aircraft;
    if (!anvDestino) throw new Error('Instalação exige a aeronave de destino. Informe a aeronave ou use uma OS iniciada por 4001/4003/4004/4005/4010/4012.');
    categoriaDestino = 'AERONAVE';
    localDestino = localDestino || `AERONAVE ${anvDestino}`;
  } else if (tipo === 'REMOCAO') {
    anvOrigem = anvOrigem || aircraft || normalizeAircraft(equipment.anv_atual);
    categoriaOrigem = categoriaOrigem || (anvOrigem ? 'AERONAVE' : normalizeCode(equipment.categoria_local_atual));
    localOrigem = localOrigem || (anvOrigem ? `AERONAVE ${anvOrigem}` : cleanText(equipment.local_atual));
    if (!categoriaDestino && !localDestino && !anvDestino) categoriaDestino = 'DESCONHECIDO';
  } else if (tipo === 'TRANSFERENCIA') {
    if (!categoriaDestino && !localDestino && !anvDestino) throw new Error('Transferência exige destino.');
    if (anvDestino) {
      categoriaDestino = 'AERONAVE';
      localDestino = localDestino || `AERONAVE ${anvDestino}`;
    }
  }

  return {
    equipment_id: Number(equipment.id),
    pn: equipment.pn,
    sn: equipment.sn,
    tipo_movimento: tipo,
    os,
    osr,
    pim,
    aeronave: aircraft,
    categoria_origem: categoriaOrigem,
    local_origem: localOrigem,
    anv_origem: anvOrigem,
    categoria_destino: categoriaDestino || 'DESCONHECIDO',
    local_destino: localDestino,
    anv_destino: anvDestino,
    condicao_resultante: normalizeCondition(input.condicao_resultante || input.condicao || input.motivo_remocao, tipo === 'INSTALACAO' ? 'INSTALADO' : equipment.condicao_atual || 'DESCONHECIDA'),
    motivo_movimento: cleanText(input.motivo_movimento || input.motivo) || (tipo === 'INSTALACAO' ? 'Instalação em aeronave.' : tipo === 'REMOCAO' ? 'Remoção de aeronave.' : 'Movimentação por OS/PIM.'),
    data_evento: normalizeDateTime(input.data_evento || input.data_movimentacao || input.data),
    documento_referencia: cleanText(input.documento_referencia || input.documento || os || osr || pim),
    observacao: cleanText(input.observacao || input.observacoes),
    staging_id: cleanText(input.staging_id),
    documento_chat_lince_id: cleanText(input.documento_chat_lince_id),
  };
}

function currentMatchesOrigin(equipment, snapshot) {
  const hasOrigin = Boolean(snapshot.local_origem || snapshot.anv_origem || (snapshot.categoria_origem && snapshot.categoria_origem !== 'DESCONHECIDO'));
  if (!hasOrigin) return true;
  const current = locationSignature(equipment.categoria_local_atual, equipment.local_atual, equipment.anv_atual);
  const origin = locationSignature(snapshot.categoria_origem, snapshot.local_origem, snapshot.anv_origem);
  return current === origin;
}

async function upsertRegistrationEvent(equipment, snapshot, cardKey, user = {}) {
  return equipmentService.addEvent(equipment.id, {
    tipo_evento: 'OS_PIM_REGISTRADO',
    data_evento: snapshot.data_evento,
    pim: snapshot.pim,
    os: snapshot.os || snapshot.osr,
    status_resultante: equipment.status_atual || 'DESCONHECIDO',
    condicao_resultante: equipment.condicao_atual || 'DESCONHECIDA',
    confianca: 'CONFIRMADA',
    documento_tipo: snapshot.osr ? 'OSR' : snapshot.os ? 'OS' : 'PIM',
    documento: snapshot.documento_referencia,
    origem_evento: 'OS_PIM',
    origem_registro_id: `${cardKey}:REGISTRO`,
    automatico: false,
    motivo: `${snapshot.tipo_movimento} registrada por ${snapshot.os ? `OS ${snapshot.os}` : snapshot.osr ? `OSR ${snapshot.osr}` : `PIM ${snapshot.pim}`}.`,
    observacao: snapshot.observacao,
    payload: sharedPayload(snapshot, cardKey),
  }, user);
}

async function upsertStageEvent(equipment, snapshot, cardKey, user = {}) {
  const typeMap = {
    INSTALACAO: 'INSTALACAO_ANV',
    REMOCAO: 'REMOCAO_ANV',
    TRANSFERENCIA: 'TRANSFERENCIA_OS_PIM',
    MOVIMENTACAO: 'MOVIMENTACAO_OS_PIM',
  };
  const tipoEvento = typeMap[snapshot.tipo_movimento] || 'MOVIMENTACAO_OS_PIM';
  const sourceKey = `${cardKey}:MOVIMENTO`;
  const isUnknownRemoval = snapshot.tipo_movimento === 'REMOCAO' && !snapshot.local_destino && !snapshot.anv_destino && snapshot.categoria_destino === 'DESCONHECIDO';

  if (isUnknownRemoval) {
    const current = await equipmentService.getEquipment(equipment.id);
    const candidateTime = new Date(snapshot.data_evento).getTime();
    const latestLocationEvent = (current.eventos || []).find((event) => {
      if (event?.invalidado) return false;
      const category = normalizeCode(event?.categoria_destino);
      return Boolean(event?.local_destino || event?.anv_destino || (category && category !== 'DESCONHECIDO'));
    });
    const latestTime = latestLocationEvent ? new Date(latestLocationEvent.data_evento || '').getTime() : NaN;
    const historicalOnly = Number.isFinite(candidateTime) && Number.isFinite(latestTime) && candidateTime < latestTime;
    const explicitOrigin = Boolean(snapshot.local_origem || snapshot.anv_origem || (snapshot.categoria_origem && snapshot.categoria_origem !== 'DESCONHECIDO'));

    if (!historicalOnly && explicitOrigin && !currentMatchesOrigin(current, snapshot)) {
      const conflict = await equipmentService.upsertPendingLocationConflict(current, {
        tipo_evento: tipoEvento,
        data_evento: snapshot.data_evento,
        categoria_destino: 'DESCONHECIDO',
        local_destino: null,
        anv_destino: null,
        status_resultante: 'REMOCAO_DESTINO_A_CONFIRMAR',
        condicao_resultante: snapshot.condicao_resultante,
        confianca: 'CONFLITANTE',
        motivo: snapshot.motivo_movimento,
        payload: sharedPayload(snapshot, cardKey),
      }, {
        source_type: snapshot.osr ? 'OSR' : snapshot.os ? 'OS' : 'PIM',
        source_key: sourceKey,
        documento: snapshot.documento_referencia,
        data_evento: snapshot.data_evento,
        observacao: snapshot.observacao,
      }, user);
      return { action: 'CONFLICT', conflict };
    }

    const event = await equipmentService.addEvent(equipment.id, {
      tipo_evento: tipoEvento,
      data_evento: snapshot.data_evento,
      pim: snapshot.pim,
      os: snapshot.os || snapshot.osr,
      categoria_destino: 'DESCONHECIDO',
      local_destino: null,
      anv_destino: null,
      status_resultante: historicalOnly ? current.status_atual || 'DESCONHECIDO' : 'REMOCAO_DESTINO_A_CONFIRMAR',
      condicao_resultante: snapshot.condicao_resultante,
      confianca: historicalOnly ? 'MEDIA' : 'ALTA',
      documento_tipo: snapshot.osr ? 'OSR' : snapshot.os ? 'OS' : 'PIM',
      documento: snapshot.documento_referencia,
      origem_evento: 'OS_PIM',
      origem_registro_id: sourceKey,
      automatico: false,
      motivo: historicalOnly ? `${snapshot.motivo_movimento} Evidência histórica: não altera o estado atual mais recente.` : snapshot.motivo_movimento,
      observacao: snapshot.observacao,
      payload: { ...sharedPayload(snapshot, cardKey), historical_only: historicalOnly, latest_valid_location_event_id: latestLocationEvent?.id || null },
    }, user);
    return { action: historicalOnly ? 'HISTORICAL_EVENT' : 'EVENT_CREATED', event };
  }

  const current = await equipmentService.getEquipment(equipment.id);
  const originConfirmed = !current.local_atual || normalizeCode(current.categoria_local_atual) === 'DESCONHECIDO' || currentMatchesOrigin(current, snapshot);
  const result = await equipmentService.registerLocationEvidence(equipment.id, {
    tipo_evento: tipoEvento,
    data_evento: snapshot.data_evento,
    categoria_destino: snapshot.categoria_destino,
    local_destino: snapshot.local_destino,
    anv_destino: snapshot.anv_destino,
    status_resultante: snapshot.tipo_movimento === 'INSTALACAO' ? 'INSTALADO' : snapshot.tipo_movimento === 'REMOCAO' ? 'REMOVIDO' : 'MOVIMENTADO',
    condicao_resultante: snapshot.condicao_resultante,
    confianca: 'ALTA',
    motivo: snapshot.motivo_movimento,
    observacao: snapshot.observacao,
    payload: sharedPayload(snapshot, cardKey),
  }, {
    source_type: snapshot.osr ? 'OSR' : snapshot.os ? 'OS' : 'PIM',
    origin_event: 'OS_PIM',
    source_key: sourceKey,
    documento: snapshot.documento_referencia,
    data_evento: snapshot.data_evento,
    observacao: snapshot.observacao,
  }, user, { automatico: false, confirmedTransition: originConfirmed });

  if (result.action === 'SAME_LOCATION') {
    const event = await equipmentService.addEvent(equipment.id, {
      tipo_evento: tipoEvento,
      data_evento: snapshot.data_evento,
      pim: snapshot.pim,
      os: snapshot.os || snapshot.osr,
      categoria_destino: snapshot.categoria_destino,
      local_destino: snapshot.local_destino,
      anv_destino: snapshot.anv_destino,
      status_resultante: snapshot.tipo_movimento === 'INSTALACAO' ? 'INSTALADO' : snapshot.tipo_movimento === 'REMOCAO' ? 'REMOVIDO' : 'MOVIMENTADO',
      condicao_resultante: snapshot.condicao_resultante,
      confianca: 'ALTA',
      documento_tipo: snapshot.osr ? 'OSR' : snapshot.os ? 'OS' : 'PIM',
      documento: snapshot.documento_referencia,
      origem_evento: 'OS_PIM',
      origem_registro_id: sourceKey,
      automatico: false,
      motivo: `${snapshot.motivo_movimento} A evidência confirma a localização já vigente.`,
      observacao: snapshot.observacao,
      payload: sharedPayload(snapshot, cardKey),
    }, user);
    return { action: 'EVENT_CREATED', event };
  }
  return result;
}

async function saveMovement(input = {}, user = {}, expectedCardKey = null) {
  const existing = expectedCardKey ? await getMovementCard(expectedCardKey) : null;
  if (expectedCardKey && !existing) throw new Error('Movimentação OS/PIM não encontrada para edição.');

  const equipment = await findEquipment(input);
  const snapshot = normalizeMovementInput(input, equipment);
  const cardKey = buildCardKey(equipment.id, snapshot);

  if (expectedCardKey && expectedCardKey !== cardKey) {
    throw new Error('PN, SN, documento principal e tipo de movimentação não podem ser alterados nesta edição. Cancele o registro incorreto e crie outro para preservar a rastreabilidade.');
  }
  if (!expectedCardKey) {
    const duplicate = await getMovementCard(cardKey);
    if (duplicate && duplicate.status !== 'CANCELADA') throw new Error('Esta movimentação OS/PIM já está registrada. Abra o card existente para editar ou cancelar.');
  }
  if (existing?.status === 'CANCELADA') throw new Error('Movimentação cancelada não pode ser reaberta. Crie um novo registro para preservar o histórico.');

  const registration = await upsertRegistrationEvent(equipment, snapshot, cardKey, user);
  const result = await upsertStageEvent(equipment, snapshot, cardKey, user);
  return {
    card_key: cardKey,
    equipment_id: equipment.id,
    pn: equipment.pn,
    sn: equipment.sn,
    tipo_movimento: snapshot.tipo_movimento,
    documento: snapshot.documento_referencia,
    os: snapshot.os,
    osr: snapshot.osr,
    pim: snapshot.pim,
    action: result.action,
    register_event_id: registration?.id || null,
    event_id: result.event?.id || result.conflict?.id || null,
    conflito_localizacao: result.action === 'CONFLICT',
  };
}

async function cancelMovement(cardKey, reason, user = {}) {
  const motivo = cleanText(reason);
  if (!motivo) throw new Error('Informe o motivo do cancelamento.');
  const card = await getMovementCard(cardKey);
  if (!card) throw new Error('Movimentação OS/PIM não encontrada.');
  if (card.status === 'CANCELADA') throw new Error('Movimentação já cancelada.');

  const { data: events, error } = await supabase
    .from('equipamento_eventos')
    .select('*')
    .eq('equipamento_id', card.equipment_id)
    .eq('origem_evento', 'OS_PIM');
  if (error) throw error;

  const target = (events || []).filter((event) => event?.payload?.os_pim?.card_key === cardKey && !event.invalidado);
  for (const event of target) {
    await equipmentService.invalidateEvent(card.equipment_id, event.id, `Movimentação OS/PIM cancelada: ${motivo}`, user);
  }

  const { data: pendingConflict, error: conflictError } = await supabase
    .from('equipamento_eventos')
    .select('*')
    .eq('equipamento_id', card.equipment_id)
    .eq('origem_evento', 'RECONCILIACAO')
    .eq('origem_registro_id', `${cardKey}:MOVIMENTO`)
    .maybeSingle();
  if (conflictError) throw conflictError;
  if (pendingConflict?.payload?.conflito_status === 'PENDENTE') {
    const nextPayload = {
      ...(pendingConflict.payload || {}),
      conflito_status: 'CANCELADO',
      cancelado_em: new Date().toISOString(),
      cancelado_por: user.email || null,
      motivo_cancelamento: motivo,
    };
    const { error: closeConflictError } = await supabase
      .from('equipamento_eventos')
      .update({ payload: nextPayload, motivo_invalidacao: 'CANCELADO_OS_PIM', invalidado_por: user.email || null, invalidado_em: new Date().toISOString() })
      .eq('id', pendingConflict.id);
    if (closeConflictError) throw closeConflictError;
  }

  const cancelEvent = await equipmentService.addEvent(card.equipment_id, {
    tipo_evento: 'OS_PIM_CANCELADO',
    data_evento: new Date().toISOString(),
    pim: card.pim,
    os: card.os || card.osr,
    status_resultante: card.equipamento?.status_atual || 'DESCONHECIDO',
    condicao_resultante: card.equipamento?.condicao_atual || 'DESCONHECIDA',
    confianca: 'CONFIRMADA',
    documento_tipo: 'CANCELAMENTO_OS_PIM',
    documento: card.documento,
    origem_evento: 'OS_PIM',
    origem_registro_id: `${cardKey}:CANCELAMENTO`,
    automatico: false,
    motivo,
    observacao: 'Cancelamento lógico: eventos anteriores permanecem no Livro, mas deixam de definir o estado atual.',
    payload: { os_pim: { ...(card.snapshot || {}), card_key: cardKey }, cancelamento: true },
  }, user);

  return { card_key: cardKey, invalidated: target.length, cancel_event_id: cancelEvent.id };
}

function cardFromGroup(cardKey, events, equipment) {
  const sorted = [...events].sort((a, b) => new Date(b.data_evento || 0) - new Date(a.data_evento || 0));
  const payloadEvent = sorted.find((event) => event?.payload?.os_pim) || sorted[0];
  const snapshot = payloadEvent?.payload?.os_pim || {};
  const cancelled = sorted.some((event) => event.tipo_evento === 'OS_PIM_CANCELADO' && !event.invalidado);
  const pendingConflict = sorted.some((event) => event.tipo_evento === 'CONFLITO_LOCALIZACAO' && event?.payload?.conflito_status === 'PENDENTE');
  const movementEvent = sorted.find((event) => !['OS_PIM_CANCELADO', 'OS_PIM_REGISTRADO', 'CONFLITO_LOCALIZACAO'].includes(event.tipo_evento)) || sorted.find((event) => event.tipo_evento === 'OS_PIM_REGISTRADO');
  return {
    card_key: cardKey,
    equipment_id: Number(snapshot.equipment_id || equipment?.id || payloadEvent?.equipamento_id),
    pn: snapshot.pn || equipment?.pn || payloadEvent?.pn,
    sn: snapshot.sn || equipment?.sn || payloadEvent?.sn,
    nomenclatura: equipment?.nomenclatura || null,
    tipo_movimento: snapshot.tipo_movimento || 'MOVIMENTACAO',
    os: snapshot.os || null,
    osr: snapshot.osr || null,
    pim: snapshot.pim || null,
    documento: snapshot.documento_referencia || payloadEvent?.documento || null,
    data_evento: snapshot.data_evento || movementEvent?.data_evento || null,
    aeronave: snapshot.aeronave || snapshot.anv_destino || snapshot.anv_origem || null,
    categoria_origem: snapshot.categoria_origem || null,
    local_origem: snapshot.local_origem || null,
    anv_origem: snapshot.anv_origem || null,
    categoria_destino: snapshot.categoria_destino || movementEvent?.categoria_destino || null,
    local_destino: snapshot.local_destino || movementEvent?.local_destino || null,
    anv_destino: snapshot.anv_destino || movementEvent?.anv_destino || null,
    condicao_resultante: snapshot.condicao_resultante || movementEvent?.condicao_resultante || null,
    motivo_movimento: snapshot.motivo_movimento || movementEvent?.motivo || null,
    observacao: snapshot.observacao || movementEvent?.observacao || null,
    staging_id: snapshot.staging_id || null,
    status: cancelled ? 'CANCELADA' : pendingConflict ? 'CONFLITO' : 'ATIVA',
    snapshot,
    equipamento: equipment || null,
    event_ids: sorted.map((event) => event.id),
  };
}

async function listMovementCards({ q = '', limit = 500 } = {}) {
  const safeLimit = Math.max(1, Math.min(Number(limit) || 500, 2000));
  const { data: events, error } = await supabase
    .from('equipamento_eventos')
    .select('*')
    .in('origem_evento', ['OS_PIM', 'RECONCILIACAO'])
    .order('data_evento', { ascending: false })
    .limit(safeLimit * 4);
  if (error) throw error;

  const grouped = new Map();
  for (const event of events || []) {
    const rawSourceKey = event.origem_registro_id ? String(event.origem_registro_id) : '';
    const cardKey = event?.payload?.os_pim?.card_key || (rawSourceKey.startsWith('OSPIM:') ? rawSourceKey.replace(/:(REGISTRO|MOVIMENTO|CANCELAMENTO)$/, '') : null);
    if (!cardKey || !String(cardKey).startsWith('OSPIM:')) continue;
    if (!grouped.has(cardKey)) grouped.set(cardKey, []);
    grouped.get(cardKey).push(event);
  }

  const equipmentIds = [...new Set([].concat(...[...grouped.values()]).map((event) => event.equipamento_id).filter(Boolean))];
  let equipments = [];
  if (equipmentIds.length) {
    const { data, error: eqError } = await supabase.from('equipamentos_serializados').select('*').in('id', equipmentIds);
    if (eqError) throw eqError;
    equipments = data || [];
  }
  const byId = new Map(equipments.map((item) => [String(item.id), item]));

  const term = normalizeCode(q);
  return [...grouped.entries()]
    .map(([key, group]) => cardFromGroup(key, group, byId.get(String(group[0]?.equipamento_id))))
    .filter((card) => {
      if (!term) return true;
      return [card.pn, card.sn, card.os, card.osr, card.pim, card.documento, card.aeronave, card.local_destino, card.tipo_movimento]
        .some((value) => normalizeCode(value)?.includes(term));
    })
    .slice(0, safeLimit);
}

async function getMovementCard(cardKey) {
  const cards = await listMovementCards({ limit: 2000 });
  return cards.find((card) => card.card_key === cardKey) || null;
}

async function listAircraftConfiguration() {
  const { data, error } = await supabase
    .from('equipamentos_serializados')
    .select('*')
    .eq('ativo', true)
    .eq('categoria_local_atual', 'AERONAVE')
    .order('anv_atual', { ascending: true })
    .order('pn', { ascending: true })
    .order('sn', { ascending: true });
  if (error) throw error;

  const groups = {};
  for (const item of data || []) {
    const aircraft = normalizeAircraft(item.anv_atual) || normalizeAircraft(item.local_atual) || 'NAO_IDENTIFICADA';
    if (!groups[aircraft]) groups[aircraft] = [];
    groups[aircraft].push(item);
  }
  return Object.entries(groups).map(([aeronave, itens]) => ({ aeronave, total: itens.length, equipamentos: itens }));
}

async function listStaging({ q = '', limit = 250 } = {}) {
  const safeLimit = Math.max(1, Math.min(Number(limit) || 250, 1000));
  let query = supabase
    .from('chat_lince_os_eventos_staging')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(safeLimit);
  const { data, error } = await query;
  if (error) {
    if (['42P01', 'PGRST205'].includes(error.code)) return [];
    throw error;
  }
  const term = normalizeCode(q);
  return (data || []).filter((row) => {
    if (!term) return true;
    return [row.os_numero, row.pim, row.pn, row.sn, row.aeronave, row.local_origem, row.local_destino, row.tipo_evento]
      .some((value) => normalizeCode(value)?.includes(term));
  });
}

async function promoteStaging(stagingId, overrides = {}, user = {}) {
  const { data: staged, error } = await supabase
    .from('chat_lince_os_eventos_staging')
    .select('*')
    .eq('id', stagingId)
    .maybeSingle();
  if (error) throw error;
  if (!staged) throw new Error('Evento OS/PIM de staging não encontrado.');
  if (staged?.payload?.aplicado_2b7?.card_key) throw new Error('Este evento de staging já foi aplicado ao Livro de Equipamentos.');

  const payload = staged.payload && typeof staged.payload === 'object' ? staged.payload : {};
  const merged = {
    ...payload,
    ...staged,
    ...overrides,
    staging_id: String(staged.id),
    documento_chat_lince_id: staged.documento_id ? String(staged.documento_id) : null,
    os: overrides.os || staged.os_numero || payload.os_numero || payload.os,
    pim: overrides.pim || staged.pim || payload.pim,
    pn: overrides.pn || staged.pn || payload.pn,
    sn: overrides.sn || staged.sn || payload.sn,
    aeronave: overrides.aeronave || staged.aeronave || payload.aeronave,
    data_evento: overrides.data_evento || staged.data_evento || payload.data_evento,
    local_origem: overrides.local_origem || staged.local_origem || payload.local_origem,
    local_destino: overrides.local_destino || staged.local_destino || payload.local_destino,
    tipo_movimento: overrides.tipo_movimento || staged.tipo_evento || payload.tipo_evento,
    observacao: overrides.observacao || payload.observacao || `Promovido do staging Chat Lince ${staged.id}.`,
  };

  if (!normalizeCode(merged.pn) || !normalizeSn(merged.sn)) {
    throw new Error('O staging não possui PN+SN suficientes. Revise e informe PN e SN antes de aplicar ao Livro.');
  }

  const result = await saveMovement(merged, user);
  const nextPayload = {
    ...payload,
    aplicado_2b7: {
      card_key: result.card_key,
      equipment_id: result.equipment_id,
      event_id: result.event_id,
      aplicado_em: new Date().toISOString(),
      aplicado_por: user.email || null,
    },
  };
  const { error: updateError } = await supabase
    .from('chat_lince_os_eventos_staging')
    .update({ payload: nextPayload })
    .eq('id', stagingId);
  if (updateError) throw updateError;
  return result;
}

module.exports = {
  AIRCRAFT_CODES,
  WORKSHOP_MAP,
  parseOsOrigin,
  listMovementCards,
  getMovementCard,
  saveMovement,
  cancelMovement,
  listAircraftConfiguration,
  listStaging,
  promoteStaging,
};
