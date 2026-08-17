const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  normalizePnCandidate,
  parseRepairOverhaulTableTsv,
  choosePnCandidate,
  parseMetadataText,
  buildTranscript,
} = require('../../src/services/commercialLocalOcrService');
const {
  parseDeterministicCommercialDocument,
} = require('../../src/services/commercialDocumentDeterministicService');

const root = path.resolve(__dirname, '..', '..');
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');

function tsvWord({ text, left, top, width = 80, height = 24, conf = 90 }) {
  return ['5', '1', '1', '1', '1', '1', left, top, width, height, conf, text].join('\t');
}

function syntheticTableTsv() {
  const header = 'level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext';
  const rows = [
    ['1','1','0','0','0','0','0','0','1000','1200','-1',''].join('\t'),
    tsvWord({ text: 'Component', left: 80, top: 100 }),
    tsvWord({ text: 'Part', left: 360, top: 100 }),
    tsvWord({ text: 'Repair', left: 610, top: 130 }),
    tsvWord({ text: 'Overhaul', left: 810, top: 130 }),
    tsvWord({ text: 'Fuel', left: 80, top: 210 }),
    tsvWord({ text: 'Booster', left: 130, top: 210 }),
    tsvWord({ text: 'Pump', left: 205, top: 210 }),
    tsvWord({ text: '2030H08', left: 365, top: 210, conf: 84 }),
    tsvWord({ text: '37,207.00', left: 615, top: 210, conf: 95 }),
    tsvWord({ text: '41,065.00', left: 815, top: 210, conf: 94 }),
    tsvWord({ text: 'Valve', left: 80, top: 270 }),
    tsvWord({ text: 'Solenoid', left: 130, top: 270 }),
    tsvWord({ text: 'LH11264-02', left: 365, top: 270, conf: 82 }),
    tsvWord({ text: '44,034.00', left: 615, top: 270, conf: 95 }),
    tsvWord({ text: 'Multi-Function', left: 80, top: 302 }),
    tsvWord({ text: 'Valve', left: 190, top: 302 }),
    tsvWord({ text: '(MFV)', left: 235, top: 302 }),
    tsvWord({ text: 'Gearbox', left: 80, top: 360 }),
    tsvWord({ text: 'Change', left: 150, top: 360 }),
    tsvWord({ text: 'Unit', left: 205, top: 360 }),
    tsvWord({ text: 'WG1468-0002-***', left: 365, top: 360, conf: 88 }),
    tsvWord({ text: '562,598.00', left: 615, top: 360, conf: 93 }),
    tsvWord({ text: '1,037,984.00', left: 815, top: 360, conf: 92 }),
  ];
  return [header, ...rows].join('\n');
}

test('C2.7: TSV por coordenadas preserva a mesma linha física de PN, Repair e Overhaul', () => {
  const parsed = parseRepairOverhaulTableTsv(syntheticTableTsv());
  assert.equal(parsed.recognized, true);
  assert.equal(parsed.rows.length, 3);
  assert.deepEqual(
    parsed.rows.map((row) => [row.pn, row.repair, row.overhaul]),
    [
      ['2030H08', 37207, 41065],
      ['LH11264-02', 44034, 0],
      ['WG1468-0002-***', 562598, 1037984],
    ],
  );
});

test('C2.7: continuação visual sem PN/preço só complementa a descrição da linha anterior', () => {
  const parsed = parseRepairOverhaulTableTsv(syntheticTableTsv());
  assert.equal(parsed.rows[1].description, 'Valve Solenoid Multi-Function Valve (MFV)');
});

test('C2.7: normalizador remove somente artefato de borda e preserva separadores internos do PN', () => {
  assert.equal(normalizePnCandidate('-WG1468-0002-***'), 'WG1468-0002-***');
  assert.equal(normalizePnCandidate('/30495-211'), '30495-211');
  assert.equal(normalizePnCandidate('JMP/PRA/4933/4'), 'JMP/PRA/4933/4');
});

test('C2.7: re-OCR escolhe candidato de alta confiança mesmo contra leitura de página errada repetida', () => {
  const choice = choosePnCandidate([
    { source: 'page', value: '30495-2111', confidence: 0 },
    { source: 'cell_200_7', value: '30495-211', confidence: 91.8 },
    { source: 'cell_200_8', value: '30495-211', confidence: 2.7 },
    { source: 'cell_250_7', value: '30495-211', confidence: 91.2 },
    { source: 'cell_250_8', value: '30495-211', confidence: 0 },
  ]);
  assert.equal(choice.accepted, true);
  assert.equal(choice.value, '30495-211');
});

test('C2.7: consenso OCR exato em quatro passes aceita PN legível mesmo com confiança numérica baixa', () => {
  const choice = choosePnCandidate([
    { source: 'page', value: 'WG1344-7001-053', confidence: 21 },
    { source: 'cell_1', value: 'WG1344-7001-053', confidence: 0 },
    { source: 'cell_2', value: 'WG1344-7001-053', confidence: 0 },
    { source: 'cell_3', value: 'WG1344-7001-053', confidence: 0 },
  ]);
  assert.equal(choice.accepted, true);
  assert.equal(choice.value, 'WG1344-7001-053');
});

