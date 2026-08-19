const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  deriveUsageSuggestion,
  normalizeCycle,
  markRepeatRemovals,
  summarizeA3Cycles,
} = require('../../src/services/reliabilityAnalysisService');

const ROOT = path.resolve(__dirname, '../..');
const read = (relative) => fs.readFileSync(path.join(ROOT, relative), 'utf8');

function interval(overrides = {}) {
  return {
    id: 1,
    equipment_id: 10,
    pn: 'PN123',
    sn: 'SN001',
    aircraft_code: '4005',
    position_code: 'BOOSTER LH',
    usage_counter: 'HORAS_DE_VOO',
    usage_metric: 'aircraft_hours',
    installed_at: '2026-01-01T00:00:00Z',
    removed_at: '2026-02-01T00:00:00Z',
    removal_reason: 'PANE',
    failure_status: 'CONFIRMED',
    test_result: null,
    ...overrides,
  };
}

function confirmation(overrides = {}) {
  return {
    interval_id: 1,
    usage_start_value: 100,
    usage_end_value: 200,
    usage_delta: 100,
    usage_unit: 'HOURS',
    technical_result: 'REPAIRED',
    repair_started_at: '2026-02-11T00:00:00Z',
    repair_completed_at: '2026-02-14T00:00:00Z',
    available_at: '2026-03-11T00:00:00Z',
    repairer: 'LEONARDO',
    manufacturer: 'OEM X',
    confirmed_by: 'admin@example.com',
    confirmed_at: '2026-03-12T00:00:00Z',
    ...overrides,
  };
}

test('A3: migration cria confirmação append-only, view atual e RPC service-role only', () => {
  const sql = read('sql/migrations/20260815_A3_001_reliability_engine.sql');
  assert.match(sql, /create table if not exists public\.equipment_reliability_cycle_confirmations/i);
  assert.match(sql, /create or replace view public\.v_sisha_a3_current_cycle_confirmations/i);
  assert.match(sql, /create or replace function public\.sisha_a3_confirm_reliability_cycle_atomic/i);
  assert.match(sql, /confirmed_by text not null/i);
  assert.match(sql, /confirmation_reason text not null/i);
  assert.match(sql, /revoke all on function public\.sisha_a3_confirm_reliability_cycle_atomic[\s\S]*authenticated/i);
  assert.match(sql, /grant execute on function public\.sisha_a3_confirm_reliability_cycle_atomic[\s\S]*service_role/i);
  assert.doesNotMatch(sql, /delete from public\.equipment_reliability_cycle_confirmations/i);
});

test('A3: MTBF e MTBUR oficiais exigem cobertura completa de utilização em horas', () => {
  const c1 = normalizeCycle(interval({ id: 1 }), confirmation({ interval_id: 1, usage_delta: 100 }));
  const c2 = normalizeCycle(interval({ id: 2, equipment_id: 11, sn: 'SN002', removal_reason: 'PRONTO_USO', failure_status: 'NONE' }), confirmation({ interval_id: 2, usage_start_value: 200, usage_end_value: 300, usage_delta: 100, technical_result: null, repair_started_at: null, repair_completed_at: null, available_at: null }));
  const summary = summarizeA3Cycles([c1, c2]);
  assert.equal(summary.mtbf.ready, true);
  assert.equal(summary.mtbf.value_hours, 200);
  assert.equal(summary.mtbur.ready, true);
  assert.equal(summary.mtbur.value_hours, 200);
  assert.equal(summary.failures_per_1000_hours.value, 5);
});

test('A3: uma leitura de horas faltante bloqueia o MTBF em vez de calcular média parcial', () => {
  const c1 = normalizeCycle(interval({ id: 1 }), confirmation({ interval_id: 1, usage_delta: 100 }));
  const c2 = normalizeCycle(interval({ id: 2, equipment_id: 11, sn: 'SN002', removal_reason: 'PRONTO_USO', failure_status: 'NONE' }), null);
  const summary = summarizeA3Cycles([c1, c2]);
  assert.equal(summary.mtbf.ready, false);
  assert.equal(summary.mtbf.blocker, 'USAGE_HOURS_COVERAGE_INCOMPLETE');
  assert.equal(summary.mtbf.value_hours, null);
});

test('A3: NFF mantém remoção não programada, mas não conta como falha técnica efetiva', () => {
  const c1 = normalizeCycle(interval({ id: 1, removal_reason: 'TESTE', failure_status: 'CONFIRMED', test_result: 'REPROVADO' }), confirmation({ technical_result: 'NFF', repair_started_at: null, repair_completed_at: null, available_at: '2026-02-05T00:00:00Z' }));
  assert.equal(c1.unscheduled_removal, true);
  assert.equal(c1.effective_failure, false);
  const summary = summarizeA3Cycles([c1]);
  assert.equal(summary.nff.ready, true);
  assert.equal(summary.nff.count, 1);
  assert.equal(summary.nff.rate_percent, 100);
  assert.equal(summary.mtbf.ready, false);
  assert.equal(summary.mtbf.blocker, 'CONFIRMED_FAILURE_REQUIRED');
  assert.equal(summary.mtbur.ready, true);
  assert.equal(summary.mtbur.value_hours, 100);
});

