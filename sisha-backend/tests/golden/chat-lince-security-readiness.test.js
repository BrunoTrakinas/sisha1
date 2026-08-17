const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  READINESS_VERSION,
  evaluateChatLinceSecurityReadiness,
  publicChatLinceSecurityReadiness,
  assertChatLinceSecurityReadiness,
} = require('../../src/services/chatLinceSecurityReadinessService');

const backendRoot = path.resolve(__dirname, '../..');

function safeEnv(overrides = {}) {
  return {
    NODE_ENV: 'development',
    CHAT_LINCE_MAX_PROMPT_CHARS: '6000',
    CHAT_LINCE_REQUIRE_LIVE_AI: 'false',
    OPENROUTER_API_KEY: '',
    OPENROUTER_MODEL: '',
    ...overrides,
  };
}

test('GOLDEN H6E: readiness final e versionado', () => {
  assert.equal(READINESS_VERSION, 'H6E-1');
});

test('GOLDEN H6E: defaults seguros ficam READY_WITH_WARNINGS apenas pela IA live opcional', () => {
  const result = evaluateChatLinceSecurityReadiness(safeEnv());
  assert.equal(result.status, 'READY_WITH_WARNINGS');
  assert.equal(result.summary.blockers, 0);
  assert.equal(result.canConsultSafely, true);
  assert.equal(result.canExecuteActionsSafely, true);
  assert.equal(result.liveAiConfigured, false);
  assert.ok(result.checks.some((item) => item.code === 'AI_LIVE_PROVIDER_OPTIONAL' && item.status === 'WARN'));
});

test('GOLDEN H6E: IA live obrigatoria sem chave vira NO_GO', () => {
  const result = evaluateChatLinceSecurityReadiness(safeEnv({
    NODE_ENV: 'production',
    CHAT_LINCE_REQUIRE_LIVE_AI: 'true',
    OPENROUTER_API_KEY: '',
  }));
  assert.equal(result.status, 'NO_GO');
  assert.ok(result.checks.some((item) => item.code === 'AI_LIVE_PROVIDER' && item.status === 'BLOCK'));
});

test('GOLDEN H6E: OpenRouter configurado com modelo fixo pode chegar a READY', () => {
  const result = evaluateChatLinceSecurityReadiness(safeEnv({
    OPENROUTER_API_KEY: 'test-secret-not-returned',
    OPENROUTER_MODEL: 'openai/gpt-5.1',
  }));
  assert.equal(result.status, 'READY');
  assert.equal(result.summary.blockers, 0);
  assert.equal(result.summary.warnings, 0);
  assert.ok(result.checks.some((item) => item.code === 'AI_MODEL_PINNED' && item.status === 'PASS'));
});

test('GOLDEN H6E: modelo auto com provider live gera warning de reprodutibilidade', () => {
  const result = evaluateChatLinceSecurityReadiness(safeEnv({
    OPENROUTER_API_KEY: 'test-secret-not-returned',
    OPENROUTER_MODEL: 'openrouter/auto',
  }));
  assert.equal(result.status, 'READY_WITH_WARNINGS');
  assert.ok(result.checks.some((item) => item.code === 'AI_MODEL_NOT_PINNED' && item.status === 'WARN'));
});

test('GOLDEN H6E: invariantes H6A permanecem PASS', () => {
  const result = evaluateChatLinceSecurityReadiness(safeEnv());
  for (const code of [
    'H6A_PROMPT_OVERRIDE_BLOCK',
    'H6A_SECRET_EXFILTRATION_BLOCK',
    'H6A_SYSTEM_TRUST_BOUNDARY',
    'H6A_OUTPUT_SECRET_REDACTION',
  ]) {
    assert.ok(result.checks.some((item) => item.code === code && item.status === 'PASS'), code);
  }
});

test('GOLDEN H6E: invariantes H6B permanecem PASS', () => {
  const result = evaluateChatLinceSecurityReadiness(safeEnv());
  for (const code of [
    'H6B_DOCUMENTARY_NOT_CURRENT_STATE',
    'H6B_LIVE_SOURCE_CAN_CONFIRM_STATE',
    'H6B_TECHNICAL_SCOPE_SEPARATION',
  ]) {
    assert.ok(result.checks.some((item) => item.code === code && item.status === 'PASS'), code);
  }
});

test('GOLDEN H6E: executor H6C continua allowlist unico e sem Operador', () => {
  const result = evaluateChatLinceSecurityReadiness(safeEnv());
  assert.ok(result.checks.some((item) => item.code === 'H6C_ACTION_ALLOWLIST' && item.status === 'PASS'));
  assert.ok(result.checks.some((item) => item.code === 'H6C_ROLE_BOUNDARY' && item.status === 'PASS'));
});

test('GOLDEN H6E: defaults H6D permanecem sob teto final de seguranca', () => {
  const result = evaluateChatLinceSecurityReadiness(safeEnv());
  for (const profile of ['CONSULT', 'DOCUMENT_ANALYSIS', 'RAG_REINDEX', 'ACTION_CONFIRM']) {
    assert.ok(
      result.checks.some((item) => item.code === `H6D_${profile}_LIMITS` && item.status === 'PASS'),
      profile
    );
  }
  assert.ok(result.checks.some((item) => item.code === 'H6D_REAUTH_LOCKOUT' && item.status === 'PASS'));
});

