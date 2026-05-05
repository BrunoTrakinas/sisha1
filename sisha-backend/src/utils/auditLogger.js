const supabase = require('../config/supabaseClient');

const GOD_EMAIL = 'bruno.martins@marinha.mil.br';
const OWNER_ROLE = 'dono';

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

function safeJson(value) {
  if (value == null) return {};
  if (typeof value === 'object') return value;
  return { value };
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
} = {}) {
  try {
    const actorEmail = normalizeEmail(req?.user?.email || details?.email || null) || null;
    const actorRole = req?.user?.role || null;
    const ip = req?.headers?.['x-forwarded-for'] || req?.socket?.remoteAddress || null;
    const userAgent = req?.headers?.['user-agent'] || null;

    const payload = {
      actor_email: actorEmail,
      actor_role: actorRole,
      action: String(action || 'EVENTO').toUpperCase(),
      entity: String(entity || 'SISTEMA').toUpperCase(),
      entity_id: entityId ? String(entityId) : null,
      summary: summary || null,
      details: safeJson(details),
      level: String(level || 'INFO').toUpperCase(),
      visibility: String(visibility || 'GOD').toUpperCase(),
      ip,
      user_agent: userAgent,
    };

    const { error } = await supabase.from('system_audit_logs').insert(payload);
    if (error) {
      // Não derruba a operação principal por falha de auditoria.
      console.warn('[SISHA][audit] Falha ao registrar auditoria:', error.message);
    }
  } catch (error) {
    console.warn('[SISHA][audit] Falha inesperada:', error.message);
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
  registrarAuditoria,
};
