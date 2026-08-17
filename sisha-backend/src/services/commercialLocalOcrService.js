const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const execFileAsync = promisify(execFile);

const DEFAULT_TIMEOUT_MS = Math.max(10000, Number(process.env.SISHA_LOCAL_OCR_TIMEOUT_MS || 45000));
const DEFAULT_SCAN_PAGES = Math.min(6, Math.max(1, Number(process.env.SISHA_LOCAL_OCR_MAX_PAGES || 4)));
const OCR_ENABLED = !/^(?:0|false|no|off)$/i.test(String(process.env.SISHA_LOCAL_OCR_ENABLED ?? 'true'));
const TESSERACT_CMD = String(process.env.SISHA_TESSERACT_CMD || 'tesseract').trim() || 'tesseract';
const PDFTOPPM_CMD = String(process.env.SISHA_PDFTOPPM_CMD || 'pdftoppm').trim() || 'pdftoppm';

function clean(value) {
  return value == null ? '' : String(value).replace(/\r/g, '').trim();
}

function parseMoney(value) {
  let text = clean(value).replace(/£/g, '').replace(/\s/g, '');
  if (!text) return 0;
  if (text.includes(',') && text.includes('.')) text = text.replace(/,/g, '');
  else if (text.includes(',')) text = text.replace(',', '.');
  const parsed = Number(text.replace(/[^0-9.-]/g, ''));
  return Number.isFinite(parsed) ? parsed : 0;
}

function formatMoney(value) {
  const n = Number(value) || 0;
  if (!n) return '';
  return n.toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2, useGrouping: true });
}

function normalizePnCandidate(value) {
  return clean(value)
    .toUpperCase()
    .replace(/\s+/g, '')
    .replace(/^[|_.,;:]+/, '')
    .replace(/[|_.,;:]+$/, '')
    // Bordas da célula podem ser lidas como '-' ou '/' no início.
    // Removemos apenas artefato de BORDA; barras/hífens internos continuam parte do PN.
    .replace(/^[-/]+(?=[A-Z0-9])/, '');
}

function parseTsv(tsv = '') {
  const lines = String(tsv || '').split(/\r?\n/).filter(Boolean);
  if (lines.length < 2) return { width: 0, height: 0, words: [] };
  const header = lines[0].split('\t');
  const idx = Object.fromEntries(header.map((name, i) => [name, i]));
  const rows = lines.slice(1).map((line) => line.split('\t'));
  const root = rows.find((cols) => Number(cols[idx.level]) === 1) || [];
  const words = rows
    .filter((cols) => Number(cols[idx.level]) === 5 && clean(cols[idx.text]))
    .map((cols) => ({
      text: clean(cols[idx.text]),
      left: Number(cols[idx.left]) || 0,
      top: Number(cols[idx.top]) || 0,
      width: Number(cols[idx.width]) || 0,
      height: Number(cols[idx.height]) || 0,
      conf: Number(cols[idx.conf]),
    }));
  return {
    width: Number(root[idx.width]) || 0,
    height: Number(root[idx.height]) || 0,
    words,
  };
}

function groupWordsByVisualLine(words = [], tolerance = 8) {
  const groups = [];
  [...words].sort((a, b) => a.top - b.top || a.left - b.left).forEach((word) => {
    let group = groups.find((candidate) => Math.abs(candidate.top - word.top) <= tolerance);
    if (!group) {
      group = { top: word.top, words: [] };
      groups.push(group);
    }
    group.words.push(word);
    group.top = group.words.reduce((sum, item) => sum + item.top, 0) / group.words.length;
  });
  return groups.sort((a, b) => a.top - b.top);
}

