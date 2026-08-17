-- SISHA1 V2 — MASTER OS: histórico oficial + orquestração segura de equipamentos
-- Data: 2026-08-16
-- Fonte: Divisão de Planejamento (abertura, acompanhamento, fechamento/cancelamento de OS)
-- Regras:
-- 1) ausência em snapshot posterior nunca apaga/regride evidência positiva;
-- 2) OS ABERTA = intenção/escrituração, sem movimentação física automática;
-- 3) OS CANCELADA = intenção preservada, sem movimentação física automática;
-- 4) OS FECHADA = pode confirmar movimentação somente com ação + identidade PN/SN + destino inequívocos;
-- 5) equipamento_eventos continua sendo o ledger físico compartilhado com PPU/PIM/STC/WO/Recibos.

begin;

do $check$
begin
  if to_regclass('public.sisha_schema_migrations') is null then
    raise exception 'MASTER OS: ledger de migrations ausente.';
  end if;
  if to_regclass('public.system_audit_logs') is null then
    raise exception 'MASTER OS: auditoria H3/H4 ausente.';
  end if;
  if to_regclass('public.equipamentos_serializados') is null or to_regclass('public.equipamento_eventos') is null then
    raise exception 'MASTER OS: Livro de Equipamentos ausente.';
  end if;
  if to_regclass('public.equipment_operational_intervals') is null then
    raise exception 'MASTER OS: A2 (intervalos de instalação/remoção) ausente.';
  end if;
end
$check$;

create table if not exists public.os_master_evidencias (
  id bigserial primary key,
  os_numero text not null,
  os_numero_normalizado text not null check (length(btrim(os_numero_normalizado)) > 0),
  os_ano integer not null check (os_ano between 2000 and 2200),
  dominio_tipo text not null default 'OUTROS',
  dominio_codigo text,
  dominio_descricao text,
  dominio_historico boolean not null default false,
  fonte_dominio text,
  data_abertura date,
  situacao text,
  destino text,
  descricao text,
  data_fechamento date,
  responsavel text,
  tipo_inspecao text,
  pane text,
  hora_abertura numeric,
  hora_fechamento numeric,
  horas_total numeric,
  hv_total numeric,
  status_evidencia text not null check (status_evidencia in ('ABERTA','FECHADA','CANCELADA')),
  cronologia_consistente boolean not null default true,
  movimento_tipo text check (movimento_tipo is null or movimento_tipo in ('REMOCAO','INSTALACAO','AMBIGUO')),
  movimento_estado text not null default 'NAO_APLICAVEL',
  movimento_payload jsonb not null default '{}'::jsonb,
  source_file_name text not null,
  source_sha256 text not null check (source_sha256 ~ '^[0-9a-f]{64}$'),
  source_sheet text not null,
  source_row integer not null check (source_row > 0),
  source_payload jsonb not null default '{}'::jsonb,
  imported_by text,
  imported_at timestamptz not null default now(),
  invalidado boolean not null default false,
  invalidado_em timestamptz,
  invalidado_por text,
  motivo_invalidacao text
);

create unique index if not exists uq_os_master_evidencia_source
  on public.os_master_evidencias (source_sha256, source_sheet, source_row);
create index if not exists idx_os_master_identidade
  on public.os_master_evidencias (os_numero_normalizado, os_ano, imported_at desc);
create index if not exists idx_os_master_dominio
  on public.os_master_evidencias (dominio_tipo, dominio_codigo, os_ano);
create index if not exists idx_os_master_status
  on public.os_master_evidencias (status_evidencia, os_ano, data_abertura desc);
create index if not exists idx_os_master_movimento
  on public.os_master_evidencias (movimento_estado, movimento_tipo, os_ano);

alter table public.os_master_evidencias enable row level security;

