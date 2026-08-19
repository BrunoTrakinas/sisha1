const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  buildRecipePolicyDeficiency,
  buildPurchaseCoverage,
  formatRecipePolicyDeficiencyRows,
} = require('../../src/services/recipePolicyDeficiencyService');

const ROOT = path.resolve(__dirname, '../..');

function mapQty(entries = {}) {
  return new Map(Object.entries(entries).map(([pn, quantidade]) => [pn, { quantidade, docs: new Set() }]));
}

test('HF deficiência: Política 20 x Receita 1 consolida necessidade e mostra demanda a providenciar', () => {
  const now = new Date('2026-08-19T12:00:00Z');
  const result = buildRecipePolicyDeficiency({
    selectedRecipes: ['TROCA MOTOR'],
    recipeRows: [{ inspecao: 'TROCA MOTOR', pn: 'PN-123', nomenclatura: 'ITEM A', qtd_por_ciclo: 1 }],
    policyRows: [{ tarefas: 'TROCA MOTOR', tipo: 'Receita', prioridade: 1, qtde_2_anos: 20 }],
    ppuMap: mapQty({ 'PN-123': 10 }),
    purchaseRows: [
      { pn: 'PN-123', status: 'ODA', ativo: true, quantidade: 3, qtd_recebida: 0, data_previsao_entrega: '2027-03-01' },
      { pn: 'PN-123', status: 'FAT', ativo: true, quantidade: 4, qtd_recebida: 0, data_previsao_entrega: null },
      { pn: 'PN-123', status: 'CAN', ativo: false, quantidade: 99, qtd_recebida: 0, data_previsao_entrega: '2027-01-01' },
      { pn: 'PN-123', status: 'ODC', ativo: true, quantidade: 1, qtd_recebida: 0, data_previsao_entrega: '2027-02-01' },
    ],
    ceimspaRows: [{ pn: 'PN-123', quantidade: 2 }],
    now,
  });

  assert.equal(result.summary.receitas_com_politica, 1);
  assert.equal(result.summary.pns_deficientes, 1);
  assert.equal(result.summary.necessidade_2_anos, 20);
  assert.equal(result.summary.deficit_a_providenciar, 3);
  assert.equal(result.summary.risco_cobertura_no_horizonte, 7);
  const row = result.rows[0];
  assert.equal(row.ppu_efetivo, 10);
  assert.equal(row.compras_comprometidas_no_horizonte, 3);
  assert.equal(row.compras_comprometidas_sem_data, 4);
  assert.equal(row.deficit_a_providenciar, 3);
  assert.equal(row.risco_cobertura_no_horizonte, 7);
  assert.equal(row.ceimspa_potencial, 2);
  assert.equal(row.pipeline_potencial_no_horizonte, 1);
  assert.equal(row.status, 'COBERTURA_POTENCIAL');
});

test('HF deficiência: mesmo PN em duas receitas usa o PPU uma única vez', () => {
  const result = buildRecipePolicyDeficiency({
    selectedRecipes: ['TROCA MOTOR', 'INSPEÇÃO X'],
    recipeRows: [
      { inspecao: 'TROCA MOTOR', pn: 'ABC', qtd_por_ciclo: 1 },
      { inspecao: 'INSPEÇÃO X', pn: 'ABC', qtd_por_ciclo: 2 },
    ],
    policyRows: [
      { tarefas: 'TROCA MOTOR', tipo: 'Receita', prioridade: 1, qtde_2_anos: 20 },
      { tarefas: 'INSPEÇÃO X', tipo: 'Receita', prioridade: 2, qtde_2_anos: 5 },
    ],
    ppuMap: mapQty({ ABC: 10 }),
  });
  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0].necessidade_2_anos, 30);
  assert.equal(result.rows[0].ppu_efetivo, 10);
  assert.equal(result.rows[0].deficit_a_providenciar, 20);
  assert.equal(result.summary.receitas_deficientes, 2);
});

test('HF deficiência: política/receita incompleta falha fechada sem presumir quantidade', () => {
  const result = buildRecipePolicyDeficiency({
    selectedRecipes: ['SEM POLÍTICA', 'SEM CICLOS', 'SEM QTD ITEM'],
    recipeRows: [
      { inspecao: 'SEM POLÍTICA', pn: 'A', qtd_por_ciclo: 1 },
      { inspecao: 'SEM CICLOS', pn: 'B', qtd_por_ciclo: 1 },
      { inspecao: 'SEM QTD ITEM', pn: 'C', qtd_por_ciclo: 0 },
    ],
    policyRows: [
      { tarefas: 'SEM CICLOS', tipo: 'Receita', prioridade: 1, qtde_2_anos: 0 },
      { tarefas: 'SEM QTD ITEM', tipo: 'Receita', prioridade: 1, qtde_2_anos: 10 },
    ],
  });
  assert.equal(result.rows.length, 0);
  assert.equal(result.blockers.length, 3);
  assert.deepEqual(new Set(result.blockers.map((row) => row.codigo)), new Set([
    'POLITICA_NAO_CADASTRADA',
    'POLITICA_SEM_QTDE_2_ANOS',
    'ITEM_RECEITA_SEM_QTD_POR_CICLO',
  ]));
});

