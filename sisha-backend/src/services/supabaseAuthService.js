const { createClient } = require('@supabase/supabase-js');
const { getSupabaseAdmin } = require('../config/supabaseAdminClient');

function normalizeEmail(value = '') {
  return String(value || '').trim().toLowerCase();
}

function getPublicAuthConfig() {
  return {
    url: String(process.env.SUPABASE_URL || '').trim(),
    key: String(process.env.SUPABASE_KEY || '').trim(),
  };
}

function publicAuthConfigured() {
  const { url, key } = getPublicAuthConfig();
  return Boolean(url && key);
}

function createPublicAuthClient() {
  const { url, key } = getPublicAuthConfig();
  if (!url || !key) {
    const error = new Error('Supabase Auth público não configurado no backend. Verifique SUPABASE_URL e SUPABASE_KEY.');
    error.code = 'SUPABASE_AUTH_NOT_CONFIGURED';
    throw error;
  }

  return createClient(url, key, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
  });
}

function getFrontendBaseUrl() {
  const configured = String(process.env.AUTH_FRONTEND_URL || process.env.FRONTEND_URL || '').trim();
  if (configured) return configured.replace(/\/+$/, '');

  if (String(process.env.NODE_ENV || '').trim().toLowerCase() !== 'production') {
    return 'http://localhost:5173';
  }

  const error = new Error('AUTH_FRONTEND_URL é obrigatório em produção para convites e recuperação de senha.');
  error.code = 'AUTH_FRONTEND_URL_REQUIRED';
  throw error;
}

function getPasswordSetupRedirectUrl() {
  return `${getFrontendBaseUrl()}/definir-senha`;
}

function decodeJwtPayloadUnsafe(token = '') {
  try {
    const parts = String(token || '').split('.');
    if (parts.length !== 3) return null;
    return JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  } catch (_) {
    return null;
  }
}

function looksLikeSupabaseToken(token = '') {
  const payload = decodeJwtPayloadUnsafe(token);
  if (!payload) return false;
  const issuer = String(payload.iss || '').toLowerCase();
  const audience = Array.isArray(payload.aud) ? payload.aud.map(String) : [String(payload.aud || '')];
  return issuer.includes('/auth/v1') || audience.includes('authenticated');
}

async function signInWithPassword(email, password) {
  const client = createPublicAuthClient();
  const { data, error } = await client.auth.signInWithPassword({
    email: normalizeEmail(email),
    password: String(password || ''),
  });
  if (error) throw error;
  if (!data?.session?.access_token || !data?.user) {
    const missing = new Error('Supabase Auth não retornou sessão válida.');
    missing.code = 'SUPABASE_AUTH_SESSION_MISSING';
    throw missing;
  }
  return data;
}

async function getAuthUserFromToken(token) {
  const client = createPublicAuthClient();
  const { data, error } = await client.auth.getUser(token);
  if (error) throw error;
  if (!data?.user) {
    const missing = new Error('Usuário Supabase não encontrado para a sessão informada.');
    missing.code = 'SUPABASE_AUTH_USER_MISSING';
    throw missing;
  }
  return data.user;
}

async function findAuthUserByEmail(email) {
  const admin = getSupabaseAdmin();
  const normalized = normalizeEmail(email);
  const { data, error } = await admin.auth.admin.listUsers({ page: 1, perPage: 1000 });
  if (error) throw error;
  return (data?.users || []).find((user) => normalizeEmail(user.email) === normalized) || null;
}

async function sendAccessLink(email) {
  const normalized = normalizeEmail(email);
  const redirectTo = getPasswordSetupRedirectUrl();
  const existing = await findAuthUserByEmail(normalized);

  if (existing) {
    const client = createPublicAuthClient();
    const { error } = await client.auth.resetPasswordForEmail(normalized, { redirectTo });
    if (error) throw error;
    return {
      method: 'PASSWORD_RESET',
      auth_user_id: existing.id,
      redirect_to: redirectTo,
      created_auth_user: false,
    };
  }

  const admin = getSupabaseAdmin();
  const { data, error } = await admin.auth.admin.inviteUserByEmail(normalized, {
    redirectTo,
    data: { sisha_invited: true },
  });
  if (error) throw error;

  return {
    method: 'INVITE',
    auth_user_id: data?.user?.id || null,
    redirect_to: redirectTo,
    created_auth_user: true,
  };
}

async function updatePasswordFromAccessToken(token, newPassword) {
  const user = await getAuthUserFromToken(token);
  const admin = getSupabaseAdmin();
  const { data, error } = await admin.auth.admin.updateUserById(user.id, {
    password: String(newPassword || ''),
  });
  if (error) throw error;
  return { authUser: data?.user || user };
}

async function updateAuthEmailIfExists(currentEmail, newEmail, authUserId = null) {
  const normalizedCurrent = normalizeEmail(currentEmail);
  const normalizedNew = normalizeEmail(newEmail);
  if (!normalizedCurrent || !normalizedNew || normalizedCurrent === normalizedNew) {
    return { changed: false, auth_user_id: null };
  }

  const authUser = authUserId
    ? { id: String(authUserId).trim() }
    : await findAuthUserByEmail(normalizedCurrent);
  if (!authUser?.id) return { changed: false, auth_user_id: null };

  const admin = getSupabaseAdmin();
  const { error } = await admin.auth.admin.updateUserById(authUser.id, { email: normalizedNew });
  if (error) throw error;

  return { changed: true, auth_user_id: authUser.id };
}

async function rollbackAuthEmail(authUserId, previousEmail) {
  if (!authUserId || !previousEmail) return;
  const admin = getSupabaseAdmin();
  const { error } = await admin.auth.admin.updateUserById(authUserId, { email: normalizeEmail(previousEmail) });
  if (error) throw error;
}

async function deleteAuthUserByEmail(email, authUserId = null) {
  const normalized = normalizeEmail(email);
  if (!normalized && !authUserId) {
    return { found: false, deleted: false, auth_user_id: null };
  }

  const authUser = authUserId
    ? { id: String(authUserId).trim() }
    : await findAuthUserByEmail(normalized);
  if (!authUser?.id) {
    return { found: false, deleted: false, auth_user_id: null };
  }

  const admin = getSupabaseAdmin();
  const { error } = await admin.auth.admin.deleteUser(authUser.id, false);
  if (error) throw error;

  return {
    found: true,
    deleted: true,
    auth_user_id: authUser.id,
  };
}

async function revokeSupabaseSession(token) {
  if (!token || !looksLikeSupabaseToken(token)) return { revoked: false };
  try {
    const admin = getSupabaseAdmin();
    const { error } = await admin.auth.admin.signOut(token, 'local');
    if (error) throw error;
    return { revoked: true };
  } catch (error) {
    return { revoked: false, error };
  }
}

module.exports = {
  publicAuthConfigured,
  getFrontendBaseUrl,
  getPasswordSetupRedirectUrl,
  looksLikeSupabaseToken,
  signInWithPassword,
  getAuthUserFromToken,
  findAuthUserByEmail,
  sendAccessLink,
  updatePasswordFromAccessToken,
  updateAuthEmailIfExists,
  rollbackAuthEmail,
  deleteAuthUserByEmail,
  revokeSupabaseSession,
};
