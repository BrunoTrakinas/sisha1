const crypto = require('crypto');

const AIRCRAFT_SHEET = /^\d{4}$/;
const TOTAL_COLUMNS = ['Y', 'U', 'Q', 'M', 'I', 'E'];
const DATE_COLUMNS = ['X', 'T', 'P', 'L', 'H'];

function clean(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function upper(value) {
  return clean(value).toUpperCase();
}

function excelSerialToIso(value) {
  const num = Number(value);
  if (!Number.isFinite(num) || num <= 0) return null;
  const millis = Math.round((num - 25569) * 86400 * 1000);
  const date = new Date(millis);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString().slice(0, 10);
}

function parseDateCell(cell) {
  if (!cell || cell.v === null || cell.v === undefined || cell.v === '') return null;
  if (cell.v instanceof Date && !Number.isNaN(cell.v.getTime())) return cell.v.toISOString().slice(0, 10);
  if (typeof cell.v === 'number') return excelSerialToIso(cell.v);
  const text = clean(cell.w ?? cell.v);
  const br = text.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/);
  if (br) {
    const [, d, m, rawY] = br;
    const y = rawY.length === 2 ? `20${rawY}` : rawY;
    return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  }
  const iso = text.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  return null;
}

function parseDurationText(value) {
  const text = clean(value);
  const match = text.match(/^(\d+):([0-5]\d)(?::([0-5]\d))?$/);
  if (!match) return null;
  return Number(match[1]) + Number(match[2]) / 60 + Number(match[3] || 0) / 3600;
}

function numericCell(cell, { hours = false } = {}) {
  if (!cell || cell.v === null || cell.v === undefined || cell.v === '') return null;
  const displayedHours = hours ? parseDurationText(cell.w ?? '') : null;
  if (displayedHours !== null) return Number(displayedHours.toFixed(4));

  const num = Number(cell.v);
  if (!Number.isFinite(num)) return null;
  if (!hours) return Number(num.toFixed(4));

  const format = String(cell.z || '').toLowerCase();
  const formattedAsTime = /\[h+\]|h:mm|hh:mm/.test(format);
  const value = formattedAsTime ? num * 24 : num;
  return Number(value.toFixed(4));
}

function cell(sheet, address) {
  return sheet?.[address] || null;
}

function sheetRange(sheet) {
  const ref = String(sheet?.['!ref'] || 'A1:A1');
  const end = ref.split(':').pop() || 'A1';
  const match = end.match(/([A-Z]+)(\d+)/i);
  return match ? Number(match[2]) : 1;
}

function findTotal(sheet, row, { hours = false } = {}) {
  for (const column of TOTAL_COLUMNS) {
    const address = `${column}${row}`;
    const item = cell(sheet, address);
    const value = numericCell(item, { hours });
    if (value !== null) return { value, address, raw: clean(item?.w ?? item?.v), format: clean(item?.z) || null };
  }
  return { value: null, address: null, raw: null, format: null };
}

function findObservedDate(sheet, headerRow) {
  const candidates = DATE_COLUMNS
    .map((column) => ({ address: `${column}${headerRow}`, value: parseDateCell(cell(sheet, `${column}${headerRow}`)) }))
    .filter((item) => item.value);
  if (!candidates.length) return { value: null, address: null };
  candidates.sort((a, b) => String(a.value).localeCompare(String(b.value)));
  return candidates[candidates.length - 1];
}

function metric(sheet, row, key, options = {}) {
  const total = findTotal(sheet, row, options);
  return { key, value: total.value, source_cell: total.address, raw_value: total.raw, raw_format: total.format };
}

