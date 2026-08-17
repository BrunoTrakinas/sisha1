const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const backendRoot = path.resolve(__dirname, '../..');
const projectRoot = path.resolve(backendRoot, '..');

function readProject(relativePath) {
  return fs.readFileSync(path.join(projectRoot, relativePath), 'utf8');
}

test('GOLDEN higiene: .gitignore protege segredos, dependencias e builds', () => {
  const source = readProject('.gitignore');
  assert.match(source, /(^|\n)\.env(\n|$)/);
  assert.match(source, /node_modules\//);
  assert.match(source, /dist\//);
  assert.match(source, /\.vite\//);
});

test('GOLDEN higiene: SQL permanente fica concentrado em migrations', () => {
  const sqlRoot = path.join(backendRoot, 'sql');
  const looseSql = fs
    .readdirSync(sqlRoot, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.sql'))
    .map((entry) => entry.name);

  assert.deepEqual(looseSql, []);
  assert.equal(fs.existsSync(path.join(sqlRoot, 'migrations')), true);
});

test('GOLDEN higiene: scripts temporarios H1-H4 nao voltaram para a raiz', () => {
  const scripts = path.join(projectRoot, 'scripts');
  if (fs.existsSync(scripts)) {
    const names = fs.readdirSync(scripts);
    const legacyAudit = names.filter((name) => /^h[1-4].*(audit|readiness|smoke)/i.test(name));
    assert.deepEqual(legacyAudit, []);
  }

  // C1: validadores one-shot e artefatos de decisão já absorvidos pelo código/testes
  // não permanecem na raiz operacional do projeto.
  [
    'VALIDAR_A1_1_READ_ONLY.sql',
    'VALIDAR_A1_1A_READ_ONLY.sql',
    'VALIDAR_A1_1A_HF2_READ_ONLY.sql',
    'VALIDAR_A1_1A_HF3_READ_ONLY.sql',
    'AUDITORIA_DOCUMENTOS_DECISAO.md',
  ].forEach((name) => assert.equal(fs.existsSync(path.join(projectRoot, name)), false, `${name} deve ser removido`));

  // Arquivos sem qualquer referência runtime após H4/A3 também não permanecem como código morto.
  assert.equal(fs.existsSync(path.join(backendRoot, 'src/controllers/inventoryController.js')), false);
  assert.equal(fs.existsSync(path.join(backendRoot, 'src/services/transactionGuardService.js')), false);
});

test('GOLDEN CI: workflow possui somente leitura e testa backend + build frontend', () => {
  const source = readProject('.github/workflows/sisha-ci.yml');
  assert.match(source, /permissions:\s*\n\s*contents:\s*read/);
  assert.match(source, /working-directory:\s*sisha-backend[\s\S]*?run:\s*npm test/);
  assert.match(source, /working-directory:\s*sisha-frontend[\s\S]*?run:\s*npm run build/);
  assert.doesNotMatch(source, /packages:\s*write|contents:\s*write|id-token:\s*write/i);
});
