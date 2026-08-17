const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildEffectiveOperationalState,
  classifyMaintenanceIndicatorSemantic,
  inferAvailabilityFromOperationalState,
} = require('../../src/services/aircraftOperationalStateService');
const { buildAircraftAvailabilityMap, buildMtAvailabilityDecision } = require('../../src/services/mtNeedPolicyService');

test('A1.1A: confirmação PRESERVED prevalece sobre D/I bruto e bloqueia projeção/MT conforme decisão humana', () => {
  const state = buildEffectiveOperationalState({
    aircraft_code: '4001',
    raw_status: 'UNKNOWN',
    admin_confirmation_id: 10,
    admin_operational_state: 'PRESERVED',
    mt_additive_eligible: false,
    flight_projection_enabled: false,
  });
  assert.equal(state.status, 'I');
  assert.equal(state.operational_state, 'PRESERVED');
  assert.equal(state.mt_additive_eligible, false);
  assert.equal(state.flight_projection_enabled, false);
  assert.equal(state.has_admin_confirmation, true);
});

test('A1.1A: modernização/PROGEM não habilitam MT automaticamente', () => {
  assert.equal(inferAvailabilityFromOperationalState('IN_MODERNIZATION', 'UNKNOWN'), 'I');
  const map = buildAircraftAvailabilityMap([
    { aircraft_code: '4012', raw_status: 'UNKNOWN', admin_confirmation_id: 1, admin_operational_state: 'IN_MODERNIZATION', mt_additive_eligible: false },
    { aircraft_code: '4010', raw_status: 'I', admin_confirmation_id: 2, admin_operational_state: 'IN_INSPECTION', mt_additive_eligible: false },
  ]);
  const selected = [
    { isAircraft: true, pn: 'MFV1', origem: { origem_codigo: '4010' } },
    { isMt: true, pn: 'MFV1' },
  ];
  const decision = buildMtAvailabilityDecision(selected[1], selected, map);
  assert.equal(decision.blocked, true);
  assert.equal(decision.additive, false);
});

test('A1.1A: WAITING_MATERIAL confirmado pode habilitar MT adicional', () => {
  const map = buildAircraftAvailabilityMap([
    { aircraft_code: '4005', raw_status: 'I', admin_confirmation_id: 3, admin_operational_state: 'WAITING_MATERIAL', mt_additive_eligible: true },
  ]);
  const selected = [
    { isAircraft: true, pn: 'MFV1', origem: { origem_codigo: '4005' } },
    { isMt: true, pn: 'MFV1' },
  ];
  const decision = buildMtAvailabilityDecision(selected[1], selected, map);
  assert.equal(decision.blocked, false);
  assert.equal(decision.additive, true);
  assert.deepEqual(decision.unavailableAircraft, ['4005']);
});

test('A1.1A: sem confirmação administrativa, I bruto mantém compatibilidade A1.1', () => {
  const map = buildAircraftAvailabilityMap([{ aircraft_code: '4005', status: 'I', reason: 'AGUARDANDO COMPONENTES' }]);
  assert.equal(map.get('4005').mt_additive_eligible, true);
});

test('A1.1A: indicador negativo é vencido, não zero nem erro', () => {
  const result = classifyMaintenanceIndicatorSemantic({ quality_status: 'VALID', value_type: 'HOURS_REMAINING', value_numeric: -4.5, label: 'VIBRAÇÃO COM HOIST' });
  assert.equal(result.semantic_status, 'OVERDUE');
  assert.equal(result.planning_usable, true);
  assert.equal(result.reason, 'NEGATIVE_REMAINING');
});

test('A1.1A: TBO em data passada é vencido e permanece utilizável como alerta programado', () => {
  const result = classifyMaintenanceIndicatorSemantic({ quality_status: 'VALID', value_type: 'TBO_DUE_DATE', due_date: '2026-01-30', label: 'TBO' }, new Date('2026-08-14T12:00:00Z'));
  assert.equal(result.semantic_status, 'OVERDUE');
  assert.equal(result.planning_usable, true);
});

test('A1.1A: horas restantes acima do intervalo nominal ficam REVIEW e bloqueadas para cálculo', () => {
  const result = classifyMaintenanceIndicatorSemantic({ quality_status: 'VALID', value_type: 'HOURS_REMAINING', value_numeric: 1156.5, label: '200 H #1' });
  assert.equal(result.semantic_status, 'REVIEW');
  assert.equal(result.planning_usable, false);
  assert.equal(result.reason, 'REMAINING_EXCEEDS_NOMINAL_INTERVAL');
});

test('A1.1A: erro de planilha permanece bloqueado', () => {
  const result = classifyMaintenanceIndicatorSemantic({ quality_status: 'ERROR', value_type: 'ERROR', label: 'Tie Bar' });
  assert.equal(result.semantic_status, 'ERROR');
  assert.equal(result.planning_usable, false);
});
