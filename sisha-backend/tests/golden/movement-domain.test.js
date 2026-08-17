const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');

const originalLoad = Module._load;
Module._load = function mockedLoad(request, parent, isMain) {
  if (request === '../config/supabaseClient') return {};
  if (request === '../config/supabaseAdminClient') return { getSupabaseAdmin: () => ({}) };
  return originalLoad.call(this, request, parent, isMain);
};

const {
  parseOsOrigin,
  AIRCRAFT_CODES,
  WORKSHOP_MAP,
} = require('../../src/services/osPimEquipmentService');

const {
  extractDateFromText,
  normalizeSn,
  sourceKey,
} = require('../../src/services/orderBookEquipmentService');

Module._load = originalLoad;

const backendRoot = path.resolve(__dirname, '../..');

test('GOLDEN OS/PIM: prefixo de aeronave identifica origem ANV', () => {
  assert.deepEqual(
    parseOsOrigin('4003-OS-1234'),
    { tipo: 'ANV', codigo: '4003', descricao: 'AERONAVE 4003' }
  );
  assert.ok(AIRCRAFT_CODES.includes('4001'));
  assert.ok(AIRCRAFT_CODES.includes('4010'));
});

test('GOLDEN OS/PIM: prefixos de oficina preservam origem operacional', () => {
  for (const prefix of ['HV', 'MV', 'SV', 'VN', 'PA', 'MT']) {
    const parsed = parseOsOrigin(`${prefix}-1234`);
    assert.equal(parsed.tipo, 'OFICINA');
    assert.equal(parsed.codigo, prefix);
    assert.equal(parsed.descricao, WORKSHOP_MAP[prefix]);
  }
});

test('GOLDEN Order Book equipamento: SN perde espacos mas nao identidade', () => {
  assert.equal(normalizeSn(' sn 00 123 '), 'SN00123');
});

test('GOLDEN Order Book equipamento: data textual preserva data civil e chave de origem e deterministica', () => {
  assert.equal(extractDateFromText('Delivered on 13/08/2026'), '2026-08-13T12:00:00.000Z');
  const row = {
    source_sheet: 'Repair',
    trace_type: 'ER',
    documento_referencia: 'PD-123',
    pn: 'PN-1',
    sn: 'SN-1',
  };
  assert.equal(sourceKey(row, 'RECEIVED'), sourceKey(row, 'RECEIVED'));
  assert.notEqual(sourceKey(row, 'RECEIVED'), sourceKey(row, 'SHIPPED'));
});

test('GOLDEN OS/PIM: contratos de movimento permanecem no servico', () => {
  const source = fs.readFileSync(
    path.join(backendRoot, 'src/services/osPimEquipmentService.js'),
    'utf8'
  );
  assert.match(source, /PN e SN são obrigatórios/);
  assert.match(source, /Informe ao menos OS, OSR ou PIM/);
  assert.match(source, /INSTALACAO/);
  assert.match(source, /REMOCAO/);
  assert.match(source, /POSSIVEL_PANE/);
  assert.match(source, /PRONTO_USO/);
});
