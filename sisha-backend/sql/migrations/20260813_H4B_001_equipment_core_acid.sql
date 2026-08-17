-- SISHA1 V2 — H4B CORE ACID / EQUIPAMENTOS
-- Data: 2026-08-13
-- Objetivo: versionar a infraestrutura mínima de migrations e criar RPCs ACID
-- para as operações multi-tabela críticas do Livro de Equipamentos.
--
-- Regras:
-- - NÃO altera UI/UX.
-- - NÃO remove tabela/coluna/constraint existente.
-- - NÃO altera work_orders/compras/recebimentos.
-- - As novas RPCs são executáveis somente pela role de backend (service_role).
-- - A aplicação só passa a usá-las quando SISHA_H4B_ACID_EQUIPMENT_ENABLED=true.

begin;

create table if not exists public.sisha_schema_migrations (
  version text primary key,
  description text not null,
  applied_at timestamptz not null default now()
);

alter table public.sisha_schema_migrations enable row level security;

create or replace function public.sisha_insert_equipment_event_atomic(
  p_equipment_id bigint,
  p_event jsonb,
  p_user_email text default null
)
returns bigint
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_equipment public.equipamentos_serializados%rowtype;
  v_event_id bigint;
  v_tipo text;
  v_motivo text;
  v_origem text;
  v_origem_registro text;
  v_payload jsonb;
