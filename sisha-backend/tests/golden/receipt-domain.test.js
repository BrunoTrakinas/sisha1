const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

const originalLoad = Module._load;
const fakeXlsx = {};
const fakeSupabase = {};

Module._load = function mockedLoad(request, parent, isMain) {
  if (request === 'xlsx') return fakeXlsx;
  if (request === '../config/supabaseClient') return fakeSupabase;
  return originalLoad.call(this, request, parent, isMain);
};

const {
  parseLocaleNumber,
  extractSerials,
  extractReceivingOrganization,
  extractProgramOrigin,
  inferPredictedDestination,
  classifyValidity,
} = require('../../src/services/receiptDocumentParser');

const {
  parseDateToIso,
  isRealSerial,
  normalizeReceiptItems,
} = require('../../src/utils/receiptLedger');

Module._load = originalLoad;

test('GOLDEN Recebimentos: numeros BR e internacional convergem para o mesmo valor', () => {
  assert.equal(parseLocaleNumber('£ 1.234,56'), 1234.56);
  assert.equal(parseLocaleNumber('1,234.56'), 1234.56);
  assert.equal(parseLocaleNumber(12.5), 12.5);
});

test('GOLDEN Recebimentos: extracao de SN separa varios equipamentos sem duplicar serial', () => {
  assert.deepEqual(
    extractSerials('PUMP ASSY S/N: SN001, SN002; SN001 - BRAZIL ITEM'),
    ['SN001', 'SN002']
  );
});

test('GOLDEN Recebimentos: placeholders nao sao aceitos como serial real', () => {
  for (const value of ['', 'N/A', 'NA', 'S/N', 'SEM SN', 'SEM S/N', '-']) {
    assert.equal(isRealSerial(value), false, value);
  }
  assert.equal(isRealSerial('AB-123'), true);
});

test('GOLDEN Recebimentos: PD 71200 ou recebedor CEIMSPA preve destino CEIMSPA', () => {
  assert.deepEqual(
    inferPredictedDestination({ pd: '71200-123/2026' }),
    { destino: 'CEIMSPA', fonte: 'PD_71200' }
  );
  assert.deepEqual(
    inferPredictedDestination({ receiver: { sigla: 'CEIMSPA' } }),
    { destino: 'CEIMSPA', fonte: 'RECEBEDOR_CEIMSPA' }
  );
});

test('GOLDEN Recebimentos: validade documental nao transforma vencido em pronto uso', () => {
  const noStock = classifyValidity('No Stock', 'item');
  assert.equal(noStock.condition, 'FALTANTE');
  assert.equal(noStock.validity, 'SEM_ESTOQUE');

  const expired = classifyValidity('Expired', 'batch');
  assert.equal(expired.condition, 'QUARENTENA');
  assert.equal(expired.validity, 'VENCIDO');

  const near = classifyValidity('Near Expiring', 'batch');
  assert.equal(near.condition, 'RECEBIDO_DISPONIVEL');
  assert.equal(near.validity, 'PROXIMO_VENCIMENTO');
});

test('GOLDEN Recebimentos: codigo OM, sigla e programa de origem sao preservados', () => {
  assert.deepEqual(
    extractReceivingOrganization('CÓDIGO OM: 71200 SIGLA - CEIMSPA'),
    { codigoOm: '71200', sigla: 'CEIMSPA' }
  );
  assert.equal(
    extractProgramOrigin('Material referente ao N-4010 Warranty Spares'),
    'N-4010 WARRANTY SPARES'
  );
});

test('GOLDEN Recebimentos: item com dois SN e quantidade 3 vira 2 equipamentos + 1 sobressalente', () => {
  const rows = normalizeReceiptItems([{
    pn: 'pn-001',
    quantidade: 3,
    sn: 'SN001;SN002',
    valor_total_documento: 300,
    contabiliza_pelo_recibo: true,
    quantidade_inventariada: 0,
  }]);

  assert.equal(rows.length, 3);
  assert.deepEqual(rows.map((row) => row.tipo_item), [
    'EQUIPAMENTO',
    'EQUIPAMENTO',
    'SOBRESSALENTE',
  ]);
  assert.deepEqual(rows.map((row) => row.quantidade), [1, 1, 1]);
  assert.deepEqual(rows.map((row) => row.valor_unitario), [100, 100, 100]);
});

test('GOLDEN Recebimentos: quantidade menor que numero de SNs falha fechada', () => {
  assert.throws(
    () => normalizeReceiptItems([{
      pn: 'PN-001',
      quantidade: 1,
      sn: 'SN001;SN002',
    }]),
    (error) => error?.code === 'RECEIPT_SERIAL_QUANTITY_MISMATCH'
  );
});

test('GOLDEN Recebimentos: quantidade ja inventariada exige PPU ou CEIMSPA', () => {
  assert.throws(
    () => normalizeReceiptItems([{
      pn: 'PN-001',
      quantidade: 2,
      quantidade_inventariada: 1,
      contabiliza_pelo_recibo: true,
    }]),
    (error) => error?.code === 'RECEIPT_STOCK_DESTINATION_REQUIRED'
  );
});

test('GOLDEN Recebimentos: datas BR permanecem data civil sem deslocamento UTC', () => {
  assert.equal(parseDateToIso('13/08/2026'), '2026-08-13');
  assert.equal(parseDateToIso('2026-08-13'), '2026-08-13');
});
