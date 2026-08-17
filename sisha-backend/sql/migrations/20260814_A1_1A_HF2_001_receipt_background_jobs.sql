-- SISHA1 V2 — A1.1A HF2 — IMPORTAÇÃO DURÁVEL DE RECIBOS EM SEGUNDO PLANO
-- Staging técnico persistente. Nenhum recibo operacional é salvo sem revisão Admin/Dono.

begin;

create table if not exists public.receipt_import_jobs (
  id uuid primary key default gen_random_uuid(),
  archive_name text not null,
  archive_sha256 text,
  storage_bucket text not null,
  storage_key text not null,
  storage_mode text not null default 'ARCHIVE' check (storage_mode in ('ARCHIVE','MULTI_OBJECT')),
  status text not null default 'QUEUED' check (status in ('QUEUED','PROCESSING','REVIEW_READY','FAILED','CANCELLED')),
  total_items integer not null default 0 check (total_items >= 0),
  processed_items integer not null default 0 check (processed_items >= 0),
  ready_items integer not null default 0 check (ready_items >= 0),
  review_items integer not null default 0 check (review_items >= 0),
  conflict_items integer not null default 0 check (conflict_items >= 0),
  duplicate_items integer not null default 0 check (duplicate_items >= 0),
  error_items integer not null default 0 check (error_items >= 0),
  saved_items integer not null default 0 check (saved_items >= 0),
  ignored_items integer not null default 0 check (ignored_items >= 0),
  created_by_auth_user_id uuid,
  created_by_email text not null,
  created_by_role text not null check (lower(created_by_role) in ('admin','dono')),
  request_id text,
  error_message text,
  created_at timestamptz not null default now(),
  started_at timestamptz,
  completed_at timestamptz,
  last_heartbeat_at timestamptz
);

create table if not exists public.receipt_import_job_items (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references public.receipt_import_jobs(id) on delete cascade,
  sequence_no integer not null check (sequence_no > 0),
  file_name text not null,
  file_sha256 text,
  mime_type text,
  size_bytes bigint not null default 0 check (size_bytes >= 0),
  storage_key text not null,
  archive_entry_name text,
  status text not null default 'PENDING' check (status in ('PENDING','PROCESSING','READY','REVIEW','CONFLICT','DUPLICATE','ERROR','SAVED','IGNORED')),
  attempt_count integer not null default 0 check (attempt_count >= 0),
  claim_token uuid,
  claimed_by text,
  claimed_at timestamptz,
  lease_until timestamptz,
  processed_at timestamptz,
  source_method text,
  receipt_number text,
  receipt_type text,
  item_count integer not null default 0 check (item_count >= 0),
  warnings jsonb not null default '[]'::jsonb,
  diagnostic text,
  triage_payload jsonb,
  analysis_version text,
  reused_analysis boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(job_id, sequence_no)
);