begin
  if p_equipment_id is null then
    raise exception 'equipment_id é obrigatório.';
  end if;
  if p_event is null or jsonb_typeof(p_event) <> 'object' then
    raise exception 'Evento deve ser um objeto JSON.';
  end if;

  select *
    into v_equipment
    from public.equipamentos_serializados
   where id = p_equipment_id
   for update;

  if not found then
    raise exception 'Equipamento % não encontrado.', p_equipment_id;
  end if;

  v_tipo := upper(btrim(coalesce(p_event->>'tipo_evento', '')));
  v_motivo := nullif(btrim(coalesce(p_event->>'motivo', '')), '');
  v_origem := upper(btrim(coalesce(nullif(p_event->>'origem_evento', ''), 'MANUAL')));
  v_origem_registro := nullif(btrim(coalesce(p_event->>'origem_registro_id', '')), '');
  v_payload := case
    when jsonb_typeof(p_event->'payload') = 'object' then p_event->'payload'
    else '{}'::jsonb
  end;

  if v_tipo = '' then
    raise exception 'Tipo do evento é obrigatório.';
  end if;
  if v_motivo is null then
    raise exception 'Motivo/descrição do movimento é obrigatório para auditoria.';
  end if;

  if v_origem_registro is not null and v_origem <> 'MANUAL' then
    insert into public.equipamento_eventos (
      equipamento_id, pn, sn, tipo_evento, data_evento,
      pim, os, anv, horas_evento,
      local_origem, local_destino,
      categoria_origem, categoria_destino,
      status_resultante, condicao_resultante, anv_destino,
      motivo, documento_tipo, documento, observacao, usuario,
      origem_evento, origem_registro_id, confianca,
      automatico, invalidado, invalidado_em, invalidado_por,
      motivo_invalidacao, payload
    ) values (
      v_equipment.id,
      v_equipment.pn,
      v_equipment.sn,
      v_tipo,
      coalesce(nullif(p_event->>'data_evento', '')::timestamptz, now()),
      nullif(btrim(coalesce(p_event->>'pim', '')), ''),
      nullif(btrim(coalesce(p_event->>'os', '')), ''),
      nullif(btrim(coalesce(p_event->>'anv', p_event->>'anv_destino', '')), ''),
      nullif(p_event->>'horas_evento', '')::numeric,
      v_equipment.local_atual,
      nullif(btrim(coalesce(p_event->>'local_destino', '')), ''),
      v_equipment.categoria_local_atual,
      nullif(btrim(coalesce(p_event->>'categoria_destino', '')), ''),
      coalesce(nullif(btrim(coalesce(p_event->>'status_resultante', '')), ''), v_equipment.status_atual, 'DESCONHECIDO'),
      coalesce(nullif(btrim(coalesce(p_event->>'condicao_resultante', '')), ''), v_equipment.condicao_atual, 'DESCONHECIDA'),
      nullif(btrim(coalesce(p_event->>'anv_destino', '')), ''),
      v_motivo,
      nullif(upper(btrim(coalesce(p_event->>'documento_tipo', ''))), ''),
      nullif(btrim(coalesce(p_event->>'documento', '')), ''),
      nullif(btrim(coalesce(p_event->>'observacao', '')), ''),
      coalesce(nullif(btrim(p_user_email), ''), nullif(btrim(coalesce(p_event->>'usuario', '')), '')),
      v_origem,
      v_origem_registro,
      upper(btrim(coalesce(nullif(p_event->>'confianca', ''), 'CONFIRMADA'))),
      coalesce(nullif(p_event->>'automatico', '')::boolean, false),
      coalesce(nullif(p_event->>'invalidado', '')::boolean, false),
      nullif(p_event->>'invalidado_em', '')::timestamptz,
      nullif(btrim(coalesce(p_event->>'invalidado_por', '')), ''),
      nullif(btrim(coalesce(p_event->>'motivo_invalidacao', '')), ''),
      v_payload
    )
    on conflict (origem_evento, origem_registro_id) do update set
      equipamento_id = excluded.equipamento_id,
      pn = excluded.pn,
      sn = excluded.sn,
      tipo_evento = excluded.tipo_evento,
      data_evento = excluded.data_evento,
      pim = excluded.pim,
      os = excluded.os,
      anv = excluded.anv,
      horas_evento = excluded.horas_evento,
      local_origem = excluded.local_origem,
      local_destino = excluded.local_destino,
      categoria_origem = excluded.categoria_origem,
      categoria_destino = excluded.categoria_destino,
      status_resultante = excluded.status_resultante,
      condicao_resultante = excluded.condicao_resultante,
      anv_destino = excluded.anv_destino,
      motivo = excluded.motivo,
      documento_tipo = excluded.documento_tipo,
      documento = excluded.documento,
      observacao = excluded.observacao,
      usuario = excluded.usuario,
      confianca = excluded.confianca,
      automatico = excluded.automatico,
      invalidado = excluded.invalidado,
      invalidado_em = excluded.invalidado_em,
      invalidado_por = excluded.invalidado_por,
      motivo_invalidacao = excluded.motivo_invalidacao,
      payload = excluded.payload
    returning id into v_event_id;
  else
    insert into public.equipamento_eventos (
      equipamento_id, pn, sn, tipo_evento, data_evento,
      pim, os, anv, horas_evento,
      local_origem, local_destino,
      categoria_origem, categoria_destino,
      status_resultante, condicao_resultante, anv_destino,
      motivo, documento_tipo, documento, observacao, usuario,
      origem_evento, origem_registro_id, confianca,
      automatico, invalidado, invalidado_em, invalidado_por,
      motivo_invalidacao, payload
    ) values (
      v_equipment.id,
      v_equipment.pn,
      v_equipment.sn,
      v_tipo,
      coalesce(nullif(p_event->>'data_evento', '')::timestamptz, now()),
      nullif(btrim(coalesce(p_event->>'pim', '')), ''),
      nullif(btrim(coalesce(p_event->>'os', '')), ''),
      nullif(btrim(coalesce(p_event->>'anv', p_event->>'anv_destino', '')), ''),
      nullif(p_event->>'horas_evento', '')::numeric,
      v_equipment.local_atual,
      nullif(btrim(coalesce(p_event->>'local_destino', '')), ''),
      v_equipment.categoria_local_atual,
      nullif(btrim(coalesce(p_event->>'categoria_destino', '')), ''),
      coalesce(nullif(btrim(coalesce(p_event->>'status_resultante', '')), ''), v_equipment.status_atual, 'DESCONHECIDO'),
      coalesce(nullif(btrim(coalesce(p_event->>'condicao_resultante', '')), ''), v_equipment.condicao_atual, 'DESCONHECIDA'),
      nullif(btrim(coalesce(p_event->>'anv_destino', '')), ''),
      v_motivo,
      nullif(upper(btrim(coalesce(p_event->>'documento_tipo', ''))), ''),
      nullif(btrim(coalesce(p_event->>'documento', '')), ''),
      nullif(btrim(coalesce(p_event->>'observacao', '')), ''),
      coalesce(nullif(btrim(p_user_email), ''), nullif(btrim(coalesce(p_event->>'usuario', '')), '')),
      v_origem,
      v_origem_registro,
      upper(btrim(coalesce(nullif(p_event->>'confianca', ''), 'CONFIRMADA'))),
      coalesce(nullif(p_event->>'automatico', '')::boolean, false),
      coalesce(nullif(p_event->>'invalidado', '')::boolean, false),
      nullif(p_event->>'invalidado_em', '')::timestamptz,
      nullif(btrim(coalesce(p_event->>'invalidado_por', '')), ''),
      nullif(btrim(coalesce(p_event->>'motivo_invalidacao', '')), ''),
      v_payload
    ) returning id into v_event_id;
  end if;

  return v_event_id;
