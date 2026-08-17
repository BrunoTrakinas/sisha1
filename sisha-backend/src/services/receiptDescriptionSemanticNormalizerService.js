function compact(value = '') {
  return String(value || '')
    .replace(/[\u00a0\u2007\u202f]/g, ' ')
    .replace(/[\u2010\u2011\u2012\u2013\u2014\u2212]/g, '-')
    .replace(/\s+/g, ' ')
    .trim();
}

const CONTRACT_PATTERN_SOURCE = String.raw`\d{4,6}\/\d{4}-\d{3}(?:\/\d{2})?`;
const CONTRACT_RE = new RegExp(`\\b(${CONTRACT_PATTERN_SOURCE})\\b`, 'i');
const ORDER_RE = /\b(P\d{4}-\d{4}(?:\/\d+)?)\b/i;
const ITEM_RE = /\bITEM\s*:?[\s-]*(\d+)\b/i;
const SN_MARKER_RE = /\b(?:S\s*\/\s*N|SN)\.?(?:\s*[º°])?\s*[:\-]?\s*/i;
const REF_MARKER_RE = /\b(?:CUST(?:OMER)?\.?\s*REF\.?|REF\.?)\s*:/i;
const FOC_RE = /\bF\s*\.?\s*O\s*\.?\s*C\s*\.?\b/i;
const FREE_OF_CHARGE_RE = /\bTHIS\s+ITEM\s+IS\s+(?:FREE\s+OF\s+CHARGE|FOC)\b/i;
const WARRANTY_RE = /\bWARRANTY(?:\s+SPARES)?\b/i;
const AIRCRAFT_WARRANTY_RE = /\bN\s*[- ]\s*(\d{4})\s+WARRANTY(?:\s+SPARES)?\b/i;
const AUX_CODE_RE = /\(([A-Z][A-Z0-9-]{4,})\)/i;
const COMPACT_PLANNING_RE = /\b((?:BRAZIL|BRASIL)\s*7\s*&\s*8\s*PLANNING\s*REMOVAL\s*(?:\(\s*\d+\s*\))?)/i;
const EXPIRING_BS_RE = /\b((?:BRAZIL|BRASIL)\s+EXPIRING\s+BS\s+\d+\s+YEARS?\s+STOCK)\b/i;
const RADALT_RE = /\b((?:BRAZIL|BRASIL)\s*-\s*RADALT\s+TI\s+PARTS)\b/i;

function firstMatch(text, patterns) {
  let best = null;
  for (const [type, pattern] of patterns) {
    pattern.lastIndex = 0;
    const match = pattern.exec(text);
    if (!match) continue;
    if (!best || match.index < best.match.index) best = { type, match };
  }
  return best;
}

function markerCutIndex(source, index) {
  let cut = Number(index);
  if (!Number.isFinite(cut) || cut < 0) return source.length;
  const prefix = source.slice(0, cut);
  const separator = /\s*[-–—]\s*$/.exec(prefix);
  if (separator) return separator.index;
  while (cut > 0 && /\s/.test(source[cut - 1])) cut -= 1;
  return cut;
}

function programMatch(text = '') {
  return firstMatch(text, [
    ['PLANNING_REMOVAL', COMPACT_PLANNING_RE],
    ['EXPIRING_BS', EXPIRING_BS_RE],
    ['RADALT', RADALT_RE],
  ]);
}

function canonicalProgram(raw = '') {
  const text = compact(raw);
  if (!text) return null;
  const planning = COMPACT_PLANNING_RE.exec(text);
  if (planning) {
    const ref = /\(\s*(\d+)\s*\)/.exec(planning[1])?.[1];
    return `Brazil 7 & 8 planning removal${ref ? ` (${ref})` : ''}`;
  }
  return text;
}

