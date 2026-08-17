const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const backend = path.resolve(__dirname, '../..');
const {
  parseLegacyDocTextReceipt,
  parseDescriptionMetadata,
} = require('../../src/services/receiptDocumentParser');

function fixture(name) {
  return fs.readFileSync(path.join(backend, 'tests/fixtures', name), 'utf8');
}

function receipt051() {
  return parseLegacyDocTextReceipt({
    content: fixture('receipt-051-2026-pd-hf9.txt'),
    fileName: 'RECIBO-051-2026-MAT-PD.DOC',
    fileBuffer: Buffer.from('fixture-051-hf9'),
    requestedType: 'recibo_auto',
  });
}

test('A1.1A HF9: recibo 051/2026 remove OC e Item da nomenclatura técnica', () => {
  const result = receipt051();
  assert.deepEqual(result.data_triagem.map((item) => item.nomenclatura), [
    'O-RING',
    'THERMOMETER',
    "RING 'O'",
    'ASSEMBLY TAIL DRIVE SHAFT NO.5 REV DIR',
  ]);
});

test('A1.1A HF9: OC PYYYY e Item são preservados como metadados auditáveis', () => {
  const result = receipt051();
  const first = result.data_triagem.find((item) => item.pn === '100-044-2129');
  assert.equal(first.documento_referencia, 'PD91100-2024-00730');
  assert.equal(first.dados_originais.ORDEM_COMPRA_EXTRAIDA_DESCRICAO, 'P2024-4150/19');
  assert.equal(first.dados_originais.ITEM_ORDEM_COMPRA_EXTRAIDO_DESCRICAO, '42');
  assert.match(first.dados_originais.DESCRIPTION, /O-RING - P2024-4150\/19 - Item: 42/);
});

test('A1.1A HF9: OC sem hífen separador também não contamina nomenclatura', () => {
  const meta = parseDescriptionMetadata("RING 'O' P2024-4104/2 - Item: 5");
  assert.equal(meta.nomenclatura, "RING 'O'");
  assert.equal(meta.ordemCompra, 'P2024-4104/2');
  assert.equal(meta.itemOrdemCompra, '5');
});

test('A1.1A HF9: SN antes da OC continua limpo e a OC fica separada', () => {
  const result = receipt051();
  const shaft = result.data_triagem.find((item) => item.pn === 'WG1568-0481-041');
  assert.equal(shaft.nomenclatura, 'ASSEMBLY TAIL DRIVE SHAFT NO.5 REV DIR');
  assert.equal(shaft.sn, 'BBA6248');
  assert.equal(shaft.dados_originais.ORDEM_COMPRA_EXTRAIDA_DESCRICAO, 'P2024-4150/19');
  assert.equal(shaft.dados_originais.ITEM_ORDEM_COMPRA_EXTRAIDO_DESCRICAO, '34');
});

test('A1.1A HF9: programa logístico explícito não integra a nomenclatura', () => {
  const meta = parseDescriptionMetadata('SEAL - Brazil Expiring BS 5 years Stock');
  assert.equal(meta.nomenclatura, 'SEAL');
  assert.equal(meta.programaLogistico, 'Brazil Expiring BS 5 years Stock');
});

test('A1.1A HF9: hífens técnicos continuam preservados quando não há marcador documental', () => {
  const meta = parseDescriptionMetadata('NUT, SELF-LOCKING, HEXAGON');
  assert.equal(meta.nomenclatura, 'NUT, SELF-LOCKING, HEXAGON');
  assert.equal(meta.ordemCompra, null);
  assert.equal(meta.itemOrdemCompra, null);
});

test('A1.1A HF9: versão invalida cache anterior e nunca reprocessa SAVED/IGNORED', () => {
  const triage = fs.readFileSync(path.join(backend, 'src/services/receiptBatchTriageService.js'), 'utf8');
  const worker = fs.readFileSync(path.join(backend, 'src/services/receiptImportJobService.js'), 'utf8');
  const version = triage.match(/ANALYSIS_VERSION = 'A1\.1A-HF(\d+)-V(\d+)'/);
  assert.ok(version);
  assert.ok(Number(version[1]) >= 9);
  assert.match(worker, /String\(item\.analysis_version \|\| ''\) !== ANALYSIS_VERSION/);
  assert.doesNotMatch(worker, /\.in\('status', \[[^\]]*'SAVED'/);
  assert.doesNotMatch(worker, /\.in\('status', \[[^\]]*'IGNORED'/);
});
