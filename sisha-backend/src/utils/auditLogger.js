const { getSupabaseAdmin } = require('../config/supabaseAdminClient');

const GOD_EMAIL = 'bruno.martins@marinha.mil.br';
const OWNER_ROLE = 'dono';
const MAX_AUDIT_DEPTH = 8;
const SENSITIVE_KEY_PATTERN = /(password|senha|passwd|secret|token|authorization|cookie|api[_-]?key|service[_-]?role|access[_-]?key|private[_-]?key)/i;

function normalizeEmail(email = '') {
  return String(email || '').trim().toLowerCase();
}

function isGodEmail(email = '') {
  return normalizeEmail(email) === GOD_EMAIL;
}

function normalizeRole(role = '') {
  return String(role || '').trim().toLowerCase();
}

function isOwnerRole(role = '') {
  return normalizeRole(role) === OWNER_ROLE;
}

function isGodUser(user = {}) {
  return isOwnerRole(user?.role) || isGodEmail(user?.email);
}

function sanitizeAuditValue(value, depth = 0, seen = new WeakSet()) {
  if (value == null) return value;
  if (depth > MAX_AUDIT_DEPTH) return '[TRUNCATED_DEPTH]';
  if (typeof value === 'string') return value.length > 12000 ? `${value.slice(0, 12000)}...[TRUNCATED]` : value;
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'bigint') return String(value);
  if (Buffer.isBuffer(value)) return `[BUFFER:${value.length}]`;
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.slice(0, 500).map((item) => sanitizeAuditValue(item, depth + 1, seen));
  if (typeof value !== 'object') return String(value);
  if (seen.has(value)) return '[CIRCULAR]';
  seen.add(value);

  const output = {};
  for (const [key, item] of Object.entries(value)) {
    if (SENSITIVE_KEY_PATTERN.test(key)) {
      output[key] = '[REDACTED]';
      continue;
    }
    output[key] = sanitizeAuditValue(item, depth + 1, seen);
  }
  return output;
}

function safeJson(value) {
  if (value == null) return {};
  if (typeof value === 'object') return sanitizeAuditValue(value);
  return { value: sanitizeAuditValue(value) };
}

function buildAuditMeta({ req, transactionId, transactionPhase, transactionName } = {}) {
  const meta = {};
  const requestId = req?.requestId || req?.auditContext?.requestId || null;
  if (requestId) meta.request_id = String(requestId);
  if (transactionId) meta.transaction_id = String(transactionId);
  if (transactionPhase) meta.transaction_phase = String(transactionPhase).toUpperCase();
  if (transactionName) meta.transaction_name = String(transactionName);
  return meta;
}

async function registrarAuditoria({
  req,
  action,
  entity = 'SISTEMA',
  entityId = null,
  summary = null,
  details = {},
  level = 'INFO',
  visibility = 'GOD',
  db = null,
  required = false,
  transactionId = null,
  transactionPhase = null,
  transactionName = null,
} = {}) {
  try {
    const actorEmail = normalizeEmail(req?.user?.email || details?.email || null) || null;
    const actorRole = req?.user?.role || null;
    const ip = req?.headers?.['x-forwarded-for'] || req?.socket?.remoteAddress || null;
    const userAgent = req?.headers?.['user-agent'] || null;
    const auditMeta = buildAuditMeta({ req, transactionId, transactionPhase, transactionName });
    const sanitizedDetails = safeJson(details);

    const payload = {
      actor_email: actorEmail,
      actor_role: actorRole,
      action: String(action || 'EVENTO').toUpperCase(),
      entity: String(entity || 'SISTEMA').toUpperCase(),
      entity_id: entityId ? String(entityId) : null,
      summary: summary || null,
      details: {
        ...sanitizedDetails,
        ...(Object.keys(auditMeta).length ? { _sisha_audit: auditMeta } : {}),
      },
      level: String(level || 'INFO').toUpperCase(),
      visibility: String(visibility || 'GOD').toUpperCase(),
      ip,
      user_agent: userAgent,
    };

    const auditDb = db || getSupabaseAdmin();
    const { error } = await auditDb.from('system_audit_logs').insert(payload);
    if (error) throw error;

    return {
      ok: true,
      requestId: auditMeta.request_id || null,
      transactionId: auditMeta.transaction_id || null,
    };
  } catch (error) {
    if (required) {
      const wrapped = new Error(`Auditoria obrigatória indisponível: ${error.message}`);
      wrapped.code = 'AUDIT_REQUIRED_FAILED';
      wrapped.cause = error;
      throw wrapped;
    }
    console.warn('[SISHA][audit] Falha ao registrar auditoria:', error.message);
    return { ok: false, error: error.message };
  }
}

module.exports = {
  GOD_EMAIL,
  OWNER_ROLE,
  normalizeEmail,
  normalizeRole,
  isGodEmail,
  isOwnerRole,
  isGodUser,
  sanitizeAuditValue,
  registrarAuditoria,
};