end;
$function$;

create or replace function public.sisha_create_equipment_atomic(
  p_equipment jsonb,
  p_initial_event jsonb default null,
  p_user_email text default null
)
returns jsonb
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_equipment public.equipamentos_serializados%rowtype;
  v_event_id bigint;
  v_pn text;
  v_sn text;
begin
  if p_equipment is null or jsonb_typeof(p_equipment) <> 'object' then
    raise exception 'Dados do equipamento devem ser um objeto JSON.';
  end if;

  v_pn := upper(regexp_replace(btrim(coalesce(p_equipment->>'pn', '')), '\s+', '', 'g'));
  v_sn := upper(regexp_replace(btrim(coalesce(p_equipment->>'sn', '')), '\s+', '', 'g'));
  if v_pn = '' or v_sn = '' then
    raise exception 'PN e SN são obrigatórios para identificar um equipamento.';
  end if;

  insert into public.equipamentos_serializados (
    pn, sn, nomenclatura,
    status_atual, condicao_atual, categoria_local_atual, confianca_localizacao,
    garantia_inicio, garantia_vencimento, garantia_observacao, garantia_documento, garantia_alerta_ativo,
    horas_acumuladas,
    origem_entrada, documento_entrada, data_entrada,
    atualizado_por, ativo, updated_at
  ) values (
    v_pn,
    v_sn,
    nullif(btrim(coalesce(p_equipment->>'nomenclatura', '')), ''),
    coalesce(nullif(btrim(coalesce(p_equipment->>'status_atual', '')), ''), 'DESCONHECIDO'),
    coalesce(nullif(btrim(coalesce(p_equipment->>'condicao_atual', '')), ''), 'DESCONHECIDA'),
    coalesce(nullif(upper(btrim(coalesce(p_equipment->>'categoria_local_atual', ''))), ''), 'DESCONHECIDO'),
    coalesce(nullif(upper(btrim(coalesce(p_equipment->>'confianca_localizacao', ''))), ''), 'DESCONHECIDA'),
    nullif(p_equipment->>'garantia_inicio', '')::date,
    nullif(p_equipment->>'garantia_vencimento', '')::date,
    nullif(btrim(coalesce(p_equipment->>'garantia_observacao', '')), ''),
    nullif(btrim(coalesce(p_equipment->>'garantia_documento', '')), ''),
    coalesce(nullif(p_equipment->>'garantia_alerta_ativo', '')::boolean, true),
    coalesce(nullif(p_equipment->>'horas_acumuladas', '')::numeric, 0),
    nullif(btrim(coalesce(p_equipment->>'origem_entrada', '')), ''),
    nullif(btrim(coalesce(p_equipment->>'documento_entrada', '')), ''),
    nullif(p_equipment->>'data_entrada', '')::date,
    coalesce(nullif(btrim(p_user_email), ''), nullif(btrim(coalesce(p_equipment->>'atualizado_por', '')), '')),
    coalesce(nullif(p_equipment->>'ativo', '')::boolean, true),
    now()
  ) returning * into v_equipment;

  if p_initial_event is not null then
    v_event_id := public.sisha_insert_equipment_event_atomic(v_equipment.id, p_initial_event, p_user_email);
  end if;

  select * into v_equipment from public.equipamentos_serializados where id = v_equipment.id;

  return jsonb_build_object(
    'equipment_id', v_equipment.id,
    'event_id', v_event_id,
    'equipment', to_jsonb(v_equipment)
  );
end;
$function$;

create or replace function public.sisha_update_equipment_atomic(
  p_equipment_id bigint,
  p_equipment jsonb,
  p_event jsonb default null,
  p_user_email text default null
)
returns jsonb
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_before public.equipamentos_serializados%rowtype;
  v_after public.equipamentos_serializados%rowtype;
  v_event_id bigint;
  v_pn text;
  v_sn text;