function findHeader(words = []) {
  const component = words.find((word) => /^Component$/i.test(word.text));
  const part = words.find((word) => /^Part$/i.test(word.text) && word.top >= (component?.top || 0) - 30 && word.top <= (component?.top || 0) + 50);
  const repair = words.find((word) => /^Repair$/i.test(word.text) && word.top > (component?.top || 0));
  const overhaul = words.find((word) => /^Overhaul$/i.test(word.text) && word.top > (component?.top || 0));
  if (!component || !part || !repair || !overhaul) return null;
  return {
    descStart: component.left,
    pnStart: part.left,
    repairStart: repair.left,
    overhaulStart: overhaul.left,
    headerBottom: Math.max(repair.top + repair.height, overhaul.top + overhaul.height),
  };
}

function parseRepairOverhaulTableTsv(tsv = '') {
  const parsed = parseTsv(tsv);
  const header = findHeader(parsed.words);
  if (!header || !parsed.width || !parsed.height) {
    return { recognized: false, rows: [], blocking: ['Cabeçalho tabular Repair/Overhaul não localizado pelo OCR local.'], width: parsed.width, height: parsed.height };
  }

  const rightLimit = Math.min(parsed.width, header.overhaulStart + Math.max(250, (header.overhaulStart - header.repairStart) * 1.7));
  const bodyWords = parsed.words.filter((word) => (
    word.top > header.headerBottom + 5
    && word.left >= Math.max(0, header.descStart - 40)
    && word.left < rightLimit
    && !/^(?:Commercial-in-Confidence|Page)$/i.test(word.text)
  ));
  const groups = groupWordsByVisualLine(bodyWords, Math.max(5, Math.round(parsed.height / 440)));
  const rows = [];
  let previous = null;

  for (const group of groups) {
    const words = group.words.filter((word) => /[A-Za-z0-9£]/.test(word.text)).sort((a, b) => a.left - b.left);
    if (!words.length) continue;
    const descWords = words.filter((word) => word.left < header.pnStart - 10);
    const pnWords = words.filter((word) => word.left >= header.pnStart - 10 && word.left < header.repairStart - 10);
    const repairWords = words.filter((word) => word.left >= header.repairStart - 10 && word.left < header.overhaulStart - 10);
    const overhaulWords = words.filter((word) => word.left >= header.overhaulStart - 10 && word.left < rightLimit);

    const description = clean(descWords.map((word) => word.text).join(' '));
    const pnRaw = normalizePnCandidate(pnWords.map((word) => word.text).join(''));
    const repairText = repairWords.map((word) => word.text).join('');
    const overhaulText = overhaulWords.map((word) => word.text).join('');
    const repair = parseMoney(repairText);
    const overhaul = parseMoney(overhaulText);

    if (!pnRaw && !repair && !overhaul) {
      if (description && previous && !/Component\s+Description|Fixed\s+Price|Part\s+Number/i.test(description)) {
        previous.description = clean(`${previous.description} ${description}`);
      }
      continue;
    }
    if (!pnRaw || (!repair && !overhaul)) continue;

    const pnConfidence = pnWords.length
      ? Math.min(...pnWords.map((word) => Number.isFinite(word.conf) ? word.conf : -1))
      : -1;
    const moneyConfidence = [...repairWords, ...overhaulWords].length
      ? Math.min(...[...repairWords, ...overhaulWords].map((word) => Number.isFinite(word.conf) ? word.conf : -1))
      : -1;

    const row = {
      description,
      pn: pnRaw,
      pn_confidence: pnConfidence,
      money_confidence: moneyConfidence,
      repair,
      overhaul,
      row_top: Math.round(group.top),
      row_height: Math.max(28, ...words.map((word) => word.height || 0)),
      source_page: null,
      needs_pn_verification: pnConfidence < 70,
      pn_evidence: [{ source: 'page_tsv_300', value: pnRaw, confidence: pnConfidence }],
    };
    rows.push(row);
    previous = row;
  }

  const blocking = [];
  if (rows.length < 5) blocking.push(`OCR local encontrou somente ${rows.length} linha(s) de preço; tabela considerada incompleta.`);
  const invalidMoney = rows.filter((row) => (!row.repair && !row.overhaul));
  if (invalidMoney.length) blocking.push(`${invalidMoney.length} linha(s) sem preço Repair/Overhaul utilizável.`);

  return {
    recognized: true,
    rows,
    blocking,
    width: parsed.width,
    height: parsed.height,
    header,
  };
}

