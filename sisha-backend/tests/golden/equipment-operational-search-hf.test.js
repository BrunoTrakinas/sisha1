const test = require('node:test');
const assert = require('node:assert/strict');
const {
  eventMatchesCurrentLocation,
  reasonEvidenceForCurrentLocation,
  deriveRepairPriority,
  buildOperationalRow,
  applyOperationalFilters,
} = require('../../src/services/equipmentOperationalSearchService');

test('motivo privilegia movimentação que explica a localização atual', () => {
  const equipment = { categoria_local_atual: 'RECEX', local_atual: 'RECEX' };
  const events = [
    { id: 3, tipo_evento: 'CONTROLE_CRITICO_LOCALIZACAO', data_evento: '2026-08-10T12:00:00Z', categoria_destino: 'RECEX', local_destino: 'RECEX', motivo: 'Snapshot do controle crítico.' },
    { id: 2, tipo_evento: 'REMOCAO_ANV', data_evento: '2026-08-01T12:00:00Z', categoria_destino: 'RECEX', local_destino: 'RECEX', motivo: 'Removido por pane e encaminhado ao RECEX.' },
  ];
  assert.equal(eventMatchesCurrentLocation(equipment, events[1]), true);
  assert.equal(reasonEvidenceForCurrentLocation(equipment, events).id, 2);
});


test('motivo não reutiliza uma passagem antiga pelo mesmo local após saída e retorno', () => {
  const equipment = { categoria_local_atual: 'RECEX', local_atual: 'RECEX' };
  const events = [
    { id: 5, tipo_evento: 'CONTROLE_CRITICO_LOCALIZACAO', data_evento: '2026-08-15T12:00:00Z', categoria_destino: 'RECEX', local_destino: 'RECEX', motivo: 'Posição atual confirmada no RECEX.' },
    { id: 4, tipo_evento: 'TRANSFERENCIA', data_evento: '2026-08-10T12:00:00Z', categoria_destino: 'PPU', local_destino: 'A1', motivo: 'Transferido ao PPU.' },
    { id: 3, tipo_evento: 'ENVIO_RECEX', data_evento: '2026-07-01T12:00:00Z', categoria_destino: 'RECEX', local_destino: 'RECEX', motivo: 'Pane antiga.' },
  ];
  const evidence = reasonEvidenceForCurrentLocation(equipment, events);
  assert.equal(evidence.id, 5);
  assert.equal(evidence.motivo, 'Posição atual confirmada no RECEX.');
});

test('emergência é fail-closed e exige criticidade explícita + PPU zero + reparo + sem conflito', () => {
  const equipment = { categoria_local_atual: 'RECEX', local_atual: 'RECEX', condicao_atual: 'AVARIADO' };
  const yes = deriveRepairPriority(equipment, { conflicts: 0, critical: true, criticalCurrentCompatible: true, ppuQty: 0, woState: 'SEM_WO' });
  assert.equal(yes.nivel, 'CRITICA');
  assert.equal(yes.candidato_emergencia_reparo, true);
  const noCritical = deriveRepairPriority(equipment, { conflicts: 0, critical: false, ppuQty: 0, woState: 'SEM_WO' });
  assert.equal(noCritical.candidato_emergencia_reparo, false);
  const conflict = deriveRepairPriority(equipment, { conflicts: 1, critical: true, criticalCurrentCompatible: true, ppuQty: 0, woState: 'SEM_WO' });
  assert.equal(conflict.nivel, 'INDETERMINADA');
  assert.equal(conflict.candidato_emergencia_reparo, false);
});



test('RECEX sozinho não prova necessidade de reparo nem gera urgência', () => {
  const equipment = { categoria_local_atual: 'RECEX', local_atual: 'RECEX', condicao_atual: 'PRONTO_USO' };
  const result = deriveRepairPriority(equipment, { conflicts: 0, critical: true, criticalCurrentCompatible: true, ppuQty: 0, woState: 'SEM_WO' });
  assert.equal(result.necessita_reparo_avaliacao, false);
  assert.equal(result.candidato_emergencia_reparo, false);
  assert.equal(result.nivel, 'NORMAL');
});

test('criticidade histórica incompatível com a posição atual não autoriza candidato emergencial', () => {
  const equipment = { categoria_local_atual: 'RECEX', local_atual: 'RECEX', condicao_atual: 'AVARIADO' };
  const result = deriveRepairPriority(equipment, { conflicts: 0, critical: true, criticalCurrentCompatible: false, ppuQty: 0, woState: 'SEM_WO' });
  assert.equal(result.candidato_emergencia_reparo, false);
  assert.ok(result.razoes.some((value) => value.includes('não coincide')));
});