-- Read model monotônico por identidade OS+ano.
-- ABERTA nunca supera uma evidência terminal FECHADA/CANCELADA já comprovada.
-- Entre duas evidências terminais divergentes, prevalece a evidência terminal mais
-- recente; o histórico bruto continua preservado para auditoria/correção.
create or replace view public.v_sisha_os_historico_atual
with (security_invoker = true)
as
with valid as (
  select *
  from public.os_master_evidencias
  where coalesce(invalidado, false) = false
), aggregated as (
  select
    os_numero_normalizado,
    os_ano,
    min(data_abertura) filter (where data_abertura is not null) as primeira_abertura,
    max(data_fechamento) filter (where data_fechamento is not null) as ultima_fechamento,
    count(*)::bigint as evidencias_total,
    count(distinct source_sha256)::bigint as arquivos_total
  from valid
  group by os_numero_normalizado, os_ano
), ranked as (
  select
    v.*,
    row_number() over (
      partition by v.os_numero_normalizado, v.os_ano
      order by
        case when v.status_evidencia in ('FECHADA','CANCELADA') then 2 else 1 end desc,
        coalesce(v.data_fechamento, v.data_abertura) desc nulls last,
        v.imported_at desc,
        v.id desc
    ) as rn
  from valid v
)
select
  r.id as evidencia_atual_id,
  r.os_numero,
  r.os_numero_normalizado,
  r.os_ano,
  r.dominio_tipo,
  r.dominio_codigo,
  r.dominio_descricao,
  r.dominio_historico,
  r.fonte_dominio,
  a.primeira_abertura as data_abertura,
  r.situacao,
  r.destino,
  r.descricao,
  a.ultima_fechamento as data_fechamento,
  r.responsavel,
  r.tipo_inspecao,
  r.pane,
  r.status_evidencia as status,
  r.cronologia_consistente,
  r.movimento_tipo,
  r.movimento_estado,
  r.movimento_payload,
  a.evidencias_total,
  a.arquivos_total,
  r.source_file_name as ultima_fonte_positiva,
  r.source_sha256 as ultima_fonte_sha256,
  r.source_sheet as ultima_fonte_aba,
  r.source_row as ultima_fonte_linha,
  r.imported_at as ultima_importacao
from ranked r
join aggregated a using (os_numero_normalizado, os_ano)
where r.rn = 1;


-- Aplica somente movimentação física confirmada por OS FECHADA.
-- A função é ACID e idempotente, preserva a origem oficial da OS, protege
-- evidência física temporalmente mais nova e mantém A2 coerente quando existe
-- um intervalo aberto de remoção. Instalação sem posição/contador NÃO fabrica
-- um novo intervalo A2: a localização é confirmada, mas A3 continua fail-closed
-- até existir cobertura operacional suficiente.
create or replace function public.sisha_apply_master_os_movement_atomic(
  p_equipment_id bigint,
  p_event jsonb,
  p_actor_email text,
  p_actor_role text
)
returns jsonb
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_equipment public.equipamentos_serializados%rowtype;
  v_latest public.equipamento_eventos%rowtype;
  v_interval public.equipment_operational_intervals%rowtype;
  v_event_id bigint;
  v_existing_event_id bigint;
  v_email text := lower(btrim(coalesce(p_actor_email,'')));
  v_role text := lower(btrim(coalesce(p_actor_role,'')));
  v_type text := upper(btrim(coalesce(p_event->>'tipo_evento','')));
  v_when timestamptz := coalesce(nullif(p_event->>'data_evento','')::timestamptz, now());
  v_source_key text := nullif(btrim(coalesce(p_event->>'origem_registro_id','')), '');
  v_dest_category text := upper(btrim(coalesce(p_event->>'categoria_destino','')));
  v_dest_location text := nullif(btrim(coalesce(p_event->>'local_destino','')), '');
  v_dest_aircraft text := nullif(regexp_replace(upper(btrim(coalesce(p_event->>'anv_destino',''))), '^N[- ]*', ''), '');
  v_source_aircraft text := nullif(regexp_replace(upper(btrim(coalesce(p_event->>'source_aircraft',''))), '^N[- ]*', ''), '');
  v_source_category text := upper(btrim(coalesce(p_event->>'categoria_origem','')));
  v_source_location text := nullif(btrim(coalesce(p_event->>'local_origem','')), '');
  v_status text;
  v_condition text;
  v_payload jsonb;
  v_same boolean := false;
  v_historical boolean := false;
  v_has_interval boolean := false;
  v_close_interval boolean := false;
  v_event_anv text;
