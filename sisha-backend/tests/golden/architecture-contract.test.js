const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const backendRoot = path.resolve(__dirname, '../..');

function read(relativePath) {
  return fs.readFileSync(path.join(backendRoot, relativePath), 'utf8');
}

test('GOLDEN H4C4: data-plane principal usa cliente administrativo, nao anon key', () => {
  const source = read('src/config/supabaseClient.js');
  assert.match(source, /getSupabaseAdmin/);
  assert.doesNotMatch(
    source,
    /createClient\s*\(\s*process\.env\.SUPABASE_URL\s*,\s*process\.env\.SUPABASE_KEY/
  );
});

test('GOLDEN H4C6: authToken legado nao existe mais', () => {
  assert.equal(fs.existsSync(path.join(backendRoot, 'src/config/authToken.js')), false);
});

test('GOLDEN H4C6: requests autenticadas resolvem autorizacao pelo UUID Auth', () => {
  const source = read('src/services/authIdentityBindingService.js');
  assert.match(source, /loadAuthorizedUserByAuthId\(authUserId\)/);
  assert.match(source, /auth_user_id/);
});

test('GOLDEN rotas: todas as areas de dados sao protegidas por requireAuth', () => {
  const source = read('server.js');

  const protectedMounts = [
    '/api/import',
    '/api/stats',
    '/api/search',
    '/api/manual',
    '/api/items',
    '/api/needs',
    '/api/purchases',
    '/api/chat-lince',
    '/api/history',
    '/api/receipts',
    '/api/locations',
    '/api/equipments',
    '/api/manuals',
  ];

  for (const mount of protectedMounts) {
    const escaped = mount.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    assert.match(
      source,
      new RegExp(`app\\.use\\(['"]${escaped}['"]\\s*,\\s*requireAuth\\b`),
      `${mount} precisa permanecer protegido`
    );
  }
});

test('GOLDEN rotas: importacao/manual/cadastro mestre continuam Admin/Dono', () => {
  const source = read('server.js');
  for (const mount of ['/api/import', '/api/manual', '/api/items']) {
    const escaped = mount.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    assert.match(
      source,
      new RegExp(
        `app\\.use\\(['"]${escaped}['"]\\s*,\\s*requireAuth\\s*,\\s*requireRole\\(\\[['"]admin['"]\\]\\)`
      )
    );
  }
});

test('GOLDEN H4D: startup executa runtime gate antes de criar a aplicacao', () => {
  const source = read('server.js');
  const readiness = source.indexOf('assertRuntimeReadiness();');
  const appCreation = source.indexOf('const app = express();');
  assert.ok(readiness >= 0);
  assert.ok(appCreation > readiness);
});
