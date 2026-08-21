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

test('HF deficiência v2: Política × Receita usa PPU + CeIMSPA + ODA e não reutiliza FAT/EMB/REC', () => {
  const now = new Date('2026-08-21T12:00:00Z');
  const result = buildRecipePolicyDeficiency({
    selectedRecipes: ['TROCA MOTOR'],
    recipeRows: [{ inspecao: 'TROCA MOTOR', pn: 'PN-123', nomenclatura: 'ITEM A', qtd_por_ciclo: 1 }],
    policyRows: [{ tarefas: 'TROCA MOTOR', tipo: 'Receita', prioridade: 1, qtde_2_anos: 20 }],
    ppuMap: mapQty({ 'PN-123': 4 }),
    ceimspaRows: [{ pn: 'PN-123', quantidade: 3 }],
    purchaseRows: [
      { pn: 'PN-123', numero_pd: 'PD-ODA', status: 'ODA', ativo: true, quantidade: 5, qtd_recebida: 1, data_previsao_entrega: '2027-03-01' },
      { pn: 'PN-123', numero_pd: 'PD-FAT', status: 'FAT', ativo: true, quantidade: 50, qtd_recebida: 0 },
      { pn: 'PN-123', numero_pd: 'PD-EMB', status: 'EMB', ativo: true, quantidade: 50, qtd_recebida: 0 },
      { pn: 'PN-123', numero_pd: 'PD-REC', status: 'REC', ativo: true, quantidade: 50, qtd_recebida: 50 },
      { pn: 'PN-123', numero_pd: 'PD-ODC', status: 'ODC', ativo: true, quantidade: 9, qtd_recebida: 0, data_previsao_entrega: '2027-02-01' },
    ],
    now,
  });

  const row = result.rows[0];
  assert.equal(row.necessidade_2_anos, 20);
  assert.equal(row.ppu_efetivo, 4);
  assert.equal(row.ceimspa_disponivel, 3);
  assert.equal(row.oda_a_receber_total, 4); // 5 compradas - 1 já recebida
  assert.equal(row.odc_em_andamento, 9);
  assert.equal(row.deficit_a_providenciar, 9); // 20 - 4 - 3 - 4
  assert.equal(row.entregas_historicas_fat_emb_rec, 3);
  assert.equal(row.status, 'DEFICIENTE_COM_ODC_EM_ANDAMENTO');
  assert.match(row.nota, /ODC em andamento/i);
  assert.match(row.nota, /não abate/i);
});

test('HF deficiência v2: ODC nunca reduz o déficit, apenas sinaliza processo em andamento', () => {
  const result = buildRecipePolicyDeficiency({
    selectedRecipes: ['R'],
    recipeRows: [{ inspecao: 'R', pn: 'X', qtd_por_ciclo: 1 }],
    policyRows: [{ tarefas: 'R', tipo: 'Receita', prioridade: 1, qtde_2_anos: 6 }],
    purchaseRows: [{ pn: 'X', numero_pd: 'PD-ODC', status: 'ODC', ativo: true, quantidade: 6 }],
  });
  assert.equal(result.rows[0].deficit_a_providenciar, 6);
  assert.equal(result.rows[0].odc_em_andamento, 6);
  assert.equal(result.rows[0].status, 'DEFICIENTE_COM_ODC_EM_ANDAMENTO');
});

test('HF deficiência v2: ODA sem data evita compra duplicada e mantém risco de prazo', () => {
  const result = buildRecipePolicyDeficiency({
    selectedRecipes: ['TROCA MOTOR'],
    recipeRows: [{ inspecao: 'TROCA MOTOR', pn: 'MOTOR-X', qtd_por_ciclo: 1 }],
    policyRows: [{ tarefas: 'TROCA MOTOR', tipo: 'Receita', prioridade: 1, qtde_2_anos: 20 }],
    ppuMap: mapQty({ 'MOTOR-X': 10 }),
    purchaseRows: [{ pn: 'MOTOR-X', numero_pd: 'PD1', status: 'ODA', ativo: true, quantidade: 10, qtd_recebida: 0, data_previsao_entrega: null }],
  });
  const row = result.rows[0];
  assert.equal(row.deficit_a_providenciar, 0);
  assert.equal(row.risco_cobertura_no_horizonte, 10);
  assert.equal(row.status, 'COBERTO_COM_ODA_RISCO_PRAZO');
  assert.equal(result.summary.pns_deficientes, 0);
});

test('HF deficiência v2: mesmo PN em duas receitas usa a cobertura uma única vez', () => {
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
    ceimspaRows: [{ pn: 'ABC', quantidade: 5 }],
    purchaseRows: [{ pn: 'ABC', status: 'ODA', ativo: true, quantidade: 4 }],
  });
  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0].necessidade_2_anos, 30);
  assert.equal(result.rows[0].deficit_a_providenciar, 11);
  assert.equal(result.summary.receitas_deficientes, 2);
});