function candidateScore(item) {
  const confidence = Number(item?.confidence);
  return Number.isFinite(confidence) ? Math.max(-1, confidence) : -1;
}

function choosePnCandidate(evidence = []) {
  const grouped = new Map();
  for (const item of evidence) {
    const value = normalizePnCandidate(item?.value);
    if (!value || !/[A-Z0-9]/.test(value)) continue;
    const confidence = candidateScore(item);
    const current = grouped.get(value) || { value, count: 0, maxConfidence: -1, totalConfidence: 0, evidence: [] };
    current.count += 1;
    current.maxConfidence = Math.max(current.maxConfidence, confidence);
    current.totalConfidence += Math.max(0, confidence);
    current.evidence.push({ ...item, value });
    grouped.set(value, current);
  }
  const ranked = [...grouped.values()].map((entry) => ({
    ...entry,
    score: entry.maxConfidence + Math.max(0, entry.count - 1) * 10,
  })).sort((a, b) => b.score - a.score || b.maxConfidence - a.maxConfidence || b.count - a.count);
  if (!ranked.length) return { value: '', accepted: false, reason: 'SEM_CANDIDATO', ranked };
  const winner = ranked[0];
  const runner = ranked[1];
  const margin = runner ? winner.score - runner.score : winner.score;
  const strongExactConsensus = winner.count >= 4
    && (!runner || winner.count >= runner.count + 2)
    && /^[A-Z0-9][A-Z0-9*+./-]{2,}$/.test(winner.value);
  const accepted = (winner.maxConfidence >= 70 && margin >= 12)
    || (winner.count >= 2 && winner.maxConfidence >= 50 && margin >= 12)
    || (winner.count >= 3 && winner.maxConfidence >= 55)
    || strongExactConsensus;
  return {
    value: winner.value,
    accepted,
    confidence: winner.maxConfidence,
    score: winner.score,
    margin,
    reason: accepted ? 'CONSENSO_OCR' : 'PN_OCR_AMBIGUO',
    ranked,
  };
}

