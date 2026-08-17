const { getSupabaseAdmin } = require('../config/supabaseAdminClient');
const { isGodUser } = require('../utils/auditLogger');
const { getAuthUserFromToken } = require('../services/supabaseAuthService');
const { resolveAuthorizedUserForAuthUser } = require('../services/authIdentityBindingService');

function extractToken(req) {
  const header = req.headers.authorization || '';
  if (!header.startsWith('Bearer ')) return null;
  return header.slice(7).trim();
}

async function loadAuthorizedUserById(id) {
  const { data, error } = await getSupabaseAdmin()
    .from('authorized_users')
    .select('id,email,role,active')
    .eq('id', id)
    .maybeSingle();
  if (error) throw error;
  return data || null;
}

function ensureActiveAuthorizedUser(row) {
  if (!row) {
    const error = new Error('Usuário não autorizado no SISHA.');
    error.code = 'SISHA_USER_NOT_AUTHORIZED';
    throw error;
  }
  if (row.active === false) {
    const error = new Error('Usuário desativado no SISHA.');
    error.code = 'SISHA_USER_INACTIVE';
    throw error;
  }
  return row;
}

async function resolveSupabaseUser(token) {
  const authUser = await getAuthUserFromToken(token);
  const row = ensureActiveAuthorizedUser(await resolveAuthorizedUserForAuthUser(authUser));
  return {
    sub: row.id,
    email: row.email,
    role: row.role,
    auth_provider: 'supabase',
    auth_user_id: authUser.id,
  };
}

async function requireAuth(req, res, next) {
  try {
    const token = extractToken(req);
    if (!token) {
      return res.status(401).json({ status: 'error', message: 'Acesso não autorizado.' });
    }

    // H4C6: somente sessoes emitidas pelo Supabase Auth sao aceitas.
    // Tokens HMAC legados do SISHA deixam de ser reconhecidos imediatamente.
    req.user = await resolveSupabaseUser(token);
    return next();
  } catch (error) {
    return res.status(401).json({ status: 'error', message: error.message || 'Sessão inválida.' });
  }
}

function requireRole(rolesPermitidas = []) {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ status: 'error', message: 'Acesso não autorizado.' });
    }

    // DONO é superusuário funcional: pode acessar rotas de Admin sem precisar duplicar
    // todas as listas de roles no projeto. Operador continua limitado normalmente.
    if (req.user.role === 'dono') {
      return next();
    }

    if (!rolesPermitidas.includes(req.user.role)) {
      return res.status(403).json({ status: 'error', message: 'Perfil sem permissão para esta operação.' });
    }

    return next();
  };
}

function requireDono(req, res, next) {
  if (!req.user) {
    return res.status(401).json({ status: 'error', message: 'Acesso não autorizado.' });
  }

  if (!isGodUser(req.user)) {
    return res.status(403).json({
      status: 'error',
      message: 'Permissão DONO necessária. Esta ação é restrita ao proprietário do SISHA.',
    });
  }

  return next();
}

module.exports = {
  requireAuth,
  requireRole,
  requireDono,
  requireGod: requireDono,
};
