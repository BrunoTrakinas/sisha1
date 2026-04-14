const { verifyToken } = require('../config/authToken');

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

    if (!rolesPermitidas.includes(req.user.role)) {
      return res.status(403).json({ status: 'error', message: 'Perfil sem permissão para esta operação.' });
    }

    return next();
  };
}

module.exports = {
  requireAuth,
  requireRole,
};
