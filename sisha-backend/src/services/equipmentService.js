const supabase = require('../config/supabaseClient');
const { getSupabaseAdmin } = require('../config/supabaseAdminClient');
const { buildEquipmentDossierSummary } = require('./equipmentDossierService');

const MAX_LIST = 500;

function h4bAcidEnabled() {
  return /^(1|true|yes|on)$/i.test(String(process.env.SISHA_H4B_ACID_EQUIPMENT_ENABLED || 'false').trim());
}

function getH4bAcidDb() {
  return getSupabaseAdmin();
}

function cleanText(value) {
  const text = String(value ?? '').trim();
  return text || null;
}

function normalizeCode(value) {
  const text = cleanText(value);
  return text ? text.toUpperCase() : null;
}

function normalizeDate(value) {
  const text = cleanText(value);
  if (!text) return null;
  const date = new Date(text);
  if (Number.isNaN(date.getTime())) return text.slice(0, 10);
  return date.toISOString().slice(0, 10);
}

function normalizeTimestamp(value) {
  const text = cleanText(value);
  if (!text) return new Date().toISOString();
  const date = new Date(text);
  if (Number.isNaN(date.getTime())) throw new Error('Data do evento inválida.');
  return date.toISOString();
}

function assertIdentity(pn, sn) {
  if (!pn || !sn) throw new Error('PN e SN são obrigatórios para identificar um equipamento.');
}

function normalizeSn(value) {
  const text = normalizeCode(value);
  return text ? text.replace(/\s+/g, '') : null;
}

function normalizeComparable(value) {
  return String(value || '').trim().toUpperCase().replace(/\s+/g, ' ');
}

function stateSnapshot(input = {}) {
  return {
    categoria_local_atual: normalizeCode(input.categoria_local_atual) || 'DESCONHECIDO',
    local_atual: cleanText(input.local_atual),
    anv_atual: cleanText(input.anv_atual),
    status_atual: cleanText(input.status_atual) || 'DESCONHECIDO',
    condicao_atual: cleanText(input.condicao_atual) || 'DESCONHECIDA',
    confianca_localizacao: normalizeCode(input.confianca_localizacao) || 'DESCONHECIDA',
  };
}

function locationSignature(input = {}) {
  const state = stateSnapshot(input);
  return [
    normalizeComparable(state.categoria_local_atual),
    normalizeComparable(state.local_atual),
    normalizeComparable(state.anv_atual),
  ].join('|');
}

function isKnownLocation(input = {}) {
  const state = stateSnapshot(input);
  return Boolean(
    (state.local_atual && normalizeComparable(state.local_atual) !== 'DESCONHECIDO') ||
    (state.anv_atual && normalizeComparable(state.anv_atual) !== 'DESCONHECIDO') ||
    !['', 'DESCONHECIDO'].includes(normalizeComparable(state.categoria_local_atual))
  );
}

function chunkArray(items = [], size = 250) {
  const chunks = [];
  for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size));
  return chunks;
}

async function listEquipments({ q = '', limit = 250 } = {}) {
  const safeLimit = Math.max(1, Math.min(Number(limit) || 250, MAX_LIST));
  let query = supabase
    .from('v_sisha_equipamentos_search')
    .select('*')
    .order('pn', { ascending: true })
    .order('sn', { ascending: true })
    .limit(safeLimit);

  const term = cleanText(q);
  if (term) query = query.ilike('search_text', `%${term}%`);

  const { data, error } = await query;
  if (error) throw error;
  // A view atual pode ou não expor `ativo`. Quando expõe, equipamentos arquivados
  // deixam de aparecer nas consultas de rotina. Quando não expõe, mantemos
  // compatibilidade com a definição já existente da view.
  return (data || []).filter((item) => item?.ativo !== false);
}

async function getEquipment(id) {
  const { data: equipment, error } = await supabase
    .from('equipamentos_serializados')
    .select('*')
    .eq('id', id)
    .maybeSingle();
  if (error) throw error;
  if (!equipment) return null;

  const { data: events, error: eventsError } = await supabase
    .from('equipamento_eventos')
    .select('*')
    .eq('equipamento_id', id)
    .order('data_evento', { ascending: false })
    .order('id', { ascending: false });
  if (eventsError) throw eventsError;

  const eventRows = events || [];
  return {
    ...equipment,
    eventos: eventRows,
    dossie_resumo: buildEquipmentDossierSummary(equipment, eventRows),
  };
}

async function findDuplicate(pn, sn, ignoreId = null) {
  let query = supabase
    .from('equipamentos_serializados')
    .select('id,pn,sn,ativo')
    .ilike('pn', pn)
    .ilike('sn', sn)
    .limit(2);
  if (ignoreId) query = query.neq('id', ignoreId);
  const { data, error } = await query;
  if (error) throw error;
  return (data || [])[0] || null;
}

function buildEquipmentPayload(input = {}, user = {}, current = {}) {
  const pn = normalizeCode(input.pn ?? current.pn);
  const sn = normalizeSn(input.sn ?? current.sn);
  assertIdentity(pn, sn);

  return {
    pn,
    sn,
    nomenclatura: cleanText(input.nomenclatura ?? current.nomenclatura),
    garantia_inicio: normalizeDate(input.garantia_inicio ?? current.garantia_inicio),
    garantia_vencimento: normalizeDate(input.garantia_vencimento ?? current.garantia_vencimento),
    garantia_observacao: cleanText(input.garantia_observacao ?? current.garantia_observacao),
    garantia_documento: cleanText(input.garantia_documento ?? current.garantia_documento),
    garantia_alerta_ativo: input.garantia_alerta_ativo ?? current.garantia_alerta_ativo ?? true,
    horas_acumuladas: Number(input.horas_acumuladas ?? current.horas_acumuladas ?? 0) || 0,
    origem_entrada: cleanText(input.origem_entrada ?? current.origem_entrada),
    documento_entrada: cleanText(input.documento_entrada ?? current.documento_entrada),
    data_entrada: normalizeDate(input.data_entrada ?? current.data_entrada),
    atualizado_por: user.email || null,
    updated_at: new Date().toISOString(),
    ativo: input.ativo ?? current.ativo ?? true,
  };
}

