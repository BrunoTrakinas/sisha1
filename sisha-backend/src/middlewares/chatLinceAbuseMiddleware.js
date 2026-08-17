const {
  acquireRatePermit,
} = require('../services/chatLinceAbuseGuardService');
function auditRateBlock(payload) {
  try {
    const { registrarAuditoria } = require('../utils/auditLogger');
    return registrarAuditoria(payload).catch(() => null);
  } catch {
    return Promise.resolve();
  }
}

function subjectFromRequest(req) {
  return String(
    req.user?.auth_user_id
    || req.user?.id
    || req.user?.email
    || req.ip
    || req.socket?.remoteAddress
    || 'unknown'
  ).trim().toLowerCase();
}

function publicProfileLabel(profileName) {
  const labels = {
    CONSULT: 'consultas do Chat Lince',
    DOCUMENT_ANALYSIS: 'análises documentais do Chat Lince',
    RAG_REINDEX: 'reindexações do Chat Lince',
    ACTION_CONFIRM: 'confirmações de ações do Chat Lince',
  };
  return labels[profileName] || 'operações do Chat Lince';
}

function createChatLinceRateGuard(profileName) {
  return function chatLinceRateGuard(req, res, next) {
    const subject = subjectFromRequest(req);
    const permit = acquireRatePermit(profileName, subject);

    if (!permit.allowed) {
      const retry = Number(permit.retryAfterSeconds || 1);
      res.setHeader('Retry-After', String(retry));

      auditRateBlock({
        req,
        action: 'CHAT_LINCE_ABUSE_GUARD_BLOCK',
        entity: 'CHAT_LINCE_RATE_LIMIT',
        entityId: profileName,
        summary: `${req.user?.email || 'Usuário'} excedeu proteção de uso em ${publicProfileLabel(profileName)}.`,
        details: {
          profile: profileName,
          code: permit.code,
          retry_after_seconds: retry,
        },
        level: 'WARN',
        visibility: 'GOD',
      });

      return res.status(429).json({
        status: 'error',
        code: `CHAT_LINCE_${permit.code}`,
        message: `Muitas ${publicProfileLabel(profileName)} em pouco tempo. Aguarde ${retry} segundo(s) e tente novamente.`,
        retry_after_seconds: retry,
      });
    }

    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      permit.release();
    };

    res.once('finish', release);
    res.once('close', release);

    return next();
  };
}

const guardChatLinceConsult = createChatLinceRateGuard('CONSULT');
const guardChatLinceDocumentAnalysis = createChatLinceRateGuard('DOCUMENT_ANALYSIS');
const guardChatLinceRagReindex = createChatLinceRateGuard('RAG_REINDEX');
const guardChatLinceActionConfirm = createChatLinceRateGuard('ACTION_CONFIRM');

module.exports = {
  subjectFromRequest,
  createChatLinceRateGuard,
  guardChatLinceConsult,
  guardChatLinceDocumentAnalysis,
  guardChatLinceRagReindex,
  guardChatLinceActionConfirm,
};
