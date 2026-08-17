const { createClient } = require('@supabase/supabase-js');
const path = require('path');
const dotenv = require('dotenv');

const envPath = path.join(__dirname, '..', '..', '.env');
dotenv.config({ path: envPath });

const supabaseUrl = String(process.env.SUPABASE_URL || '').trim();
const secretKey = String(
  process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || ''
).trim();

let adminClient = null;

function configured() {
  return Boolean(supabaseUrl && secretKey);
}

function keyType() {
  if (!secretKey) return 'MISSING';
  if (secretKey.startsWith('sb_secret_')) return 'SUPABASE_SECRET_KEY';
  const parts = secretKey.split('.');
  if (parts.length === 3) {
    try {
      const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
      if (payload?.role === 'service_role') return 'LEGACY_SERVICE_ROLE';
      if (payload?.role) return `JWT_${String(payload.role).toUpperCase()}`;
    } catch (_) {
      // Mantém UNKNOWN abaixo.
    }
  }
  return 'UNKNOWN_SERVER_KEY';
}

function getSupabaseAdmin() {
  if (!configured()) {
    const error = new Error(
      'Cliente administrativo do Supabase não configurado. Defina SUPABASE_SECRET_KEY no backend (recomendado) ou SUPABASE_SERVICE_ROLE_KEY legado.'
    );
    error.code = 'SUPABASE_ADMIN_NOT_CONFIGURED';
    throw error;
  }

  if (!adminClient) {
    adminClient = createClient(supabaseUrl, secretKey, {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
        detectSessionInUrl: false,
      },
    });
  }
  return adminClient;
}

function getSupabaseAdminStatus() {
  return {
    configured: configured(),
    key_type: keyType(),
    ready: false,
  };
}

async function checkSupabaseAdminReadiness() {
  const base = getSupabaseAdminStatus();
  if (!base.configured) {
    return {
      ...base,
      message: 'Chave administrativa do Supabase ausente no backend.',
    };
  }

  try {
    const client = getSupabaseAdmin();
    // Prova read-only de privilégio administrativo. Não cria usuário e não muta banco.
    const { error } = await client.auth.admin.listUsers({ page: 1, perPage: 1 });
    if (error) {
      return {
        ...base,
        ready: false,
        message: `Chave administrativa presente, mas não validada como acesso privilegiado: ${error.message}`,
      };
    }
    return {
      ...base,
      ready: true,
      message: 'Cliente administrativo Supabase validado no backend; RLS permanecerá ativo para os demais clientes.',
    };
  } catch (error) {
    return {
      ...base,
      ready: false,
      message: error.message || 'Falha ao validar cliente administrativo do Supabase.',
    };
  }
}

module.exports = {
  getSupabaseAdmin,
  getSupabaseAdminStatus,
  checkSupabaseAdminReadiness,
};
