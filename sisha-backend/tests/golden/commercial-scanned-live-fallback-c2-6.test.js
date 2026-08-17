const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  normalizeFocusedRepairOverhaulTranscript,
} = require('../../src/services/commercialVisualTableService');
const {
  parseLeonardoRepairPriceLetter,
} = require('../../src/services/commercialDocumentDeterministicService');

const ROOT = path.resolve(__dirname, '../..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

function focusedTranscript(overrides = '') {
  return [
    'DOCUMENT_TYPE: LEONARDO_REPAIR_PRICE_LETTER',
    'TABLE_COMPLETE: YES',
    'LETTER_REFERENCE: LUKL/BN/UPGRADE/24052024',
    'LETTER_DATE: 24th May 2024',
    'CONTRACT_REFERENCE: 71000/2020-022/00',
    'SUBJECT: Future Support and Fixed Price Repairs – Lynx M21B',
    'VALIDITY: 31st March 2025',
    'TABLE_START',
    'Description | Part Number | RepairGBP | OverhaulGBP | SourcePage',
    'Fuel Booster Pump | 2030H08 | 37207.00 | 41065.00 | 3',
    'Multi-Function Valve | LH11264-02 | 44034.00 | NULL | 3',
    'Bolted Main Rotor Head Assembly | WG1369-2300* | 417650.00 | 655099.00 | 3',
    'Oil Cooler Fan | WG1468-0210-043 | NULL | 65808.00 | 3',
    'Gearbox Change Unit | WG1468-0002-*** | 562598.00 | 1037984.00 | 3',
    overrides,
    'TABLE_END',
    'UNREADABLE_ROWS: NONE',
  ].filter(Boolean).join('\n');
}

test('C2.6: fallback textual focado reconhece carta Repair/Overhaul real-like', () => {
  const normalized = normalizeFocusedRepairOverhaulTranscript(focusedTranscript(), 'LUKLBNUPGRADE24052024.pdf');
  assert.equal(normalized.recognized, true);
  assert.equal(normalized.valid, true);
  assert.equal(normalized.rows.length, 5);
  assert.match(normalized.transcript, /Contract No\. 71000\/2020-022\/00/);
});

test('C2.6: fallback focado preserva Repair e Overhaul em registros independentes', () => {
  const normalized = normalizeFocusedRepairOverhaulTranscript(focusedTranscript());
  const parsed = parseLeonardoRepairPriceLetter(normalized.transcript);
  const fuel = parsed.items.filter((item) => item.pn === '2030H08');
  assert.deepEqual(fuel.map((item) => [item.tipo_cotacao, item.valor_unitario]), [
    ['REPARO', 37207],
    ['OVERHAUL', 41065],
  ]);
});

test('C2.6: fallback focado mantém wildcard como PATTERN e milhão sem perda de fator', () => {
  const normalized = normalizeFocusedRepairOverhaulTranscript(focusedTranscript());
  const parsed = parseLeonardoRepairPriceLetter(normalized.transcript);
  const gearbox = parsed.items.find((item) => item.pn === 'WG1468-0002-***' && item.tipo_cotacao === 'OVERHAUL');
  assert.ok(gearbox);
  assert.equal(gearbox.match_mode, 'PATTERN');
  assert.equal(gearbox.valor_unitario, 1037984);
});

test('C2.6: TABLE_COMPLETE ausente ou NO bloqueia gravação', () => {
  const missing = focusedTranscript().replace('TABLE_COMPLETE: YES\n', '');
  const no = focusedTranscript().replace('TABLE_COMPLETE: YES', 'TABLE_COMPLETE: NO');
  assert.equal(normalizeFocusedRepairOverhaulTranscript(missing).valid, false);
  assert.equal(normalizeFocusedRepairOverhaulTranscript(no).valid, false);
});

test('C2.6: linha de página de Terms and Conditions não entra na tabela comercial', () => {
  const text = focusedTranscript('Warranty clause | 10.1 | 300.00 | NULL | 9');
  const normalized = normalizeFocusedRepairOverhaulTranscript(text);
  assert.equal(normalized.rows.some((row) => row.pn === '10.1'), false);
  assert.match(normalized.warnings.join(' '), /Termos e Condições|página 9/i);
});

test('C2.6: runtime tenta JSON estruturado, depois transcrição focada, só então genérico', () => {
  const source = read('src/services/rfqParserService.js');
  const structured = source.indexOf('extractCommercialTableFromPdfWithAi');
  const focused = source.indexOf('extractRepairOverhaulTranscriptFromPdfWithAi', structured);
  const generic = source.indexOf('extractTextFromPdfWithAi({', focused);
  assert.ok(structured >= 0);
  assert.ok(focused > structured);
  assert.ok(generic > focused);
});

test('C2.6: carta Repair reconhecida no fallback genérico nunca volta ao merge comercial genérico', () => {
  const source = read('src/services/rfqParserService.js');
  assert.match(source, /genericType === 'LEONARDO_REPAIR_PRICE_LETTER'/);
  assert.match(source, /CHAT_LINCE_PDF_REPAIR_RECONHECIDO_BLOQUEADO/);
  assert.match(source, /Carta Leonardo Fixed Price Repair\/Overhaul reconhecida/);
});

test('C2.6: PDF LUKL escaneado sem estrutura falha fechado em vez de 0 itens genérico', () => {
  const source = read('src/services/rfqParserService.js');
  assert.match(source, /PDF_ESCANEADO_LEONARDO_BLOQUEADO/);
  assert.match(source, /LUKL\|LHUK\|LEONARDO/);
});

test('C2.6: contrato IA genérico deixa de inventar condição New', () => {
  const source = read('src/services/chatLinceService.js');
  assert.match(source, /"condicao": null/);
  assert.doesNotMatch(source, /"condicao": "New"/);
});

test('C2.6: versão nova invalida job ruim do C2.5 no backend e frontend', () => {
  const jobs = read('src/services/rfqImportJobService.js');
  const front = fs.readFileSync(path.resolve(ROOT, '../sisha-frontend/src/components/RfqImporter.jsx'), 'utf8');
  assert.match(jobs, /ANALYSIS_VERSION = 'C2\./);
  assert.match(front, /CURRENT_ANALYSIS_VERSION = 'C2\./);
  assert.doesNotMatch(jobs, /C2\.5-SCANNED-VISUAL-TABLE-1/);
  assert.doesNotMatch(front, /C2\.5-SCANNED-VISUAL-TABLE-1/);
});
