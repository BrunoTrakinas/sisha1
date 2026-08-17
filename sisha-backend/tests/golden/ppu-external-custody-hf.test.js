const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const parser = require('../../src/services/ppuExternalCustodyParserService');
const effective = require('../../src/services/ppuEffectiveAvailabilityService');

function fakeWorkbook(sheets) {
  return {
    xlsx: { utils: { sheet_to_json: (sheet) => sheet.rows } },
    workbook: { SheetNames: Object.keys(sheets), Sheets: Object.fromEntries(Object.entries(sheets).map(([name, rows]) => [name, { rows }])) },
  };
}

const header = ['Data/Hora', 'PN', 'NSN', 'Nomenclatura', 'Qtd', 'SN', 'Localizacao', 'Auditor_Nome', 'Auditor_NIP'];
const custody = (overrides = {}) => ({
  import_id: 'imp-1', group_key: overrides.group_key || 'g1', pn: 'PN123', box_code: 'CX-020',
  original_location: 'ECHO-1', original_location_normalized: 'ECHO-1', quantity: 5,
  nomenclature: 'ITEM TESTE', nsn_normalized: null, sn: null, ...overrides,
});
const base = (overrides = {}) => ({ pn: 'PN123', nomenclatura: 'ITEM TESTE', nsn_pi: null, sn: null, quantidade: 10, localizacao: 'ECHO-1', origem_saldo: 'PPU_OFICIAL', ...overrides });

test('HF Custódia PPU: parser aceita diretamente abas FECHADA CX-XXX e cabeçalho real do APP', () => {
  const { xlsx, workbook } = fakeWorkbook({
    'FECHADA CX-001': [header, ['15/08/2026 10:00', ' PN 123 ', 'XXX', 'Item teste', 2, '', 'ALFA - 9', 'Bruno', '123']],
    'FECHADA CX-002': [header],
  });
  const parsed = parser.parsePpuExternalCustodyWorkbook(xlsx, workbook);
  assert.equal(parsed.summary.closed_boxes, 2);
  assert.equal(parsed.summary.boxes_with_items, 1);
  assert.equal(parsed.summary.empty_boxes, 1);
  assert.equal(parsed.summary.item_rows, 1);
  assert.equal(parsed.items[0].box_code, 'CX-001');
  assert.equal(parsed.items[0].pn, 'PN123');
  assert.equal(parsed.items[0].nsn_normalized, null);
  assert.equal(parsed.items[0].original_location_normalized, 'ALFA-9');
});

test('HF Custódia PPU HF1: PN 25-2 usa o texto visível da célula e não a coerção de data do Excel', () => {
  const sheet = {
    rows: [header, ['30/04/2026 14:55', '25/02/2026', '996412886', 'BANDEJA DE BATERIA', 8, '', 'QUEBEC-6', 'Joannes', '14017105']],
    B2: { t: 'n', v: 46077, w: '25-2', z: 'd\\-m' },
  };
  const xlsx = {
    utils: {
      sheet_to_json: (value) => value.rows,
      encode_cell: ({ r, c }) => `${String.fromCharCode(65 + c)}${r + 1}`,
      format_cell: (cell) => cell.w || String(cell.v ?? ''),
    },
  };
  const workbook = { SheetNames: ['FECHADA CX-051'], Sheets: { 'FECHADA CX-051': sheet } };
  const parsed = parser.parsePpuExternalCustodyWorkbook(xlsx, workbook);
  assert.equal(parsed.items.length, 1);
  assert.equal(parsed.summary.issues, 0);
  assert.equal(parsed.items[0].pn, '25-2');
  assert.equal(parsed.items[0].pn_original, '25-2');
  assert.equal(parsed.items[0].quantity, 8);
  assert.equal(parsed.items[0].original_location, 'QUEBEC-6');
});

test('HF Custódia PPU HF1: data completa sem texto documental recuperável continua bloqueada', () => {
  const { xlsx, workbook } = fakeWorkbook({
    'FECHADA CX-051': [header, ['30/04/2026 14:55', '25/02/2026', '996412886', 'BANDEJA DE BATERIA', 8, '', 'QUEBEC-6', 'Joannes', '14017105']],
  });
  const parsed = parser.parsePpuExternalCustodyWorkbook(xlsx, workbook);
  assert.equal(parsed.items.length, 0);
  assert.equal(parsed.summary.issues, 1);
  assert.equal(parsed.issues[0].field, 'PN');
  assert.match(parsed.issues[0].reason, /texto documental exibido/i);
});

