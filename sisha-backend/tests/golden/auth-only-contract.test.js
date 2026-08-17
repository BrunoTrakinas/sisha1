const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const backendRoot = path.resolve(__dirname, '../..');

function read(relativePath) {
  return fs.readFileSync(path.join(backendRoot, relativePath), 'utf8');
}

test('GOLDEN Auth: login usa somente signInWithPassword do Supabase', () => {
  const source = read('src/controllers/authController.js');
  assert.match(source, /auth\s*=\s*await signInWithPassword\(email,\s*senha\)/);
  assert.doesNotMatch(source, /verifyLegacy|signLegacy|legacyToken|APP_AUTH_SECRET/i);
});

test('GOLDEN Auth: request autenticado resolve autorizacao pelo UUID imutavel', () => {
  const middleware = read('src/middlewares/authMiddleware.js');
  const binding = read('src/services/authIdentityBindingService.js');

  assert.match(middleware, /resolveAuthorizedUserForAuthUser\(authUser\)/);
  assert.match(binding, /return loadAuthorizedUserByAuthId\(authUserId\)/);
});

test('GOLDEN Auth: Esqueci minha senha cria ou recupera identidade e faz binding', () => {
  const controller = read('src/controllers/authController.js');
  const start = controller.indexOf('exports.requestPasswordReset');
  const end = controller.indexOf('exports.setPasswordFromLink');
  assert.ok(start >= 0 && end > start);

  const flow = controller.slice(start, end);
  assert.match(flow, /sendAccessLink\(email\)/);
  assert.match(flow, /bindAuthorizedUserIdentity\(/);
  assert.match(flow, /authUserId:\s*access\.auth_user_id/);
});

test('GOLDEN Auth: sendAccessLink usa reset para existente e invite para novo', () => {
  const source = read('src/services/supabaseAuthService.js');
  const start = source.indexOf('async function sendAccessLink');
  const end = source.indexOf('async function updatePasswordFromAccessToken');
  assert.ok(start >= 0 && end > start);

  const flow = source.slice(start, end);
  assert.match(flow, /findAuthUserByEmail\(normalized\)/);
  assert.match(flow, /resetPasswordForEmail\(normalized/);
  assert.match(flow, /inviteUserByEmail\(normalized/);
  assert.match(flow, /created_auth_user:\s*false/);
  assert.match(flow, /created_auth_user:\s*true/);
});

test('GOLDEN Auth: codigo de producao nao consulta coluna local senha', () => {
  const files = [
    'src/controllers/authController.js',
    'src/middlewares/authMiddleware.js',
    'src/services/authIdentityBindingService.js',
    'src/services/chatLinceActionService.js',
  ];

  for (const file of files) {
    const source = read(file);
    assert.doesNotMatch(
      source,
      /\.select\(\s*['"][^'"]*\bsenha\b[^'"]*['"]\s*\)/i,
      `${file} voltou a consultar authorized_users.senha`
    );
  }
});

test('GOLDEN Chat Lince: reautenticacao administrativa valida senha no Supabase', () => {
  const source = read('src/services/chatLinceActionService.js');
  assert.match(source, /signInWithPassword\(email,\s*senha\)/);
  assert.match(source, /auth_user_id/);
  assert.doesNotMatch(source, /APP_AUTH_SECRET|verifyLegacy|senha_hash/i);
});
