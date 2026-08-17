const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const backend = path.resolve(__dirname, '../..');
const parserPath = path.join(backend, 'src/services/receiptDocumentParser.js');
const officePath = path.join(backend, 'src/utils/officeDocumentText.js');
const triagePath = path.join(backend, 'src/services/receiptBatchTriageService.js');
const chatPath = path.join(backend, 'src/services/chatLinceService.js');
function read(file) { return fs.readFileSync(file, 'utf8'); }

test('A1.1A HF2-HF2: DOCX Receipt of Material tenta parser determinístico antes da IA', () => {
  const triage = read(triagePath);
  const parser = read(parserPath);
  assert.match(triage, /STRUCTURAL_EXTENSIONS = new Set\(\[[^\]]*'\.docx'/s);
  assert.match(parser, /parseBondedStoreDocxReceipt/);
  assert.match(parser, /name\.endsWith\('\.docx'\).*parseBondedStoreDocxReceipt/s);
});

test('A1.1A HF2-HF2: DOCX extrai linhas de tabela sem nova dependência', () => {
  const office = read(officePath);
  assert.match(office, /function extractDocxTableRows/);
  assert.match(office, /tableRows: extractDocxTableRows/);
  assert.doesNotMatch(office, /mammoth|docx-parser|officeparser/i);
});

test('A1.1A HF2-HF2: fallback IA de recibo possui timeout limitado', () => {
  const triage = read(triagePath);
  const chat = read(chatPath);
  assert.match(triage, /RECEIPT_IMPORT_AI_TIMEOUT_MS \|\| 45000/);
  assert.match(triage, /timeoutMs: RECEIPT_AI_TIMEOUT_MS/);
  assert.match(chat, /new AbortController\(\)/);
  assert.match(chat, /signal: controller\.signal/);
  assert.match(chat, /OpenRouter excedeu o tempo limite/);
});

test('A1.1A HF2-HF2: timeout é opt-in e não reduz silenciosamente outras chamadas do Chat Lince', () => {
  const chat = read(chatPath);
  assert.match(chat, /plugins = null, timeoutMs = null/);
  assert.match(chat, /analyzeDocumentWithAi\(\{ tipoDocumento, text, fileName, timeoutMs = null \}\)/);
});
