'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const base=path.resolve(__dirname,'../../sql');
const migration=fs.readFileSync(path.join(base,'migrations/20261126_R5_001_ppu_inventory_history.sql'),'utf8');
const preflight=fs.readFileSync(path.join(base,'audits/R5_ppu_inventory_history_precheck.sql'),'utf8');

test('R5 migration is transactional and does not activate the import flow',()=>{
  assert.match(migration,/^begin;/m);assert.match(migration,/^commit;/m);
  assert.doesNotMatch(migration,/\b(?:insert\s+into|update|delete\s+from|truncate(?:\s+table)?)\s+public\.(?:estoque_ppu|recebimento_itens|recebimentos|equipamentos_serializados|recebimento_eventos|equipamento_eventos)\b/i);
  assert.doesNotMatch(migration,/select\s+public\.sisha_capture_ppu_legacy_baseline\s*\(/i);
});
test('R5 history chain is independent, unique and append-only',()=>{
  assert.match(migration,/previous_snapshot_id uuid unique references public\.ppu_inventario_snapshots\(id\) on delete restrict/);
  assert.match(migration,/source_file_sha256 text unique/);
  assert.match(migration,/where snapshot_type = 'BASELINE_LEGADO'/);
  assert.match(migration,/before update or delete or truncate/);
  assert.match(migration,/grant select, insert on table public\.ppu_inventario_snapshots to service_role/);
  assert.doesNotMatch(migration,/grant[^;]*(?:update|delete|truncate)[^;]*on table public\.ppu_inventario_snapshots/i);
});
test('R5 history uses existing policies and exact stock payload without dropping serials or zero rows',()=>{
  assert.match(migration,/jsonb_agg\(to_jsonb\(p\) order by p\.id\), count\(\*\)::integer/);
  assert.match(migration,/from public\.estoque_ppu p;/);
  assert.match(migration,/from public\.ppu_localizacoes_config p;/);
  assert.match(migration,/jsonb_array_length\(rows_payload\) = row_count/);
  assert.match(migration,/jsonb_array_length\(policies_payload\) = policy_count/);
  assert.match(migration,/rows_sha256 = encode\(pg_catalog\.sha256/);
  assert.match(migration,/policies_sha256 = encode\(pg_catalog\.sha256/);
});
test('R5 legacy capture requires two audited hashes and does not invent dates',()=>{
  assert.match(migration,/p_expected_rows_sha256 is null/);
  assert.match(migration,/p_expected_policies_sha256 is null/);
  assert.match(migration,/v_rows_sha256 <> p_expected_rows_sha256 or v_policies_sha256 <> p_expected_policies_sha256/);
  assert.match(migration,/and source_file_name is null and source_file_sha256 is null and observed_on is null/);
  assert.match(migration,/BASELINE_REUSED/);
  assert.match(migration,/pg_advisory_xact_lock\(hashtext\('sisha_ppu_inventory_reconciliation'\)::bigint\)/);
  assert.match(migration,/lock table public\.estoque_ppu, public\.ppu_localizacoes_config in share mode/);
});
test('R5 access is restricted to backend, no security definer',()=>{
  assert.match(migration,/enable row level security/);
  assert.match(migration,/revoke all on table public\.ppu_inventario_snapshots from public, anon, authenticated, service_role/);
  assert.doesNotMatch(migration,/security definer/i);
  for(const f of ['sisha_capture_ppu_legacy_baseline\\(text,text\\)','sisha_ppu_snapshot_diff\\(uuid,uuid\\)']){
    assert.match(migration,new RegExp('revoke all on function public\\.'+f+' from public, anon, authenticated, service_role'));
    assert.match(migration,new RegExp('grant execute on function public\\.'+f+' to service_role'));
  }
});
test('R5 diff uses PN + location, full outer join, policy provenance and missing-snapshot protection',()=>{
  assert.match(migration,/full join b on a\.p=b\.p and a\.l=b\.l/);
  assert.match(migration,/c\.qb-c\.qa/);
  assert.match(migration,/pa\.allowed,pb\.allowed/);
  assert.match(migration,/Snapshot anterior não encontrado/);
  assert.match(migration,/Snapshot posterior não encontrado/);
});
test('R5 preflight only returns counts and fingerprints and reads the exact same sources',()=>{
  assert.match(preflight,/jsonb_agg\(to_jsonb\(p\) order by p\.id\)/);
  assert.match(preflight,/from public\.estoque_ppu p/);
  assert.match(preflight,/from public\.ppu_localizacoes_config p/);
  assert.doesNotMatch(preflight,/\b(?:insert|update|delete|truncate|alter|create|drop)\b/i);
});
