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

function normalizePn(value = '') {
  return clean(value).toUpperCase().replace(/\s+/g, '');
}

function normalizeReceipt(value = '') {
  return clean(value).toUpperCase().replace(/\s+/g, '').replace(/\\/g, '/');
}

function parseQuantity(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  let raw = clean(value).replace(/\s+/g, '');
  if (!raw) return null;
  if (raw.includes(',')) raw = raw.replace(/\./g, '').replace(',', '.');
  else if (/^[+-]?\d{1,3}(?:\.\d{3})+$/.test(raw)) raw = raw.replace(/\./g, '');
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

function normalizeLocation(value = '') {
  return stripAccents(value).toUpperCase().replace(/\s+/g, ' ').trim();
}

function validLocation(value = '') {
  const normalized = normalizeLocation(value);
  return Boolean(normalized && normalized !== '-' && normalized !== 'N/A' && normalized !== 'NA');
}

function extractBoxCode(value = '') {
  const normalized = normalizeLocation(value);
  if (!normalized) return null;
  const match = normalized.match(/(?:CAIXA|CX)\s*[-#:]?\s*0*(\d{1,3})\b/);
  if (!match) return null;
  return `CX-${String(Number(match[1])).padStart(3, '0')}`;
}

function classifyLocation(value = '') {
  const normalized = normalizeLocation(value);
  if (!validLocation(normalized)) return 'PENDENTE';
  if (normalized.includes('CEIMSPA')) return 'CEIMSPA';
  if (extractBoxCode(normalized)) return 'CAIXA';
  return 'PPU';
}

function excelDateToIso(value) {
  if (value === null || value === undefined || value === '') return null;
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString();
  if (typeof value === 'number' && Number.isFinite(value)) {
    const date = new Date(Math.round((value - 25569) * 86400 * 1000));
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }
  const text = clean(value);
  if (!text) return null;
  const br = text.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{2}|\d{4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?$/);
  if (br) {
    let [, d, m, y, hh = '00', mm = '00', ss = '00'] = br;
    if (y.length === 2) y = Number(y) > 50 ? `19${y}` : `20${y}`;
    const date = new Date(Date.UTC(Number(y), Number(m) - 1, Number(d), Number(hh), Number(mm), Number(ss)));
    return Number.isNaN(date.getTime()) ? text : date.toISOString();
  }
  const parsed = new Date(text);
  return Number.isNaN(parsed.getTime()) ? text : parsed.toISOString();
}

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
    // fallback abaixo
  }
  return fallback;
}

function findHeaderIndex(rows = []) {
  for (let i = 0; i < Math.min(rows.length, 12); i += 1) {
    const normalized = (rows[i] || []).map(normalizeHeader);
    const hasReceipt = normalized.includes('RECIBO');
    const hasPn = normalized.includes('PN');
    const hasQty = normalized.includes('QTD') || normalized.includes('QUANTIDADE');
    const hasAudit = normalized.includes('QTD_AUDITADA') || normalized.includes('QUANTIDADE_AUDITADA');
    if (hasReceipt && hasPn && hasQty && hasAudit) return i;
  }
  return -1;
}

function indexByAliases(headers = [], aliases = []) {
  for (const alias of aliases) {
    const idx = headers.indexOf(normalizeHeader(alias));
    if (idx >= 0) return idx;
  }
  return -1;
}

function parseLocrecRows(rows = [], { xlsx = null, sheet = null, headerIndex = null, sheetName = 'Planilha1' } = {}) {
  const resolvedHeader = Number.isInteger(headerIndex) ? headerIndex : findHeaderIndex(rows);
  if (resolvedHeader < 0) throw new Error('Cabeçalho LOCREC não reconhecido. Esperado: Recibo, PN, Qtd e QTD Auditada.');

  const headers = (rows[resolvedHeader] || []).map(normalizeHeader);
  const index = {
    recibo: indexByAliases(headers, ['RECIBO']),
    pd: indexByAliases(headers, ['PD', 'PEDIDO']),
    pn: indexByAliases(headers, ['PN', 'P/N', 'PART NUMBER']),
    qtd: indexByAliases(headers, ['QTD', 'QUANTIDADE']),
    qtdAuditada: indexByAliases(headers, ['QTD AUDITADA', 'QUANTIDADE AUDITADA']),
    loc: indexByAliases(headers, ['LOC ESCOLHIDA', 'LOCAL ESCOLHIDO', 'LOCALIZACAO', 'LOCALIZAÇÃO']),
    nip: indexByAliases(headers, ['NIP']),
    data: indexByAliases(headers, ['DATA']),
    restante: indexByAliases(headers, ['RESTANTE', 'SALDO']),
  };

  const missing = ['recibo', 'pn', 'qtd', 'qtdAuditada'].filter((key) => index[key] < 0);
  if (missing.length) throw new Error(`Colunas obrigatórias LOCREC ausentes: ${missing.join(', ')}.`);

  const items = [];
  const issues = [];

  for (let rowIndex = resolvedHeader + 1; rowIndex < rows.length; rowIndex += 1) {
    const row = rows[rowIndex] || [];
    if (!row.some((cell) => clean(cell))) continue;

    const displayPn = xlsx && sheet
      ? getCellDisplayText(xlsx, sheet, rowIndex, index.pn, row[index.pn])
      : row[index.pn];
    const displayNip = index.nip >= 0 && xlsx && sheet
      ? getCellDisplayText(xlsx, sheet, rowIndex, index.nip, row[index.nip])
      : (index.nip >= 0 ? row[index.nip] : null);

    const numeroRecibo = normalizeReceipt(row[index.recibo]);
    const pn = normalizePn(displayPn);
    const qtd = parseQuantity(row[index.qtd]);
    const qtdAuditadaOriginal = parseQuantity(row[index.qtdAuditada]);
    const locEscolhida = index.loc >= 0 ? clean(row[index.loc]) || null : null;

    if (!numeroRecibo || !pn || qtd === null || qtd <= 0) {
      issues.push({
        sheet: sheetName,
        row: rowIndex + 1,
        field: !numeroRecibo ? 'Recibo' : !pn ? 'PN' : 'Qtd',
        value: !numeroRecibo ? row[index.recibo] : !pn ? displayPn : row[index.qtd],
        reason: 'Linha bloqueada: Recibo, PN e Qtd positiva são obrigatórios.',
      });
      continue;
    }

    if (qtdAuditadaOriginal !== null && qtdAuditadaOriginal < 0) {
      issues.push({ sheet: sheetName, row: rowIndex + 1, field: 'QTD Auditada', value: row[index.qtdAuditada], reason: 'QTD Auditada negativa não é válida.' });
      continue;
    }

    const qtdAuditadaAplicada = qtdAuditadaOriginal === null ? 0 : Math.min(qtd, qtdAuditadaOriginal);
    const restanteOriginal = index.restante >= 0 ? parseQuantity(row[index.restante]) : null;
    const restanteCalculado = qtdAuditadaOriginal === null ? null : Math.max(0, qtd - qtdAuditadaAplicada);
    const destinoIndicado = qtdAuditadaAplicada > 0 && validLocation(locEscolhida)
      ? classifyLocation(locEscolhida)
      : 'PENDENTE';
    const boxCode = extractBoxCode(locEscolhida);

    const item = {
      sheet_name: sheetName,
      source_row: rowIndex + 1,
      numero_recibo: numeroRecibo,
      pd: index.pd >= 0 ? clean(row[index.pd]) || null : null,
      pn,
      qtd_documental: qtd,
      qtd_auditada_original: qtdAuditadaOriginal,
      qtd_auditada_aplicada: qtdAuditadaAplicada,
      loc_escolhida: locEscolhida,
      loc_normalizada: normalizeLocation(locEscolhida) || null,
      destino_indicado: destinoIndicado,
      box_code: boxCode,
      nip: clean(displayNip) || null,
      data_auditoria: index.data >= 0 ? excelDateToIso(row[index.data]) : null,
      restante_original: restanteOriginal,
      restante_calculado: restanteCalculado,
    };
    item.source_fingerprint = crypto.createHash('sha256')
      .update(`${sheetName}|${item.source_row}|${numeroRecibo}|${pn}|${qtd}|${qtdAuditadaOriginal ?? ''}|${item.loc_normalizada || ''}|${item.nip || ''}|${item.data_auditoria || ''}`)
      .digest('hex');
    items.push(item);
  }

  const receipts = new Set(items.map((item) => item.numero_recibo));
  const pns = new Set(items.map((item) => item.pn));
  return {
    format: 'LOCREC_CONSULTIVO_V1',
    items,
    issues,
    summary: {
      source_rows: Math.max(0, rows.length - resolvedHeader - 1),
      valid_rows: items.length,
      blocked_rows: issues.length,
      receipts: receipts.size,
      pns: pns.size,
      audited_rows: items.filter((item) => Number(item.qtd_auditada_aplicada) > 0).length,
      pending_rows: items.filter((item) => Number(item.qtd_auditada_aplicada) <= 0 || item.destino_indicado === 'PENDENTE').length,
      ppu_rows: items.filter((item) => item.destino_indicado === 'PPU').length,
      box_rows: items.filter((item) => item.destino_indicado === 'CAIXA').length,
      ceimspa_rows: items.filter((item) => item.destino_indicado === 'CEIMSPA').length,
      audited_quantity: Number(items.reduce((sum, item) => sum + Number(item.qtd_auditada_aplicada || 0), 0).toFixed(6)),
    },
  };
}

function parseLocrecWorkbook(xlsx, workbook) {
  if (!xlsx?.utils?.sheet_to_json || !workbook?.SheetNames || !workbook?.Sheets) {
    throw new Error('Workbook LOCREC inválido.');
  }
  const sheetName = workbook.SheetNames.find((name) => {
    const rows = xlsx.utils.sheet_to_json(workbook.Sheets[name], { header: 1, defval: '', raw: true });
    return findHeaderIndex(rows) >= 0;
  });
  if (!sheetName) throw new Error('Nenhuma aba LOCREC com cabeçalho válido foi encontrada.');
  const sheet = workbook.Sheets[sheetName];
  const rows = xlsx.utils.sheet_to_json(sheet, { header: 1, defval: '', raw: true });
  return parseLocrecRows(rows, { xlsx, sheet, sheetName });
}

module.exports = {
  clean,
  normalizeHeader,
  normalizePn,
  normalizeReceipt,
  parseQuantity,
  normalizeLocation,
  validLocation,
  extractBoxCode,
  classifyLocation,
  parseLocrecRows,
  parseLocrecWorkbook,
};
