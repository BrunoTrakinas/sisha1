const crypto = require('crypto');

const AIRCRAFT_SHEET_PATTERN = /^\d{4}$/;
const ALLOWED_STATUS = new Set(['D', 'I', 'UNKNOWN']);
const ERROR_TOKEN = /^#(?:N\/A|VALUE!|VALOR!|REF!|DIV\/0!|NAME\?|NOME\?|NUM!|NULL!)/i;

function getSupabase() {
  // Lazy require: parsers permanecem puros/testáveis sem abrir data-plane.
  return require('../config/supabaseClient');
}

function normalizeText(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function upper(value) {
  return normalizeText(value).toUpperCase();
}

function normalizeStatus(value) {
  const text = upper(value).replace(/[“”"']/g, '');
  if (text === 'D') return 'D';
  if (text === 'I') return 'I';
  return 'UNKNOWN';
}

function excelSerialToIso(value) {
  const num = Number(value);
  if (!Number.isFinite(num) || num <= 0) return null;
  const millis = Math.round((num - 25569) * 86400 * 1000);
  const date = new Date(millis);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString().slice(0, 10);
}

function excelSerialToIsoDateTime(value) {
  const num = Number(value);
  if (!Number.isFinite(num) || num <= 0) return null;
  const millis = Math.round((num - 25569) * 86400 * 1000);
  const date = new Date(millis);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString();
}

function columnName(index) {
  let n = Number(index) + 1;
  let out = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    out = String.fromCharCode(65 + rem) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

function address(rowIndex, colIndex) {
  return `${columnName(colIndex)}${rowIndex + 1}`;
}

function cell(sheet, rowIndex, colIndex) {
  return sheet?.[address(rowIndex, colIndex)] || null;
}

function cellValue(sheet, rowIndex, colIndex) {
  return cell(sheet, rowIndex, colIndex)?.v ?? null;
}

function cellDisplay(sheet, rowIndex, colIndex) {
  const item = cell(sheet, rowIndex, colIndex);
  if (!item) return '';
  return normalizeText(item.w ?? item.v ?? '');
}

function cellFormat(sheet, rowIndex, colIndex) {
  return normalizeText(cell(sheet, rowIndex, colIndex)?.z || '');
}

function isErrorCell(item) {
  if (!item) return false;
  if (item.t === 'e') return true;
  return ERROR_TOKEN.test(normalizeText(item.w ?? item.v ?? ''));
}

function isDateFormat(format = '') {
  const fmt = String(format || '').toLowerCase();
  if (!fmt || fmt.includes('[h')) return false;
  return /(dd|d\/|mm\/|yyyy|yy)/.test(fmt);
}

function isDurationHoursFormat(format = '') {
  return /\[(?:h|hh)\]/i.test(String(format || ''));
}

function parseDurationTextToHours(value) {
  const text = normalizeText(value);
  const match = text.match(/^(\d+):([0-5]?\d)(?::([0-5]?\d))?$/);
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2] || 0);
  const seconds = Number(match[3] || 0);
  return hours + minutes / 60 + seconds / 3600;
}

function asHours(item, forceExcelDuration = false) {
  if (!item || isErrorCell(item)) return null;
  if (typeof item.v === 'number' && Number.isFinite(item.v)) {
    if (forceExcelDuration || isDurationHoursFormat(item.z)) return item.v * 24;
    return Number(item.v);
  }
  return parseDurationTextToHours(item.w ?? item.v);
}

function findLabel(sheet, labelPattern, maxRows = 80, maxCols = 12) {
  for (let r = 0; r < maxRows; r += 1) {
    for (let c = 0; c < maxCols; c += 1) {
      const text = upper(cellDisplay(sheet, r, c));
      if (text && labelPattern.test(text)) return { row: r, col: c, text };
    }
  }
  return null;
}

function findValueRight(sheet, location, maxRight = 4) {
  if (!location) return { cell: null, row: -1, col: -1 };
  for (let offset = 1; offset <= maxRight; offset += 1) {
    const col = location.col + offset;
    const item = cell(sheet, location.row, col);
    if (!item) continue;
    const display = normalizeText(item.w ?? item.v ?? '');
    if (display !== '') return { cell: item, row: location.row, col };
  }
  return { cell: null, row: -1, col: -1 };
}

function findValueNearby(sheet, location, { maxRight = 4, maxDown = 2 } = {}) {
  const right = findValueRight(sheet, location, maxRight);
  if (right.cell) return right;
  if (!location) return { cell: null, row: -1, col: -1 };

  for (let down = 1; down <= maxDown; down += 1) {
    for (let offset = 0; offset <= maxRight; offset += 1) {
      const row = location.row + down;
      const col = location.col + offset;
      const item = cell(sheet, row, col);
      if (!item) continue;
      const display = normalizeText(item.w ?? item.v ?? '');
      if (display !== '') return { cell: item, row, col };
    }
  }
  return { cell: null, row: -1, col: -1 };
}

function parseDateCell(item, includeTime = false) {
  if (!item || isErrorCell(item)) return null;
  if (typeof item.v === 'number') {
    return includeTime ? excelSerialToIsoDateTime(item.v) : excelSerialToIso(item.v);
  }
  const raw = normalizeText(item.w ?? item.v ?? '');
  if (!raw) return null;
  const br = raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})(?:\s+(\d{1,2}):(\d{2}))?$/);
  if (br) {
    const [, d, m, yRaw, hh = '00', mm = '00'] = br;
    const y = yRaw.length === 2 ? `20${yRaw}` : yRaw;
    const iso = `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    return includeTime ? `${iso}T${String(hh).padStart(2, '0')}:${mm}:00.000Z` : iso;
  }
  const dt = new Date(raw);
  if (Number.isNaN(dt.getTime())) return null;
  return includeTime ? dt.toISOString() : dt.toISOString().slice(0, 10);
}

function parseTopMetadata(sheet, aircraftCode) {
  const hoursLoc = findLabel(sheet, /^HORAS DA ANV:?$/i);
  const hoursRef = findValueRight(sheet, hoursLoc, 2);
  const hoursValue = hoursRef.cell;

  const lastFlightLoc = findLabel(sheet, /^DATA DO ULTIMO VOO$/i);
  const lastFlightRef = findValueRight(sheet, lastFlightLoc, 3);
  const lastFlightValue = lastFlightRef.cell;

  const updatedLoc = findLabel(sheet, /^DATA DA ATUALIZA[CÇ][AÃ]O$/i);
  const updatedRef = findValueRight(sheet, updatedLoc, 3);
  const updatedValue = updatedRef.cell;

  const frvLoc = findLabel(sheet, /^ULTIMA FRV$/i);
  const frvRef = findValueRight(sheet, frvLoc, 2);
  const frvValue = frvRef.cell;

  const reasonLoc = findLabel(sheet, /^MOTIVO DA INDISPONIBILIDADE$/i);
  const reasonRef = findValueNearby(sheet, reasonLoc, { maxRight: 3, maxDown: 2 });
  const reasonValue = reasonRef.cell;

  const motor1Loc = findLabel(sheet, /^MOTOR\s*#?1:?$/i);
  const motor1SnValue = findValueRight(sheet, motor1Loc, 1);
  const motor1HoursCell = motor1Loc ? cell(sheet, motor1Loc.row, motor1Loc.col + 2) : null;
  const motor1HoursRef = motor1Loc ? address(motor1Loc.row, motor1Loc.col + 2) : null;

  const motor2Loc = findLabel(sheet, /^MOTOR\s*#?2:?$/i);
  const motor2SnValue = findValueRight(sheet, motor2Loc, 1);
  const motor2HoursCell = motor2Loc ? cell(sheet, motor2Loc.row, motor2Loc.col + 2) : null;
  const motor2HoursRef = motor2Loc ? address(motor2Loc.row, motor2Loc.col + 2) : null;

  const statusLoc = findLabel(sheet, /^SITUA[CÇ][AÃ]O(?: DA ANV)?$/i, 8, 12);
  const statusRef = findValueNearby(sheet, statusLoc, { maxRight: 3, maxDown: 1 });
  const statusCell = statusRef.cell || cell(sheet, 0, 10);
  const statusCellRef = statusRef.cell ? address(statusRef.row, statusRef.col) : 'K1';
  const topStatus = normalizeStatus(statusCell ? (statusCell.w ?? statusCell.v) : '');
  const aircraftHours = hoursValue && !isErrorCell(hoursValue) && Number.isFinite(Number(hoursValue.v))
    ? Number(hoursValue.v)
    : null;

  const rawMetaEntry = (item, ref) => ({
    cell: ref || null,
    raw_value: item ? normalizeText(item.w ?? item.v ?? '') || null : null,
    raw_format: item ? normalizeText(item.z || '') || null : null,
    error: Boolean(item && isErrorCell(item)),
  });

  const sourceMeta = {
    status: rawMetaEntry(statusCell, statusCellRef),
    aircraft_hours: rawMetaEntry(hoursValue, hoursRef.cell ? address(hoursRef.row, hoursRef.col) : null),
    last_flight_date: rawMetaEntry(lastFlightValue, lastFlightRef.cell ? address(lastFlightRef.row, lastFlightRef.col) : null),
    source_observed_at: rawMetaEntry(updatedValue, updatedRef.cell ? address(updatedRef.row, updatedRef.col) : null),
    last_frv: rawMetaEntry(frvValue, frvRef.cell ? address(frvRef.row, frvRef.col) : null),
    reason: rawMetaEntry(reasonValue, reasonRef.cell ? address(reasonRef.row, reasonRef.col) : null),
    engine_1_sn: rawMetaEntry(motor1SnValue.cell, motor1SnValue.cell ? address(motor1SnValue.row, motor1SnValue.col) : null),
    engine_1_hours: rawMetaEntry(motor1HoursCell, motor1HoursRef),
    engine_2_sn: rawMetaEntry(motor2SnValue.cell, motor2SnValue.cell ? address(motor2SnValue.row, motor2SnValue.col) : null),
    engine_2_hours: rawMetaEntry(motor2HoursCell, motor2HoursRef),
  };
  const metadataErrors = Object.values(sourceMeta).filter((entry) => entry.error).length;

  return {
    aircraft_code: aircraftCode,
    status: ALLOWED_STATUS.has(topStatus) ? topStatus : 'UNKNOWN',
    reason: isErrorCell(reasonValue) ? null : normalizeText(reasonValue?.w ?? reasonValue?.v ?? '') || null,
    aircraft_hours: aircraftHours,
    last_flight_date: parseDateCell(lastFlightValue, false),
    last_frv: isErrorCell(frvValue) ? null : normalizeText(frvValue?.w ?? frvValue?.v ?? '') || null,
    source_observed_at: parseDateCell(updatedValue, true),
    engine_1_sn: isErrorCell(motor1SnValue.cell) ? null : normalizeText(motor1SnValue.cell?.w ?? motor1SnValue.cell?.v ?? '') || null,
    engine_1_hours: asHours(motor1HoursCell, true),
    engine_2_sn: isErrorCell(motor2SnValue.cell) ? null : normalizeText(motor2SnValue.cell?.w ?? motor2SnValue.cell?.v ?? '') || null,
    engine_2_hours: asHours(motor2HoursCell, true),
    source_meta: sourceMeta,
    metadata_errors: metadataErrors,
  };
}

function looksLikeHeader(label) {
  const text = upper(label);
  return !text
    || text === 'LEGENDA'
    || /^INSPE[CÇ][OÕ]ES?\b/.test(text)
    || /^PROXIMAS?\b/.test(text)
    || /^N[AÃ]O CUMPRIDAS/.test(text)
    || /^HORARIAS$/.test(text)
    || /^CALENDARICAS$/.test(text)
    || /^ASSOCIADAS$/.test(text)
    || /^OUTRAS INSPE[CÇ][OÕ]ES$/.test(text)
    || /^MOTIVO DA INDISPONIBILIDADE$/.test(text)
    || /^S\/N$/.test(text);
}

function sectionForPair(pairName, rowIndex) {
  if (pairName === 'A_B') return 'INSPECOES_PERIODICAS';
  if (pairName === 'D_E') return rowIndex < 20 ? 'INSPECOES_CALENDARIAS' : 'INSPECOES_ASSOCIADAS';
  if (pairName === 'F_G') {
    if (rowIndex <= 12) return 'MOTOR_1';
    if (rowIndex <= 20) return 'MOTOR_2';
    return 'OUTRAS_INSPECOES';
  }
  if (pairName === 'F_J') return 'OUTRAS_INSPECOES';
  if (pairName === 'I_K') return 'EQUIPAMENTOS_ESPECIAIS';
  return 'OUTROS';
}

function classifyIndicator({ label, item, section }) {
  const raw = normalizeText(item?.w ?? item?.v ?? '');
  const format = normalizeText(item?.z || '');
  const labelUpper = upper(label);

  if (!item || raw === '') return null;
  if (isErrorCell(item)) {
    return { value_type: 'ERROR', value_numeric: null, value_text: raw || null, due_date: null, unit: null, quality_status: 'ERROR' };
  }

  if (isDateFormat(format)) {
    const due = parseDateCell(item, false);
    return {
      value_type: labelUpper === 'TBO' ? 'TBO_DUE_DATE' : 'DUE_DATE',
      value_numeric: null,
      value_text: null,
      due_date: due,
      unit: 'DATE',
      quality_status: due ? 'VALID' : 'WARNING',
    };
  }

  if (isDurationHoursFormat(format)) {
    const hours = asHours(item, true);
    return {
      value_type: labelUpper === 'TBO' ? 'TBO_HOURS_REMAINING' : 'HOURS_REMAINING',
      value_numeric: Number.isFinite(hours) ? Number(hours.toFixed(4)) : null,
      value_text: null,
      due_date: null,
      unit: 'HOURS',
      quality_status: Number.isFinite(hours) ? 'VALID' : 'WARNING',
    };
  }

  if (typeof item.v === 'number' && Number.isFinite(item.v)) {
    if (/CICLO/.test(labelUpper)) {
      return { value_type: 'CYCLES_REMAINING', value_numeric: Number(item.v), value_text: null, due_date: null, unit: 'CYCLES', quality_status: 'VALID' };
    }
    const hourContext = /\b\d+\s*H\b|\bH\s*#?\d*\b|PPI|PORTA|TIE BAR|FUEL NOZZLE|SERVO|GENERATOR|TAIL|VIBRA|LAV\.|LAV\s|ARP[AÃ]O|AMPEP/i.test(labelUpper)
      || ['INSPECOES_PERIODICAS', 'MOTOR_1', 'MOTOR_2', 'OUTRAS_INSPECOES'].includes(section);
    if (hourContext) {
      return {
        value_type: labelUpper === 'TBO' ? 'TBO_HOURS_REMAINING' : 'HOURS_REMAINING',
        value_numeric: Number(item.v), value_text: null, due_date: null, unit: 'HOURS', quality_status: 'VALID',
      };
    }
    return { value_type: 'NUMERIC', value_numeric: Number(item.v), value_text: null, due_date: null, unit: null, quality_status: 'WARNING' };
  }

  const durationText = parseDurationTextToHours(raw);
  if (durationText !== null) {
    return { value_type: 'HOURS_REMAINING', value_numeric: Number(durationText.toFixed(4)), value_text: null, due_date: null, unit: 'HOURS', quality_status: 'VALID' };
  }

  return { value_type: 'TEXT', value_numeric: null, value_text: raw || null, due_date: null, unit: null, quality_status: 'WARNING' };
}

function parseIndicators(sheet) {
  const indicators = [];
  const pairs = [
    { name: 'A_B', labelCol: 0, valueCol: 1 },
    { name: 'D_E', labelCol: 3, valueCol: 4 },
    { name: 'F_G', labelCol: 5, valueCol: 6 },
    { name: 'F_J', labelCol: 5, valueCol: 9 },
    { name: 'I_K', labelCol: 8, valueCol: 10 },
  ];

  let legendRow = 55;
  for (let r = 5; r < 60; r += 1) {
    if (upper(cellDisplay(sheet, r, 0)) === 'LEGENDA') {
      legendRow = r;
      break;
    }
  }

  const seen = new Set();
  for (let r = 5; r < legendRow; r += 1) {
    for (const pair of pairs) {
      const label = cellDisplay(sheet, r, pair.labelCol);
      if (looksLikeHeader(label)) continue;
      const valueCell = cell(sheet, r, pair.valueCol);
      if (!valueCell) continue;
      const display = normalizeText(valueCell.w ?? valueCell.v ?? '');
      if (!display) continue;

      const section = sectionForPair(pair.name, r);
      const classification = classifyIndicator({ label, item: valueCell, section });
      if (!classification) continue;

      const sourceCell = address(r, pair.valueCol);
      const key = `${sourceCell}::${upper(label)}`;
      if (seen.has(key)) continue;
      seen.add(key);

      indicators.push({
        section,
        label: normalizeText(label),
        indicator_key: upper(label).replace(/[^A-Z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 120) || sourceCell,
        ...classification,
        source_cell: sourceCell,
        raw_value: display,
        raw_format: normalizeText(valueCell.z || '') || null,
        quality_status: classification.quality_status || 'WARNING',
      });
    }
  }
  return indicators;
}

function parseAvailabilityWorkbook(workbook, sourceDocument = 'DISPONIBILIDADE.xlsx') {
  if (!workbook || !Array.isArray(workbook.SheetNames)) throw new Error('Workbook de disponibilidade inválido.');

  const snapshots = [];
  const warnings = [];

  for (const sheetNameRaw of workbook.SheetNames) {
    const sheetName = normalizeText(sheetNameRaw);
    if (!AIRCRAFT_SHEET_PATTERN.test(sheetName)) continue;
    const sheet = workbook.Sheets?.[sheetNameRaw];
    if (!sheet) continue;

    const metadata = parseTopMetadata(sheet, sheetName);
    const indicators = parseIndicators(sheet);
    const errors = indicators.filter((item) => item.quality_status === 'ERROR');

    if (metadata.status === 'UNKNOWN') warnings.push(`${sheetName}: situação D/I não identificada; snapshot será preservado como UNKNOWN.`);
    if (metadata.metadata_errors) warnings.push(`${sheetName}: ${metadata.metadata_errors} campo(s) de cabeçalho com erro de planilha preservado(s) na proveniência e não convertido(s) em zero.`);
    if (metadata.status === 'I' && !metadata.reason) warnings.push(`${sheetName}: aeronave I sem motivo de indisponibilidade preenchido.`);
    if (errors.length) warnings.push(`${sheetName}: ${errors.length} indicador(es) com erro de planilha preservado(s) como evidência não utilizável.`);

    snapshots.push({
      ...metadata,
      source_sheet: sheetName,
      indicators,
      quality: {
        indicator_count: indicators.length,
        errors: errors.length,
        metadata_errors: metadata.metadata_errors || 0,
        warnings: indicators.filter((item) => item.quality_status === 'WARNING').length,
      },
    });
  }

  if (!snapshots.length) throw new Error('Nenhuma aba de aeronave (4 dígitos) foi reconhecida no Mapa de Disponibilidade.');

  return {
    source_document: sourceDocument,
    snapshots,
    warnings,
    summary: {
      aircraft_count: snapshots.length,
      available: snapshots.filter((item) => item.status === 'D').length,
      unavailable: snapshots.filter((item) => item.status === 'I').length,
      unknown: snapshots.filter((item) => item.status === 'UNKNOWN').length,
      indicators: snapshots.reduce((sum, item) => sum + item.indicators.length, 0),
      indicator_errors: snapshots.reduce((sum, item) => sum + item.quality.errors, 0),
    },
  };
}

function parseAvailabilityWorkbookBuffer(buffer, sourceDocument = 'DISPONIBILIDADE.xlsx') {
  if (!Buffer.isBuffer(buffer) || !buffer.length) throw new Error('Arquivo de disponibilidade vazio.');
  // Lazy require para permitir testes dos parsers puros sem I/O de XLSX.
  const XLSX = require('xlsx');
  const workbook = XLSX.read(buffer, { type: 'buffer', cellNF: true, cellDates: false, cellStyles: true });
  return parseAvailabilityWorkbook(workbook, sourceDocument);
}

function sourceHash(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function normalizeSnapshotForRpc(snapshot = {}) {
  return {
    aircraft_code: snapshot.aircraft_code,
    status: snapshot.status,
    reason: snapshot.reason,
    aircraft_hours: snapshot.aircraft_hours,
    last_flight_date: snapshot.last_flight_date,
    last_frv: snapshot.last_frv,
    source_observed_at: snapshot.source_observed_at,
    engine_1_sn: snapshot.engine_1_sn,
    engine_1_hours: snapshot.engine_1_hours,
    engine_2_sn: snapshot.engine_2_sn,
    engine_2_hours: snapshot.engine_2_hours,
    source_sheet: snapshot.source_sheet,
    source_meta: snapshot.source_meta || {},
    quality: snapshot.quality || {},
    indicators: (snapshot.indicators || []).map((indicator) => ({
      section: indicator.section,
      label: indicator.label,
      indicator_key: indicator.indicator_key,
      value_type: indicator.value_type,
      value_numeric: indicator.value_numeric,
      value_text: indicator.value_text,
      due_date: indicator.due_date,
      unit: indicator.unit,
      source_cell: indicator.source_cell,
      raw_value: indicator.raw_value,
      raw_format: indicator.raw_format,
      quality_status: indicator.quality_status,
    })),
  };
}

async function importAvailabilityAtomic(parsed, { buffer, fileName, user = {}, requestId = null } = {}) {
  const hash = sourceHash(buffer);
  const payload = (parsed.snapshots || []).map(normalizeSnapshotForRpc);
  const supabase = getSupabase();
  const { data, error } = await supabase.rpc('sisha_import_aircraft_availability_atomic', {
    p_source_document: fileName || parsed.source_document || 'DISPONIBILIDADE.xlsx',
    p_source_sha256: hash,
    p_snapshots: payload,
    p_actor_email: user.email || null,
    p_actor_role: user.role || null,
    p_request_id: requestId || null,
  });
  if (error) throw error;
  return { ...(data || {}), source_sha256: hash, parser_summary: parsed.summary, warnings: parsed.warnings || [] };
}

async function loadCurrentAvailabilityRows() {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from('v_sisha_aircraft_current_availability')
    .select('*')
    .order('aircraft_code', { ascending: true });
  if (error) throw error;
  return data || [];
}

async function loadCurrentMaintenanceIndicators(aircraftCodes = []) {
  const supabase = getSupabase();
  let query = supabase.from('v_sisha_aircraft_current_maintenance_indicators').select('*');
  const clean = [...new Set((aircraftCodes || []).map((item) => upper(item)).filter(Boolean))];
  if (clean.length) query = query.in('aircraft_code', clean);
  const { data, error } = await query.order('aircraft_code', { ascending: true }).order('section', { ascending: true });
  if (error) throw error;
  return data || [];
}

module.exports = {
  normalizeStatus,
  excelSerialToIso,
  excelSerialToIsoDateTime,
  parseDurationTextToHours,
  parseTopMetadata,
  parseIndicators,
  parseAvailabilityWorkbook,
  parseAvailabilityWorkbookBuffer,
  sourceHash,
  normalizeSnapshotForRpc,
  importAvailabilityAtomic,
  loadCurrentAvailabilityRows,
  loadCurrentMaintenanceIndicators,
};
