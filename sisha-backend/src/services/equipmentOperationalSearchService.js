function getDb() { return require('../config/supabaseClient'); }
const { loadEffectivePpuRowsByPns } = require('./ppuEffectiveAvailabilityService');
const { sourceLabelsFromEvent } = require('./equipmentDossierService');

const MAX_RESULT = 5000;
const REPAIR_NEED_CONDITIONS = new Set(['AVARIADO', 'POSSIVEL_PANE', 'AGUARDANDO_REPARO']);
const IN_REPAIR_CATEGORIES = new Set(['WO_EXTERIOR', 'REPARO_EXTERNO', 'GARANTIA']);
const UNKNOWN_VALUES = new Set(['', 'DESCONHECIDO', 'DESCONHECIDA', 'N/A', 'NA']);

function clean(value) {
  return String(value ?? '').trim();
}

function upper(value) {
  return clean(value).toUpperCase();
}

function normalizeSn(value) {
  return upper(value).replace(/\s+/g, '');
}

function normalizeBoolFilter(value) {
  const text = upper(value);
  if (['1', 'TRUE', 'SIM', 'YES'].includes(text)) return true;
  if (['0', 'FALSE', 'NAO', 'NÃO', 'NO'].includes(text)) return false;
  return null;
}

function asDateMs(value) {
  const time = new Date(value || 0).getTime();
  return Number.isFinite(time) ? time : 0;
}

function daysSince(value, now = new Date()) {
  const then = asDateMs(value);
  if (!then) return null;
  const delta = Math.max(0, now.getTime() - then);
  return Math.floor(delta / 86400000);
}

function eventMatchesCurrentLocation(equipment = {}, event = {}) {
  if (event.invalidado) return false;
  const currentCategory = upper(equipment.categoria_local_atual);
  const currentLocal = upper(equipment.local_atual);
  const currentAircraft = upper(equipment.anv_atual);
  const eventCategory = upper(event.categoria_destino);
  const eventLocal = upper(event.local_destino);
  const eventAircraft = upper(event.anv_destino || event.anv);

  let compared = false;
  if (currentCategory && !UNKNOWN_VALUES.has(currentCategory)) {
    compared = true;
    if (eventCategory !== currentCategory) return false;
  }
  if (currentLocal) {
    compared = true;
    if (!eventLocal || eventLocal !== currentLocal) return false;
  }
  if (currentAircraft) {
    compared = true;
    if (!eventAircraft || eventAircraft !== currentAircraft) return false;
  }
  return compared;
}

function isMovementEvent(event = {}) {
  const type = upper(event.tipo_evento);
  const origin = upper(event.origem_evento);
  return /ENVIO|REMOCAO|REMOÇÃO|TRANSFER|RECEBIMENTO|RETORNO|INSTALACAO|INSTALAÇÃO|SAIDA|SAÍDA|ENTRADA|MOVIMENTO/.test(type)
    || ['WO', 'OS_PIM', 'STC', 'RECIBO', 'MASTER_OS'].includes(origin);
}

function eventHasLocationSignal(event = {}) {
  return Boolean(clean(event.categoria_destino) || clean(event.local_destino) || clean(event.anv_destino || event.anv));
}

function reasonEvidenceForCurrentLocation(equipment = {}, events = []) {
  const sorted = (events || [])
    .filter((event) => !event.invalidado)
    .sort((a, b) => asDateMs(b.data_evento) - asDateMs(a.data_evento) || Number(b.id || 0) - Number(a.id || 0));

  // Considera somente a ocupação corrente do local. Isso evita atribuir ao item
  // um motivo antigo de RECEX se ele saiu, foi para outro lugar e voltou depois.
  const currentWindow = [];
  let currentLocationSeen = false;
  for (const event of sorted) {
    if (eventMatchesCurrentLocation(equipment, event)) {
      currentLocationSeen = true;
      currentWindow.push(event);
      continue;
    }
    if (currentLocationSeen && eventHasLocationSignal(event)) break;
  }

  return currentWindow.find((event) => isMovementEvent(event) && clean(event.motivo))
    || currentWindow.find((event) => clean(event.motivo))
    || currentWindow[0]
    || null;
}

