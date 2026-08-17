const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const migrationPath = path.resolve(__dirname, '../../sql/migrations/20260814_A1_1_001_aircraft_availability_evidence.sql');

function sql() {
  assert.equal(fs.existsSync(migrationPath), true, 'migration A1.1 ausente');
  return fs.readFileSync(migrationPath, 'utf8');
}

test('A1.1 migration cria histórico de snapshots e indicadores técnicos sem sobrescrever história', () => {
  const text = sql();
  assert.match(text, /create table if not exists public\.aircraft_availability_snapshots/i);
  assert.match(text, /create table if not exists public\.aircraft_maintenance_indicators/i);
  assert.match(text, /unique \(source_sha256, aircraft_code\)/i);
  assert.match(text, /source_observed_at timestamptz/i);
  assert.match(text, /TBO_HOURS_REMAINING/i);
  assert.match(text, /TBO_DUE_DATE/i);
});

test('A1.1 migration mantém data-plane server-only e RPC ACID auditada', () => {
  const text = sql();
  assert.match(text, /security definer/i);
  assert.match(text, /set search_path to 'public', 'pg_temp'/i);
  assert.match(text, /insert into public\.system_audit_logs/i);
  assert.match(text, /revoke all on table public\.aircraft_availability_snapshots from public, anon, authenticated/i);
  assert.match(text, /revoke all on function public\.sisha_import_aircraft_availability_atomic[\s\S]*from authenticated/i);
  assert.match(text, /grant execute on function public\.sisha_import_aircraft_availability_atomic[\s\S]*to service_role/i);
});

test('A1.1 migration expõe somente views atuais server-only para consumo determinístico', () => {
  const text = sql();
  assert.match(text, /v_sisha_aircraft_current_availability/i);
  assert.match(text, /v_sisha_aircraft_current_maintenance_indicators/i);
  assert.match(text, /grant select on table public\.v_sisha_aircraft_current_availability to service_role/i);
});
