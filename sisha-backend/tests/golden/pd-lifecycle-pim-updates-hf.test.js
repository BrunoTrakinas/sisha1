const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '../..');
const {
  chooseMonotonicImportedStatus,
  pendingPurchaseQty,
  isFuturePurchaseCoverageStatus,
  isOdcProcessStatus,
  isDeliveredHistoricalStatus,
} = require('../../src/services/pdLifecyclePolicyService');
const { parseOsDomain } = require('../../src/services/osDomainService');

test('HF lifecycle: importação pode avançar, mas nunca regride ODA/REC por snapshot atrasado', () => {
  assert.equal(chooseMonotonicImportedStatus('ODC', 'ODA'), 'ODA');
  assert.equal(chooseMonotonicImportedStatus('ODA', 'ODC'), 'ODA');
  assert.equal(chooseMonotonicImportedStatus('REC', 'ODA'), 'REC');
  assert.equal(chooseMonotonicImportedStatus('FAT', 'ODC'), 'FAT');
  assert.equal(chooseMonotonicImportedStatus('ODA', 'CAN'), 'ODA');
});

test('HF lifecycle: somente saldo ODA ainda a receber cobre aquisição futura', () => {
  assert.equal(isFuturePurchaseCoverageStatus('ODA'), true);
  assert.equal(isFuturePurchaseCoverageStatus('FAT'), false);
  assert.equal(isFuturePurchaseCoverageStatus('EMB'), false);
  assert.equal(isFuturePurchaseCoverageStatus('REC'), false);
  assert.equal(isOdcProcessStatus('ODC'), true);
  assert.equal(isDeliveredHistoricalStatus('FAT'), true);
  assert.equal(isDeliveredHistoricalStatus('EMB'), true);
  assert.equal(isDeliveredHistoricalStatus('REC'), true);
  assert.equal(pendingPurchaseQty({ qtd_comprada: 10, qtd_recebida: 4 }), 6);
});

test('HF lifecycle: imports de OC/PD aplicam política monotônica e edição manual continua separada', () => {
  const controller = fs.readFileSync(path.join(ROOT, 'src/controllers/purchaseController.js'), 'utf8');
  assert.match(controller, /chooseMonotonicImportedStatus/);
  assert.match(controller, /IMPORTACAO_PD_NUNCA_REGRIDE/);
  assert.match(controller, /REGRESSAO_SOMENTE_EDICAO_ADMIN_DONO/);
  assert.match(controller, /exports\.transicionarStatusOrdem/);
});

test('HF lifecycle: Order Book continua principal reconciliação positiva sem regressão automática', () => {
  const source = fs.readFileSync(path.join(ROOT, 'src/services/orderBookReconciliationService.js'), 'utf8');
  assert.match(source, /orderBookPresent: true/);
  assert.match(source, /allowRegression: false/);
  assert.match(source, /received >= total.*return 'REC'/s);
});

test('HF PIM: MTAR integra a família MT sem apagar compatibilidade MTVA', () => {
  const mtar = parseOsDomain('MTAR0001');
  assert.equal(mtar.tipo, 'OFICINA');
  assert.equal(mtar.codigo, 'MTAR');
  assert.equal(mtar.familia, 'MT');
  assert.equal(mtar.demanda_material_mt, true);
  assert.equal(parseOsDomain('MTVA0001').codigo, 'MTVA');
});

test('HF PIM: migration cria fotografia vigente sem DELETE e preserva manual', () => {
  const sql = fs.readFileSync(path.join(ROOT, 'sql/migrations/20260821_HF_PIM_CURRENT_SNAPSHOT_001.sql'), 'utf8');
  assert.match(sql, /sisha_replace_pim_snapshot_atomic/);
  assert.match(sql, /origem_importacao = 'ARQUIVO_PIM'/);
  assert.match(sql, /set ativo = false/i);
  assert.match(sql, /where coalesce\(ativo, true\) = true[\s\S]*origem_importacao = 'ARQUIVO_PIM'/i);
  assert.doesNotMatch(sql, /delete\s+from\s+public\.pim_demandas/i);
  assert.match(sql, /grant execute.*service_role/is);
});

test('HF PIM: Atualizar Sistema usa importador PIM atual e mostra assinatura do último upload', () => {
  const cadastro = fs.readFileSync(path.resolve(ROOT, '../sisha-frontend/src/pages/Cadastro.jsx'), 'utf8');
  assert.match(cadastro, /PIM Pendentes — snapshot atual/);
  assert.match(cadastro, /\/needs\/pims\/import/);
  assert.match(cadastro, /Última atualização registrada para este tipo/);
  assert.match(cadastro, /label: 'Atualizações'/);
  assert.match(cadastro, /\/import\/logs\?limit=300/);
});

test('HF Atualizações: backend permite histórico auditado maior sem expor mutação ao Operador', () => {
  const importController = fs.readFileSync(path.join(ROOT, 'src/controllers/importController.js'), 'utf8');
  const importRoutes = fs.readFileSync(path.join(ROOT, 'src/routes/importRoutes.js'), 'utf8');
  assert.match(importController, /Math\.min\(500/);
  assert.match(importController, /tipo_arquivo/);
  assert.match(importRoutes, /router\.get\('\/logs', requireRole\(\['admin'\]\)/);
});
