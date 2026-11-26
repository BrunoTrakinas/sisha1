'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {buildR6Plan,importPpuR6}=require('../../src/services/ppuReceiptReconciliationService');
const row=(q,localizacao='A-1',sn=null)=>({pn:'P1',quantidade:q,localizacao,sn});
const p=(localizacao_normalizada,contabiliza_ppu=true)=>({localizacao_normalizada,ativo:true,contabiliza_ppu});
const rec=(id,q,extra={})=>({id,numero_recibo:String(id),ativo:true,data_recebimento:'2026-10-01',recebimento_itens:[{id:id*10,pn:'P1',ativo:true,quantidade:q,quantidade_inventariada:0,contabiliza_pelo_recibo:true,condicao_item:'RECEBIDO_DISPONIVEL',tipo_item:'SOBRESSALENTE',...extra}]});
const context=(extra={})=>({token:'x',previous_observed_on:'2026-10-02',previous_rows:[row(1)],previous_policies:[p('A-1'),p('Z')],policies:[p('A-1'),p('Z')],receipts:[rec(1,2)],serial_pns:[],locrec:[],...extra});
const opts={complete:true,observedOn:'2026-11-26'};
const run=(c,r,o=opts)=>buildR6Plan(c,r,o).plans;
test('R6 partial and exact allocation with same and new location',()=>{
  assert.equal(run(context(),[row(2)])[0].pending,1);
  assert.equal(run(context(),[row(1),row(2,'Z')])[0].full,true);
  assert.equal(run(context({receipts:[rec(1,2),rec(2,5)]}),[row(6)])[0].receiptId,2);
});
test('R6 transfer does not debit, unknown or changed policy cannot create eligible gain',()=>{
  assert.equal(run(context(),[row(1,'Z')]).length,0);
  assert.equal(run(context(),[row(1),row(2,'UNKNOWN')]).length,0);
  assert.equal(run(context({previous_policies:[p('A-1'),p('Z',false)]}),[row(1),row(2,'Z')]).length,0);
});
test('R6 blocks PN-wide serial evidence in old inventory, book and receipt',()=>{
  for(const c of [context({previous_rows:[row(1,'A-1','SN1')]}),context({serial_pns:['P1']}),context({receipts:[rec(1,2),rec(2,1,{tipo_item:'EQUIPAMENTO'})]})])
    assert.equal(run(c,[row(4)]).length,0);
});
test('R6 invalid or missing dates and incomplete inventory fail closed',()=>{
  assert.throws(()=>run(context(),[row(2)],{...opts,complete:false}));
  assert.throws(()=>run(context({previous_observed_on:null}),[row(2)]));
  assert.throws(()=>run(context(),[row(2)],{...opts,observedOn:'2026-02-31'}));
});
test('R6 documentary evidence precedes quantity exact',()=>{
  const c=context({receipts:[rec(1,1),rec(2,2)],locrec:[{numero_recibo:'2',pn:'P1',qtd_documental:2,qtd_auditada_aplicada:1,loc_escolhida:'A-1',destino_indicado:'PPU',data_auditoria:'2026-10-20'}]});
  const plan=run(c,[row(2)]);
  assert.equal(plan[0].receiptId,2);assert.equal(plan[0].method,'LOCREC');
});
test('R6 preview is read only and apply uses only transactional RPC',async()=>{
  const calls=[];const db={rpc:async(n,args)=>{calls.push(n);return {data:n==='sisha_ppu_r6_context'?context():{status:'APPLIED',rows:1}};}};
  const args={supabase:db,parsed:{format:'PPU_LEGADO_TABULAR',items:[{source_section:'LEGADO_AGREGADO'}]},rows:[row(2)],buffer:Buffer.from('fixture'),fileName:'fixture.ods',logId:'fixture',user:{email:'test@example.invalid'},options:{...opts,preview:true}};
  assert.equal((await importPpuR6(args)).status,'PREVIEW');
  assert.deepEqual(calls,['sisha_ppu_r6_context']);
  calls.length=0;await importPpuR6({...args,options:opts});
  assert.deepEqual(calls,['sisha_ppu_r6_context','sisha_ppu_r6_apply']);
});
test('R6 SQL migration contains single transaction, server-only RPC, receipt event and immutable snapshot',()=>{
  const s=require('node:fs').readFileSync(require('node:path').resolve(__dirname,'../../sql/migrations/20261126_R6A_001_ppu_reconciliation_atomic.sql'),'utf8');
  assert.match(s,/^begin;/m);assert.match(s,/^commit;/m);assert.match(s,/pg_advisory_xact_lock/);
  assert.match(s,/contexto mudou/);assert.match(s,/ITEM_INCORPORACAO_ESTOQUE_AJUSTADA/);
  assert.match(s,/insert into public\.ppu_inventario_snapshots/);assert.match(s,/security invoker/);
  assert.doesNotMatch(s,/security definer/i);
});

test('R6 replay of the same current source hash submits no plan and cannot debit twice',async()=>{
  const buffer=Buffer.from('fixture');
  const hash=require('node:crypto').createHash('sha256').update(buffer).digest('hex');
  const calls=[];
  const db={rpc:async(n,args)=>{calls.push({n,args});return {data:n==='sisha_ppu_r6_context'?context({source_file_sha256:hash,previous_observed_on:opts.observedOn}):{status:'REUSED'}};}};
  const args={supabase:db,parsed:{format:'PPU_LEGADO_TABULAR',items:[{source_section:'LEGADO_AGREGADO'}]},rows:[row(2)],buffer,fileName:'fixture.ods',logId:'fixture',user:{email:'test@example.invalid'},options:opts};
  assert.equal((await importPpuR6(args)).status,'REUSED');
  assert.deepEqual(calls[1].args.p_plan,[]);
});
test('R6 activation is gated and never falls back on failed transactional RPC',()=>{
  const s=require('node:fs').readFileSync(require('node:path').resolve(__dirname,'../../src/controllers/importController.js'),'utf8');
  assert.match(s,/process\.env\.PPU_RECEIPT_RECONCILIATION_ENABLED === 'true'/);
  const start=s.indexOf("if (process.env.PPU_RECEIPT_RECONCILIATION_ENABLED === 'true')");
  const end=s.indexOf('if (estoqueAtualizado.length > 0)',start);
  const block=s.slice(start,end);
  assert.match(block,/await importPpuR6/);assert.match(block,/return respondSuccess/);
  assert.doesNotMatch(block,/\.delete\(|\.insert\(|catch\s*\(/);
});
