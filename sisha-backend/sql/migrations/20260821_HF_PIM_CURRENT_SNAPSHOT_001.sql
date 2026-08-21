-- SISHA1 V2 — HF PIM atual: snapshot identificado, histórico preservado e server-only
-- Data: 2026-08-21
-- Regra: novo arquivo PIM substitui somente o snapshot de arquivo anterior.
-- Registros manuais continuam ativos. Nenhuma linha histórica é apagada.

begin;

do $check$
begin
  if to_regclass('public.sisha_schema_migrations') is null then
    raise exception 'PIM snapshot: ledger de migrations ausente.';
  end if;
  if to_regclass('public.pim_demandas') is null then
    raise exception 'PIM snapshot: tabela public.pim_demandas ausente.';
  end if;
end
$check$;

alter table public.pim_demandas
  add column if not exists ativo boolean not null default true,
  add column if not exists origem_importacao text not null default 'LEGADO',
  add column if not exists source_file_name text,
  add column if not exists source_file_sha256 text,
  add column if not exists source_imported_at timestamptz,
  add column if not exists source_sheet text,
  add column if not exists source_row integer,
  add column if not exists source_payload jsonb not null default '{}'::jsonb;

create index if not exists idx_pim_demandas_ativo
  on public.pim_demandas (ativo, data_solicitacao desc, pim);
create index if not exists idx_pim_demandas_source_sha
  on public.pim_demandas (source_file_sha256, source_sheet, source_row)
  where source_file_sha256 is not null;

create or replace function public.sisha_replace_pim_snapshot_atomic(
  p_rows jsonb,
  p_source_file_name text,
  p_source_file_sha256 text,
  p_actor_email text,
  p_actor_role text
)
returns jsonb
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_row jsonb;
  v_inserted integer := 0;
  v_deactivated integer := 0;
  v_email text := lower(btrim(coalesce(p_actor_email, '')));
  v_role text := lower(btrim(coalesce(p_actor_role, '')));
  v_file text := nullif(btrim(coalesce(p_source_file_name, '')), '');
  v_sha text := lower(btrim(coalesce(p_source_file_sha256, '')));
begin
  if v_role not in ('admin', 'dono') then
    raise exception 'PIM snapshot: somente Admin/Dono pode substituir a fotografia atual.';
  end if;
  if v_email = '' then raise exception 'PIM snapshot: usuário autenticado obrigatório.'; end if;
  if v_file is null then raise exception 'PIM snapshot: nome do arquivo obrigatório.'; end if;
  if v_sha !~ '^[0-9a-f]{64}$' then raise exception 'PIM snapshot: SHA-256 inválido.'; end if;
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) = 0 then
    raise exception 'PIM snapshot: nenhuma linha válida para aplicar.';
  end if;

  -- Lock lógico do conjunto corrente. Somente snapshot de ARQUIVO_PIM é substituído.
  perform pg_advisory_xact_lock(hashtext('SISHA:PIM_CURRENT_SNAPSHOT'));

  update public.pim_demandas
     set ativo = false,
         updated_at = now()
   where coalesce(ativo, true) = true
     and origem_importacao = 'ARQUIVO_PIM';
  get diagnostics v_deactivated = row_count;

  for v_row in select value from jsonb_array_elements(p_rows)
  loop
    insert into public.pim_demandas (
      pim,
      data_solicitacao,
      pn,
      nsn,
      quantidade,
      os_vinculada,
      observacoes,
      origem_tipo,
      origem_codigo,
      origem_descricao,
      fator_multiplicador,
      ativo,
      origem_importacao,
      source_file_name,
      source_file_sha256,
      source_imported_at,
      source_sheet,
      source_row,
      source_payload,
      updated_at
    ) values (
      nullif(btrim(coalesce(v_row->>'pim', '')), ''),
      nullif(v_row->>'data_solicitacao', '')::date,
      nullif(btrim(coalesce(v_row->>'pn', '')), ''),
      nullif(btrim(coalesce(v_row->>'nsn', '')), ''),
      nullif(v_row->>'quantidade', '')::numeric,
      nullif(btrim(coalesce(v_row->>'os_vinculada', '')), ''),
      nullif(btrim(coalesce(v_row->>'observacoes', '')), ''),
      nullif(btrim(coalesce(v_row->>'origem_tipo', '')), ''),
      nullif(btrim(coalesce(v_row->>'origem_codigo', '')), ''),
      nullif(btrim(coalesce(v_row->>'origem_descricao', '')), ''),
      1,
      true,
      'ARQUIVO_PIM',
      v_file,
      v_sha,
      now(),
      nullif(btrim(coalesce(v_row->>'source_sheet', '')), ''),
      nullif(v_row->>'source_row', '')::integer,
      coalesce(v_row->'source_payload', '{}'::jsonb),
      now()
    );
    v_inserted := v_inserted + 1;
  end loop;

  return jsonb_build_object(
    'inserted', v_inserted,
    'previous_file_rows_deactivated', v_deactivated,
    'source_file_name', v_file,
    'source_file_sha256', v_sha,
    'applied_at', now()
  );
end;
$function$;

revoke all on function public.sisha_replace_pim_snapshot_atomic(jsonb, text, text, text, text)
  from public, anon, authenticated;
grant execute on function public.sisha_replace_pim_snapshot_atomic(jsonb, text, text, text, text)
  to service_role;

insert into public.sisha_schema_migrations(version, description)
values (
  '20260821_HF_PIM_CURRENT_SNAPSHOT_001',
  'PIM passa a ter snapshot de arquivo atual identificado por data/SHA-256, preservando histórico e registros manuais.'
)
on conflict (version) do nothing;

commit;
