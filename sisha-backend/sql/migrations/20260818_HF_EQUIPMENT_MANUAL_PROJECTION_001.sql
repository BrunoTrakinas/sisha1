-- SISHA1 V2 — HF Equipamentos: movimentação/correção manual projeta estado atual
-- Data: 2026-08-18
-- Mantém equipamento_eventos como Livro append-only e sincroniza a projeção atual.

begin;

create or replace function public.sisha_project_equipment_current_state(
  p_equipment_id bigint,
  p_user_email text default null
)
returns jsonb
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_equipment public.equipamentos_serializados%rowtype;
  v_event public.equipamento_eventos%rowtype;
  v_has_event boolean := false;
begin
  select * into v_equipment
    from public.equipamentos_serializados
   where id = p_equipment_id
   for update;
  if not found then
    raise exception 'Equipamento % não encontrado.', p_equipment_id;
  end if;

  select e.* into v_event
    from public.equipamento_eventos e
   where e.equipamento_id = p_equipment_id
     and coalesce(e.invalidado, false) = false
     and upper(coalesce(e.tipo_evento, '')) <> 'CONFLITO_LOCALIZACAO'
     and lower(coalesce(e.payload->>'historical_only', 'false')) <> 'true'
     and (
       lower(coalesce(e.payload->>'project_current_state', 'false')) = 'true'
       or nullif(btrim(coalesce(e.local_destino, '')), '') is not null
       or nullif(btrim(coalesce(e.anv_destino, e.anv, '')), '') is not null
       or upper(btrim(coalesce(e.categoria_destino, ''))) not in ('', 'DESCONHECIDO', 'DESCONHECIDA')
     )
   order by e.data_evento desc nulls last, e.id desc
   limit 1;
  v_has_event := found;

  if v_has_event then
    update public.equipamentos_serializados
       set categoria_local_atual = coalesce(nullif(upper(btrim(coalesce(v_event.categoria_destino, ''))), ''), 'DESCONHECIDO'),
           local_atual = nullif(btrim(coalesce(v_event.local_destino, '')), ''),
           anv_atual = nullif(btrim(coalesce(v_event.anv_destino, v_event.anv, '')), ''),
           status_atual = coalesce(nullif(btrim(coalesce(v_event.status_resultante, '')), ''), status_atual, 'DESCONHECIDO'),
           condicao_atual = coalesce(nullif(btrim(coalesce(v_event.condicao_resultante, '')), ''), condicao_atual, 'DESCONHECIDA'),
           confianca_localizacao = coalesce(nullif(upper(btrim(coalesce(v_event.confianca, ''))), ''), 'DESCONHECIDA'),
           atualizado_por = coalesce(nullif(btrim(coalesce(p_user_email, '')), ''), atualizado_por),
           updated_at = now()
     where id = p_equipment_id
     returning * into v_equipment;
  else
    update public.equipamentos_serializados
       set categoria_local_atual = 'DESCONHECIDO',
           local_atual = null,
           anv_atual = null,
           status_atual = 'DESCONHECIDO',
           condicao_atual = 'DESCONHECIDA',
           confianca_localizacao = 'DESCONHECIDA',
           atualizado_por = coalesce(nullif(btrim(coalesce(p_user_email, '')), ''), atualizado_por),
           updated_at = now()
     where id = p_equipment_id
     returning * into v_equipment;
  end if;

  return jsonb_build_object(
    'equipment', to_jsonb(v_equipment),
    'source_event_id', case when v_has_event then v_event.id else null end
  );
end;
$function$;

create or replace function public.sisha_record_equipment_event_and_project_atomic(
  p_equipment_id bigint,
  p_event jsonb,
  p_user_email text default null
)
returns jsonb
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_event_id bigint;
  v_projection jsonb;
begin
  v_event_id := public.sisha_insert_equipment_event_atomic(p_equipment_id, p_event, p_user_email);
  v_projection := public.sisha_project_equipment_current_state(p_equipment_id, p_user_email);
  return jsonb_build_object(
    'event_id', v_event_id,
    'equipment', v_projection->'equipment',
    'source_event_id', v_projection->'source_event_id'
  );
end;
$function$;

