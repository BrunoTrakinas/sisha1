-- SISHA1 V2 — H4C2
-- RPCs mutaveis de Equipamentos: EXECUTE somente pelo backend service_role.
-- Nao altera tabelas, dados, UI/UX, regras logisticas ou a coluna legada senha.

begin;

create table if not exists public.sisha_schema_migrations (
  version text primary key,
  description text not null,
  applied_at timestamptz not null default now()
);

-- Guard fail-closed: nao aceitamos registrar hardening parcial.
do $guard$
begin
  if to_regprocedure('public.sisha_apply_equipment_inventory_import(text,date,text,text,text,jsonb)') is null then
    raise exception 'H4C2: RPC sisha_apply_equipment_inventory_import nao encontrada.';
  end if;
  if to_regprocedure('public.sisha_insert_equipment_event_atomic(bigint,jsonb,text)') is null then
    raise exception 'H4C2: RPC sisha_insert_equipment_event_atomic nao encontrada.';
  end if;
  if to_regprocedure('public.sisha_create_equipment_atomic(jsonb,jsonb,text)') is null then
    raise exception 'H4C2: RPC sisha_create_equipment_atomic nao encontrada.';
  end if;
  if to_regprocedure('public.sisha_update_equipment_atomic(bigint,jsonb,jsonb,text)') is null then
    raise exception 'H4C2: RPC sisha_update_equipment_atomic nao encontrada.';
  end if;
  if to_regprocedure('public.sisha_resolve_location_conflict_atomic(bigint,bigint,jsonb,text,text,text)') is null then
    raise exception 'H4C2: RPC sisha_resolve_location_conflict_atomic nao encontrada.';
  end if;
end;
$guard$;

-- SECURITY DEFINER de importacao: remove o EXECUTE padrao herdado por PUBLIC.
revoke all on function public.sisha_apply_equipment_inventory_import(text, date, text, text, text, jsonb) from public;
revoke all on function public.sisha_apply_equipment_inventory_import(text, date, text, text, text, jsonb) from anon;
revoke all on function public.sisha_apply_equipment_inventory_import(text, date, text, text, text, jsonb) from authenticated;
grant execute on function public.sisha_apply_equipment_inventory_import(text, date, text, text, text, jsonb) to service_role;

-- Reafirma de forma idempotente a cerca eletrica das RPCs ACID H4B.
revoke all on function public.sisha_insert_equipment_event_atomic(bigint, jsonb, text) from public;
revoke all on function public.sisha_insert_equipment_event_atomic(bigint, jsonb, text) from anon;
revoke all on function public.sisha_insert_equipment_event_atomic(bigint, jsonb, text) from authenticated;
grant execute on function public.sisha_insert_equipment_event_atomic(bigint, jsonb, text) to service_role;

revoke all on function public.sisha_create_equipment_atomic(jsonb, jsonb, text) from public;
revoke all on function public.sisha_create_equipment_atomic(jsonb, jsonb, text) from anon;
revoke all on function public.sisha_create_equipment_atomic(jsonb, jsonb, text) from authenticated;
grant execute on function public.sisha_create_equipment_atomic(jsonb, jsonb, text) to service_role;

revoke all on function public.sisha_update_equipment_atomic(bigint, jsonb, jsonb, text) from public;
revoke all on function public.sisha_update_equipment_atomic(bigint, jsonb, jsonb, text) from anon;
revoke all on function public.sisha_update_equipment_atomic(bigint, jsonb, jsonb, text) from authenticated;
grant execute on function public.sisha_update_equipment_atomic(bigint, jsonb, jsonb, text) to service_role;

revoke all on function public.sisha_resolve_location_conflict_atomic(bigint, bigint, jsonb, text, text, text) from public;
revoke all on function public.sisha_resolve_location_conflict_atomic(bigint, bigint, jsonb, text, text, text) from anon;
revoke all on function public.sisha_resolve_location_conflict_atomic(bigint, bigint, jsonb, text, text, text) from authenticated;
grant execute on function public.sisha_resolve_location_conflict_atomic(bigint, bigint, jsonb, text, text, text) to service_role;

-- Verificacao dentro da propria transacao. Se qualquer RPC continuar publica,
-- nada desta migration e confirmado.
do $verify$
declare
  v_signature text;
  v_role text;
  v_rpc text;
  v_rpcs text[] := array[
    'public.sisha_apply_equipment_inventory_import(text,date,text,text,text,jsonb)',
    'public.sisha_insert_equipment_event_atomic(bigint,jsonb,text)',
    'public.sisha_create_equipment_atomic(jsonb,jsonb,text)',
    'public.sisha_update_equipment_atomic(bigint,jsonb,jsonb,text)',
    'public.sisha_resolve_location_conflict_atomic(bigint,bigint,jsonb,text,text,text)'
  ];
begin
  foreach v_rpc in array v_rpcs loop
    v_signature := v_rpc;

    foreach v_role in array array['anon','authenticated'] loop
      if has_function_privilege(v_role, v_signature, 'EXECUTE') then
        raise exception 'H4C2: % ainda possui EXECUTE para %.', v_signature, v_role;
      end if;
    end loop;
    if not has_function_privilege('service_role', v_signature, 'EXECUTE') then
      raise exception 'H4C2: service_role perdeu EXECUTE em %.', v_signature;
    end if;
  end loop;
end;
$verify$;

insert into public.sisha_schema_migrations(version, description)
values (
  '20260813_H4C2_001',
  'H4C2: RPCs mutaveis do Livro de Equipamentos restritas ao backend service_role.'
)
on conflict (version) do update
set description = excluded.description;

commit;
