const test = require('node:test');
const assert = require('node:assert/strict');

const {
  normalizeIncomingRequestId,
  createRequestId,
  requestContextMiddleware,
} = require('../../src/middlewares/requestContextMiddleware');

test('GOLDEN H3: Request-ID seguro recebido do cliente e preservado', () => {
  assert.equal(
    normalizeIncomingRequestId('h5a-smoke_2026-08-13:01'),
    'h5a-smoke_2026-08-13:01'
  );
});

test('GOLDEN H3: Request-ID invalido ou excessivo e rejeitado', () => {
  assert.equal(normalizeIncomingRequestId('valor invalido !!!'), null);
  assert.equal(normalizeIncomingRequestId('x'.repeat(129)), null);
});

test('GOLDEN H3: Request-ID gerado tem formato UUID', () => {
  assert.match(
    createRequestId(),
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
  );
});

test('GOLDEN H3: middleware correlaciona req, auditContext e response header', () => {
  const headers = {};
  const req = { headers: { 'x-request-id': 'golden-request-01' } };
  const res = {
    setHeader(name, value) {
      headers[name] = value;
    },
  };
  let nextCalled = false;

  requestContextMiddleware(req, res, () => {
    nextCalled = true;
  });

  assert.equal(nextCalled, true);
  assert.equal(req.requestId, 'golden-request-01');
  assert.equal(req.auditContext.requestId, 'golden-request-01');
  assert.equal(headers['X-SISHA-Request-Id'], 'golden-request-01');
});
