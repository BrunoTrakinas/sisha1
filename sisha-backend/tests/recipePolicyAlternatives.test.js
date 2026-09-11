const test = require('node:test');
const assert = require('node:assert/strict');
const { buildRecipePolicyDeficiency } = require('../src/services/recipePolicyDeficiencyService');

function policy() {
  return [{ tipo: 'RECEITA', tarefas: 'R1', qtde_2_anos: 1, prioridade: 1 }];
}

test('estoque de PN alternativo reduz a necessidade antes da ODA', () => {
  const result = buildRecipePolicyDeficiency({
    selectedRecipes: ['R1'],
    recipeRows: [{ inspecao: 'R1', pn: 'ABC', qtd_por_ciclo: 100, nomenclatura: 'ITEM ABC' }],
    policyRows: policy(),
    ppuMap: new Map([
      ['ABC', { quantidade: 20 }],
      ['DEF', { quantidade: 30 }],
    ]),
    pnAlternativeMap: new Map([['ABC', new Set(['DEF'])]]),
    pnPiMap: new Map(),
  });

  assert.equal(result.rows[0].alternativos_aplicado, 30);
  assert.equal(result.rows[0].deficit_a_providenciar, 50);
  assert.match(result.rows[0].alternativos_texto, /DEF/);
});

test('saldo Sem Demanda do mesmo PI é consumido uma vez entre dois PNs', () => {
  const result = buildRecipePolicyDeficiency({
    selectedRecipes: ['R1'],
    recipeRows: [
      { inspecao: 'R1', pn: 'ABC', qtd_por_ciclo: 30, nomenclatura: 'ITEM ABC' },
      { inspecao: 'R1', pn: 'DEF', qtd_por_ciclo: 30, nomenclatura: 'ITEM DEF' },
    ],
    policyRows: policy(),
    ceimspaRows: [{ id: 'SEM-1', pn: null, pi: '123', quantidade: 40, fonte_identificacao: 'CEIMSPA_SEM_DEMANDA' }],
    pnPiMap: new Map([
      ['ABC', new Set(['123'])],
      ['DEF', new Set(['123'])],
    ]),
    pnAlternativeMap: new Map([
      ['ABC', new Set(['DEF'])],
      ['DEF', new Set(['ABC'])],
    ]),
  });

  assert.equal(result.summary.necessidade_2_anos, 60);
  assert.equal(result.summary.deficit_a_providenciar, 20);
  assert.equal(result.rows.reduce((sum, row) => sum + row.cobertura_fisica_atual, 0), 40);
});