test('HF deficiência: ODA/FAT/EMB sem data evita compra duplicada mas mantém risco de prazo', () => {
  const result = buildRecipePolicyDeficiency({
    selectedRecipes: ['TROCA MOTOR'],
    recipeRows: [{ inspecao: 'TROCA MOTOR', pn: 'MOTOR-X', qtd_por_ciclo: 1 }],
    policyRows: [{ tarefas: 'TROCA MOTOR', tipo: 'Receita', prioridade: 1, qtde_2_anos: 20 }],
    ppuMap: mapQty({ 'MOTOR-X': 10 }),
    purchaseRows: [{ pn: 'MOTOR-X', status: 'ODA', ativo: true, quantidade: 10, qtd_recebida: 0, data_previsao_entrega: null }],
  });
  const row = result.rows[0];
  assert.equal(row.deficit_a_providenciar, 0);
  assert.equal(row.risco_cobertura_no_horizonte, 10);
  assert.equal(row.status, 'COBERTO_COMPROMETIDO_COM_RISCO_PRAZO');
  assert.equal(result.summary.pns_deficientes, 0);
});

test('HF deficiência: compra CAN/REC/inativa nunca reduz a deficiência', () => {
  const coverage = buildPurchaseCoverage([
    { pn: 'X', status: 'CAN', ativo: false, quantidade: 10, data_previsao_entrega: '2027-01-01' },
    { pn: 'X', status: 'REC', ativo: true, quantidade: 10, data_previsao_entrega: '2027-01-01' },
    { pn: 'X', status: 'ODA', ativo: true, quantidade: 5, qtd_recebida: 2, data_previsao_entrega: '2027-01-01' },
  ], 'X', { now: new Date('2026-08-19T12:00:00Z'), horizonDays: 730 });
  assert.equal(coverage.committed_within_horizon, 3);
  assert.equal(coverage.canonical_rows, 1);
});

test('HF deficiência: fallback Order Book só é usado quando não existe compra canônica para o PN', () => {
  const oda = mapQty({ FALL: 6 });
  oda.get('FALL').docs.add('PD-1');
  const result = buildRecipePolicyDeficiency({
    selectedRecipes: ['R'],
    recipeRows: [{ inspecao: 'R', pn: 'FALL', qtd_por_ciclo: 1 }],
    policyRows: [{ tarefas: 'R', tipo: 'Receita', prioridade: 1, qtde_2_anos: 10 }],
    odaFallbackMap: oda,
  });
  assert.equal(result.rows[0].compras_comprometidas_sem_data, 6);
  assert.equal(result.rows[0].fonte_compra, 'FALLBACK_ORDER_BOOK_ODC');
  assert.match(result.rows[0].documentos_compra, /PD-1/);
});

test('HF deficiência: Excel recebe campos de Política × Receita, demanda e risco de prazo', () => {
  const rows = formatRecipePolicyDeficiencyRows([{
    pn: 'ABC', nsn: '123', nomenclatura: 'ITEM', prioridade_mais_alta: 1,
    receitas_texto: 'TROCA MOTOR: 20 ciclo(s) × 1 = 20', necessidade_2_anos: 20,
    ppu_efetivo: 10, deficit_imediato: 10, compras_comprometidas_no_horizonte: 2,
    compras_comprometidas_sem_data: 3, compras_comprometidas_fora_horizonte: 0,
    compras_comprometidas_total: 5, risco_cobertura_no_horizonte: 8, deficit_a_providenciar: 5, ceimspa_potencial: 1, pipeline_potencial_no_horizonte: 2,
    pipeline_potencial_sem_data: 0, deficit_apos_potenciais: 2, cobertura_confirmada_percentual: 60,
    status: 'DEFICIENTE', documentos_compra: 'PD-1', fonte_compra: 'COMPRAS_PDS', nota: 'n',
  }]);
  assert.equal(rows[0].Deficit_A_Providenciar, 5);
  assert.equal(rows[0].Risco_Cobertura_No_Horizonte, 8);
  assert.match(rows[0].Receitas_Politica, /TROCA MOTOR/);
  assert.equal(rows[0].PPU_Efetivo, 10);
});

test('HF deficiência: integração é cirúrgica no Gerador e não cria rota/tabela nova', () => {
  const controller = fs.readFileSync(path.join(ROOT, 'src/controllers/needsController.js'), 'utf8');
  const routes = fs.readFileSync(path.join(ROOT, 'src/routes/needsRoutes.js'), 'utf8');
  const frontend = fs.readFileSync(path.resolve(ROOT, '../sisha-frontend/src/pages/GeradorNecessidades.jsx'), 'utf8');
  assert.match(controller, /buildRecipePolicyDeficiency/);
  assert.match(controller, /fetchAllRows\('compras_pds', '\*'\)/);
  assert.match(controller, /00_DEFICIENCIAS_RECEITAS/);
  assert.match(frontend, /Deficiência automática — Política × Receita/);
  assert.match(frontend, /deficit_a_providenciar/);
  assert.doesNotMatch(routes, /recipe-deficiency/);
});