function normalizeOcrDateText(value) {
  return clean(value)
    // OCR costuma ler o ordinal inglês/scan como aspas, grau ou apóstrofo entre dia e mês.
    // Não inferimos a data: apenas retiramos esse ruído gráfico do valor já reconhecido.
    .replace(/^(\d{1,2})(?:st|nd|rd|th|[°'”"])+\s+/i, '$1 ')
    .replace(/\s+/g, ' ');
}

function parseMetadataText(text = '') {
  const raw = String(text || '').replace(/\r/g, '');
  const flat = raw.replace(/[\t ]+/g, ' ').replace(/\n+/g, ' ');
  const reference = clean(flat.match(/LUKL\s+Ref\.?\s*:\s*([A-Z0-9/.-]+)/i)?.[1]);
  const date = clean(flat.match(/Date\s*:\s*(\d{1,2}(?:st|nd|rd|th|[°'”"])?\s+[A-Za-z]+\s+\d{4})/i)?.[1]);
  const contract = clean(flat.match(/Contract\s+No\.\s*([0-9A-Z/.-]+)/i)?.[1]);
  const subject = clean(raw.match(/Subject\s*:\s*([^\n\r]+)/i)?.[1] || flat.match(/Subject\s*:\s*(.*?)(?=\s+(?:I trust|Attachment\s+1|References?\s*:|Dear\s+))/i)?.[1]).replace(/\s+I trust.*$/i, '').replace(/\.$/, '');
  const validity = clean(flat.match(/valid\s+until\s+(\d{1,2}(?:st|nd|rd|th|[°'”"])?\s+[A-Za-z]+\s+\d{4})/i)?.[1]
    || flat.match(/validity,?\s*(\d{1,2}(?:st|nd|rd|th|[°'”"])?\s+[A-Za-z]+\s+\d{4})/i)?.[1]);
  return {
    reference,
    date: normalizeOcrDateText(date),
    contract_reference: contract,
    subject,
    validity: normalizeOcrDateText(validity),
  };
}

function buildTranscript({ metadata = {}, rows = [] } = {}) {
  const lines = ['Leonardo UK Ltd', 'Document Type: LEONARDO_REPAIR_PRICE_LETTER'];
  if (metadata.reference) lines.push(`LUKL Ref.: ${metadata.reference}`);
  if (metadata.date) lines.push(`Date: ${metadata.date}`);
  if (metadata.contract_reference) lines.push(`Contract No. ${metadata.contract_reference}`);
  if (metadata.subject) lines.push(`Subject: ${metadata.subject}`);
  if (metadata.validity) lines.push(`Attachment 1 - Fixed Price Repair / Overhaul Listing - validity, ${metadata.validity}.`);
  else lines.push('Attachment 1 - Fixed Price Repair / Overhaul Listing.');
  lines.push('Component Description | Part Number | Fixed Price Repair (GBP) | Fixed Price Overhaul (GBP)');
  for (const row of rows) {
    lines.push(`${row.description || '[REVISAR]'} | ${row.pn} | ${formatMoney(row.repair)} | ${formatMoney(row.overhaul)}`);
  }
  return lines.join('\n');
}

async function run(command, args, { timeout = DEFAULT_TIMEOUT_MS, maxBuffer = 8 * 1024 * 1024 } = {}) {
  return execFileAsync(command, args, { timeout, maxBuffer, windowsHide: true, encoding: 'utf8' });
}

async function checkLocalOcrReadiness() {
  if (!OCR_ENABLED) return { ready: false, reason: 'OCR_LOCAL_DESATIVADO' };
  try {
    await run(TESSERACT_CMD, ['--version'], { timeout: 8000 });
  } catch (error) {
    return { ready: false, reason: 'TESSERACT_INDISPONIVEL', detail: error?.code || error?.message || String(error) };
  }
  try {
    await run(PDFTOPPM_CMD, ['-v'], { timeout: 8000 });
  } catch (error) {
    return { ready: false, reason: 'PDFTOPPM_INDISPONIVEL', detail: error?.code || error?.message || String(error) };
  }
  return { ready: true, tesseract: TESSERACT_CMD, pdftoppm: PDFTOPPM_CMD };
}

async function renderPdfPage(pdfPath, page, dpi, outputBase, crop = null) {
  const args = ['-f', String(page), '-l', String(page), '-r', String(dpi)];
  if (crop) {
    args.push('-x', String(Math.max(0, Math.round(crop.x))));
    args.push('-y', String(Math.max(0, Math.round(crop.y))));
    args.push('-W', String(Math.max(1, Math.round(crop.width))));
    args.push('-H', String(Math.max(1, Math.round(crop.height))));
  }
  args.push('-singlefile', '-png', pdfPath, outputBase);
  await run(PDFTOPPM_CMD, args, { timeout: DEFAULT_TIMEOUT_MS * 2 });
  return `${outputBase}.png`;
}

async function ocrText(imagePath, psm = 3) {
  const { stdout } = await run(TESSERACT_CMD, [imagePath, 'stdout', '-l', 'eng', '--psm', String(psm)], { timeout: DEFAULT_TIMEOUT_MS });
  return clean(stdout);
}

async function ocrTsv(imagePath, psm = 3, whitelist = '') {
  const args = [imagePath, 'stdout', '-l', 'eng', '--psm', String(psm)];
  if (whitelist) args.push('-c', `tessedit_char_whitelist=${whitelist}`);
  args.push('tsv');
  const { stdout } = await run(TESSERACT_CMD, args, { timeout: DEFAULT_TIMEOUT_MS });
  return stdout || '';
}

function extractSingleWordEvidence(tsv = '', source = '') {
  const parsed = parseTsv(tsv);
  const words = parsed.words.filter((word) => /[A-Za-z0-9]/.test(word.text));
  const value = normalizePnCandidate(words.map((word) => word.text).join(''));
  const confidence = words.length ? Math.min(...words.map((word) => Number.isFinite(word.conf) ? word.conf : -1)) : -1;
  return { source, value, confidence };
}

async function verifyPnCell({ pdfPath, page, row, header }) {
  const evidence = [...(row.pn_evidence || [])];
  // Dois DPIs + dois modos de segmentação dão quatro leituras independentes da MESMA célula.
  // Isso é deliberadamente diferente de pedir a um LLM para "interpretar" o PN.
  const passes = [
    { dpi: 200, psm: 7 },
    { dpi: 200, psm: 8 },
    { dpi: 250, psm: 7 },
    { dpi: 250, psm: 8 },
  ];
  for (const { dpi, psm } of passes) {
    const scale = dpi / 300;
    // C2.7: crop vertical deliberadamente estreito. Linhas da tabela têm bordas
    // horizontais; incluir a borda inferior pode virar um caractere extra
    // (ex.: 30495-211 -> 30495-2111).
    const baseHeight300 = Math.max(42, Math.min(54, row.row_height + 18));
    const crop = {
      x: (header.pnStart - 25) * scale,
      y: (row.row_top - 11) * scale,
      width: Math.max(150, (header.repairStart - header.pnStart - 20) * scale),
      height: Math.max(28, baseHeight300 * scale),
    };
    const base = path.join(path.dirname(pdfPath), `pn-${page}-${row.row_top}-${dpi}-${psm}`);
    try {
      const imagePath = await renderPdfPage(pdfPath, page, dpi, base, crop);
      const tsv = await ocrTsv(imagePath, psm, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-/*.+');
      evidence.push(extractSingleWordEvidence(tsv, `cell_${dpi}_psm${psm}`));
    } catch (error) {
      evidence.push({ source: `cell_${dpi}_psm${psm}`, value: '', confidence: -1, error: error?.message || String(error) });
    }
  }
  const choice = choosePnCandidate(evidence);
  return { ...choice, evidence };
}

async function extractScannedRepairOverhaulWithLocalOcr({ buffer, fileName = 'documento.pdf' } = {}) {
  const body = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer || '');
  if (!body.length) return { recognized: false, valid: false, unavailable: false, blocking: ['PDF vazio para OCR local.'], rows: [] };
  const readiness = await checkLocalOcrReadiness();
  if (!readiness.ready) {
    return {
      recognized: /(?:LUKL|LHUK|LEONARDO)/i.test(fileName || ''),
      valid: false,
      unavailable: true,
      readiness,
      blocking: [`OCR local indisponível (${readiness.reason}). Instale/configure Tesseract OCR e Poppler/pdftoppm; o SISHA não usará IA generativa como substituto para preços de carta escaneada.`],
      rows: [],
      transcript: '',
    };
  }

  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sisha-rfq-ocr-'));
  const pdfPath = path.join(tmpDir, 'source.pdf');
  try {
    await fs.writeFile(pdfPath, body);
    const metadataTexts = [];
    let tablePage = null;
    for (let page = 1; page <= DEFAULT_SCAN_PAGES; page += 1) {
      const base = path.join(tmpDir, `scan-${page}`);
      let imagePath;
      try {
        imagePath = await renderPdfPage(pdfPath, page, 200, base);
      } catch (error) {
        if (page === 1) throw error;
        break;
      }
      const text = await ocrText(imagePath, 3);
      metadataTexts.push(text);
      if (/Fixed\s+Price\s+Repair/i.test(text) && /Overhaul/i.test(text) && /Part\s+Number/i.test(text)) {
        tablePage = page;
        break;
      }
    }

    const combinedText = metadataTexts.join('\n');
    const recognized = /Future\s+Support\s+and\s+Fixed\s+Price\s+Repairs/i.test(combinedText)
      || (/Fixed\s+Price\s+Repair/i.test(combinedText) && /Overhaul/i.test(combinedText));
    if (!recognized || !tablePage) {
      return { recognized: false, valid: false, unavailable: false, blocking: [], warnings: [], rows: [], transcript: '' };
    }

    const tableBase = path.join(tmpDir, `table-${tablePage}-300`);
    const tableImage = await renderPdfPage(pdfPath, tablePage, 300, tableBase);
    const tsv = await ocrTsv(tableImage, 3);
    const parsedTable = parseRepairOverhaulTableTsv(tsv);
    parsedTable.rows.forEach((row) => { row.source_page = tablePage; });

    const blocking = [...(parsedTable.blocking || [])];
    const warnings = [];
    for (const row of parsedTable.rows) {
      if (row.needs_pn_verification) {
        const verification = await verifyPnCell({ pdfPath, page: tablePage, row, header: parsedTable.header });
        row.pn_verification = verification;
        if (verification.accepted) {
          if (verification.value !== row.pn) warnings.push(`PN OCR refinado na mesma célula visual: ${row.pn} -> ${verification.value}.`);
          row.pn = verification.value;
          row.needs_pn_verification = false;
        } else {
          blocking.push(`PN da linha "${row.description || 'sem descrição'}" ficou ambíguo no OCR local (${row.pn || 'sem leitura'}). Confirmação humana obrigatória.`);
        }
      }
      if (row.money_confidence >= 0 && row.money_confidence < 55) {
        blocking.push(`Preço da linha PN ${row.pn || '[REVISAR]'} teve baixa confiança OCR (${row.money_confidence.toFixed(1)}).`);
      }
    }

    const uniquePn = new Map();
    for (const row of parsedTable.rows) {
      const key = normalizePnCandidate(row.pn);
      const previous = uniquePn.get(key);
      if (previous && (previous.repair !== row.repair || previous.overhaul !== row.overhaul || previous.description !== row.description)) {
        blocking.push(`PN ${key} apareceu mais de uma vez com conteúdo divergente na tabela OCR.`);
      } else if (!previous) uniquePn.set(key, row);
    }

    const metadata = parseMetadataText(combinedText);
    const transcript = buildTranscript({ metadata, rows: parsedTable.rows });
    if (!metadata.contract_reference) warnings.push('Contract No. não foi localizado com segurança pelo OCR local.');
    if (!metadata.validity) warnings.push('Validade da lista não foi localizada com segurança pelo OCR local.');

    return {
      recognized: true,
      valid: blocking.length === 0,
      unavailable: false,
      blocking,
      warnings,
      rows: parsedTable.rows,
      metadata: { ...metadata, source_table_page: tablePage },
      transcript,
      method: 'OCR_LOCAL_TESSERACT_POPPLER',
      evidence: {
        engine: 'tesseract+pdftoppm',
        table_page: tablePage,
        row_count: parsedTable.rows.length,
        price_reference_count: parsedTable.rows.reduce((sum, row) => sum + (row.repair ? 1 : 0) + (row.overhaul ? 1 : 0), 0),
      },
    };
  } catch (error) {
    return {
      recognized: /(?:LUKL|LHUK|LEONARDO)/i.test(fileName || ''),
      valid: false,
      unavailable: false,
      blocking: [`Falha no OCR local fail-closed: ${error?.message || String(error)}`],
      warnings: [],
      rows: [],
      transcript: '',
      method: 'OCR_LOCAL_ERRO_BLOQUEADO',
    };
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}

module.exports = {
  parseMoney,
  normalizePnCandidate,
  parseTsv,
  parseRepairOverhaulTableTsv,
  choosePnCandidate,
  parseMetadataText,
  normalizeOcrDateText,
  buildTranscript,
  checkLocalOcrReadiness,
  extractScannedRepairOverhaulWithLocalOcr,
};
