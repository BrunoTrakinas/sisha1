const { classifyMaintenanceIndicatorSemantic } = require('./aircraftOperationalStateService');

function clean(value) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return text || null;
}

function upper(value) {
  return String(value ?? '').trim().toUpperCase();
}

function bindingKey(row = {}) {
  return [upper(row.aircraft_code), upper(row.indicator_key), upper(row.source_cell)].join('|');
}

function formatTrigger(indicator = {}) {
  if (indicator.due_date) return { type: 'DATE', due_date: String(indicator.due_date).slice(0, 10), value: null, unit: 'DATE' };
  const value = indicator.value_numeric == null ? null : Number(indicator.value_numeric);
  const valueType = upper(indicator.value_type);
  if (Number.isFinite(value) && valueType.includes('CYCLES_REMAINING')) return { type: 'CYCLES_REMAINING', due_date: null, value, unit: 'CYCLES' };
  if (Number.isFinite(value) && valueType.includes('HOURS_REMAINING')) return { type: 'HOURS_REMAINING', due_date: null, value, unit: 'HOURS' };
  return { type: valueType || 'UNKNOWN', due_date: null, value: Number.isFinite(value) ? value : null, unit: indicator.unit || null };
}

function buildMaintenanceProgram(indicators = [], bindings = [], runningLogs = [], now = new Date()) {
  const bindingMap = new Map((bindings || []).map((row) => [bindingKey(row), row]));
  const runningLogMap = new Map((runningLogs || []).map((row) => [upper(row.aircraft_code), row]));
  const rows = (indicators || []).map((indicator) => {
    const semantic = classifyMaintenanceIndicatorSemantic(indicator, now);
    const binding = bindingMap.get(bindingKey(indicator)) || null;
    const trigger = formatTrigger(indicator);
    const schedulingTrigger = ['DATE', 'HOURS_REMAINING', 'CYCLES_REMAINING'].includes(trigger.type);
    let blocker = null;
    if (!schedulingTrigger) blocker = 'NOT_SCHEDULING_TRIGGER';
    else if (!binding) blocker = 'BINDING_REQUIRED';
    else if (binding.planning_enabled === false) blocker = 'DISABLED_BY_ADMIN';
    else if (!semantic.planning_usable) blocker = semantic.reason || 'SOURCE_NOT_PLANNING_USABLE';
    else if (!binding.pn) blocker = 'PN_REQUIRED';

    const scheduled = !blocker;
    return {
      aircraft_code: indicator.aircraft_code,
      indicator_id: indicator.id || null,
      indicator_key: indicator.indicator_key,
      label: indicator.label,
      section: indicator.section,
      source_cell: indicator.source_cell,
      source_snapshot_id: indicator.snapshot_id || null,
      source_document: indicator.source_document || null,
      source_observed_at: indicator.source_observed_at || null,
      value_type: indicator.value_type,
      value_numeric: indicator.value_numeric,
      due_date: indicator.due_date || null,
      unit: indicator.unit || null,
      quality_status: indicator.quality_status,
      semantic_status: semantic.semantic_status,
      planning_usable: semantic.planning_usable,
      semantic_reason: semantic.reason,
      binding,
      current_running_log: runningLogMap.get(upper(indicator.aircraft_code)) || null,
      planning_status: scheduled ? (semantic.semantic_status === 'OVERDUE' ? 'OVERDUE' : 'PLANNED') : 'BLOCKED',
      blocker,
      trigger,
    };
  });

  const scheduledNeeds = rows.filter((row) => row.planning_status !== 'BLOCKED').map((row) => ({
    aircraft_code: row.aircraft_code,
    pn: row.binding.pn,
    sn: row.binding.sn || null,
    equipment_id: row.binding.equipment_id || null,
    nomenclatura: row.binding.nomenclatura || null,
    quantidade: Number(row.binding.quantidade || 1),
    maintenance_action: row.binding.maintenance_action,
    indicator_key: row.indicator_key,
    indicator_label: row.label,
    source_cell: row.source_cell,
    source_document: row.source_document,
    source_observed_at: row.source_observed_at,
    planning_status: row.planning_status,
    trigger: row.trigger,
    binding_confirmation_id: row.binding.confirmation_id || row.binding.id || null,
  }));

  return {
    rows,
    scheduled_needs: scheduledNeeds,
    summary: {
      indicators: rows.length,
      bound: rows.filter((row) => row.binding).length,
      blocked: rows.filter((row) => row.planning_status === 'BLOCKED').length,
      planned: rows.filter((row) => row.planning_status === 'PLANNED').length,
      overdue: rows.filter((row) => row.planning_status === 'OVERDUE').length,
    },
  };
}

async function loadMaintenanceProgram() {
  const supabase = require('../config/supabaseClient');
  const [indicatorResult, bindingResult, runningResult] = await Promise.all([
    supabase.from('v_sisha_aircraft_current_maintenance_indicators').select('*').order('aircraft_code', { ascending: true }).order('section', { ascending: true }),
    supabase.from('v_sisha_current_maintenance_bindings').select('*').order('aircraft_code', { ascending: true }),
    supabase.from('v_sisha_aircraft_current_running_log').select('*').order('aircraft_code', { ascending: true }),
  ]);
  if (indicatorResult.error) throw indicatorResult.error;
  if (bindingResult.error) throw bindingResult.error;
  if (runningResult.error) throw runningResult.error;
  return buildMaintenanceProgram(indicatorResult.data || [], bindingResult.data || [], runningResult.data || []);
}

async function confirmMaintenanceBinding(input = {}, { user = {}, requestId = null } = {}) {
  const supabase = require('../config/supabaseClient');
  const aircraftCode = upper(input.aircraft_code);
  const indicatorKey = clean(input.indicator_key);
  const sourceCell = upper(input.source_cell);
  const reason = clean(input.confirmation_reason);
  if (!/^\d{4}$/.test(aircraftCode)) throw new Error('A1.2: aeronave inválida.');
  if (!indicatorKey || !sourceCell) throw new Error('A1.2: indicador e célula de origem são obrigatórios.');
  if (!clean(input.pn)) throw new Error('A1.2: PN é obrigatório para programar necessidade.');
  const quantity = Number(input.quantidade ?? 1);
  if (!Number.isFinite(quantity) || quantity <= 0) throw new Error('A1.2: quantidade deve ser maior que zero.');
  if (!reason || reason.length < 5) throw new Error('A1.2: motivo da vinculação é obrigatório.');

  const { data, error } = await supabase.rpc('sisha_confirm_maintenance_binding_atomic', {
    p_aircraft_code: aircraftCode,
    p_indicator_key: indicatorKey,
    p_source_cell: sourceCell,
    p_pn: upper(input.pn).replace(/\s+/g, ''),
    p_sn: clean(input.sn) ? upper(input.sn).replace(/\s+/g, '') : null,
    p_quantity: quantity,
    p_maintenance_action: upper(input.maintenance_action || 'OVERHAUL'),
    p_planning_enabled: input.planning_enabled !== false,
    p_confirmation_reason: reason,
    p_actor_email: user.email || null,
    p_actor_role: user.role || null,
    p_request_id: requestId || null,
  });
  if (error) throw error;
  return data || {};
}

module.exports = {
  bindingKey,
  formatTrigger,
  buildMaintenanceProgram,
  loadMaintenanceProgram,
  confirmMaintenanceBinding,
};
