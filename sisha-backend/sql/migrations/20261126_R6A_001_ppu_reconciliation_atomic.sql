-- R6A: transactional reconciliation of non-serialized PPU inventory.
-- Draft only. Do not install until R6B SQL integration and R7 UI gates are approved.
begin;

create function public.sisha_ppu_r6_context() returns jsonb
language plpgsql stable security invoker set search_path=pg_catalog set timezone='UTC'
as $$
declare
  s public.ppu_inventario_snapshots%rowtype;
  v_rows jsonb;
  v_policies jsonb;
  v_receipts jsonb;
  v_serial jsonb;
  v_locrec jsonb;
  v_context jsonb;
begin
  select h.* into s from public.ppu_inventario_snapshots h
  where not exists (select 1 from public.ppu_inventario_snapshots n where n.previous_snapshot_id=h.id);
  if not found then raise exception 'R6: baseline ausente'; end if;
  select coalesce(jsonb_agg(to_jsonb(p) order by p.id),'[]'::jsonb) into v_rows from public.estoque_ppu p;
  if encode(sha256(convert_to(v_rows::text,'UTF8')),'hex')<>s.rows_sha256 then
    raise exception 'R6: estoque vigente diverge do ultimo snapshot; revisar antes de importar';
  end if;
  select coalesce(jsonb_agg(jsonb_build_object(
    'localizacao_normalizada',p.localizacao_normalizada,'ativo',p.ativo,
    'contabiliza_ppu',p.contabiliza_ppu,'destino_contabilizacao',p.destino_contabilizacao,
    'situacao_operacional',p.situacao_operacional) order by p.id),'[]'::jsonb)
    into v_policies from public.ppu_localizacoes_config p;
  select coalesce(jsonb_agg(jsonb_build_object('id',r.id,'numero_recibo',r.numero_recibo,
    'data_recebimento',r.data_recebimento,'ativo',true,'recebimento_itens',i.items) order by r.id),'[]'::jsonb)
    into v_receipts
  from public.recebimentos r cross join lateral (
    select coalesce(jsonb_agg(to_jsonb(x)||jsonb_build_object('ativo',true) order by x.id),'[]'::jsonb) items
    from public.recebimento_itens x where x.recebimento_id=r.id and x.ativo is distinct from false
  ) i where r.ativo is distinct from false;
  select coalesce(jsonb_agg(pn order by pn),'[]'::jsonb) into v_serial from (
    select distinct upper(regexp_replace(btrim(e.pn),'[[:space:]]+','','g')) pn
    from public.equipamentos_serializados e where e.ativo is distinct from false
  ) t;
  select coalesce(jsonb_agg(jsonb_build_object(
    'id',l.id,'numero_recibo',l.numero_recibo,'pn',l.pn,'qtd_documental',l.qtd_documental,
    'qtd_auditada_aplicada',l.qtd_auditada_aplicada,'loc_escolhida',l.loc_escolhida,
    'destino_indicado',l.destino_indicado,'data_auditoria',l.data_auditoria) order by l.id),'[]'::jsonb)
    into v_locrec from public.v_sisha_locrec_atual l;
  v_context:=jsonb_build_object('snapshot_id',s.id,'previous_observed_on',s.observed_on,
    'previous_rows',v_rows,'previous_policies',s.policies_payload,'policies',v_policies,
    'receipts',v_receipts,'serial_pns',v_serial,'locrec',v_locrec);
  return v_context||jsonb_build_object('token',encode(sha256(convert_to(v_context::text,'UTF8')),'hex'));
end;
$$;
revoke all on function public.sisha_ppu_r6_context() from public,anon,authenticated,service_role;
grant execute on function public.sisha_ppu_r6_context() to service_role;

create function public.sisha_ppu_r6_apply(
  p_context_token text,p_source_sha256 text,p_file_name text,p_import_log_id uuid,
  p_observed_on date,p_previous_observed_on date,p_previous_date_evidence text,
  p_complete boolean,p_rows jsonb,p_plan jsonb,p_actor text
) returns jsonb
language plpgsql security invoker set search_path=pg_catalog set timezone='UTC'
as $$
declare
  c jsonb;
  s public.ppu_inventario_snapshots%rowtype;
  v_existing public.ppu_inventario_snapshots%rowtype;
  v_new_id uuid:=gen_random_uuid();
  v_rows jsonb;
  v_policies jsonb;
  v_count integer;
  v_entry record;
  v_item public.recebimento_itens%rowtype;
  v_date date;
  v_changed integer:=0;
  v_sum numeric:=0;
