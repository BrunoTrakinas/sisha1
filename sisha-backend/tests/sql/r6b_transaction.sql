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
