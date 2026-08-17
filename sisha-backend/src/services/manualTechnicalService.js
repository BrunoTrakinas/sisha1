const crypto = require('crypto');
const pdfParse = require('pdf-parse');
const { extractTextFromImagesWithAi, extractTextFromPdfWithAi, compactText } = require('./chatLinceService');

function hashBuffer(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function safe(value) {
  return String(value == null ? '' : value).trim();
}

function normalizePn(value) {
  return safe(value).toUpperCase().replace(/[‐‑–—]/g, '-');
}

function unique(values = []) {
  return Array.from(new Set(values.filter(Boolean)));
}


const MANUAL_PARSE_CACHE = new Map();
const MANUAL_PARSE_CACHE_TTL_MS = Math.max(5, Number(process.env.WTP_PREVIEW_CACHE_MINUTES || 30)) * 60 * 1000;

function cacheGet(hash) {
  const row = MANUAL_PARSE_CACHE.get(hash);
  if (!row) return null;
  if ((Date.now() - row.createdAt) > MANUAL_PARSE_CACHE_TTL_MS) {
    MANUAL_PARSE_CACHE.delete(hash);
    return null;
  }
  return row.value;
}

function cacheSet(hash, value) {
  if (MANUAL_PARSE_CACHE.size > 24) {
    const oldest = Array.from(MANUAL_PARSE_CACHE.entries())
      .sort((a, b) => a[1].createdAt - b[1].createdAt)
      .slice(0, 8);
    oldest.forEach(([key]) => MANUAL_PARSE_CACHE.delete(key));
  }
  MANUAL_PARSE_CACHE.set(hash, { createdAt: Date.now(), value });
}

function looksLikeUsefulTechnicalPdfText(text = '') {
  const clean = String(text || '').replace(/\s+/g, ' ').trim();
  if (clean.length < 350) return false;
  const upper = clean.toUpperCase();
  const technicalSignals = [
    'PART NUMBER', 'PART NO', 'P/N', 'NOMENCLATURE', 'DETAILED PARTS LIST',
    'FAULT', 'PROBABLE CAUSE', 'CORRECTION', 'COMPONENT MAINTENANCE MANUAL',
    'SPECIAL TOOLS', 'CONSUMABLES', 'WTP',
  ].filter((signal) => upper.includes(signal)).length;
  const digitDensity = (clean.match(/\d/g) || []).length / Math.max(clean.length, 1);
  return technicalSignals >= 2 || (technicalSignals >= 1 && digitDensity >= 0.015);
}

function tokens(text = '') {
  const list = String(text).toUpperCase().match(/[A-Z0-9][A-Z0-9\-/.]{2,}/g) || [];
  return unique(list.map((v) => v.replace(/[.,;:]+$/g, '')).filter((v) => v.length <= 50)).slice(0, 40);
}

function extractJpegImagesFromPdfBuffer(buffer, maxImages = 10) {
  const images = [];
  const startMarker = Buffer.from([0xff, 0xd8]);
  const endMarker = Buffer.from([0xff, 0xd9]);
  let offset = 0;
  while (images.length < maxImages) {
    const start = buffer.indexOf(startMarker, offset);
    if (start === -1) break;
    const end = buffer.indexOf(endMarker, start + 2);
    if (end === -1) break;
    const imageBuffer = buffer.subarray(start, end + 2);
    offset = end + 2;
    if (imageBuffer.length < 25 * 1024) continue;
    images.push({ mime: 'image/jpeg', base64: imageBuffer.toString('base64'), bytes: imageBuffer.length });
  }
  return images;
}


async function renderPageWithLayout(pageData) {
  const content = await pageData.getTextContent({ normalizeWhitespace: false, disableCombineTextItems: false });
  const groups = [];
  const tolerance = 1.6;
  (content.items || []).forEach((item) => {
    const y = Number(item.transform?.[5] || 0);
    const x = Number(item.transform?.[4] || 0);
    let group = groups.find((g) => Math.abs(g.y - y) <= tolerance);
    if (!group) {
      group = { y, items: [] };
      groups.push(group);
    }
    group.items.push({ x, width: Number(item.width || 0), str: String(item.str || '') });
  });

  groups.sort((a, b) => b.y - a.y);
  return groups.map((group) => {
    group.items.sort((a, b) => a.x - b.x);
    let line = '';
    let previousEnd = null;
    let previousChar = 5;
    group.items.forEach((item) => {
      const clean = item.str.replace(/\s+/g, ' ').trim();
      if (!clean) return;
      const charWidth = item.width > 0 && clean.length > 0 ? Math.max(2.5, item.width / clean.length) : previousChar;
      if (previousEnd != null) {
        const gap = item.x - previousEnd;
        if (gap > 1.5) {
          const spaces = Math.min(60, Math.max(1, Math.round(gap / Math.max(2.5, (previousChar + charWidth) / 2))));
          line += ' '.repeat(spaces);
        }
      }
      line += clean;
      previousEnd = item.x + item.width;
      previousChar = charWidth;
    });
    return line.trimEnd();
  }).filter(Boolean).join('\n');
}

async function extractPdfText(buffer, fileName = 'manual.pdf') {
  const parsed = await pdfParse(buffer, { pagerender: renderPageWithLayout }).catch(() => ({ text: '' }));
  const text = String(parsed.text || '').replace(/\r/g, '').trim().slice(0, 350000);
  if (looksLikeUsefulTechnicalPdfText(text)) {
    return { text, method: 'PDF_TEXT', pdf_kind: 'DIGITAL' };
  }

  // Para PDF Xerox/escaneado, enviar o PDF privado inteiro como base64 ao pipeline
  // de PDF do OpenRouter. Não exige tornar o R2 público.
  const pdfAi = await extractTextFromPdfWithAi({
    buffer,
    fileName,
    tipoDocumento: 'WTP / Manual Técnico',
    prompt: [
      'O usuário informou que este arquivo é uma WTP/CMM/Manual Técnico.',
      'Faça OCR/leitura documental do PDF e preserve a estrutura técnica.',
      'Dê prioridade a: código do manual, revisão, ATA/DMC, PNs principais, Detailed Parts List/Illustrated Parts List, FIG, ITEM, PART NUMBER, NOMENCLATURE/DESCRIPTION, USAGE CODE, UNITS PER ASSY, Fault/Probable Cause/Correction e Special Tools/Consumables.',
      'Não resuma nem interprete livremente. Extraia o conteúdo técnico fielmente.',
      'Se algum caractere de PN ou ITEM estiver ilegível, marque [REVISAR] ao invés de inventar.',
    ].join('\n'),
  });

  if (pdfAi.ok && safe(pdfAi.text)) {
    return {
      text: compactText(pdfAi.text, 350000),
      method: `AI_PDF:${pdfAi.engine || 'OPENROUTER'}:${pdfAi.model || 'MODEL'}`,
      pdf_kind: 'DIGITALIZADO_OU_XEROX',
    };
  }

  // Último fallback para PDFs antigos que encapsulam JPEGs diretamente.
  const images = extractJpegImagesFromPdfBuffer(buffer, 10);
  if (images.length) {
    const visual = await extractTextFromImagesWithAi({ images, fileName, tipoDocumento: 'manual_tecnico_wtp' });
    if (visual.ok && safe(visual.text)) {
      return {
        text: compactText(visual.text, 350000),
        method: `IA_VISUAL_JPEG:${visual.model || 'OPENROUTER'}`,
        pdf_kind: 'DIGITALIZADO_OU_XEROX',
      };
    }
  }

  throw new Error(`Manual PDF sem texto técnico pesquisável e a leitura visual/PDF não conseguiu extrair conteúdo suficiente. ${pdfAi.reason || ''}`.trim());
}

function inferManualCode(text, fileName) {
  const fromName = String(fileName || '').toUpperCase().match(/\bWTP[A-Z0-9-]{4,}\b/);
  if (fromName) return fromName[0];
  const fromText = String(text || '').toUpperCase().match(/\bWTP[A-Z0-9-]{4,}\b/);
  return fromText ? fromText[0] : '';
}

function inferManualType(text, code) {
  const upper = String(text || '').toUpperCase();
  if (/^WTP/i.test(code)) return 'WTP';
  if (upper.includes('COMPONENT MAINTENANCE MANUAL')) return 'CMM';
  if (upper.includes('ILLUSTRATED PARTS') || upper.includes('ILLUSTRATED PART LIST')) return 'IPL';
  return 'MANUAL_TECNICO';
}

function inferManufacturer(text) {
  const upper = String(text || '').toUpperCase();
  const known = ['SAFRAN AEROTECHNICS', 'LEONARDO', 'AGUSTAWESTLAND', 'GKN', 'HONEYWELL', 'COLLINS', 'PARKER'];
  return known.find((name) => upper.includes(name)) || '';
}

function inferAta(text) {
  const matches = String(text || '').match(/\b\d{2}-\d{2}-\d{2}\b/g) || [];
  if (!matches.length) return '';
  const counts = new Map();
  matches.forEach((m) => counts.set(m, (counts.get(m) || 0) + 1));
  return Array.from(counts.entries()).sort((a, b) => b[1] - a[1])[0][0];
}

function inferRevision(text) {
  const values = String(text || '').match(/\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s*\d{1,2}\/\d{2}\b/gi) || [];
  return values.length ? values[values.length - 1] : '';
}

function inferTitle(text, code) {
  const lines = String(text || '').split(/\n/).map((l) => safe(l)).filter(Boolean).slice(0, 180);
  const preferred = lines.find((line) => /FUEL PUMP|PUMP|LANDING GEAR|WHEEL|TIRE|HARPOON|ROTOR|GEARBOX|GENERATOR|ACTUATOR/i.test(line) && line.length <= 100);
  if (preferred) return preferred;
  return code ? `Manual técnico ${code}` : 'Manual técnico';
}

function inferMainPns(text) {
  const sample = String(text || '').slice(0, 18000);
  const direct = [];
  const lines = sample.split(/\n/);
  let capture = 0;
  for (const line of lines) {
    if (/PART\s*No/i.test(line)) capture = 4;
    if (capture > 0) {
      const vals = line.match(/\b[A-Z0-9][A-Z0-9\-/.]{3,}\b/g) || [];
      vals.forEach((v) => {
        if (/\d/.test(v) && !/^\d{2}-\d{2}-\d{2}$/.test(v) && !/^PAGE$/i.test(v)) direct.push(normalizePn(v));
      });
      capture -= 1;
    }
  }
  return unique(direct).slice(0, 12);
}

function parseDplParts(text) {
  const lines = String(text || '').split(/\n/);
  let start = -1;
  lines.forEach((line, index) => {
    if (/^\s*DETAILED PARTS LIST\s*$/i.test(line)) start = index;
  });
  if (start === -1) return [];

  const parts = [];
  let fig = '1';
  let pageRef = '';
  for (let i = start; i < lines.length; i += 1) {
    const trimmed = safe(lines[i]);
    if (!trimmed) continue;
    if (/ALPHA NUMERICAL INDEX|VENDOR'S CODE INDEX/i.test(trimmed) && parts.length > 0) break;

    const figMatch = trimmed.match(/Figure\s+(\d+[A-Z]?)/i);
    if (figMatch) fig = figMatch[1];
    const pageMatch = trimmed.match(/Page\s+(10001(?:-[0-9A-Z]+)?)/i);
    if (pageMatch) pageRef = `DPL Page ${pageMatch[1]}`;

    if (/^(?:AIRLINE|USAGE|NOMENCLATURE|FIG\.|CODE$|No\.|1234567$|ATTACHING PARTS|\* \* \*|- ITEM NOT ILLUSTRATED)/i.test(trimmed)) continue;
    if (/^(?:SAFRAN|COMPONENT MAINTENANCE MANUAL|The data and information|28-21-51)/i.test(trimmed)) continue;

    let itemRaw = '';
    let pn = '';
    let tail = '';

    // Alguns CMMs unem o primeiro item e o PN principal: "- 1203666 ..." = item 1 / PN 203666.
    let match = trimmed.match(/^\s*[-–—]\s*(\d)(\d{5,})\s{2,}(.+)$/);
    if (match) {
      itemRaw = match[1];
      pn = normalizePn(match[2]);
      tail = match[3];
    } else {
      match = trimmed.match(/^\s*[-–—]?\s*(\d+[A-Z]?)\s+([A-Z0-9][A-Z0-9\-/.]{2,})\s*(.*)$/i);
      if (!match) continue;
      itemRaw = match[1];
      pn = normalizePn(match[2]);
      tail = match[3] || '';
    }

    if (!/^[0-9A-Z][0-9A-Z\-/.]{2,}$/.test(pn) || !/\d/.test(pn)) continue;
    const cols = tail.split(/\s{2,}/).map(safe).filter(Boolean);
    if (!cols.length) continue;

    let nomenclatura = cols[0].replace(/^\.\s*/, '').trim();
    // Linha sem espaço entre PN e ponto: B8...CG. SCREW...
    if (!nomenclatura && tail.includes('.')) nomenclatura = tail.slice(tail.indexOf('.') + 1).trim();
    if (!nomenclatura || /^ATTACHING PARTS|^\*\*\*/i.test(nomenclatura)) continue;

    const units = cols.length >= 2 ? cols[cols.length - 1] : null;
    const possibleUsage = cols.length >= 3 ? cols[cols.length - 2] : null;
    parts.push({
      pn,
      fig,
      item: itemRaw,
      nomenclatura,
      airline_part_no: null,
      usage_code: possibleUsage && /^[A-Z]{1,4}$/.test(possibleUsage) ? possibleUsage : null,
      units_per_assy: units,
      tipo_vinculo: 'DPL',
      page_ref: pageRef || null,
      metadata: { raw_line: trimmed },
    });
  }

  const dedup = new Map();
  parts.forEach((row) => dedup.set(`${row.pn}|${row.fig}|${row.item}`, row));
  return Array.from(dedup.values()).slice(0, 5000);
}

function parseFaults(text) {
  const lines = String(text || '').split(/\n/);
  const rows = [];
  let currentFault = '';
  let currentRow = null;
  let pageRef = '';
  let inside = false;

  const flush = () => {
    if (currentRow?.fault && currentRow?.probable_cause) rows.push(currentRow);
    currentRow = null;
  };

  for (let i = 0; i < lines.length; i += 1) {
    const trimmed = safe(lines[i]);
    if (!trimmed) continue;
    if (/^FAULT\s+PROBABLE CAUSE\s+CORRECTION$/i.test(trimmed.replace(/\s{2,}/g, ' '))) {
      inside = true;
      flush();
      continue;
    }
    if (!inside) continue;
    if (/^DISASSEMBLY$/i.test(trimmed)) { flush(); break; }

    const pageMatch = trimmed.match(/^Page\s+([0-9A-Z-]+)/i);
    if (pageMatch) { pageRef = `Page ${pageMatch[1]}`; continue; }
    if (/^(?:28-21-51\b|SAFRAN AEROTECHNICS$|COMPONENT MAINTENANCE MANUAL$|The data and information|203666\s+203837$)/i.test(trimmed)) continue;

    const cols = trimmed.split(/\s{2,}/).map(safe).filter(Boolean);
    if (cols.length >= 3) {
      flush();
      currentFault = cols[0];
      currentRow = { fault: currentFault, probable_cause: cols[1], correction: cols.slice(2).join(' '), task_ref: null, page_ref: pageRef || null, metadata: {} };
      continue;
    }
    if (cols.length === 2) {
      // A tabela deixa a coluna FAULT vazia nas causas seguintes do mesmo defeito.
      flush();
      currentRow = { fault: currentFault || 'Falha conforme tabela', probable_cause: cols[0], correction: cols[1], task_ref: null, page_ref: pageRef || null, metadata: {} };
      continue;
    }
    if (cols.length === 1 && currentRow && !/^TASK\b|^NOTE\b/i.test(cols[0])) {
      currentRow.correction = `${currentRow.correction || ''} ${cols[0]}`.trim();
    }
  }
  flush();

  return rows
    .filter((row) => row.fault && row.probable_cause && row.fault !== 'FAULT' && row.probable_cause !== 'PROBABLE CAUSE')
    .map((row) => ({ ...row, fault: row.fault.slice(0, 300), probable_cause: row.probable_cause.slice(0, 700), correction: safe(row.correction).slice(0, 1600) }))
    .slice(0, 300);
}

function parseResources(text) {
  const lines = String(text || '').split(/\n/);
  let start = -1;
  lines.forEach((line, index) => {
    if (/^SPECIAL TOOLS\s*-\s*FIXTURES\s*-\s*EQUIPMENT AND CONSUMABLES\s*$/i.test(safe(line))) start = index;
  });
  if (start === -1) return [];

  const out = [];
  let category = 'FERRAMENTA';
  let pageRef = '';
  const ignored = /^(?:\(?\d+\)?\.?|NOTE\s*:|CODE OR|NAME AND|ADDRESS|P\/N|DESCRIPTION|DESIGNATION|RANGE|ACCURACY|BLOCK|WHERE|USED|TASK\b|SAFRAN|COMPONENT MAINTENANCE MANUAL|The data and information|28-21-51|203666\s+203837)$/i;

  for (let i = start + 1; i < lines.length; i += 1) {
    const trimmed = safe(lines[i]);
    if (!trimmed) continue;
    if (/^STORAGE AND TRANSPORTATION$/i.test(trimmed)) break;
    if (/^B\.\s+Special Equipment/i.test(trimmed)) { category = 'EQUIPAMENTO'; continue; }
    if (/^2\.\s+.*CONSUMABLES|^A\.\s+Consumables/i.test(trimmed)) { category = 'CONSUMIVEL'; continue; }
    if (/^A\.\s+Special Fixtures/i.test(trimmed)) { category = 'FERRAMENTA'; continue; }
    const pageMatch = trimmed.match(/^Page\s+([0-9A-Z-]+)/i);
    if (pageMatch) { pageRef = `Page ${pageMatch[1]}`; continue; }
    if (ignored.test(trimmed)) continue;

    // Equipamentos de teste não têm PN: a primeira coluna é a designação.
    if (category === 'EQUIPAMENTO') {
      const cols = trimmed.split(/\s{2,}/).map(safe).filter(Boolean);
      if (cols.length >= 2 && !/^\(/.test(cols[0]) && !/^(?:NOTE|The table|component\.)/i.test(cols[0])) {
        out.push({ categoria: category, pn: null, designacao: cols[0], fornecedor: null, page_ref: pageRef || null, metadata: { raw_line: trimmed } });
      }
      continue;
    }

    let cols = trimmed.split(/\s{2,}/).map(safe).filter(Boolean);
    // Ex.: "ENVIROWASHCleaning system ..." em PDFs cujo texto junta PN e designação.
    if (cols.length >= 2 && cols[0].length > 12) {
      const glued = cols[0].match(/^([A-Z0-9][A-Z0-9\-/.]{2,}?)([A-Z][a-z].*)$/);
      if (glued) cols = [glued[1], glued[2], ...cols.slice(1)];
    }
    if (cols.length < 2) continue;

    let first = cols[0].replace(/^[-–—]\s*/, '').trim();
    let designation = cols[1];
    if (!first || ignored.test(first) || /^(?:The table|component\.|as used|reducing valve)$/i.test(first)) continue;
    if (!designation || /^(?:BLOCK|WHERE|USED)$/i.test(designation)) continue;

    let pn = null;
    if (!/^No specific$/i.test(first)) {
      pn = normalizePn(first);
      if (!/^[A-Z0-9][A-Z0-9\-/. ]{1,60}$/i.test(pn) || /^(?:NOTE|CODE|NAME|ADDRESS)$/i.test(pn)) continue;
    }
    const supplier = cols.length >= 3 && !/^\d{4,5}$/.test(cols[2]) ? cols[2] : null;
    out.push({ categoria: category, pn, designacao: designation.slice(0, 300), fornecedor: supplier, page_ref: pageRef || null, metadata: { raw_line: trimmed } });
  }

  const dedup = new Map();
  out.forEach((row) => dedup.set(`${row.categoria}|${row.pn || ''}|${row.designacao}`, row));
  return Array.from(dedup.values()).slice(0, 1000);
}

function buildSectionChunks(text, sections = []) {
  const raw = String(text || '');
  const labels = sections.length ? sections : [
    'DESCRIPTION AND OPERATION',
    'TESTING AND FAULT ISOLATION',
    'DISASSEMBLY',
    'CLEANING',
    'CHECK',
    'REPAIR',
    'ASSEMBLY',
    'FITS AND CLEARANCES',
    'SPECIAL TOOLS - FIXTURES - EQUIPMENT AND CONSUMABLES',
    'DETAILED PARTS LIST',
  ];

  const lineRows = [];
  let cursor = 0;
  raw.split(/\n/).forEach((line) => {
    lineRows.push({ line: safe(line), offset: cursor });
    cursor += line.length + 1;
  });

  const points = [];
  labels.forEach((label) => {
    const normalizedLabel = label.toUpperCase();
    const matches = lineRows.filter((row) => row.line.toUpperCase() === normalizedLabel);
    if (matches.length) points.push({ label, index: matches[matches.length - 1].offset });
    else {
      const fallback = raw.toUpperCase().lastIndexOf(normalizedLabel);
      if (fallback >= 0) points.push({ label, index: fallback });
    }
  });
  points.sort((a, b) => a.index - b.index);

  const chunks = [];
  points.forEach((point, idx) => {
    const end = points[idx + 1]?.index ?? raw.length;
    const segment = raw.slice(point.index, Math.min(end, point.index + 36000));
    for (let offset = 0, chunkIndex = 0; offset < segment.length && chunkIndex < 18; offset += 1800, chunkIndex += 1) {
      const trecho = compactText(segment.slice(offset, offset + 2200), 2200);
      if (trecho.length < 80) continue;
      const pageMatch = trecho.match(/\b(?:DPL\s+\d+\s+)?Page\s+([0-9A-Z-]+)/i);
      chunks.push({ secao: point.label, page_ref: pageMatch ? `Page ${pageMatch[1]}` : null, chunk_index: chunkIndex, trecho, tokens: tokens(trecho), metadata: {} });
    }
  });
  return chunks.slice(0, 180);
}

async function parseManualTechnicalPdf(buffer, fileName = 'manual.pdf') {
  const fileHash = hashBuffer(buffer);
  const cached = cacheGet(fileHash);
  if (cached) return cached;

  const extraction = await extractPdfText(buffer, fileName);
  const text = extraction.text;
  const code = inferManualCode(text, fileName);
  const metadata = {
    codigo: code || safe(fileName).replace(/\.pdf$/i, '').toUpperCase(),
    tipo_manual: inferManualType(text, code),
    titulo: inferTitle(text, code),
    fabricante: inferManufacturer(text),
    ata_dmc: inferAta(text),
    revisao: inferRevision(text),
    data_revisao: null,
    pns_principais: inferMainPns(text),
    arquivo_nome: fileName,
    arquivo_hash: fileHash,
    metodo_leitura: extraction.method,
    pdf_kind: extraction.pdf_kind || 'DESCONHECIDO',
    parser_version: 'SISHA_28_12B_WTP_V2',
  };

  const dpl = parseDplParts(text);
  metadata.pns_principais = unique([...metadata.pns_principais, ...dpl.filter((r) => /PUMP, ASSY|ASSEMBLY/i.test(r.nomenclatura)).slice(0, 6).map((r) => r.pn)]).slice(0, 20);
  const pnsIndexados = [...dpl];
  metadata.pns_principais.forEach((pn) => {
    if (!pnsIndexados.some((row) => normalizePn(row.pn) === normalizePn(pn))) {
      pnsIndexados.unshift({ pn: normalizePn(pn), fig: null, item: null, nomenclatura: metadata.titulo || 'PN principal do manual', airline_part_no: null, usage_code: null, units_per_assy: null, tipo_vinculo: 'PN_PRINCIPAL', page_ref: 'Title Page', metadata: {} });
    }
  });

  const result = {
    metadata,
    pns: pnsIndexados,
    falhas: parseFaults(text),
    recursos: parseResources(text),
    trechos: buildSectionChunks(text),
    text_preview: compactText(text, 5000),
  };
  cacheSet(fileHash, result);
  return result;
}

module.exports = {
  hashBuffer,
  parseManualTechnicalPdf,
  parseDplParts,
  parseFaults,
  parseResources,
  buildSectionChunks,
};
