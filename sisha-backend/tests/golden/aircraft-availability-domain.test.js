const test = require('node:test');
const assert = require('node:assert/strict');

const {
  parseAvailabilityWorkbook,
  parseDurationTextToHours,
} = require('../../src/services/aircraftAvailabilityService');
const {
  buildAircraftAvailabilityMap,
  buildMtAvailabilityDecision,
} = require('../../src/services/mtNeedPolicyService');

function makeSheet(cells = {}) {
  return Object.fromEntries(Object.entries(cells).map(([addr, value]) => {
    if (value && typeof value === 'object' && Object.prototype.hasOwnProperty.call(value, 'v')) return [addr, value];
    return [addr, { v: value, w: String(value) }];
  }));
}

test('A1.1: parser preserva D/I, horas, motivo, motores e TBO/horas restantes', () => {
  const sheet4005 = makeSheet({
    K1: { v: 'I', w: 'I' },
    A2: { v: 'HORAS DA ANV:', w: 'HORAS DA ANV:' },
    B2: { v: 2731.4, w: '2731,4' },
    D2: { v: 'DATA DO ULTIMO VOO', w: 'DATA DO ULTIMO VOO' },
    F2: { v: 46234, w: '31/07/2026', z: 'dd/mm/yyyy' },
    D3: { v: 'DATA DA ATUALIZAÇÃO', w: 'DATA DA ATUALIZAÇÃO' },
    F3: { v: 46235.5, w: '01/08/2026 12:00', z: 'dd/mm/yyyy hh:mm' },
    H2: { v: 'ULTIMA FRV', w: 'ULTIMA FRV' },
    I2: { v: '40050811', w: '40050811' },
    A4: { v: 'MOTOR #1:', w: 'MOTOR #1:' },
    B4: { v: 'P4N293', w: 'P4N293' },
    C4: { v: 120.5 / 24, w: '120:30:00', z: '[hh]:mm:ss' },
    A5: { v: 'MOTOR #2:', w: 'MOTOR #2:' },
    B5: { v: 'P4N290', w: 'P4N290' },
    C5: { v: 80 / 24, w: '80:00:00', z: '[hh]:mm:ss' },
    A35: { v: 'MOTIVO DA INDISPONIBILIDADE', w: 'MOTIVO DA INDISPONIBILIDADE' },
    B36: { v: 'AGUARDANDO COMPONENTES DO MOTOR', w: 'AGUARDANDO COMPONENTES DO MOTOR' },
    F13: { v: 'FUEL NOZZLE #1', w: 'FUEL NOZZLE #1' },
    G13: { v: 60 / 24, w: '60:00:00', z: '[hh]:mm:ss' },
    F14: { v: 'TBO', w: 'TBO' },
    G14: { v: 100 / 24, w: '100:00:00', z: '[hh]:mm:ss' },
    F15: { v: 'OUTRO INDICADOR', w: 'OUTRO INDICADOR' },
    G15: { t: 'e', v: 15, w: '#N/A' },
    A50: { v: 'LEGENDA', w: 'LEGENDA' },
  });

  const parsed = parseAvailabilityWorkbook({
    SheetNames: ['4005'],
    Sheets: { 4005: sheet4005 },
  }, 'DISPONIBILIDADE.xlsx');

  assert.equal(parsed.summary.aircraft_count, 1);
  assert.equal(parsed.summary.unavailable, 1);
  const snapshot = parsed.snapshots[0];
  assert.equal(snapshot.aircraft_code, '4005');
  assert.equal(snapshot.status, 'I');
  assert.equal(snapshot.reason, 'AGUARDANDO COMPONENTES DO MOTOR');
  assert.equal(snapshot.aircraft_hours, 2731.4);
  assert.equal(snapshot.engine_1_sn, 'P4N293');
  assert.equal(snapshot.engine_2_sn, 'P4N290');
  assert.equal(snapshot.engine_1_hours, 120.5);
  assert.equal(snapshot.engine_2_hours, 80);
  assert.equal(snapshot.last_frv, '40050811');

  const fuelNozzle = snapshot.indicators.find((item) => item.label === 'FUEL NOZZLE #1' && item.source_cell === 'G13');
  assert.ok(fuelNozzle);
  assert.equal(fuelNozzle.value_type, 'HOURS_REMAINING');
  assert.equal(fuelNozzle.value_numeric, 60);

  const tbo = snapshot.indicators.find((item) => item.label === 'TBO' && item.source_cell === 'G14');
  assert.ok(tbo);
  assert.equal(tbo.value_type, 'TBO_HOURS_REMAINING');
  assert.equal(tbo.value_numeric, 100);

  const error = snapshot.indicators.find((item) => item.source_cell === 'G15');
  assert.ok(error);
  assert.equal(error.value_type, 'ERROR');
  assert.equal(error.value_numeric, null);
  assert.equal(error.quality_status, 'ERROR');
});