async function createEquipment(input = {}, user = {}) {
  const payload = buildEquipmentPayload(input, user);
  const duplicate = await findDuplicate(payload.pn, payload.sn);
  if (duplicate) throw new Error(`Já existe equipamento cadastrado com PN ${payload.pn} e SN ${payload.sn}.`);

  const hasInitialEvidence = [input.local_atual, input.categoria_local_atual, input.status_atual, input.condicao_atual, input.anv_atual]
    .some((value) => cleanText(value));
  const initialEvent = hasInitialEvidence ? {
    tipo_evento: 'CADASTRO_INICIAL',
    data_evento: input.data_entrada || new Date().toISOString(),
    local_destino: input.local_atual,
    categoria_destino: input.categoria_local_atual || 'DESCONHECIDO',
    status_resultante: input.status_atual || 'CADASTRADO',
    condicao_resultante: input.condicao_atual || 'DESCONHECIDA',
    anv_destino: input.anv_atual,
    documento_tipo: input.documento_entrada ? 'DOCUMENTO_ENTRADA' : 'CADASTRO_MANUAL',
    documento: input.documento_entrada,
    origem_evento: 'MANUAL',
    confianca: 'CONFIRMADA',
    motivo: input.motivo_inicial || 'Cadastro inicial do equipamento no SISHA.',
    observacao: input.observacao_inicial,
    payload: { project_current_state: true },
  } : null;

  if (h4bAcidEnabled()) {
    const { data, error } = await getH4bAcidDb().rpc('sisha_create_equipment_and_project_atomic', {
      p_equipment: {
        ...payload,
        status_atual: 'DESCONHECIDO',
        condicao_atual: 'DESCONHECIDA',
        categoria_local_atual: 'DESCONHECIDO',
        confianca_localizacao: 'DESCONHECIDA',
      },
      p_initial_event: initialEvent,
      p_user_email: user.email || null,
    });
    if (error) throw error;
    const equipmentId = data?.equipment_id || data?.equipment?.id;
    if (!equipmentId) throw new Error('RPC H4B não retornou o equipamento criado.');
    return getEquipment(equipmentId);
  }

  const { data, error } = await supabase
    .from('equipamentos_serializados')
    .insert({
      ...payload,
      status_atual: 'DESCONHECIDO',
      condicao_atual: 'DESCONHECIDA',
      categoria_local_atual: 'DESCONHECIDO',
      confianca_localizacao: 'DESCONHECIDA',
    })
    .select('*')
    .single();
  if (error) throw error;

  if (initialEvent) await addProjectedEvent(data.id, initialEvent, user);
  return getEquipment(data.id);
}

async function updateEquipment(id, input = {}, user = {}) {
  const current = await getEquipment(id);
  if (!current) return null;
  const payload = buildEquipmentPayload(input, user, current);
  const duplicate = await findDuplicate(payload.pn, payload.sn, id);
  if (duplicate) throw new Error(`Já existe outro equipamento com PN ${payload.pn} e SN ${payload.sn}.`);

  const previousState = stateSnapshot(current);
  const requestedState = stateSnapshot({ ...current, ...input });
  const identityChanged = payload.pn !== normalizeCode(current.pn) || payload.sn !== normalizeSn(current.sn);
  const stateChanged = [
    'categoria_local_atual',
    'local_atual',
    'anv_atual',
    'status_atual',
    'condicao_atual',
    'confianca_localizacao',
  ].some((field) => normalizeComparable(previousState[field]) !== normalizeComparable(requestedState[field]));

  const auditableCadastroFields = [
    ['nomenclatura', 'Nomenclatura'],
    ['garantia_inicio', 'Início da garantia'],
    ['garantia_vencimento', 'Vencimento da garantia'],
    ['garantia_observacao', 'Observação da garantia'],
    ['garantia_documento', 'Documento da garantia'],
    ['garantia_alerta_ativo', 'Alerta de garantia'],
    ['horas_acumuladas', 'Horas acumuladas'],
    ['origem_entrada', 'Origem da entrada'],
    ['documento_entrada', 'Documento de entrada'],
    ['data_entrada', 'Data de entrada'],
  ];
  const cadastroChanges = auditableCadastroFields.flatMap(([field, label]) => {
    if (!Object.prototype.hasOwnProperty.call(input, field)) return [];
    const before = current[field] ?? null;
    const after = payload[field] ?? null;
    if (normalizeComparable(before) === normalizeComparable(after)) return [];
    return [{ field, label, before, after }];
  });
  const cadastroChanged = cadastroChanges.length > 0;
  const hasAuditableChange = identityChanged || stateChanged || cadastroChanged;

  const correctionReason = cleanText(input.motivo_edicao);
  if ((identityChanged || stateChanged) && !correctionReason) {
    throw new Error('Informe o motivo da correção quando alterar PN, SN, localização, aeronave, status, condição ou confiança.');
  }

  const automaticCadastroReason = cadastroChanges
    .map(({ label, before, after }) => `${label}: ${before ?? '—'} → ${after ?? '—'}`)
    .join(' | ');

  const correctionEvent = hasAuditableChange ? {
    tipo_evento: identityChanged ? 'CORRECAO_CADASTRAL' : (stateChanged ? 'AJUSTE_MANUAL' : 'ATUALIZACAO_CADASTRAL'),
    data_evento: new Date().toISOString(),
    local_destino: requestedState.local_atual,
    categoria_destino: requestedState.categoria_local_atual,
    anv_destino: requestedState.anv_atual,
    status_resultante: requestedState.status_atual,
    condicao_resultante: requestedState.condicao_atual,
    confianca: requestedState.confianca_localizacao === 'DESCONHECIDA' ? 'CONFIRMADA' : requestedState.confianca_localizacao,
    documento_tipo: 'CORRECAO_CADASTRAL',
    documento: cleanText(input.documento_correcao),
    origem_evento: 'MANUAL',
    motivo: correctionReason || automaticCadastroReason || 'Atualização cadastral do equipamento.',
    observacao: cleanText(input.observacao_edicao),
    payload: {
      identidade_anterior: { pn: current.pn, sn: current.sn },
      identidade_atual: { pn: payload.pn, sn: payload.sn },
      estado_anterior: previousState,
      estado_confirmado: requestedState,
      alteracoes_cadastrais: cadastroChanges,
      project_current_state: stateChanged,
    },
  } : null;

  if (h4bAcidEnabled()) {
    const { error } = await getH4bAcidDb().rpc('sisha_update_equipment_and_project_atomic', {
      p_equipment_id: Number(id),
      p_equipment: payload,
      p_event: correctionEvent,
      p_user_email: user.email || null,
    });
    if (error) throw error;
    return getEquipment(id);
  }

  const { error } = await supabase
    .from('equipamentos_serializados')
    .update(payload)
    .eq('id', id);
  if (error) throw error;

  if (correctionEvent) {
    if (stateChanged) await addProjectedEvent(id, correctionEvent, user);
    else await addEvent(id, correctionEvent, user);
  }
  return getEquipment(id);
}


