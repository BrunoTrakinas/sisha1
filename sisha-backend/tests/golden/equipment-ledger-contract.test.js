const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const backendRoot = path.resolve(__dirname, '../..');

function read(relativePath) {
  return fs.readFileSync(path.join(backendRoot, relativePath), 'utf8');
}

test('GOLDEN Equipamentos: STC, OS/PIM, Cadastro Mestre e Inventario continuam no mesmo ledger PN+SN', () => {
  const routes = read('src/routes/equipmentRoutes.js');
  assert.match(routes, /router\.get\(['"]\/os-pim['"]/);
  assert.match(routes, /router\.get\(['"]\/stc['"]/);
  assert.match(routes, /router\.post\(['"]\/master\/preview['"]/);
  assert.match(routes, /router\.post\(['"]\/inventory\/preview['"]/);
  assert.match(routes, /router\.post\(['"]\/:id\/events['"]/);
});

test('GOLDEN Equipamentos: alteracoes patrimoniais criticas continuam protegidas por Admin', () => {
  const routes = read('src/routes/equipmentRoutes.js');

  const expected = [
    /router\.post\(['"]\/inventory\/apply['"]\s*,\s*requireRole\(\[['"]admin['"]\]\)/,
    /router\.post\(['"]\/master\/apply['"]\s*,\s*requireRole\(\[['"]admin['"]\]\)/,
    /router\.post\(['"]\/os-pim['"]\s*,\s*requireRole\(\[['"]admin['"]\]\)/,
    /router\.post\(['"]\/stc['"]\s*,\s*requireRole\(\[['"]admin['"]\]\)/,
    /router\.post\(['"]\/:id\/events['"]\s*,\s*requireRole\(\[['"]admin['"]\]\)/,
  ];

  for (const pattern of expected) {
    assert.match(routes, pattern);
  }
});

test('GOLDEN Equipamentos: caminho ACID permanece default oficial no env.example', () => {
  const source = fs.readFileSync(path.join(backendRoot, '.env.example'), 'utf8');
  assert.match(source, /^SISHA_H4B_ACID_EQUIPMENT_ENABLED=true$/m);
});
