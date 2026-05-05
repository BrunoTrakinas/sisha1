const supabase = require('../config/supabaseClient');
const { createToken } = require('../config/authToken');
const { isGodEmail, isGodUser, isOwnerRole, registrarAuditoria } = require('../utils/auditLogger');

const VALID_ROLES = ['admin', 'operador', 'dono'];

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

function normalizeSenha(senha) {
  return String(senha || '').trim();
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

exports.login = async (req, res) => {
  try {
    const email = normalizeEmail(req.body.email);
    const senha = normalizeSenha(req.body.senha);

    if (!email || !senha) {
      return res.status(400).json({ status: 'error', message: 'Email e Senha são obrigatórios.' });
    }

    const { data, error } = await supabase
      .from('authorized_users')
      .select('id, email, senha, role, active')
      .eq('email', email)
      .eq('senha', senha)
      .maybeSingle();

    if (error) throw error;

    if (!data || data.active === false) {
      await registrarAuditoria({
        req,
        action: 'LOGIN_NEGADO',
        entity: 'AUTH',
        entityId: email,
        summary: `Tentativa de acesso negada para ${email}.`,
        details: { email },
        level: 'WARN',
        visibility: 'GOD',
      });
      return res.status(401).json({ status: 'error', message: 'Acesso não autorizado para este militar.' });
    }

    const token = createToken(data);
    const isGod = isGodUser(data);

    await registrarAuditoria({
      req: { ...req, user: { email: data.email, role: data.role, sub: data.id } },
      action: 'LOGIN_SUCESSO',
      entity: 'AUTH',
      entityId: data.email,
      summary: `${data.email} acessou o SISHA.`,
      details: { email: data.email, role: data.role, isGod },
      level: 'INFO',
      visibility: 'GOD',
    });

    return res.status(200).json({
      status: 'success',
      token,
      user: {
        id: data.id,
        email: data.email,
        role: data.role,
        isGod,
        isDono: isGodUser(data),
      },
    });
  } catch (error) {
    console.error('ERRO LOGIN SISHA:', error);
    return res.status(500).json({ status: 'error', message: 'Falha ao autenticar o militar.' });
  }
};

exports.me = async (req, res) => {
  return res.status(200).json({
    status: 'success',
    user: {
      id: req.user.sub,
      email: req.user.email,
      role: req.user.role,
      isGod: isGodUser(req.user),
      isDono: isGodUser(req.user),
    },
  });
};

exports.listAuthorizedUsers = async (req, res) => {
  try {
    let query = supabase
      .from('authorized_users')
      .select('id, email, role, active, created_at, updated_at')
      .order('email', { ascending: true });

    const { data, error } = await query;
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
    const senha = normalizeSenha(req.body.senha);
    const role = String(req.body.role || 'operador').trim().toLowerCase();

    if (!email || !senha) {
      return res.status(400).json({ status: 'error', message: 'Email e Senha são obrigatórios.' });
    }

    if (!VALID_ROLES.includes(role)) {
      return res.status(400).json({ status: 'error', message: 'Role inválida. Use operador, admin ou dono.' });
    }

    if (!isDono(req.user)) {
      return res.status(403).json({ status: 'error', message: 'Somente o DONO pode cadastrar usuários e definir permissões.' });
    }

    const payload = {
      email,
      senha,
      role,
      active: true,
    };

    const { data, error } = await supabase
      .from('authorized_users')
      .upsert(payload, { onConflict: 'email' })
      .select('id, email, role, active')
      .single();

    if (error) throw error;

    await registrarAuditoria({
      req,
      action: 'USUARIO_CRIADO_ATUALIZADO',
      entity: 'AUTHORIZED_USERS',
      entityId: email,
      summary: `${req.user?.email || 'Sistema'} cadastrou/atualizou usuário ${email} como ${role}.`,
      details: { email, role, active: true },
      level: 'INFO',
      visibility: 'GOD',
    });

    return res.status(200).json({
      status: 'success',
      message: `Militar ${email} autorizado com sucesso.`,
      data,
    });
  } catch (error) {
    console.error('ERRO CREATE AUTH USER:', error);
    return res.status(500).json({ status: 'error', message: 'Falha ao cadastrar militar autorizado.' });
  }
};


exports.updateAuthorizedUser = async (req, res) => {
  try {
    const { id } = req.params;

    const atual = await supabase.from('authorized_users').select('id,email,role,active').eq('id', id).maybeSingle();
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
      payload.senha = normalizeSenha(req.body.senha);
    }

    if (req.body.role !== undefined) {
      const role = String(req.body.role || 'operador').trim().toLowerCase();
      if (!VALID_ROLES.includes(role)) {
        return res.status(400).json({ status: 'error', message: 'Role inválida. Use operador, admin ou dono.' });
      }

      if (!actorIsDono && role !== atual.data.role) {
        return res.status(403).json({ status: 'error', message: 'Somente o DONO pode alterar permissões.' });
      }

      if (actorIsDono) {
        payload.role = role;
      }
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

    payload.updated_at = new Date().toISOString();

    const { data, error } = await supabase
      .from('authorized_users')
      .update(payload)
      .eq('id', id)
      .select('id, email, role, active, created_at, updated_at')
      .single();

    if (error) throw error;

    await registrarAuditoria({
      req,
      action: 'USUARIO_EDITADO',
      entity: 'AUTHORIZED_USERS',
      entityId: data.email,
      summary: `${req.user?.email || 'Sistema'} editou usuário ${data.email}.`,
      details: { before: atual.data, after: data, changed_fields: Object.keys(payload).filter(k => k !== 'updated_at') },
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
      return res.status(403).json({ status: 'error', message: 'Somente o DONO pode excluir usuários.' });
    }

    const { id } = req.params;

    const atual = await supabase.from('authorized_users').select('id,email,role,active').eq('id', id).maybeSingle();
    if (atual.error) throw atual.error;
    if (!atual.data) return res.status(404).json({ status: 'error', message: 'Usuário não encontrado.' });

    if (req.user?.sub === id) {
      return res.status(400).json({ status: 'error', message: 'Por segurança, o seu próprio usuário não pode ser excluído por esta tela.' });
    }

    const { error } = await supabase
      .from('authorized_users')
      .delete()
      .eq('id', id);

    if (error) throw error;

    await registrarAuditoria({
      req,
      action: 'USUARIO_EXCLUIDO',
      entity: 'AUTHORIZED_USERS',
      entityId: atual.data.email,
      summary: `${req.user?.email || 'Sistema'} excluiu usuário ${atual.data.email}.`,
      details: { deleted: atual.data },
      level: 'WARN',
      visibility: 'GOD',
    });

    return res.status(200).json({ status: 'success', message: 'Militar removido da lista de acesso.' });
  } catch (error) {
    console.error('ERRO DELETE AUTH USER:', error);
    return res.status(500).json({ status: 'error', message: 'Falha ao remover militar autorizado.' });
  }
};
