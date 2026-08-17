-- SISHA1 V2 - H4C6
-- Corte definitivo do autenticador legado local.
--
-- Efeito:
--   * exige ao menos um DONO ativo ja vinculado ao Supabase Auth;
--   * remove public.authorized_users.senha (nao ha mais credencial local);
--   * preserva usuarios autorizados ainda sem auth_user_id: eles ficam sem acesso
--     ate usarem ENVIAR LINK ou ESQUECI MINHA SENHA;
--   * nao cria usuarios automaticamente e nao abre cadastro publico.

do $h4c6$
declare
  v_bound_active_dono integer := 0;
  v_legacy_column_exists integer := 0;
begin
  select count(*)
    into v_bound_active_dono
  from public.authorized_users au
  join auth.users u
    on u.id = au.auth_user_id
  where au.active is true
    and lower(trim(au.role)) = 'dono'
    and au.auth_user_id is not null
    and lower(trim(coalesce(u.email, ''))) = lower(trim(au.email));

  if v_bound_active_dono < 1 then
    raise exception 'H4C6 BLOQUEADO: nenhum DONO ativo possui vinculo 1:1 valido com Supabase Auth.';
  end if;

  select count(*)
    into v_legacy_column_exists
  from information_schema.columns
  where table_schema = 'public'
    and table_name = 'authorized_users'
    and column_name = 'senha';

  if v_legacy_column_exists > 0 then
    alter table public.authorized_users drop column senha;
  end if;

  comment on table public.authorized_users is
    'Allowlist administrativa do SISHA. Credenciais sao geridas exclusivamente pelo Supabase Auth; esta tabela guarda somente autorizacao, role, status e vinculo por UUID.';

  insert into public.sisha_schema_migrations(version, description)
  values (
    '20260813_H4C6_001',
    'H4C6: Supabase Auth exclusivo; login/token legado removido e coluna authorized_users.senha eliminada.'
  )
  on conflict (version) do update
     set description = excluded.description;

  if exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'authorized_users'
      and column_name = 'senha'
  ) then
    raise exception 'H4C6: coluna authorized_users.senha permaneceu apos o corte legado.';
  end if;
end;
$h4c6$;