begin
  if p_equipment_id is null then
    raise exception 'equipment_id é obrigatório.';
  end if;
  if p_equipment is null or jsonb_typeof(p_equipment) <> 'object' then
    raise exception 'Dados do equipamento devem ser um objeto JSON.';
  end if;

  select * into v_before
    from public.equipamentos_serializados
   where id = p_equipment_id
   for update;
  if not found then
    raise exception 'Equipamento % não encontrado.', p_equipment_id;
  end if;

  v_pn := case when p_equipment ? 'pn'
    then upper(regexp_replace(btrim(coalesce(p_equipment->>'pn', '')), '\s+', '', 'g'))
    else v_before.pn end;
  v_sn := case when p_equipment ? 'sn'
    then upper(regexp_replace(btrim(coalesce(p_equipment->>'sn', '')), '\s+', '', 'g'))
    else v_before.sn end;
  if coalesce(v_pn, '') = '' or coalesce(v_sn, '') = '' then
    raise exception 'PN e SN são obrigatórios para identificar um equipamento.';
  end if;

  update public.equipamentos_serializados
     set pn = v_pn,
         sn = v_sn,
         nomenclatura = case when p_equipment ? 'nomenclatura' then nullif(btrim(coalesce(p_equipment->>'nomenclatura', '')), '') else nomenclatura end,
         garantia_inicio = case when p_equipment ? 'garantia_inicio' then nullif(p_equipment->>'garantia_inicio', '')::date else garantia_inicio end,
         garantia_vencimento = case when p_equipment ? 'garantia_vencimento' then nullif(p_equipment->>'garantia_vencimento', '')::date else garantia_vencimento end,
         garantia_observacao = case when p_equipment ? 'garantia_observacao' then nullif(btrim(coalesce(p_equipment->>'garantia_observacao', '')), '') else garantia_observacao end,
         garantia_documento = case when p_equipment ? 'garantia_documento' then nullif(btrim(coalesce(p_equipment->>'garantia_documento', '')), '') else garantia_documento end,
         garantia_alerta_ativo = case when p_equipment ? 'garantia_alerta_ativo' then coalesce(nullif(p_equipment->>'garantia_alerta_ativo', '')::boolean, garantia_alerta_ativo) else garantia_alerta_ativo end,
         horas_acumuladas = case when p_equipment ? 'horas_acumuladas' then coalesce(nullif(p_equipment->>'horas_acumuladas', '')::numeric, 0) else horas_acumuladas end,
         origem_entrada = case when p_equipment ? 'origem_entrada' then nullif(btrim(coalesce(p_equipment->>'origem_entrada', '')), '') else origem_entrada end,
         documento_entrada = case when p_equipment ? 'documento_entrada' then nullif(btrim(coalesce(p_equipment->>'documento_entrada', '')), '') else documento_entrada end,
         data_entrada = case when p_equipment ? 'data_entrada' then nullif(p_equipment->>'data_entrada', '')::date else data_entrada end,
         atualizado_por = coalesce(nullif(btrim(p_user_email), ''), nullif(btrim(coalesce(p_equipment->>'atualizado_por', '')), ''), atualizado_por),
         ativo = case when p_equipment ? 'ativo' then coalesce(nullif(p_equipment->>'ativo', '')::boolean, ativo) else ativo end,
         updated_at = now()
   where id = p_equipment_id
   returning * into v_after;

  if p_event is not null then
    v_event_id := public.sisha_insert_equipment_event_atomic(p_equipment_id, p_event, p_user_email);
  end if;

  select * into v_after from public.equipamentos_serializados where id = p_equipment_id;

  return jsonb_build_object(
    'equipment_id', v_after.id,
    'event_id', v_event_id,
    'equipment', to_jsonb(v_after)
  );
end;
$function$;

create or replace function public.sisha_resolve_location_conflict_atomic(
  p_equipment_id bigint,
  p_conflict_event_id bigint,
  p_resolution_event jsonb,
  p_decision text,
  p_reason text,
  p_user_email text default null
)
returns jsonb
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_equipment public.equipamentos_serializados%rowtype;
  v_conflict public.equipamento_eventos%rowtype;
  v_resolution public.equipamento_eventos%rowtype;
  v_resolution_id bigint;
  v_decision text := upper(btrim(coalesce(p_decision, '')));
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
  v_next_payload jsonb;