test('HF deficiência v2: política/receita incompleta continua fail-closed', () => {
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
});

test('HF deficiência v2: FAT/EMB/REC ficam históricos e não contam como saldo futuro', () => {
  const coverage = buildPurchaseCoverage([
    { pn: 'X', numero_pd: 'F1', status: 'FAT', ativo: true, quantidade: 10 },
    { pn: 'X', numero_pd: 'E1', status: 'EMB', ativo: true, quantidade: 10 },
    { pn: 'X', numero_pd: 'R1', status: 'REC', ativo: true, quantidade: 10, qtd_recebida: 10 },
    { pn: 'X', numero_pd: 'O1', status: 'ODA', ativo: true, quantidade: 5, qtd_recebida: 2, data_previsao_entrega: '2027-01-01' },
  ], 'X', { now: new Date('2026-08-21T12:00:00Z'), horizonDays: 730 });
  assert.equal(coverage.committed_within_horizon, 3);
  assert.equal(coverage.historical_delivered_rows, 3);
  assert.equal(coverage.canonical_rows, 4);
});

test('HF deficiência v2: fallback Order Book mantém ODA e ODC separados', () => {
  const oda = mapQty({ FALL: 6 });
  oda.get('FALL').docs.add('PD-ODA');
  const odc = mapQty({ FALL: 2 });
  odc.get('FALL').docs.add('PD-ODC');
  const result = buildRecipePolicyDeficiency({
    selectedRecipes: ['R'],
    recipeRows: [{ inspecao: 'R', pn: 'FALL', qtd_por_ciclo: 1 }],
    policyRows: [{ tarefas: 'R', tipo: 'Receita', prioridade: 1, qtde_2_anos: 10 }],
    odaFallbackMap: oda,
    odcFallbackMap: odc,
  });
  const row = result.rows[0];
  assert.equal(row.oda_a_receber_total, 6);
  assert.equal(row.odc_em_andamento, 2);
  assert.equal(row.deficit_a_providenciar, 4);
  assert.equal(row.fonte_compra, 'FALLBACK_ORDER_BOOK');
  assert.match(row.documentos_oda, /PD-ODA/);
  assert.match(row.documentos_odc, /PD-ODC/);
});

test('HF deficiência v2: Excel explicita Política, PPU, CeIMSPA, ODA, ODC e déficit', () => {
  const rows = formatRecipePolicyDeficiencyRows([{
    pn: 'ABC', nsn: '123', nomenclatura: 'ITEM', prioridade_mais_alta: 1,
    receitas_texto: 'TROCA MOTOR: 20 ciclo(s) × 1 = 20', necessidade_2_anos: 20,
    ppu_efetivo: 5, ceimspa_disponivel: 3, cobertura_fisica_atual: 8, deficit_apos_estoques: 12,
    oda_no_horizonte: 4, oda_sem_data: 1, oda_fora_horizonte: 0, oda_a_receber_total: 5,
    deficit_a_providenciar: 7, odc_em_andamento: 6, risco_cobertura_no_horizonte: 1,
    cobertura_confirmada_percentual: 65, entregas_historicas_fat_emb_rec: 2,
    documentos_oda: 'PD-1', documentos_odc: 'PD-2', documentos_historicos_fat_emb_rec: 'PD-3 (REC)',
    status: 'DEFICIENTE_COM_ODC_EM_ANDAMENTO', fonte_compra: 'COMPRAS_PDS', nota: 'n',
  }]);
  assert.equal(rows[0].Necessidade_2_Anos, 20);
  assert.equal(rows[0].PPU_Efetivo, 5);
  assert.equal(rows[0].CeIMSPA_Disponivel, 3);
  assert.equal(rows[0].ODA_A_Receber_Total, 5);
  assert.equal(rows[0].ODC_Em_Andamento, 6);
  assert.equal(rows[0].Deficit_A_Providenciar, 7);
});

test('HF deficiência v2: integração do Gerador expõe a decisão sem criar rota paralela', () => {
  const controller = fs.readFileSync(path.join(ROOT, 'src/controllers/needsController.js'), 'utf8');
  const routes = fs.readFileSync(path.join(ROOT, 'src/routes/needsRoutes.js'), 'utf8');
  const frontend = fs.readFileSync(path.resolve(ROOT, '../sisha-frontend/src/pages/GeradorNecessidades.jsx'), 'utf8');
  assert.match(controller, /buildRecipePolicyDeficiency/);
  assert.match(controller, /ODC é processo administrativo em andamento/);
  assert.match(frontend, /Política de estoque • horizonte de 2 anos/);
  assert.match(frontend, /ODC alerta/);
  assert.match(frontend, /Falta comprar/);
  assert.doesNotMatch(routes, /recipe-deficiency/);
});