function sourceFlags(events = [], ppuQty = 0) {
  const valid = (events || []).filter((event) => !event.invalidado);
  const flags = {
    critico: false,
    master_os: false,
    os_pim: false,
    wo: false,
    recibo: false,
    ppu: Number(ppuQty || 0) > 0,
    stc: false,
  };
  const labels = new Set();
  valid.forEach((event) => {
    sourceLabelsFromEvent(event).forEach((label) => labels.add(label));
    const type = upper(event.tipo_evento);
    const docType = upper(event.documento_tipo);
    const origin = upper(event.origem_evento);
    if (type.includes('CONTROLE_CRITICO') || origin.includes('CONTROLE_CRIT')) flags.critico = true;
    if (docType === 'MASTER_OS' || origin === 'MASTER_OS' || type.startsWith('MASTER_OS')) flags.master_os = true;
    if (docType === 'OS' || docType === 'PIM' || docType === 'OSR' || origin === 'OS_PIM' || /INSTALACAO|REMOCAO/.test(type)) flags.os_pim = true;
    if (docType === 'WO' || origin === 'WO' || type.includes('WO')) flags.wo = true;
    if (docType === 'RECIBO' || origin === 'RECIBO' || type === 'RECEBIMENTO') flags.recibo = true;
    if (origin.includes('PPU') || type.includes('PPU') || docType.includes('PPU')) flags.ppu = true;
    if (docType === 'STC' || origin === 'STC' || type.includes('STC')) flags.stc = true;
  });
  if (flags.critico) labels.add('CONTROLE DE EQUIPAMENTOS CRÍTICOS');
  if (flags.master_os) labels.add('MASTER OS — DIVISÃO DE PLANEJAMENTO');
  if (flags.ppu) labels.add('PPU');
  return { flags, labels: Array.from(labels).sort((a, b) => a.localeCompare(b, 'pt-BR')) };
}

function latestCriticalEvidence(equipment = {}, events = []) {
  const latest = (events || [])
    .filter((event) => !event.invalidado && (upper(event.tipo_evento).includes('CONTROLE_CRITICO') || upper(event.origem_evento).includes('CONTROLE_CRIT')))
    .sort((a, b) => asDateMs(b.data_evento) - asDateMs(a.data_evento) || Number(b.id || 0) - Number(a.id || 0))[0] || null;
  return {
    event: latest,
    exists: Boolean(latest),
    currentStateCompatible: Boolean(latest && eventMatchesCurrentLocation(equipment, latest)),
  };
}

function latestWoState(events = []) {
  const latest = (events || [])
    .filter((event) => !event.invalidado && (upper(event.documento_tipo) === 'WO' || upper(event.origem_evento) === 'WO' || upper(event.tipo_evento).includes('WO')))
    .sort((a, b) => asDateMs(b.data_evento) - asDateMs(a.data_evento) || Number(b.id || 0) - Number(a.id || 0))[0];
  if (!latest) return { state: 'SEM_WO', document: null, event: null };
  const type = upper(latest.tipo_evento);
  if (type.includes('CANCEL')) return { state: 'CANCELADA', document: latest.documento || null, event: latest };
  if (type.includes('RETORNO')) return { state: 'RETORNADO', document: latest.documento || null, event: latest };
  if (type.includes('ENVIO') || upper(latest.condicao_resultante) === 'EM_REPARO') return { state: 'EM_REPARO', document: latest.documento || null, event: latest };
  return { state: 'REGISTRADA', document: latest.documento || null, event: latest };
}

