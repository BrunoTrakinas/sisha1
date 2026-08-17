const supabase = require('../config/supabaseClient');
const equipmentService = require('./equipmentService');

const STC_EVENT_TYPES = ['STC_REGISTRADA', 'ENVIO_STC', 'RETORNO_STC', 'STC_CANCELADA'];
const STC_STATUS = new Set(['REGISTRADA', 'ENVIADA', 'RETORNADA', 'CANCELADA']);
const STC_REASONS = new Set(['REPARO', 'GARANTIA', 'TRANSFERENCIA', 'CESSAO', 'EMPRESTIMO', 'MOVIMENTACAO', 'OUTRO']);

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
  if (Number.isNaN(dt.getTime())) throw new Error(`Data inválida: ${text}.`);
  return dt.toISOString();
}

function slug(value) {
  return normalizeCode(value)?.replace(/[^A-Z0-9._-]+/g, '-') || null;
}

function normalizeCategory(value) {
  return normalizeCode(value) || 'DESCONHECIDO';
}

function locationSignature(category, location, aircraft) {
  return [normalizeCode(category) || 'DESCONHECIDO', normalizeCode(location) || '', normalizeCode(aircraft) || ''].join('|');
}

function equipmentLocationSignature(equipment = {}) {
  return locationSignature(equipment.categoria_local_atual, equipment.local_atual, equipment.anv_atual);
}

function stcCardKey(equipmentId, number) {
  const code = slug(number);
  if (!equipmentId || !code) throw new Error('Número da STC e equipamento são obrigatórios.');
  return `STC:${equipmentId}:${code}`;
}

function stageKey(cardKey, stage) {
  return `${cardKey}:${stage}`;
}

async function findEquipment({ equipment_id, pn, sn } = {}) {
  if (equipment_id) {
    const equipment = await equipmentService.getEquipment(equipment_id);
    if (!equipment || equipment.ativo === false) throw new Error('Equipamento não encontrado/ativo no Cadastro Mestre.');
    return equipment;
  }
  const normalizedPn = normalizeCode(pn);
  const normalizedSn = normalizeSn(sn);
  if (!normalizedPn || !normalizedSn) throw new Error('Informe PN e SN para vincular a STC ao equipamento.');
  const { data, error } = await supabase
    .from('equipamentos_serializados')
    .select('*')
    .ilike('pn', normalizedPn)
    .ilike('sn', normalizedSn)
    .eq('ativo', true)
    .limit(2);
  if (error) throw error;
  const rows = data || [];
  if (!rows.length) throw new Error(`PN ${normalizedPn} / SN ${normalizedSn} não existe no Cadastro Mestre de Equipamentos.`);
  if (rows.length > 1) throw new Error(`Mais de um equipamento ativo foi encontrado para PN ${normalizedPn} / SN ${normalizedSn}. Reconcilie o Cadastro Mestre antes de registrar STC.`);
  return rows[0];
}