function eventDefinesCurrentLocation(event = {}) {
  if (!event || event.invalidado) return false;
  if (event?.payload?.historical_only === true) return false;
  if (normalizeCode(event.tipo_evento) === 'CONFLITO_LOCALIZACAO') return false;
  const category = normalizeCode(event.categoria_destino);
  const explicitProjection = event?.payload?.project_current_state === true;
  return Boolean(explicitProjection || cleanText(event.local_destino) || cleanText(event.anv_destino || event.anv) || (category && category !== 'DESCONHECIDO'));
}

async function recomputeEquipmentProjection(id, user = {}) {
  const current = await getEquipment(id);
  if (!current) throw new Error('Equipamento não encontrado.');
  const latest = (current.eventos || []).find(eventDefinesCurrentLocation) || null;
  const next = latest ? {
    categoria_local_atual: normalizeCode(latest.categoria_destino) || 'DESCONHECIDO',
    local_atual: cleanText(latest.local_destino),
    anv_atual: cleanText(latest.anv_destino || latest.anv),
    status_atual: cleanText(latest.status_resultante) || current.status_atual || 'DESCONHECIDO',
    condicao_atual: cleanText(latest.condicao_resultante) || current.condicao_atual || 'DESCONHECIDA',
    confianca_localizacao: normalizeCode(latest.confianca) || 'DESCONHECIDA',
  } : {
    categoria_local_atual: 'DESCONHECIDO',
    local_atual: null,
    anv_atual: null,
    status_atual: 'DESCONHECIDO',
    condicao_atual: 'DESCONHECIDA',
    confianca_localizacao: 'DESCONHECIDA',
  };

  const { error } = await supabase
    .from('equipamentos_serializados')
    .update({ ...next, atualizado_por: user.email || null, updated_at: new Date().toISOString() })
    .eq('id', id);
  if (error) throw error;
  return getEquipment(id);
}

async function addProjectedEvent(id, input = {}, user = {}) {
  const projectedInput = {
    ...input,
    payload: {
      ...(input?.payload && typeof input.payload === 'object' ? input.payload : {}),
      project_current_state: true,
    },
  };
  if (h4bAcidEnabled()) {
    const { data, error } = await getH4bAcidDb().rpc('sisha_record_equipment_event_and_project_atomic', {
      p_equipment_id: Number(id),
      p_event: projectedInput,
      p_user_email: user.email || null,
    });
    if (error) throw error;
    const eventId = data?.event_id;
    if (!eventId) throw new Error('RPC não retornou o evento de movimentação.');
    const { data: event, error: readError } = await supabase
      .from('equipamento_eventos')
      .select('*')
      .eq('id', eventId)
      .single();
    if (readError) throw readError;
    return event;
  }

  const event = await addEvent(id, projectedInput, user);
  await recomputeEquipmentProjection(id, user);
  return event;
}

async function addEvent(id, input = {}, user = {}) {
  const current = await getEquipment(id);
  if (!current) throw new Error('Equipamento não encontrado.');

  const tipoEvento = normalizeCode(input.tipo_evento);
  const motivo = cleanText(input.motivo);
  if (!tipoEvento) throw new Error('Tipo do evento é obrigatório.');
  if (!motivo) throw new Error('Motivo/descrição do movimento é obrigatório para auditoria.');

  const payload = {
    equipamento_id: Number(id),
    pn: current.pn,
    sn: current.sn,
    tipo_evento: tipoEvento,
    data_evento: normalizeTimestamp(input.data_evento),
    pim: cleanText(input.pim),
    os: cleanText(input.os),
    anv: cleanText(input.anv_destino ?? input.anv),
    horas_evento: input.horas_evento === '' || input.horas_evento == null ? null : Number(input.horas_evento),
    local_origem: current.local_atual || null,
    local_destino: cleanText(input.local_destino),
    categoria_origem: current.categoria_local_atual || null,
    categoria_destino: cleanText(input.categoria_destino),
    status_resultante: cleanText(input.status_resultante) || current.status_atual || 'DESCONHECIDO',
    condicao_resultante: cleanText(input.condicao_resultante) || current.condicao_atual || 'DESCONHECIDA',
    anv_destino: cleanText(input.anv_destino),
    motivo,
    documento_tipo: normalizeCode(input.documento_tipo),
    documento: cleanText(input.documento),
    observacao: cleanText(input.observacao),
    usuario: user.email || null,
    origem_evento: normalizeCode(input.origem_evento) || 'MANUAL',
    origem_registro_id: cleanText(input.origem_registro_id),
    confianca: normalizeCode(input.confianca) || 'CONFIRMADA',
    automatico: Boolean(input.automatico),
    invalidado: false,
    payload: input.payload && typeof input.payload === 'object' ? input.payload : {},
  };

  const table = supabase.from('equipamento_eventos');
  const mutation = payload.origem_registro_id && payload.origem_evento !== 'MANUAL'
    ? table.upsert(payload, { onConflict: 'origem_evento,origem_registro_id' })
    : table.insert(payload);
  const { data, error } = await mutation.select('*').single();
  if (error) throw error;
  return data;
}

