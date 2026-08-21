const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  buildConsumptionProjection,
  buildReliabilityProjection,
  buildScheduledProjection,
  buildProcurementSnapshot,
  buildRepairSnapshot,
  deriveCriticality,
  buildA4PnAnalysis,
  parseLeadTimeDays,
} = require('../../src/services/logisticsIntelligenceService');

const NOW = new Date('2026-08-15T12:00:00Z');

test('A4: consumo histórico exige mais de uma observação e janela mínima', () => {
  const blocked = buildConsumptionProjection([{ data_movimentacao: '2026-08-01', quantidade: 3 }], 90, NOW);
  assert.equal(blocked.ready, false);
  assert.equal(blocked.blocker, 'HISTORICAL_CONSUMPTION_COVERAGE_INSUFFICIENT');

  const ready = buildConsumptionProjection([
    { data_movimentacao: '2026-05-17', quantidade: 2 },
    { data_movimentacao: '2026-07-15', quantidade: 2 },
  ], 90, NOW);
  assert.equal(ready.ready, true);
  assert.ok(ready.projected_qty > 3.9 && ready.projected_qty < 4.1);
});

test('A4: MTBF só projeta falhas quando A3 está pronto e há horas previstas', () => {
  assert.equal(buildReliabilityProjection({ mtbf: { ready: true, value_hours: 100 } }, 0).ready, false);
  const result = buildReliabilityProjection({ mtbf: { ready: true, value_hours: 100 } }, 250);
  assert.equal(result.ready, true);
  assert.equal(result.expected_failures, 2.5);
});

test('A4: manutenção programada respeita horizonte e contador previsto', () => {
  const result = buildScheduledProjection([
    { quantidade: 2, planning_status: 'PLANNED', trigger: { type: 'DATE', due_date: '2026-09-01' } },
    { quantidade: 1, planning_status: 'PLANNED', trigger: { type: 'HOURS_REMAINING', value: 50 } },
    { quantidade: 9, planning_status: 'PLANNED', trigger: { type: 'DATE', due_date: '2027-01-01' } },
  ], 90, 60, 0, NOW);
  assert.equal(result.projected_qty, 3);
  assert.equal(result.included.length, 2);
});

test('A4: somente ODA é cobertura futura; ODC é potencial e FAT/EMB/REC são históricos', () => {
  const result = buildProcurementSnapshot([
    { status_grupo: 'ODA', quantidade: 2, qtd_recebida: 0, data_previsao_entrega: '2026-09-01', dias_entrega: 100 },
    { status_grupo: 'ODC', quantidade: 3, qtd_recebida: 0, data_previsao_entrega: '2026-09-10', dias_entrega: 200 },
    { status_grupo: 'FAT', quantidade: 1, qtd_recebida: 0, data_previsao_entrega: null },
  ], 90, NOW, 240);
  assert.equal(result.committed_within_horizon, 2);
  assert.equal(result.potential_within_horizon, 3);
  assert.equal(result.pipeline_without_date, 0);
  assert.equal(result.pipeline.find((row) => row.status === 'FAT')?.coverage_role, 'HISTORICAL_DELIVERED');
  assert.equal(result.lead_time.effective_days, 150);
  assert.equal(result.lead_time.source, 'HISTORICAL_PD_DIAS_ENTREGA_MEDIAN');
});

test('A4: reparo em aberto nunca vira estoque confirmado antes do retorno', () => {
  const result = buildRepairSnapshot([
    { numero_wo: 'WO1', status: 'REP', resultado_tecnico: 'PENDENTE', data_previsao_entrega: '2026-09-01' },
    { numero_wo: 'WO2', status: 'REP', resultado_tecnico: 'PENDENTE' },
    { numero_wo: 'WO3', status: 'REP', resultado_tecnico: 'IRREPARAVEL', data_previsao_entrega: '2026-09-01' },
  ], 90, NOW);
  assert.equal(result.open_units, 2);
  assert.equal(result.potential_return_within_horizon, 1);
  assert.match(result.note, /potencial/i);
});

test('A4: criticidade só é elevada quando existe evidência explícita', () => {
  assert.equal(deriveCriticality([]).status, 'UNCONFIRMED');
  assert.equal(deriveCriticality([{ critica: 'SIM' }]).status, 'CRITICAL');
  assert.equal(deriveCriticality([{ prioridade: '3' }]).status, 'DOCUMENTED_NOT_CONFIRMED_CRITICAL');
});

test('A4: lead time textual é normalizado sem inventar conversão monetária ou prazo', () => {
  assert.equal(parseLeadTimeDays('12 weeks'), 84);
  assert.equal(parseLeadTimeDays('45 dias'), 45);
  assert.equal(parseLeadTimeDays('sem dado'), null);
});