function deriveRepairPriority(equipment = {}, context = {}) {
  const category = upper(equipment.categoria_local_atual);
  const condition = upper(equipment.condicao_atual);
  const conflicts = Number(context.conflicts || 0);
  const critical = context.critical === true;
  const criticalCurrentCompatible = context.criticalCurrentCompatible === true;
  const ppuKnown = context.ppuKnown !== false;
  const ppuQty = Number(context.ppuQty || 0);
  const woState = upper(context.woState);
  const knownLocation = Boolean(clean(equipment.local_atual) || clean(equipment.anv_atual) || (category && !UNKNOWN_VALUES.has(category)));
  const needsRepair = REPAIR_NEED_CONDITIONS.has(condition) || context.repairEvidence === true || woState === 'REGISTRADA';
  const alreadyInRepair = IN_REPAIR_CATEGORIES.has(category) || condition === 'EM_REPARO' || woState === 'EM_REPARO';
  const emergencyCandidate = critical && criticalCurrentCompatible && ppuKnown && ppuQty <= 0 && needsRepair && !alreadyInRepair && conflicts === 0 && knownLocation;

  const reasons = [];
  if (critical) reasons.push('Há evidência explícita no Controle de Equipamentos Críticos.');
  if (critical && !criticalCurrentCompatible) reasons.push('A última evidência de criticidade não coincide com o estado/localização atual; validar atualidade antes de priorizar emergência.');
  if (!ppuKnown) reasons.push('Disponibilidade efetiva do PPU não pôde ser confirmada; prioridade de emergência bloqueada.');
  else if (ppuQty <= 0) reasons.push('Disponibilidade efetiva do PN no PPU é zero.');
  else reasons.push(`Disponibilidade efetiva do PN no PPU: ${ppuQty}.`);
  if (REPAIR_NEED_CONDITIONS.has(condition)) reasons.push(`Condição atual: ${condition}.`);
  if (context.repairEvidence === true && !REPAIR_NEED_CONDITIONS.has(condition)) reasons.push('Há evidência documental/textual explícita de pane, avaria, garantia ou reparo.');
  if (woState === 'REGISTRADA') reasons.push('Há WO registrada sem evidência de envio/retorno posterior.');
  if (category === 'RECEX') reasons.push('Localização atual: RECEX (localização isoladamente não prova necessidade de reparo).');
  if (alreadyInRepair) reasons.push('Já existe evidência de reparo em curso/permanência em reparo.');
  if (conflicts > 0) reasons.push('Há conflito de localização/evidência pendente.');
  if (!knownLocation) reasons.push('Localização atual não está suficientemente determinada.');

  let level = 'NORMAL';
  if (conflicts > 0 || !knownLocation || (needsRepair && !ppuKnown)) level = 'INDETERMINADA';
  else if (emergencyCandidate) level = 'CRITICA';
  else if ((critical && needsRepair) || (ppuQty <= 0 && needsRepair)) level = 'ALTA';
  else if (needsRepair) level = 'MEDIA';

  let repairState = 'SEM_INDICACAO';
  if (conflicts > 0) repairState = 'INDETERMINADA';
  else if (alreadyInRepair) repairState = 'EM_REPARO';
  else if (needsRepair) repairState = 'AGUARDANDO_ENVIO_AVALIACAO';
  else if (woState === 'RETORNADO') repairState = 'RETORNADO';

  return {
    nivel: level,
    candidato_emergencia_reparo: emergencyCandidate,
    necessita_reparo_avaliacao: needsRepair,
    ja_em_reparo: alreadyInRepair,
    situacao_reparo: repairState,
    razoes: reasons,
  };
}

function buildOperationalRow(equipment = {}, events = [], ppuRows = [], now = new Date(), operationalContext = {}) {
  const valid = (events || []).filter((event) => !event.invalidado);
  const pendingConflicts = valid.filter((event) => upper(event.tipo_evento) === 'CONFLITO_LOCALIZACAO' && upper(event?.payload?.conflito_status) === 'PENDENTE');
  const reasonEvent = reasonEvidenceForCurrentLocation(equipment, valid);
  const ppuQty = Number((ppuRows || []).reduce((sum, row) => sum + Math.max(0, Number(row.quantidade || 0) || 0), 0).toFixed(3));
  const ppuSnPresent = (ppuRows || []).some((row) => normalizeSn(row.sn) && normalizeSn(row.sn) === normalizeSn(equipment.sn));
  const sources = sourceFlags(valid, ppuQty);
  const critical = latestCriticalEvidence(equipment, valid);
  const wo = latestWoState(valid);
  const repairText = upper([reasonEvent?.motivo, reasonEvent?.tipo_evento, reasonEvent?.documento_tipo, reasonEvent?.observacao].filter(Boolean).join(' | '));
  const repairEvidence = /PANE|REPAR|AVARI|GARANTIA/.test(repairText);
  const priority = deriveRepairPriority(equipment, {
    conflicts: pendingConflicts.length,
    critical: critical.exists,
    criticalCurrentCompatible: critical.currentStateCompatible,
    repairEvidence,
    ppuQty,
    ppuKnown: operationalContext.ppuKnown !== false,
    woState: wo.state,
  });
  const motivo = clean(reasonEvent?.motivo);
  return {
    ...equipment,
    motivo_atual: motivo || 'Motivo não identificado nas evidências disponíveis.',
    motivo_status: motivo ? 'IDENTIFICADO' : 'NAO_IDENTIFICADO',
    motivo_evento_tipo: reasonEvent?.tipo_evento || null,
    motivo_documento_tipo: reasonEvent?.documento_tipo || null,
    motivo_documento: reasonEvent?.documento || null,
    local_atual_desde: reasonEvent?.data_evento || equipment.ultima_evidencia_em || null,
    dias_local_atual: daysSince(reasonEvent?.data_evento || equipment.ultima_evidencia_em, now),
    fontes_dossie: sources.labels,
    fontes_flags: sources.flags,
    controle_critico: critical.exists,
    controle_critico_compativel_atual: critical.currentStateCompatible,
    conflitos_pendentes: pendingConflicts.length,
    ppu_quantidade_efetiva_pn: operationalContext.ppuKnown === false ? null : ppuQty,
    ppu_disponibilidade_conhecida: operationalContext.ppuKnown !== false,
    ppu_sn_presente: ppuSnPresent,
    wo_estado: wo.state,
    wo_documento: wo.document,
    prioridade_operacional: priority,
    evidencias_total: valid.length,
  };
}