function normalizeSerialToken(value = '') {
  return compact(value)
    .toUpperCase()
    .replace(/^[*#]+/, '')
    .replace(/(?:\s*-\s*)?F\s*\.?\s*O\s*\.?\s*C\s*\.?$/i, '')
    .replace(/^[.\-\s]+|[.\-\s]+$/g, '')
    .trim();
}

function serialBoundaryPatterns() {
  return [
    ['REFERENCE', REF_MARKER_RE],
    ['FOC', FOC_RE],
    ['FREE_OF_CHARGE', FREE_OF_CHARGE_RE],
    ['WARRANTY', WARRANTY_RE],
    ['PLANNING_REMOVAL', COMPACT_PLANNING_RE],
    ['EXPIRING_BS', EXPIRING_BS_RE],
    ['RADALT', RADALT_RE],
    ['ITEM', ITEM_RE],
    ['ORDER', ORDER_RE],
    ['CONTRACT', CONTRACT_RE],
    ['AIRCRAFT_WARRANTY', AIRCRAFT_WARRANTY_RE],
    ['AUX_CODE', AUX_CODE_RE],
  ];
}

function collapseShadowDuplicateSerials(serials = []) {
  const unique = [...new Set(serials)];
  const exact = new Set(unique);

  return unique.filter((candidate) => {
    // Recibos podem repetir o mesmo SN e acrescentar uma anotação documental
    // depois de um hífen separado por espaços: "SN001 - anotação documental".
    // Se o SN-base já foi extraído de forma inequívoca no mesmo campo, o
    // candidato alongado é apenas uma duplicata anotada, não outra identidade.
    // Hífens internos normais (ex.: AB-123) não entram nesta regra.
    const shadow = /^(.*?)\s+-\s+(.+)$/.exec(candidate);
    if (!shadow) return true;

    const base = normalizeSerialToken(shadow[1]);
    return !base || base === candidate || !exact.has(base);
  });
}

function extractSerialsFromDescription(value = '') {
  const source = compact(value);
  const marker = SN_MARKER_RE.exec(source);
  if (!marker) return [];

  let serialText = source.slice(marker.index + marker[0].length);
  let first = serialText.length;
  for (const [, pattern] of serialBoundaryPatterns()) {
    pattern.lastIndex = 0;
    const match = pattern.exec(serialText);
    if (match && match.index < first) first = match.index;
  }
  serialText = serialText.slice(0, first)
    .replace(/\s*[-–—]\s*$/, '')
    .replace(/[.;]+$/, '')
    .trim();

  const serials = serialText
    .replace(/\s+(?:E|AND)\s+/gi, ',')
    .split(/[,;|]+/)
    .map(normalizeSerialToken)
    .filter((serial) => serial && !/^(?:N\/?A|NA|SEM\s+S\/?N|S\/?N|-)$/.test(serial));

  return collapseShadowDuplicateSerials(serials);
}

function normalizeSerialField(value = '') {
  const raw = compact(value);
  if (!raw) return '';
  const parsed = extractSerialsFromDescription(`S/N ${raw}`);
  return parsed.length ? parsed.join(', ') : normalizeSerialToken(raw);
}

function extractReference(text = '') {
  const source = compact(text);
  const marker = REF_MARKER_RE.exec(source);
  if (!marker) return null;
  let rest = source.slice(marker.index + marker[0].length);
  let first = rest.length;
  for (const [, pattern] of [
    ['SN', SN_MARKER_RE],
    ['FOC', FOC_RE],
    ['FREE', FREE_OF_CHARGE_RE],
    ['WARRANTY', WARRANTY_RE],
    ['PROGRAM', COMPACT_PLANNING_RE],
    ['PROGRAM_BS', EXPIRING_BS_RE],
    ['PROGRAM_RADALT', RADALT_RE],
    ['ITEM', ITEM_RE],
    ['ORDER', ORDER_RE],
  ]) {
    pattern.lastIndex = 0;
    const match = pattern.exec(rest);
    if (match && match.index < first) first = match.index;
  }
  return compact(rest.slice(0, first))
    .replace(/\s*[-–—]\s*$/, '')
    .replace(/[.;,]+$/, '') || null;
}

function cleanTechnicalNomenclature(value = '') {
  const source = compact(value);
  if (!source) return '';

  const markers = [
    ['SN', SN_MARKER_RE],
    ['REFERENCE', REF_MARKER_RE],
    ['FOC', FOC_RE],
    ['FREE_OF_CHARGE', FREE_OF_CHARGE_RE],
    ['AIRCRAFT_WARRANTY', AIRCRAFT_WARRANTY_RE],
    ['WARRANTY', WARRANTY_RE],
    ['PLANNING_REMOVAL', COMPACT_PLANNING_RE],
    ['EXPIRING_BS', EXPIRING_BS_RE],
    ['RADALT', RADALT_RE],
    ['ORDER', ORDER_RE],
    ['ITEM', ITEM_RE],
    ['CONTRACT', CONTRACT_RE],
  ];

  const found = firstMatch(source, markers);
  const cut = found ? markerCutIndex(source, found.match.index) : source.length;
  const cleaned = compact(source.slice(0, cut))
    .replace(/[|]+$/g, '')
    .replace(/[;,:\s\-–—]+$/g, '')
    .trim();
  return cleaned || source;
}

function analyzeReceiptDescription(value = '') {
  const original = compact(value);
  const contract = CONTRACT_RE.exec(original)?.[1]?.toUpperCase() || null;
  const order = ORDER_RE.exec(original)?.[1]?.toUpperCase() || null;
  const item = ITEM_RE.exec(original)?.[1] || null;
  const pMatch = programMatch(original);
  const rawProgram = pMatch?.match?.[1] || null;
  const program = canonicalProgram(rawProgram);
  const aircraftContext = AIRCRAFT_WARRANTY_RE.exec(original)?.[1] || null;
  const auxCode = AUX_CODE_RE.exec(original)?.[1]?.toUpperCase() || null;
  const reference = extractReference(original);
  const serials = extractSerialsFromDescription(original);

  return {
    original,
    nomenclatura: cleanTechnicalNomenclature(original),
    serials,
    contract,
    order,
    item,
    program,
    programRaw: rawProgram,
    aircraftContext: aircraftContext ? `N-${aircraftContext}` : null,
    auxCode,
    reference,
    isFoc: FOC_RE.test(original) || FREE_OF_CHARGE_RE.test(original),
    warranty: WARRANTY_RE.test(original),
  };
}

function metadataResidueKinds(value = '', { serial = false } = {}) {
  const text = compact(value);
  if (!text) return [];
  const checks = [
    ['SN', SN_MARKER_RE],
    ['CONTRATO', CONTRACT_RE],
    ['OC', ORDER_RE],
    ['ITEM', ITEM_RE],
    ['REFERENCIA', REF_MARKER_RE],
    ['FOC', FOC_RE],
    ['GRATUIDADE', FREE_OF_CHARGE_RE],
    ['GARANTIA', WARRANTY_RE],
    ['PROGRAMA_PLANNING', COMPACT_PLANNING_RE],
    ['PROGRAMA_BS', EXPIRING_BS_RE],
    ['PROGRAMA_RADALT', RADALT_RE],
    ['CONTEXTO_AERONAVE', AIRCRAFT_WARRANTY_RE],
  ];
  if (serial) checks.push(['CODIGO_AUXILIAR', AUX_CODE_RE]);
  return checks.filter(([, pattern]) => {
    pattern.lastIndex = 0;
    return pattern.test(text);
  }).map(([kind]) => kind);
}

module.exports = {
  compact,
  CONTRACT_PATTERN_SOURCE,
  analyzeReceiptDescription,
  cleanTechnicalNomenclature,
  extractSerialsFromDescription,
  normalizeSerialField,
  normalizeSerialToken,
  metadataResidueKinds,
};