test('A3: MTTR técnico não se confunde com TAT canônico', () => {
  // Remoção em 01/02. Dez dias até iniciar reparo; 20 dias de espera já estão
  // embutidos antes do relógio técnico; 3 dias reparando; 5 dias até disponível.
  // MTTR = 3 dias; TAT = 38 dias.
  const c1 = normalizeCycle(interval({ removed_at: '2026-02-01T00:00:00Z' }), confirmation({
    repair_started_at: '2026-03-03T00:00:00Z',
    repair_completed_at: '2026-03-06T00:00:00Z',
    available_at: '2026-03-11T00:00:00Z',
  }));
  const summary = summarizeA3Cycles([c1]);
  assert.equal(summary.mttr.ready, true);
  assert.equal(summary.mttr.value_hours, 72);
  assert.equal(summary.tat.ready, true);
  assert.equal(summary.tat.value_hours, 912);
});

test('A3: repeat removal é nova remoção não programada do mesmo PN+SN sem limiar inventado', () => {
  const rows = markRepeatRemovals([
    normalizeCycle(interval({ id: 1, removed_at: '2026-02-01T00:00:00Z' }), confirmation()),
    normalizeCycle(interval({ id: 2, installed_at: '2026-03-15T00:00:00Z', removed_at: '2026-04-15T00:00:00Z' }), confirmation({ interval_id: 2 })),
  ]);
  assert.equal(rows.filter((row) => row.repeat_removal).length, 1);
  assert.equal(rows.find((row) => row.interval_id === 2).repeat_previous_removed_at, '2026-02-01T00:00:00Z');
  const summary = summarizeA3Cycles(rows);
  assert.equal(summary.repeat_removal.count, 1);
  assert.match(summary.repeat_removal.note, /não inventa limiar/i);
});

test('A3: sugestão do LIVRO DOS MOTORES nunca vira utilização oficial sem confirmação', () => {
  const sourceInterval = interval({ installed_at: '2026-01-01T08:00:00Z', removed_at: '2026-02-01T12:00:00Z' });
  const suggestion = deriveUsageSuggestion(sourceInterval, [
    { aircraft_code: '4005', source_observed_at: '2026-01-01', aircraft_hours: 100 },
    { aircraft_code: '4005', source_observed_at: '2026-02-01', aircraft_hours: 140 },
  ]);
  assert.equal(suggestion.delta, 40);
  assert.equal(suggestion.official_without_confirmation, false);
  const cycle = normalizeCycle(sourceInterval, null, [
    { aircraft_code: '4005', source_observed_at: '2026-01-01', aircraft_hours: 100 },
    { aircraft_code: '4005', source_observed_at: '2026-02-01', aircraft_hours: 140 },
  ]);
  assert.equal(cycle.official_usage, null);
  assert.equal(cycle.usage_suggestion.delta, 40);
});

test('A3: calendário deriva exposição do próprio intervalo A2 sem fabricar leitura externa', () => {
  const cycle = normalizeCycle(interval({ usage_counter: 'CALENDARIO', usage_metric: 'calendar', installed_at: '2026-01-01T00:00:00Z', removed_at: '2026-01-11T00:00:00Z' }), null, []);
  assert.equal(cycle.official_usage.official, true);
  assert.equal(cycle.official_usage.unit, 'CALENDAR_DAYS');
  assert.equal(cycle.official_usage.delta, 10);
});

test('A3: breakdowns existem por PN, SN, aeronave, reparador e fabricante', () => {
  const c1 = normalizeCycle(interval({ id: 1 }), confirmation());
  const summary = summarizeA3Cycles([c1]);
  assert.equal(summary.breakdowns.by_pn[0].key, 'PN123');
  assert.match(summary.breakdowns.by_sn[0].key, /SN001/);
  assert.equal(summary.breakdowns.by_aircraft[0].key, '4005');
  assert.equal(summary.breakdowns.by_repairer[0].key, 'LEONARDO');
  assert.equal(summary.breakdowns.by_manufacturer[0].key, 'OEM X');
});

test('A3: backend usa A2 + A1.2 e mantém confirmação em rota Admin/Dono', () => {
  const service = read('src/services/equipmentReliabilityService.js');
  const routes = read('src/routes/equipmentRoutes.js');
  assert.match(service, /equipment_operational_intervals/);
  assert.match(service, /aircraft_running_log_snapshots/);
  assert.match(service, /v_sisha_a3_current_cycle_confirmations/);
  assert.match(service, /sisha_a3_confirm_reliability_cycle_atomic/);
  assert.match(routes, /router\.get\('\/reliability', equipmentController\.painelConfiabilidadeA3\)/);
  assert.match(routes, /router\.post\('\/reliability\/confirm', requireRole\(\['admin'\]\), equipmentController\.confirmarCicloConfiabilidadeA3\)/);
});

test('A3: frontend adiciona somente modal de confiabilidade no Administrar e reserva A4', () => {
  const page = fs.readFileSync(path.resolve(ROOT, '../sisha-frontend/src/pages/Equipamentos.jsx'), 'utf8');
  const modal = fs.readFileSync(path.resolve(ROOT, '../sisha-frontend/src/components/ReliabilityAnalysisModal.jsx'), 'utf8');
  assert.match(page, /Indicadores de confiabilidade/);
  assert.match(page, /ReliabilityAnalysisModal/);
  assert.match(modal, /A3 — Motor de Confiabilidade/);
  assert.match(modal, /MTBF/);
  assert.match(modal, /MTBUR/);
  assert.match(modal, /MTTR técnico/);
  assert.match(modal, /TAT/);
  assert.match(modal, /NFF/);
  assert.match(modal, /Repeat removal/);
  assert.match(modal, /Sem previsão de ruptura ou recomendação de compra\/reparo nesta etapa/);
});
