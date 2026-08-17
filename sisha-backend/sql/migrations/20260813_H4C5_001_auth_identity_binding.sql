-- SISHA1 V2 - H4C5 HF1
-- Vinculo 1:1 entre public.authorized_users e auth.users.
--
-- HF1:
--   * substitui o BEGIN/COMMIT externo por um unico bloco DO atomico;
--   * permanece idempotente;
--   * nao remove a coluna senha;
--   * nao muda SISHA_AUTH_MODE=hybrid;
--   * nao altera UI/UX/layout.

do $h4c5$
declare
  v_duplicate_bindings integer := 0;
  v_public_grants integer := 0;
begin
  execute 'alter table public.authorized_users add column if not exists auth_user_id uuid';
  execute 'alter table public.authorized_users add column if not exists auth_bound_at timestamptz';

  -- Antes de criar o indice unico, garante que nao exista estado inconsistente
  -- caso uma tentativa/manualidade anterior tenha preenchido a coluna.
  select count(*)
    into v_duplicate_bindings
  from (
    select auth_user_id
    from public.authorized_users
    where auth_user_id is not null
    group by auth_user_id
    having count(*) > 1
  ) d;

  if v_duplicate_bindings <> 0 then
    raise exception 'H4C5: existem % vinculos auth_user_id duplicados antes do binding.', v_duplicate_bindings;
  end if;

  execute '
    create unique index if not exists authorized_users_auth_user_id_key
      on public.authorized_users(auth_user_id)
      where auth_user_id is not null
  ';

  execute '
    create index if not exists idx_authorized_users_auth_binding
      on public.authorized_users(active, auth_user_id)
  ';

  -- Backfill conservador:
  -- somente cadastros ainda sem UUID e cujo email corresponde ao auth.users.
  -- Um auth_user_id ja preenchido nunca e reatribuido automaticamente.
  update public.authorized_users au
     set auth_user_id = u.id,
         auth_bound_at = coalesce(au.auth_bound_at, now()),
         updated_at = now()
    from auth.users u
   where au.auth_user_id is null
     and u.email is not null
     and lower(trim(au.email)) = lower(trim(u.email));

  execute $comment1$
    comment on column public.authorized_users.auth_user_id is
    'UUID imutavel da identidade Supabase Auth vinculada ao cadastro autorizado do SISHA. Server-only.'
  $comment1$;

  execute $comment2$
    comment on column public.authorized_users.auth_bound_at is
    'Data/hora em que o cadastro autorizado foi vinculado a identidade Supabase Auth.'
  $comment2$;

  -- Guards finais.
  select count(*)
    into v_duplicate_bindings
  from (
    select auth_user_id
    from public.authorized_users
    where auth_user_id is not null
    group by auth_user_id
    having count(*) > 1
  ) d;

  if v_duplicate_bindings <> 0 then
    raise exception 'H4C5: existem % vinculos auth_user_id duplicados apos o binding.', v_duplicate_bindings;
  end if;

  select count(*)
    into v_public_grants
  from information_schema.role_table_grants
  where table_schema = 'public'
    and table_name = 'authorized_users'
    and grantee in ('anon', 'authenticated');

  if v_public_grants <> 0 then
    raise exception 'H4C5: authorized_users voltou a expor privilegios para anon/authenticated.';
  end if;

  insert into public.sisha_schema_migrations(version, description)
  values (
    '20260813_H4C5_001',
    'H4C5: vinculo 1:1 authorized_users -> auth.users por UUID; compativel com migracao hybrid.'
  )
  on conflict (version) do update
     set description = excluded.description;
end;
$h4c5$;
