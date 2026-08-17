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

test('A1.1A HF8: recibo 061/2025 mantém apenas a nomenclatura técnica nos cinco itens', () => {
  const result = parseLegacyDocTextReceipt({
    content: fixture('receipt-061-2025-legacy-hf7.txt'),
    fileName: 'RECIBO-061-2025-MAT-GARANTIA (003).DOC',
    fileBuffer: Buffer.from('fixture-061-hf8'),
    requestedType: 'recibo_auto',
  });
  assert.deepEqual(result.data_triagem.map((item) => item.nomenclatura), [
    'SHAFT TAIL DRIVE NOS.2 3 & 4',
    'SHAFT TAIL DRIVE NOS.2 3 & 4',
    'SCANNER',
    'MANIFOLD, CONTROL VALVE',
    'SERVOJACK, MAIN ROTOR',
  ]);
});

test('A1.1A HF8: SN e Cust. Ref. são removidos da nomenclatura sem perder os campos próprios', () => {
  const meta = parseDescriptionMetadata('SHAFT TAIL DRIVE NOS.2 3 & 4 - S/N TAC 7513 - Cust. Ref: 4300/2014-004/00 - Warranty Spares');
  assert.equal(meta.nomenclatura, 'SHAFT TAIL DRIVE NOS.2 3 & 4');
  assert.equal(meta.referencia, '4300/2014-004/00');
  assert.equal(meta.warranty, true);
});

test('A1.1A HF8: F.O.C. não contamina nomenclatura e permanece metadado do item', () => {
  const result = parseLegacyDocTextReceipt({
    content: fixture('receipt-061-2025-legacy-hf7.txt'),
    fileName: 'RECIBO-061-2025-MAT-GARANTIA (003).DOC',
    fileBuffer: Buffer.from('fixture-061-hf8-foc'),
    requestedType: 'recibo_auto',
  });
  const manifold = result.data_triagem.find((item) => item.pn === '2339H000-003');
  assert.equal(manifold.nomenclatura, 'MANIFOLD, CONTROL VALVE');
  assert.equal(manifold.sn, '1166');
  assert.equal(manifold.is_foc_item, true);
  assert.equal(manifold.dados_originais.FOC_EXTRAIDO_DESCRICAO, true);
});

test('A1.1A HF8: referência textual vira referência do item quando não existe PD sem apagar descrição original', () => {
  const result = parseLegacyDocTextReceipt({
    content: fixture('receipt-061-2025-legacy-hf7.txt'),
    fileName: 'RECIBO-061-2025-MAT-GARANTIA (003).DOC',
    fileBuffer: Buffer.from('fixture-061-hf8-ref'),
    requestedType: 'recibo_auto',
  });
  const scanner = result.data_triagem.find((item) => item.pn === '3990-75140');
  assert.equal(scanner.documento_referencia, 'ER-21B-154');
  assert.equal(scanner.nomenclatura, 'SCANNER');
  assert.match(scanner.dados_originais.DESCRIPTION, /Cust\. Ref: ER-21B-154/i);
});

test('A1.1A HF8: hífen técnico sem marcador conhecido não é removido da nomenclatura', () => {
  const meta = parseDescriptionMetadata('VALVE - PRESSURE-REGULATING ASSEMBLY');
  assert.equal(meta.nomenclatura, 'VALVE - PRESSURE-REGULATING ASSEMBLY');
  assert.equal(meta.referencia, null);
});

test('A1.1A HF8: versão de análise força reprocessamento somente do que ainda não foi salvo', () => {
  const triage = fs.readFileSync(path.join(backend, 'src/services/receiptBatchTriageService.js'), 'utf8');
  const worker = fs.readFileSync(path.join(backend, 'src/services/receiptImportJobService.js'), 'utf8');
  const version = triage.match(/ANALYSIS_VERSION = 'A1\.1A-HF(\d+)-V(\d+)'/);
  assert.ok(version);
  assert.ok(Number(version[1]) >= 8, `versão de análise não pode regredir abaixo de HF8: ${version?.[0]}`);
  assert.match(worker, /String\(item\.analysis_version \|\| ''\) !== ANALYSIS_VERSION/);
  assert.doesNotMatch(worker, /\.in\('status', \[[^\]]*'SAVED'/);
  assert.doesNotMatch(worker, /\.in\('status', \[[^\]]*'IGNORED'/);
});
