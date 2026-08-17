const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const backend = path.resolve(__dirname, '../..');
const {
  parseLegacyDocTextReceipt,
  expandSerializedReceiptItems,
  extractSerials,
} = require('../../src/services/receiptDocumentParser');

function fixture(name) {
  return fs.readFileSync(path.join(backend, 'tests/fixtures', name), 'utf8');
}

test('A1.1A HF5: recibo 085/2025 expande 4 controllers serializados em quatro linhas QTD 1', () => {
  const result = parseLegacyDocTextReceipt({
    content: fixture('receipt-085-2025-legacy-hf5.txt'),
    fileName: 'RECIBO-085-2025-MAT-GARANTIA(5).doc',
    fileBuffer: Buffer.from('fixture-085-hf5'),
    requestedType: 'recibo_auto',
  });
  assert.equal(result.recibo_ref, '085/2025');
  assert.equal(result.data_entrega_ref, '2025-12-03');
  assert.equal(result.data_triagem.length, 6);

  const controllers = result.data_triagem.filter((item) => item.pn === 'WG1481-0863-002');
  assert.equal(controllers.length, 4);
  assert.deepEqual(controllers.map((item) => item.quantidade), [1, 1, 1, 1]);
  assert.deepEqual(controllers.map((item) => item.sn), ['0318', '0320', '0335', '0336']);
  assert.deepEqual(controllers.map((item) => item.delivery_note), ['7000379389', '7000379389', '7000379390', '7000379390']);
  assert.deepEqual(controllers.map((item) => item.valor_total_documento), [5244, 5244, 5244, 5244]);
});

test('A1.1A HF5: marcador asterisco do documento não faz parte da identidade do SN', () => {
  assert.deepEqual(
    extractSerials('CONTROLLER, ANTI-ICE - S/N *0318 e *0320'),
    ['0318', '0320'],
  );
});

test('A1.1A HF5: QTD 3 com 2 SN vira dois equipamentos e saldo 1 sem SN', () => {
  const warnings = [];
  const rows = expandSerializedReceiptItems([{
    pn: 'PN-TESTE', quantidade: 3, sn: 'SN-A, SN-B', sns_pre_carregados: ['SN-A', 'SN-B'],
    nomenclatura: 'ITEM TESTE', valor_unitario: 100, valor_total_documento: 300,
    dados_originais: { QTY: 3 },
  }], warnings);
  assert.equal(warnings.length, 0);
  assert.equal(rows.length, 3);
  assert.deepEqual(rows.map((row) => [row.quantidade, row.sn, row.tipo_item]), [
    [1, 'SN-A', 'EQUIPAMENTO'],
    [1, 'SN-B', 'EQUIPAMENTO'],
    [1, '', 'SOBRESSALENTE'],
  ]);
  assert.deepEqual(rows.map((row) => row.valor_total_documento), [100, 100, 100]);
});

test('A1.1A HF5: QTD 2 com 3 SN falha fechado para revisão sem descartar serial', () => {
  const warnings = [];
  const rows = expandSerializedReceiptItems([{
    pn: 'PN-TESTE', quantidade: 2, sn: 'A, B, C', sns_pre_carregados: ['A', 'B', 'C'], nomenclatura: 'ITEM',
  }], warnings);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].quantidade, 2);
  assert.equal(rows[0].sn, 'A, B, C');
  assert.match(warnings.join(' '), /quantidade 2 menor que 3 SNs encontrados/i);
});

test('A1.1A HF5: item sem SN preserva quantidade agregada e não cria linhas artificiais', () => {
  const warnings = [];
  const rows = expandSerializedReceiptItems([{
    pn: '528-027-01', quantidade: 2, sn: '', sns_pre_carregados: [], nomenclatura: 'CARGO HOOK', delivery_note: '7000379388',
  }], warnings);
  assert.equal(warnings.length, 0);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].quantidade, 2);
  assert.equal(rows[0].sn, '');
  assert.equal(rows[0].delivery_note, '7000379388');
});

test('A1.1A HF5: versão de análise força reprocessamento dos recibos ainda não salvos', () => {
  const triage = fs.readFileSync(path.join(backend, 'src/services/receiptBatchTriageService.js'), 'utf8');
  const worker = fs.readFileSync(path.join(backend, 'src/services/receiptImportJobService.js'), 'utf8');
  assert.match(triage, /ANALYSIS_VERSION = 'A1\.1A-HF\d+-V\d+'/);
  assert.match(worker, /String\(item\.analysis_version \|\| ''\) !== ANALYSIS_VERSION/);
  assert.doesNotMatch(worker, /\['READY', 'REVIEW', 'CONFLICT', 'ERROR', 'SAVED'/);
  assert.doesNotMatch(worker, /\['READY', 'REVIEW', 'CONFLICT', 'ERROR', 'IGNORED'/);
});
