function normalize(value = '') {
  return String(value || '').trim();
}

function isTruthy(value = '') {
  return ['1', 'true', 'yes', 'on'].includes(normalize(value).toLowerCase());
}

function parseOrigins(value = '') {
  return normalize(value)
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function validateRuntimeReadiness(env = process.env) {
  const isProduction = normalize(env.NODE_ENV).toLowerCase() === 'production';
  const blockers = [];
  const warnings = [];

  const required = [
    'SUPABASE_URL',
    'SUPABASE_KEY',
    'SUPABASE_SECRET_KEY',
  ];

  for (const key of required) {
    if (!normalize(env[key])) blockers.push(`${key} nao configurado.`);
  }

  if (!isTruthy(env.SISHA_H4B_ACID_EQUIPMENT_ENABLED)) {
    const message = 'SISHA_H4B_ACID_EQUIPMENT_ENABLED deve permanecer true apos homologacao do H4B.';
    if (isProduction) blockers.push(message);
    else warnings.push(message);
  }

  const corsOrigins = parseOrigins(env.CORS_ORIGINS);
  if (isProduction) {
    if (corsOrigins.length === 0) {
      blockers.push('CORS_ORIGINS obrigatorio em producao.');
    }

    for (const origin of corsOrigins) {
      if (origin === '*') {
        blockers.push('CORS_ORIGINS nao pode conter wildcard (*) em producao.');
        continue;
      }
      if (!/^https:\/\//i.test(origin)) {
        blockers.push(`Origem CORS insegura em producao: ${origin}`);
      }
      if (/localhost|127\.0\.0\.1/i.test(origin)) {
        blockers.push(`Origem local nao permitida em producao: ${origin}`);
      }
    }

    const frontendUrl = normalize(env.AUTH_FRONTEND_URL);
    if (!frontendUrl) {
      blockers.push('AUTH_FRONTEND_URL obrigatorio em producao.');
    } else if (!/^https:\/\//i.test(frontendUrl)) {
      blockers.push('AUTH_FRONTEND_URL deve usar HTTPS em producao.');
    }
  } else {
    if (corsOrigins.length === 0) {
      warnings.push('CORS_ORIGINS vazio: permitido somente em desenvolvimento.');
    }
  }

  if (normalize(env.SISHA_AUTH_MODE)) {
    warnings.push('SISHA_AUTH_MODE e obsoleto desde H4C6 e pode ser removido do ambiente.');
  }
  if (normalize(env.APP_AUTH_SECRET)) {
    warnings.push('APP_AUTH_SECRET e obsoleto desde H4C6 e deve ser removido do ambiente.');
  }

  return {
    ok: blockers.length === 0,
    mode: isProduction ? 'production' : 'development',
    blockers,
    warnings,
  };
}

function assertRuntimeReadiness(env = process.env) {
  const result = validateRuntimeReadiness(env);

  for (const warning of result.warnings) {
    console.warn(`[SISHA][runtime] WARN: ${warning}`);
  }

  if (!result.ok) {
    const error = new Error(
      `SISHA runtime bloqueado por configuracao insegura: ${result.blockers.join(' | ')}`
    );
    error.code = 'SISHA_RUNTIME_NOT_READY';
    error.readiness = result;
    throw error;
  }

  console.log(`[SISHA][runtime] Readiness OK (${result.mode}).`);
  return result;
}

module.exports = {
  validateRuntimeReadiness,
  assertRuntimeReadiness,
};
