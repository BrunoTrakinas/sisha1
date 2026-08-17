const crypto = require('crypto');
const supabase = require('../config/supabaseClient');

const COUNTERS = new Set(['HORAS_DE_VOO', 'MOTOR_1', 'MOTOR_2', 'CICLOS', 'CALENDARIO']);
const CYCLE_METRICS = new Set([
  'landings',
  'rotor_stop_starts',
  'engine_1_starts',
  'engine_1_power_turbine_cycles',
  'engine_1_gas_generator_cycles',
  'engine_2_starts',
  'engine_2_power_turbine_cycles',
  'engine_2_gas_generator_cycles',
]);
const REMOVAL_REASONS = new Set(['PANE', 'TESTE', 'PRONTO_USO']);
const BLOCKED_INSTALL_CONDITIONS = new Set(['AVARIADO', 'EM_REPARO', 'AGUARDANDO_REPARO', 'QUARENTENA', 'AGUARDANDO_DESFAZIMENTO', 'EM_TESTE']);

function clean(value) {
  const text = String(value ?? '').trim();
  return text || null;
}

function upper(value) {
  const text = clean(value);
  return text ? text.toUpperCase() : null;
}

function normalizeSn(value) {
  const text = upper(value);
  return text ? text.replace(/\s+/g, '') : null;
}

function normalizeAircraft(value) {
  const text = upper(value);
  return text ? text.replace(/^N[-\s]*/, '') : null;
}

function normalizeUuid(value) {
  const text = clean(value);
  if (!text) return crypto.randomUUID();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(text)) {
    throw new Error('operation_id inválido.');
  }
  return text.toLowerCase();
}

function normalizeCounter(counter, metric) {
  const usageCounter = upper(counter);
  if (!COUNTERS.has(usageCounter)) throw new Error('Contador de utilização inválido.');
  let usageMetric = clean(metric)?.toLowerCase() || null;
  if (usageCounter === 'HORAS_DE_VOO') usageMetric = 'aircraft_hours';
  if (usageCounter === 'MOTOR_1') usageMetric = 'engine_1_hours';
  if (usageCounter === 'MOTOR_2') usageMetric = 'engine_2_hours';
  if (usageCounter === 'CALENDARIO') usageMetric = 'calendar';
  if (usageCounter === 'CICLOS' && !CYCLE_METRICS.has(usageMetric)) {
    throw new Error('Para CICLOS, selecione a métrica auditável do Livro dos Motores.');
  }
  return { usageCounter, usageMetric };
}

function toIso(value) {
  const text = clean(value);
  if (!text) return new Date().toISOString();
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?$/.test(text)) {
    throw new Error('Data/hora sem fuso não é aceita. Envie ISO com Z ou offset para preservar o instante operacional.');
  }
  const date = new Date(text);
  if (Number.isNaN(date.getTime())) throw new Error('Data inválida.');
  return date.toISOString();
}

async function listCandidates({ pn = '', mode = 'INSTALL', limit = 100 } = {}) {
  const normalizedPn = upper(pn);
  if (!normalizedPn || normalizedPn.length < 2) return [];
  const safeLimit = Math.max(1, Math.min(Number(limit) || 100, 250));
  let query = supabase
    .from('equipamentos_serializados')
    .select('id,pn,sn,nomenclatura,categoria_local_atual,local_atual,anv_atual,status_atual,condicao_atual,ativo,posicao_atual,contador_utilizacao_atual,metrica_utilizacao_atual')
    .eq('ativo', true)
    .ilike('pn', `%${normalizedPn}%`)
    .order('sn', { ascending: true })
    .limit(safeLimit);

  const { data, error } = await query;
  if (error) throw error;
  const wanted = upper(mode) === 'REMOVE' ? 'REMOVE' : 'INSTALL';
  return (data || []).filter((row) => {
    const inAircraft = upper(row.categoria_local_atual) === 'AERONAVE' || Boolean(clean(row.anv_atual));
    const blockedCondition = BLOCKED_INSTALL_CONDITIONS.has(upper(row.condicao_atual));
    return wanted === 'REMOVE' ? inAircraft : (!inAircraft && !blockedCondition);
  });
}

async function listOpenInstallations({ pn = '', aircraft = '', limit = 250 } = {}) {
  let query = supabase
    .from('v_sisha_a2_open_installations')
    .select('*')
    .order('aircraft_code', { ascending: true })
    .order('position_code', { ascending: true })
    .limit(Math.max(1, Math.min(Number(limit) || 250, 1000)));
  if (clean(pn)) query = query.ilike('pn', `%${upper(pn)}%`);
  if (clean(aircraft)) query = query.eq('aircraft_code', normalizeAircraft(aircraft));
  const { data, error } = await query;
  if (error) throw error;
  return data || [];
}

