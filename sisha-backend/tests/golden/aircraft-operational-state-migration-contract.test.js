const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const migration = fs.readFileSync(path.join(__dirname, '../../sql/migrations/20260814_A1_1A_001_aircraft_operational_state_confirmation.sql'), 'utf8');
const routes = fs.readFileSync(path.join(__dirname, '../../src/routes/needsRoutes.js'), 'utf8');

test('A1.1A migration preserva confirmação append-only com cópia da evidência bruta', () => {
  assert.match(migration, /create table if not exists public\.aircraft_operational_state_confirmations/i);
  assert.match(migration, /source_snapshot_id/i);
  assert.match(migration, /raw_status/i);
  assert.match(migration, /source_document/i);
  assert.match(migration, /confirmed_by/i);
  assert.match(migration, /confirmation_reason/i);
  assert.doesNotMatch(migration, /update\s+public\.aircraft_operational_state_confirmations/i);
  assert.doesNotMatch(migration, /delete\s+from\s+public\.aircraft_operational_state_confirmations/i);
});

test('A1.1A mutation é server-only, auditada e restrita a Admin/Dono', () => {
  assert.match(migration, /security definer/i);
  assert.match(migration, /v_role not in \('admin', 'dono'\)/i);
  assert.match(migration, /CONFIRM_AIRCRAFT_OPERATIONAL_STATE/i);
  assert.match(migration, /revoke all on function public\.sisha_confirm_aircraft_operational_state_atomic/i);
  assert.match(migration, /grant execute .* to service_role/i);
  assert.match(routes, /put\('\/aircraft-operational-state\/:aircraft', adminOnly/i);
});

test('A1.1A view separa evidência bruta de confirmação administrativa', () => {
  assert.match(migration, /v_sisha_aircraft_effective_operational_state/i);
  assert.match(migration, /raw_status/i);
  assert.match(migration, /admin_operational_state/i);
  assert.match(migration, /mt_additive_eligible/i);
  assert.match(migration, /flight_projection_enabled/i);
});
