const supabase = require('../config/supabaseClient');
const { createToken } = require('../config/authToken');

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

function normalizeSenha(senha) {
  return String(senha || '').trim();
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
      return res.status(401).json({ status: 'error', message: 'Acesso não autorizado para este militar.' });
    }

    const token = createToken(data);

    return res.status(200).json({
      status: 'success',
      token,
      user: {
        id: data.id,
        email: data.email,
        role: data.role,
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
    },
  });
};

exports.listAuthorizedUsers = async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('authorized_users')
      .select('id, email, role, active, created_at')
      .order('email', { ascending: true });

    if (error) throw error;
    return res.status(200).json({ status: 'success', data: data || [] });
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

    if (!['admin', 'operador'].includes(role)) {
      return res.status(400).json({ status: 'error', message: 'Role inválida. Use admin ou operador.' });
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

exports.deleteAuthorizedUser = async (req, res) => {
  try {
    const { id } = req.params;

    const { error } = await supabase
      .from('authorized_users')
      .delete()
      .eq('id', id);

    if (error) throw error;

    return res.status(200).json({ status: 'success', message: 'Militar removido da lista de acesso.' });
  } catch (error) {
    console.error('ERRO DELETE AUTH USER:', error);
    return res.status(500).json({ status: 'error', message: 'Falha ao remover militar autorizado.' });
  }
};
