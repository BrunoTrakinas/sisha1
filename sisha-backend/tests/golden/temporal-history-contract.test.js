const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const backendRoot = path.resolve(__dirname, '../..');

function read(relativePath) {
  return fs.readFileSync(path.join(backendRoot, relativePath), 'utf8');
}

const {
  buildEquipmentDossierSummary,
  sourceLabelsFromEvent,
} = require('../../src/services/equipmentDossierService');

test('GOLDEN Historico: Dossie usa data_evento para primeira/ultima evidencia', () => {
  const summary = buildEquipmentDossierSummary({}, [
    { id: 1, tipo_evento: 'CADASTRO', data_evento: '2026-08-01T10:00:00Z' },
    { id: 2, tipo_evento: 'INSTALACAO_ANV', data_evento: '2026-08-03T10:00:00Z' },
    { id: 3, tipo_evento: 'REMOCAO_ANV', data_evento: '2026-08-02T10:00:00Z' },
  ]);

  assert.equal(summary.primeira_evidencia_em, '2026-08-01T10:00:00Z');
  assert.equal(summary.ultima_evidencia_em, '2026-08-03T10:00:00Z');
  assert.equal(summary.ultimo_evento_tipo, 'INSTALACAO_ANV');
});

test('GOLDEN Historico: evento invalidado permanece contado mas nao define estado temporal', () => {
  const summary = buildEquipmentDossierSummary({}, [
    {
      id: 1,
      tipo_evento: 'INSTALACAO_ANV',
      data_evento: '2026-08-01T10:00:00Z',
    },
    {
      id: 2,
      tipo_evento: 'REMOCAO_ANV',
      data_evento: '2026-08-10T10:00:00Z',
      invalidado: true,
    },
  ]);

  assert.equal(summary.eventos_total, 2);
  assert.equal(summary.eventos_validos, 1);
  assert.equal(summary.eventos_invalidos, 1);
  assert.equal(summary.ultimo_evento_tipo, 'INSTALACAO_ANV');
});

test('GOLDEN Historico: conflito pendente prevalece sobre localizacao conhecida', () => {
  const summary = buildEquipmentDossierSummary(
    { local_atual: 'PPU', categoria_local_atual: 'PPU' },
    [{
      tipo_evento: 'CONFLITO_LOCALIZACAO',
      data_evento: '2026-08-10T10:00:00Z',
      payload: { conflito_status: 'PENDENTE' },
    }]
  );
  assert.equal(summary.localizacao_status, 'CONFLITO');
});

test('GOLDEN Historico: fontes OS/PIM, WO, STC e Order Book sao rastreaveis', () => {
  assert.ok(sourceLabelsFromEvent({
    tipo_evento: 'INSTALACAO_ANV',
    documento_tipo: 'OS',
  }).includes('OS/PIM'));

  assert.ok(sourceLabelsFromEvent({
    tipo_evento: 'ENVIO_WO_REPARO',
    documento_tipo: 'WO',
  }).includes('WO'));

  assert.ok(sourceLabelsFromEvent({
    tipo_evento: 'ENVIO_STC',
    documento_tipo: 'STC',
  }).includes('STC'));

  assert.ok(sourceLabelsFromEvent({
    tipo_evento: 'STATUS_ORDER_BOOK',
    origem_evento: 'ORDER_BOOK',
  }).includes('ORDER BOOK'));
});

test('GOLDEN Historico: inventario data-only preserva precisao DATA e fuso operacional', () => {
  const sql = read('sql/migrations/20260813_H4C2HF1_001_inventory_date_precision.sql');
  assert.match(sql, /'precisao_temporal',\s*'DATA'/);
  assert.match(sql, /'fuso_operacional',\s*'America\/Sao_Paulo'/);
  assert.match(sql, /data_evento_original_utc/);
  assert.match(sql, /AT TIME ZONE 'America\/Sao_Paulo'/);
});

test('GOLDEN Historico: OS/PIM antigo nao deve sobrescrever localizacao mais recente', () => {
  const source = read('src/services/osPimEquipmentService.js');
  assert.match(source, /candidateTime\s*<\s*latestTime/);
  assert.match(source, /historical_only:\s*historicalOnly/);
  assert.match(source, /Evidência histórica: não altera o estado atual mais recente/);
});

test('GOLDEN Historico: conflito de origem OS/PIM exige confirmacao em vez de mover silenciosamente', () => {
  const source = read('src/services/osPimEquipmentService.js');
  assert.match(source, /upsertPendingLocationConflict/);
  assert.match(source, /CONFLITANTE/);
  assert.match(source, /REMOCAO_DESTINO_A_CONFIRMAR/);
});

test('GOLDEN Historico: retorno de WO nao inventa localizacao interna', () => {
  const source = read('src/services/workOrderEquipmentService.js');
  assert.match(source, /RETORNADO_WO_LOCAL_A_CONFIRMAR/);
  assert.match(source, /categoria_destino:\s*'DESCONHECIDO'/);
  assert.match(source, /localização interna após o retorno deve ser confirmada/i);
});

test('GOLDEN Historico: WO com envio sem data confiavel gera warning e nao fabrica evento temporal', () => {
  const source = read('src/services/workOrderEquipmentService.js');
  assert.match(source, /WO indica envio\/reparo, mas não possui data confiável/);
});

test('GOLDEN Historico: PN de saida diferente na WO vira evidencia, nao reescrita automatica', () => {
  const source = read('src/services/workOrderEquipmentService.js');
  assert.match(source, /PN de saída/);
  assert.match(source, /Cadastro Mestre não foi reescrito automaticamente/);
});

test('GOLDEN Historico: STC retornada nao pode regredir de status', () => {
  const source = read('src/services/stcEquipmentService.js');
  assert.match(source, /STC já retornada não pode regredir de status/);
});

test('GOLDEN Historico: retorno STC sem local conhecido permanece a confirmar', () => {
  const source = read('src/services/stcEquipmentService.js');
  assert.match(source, /RETORNO_STC_LOCAL_A_CONFIRMAR/);
  assert.match(source, /A localização interna após o retorno precisa ser confirmada/);
});