test('A4: risco é parcela da demanda sem cobertura confirmada e CeIMSPA permanece potencial', () => {
  const result = buildA4PnAnalysis({
    pn: 'PN123',
    horizonDays: 90,
    expectedFlightHours: 100,
    historyRows: [
      { data_movimentacao: '2026-05-17', quantidade: 2 },
      { data_movimentacao: '2026-07-15', quantidade: 2 },
    ],
    ppuRows: [{ quantidade: 2 }],
    ceimspaRows: [{ quantidade: 1 }],
    purchaseRows: [
      { status_grupo: 'ODA', quantidade: 1, data_previsao_entrega: '2026-09-01' },
      { status_grupo: 'ODC', quantidade: 1, data_previsao_entrega: '2026-09-01' },
    ],
    repairRows: [{ status: 'REP', resultado_tecnico: 'PENDENTE', data_previsao_entrega: '2026-09-01' }],
    scheduledNeeds: [{ quantidade: 2, planning_status: 'PLANNED', trigger: { type: 'DATE', due_date: '2026-09-01' } }],
    reliabilitySummary: { mtbf: { ready: true, value_hours: 100 } },
    now: NOW,
  });
  assert.equal(result.demand.predicted_qty, 7);
  assert.equal(result.supply.confirmed_total, 3);
  assert.equal(result.supply.potential_total, 6);
  assert.equal(result.risk.shortage_confirmed_qty, 4);
  assert.equal(result.risk.shortage_after_potential_qty, 1);
  assert.equal(result.risk.index_percent, 57.1);
  assert.match(result.risk.explanation, /não é probabilidade estatística/i);
  assert.equal(result.recommendation.contingency_purchase_qty, 1);
});

test('A4: sem consumo, MTBF utilizável ou manutenção prevista a projeção falha fechada', () => {
  const result = buildA4PnAnalysis({ pn: 'PNX', horizonDays: 90, ppuRows: [{ quantidade: 99 }], now: NOW });
  assert.equal(result.status, 'BLOCKED');
  assert.equal(result.risk.index_percent, null);
  assert.equal(result.recommendation.primary_action, 'COMPLETE_EVIDENCE');
});

test('A4: recomendação não transforma CeIMSPA, reparo ou ODC em disponibilidade confirmada', () => {
  const result = buildA4PnAnalysis({
    pn: 'PNY', horizonDays: 90,
    scheduledNeeds: [{ quantidade: 4, planning_status: 'OVERDUE', trigger: { type: 'DATE', due_date: '2026-08-01' } }],
    ppuRows: [{ quantidade: 1 }],
    ceimspaRows: [{ quantidade: 1 }],
    repairRows: [{ status: 'REP', resultado_tecnico: 'PENDENTE', data_previsao_entrega: '2026-09-01' }],
    purchaseRows: [{ status_grupo: 'ODC', quantidade: 1, data_previsao_entrega: '2026-09-01' }],
    now: NOW,
  });
  assert.equal(result.supply.confirmed_total, 1);
  assert.equal(result.supply.potential_total, 4);
  assert.equal(result.recommendation.primary_action, 'CONFIRM_CEIMSPA');
  assert.equal(result.recommendation.contingency_purchase_qty, 0);
});

test('A4: endpoint é somente consulta e não cria rota de mutação logística', () => {
  const routes = fs.readFileSync(path.join(__dirname, '../../src/routes/needsRoutes.js'), 'utf8');
  assert.match(routes, /router\.get\('\/intelligence\/a4'/);
  assert.doesNotMatch(routes, /router\.(?:post|put|patch|delete)\('\/intelligence\/a4'/);
  const service = fs.readFileSync(path.join(__dirname, '../../src/services/logisticsIntelligenceService.js'), 'utf8');
  assert.match(service, /A4 é somente recomendação read-only/);
  assert.doesNotMatch(service, /\.insert\(|\.update\(|\.delete\(|\.upsert\(/);
});

test('A4: frontend preserva Gerador e adiciona apenas botão/modal de Inteligência Logística', () => {
  const page = fs.readFileSync(path.join(__dirname, '../../../sisha-frontend/src/pages/GeradorNecessidades.jsx'), 'utf8');
  const modal = fs.readFileSync(path.join(__dirname, '../../../sisha-frontend/src/components/LogisticsIntelligenceModal.jsx'), 'utf8');
  assert.match(page, /Gerador de Necessidades/);
  assert.match(page, /INTELIGÊNCIA A4/);
  assert.match(page, /LogisticsIntelligenceModal/);
  assert.match(modal, /A4 — Inteligência Logística/);
  assert.match(modal, /Não cria OC, PD ou WO/);
});
