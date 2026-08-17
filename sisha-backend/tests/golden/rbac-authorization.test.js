const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const backendRoot = path.resolve(__dirname, '../..');

function read(relativePath) {
  return fs.readFileSync(path.join(backendRoot, relativePath), 'utf8');
}

function mutationLines(source) {
  return source
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /^router\.(post|put|patch|delete)\(/.test(line));
}

test('GOLDEN RBAC: Dono continua herdando permissoes de Admin', () => {
  const source = read('src/middlewares/authMiddleware.js');
  assert.match(source, /if\s*\(\s*req\.user\.role\s*===\s*['"]dono['"]\s*\)\s*\{\s*return next\(\)/s);
});

test('GOLDEN RBAC: Operador nao recebe bypass administrativo', () => {
  const source = read('src/middlewares/authMiddleware.js');
  assert.doesNotMatch(source, /req\.user\.role\s*===\s*['"]operador['"][\s\S]{0,80}return next\(\)/i);
  assert.match(source, /return res\.status\(403\)/);
});

test('GOLDEN Equipamentos: toda rota mutavel permanece Admin/Dono', () => {
  const source = read('src/routes/equipmentRoutes.js');
  const lines = mutationLines(source);
  assert.ok(lines.length >= 10, `esperadas varias rotas mutaveis; encontradas ${lines.length}`);
  for (const line of lines) {
    assert.match(line, /requireRole\(\[['"]admin['"]\]\)/, `rota mutavel sem guard Admin: ${line}`);
  }
});

test('GOLDEN Recebimentos: toda rota mutavel permanece Admin/Dono', () => {
  const source = read('src/routes/receiptRoutes.js');
  const lines = mutationLines(source);
  assert.ok(lines.length >= 4);
  for (const line of lines) {
    assert.match(line, /requireRole\(\[['"]admin['"]\]\)/, `rota mutavel sem guard Admin: ${line}`);
  }
});

test('GOLDEN Compras/PD/WO: toda rota mutavel permanece Admin/Dono', () => {
  const source = read('src/routes/purchaseRoutes.js');
  const lines = mutationLines(source);
  assert.ok(lines.length >= 15);
  for (const line of lines) {
    assert.match(line, /requireRole\(\[['"]admin['"]\]\)/, `rota mutavel sem guard Admin: ${line}`);
  }
});

test('GOLDEN Operador read-only: consultas/exportacoes principais continuam GET', () => {
  const equipment = read('src/routes/equipmentRoutes.js');
  const receipts = read('src/routes/receiptRoutes.js');
  const purchases = read('src/routes/purchaseRoutes.js');

  assert.match(equipment, /router\.get\(['"]\/['"]\s*,\s*equipmentController\.listar\)/);
  assert.match(equipment, /router\.get\(['"]\/export['"]\s*,\s*equipmentController\.exportar\)/);
  assert.match(receipts, /router\.get\(['"]\/['"]\s*,\s*receiptController\.listar\)/);
  assert.match(receipts, /router\.get\(['"]\/export['"]\s*,\s*receiptController\.exportar\)/);
  assert.match(purchases, /router\.get\(['"]\/ordens['"]/);
  assert.match(purchases, /router\.get\(['"]\/pds['"]/);
  assert.match(purchases, /router\.get\(['"]\/work-orders['"]/);
});
