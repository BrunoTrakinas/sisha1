const { getSupabaseAdmin } = require('../config/supabaseAdminClient');
const { isGodEmail, isGodUser, registrarAuditoria } = require('../utils/auditLogger');
const { markPresenceOnline, markPresenceOffline, listOnlineUsers } = require('../utils/presenceTracker');
const {
  signInWithPassword,
  getAuthUserFromToken,
  sendAccessLink,
  updatePasswordFromAccessToken,
  updateAuthEmailIfExists,
  rollbackAuthEmail,
  deleteAuthUserByEmail,
  revokeSupabaseSession,
} = require('../services/supabaseAuthService');
const { bindAuthorizedUserIdentity } = require('../services/authIdentityBindingService');

const VALID_ROLES = ['admin', 'operador', 'dono'];

function authorizedUsersDb() {
  return getSupabaseAdmin();
}

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

function normalizeSenha(senha) {
  return String(senha || '').trim();
}

function extractBearerToken(req) {
  const header = String(req.headers?.authorization || '');
  return header.startsWith('Bearer ') ? header.slice(7).trim() : '';
}

function isDono(user = {}) {
  return isGodUser(user);
}

function isAdmin(user = {}) {
  return String(user?.role || '').trim().toLowerCase() === 'admin';
}

function canAdminManageTarget(actor = {}, target = {}) {
  const actorId = String(actor?.sub || actor?.id || '');
  const targetId = String(target?.id || '');
  const targetRole = String(target?.role || '').trim().toLowerCase();
  return targetRole === 'operador' || (actorId && targetId && actorId === targetId && targetRole === 'admin');
}