begin
  if p_complete is distinct from true or p_observed_on is null or p_observed_on>current_date
     or p_source_sha256 is null or p_source_sha256 !~ '^[0-9a-f]{64}$'
     or nullif(btrim(p_file_name),'') is null or nullif(btrim(p_actor),'') is null
     or p_import_log_id is null then raise exception 'R6: arquivo completo, data e auditoria obrigatorios'; end if;
  if jsonb_typeof(p_rows) is distinct from 'array' or jsonb_typeof(p_plan) is distinct from 'array'
     or jsonb_array_length(p_rows)=0 then raise exception 'R6: payload invalido ou vazio'; end if;
  perform pg_advisory_xact_lock(hashtext('sisha_ppu_inventory_reconciliation')::bigint);
  -- All data that defines the plan is locked until commit. Existing legacy imports must
  -- be disabled before activation; their separate delete/insert calls are not safe.
  lock table public.estoque_ppu,public.ppu_localizacoes_config in share row exclusive mode;
  lock table public.recebimentos,public.recebimento_itens,public.equipamentos_serializados,
    public.locrec_importacoes,public.locrec_itens in share row exclusive mode;
  if not exists(select 1 from public.import_logs l where l.id=p_import_log_id
    and l.tipo_arquivo='inventario_ppu' and l.status='PROCESSANDO'
    and l.detalhes->'arquivo'->>'sha256'=p_source_sha256
    and l.nome_arquivo=p_file_name) then raise exception 'R6: trilha de upload invalida'; end if;

  select h.* into v_existing from public.ppu_inventario_snapshots h where h.source_file_sha256=p_source_sha256;
  if found then
    if exists(select 1 from public.ppu_inventario_snapshots n where n.previous_snapshot_id=v_existing.id)
      then raise exception 'R6: arquivo historico nao pode substituir o estoque vigente'; end if;
    if v_existing.observed_on is distinct from p_observed_on then raise exception 'R6: data divergente para arquivo ja importado'; end if;
    if v_existing.rows_sha256<>(select encode(sha256(convert_to(coalesce(jsonb_agg(to_jsonb(p) order by p.id),'[]'::jsonb)::text,'UTF8')),'hex') from public.estoque_ppu p)
      then raise exception 'R6: estoque alterado apos importacao'; end if;
    return jsonb_build_object('status','REUSED','snapshot_id',v_existing.id,'rows',v_existing.row_count,'items',0,'quantity',0);
  end if;

  c:=public.sisha_ppu_r6_context();
  if c->>'token' is distinct from p_context_token then raise exception 'R6: contexto mudou; recalcular antes de importar'; end if;
  select h.* into strict s from public.ppu_inventario_snapshots h where h.id=(c->>'snapshot_id')::uuid;
  if s.observed_on is null then
    if p_previous_observed_on is null or length(btrim(coalesce(p_previous_date_evidence,'')))<10
      then raise exception 'R6: data operacional anterior e referencia documental obrigatorias'; end if;
    v_date:=p_previous_observed_on;
  else
    v_date:=s.observed_on;
    if p_previous_observed_on is not null and p_previous_observed_on<>v_date then raise exception 'R6: data anterior divergente'; end if;
  end if;
  if v_date>=p_observed_on then raise exception 'R6: inventario deve ser posterior ao anterior'; end if;

  -- R6A deliberately accepts only the summarized/no-SN input.
  if exists(select 1 from jsonb_to_recordset(p_rows) x(pn text,localizacao text,quantidade numeric,sn text)
      where x.pn is null or btrim(x.pn)='' or upper(btrim(x.pn)) in ('LIMPEZA','DUPLICADO','NULL','PN')
        or upper(btrim(x.pn)) like 'EXCLUIR%' or x.localizacao is null or btrim(x.localizacao)=''
        or x.quantidade is null or x.quantidade<0 or x.quantidade<>round(x.quantidade,6)
        or nullif(btrim(x.sn),'') is not null)
    then raise exception 'R6: linha invalida ou formato serializado ainda nao homologado'; end if;
  if exists(select 1 from public.estoque_ppu where pn='LIMPEZA') then raise exception 'R6: sentinela legada requer revisao'; end if;
  if exists(select 1 from jsonb_to_recordset(p_rows) x(localizacao text)
    where public.sisha_normalize_location(x.localizacao) in ('NÃO DEFINIDO','CONFLITO DE LOCALIZAÇÃO')
    and not exists(select 1 from public.ppu_localizacoes_config k where k.localizacao_normalizada=public.sisha_normalize_location(x.localizacao) and k.ativo and not k.contabiliza_ppu))
    then raise exception 'R6: local tecnico sem politica de exclusao'; end if;

  -- Defense in depth: check every proposed allocation against locked current data.
  if exists(
    with entries as (
      select * from jsonb_to_recordset(p_plan) x("itemId" bigint,"receiptId" bigint,pn text,quantity numeric,before numeric,after numeric,method text,location text)
    ), totals as (
      select e.pn,sum(e.quantity) qty from entries e group by e.pn
    ), old as (
      select upper(regexp_replace(btrim(p.pn),'[[:space:]]+','','g')) pn,coalesce(public.sisha_normalize_location(p.localizacao),'') loc,sum(coalesce(p.quantidade,0)) qty
      from public.estoque_ppu p where p.quantidade>0 group by 1,2
    ), new as (
      select upper(regexp_replace(btrim(p.pn),'[[:space:]]+','','g')) pn,coalesce(public.sisha_normalize_location(p.localizacao),'') loc,sum(p.quantidade) qty
      from jsonb_to_recordset(p_rows) p(pn text,localizacao text,quantidade numeric) where p.quantidade>0 group by 1,2
    ), changes as (
      select coalesce(o.pn,n.pn) pn,coalesce(o.loc,n.loc) loc,coalesce(n.qty,0)-coalesce(o.qty,0) delta
      from old o full join new n on o.pn=n.pn and o.loc=n.loc
    ), budgets as (
      select x.pn,sum(x.delta) net,
        sum(greatest(x.delta,0)) filter(where k.ativo and k.contabiliza_ppu
          and exists(select 1 from jsonb_to_recordset(s.policies_payload) a(localizacao_normalizada text,ativo boolean,contabiliza_ppu boolean)
            where a.localizacao_normalizada=x.loc and a.ativo and a.contabiliza_ppu)) eligible
      from changes x left join public.ppu_localizacoes_config k on k.localizacao_normalizada=x.loc group by x.pn
    )
    select 1 from totals t left join budgets b on b.pn=t.pn
    where t.qty is null or t.qty<=0 or t.qty>greatest(0,least(coalesce(b.net,0),coalesce(b.eligible,0)))
  ) then raise exception 'R6: alocacao excede incremento liquido ou local autorizado'; end if;

  for v_entry in select value as payload from jsonb_array_elements(p_plan) with ordinality order by ordinality loop
    select i.* into v_item from public.recebimento_itens i join public.recebimentos r on r.id=i.recebimento_id
    where i.id=(v_entry.payload->>'itemId')::bigint and r.id=(v_entry.payload->>'receiptId')::bigint
      and i.ativo is distinct from false and r.ativo is distinct from false
      and r.data_recebimento<p_observed_on and i.contabiliza_pelo_recibo is true
      and i.condicao_item='RECEBIDO_DISPONIVEL'
      and coalesce(i.destino_previsto,'PPU')='PPU' and coalesce(i.destino_estoque,'PPU')='PPU'
      and coalesce(i.validade_status,'NAO_INFORMADA') not in ('VENCIDO','REVISAR','SEM_ESTOQUE')
      and i.tipo_item='SOBRESSALENTE' and i.equipamento_id is null and nullif(btrim(i.sn),'') is null
      and upper(regexp_replace(btrim(i.pn),'[[:space:]]+','','g'))=v_entry.payload->>'pn'
      and not exists(select 1 from public.equipamentos_serializados e where e.ativo is distinct from false
        and upper(regexp_replace(btrim(e.pn),'[[:space:]]+','','g'))=v_entry.payload->>'pn')
      and not exists(select 1 from public.estoque_ppu e where nullif(btrim(e.sn),'') is not null
        and upper(regexp_replace(btrim(e.pn),'[[:space:]]+','','g'))=v_entry.payload->>'pn')
      and not exists(select 1 from public.recebimento_itens j join public.recebimentos r2 on r2.id=j.recebimento_id
        where j.ativo is distinct from false and r2.ativo is distinct from false and (j.tipo_item='EQUIPAMENTO' or nullif(btrim(j.sn),'') is not null or j.equipamento_id is not null)
        and upper(regexp_replace(btrim(j.pn),'[[:space:]]+','','g'))=v_entry.payload->>'pn');
    if not found then raise exception 'R6: item nao elegivel ou PN serializado'; end if;
    if v_entry.payload->>'method' is null or v_entry.payload->>'method' not in ('LOCREC','QTD_EXATA','FIFO')
       or (v_entry.payload->>'quantity')::numeric is null or (v_entry.payload->>'quantity')::numeric<=0
       or (v_entry.payload->>'before')::numeric is distinct from coalesce(v_item.quantidade_inventariada,0)
       or (v_entry.payload->>'after')::numeric is distinct from coalesce(v_item.quantidade_inventariada,0)+(v_entry.payload->>'quantity')::numeric
       or (v_entry.payload->>'after')::numeric>v_item.quantidade then
       raise exception 'R6: alocacao invalida ou saldo alterado'; end if;
    -- The authorized backend builds the deterministic plan. Never assert physical
    -- provenance for an accounting inference; location candidates remain evidence.
    update public.recebimento_itens set quantidade_inventariada=(v_entry.payload->>'after')::numeric,
      contabiliza_pelo_recibo=((v_entry.payload->>'after')::numeric<quantidade),
      destino_estoque='PPU',inventariado_em=now(),inventariado_por_email=p_actor
    where id=v_item.id;
    insert into public.recebimento_eventos(recebimento_id,recebimento_item_id,tipo_evento,detalhe,created_by_email)
    values(v_item.recebimento_id,v_item.id,'ITEM_INCORPORACAO_ESTOQUE_AJUSTADA',
      jsonb_build_object('origem','R6_AUTO_PPU','snapshot_id',v_new_id,'snapshot_anterior_id',s.id,
       'arquivo_sha256',p_source_sha256,'observed_on',p_observed_on,'previous_observed_on',v_date,
       'previous_date_evidence',case when s.observed_on is null then p_previous_date_evidence end,
       'pn',v_item.pn,'quantidade_anterior',coalesce(v_item.quantidade_inventariada,0),
       'quantidade_nova',(v_entry.payload->>'after')::numeric,'quantidade_incorporada',(v_entry.payload->>'quantity')::numeric,
       'saldo_temporario_anterior',v_item.quantidade-coalesce(v_item.quantidade_inventariada,0),
       'saldo_temporario_novo',v_item.quantidade-(v_entry.payload->>'after')::numeric,
       'destino_estoque','PPU','metodo',v_entry.payload->>'method',
       'localizacao_candidata',v_entry.payload->>'location','localizacoes_observadas',v_entry.payload->'observedLocations',
       'natureza','RECONCILIACAO_CONTABIL_COM_EVIDENCIAS','origem_fisica_comprovada',false),p_actor);
    v_changed:=v_changed+1;
    v_sum:=v_sum+(v_entry.payload->>'quantity')::numeric;
  end loop;

  delete from public.estoque_ppu;
  insert into public.estoque_ppu(pn,nsn_pi,nomenclatura,quantidade,localizacao,sn)
  select x.pn,x.nsn_pi,x.nomenclatura,x.quantidade,x.localizacao,null
    from jsonb_to_recordset(p_rows) x(pn text,nsn_pi text,nomenclatura text,quantidade numeric,localizacao text);
  get diagnostics v_count=row_count;
  if v_count<>jsonb_array_length(p_rows) then raise exception 'R6: quantidade de linhas divergente'; end if;
  select jsonb_agg(to_jsonb(p) order by p.id) into v_rows from public.estoque_ppu p;
  v_policies:=c->'policies';
  insert into public.ppu_inventario_snapshots(id,snapshot_type,previous_snapshot_id,import_log_id,
    source_file_name,source_file_sha256,observed_on,row_count,policy_count,rows_payload,policies_payload,rows_sha256,policies_sha256)
  values(v_new_id,'IMPORTACAO',s.id,p_import_log_id,p_file_name,p_source_sha256,p_observed_on,
    v_count,jsonb_array_length(v_policies),v_rows,v_policies,
    encode(sha256(convert_to(v_rows::text,'UTF8')),'hex'),encode(sha256(convert_to(v_policies::text,'UTF8')),'hex'));
  return jsonb_build_object('status','APPLIED','snapshot_id',v_new_id,'rows',v_count,'allocations',v_changed,'quantity',v_sum,
    'previous_observed_on',v_date,'previous_date_evidence',case when s.observed_on is null then p_previous_date_evidence end);
end;
$$;
revoke all on function public.sisha_ppu_r6_apply(text,text,text,uuid,date,date,text,boolean,jsonb,jsonb,text) from public,anon,authenticated,service_role;
grant execute on function public.sisha_ppu_r6_apply(text,text,text,uuid,date,date,text,boolean,jsonb,jsonb,text) to service_role;
commit;