function parseRunningLogSheet(sheet, aircraftCode) {
  const snapshots = [];
  const issues = [];
  const maxRow = sheetRange(sheet);

  for (let row = 1; row <= maxRow; row += 1) {
    if (upper(cell(sheet, `A${row}`)?.w ?? cell(sheet, `A${row}`)?.v) !== 'AIRCRAFT TOTAL HOURS') continue;

    const observed = findObservedDate(sheet, Math.max(1, row - 3));
    const metrics = [
      metric(sheet, row, 'AIRCRAFT_HOURS', { hours: true }),
      metric(sheet, row + 4, 'LANDINGS'),
      metric(sheet, row + 5, 'AUTOROTATIONS'),
      metric(sheet, row + 6, 'ROTOR_STOP_STARTS'),
      metric(sheet, row + 7, 'ENGINE_1_HOURS', { hours: true }),
      metric(sheet, row + 8, 'ENGINE_1_STARTS'),
      metric(sheet, row + 9, 'ENGINE_1_POWER_TURBINE_CYCLES'),
      metric(sheet, row + 10, 'ENGINE_1_GAS_GENERATOR_CYCLES'),
      metric(sheet, row + 13, 'ENGINE_2_HOURS', { hours: true }),
      metric(sheet, row + 14, 'ENGINE_2_STARTS'),
      metric(sheet, row + 15, 'ENGINE_2_POWER_TURBINE_CYCLES'),
      metric(sheet, row + 16, 'ENGINE_2_GAS_GENERATOR_CYCLES'),
    ];

    const metricMap = Object.fromEntries(metrics.map((item) => [item.key, item.value]));
    const hasUsefulValue = metrics.some((item) => Number.isFinite(item.value) && item.value > 0);
    if (!observed.value && !hasUsefulValue) continue;
    if (!observed.value) {
      issues.push({ aircraft_code: aircraftCode, row, reason: 'Bloco do Livro dos Motores possui valores, mas não contém data observacional confiável.' });
      continue;
    }

    const invalid = metrics.filter((item) => item.value !== null && (!Number.isFinite(item.value) || item.value < 0));
    snapshots.push({
      aircraft_code: aircraftCode,
      source_observed_at: observed.value,
      source_date_cell: observed.address,
      source_block_row: row,
      aircraft_hours: metricMap.AIRCRAFT_HOURS,
      landings: metricMap.LANDINGS,
      autorotations: metricMap.AUTOROTATIONS,
      rotor_stop_starts: metricMap.ROTOR_STOP_STARTS,
      engine_1_hours: metricMap.ENGINE_1_HOURS,
      engine_1_starts: metricMap.ENGINE_1_STARTS,
      engine_1_power_turbine_cycles: metricMap.ENGINE_1_POWER_TURBINE_CYCLES,
      engine_1_gas_generator_cycles: metricMap.ENGINE_1_GAS_GENERATOR_CYCLES,
      engine_2_hours: metricMap.ENGINE_2_HOURS,
      engine_2_starts: metricMap.ENGINE_2_STARTS,
      engine_2_power_turbine_cycles: metricMap.ENGINE_2_POWER_TURBINE_CYCLES,
      engine_2_gas_generator_cycles: metricMap.ENGINE_2_GAS_GENERATOR_CYCLES,
      source_cells: Object.fromEntries(metrics.map((item) => [item.key, {
        cell: item.source_cell,
        raw_value: item.raw_value,
        raw_format: item.raw_format,
      }])),
      quality: {
        status: invalid.length ? 'REVIEW' : 'VALID',
        invalid_metrics: invalid.map((item) => item.key),
      },
    });
  }

  return { snapshots, issues };
}

function parseRunningLogWorkbook(workbook, sourceDocument = 'LIVRO DOS MOTORES.xlsx') {
  if (!workbook || !Array.isArray(workbook.SheetNames)) throw new Error('LIVRO DOS MOTORES inválido.');
  const snapshots = [];
  const issues = [];

  workbook.SheetNames.filter((name) => AIRCRAFT_SHEET.test(String(name))).forEach((sheetName) => {
    const parsed = parseRunningLogSheet(workbook.Sheets[sheetName], sheetName);
    parsed.snapshots.forEach((snapshot) => snapshots.push({ ...snapshot, source_sheet: sheetName, source_document: sourceDocument }));
    parsed.issues.forEach((issue) => issues.push({ ...issue, source_sheet: sheetName }));
  });

  snapshots.sort((a, b) => `${a.aircraft_code}:${a.source_observed_at}:${a.source_block_row}`.localeCompare(`${b.aircraft_code}:${b.source_observed_at}:${b.source_block_row}`));
  return {
    source_document: sourceDocument,
    snapshots,
    issues,
    summary: {
      aircraft_count: new Set(snapshots.map((item) => item.aircraft_code)).size,
      snapshots: snapshots.length,
      issues: issues.length,
    },
  };
}

function sourceHash(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

async function importRunningLogAtomic(parsed, { buffer, fileName, user = {}, requestId = null } = {}) {
  const supabase = require('../config/supabaseClient');
  const hash = sourceHash(buffer);
  const { data, error } = await supabase.rpc('sisha_import_aircraft_running_log_atomic', {
    p_source_document: fileName || parsed.source_document || 'LIVRO DOS MOTORES.xlsx',
    p_source_sha256: hash,
    p_snapshots: parsed.snapshots || [],
    p_actor_email: user.email || null,
    p_actor_role: user.role || null,
    p_request_id: requestId || null,
  });
  if (error) throw error;
  return { ...(data || {}), source_sha256: hash, parser_summary: parsed.summary, issues: parsed.issues || [] };
}

module.exports = {
  excelSerialToIso,
  parseDurationText,
  numericCell,
  parseRunningLogSheet,
  parseRunningLogWorkbook,
  sourceHash,
  importRunningLogAtomic,
};
