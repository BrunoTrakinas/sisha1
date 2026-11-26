\set ON_ERROR_STOP on
do $$ begin if current_database()<>'sisha_r6_fixture' then raise exception 'Fixture only'; end if; end $$;
set role service_role;
select public.sisha_capture_ppu_legacy_baseline(
 (select encode(sha256(convert_to(jsonb_agg(to_jsonb(p) order by p.id)::text,'UTF8')),'hex') from public.estoque_ppu p),
 (select encode(sha256(convert_to(jsonb_agg(jsonb_build_object('localizacao_normalizada',p.localizacao_normalizada,'ativo',p.ativo,'contabiliza_ppu',p.contabiliza_ppu,'destino_contabilizacao',p.destino_contabilizacao,'situacao_operacional',p.situacao_operacional) order by p.id)::text,'UTF8')),'hex') from public.ppu_localizacoes_config p));
do $$
declare
 token text:=public.sisha_ppu_r6_context()->>'token';
 base uuid:=(public.sisha_ppu_r6_context()->>'snapshot_id')::uuid;
 newrows jsonb:='[{"pn":"FIXTURE-PN","localizacao":"A-1","quantidade":2}]';
 plan jsonb:='[{"itemId":1,"receiptId":1,"pn":"FIXTURE-PN","quantity":1,"before":0,"after":1,"method":"FIFO","location":"A-1"}]';
 result jsonb;
begin
 -- Deliberate failure after receipt update/event but during stock insert.
 begin
  perform public.sisha_ppu_r6_apply(token,repeat('b',64),'fixture-3.ods','00000000-0000-4000-8000-000000000003','2025-02-01','2025-01-15','Synthetic source reference',true,newrows||'[{"pn":"FIXTURE-FAIL-LATE","localizacao":"Z","quantidade":1}]'::jsonb,plan,'fixture@example.invalid');
  raise exception 'expected late check violation';
 exception when check_violation then null; end;
 if (select quantidade_inventariada from public.recebimento_itens where id=1)<>0
    or (select count(*) from public.recebimento_eventos)<>0
    or (select sum(quantidade) from public.estoque_ppu)<>1
    or (select count(*) from public.ppu_inventario_snapshots)<>1
    or (select status from public.import_logs where id='00000000-0000-4000-8000-000000000003')<>'PROCESSANDO'
    then raise exception 'late rollback failed'; end if;
 raise notice 'R6B PASS late rollback';
 -- Successful partial incorporation.
 result:=public.sisha_ppu_r6_apply(token,repeat('a',64),'fixture-1.ods','00000000-0000-4000-8000-000000000001','2025-02-01','2025-01-15','Synthetic source reference',true,newrows,plan,'fixture@example.invalid');
 if result->>'status'<>'APPLIED' or (select quantidade_inventariada from public.recebimento_itens where id=1)<>1
    or (select contabiliza_pelo_recibo from public.recebimento_itens where id=1) is not true
    or (select localizacao_ppu from public.recebimento_itens where id=1)<>'HANGAR'
    or (select sum(quantidade) from public.estoque_ppu)<>2
    or (select count(*) from public.recebimento_eventos)<>1
    or (select count(*) from public.ppu_inventario_snapshots)<>2
    or (select status from public.import_logs where id='00000000-0000-4000-8000-000000000001')<>'SUCESSO'
    then raise exception 'partial application failed'; end if;
 if (select sum(delta) from public.sisha_ppu_snapshot_diff(base,(result->>'snapshot_id')::uuid))<>1 then raise exception 'snapshot diff failed'; end if;
 raise notice 'R6B PASS atomic partial and snapshot diff';
 result:=public.sisha_ppu_r6_apply(token,repeat('a',64),'fixture-2.ods','00000000-0000-4000-8000-000000000002','2025-02-01',null,null,true,newrows,'[]','fixture@example.invalid');
 if result->>'status'<>'REUSED' or (select count(*) from public.recebimento_eventos)<>1 or (select count(*) from public.ppu_inventario_snapshots)<>2 then raise exception 'replay failed'; end if;
 raise notice 'R6B PASS replay';
 begin
  perform public.sisha_ppu_r6_apply(token,repeat('b',64),'fixture-3.ods','00000000-0000-4000-8000-000000000003','2025-03-01',null,null,true,newrows,'[]','fixture@example.invalid');
  raise exception 'expected stale context rejection';
 exception when raise_exception then
  if sqlerrm not like '%contexto mudou%' then raise; end if;
 end;
 raise notice 'R6B PASS stale context';
 -- Incorrect allocation must not replace stock or write events.
 begin
  perform public.sisha_ppu_r6_apply(public.sisha_ppu_r6_context()->>'token',repeat('b',64),'fixture-3.ods','00000000-0000-4000-8000-000000000003','2025-03-01',null,null,true,newrows,plan,'fixture@example.invalid');
  raise exception 'expected budget rejection';
 exception when raise_exception then
  if sqlerrm not like '%excede incremento%' then raise; end if;
 end;
 raise notice 'R6B PASS net limit';
 -- Serializable input explicitly blocked; existing flag-off workflow remains available.
 begin
  perform public.sisha_ppu_r6_apply(public.sisha_ppu_r6_context()->>'token',repeat('b',64),'fixture-3.ods','00000000-0000-4000-8000-000000000003','2025-03-01',null,null,true,'[{"pn":"FIXTURE-PN","localizacao":"A-1","quantidade":2,"sn":"SYNTHETIC-SN"}]','[]','fixture@example.invalid');
  raise exception 'expected SN rejection';
 exception when raise_exception then
  if sqlerrm not like '%formato serializado%' then raise; end if;
 end;
 raise notice 'R6B PASS serial fail closed';
