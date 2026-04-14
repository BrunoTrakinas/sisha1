const crypto = require('crypto');

const SECRET = process.env.APP_AUTH_SECRET || 'SISHA1_DEV_SECRET_CHANGE_ME';
const EXPIRES_IN_SECONDS = 60 * 60 * 12;

function base64url(input) {
  return Buffer.from(input)
    .toString('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

function sign(data) {
  return crypto
    .createHmac('sha256', SECRET)
    .update(data)
    .digest('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

function createToken(user) {
  const header = { alg: 'HS256', typ: 'JWT' };
  const payload = {
    sub: user.id,
    email: user.email,
    role: user.role,
    exp: Math.floor(Date.now() / 1000) + EXPIRES_IN_SECONDS,
  };

  const encodedHeader = base64url(JSON.stringify(header));
  const encodedPayload = base64url(JSON.stringify(payload));
  const signature = sign(`${encodedHeader}.${encodedPayload}`);

  return `${encodedHeader}.${encodedPayload}.${signature}`;
}

function verifyToken(token) {
  if (!token || token.split('.').length !== 3) {
    throw new Error('Token inválido.');
  }

  const [encodedHeader, encodedPayload, signature] = token.split('.');
  const expectedSignature = sign(`${encodedHeader}.${encodedPayload}`);

  if (signature !== expectedSignature) {
    throw new Error('Assinatura inválida.');
  }

  const payload = JSON.parse(Buffer.from(encodedPayload, 'base64').toString('utf8'));

  if (!payload.exp || payload.exp < Math.floor(Date.now() / 1000)) {
    throw new Error('Sessão expirada.');
  }

  return payload;
}

module.exports = {
  createToken,
  verifyToken,
};
