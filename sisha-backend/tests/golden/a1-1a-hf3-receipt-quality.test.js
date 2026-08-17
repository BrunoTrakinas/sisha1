const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const backend = path.resolve(__dirname, '../..');
const triagePath = path.join(backend, 'src/services/receiptBatchTriageService.js');
const parserPath = path.join(backend, 'src/services/receiptDocumentParser.js');
const officePath = path.join(backend, 'src/utils/officeDocumentText.js');
const jobsPath = path.join(backend, 'src/services/receiptImportJobService.js');
function read(file) { return fs.readFileSync(file, 'utf8'); }

test('A1.1A HF3+: versão de análise evolui e invalida cache antigo sem apagar dados operacionais', () => {
  const triage = read(triagePath);
  assert.match(triage, /ANALYSIS_VERSION = 'A1\.1A-HF\d+-V\d+'/);
  assert.match(triage, /eq\('analysis_version', ANALYSIS_VERSION\)/);
  assert.match(triage, /onConflict: 'file_sha256'/);
});

test('A1.1A HF3: DOCX Bonded Store preenche número, data, PN, nomenclatura, SN e referências', () => {
  const { parseReceiptDocument } = require(path.join(backend, 'src/services/receiptDocumentParser.js'));
  const fixture = path.join(backend, 'tests/fixtures/receipt-bonded-store-hf3.docx');
  const file = { originalname: 'RECEIPT OF MATERIAL - 140-2026.docx', buffer: fs.readFileSync(fixture) };
  const parsed = parseReceiptDocument({ file, requestedType: 'recibo_auto' });
  assert.equal(parsed.recibo_ref, '140/2026');
  assert.equal(parsed.data_entrega_ref, '2026-07-23');
  assert.equal(parsed.data_triagem.length, 1);
  const item = parsed.data_triagem[0];
  assert.equal(item.pn, 'WG1568-0481-041');
  assert.equal(item.nomenclatura, 'ASSEMBLY TAIL DRIVE SHAFT NO.5');
  assert.equal(item.sn, 'BBA6248');
  assert.equal(item.delivery_note, '82933105');
  assert.equal(item.invoice_no, '201144262');
  assert.equal(item.di, '26BR0001070605-5');
});

test('A1.1A HF3: texto DOCX concatena runs do Word sem quebrar palavras', () => {
  const office = read(officePath);
  assert.match(office, /function docxTableCellText/);
  assert.match(office, /parts\.join\(''\)/);
  assert.doesNotMatch(office, /cells\.push\(xmlToReadableText\(cellXml/);
});

test('A1.1A HF3: gate de qualidade impede READY com número, data ou nomenclatura ausentes', () => {
  const triage = read(triagePath);
  assert.match(triage, /function receiptQualityWarnings/);
  assert.match(triage, /Número do recibo não foi extraído/);
  assert.match(triage, /Data do recebimento não foi extraída/);
  assert.match(triage, /sem nomenclatura; revisão obrigatória/);
  assert.match(triage, /form\.avisos_triagem = warnings/);
});

test('A1.1A HF3: referências logísticas inequívocas não podem virar PN via IA', () => {
  const triage = read(triagePath);
  assert.match(triage, /function isObviousNonPnReference/);
  assert.match(triage, /\\d\{2\}BR\\d\{8,/);
  assert.match(triage, /MAWB\/HAWB\/DI/);
  assert.match(triage, /form = sanitizeAiForm\(form\)/);
});

test('A1.1A HF3+: job elegível reprocessa análise antiga sem tocar SAVED ou IGNORED', () => {
  const jobs = read(jobsPath);
  assert.match(jobs, /function requeueStaleActiveAnalyses|async function requeueStaleActiveAnalyses/);
  assert.match(jobs, /in\('status', \['QUEUED', 'PROCESSING', 'REVIEW_READY'\]\)/);
  assert.match(jobs, /in\('status', \['READY', 'REVIEW', 'CONFLICT', 'ERROR'\]\)/);
  assert.doesNotMatch(jobs, /\['READY', 'REVIEW', 'CONFLICT', 'ERROR', 'SAVED'/);
  assert.doesNotMatch(jobs, /\['READY', 'REVIEW', 'CONFLICT', 'ERROR', 'IGNORED'/);
  assert.match(jobs, /String\(item\.analysis_version \|\| ''\) !== ANALYSIS_VERSION/);
});