end $$;
reset role;
do $$ begin
 if has_function_privilege('anon','public.sisha_ppu_r6_apply(text,text,text,uuid,date,date,text,boolean,jsonb,jsonb,text)','EXECUTE')
 or has_function_privilege('authenticated','public.sisha_ppu_r6_context()','EXECUTE') then raise exception 'RPC privilege leak'; end if;
 raise notice 'R6B PASS RPC ACL';
end $$;

-- R7B1: historical review uses the same dated snapshot and never replaces stock.
-- Roll back all fixture changes so the separate R6 concurrency test sees its baseline.
begin;
set local role service_role;
insert into public.locrec_importacoes(id,status) values('00000000-0000-4000-8000-000000000099','ACTIVE');
insert into public.locrec_itens(id,import_id,numero_recibo,pn,qtd_documental,qtd_auditada_aplicada,loc_escolhida,destino_indicado,data_auditoria)
values(99,'00000000-0000-4000-8000-000000000099','FIXTURE-1','FIXTURE-PN',4,2,'A-1','PPU','2025-01-15');
do $$
declare
 token text:=public.sisha_ppu_r6_context()->>'token';
 result jsonb;
 before_stock jsonb:=(select jsonb_agg(to_jsonb(x) order by id) from public.estoque_ppu x);
begin
 begin
  perform public.sisha_ppu_r7_retro_apply(token,1,99,2,'Synthetic actual stock entry document','fixture@example.invalid');
  raise exception 'expected excessive historical debit rejection';
 exception when raise_exception then
  if sqlerrm not like '%quantidade insuficiente%' then raise; end if;
 end;
 if (select quantidade_inventariada from public.recebimento_itens where id=1)<>1 then raise exception 'overdebit altered balance'; end if;
 begin
  perform public.sisha_ppu_r7_retro_apply(token,1,99,1,'short','fixture@example.invalid');
  raise exception 'expected documentary evidence rejection';
 exception when raise_exception then
  if sqlerrm not like '%evidencia de entrada%' then raise; end if;
 end;
 result:=public.sisha_ppu_r7_retro_apply(token,1,99,1,'Synthetic actual stock entry document','fixture@example.invalid');
 if result->>'status'<>'APPLIED' or (result->>'pending')::numeric<>2
    or (select quantidade_inventariada from public.recebimento_itens where id=1)<>2
    or (select quantidade from public.recebimento_itens where id=1)<>4
    or (select count(*) from public.recebimento_eventos where detalhe->>'origem'='R7_RETRO_PPU')<>1
    or (select jsonb_agg(to_jsonb(x) order by id) from public.estoque_ppu x) is distinct from before_stock
    or (select count(*) from public.ppu_inventario_snapshots)<>2
 then raise exception 'retroactive controlled application failed'; end if;
 begin
  perform public.sisha_ppu_r7_retro_apply(token,1,99,1,'Synthetic actual stock entry document','fixture@example.invalid');
  raise exception 'expected historical replay rejection';
 exception when raise_exception then
  if sqlerrm not like '%contexto mudou%' then raise; end if;
 end;
 begin
  perform public.sisha_ppu_r7_retro_apply(public.sisha_ppu_r6_context()->>'token',1,99,1,'Synthetic actual stock entry document','fixture@example.invalid');
  raise exception 'expected consumed LOCREC rejection';
 exception when raise_exception then
  if sqlerrm not like '%quantidade insuficiente%' then raise; end if;
 end;
 raise notice 'R7B1 PASS historical bounds, audit, stock unchanged and replay';