test('HF Custódia PPU: linhas repetidas são preservadas e quantidades são somadas, não deduplicadas', () => {
  const { xlsx, workbook } = fakeWorkbook({
    'FECHADA CX-034': [header,
      ['2026-08-15', 'PN123', '', 'Item', 1, '', 'PAPA-3', 'A', '1'],
      ['2026-08-15', 'PN123', '', 'Item', 1, '', 'PAPA-3', 'A', '1'],
    ],
  });
  const parsed = parser.parsePpuExternalCustodyWorkbook(xlsx, workbook);
  assert.equal(parsed.items.length, 2);
  assert.equal(parsed.groups.length, 1);
  assert.equal(parsed.groups[0].quantity, 2);
});

test('HF Custódia PPU: caixa reclassifica localização sem aumentar o total do PPU', () => {
  const result = effective.buildEffectivePpuAvailability(
    [base()],
    [custody({ group_key: 'a', box_code: 'CX-020', quantity: 5 }), custody({ group_key: 'b', box_code: 'CX-034', quantity: 5 })],
    []
  );
  assert.equal(result.summary.official_qty, 10);
  assert.equal(result.summary.effective_qty, 10);
  assert.equal(result.rows.filter((r) => r.localizacao.includes('CEIMSPA')).reduce((s, r) => s + r.quantidade, 0), 10);
  assert.equal(result.rows.filter((r) => r.localizacao === 'ECHO-1').reduce((s, r) => s + r.quantidade, 0), 0);
});

test('HF Custódia PPU: localização física CEIMSPA continua origem PPU e nunca vira saldo CeIMSPA', () => {
  const result = effective.buildEffectivePpuAvailability([base()], [custody()], []);
  const row = result.rows.find((r) => r.origem_saldo === 'PPU_CUSTODIA_EXTERNA');
  assert.equal(row.localizacao, 'CX-020 — CEIMSPA');
  assert.equal(row.custodia, 'PPU');
  assert.equal(row.local_fisico, 'CEIMSPA');
});

test('HF Custódia PPU: inventário que já traz a caixa absorve movimentação e impede dupla contagem', () => {
  const result = effective.buildEffectivePpuAvailability([
    base({ quantidade: 5 }),
    base({ quantidade: 5, localizacao: 'CAIXA 20' }),
  ], [custody({ quantity: 5 })], []);
  assert.equal(result.summary.effective_qty, 10);
  assert.equal(result.reconciliation[0].status, 'ABSORVIDO_PELO_INVENTARIO');
  assert.equal(result.rows.filter((r) => r.localizacao === 'CX-020 — CEIMSPA').reduce((s, r) => s + r.quantidade, 0), 5);
});

test('HF Custódia PPU: divergência nunca produz saldo negativo nem inventa quantidade', () => {
  const result = effective.buildEffectivePpuAvailability([base({ quantidade: 3 })], [custody({ quantity: 5 })], []);
  assert.equal(result.summary.effective_qty, 3);
  assert.equal(result.summary.blocked_qty, 2);
  assert.equal(result.summary.divergence_groups, 1);
  assert.equal(result.reconciliation[0].status, 'DIVERGENCIA');
});

test('HF Custódia PPU: confirmação Admin/Dono pode reconhecer evidência física excedente de forma explícita', () => {
  const result = effective.buildEffectivePpuAvailability(
    [base({ quantidade: 3 })],
    [custody({ quantity: 5 })],
    [{ group_key: 'g1', decision: 'CONFIRMAR_CUSTODIA', reason: 'Contagem física conferida' }]
  );
  assert.equal(result.summary.effective_qty, 5);
  assert.equal(result.summary.blocked_qty, 0);
  assert.equal(result.reconciliation[0].status, 'CONFIRMADO_ADMIN');
});