begin
  if v_role not in ('admin','dono') then
    raise exception 'MASTER OS: somente Admin/Dono pode aplicar movimentação confirmada.';
  end if;
  if v_email = '' then raise exception 'MASTER OS: ator autenticado obrigatório.'; end if;
  if p_equipment_id is null then raise exception 'MASTER OS: equipment_id obrigatório.'; end if;
  if p_event is null or jsonb_typeof(p_event) <> 'object' then raise exception 'MASTER OS: evento inválido.'; end if;
  if v_type not in ('INSTALACAO_ANV','REMOCAO_ANV') then raise exception 'MASTER OS: movimento físico inválido.'; end if;
  if v_source_key is null then raise exception 'MASTER OS: origem_registro_id obrigatório para idempotência.'; end if;
  if v_dest_category = '' or (v_dest_location is null and v_dest_aircraft is null) then
    raise exception 'MASTER OS: destino físico inequívoco obrigatório.';
  end if;

  select * into v_equipment
    from public.equipamentos_serializados
   where id = p_equipment_id
   for update;
  if not found then raise exception 'MASTER OS: equipamento não encontrado.'; end if;
  if coalesce(v_equipment.ativo,true) = false then raise exception 'MASTER OS: equipamento arquivado não pode receber movimentação automática.'; end if;

  select id into v_existing_event_id
    from public.equipamento_eventos
   where origem_evento = 'MASTER_OS'
     and origem_registro_id = v_source_key
   limit 1;
  if found then
    return jsonb_build_object(
      'action','IDEMPOTENT',
      'event_id',v_existing_event_id,
      'equipment_id',v_equipment.id,
      'a2_interval_closed',false
    );
  end if;

  select * into v_latest
    from public.equipamento_eventos
   where equipamento_id = v_equipment.id
     and coalesce(invalidado,false) = false
     and (
       nullif(btrim(coalesce(local_destino,'')),'') is not null
       or nullif(btrim(coalesce(anv_destino,'')),'') is not null
       or upper(btrim(coalesce(categoria_destino,''))) not in ('','DESCONHECIDO')
     )
   order by data_evento desc, id desc
   limit 1;
  if found and v_latest.data_evento > v_when then v_historical := true; end if;

  select * into v_interval
    from public.equipment_operational_intervals
   where equipment_id = v_equipment.id
     and removed_at is null
   order by installed_at desc, id desc
   limit 1
   for update;
  v_has_interval := found;

  -- Um A2 aberto é evidência manual/operacional mais detalhada. O Master pode
  -- corroborá-lo ou fechar uma remoção da mesma aeronave, mas não inventa a
  -- transição intermediária se ambos apontarem aeronaves diferentes.
  if not v_historical and v_has_interval and v_type = 'INSTALACAO_ANV' then
    if upper(btrim(v_interval.aircraft_code)) <> coalesce(v_dest_aircraft,'') then
      return jsonb_build_object(
        'action','A2_INTERVAL_CONFLICT',
        'equipment_id',v_equipment.id,
        'interval_id',v_interval.id,
        'reason',format('A2 mantém PN+SN instalado na aeronave %s, enquanto a OS fechada indica instalação na aeronave %s.',v_interval.aircraft_code,coalesce(v_dest_aircraft,'?'))
      );
    end if;
  end if;

  if not v_historical and v_has_interval and v_type = 'REMOCAO_ANV' then
    if v_source_aircraft is null or upper(btrim(v_interval.aircraft_code)) <> v_source_aircraft then
      return jsonb_build_object(
        'action','A2_INTERVAL_CONFLICT',
        'equipment_id',v_equipment.id,
        'interval_id',v_interval.id,
        'reason',format('A2 mantém PN+SN instalado na aeronave %s, enquanto a OS fechada de remoção pertence à aeronave %s.',v_interval.aircraft_code,coalesce(v_source_aircraft,'?'))
      );
    end if;
    if v_when < v_interval.installed_at then
      v_historical := true;
    else
      v_close_interval := true;
    end if;
  end if;

  v_status := coalesce(nullif(btrim(coalesce(p_event->>'status_resultante','')), ''), v_equipment.status_atual, 'DESCONHECIDO');
  v_condition := coalesce(nullif(btrim(coalesce(p_event->>'condicao_resultante','')), ''), v_equipment.condicao_atual, 'DESCONHECIDA');
  v_event_anv := case when v_type = 'REMOCAO_ANV' then v_source_aircraft else v_dest_aircraft end;

  v_same :=
    upper(btrim(coalesce(v_equipment.categoria_local_atual,''))) = v_dest_category
    and upper(btrim(coalesce(v_equipment.local_atual,''))) = upper(btrim(coalesce(v_dest_location,'')))
    and upper(btrim(coalesce(v_equipment.anv_atual,''))) = upper(btrim(coalesce(v_dest_aircraft,'')));

  -- Quando o A2 já possui a mesma instalação com posição/counter mais precisos,
  -- o Master apenas corrobora e não degrada essa precisão para "AERONAVE XXXX".
  if not v_historical and v_type = 'INSTALACAO_ANV' and v_has_interval
     and upper(btrim(v_interval.aircraft_code)) = coalesce(v_dest_aircraft,'') then
    v_same := true;
  end if;

  v_payload := case when jsonb_typeof(p_event->'payload') = 'object' then p_event->'payload' else '{}'::jsonb end;
  v_payload := v_payload || jsonb_build_object(
    'master_os_atomic',true,
    'historical_only',v_historical,
    'projection_before',jsonb_build_object(
      'categoria_local_atual',v_equipment.categoria_local_atual,
      'local_atual',v_equipment.local_atual,
      'anv_atual',v_equipment.anv_atual,
      'status_atual',v_equipment.status_atual,
      'condicao_atual',v_equipment.condicao_atual
    ),
    'latest_valid_location_event_id',case when v_latest.id is null then null else v_latest.id end,
    'a2_open_interval_id',case when v_has_interval then v_interval.id else null end
  );

  insert into public.equipamento_eventos (
    equipamento_id,pn,sn,tipo_evento,data_evento,pim,os,anv,horas_evento,
    local_origem,local_destino,categoria_origem,categoria_destino,
    status_resultante,condicao_resultante,anv_destino,motivo,documento_tipo,documento,
    observacao,usuario,origem_evento,origem_registro_id,confianca,automatico,invalidado,payload
  ) values (
    v_equipment.id,v_equipment.pn,v_equipment.sn,v_type,v_when,
    nullif(btrim(coalesce(p_event->>'pim','')),''),
    nullif(btrim(coalesce(p_event->>'os','')),''),
    v_event_anv,nullif(p_event->>'horas_evento','')::numeric,
    coalesce(v_source_location,v_equipment.local_atual),v_dest_location,
    coalesce(nullif(v_source_category,''),v_equipment.categoria_local_atual),v_dest_category,
    v_status,v_condition,v_dest_aircraft,
    coalesce(nullif(btrim(coalesce(p_event->>'motivo','')),''),'MASTER OS fechada confirma movimentação física.'),
    'MASTER_OS',nullif(btrim(coalesce(p_event->>'documento','')),''),
    nullif(btrim(coalesce(p_event->>'observacao','')),''),v_email,
    'MASTER_OS',v_source_key,'CONFIRMADA',true,false,v_payload
  )
  returning id into v_event_id;

  if v_historical then
    return jsonb_build_object(
      'action','HISTORICAL_EVENT','event_id',v_event_id,'equipment_id',v_equipment.id,
      'latest_valid_location_event_id',v_latest.id,'a2_interval_closed',false
    );
  end if;

  if v_same and not v_close_interval then
    return jsonb_build_object(
      'action',case when v_has_interval and v_type='INSTALACAO_ANV' then 'A2_CORROBORATED' else 'SAME_LOCATION' end,
      'event_id',v_event_id,'equipment_id',v_equipment.id,'a2_interval_closed',false
    );
  end if;

  update public.equipamentos_serializados
     set categoria_local_atual = v_dest_category,
         local_atual = v_dest_location,
         anv_atual = v_dest_aircraft,
         posicao_atual = null,
         contador_utilizacao_atual = null,
         metrica_utilizacao_atual = null,
         status_atual = v_status,
         condicao_atual = v_condition,
         confianca_localizacao = 'CONFIRMADA',
         atualizado_por = v_email,
         updated_at = now()
   where id = v_equipment.id;

  if v_close_interval then
    update public.equipment_operational_intervals
       set removed_at = v_when,
           removal_event_id = v_event_id,
           removal_reason = null,
           test_result = null,
           failure_status = 'NONE',
           repair_flow_status = 'NOT_APPLICABLE',
           closed_by = v_email,
           updated_by = v_email,
           updated_at = now()
     where id = v_interval.id;
  end if;

  insert into public.system_audit_logs(actor_email,actor_role,action,entity,entity_id,summary,details,level,visibility)
  values(
    v_email,v_role,'MASTER_OS_MOVEMENT_APPLIED','EQUIPMENT',v_equipment.id::text,
    format('Master OS fechada confirmou %s do PN %s / SN %s para %s.',v_type,v_equipment.pn,v_equipment.sn,coalesce(v_dest_location,v_dest_aircraft,'destino conhecido')),
    jsonb_build_object(
      'event_id',v_event_id,'source_key',v_source_key,'event_time',v_when,
      'destination_category',v_dest_category,'destination_location',v_dest_location,
      'destination_aircraft',v_dest_aircraft,'source_aircraft',v_source_aircraft,
      'a2_interval_closed',v_close_interval,'a2_interval_id',case when v_close_interval then v_interval.id else null end
    ),
    'INFO','GOD'
  );

  return jsonb_build_object(
    'action','EVENT_APPLIED','event_id',v_event_id,'equipment_id',v_equipment.id,
    'a2_interval_closed',v_close_interval,
    'a2_interval_id',case when v_close_interval then v_interval.id else null end
  );
