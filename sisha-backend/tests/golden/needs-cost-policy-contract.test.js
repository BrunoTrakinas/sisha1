const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const BACKEND = path.resolve(__dirname, '../..');
const PROJECT = path.resolve(BACKEND, '..');
const readBackend = (relative) => fs.readFileSync(path.join(BACKEND, relative), 'utf8');
const readProject = (relative) => fs.readFileSync(path.join(PROJECT, relative), 'utf8');

test('GOLDEN Necessidades: Gerador continua seletivo por origens escolhidas', () => {
  const source = readBackend('src/controllers/needsController.js');
  assert.match(source, /selectedOrigemSet\.size === 0 \|\| selectedOrigemSet\.has\(origemKey\)/);
});

test('GOLDEN MT: sobreposição usa evidência D/I e permanece fail-closed sem aeronave I', () => {
  const controller = readBackend('src/controllers/needsController.js');
  const policy = readBackend('src/services/mtNeedPolicyService.js');
  assert.match(controller, /buildMtAvailabilityDecision/);
  assert.match(controller, /quantidade: mtDecision\.blocked \? 0 : quantidadeOriginal/);
  assert.match(policy, /RELATED_AIRCRAFT_UNAVAILABLE/);
  assert.match(policy, /UNAVAILABLE_EVIDENCE_REQUIRED/);
  assert.match(policy, /status === 'I'/);
});

test('GOLDEN Custos: custo unitário e projeção continuam separados', () => {
  const source = readBackend('src/controllers/needsController.js');
  assert.match(source, /qtd_unitaria/);
  assert.match(source, /qtd_planejada/);
  assert.match(source, /custo_execucao_gbp/);
  assert.match(source, /custo_projetado_gbp/);
});

test('GOLDEN Cotação: preço histórico pode preencher estimativa e continuar elegível a cotação', () => {
  const costPage = readProject('sisha-frontend/src/pages/CustoOperacional.jsx');
  const needsPage = readProject('sisha-frontend/src/pages/GeradorNecessidades.jsx');
  const modal = readProject('sisha-frontend/src/components/CotacaoRequestModal.jsx');
  assert.match(costPage, /row\.necessita_cotacao/);
  assert.match(needsPage, /row\.necessita_cotacao/);
  assert.match(modal, /referência vencida\/histórica/);
});
