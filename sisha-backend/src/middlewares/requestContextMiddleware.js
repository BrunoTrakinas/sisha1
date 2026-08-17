const crypto = require('crypto');

function normalizeIncomingRequestId(value) {
  const text = String(value || '').trim();
  if (!text) return null;
  if (text.length > 128) return null;
  if (!/^[A-Za-z0-9._:-]+$/.test(text)) return null;
  return text;
}

function createRequestId() {
  return crypto.randomUUID();
}

function requestContextMiddleware(req, res, next) {
  const requestId = normalizeIncomingRequestId(req.headers?.['x-request-id']) || createRequestId();
  req.requestId = requestId;
  req.auditContext = {
    ...(req.auditContext || {}),
    requestId,
  };
  res.setHeader('X-SISHA-Request-Id', requestId);
  next();
}

module.exports = {
  requestContextMiddleware,
  normalizeIncomingRequestId,
  createRequestId,
};