function normalizeStcInput(input = {}, equipment = {}) {
  const numero = cleanText(input.numero_stc || input.numero || input.stc);
  if (!numero) throw new Error('Número da STC é obrigatório.');

  const status = normalizeCode(input.status) || (input.data_retorno ? 'RETORNADA' : input.data_envio ? 'ENVIADA' : 'REGISTRADA');
  if (!STC_STATUS.has(status)) throw new Error('Status da STC inválido.');

  const motivo = normalizeCode(input.motivo_stc || input.tipo_movimentacao || input.motivo) || 'MOVIMENTACAO';
  if (!STC_REASONS.has(motivo)) throw new Error('Motivo/tipo da STC inválido.');

  const dataEnvio = normalizeDateTime(input.data_envio);
  const dataRetorno = normalizeDateTime(input.data_retorno);
  if (['ENVIADA', 'RETORNADA'].includes(status) && !dataEnvio) throw new Error('Informe a data de envio para STC enviada/retornada.');
  if (status === 'RETORNADA' && !dataRetorno) throw new Error('Informe a data de retorno para STC retornada.');
  if (dataRetorno && !dataEnvio) throw new Error('Uma STC com retorno precisa informar também a data de envio.');
  if (dataEnvio && dataRetorno && new Date(dataRetorno) < new Date(dataEnvio)) throw new Error('A data de retorno não pode ser anterior à data de envio.');

  const destinoCategoria = normalizeCategory(input.categoria_destino);
  const destinoLocal = cleanText(input.local_destino || input.destino);
  const destinoAnv = cleanText(input.anv_destino || input.aeronave_destino);
  const retornoCategoria = normalizeCategory(input.categoria_retorno || input.categoria_local_retorno);
  const retornoLocal = cleanText(input.local_retorno);
  const retornoAnv = cleanText(input.anv_retorno || input.aeronave_retorno);

  return {
    numero_stc: numero,
    status,
    motivo_stc: motivo,
    descricao: cleanText(input.descricao || input.observacao),
    origem_informada: cleanText(input.local_origem),
    categoria_origem_informada: normalizeCode(input.categoria_origem),
    anv_origem_informada: cleanText(input.anv_origem || input.aeronave_origem),
    categoria_destino: destinoCategoria,
    local_destino: destinoLocal,
    anv_destino: destinoAnv,
    empresa_destino: cleanText(input.empresa_destino || input.empresa || input.destinatario),
    data_envio: dataEnvio,
    categoria_retorno: retornoCategoria,
    local_retorno: retornoLocal,
    anv_retorno: retornoAnv,
    data_retorno: dataRetorno,
    condicao_retorno: normalizeCode(input.condicao_retorno) || 'DESCONHECIDA',
    documento_referencia: cleanText(input.documento_referencia),
    observacao: cleanText(input.observacao),
    pn: normalizeCode(equipment.pn),
    sn: normalizeSn(equipment.sn),
    equipment_id: Number(equipment.id),
  };
}

function sharedPayload(snapshot, cardKey) {
  return {
    stc: {
      card_key: cardKey,
      ...snapshot,
    },
  };
}

async function upsertSimpleStage(equipment, snapshot, cardKey, stage, eventInput, user = {}) {
  return equipmentService.addEvent(equipment.id, {
    ...eventInput,
    documento_tipo: 'STC',
    documento: snapshot.numero_stc,
    origem_evento: 'STC',
    origem_registro_id: stageKey(cardKey, stage),
    automatico: false,
    payload: {
      ...sharedPayload(snapshot, cardKey),
      ...(eventInput.payload && typeof eventInput.payload === 'object' ? eventInput.payload : {}),
    },
  }, user);
}

function originMatchesCurrent(equipment, snapshot) {
  const informed = locationSignature(
    snapshot.categoria_origem_informada,
    snapshot.origem_informada,
    snapshot.anv_origem_informada,
  );
  const informedHasLocation = Boolean(snapshot.origem_informada || snapshot.anv_origem_informada || snapshot.categoria_origem_informada);
  if (!informedHasLocation) return false;
  return informed === equipmentLocationSignature(equipment);
}

