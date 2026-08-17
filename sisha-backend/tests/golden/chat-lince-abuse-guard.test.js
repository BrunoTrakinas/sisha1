const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');

const {
  DEFAULT_PROFILES,
  profileConfig,
  inspectRateLimit,
  acquireRatePermit,
  inspectReauth,
  recordReauthFailure,
  clearReauthFailures,
  resetAbuseGuardStateForTests,
} = require('../../src/services/chatLinceAbuseGuardService');
const {
  subjectFromRequest,
  createChatLinceRateGuard,
} = require('../../src/middlewares/chatLinceAbuseMiddleware');

const backendRoot = path.resolve(__dirname, '../..');
function read(relativePath) {
  return fs.readFileSync(path.join(backendRoot, relativePath), 'utf8');
}

function withEnv(values, fn) {
  const old = {};
  for (const [key, value] of Object.entries(values)) {
    old[key] = process.env[key];
    process.env[key] = String(value);
  }
  try { return fn(); }
  finally {
    for (const [key, value] of Object.entries(old)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test.beforeEach(() => resetAbuseGuardStateForTests());

test('GOLDEN H6D: defaults separam consulta, documento, RAG e confirmacao', () => {
  assert.equal(DEFAULT_PROFILES.CONSULT.maxRequests, 20);
  assert.equal(DEFAULT_PROFILES.DOCUMENT_ANALYSIS.perUserConcurrency, 1);
  assert.equal(DEFAULT_PROFILES.RAG_REINDEX.globalConcurrency, 1);
  assert.equal(DEFAULT_PROFILES.ACTION_CONFIRM.maxRequests, 10);
});

test('GOLDEN H6D: configuracao por env tem limites saneados', () => withEnv({
  CHAT_LINCE_CONSULT_MAX: 3,
  CHAT_LINCE_CONSULT_WINDOW_MS: 2000,
}, () => {
  const config = profileConfig('CONSULT');
  assert.equal(config.maxRequests, 3);
  assert.equal(config.windowMs, 2000);
}));

test('GOLDEN H6D: consulta normal recebe permit e release idempotente', () => {
  const permit = acquireRatePermit('CONSULT', 'user-a', 1000);
  assert.equal(permit.allowed, true);
  permit.release();
  permit.release();
  assert.equal(inspectRateLimit('CONSULT', 'user-a', 1001).allowed, true);
});

test('GOLDEN H6D: burst excessivo retorna bloqueio e Retry-After', () => withEnv({
  CHAT_LINCE_CONSULT_BURST_MAX: 2,
  CHAT_LINCE_CONSULT_BURST_WINDOW_MS: 10000,
  CHAT_LINCE_CONSULT_MAX: 20,
}, () => {
  const a = acquireRatePermit('CONSULT', 'user-b', 1000); a.release();
  const b = acquireRatePermit('CONSULT', 'user-b', 2000); b.release();
  const blocked = inspectRateLimit('CONSULT', 'user-b', 2500);
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.code, 'BURST_RATE_LIMIT');
  assert.ok(blocked.retryAfterSeconds >= 1);
}));

test('GOLDEN H6D: janela longa limita volume acumulado', () => withEnv({
  CHAT_LINCE_CONSULT_MAX: 2,
  CHAT_LINCE_CONSULT_WINDOW_MS: 60000,
  CHAT_LINCE_CONSULT_BURST_MAX: 20,
}, () => {
  const a = acquireRatePermit('CONSULT', 'user-c', 1000); a.release();
  const b = acquireRatePermit('CONSULT', 'user-c', 2000); b.release();
  const blocked = inspectRateLimit('CONSULT', 'user-c', 3000);
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.code, 'WINDOW_RATE_LIMIT');
}));

test('GOLDEN H6D: concorrencia por usuario impede tempestade paralela', () => withEnv({
  CHAT_LINCE_CONSULT_USER_CONCURRENCY: 1,
  CHAT_LINCE_CONSULT_GLOBAL_CONCURRENCY: 10,
}, () => {
  const first = acquireRatePermit('CONSULT', 'user-d', 1000);
  assert.equal(first.allowed, true);
  const blocked = inspectRateLimit('CONSULT', 'user-d', 1001);
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.code, 'USER_CONCURRENCY_LIMIT');
  first.release();
}));

test('GOLDEN H6D: concorrencia global protege OpenRouter/CPU mesmo com varios usuarios', () => withEnv({
  CHAT_LINCE_DOCUMENT_ANALYSIS_USER_CONCURRENCY: 5,
  CHAT_LINCE_DOCUMENT_ANALYSIS_GLOBAL_CONCURRENCY: 1,
}, () => {
  const first = acquireRatePermit('DOCUMENT_ANALYSIS', 'user-e', 1000);
  assert.equal(first.allowed, true);
  const blocked = inspectRateLimit('DOCUMENT_ANALYSIS', 'user-f', 1001);
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.code, 'GLOBAL_CONCURRENCY_LIMIT');
  first.release();
}));

test('GOLDEN H6D: sujeito prioriza auth_user_id/email e nao depende so de IP', () => {
  assert.equal(subjectFromRequest({ user: { auth_user_id: 'AUTH-123', email: 'x@y' }, ip: '1.2.3.4' }), 'auth-123');
  assert.equal(subjectFromRequest({ user: { email: 'User@Example.Mil' }, ip: '1.2.3.4' }), 'user@example.mil');
});

