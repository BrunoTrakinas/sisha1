const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const backend = path.resolve(__dirname, '../..');
const {
  parseLegacyDocTextReceipt,
  extractSerials,
} = require('../../src/services/receiptDocumentParser');

function fixture(name) {
  return fs.readFileSync(path.join(backend, 'tests/fixtures', name), 'utf8');
}

test('A1.1A HF7: recibo 061/2025 extrai os cinco SNs exatos, inclusive seriais com espaço interno', () => {
  const result = parseLegacyDocTextReceipt({
    content: fixture('receipt-061-2025-legacy-hf7.txt'),
    fileName: 'RECIBO-061-2025-MAT-GARANTIA (003).DOC',
    fileBuffer: Buffer.from('fixture-061-hf7'),
    requestedType: 'recibo_auto',
  });
  assert.equal(result.recibo_ref, '061/2025');
  assert.equal(result.data_entrega_ref, '2025-09-02');
  assert.equal(result.data_triagem.length, 5);
  assert.deepEqual(result.data_triagem.map((item) => item.sn), [
    'TAC 7513', 'TAU 3133', '103', '1166', '1854',
  ]);
});

test('A1.1A HF7: Cust. Ref. delimita o SN sem apagar espaço interno', () => {
  assert.deepEqual(
    extractSerials('SHAFT TAIL DRIVE NOS.2 3 & 4 - S/N TAC 7513 - Cust. Ref: 4300/2014-004/00 - Warranty Spares'),
    ['TAC 7513'],
  );
  assert.deepEqual(
    extractSerials('SHAFT TAIL DRIVE NOS.2 3 & 4 - S/N TAU 3133 - Cust. Ref: 4300/2014-004/00 - Warranty Spares'),
    ['TAU 3133'],
  );
});

test('A1.1A HF7: F.O.C. é metadado documental e nunca integra a identidade SN', () => {
  assert.deepEqual(extractSerials('MANIFOLD, CONTROL VALVE - S/N 1166 - F.O.C.'), ['1166']);
  assert.deepEqual(extractSerials('SERVOJACK, MAIN ROTOR - SN 1854 - F.O.C.'), ['1854']);
});

test('A1.1A HF7: múltiplos SN continuam separados para a expansão unitária HF5', () => {
  assert.deepEqual(extractSerials('CONTROLLER, ANTI-ICE - S/N *0318 e *0320'), ['0318', '0320']);
});

test('A1.1A HF7: descrição original preserva F.O.C. enquanto o SN operacional permanece limpo', () => {
  const result = parseLegacyDocTextReceipt({
    content: fixture('receipt-061-2025-legacy-hf7.txt'),
    fileName: 'RECIBO-061-2025-MAT-GARANTIA (003).DOC',
    fileBuffer: Buffer.from('fixture-061-hf7-original'),
    requestedType: 'recibo_auto',
  });
  const manifold = result.data_triagem.find((item) => item.pn === '2339H000-003');
  assert.equal(manifold.sn, '1166');
  assert.match(manifold.dados_originais.DESCRIPTION, /F\.O\.C\./i);
});

test('A1.1A HF7+: versão de análise continua evoluindo sem tocar itens já salvos', () => {
  const triage = fs.readFileSync(path.join(backend, 'src/services/receiptBatchTriageService.js'), 'utf8');
  const worker = fs.readFileSync(path.join(backend, 'src/services/receiptImportJobService.js'), 'utf8');
  const version = triage.match(/ANALYSIS_VERSION = 'A1\.1A-HF(\d+)-V(\d+)'/);
  assert.ok(version);
  assert.ok(Number(version[1]) >= 7, `versão de análise não pode regredir abaixo de HF7: ${version?.[0]}`);
  assert.match(worker, /String\(item\.analysis_version \|\| ''\) !== ANALYSIS_VERSION/);
  assert.doesNotMatch(worker, /\.in\('status', \[[^\]]*'SAVED'/);
  assert.doesNotMatch(worker, /\.in\('status', \[[^\]]*'IGNORED'/);
});