async function createOrUpdateSendEvent(equipment, snapshot, cardKey, user = {}) {
  if (!snapshot.data_envio) return { action: 'NOT_APPLICABLE' };
  const destinationKnown = Boolean(snapshot.local_destino || snapshot.anv_destino || (snapshot.categoria_destino && snapshot.categoria_destino !== 'DESCONHECIDO'));
  if (!destinationKnown) {
    const event = await upsertSimpleStage(equipment, snapshot, cardKey, 'ENVIO', {
      tipo_evento: 'ENVIO_STC',
      data_evento: snapshot.data_envio,
      categoria_destino: 'DESCONHECIDO',
      local_destino: null,
      status_resultante: 'STC_ENVIADA_LOCAL_A_CONFIRMAR',
      condicao_resultante: equipment.condicao_atual || 'DESCONHECIDA',
      confianca: 'MEDIA',
      motivo: `STC ${snapshot.numero_stc} registra saída do equipamento, mas o destino precisa ser confirmado.`,
      observacao: snapshot.observacao || snapshot.descricao,
    }, user);
    return { action: 'EVENT_CREATED', event };
  }

  const originWasInformed = Boolean(snapshot.origem_informada || snapshot.anv_origem_informada || snapshot.categoria_origem_informada);
  const confirmedTransition = !equipment.local_atual || normalizeCode(equipment.categoria_local_atual) === 'DESCONHECIDO' || !originWasInformed || originMatchesCurrent(equipment, snapshot);
  const result = await equipmentService.registerLocationEvidence(equipment.id, {
    tipo_evento: 'ENVIO_STC',
    data_evento: snapshot.data_envio,
    categoria_destino: snapshot.categoria_destino,
    local_destino: snapshot.local_destino,
    anv_destino: snapshot.anv_destino,
    status_resultante: 'STC_ENVIADA',
    condicao_resultante: equipment.condicao_atual || 'DESCONHECIDA',
    confianca: 'ALTA',
    motivo: `STC ${snapshot.numero_stc} registra envio/transferência do equipamento.`,
    observacao: snapshot.observacao || snapshot.descricao,
    payload: sharedPayload(snapshot, cardKey),
  }, {
    source_type: 'STC',
    origin_event: 'STC',
    source_key: stageKey(cardKey, 'ENVIO'),
    documento: snapshot.numero_stc,
    data_evento: snapshot.data_envio,
    observacao: snapshot.observacao || snapshot.descricao,
  }, user, { automatico: false, confirmedTransition });

  if (result.action === 'SAME_LOCATION') {
    const event = await upsertSimpleStage(equipment, snapshot, cardKey, 'ENVIO', {
      tipo_evento: 'ENVIO_STC',
      data_evento: snapshot.data_envio,
      categoria_destino: snapshot.categoria_destino,
      local_destino: snapshot.local_destino,
      anv_destino: snapshot.anv_destino,
      status_resultante: 'STC_ENVIADA',
      condicao_resultante: equipment.condicao_atual || 'DESCONHECIDA',
      confianca: 'ALTA',
      motivo: `STC ${snapshot.numero_stc} confirma movimentação para a localização que já estava vigente.`,
      observacao: snapshot.observacao || snapshot.descricao,
    }, user);
    return { action: 'EVENT_CREATED', event };
  }
  return result;
}

