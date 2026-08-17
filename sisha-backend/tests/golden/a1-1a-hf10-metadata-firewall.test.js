const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const backend = path.resolve(__dirname, '../..');
const {
  parseLegacyDocTextReceipt,
  parseDescriptionMetadata,
  extractSerials,
} = require('../../src/services/receiptDocumentParser');

function fixture(name) {
  return fs.readFileSync(path.join(backend, 'tests/fixtures', name), 'utf8');
}

function receipt050() {
  return parseLegacyDocTextReceipt({
    content: fixture('receipt-050-2026-contract-hf10.txt'),
    fileName: 'RECIBO-050-2026-MAT-GARANTIA.doc',
    fileBuffer: Buffer.from('fixture-050-hf10'),
    requestedType: 'recibo_auto',
  });
}

test('A1.1A HF10: contrato após SN nunca integra a identidade do serial', () => {
  assert.deepEqual(extractSerials('UNIT NVG CPI MOD - S/N 928 - 43000/2014-004/00'), ['928']);
  assert.deepEqual(extractSerials('CRADLE REAR ASSY - S/N. 400552056 - 43000/2014-004/00'), ['400552056']);
});

test('A1.1A HF10: contrato sem SN é removido da nomenclatura e preservado como metadado', () => {
  const meta = parseDescriptionMetadata('PANEL CFC LTG DIMMERS - 43000/2014-004/00');
  assert.equal(meta.nomenclatura, 'PANEL CFC LTG DIMMERS');
  assert.equal(meta.contratoLinha, '43000/2014-004/00');
});

test('A1.1A HF10: recibo 050/2026 limpa contrato de nomenclatura e SN em todas as linhas auditadas', () => {
  const result = receipt050();
  assert.equal(result.data_triagem.length, 8);
  const byPn = new Map(result.data_triagem.map((item) => [item.pn, item]));
  assert.equal(byPn.get('WG1480-8091-041').nomenclatura, 'UNIT NVG CPI MOD');
  assert.equal(byPn.get('WG1480-8091-041').sn, '928');
  assert.equal(byPn.get('WG1480-8092-041').sn, '955');
  assert.equal(byPn.get('WG1457-8013-04101').sn, '400552056');
  assert.equal(byPn.get('3990-75170').sn, '103');
  assert.equal(byPn.get('WG1481-8248-045').nomenclatura, 'PANEL CFC LTG DIMMERS');
  assert.equal(byPn.get('WG1481-8248-045').documento_referencia, '43000/2014-004/00');
  assert.equal(byPn.get('B693-31').sn, '0039');
  for (const item of result.data_triagem) {
    assert.doesNotMatch(item.nomenclatura, /\b\d{4,6}\/\d{4}-\d{3}\/\d{2}\b/);
    assert.doesNotMatch(item.sn || '', /\b\d{4,6}\/\d{4}-\d{3}\/\d{2}\b/);
  }
});

test('A1.1A HF10: programa Radalt e Item não contaminam nomenclatura', () => {
  const meta = parseDescriptionMetadata('RELAY, TIME DELAY - Brazil - Radalt TI parts - Item: 3 - This item is free of charge');
  assert.equal(meta.nomenclatura, 'RELAY, TIME DELAY');
  assert.match(meta.programaLogistico || '', /RADALT TI parts/i);
  assert.equal(meta.itemOrdemCompra, '3');
});

test('A1.1A HF10: quality gate global bloqueia resíduo documental antes de READY', () => {
  const triage = fs.readFileSync(path.join(backend, 'src/services/receiptBatchTriageService.js'), 'utf8');
  assert.match(triage, /CONTRACT_REFERENCE_RESIDUE_RE/);
  assert.match(triage, /NOMENCLATURE_METADATA_RESIDUE_RE/);
  assert.match(triage, /número de contrato permaneceu dentro da nomenclatura/);
  assert.match(triage, /número de contrato permaneceu dentro do SN/);
  assert.match(triage, /warnings\.push\(\.\.\.metadataResidueWarnings\(item, index\)\)/);
});

test('A1.1A HF10: metadata firewall é regra geral e não contém número de recibo hardcoded no parser', () => {
  const parser = fs.readFileSync(path.join(backend, 'src/services/receiptDocumentParser.js'), 'utf8');
  assert.match(parser, /INLINE_CONTRACT_PATTERN_SOURCE/);
  assert.match(parser, /CONTRATO_LINHA_EXTRAIDO_DESCRICAO/);
  assert.doesNotMatch(parser, /050\/2026/);
});

test('A1.1A HF10: versão nova invalida cache antigo sem tocar SAVED\/IGNORED', () => {
  const triage = fs.readFileSync(path.join(backend, 'src/services/receiptBatchTriageService.js'), 'utf8');
  const worker = fs.readFileSync(path.join(backend, 'src/services/receiptImportJobService.js'), 'utf8');
  assert.match(triage, /ANALYSIS_VERSION = 'A1\.1A-HF\d+-V\d+'/);
  assert.match(worker, /String\(item\.analysis_version \|\| ''\) !== ANALYSIS_VERSION/);
  assert.doesNotMatch(worker, /\.in\('status', \[[^\]]*'SAVED'/);
  assert.doesNotMatch(worker, /\.in\('status', \[[^\]]*'IGNORED'/);
});