test('C2.7: candidatos concorrentes sem margem suficiente continuam bloqueados', () => {
  const choice = choosePnCandidate([
    { source: 'a', value: '2282H000-004', confidence: 52 },
    { source: 'b', value: '2282H000-004', confidence: 40 },
    { source: 'c', value: '2282HO000-004', confidence: 60 },
    { source: 'd', value: '2282HO000-004', confidence: 50 },
  ]);
  assert.equal(choice.accepted, false);
});

test('C2.7: metadados OCR preservam referência/contrato e limpam somente ruído gráfico de data', () => {
  const metadata = parseMetadataText(`
    LUKL Ref.: LUKL/BN/UPGRADE/24052024
    Date: 24" May 2024
    Contract No. 71000/2020-022/00
    Subject: Future Support and Fixed Price Repairs - Lynx M21B.
    Attachment 1 - Fixed Price Repair / Overhaul Listing - validity, 31° March 2025.
  `);
  assert.deepEqual(metadata, {
    reference: 'LUKL/BN/UPGRADE/24052024',
    date: '24 May 2024',
    contract_reference: '71000/2020-022/00',
    subject: 'Future Support and Fixed Price Repairs - Lynx M21B',
    validity: '31 March 2025',
  });
});

test('C2.7: transcrição OCR alimenta parser determinístico e separa Repair/Overhaul sem IA', () => {
  const transcript = buildTranscript({
    metadata: {
      reference: 'LUKL/BN/UPGRADE/24052024',
      date: '24 May 2024',
      contract_reference: '71000/2020-022/00',
      validity: '31 March 2025',
    },
    rows: [
      { description: 'Fuel Booster Pump', pn: '2030H08', repair: 37207, overhaul: 41065 },
      { description: 'Oil Cooler Fan', pn: 'WG1468-0210-043', repair: 0, overhaul: 65808 },
      { description: 'Gearbox Change Unit', pn: 'WG1468-0002-***', repair: 562598, overhaul: 1037984 },
    ],
  });
  const parsed = parseDeterministicCommercialDocument({
    text: transcript,
    fileName: 'scan.pdf',
    documentType: 'LEONARDO_REPAIR_PRICE_LETTER',
  });
  assert.equal(parsed.items.length, 5);
  assert.deepEqual(parsed.items.map((item) => [item.pn, item.tipo_cotacao, item.valor_unitario, item.match_mode]), [
    ['2030H08', 'REPARO', 37207, 'EXACT'],
    ['2030H08', 'OVERHAUL', 41065, 'EXACT'],
    ['WG1468-0210-043', 'OVERHAUL', 65808, 'EXACT'],
    ['WG1468-0002-***', 'REPARO', 562598, 'PATTERN'],
    ['WG1468-0002-***', 'OVERHAUL', 1037984, 'PATTERN'],
  ]);
});

test('C2.7: runtime tenta OCR local antes de qualquer leitor visual generativo em PDF escaneado', () => {
  const source = read('src/services/rfqParserService.js');
  const local = source.indexOf('extractScannedRepairOverhaulWithLocalOcr');
  const ai = source.indexOf('extractCommercialTableFromPdfWithAi({', local);
  assert.ok(local >= 0);
  assert.ok(ai > local);
  assert.match(source, /method: 'OCR_LOCAL_TESSERACT_POPPLER'/);
});

test('C2.7: OCR local reconhecido é autoritativo e ambiguidade bloqueia antes de IA preencher PN/preço', () => {
  const source = read('src/services/rfqParserService.js');
  assert.match(source, /if \(localOcr\.recognized\) \{/);
  assert.match(source, /method: localOcr\.unavailable \? 'OCR_LOCAL_INDISPONIVEL_BLOQUEADO' : 'OCR_LOCAL_REVIEW_BLOQUEADO'/);
  assert.match(source, /o SISHA não usa IA generativa como substituto do OCR local para definir PN ou preço/);
});

test('C2.7: versão invalida C2.6 no backend/frontend e env documenta Tesseract/Poppler sem npm novo', () => {
  const job = read('src/services/rfqImportJobService.js');
  const front = read('../sisha-frontend/src/components/RfqImporter.jsx');
  const env = read('.env.example');
  const packageJson = JSON.parse(read('package.json'));
  const backendVersion = job.match(/const ANALYSIS_VERSION = '([^']+)'/)?.[1] || null;
  const frontendVersion = front.match(/const CURRENT_ANALYSIS_VERSION = '([^']+)'/)?.[1] || null;
  assert.match(String(backendVersion || ''), /^C2\.7/);
  assert.equal(frontendVersion, backendVersion);
  assert.notEqual(backendVersion, 'C2.6-SCANNED-REPAIR-LIVE-FALLBACK-1');
  assert.match(env, /SISHA_TESSERACT_CMD=tesseract/);
  assert.match(env, /SISHA_PDFTOPPM_CMD=pdftoppm/);
  assert.equal(Boolean(packageJson.dependencies?.tesseract || packageJson.dependencies?.poppler), false);
  const ocrSource = read('src/services/commercialLocalOcrService.js');
  assert.match(ocrSource, /execFile/);
  assert.match(ocrSource, /fs\.rm\(tmpDir, \{ recursive: true, force: true \}/);
});
