#!/usr/bin/env bash
set -euo pipefail
[[ "$PGDATABASE" == sisha_r6_fixture ]] || exit 91
p=(psql -X -v ON_ERROR_STOP=1 -At)
token="$("${p[@]}" -c "set role service_role; select public.sisha_ppu_r6_context()->>'token'" | tail -n1)"
[[ "$token" =~ ^[a-f0-9]{64}$ ]]
# Separate physical sessions; second transaction must not use the first context after commit.
dir="$(mktemp -d)"
trap 'rm -rf "$dir"' EXIT
(
 "${p[@]}" <<SQL
begin;
set role service_role;
select public.sisha_ppu_r6_apply('$token',repeat('c',64),'fixture-4.ods','00000000-0000-4000-8000-000000000004','2025-03-01',null,null,true,'[{"pn":"FIXTURE-PN","localizacao":"A-1","quantidade":3}]','[{"itemId":1,"receiptId":1,"pn":"FIXTURE-PN","quantity":1,"before":1,"after":2,"method":"FIFO","location":"A-1"}]','fixture@example.invalid');
select pg_sleep(3);
commit;
SQL
) >"$dir/first" 2>&1 &
first=$!
# Poll the advisory lock in the first session, not an arbitrary delay.
locked=0
for i in $(seq 1 30); do
 if [[ "$("${p[@]}" -c "select count(*) from pg_locks where locktype='advisory' and granted")" != 0 ]]; then locked=1; break; fi
 sleep .1
done
[[ "$locked" == 1 ]]
set +e
"${p[@]}" -c "set role service_role; select public.sisha_ppu_r6_apply('$token',repeat('d',64),'fixture-5.ods','00000000-0000-4000-8000-000000000005','2025-04-01',null,null,true,'[{\"pn\":\"FIXTURE-PN\",\"localizacao\":\"A-1\",\"quantidade\":4}]','[]','fixture@example.invalid')" >"$dir/second" 2>&1
rc=$?
set -e
wait "$first"
cat "$dir/first" "$dir/second"
[[ "$rc" != 0 ]]
grep -q 'contexto mudou' "$dir/second"
[[ "$("${p[@]}" -c "select quantidade_inventariada from public.recebimento_itens where id=1")" == 2 ]]
[[ "$("${p[@]}" -c "select count(*) from public.ppu_inventario_snapshots")" == 3 ]]
[[ "$("${p[@]}" -c "select count(*) from public.recebimento_eventos")" == 2 ]]
echo 'R6B PASS concurrent stale context rejected'