test('GOLDEN H6E: enfraquecer lockout de senha vira NO_GO', () => {
  const previous = {
    max: process.env.CHAT_LINCE_REAUTH_MAX_FAILURES,
    lock: process.env.CHAT_LINCE_REAUTH_LOCK_MS,
    window: process.env.CHAT_LINCE_REAUTH_FAILURE_WINDOW_MS,
  };
  Object.assign(process.env, {
    CHAT_LINCE_REAUTH_MAX_FAILURES: '50',
    CHAT_LINCE_REAUTH_LOCK_MS: '10000',
    CHAT_LINCE_REAUTH_FAILURE_WINDOW_MS: '10000',
  });
  try {
    const result = evaluateChatLinceSecurityReadiness(safeEnv());
    assert.equal(result.status, 'NO_GO');
    assert.ok(result.checks.some((item) => item.code === 'H6D_REAUTH_LOCKOUT' && item.status === 'BLOCK'));
  } finally {
    if (previous.max === undefined) delete process.env.CHAT_LINCE_REAUTH_MAX_FAILURES;
    else process.env.CHAT_LINCE_REAUTH_MAX_FAILURES = previous.max;
    if (previous.lock === undefined) delete process.env.CHAT_LINCE_REAUTH_LOCK_MS;
    else process.env.CHAT_LINCE_REAUTH_LOCK_MS = previous.lock;
    if (previous.window === undefined) delete process.env.CHAT_LINCE_REAUTH_FAILURE_WINDOW_MS;
    else process.env.CHAT_LINCE_REAUTH_FAILURE_WINDOW_MS = previous.window;
  }
});

test('GOLDEN H6E: elevar rate limit acima do teto vira NO_GO', () => {
  const previous = process.env.CHAT_LINCE_CONSULT_MAX;
  process.env.CHAT_LINCE_CONSULT_MAX = '9999';
  try {
    const result = evaluateChatLinceSecurityReadiness(safeEnv());
    assert.equal(result.status, 'NO_GO');
    assert.ok(result.checks.some((item) => item.code === 'H6D_CONSULT_LIMITS' && item.status === 'BLOCK'));
  } finally {
    if (previous === undefined) delete process.env.CHAT_LINCE_CONSULT_MAX;
    else process.env.CHAT_LINCE_CONSULT_MAX = previous;
  }
});

test('GOLDEN H6E: endpoint publico nunca retorna valor da chave OpenRouter', () => {
  const secret = 'h6e-do-not-leak-super-secret';
  const result = publicChatLinceSecurityReadiness(safeEnv({
    OPENROUTER_API_KEY: secret,
    OPENROUTER_MODEL: 'openai/gpt-5.1',
  }));
  const serialized = JSON.stringify(result);
  assert.equal(result.liveAiConfigured, true);
  assert.doesNotMatch(serialized, new RegExp(secret));
  assert.doesNotMatch(serialized, /OPENROUTER_API_KEY\s*[:=]\s*h6e/i);
});

test('GOLDEN H6E: producao falha fechada quando readiness e NO_GO', () => {
  assert.throws(
    () => assertChatLinceSecurityReadiness(safeEnv({
      NODE_ENV: 'production',
      CHAT_LINCE_REQUIRE_LIVE_AI: 'true',
      OPENROUTER_API_KEY: '',
    })),
    (error) => error?.code === 'SISHA_CHAT_LINCE_SECURITY_NOT_READY'
  );
});

test('GOLDEN H6E: desenvolvimento nao derruba backend por provider opcional ausente', () => {
  const result = assertChatLinceSecurityReadiness(safeEnv());
  assert.equal(result.status, 'READY_WITH_WARNINGS');
});

test('GOLDEN H6E: server executa readiness da IA antes de criar Express', () => {
  const source = fs.readFileSync(path.join(backendRoot, 'server.js'), 'utf8');
  const globalReadiness = source.indexOf('assertRuntimeReadiness();');
  const aiReadiness = source.indexOf('assertChatLinceSecurityReadiness();');
  const app = source.indexOf('const app = express();');
  assert.ok(globalReadiness >= 0);
  assert.ok(aiReadiness > globalReadiness);
  assert.ok(app > aiReadiness);
});

test('GOLDEN H6E: rota de readiness e somente Admin/Dono e read-only', () => {
  const source = fs.readFileSync(path.join(backendRoot, 'src/routes/chatLinceRoutes.js'), 'utf8');
  assert.match(
    source,
    /router\.get\(['"]\/security-readiness['"]\s*,\s*requireRole\(\[['"]admin['"],\s*['"]dono['"]\]\)\s*,\s*chatLinceController\.securityReadiness\)/
  );
  assert.doesNotMatch(source, /router\.(post|put|patch|delete)\(['"]\/security-readiness['"]/);
});

test('GOLDEN H6E: controller de readiness usa apenas resumo seguro', () => {
  const source = fs.readFileSync(path.join(backendRoot, 'src/controllers/chatLinceController.js'), 'utf8');
  const start = source.indexOf('exports.securityReadiness');
  const end = source.indexOf('exports.perguntar');
  assert.ok(start >= 0 && end > start);
  const block = source.slice(start, end);
  assert.match(block, /publicChatLinceSecurityReadiness\(\)/);
  assert.doesNotMatch(block, /process\.env|OPENROUTER_API_KEY|SUPABASE_SECRET_KEY/);
});

test('GOLDEN H6E: env.example documenta provider obrigatorio sem expor segredo', () => {
  const source = fs.readFileSync(path.join(backendRoot, '.env.example'), 'utf8');
  assert.match(source, /^CHAT_LINCE_REQUIRE_LIVE_AI=false$/m);
  assert.doesNotMatch(source, /OPENROUTER_API_KEY=\S+/);
});
