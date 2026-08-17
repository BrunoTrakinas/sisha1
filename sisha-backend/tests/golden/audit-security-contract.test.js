const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const backendRoot = path.resolve(__dirname, '../..');

function read(relativePath) {
  return fs.readFileSync(path.join(backendRoot, relativePath), 'utf8');
}

test('GOLDEN Auditoria: chaves sensiveis continuam cobertas pelo redaction pattern', () => {
  const source = read('src/utils/auditLogger.js');
  for (const key of ['password', 'senha', 'secret', 'token', 'authorization', 'cookie', 'api', 'service']) {
    assert.match(source, new RegExp(key, 'i'), `padrao de auditoria perdeu protecao para ${key}`);
  }
  assert.match(source, /\[REDACTED\]/);
});

test('GOLDEN Auditoria: falha de auditoria obrigatoria permanece fail-closed', () => {
  const source = read('src/utils/auditLogger.js');
  assert.match(source, /if\s*\(\s*required\s*\)/);
  assert.match(source, /AUDIT_REQUIRED_FAILED/);
  assert.match(source, /throw wrapped/);
});

test('GOLDEN Auditoria: request e transaction IDs continuam anexados ao log', () => {
  const source = read('src/utils/auditLogger.js');
  assert.match(source, /request_id/);
  assert.match(source, /transaction_id/);
  assert.match(source, /transaction_phase/);
  assert.match(source, /transaction_name/);
});
