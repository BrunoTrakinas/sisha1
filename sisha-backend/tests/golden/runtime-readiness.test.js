const test = require('node:test');
const assert = require('node:assert/strict');

const { validateRuntimeReadiness } = require('../../src/config/runtimeReadiness');

function secureBase(overrides = {}) {
  return {
    NODE_ENV: 'production',
    SUPABASE_URL: 'https://example.supabase.co',
    SUPABASE_KEY: 'public-key-for-auth',
    SUPABASE_SECRET_KEY: 'server-secret',
    SISHA_H4B_ACID_EQUIPMENT_ENABLED: 'true',
    CORS_ORIGINS: 'https://sisha.example.com',
    AUTH_FRONTEND_URL: 'https://sisha.example.com',
    ...overrides,
  };
}

test('GOLDEN H4: producao segura passa no runtime gate', () => {
  const result = validateRuntimeReadiness(secureBase());
  assert.equal(result.ok, true);
  assert.deepEqual(result.blockers, []);
  assert.equal(result.mode, 'production');
});

test('GOLDEN H4: producao bloqueia CORS vazio', () => {
  const result = validateRuntimeReadiness(secureBase({ CORS_ORIGINS: '' }));
  assert.equal(result.ok, false);
  assert.match(result.blockers.join(' | '), /CORS_ORIGINS obrigatorio/i);
});

test('GOLDEN H4: producao bloqueia wildcard, HTTP e localhost', () => {
  for (const origin of ['*', 'http://sisha.example.com', 'http://localhost:5173']) {
    const result = validateRuntimeReadiness(secureBase({ CORS_ORIGINS: origin }));
    assert.equal(result.ok, false, origin);
  }
});

test('GOLDEN H4: producao bloqueia caminho ACID desligado', () => {
  const result = validateRuntimeReadiness(
    secureBase({ SISHA_H4B_ACID_EQUIPMENT_ENABLED: 'false' })
  );
  assert.equal(result.ok, false);
  assert.match(result.blockers.join(' | '), /ACID_EQUIPMENT_ENABLED/i);
});

test('GOLDEN H4: desenvolvimento tolera CORS vazio apenas como warning', () => {
  const result = validateRuntimeReadiness({
    NODE_ENV: 'development',
    SUPABASE_URL: 'https://example.supabase.co',
    SUPABASE_KEY: 'public-key-for-auth',
    SUPABASE_SECRET_KEY: 'server-secret',
    SISHA_H4B_ACID_EQUIPMENT_ENABLED: 'true',
    CORS_ORIGINS: '',
  });
  assert.equal(result.ok, true);
  assert.match(result.warnings.join(' | '), /CORS_ORIGINS vazio/i);
});