async function invalidateEvent(equipmentId, eventId, reason, user = {}) {
  const motivo = cleanText(reason);
  if (!motivo) throw new Error('Informe o motivo da invalidação do evento.');

  if (h4bAcidEnabled()) {
    const { error } = await getH4bAcidDb().rpc('sisha_invalidate_equipment_event_and_project_atomic', {
      p_equipment_id: Number(equipmentId),
      p_event_id: Number(eventId),
      p_reason: motivo,
      p_user_email: user.email || null,
    });
    if (error) throw error;
    return getEquipment(equipmentId);
  }

  const { data: event, error: readError } = await supabase
    .from('equipamento_eventos')
    .select('id,equipamento_id,invalidado')
    .eq('id', eventId)
    .eq('equipamento_id', equipmentId)
    .maybeSingle();
  if (readError) throw readError;
  if (!event) throw new Error('Evento não encontrado para este equipamento.');
  if (event.invalidado) throw new Error('Este evento já está invalidado.');

  const { error } = await supabase
    .from('equipamento_eventos')
    .update({
      invalidado: true,
      invalidado_em: new Date().toISOString(),
      invalidado_por: user.email || null,
      motivo_invalidacao: motivo,
    })
    .eq('id', eventId)
    .eq('equipamento_id', equipmentId);
  if (error) throw error;
  return recomputeEquipmentProjection(equipmentId, user);
}

async function fetchEventsForEquipmentIds(ids = []) {
  if (!ids.length) return [];
  const { data, error } = await supabase
    .from('equipamento_eventos')
    .select('*')
    .in('equipamento_id', ids)
    .order('data_evento', { ascending: false })
    .order('id', { ascending: false });
  if (error) throw error;
  return data || [];
}

async function removeEquipment(id, user = {}) {
  const current = await getEquipment(id);
  if (!current) throw new Error('Equipamento não encontrado.');

  const { count, error: countError } = await supabase
    .from('equipamento_eventos')
    .select('id', { count: 'exact', head: true })
    .eq('equipamento_id', id);
  if (countError) throw countError;

  if (!count) {
    const { error: deleteError } = await supabase
      .from('equipamentos_serializados')
      .delete()
      .eq('id', id);
    if (!deleteError) return { mode: 'DELETE', id, pn: current.pn, sn: current.sn };
    // Se existir vínculo externo não mapeado, falha fechada para arquivamento lógico.
  }

  const { data, error } = await supabase
    .from('equipamentos_serializados')
    .update({ ativo: false, atualizado_por: user.email || null, updated_at: new Date().toISOString() })
    .eq('id', id)
    .select('*')
    .single();
  if (error) throw error;
  return { mode: 'ARCHIVE', id, pn: data.pn, sn: data.sn, event_count: Number(count || 0) };
}

async function upsertPendingLocationConflict(equipment, candidate = {}, source = {}, user = {}) {
  const sourceKey = cleanText(source.source_key) || [
    normalizeCode(source.source_type) || 'FONTE',
    cleanText(source.file_hash) || cleanText(source.documento) || 'SEM_HASH',
    cleanText(source.row_key) || `${equipment.id}:${locationSignature(candidate)}`,
  ].join(':');

  const { data: existingConflict, error: existingConflictError } = await supabase
    .from('equipamento_eventos')
    .select('*')
    .eq('origem_evento', 'RECONCILIACAO')
    .eq('origem_registro_id', sourceKey)
    .maybeSingle();
  if (existingConflictError) throw existingConflictError;
  if (existingConflict?.payload?.conflito_status && existingConflict.payload.conflito_status !== 'PENDENTE') {
    return existingConflict;
  }

  const payload = {
    conflito_status: 'PENDENTE',
    estado_atual: stateSnapshot(equipment),
    estado_candidato: stateSnapshot(candidate),
    fonte: {
      source_type: normalizeCode(source.source_type) || 'IMPORTACAO',
      documento: cleanText(source.documento),
      file_hash: cleanText(source.file_hash),
      arquivo: cleanText(source.arquivo),
      linha: source.linha || null,
      observacao: cleanText(source.observacao),
    },
  };

  const eventPayload = {
    equipamento_id: Number(equipment.id),
    pn: equipment.pn,
    sn: equipment.sn,
    tipo_evento: 'CONFLITO_LOCALIZACAO',
    data_evento: normalizeTimestamp(candidate.data_evento || source.data_evento || new Date().toISOString()),
    local_origem: equipment.local_atual || null,
    local_destino: cleanText(candidate.local_atual || candidate.local_destino),
    categoria_origem: equipment.categoria_local_atual || null,
    categoria_destino: normalizeCode(candidate.categoria_local_atual || candidate.categoria_destino) || 'DESCONHECIDO',
    status_resultante: cleanText(candidate.status_atual || candidate.status_resultante) || equipment.status_atual || 'DESCONHECIDO',
    condicao_resultante: cleanText(candidate.condicao_atual || candidate.condicao_resultante) || equipment.condicao_atual || 'DESCONHECIDA',
    anv: cleanText(candidate.anv_atual || candidate.anv_destino),
    anv_destino: cleanText(candidate.anv_atual || candidate.anv_destino),
    motivo: 'Nova evidência indica uma localização diferente da posição atual confirmada.',
    documento_tipo: normalizeCode(source.source_type) || 'EVIDENCIA',
    documento: cleanText(source.documento || source.arquivo),
    observacao: cleanText(source.observacao),
    usuario: user.email || null,
    origem_evento: 'RECONCILIACAO',
    origem_registro_id: sourceKey,
    confianca: 'CONFLITANTE',
    automatico: true,
    invalidado: true,
    invalidado_em: new Date().toISOString(),
    invalidado_por: 'SISHA_AUTO',
    motivo_invalidacao: 'PENDENTE_RECONCILIACAO',
    payload,
  };

  const { data, error } = await supabase
    .from('equipamento_eventos')
    .upsert(eventPayload, { onConflict: 'origem_evento,origem_registro_id' })
    .select('*')
    .single();
  if (error) throw error;
  return data;
}

