const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  cleanNomenclature,
  extractSerialsFromText,
  sanitizeReceiptItemMetadata,
  sanitizeReceiptFormMetadata,
} = require('../../src/services/receiptMetadataSanitizerService');

const backend = path.resolve(__dirname, '../..');

test('A1.1A HF11: nomenclatura final remove S/N 928 mesmo se parser anterior deixar escapar', () => {
  const item = sanitizeReceiptItemMetadata({
    pn: 'WG1480-8091-041',
    nomenclatura: 'UNIT NVG CPI MOD - S/N 928 - 43000/2014-004/00',
    sn: '928',
  });
  assert.equal(item.nomenclatura, 'UNIT NVG CPI MOD');
  assert.equal(item.sn, '928');
  assert.equal(item.documento_referencia, '43000/2014-004/00');
});

test('A1.1A HF11: segundo item do recibo 050 também separa S/N 955 da nomenclatura', () => {
  const item = sanitizeReceiptItemMetadata({
    pn: 'WG1480-8092-041',
    nomenclatura: 'CONTROLR COMPASS NVG MOD - S/N 955 - 43000/2014-004/00',
    sn: '955',
  });
  assert.equal(item.nomenclatura, 'CONTROLR COMPASS NVG MOD');
  assert.equal(item.sn, '955');
});

test('A1.1A HF11: SN ausente no campo próprio é recuperado da nomenclatura antes da limpeza', () => {
  const item = sanitizeReceiptItemMetadata({
    pn: 'WG1480-8091-041',
    nomenclatura: 'UNIT NVG CPI MOD - S/N 928 - 43000/2014-004/00',
    sn: '',
  });
  assert.equal(item.nomenclatura, 'UNIT NVG CPI MOD');
  assert.equal(item.sn, '928');
  assert.equal(item.sn_extraido_documento, true);
});

test('A1.1A HF11: sanitização final preserva nomenclatura técnica sem marcador documental', () => {
  assert.equal(cleanNomenclature('NUT, SELF-LOCKING, HEXAGON'), 'NUT, SELF-LOCKING, HEXAGON');
  assert.equal(cleanNomenclature('SENSOR UNIT, PRESSURE-REGULATING'), 'SENSOR UNIT, PRESSURE-REGULATING');
});

test('A1.1A HF11: extrator final preserva serial com espaço interno e corta contrato', () => {
  assert.deepEqual(extractSerialsFromText('SHAFT TAIL DRIVE - S/N TAC 7513 - 43000/2014-004/00'), ['TAC 7513']);
});

test('A1.1A HF11: firewall final aplica-se ao formulário inteiro', () => {
  const form = sanitizeReceiptFormMetadata({
    itens: [
      { pn: 'WG1480-8091-041', nomenclatura: 'UNIT NVG CPI MOD - S/N 928 - 43000/2014-004/00', sn: '928', quantidade: 1 },
      { pn: 'WG1480-8092-041', nomenclatura: 'CONTROLR COMPASS NVG MOD - S/N 955 - 43000/2014-004/00', sn: '955', quantidade: 1 },
    ],
  });
  assert.deepEqual(form.itens.map((item) => item.nomenclatura), ['UNIT NVG CPI MOD', 'CONTROLR COMPASS NVG MOD']);
  assert.deepEqual(form.itens.map((item) => item.sn), ['928', '955']);
});

test('A1.1A HF11: triagem usa firewall final antes de qualidade/cache e também em cache reutilizado', () => {
  const triage = fs.readFileSync(path.join(backend, 'src/services/receiptBatchTriageService.js'), 'utf8');
  assert.match(triage, /ANALYSIS_VERSION = 'A1\.1A-HF\d+-V\d+'/);
  assert.match(triage, /sanitizeReceiptFormMetadata\(cached\.triage_payload\)/);
  assert.match(triage, /form = sanitizeReceiptFormMetadata\(form\);/);
  const finalSanitize = triage.indexOf('form = sanitizeReceiptFormMetadata(form);');
  const quality = triage.indexOf('...receiptQualityWarnings(form, sourceMethod)');
  assert.ok(finalSanitize >= 0 && quality > finalSanitize);
});
