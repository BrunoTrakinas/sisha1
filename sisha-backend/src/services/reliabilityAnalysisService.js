const HOURS_COUNTERS = new Set(['HORAS_DE_VOO', 'MOTOR_1', 'MOTOR_2']);
const UNSCHEDULED_REMOVALS = new Set(['PANE', 'TESTE']);
const FINAL_TECHNICAL_RESULTS = new Set(['REPAIRED', 'NFF', 'IRREPARABLE']);

function clean(value) {
  const text = String(value ?? '').trim();
  return text || null;
}

function upper(value) {
  const text = clean(value);
  return text ? text.toUpperCase() : null;
}

function numeric(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function timestamp(value) {
  if (!value) return null;
  const time = new Date(value).getTime();
  return Number.isFinite(time) ? time : null;
}

function durationHours(start, end) {
  const a = timestamp(start);
  const b = timestamp(end);
  if (a === null || b === null || b < a) return null;
  return (b - a) / 3600000;
}

function dateOnly(value) {
  const time = timestamp(value);
  return time === null ? null : new Date(time).toISOString().slice(0, 10);
}

function metricValue(snapshot = {}, metric) {
  const key = clean(metric);
  if (!key || key === 'calendar') return null;
  return numeric(snapshot[key]);
}

function deriveUsageSuggestion(interval = {}, snapshots = []) {
  if (!interval?.removed_at || !interval?.installed_at) return null;
  const counter = upper(interval.usage_counter);
  const metric = clean(interval.usage_metric)?.toLowerCase();

  if (counter === 'CALENDARIO') {
    const hours = durationHours(interval.installed_at, interval.removed_at);
    if (hours === null) return null;
    return {
      source: 'A2_TIMESTAMPS',
      quality: 'EXACT_CALENDAR',
      unit: 'CALENDAR_DAYS',
      start_value: 0,
      end_value: hours / 24,
      delta: hours / 24,
      official_without_confirmation: true,
    };
  }

  if (!metric) return null;
  const startDate = dateOnly(interval.installed_at);
  const endDate = dateOnly(interval.removed_at);
  if (!startDate || !endDate) return null;

  const applicable = (snapshots || [])
    .filter((row) => String(row.aircraft_code || '') === String(interval.aircraft_code || ''))
    .filter((row) => clean(row.source_observed_at))
    .filter((row) => metricValue(row, metric) !== null)
    .sort((a, b) => String(a.source_observed_at).localeCompare(String(b.source_observed_at)));

  const start = applicable.find((row) => String(row.source_observed_at).slice(0, 10) >= startDate) || null;
  const endCandidates = applicable.filter((row) => String(row.source_observed_at).slice(0, 10) <= endDate);
  const end = endCandidates.length ? endCandidates[endCandidates.length - 1] : null;
  if (!start || !end) return null;
  const startObserved = String(start.source_observed_at).slice(0, 10);
  const endObserved = String(end.source_observed_at).slice(0, 10);
  if (startObserved > endObserved) return null;

  const startValue = metricValue(start, metric);
  const endValue = metricValue(end, metric);
  if (startValue === null || endValue === null || endValue < startValue) return null;

  return {
    source: 'LIVRO_DOS_MOTORES',
    quality: startObserved === startDate && endObserved === endDate ? 'DATE_LEVEL_SUGGESTION' : 'INNER_WINDOW_SUGGESTION',
    unit: HOURS_COUNTERS.has(counter) ? 'HOURS' : 'CYCLES',
    start_value: startValue,
    end_value: endValue,
    delta: endValue - startValue,
    start_observed_at: startObserved,
    end_observed_at: endObserved,
    official_without_confirmation: false,
    note: 'Sugestão documental. Só entra nos indicadores oficiais após confirmação Admin/Dono.',
  };
}

function normalizeCycle(interval = {}, confirmation = null, snapshots = []) {
  const counter = upper(interval.usage_counter);
  const suggestion = deriveUsageSuggestion(interval, snapshots);
  const confirmationDelta = numeric(confirmation?.usage_delta);
  const confirmationUnit = upper(confirmation?.usage_unit);
  const calendarHours = counter === 'CALENDARIO' ? durationHours(interval.installed_at, interval.removed_at) : null;
  const calendarDays = calendarHours === null ? null : calendarHours / 24;
  const officialUsage = confirmationDelta !== null && confirmationDelta >= 0
    ? {
        official: true,
        source: 'ADMIN_CONFIRMED',
        unit: confirmationUnit || (HOURS_COUNTERS.has(counter) ? 'HOURS' : counter === 'CICLOS' ? 'CYCLES' : 'CALENDAR_DAYS'),
        start_value: numeric(confirmation?.usage_start_value),
        end_value: numeric(confirmation?.usage_end_value),
        delta: confirmationDelta,
      }
    : calendarDays !== null
      ? {
          official: true,
          source: 'A2_TIMESTAMPS',
          unit: 'CALENDAR_DAYS',
          start_value: 0,
          end_value: calendarDays,
          delta: calendarDays,
        }
      : null;

  const technicalResult = upper(confirmation?.technical_result) || null;
  const failureStatus = upper(interval.failure_status) || 'NONE';
  const effectiveFailure = failureStatus === 'CONFIRMED' && technicalResult !== 'NFF';
  const unscheduled = UNSCHEDULED_REMOVALS.has(upper(interval.removal_reason));
  const mttrHours = durationHours(confirmation?.repair_started_at, confirmation?.repair_completed_at);
  const tatHours = durationHours(interval.removed_at, confirmation?.available_at);

  return {
    interval_id: Number(interval.id || interval.interval_id),
    equipment_id: Number(interval.equipment_id),
    pn: clean(interval.pn),
    sn: clean(interval.sn),
    nomenclatura: clean(interval.nomenclatura),
    aircraft_code: clean(interval.aircraft_code),
    position_code: clean(interval.position_code),
    usage_counter: counter,
    usage_metric: clean(interval.usage_metric),
    installed_at: interval.installed_at || null,
    removed_at: interval.removed_at || null,
    removal_reason: upper(interval.removal_reason),
    test_result: upper(interval.test_result),
    failure_status: failureStatus,
    effective_failure: effectiveFailure,
    unscheduled_removal: unscheduled,
    technical_result: technicalResult,
    repair_started_at: confirmation?.repair_started_at || null,
    repair_completed_at: confirmation?.repair_completed_at || null,
    available_at: confirmation?.available_at || null,
    repairer: clean(confirmation?.repairer),
    manufacturer: clean(confirmation?.manufacturer),
    source_document: clean(confirmation?.source_document),
    confirmation_reason: clean(confirmation?.confirmation_reason),
    confirmed_by: clean(confirmation?.confirmed_by),
    confirmed_at: confirmation?.confirmed_at || null,
    official_usage: officialUsage,
    usage_suggestion: suggestion,
    mttr_hours: mttrHours,
    tat_hours: tatHours,
    repeat_removal: false,
    repeat_previous_removed_at: null,
    repeat_interval_days: null,
  };
}

function markRepeatRemovals(cycles = []) {
  const byEquipment = new Map();
  const rows = (cycles || []).map((cycle) => ({ ...cycle }));
  for (const cycle of rows) {
    const key = String(cycle.equipment_id || `${cycle.pn || ''}::${cycle.sn || ''}`);
    if (!byEquipment.has(key)) byEquipment.set(key, []);
    byEquipment.get(key).push(cycle);
  }

  for (const list of byEquipment.values()) {
    list.sort((a, b) => (timestamp(a.removed_at) || 0) - (timestamp(b.removed_at) || 0));
    let previousUnscheduled = null;
    for (const cycle of list) {
      if (!cycle.unscheduled_removal || !cycle.removed_at) continue;
      if (previousUnscheduled) {
        cycle.repeat_removal = true;
        cycle.repeat_previous_removed_at = previousUnscheduled.removed_at;
        const hours = durationHours(previousUnscheduled.removed_at, cycle.removed_at);
        cycle.repeat_interval_days = hours === null ? null : hours / 24;
      }
      previousUnscheduled = cycle;
    }
  }
  return rows;
}

function average(values = []) {
  const list = values.filter((value) => Number.isFinite(value));
  if (!list.length) return null;
  return list.reduce((sum, value) => sum + value, 0) / list.length;
}

function summarizeCore(cycles = []) {
  const rows = markRepeatRemovals(cycles);
  const hoursPopulation = rows.filter((cycle) => HOURS_COUNTERS.has(cycle.usage_counter));
  const hoursCovered = hoursPopulation.filter((cycle) => cycle.official_usage?.official && cycle.official_usage.unit === 'HOURS' && Number.isFinite(cycle.official_usage.delta));
  const hoursCoverageComplete = hoursPopulation.length > 0 && hoursCovered.length === hoursPopulation.length;
  const totalHours = hoursCovered.reduce((sum, cycle) => sum + cycle.official_usage.delta, 0);
  const failuresHours = hoursPopulation.filter((cycle) => cycle.effective_failure).length;
  const unscheduledHours = hoursPopulation.filter((cycle) => cycle.unscheduled_removal).length;

  const cyclePopulation = rows.filter((cycle) => cycle.usage_counter === 'CICLOS');
  const cycleCovered = cyclePopulation.filter((cycle) => cycle.official_usage?.official && cycle.official_usage.unit === 'CYCLES' && Number.isFinite(cycle.official_usage.delta));
  const cycleCoverageComplete = cyclePopulation.length > 0 && cycleCovered.length === cyclePopulation.length;
  const totalCycles = cycleCovered.reduce((sum, cycle) => sum + cycle.official_usage.delta, 0);
  const failuresCycles = cyclePopulation.filter((cycle) => cycle.effective_failure).length;
  const unscheduledCycles = cyclePopulation.filter((cycle) => cycle.unscheduled_removal).length;

  const unscheduled = rows.filter((cycle) => cycle.unscheduled_removal);
  const resolvedUnscheduled = unscheduled.filter((cycle) => FINAL_TECHNICAL_RESULTS.has(cycle.technical_result));
  const repaired = resolvedUnscheduled.filter((cycle) => cycle.technical_result === 'REPAIRED');
  const nff = resolvedUnscheduled.filter((cycle) => cycle.technical_result === 'NFF');
  const technicalResultComplete = unscheduled.length > 0 && resolvedUnscheduled.length === unscheduled.length;
  const mttrComplete = technicalResultComplete
    && repaired.length > 0
    && repaired.every((cycle) => Number.isFinite(cycle.mttr_hours));
  const tatPopulation = resolvedUnscheduled.filter((cycle) => cycle.technical_result !== 'IRREPARABLE');
  const tatComplete = technicalResultComplete
    && tatPopulation.length > 0
    && tatPopulation.every((cycle) => Number.isFinite(cycle.tat_hours));

  const repeats = rows.filter((cycle) => cycle.repeat_removal);

  return {
    population: {
      closed_intervals: rows.length,
      hours_intervals: hoursPopulation.length,
      hours_confirmed: hoursCovered.length,
      cycles_intervals: cyclePopulation.length,
      cycles_confirmed: cycleCovered.length,
      unscheduled_removals: unscheduled.length,
      confirmed_failures: rows.filter((cycle) => cycle.effective_failure).length,
      resolved_technical_results: resolvedUnscheduled.length,
      repeat_removals: repeats.length,
    },
    mtbf: {
      ready: hoursCoverageComplete && failuresHours > 0,
      value_hours: hoursCoverageComplete && failuresHours > 0 ? totalHours / failuresHours : null,
      total_hours: hoursCoverageComplete ? totalHours : null,
      failures: failuresHours,
      blocker: hoursPopulation.length === 0
        ? 'HOURS_COUNTER_INTERVAL_REQUIRED'
        : !hoursCoverageComplete
          ? 'USAGE_HOURS_COVERAGE_INCOMPLETE'
          : failuresHours === 0
            ? 'CONFIRMED_FAILURE_REQUIRED'
            : null,
    },
    mtbur: {
      ready: hoursCoverageComplete && unscheduledHours > 0,
      value_hours: hoursCoverageComplete && unscheduledHours > 0 ? totalHours / unscheduledHours : null,
      total_hours: hoursCoverageComplete ? totalHours : null,
      unscheduled_removals: unscheduledHours,
      blocker: hoursPopulation.length === 0
        ? 'HOURS_COUNTER_INTERVAL_REQUIRED'
        : !hoursCoverageComplete
          ? 'USAGE_HOURS_COVERAGE_INCOMPLETE'
          : unscheduledHours === 0
            ? 'UNSCHEDULED_REMOVAL_REQUIRED'
            : null,
    },
    failures_per_1000_hours: {
      ready: hoursCoverageComplete && totalHours > 0,
      value: hoursCoverageComplete && totalHours > 0 ? (failuresHours / totalHours) * 1000 : null,
      blocker: hoursPopulation.length === 0
        ? 'HOURS_COUNTER_INTERVAL_REQUIRED'
        : !hoursCoverageComplete
          ? 'USAGE_HOURS_COVERAGE_INCOMPLETE'
          : totalHours <= 0
            ? 'POSITIVE_UTILIZATION_REQUIRED'
            : null,
    },
    mtbf_cycles: {
      ready: cycleCoverageComplete && failuresCycles > 0,
      value_cycles: cycleCoverageComplete && failuresCycles > 0 ? totalCycles / failuresCycles : null,
      blocker: cyclePopulation.length === 0
        ? 'CYCLE_COUNTER_INTERVAL_REQUIRED'
        : !cycleCoverageComplete
          ? 'USAGE_CYCLES_COVERAGE_INCOMPLETE'
          : failuresCycles === 0
            ? 'CONFIRMED_FAILURE_REQUIRED'
            : null,
    },
    mtbur_cycles: {
      ready: cycleCoverageComplete && unscheduledCycles > 0,
      value_cycles: cycleCoverageComplete && unscheduledCycles > 0 ? totalCycles / unscheduledCycles : null,
      blocker: cyclePopulation.length === 0
        ? 'CYCLE_COUNTER_INTERVAL_REQUIRED'
        : !cycleCoverageComplete
          ? 'USAGE_CYCLES_COVERAGE_INCOMPLETE'
          : unscheduledCycles === 0
            ? 'UNSCHEDULED_REMOVAL_REQUIRED'
            : null,
    },
    mttr: {
      ready: mttrComplete,
      value_hours: mttrComplete ? average(repaired.map((cycle) => cycle.mttr_hours)) : null,
      repaired_cycles: repaired.length,
      blocker: unscheduled.length === 0
        ? 'UNSCHEDULED_REMOVAL_REQUIRED'
        : resolvedUnscheduled.length !== unscheduled.length
          ? 'TECHNICAL_RESULT_COVERAGE_INCOMPLETE'
          : repaired.length === 0
            ? 'REPAIRED_CYCLE_REQUIRED'
            : !repaired.every((cycle) => Number.isFinite(cycle.mttr_hours))
              ? 'EXPLICIT_REPAIR_CLOCK_COVERAGE_INCOMPLETE'
              : null,
    },
    tat: {
      ready: tatComplete,
      value_hours: tatComplete ? average(tatPopulation.map((cycle) => cycle.tat_hours)) : null,
      cycles: tatPopulation.length,
      blocker: unscheduled.length === 0
        ? 'UNSCHEDULED_REMOVAL_REQUIRED'
        : !technicalResultComplete
          ? 'TECHNICAL_RESULT_COVERAGE_INCOMPLETE'
          : tatPopulation.length === 0
            ? 'RETURNABLE_CYCLE_REQUIRED'
            : !tatComplete
              ? 'AVAILABLE_AT_COVERAGE_INCOMPLETE'
              : null,
    },
    nff: {
      ready: technicalResultComplete,
      count: nff.length,
      rate_percent: technicalResultComplete && unscheduled.length ? (nff.length / unscheduled.length) * 100 : null,
      denominator_unscheduled: unscheduled.length,
      blocker: unscheduled.length === 0
        ? 'UNSCHEDULED_REMOVAL_REQUIRED'
        : !technicalResultComplete
          ? 'TECHNICAL_RESULT_COVERAGE_INCOMPLETE'
          : null,
    },
    repeat_removal: {
      ready: rows.length > 0,
      count: repeats.length,
      equipment_affected: new Set(repeats.map((cycle) => cycle.equipment_id)).size,
      intervals: repeats.map((cycle) => ({
        interval_id: cycle.interval_id,
        equipment_id: cycle.equipment_id,
        pn: cycle.pn,
        sn: cycle.sn,
        removed_at: cycle.removed_at,
        previous_removed_at: cycle.repeat_previous_removed_at,
        days_between: cycle.repeat_interval_days,
      })),
      note: 'Repeat removal significa nova remoção não programada do mesmo PN+SN após uma remoção não programada anterior. O SISHA não inventa limiar de dias/horas.',
    },
  };
}

function groupRows(cycles, keyFn) {
  const groups = new Map();
  for (const cycle of cycles || []) {
    const key = clean(keyFn(cycle));
    if (!key) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(cycle);
  }
  return [...groups.entries()]
    .map(([key, rows]) => ({ key, rows, summary: summarizeCore(rows) }))
    .sort((a, b) => b.rows.length - a.rows.length || a.key.localeCompare(b.key));
}

function summarizeA3Cycles(cycles = {}, options = {}) {
  const rows = markRepeatRemovals(Array.isArray(cycles) ? cycles : []);
  const summary = summarizeCore(rows);
  if (options.include_breakdowns === false) return summary;
  return {
    ...summary,
    breakdowns: {
      by_pn: groupRows(rows, (row) => row.pn),
      by_sn: groupRows(rows, (row) => row.sn ? `${row.pn || ''} / SN ${row.sn}` : null),
      by_aircraft: groupRows(rows, (row) => row.aircraft_code),
      by_repairer: groupRows(rows, (row) => row.repairer),
      by_manufacturer: groupRows(rows, (row) => row.manufacturer),
    },
  };
}

module.exports = {
  HOURS_COUNTERS,
  UNSCHEDULED_REMOVALS,
  FINAL_TECHNICAL_RESULTS,
  durationHours,
  metricValue,
  deriveUsageSuggestion,
  normalizeCycle,
  markRepeatRemovals,
  summarizeA3Cycles,
};
