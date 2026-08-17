-- SISHA1 V2 — A2 INSTALAÇÃO / REMOÇÃO PN+SN
-- Data: 2026-08-15
-- Objetivo:
-- 1) registrar intervalos operacionais PN+SN em aeronave sem criar segunda verdade de localização;
-- 2) vincular cada instalação a um contador de utilização auditável;
-- 3) classificar remoção como PANE, TESTE ou PRONTO_USO;
-- 4) deixar TESTE pendente até resultado humano e preparar evidência para A3;
-- 5) atualizar a projeção atual do equipamento de forma ACID com o Livro de Eventos.

begin;

do $check$
begin
  if to_regclass('public.equipamentos_serializados') is null then
    raise exception 'A2: Livro de Equipamentos ausente.';
  end if;
  if to_regclass('public.equipamento_eventos') is null then
    raise exception 'A2: Livro de Eventos ausente.';
  end if;
  if to_regclass('public.aircraft_running_log_snapshots') is null then
    raise exception 'A2: A1.2 não aplicado.';
  end if;
  if to_regclass('public.system_audit_logs') is null then
    raise exception 'A2: auditoria H3/H4 ausente.';
  end if;
  if to_regclass('public.sisha_schema_migrations') is null then
    raise exception 'A2: ledger de migrations ausente.';
  end if;
  if to_regprocedure('public.sisha_insert_equipment_event_atomic(bigint,jsonb,text)') is null then
    raise exception 'A2: H4B ACID do Livro de Equipamentos ausente.';
  end if;
end
$check$;

alter table public.equipamentos_serializados
  add column if not exists posicao_atual text,
  add column if not exists contador_utilizacao_atual text,
  add column if not exists metrica_utilizacao_atual text;

create table if not exists public.equipment_operational_intervals (
  id bigserial primary key,
  equipment_id bigint not null references public.equipamentos_serializados(id) on delete restrict,
  pn text not null,
  sn text not null,
  aircraft_code text not null check (aircraft_code ~ '^[0-9]{4}$'),
  position_code text not null check (length(btrim(position_code)) > 0),
  usage_counter text not null check (usage_counter in ('HORAS_DE_VOO','MOTOR_1','MOTOR_2','CICLOS','CALENDARIO')),
  usage_metric text,
  installed_at timestamptz not null,
  installation_event_id bigint not null references public.equipamento_eventos(id) on delete restrict,
  installation_document text,
  removed_at timestamptz,
  removal_event_id bigint references public.equipamento_eventos(id) on delete restrict,
  removal_reason text check (removal_reason is null or removal_reason in ('PANE','TESTE','PRONTO_USO')),
  test_result text check (test_result is null or test_result in ('PENDENTE','APROVADO','REPROVADO')),
  test_result_at timestamptz,
  test_result_event_id bigint references public.equipamento_eventos(id) on delete restrict,
  failure_status text not null default 'NONE' check (failure_status in ('NONE','PENDING_TEST','CONFIRMED')),
  repair_flow_status text not null default 'NOT_APPLICABLE' check (repair_flow_status in ('NOT_APPLICABLE','PENDING_DESTINATION','OPEN')),
  created_by text not null,
  closed_by text,
  updated_by text,
  operation_install_id uuid not null,
  operation_remove_id uuid,
  operation_test_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (removed_at is null or removed_at >= installed_at)
);

create unique index if not exists uq_equipment_operational_interval_open_equipment
  on public.equipment_operational_intervals (equipment_id)
  where removed_at is null;

create unique index if not exists uq_equipment_operational_interval_open_position
  on public.equipment_operational_intervals (aircraft_code, upper(btrim(position_code)))
  where removed_at is null;

create unique index if not exists uq_equipment_operational_interval_install_operation
  on public.equipment_operational_intervals (operation_install_id);

create unique index if not exists uq_equipment_operational_interval_remove_operation
  on public.equipment_operational_intervals (operation_remove_id)
  where operation_remove_id is not null;

create unique index if not exists uq_equipment_operational_interval_test_operation
  on public.equipment_operational_intervals (operation_test_id)
  where operation_test_id is not null;

create index if not exists idx_equipment_operational_intervals_aircraft
  on public.equipment_operational_intervals (aircraft_code, installed_at desc);
create index if not exists idx_equipment_operational_intervals_identity
  on public.equipment_operational_intervals (pn, sn, installed_at desc);