function applyOperationalFilters(rows = [], filters = {}) {
  const q = upper(filters.q);
  const locationCategory = upper(filters.location_category || filters.locationCategory);
  const location = upper(filters.location);
  const condition = upper(filters.condition);
  const status = upper(filters.status);
  const reason = upper(filters.reason);
  const source = upper(filters.source);
  const repairState = upper(filters.repair_state || filters.repairState);
  const priority = upper(filters.priority);
  const critical = normalizeBoolFilter(filters.critical);
  const emergency = normalizeBoolFilter(filters.emergency);
  const conflict = normalizeBoolFilter(filters.conflict);
  const ppu = upper(filters.ppu);
  const minDays = clean(filters.min_days || filters.minDays) === '' ? null : Number(filters.min_days || filters.minDays);

  return (rows || []).filter((row) => {
    if (q) {
      const haystack = [row.pn, row.sn, row.nomenclatura, row.local_atual, row.anv_atual, row.status_atual, row.condicao_atual, row.motivo_atual, row.motivo_documento, ...(row.fontes_dossie || [])].map(upper).join(' | ');
      if (!haystack.includes(q)) return false;
    }
    if (locationCategory && upper(row.categoria_local_atual) !== locationCategory) return false;
    if (location && !upper(row.local_atual).startsWith(location)) return false;
    if (condition && upper(row.condicao_atual) !== condition) return false;
    if (status && !upper(row.status_atual).startsWith(status)) return false;
    if (reason && ![row.motivo_atual, row.motivo_evento_tipo, row.motivo_documento].map(upper).join(' | ').includes(reason)) return false;
    if (source && row.fontes_flags?.[source.toLowerCase()] !== true) return false;
    if (repairState && upper(row.prioridade_operacional?.situacao_reparo) !== repairState) return false;
    if (priority && upper(row.prioridade_operacional?.nivel) !== priority) return false;
    if (critical !== null && Boolean(row.controle_critico) !== critical) return false;
    if (emergency !== null && Boolean(row.prioridade_operacional?.candidato_emergencia_reparo) !== emergency) return false;
    if (conflict !== null && (Number(row.conflitos_pendentes || 0) > 0) !== conflict) return false;
    if (ppu === 'ZERO' && (row.ppu_disponibilidade_conhecida !== true || Number(row.ppu_quantidade_efetiva_pn || 0) > 0)) return false;
    if (ppu === 'POSITIVO' && (row.ppu_disponibilidade_conhecida !== true || Number(row.ppu_quantidade_efetiva_pn || 0) <= 0)) return false;
    if (ppu === 'INDETERMINADO' && row.ppu_disponibilidade_conhecida === true) return false;
    if (Number.isFinite(minDays) && Number(row.dias_local_atual ?? -1) < minDays) return false;
    return true;
  });
}

function summarizeOperationalRows(rows = []) {
  return {
    total: rows.length,
    recex: rows.filter((row) => upper(row.categoria_local_atual) === 'RECEX').length,
    criticos: rows.filter((row) => row.controle_critico).length,
    candidatos_emergencia_reparo: rows.filter((row) => row.prioridade_operacional?.candidato_emergencia_reparo).length,
    aguardando_reparo_avaliacao: rows.filter((row) => upper(row.prioridade_operacional?.situacao_reparo) === 'AGUARDANDO_ENVIO_AVALIACAO').length,
    conflitos: rows.filter((row) => Number(row.conflitos_pendentes || 0) > 0).length,
    motivo_nao_identificado: rows.filter((row) => row.motivo_status === 'NAO_IDENTIFICADO').length,
  };
}

