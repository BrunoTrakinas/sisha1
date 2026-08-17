const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  analyzeReceiptDescription,
  cleanTechnicalNomenclature,
  extractSerialsFromDescription,
  metadataResidueKinds,
} = require('../../src/services/receiptDescriptionSemanticNormalizerService');
const { sanitizeReceiptItemMetadata } = require('../../src/services/receiptMetadataSanitizerService');

const backend = path.resolve(__dirname, '../..');

test('A1.1A HF12: programa Brazil7&8planningremoval compactado não integra nomenclatura', () => {
  const meta = analyzeReceiptDescription('ANTENNA, GA-35GPS/WAAS - Brazil7&8planningremoval(1) - Item 63 - This item is FOC');
  assert.equal(meta.nomenclatura, 'ANTENNA, GA-35GPS/WAAS');
  assert.equal(meta.item, '63');
  assert.match(meta.program || '', /planning removal/i);
  assert.equal(meta.isFoc, true);
});

test('A1.1A HF12: Item sem dois-pontos é metadado e nunca permanece na nomenclatura', () => {
  const meta = analyzeReceiptDescription('LONGHALFQUICKRELEASEBONDSTRAP - Brazil7&8planningremoval(5) - Item:485 - FOC');
  assert.equal(meta.nomenclatura, 'LONGHALFQUICKRELEASEBONDSTRAP');
  assert.equal(meta.item, '485');
});

test('A1.1A HF12: contexto N-4010 Warranty Spares sai da nomenclatura e é preservado', () => {
  const meta = analyzeReceiptDescription('NUT,SELF-LOCKING,HEXAGON - N-4010 Warranty Spares - Item: 9 - This item is FOC');
  assert.equal(meta.nomenclatura, 'NUT,SELF-LOCKING,HEXAGON');
  assert.equal(meta.aircraftContext, 'N-4010');
  assert.equal(meta.warranty, true);
});

test('A1.1A HF12: código auxiliar após SN não integra identidade PN+SN', () => {
  const meta = analyzeReceiptDescription('UNIT GEN ISIS - S/N 400577584 – (A031810) - Ref: 43000/2014-004/04');
  assert.equal(meta.nomenclatura, 'UNIT GEN ISIS');
  assert.deepEqual(meta.serials, ['400577584']);
  assert.equal(meta.auxCode, 'A031810');
  assert.equal(meta.reference, '43000/2014-004/04');
});

test('A1.1A HF12: primeiro item do 042 preserva SN com espaço e limpa artefatos documentais', () => {
  const meta = analyzeReceiptDescription('SUB ASSY FORKED LINK – S/N ABA 5123 - Ref: 92C: L01387 a/c N4005');
  assert.equal(meta.nomenclatura, 'SUB ASSY FORKED LINK');
  assert.deepEqual(meta.serials, ['ABA 5123']);
});

test('A1.1A HF12: firewall final recupera metadados sem contaminar nomenclatura/SN', () => {
  const item = sanitizeReceiptItemMetadata({
    pn: '12540MFSD1-1',
    nomenclatura: 'UNIT GEN ISIS - S/N 400577584 – (A031810) - Ref: 43000/2014-004/04',
    sn: '400577584 – (A031810)',
    dados_originais: {},
  });
  assert.equal(item.nomenclatura, 'UNIT GEN ISIS');
  assert.equal(item.sn, '400577584');
  assert.equal(item.dados_originais.CODIGO_AUXILIAR_EXTRAIDO_FIREWALL_V2, 'A031810');
});

test('A1.1A HF12: lint semântico reconhece resíduos mesmo com variação de espaços e pontuação', () => {
  assert.ok(metadataResidueKinds('ANTENNA - Brazil7&8planningremoval(1) - Item 63').length >= 2);
  assert.ok(metadataResidueKinds('400577584 - (A031810)', { serial: true }).includes('CODIGO_AUXILIAR'));
  assert.equal(metadataResidueKinds('NUT,SELF-LOCKING,HEXAGON').length, 0);
});

test('A1.1A HF12: fixture real 042 contém as quatro classes que motivaram o normalizador v2', () => {
  const fixture = fs.readFileSync(path.join(backend, 'tests/fixtures/receipt-042-2026-semantic-v2-hf12.txt'), 'utf8');
  assert.match(fixture, /Brazil7&8planningremoval\(9\)/i);
  assert.match(fixture, /Item 63/i);
  assert.match(fixture, /N-4010 Warranty Spares/i);
  assert.match(fixture, /400577584\s*-\s*\(A031810\)/i);
});

test('A1.1A HF12: regras são gerais e não hardcodam número do recibo no código de produção', () => {
  const semantic = fs.readFileSync(path.join(backend, 'src/services/receiptDescriptionSemanticNormalizerService.js'), 'utf8');
  const sanitizer = fs.readFileSync(path.join(backend, 'src/services/receiptMetadataSanitizerService.js'), 'utf8');
  assert.doesNotMatch(semantic, /042\/2026/);
  assert.doesNotMatch(sanitizer, /042\/2026/);
  assert.match(semantic, /COMPACT_PLANNING_RE/);
  assert.match(semantic, /AIRCRAFT_WARRANTY_RE/);
  assert.match(semantic, /AUX_CODE_RE/);
});

test('A1.1A HF12: triagem usa versão nova e lint v2 antes de READY', () => {
  const triage = fs.readFileSync(path.join(backend, 'src/services/receiptBatchTriageService.js'), 'utf8');
  assert.match(triage, /ANALYSIS_VERSION = 'A1\.1A-HF12-V1'/);
  assert.match(triage, /metadataResidueKinds/);
  assert.match(triage, /sanitizeReceiptFormMetadata\(form\)/);
});