alter table public.equipment_operational_intervals enable row level security;

create or replace view public.v_sisha_a2_open_installations
with (security_invoker = true)
as
select
  i.*,
  e.nomenclatura,
  e.status_atual,
  e.condicao_atual,
  e.categoria_local_atual,
  e.local_atual,
  e.anv_atual
from public.equipment_operational_intervals i
join public.equipamentos_serializados e on e.id = i.equipment_id
where i.removed_at is null
  and coalesce(e.ativo, true) = true;

create or replace view public.v_sisha_a2_pending_tests
with (security_invoker = true)
as
select
  i.*,
  e.nomenclatura,
  e.status_atual,
  e.condicao_atual,
  e.categoria_local_atual,
  e.local_atual
from public.equipment_operational_intervals i
join public.equipamentos_serializados e on e.id = i.equipment_id
where i.removal_reason = 'TESTE'
  and i.test_result = 'PENDENTE'
  and coalesce(e.ativo, true) = true;

create or replace function public.sisha_a2_install_equipment_atomic(
  p_equipment_id bigint,
  p_aircraft_code text,
  p_position_code text,
  p_usage_counter text,
  p_usage_metric text,
  p_installed_at timestamptz,
  p_document text,
  p_observation text,
  p_operation_id uuid,
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
  v_interval public.equipment_operational_intervals%rowtype;
  v_event_id bigint;
  v_aircraft text := regexp_replace(upper(btrim(coalesce(p_aircraft_code,''))), '^N[- ]*', '');
  v_position text := upper(btrim(coalesce(p_position_code,'')));
  v_counter text := upper(btrim(coalesce(p_usage_counter,'')));
  v_metric text := lower(btrim(coalesce(p_usage_metric,'')));
  v_email text := lower(btrim(coalesce(p_actor_email,'')));
  v_role text := lower(btrim(coalesce(p_actor_role,'')));
  v_when timestamptz := coalesce(p_installed_at, now());
  v_event jsonb;
begin
  if v_role not in ('admin','dono') then raise exception 'A2: somente Admin/Dono pode instalar equipamento.'; end if;
  if v_email = '' then raise exception 'A2: ator autenticado obrigatório.'; end if;
  if p_operation_id is null then raise exception 'A2: operation_id obrigatório.'; end if;
  if v_aircraft !~ '^[0-9]{4}$' then raise exception 'A2: aeronave inválida.'; end if;
  if v_position = '' then raise exception 'A2: posição de instalação obrigatória.'; end if;
  if v_counter not in ('HORAS_DE_VOO','MOTOR_1','MOTOR_2','CICLOS','CALENDARIO') then raise exception 'A2: contador de utilização inválido.'; end if;
  if v_counter = 'CICLOS' and v_metric not in ('landings','rotor_stop_starts','engine_1_starts','engine_1_power_turbine_cycles','engine_1_gas_generator_cycles','engine_2_starts','engine_2_power_turbine_cycles','engine_2_gas_generator_cycles') then
    raise exception 'A2: CICLOS exige métrica auditável do A1.2.';
  end if;
  if v_counter = 'HORAS_DE_VOO' then v_metric := 'aircraft_hours'; end if;
  if v_counter = 'MOTOR_1' then v_metric := 'engine_1_hours'; end if;
  if v_counter = 'MOTOR_2' then v_metric := 'engine_2_hours'; end if;
  if v_counter = 'CALENDARIO' then v_metric := 'calendar'; end if;

  select * into v_interval
    from public.equipment_operational_intervals
   where operation_install_id = p_operation_id;
  if found then return jsonb_build_object('idempotent', true, 'interval', to_jsonb(v_interval)); end if;

  select * into v_equipment
    from public.equipamentos_serializados
   where id = p_equipment_id
   for update;
  if not found then raise exception 'A2: equipamento não encontrado.'; end if;
  if coalesce(v_equipment.ativo,true) = false then raise exception 'A2: equipamento arquivado não pode ser instalado.'; end if;
  if upper(coalesce(v_equipment.categoria_local_atual,'')) = 'AERONAVE' then raise exception 'A2: equipamento já está indicado como instalado em aeronave.'; end if;
  if upper(coalesce(v_equipment.condicao_atual,'')) in ('AVARIADO','EM_REPARO','AGUARDANDO_REPARO','QUARENTENA','AGUARDANDO_DESFAZIMENTO','EM_TESTE') then
    raise exception 'A2: condição atual do equipamento não permite instalação. Regularize/reconcilie a evidência antes de instalar.';
  end if;
  if exists(select 1 from public.equipment_operational_intervals where equipment_id = p_equipment_id and removed_at is null) then raise exception 'A2: já existe intervalo operacional aberto para este PN+SN.'; end if;
  if exists(select 1 from public.equipment_operational_intervals where aircraft_code = v_aircraft and upper(btrim(position_code)) = v_position and removed_at is null) then raise exception 'A2: a posição informada já possui outro PN+SN instalado.'; end if;

  v_event := jsonb_build_object(
    'tipo_evento','INSTALACAO_ANV',
    'data_evento',v_when,
    'anv_destino',v_aircraft,
    'categoria_destino','AERONAVE',
    'local_destino',format('AERONAVE %s / %s',v_aircraft,v_position),
    'status_resultante','INSTALADO',
    'condicao_resultante','INSTALADO',
    'documento_tipo','A2_INSTALACAO',
    'documento',nullif(btrim(coalesce(p_document,'')),''),
    'origem_evento','A2_OPERACAO',
    'origem_registro_id','A2:INSTALL:' || p_operation_id::text,
    'confianca','CONFIRMADA',
    'automatico',false,
    'motivo','Instalação PN+SN confirmada por Admin/Dono no A2.',
    'observacao',nullif(btrim(coalesce(p_observation,'')),''),
    'payload',jsonb_build_object('a2',jsonb_build_object(
      'operation_id',p_operation_id,
      'operation','INSTALL',
      'aircraft_code',v_aircraft,
      'position_code',v_position,
      'usage_counter',v_counter,
      'usage_metric',v_metric,
      'failure_status','NONE'
    ))
  );

  v_event_id := public.sisha_insert_equipment_event_atomic(v_equipment.id, v_event, v_email);

  insert into public.equipment_operational_intervals(
    equipment_id,pn,sn,aircraft_code,position_code,usage_counter,usage_metric,
    installed_at,installation_event_id,installation_document,created_by,operation_install_id
  ) values (
    v_equipment.id,v_equipment.pn,v_equipment.sn,v_aircraft,v_position,v_counter,v_metric,
    v_when,v_event_id,nullif(btrim(coalesce(p_document,'')),''),v_email,p_operation_id
  ) returning * into v_interval;

  update public.equipamentos_serializados
     set categoria_local_atual='AERONAVE',
         local_atual=format('AERONAVE %s / %s',v_aircraft,v_position),
         anv_atual=v_aircraft,
         posicao_atual=v_position,
         contador_utilizacao_atual=v_counter,
         metrica_utilizacao_atual=v_metric,
         status_atual='INSTALADO',
         condicao_atual='INSTALADO',
         confianca_localizacao='CONFIRMADA',
         atualizado_por=v_email,
         updated_at=now()
   where id=v_equipment.id;

  insert into public.system_audit_logs(actor_email,actor_role,action,entity,entity_id,summary,details,level,visibility)
  values(v_email,v_role,'A2_INSTALL','EQUIPMENT_OPERATIONAL_INTERVAL',v_interval.id::text,
    format('PN %s / SN %s instalado na aeronave %s posição %s.',v_equipment.pn,v_equipment.sn,v_aircraft,v_position),
    jsonb_build_object('equipment_id',v_equipment.id,'interval_id',v_interval.id,'event_id',v_event_id,'operation_id',p_operation_id,'usage_counter',v_counter,'usage_metric',v_metric),
    'INFO','GOD');

  return jsonb_build_object('idempotent',false,'interval',to_jsonb(v_interval),'event_id',v_event_id);
end;
$function$;

create or replace function public.sisha_a2_remove_equipment_atomic(
  p_equipment_id bigint,
  p_removal_reason text,
  p_removed_at timestamptz,
  p_destination_category text,
  p_destination_location text,
  p_document text,
  p_observation text,
  p_operation_id uuid,
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
  v_interval public.equipment_operational_intervals%rowtype;
  v_event_id bigint;
  v_reason text := upper(btrim(coalesce(p_removal_reason,'')));
  v_when timestamptz := coalesce(p_removed_at,now());
  v_category text := upper(btrim(coalesce(p_destination_category,'')));
  v_location text := nullif(btrim(coalesce(p_destination_location,'')),'');
  v_email text := lower(btrim(coalesce(p_actor_email,'')));
  v_role text := lower(btrim(coalesce(p_actor_role,'')));
  v_failure text;
  v_repair text;
  v_condition text;
  v_status text;
  v_test text;
  v_event jsonb;
begin
  if v_role not in ('admin','dono') then raise exception 'A2: somente Admin/Dono pode remover equipamento.'; end if;
  if v_email = '' then raise exception 'A2: ator autenticado obrigatório.'; end if;
  if p_operation_id is null then raise exception 'A2: operation_id obrigatório.'; end if;
  if v_reason not in ('PANE','TESTE','PRONTO_USO') then raise exception 'A2: motivo de remoção deve ser PANE, TESTE ou PRONTO_USO.'; end if;

  select * into v_interval from public.equipment_operational_intervals where operation_remove_id = p_operation_id;
  if found then return jsonb_build_object('idempotent',true,'interval',to_jsonb(v_interval)); end if;

  select * into v_equipment from public.equipamentos_serializados where id=p_equipment_id for update;
  if not found then raise exception 'A2: equipamento não encontrado.'; end if;

  select * into v_interval
    from public.equipment_operational_intervals
   where equipment_id=p_equipment_id and removed_at is null
   for update;
  if not found then raise exception 'A2: não existe instalação A2 aberta para este PN+SN.'; end if;
  if v_when < v_interval.installed_at then raise exception 'A2: remoção não pode ocorrer antes da instalação.'; end if;

  if v_reason='PANE' then
    v_failure:='CONFIRMED'; v_repair:='PENDING_DESTINATION'; v_condition:='AVARIADO'; v_status:='REMOVIDO_PANE'; v_test:=null;
  elsif v_reason='TESTE' then
    v_failure:='PENDING_TEST'; v_repair:='NOT_APPLICABLE'; v_condition:='EM_TESTE'; v_status:='REMOVIDO_TESTE'; v_test:='PENDENTE';
  else
    v_failure:='NONE'; v_repair:='NOT_APPLICABLE'; v_condition:='PRONTO_USO'; v_status:='REMOVIDO_PRONTO_USO'; v_test:=null;
  end if;
  if v_category='' then v_category:='DESCONHECIDO'; end if;

  v_event:=jsonb_build_object(
    'tipo_evento','REMOCAO_ANV','data_evento',v_when,
    'categoria_destino',v_category,'local_destino',v_location,'anv_destino',null,
    'status_resultante',v_status,'condicao_resultante',v_condition,
    'documento_tipo','A2_REMOCAO','documento',nullif(btrim(coalesce(p_document,'')),''),
    'origem_evento','A2_OPERACAO','origem_registro_id','A2:REMOVE:' || p_operation_id::text,
    'confianca','CONFIRMADA','automatico',false,
    'motivo',case v_reason when 'PANE' then 'Remoção por PANE confirmada no A2.' when 'TESTE' then 'Remoção para TESTE; falha ainda não confirmada.' else 'Remoção em condição PRONTO USO; não caracteriza falha.' end,
    'observacao',nullif(btrim(coalesce(p_observation,'')),''),
    'payload',jsonb_build_object('a2',jsonb_build_object(
      'operation_id',p_operation_id,'operation','REMOVE','interval_id',v_interval.id,
      'aircraft_code',v_interval.aircraft_code,'position_code',v_interval.position_code,
      'usage_counter',v_interval.usage_counter,'usage_metric',v_interval.usage_metric,
      'removal_reason',v_reason,'test_result',v_test,'failure_status',v_failure,
      'failure_effective_at',case when v_failure='CONFIRMED' then v_when else null end,
      'repair_flow_status',v_repair
    ))
  );

  v_event_id:=public.sisha_insert_equipment_event_atomic(v_equipment.id,v_event,v_email);

  update public.equipment_operational_intervals
     set removed_at=v_when,removal_event_id=v_event_id,removal_reason=v_reason,test_result=v_test,
         failure_status=v_failure,repair_flow_status=v_repair,closed_by=v_email,updated_by=v_email,
         operation_remove_id=p_operation_id,updated_at=now()
   where id=v_interval.id
   returning * into v_interval;

  update public.equipamentos_serializados
     set categoria_local_atual=v_category,local_atual=v_location,anv_atual=null,posicao_atual=null,
         contador_utilizacao_atual=null,metrica_utilizacao_atual=null,
         status_atual=v_status,condicao_atual=v_condition,confianca_localizacao='CONFIRMADA',
         atualizado_por=v_email,updated_at=now()
   where id=v_equipment.id;

  insert into public.system_audit_logs(actor_email,actor_role,action,entity,entity_id,summary,details,level,visibility)
  values(v_email,v_role,'A2_REMOVE','EQUIPMENT_OPERATIONAL_INTERVAL',v_interval.id::text,
    format('PN %s / SN %s removido da aeronave %s por %s.',v_equipment.pn,v_equipment.sn,v_interval.aircraft_code,v_reason),
    jsonb_build_object('equipment_id',v_equipment.id,'interval_id',v_interval.id,'event_id',v_event_id,'operation_id',p_operation_id,'removal_reason',v_reason,'failure_status',v_failure),
    'INFO','GOD');

  return jsonb_build_object('idempotent',false,'interval',to_jsonb(v_interval),'event_id',v_event_id);
end;
$function$;

create or replace function public.sisha_a2_resolve_test_result_atomic(
  p_interval_id bigint,
  p_test_result text,
  p_result_at timestamptz,
  p_destination_category text,
  p_destination_location text,
  p_document text,
  p_observation text,
  p_operation_id uuid,
  p_actor_email text,
  p_actor_role text
)
returns jsonb
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_interval public.equipment_operational_intervals%rowtype;
  v_equipment public.equipamentos_serializados%rowtype;
  v_result text:=upper(btrim(coalesce(p_test_result,'')));
  v_when timestamptz:=coalesce(p_result_at,now());
  v_category text:=upper(btrim(coalesce(p_destination_category,'')));
  v_location text:=nullif(btrim(coalesce(p_destination_location,'')),'');
  v_email text:=lower(btrim(coalesce(p_actor_email,'')));
  v_role text:=lower(btrim(coalesce(p_actor_role,'')));
  v_failure text;
  v_repair text;
  v_condition text;
  v_status text;
  v_event_id bigint;
  v_event jsonb;
begin
  if v_role not in ('admin','dono') then raise exception 'A2: somente Admin/Dono pode concluir TESTE.'; end if;
  if v_email='' then raise exception 'A2: ator autenticado obrigatório.'; end if;
  if p_operation_id is null then raise exception 'A2: operation_id obrigatório.'; end if;
  if v_result not in ('APROVADO','REPROVADO') then raise exception 'A2: resultado deve ser APROVADO ou REPROVADO.'; end if;

  select * into v_interval from public.equipment_operational_intervals where operation_test_id=p_operation_id;
  if found then return jsonb_build_object('idempotent',true,'interval',to_jsonb(v_interval)); end if;

  select * into v_interval from public.equipment_operational_intervals where id=p_interval_id for update;
  if not found then raise exception 'A2: intervalo operacional não encontrado.'; end if;
  if v_interval.removal_reason<>'TESTE' or v_interval.test_result<>'PENDENTE' then raise exception 'A2: este intervalo não possui TESTE pendente.'; end if;
  if v_when < coalesce(v_interval.removed_at,v_interval.installed_at) then raise exception 'A2: resultado do teste não pode anteceder a remoção.'; end if;

  select * into v_equipment from public.equipamentos_serializados where id=v_interval.equipment_id for update;
  if not found then raise exception 'A2: equipamento não encontrado.'; end if;

  if v_result='REPROVADO' then
    v_failure:='CONFIRMED'; v_repair:='PENDING_DESTINATION'; v_condition:='AVARIADO'; v_status:='TESTE_REPROVADO';
  else
    v_failure:='NONE'; v_repair:='NOT_APPLICABLE'; v_condition:='PRONTO_USO'; v_status:='TESTE_APROVADO';
  end if;
  if v_category='' then v_category:=coalesce(nullif(upper(btrim(coalesce(v_equipment.categoria_local_atual,''))),''),'DESCONHECIDO'); end if;
  if v_location is null then v_location:=v_equipment.local_atual; end if;

  v_event:=jsonb_build_object(
    'tipo_evento','A2_RESULTADO_TESTE','data_evento',v_when,
    'categoria_destino',v_category,'local_destino',v_location,
    'status_resultante',v_status,'condicao_resultante',v_condition,
    'documento_tipo','A2_TESTE','documento',nullif(btrim(coalesce(p_document,'')),''),
    'origem_evento','A2_OPERACAO','origem_registro_id','A2:TEST:' || p_operation_id::text,
    'confianca','CONFIRMADA','automatico',false,
    'motivo',case when v_result='REPROVADO' then 'Teste reprovado: falha confirmada após remoção para teste.' else 'Teste aprovado: remoção não caracterizada como falha.' end,
    'observacao',nullif(btrim(coalesce(p_observation,'')),''),
    'payload',jsonb_build_object('a2',jsonb_build_object(
      'operation_id',p_operation_id,'operation','TEST_RESULT','interval_id',v_interval.id,
      'test_result',v_result,'failure_status',v_failure,
      'failure_effective_at',case when v_failure='CONFIRMED' then v_interval.removed_at else null end,
      'repair_flow_status',v_repair
    ))
  );
  v_event_id:=public.sisha_insert_equipment_event_atomic(v_equipment.id,v_event,v_email);

  update public.equipment_operational_intervals
     set test_result=v_result,test_result_at=v_when,test_result_event_id=v_event_id,
         failure_status=v_failure,repair_flow_status=v_repair,updated_by=v_email,
         operation_test_id=p_operation_id,updated_at=now()
   where id=v_interval.id returning * into v_interval;

  update public.equipamentos_serializados
     set categoria_local_atual=v_category,local_atual=v_location,status_atual=v_status,condicao_atual=v_condition,
         confianca_localizacao='CONFIRMADA',atualizado_por=v_email,updated_at=now()
   where id=v_equipment.id;

  insert into public.system_audit_logs(actor_email,actor_role,action,entity,entity_id,summary,details,level,visibility)
  values(v_email,v_role,'A2_TEST_RESULT','EQUIPMENT_OPERATIONAL_INTERVAL',v_interval.id::text,
    format('Resultado %s para PN %s / SN %s após remoção para TESTE.',v_result,v_equipment.pn,v_equipment.sn),
    jsonb_build_object('equipment_id',v_equipment.id,'interval_id',v_interval.id,'event_id',v_event_id,'operation_id',p_operation_id,'test_result',v_result,'failure_status',v_failure),
    'INFO','GOD');

  return jsonb_build_object('idempotent',false,'interval',to_jsonb(v_interval),'event_id',v_event_id);
end;
$function$;

revoke all on function public.sisha_a2_install_equipment_atomic(bigint,text,text,text,text,timestamptz,text,text,uuid,text,text) from public;
revoke all on function public.sisha_a2_install_equipment_atomic(bigint,text,text,text,text,timestamptz,text,text,uuid,text,text) from anon;
revoke all on function public.sisha_a2_install_equipment_atomic(bigint,text,text,text,text,timestamptz,text,text,uuid,text,text) from authenticated;
revoke all on function public.sisha_a2_remove_equipment_atomic(bigint,text,timestamptz,text,text,text,text,uuid,text,text) from public;
revoke all on function public.sisha_a2_remove_equipment_atomic(bigint,text,timestamptz,text,text,text,text,uuid,text,text) from anon;
revoke all on function public.sisha_a2_remove_equipment_atomic(bigint,text,timestamptz,text,text,text,text,uuid,text,text) from authenticated;
revoke all on function public.sisha_a2_resolve_test_result_atomic(bigint,text,timestamptz,text,text,text,text,uuid,text,text) from public;
revoke all on function public.sisha_a2_resolve_test_result_atomic(bigint,text,timestamptz,text,text,text,text,uuid,text,text) from anon;
revoke all on function public.sisha_a2_resolve_test_result_atomic(bigint,text,timestamptz,text,text,text,text,uuid,text,text) from authenticated;
grant execute on function public.sisha_a2_install_equipment_atomic(bigint,text,text,text,text,timestamptz,text,text,uuid,text,text) to service_role;
grant execute on function public.sisha_a2_remove_equipment_atomic(bigint,text,timestamptz,text,text,text,text,uuid,text,text) to service_role;
grant execute on function public.sisha_a2_resolve_test_result_atomic(bigint,text,timestamptz,text,text,text,text,uuid,text,text) to service_role;

insert into public.sisha_schema_migrations(version,description)
values('20260815_A2_001','A2: instalação/remoção PN+SN, intervalos de utilização e resultado de teste com evidência auditável.')
on conflict(version) do update set description=excluded.description;

commit;