test('falha/indeterminação do PPU bloqueia prioridade emergencial em vez de assumir saldo zero', () => {
  const equipment = { categoria_local_atual: 'RECEX', local_atual: 'RECEX', condicao_atual: 'AVARIADO' };
  const result = deriveRepairPriority(equipment, { conflicts: 0, critical: true, criticalCurrentCompatible: true, ppuKnown: false, ppuQty: 0, woState: 'SEM_WO' });
  assert.equal(result.candidato_emergencia_reparo, false);
  assert.equal(result.nivel, 'INDETERMINADA');
  assert.ok(result.razoes.some((value) => value.includes('não pôde ser confirmada')));
});

test('equipamento já em reparo não vira candidato a envio emergencial', () => {
  const equipment = { categoria_local_atual: 'REPARO_EXTERNO', local_atual: 'LEONARDO', condicao_atual: 'EM_REPARO' };
  const result = deriveRepairPriority(equipment, { conflicts: 0, critical: true, criticalCurrentCompatible: true, ppuQty: 0, woState: 'EM_REPARO' });
  assert.equal(result.candidato_emergencia_reparo, false);
  assert.equal(result.situacao_reparo, 'EM_REPARO');
});

test('dossiê operacional cruza controle crítico, PPU, WO e motivo sem inventar', () => {
  const equipment = { id: 7, pn: 'AAA', sn: '001', categoria_local_atual: 'RECEX', local_atual: 'RECEX', condicao_atual: 'AGUARDANDO_REPARO' };
  const events = [
    { id: 10, equipamento_id: 7, tipo_evento: 'CONTROLE_CRITICO_LOCALIZACAO', origem_evento: 'CONTROLE_CRITICOS', data_evento: '2026-08-10T12:00:00Z', categoria_destino: 'RECEX', local_destino: 'RECEX', motivo: 'Controle de Equipamentos Críticos indica posição.' },
    { id: 9, equipamento_id: 7, tipo_evento: 'ENVIO_RECEX', documento_tipo: 'PIM', documento: 'PIM 22/26', data_evento: '2026-08-01T12:00:00Z', categoria_destino: 'RECEX', local_destino: 'RECEX', motivo: 'Removido por pane.' },
  ];
  const row = buildOperationalRow(equipment, events, [], new Date('2026-08-17T12:00:00Z'));
  assert.equal(row.controle_critico, true);
  assert.equal(row.ppu_quantidade_efetiva_pn, 0);
  assert.equal(row.motivo_atual, 'Removido por pane.');
  assert.equal(row.prioridade_operacional.candidato_emergencia_reparo, true);
  assert.ok(row.fontes_dossie.some((value) => value.includes('CRÍTICOS')));
});

test('filtros avançados combinam localização, condição, motivo, fonte e emergência', () => {
  const rows = [
    {
      id: 1, categoria_local_atual: 'RECEX', local_atual: 'RECEX', condicao_atual: 'AVARIADO', motivo_atual: 'Pane', motivo_evento_tipo: 'REMOCAO_ANV', motivo_documento: 'PIM 1',
      fontes_flags: { critico: true }, controle_critico: true, conflitos_pendentes: 0, ppu_quantidade_efetiva_pn: 0, ppu_disponibilidade_conhecida: true,
      prioridade_operacional: { nivel: 'CRITICA', situacao_reparo: 'AGUARDANDO_ENVIO_AVALIACAO', candidato_emergencia_reparo: true }, dias_local_atual: 30,
    },
    {
      id: 2, categoria_local_atual: 'PPU', local_atual: 'A1', condicao_atual: 'PRONTO_USO', motivo_atual: 'Inventário',
      fontes_flags: { critico: false }, controle_critico: false, conflitos_pendentes: 0, ppu_quantidade_efetiva_pn: 2, ppu_disponibilidade_conhecida: true,
      prioridade_operacional: { nivel: 'NORMAL', situacao_reparo: 'SEM_INDICACAO', candidato_emergencia_reparo: false }, dias_local_atual: 2,
    },
  ];
  const filtered = applyOperationalFilters(rows, { location_category: 'RECEX', condition: 'AVARIADO', reason: 'PANE', source: 'CRITICO', emergency: 'true', ppu: 'ZERO', min_days: '10' });
  assert.deepEqual(filtered.map((row) => row.id), [1]);
});
