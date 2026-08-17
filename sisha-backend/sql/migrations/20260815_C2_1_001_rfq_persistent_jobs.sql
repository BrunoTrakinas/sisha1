begin;

create table if not exists public.rfq_import_jobs (
  id uuid primary key default gen_random_uuid(),
  status text not null default 'QUEUED' check (status in ('QUEUED','PROCESSING','REVIEW_READY','ERROR','SAVED')),
  file_name text not null,
  file_sha256 text not null,
  mime_type text,
  size_bytes bigint not null default 0 check (size_bytes >= 0),
  storage_bucket text not null,
  storage_key text not null,
  analysis_version text not null,
  document_type text,
  quotation_number text,
  analysis_method text,
  quality_status text,
  result_payload jsonb,
  diagnostic text,
  created_by_auth_user_id uuid,
  created_by_email text,
  created_by_role text,
  request_id text,
  claimed_by text,
  claim_token uuid,
  claimed_at timestamptz,
  lease_until timestamptz,
  attempt_count integer not null default 0 check (attempt_count >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  started_at timestamptz,
  completed_at timestamptz,
  saved_at timestamptz
);

create index if not exists idx_rfq_import_jobs_status_created
  on public.rfq_import_jobs(status, created_at);
create index if not exists idx_rfq_import_jobs_hash_version
  on public.rfq_import_jobs(file_sha256, analysis_version, created_at desc);
create index if not exists idx_rfq_import_jobs_lease
  on public.rfq_import_jobs(status, lease_until);

alter table public.rfq_import_jobs enable row level security;

create or replace function public.sisha_claim_rfq_import_job(
  p_worker_id text,
  p_lease_seconds integer default 180
)
returns table (
  job_id uuid,
  file_name text,
  file_sha256 text,
  mime_type text,
  storage_bucket text,
  storage_key text,
  claim_token uuid
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_job public.rfq_import_jobs%rowtype;
  v_token uuid := gen_random_uuid();
begin
  select * into v_job
  from public.rfq_import_jobs
  where (
    status = 'QUEUED'
    or (status = 'PROCESSING' and (lease_until is null or lease_until < now()))
  )
  order by created_at asc
  for update skip locked
  limit 1;

  if not found then return; end if;

  update public.rfq_import_jobs
  set status = 'PROCESSING',
      claimed_by = p_worker_id,
      claim_token = v_token,
      claimed_at = now(),
      lease_until = now() + make_interval(secs => greatest(60, least(coalesce(p_lease_seconds, 180), 900))),
      attempt_count = attempt_count + 1,
      started_at = coalesce(started_at, now()),
      updated_at = now()
  where id = v_job.id;

  return query
  select j.id, j.file_name, j.file_sha256, j.mime_type, j.storage_bucket, j.storage_key, j.claim_token
  from public.rfq_import_jobs j
  where j.id = v_job.id;
end;
$$;

create or replace function public.sisha_renew_rfq_import_job_lease(
  p_job_id uuid,
  p_claim_token uuid,
  p_lease_seconds integer default 180
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.rfq_import_jobs
  set lease_until = now() + make_interval(secs => greatest(60, least(coalesce(p_lease_seconds, 180), 900))),
      updated_at = now()
  where id = p_job_id
    and status = 'PROCESSING'
    and claim_token = p_claim_token;
  return found;
end;
$$;

create or replace function public.sisha_complete_rfq_import_job(
  p_job_id uuid,
  p_claim_token uuid,
  p_status text,
  p_result_payload jsonb default null,
  p_document_type text default null,
  p_quotation_number text default null,
  p_analysis_method text default null,
  p_quality_status text default null,
  p_diagnostic text default null
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_status not in ('REVIEW_READY','ERROR') then
    raise exception 'RFQ_JOB_INVALID_FINAL_STATUS';
  end if;

  update public.rfq_import_jobs
  set status = p_status,
      result_payload = p_result_payload,
      document_type = p_document_type,
      quotation_number = p_quotation_number,
      analysis_method = p_analysis_method,
      quality_status = p_quality_status,
      diagnostic = p_diagnostic,
      completed_at = now(),
      claimed_by = null,
      claim_token = null,
      claimed_at = null,
      lease_until = null,
      updated_at = now()
  where id = p_job_id
    and status = 'PROCESSING'
    and claim_token = p_claim_token;
  return found;
end;
$$;

create or replace function public.sisha_mark_rfq_import_job_saved(p_job_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.rfq_import_jobs
  set status = 'SAVED', saved_at = now(), updated_at = now()
  where id = p_job_id and status in ('REVIEW_READY','SAVED');
  return found;
end;
$$;

revoke all on table public.rfq_import_jobs from public, anon, authenticated;
grant select, insert, update on table public.rfq_import_jobs to service_role;

revoke all on function public.sisha_claim_rfq_import_job(text,integer) from public, anon, authenticated;
revoke all on function public.sisha_renew_rfq_import_job_lease(uuid,uuid,integer) from public, anon, authenticated;
revoke all on function public.sisha_complete_rfq_import_job(uuid,uuid,text,jsonb,text,text,text,text,text) from public, anon, authenticated;
revoke all on function public.sisha_mark_rfq_import_job_saved(uuid) from public, anon, authenticated;

grant execute on function public.sisha_claim_rfq_import_job(text,integer) to service_role;
grant execute on function public.sisha_renew_rfq_import_job_lease(uuid,uuid,integer) to service_role;
grant execute on function public.sisha_complete_rfq_import_job(uuid,uuid,text,jsonb,text,text,text,text,text) to service_role;
grant execute on function public.sisha_mark_rfq_import_job_saved(uuid) to service_role;

commit;