async function createOrUpdateReturnEvent(equipment, snapshot, cardKey, user = {}) {
  if (!snapshot.data_retorno) return { action: 'NOT_APPLICABLE' };
  const current = await equipmentService.getEquipment(equipment.id);
  const returnKnown = Boolean(snapshot.local_retorno || snapshot.anv_retorno || (snapshot.categoria_retorno && snapshot.categoria_retorno !== 'DESCONHECIDO'));
  if (!returnKnown) {
    const event = await upsertSimpleStage(current, snapshot, cardKey, 'RETORNO', {
      tipo_evento: 'RETORNO_STC',
      data_evento: snapshot.data_retorno,
      categoria_destino: 'DESCONHECIDO',
      local_destino: null,
      status_resultante: 'RETORNO_STC_LOCAL_A_CONFIRMAR',
      condicao_resultante: snapshot.condicao_retorno,
      confianca: 'ALTA',
      motivo: `STC ${snapshot.numero_stc} registra retorno. A localização interna após o retorno precisa ser confirmada.`,
      observacao: snapshot.observacao || snapshot.descricao,
    }, user);
    return { action: 'EVENT_CREATED', event };
  }

  const expectedExternal = locationSignature(snapshot.categoria_destino, snapshot.local_destino, snapshot.anv_destino);
  const expectedExternalKnown = Boolean(snapshot.local_destino || snapshot.anv_destino || (snapshot.categoria_destino && snapshot.categoria_destino !== 'DESCONHECIDO'));
  const confirmedTransition = !current.local_atual || normalizeCode(current.categoria_local_atual) === 'DESCONHECIDO' || !expectedExternalKnown || equipmentLocationSignature(current) === expectedExternal;
  const result = await equipmentService.registerLocationEvidence(current.id, {
    tipo_evento: 'RETORNO_STC',
    data_evento: snapshot.data_retorno,
    categoria_destino: snapshot.categoria_retorno,
    local_destino: snapshot.local_retorno,
    anv_destino: snapshot.anv_retorno,
    status_resultante: 'STC_RETORNADA',
    condicao_resultante: snapshot.condicao_retorno,
    confianca: 'ALTA',
    motivo: `STC ${snapshot.numero_stc} registra retorno do equipamento.`,
    observacao: snapshot.observacao || snapshot.descricao,
    payload: sharedPayload(snapshot, cardKey),
  }, {
    source_type: 'STC',
    origin_event: 'STC',
    source_key: stageKey(cardKey, 'RETORNO'),
    documento: snapshot.numero_stc,
    data_evento: snapshot.data_retorno,
    observacao: snapshot.observacao || snapshot.descricao,
  }, user, { automatico: false, confirmedTransition });

  if (result.action === 'SAME_LOCATION') {
    const event = await upsertSimpleStage(current, snapshot, cardKey, 'RETORNO', {
      tipo_evento: 'RETORNO_STC',
      data_evento: snapshot.data_retorno,
      categoria_destino: snapshot.categoria_retorno,
      local_destino: snapshot.local_retorno,
      anv_destino: snapshot.anv_retorno,
      status_resultante: 'STC_RETORNADA',
      condicao_resultante: snapshot.condicao_retorno,
      confianca: 'ALTA',
      motivo: `STC ${snapshot.numero_stc} confirma retorno para a localização que já estava vigente.`,
      observacao: snapshot.observacao || snapshot.descricao,
    }, user);
    return { action: 'EVENT_CREATED', event };
  }
  return result;
}

async function saveStc(input = {}, user = {}, expectedCardKey = null) {
  const existing = expectedCardKey ? await getStcCard(expectedCardKey) : null;
  if (expectedCardKey && !existing) throw new Error('STC não encontrada para edição.');
  const equipment = await findEquipment(input);
  const snapshot = normalizeStcInput(input, equipment);
  if (existing?.status === 'RETORNADA' && snapshot.status !== 'RETORNADA') throw new Error('Uma STC já retornada não pode regredir de status. Corrija os dados mantendo RETORNADA ou cancele a STC com motivo.');
  if (existing?.status === 'ENVIADA' && snapshot.status === 'REGISTRADA') throw new Error('Uma STC já enviada não pode voltar para REGISTRADA. Corrija os dados mantendo ENVIADA/RETORNADA ou cancele a STC com motivo.');
  const cardKey = stcCardKey(equipment.id, snapshot.numero_stc);
  if (!expectedCardKey) {
    const duplicate = await getStcCard(cardKey);
    if (duplicate) throw new Error(`Já existe a STC ${snapshot.numero_stc} para PN ${equipment.pn} / SN ${equipment.sn}. Abra o card existente para editar ou cancelar.`);
  }
  if (existing?.status === 'CANCELADA') throw new Error('STC cancelada não pode ser reaberta. Registre uma nova STC para preservar o histórico.');
  if (expectedCardKey && expectedCardKey !== cardKey) {
    throw new Error('PN, SN e número da STC não podem ser alterados nesta edição. Cancele o card incorreto e registre uma nova STC para preservar a rastreabilidade.');
  }

  const registerEvent = await upsertSimpleStage(equipment, snapshot, cardKey, 'REGISTRO', {
    tipo_evento: 'STC_REGISTRADA',
    data_evento: snapshot.data_envio || new Date().toISOString(),
    status_resultante: equipment.status_atual || 'DESCONHECIDO',
    condicao_resultante: equipment.condicao_atual || 'DESCONHECIDA',
    confianca: 'CONFIRMADA',
    motivo: `STC ${snapshot.numero_stc} registrada para PN ${snapshot.pn} / SN ${snapshot.sn}.`,
    observacao: snapshot.observacao || snapshot.descricao,
  }, user);

  const sendResult = await createOrUpdateSendEvent(equipment, snapshot, cardKey, user);
  const returnResult = await createOrUpdateReturnEvent(equipment, snapshot, cardKey, user);

  return {
    card_key: cardKey,
    equipment_id: equipment.id,
    pn: equipment.pn,
    sn: equipment.sn,
    numero_stc: snapshot.numero_stc,
    status: snapshot.status,
    register_event_id: registerEvent?.id || null,
    envio: { action: sendResult.action, event_id: sendResult.event?.id || sendResult.conflict?.id || null },
    retorno: { action: returnResult.action, event_id: returnResult.event?.id || returnResult.conflict?.id || null },
    conflito_localizacao: [sendResult.action, returnResult.action].includes('CONFLICT'),
  };
}