test('HF Custódia PPU: decisão IGNORAR mantém fotografia oficial intacta', () => {
  const result = effective.buildEffectivePpuAvailability(
    [base()], [custody()], [{ group_key: 'g1', decision: 'IGNORAR_MOVIMENTACAO', reason: 'Lançamento indevido' }]
  );
  assert.equal(result.summary.effective_qty, 10);
  assert.equal(result.rows.some((r) => r.origem_saldo === 'PPU_CUSTODIA_EXTERNA'), false);
});

test('HF Custódia PPU: saldo temporário de recibo não é consumido para reconciliar caixa antiga', () => {
  const result = effective.buildEffectivePpuAvailability([
    base({ quantidade: 2 }),
    base({ quantidade: 3, origem_saldo: 'RECIBO_PENDENTE', recebimento_id: 'r1', recebimento_item_id: 'ri1', numero_recibo: '001/2026' }),
  ], [custody({ quantity: 5 })], []);
  const externalQty = result.rows.filter((r) => r.origem_saldo === 'PPU_CUSTODIA_EXTERNA').reduce((s, r) => s + r.quantidade, 0);
  const receiptQty = result.rows.filter((r) => r.origem_saldo === 'RECIBO_PENDENTE').reduce((s, r) => s + r.quantidade, 0);
  assert.equal(externalQty, 2);
  assert.equal(receiptQty, 3);
  assert.equal(result.summary.blocked_qty, 3);
});

test('HF Custódia PPU: migration é server-only, append-only e não altera estoque_ppu', () => {
  const sql = fs.readFileSync(path.join(__dirname, '../../sql/migrations/20260815_HF_PPU_002_custodia_externa_caixas_ceimspa.sql'), 'utf8');
  assert.match(sql, /enable row level security/i);
  assert.match(sql, /grant execute .*service_role/i);
  assert.match(sql, /SUPERSEDED/i);
  assert.match(sql, /pg_advisory_xact_lock/i);
  assert.match(sql, /pn_original/i);
  assert.match(sql, /imp\.status = 'ACTIVE'/i);
  assert.doesNotMatch(sql, /delete\s+from\s+public\.estoque_ppu/i);
  assert.doesNotMatch(sql, /update\s+public\.estoque_ppu/i);
});

test('HF Custódia PPU: Radar, Gerador, A4, Custos e Chat Lince usam disponibilidade efetiva central', () => {
  const root = path.join(__dirname, '../..');
  const search = fs.readFileSync(path.join(root, 'src/controllers/searchController.js'), 'utf8');
  const needs = fs.readFileSync(path.join(root, 'src/controllers/needsController.js'), 'utf8');
  const a4 = fs.readFileSync(path.join(root, 'src/services/logisticsIntelligenceService.js'), 'utf8');
  const stats = fs.readFileSync(path.join(root, 'src/controllers/statsController.js'), 'utf8');
  const chat = fs.readFileSync(path.join(root, 'src/services/chatLinceDbToolsService.js'), 'utf8');
  assert.match(search, /loadEffectivePpuRowsByPns/);
  assert.match(needs, /loadAllEffectivePpuRows/);
  assert.match(a4, /loadEffectivePpuRowsByPns/);
  assert.match(stats, /loadAllEffectivePpuRows/);
  assert.match(chat, /v_sisha_ppu_disponibilidade_efetiva/);
});

test('HF Custódia PPU: Central aceita Backend_Auditoria_Paiol e oferece revisão Admin/Dono sem redesenhar Radar', () => {
  const root = path.join(__dirname, '../../..');
  const cadastro = fs.readFileSync(path.join(root, 'sisha-frontend/src/pages/Cadastro.jsx'), 'utf8');
  const consulta = fs.readFileSync(path.join(root, 'sisha-frontend/src/pages/ConsultaItens.jsx'), 'utf8');
  assert.match(cadastro, /Backend_Auditoria_Paiol — Caixas CEIMSPA sob custódia PPU/);
  assert.match(cadastro, /REVISAR RECONCILIAÇÃO/);
  assert.match(consulta, /PPU_CUSTODIA_EXTERNA/);
  assert.match(consulta, /Custódia PPU • localização física em caixa no CEIMSPA/);
});