async function registerLocationEvidence(equipmentId, candidate = {}, source = {}, user = {}, options = {}) {
  const equipment = await getEquipment(equipmentId);
  if (!equipment) throw new Error('Equipamento não encontrado para registrar evidência.');

  const candidateState = stateSnapshot({
    categoria_local_atual: candidate.categoria_local_atual || candidate.categoria_destino,
    local_atual: candidate.local_atual || candidate.local_destino,
    anv_atual: candidate.anv_atual || candidate.anv_destino,
    status_atual: candidate.status_atual || candidate.status_resultante,
    condicao_atual: candidate.condicao_atual || candidate.condicao_resultante,
    confianca_localizacao: candidate.confianca_localizacao || candidate.confianca || 'ALTA',
  });

  if (!isKnownLocation(candidateState)) {
    return { action: 'IGNORED_NO_LOCATION', equipment };
  }

  if (isKnownLocation(equipment) && locationSignature(equipment) === locationSignature(candidateState)) {
    return { action: 'SAME_LOCATION', equipment };
  }

  const candidateTime = new Date(candidate.data_evento || source.data_evento || '').getTime();
  const latestLocationEvent = (equipment.eventos || []).find((event) => {
    if (event?.invalidado) return false;
    const category = normalizeComparable(event?.categoria_destino);
    return Boolean(event?.local_destino || event?.anv_destino || (category && category !== 'DESCONHECIDO'));
  });
  const latestTime = latestLocationEvent ? new Date(latestLocationEvent.data_evento || '').getTime() : NaN;
  if (Number.isFinite(candidateTime) && Number.isFinite(latestTime) && candidateTime < latestTime) {
    const historicalEvent = await addEvent(equipmentId, {
      tipo_evento: normalizeCode(candidate.tipo_evento) || 'EVIDENCIA_HISTORICA_LOCALIZACAO',
      data_evento: candidate.data_evento || source.data_evento,
      local_destino: candidateState.local_atual,
      categoria_destino: candidateState.categoria_local_atual,
      anv_destino: candidateState.anv_atual,
      status_resultante: candidateState.status_atual,
      condicao_resultante: candidateState.condicao_atual,
      confianca: candidateState.confianca_localizacao || 'ALTA',
      documento_tipo: normalizeCode(source.source_type) || 'EVIDENCIA',
      documento: cleanText(source.documento || source.arquivo),
      origem_evento: normalizeCode(source.origin_event) || normalizeCode(source.source_type) || 'IMPORTACAO',
      origem_registro_id: cleanText(source.source_key),
      automatico: options.automatico !== false,
      motivo: cleanText(candidate.motivo) || 'Evidência histórica de localização registrada sem substituir o estado atual mais recente.',
      observacao: cleanText(source.observacao || candidate.observacao),
      payload: {
        historical_only: true,
        latest_valid_location_event_id: latestLocationEvent?.id || null,
        fonte: {
          source_type: normalizeCode(source.source_type) || 'IMPORTACAO',
          documento: cleanText(source.documento),
          arquivo: cleanText(source.arquivo),
          file_hash: cleanText(source.file_hash),
          linha: source.linha || null,
        },
        ...(candidate.payload && typeof candidate.payload === 'object' ? candidate.payload : {}),
      },
    }, user);
    return { action: 'HISTORICAL_EVENT', equipment: await getEquipment(equipmentId), event: historicalEvent };
  }

  if (isKnownLocation(equipment) && options.confirmedTransition !== true) {
    const conflict = await upsertPendingLocationConflict(equipment, { ...candidateState, data_evento: candidate.data_evento }, source, user);
    return { action: 'CONFLICT', equipment, conflict };
  }

  const event = await addProjectedEvent(equipmentId, {
    tipo_evento: normalizeCode(candidate.tipo_evento) || 'EVIDENCIA_LOCALIZACAO',
    data_evento: candidate.data_evento || source.data_evento || new Date().toISOString(),
    local_destino: candidateState.local_atual,
    categoria_destino: candidateState.categoria_local_atual,
    anv_destino: candidateState.anv_atual,
    status_resultante: candidateState.status_atual,
    condicao_resultante: candidateState.condicao_atual,
    confianca: candidateState.confianca_localizacao || 'ALTA',
    documento_tipo: normalizeCode(source.source_type) || 'EVIDENCIA',
    documento: cleanText(source.documento || source.arquivo),
    origem_evento: normalizeCode(source.origin_event) || normalizeCode(source.source_type) || 'IMPORTACAO',
    origem_registro_id: cleanText(source.source_key),
    automatico: options.automatico !== false,
    motivo: cleanText(candidate.motivo) || 'Evidência de localização registrada no Livro do Equipamento.',
    observacao: cleanText(source.observacao || candidate.observacao),
    payload: {
      fonte: {
        source_type: normalizeCode(source.source_type) || 'IMPORTACAO',
        documento: cleanText(source.documento),
        arquivo: cleanText(source.arquivo),
        file_hash: cleanText(source.file_hash),
        linha: source.linha || null,
      },
      ...(candidate.payload && typeof candidate.payload === 'object' ? candidate.payload : {}),
    },
  }, user);
  return { action: 'EVENT_CREATED', equipment: await getEquipment(equipmentId), event };
}

