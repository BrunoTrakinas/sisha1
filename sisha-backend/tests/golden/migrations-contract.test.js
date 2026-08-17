const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const migrationsDir = path.resolve(__dirname, '../../sql/migrations');

function migration(name) {
  const file = path.join(migrationsDir, name);
  assert.equal(fs.existsSync(file), true, `migration ausente: ${name}`);
  return fs.readFileSync(file, 'utf8');
}

test('GOLDEN schema: historico H4 permanente permanece versionado', () => {
  const expected = [
    '20260813_H4B_001_equipment_core_acid.sql',
    '20260813_H4B_002_version_existing_inventory_rpc.sql',
    '20260813_H4C0_001_rpc_dashboard_stats_live_baseline.sql',
    '20260813_H4C1_001_server_only_auth_audit.sql',
    '20260813_H4C2_001_equipment_mutation_rpcs_server_only.sql',
    '20260813_H4C2HF1_001_inventory_date_precision.sql',
    '20260813_H4C3_001_dashboard_rpc_server_only.sql',
    '20260813_H4C4_001_public_data_plane_server_only.sql',
    '20260813_H4C5_001_auth_identity_binding.sql',
    '20260813_H4C6_001_supabase_auth_only.sql',
    '20260813_H4D_001_auth_integrity_runtime_gate.sql',
  ];

  for (const name of expected) migration(name);
});

test('GOLDEN H4C2: RPCs mutaveis continuam service_role only', () => {
  const sql = migration('20260813_H4C2_001_equipment_mutation_rpcs_server_only.sql');
  assert.match(sql, /revoke all on function[\s\S]*from anon/i);
  assert.match(sql, /revoke all on function[\s\S]*from authenticated/i);
  assert.match(sql, /grant execute on function[\s\S]*to service_role/i);
});

test('GOLDEN H4C4: data-plane public permanece fechado', () => {
  const sql = migration('20260813_H4C4_001_public_data_plane_server_only.sql');
  assert.match(sql, /revoke all privileges on all tables in schema public from anon/i);
  assert.match(sql, /revoke all privileges on all tables in schema public from authenticated/i);
  assert.match(sql, /grant all privileges on all tables in schema public to service_role/i);
});

test('GOLDEN H4C6: coluna de senha local e removida pela migration', () => {
  const sql = migration('20260813_H4C6_001_supabase_auth_only.sql');
  assert.match(sql, /drop column[\s\S]*senha/i);
});

test('GOLDEN H4D: ultimo Dono e integridade do UUID Auth permanecem protegidos', () => {
  const sql = migration('20260813_H4D_001_auth_integrity_runtime_gate.sql');
  assert.match(sql, /authorized_users_auth_user_id_fkey/);
  assert.match(sql, /SISHA_LAST_DONO_GUARD/);
  assert.match(sql, /SISHA_AUTH_BINDING_EMAIL_MISMATCH/);
  assert.match(sql, /trg_sisha_authorized_user_auth_integrity/);
});
