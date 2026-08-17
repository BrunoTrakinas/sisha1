const { getSupabaseAdmin } = require('../config/supabaseAdminClient');

function normalizeEmail(value = '') {
  return String(value || '').trim().toLowerCase();
}

function normalizeUuid(value = '') {
  return String(value || '').trim().toLowerCase();
}

function bindingError(message, code = 'AUTH_IDENTITY_BINDING_ERROR') {
  const error = new Error(message);
  error.code = code;
  return error;
}

async function loadAuthorizedUserByAuthId(authUserId) {
  const id = normalizeUuid(authUserId);
  if (!id) return null;

  const { data, error } = await getSupabaseAdmin()
    .from('authorized_users')
    .select('id,email,role,active,auth_user_id,auth_bound_at')
    .eq('auth_user_id', id)
    .maybeSingle();

  if (error) throw error;
  return data || null;
}

async function bindAuthorizedUserIdentity({ authorizedUserId, authUserId, authEmail }) {
  const localId = String(authorizedUserId || '').trim();
  const providerId = normalizeUuid(authUserId);
  const providerEmail = normalizeEmail(authEmail);

  if (!localId || !providerId) {
    throw bindingError('Vínculo Auth incompleto: IDs obrigatórios ausentes.', 'AUTH_IDENTITY_BINDING_INPUT_INVALID');
  }

  const db = getSupabaseAdmin();
  const { data: current, error: currentError } = await db
    .from('authorized_users')
    .select('id,email,role,active,auth_user_id,auth_bound_at')
    .eq('id', localId)
    .maybeSingle();

  if (currentError) throw currentError;
  if (!current) {
    throw bindingError('Cadastro autorizado não encontrado para vínculo Supabase Auth.', 'AUTH_IDENTITY_LOCAL_USER_MISSING');
  }

  if (providerEmail && normalizeEmail(current.email) !== providerEmail) {
    throw bindingError('A identidade Supabase não corresponde ao email autorizado no SISHA.', 'AUTH_IDENTITY_EMAIL_MISMATCH');
  }

  if (current.auth_user_id) {
    if (normalizeUuid(current.auth_user_id) !== providerId) {
      throw bindingError('Este cadastro SISHA já está vinculado a outra identidade Supabase Auth.', 'AUTH_IDENTITY_UUID_MISMATCH');
    }
    return { ...current, newlyBound: false };
  }

  const now = new Date().toISOString();
  const { data: updated, error: updateError } = await db
    .from('authorized_users')
    .update({ auth_user_id: providerId, auth_bound_at: now, updated_at: now })
    .eq('id', localId)
    .is('auth_user_id', null)
    .select('id,email,role,active,auth_user_id,auth_bound_at')
    .maybeSingle();

  if (updateError) throw updateError;
  if (updated) return { ...updated, newlyBound: true };

  // Corrida rara: outra requisição pode ter vinculado entre SELECT e UPDATE.
  const { data: reloaded, error: reloadError } = await db
    .from('authorized_users')
    .select('id,email,role,active,auth_user_id,auth_bound_at')
    .eq('id', localId)
    .maybeSingle();

  if (reloadError) throw reloadError;
  if (reloaded && normalizeUuid(reloaded.auth_user_id) === providerId) {
    return { ...reloaded, newlyBound: false };
  }

  throw bindingError('Não foi possível concluir o vínculo 1:1 com o Supabase Auth.', 'AUTH_IDENTITY_BINDING_RACE');
}

async function resolveAuthorizedUserForAuthUser(authUser = {}) {
  const authUserId = normalizeUuid(authUser.id);
  if (!authUserId) {
    throw bindingError('Sessao Supabase sem identificador de usuario.', 'AUTH_IDENTITY_PROVIDER_ID_MISSING');
  }

  // H4C6: autorizacao de sessao usa somente o UUID imutavel previamente vinculado.
  // Email nao e mais fallback de autorizacao em requests autenticadas.
  return loadAuthorizedUserByAuthId(authUserId);
}

module.exports = {
  bindAuthorizedUserIdentity,
  resolveAuthorizedUserForAuthUser,
  loadAuthorizedUserByAuthId,
};
