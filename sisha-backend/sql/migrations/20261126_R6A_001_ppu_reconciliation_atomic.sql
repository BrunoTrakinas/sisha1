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
  v_context:=jsonb_build_object('snapshot_id',s.id,'previous_observed_on',s.observed_on,'source_file_sha256',s.source_file_sha256,
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
  v_log public.import_logs%rowtype;
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
  select l.* into v_log from public.import_logs l where l.id=p_import_log_id for update;
  if not found or v_log.tipo_arquivo is distinct from 'inventario_ppu'
    or v_log.status is distinct from 'PROCESSANDO'
    or v_log.detalhes->'arquivo'->>'sha256' is distinct from p_source_sha256
    or v_log.nome_arquivo is distinct from p_file_name
    or v_log.uploaded_by_email is distinct from p_actor
    then raise exception 'R6: trilha de upload invalida'; end if;

  select h.* into v_existing from public.ppu_inventario_snapshots h where h.source_file_sha256=p_source_sha256;
  if found then
    if exists(select 1 from public.ppu_inventario_snapshots n where n.previous_snapshot_id=v_existing.id)
      then raise exception 'R6: arquivo historico nao pode substituir o estoque vigente'; end if;
    if v_existing.observed_on is distinct from p_observed_on then raise exception 'R6: data divergente para arquivo ja importado'; end if;
    if v_existing.rows_sha256<>(select encode(sha256(convert_to(coalesce(jsonb_agg(to_jsonb(p) order by p.id),'[]'::jsonb)::text,'UTF8')),'hex') from public.estoque_ppu p)
      then raise exception 'R6: estoque alterado apos importacao'; end if;
    update public.import_logs set status='SUCESSO',tabela_alvo='estoque_ppu',linhas_importadas=0,
      mensagem='Inventario ja aplicado; nenhuma incorporacao repetida.',finished_at=now(),
      detalhes=coalesce(detalhes,'{}'::jsonb)||jsonb_build_object('r6_transaction',
        jsonb_build_object('status','REUSED','snapshot_id',v_existing.id,'quantity',0))
      where id=p_import_log_id;
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
  update public.import_logs set status='SUCESSO',tabela_alvo='estoque_ppu',
    linhas_importadas=v_count, mensagem='Inventario e recibos atualizados atomicamente.',finished_at=now(),
    detalhes=coalesce(detalhes,'{}'::jsonb)||jsonb_build_object('r6_transaction',
      jsonb_build_object('status','APPLIED','snapshot_id',v_new_id,'rows',v_count,'allocations',v_changed,
        'quantity',v_sum,'observed_on',p_observed_on,'previous_observed_on',v_date,
        'previous_date_evidence',case when s.observed_on is null then p_previous_date_evidence end))
    where id=p_import_log_id;
  return jsonb_build_object('status','APPLIED','snapshot_id',v_new_id,'rows',v_count,'allocations',v_changed,'quantity',v_sum,
    'previous_observed_on',v_date,'previous_date_evidence',case when s.observed_on is null then p_previous_date_evidence end);
end;
$$;
revoke all on function public.sisha_ppu_r6_apply(text,text,text,uuid,date,date,text,boolean,jsonb,jsonb,text) from public,anon,authenticated,service_role;
grant execute on function public.sisha_ppu_r6_apply(text,text,text,uuid,date,date,text,boolean,jsonb,jsonb,text) to service_role;

-- R7B1: individually confirmed historical incorporation. No inventory or Livro write.
create function public.sisha_ppu_r7_retro_apply(
 p_context_token text,p_item_id bigint,p_locrec_id bigint,p_quantity numeric,
 p_evidence text,p_actor text
) returns jsonb
language plpgsql security invoker set search_path=pg_catalog set timezone='UTC'
as $
declare
 c jsonb;
 s public.ppu_inventario_snapshots%rowtype;
 i public.recebimento_itens%rowtype;
 r public.recebimentos%rowtype;
 d record;
 v_pn text;
 v_rec text;
 v_loc text;
 v_day date;
 v_claim numeric;
 v_stock numeric;
 v_before numeric;
 v_after numeric;
begin
 if p_context_token is null or p_context_token !~ '^[0-9a-f]{64}
   or p_item_id is null or p_locrec_id is null or p_quantity is null
   or p_quantity::text in ('NaN','Infinity','-Infinity') or p_quantity<=0
   or p_quantity<>round(p_quantity,6)
   or length(btrim(coalesce(p_evidence,'')))<15
   or length(p_evidence)>2000 or nullif(btrim(p_actor),'') is null
 then raise exception 'R7B: quantidade e evidencia de entrada efetiva obrigatorias'; end if;
 perform pg_advisory_xact_lock(hashtext('sisha_ppu_inventory_reconciliation')::bigint);
 lock table public.estoque_ppu,public.ppu_localizacoes_config in share row exclusive mode;
 lock table public.recebimentos,public.recebimento_itens,public.equipamentos_serializados,
   public.locrec_importacoes,public.locrec_itens in share row exclusive mode;
 c:=public.sisha_ppu_r6_context();
 if c->>'token' is distinct from p_context_token then raise exception 'R7B: contexto mudou; revisar novamente'; end if;
 select h.* into strict s from public.ppu_inventario_snapshots h where h.id=(c->>'snapshot_id')::uuid;
 if s.snapshot_type<>'IMPORTACAO' or s.observed_on is null then
   raise exception 'R7B: primeiro concluir inventario datado'; end if;
 select x.* into strict i from public.recebimento_itens x where x.id=p_item_id;
 select x.* into strict r from public.recebimentos x where x.id=i.recebimento_id;
 if not i.ativo or not r.ativo or not i.contabiliza_pelo_recibo
   or i.condicao_item<>'RECEBIDO_DISPONIVEL' or i.tipo_item<>'SOBRESSALENTE'
   or i.equipamento_id is not null or nullif(btrim(i.sn),'') is not null
   or coalesce(i.destino_previsto,'PPU')<>'PPU' or coalesce(i.destino_estoque,'PPU')<>'PPU'
   or coalesce(i.validade_status,'NAO_INFORMADA') in ('VENCIDO','REVISAR','SEM_ESTOQUE')
   or r.data_recebimento is null or r.data_recebimento>=s.observed_on
 then raise exception 'R7B: item nao elegivel'; end if;
 v_pn:=upper(regexp_replace(btrim(i.pn),'[[:space:]]+','','g'));
 v_rec:=replace(upper(regexp_replace(btrim(r.numero_recibo),'[[:space:]]+','','g')),chr(92),'/');
 if v_pn in ('LIMPEZA','DUPLICADO','NULL','PN') or v_pn like 'EXCLUIR%' or v_pn='' then raise exception 'R7B: PN invalido'; end if;
 if exists(select 1 from public.equipamentos_serializados e where e.ativo
    and upper(regexp_replace(btrim(e.pn),'[[:space:]]+','','g'))=v_pn)
 or exists(select 1 from public.recebimento_itens j where j.ativo
    and upper(regexp_replace(btrim(j.pn),'[[:space:]]+','','g'))=v_pn
    and (j.tipo_item='EQUIPAMENTO' or j.equipamento_id is not null or nullif(btrim(j.sn),'') is not null))
 or exists(select 1 from public.ppu_inventario_snapshots h cross join lateral jsonb_to_recordset(h.rows_payload) x(pn text,sn text)
    where nullif(btrim(x.sn),'') is not null and upper(regexp_replace(btrim(x.pn),'[[:space:]]+','','g'))=v_pn)
 then raise exception 'R7B: PN serializado exige identidade individual'; end if;
 if (select count(*) from public.recebimento_itens j join public.recebimentos r2 on r2.id=j.recebimento_id
   where j.ativo and r2.ativo and upper(regexp_replace(btrim(j.pn),'[[:space:]]+','','g'))=v_pn
   and replace(upper(regexp_replace(btrim(r2.numero_recibo),'[[:space:]]+','','g')),chr(92),'/')=v_rec)<>1
 then raise exception 'R7B: grupo Recibo PN ambiguo'; end if;
 select l.* into strict d from public.v_sisha_locrec_atual l where l.id=p_locrec_id;
 if replace(upper(regexp_replace(btrim(d.numero_recibo),'[[:space:]]+','','g')),chr(92),'/') is distinct from v_rec
   or upper(regexp_replace(btrim(d.pn),'[[:space:]]+','','g')) is distinct from v_pn
   or (select count(*) from public.v_sisha_locrec_atual l
      where replace(upper(regexp_replace(btrim(l.numero_recibo),'[[:space:]]+','','g')),chr(92),'/')=v_rec
      and upper(regexp_replace(btrim(l.pn),'[[:space:]]+','','g'))=v_pn)<>1
   or d.destino_indicado is distinct from 'PPU'
   or d.qtd_documental is distinct from i.quantidade
   or d.qtd_auditada_aplicada is null or d.qtd_auditada_aplicada<=0 or d.qtd_auditada_aplicada>i.quantidade
   or d.data_auditoria is null or d.data_auditoria !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}($|T)'
 then raise exception 'R7B: evidencia LOCREC invalida ou ambigua'; end if;
 v_day:=left(d.data_auditoria,10)::date;
 if v_day<r.data_recebimento or v_day>s.observed_on then raise exception 'R7B: cronologia divergente'; end if;
 v_loc:=public.sisha_normalize_location(d.loc_escolhida);
 if v_loc is null or v_loc in ('','NÃO DEFINIDO','NAO DEFINIDO','CONFLITO DE LOCALIZAÇÃO','CONFLITO DE LOCALIZACAO')
   or not exists(select 1 from public.ppu_localizacoes_config k where k.localizacao_normalizada=v_loc and k.ativo and k.contabiliza_ppu and k.destino_contabilizacao='PPU')
 then raise exception 'R7B: local nao elegivel'; end if;
 select coalesce(sum(l.qtd_auditada_aplicada),0) into v_claim from public.v_sisha_locrec_atual l
 where l.destino_indicado='PPU' and l.qtd_auditada_aplicada>0
 and upper(regexp_replace(btrim(l.pn),'[[:space:]]+','','g'))=v_pn and public.sisha_normalize_location(l.loc_escolhida)=v_loc;
 select coalesce(sum(x.quantidade),0) into v_stock from public.estoque_ppu x
 where x.quantidade>0 and upper(regexp_replace(btrim(x.pn),'[[:space:]]+','','g'))=v_pn and public.sisha_normalize_location(x.localizacao)=v_loc;
 v_before:=coalesce(i.quantidade_inventariada,0);
 v_after:=v_before+p_quantity;
 if v_stock<v_claim or v_after>i.quantidade or v_after>d.qtd_auditada_aplicada then
   raise exception 'R7B: quantidade insuficiente, disputada ou ja incorporada'; end if;
 update public.recebimento_itens set quantidade_inventariada=v_after,contabiliza_pelo_recibo=(v_after<quantidade),
    destino_estoque='PPU',inventariado_em=now(),inventariado_por_email=p_actor where id=i.id;
 insert into public.recebimento_eventos(recebimento_id,recebimento_item_id,tipo_evento,detalhe,created_by_email)
 values(r.id,i.id,'ITEM_INCORPORACAO_ESTOQUE_AJUSTADA',
 jsonb_build_object('origem','R7_RETRO_PPU','snapshot_id',s.id,'observed_on',s.observed_on,
   'locrec_id',p_locrec_id,'pn',i.pn,'quantidade_anterior',v_before,'quantidade_nova',v_after,
   'quantidade_incorporada',p_quantity,'saldo_temporario_anterior',i.quantidade-v_before,
   'saldo_temporario_novo',i.quantidade-v_after,'destino_estoque','PPU','metodo','REVISAO_DOCUMENTAL',
   'localizacao_candidata',v_loc,'referencia_entrada_confirmada',btrim(p_evidence),
   'origem_fisica_comprovada',false,'natureza','REVISAO_HUMANA_DOCUMENTAL'),p_actor);
 return jsonb_build_object('status','APPLIED','itemId',i.id,'quantity',p_quantity,'pending',i.quantidade-v_after);
end;
$;
revoke all on function public.sisha_ppu_r7_retro_apply(text,bigint,bigint,numeric,text,text) from public,anon,authenticated,service_role;
grant execute on function public.sisha_ppu_r7_retro_apply(text,bigint,bigint,numeric,text,text) to service_role;

commit;