create or replace function public.sisha_create_equipment_and_project_atomic(
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
  v_result jsonb;
  v_projection jsonb;
  v_equipment_id bigint;
begin
  v_result := public.sisha_create_equipment_atomic(p_equipment, p_initial_event, p_user_email);
  v_equipment_id := nullif(v_result->>'equipment_id', '')::bigint;
  if v_equipment_id is null then
    raise exception 'Criação do equipamento não retornou equipment_id.';
  end if;
  if p_initial_event is not null then
    v_projection := public.sisha_project_equipment_current_state(v_equipment_id, p_user_email);
    v_result := v_result || jsonb_build_object(
      'equipment', v_projection->'equipment',
      'projection_source_event_id', v_projection->'source_event_id'
    );
  end if;
  return v_result;
end;
$function$;

create or replace function public.sisha_update_equipment_and_project_atomic(
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
  v_result jsonb;
  v_projection jsonb;
begin
  v_result := public.sisha_update_equipment_atomic(p_equipment_id, p_equipment, p_event, p_user_email);
  if p_event is not null then
    v_projection := public.sisha_project_equipment_current_state(p_equipment_id, p_user_email);
    v_result := v_result || jsonb_build_object(
      'equipment', v_projection->'equipment',
      'projection_source_event_id', v_projection->'source_event_id'
    );
  end if;
  return v_result;
end;
$function$;

create or replace function public.sisha_invalidate_equipment_event_and_project_atomic(
  p_equipment_id bigint,
  p_event_id bigint,
  p_reason text,
  p_user_email text default null
)
returns jsonb
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_event public.equipamento_eventos%rowtype;
  v_projection jsonb;
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
begin
  if v_reason is null then
    raise exception 'Informe o motivo da invalidação do evento.';
  end if;

  select * into v_event
    from public.equipamento_eventos
   where id = p_event_id
     and equipamento_id = p_equipment_id
   for update;
  if not found then
    raise exception 'Evento não encontrado para este equipamento.';
  end if;
  if coalesce(v_event.invalidado, false) then
    raise exception 'Este evento já está invalidado.';
  end if;

  update public.equipamento_eventos
     set invalidado = true,
         invalidado_em = now(),
         invalidado_por = nullif(btrim(coalesce(p_user_email, '')), ''),
         motivo_invalidacao = v_reason
   where id = p_event_id
     and equipamento_id = p_equipment_id;

  v_projection := public.sisha_project_equipment_current_state(p_equipment_id, p_user_email);
  return jsonb_build_object(
    'event_id', p_event_id,
    'equipment', v_projection->'equipment',
    'source_event_id', v_projection->'source_event_id'
  );
end;
$function$;

create or replace function public.sisha_resolve_location_conflict_and_project_atomic(
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
  v_result jsonb;
  v_projection jsonb;
begin
  v_result := public.sisha_resolve_location_conflict_atomic(
    p_equipment_id,
    p_conflict_event_id,
    p_resolution_event,
    p_decision,
    p_reason,
    p_user_email
  );
  v_projection := public.sisha_project_equipment_current_state(p_equipment_id, p_user_email);
  return v_result || jsonb_build_object(
    'equipment', v_projection->'equipment',
    'projection_source_event_id', v_projection->'source_event_id'
  );
end;
$function$;

revoke all on function public.sisha_project_equipment_current_state(bigint, text) from public, anon, authenticated;
revoke all on function public.sisha_create_equipment_and_project_atomic(jsonb, jsonb, text) from public, anon, authenticated;
revoke all on function public.sisha_record_equipment_event_and_project_atomic(bigint, jsonb, text) from public, anon, authenticated;
revoke all on function public.sisha_update_equipment_and_project_atomic(bigint, jsonb, jsonb, text) from public, anon, authenticated;
revoke all on function public.sisha_invalidate_equipment_event_and_project_atomic(bigint, bigint, text, text) from public, anon, authenticated;
revoke all on function public.sisha_resolve_location_conflict_and_project_atomic(bigint, bigint, jsonb, text, text, text) from public, anon, authenticated;

grant execute on function public.sisha_project_equipment_current_state(bigint, text) to service_role;
grant execute on function public.sisha_create_equipment_and_project_atomic(jsonb, jsonb, text) to service_role;
grant execute on function public.sisha_record_equipment_event_and_project_atomic(bigint, jsonb, text) to service_role;
grant execute on function public.sisha_update_equipment_and_project_atomic(bigint, jsonb, jsonb, text) to service_role;
grant execute on function public.sisha_invalidate_equipment_event_and_project_atomic(bigint, bigint, text, text) to service_role;
grant execute on function public.sisha_resolve_location_conflict_and_project_atomic(bigint, bigint, jsonb, text, text, text) to service_role;

insert into public.sisha_schema_migrations(version, description)
values ('20260818_HF_EQUIPMENT_MANUAL_PROJECTION_001', 'Movimentação/correção manual passa a recompor projeção atual do equipamento a partir do Livro de Eventos.')
on conflict (version) do nothing;

commit;