async function listLocationConflicts(limit = 250) {
  const safeLimit = Math.max(1, Math.min(Number(limit) || 250, 1000));
  const { data: events, error } = await supabase
    .from('equipamento_eventos')
    .select('*')
    .eq('tipo_evento', 'CONFLITO_LOCALIZACAO')
    .eq('invalidado', true)
    .order('data_evento', { ascending: false })
    .limit(safeLimit);
  if (error) throw error;

  const pending = (events || []).filter((event) => event?.payload?.conflito_status === 'PENDENTE');
  const ids = [...new Set(pending.map((event) => event.equipamento_id).filter(Boolean))];
  if (!ids.length) return [];

  const { data: equipments, error: equipmentError } = await supabase
    .from('equipamentos_serializados')
    .select('*')
    .in('id', ids);
  if (equipmentError) throw equipmentError;
  const byId = new Map((equipments || []).map((item) => [String(item.id), item]));

  return pending.map((event) => ({
    ...event,
    equipamento: byId.get(String(event.equipamento_id)) || null,
    estado_atual: stateSnapshot(byId.get(String(event.equipamento_id)) || event.payload?.estado_atual || {}),
    estado_candidato: event.payload?.estado_candidato || stateSnapshot({
      categoria_local_atual: event.categoria_destino,
      local_atual: event.local_destino,
      anv_atual: event.anv_destino || event.anv,
      status_atual: event.status_resultante,
      condicao_atual: event.condicao_resultante,
      confianca_localizacao: event.confianca,
    }),
  }));
}

async function resolveLocationConflict(equipmentId, eventId, input = {}, user = {}) {
  const decision = normalizeCode(input.decision);
  if (!['CURRENT', 'CANDIDATE'].includes(decision)) throw new Error('Decisão inválida. Use CURRENT ou CANDIDATE.');
  const reason = cleanText(input.motivo);
  if (!reason) throw new Error('Informe o motivo da reconciliação.');

  const current = await getEquipment(equipmentId);
  if (!current) throw new Error('Equipamento não encontrado.');
  const { data: conflict, error } = await supabase
    .from('equipamento_eventos')
    .select('*')
    .eq('id', eventId)
    .eq('equipamento_id', equipmentId)
    .eq('tipo_evento', 'CONFLITO_LOCALIZACAO')
    .maybeSingle();
  if (error) throw error;
  if (!conflict) throw new Error('Conflito de localização não encontrado.');
  if (conflict?.payload?.conflito_status !== 'PENDENTE') throw new Error('Este conflito já foi reconciliado.');

  const candidate = conflict.payload?.estado_candidato || {};
  const chosen = decision === 'CANDIDATE' ? candidate : stateSnapshot(current);
  const resolutionInput = {
    tipo_evento: 'RECONCILIACAO_LOCALIZACAO',
    data_evento: new Date().toISOString(),
    local_destino: chosen.local_atual,
    categoria_destino: chosen.categoria_local_atual,
    anv_destino: chosen.anv_atual,
    status_resultante: chosen.status_atual || current.status_atual,
    condicao_resultante: chosen.condicao_atual || current.condicao_atual,
    confianca: 'CONFIRMADA',
    documento_tipo: 'RECONCILIACAO',
    documento: conflict.documento,
    origem_evento: 'MANUAL',
    motivo: reason,
    observacao: decision === 'CANDIDATE'
      ? 'Admin confirmou a localização indicada pela nova evidência.'
      : 'Admin manteve a localização que já estava vigente e descartou a nova evidência como posição atual.',
    payload: {
      conflito_evento_id: conflict.id,
      decisao: decision,
      evidencia_original: conflict.payload?.fonte || null,
      estado_descartado: decision === 'CANDIDATE' ? conflict.payload?.estado_atual : candidate,
      project_current_state: true,
    },
  };

  if (h4bAcidEnabled()) {
    const { data, error: rpcError } = await getH4bAcidDb().rpc('sisha_resolve_location_conflict_and_project_atomic', {
      p_equipment_id: Number(equipmentId),
      p_conflict_event_id: Number(eventId),
      p_resolution_event: resolutionInput,
      p_decision: decision,
      p_reason: reason,
      p_user_email: user.email || null,
    });
    if (rpcError) throw rpcError;
    return {
      equipamento: await getEquipment(equipmentId),
      conflito: data?.conflict || conflict,
      evento_resolucao: data?.resolution_event || null,
    };
  }

  const resolutionEvent = await addProjectedEvent(equipmentId, resolutionInput, user);
  const nextPayload = {
    ...(conflict.payload || {}),
    conflito_status: 'RESOLVIDO',
    resolvido_em: new Date().toISOString(),
    resolvido_por: user.email || null,
    decisao: decision,
    motivo_resolucao: reason,
    evento_resolucao_id: resolutionEvent.id,
  };
  const { error: updateError } = await supabase
    .from('equipamento_eventos')
    .update({
      payload: nextPayload,
      motivo_invalidacao: decision === 'CANDIDATE' ? 'SUPERADO_POR_RECONCILIACAO' : 'DESCARTADO_POR_RECONCILIACAO',
      invalidado_por: user.email || null,
      invalidado_em: new Date().toISOString(),
    })
    .eq('id', conflict.id);
  if (updateError) throw updateError;

  return { equipamento: await getEquipment(equipmentId), conflito: { ...conflict, payload: nextPayload }, evento_resolucao: resolutionEvent };
}

async function fetchAllEquipmentRows() {
  const result = [];
  const pageSize = 1000;
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await supabase
      .from('equipamentos_serializados')
      .select('*')
      .range(from, from + pageSize - 1);
    if (error) throw error;
    result.push(...(data || []));
    if (!data || data.length < pageSize) break;
  }
  return result;
}