function cardFromGroup(cardKey, events, equipment) {
  const sorted = [...events].sort((a, b) => new Date(b.data_evento || 0) - new Date(a.data_evento || 0));
  const payloadEvent = sorted.find((event) => event?.payload?.stc) || sorted[0];
  const snapshot = payloadEvent?.payload?.stc || {};
  const cancelled = sorted.some((event) => event.tipo_evento === 'STC_CANCELADA' && !event.invalidado);
  const returned = sorted.some((event) => event.tipo_evento === 'RETORNO_STC' && !event.invalidado);
  const sent = sorted.some((event) => event.tipo_evento === 'ENVIO_STC' && !event.invalidado);
  return {
    card_key: cardKey,
    equipment_id: Number(snapshot.equipment_id || equipment?.id || payloadEvent?.equipamento_id),
    pn: snapshot.pn || equipment?.pn || payloadEvent?.pn,
    sn: snapshot.sn || equipment?.sn || payloadEvent?.sn,
    nomenclatura: equipment?.nomenclatura || null,
    numero_stc: snapshot.numero_stc || payloadEvent?.documento,
    status: cancelled ? 'CANCELADA' : returned ? 'RETORNADA' : sent ? 'ENVIADA' : snapshot.status || 'REGISTRADA',
    motivo_stc: snapshot.motivo_stc || null,
    descricao: snapshot.descricao || null,
    origem_informada: snapshot.origem_informada || null,
    categoria_origem_informada: snapshot.categoria_origem_informada || null,
    anv_origem_informada: snapshot.anv_origem_informada || null,
    categoria_destino: snapshot.categoria_destino || null,
    local_destino: snapshot.local_destino || null,
    anv_destino: snapshot.anv_destino || null,
    empresa_destino: snapshot.empresa_destino || null,
    data_envio: snapshot.data_envio || null,
    categoria_retorno: snapshot.categoria_retorno || null,
    local_retorno: snapshot.local_retorno || null,
    anv_retorno: snapshot.anv_retorno || null,
    data_retorno: snapshot.data_retorno || null,
    condicao_retorno: snapshot.condicao_retorno || null,
    documento_referencia: snapshot.documento_referencia || null,
    observacao: snapshot.observacao || null,
    equipamento_local_atual: equipment?.local_atual || null,
    equipamento_categoria_atual: equipment?.categoria_local_atual || null,
    equipamento_anv_atual: equipment?.anv_atual || null,
    events: sorted,
  };
}

