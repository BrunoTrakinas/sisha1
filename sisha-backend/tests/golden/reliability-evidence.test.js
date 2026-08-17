const test = require('node:test');
const assert = require('node:assert/strict');

const {
  durationHours,
  validEvents,
  failureEvidence,
  buildRepairTurnaroundCycles,
  summarizeReliabilityEvidence,
} = require('../../src/services/reliabilityEvidenceService');

test('GOLDEN Confiabilidade: eventos invalidos/invalidado nao entram na evidencia', () => {
  const rows = validEvents([
    { id: 1, data_evento: '2026-08-10T10:00:00Z' },
    { id: 2, data_evento: '2026-08-11T10:00:00Z', invalidado: true },
    { id: 3, data_evento: 'nao-e-data' },
  ]);
  assert.deepEqual(rows.map((row) => row.id), [1]);
});

test('GOLDEN Confiabilidade: ordem temporal usa data_evento e nao created_at', () => {
  const rows = validEvents([
    {
      id: 2,
      data_evento: '2026-08-12T10:00:00Z',
      created_at: '2026-08-01T10:00:00Z',
    },
    {
      id: 1,
      data_evento: '2026-08-10T10:00:00Z',
      created_at: '2026-08-13T10:00:00Z',
    },
  ]);
  assert.deepEqual(rows.map((row) => row.id), [1, 2]);
});

test('GOLDEN Confiabilidade: POSSIVEL_PANE nao vira falha confirmada', () => {
  assert.equal(failureEvidence({
    tipo_evento: 'REMOCAO_ANV',
    condicao_resultante: 'POSSIVEL_PANE',
  }), 'SUSPECT');
});

test('GOLDEN Confiabilidade: remocao por AVARIADO conta como falha confirmada', () => {
  assert.equal(failureEvidence({
    tipo_evento: 'REMOCAO_ANV',
    condicao_resultante: 'AVARIADO',
  }), 'CONFIRMED');
});

test('GOLDEN Confiabilidade: remocao pronto uso nao conta como falha', () => {
  assert.equal(failureEvidence({
    tipo_evento: 'REMOCAO_ANV',
    condicao_resultante: 'PRONTO_USO',
    motivo: 'Cessao para outra aeronave.',
  }), 'NONE');
});

test('GOLDEN Confiabilidade: duracao negativa ou data invalida e recusada', () => {
  assert.equal(durationHours('2026-08-12T10:00:00Z', '2026-08-11T10:00:00Z'), null);
  assert.equal(durationHours('invalida', '2026-08-11T10:00:00Z'), null);
});

test('GOLDEN Confiabilidade: ENVIO_WO -> RETORNO_WO produz TAT, nao MTTR automatico', () => {
  const events = [
    {
      id: 1,
      tipo_evento: 'ENVIO_WO_REPARO',
      documento: 'WO-001',
      data_evento: '2026-08-01T12:00:00Z',
    },
    {
      id: 2,
      tipo_evento: 'RETORNO_WO_REPARO',
      documento: 'WO-001',
      data_evento: '2026-08-11T12:00:00Z',
    },
  ];

  const cycles = buildRepairTurnaroundCycles(events);
  assert.equal(cycles.length, 1);
  assert.equal(cycles[0].dias, 10);

  const summary = summarizeReliabilityEvidence(events);
  assert.equal(summary.tat_reparo_ciclos.length, 1);
  assert.equal(summary.mttr.ready, false);
  assert.equal(summary.mttr.blocker, 'EXPLICIT_REPAIR_CLOCK_REQUIRED');
});

test('GOLDEN Confiabilidade: retorno WO sem envio conhecido nao fabrica TAT', () => {
  const cycles = buildRepairTurnaroundCycles([{
    tipo_evento: 'RETORNO_WO_REPARO',
    documento: 'WO-001',
    data_evento: '2026-08-11T12:00:00Z',
  }]);
  assert.deepEqual(cycles, []);
});

test('GOLDEN MTBF: falha confirmada sem horas de voo permanece bloqueada', () => {
  const summary = summarizeReliabilityEvidence([{
    tipo_evento: 'REMOCAO_ANV',
    condicao_resultante: 'AVARIADO',
    data_evento: '2026-08-11T12:00:00Z',
  }]);
  assert.equal(summary.mtbf.ready, false);
  assert.equal(summary.mtbf.value_hours, null);
  assert.equal(summary.mtbf.blocker, 'AIRCRAFT_UTILIZATION_HOURS_REQUIRED');
});

test('GOLDEN MTBF: possivel pane isolada nao habilita calculo', () => {
  const summary = summarizeReliabilityEvidence([{
    tipo_evento: 'REMOCAO_ANV',
    condicao_resultante: 'POSSIVEL_PANE',
    data_evento: '2026-08-11T12:00:00Z',
  }], { utilization_hours: 100 });
  assert.equal(summary.falhas_confirmadas, 0);
  assert.equal(summary.falhas_suspeitas, 1);
  assert.equal(summary.mtbf.ready, false);
  assert.equal(summary.mtbf.blocker, 'CONFIRMED_FAILURE_REQUIRED');
});

test('GOLDEN MTBF: quando horas e falhas confirmadas existem, media e deterministica', () => {
  const events = [
    {
      tipo_evento: 'REMOCAO_ANV',
      condicao_resultante: 'AVARIADO',
      data_evento: '2026-07-01T12:00:00Z',
    },
    {
      tipo_evento: 'REMOCAO_ANV',
      condicao_resultante: 'PANE',
      data_evento: '2026-08-01T12:00:00Z',
    },
  ];
  const summary = summarizeReliabilityEvidence(events, { utilization_hours: 240 });
  assert.equal(summary.mtbf.ready, true);
  assert.equal(summary.mtbf.value_hours, 120);
});

test('GOLDEN MTTR: somente relogio explicito de reparo habilita MTTR', () => {
  const summary = summarizeReliabilityEvidence([{
    tipo_evento: 'RESULTADO_TECNICO_WO',
    data_evento: '2026-08-05T12:00:00Z',
    payload: {
      reliability: {
        repair_started_at: '2026-08-01T08:00:00Z',
        repair_completed_at: '2026-08-03T08:00:00Z',
      },
    },
  }]);
  assert.equal(summary.mttr.ready, true);
  assert.equal(summary.mttr.value_hours, 48);
});
