const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..', '..', '..');
const cadastro = fs.readFileSync(path.join(root, 'sisha-frontend', 'src', 'pages', 'Cadastro.jsx'), 'utf8');
const recebimentos = fs.readFileSync(path.join(root, 'sisha-frontend', 'src', 'pages', 'Recebimentos.jsx'), 'utf8');

test('HF Recibos: Atualizar Sistema possui entrada RECIBOS e incorpora a triagem canônica', () => {
  assert.match(cadastro, />\s*RECIBOS\s*</);
  assert.match(cadastro, /<Recebimentos importOnly \/>/);
  assert.doesNotMatch(cadastro, /option value="recibos_auto"/);
});

test('HF Recibos: página Recebimentos vira consulta por padrão e importação só aparece em importOnly', () => {
  assert.match(recebimentos, /function Recebimentos\(\{ importOnly = false \}\)/);
  assert.match(recebimentos, /isAdmin && importOnly && \(\s*<form onSubmit=\{importReceipt\}/);
  assert.match(recebimentos, /!importOnly && \(<section className="bg-white dark:bg-slate-800/);
});

test('HF Recibos: Operador não ganha capacidade de importar', () => {
  assert.match(recebimentos, /const isAdmin = \['admin', 'dono'\]\.includes\(user\?\.role\)/);
  assert.match(recebimentos, /isAdmin && importOnly/);
});