end $$;
rollback;
do $$ begin
 if has_function_privilege('anon','public.sisha_ppu_r7_retro_apply(text,bigint,bigint,numeric,text,text)','EXECUTE')
 or has_function_privilege('authenticated','public.sisha_ppu_r7_retro_apply(text,bigint,bigint,numeric,text,text)','EXECUTE')
 then raise exception 'R7B1 privilege leak'; end if;
 raise notice 'R7B1 PASS historical ACL';
end $$;

-- R7B2: native report keeps SN and a durable Livro pending state.
begin;
set local role service_role;
do $r7test$
declare
 token text:=public.sisha_ppu_r6_context()->>'token';
 result jsonb;
 snapshot uuid;
 claim jsonb;
 done jsonb;
 native_rows jsonb:='[{"pn":"FIXTURE-PN","localizacao":"A-1","quantidade":2,"source_section":"SOBRESSALENTES","source_row":5},{"pn":"FIXTURE-SERIAL","localizacao":"Z","quantidade":1,"sn":"SN-FIXTURE-1","source_section":"EQUIPAMENTOS","source_row":8}]';
begin
 result:=public.sisha_ppu_r6_apply(token,repeat('c',64),'fixture-4.ods','00000000-0000-4000-8000-000000000004','2025-03-01',null,null,true,native_rows,'[]','fixture@example.invalid');
 snapshot:=(result->>'snapshot_id')::uuid;
 if result->'book_sync'->>'state'<>'PENDING' or (result->'book_sync'->>'total')::integer<>1
   or (select count(*) from public.estoque_ppu where sn='SN-FIXTURE-1' and quantidade=1)<>1
   or (select count(*) from public.equipamentos_serializados)<>0
   or (select quantidade_inventariada from public.recebimento_itens where id=1)<>1
   or (select count(*) from public.ppu_inventario_snapshots)<>3
 then raise exception 'native stock and durable evidence failed'; end if;
 begin
  perform public.sisha_ppu_r6_apply(public.sisha_ppu_r6_context()->>'token',repeat('d',64),'fixture-5.ods','00000000-0000-4000-8000-000000000005','2025-04-01',null,null,true,native_rows,'[]','fixture@example.invalid');
  raise exception 'expected pending Livro gate';
 exception when raise_exception then if sqlerrm not like '%concluir sincronizacao%' then raise; end if; end;
 claim:=public.sisha_ppu_r7_book_claim(snapshot,'fixture@example.invalid');
 if claim->>'state'<>'RUNNING' or claim->'items'->0->>'sn'<>'SN-FIXTURE-1' or claim->>'sourceHash'<>repeat('c',64)
 then raise exception 'native evidence claim failed'; end if;
 begin
  perform public.sisha_ppu_r7_book_claim(snapshot,'other@example.invalid');
  raise exception 'expected exclusive claim';
 exception when raise_exception then if sqlerrm not like '%sincronizacao em andamento%' then raise; end if; end;
 begin
  perform public.sisha_ppu_r7_book_finish(snapshot,gen_random_uuid(),true,'{}','fixture@example.invalid');
  raise exception 'expected wrong attempt rejection';
 exception when raise_exception then if sqlerrm not like '%tentativa ativa%' then raise; end if; end;
 done:=public.sisha_ppu_r7_book_finish(snapshot,(claim->>'attempt_id')::uuid,false,'{"retry_required":true}','fixture@example.invalid');
 if done->>'state'<>'PENDING' or (done->>'cursor')::integer<>0 then raise exception 'failed batch advanced cursor'; end if;
 claim:=public.sisha_ppu_r7_book_claim(snapshot,'fixture@example.invalid');
 done:=public.sisha_ppu_r7_book_finish(snapshot,(claim->>'attempt_id')::uuid,true,'{"events":1}','fixture@example.invalid');
 if done->>'state'<>'COMPLETE' or (done->>'cursor')::integer<>1 then raise exception 'completed batch cursor failed'; end if;
 result:=public.sisha_ppu_r6_apply(public.sisha_ppu_r6_context()->>'token',repeat('d',64),'fixture-5.ods','00000000-0000-4000-8000-000000000005','2025-04-01',null,null,true,'[{"pn":"FIXTURE-PN","localizacao":"A-1","quantidade":2},{"pn":"FIXTURE-SERIAL","localizacao":"Z","quantidade":1}]','[]','fixture@example.invalid');
 if result->>'status'<>'APPLIED' or not ((public.sisha_ppu_r6_context()->'serial_pns') ? 'FIXTURE-SERIAL') then raise exception 'historical equipment identity guard lost'; end if;
 raise notice 'R7B2 PASS native preservation, exclusive claim, failed batch resume, pending import gate and historical identity';