function sanitizeUser(row = {}) {
  return {
    id: row.id,
    email: row.email,
    role: row.role,
    active: row.active,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

async function loadAuthorizedByEmail(email) {
  const { data, error } = await authorizedUsersDb()
    .from('authorized_users')
    .select('id,email,role,active,created_at,updated_at,auth_user_id,auth_bound_at')
    .eq('email', normalizeEmail(email))
    .maybeSingle();
  if (error) throw error;
  return data || null;
}

async function respondLoginSuccess({ req, res, row, token, provider }) {
  const isGod = isGodUser(row);
  const reqWithUser = {
    ...req,
    user: {
      email: row.email,
      role: row.role,
      sub: row.id,
      auth_provider: provider,
    },
  };

  await markPresenceOnline({ req: reqWithUser, user: row, lastPath: '/login' });
  await registrarAuditoria({
    req: reqWithUser,
    action: 'LOGIN_SUCESSO',
    entity: 'AUTH',
    entityId: row.email,
    summary: `${row.email} acessou o SISHA.`,
    details: { email: row.email, role: row.role, isGod, auth_provider: provider },
    level: 'INFO',
    visibility: 'GOD',
  });

  return res.status(200).json({
    status: 'success',
    token,
    auth_provider: provider,
    user: {
      id: row.id,
      email: row.email,
      role: row.role,
      isGod,
      isDono: isGodUser(row),
    },
  });
}

exports.login = async (req, res) => {
  try {
    const email = normalizeEmail(req.body.email);
    const senha = normalizeSenha(req.body.senha);

    if (!email || !senha) {
      return res.status(400).json({ status: 'error', message: 'Email e Senha sao obrigatorios.' });
    }

    const row = await loadAuthorizedByEmail(email);
    if (!row) {
      await registrarAuditoria({
        req,
        action: 'LOGIN_EMAIL_NAO_ENCONTRADO',
        entity: 'AUTH',
        entityId: email,
        summary: `Tentativa de login com email nao encontrado: ${email}.`,
        details: { email, motivo: 'EMAIL_NAO_ENCONTRADO', auth_provider: 'supabase' },
        level: 'WARN',
        visibility: 'GOD',
      });
      return res.status(404).json({ status: 'error', code: 'EMAIL_NAO_ENCONTRADO', message: 'Email nao encontrado na lista de usuarios autorizados.' });
    }

    if (row.active === false) {
      return res.status(403).json({ status: 'error', code: 'USUARIO_INATIVO', message: 'Usuario encontrado, mas o cadastro esta desativado. Procure o Admin ou o Dono.' });
    }

    let auth;
    try {
      auth = await signInWithPassword(email, senha);
    } catch (authError) {
      await registrarAuditoria({
        req,
        action: 'LOGIN_SUPABASE_INVALIDO',
        entity: 'AUTH',
        entityId: email,
        summary: `Tentativa de login Supabase invalida para ${email}.`,
        details: { email, motivo: 'CREDENCIAL_SUPABASE_INVALIDA' },
        level: 'WARN',
        visibility: 'GOD',
      });
      return res.status(401).json({
        status: 'error',
        code: 'CREDENCIAL_SUPABASE_INVALIDA',
        message: 'Senha incorreta ou acesso Supabase ainda nao ativado. Use Esqueci minha senha para receber um link seguro.',
      });
    }

    try {
      await bindAuthorizedUserIdentity({
        authorizedUserId: row.id,
        authUserId: auth.user.id,
        authEmail: auth.user.email,
      });
    } catch (bindingError) {
      await registrarAuditoria({
        req,
        action: 'LOGIN_IDENTIDADE_AUTH_DIVERGENTE',
        entity: 'AUTH',
        entityId: email,
        summary: `Login bloqueado por divergencia do vinculo Supabase Auth para ${email}.`,
        details: { email, motivo: bindingError.code || 'AUTH_IDENTITY_BINDING_ERROR' },
        level: 'ERROR',
        visibility: 'GOD',
      });
      return res.status(403).json({
        status: 'error',
        code: 'AUTH_IDENTITY_BINDING_ERROR',
        message: 'A identidade de acesso nao corresponde ao cadastro autorizado no SISHA. Procure o Dono.',
      });
    }

    return respondLoginSuccess({
      req,
      res,
      row,
      token: auth.session.access_token,
      provider: 'supabase',
    });
  } catch (error) {
    console.error('ERRO LOGIN SISHA:', error);
    return res.status(500).json({ status: 'error', message: 'Falha ao autenticar o militar.' });
  }
};

exports.logout = async (req, res) => {
  try {
    const reason = String(req.body?.reason || 'MANUAL').trim().toUpperCase();
    const isIdle = reason === 'INATIVIDADE' || reason === 'IDLE_TIMEOUT';
    const action = isIdle ? 'LOGOUT_INATIVIDADE' : 'LOGOUT';
    const summary = isIdle
      ? `${req.user?.email || 'Usuário'} teve a sessão encerrada por inatividade.`
      : `${req.user?.email || 'Usuário'} saiu do SISHA.`;

    const token = extractBearerToken(req);
    if (req.user?.auth_provider === 'supabase') {
      const revoke = await revokeSupabaseSession(token);
      if (revoke.error) console.warn('[SISHA][auth] Falha não bloqueante ao revogar sessão Supabase:', revoke.error.message);
    }

    await markPresenceOffline({ req, user: req.user });
    await registrarAuditoria({
      req,
      action,
      entity: 'AUTH',
      entityId: req.user?.email,
      summary,
      details: { email: req.user?.email, role: req.user?.role, reason, auth_provider: req.user?.auth_provider || 'supabase' },
      level: 'INFO',
      visibility: 'GOD',
    });

    return res.status(200).json({ status: 'success', message: 'Sessão encerrada.' });
  } catch (error) {
    console.error('ERRO LOGOUT SISHA:', error);
    return res.status(200).json({ status: 'success', message: 'Sessão encerrada.' });
  }
};

exports.requestPasswordReset = async (req, res) => {
  const generic = 'Se o email estiver autorizado no SISHA, o link de acesso/recuperação será enviado.';
  try {
    const email = normalizeEmail(req.body?.email);
    if (!email) return res.status(400).json({ status: 'error', message: 'Informe o email.' });

    const row = await loadAuthorizedByEmail(email);
    if (!row || row.active === false) {
      return res.status(200).json({ status: 'success', message: generic });
    }

    try {
      const access = await sendAccessLink(email);
      await bindAuthorizedUserIdentity({
        authorizedUserId: row.id,
        authUserId: access.auth_user_id,
        authEmail: row.email,
      });
    } catch (error) {
      console.warn('[SISHA][auth] Falha ao enviar recuperacao de senha:', error.message);
    }

    return res.status(200).json({ status: 'success', message: generic });
  } catch (error) {
    console.error('ERRO PASSWORD RESET SISHA:', error);
    return res.status(200).json({ status: 'success', message: generic });
  }
};

exports.setPasswordFromLink = async (req, res) => {
  try {
    const token = extractBearerToken(req);
    const newPassword = String(req.body?.senha || '');
    if (!token || !newPassword) {
      return res.status(400).json({ status: 'error', message: 'Link de acesso e nova senha são obrigatórios.' });
    }

    const authUser = await getAuthUserFromToken(token);
    const email = normalizeEmail(authUser.email);
    const row = await loadAuthorizedByEmail(email);

    if (!row || row.active === false) {
      return res.status(403).json({ status: 'error', message: 'Este email não está autorizado ou está inativo no SISHA.' });
    }

    await bindAuthorizedUserIdentity({
      authorizedUserId: row.id,
      authUserId: authUser.id,
      authEmail: authUser.email,
    });

    await updatePasswordFromAccessToken(token, newPassword);

    await registrarAuditoria({
      req: { ...req, user: { sub: row.id, email: row.email, role: row.role, auth_provider: 'supabase' } },
      action: 'AUTH_SENHA_DEFINIDA_SUPABASE',
      entity: 'AUTH',
      entityId: row.email,
      summary: `${row.email} definiu a própria senha pelo fluxo seguro do Supabase Auth.`,
      details: { email: row.email, auth_provider: 'supabase', local_password_storage: false },
      level: 'INFO',
      visibility: 'GOD',
    });

    return res.status(200).json({
      status: 'success',
      message: 'Senha definida com sucesso. Volte ao login e acesse o SISHA com sua nova senha.',
    });
  } catch (error) {
    console.error('ERRO SET PASSWORD SISHA:', error);
    return res.status(400).json({
      status: 'error',
      message: 'Não foi possível concluir a definição de senha. O link pode ter expirado; solicite um novo link de acesso.',
    });
  }
};

exports.presencePing = async (req, res) => {
  try {
    const lastPath = String(req.body?.path || req.headers?.referer || '').slice(0, 500);
    const data = await markPresenceOnline({ req, user: req.user, lastPath });
    return res.status(200).json({ status: 'success', data });
  } catch (error) {
    console.warn('[SISHA][presence] Falha no ping:', error.message);
    return res.status(200).json({ status: 'success', data: null });
  }
};

exports.onlineUsers = async (req, res) => {
  try {
    if (!isGodUser(req.user)) {
      return res.status(403).json({ status: 'error', message: 'Somente o perfil DONO pode visualizar usuários online.' });
    }

    const data = await listOnlineUsers({ minutes: Number(req.query?.minutes || 3) });
    return res.status(200).json({ status: 'success', data });
  } catch (error) {
    console.error('ERRO ONLINE USERS SISHA:', error);
    return res.status(500).json({ status: 'error', message: 'Falha ao listar usuários online.' });
  }
};

exports.me = async (req, res) => {
  return res.status(200).json({
    status: 'success',
    user: {
      id: req.user.sub,
      email: req.user.email,
      role: req.user.role,
      auth_provider: req.user.auth_provider || 'supabase',
      isGod: isGodUser(req.user),
      isDono: isGodUser(req.user),
    },
  });
};

exports.listAuthorizedUsers = async (req, res) => {
  try {
    const { data, error } = await authorizedUsersDb()
      .from('authorized_users')
      .select('id, email, role, active, created_at, updated_at')
      .order('email', { ascending: true });
    if (error) throw error;

    const rows = (data || []).filter((row) => {
      if (isDono(req.user)) return true;
      if (isAdmin(req.user)) return canAdminManageTarget(req.user, row);
      return String(row.id) === String(req.user?.sub || '');
    }).map(sanitizeUser);

    return res.status(200).json({ status: 'success', data: rows });
  } catch (error) {
    console.error('ERRO LISTAGEM AUTH USERS:', error);
    return res.status(500).json({ status: 'error', message: 'Falha ao listar militares autorizados.' });
  }
};

exports.createAuthorizedUser = async (req, res) => {
  try {
    const email = normalizeEmail(req.body.email);
    const role = String(req.body.role || 'operador').trim().toLowerCase();

    if (!email) {
      return res.status(400).json({ status: 'error', message: 'Email é obrigatório.' });
    }
    if (!VALID_ROLES.includes(role)) {
      return res.status(400).json({ status: 'error', message: 'Role inválida. Use operador, admin ou dono.' });
    }
    if (!isDono(req.user)) {
      return res.status(403).json({ status: 'error', message: 'Somente o DONO pode cadastrar usuários e definir permissões.' });
    }

    const existing = await loadAuthorizedByEmail(email);
    if (existing) {
      return res.status(409).json({
        status: 'error',
        message: 'Este email já está cadastrado. Use ENVIAR LINK para primeiro acesso/recuperação.',
      });
    }

    const { data, error } = await authorizedUsersDb()
      .from('authorized_users')
      .insert({ email, role, active: true })
      .select('id, email, role, active')
      .single();
    if (error) throw error;

    try {
      const access = await sendAccessLink(email);
      await bindAuthorizedUserIdentity({
        authorizedUserId: data.id,
        authUserId: access.auth_user_id,
        authEmail: email,
      });
      await registrarAuditoria({
        req,
        action: 'USUARIO_CONVIDADO_SUPABASE',
        entity: 'AUTHORIZED_USERS',
        entityId: email,
        summary: `${req.user?.email || 'Sistema'} autorizou ${email} como ${role} e enviou link seguro de acesso.`,
        details: { email, role, active: true, auth_provider: 'supabase', access_method: access.method, auth_identity_bound: true },
        level: 'INFO',
        visibility: 'GOD',
      });
      return res.status(200).json({
        status: 'success',
        message: `Militar ${email} autorizado. O link para definir a própria senha foi enviado por email.`,
        data,
      });
    } catch (inviteError) {
      const rollback = await authorizedUsersDb().from('authorized_users').delete().eq('id', data.id);
      if (rollback.error) console.error('[SISHA][auth] Falha no rollback do cadastro após erro de convite:', rollback.error.message);
      console.error('[SISHA][auth] Falha ao enviar convite:', inviteError.message);
      return res.status(502).json({
        status: 'error',
        message: 'O usuário não foi ativado porque o Supabase não conseguiu enviar o link de primeiro acesso. Nenhuma senha foi criada pelo SISHA.',
      });
    }
  } catch (error) {
    console.error('ERRO CREATE AUTH USER:', error);
    return res.status(500).json({ status: 'error', message: 'Falha ao cadastrar militar autorizado.' });
  }
};

exports.sendAuthorizedUserAccessLink = async (req, res) => {
  try {

    const { id } = req.params;
    const atual = await authorizedUsersDb().from('authorized_users').select('id,email,role,active,auth_user_id,auth_bound_at').eq('id', id).maybeSingle();
    if (atual.error) throw atual.error;
    if (!atual.data) return res.status(404).json({ status: 'error', message: 'Usuário não encontrado.' });

    const actorIsDono = isDono(req.user);
    const actorIsAdmin = isAdmin(req.user);
    if (!actorIsDono && !actorIsAdmin) {
      return res.status(403).json({ status: 'error', message: 'Perfil sem permissão para gerenciar acessos.' });
    }
    if (actorIsAdmin && !canAdminManageTarget(req.user, atual.data)) {
      return res.status(403).json({ status: 'error', message: 'Admin só pode gerenciar a própria conta e usuários Operador.' });
    }
    if (atual.data.active === false) {
      return res.status(409).json({ status: 'error', message: 'Ative o usuário antes de enviar um link de acesso.' });
    }

    const access = await sendAccessLink(atual.data.email);
    await bindAuthorizedUserIdentity({
      authorizedUserId: atual.data.id,
      authUserId: access.auth_user_id,
      authEmail: atual.data.email,
    });
    await registrarAuditoria({
      req,
      action: 'AUTH_LINK_ACESSO_ENVIADO',
      entity: 'AUTHORIZED_USERS',
      entityId: atual.data.email,
      summary: `${req.user?.email || 'Sistema'} enviou link seguro de acesso para ${atual.data.email}.`,
      details: { email: atual.data.email, access_method: access.method, auth_identity_bound: true },
      level: 'INFO',
      visibility: 'GOD',
    });

    return res.status(200).json({
      status: 'success',
      message: `Link de primeiro acesso/recuperação enviado para ${atual.data.email}.`,
    });
  } catch (error) {
    console.error('ERRO SEND ACCESS LINK:', error);
    return res.status(502).json({ status: 'error', message: 'Falha ao enviar link de acesso pelo Supabase Auth.' });
  }
};

exports.updateAuthorizedUser = async (req, res) => {
  let authEmailChange = null;
  try {
    const { id } = req.params;
    const atual = await authorizedUsersDb().from('authorized_users').select('id,email,role,active,auth_user_id,auth_bound_at').eq('id', id).maybeSingle();
    if (atual.error) throw atual.error;
    if (!atual.data) return res.status(404).json({ status: 'error', message: 'Usuário não encontrado.' });

    const actorIsDono = isDono(req.user);
    const actorIsAdmin = isAdmin(req.user);
    if (!actorIsDono && !actorIsAdmin) {
      return res.status(403).json({ status: 'error', message: 'Perfil sem permissão para editar usuários.' });
    }
    if (actorIsAdmin && !canAdminManageTarget(req.user, atual.data)) {
      return res.status(403).json({ status: 'error', message: 'Admin só pode editar a própria conta e usuários Operador.' });
    }

    const payload = {};
    if (req.body.email !== undefined) {
      const email = normalizeEmail(req.body.email);
      if (!email) return res.status(400).json({ status: 'error', message: 'Email inválido.' });
      if (!actorIsDono && isGodEmail(email)) {
        return res.status(403).json({ status: 'error', message: 'Admin não pode vincular conta ao usuário DONO.' });
      }
      payload.email = email;
    }

    if (req.body.senha !== undefined && normalizeSenha(req.body.senha)) {
      return res.status(400).json({
        status: 'error',
        message: 'Senhas nao sao armazenadas pelo SISHA. Use ENVIAR LINK para definir ou recuperar o acesso no Supabase Auth.',
      });
    }

    if (req.body.role !== undefined) {
      const role = String(req.body.role || 'operador').trim().toLowerCase();
      if (!VALID_ROLES.includes(role)) {
        return res.status(400).json({ status: 'error', message: 'Role inválida. Use operador, admin ou dono.' });
      }
      if (!actorIsDono && role !== atual.data.role) {
        return res.status(403).json({ status: 'error', message: 'Somente o DONO pode alterar permissões.' });
      }
      if (actorIsDono) payload.role = role;
    }

    if (req.body.active !== undefined) {
      const active = Boolean(req.body.active);
      if (String(req.user?.sub || '') === String(id) && active === false) {
        return res.status(400).json({ status: 'error', message: 'Por segurança, você não pode desativar o próprio usuário.' });
      }
      payload.active = active;
    }

    if (actorIsDono && String(req.user?.sub || '') === String(id) && payload.role && payload.role !== 'dono') {
      return res.status(400).json({ status: 'error', message: 'Por segurança, o DONO logado não pode rebaixar a própria permissão.' });
    }

    if (Object.keys(payload).length === 0) {
      return res.status(400).json({ status: 'error', message: 'Nenhum campo enviado para atualização.' });
    }

    if (payload.email && payload.email !== atual.data.email) {
      authEmailChange = await updateAuthEmailIfExists(atual.data.email, payload.email, atual.data.auth_user_id);
    }

    payload.updated_at = new Date().toISOString();
    const { data, error } = await authorizedUsersDb()
      .from('authorized_users')
      .update(payload)
      .eq('id', id)
      .select('id, email, role, active, created_at, updated_at')
      .single();

    if (error) {
      if (authEmailChange?.changed) {
        try {
          await rollbackAuthEmail(authEmailChange.auth_user_id, atual.data.email);
        } catch (rollbackError) {
          console.error('[SISHA][auth] CRITICO: falha ao restaurar email no Supabase após erro de banco:', rollbackError.message);
        }
      }
      throw error;
    }

    await registrarAuditoria({
      req,
      action: 'USUARIO_EDITADO',
      entity: 'AUTHORIZED_USERS',
      entityId: data.email,
      summary: `${req.user?.email || 'Sistema'} editou usuário ${data.email}.`,
      details: { before: atual.data, after: data, changed_fields: Object.keys(payload).filter((k) => k !== 'updated_at') },
      level: 'INFO',
      visibility: 'GOD',
    });

    return res.status(200).json({ status: 'success', message: 'Usuário atualizado com sucesso.', data });
  } catch (error) {
    console.error('ERRO UPDATE AUTH USER:', error);
    return res.status(500).json({ status: 'error', message: 'Falha ao atualizar militar autorizado.' });
  }
};

exports.deleteAuthorizedUser = async (req, res) => {
  try {
    if (!isDono(req.user)) {
      return res.status(403).json({ status: 'error', message: 'Somente o DONO pode excluir usuarios.' });
    }

    const { id } = req.params;
    const atual = await authorizedUsersDb().from('authorized_users').select('id,email,role,active,auth_user_id,auth_bound_at').eq('id', id).maybeSingle();
    if (atual.error) throw atual.error;
    if (!atual.data) return res.status(404).json({ status: 'error', message: 'Usuario nao encontrado.' });

    if (String(req.user?.sub || '') === String(id)) {
      return res.status(400).json({ status: 'error', message: 'Por seguranca, o seu proprio usuario nao pode ser excluido por esta tela.' });
    }

    const previousActive = atual.data.active !== false;
    const { error: deactivateError } = await authorizedUsersDb()
      .from('authorized_users')
      .update({ active: false, updated_at: new Date().toISOString() })
      .eq('id', id);
    if (deactivateError) throw deactivateError;

    let authDeletion = { found: false, deleted: false, auth_user_id: null };
    try {
      authDeletion = await deleteAuthUserByEmail(atual.data.email, atual.data.auth_user_id);
    } catch (authError) {
      const { error: restoreError } = await authorizedUsersDb()
        .from('authorized_users')
        .update({ active: previousActive, updated_at: new Date().toISOString() })
        .eq('id', id);

      await registrarAuditoria({
        req,
        action: 'USUARIO_EXCLUSAO_AUTH_FALHOU',
        entity: 'AUTHORIZED_USERS',
        entityId: atual.data.email,
        summary: `Falhou a exclusao do usuario ${atual.data.email} no Supabase Auth; cadastro SISHA preservado.`,
        details: {
          email: atual.data.email,
          auth_provider: 'supabase',
          local_access_restored: !restoreError,
          previous_active: previousActive,
          auth_error_code: authError?.code || null,
        },
        level: 'ERROR',
        visibility: 'GOD',
      });

      return res.status(502).json({
        status: 'error',
        message: 'Nao foi possivel excluir a identidade no Supabase Auth. O cadastro do SISHA foi preservado; tente novamente.',
      });
    }

    const { error: localDeleteError } = await authorizedUsersDb().from('authorized_users').delete().eq('id', id);
    if (localDeleteError) {
      await registrarAuditoria({
        req,
        action: 'USUARIO_EXCLUSAO_LOCAL_PENDENTE',
        entity: 'AUTHORIZED_USERS',
        entityId: atual.data.email,
        summary: `A identidade Auth de ${atual.data.email} foi tratada, mas a exclusao local ficou pendente.`,
        details: {
          email: atual.data.email,
          auth_provider: 'supabase',
          auth_user_found: authDeletion.found,
          auth_user_deleted: authDeletion.deleted,
          local_access_forced_inactive: true,
        },
        level: 'ERROR',
        visibility: 'GOD',
      });
      return res.status(500).json({
        status: 'error',
        message: 'A identidade de autenticacao foi removida ou ja estava ausente, mas o cadastro SISHA ficou inativo e pendente de exclusao. Repita a operacao.',
      });
    }

    await registrarAuditoria({
      req,
      action: 'USUARIO_EXCLUIDO',
      entity: 'AUTHORIZED_USERS',
      entityId: atual.data.email,
      summary: `${req.user?.email || 'Sistema'} excluiu usuario ${atual.data.email}.`,
      details: {
        deleted: atual.data,
        auth_provider: 'supabase',
        auth_user_found: authDeletion.found,
        auth_user_deleted: authDeletion.deleted,
        auth_account_absent_before_delete: !authDeletion.found,
      },
      level: 'WARN',
      visibility: 'GOD',
    });

    return res.status(200).json({
      status: 'success',
      message: 'Militar removido da lista de acesso e do Supabase Auth.',
    });
  } catch (error) {
    console.error('ERRO DELETE AUTH USER:', error);
    return res.status(500).json({ status: 'error', message: 'Falha ao remover militar autorizado.' });
  }
};