test('A1.1: duração [hh]:mm e texto não perdem horas acima de 24', () => {
  assert.equal(parseDurationTextToHours('125:30:00'), 125.5);
});

test('A1.1: MT é adicional quando 4004/4005 compartilham PN e uma ANV relacionada está I', () => {
  const selected = [
    { pn: 'MFV-1', isAircraft: true, isMt: false, origem: { origem_codigo: '4004' } },
    { pn: 'MFV-1', isAircraft: true, isMt: false, origem: { origem_codigo: '4005' } },
    { pn: 'MFV-1', isAircraft: false, isMt: true, origem: { origem_codigo: 'MTVN' } },
  ];
  const map = buildAircraftAvailabilityMap([
    { aircraft_code: '4004', status: 'D' },
    { aircraft_code: '4005', status: 'I', reason: 'AGUARDANDO MFV' },
  ]);
  const decision = buildMtAvailabilityDecision(selected[2], selected, map);
  assert.equal(decision.blocked, false);
  assert.equal(decision.additive, true);
  assert.deepEqual(decision.relatedAircraft.sort(), ['4004', '4005']);
  assert.deepEqual(decision.unavailableAircraft, ['4005']);
});

test('A1.1: MT sobreposta não infla necessidade quando nenhuma ANV relacionada tem I comprovado', () => {
  const selected = [
    { pn: 'MFV-1', isAircraft: true, origem: { origem_codigo: '4004' } },
    { pn: 'MFV-1', isAircraft: true, origem: { origem_codigo: '4005' } },
    { pn: 'MFV-1', isMt: true, origem: { origem_codigo: 'MTVN' } },
  ];
  const map = buildAircraftAvailabilityMap([
    { aircraft_code: '4004', status: 'D' },
    { aircraft_code: '4005', status: 'UNKNOWN' },
  ]);
  const decision = buildMtAvailabilityDecision(selected[2], selected, map);
  assert.equal(decision.blocked, true);
  assert.equal(decision.additive, false);
  assert.equal(decision.reason, 'UNAVAILABLE_EVIDENCE_REQUIRED');
});

test('A1.1: MT de PN sem sobreposição com OS de ANV continua demanda própria quando selecionada', () => {
  const selected = [
    { pn: 'PN-A', isAircraft: true, origem: { origem_codigo: '4005' } },
    { pn: 'PN-B', isMt: true, origem: { origem_codigo: 'MTMV' } },
  ];
  const decision = buildMtAvailabilityDecision(selected[1], selected, new Map());
  assert.equal(decision.blocked, false);
  assert.equal(decision.additive, false);
  assert.equal(decision.reason, 'NO_AIRCRAFT_OVERLAP');
});

test('A1.1: integração mantém importação administrativa e consultas read-only autenticadas', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const backend = path.resolve(__dirname, '../..');
  const routes = fs.readFileSync(path.join(backend, 'src/routes/needsRoutes.js'), 'utf8');
  const importController = fs.readFileSync(path.join(backend, 'src/controllers/importController.js'), 'utf8');
  const cadastro = fs.readFileSync(path.resolve(backend, '../sisha-frontend/src/pages/Cadastro.jsx'), 'utf8');

  assert.match(routes, /\/aircraft-availability\/current/);
  assert.match(routes, /\/aircraft-availability\/:aircraft\/indicators/);
  assert.match(importController, /tipoArquivo === 'disponibilidade_anv'/);
  assert.match(importController, /sisha_import_aircraft_availability_atomic|importAvailabilityAtomic/);
  assert.match(cadastro, /value="disponibilidade_anv"/);
});