async function listStcCards({ q = '', limit = 500 } = {}) {
  const safeLimit = Math.max(1, Math.min(Number(limit) || 500, 2000));
  const { data: events, error } = await supabase
    .from('equipamento_eventos')
    .select('*')
    .eq('origem_evento', 'STC')
    .in('tipo_evento', STC_EVENT_TYPES)
    .order('data_evento', { ascending: false })
    .limit(safeLimit * 4);
  if (error) throw error;

  const grouped = new Map();
  for (const event of events || []) {
    const key = event?.payload?.stc?.card_key || cleanText(event.origem_registro_id)?.replace(/:(REGISTRO|ENVIO|RETORNO|CANCELAMENTO)$/i, '') || `STC_EVENT:${event.id}`;
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(event);
  }

  const equipmentIds = [...new Set([...grouped.values()].flat().map((event) => event.equipamento_id).filter(Boolean))];
  let equipments = [];
  if (equipmentIds.length) {
    const { data, error: equipmentError } = await supabase
      .from('equipamentos_serializados')
      .select('*')
      .in('id', equipmentIds);
    if (equipmentError) throw equipmentError;
    equipments = data || [];
  }
  const equipmentById = new Map(equipments.map((item) => [String(item.id), item]));

  const term = normalizeCode(q);
  const cards = [...grouped.entries()]
    .map(([key, group]) => cardFromGroup(key, group, equipmentById.get(String(group[0]?.equipamento_id))))
    .filter((card) => {
      if (!term) return true;
      return [card.numero_stc, card.pn, card.sn, card.nomenclatura, card.local_destino, card.empresa_destino, card.status, card.motivo_stc]
        .some((value) => normalizeCode(value)?.includes(term));
    })
    .sort((a, b) => new Date(b.data_envio || b.data_retorno || 0) - new Date(a.data_envio || a.data_retorno || 0));

  return cards.slice(0, safeLimit);
}

async function getStcCard(cardKey) {
  const key = cleanText(cardKey);
  if (!key) return null;
  const { data: events, error } = await supabase
    .from('equipamento_eventos')
    .select('*')
    .eq('origem_evento', 'STC')
    .like('origem_registro_id', `${key}:%`)
    .order('data_evento', { ascending: false });
  if (error) throw error;
  if (!events?.length) return null;
  const equipmentId = events[0].equipamento_id;
  const { data: equipment, error: equipmentError } = await supabase
    .from('equipamentos_serializados')
    .select('*')
    .eq('id', equipmentId)
    .maybeSingle();
  if (equipmentError) throw equipmentError;
  return cardFromGroup(key, events, equipment || null);
}

async function cancelStc(cardKey, reason, user = {}) {
  const motivo = cleanText(reason);
  if (!motivo) throw new Error('Informe o motivo do cancelamento da STC.');
  const card = await getStcCard(cardKey);
  if (!card) throw new Error('STC não encontrada.');
  if (card.status === 'CANCELADA') throw new Error('Esta STC já está cancelada.');

  const activeStageEvents = (card.events || []).filter((event) => !event.invalidado && ['STC_REGISTRADA', 'ENVIO_STC', 'RETORNO_STC'].includes(event.tipo_evento));
  for (const event of activeStageEvents) {
    await equipmentService.invalidateEvent(card.equipment_id, event.id, `STC cancelada: ${motivo}`, user);
  }

  const equipment = await equipmentService.getEquipment(card.equipment_id);
  const snapshot = card.events?.find((event) => event?.payload?.stc)?.payload?.stc || card;
  const cancelEvent = await upsertSimpleStage(equipment, snapshot, cardKey, 'CANCELAMENTO', {
    tipo_evento: 'STC_CANCELADA',
    data_evento: new Date().toISOString(),
    status_resultante: equipment.status_atual || 'DESCONHECIDO',
    condicao_resultante: equipment.condicao_atual || 'DESCONHECIDA',
    confianca: 'CONFIRMADA',
    motivo: `STC ${card.numero_stc} cancelada. Os eventos anteriores permanecem no Livro como histórico invalidado.`,
    observacao: motivo,
  }, user);

  return { card_key: cardKey, cancel_event_id: cancelEvent?.id || null, equipamento: await equipmentService.getEquipment(card.equipment_id) };
}

module.exports = {
  STC_EVENT_TYPES,
  listStcCards,
  getStcCard,
  saveStc,
  cancelStc,
};
