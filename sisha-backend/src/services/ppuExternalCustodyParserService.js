const crypto = require('crypto');

function clean(value) {
  return String(value ?? '').trim();
}

function stripAccents(value = '') {
  return clean(value).normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

function normalizeHeader(value = '') {
  return stripAccents(value).toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_|_$/g, '');
}

function isDateLikePnValue(value) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return true;
  const raw = clean(value);
  if (!raw) return false;
  return /^\d{4}[-/]\d{1,2}[-/]\d{1,2}(?:[ T].*)?$/.test(raw) || /^\d{1,2}[/-]\d{1,2}[/-]\d{4}(?:[ T].*)?$/.test(raw);
}

// A coluna PN é uma identidade documental, não um campo de data/número.
// Alguns PNs como "25-2" podem ser coercidos internamente pelo Excel para uma data,
// embora a célula continue exibindo corretamente "25-2". Para PN, portanto,
// priorizamos SEMPRE o texto renderizado da célula (cell.w/format_cell) e só usamos
// o valor retornado por sheet_to_json como fallback.
function getCellDisplayText(xlsx, sheet, rowIndex, colIndex, fallback = '') {
  try {
    const encodeCell = xlsx?.utils?.encode_cell;
    if (sheet && typeof encodeCell === 'function') {
      const address = encodeCell({ r: rowIndex, c: colIndex });
      const cell = sheet[address];
      if (cell) {
        const rendered = clean(cell.w);
        if (rendered) return rendered;
        if (typeof xlsx?.utils?.format_cell === 'function') {
          const formatted = clean(xlsx.utils.format_cell(cell));
          if (formatted) return formatted;
        }
        if (typeof cell.v === 'string' && clean(cell.v)) return clean(cell.v);
      }
    }
  } catch (_) {
    // Fail-safe: o fallback ainda passa pelas validações abaixo.
  }
  return fallback;
}

function normalizePn(value = '') {
  if (isDateLikePnValue(value)) return '';
  return clean(value).toUpperCase().replace(/\s+/g, '');
}

function normalizeLocation(value = '') {
  return stripAccents(value).toUpperCase().replace(/\s+/g, '').replace(/[^A-Z0-9-]/g, '');
}

function normalizeSerial(value = '') {
  return clean(value).toUpperCase().replace(/^\*+/, '').replace(/\s+/g, '');
}

function normalizeNsn(value = '') {
  const raw = clean(value).toUpperCase();
  if (!raw) return null;
  const compact = raw.replace(/[\s.\-/]/g, '');
  if (!compact || /^(?:X+|N\/?A|NA|NI|NIL|NULL|SEM|SN)$/i.test(compact)) return null;
  if (/^X{3,}$/.test(compact)) return null;
  return raw;
}

function canonicalBoxCode(sheetName = '') {
  const match = clean(sheetName).match(/^FECHADA\s+CX\s*[- ]?\s*0*(\d{1,3})\s*$/i);
  if (!match) return null;
  return `CX-${String(Number(match[1])).padStart(3, '0')}`;
}

