const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..', '..', '..');
const dataAdmin = fs.readFileSync(path.join(root, 'sisha-frontend/src/components/DataAdminManager.jsx'), 'utf8');
const needsPanel = fs.readFileSync(path.join(root, 'sisha-frontend/src/components/NeedsFoundationPanel.jsx'), 'utf8');
const itemController = fs.readFileSync(path.join(root, 'sisha-backend/src/controllers/itemController.js'), 'utf8');
const purchaseController = fs.readFileSync(path.join(root, 'sisha-backend/src/controllers/purchaseController.js'), 'utf8');
const needsController = fs.readFileSync(path.join(root, 'sisha-backend/src/controllers/needsController.js'), 'utf8');
const needsRoutes = fs.readFileSync(path.join(root, 'sisha-backend/src/routes/needsRoutes.js'), 'utf8');

test('HF Gerenciador de Dados: PPU e CeIMSPA percorrem todas as páginas de 1000 linhas', () => {
  assert.match(itemController, /const ADMIN_DATA_PAGE_SIZE = 1000/);
  assert.match(itemController, /\.range\(from, from \+ ADMIN_DATA_PAGE_SIZE - 1\)/);
  assert.match(itemController, /carregarBaseAdministrativaCompleta\(\s*'estoque_ppu'/);
  assert.match(itemController, /carregarBaseAdministrativaCompleta\(\s*'estoque_ceimspa'/);
});

test('HF Gerenciador de Dados: OC, PD e WO usam leitura administrativa completa sem alterar a consulta operacional padrão', () => {
  assert.match(dataAdmin, /\/purchases\/ordens\?admin_manager=true/);
  assert.match(dataAdmin, /\/purchases\/pds\?admin_manager=true/);
  assert.match(dataAdmin, /\/purchases\/work-orders\?admin_manager=true/);
  assert.match(purchaseController, /function isAdminManagerRequest\(req\)/);
  assert.match(purchaseController, /fetchAllAdminManagerRows/);
  assert.match(purchaseController, /if \(!requireAdmin\(req, res\)\) return;/);
});

test('HF Receitas: existe renomeação da receita como conjunto e sincronização da Política de Estoque vinculada', () => {
  assert.match(needsRoutes, /router\.put\('\/receitas\/:inspecao', adminOnly, controller\.renameReceita\)/);
  assert.match(needsController, /exports\.renameReceita = async/);
  assert.match(needsController, /from\('receita_itens'\)[\s\S]*update\(\{ inspecao: nomeNovo/);
  assert.match(needsController, /from\('politica_estoque_tarefas'\)[\s\S]*update\(\{ tarefas: nomeNovo/);
  assert.match(needsController, /RECEITA_RENOMEADA_ADMIN/);
  assert.match(needsPanel, /RENOMEAR RECEITA/);
  assert.match(needsPanel, /Política de Estoque do tipo Receita vinculada/);
});

test('HF Receitas: listagem de nomes não fica presa ao teto padrão de 1000 itens', () => {
  assert.match(needsController, /const data = await fetchAllRows\('receita_itens', 'inspecao'\)/);
});