end;
$function$;

revoke all on function public.sisha_apply_master_os_movement_atomic(bigint,jsonb,text,text) from public;
revoke all on function public.sisha_apply_master_os_movement_atomic(bigint,jsonb,text,text) from anon;
revoke all on function public.sisha_apply_master_os_movement_atomic(bigint,jsonb,text,text) from authenticated;
revoke all on function public.sisha_apply_master_os_movement_atomic(bigint,jsonb,text,text) from service_role;
grant execute on function public.sisha_apply_master_os_movement_atomic(bigint,jsonb,text,text) to service_role;

revoke all on table public.os_master_evidencias from public;
revoke all on table public.os_master_evidencias from anon;
revoke all on table public.os_master_evidencias from authenticated;
revoke all on table public.os_master_evidencias from service_role;
grant select, insert, update on table public.os_master_evidencias to service_role;
grant usage, select on sequence public.os_master_evidencias_id_seq to service_role;

revoke all on table public.v_sisha_os_historico_atual from public;
revoke all on table public.v_sisha_os_historico_atual from anon;
revoke all on table public.v_sisha_os_historico_atual from authenticated;
revoke all on table public.v_sisha_os_historico_atual from service_role;
grant select on table public.v_sisha_os_historico_atual to service_role;

insert into public.sisha_schema_migrations(version, description)
values(
  '20260816_HF_MASTER_OS_001',
  'Master OS: histórico oficial append-only + orquestração ACID. Aberta=intenção, Cancelada=registro sem movimento, Fechada confirma localização/movimento apenas com PN/SN/ação/destino inequívocos; protege evidência mais nova e compatibiliza A2 sem fabricar posição/contador.'
)
on conflict(version) do update set description = excluded.description;

commit;
