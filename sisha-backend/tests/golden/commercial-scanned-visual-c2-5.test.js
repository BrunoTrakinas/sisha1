const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  normalizeVisualRepairOverhaulPayload,
} = require('../../src/services/commercialVisualTableService');
const {
  parseLeonardoRepairPriceLetter,
} = require('../../src/services/commercialDocumentDeterministicService');

const ROOT = path.resolve(__dirname, '../..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

function realLikePayload() {
  return {
    documento_tipo: 'LEONARDO_REPAIR_PRICE_LETTER',
    document: {
      contract_reference: '71000/2020-022/00',
      subject: 'Future Support and Fixed Price Repairs – Lynx M21B',
      validity: '31st March 2025',
    },
    table: {
      page: 3,
      complete: true,
      rows: [
        { description: 'Main Servo Jack', pn: '30495-211', repair_gbp: '73978.00', overhaul_gbp: '147242.00', source_page: 3 },
        { description: 'Fuel Booster Pump', pn: '2030H08', repair_gbp: '37207.00', overhaul_gbp: '41065.00', source_page: 3 },
        { description: 'Multi-Function Valve (MFV)', pn: 'LH11264-02', repair_gbp: '44034.00', overhaul_gbp: null, source_page: 3 },
        { description: 'Bolted Main Rotor Head Assembly', pn: 'WG1369-2300*', repair_gbp: '417650.00', overhaul_gbp: '655099.00', source_page: 3 },
        { description: 'Oil Cooler Fan', pn: 'WG1468-0210-043', repair_gbp: null, overhaul_gbp: '65808.00', source_page: 3 },
        { description: 'Gearbox Change Unit', pn: 'WG1468-0002-***', repair_gbp: '562598.00', overhaul_gbp: '1037984.00', source_page: 3 },
      ],
    },
    table_complete: true,
    unreadable_rows: [],
  };
}

test('C2.5: payload visual reconhecido vira transcrição determinística com contrato e validade', () => {
  const normalized = normalizeVisualRepairOverhaulPayload(realLikePayload(), 'LUKLBNUPGRADE24052024.pdf');
  assert.equal(normalized.recognized, true);
  assert.equal(normalized.valid, true);
  assert.equal(normalized.rows.length, 6);
  assert.match(normalized.transcript, /Contract No\. 71000\/2020-022\/00/);
  assert.match(normalized.transcript, /validity, 31st March 2025/i);
});

test('C2.5: Fuel Booster Pump gera Repair e Overhaul independentes sem cruzar preço', () => {
  const normalized = normalizeVisualRepairOverhaulPayload(realLikePayload());
  const parsed = parseLeonardoRepairPriceLetter(normalized.transcript, 'LUKLBNUPGRADE24052024.pdf');
  const fuel = parsed.items.filter((item) => item.pn === '2030H08');
  assert.equal(fuel.length, 2);
  assert.deepEqual(fuel.map((item) => [item.tipo_cotacao, item.valor_unitario]), [
    ['REPARO', 37207],
    ['OVERHAUL', 41065],
  ]);
});

test('C2.5: célula Repair vazia não fabrica preço e preserva somente Overhaul', () => {
  const normalized = normalizeVisualRepairOverhaulPayload(realLikePayload());
  const parsed = parseLeonardoRepairPriceLetter(normalized.transcript);
  const oil = parsed.items.filter((item) => item.pn === 'WG1468-0210-043');
  assert.equal(oil.length, 1);
  assert.equal(oil[0].tipo_cotacao, 'OVERHAUL');
  assert.equal(oil[0].valor_unitario, 65808);
});

test('C2.5: PN com wildcard permanece PATTERN', () => {
  const normalized = normalizeVisualRepairOverhaulPayload(realLikePayload());
  const parsed = parseLeonardoRepairPriceLetter(normalized.transcript);
  const gearbox = parsed.items.find((item) => item.pn === 'WG1468-0002-***');
  assert.ok(gearbox);
  assert.equal(gearbox.match_mode, 'PATTERN');
  assert.equal(gearbox.valor_unitario, 562598);
});

test('C2.5: números de Terms and Conditions não entram como linhas comerciais', () => {
  const payload = realLikePayload();
  payload.table.rows.push({ description: 'Warranty and Liability for Defects', pn: '10.1', repair_gbp: '300.00', overhaul_gbp: null, source_page: 9 });
  const normalized = normalizeVisualRepairOverhaulPayload(payload);
  assert.equal(normalized.rows.some((row) => row.pn === '10.1'), false);
  assert.match(normalized.warnings.join(' '), /Termos e Condições/i);
});

test('C2.5: linha sem Repair e Overhaul é descartada sem inventar valor', () => {
  const payload = realLikePayload();
  payload.table.rows.push({ description: 'Sem preço', pn: 'ABC-123', repair_gbp: null, overhaul_gbp: null, source_page: 3 });
  const normalized = normalizeVisualRepairOverhaulPayload(payload);
  assert.equal(normalized.rows.some((row) => row.pn === 'ABC-123'), false);
  assert.match(normalized.warnings.join(' '), /sem preço/i);
});

test('C2.5: PN repetido com preços divergentes bloqueia a carta', () => {
  const payload = realLikePayload();
  payload.table.rows.push({ description: 'Fuel Booster Pump', pn: '2030H08', repair_gbp: '999.00', overhaul_gbp: '41065.00', source_page: 3 });
  const normalized = normalizeVisualRepairOverhaulPayload(payload);
  assert.equal(normalized.valid, false);
  assert.match(normalized.blocking.join(' '), /divergente/i);
});

test('C2.5: table_complete=false ou linha ilegível falha fechado', () => {
  const payload = realLikePayload();
  payload.table_complete = false;
  payload.unreadable_rows = ['linha 17'];
  const normalized = normalizeVisualRepairOverhaulPayload(payload);
  assert.equal(normalized.valid, false);
  assert.match(normalized.blocking.join(' '), /não foi extraída por completo|ilegíveis/i);
});

test('C2.5: runtime tenta contrato visual estruturado antes do fallback comercial genérico', () => {
  const source = read('src/services/rfqParserService.js');
  const structuredAt = source.indexOf('extractCommercialTableFromPdfWithAi');
  const genericAt = source.indexOf('extractTextFromPdfWithAi({', structuredAt);
  assert.ok(structuredAt >= 0);
  assert.ok(genericAt > structuredAt);
  assert.match(source, /Carta escaneada reconhecida, mas a tabela visual não fechou integralmente/);
  assert.match(source, /CHAT_LINCE_PDF_VISUAL_ESTRUTURADO/);
});

test('C2.5: versão atual invalida jobs antigos, fica sincronizada no frontend e não adiciona OCR via npm', () => {
  const jobs = read('src/services/rfqImportJobService.js');
  const front = fs.readFileSync(path.resolve(ROOT, '../sisha-frontend/src/components/RfqImporter.jsx'), 'utf8');
  const pkg = JSON.parse(read('package.json'));

  const backendVersion = jobs.match(/const ANALYSIS_VERSION = '([^']+)'/)?.[1] || null;
  const frontendVersion = front.match(/const CURRENT_ANALYSIS_VERSION = '([^']+)'/)?.[1] || null;

  assert.ok(backendVersion, 'Backend deve declarar ANALYSIS_VERSION.');
  assert.ok(frontendVersion, 'Frontend deve declarar CURRENT_ANALYSIS_VERSION.');
  assert.equal(frontendVersion, backendVersion, 'Backend e frontend devem usar a mesma versão de análise/cache.');
  assert.notEqual(backendVersion, 'C2.6-SCANNED-REPAIR-LIVE-FALLBACK-1', 'A versão C2.6 não pode voltar após o OCR local.');
  assert.equal(Boolean(pkg.dependencies?.tesseract), false);
  assert.equal(Boolean(pkg.dependencies?.['tesseract.js']), false);
  assert.equal(Boolean(pkg.dependencies?.canvas), false);
});