end
$r7test$;
rollback;
do $r7acl$ begin
 if has_function_privilege('anon','public.sisha_ppu_r7_book_claim(uuid,text)','EXECUTE')
 or has_function_privilege('authenticated','public.sisha_ppu_r7_book_finish(uuid,uuid,boolean,jsonb,text)','EXECUTE')
 then raise exception 'R7B2 ACL failure'; end if;
end $r7acl$;

-- R8: classify unknown locations as excluded, atomically and without overriding policies.
begin;
set local role service_role;
do $r8unknown$
declare
 token text:=public.sisha_ppu_r6_context()->>'token';
 result jsonb;
 before_policies jsonb:=(select jsonb_agg(to_jsonb(x) order by id) from public.ppu_localizacoes_config x);
 before_stock jsonb:=(select jsonb_agg(to_jsonb(x) order by id) from public.estoque_ppu x);
begin
 begin
  perform public.sisha_ppu_r6_apply(token,repeat('e',64),'fixture-6.ods','00000000-0000-4000-8000-000000000006','2025-03-01',null,null,true,'[{"pn":"FIXTURE-PN","localizacao":"A-1","quantidade":2},{"pn":"FIXTURE-FAIL-LATE","localizacao":"NEW-R8","quantidade":3}]','[]','fixture@example.invalid');
  raise exception 'expected late check violation';
 exception when check_violation then null; end;
 if (select jsonb_agg(to_jsonb(x) order by id) from public.ppu_localizacoes_config x) is distinct from before_policies
 or (select jsonb_agg(to_jsonb(x) order by id) from public.estoque_ppu x) is distinct from before_stock then raise exception 'R8 policy rollback failed'; end if;
 result:=public.sisha_ppu_r6_apply(token,repeat('e',64),'fixture-6.ods','00000000-0000-4000-8000-000000000006','2025-03-01',null,null,true,'[{"pn":"FIXTURE-PN","localizacao":"A-1","quantidade":2},{"pn":"FIXTURE-PN","localizacao":"NEW-R8","quantidade":3},{"pn":"FIXTURE-OTHER","localizacao":" new-r8 ","quantidade":1}]','[]','fixture@example.invalid');
 if result->>'status' is distinct from 'APPLIED' or not exists(select 1 from public.ppu_localizacoes_config where localizacao_normalizada='NEW-R8' and ativo and not contabiliza_ppu and destino_contabilizacao='FORA_LINHA' and situacao_operacional='A_CONFIRMAR')
 or (select count(*) from public.ppu_localizacoes_config where localizacao_normalizada='NEW-R8')<>1
 or (select jsonb_agg(to_jsonb(x) order by id) from public.ppu_localizacoes_config x where localizacao_normalizada<>'NEW-R8') is distinct from before_policies
 or (select sum(p.quantidade) from public.estoque_ppu p left join public.ppu_localizacoes_config k on k.localizacao_normalizada=public.sisha_normalize_location(p.localizacao) where coalesce(k.ativo,true) and coalesce(k.contabiliza_ppu,true))<>2
 or not exists(select 1 from public.ppu_inventario_snapshots h cross join lateral jsonb_to_recordset(h.policies_payload) k(localizacao_normalizada text,contabiliza_ppu boolean,situacao_operacional text) where h.id=(result->>'snapshot_id')::uuid and k.localizacao_normalizada='NEW-R8' and not k.contabiliza_ppu and k.situacao_operacional='A_CONFIRMAR')
 or (select quantidade_inventariada from public.recebimento_itens where id=1)<>1
 then raise exception 'R8 unknown location policy or snapshot inconsistent'; end if;
 raise notice 'R8 PASS unknown location excluded, policy preserved, snapshot consistent, rollback and no receipt debit';
end
$r8unknown$;
rollback;
