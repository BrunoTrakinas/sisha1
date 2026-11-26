const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const backendRoot = path.resolve(__dirname, '../..');
const cadastro = fs.readFileSync(path.join(backendRoot, '../sisha-frontend/src/pages/Cadastro.jsx'), 'utf8');
const importController = fs.readFileSync(path.join(backendRoot, 'src/controllers/importController.js'), 'utf8');
const equipamentos = fs.readFileSync(path.join(backendRoot, '../sisha-frontend/src/pages/Equipamentos.jsx'), 'utf8');

test('Central: InventarioPPUGeralLoc é a única entrada oficial do inventário PPU', () => {
  assert.match(cadastro, /value="inventario_ppu">InventarioPPUGeralLoc — Inventário Geral PPU por Localização/);
  assert.doesNotMatch(cadastro, /<option value="inventario_equipamentos">/);
});

test('InventarioPPUGeralLoc alimenta PPU e sincroniza PN+SN no Livro de Equipamentos', () => {
  const service=fs.readFileSync(path.join(backendRoot,'src/services/ppuReceiptReconciliationService.js'),'utf8');
  const routes=fs.readFileSync(path.join(backendRoot,'src/routes/importRoutes.js'),'utf8');
  assert.match(importController,/await importPpuR6/);
  assert.match(service,/readCanonicalInventory/);
  assert.match(service,/sisha_ppu_r6_apply/);
  assert.match(routes,/importPpuInventoryEquipmentSnapshot/);
  assert.doesNotMatch(cadastro,/<option value="resumido">/);
});

test('Importador genérico PN+SN permanece disponível na página Equipamentos', () => {
  assert.match(equipamentos, /Importar relação de equipamentos/);
  assert.match(equipamentos, /setMasterModal\(true\)/);
});

test('Central usa nomes originais das fontes operacionais recebidas', () => {
  assert.match(cadastro, /Controle de Equipamentos Criticos da Aeronave/);
  assert.match(cadastro, /SaidaMovimentacaoPorPeriodo/);
  assert.match(cadastro, /CONTROLE INSPEÇÃO/);
});
