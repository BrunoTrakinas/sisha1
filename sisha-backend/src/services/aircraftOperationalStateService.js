function normalizeUpper(value) {
  return String(value ?? '').trim().toUpperCase();
}

function normalizeText(value) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return text || null;
}

const OPERATIONAL_STATES = Object.freeze([
  'AVAILABLE',
  'UNAVAILABLE',
  'PRESERVED',
  'IN_INSPECTION',
  'IN_MODERNIZATION',
  'WAITING_MATERIAL',
  'OUT_OF_OPERATIONAL_FLEET',
  'TO_CONFIRM',
]);

const OPERATIONAL_STATE_SET = new Set(OPERATIONAL_STATES);

function normalizeOperationalState(value) {
  const normalized = normalizeUpper(value);
  return OPERATIONAL_STATE_SET.has(normalized) ? normalized : null;
}

function inferAvailabilityFromOperationalState(state, rawStatus = 'UNKNOWN') {
  const normalized = normalizeOperationalState(state);
  if (normalized === 'AVAILABLE') return 'D';
  if (['UNAVAILABLE', 'PRESERVED', 'IN_INSPECTION', 'IN_MODERNIZATION', 'WAITING_MATERIAL', 'OUT_OF_OPERATIONAL_FLEET'].includes(normalized)) return 'I';
  const raw = normalizeUpper(rawStatus);
  return raw === 'D' || raw === 'I' ? raw : 'UNKNOWN';
}

function buildEffectiveOperationalState(row = {}) {
  const rawStatus = ['D', 'I'].includes(normalizeUpper(row.raw_status || row.status))
    ? normalizeUpper(row.raw_status || row.status)
    : 'UNKNOWN';
  const adminState = normalizeOperationalState(row.admin_operational_state || row.operational_state);
  const hasAdminConfirmation = Boolean(row.admin_confirmation_id || row.confirmation_id || adminState);
  const effectiveStatus = inferAvailabilityFromOperationalState(adminState, rawStatus);

  const rawMtFallback = !hasAdminConfirmation && rawStatus === 'I';
  const mtAdditiveEligible = hasAdminConfirmation
    ? row.mt_additive_eligible === true
    : rawMtFallback;

  return {
    aircraft_code: normalizeUpper(row.aircraft_code),
    status: effectiveStatus,
    raw_status: rawStatus,
    raw_reason: normalizeText(row.raw_reason || row.reason),
    operational_state: adminState || 'TO_CONFIRM',
    operational_location: normalizeText(row.operational_location),
    admin_note: normalizeText(row.admin_note),
    confirmation_reason: normalizeText(row.confirmation_reason),
    mt_additive_eligible: mtAdditiveEligible,
    flight_projection_enabled: hasAdminConfirmation ? row.flight_projection_enabled !== false : rawStatus === 'D',
    has_admin_confirmation: hasAdminConfirmation,
    admin_confirmation_id: row.admin_confirmation_id || row.confirmation_id || null,
    confirmed_by: normalizeText(row.confirmed_by),
    confirmed_at: row.confirmed_at || null,
    aircraft_hours: row.aircraft_hours == null ? null : Number(row.aircraft_hours),
    source_observed_at: row.source_observed_at || null,
    source_document: normalizeText(row.source_document),
    snapshot_id: row.snapshot_id || null,
  };
}