create table if not exists public.receipt_import_analysis_cache (
  file_sha256 text primary key,
  analysis_version text not null,
  source_method text not null,
  triage_payload jsonb not null,
  receipt_number text,
  receipt_type text,
  item_count integer not null default 0,
  warnings jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_receipt_import_jobs_status_created
  on public.receipt_import_jobs(status, created_at);
create index if not exists idx_receipt_import_items_claim
  on public.receipt_import_job_items(status, lease_until, job_id, sequence_no);
create index if not exists idx_receipt_import_items_hash
  on public.receipt_import_job_items(file_sha256);
create index if not exists idx_receipt_import_items_receipt_number
  on public.receipt_import_job_items(receipt_number);

alter table public.receipt_import_jobs enable row level security;
alter table public.receipt_import_job_items enable row level security;
alter table public.receipt_import_analysis_cache enable row level security;

create or replace function public.sisha_refresh_receipt_import_job(p_job_id uuid)
returns void
language plpgsql
security definer
set search_path to 'public','pg_temp'
as $function$
declare
  v_total integer;
  v_processed integer;
  v_ready integer;
  v_review integer;
  v_conflict integer;
  v_duplicate integer;
  v_error integer;
  v_saved integer;
  v_ignored integer;
  v_processing integer;
begin
  select
    count(*),
    count(*) filter (where status in ('READY','REVIEW','CONFLICT','DUPLICATE','ERROR','SAVED','IGNORED')),
    count(*) filter (where status = 'READY'),
    count(*) filter (where status = 'REVIEW'),
    count(*) filter (where status = 'CONFLICT'),
    count(*) filter (where status = 'DUPLICATE'),
    count(*) filter (where status = 'ERROR'),
    count(*) filter (where status = 'SAVED'),
    count(*) filter (where status = 'IGNORED'),
    count(*) filter (where status = 'PROCESSING')
  into v_total, v_processed, v_ready, v_review, v_conflict, v_duplicate, v_error, v_saved, v_ignored, v_processing
  from public.receipt_import_job_items
  where job_id = p_job_id;

  update public.receipt_import_jobs
  set
    total_items = coalesce(v_total,0),
    processed_items = coalesce(v_processed,0),
    ready_items = coalesce(v_ready,0),
    review_items = coalesce(v_review,0),
    conflict_items = coalesce(v_conflict,0),
    duplicate_items = coalesce(v_duplicate,0),
    error_items = coalesce(v_error,0),
    saved_items = coalesce(v_saved,0),
    ignored_items = coalesce(v_ignored,0),
    last_heartbeat_at = case when coalesce(v_processing,0) > 0 then now() else last_heartbeat_at end,
    status = case
      when status in ('FAILED','CANCELLED') then status
      when coalesce(v_total,0) > 0 and coalesce(v_processed,0) = coalesce(v_total,0) then 'REVIEW_READY'
      when coalesce(v_processing,0) > 0 or coalesce(v_processed,0) > 0 then 'PROCESSING'
      else 'QUEUED'
    end,
    completed_at = case
      when coalesce(v_total,0) > 0 and coalesce(v_processed,0) = coalesce(v_total,0) then coalesce(completed_at, now())
      else null
    end
  where id = p_job_id;
end;
$function$;

create or replace function public.sisha_receipt_import_item_refresh_job()
returns trigger
language plpgsql
security definer
set search_path to 'public','pg_temp'
as $function$
begin
  perform public.sisha_refresh_receipt_import_job(coalesce(new.job_id, old.job_id));
  return coalesce(new, old);
end;
$function$;

drop trigger if exists trg_receipt_import_item_refresh_job on public.receipt_import_job_items;
create trigger trg_receipt_import_item_refresh_job
after insert or update or delete on public.receipt_import_job_items
for each row execute function public.sisha_receipt_import_item_refresh_job();

create or replace function public.sisha_create_receipt_import_job_atomic(
  p_archive_name text,
  p_archive_sha256 text,
  p_storage_bucket text,
  p_storage_key text,
  p_storage_mode text,
  p_items jsonb,
  p_actor_auth_user_id uuid,
  p_actor_email text,
  p_actor_role text,
  p_request_id text default null
)
returns uuid
language plpgsql
security definer
set search_path to 'public','pg_temp'
as $function$
declare
  v_job_id uuid;
  v_role text := lower(btrim(coalesce(p_actor_role,'')));
  v_email text := lower(btrim(coalesce(p_actor_email,'')));
  v_item jsonb;
  v_seq integer := 0;
begin
  if v_role not in ('admin','dono') then
    raise exception 'HF2: somente Admin/Dono pode criar lote de recibos.';
  end if;
  if v_email = '' then
    raise exception 'HF2: ator autenticado obrigatório.';
  end if;
  if jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'HF2: lote sem itens.';
  end if;
  if jsonb_array_length(p_items) > 150 then
    raise exception 'HF2: limite de 150 documentos por lote.';
  end if;

  insert into public.receipt_import_jobs(
    archive_name, archive_sha256, storage_bucket, storage_key, storage_mode,
    created_by_auth_user_id, created_by_email, created_by_role, request_id
  ) values (
    btrim(p_archive_name), nullif(btrim(coalesce(p_archive_sha256,'')),''),
    btrim(p_storage_bucket), btrim(p_storage_key), upper(btrim(coalesce(p_storage_mode,'ARCHIVE'))),
    p_actor_auth_user_id, v_email, v_role, nullif(btrim(coalesce(p_request_id,'')),'')
  ) returning id into v_job_id;

  for v_item in select * from jsonb_array_elements(p_items)
  loop
    v_seq := v_seq + 1;
    insert into public.receipt_import_job_items(
      job_id, sequence_no, file_name, file_sha256, mime_type, size_bytes,
      storage_key, archive_entry_name, status, diagnostic
    ) values (
      v_job_id,
      coalesce(nullif((v_item->>'sequence_no')::integer,0), v_seq),
      coalesce(nullif(v_item->>'file_name',''), format('arquivo-%s',v_seq)),
      nullif(lower(v_item->>'file_sha256'),''),
      nullif(v_item->>'mime_type',''),
      greatest(coalesce((v_item->>'size_bytes')::bigint,0),0),
      coalesce(nullif(v_item->>'storage_key',''), btrim(p_storage_key)),
      nullif(v_item->>'archive_entry_name',''),
      case
        when coalesce(v_item->>'ignored_reason','') <> '' then 'IGNORED'
        when upper(coalesce(v_item->>'initial_status','')) = 'DUPLICATE' then 'DUPLICATE'
        else 'PENDING'
      end,
      coalesce(nullif(v_item->>'ignored_reason',''), nullif(v_item->>'initial_diagnostic',''))
    );
  end loop;

  perform public.sisha_refresh_receipt_import_job(v_job_id);

  insert into public.system_audit_logs(
    actor_email, actor_role, action, entity, entity_id, summary, details, level, visibility
  ) values (
    v_email, v_role, 'RECEIPT_IMPORT_JOB_CREATED', 'RECEIPT_IMPORT_JOB', v_job_id::text,
    format('Lote persistente de recibos criado com %s documento(s).', jsonb_array_length(p_items)),
    jsonb_build_object(
      'archive_name', p_archive_name,
      'archive_sha256', p_archive_sha256,
      'total_items', jsonb_array_length(p_items),
      'storage_mode', p_storage_mode,
      'request_id', p_request_id
    ),
    'INFO', 'GOD'
  );

  return v_job_id;
end;
$function$;

create or replace function public.sisha_claim_receipt_import_item(
  p_worker_id text,
  p_lease_seconds integer default 900
)
returns table(
  item_id uuid,
  claim_token uuid,
  job_id uuid,
  sequence_no integer,
  file_name text,
  file_sha256 text,
  mime_type text,
  size_bytes bigint,
  storage_bucket text,
  storage_key text,
  storage_mode text,
  archive_entry_name text,
  created_by_auth_user_id uuid,
  created_by_email text,
  created_by_role text
)
language plpgsql
security definer
set search_path to 'public','pg_temp'
as $function$
declare
  v_item public.receipt_import_job_items%rowtype;
  v_token uuid := gen_random_uuid();
  v_lease integer := greatest(120, least(coalesce(p_lease_seconds,900),3600));
begin
  select i.* into v_item
  from public.receipt_import_job_items i
  join public.receipt_import_jobs j on j.id = i.job_id
  where j.status not in ('FAILED','CANCELLED','REVIEW_READY')
    and (
      i.status = 'PENDING'
      or (i.status = 'PROCESSING' and coalesce(i.lease_until, to_timestamp(0)) < now())
    )
  order by j.created_at asc, i.sequence_no asc
  for update of i skip locked
  limit 1;

  if not found then return; end if;

  update public.receipt_import_job_items
  set status = 'PROCESSING',
      claim_token = v_token,
      claimed_by = nullif(btrim(coalesce(p_worker_id,'')),''),
      claimed_at = now(),
      lease_until = now() + make_interval(secs => v_lease),
      attempt_count = attempt_count + 1,
      updated_at = now(),
      diagnostic = case when v_item.status = 'PROCESSING' then 'Retomado após expiração do lease anterior.' else diagnostic end
  where id = v_item.id;

  update public.receipt_import_jobs
  set status = 'PROCESSING', started_at = coalesce(started_at, now()), last_heartbeat_at = now()
  where id = v_item.job_id;

  return query
  select
    i.id, i.claim_token, i.job_id, i.sequence_no, i.file_name, i.file_sha256,
    i.mime_type, i.size_bytes, j.storage_bucket, i.storage_key, j.storage_mode,
    i.archive_entry_name, j.created_by_auth_user_id, j.created_by_email, j.created_by_role
  from public.receipt_import_job_items i
  join public.receipt_import_jobs j on j.id = i.job_id
  where i.id = v_item.id;
end;
$function$;

create or replace function public.sisha_renew_receipt_import_item_lease(
  p_item_id uuid,
  p_claim_token uuid,
  p_lease_seconds integer default 120
)
returns boolean
language plpgsql
security definer
set search_path to 'public','pg_temp'
as $function$
declare
  v_lease integer := greatest(60, least(coalesce(p_lease_seconds,120),600));
  v_updated integer;
begin
  update public.receipt_import_job_items
  set lease_until = now() + make_interval(secs => v_lease),
      updated_at = now()
  where id = p_item_id
    and status = 'PROCESSING'
    and claim_token = p_claim_token;
  get diagnostics v_updated = row_count;
  return v_updated = 1;
end;
$function$;

create or replace function public.sisha_complete_receipt_import_item(
  p_item_id uuid,
  p_claim_token uuid,
  p_status text,
  p_source_method text,
  p_receipt_number text,
  p_receipt_type text,
  p_item_count integer,
  p_warnings jsonb,
  p_diagnostic text,
  p_triage_payload jsonb,
  p_analysis_version text,
  p_reused_analysis boolean default false
)
returns void
language plpgsql
security definer
set search_path to 'public','pg_temp'
as $function$
declare
  v_status text := upper(btrim(coalesce(p_status,'')));
  v_job_id uuid;
begin
  if v_status not in ('READY','REVIEW','CONFLICT','DUPLICATE','ERROR','SAVED','IGNORED') then
    raise exception 'HF2: status terminal inválido.';
  end if;

  update public.receipt_import_job_items
  set status = v_status,
      source_method = nullif(btrim(coalesce(p_source_method,'')),''),
      receipt_number = nullif(btrim(coalesce(p_receipt_number,'')),''),
      receipt_type = nullif(btrim(coalesce(p_receipt_type,'')),''),
      item_count = greatest(coalesce(p_item_count,0),0),
      warnings = coalesce(p_warnings,'[]'::jsonb),
      diagnostic = nullif(p_diagnostic,''),
      triage_payload = p_triage_payload,
      analysis_version = nullif(p_analysis_version,''),
      reused_analysis = coalesce(p_reused_analysis,false),
      processed_at = now(),
      lease_until = null,
      claim_token = null,
      updated_at = now()
  where id = p_item_id
    and status = 'PROCESSING'
    and claim_token = p_claim_token
  returning job_id into v_job_id;

  if v_job_id is null then
    raise exception 'HF2: claim expirado ou item já finalizado.';
  end if;

  perform public.sisha_refresh_receipt_import_job(v_job_id);
end;
$function$;

create or replace function public.sisha_mark_receipt_import_item_saved(
  p_item_id uuid,
  p_actor_email text,
  p_actor_role text,
  p_request_id text default null
)
returns void
language plpgsql
security definer
set search_path to 'public','pg_temp'
as $function$
declare
  v_job_id uuid;
  v_role text := lower(btrim(coalesce(p_actor_role,'')));
begin
  if v_role not in ('admin','dono') then
    raise exception 'HF2: somente Admin/Dono pode concluir item do lote.';
  end if;

  update public.receipt_import_job_items
  set status = 'SAVED', updated_at = now(), processed_at = coalesce(processed_at,now())
  where id = p_item_id and status in ('READY','REVIEW','CONFLICT')
  returning job_id into v_job_id;

  if v_job_id is null then return; end if;
  perform public.sisha_refresh_receipt_import_job(v_job_id);

  insert into public.system_audit_logs(
    actor_email, actor_role, action, entity, entity_id, summary, details, level, visibility
  ) values (
    lower(btrim(p_actor_email)), v_role, 'RECEIPT_IMPORT_ITEM_SAVED', 'RECEIPT_IMPORT_JOB_ITEM', p_item_id::text,
    'Item de triagem persistente marcado como salvo após confirmação humana.',
    jsonb_build_object('job_id', v_job_id, 'request_id', p_request_id), 'INFO', 'GOD'
  );
end;
$function$;

revoke all on table public.receipt_import_jobs from public, anon, authenticated;
revoke all on table public.receipt_import_job_items from public, anon, authenticated;
revoke all on table public.receipt_import_analysis_cache from public, anon, authenticated;
grant select, insert, update on table public.receipt_import_jobs to service_role;
grant select, insert, update on table public.receipt_import_job_items to service_role;
grant select, insert, update on table public.receipt_import_analysis_cache to service_role;

revoke all on function public.sisha_refresh_receipt_import_job(uuid) from public, anon, authenticated;
revoke all on function public.sisha_create_receipt_import_job_atomic(text,text,text,text,text,jsonb,uuid,text,text,text) from public, anon, authenticated;
revoke all on function public.sisha_claim_receipt_import_item(text,integer) from public, anon, authenticated;
revoke all on function public.sisha_renew_receipt_import_item_lease(uuid,uuid,integer) from public, anon, authenticated;
revoke all on function public.sisha_complete_receipt_import_item(uuid,uuid,text,text,text,text,integer,jsonb,text,jsonb,text,boolean) from public, anon, authenticated;
revoke all on function public.sisha_mark_receipt_import_item_saved(uuid,text,text,text) from public, anon, authenticated;
grant execute on function public.sisha_refresh_receipt_import_job(uuid) to service_role;
grant execute on function public.sisha_create_receipt_import_job_atomic(text,text,text,text,text,jsonb,uuid,text,text,text) to service_role;
grant execute on function public.sisha_claim_receipt_import_item(text,integer) to service_role;
grant execute on function public.sisha_renew_receipt_import_item_lease(uuid,uuid,integer) to service_role;
grant execute on function public.sisha_complete_receipt_import_item(uuid,uuid,text,text,text,text,integer,jsonb,text,jsonb,text,boolean) to service_role;
grant execute on function public.sisha_mark_receipt_import_item_saved(uuid,text,text,text) to service_role;

insert into public.sisha_schema_migrations(version, description)
values (
  '20260814_A1_1A_HF2_001',
  'A1.1A HF2: jobs persistentes de importação de recibos, retomada por lease, cache por SHA-256 e staging sem gravação operacional automática.'
)
on conflict (version) do update set description = excluded.description;

commit;