async function listPendingTests(limit = 250) {
  const { data, error } = await supabase
    .from('v_sisha_a2_pending_tests')
    .select('*')
    .order('removed_at', { ascending: false })
    .limit(Math.max(1, Math.min(Number(limit) || 250, 1000)));
  if (error) throw error;
  return data || [];
}

async function installEquipment(input = {}, user = {}) {
  const equipmentId = Number(input.equipment_id);
  if (!Number.isInteger(equipmentId) || equipmentId <= 0) throw new Error('Selecione um PN+SN válido para instalação.');
  const aircraft = normalizeAircraft(input.aircraft_code || input.aeronave);
  if (!/^\d{4}$/.test(aircraft || '')) throw new Error('Informe uma aeronave válida com 4 dígitos.');
  const position = upper(input.position_code || input.posicao);
  if (!position) throw new Error('Informe a posição de instalação.');
  const { usageCounter, usageMetric } = normalizeCounter(input.usage_counter, input.usage_metric);
  const operationId = normalizeUuid(input.operation_id);

  const { data, error } = await supabase.rpc('sisha_a2_install_equipment_atomic', {
    p_equipment_id: equipmentId,
    p_aircraft_code: aircraft,
    p_position_code: position,
    p_usage_counter: usageCounter,
    p_usage_metric: usageMetric,
    p_installed_at: toIso(input.installed_at || input.data_evento),
    p_document: clean(input.document),
    p_observation: clean(input.observation || input.observacao),
    p_operation_id: operationId,
    p_actor_email: user.email || null,
    p_actor_role: user.role || null,
  });
  if (error) throw error;
  return { ...(data || {}), operation_id: operationId };
}

async function removeEquipment(input = {}, user = {}) {
  const equipmentId = Number(input.equipment_id);
  if (!Number.isInteger(equipmentId) || equipmentId <= 0) throw new Error('Selecione um PN+SN instalado para remoção.');
  const reason = upper(input.removal_reason || input.motivo_remocao);
  if (!REMOVAL_REASONS.has(reason)) throw new Error('Motivo de remoção deve ser PANE, TESTE ou PRONTO_USO.');
  const operationId = normalizeUuid(input.operation_id);
  const { data, error } = await supabase.rpc('sisha_a2_remove_equipment_atomic', {
    p_equipment_id: equipmentId,
    p_removal_reason: reason,
    p_removed_at: toIso(input.removed_at || input.data_evento),
    p_destination_category: upper(input.destination_category || input.categoria_destino) || 'DESCONHECIDO',
    p_destination_location: clean(input.destination_location || input.local_destino),
    p_document: clean(input.document),
    p_observation: clean(input.observation || input.observacao),
    p_operation_id: operationId,
    p_actor_email: user.email || null,
    p_actor_role: user.role || null,
  });
  if (error) throw error;
  return { ...(data || {}), operation_id: operationId };
}

async function resolveTestResult(input = {}, user = {}) {
  const intervalId = Number(input.interval_id);
  if (!Number.isInteger(intervalId) || intervalId <= 0) throw new Error('Selecione um teste pendente válido.');
  const result = upper(input.test_result || input.resultado);
  if (!['APROVADO', 'REPROVADO'].includes(result)) throw new Error('Resultado deve ser APROVADO ou REPROVADO.');
  const operationId = normalizeUuid(input.operation_id);
  const { data, error } = await supabase.rpc('sisha_a2_resolve_test_result_atomic', {
    p_interval_id: intervalId,
    p_test_result: result,
    p_result_at: toIso(input.result_at || input.data_evento),
    p_destination_category: upper(input.destination_category || input.categoria_destino),
    p_destination_location: clean(input.destination_location || input.local_destino),
    p_document: clean(input.document),
    p_observation: clean(input.observation || input.observacao),
    p_operation_id: operationId,
    p_actor_email: user.email || null,
    p_actor_role: user.role || null,
  });
  if (error) throw error;
  return { ...(data || {}), operation_id: operationId };
}

module.exports = {
  COUNTERS,
  CYCLE_METRICS,
  REMOVAL_REASONS,
  BLOCKED_INSTALL_CONDITIONS,
  normalizeCounter,
  listCandidates,
  listOpenInstallations,
  listPendingTests,
  installEquipment,
  removeEquipment,
  resolveTestResult,
};