test('GOLDEN H6D: middleware retorna 429 e Retry-After antes do controller', async () => withEnv({
  CHAT_LINCE_CONSULT_MAX: 1,
  CHAT_LINCE_CONSULT_BURST_MAX: 10,
}, async () => {
  const now = Date.now();
  const first = acquireRatePermit('CONSULT', 'rate@example.mil', now); first.release();
  const guard = createChatLinceRateGuard('CONSULT');
  const req = { user: { email: 'rate@example.mil' }, ip: '127.0.0.1' };
  const res = new EventEmitter();
  res.headers = {};
  res.setHeader = (k, v) => { res.headers[k] = v; };
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (body) => { res.body = body; return res; };
  let nextCalled = false;
  guard(req, res, () => { nextCalled = true; });
  assert.equal(nextCalled, false);
  assert.equal(res.statusCode, 429);
  assert.ok(Number(res.headers['Retry-After']) >= 1);
  assert.match(res.body.code, /^CHAT_LINCE_/);
}));

test('GOLDEN H6D: falhas de reauth acumulam e geram lock temporario', () => withEnv({
  CHAT_LINCE_REAUTH_MAX_FAILURES: 3,
  CHAT_LINCE_REAUTH_FAILURE_WINDOW_MS: 60000,
  CHAT_LINCE_REAUTH_LOCK_MS: 30000,
}, () => {
  assert.equal(recordReauthFailure('auth-z', 1000).locked, false);
  assert.equal(recordReauthFailure('auth-z', 2000).locked, false);
  const third = recordReauthFailure('auth-z', 3000);
  assert.equal(third.locked, true);
  const gate = inspectReauth('auth-z', 3001);
  assert.equal(gate.allowed, false);
  assert.equal(gate.code, 'REAUTH_TEMPORARILY_LOCKED');
}));

test('GOLDEN H6D: lock de reauth expira automaticamente', () => withEnv({
  CHAT_LINCE_REAUTH_MAX_FAILURES: 2,
  CHAT_LINCE_REAUTH_FAILURE_WINDOW_MS: 60000,
  CHAT_LINCE_REAUTH_LOCK_MS: 10000,
}, () => {
  recordReauthFailure('auth-exp', 1000);
  recordReauthFailure('auth-exp', 2000);
  assert.equal(inspectReauth('auth-exp', 2001).allowed, false);
  assert.equal(inspectReauth('auth-exp', 12001).allowed, true);
}));

test('GOLDEN H6D: sucesso de reauth limpa historico de falhas', () => withEnv({
  CHAT_LINCE_REAUTH_MAX_FAILURES: 5,
}, () => {
  recordReauthFailure('auth-ok', 1000);
  recordReauthFailure('auth-ok', 2000);
  clearReauthFailures('auth-ok');
  const gate = inspectReauth('auth-ok', 3000);
  assert.equal(gate.allowed, true);
  assert.equal(gate.failuresInWindow, 0);
}));

test('GOLDEN H6D: rotas caras recebem guards antes dos controllers', () => {
  const source = read('src/routes/chatLinceRoutes.js');
  assert.match(source, /router\.post\('\/perguntar',\s*guardChatLinceConsult,\s*chatLinceController\.perguntar\)/);
  assert.match(source, /\/rag\/reindexar'[\s\S]{0,100}guardChatLinceRagReindex/);
  assert.match(source, /\/acoes\/:id\/confirmar'[\s\S]{0,120}guardChatLinceActionConfirm/);
  assert.match(source, /\/documentos\/analisar'[\s\S]{0,140}guardChatLinceDocumentAnalysis/);
});

test('GOLDEN H6D: controller bloqueia reauth antes de chamar executor quando locked', () => {
  const source = read('src/controllers/chatLinceController.js');
  const gate = source.indexOf('const reauthGate = inspectReauth(reauthSubject)');
  const execute = source.indexOf('executeActionPlan({ actionId: req.params.id, senha, user: req.user })');
  assert.ok(gate >= 0 && execute > gate);
  assert.match(source, /CHAT_LINCE_REAUTH_RATE_BLOCK/);
  assert.match(source, /CHAT_LINCE_REAUTH_FAILURE/);
});

test('GOLDEN H6D: somente falha de senha incrementa lockout, erros de estado nao contam', () => {
  const source = read('src/controllers/chatLinceController.js');
  assert.match(source, /result\.code === 'ACTION_REAUTH_FAILED'/);
  assert.match(source, /recordReauthFailure\(reauthSubject\)/);
  assert.match(source, /else if \(result\.ok\)[\s\S]*clearReauthFailures\(reauthSubject\)/);
});

test('GOLDEN H6D: auditoria de rate limit nao registra senha nem token', () => {
  const source = read('src/middlewares/chatLinceAbuseMiddleware.js');
  assert.doesNotMatch(source, /details:\s*\{[^}]*senha/si);
  assert.doesNotMatch(source, /details:\s*\{[^}]*authorization/si);
  assert.match(source, /CHAT_LINCE_ABUSE_GUARD_BLOCK/);
});

test('GOLDEN H6D: env.example documenta limites sem liberar wildcard ou modo bypass', () => {
  const source = read('.env.example');
  assert.match(source, /CHAT_LINCE_CONSULT_MAX=20/);
  assert.match(source, /CHAT_LINCE_REAUTH_MAX_FAILURES=5/);
  assert.doesNotMatch(source, /CHAT_LINCE_(RATE|ABUSE).*DISABLE=true/i);
});

test('GOLDEN H6D: implementacao nao adiciona Redis externo nem dependencia nova', () => {
  const source = read('src/services/chatLinceAbuseGuardService.js');
  assert.doesNotMatch(source, /redis|upstash|ioredis/i);
  const pkg = JSON.parse(read('package.json'));
  assert.equal(pkg.dependencies?.['express-rate-limit'], undefined);
  assert.equal(pkg.dependencies?.['ioredis'], undefined);
});