function parseQuantity(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  let raw = clean(value).replace(/\s+/g, '');
  if (!raw) return null;
  if (raw.includes(',')) raw = raw.replace(/\./g, '').replace(',', '.');
  else if (/^[+-]?\d{1,3}(?:\.\d{3})+$/.test(raw)) raw = raw.replace(/\./g, '');
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

function toEvidenceTimestamp(value) {
  if (!value) return null;
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString();
  if (typeof value === 'number' && Number.isFinite(value)) {
    const millis = Math.round((value - 25569) * 86400 * 1000);
    const date = new Date(millis);
    return Number.isNaN(date.getTime()) ? clean(value) : date.toISOString();
  }
  return clean(value) || null;
}

function buildGroupKey({ pn, originalLocationNormalized, boxCode }) {
  return crypto.createHash('sha256')
    .update(`${normalizePn(pn)}|${normalizeLocation(originalLocationNormalized)}|${clean(boxCode).toUpperCase()}`)
    .digest('hex')
    .slice(0, 32);
}

function findHeaderIndex(rows = []) {
  for (let i = 0; i < Math.min(rows.length, 8); i += 1) {
    const normalized = (rows[i] || []).map(normalizeHeader);
    if (normalized.includes('PN') && normalized.includes('QTD') && normalized.includes('LOCALIZACAO')) return i;
  }
  return -1;
}

function parsePpuExternalCustodyWorkbook(xlsx, workbook) {
  if (!xlsx?.utils?.sheet_to_json || !workbook?.SheetNames || !workbook?.Sheets) {
    throw new Error('Workbook inválido para Backend_Auditoria_Paiol.');
  }

  const items = [];
  const issues = [];
  const boxes = [];
  const ignoredSheets = [];

  for (const sheetName of workbook.SheetNames) {
    const boxCode = canonicalBoxCode(sheetName);
    if (!boxCode) {
      ignoredSheets.push(sheetName);
      issues.push({ sheet: sheetName, row: null, field: 'aba', reason: 'Aba ignorada: esperado FECHADA CX-XXX.' });
      continue;
    }

    const rows = xlsx.utils.sheet_to_json(workbook.Sheets[sheetName], { header: 1, defval: '', raw: false });
    const headerIndex = findHeaderIndex(rows);
    if (headerIndex < 0) {
      boxes.push({ box_code: boxCode, sheet_name: sheetName, item_count: 0, total_quantity: 0, status: 'INVALID_HEADER' });
      issues.push({ sheet: sheetName, row: null, field: 'cabecalho', reason: 'Cabeçalho PN/Qtd/Localizacao não reconhecido.' });
      continue;
    }

    const headers = rows[headerIndex].map(normalizeHeader);
    const index = Object.fromEntries(headers.map((header, idx) => [header, idx]));
    const required = ['DATA_HORA', 'PN', 'NSN', 'NOMENCLATURA', 'QTD', 'SN', 'LOCALIZACAO', 'AUDITOR_NOME', 'AUDITOR_NIP'];
    const missing = required.filter((key) => index[key] === undefined);
    if (missing.length) {
      boxes.push({ box_code: boxCode, sheet_name: sheetName, item_count: 0, total_quantity: 0, status: 'INVALID_HEADER' });
      issues.push({ sheet: sheetName, row: headerIndex + 1, field: 'cabecalho', reason: `Colunas ausentes: ${missing.join(', ')}` });
      continue;
    }

    let boxQty = 0;
    let boxItems = 0;
    let boxSourceRows = 0;
    let boxBlockedItems = 0;
    for (let rowIndex = headerIndex + 1; rowIndex < rows.length; rowIndex += 1) {
      const row = rows[rowIndex] || [];
      const rawPnFallback = row[index.PN];
      const rawPn = getCellDisplayText(xlsx, workbook.Sheets[sheetName], rowIndex, index.PN, rawPnFallback);
      const pnDateLike = isDateLikePnValue(rawPn);
      const pn = normalizePn(rawPn);
      const quantity = parseQuantity(row[index.QTD]);
      const originalLocation = clean(row[index.LOCALIZACAO]);
      const hasAny = row.some((cell) => clean(cell));
      if (!hasAny) continue;
      boxSourceRows += 1;

      if (!pn || !quantity || quantity <= 0 || !originalLocation) {
        boxBlockedItems += 1;
        issues.push({
          sheet: sheetName,
          row: rowIndex + 1,
          field: !pn ? 'PN' : !originalLocation ? 'Localizacao' : 'Qtd',
          value: !pn ? rawPn : !originalLocation ? row[index.LOCALIZACAO] : row[index.QTD],
          reason: pnDateLike
            ? 'Linha bloqueada: o PN chegou apenas como data completa e não foi possível recuperar um texto documental exibido pela célula.'
            : 'Linha bloqueada: PN, quantidade positiva e localização original são obrigatórios.',
        });
        continue;
      }

      const originalLocationNormalized = normalizeLocation(originalLocation);
      const item = {
        box_code: boxCode,
        sheet_name: sheetName,
        source_row: rowIndex + 1,
        evidence_at: toEvidenceTimestamp(row[index.DATA_HORA]),
        pn,
        pn_original: clean(rawPn) || null,
        nsn_original: clean(row[index.NSN]) || null,
        nsn_normalized: normalizeNsn(row[index.NSN]),
        nomenclature: clean(row[index.NOMENCLATURA]) || null,
        quantity,
        sn: normalizeSerial(row[index.SN]) || null,
        original_location: originalLocation,
        original_location_normalized: originalLocationNormalized,
        auditor_name: clean(row[index.AUDITOR_NOME]) || null,
        auditor_nip: clean(row[index.AUDITOR_NIP]) || null,
      };
      item.group_key = buildGroupKey({ pn, originalLocationNormalized, boxCode });
      item.source_fingerprint = crypto.createHash('sha256')
        .update(`${sheetName}|${rowIndex + 1}|${pn}|${quantity}|${originalLocationNormalized}|${item.sn || ''}|${item.evidence_at || ''}`)
        .digest('hex');
      items.push(item);
      boxQty += quantity;
      boxItems += 1;
    }

    boxes.push({
      box_code: boxCode,
      sheet_name: sheetName,
      source_row_count: boxSourceRows,
      item_count: boxItems,
      blocked_item_count: boxBlockedItems,
      total_quantity: boxQty,
      status: 'FECHADA',
    });
  }

  const groups = new Map();
  items.forEach((item) => {
    if (!groups.has(item.group_key)) {
      groups.set(item.group_key, {
        group_key: item.group_key,
        pn: item.pn,
        box_code: item.box_code,
        original_location: item.original_location,
        original_location_normalized: item.original_location_normalized,
        quantity: 0,
        row_count: 0,
      });
    }
    const group = groups.get(item.group_key);
    group.quantity += Number(item.quantity || 0);
    group.row_count += 1;
  });

  return {
    format: 'BACKEND_AUDITORIA_PAIOL_FECHADA_CX',
    items,
    groups: Array.from(groups.values()),
    boxes,
    issues,
    summary: {
      sheets_total: workbook.SheetNames.length,
      closed_boxes: boxes.length,
      boxes_with_items: boxes.filter((box) => Number(box.source_row_count || 0) > 0).length,
      boxes_with_valid_items: boxes.filter((box) => Number(box.item_count || 0) > 0).length,
      boxes_with_pending_items: boxes.filter((box) => Number(box.blocked_item_count || 0) > 0).length,
      empty_boxes: boxes.filter((box) => Number(box.source_row_count || 0) === 0 && box.status === 'FECHADA').length,
      invalid_boxes: boxes.filter((box) => box.status !== 'FECHADA').length,
      ignored_sheets: ignoredSheets.length,
      item_rows: items.length,
      total_quantity: Number(items.reduce((sum, item) => sum + Number(item.quantity || 0), 0).toFixed(6)),
      groups: groups.size,
      issues: issues.length,
    },
  };
}

module.exports = {
  normalizeHeader,
  isDateLikePnValue,
  getCellDisplayText,
  normalizePn,
  normalizeLocation,
  normalizeSerial,
  normalizeNsn,
  canonicalBoxCode,
  parseQuantity,
  buildGroupKey,
  parsePpuExternalCustodyWorkbook,
};
