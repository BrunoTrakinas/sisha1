const { verifyToken } = require('../config/authToken');
const { isGodUser } = require('../utils/auditLogger');

function extractToken(req) {
  const header = req.headers.authorization || '';
  if (!header.startsWith('Bearer ')) return null;
  return header.slice(7).trim();
}

function requireAuth(req, res, next) {
  try {
    const token = extractToken(req);
    if (!token) {
      return res.status(401).json({ status: 'error', message: 'Acesso não autorizado.' });
    }

    req.user = verifyToken(token);
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
