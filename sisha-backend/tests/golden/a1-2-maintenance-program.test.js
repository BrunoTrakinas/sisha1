const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const {
  numericCell,
  parseRunningLogWorkbook,
} = require('../../src/services/aircraftRunningLogService');
const {
  buildMaintenanceProgram,
} = require('../../src/services/maintenancePlanningService');

const backend = path.resolve(__dirname, '../..');
const project = path.resolve(backend, '..');

function makeSheet() {
  return {
    '!ref': 'A1:Y30',
    A7: { v: 'AIRCRAFT\nTOTAL HOURS', w: 'AIRCRAFT\nTOTAL HOURS' },
    H4: { v: 46258, w: '24/08/2026', z: 'dd/mm/yyyy' },
    Y7: { v: 174.5, w: '4188:00', z: '[h]:mm' },
    A11: { v: 'Landings', w: 'Landings' }, Y11: { v: 3200, w: '3200' },
    A13: { v: 'Rotor Stop Start', w: 'Rotor Stop Start' }, Y13: { v: 1200, w: '1200' },
    A14: { v: 'No.1 Engine', w: 'No.1 Engine' }, Y14: { v: 60.25, w: '1446:00', z: '[h]:mm' },
    Y15: { v: 900, w: '900' }, Y16: { v: 2100.5, w: '2100.5' }, Y17: { v: 350.25, w: '350.25' },
    A20: { v: 'No.2 Engine', w: 'No.2 Engine' }, Y20: { v: 65.5, w: '1572:00', z: '[h]:mm' },
    Y21: { v: 1100, w: '1100' }, Y22: { v: 2500, w: '2500' }, Y23: { v: 420.5, w: '420.5' },
  };
}

test('A1.2: duração Excel [h]:mm vira horas sem truncar acima de 24h', () => {
  assert.equal(numericCell({ v: 174.5, w: '4188:00', z: '[h]:mm' }, { hours: true }), 4188);
});

test('A1.2: LIVRO DOS MOTORES reconhece aba de aeronave e ignora MODELO', () => {
  const parsed = parseRunningLogWorkbook({ SheetNames: ['4004', 'MODELO'], Sheets: { 4004: makeSheet(), MODELO: {} } }, 'LIVRO DOS MOTORES.xlsx');
  assert.equal(parsed.snapshots.length, 1);
  assert.equal(parsed.snapshots[0].aircraft_code, '4004');
  assert.equal(parsed.snapshots[0].aircraft_hours, 4188);
  assert.equal(parsed.snapshots[0].engine_1_power_turbine_cycles, 2100.5);
});

test('A1.2: indicador de horas restantes exige vínculo PN/SN antes de programar', () => {
  const indicator = { aircraft_code: '4004', indicator_key: 'TBO', source_cell: 'G14', label: 'TBO', value_type: 'TBO_HOURS_REMAINING', value_numeric: 80, quality_status: 'VALID' };
  const program = buildMaintenanceProgram([indicator], [], [], new Date('2026-08-15T12:00:00Z'));
  assert.equal(program.scheduled_needs.length, 0);
  assert.equal(program.rows[0].blocker, 'BINDING_REQUIRED');
});

test('A1.2: vínculo confirmado transforma TBO futuro em necessidade programada', () => {
  const indicator = { aircraft_code: '4004', indicator_key: 'TBO', source_cell: 'G14', label: 'TBO', value_type: 'TBO_HOURS_REMAINING', value_numeric: 80, quality_status: 'VALID' };
  const binding = { aircraft_code: '4004', indicator_key: 'TBO', source_cell: 'G14', pn: 'PN123', sn: 'SN1', quantidade: 1, maintenance_action: 'OVERHAUL', planning_enabled: true };
  const program = buildMaintenanceProgram([indicator], [binding], [], new Date('2026-08-15T12:00:00Z'));
  assert.equal(program.scheduled_needs.length, 1);
  assert.equal(program.scheduled_needs[0].pn, 'PN123');
  assert.equal(program.scheduled_needs[0].trigger.value, 80);
});

test('A1.2: valor bruto que não é vencimento/restante nunca vira necessidade programada', () => {
  const indicator = { aircraft_code: '4004', indicator_key: 'AIRCRAFT_HOURS', source_cell: 'B2', label: 'Horas da ANV', value_type: 'NUMERIC', value_numeric: 4188, quality_status: 'VALID' };
  const binding = { aircraft_code: '4004', indicator_key: 'AIRCRAFT_HOURS', source_cell: 'B2', pn: 'PN123', quantidade: 1, maintenance_action: 'OTHER', planning_enabled: true };
  const program = buildMaintenanceProgram([indicator], [binding], [], new Date('2026-08-15T12:00:00Z'));
  assert.equal(program.scheduled_needs.length, 0);
  assert.equal(program.rows[0].blocker, 'NOT_SCHEDULING_TRIGGER');
});

test('A1.2: migration preserva running log, vínculo append-only e auditoria Admin/Dono', () => {
  const sql = fs.readFileSync(path.join(backend, 'sql/migrations/20260815_A1_2_001_running_log_maintenance_program.sql'), 'utf8');
  assert.match(sql, /aircraft_running_log_snapshots/);
  assert.match(sql, /equipment_maintenance_binding_confirmations/);
  assert.match(sql, /v_sisha_current_maintenance_bindings/);
  assert.match(sql, /sisha_confirm_maintenance_binding_atomic/);
  assert.match(sql, /system_audit_logs/);
  assert.match(sql, /admin','dono/i);
});

test('A1.2: Gerador mantém manutenção programada seletiva e desligada por padrão', () => {
  const src = fs.readFileSync(path.join(backend, 'src/controllers/needsController.js'), 'utf8');
  assert.match(src, /incluirProgramadas = false/);
  assert.match(src, /if \(incluirProgramadas\)/);
  assert.match(src, /MANUTENÇÃO PROGRAMADA/);
});

test('A1.2: frontend só adiciona LIVRO DOS MOTORES, checkbox seletivo e modal de vínculo', () => {
  const cadastro = fs.readFileSync(path.join(project, 'sisha-frontend/src/pages/Cadastro.jsx'), 'utf8');
  const gerador = fs.readFileSync(path.join(project, 'sisha-frontend/src/pages/GeradorNecessidades.jsx'), 'utf8');
  const equipamentos = fs.readFileSync(path.join(project, 'sisha-frontend/src/pages/Equipamentos.jsx'), 'utf8');
  const modal = fs.readFileSync(path.join(project, 'sisha-frontend/src/components/MaintenanceProgramModal.jsx'), 'utf8');
  assert.match(cadastro, /LIVRO DOS MOTORES/);
  assert.match(gerador, /Incluir manutenção programada confirmada/);
  assert.match(equipamentos, /Controle de TBO \/ horas \/ ciclos/);
  assert.match(equipamentos, /MaintenanceProgramModal/);
  assert.match(modal, /Nenhum vínculo é inferido/);
});