function sanitizeMasterRows(rows = []) {
  if (!Array.isArray(rows) || rows.length === 0) throw new Error('Nenhum equipamento foi enviado no cadastro mestre.');
  if (rows.length > 12000) throw new Error('O cadastro mestre excede o limite de 12.000 equipamentos por importação.');
  const seen = new Set();
  return rows.map((row, index) => {
    const pn = normalizeCode(row?.pn);
    const sn = normalizeSn(row?.sn);
    assertIdentity(pn, sn);
    const key = `${pn}::${sn}`;
    if (seen.has(key)) throw new Error(`PN ${pn} / SN ${sn} aparece mais de uma vez no cadastro mestre.`);
    seen.add(key);
    return {
      linha_origem: Number(row?.linha_origem || index + 1),
      arquivo_origem: cleanText(row?.arquivo_origem),
      aba_origem: cleanText(row?.aba_origem),
      pn,
      sn,
      nomenclatura: cleanText(row?.nomenclatura),
      localizacao: cleanText(row?.localizacao),
      categoria_destino: normalizeCode(row?.categoria_destino) || (cleanText(row?.localizacao) ? 'DESCONHECIDO' : 'DESCONHECIDO'),
      garantia_vencimento: normalizeDate(row?.garantia_vencimento),
      observacao: cleanText(row?.observacao),
    };
  });
}

async function applyEquipmentMaster(input = {}, user = {}) {
  const rows = sanitizeMasterRows(input.rows || []);
  const snapshotDate = normalizeDate(input.snapshot_date || new Date().toISOString());
  const fileName = cleanText(input.file_name) || 'cadastro_mestre_equipamentos';
  const fileHash = cleanText(input.file_hash) || 'SEM_HASH';
  const existingRows = await fetchAllEquipmentRows();
  const byIdentity = new Map(existingRows.map((item) => [`${normalizeCode(item.pn)}::${normalizeSn(item.sn)}`, item]));

  const toInsert = [];
  const existingMatched = [];
  for (const row of rows) {
    const existing = byIdentity.get(`${row.pn}::${row.sn}`);
    if (existing) existingMatched.push({ row, equipment: existing });
    else toInsert.push(row);
  }

  const inserted = [];
  for (const chunk of chunkArray(toInsert, 250)) {
    const payload = chunk.map((row) => ({
      pn: row.pn,
      sn: row.sn,
      nomenclatura: row.nomenclatura,
      garantia_vencimento: row.garantia_vencimento,
      status_atual: 'DESCONHECIDO',
      condicao_atual: 'DESCONHECIDA',
      categoria_local_atual: 'DESCONHECIDO',
      confianca_localizacao: 'DESCONHECIDA',
      origem_entrada: 'CADASTRO_MESTRE',
      documento_entrada: fileName,
      data_entrada: snapshotDate,
      atualizado_por: user.email || null,
      ativo: true,
    }));
    const { data, error } = await supabase
      .from('equipamentos_serializados')
      .upsert(payload, { onConflict: 'pn,sn', ignoreDuplicates: true })
      .select('*');
    if (error) throw error;
    inserted.push(...(data || []));
  }

  // Outro importador pode ter criado o mesmo PN+SN entre a fotografia inicial e
  // este upsert. Recarregamos os candidatos para convergir para uma única
  // identidade patrimonial em vez de falhar com 23505.
  const resolvedAfterRace = [];
  const toInsertPns = [...new Set(toInsert.map((row) => row.pn))];
  for (const chunk of chunkArray(toInsertPns, 250)) {
    if (!chunk.length) continue;
    const { data, error } = await supabase
      .from('equipamentos_serializados')
      .select('*')
      .in('pn', chunk);
    if (error) throw error;
    resolvedAfterRace.push(...(data || []));
  }
  const insertedByIdentity = new Map(resolvedAfterRace.map((item) => [`${normalizeCode(item.pn)}::${normalizeSn(item.sn)}`, item]));
  const allMatched = [
    ...existingMatched,
    ...toInsert.map((row) => ({ row, equipment: insertedByIdentity.get(`${row.pn}::${row.sn}`) })).filter((item) => item.equipment),
  ];

  let metadataUpdated = 0;
  let locationEvents = 0;
  let unchanged = 0;
  const conflicts = [];
  const warnings = [];

  for (const { row, equipment } of allMatched) {
    if (!equipment) continue;
    const update = {};
    if (!cleanText(equipment.nomenclatura) && row.nomenclatura) update.nomenclatura = row.nomenclatura;
    if (!equipment.garantia_vencimento && row.garantia_vencimento) update.garantia_vencimento = row.garantia_vencimento;
    if (equipment.ativo === false) warnings.push(`PN ${row.pn} / SN ${row.sn} já existe arquivado; o cadastro mestre não o reativou automaticamente.`);
    if (Object.keys(update).length) {
      update.atualizado_por = user.email || null;
      update.updated_at = new Date().toISOString();
      const { error } = await supabase.from('equipamentos_serializados').update(update).eq('id', equipment.id);
      if (error) throw error;
      metadataUpdated += 1;
    }

    if (!row.localizacao || equipment.ativo === false) {
      unchanged += 1;
      continue;
    }

    const candidate = {
      categoria_local_atual: row.categoria_destino || 'DESCONHECIDO',
      local_atual: row.localizacao,
      anv_atual: row.categoria_destino === 'AERONAVE' ? row.localizacao : null,
      status_atual: 'LOCALIZADO_CADASTRO_MESTRE',
      condicao_atual: equipment.condicao_atual || 'DESCONHECIDA',
      confianca_localizacao: 'ALTA',
      data_evento: snapshotDate,
    };

    if (!isKnownLocation(equipment)) {
      await addEvent(equipment.id, {
        tipo_evento: 'CADASTRO_MESTRE_LOCALIZACAO',
        data_evento: snapshotDate,
        local_destino: candidate.local_atual,
        categoria_destino: candidate.categoria_local_atual,
        anv_destino: candidate.anv_atual,
        status_resultante: candidate.status_atual,
        condicao_resultante: candidate.condicao_atual,
        confianca: 'ALTA',
        documento_tipo: 'CADASTRO_MESTRE',
        documento: fileName,
        origem_evento: 'CADASTRO_MESTRE',
        origem_registro_id: `MASTER:${fileHash}:${row.arquivo_origem || fileName}:${row.aba_origem || ''}:${row.linha_origem}`,
        automatico: true,
        motivo: 'Localização inicial informada no cadastro mestre de equipamentos.',
        observacao: row.observacao,
      }, user);
      locationEvents += 1;
    } else if (locationSignature(equipment) === locationSignature(candidate)) {
      unchanged += 1;
    } else {
      const conflict = await upsertPendingLocationConflict(equipment, candidate, {
        source_type: 'CADASTRO_MESTRE',
        documento: fileName,
        arquivo: row.arquivo_origem || fileName,
        file_hash: fileHash,
        linha: row.linha_origem,
        row_key: `${row.arquivo_origem || fileName}:${row.aba_origem || ''}:${row.linha_origem}:${row.pn}:${row.sn}`,
        data_evento: snapshotDate,
        observacao: row.observacao,
      }, user);
      conflicts.push(conflict);
    }
  }

  return {
    processados: rows.length,
    criados: inserted.length,
    existentes: Math.max(0, rows.length - inserted.length),
    metadados_completados: metadataUpdated,
    localizacoes_registradas: locationEvents,
    sem_alteracao: unchanged,
    conflitos_localizacao: conflicts.length,
    conflitos: conflicts.slice(0, 100),
    warnings: warnings.slice(0, 100),
    file_name: fileName,
    file_hash: fileHash,
    snapshot_date: snapshotDate,
  };
}


