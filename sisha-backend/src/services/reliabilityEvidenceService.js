const FAILURE_CONDITIONS = new Set([
  'AVARIADO',
  'PANE',
  'FALHA',
  'IRREPARAVEL',
]);

const SUSPECT_FAILURE_CONDITIONS = new Set([
  'POSSIVEL_PANE',
  'POSSIVEL PANE',
  'PROVAVEL_PANE',
  'PROVAVEL PANE',
]);

function upper(value) {
  return String(value || '').trim().toUpperCase();
}

function toTimestamp(value) {
  if (!value) return null;
  const timestamp = new Date(value).getTime();
  return Number.isFinite(timestamp) ? timestamp : null;
}

function durationHours(start, end) {
  const a = toTimestamp(start);
  const b = toTimestamp(end);
  if (a === null || b === null || b < a) return null;
  return (b - a) / 3600000;
}

function validEvents(events = []) {
  return (events || [])
    .filter((event) => event && event.invalidado !== true)
    .filter((event) => toTimestamp(event.data_evento) !== null)
    .sort((a, b) => (
      toTimestamp(a.data_evento) - toTimestamp(b.data_evento)
      || Number(a.id || 0) - Number(b.id || 0)
    ));
}

function isRemoval(event = {}) {
  const type = upper(event.tipo_evento);
  return type === 'REMOCAO_ANV' || type.includes('REMOCAO');
}

function failureEvidence(event = {}) {
  const a2 = event?.payload?.a2 && typeof event.payload.a2 === 'object' ? event.payload.a2 : {};
  const a2Failure = upper(a2.failure_status);
  const a2TestResult = upper(a2.test_result);
  const type = upper(event.tipo_evento);

  // A2 é evidência humana explícita. PANE chega como REMOCAO_ANV com
  // failure_status CONFIRMED; TESTE só vira falha após resultado REPROVADO.
  if (type === 'A2_RESULTADO_TESTE') {
    if (a2TestResult === 'REPROVADO' || a2Failure === 'CONFIRMED') return 'CONFIRMED';
    return 'NONE';
  }

  if (!isRemoval(event)) return 'NONE';
  if (a2Failure === 'CONFIRMED') return 'CONFIRMED';
  if (a2Failure === 'PENDING_TEST') return 'NONE';

  const condition = upper(event.condicao_resultante);
  const motive = upper(event.motivo || event.observacao);
  if (FAILURE_CONDITIONS.has(condition) || /\bPANE\b|\bFALHA\b|\bAVARIAD/.test(motive)) {
    if (SUSPECT_FAILURE_CONDITIONS.has(condition) || /POSSIVEL|PROVAVEL/.test(motive)) {
      return 'SUSPECT';
    }
    return 'CONFIRMED';
  }

  if (SUSPECT_FAILURE_CONDITIONS.has(condition)) return 'SUSPECT';
  return 'NONE';
}

function buildRepairTurnaroundCycles(events = []) {
  const rows = validEvents(events);
  const openByDocument = new Map();
  const cycles = [];

  for (const event of rows) {
    const type = upper(event.tipo_evento);
    const document = String(event.documento || event.os || event.pim || '').trim();
    if (!document) continue;

    if (type === 'ENVIO_WO_REPARO') {
      openByDocument.set(document, event);
      continue;
    }

    if (type === 'RETORNO_WO_REPARO') {
      const start = openByDocument.get(document);
      if (!start) continue;

      const hours = durationHours(start.data_evento, event.data_evento);
      if (hours === null) continue;

      cycles.push({
        documento: document,
        inicio: start.data_evento,
        fim: event.data_evento,
        horas: hours,
        dias: hours / 24,
        tipo: 'TAT_REPARO_EXTERNO',
      });
      openByDocument.delete(document);
    }
  }

  return cycles;
}

function summarizeReliabilityEvidence(events = [], options = {}) {
  const rows = validEvents(events);
  const confirmedFailures = rows.filter((event) => failureEvidence(event) === 'CONFIRMED');
  const suspectFailures = rows.filter((event) => failureEvidence(event) === 'SUSPECT');
  const installations = rows.filter((event) => upper(event.tipo_evento) === 'INSTALACAO_ANV');
  const repairTurnaround = buildRepairTurnaroundCycles(rows);

  const utilizationHours = Number(options.utilization_hours);
  const hasUtilizationHours = Number.isFinite(utilizationHours) && utilizationHours >= 0;

  const mtbfReady = confirmedFailures.length > 0 && hasUtilizationHours;
  const mtbfHours = mtbfReady && confirmedFailures.length > 0
    ? utilizationHours / confirmedFailures.length
    : null;

  const explicitRepairIntervals = rows
    .map((event) => event?.payload?.reliability)
    .filter((payload) => (
      payload
      && payload.repair_started_at
      && payload.repair_completed_at
      && durationHours(payload.repair_started_at, payload.repair_completed_at) !== null
    ))
    .map((payload) => durationHours(payload.repair_started_at, payload.repair_completed_at));

  const mttrReady = explicitRepairIntervals.length > 0;
  const mttrHours = mttrReady
    ? explicitRepairIntervals.reduce((sum, value) => sum + value, 0) / explicitRepairIntervals.length
    : null;

  return {
    eventos_validos: rows.length,
    instalacoes: installations.length,
    falhas_confirmadas: confirmedFailures.length,
    falhas_suspeitas: suspectFailures.length,
    tat_reparo_ciclos: repairTurnaround,
    mtbf: {
      ready: mtbfReady,
      value_hours: mtbfHours,
      blocker: mtbfReady
        ? null
        : confirmedFailures.length === 0
          ? 'CONFIRMED_FAILURE_REQUIRED'
          : 'AIRCRAFT_UTILIZATION_HOURS_REQUIRED',
    },
    mttr: {
      ready: mttrReady,
      value_hours: mttrHours,
      blocker: mttrReady ? null : 'EXPLICIT_REPAIR_CLOCK_REQUIRED',
    },
    notes: [
      'TAT de reparo externo pode ser derivado de ENVIO_WO_REPARO -> RETORNO_WO_REPARO.',
      'TAT nao e automaticamente MTTR.',
      'MTBF em horas exige utilizacao operacional da aeronave no intervalo analisado.',
      'POSSIVEL_PANE nao e contada como falha confirmada sem evidencia posterior.',
    ],
  };
}

module.exports = {
  FAILURE_CONDITIONS,
  SUSPECT_FAILURE_CONDITIONS,
  durationHours,
  validEvents,
  failureEvidence,
  buildRepairTurnaroundCycles,
  summarizeReliabilityEvidence,
};