async function loadEquipmentBaseRows(limit = MAX_RESULT) {
  const supabase = getDb();
  const safeLimit = Math.max(1, Math.min(Number(limit) || MAX_RESULT, MAX_RESULT));
  const pageSize = 1000;
  const rows = [];
  for (let from = 0; from < safeLimit; from += pageSize) {
    const to = Math.min(from + pageSize - 1, safeLimit - 1);
    const { data, error } = await supabase
      .from('v_sisha_equipamentos_search')
      .select('*')
      .order('pn', { ascending: true })
      .order('sn', { ascending: true })
      .range(from, to);
    if (error) throw error;
    const page = (data || []).filter((row) => row?.ativo !== false);
    rows.push(...page);
    if (!data || data.length < pageSize) break;
  }
  return rows.slice(0, safeLimit);
}

async function loadEventsByEquipmentIds(ids = []) {
  const supabase = getDb();
  const unique = [...new Set((ids || []).map(Number).filter(Number.isFinite))];
  const rows = [];
  for (let index = 0; index < unique.length; index += 100) {
    const { data, error } = await supabase
      .from('equipamento_eventos')
      .select('*')
      .in('equipamento_id', unique.slice(index, index + 100))
      .order('data_evento', { ascending: false })
      .order('id', { ascending: false })
      .limit(10000);
    if (error) throw error;
    rows.push(...(data || []));
  }
  return rows;
}

async function enrichOperationalEquipment(equipment = {}) {
  if (!equipment?.id) return equipment;
  const events = Array.isArray(equipment.eventos) ? equipment.eventos : await loadEventsByEquipmentIds([equipment.id]);
  let ppuRows = [];
  let ppuKnown = true;
  try {
    ppuRows = await loadEffectivePpuRowsByPns([equipment.pn]);
  } catch (_error) {
    ppuKnown = false;
  }
  return buildOperationalRow(equipment, events, ppuRows, new Date(), { ppuKnown });
}

async function searchOperationalEquipments(filters = {}) {
  const base = await loadEquipmentBaseRows(filters.limit || MAX_RESULT);
  const events = await loadEventsByEquipmentIds(base.map((row) => row.id));
  const pns = [...new Set(base.map((row) => upper(row.pn)).filter(Boolean))];
  let ppuRows = [];
  let ppuKnown = true;
  let ppuWarning = null;
  try {
    ppuRows = await loadEffectivePpuRowsByPns(pns);
  } catch (error) {
    ppuKnown = false;
    ppuWarning = clean(error?.message) || 'Falha ao consultar disponibilidade efetiva do PPU.';
  }

  const eventsById = new Map();
  events.forEach((event) => {
    const key = String(event.equipamento_id);
    if (!eventsById.has(key)) eventsById.set(key, []);
    eventsById.get(key).push(event);
  });
  const ppuByPn = new Map();
  ppuRows.forEach((row) => {
    const key = upper(row.pn);
    if (!ppuByPn.has(key)) ppuByPn.set(key, []);
    ppuByPn.get(key).push(row);
  });

  const enriched = base.map((equipment) => buildOperationalRow(
    equipment,
    eventsById.get(String(equipment.id)) || [],
    ppuByPn.get(upper(equipment.pn)) || [],
    new Date(),
    { ppuKnown },
  ));
  const filtered = applyOperationalFilters(enriched, filters);
  const finalLimit = Math.max(1, Math.min(Number(filters.result_limit || filters.resultLimit) || 2000, MAX_RESULT));
  const data = filtered.slice(0, finalLimit);
  return {
    data,
    meta: {
      ...summarizeOperationalRows(filtered),
      universo_analisado: base.length,
      retornados: data.length,
      truncado: filtered.length > data.length,
      ppu_disponibilidade_conhecida: ppuKnown,
      aviso_ppu: ppuWarning,
      regra_prioridade: 'Fail-closed: emergência somente quando a criticidade explícita é compatível com o estado atual + PPU efetivo zero + evidência de necessidade de reparo + ainda não em reparo + sem conflito. RECEX isoladamente não prova reparo.',
    },
  };
}

module.exports = {
  eventMatchesCurrentLocation,
  reasonEvidenceForCurrentLocation,
  latestCriticalEvidence,
  deriveRepairPriority,
  buildOperationalRow,
  applyOperationalFilters,
  summarizeOperationalRows,
  enrichOperationalEquipment,
  searchOperationalEquipments,
};