function normalizeInventoryMode(value) {
  const mode = String(value || 'merge').trim().toUpperCase();
  if (!['MERGE', 'REPLACE'].includes(mode)) throw new Error('Modo do inventário deve ser MERGE ou REPLACE.');
  return mode;
}

function sanitizeInventoryRows(rows = []) {
  if (!Array.isArray(rows) || rows.length === 0) throw new Error('Nenhuma linha válida foi enviada para o inventário de equipamentos.');
  if (rows.length > 12000) throw new Error('O inventário de equipamentos excede o limite de 12.000 linhas por importação.');

  const seen = new Set();
  return rows.map((row, index) => {
    const pn = normalizeCode(row?.pn);
    const sn = normalizeCode(row?.sn)?.replace(/\s+/g, '') || null;
    const localizacao = cleanText(row?.localizacao);
    assertIdentity(pn, sn);
    if (!localizacao) throw new Error(`Linha ${row?.linha_origem || index + 1}: localização é obrigatória.`);
    const key = `${pn}::${sn}`;
    if (seen.has(key)) throw new Error(`PN ${pn} / SN ${sn} aparece mais de uma vez na importação.`);
    seen.add(key);

    return {
      linha_origem: Number(row?.linha_origem || index + 1),
      pn,
      sn,
      nomenclatura: cleanText(row?.nomenclatura),
      localizacao,
      categoria_destino: normalizeCode(row?.categoria_destino) || 'PPU',
      garantia_vencimento: normalizeDate(row?.garantia_vencimento),
      observacao: cleanText(row?.observacao),
    };
  });
}

async function applyEquipmentInventory(input = {}, user = {}) {
  const mode = normalizeInventoryMode(input.mode);
  const snapshotDate = normalizeDate(input.snapshot_date || new Date().toISOString());
  const rows = sanitizeInventoryRows(input.rows || []);
  const fileName = cleanText(input.file_name) || 'inventario_equipamentos';
  const fileHash = cleanText(input.file_hash);

  // H4C2: esta RPC e SECURITY DEFINER e muta o Livro de Equipamentos.
  // Ela deve ser invocada somente pelo backend com chave administrativa;
  // nunca pelo cliente anon/publico do Supabase.
  const { data, error } = await getSupabaseAdmin().rpc('sisha_apply_equipment_inventory_import', {
    p_mode: mode,
    p_snapshot_date: snapshotDate,
    p_file_name: fileName,
    p_file_hash: fileHash,
    p_user_email: user.email || null,
    p_rows: rows,
  });
  if (error) throw error;
  return data || {};
}

async function listEquipmentReconciliation({ q = '', limit = 500 } = {}) {
  const safeLimit = Math.max(1, Math.min(Number(limit) || 500, 2000));
  let query = supabase
    .from('v_sisha_equipamentos_ppu_reconciliacao')
    .select('*')
    .order('pn', { ascending: true })
    .order('localizacao_ppu', { ascending: true })
    .limit(safeLimit);

  const term = cleanText(q);
  if (term) query = query.ilike('search_text', `%${term}%`);
  const { data, error } = await query;
  if (error) throw error;
  return data || [];
}

async function listEquipmentInventoryImports(limit = 30) {
  const safeLimit = Math.max(1, Math.min(Number(limit) || 30, 100));
  const { data, error } = await supabase
    .from('equipamento_inventario_importacoes')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(safeLimit);
  if (error) throw error;
  return data || [];
}

module.exports = {
  listEquipments,
  getEquipment,
  createEquipment,
  updateEquipment,
  removeEquipment,
  addEvent,
  addProjectedEvent,
  recomputeEquipmentProjection,
  eventDefinesCurrentLocation,
  invalidateEvent,
  fetchEventsForEquipmentIds,
  upsertPendingLocationConflict,
  registerLocationEvidence,
  listLocationConflicts,
  resolveLocationConflict,
  applyEquipmentMaster,
  applyEquipmentInventory,
  listEquipmentReconciliation,
  listEquipmentInventoryImports,
};
