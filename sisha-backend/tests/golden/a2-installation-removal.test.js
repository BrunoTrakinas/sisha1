const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const {
  failureEvidence,
  summarizeReliabilityEvidence,
} = require('../../src/services/reliabilityEvidenceService');

const backend = path.resolve(__dirname, '../..');
const project = path.resolve(backend, '..');
const migrationPath = path.join(backend, 'sql/migrations/20260815_A2_001_installation_removal_intervals.sql');

function read(file) {
  return fs.readFileSync(file, 'utf8');
}

test('A2: migration cria intervalo PN+SN único por equipamento e posição', () => {
  const sql = read(migrationPath);
  assert.match(sql, /create table if not exists public\.equipment_operational_intervals/i);
  assert.match(sql, /uq_equipment_operational_interval_open_equipment/i);
  assert.match(sql, /uq_equipment_operational_interval_open_position/i);
  assert.match(sql, /where removed_at is null/i);
  assert.match(sql, /operation_install_id uuid not null/i);
  assert.match(sql, /operation_remove_id uuid/i);
});

test('A2: instalação usa Livro de Eventos existente e contador auditável sem total_hours incremental', () => {
  const sql = read(migrationPath);
  assert.match(sql, /sisha_insert_equipment_event_atomic/i);
  assert.match(sql, /'tipo_evento','INSTALACAO_ANV'/i);
  assert.match(sql, /HORAS_DE_VOO.*MOTOR_1.*MOTOR_2.*CICLOS.*CALENDARIO/is);
  assert.match(sql, /v_metric := 'aircraft_hours'/i);
  assert.match(sql, /v_metric := 'engine_1_hours'/i);
  assert.match(sql, /v_metric := 'engine_2_hours'/i);
  assert.doesNotMatch(sql, /total_hours\s*=\s*total_hours\s*\+/i);
  assert.doesNotMatch(sql, /horas_acumuladas\s*=\s*horas_acumuladas\s*\+/i);
  assert.match(sql, /condicao_atual.*AVARIADO.*EM_REPARO.*AGUARDANDO_REPARO.*QUARENTENA/is);
});

test('A2: remoção aceita somente PANE, TESTE e PRONTO_USO e nunca presume PPU', () => {
  const sql = read(migrationPath);
  assert.match(sql, /removal_reason.*PANE.*TESTE.*PRONTO_USO/is);
  assert.match(sql, /if v_reason not in \('PANE','TESTE','PRONTO_USO'\)/i);
  assert.match(sql, /if v_category='' then v_category:='DESCONHECIDO'/i);
  assert.doesNotMatch(sql, /if v_category='' then v_category:='PPU'/i);
});

test('A2: PANE é falha confirmada e TESTE pendente ainda não é falha', () => {
  assert.equal(failureEvidence({
    tipo_evento: 'REMOCAO_ANV',
    condicao_resultante: 'AVARIADO',
    payload: { a2: { removal_reason: 'PANE', failure_status: 'CONFIRMED' } },
  }), 'CONFIRMED');

  assert.equal(failureEvidence({
    tipo_evento: 'REMOCAO_ANV',
    condicao_resultante: 'EM_TESTE',
    payload: { a2: { removal_reason: 'TESTE', test_result: 'PENDENTE', failure_status: 'PENDING_TEST' } },
  }), 'NONE');
});

test('A2: TESTE APROVADO não gera falha e REPROVADO confirma falha', () => {
  assert.equal(failureEvidence({
    tipo_evento: 'A2_RESULTADO_TESTE',
    payload: { a2: { test_result: 'APROVADO', failure_status: 'NONE' } },
  }), 'NONE');
  assert.equal(failureEvidence({
    tipo_evento: 'A2_RESULTADO_TESTE',
    payload: { a2: { test_result: 'REPROVADO', failure_status: 'CONFIRMED' } },
  }), 'CONFIRMED');
});

test('A2: evidência preparada para A3 mantém MTBF bloqueado sem horas de utilização', () => {
  const summary = summarizeReliabilityEvidence([
    { id: 1, tipo_evento: 'REMOCAO_ANV', data_evento: '2026-08-15T12:00:00Z', payload: { a2: { failure_status: 'CONFIRMED', removal_reason: 'PANE' } } },
  ]);
  assert.equal(summary.falhas_confirmadas, 1);
  assert.equal(summary.mtbf.ready, false);
  assert.equal(summary.mtbf.blocker, 'AIRCRAFT_UTILIZATION_HOURS_REQUIRED');
});

test('A2: mutações HTTP permanecem Admin/Dono e consultas são read-only autenticadas', () => {
  const routes = read(path.join(backend, 'src/routes/equipmentRoutes.js'));
  assert.match(routes, /router\.get\('\/operations\/candidates'/);
  assert.match(routes, /router\.get\('\/operations\/installations'/);
  assert.match(routes, /router\.get\('\/operations\/pending-tests'/);
  assert.match(routes, /router\.post\('\/operations\/install', requireRole\(\['admin'\]\)/);
  assert.match(routes, /router\.post\('\/operations\/remove', requireRole\(\['admin'\]\)/);
  assert.match(routes, /router\.post\('\/operations\/test-result', requireRole\(\['admin'\]\)/);
});

test('A2: RPCs são service-role only e registram auditoria', () => {
  const sql = read(migrationPath);
  assert.match(sql, /security definer/gi);
  assert.match(sql, /system_audit_logs/);
  assert.match(sql, /v_role not in \('admin','dono'\)/i);
  assert.match(sql, /grant execute on function public\.sisha_a2_install_equipment_atomic[\s\S]*to service_role/i);
  assert.match(sql, /revoke all on function public\.sisha_a2_install_equipment_atomic[\s\S]*from authenticated/i);
});

test('A2: frontend adiciona apenas fluxo guiado sem remover OS\/PIM ou Programa TBO', () => {
  const equipamentos = read(path.join(project, 'sisha-frontend/src/pages/Equipamentos.jsx'));
  const modal = read(path.join(project, 'sisha-frontend/src/components/EquipmentOperationsModal.jsx'));
  assert.match(equipamentos, /Instalar \/ Remover PN\+SN/);
  assert.match(equipamentos, /OS \/ PIM/);
  assert.match(equipamentos, /Programa TBO \/ horas \/ ciclos/);
  assert.match(modal, /PANE/);
  assert.match(modal, /TESTE/);
  assert.match(modal, /PRONTO USO/);
  assert.match(modal, /Nunca envia automaticamente para o PPU/);
  assert.match(modal, /MTBF\/MTTR\/TAT são calculados somente no A3/);
});
