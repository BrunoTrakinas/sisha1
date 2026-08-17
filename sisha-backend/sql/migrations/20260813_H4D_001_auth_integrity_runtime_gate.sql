-- SISHA1 V2 - H4D
-- Integridade final do vinculo Auth e protecao do ultimo DONO valido.
--
-- Regras permanentes:
--   * auth_user_id referencia auth.users(id);
--   * se a identidade Auth for removida externamente, auth_user_id vira NULL;
--   * quando auth_user_id existir, o email do SISHA deve coincidir com auth.users;
--   * o ultimo DONO ativo + vinculado + email consistente nao pode ser
--     desativado, rebaixado, desvinculado ou excluido;
--   * nenhum acesso publico e reaberto.

do $h4d$
declare
  v_invalid_bindings integer := 0;
  v_valid_donos integer := 0;
  v_public_grants integer := 0;
begin
  select count(*)
    into v_invalid_bindings
  from public.authorized_users au
  left join auth.users u
    on u.id = au.auth_user_id
  where au.auth_user_id is not null
    and (
      u.id is null
      or lower(trim(coalesce(u.email, ''))) <> lower(trim(coalesce(au.email, '')))
    );

  if v_invalid_bindings <> 0 then
    raise exception 'H4D BLOQUEADO: % vinculo(s) authorized_users -> auth.users invalidos.', v_invalid_bindings;
  end if;

  select count(*)
    into v_valid_donos
  from public.authorized_users au
  join auth.users u
    on u.id = au.auth_user_id
  where au.active is true
    and lower(trim(au.role)) = 'dono'
    and lower(trim(coalesce(u.email, ''))) = lower(trim(coalesce(au.email, '')));

  if v_valid_donos < 1 then
    raise exception 'H4D BLOQUEADO: nenhum DONO ativo possui vinculo Auth valido.';
  end if;

  if not exists (
    select 1
    from pg_constraint c
    join pg_class t on t.oid = c.conrelid
    join pg_namespace n on n.oid = t.relnamespace
    where n.nspname = 'public'
      and t.relname = 'authorized_users'
      and c.conname = 'authorized_users_auth_user_id_fkey'
  ) then
    execute '
      alter table public.authorized_users
      add constraint authorized_users_auth_user_id_fkey
      foreign key (auth_user_id)
      references auth.users(id)
      on delete set null
      not valid
    ';

    execute '
      alter table public.authorized_users
      validate constraint authorized_users_auth_user_id_fkey
    ';
  end if;

  execute $ddl$
    create or replace function public.sisha_guard_authorized_user_auth_integrity()
    returns trigger
    language plpgsql
    security definer
    set search_path = pg_catalog
    as $fn$
    declare
      v_auth_email text;
      v_other_valid_donos integer := 0;
      v_old_valid_dono boolean := false;
      v_new_valid_dono boolean := false;
    begin
      if tg_op in ('INSERT', 'UPDATE') and new.auth_user_id is not null then
        select lower(trim(coalesce(u.email, '')))
          into v_auth_email
        from auth.users u
        where u.id = new.auth_user_id;

        if v_auth_email is null then
          raise exception 'SISHA_AUTH_BINDING_MISSING: identidade Supabase Auth inexistente.';
        end if;

        if v_auth_email <> lower(trim(coalesce(new.email, ''))) then
          raise exception 'SISHA_AUTH_BINDING_EMAIL_MISMATCH: email autorizado diverge da identidade Supabase Auth.';
        end if;
      end if;

      if tg_op in ('UPDATE', 'DELETE') then
        v_old_valid_dono :=
          old.active is true
          and lower(trim(old.role)) = 'dono'
          and old.auth_user_id is not null
          and exists (
            select 1
            from auth.users u
            where u.id = old.auth_user_id
              and lower(trim(coalesce(u.email, ''))) = lower(trim(coalesce(old.email, '')))
          );
      end if;

      if tg_op = 'UPDATE' then
        v_new_valid_dono :=
          new.active is true
          and lower(trim(new.role)) = 'dono'
          and new.auth_user_id is not null;

        if v_old_valid_dono and not v_new_valid_dono then
          select count(*)
            into v_other_valid_donos
          from public.authorized_users au
          join auth.users u
            on u.id = au.auth_user_id
          where au.id <> old.id
            and au.active is true
            and lower(trim(au.role)) = 'dono'
            and lower(trim(coalesce(u.email, ''))) = lower(trim(coalesce(au.email, '')));

          if v_other_valid_donos < 1 then
            raise exception 'SISHA_LAST_DONO_GUARD: o ultimo DONO ativo e vinculado nao pode ser desativado, rebaixado ou desvinculado.';
          end if;
        end if;

        return new;
      end if;

      if tg_op = 'DELETE' then
        if v_old_valid_dono then
          select count(*)
            into v_other_valid_donos
          from public.authorized_users au
          join auth.users u
            on u.id = au.auth_user_id
          where au.id <> old.id
            and au.active is true
            and lower(trim(au.role)) = 'dono'
            and lower(trim(coalesce(u.email, ''))) = lower(trim(coalesce(au.email, '')));

          if v_other_valid_donos < 1 then
            raise exception 'SISHA_LAST_DONO_GUARD: o ultimo DONO ativo e vinculado nao pode ser excluido.';
          end if;
        end if;

        return old;
      end if;

      return new;
    end;
    $fn$;
  $ddl$;

  execute 'revoke all on function public.sisha_guard_authorized_user_auth_integrity() from public';
  execute 'revoke all on function public.sisha_guard_authorized_user_auth_integrity() from anon';
  execute 'revoke all on function public.sisha_guard_authorized_user_auth_integrity() from authenticated';

  execute 'drop trigger if exists trg_sisha_authorized_user_auth_integrity on public.authorized_users';
  execute '
    create trigger trg_sisha_authorized_user_auth_integrity
    before insert or update or delete
    on public.authorized_users
    for each row
    execute function public.sisha_guard_authorized_user_auth_integrity()
  ';

  select count(*)
    into v_public_grants
  from information_schema.role_table_grants
  where table_schema = 'public'
    and table_name = 'authorized_users'
    and grantee in ('anon', 'authenticated');

  if v_public_grants <> 0 then
    raise exception 'H4D: authorized_users voltou a expor privilegios para anon/authenticated.';
  end if;

  insert into public.sisha_schema_migrations(version, description)
  values (
    '20260813_H4D_001',
    'H4D: integridade authorized_users/auth.users, FK controlada e protecao do ultimo DONO valido.'
  )
  on conflict (version) do update
     set description = excluded.description;
end;
$h4d$;