function parseHoursIntervalFromLabel(label = '') {
  const normalized = normalizeUpper(label).replace(',', '.');
  const match = normalized.match(/(?:^|\D)(\d+(?:\.\d+)?)\s*H(?:\b|\s|#)/);
  if (!match) return null;
  const value = Number(match[1]);
  return Number.isFinite(value) && value > 0 ? value : null;
}

function classifyMaintenanceIndicatorSemantic(indicator = {}, now = new Date()) {
  const quality = normalizeUpper(indicator.quality_status || 'WARNING');
  const valueType = normalizeUpper(indicator.value_type);
  const numeric = indicator.value_numeric == null ? null : Number(indicator.value_numeric);
  const dueDateRaw = indicator.due_date || null;

  if (quality === 'ERROR' || valueType === 'ERROR') {
    return { semantic_status: 'ERROR', planning_usable: false, reason: 'SOURCE_ERROR' };
  }

  if (dueDateRaw) {
    const dueDate = new Date(`${String(dueDateRaw).slice(0, 10)}T00:00:00Z`);
    const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    if (!Number.isNaN(dueDate.getTime()) && dueDate < today) {
      return { semantic_status: 'OVERDUE', planning_usable: quality === 'VALID', reason: 'DUE_DATE_PASSED' };
    }
  }

  if (Number.isFinite(numeric) && /_REMAINING$/.test(valueType)) {
    if (numeric < 0) {
      return { semantic_status: 'OVERDUE', planning_usable: quality === 'VALID', reason: 'NEGATIVE_REMAINING' };
    }

    const interval = parseHoursIntervalFromLabel(indicator.label);
    if (interval && /HOURS_REMAINING/.test(valueType) && numeric > interval * 1.05) {
      return {
        semantic_status: 'REVIEW',
        planning_usable: false,
        reason: 'REMAINING_EXCEEDS_NOMINAL_INTERVAL',
        nominal_interval: interval,
      };
    }
  }

  if (quality !== 'VALID') {
    return { semantic_status: 'REVIEW', planning_usable: false, reason: 'SOURCE_WARNING' };
  }

  return { semantic_status: 'NORMAL', planning_usable: true, reason: 'VALIDATED_BY_RULES' };
}


async function loadGeneratorOperationalRows() {
  const supabase = require('../config/supabaseClient');
  const effective = await supabase
    .from('v_sisha_aircraft_effective_operational_state')
    .select('*')
    .order('aircraft_code', { ascending: true });
  if (!effective.error) return effective.data || [];

  // Compatibilidade segura durante a aplicação da migration A1.1A.
  const legacy = await supabase
    .from('v_sisha_aircraft_current_availability')
    .select('snapshot_id,aircraft_code,status,reason,aircraft_hours,source_observed_at,source_document')
    .order('aircraft_code', { ascending: true });
  if (legacy.error) throw effective.error;
  return legacy.data || [];
}

async function listEffectiveOperationalStates() {
  const supabase = require('../config/supabaseClient');
  const { data, error } = await supabase
    .from('v_sisha_aircraft_effective_operational_state')
    .select('*')
    .order('aircraft_code', { ascending: true });
  if (error) throw error;
  return (data || []).map(buildEffectiveOperationalState);
}

async function confirmOperationalState(input = {}, { user = {}, requestId = null } = {}) {
  const aircraft = normalizeUpper(input.aircraft_code);
  if (!/^\d{4}$/.test(aircraft)) throw new Error('Aeronave inválida. Informe código de 4 dígitos.');
  const operationalState = normalizeOperationalState(input.operational_state);
  if (!operationalState) throw new Error('Estado operacional administrativo inválido.');
  const confirmationReason = normalizeText(input.confirmation_reason);
  if (!confirmationReason || confirmationReason.length < 5) throw new Error('Informe o motivo da confirmação administrativa.');

  const supabase = require('../config/supabaseClient');
  const { data, error } = await supabase.rpc('sisha_confirm_aircraft_operational_state_atomic', {
    p_aircraft_code: aircraft,
    p_operational_state: operationalState,
    p_operational_location: normalizeText(input.operational_location),
    p_admin_note: normalizeText(input.admin_note),
    p_mt_additive_eligible: input.mt_additive_eligible === true,
    p_flight_projection_enabled: input.flight_projection_enabled !== false,
    p_confirmation_reason: confirmationReason,
    p_actor_email: user.email || null,
    p_actor_role: user.role || null,
    p_request_id: requestId || null,
  });
  if (error) throw error;
  return data || {};
}

async function listOperationalStateHistory(aircraftCode) {
  const aircraft = normalizeUpper(aircraftCode);
  if (!/^\d{4}$/.test(aircraft)) throw new Error('Aeronave inválida.');
  const supabase = require('../config/supabaseClient');
  const { data, error } = await supabase
    .from('aircraft_operational_state_confirmations')
    .select('id,aircraft_code,operational_state,operational_location,admin_note,mt_additive_eligible,flight_projection_enabled,confirmation_reason,raw_status,raw_reason,source_snapshot_id,source_document,source_sha256,source_observed_at,confirmed_by,confirmed_role,confirmed_at')
    .eq('aircraft_code', aircraft)
    .order('confirmed_at', { ascending: false })
    .order('id', { ascending: false });
  if (error) throw error;
  return data || [];
}

module.exports = {
  OPERATIONAL_STATES,
  normalizeOperationalState,
  inferAvailabilityFromOperationalState,
  buildEffectiveOperationalState,
  parseHoursIntervalFromLabel,
  classifyMaintenanceIndicatorSemantic,
  loadGeneratorOperationalRows,
  listEffectiveOperationalStates,
  confirmOperationalState,
  listOperationalStateHistory,
};
