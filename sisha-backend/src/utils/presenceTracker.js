const supabase = require('../config/supabaseClient');
const { normalizeEmail, normalizeRole } = require('./auditLogger');

function getIp(req) {
  const forwarded = req?.headers?.['x-forwarded-for'];
  if (forwarded) return String(forwarded).split(',')[0].trim();
  return req?.socket?.remoteAddress || null;
}

function normalizeUser(user = {}) {
  return {
    id: user?.sub || user?.id || null,
    email: normalizeEmail(user?.email || ''),
    role: normalizeRole(user?.role || 'operador') || 'operador',
  };
}

async function markPresenceOnline({ req, user, lastPath = '' } = {}) {
  const normalized = normalizeUser(user || req?.user || {});
  if (!normalized.email) return null;

  const payload = {
    user_id: normalized.id ? String(normalized.id) : null,
    email: normalized.email,
    role: normalized.role,
    online: true,
    last_seen_at: new Date().toISOString(),
    last_path: String(lastPath || '').slice(0, 500) || null,
    ip: getIp(req),
    user_agent: req?.headers?.['user-agent'] || null,
    updated_at: new Date().toISOString(),
  };

  const { data, error } = await supabase
    .from('system_user_presence')
    .upsert(payload, { onConflict: 'email' })
    .select('email, role, online, last_seen_at, last_path')
    .maybeSingle();

  if (error) {
    console.warn('[SISHA][presence] Falha ao marcar online:', error.message);
    return null;
  }

  return data;
}

async function markPresenceOffline({ req, user } = {}) {
  const normalized = normalizeUser(user || req?.user || {});
  if (!normalized.email) return null;

  const payload = {
    online: false,
    last_seen_at: new Date().toISOString(),
    last_path: 'logout',
    ip: getIp(req),
    user_agent: req?.headers?.['user-agent'] || null,
    updated_at: new Date().toISOString(),
  };

  const { data, error } = await supabase
    .from('system_user_presence')
    .update(payload)
    .eq('email', normalized.email)
    .select('email, role, online, last_seen_at')
    .maybeSingle();

  if (error) {
    console.warn('[SISHA][presence] Falha ao marcar offline:', error.message);
    return null;
  }

  return data;
}

async function listOnlineUsers({ minutes = 3 } = {}) {
  const safeMinutes = Math.max(1, Math.min(Number(minutes) || 3, 60));
  const since = new Date(Date.now() - safeMinutes * 60 * 1000).toISOString();

  const { data, error } = await supabase
    .from('system_user_presence')
    .select('email, role, online, last_seen_at, last_path, updated_at')
    .eq('online', true)
    .gte('last_seen_at', since)
    .order('last_seen_at', { ascending: false })
    .limit(50);

  if (error) throw error;
  return data || [];
}

module.exports = {
  markPresenceOnline,
  markPresenceOffline,
  listOnlineUsers,
};
