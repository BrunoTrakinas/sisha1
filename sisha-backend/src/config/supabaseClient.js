// SISHA1 V2 - cliente de DADOS do Supabase (server-only).
//
// H4C4: todo acesso ao schema public passa pelo backend usando a chave
// administrativa. O SUPABASE_KEY publico fica reservado ao Supabase Auth em
// supabaseAuthService.js e nao deve ser usado como data-plane do SISHA.

const { getSupabaseAdmin, getSupabaseAdminStatus } = require('./supabaseAdminClient');

const status = getSupabaseAdminStatus();

if (!status.configured) {
  const error = new Error(
    'Data-plane Supabase server-only nao configurado. Defina SUPABASE_SECRET_KEY no backend.'
  );
  error.code = 'SUPABASE_DATA_PLANE_NOT_CONFIGURED';
  throw error;
}

console.log(`[SISHA-1 DB] Data-plane Supabase server-only ativo (${status.key_type}).`);

module.exports = getSupabaseAdmin();