begin
  if v_decision not in ('CURRENT', 'CANDIDATE') then
    raise exception 'Decisão inválida. Use CURRENT ou CANDIDATE.';
  end if;
  if v_reason is null then
    raise exception 'Informe o motivo da reconciliação.';
  end if;

  select * into v_equipment
    from public.equipamentos_serializados
   where id = p_equipment_id
   for update;
  if not found then
    raise exception 'Equipamento não encontrado.';
  end if;

  select * into v_conflict
    from public.equipamento_eventos
   where id = p_conflict_event_id
     and equipamento_id = p_equipment_id
     and tipo_evento = 'CONFLITO_LOCALIZACAO'
   for update;
  if not found then
    raise exception 'Conflito de localização não encontrado.';
  end if;
  if coalesce(v_conflict.payload->>'conflito_status', '') <> 'PENDENTE' then
    raise exception 'Este conflito já foi reconciliado.';
  end if;

  v_resolution_id := public.sisha_insert_equipment_event_atomic(
    p_equipment_id,
    p_resolution_event,
    p_user_email
  );

  select * into v_resolution
    from public.equipamento_eventos
   where id = v_resolution_id;

  v_next_payload := coalesce(v_conflict.payload, '{}'::jsonb) || jsonb_build_object(
    'conflito_status', 'RESOLVIDO',
    'resolvido_em', now(),
    'resolvido_por', p_user_email,
    'decisao', v_decision,
    'motivo_resolucao', v_reason,
    'evento_resolucao_id', v_resolution_id
  );

  update public.equipamento_eventos
     set payload = v_next_payload,
         motivo_invalidacao = case when v_decision = 'CANDIDATE'
           then 'SUPERADO_POR_RECONCILIACAO'
           else 'DESCARTADO_POR_RECONCILIACAO'
         end,
         invalidado_por = p_user_email,
         invalidado_em = now()
   where id = v_conflict.id;

  select * into v_conflict
    from public.equipamento_eventos
   where id = v_conflict.id;

  select * into v_equipment
    from public.equipamentos_serializados
   where id = p_equipment_id;

  return jsonb_build_object(
    'equipment', to_jsonb(v_equipment),
    'conflict', to_jsonb(v_conflict),
    'resolution_event', to_jsonb(v_resolution)
  );
end;
$function$;

-- As novas RPCs não devem ficar expostas aos clientes browser.
revoke all on function public.sisha_insert_equipment_event_atomic(bigint, jsonb, text) from public;
revoke all on function public.sisha_insert_equipment_event_atomic(bigint, jsonb, text) from anon;
revoke all on function public.sisha_insert_equipment_event_atomic(bigint, jsonb, text) from authenticated;

revoke all on function public.sisha_create_equipment_atomic(jsonb, jsonb, text) from public;
revoke all on function public.sisha_create_equipment_atomic(jsonb, jsonb, text) from anon;
revoke all on function public.sisha_create_equipment_atomic(jsonb, jsonb, text) from authenticated;

revoke all on function public.sisha_update_equipment_atomic(bigint, jsonb, jsonb, text) from public;
revoke all on function public.sisha_update_equipment_atomic(bigint, jsonb, jsonb, text) from anon;
revoke all on function public.sisha_update_equipment_atomic(bigint, jsonb, jsonb, text) from authenticated;

revoke all on function public.sisha_resolve_location_conflict_atomic(bigint, bigint, jsonb, text, text, text) from public;
revoke all on function public.sisha_resolve_location_conflict_atomic(bigint, bigint, jsonb, text, text, text) from anon;
revoke all on function public.sisha_resolve_location_conflict_atomic(bigint, bigint, jsonb, text, text, text) from authenticated;

grant execute on function public.sisha_insert_equipment_event_atomic(bigint, jsonb, text) to service_role;
grant execute on function public.sisha_create_equipment_atomic(jsonb, jsonb, text) to service_role;
grant execute on function public.sisha_update_equipment_atomic(bigint, jsonb, jsonb, text) to service_role;
grant execute on function public.sisha_resolve_location_conflict_atomic(bigint, bigint, jsonb, text, text, text) to service_role;

insert into public.sisha_schema_migrations(version, description)
values (
  '20260813_H4B_001',
  'H4B: registry de migrations e RPCs ACID do núcleo de Equipamentos.'
)
on conflict (version) do update set description = excluded.description;

commit;
