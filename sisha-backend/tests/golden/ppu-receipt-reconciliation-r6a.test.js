'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {buildR6Plan,importPpuR6,validateAggregateCoverage,buildRetroactiveReview,getRetroactiveReview,applyRetroactiveReview,getBookSyncStatus,continueBookSync}=require('../../src/services/ppuReceiptReconciliationService');
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
  const args={supabase:db,parsed:{format:'PPU_LEGADO_TABULAR',items:[{...row(2),source_section:'LEGADO_AGREGADO',source_row:2}]},rows:[row(2)],rawRows:[['PN','QTD','LOCALIZACAO'],['P1',2,'A-1']],sheetCount:1,buffer:Buffer.from('fixture'),fileName:'fixture.ods',logId:'fixture',user:{email:'test@example.invalid'},options:{...opts,preview:true}};
  const preview=await importPpuR6(args);
  assert.equal(preview.status,'PREVIEW');
  assert.deepEqual(calls,['sisha_ppu_r6_context']);
  calls.length=0;await assert.rejects(importPpuR6({...args,options:opts}),/Simulação ausente/);
  assert.deepEqual(calls,['sisha_ppu_r6_context']);
  calls.length=0;await assert.rejects(importPpuR6({...args,buffer:Buffer.from('different'),options:{...opts,previewToken:preview.previewToken}}),/Simulação ausente/);
  assert.deepEqual(calls,['sisha_ppu_r6_context']);
  calls.length=0;await importPpuR6({...args,options:{...opts,previewToken:preview.previewToken}});
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
  const args={supabase:db,parsed:{format:'PPU_LEGADO_TABULAR',items:[{...row(2),source_section:'LEGADO_AGREGADO',source_row:2}]},rows:[row(2)],rawRows:[['PN','QTD','LOCALIZACAO'],['P1',2,'A-1']],sheetCount:1,buffer,fileName:'fixture.ods',logId:'fixture',user:{email:'test@example.invalid'},options:opts};
  const preview=await importPpuR6({...args,options:{...opts,preview:true}});
  assert.equal(preview.status,'PREVIEW_REUSED');
  calls.length=0;
  assert.equal((await importPpuR6({...args,options:{...opts,previewToken:preview.previewToken}})).status,'REUSED');
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

test('R6B aggregate coverage rejects omitted PN or invalid quantity and permits only explicit markers/footer',()=>{
 const raw=[['Localizacao','PI','PN','Nomenclatura','Lote','Preço','QTD'],['A-1','PI','P1','PART','',0,2],['A-1','','DUPLICADO','','',0,1],['A-1','','EXCLUIR-PN','','',0,1],[],['Assinatura']];
 const parsed={items:[{...row(2),source_row:2}],issues:[]};
 assert.deepEqual(validateAggregateCoverage(parsed,raw,1),{recognized:1,markers:2,footers:1});
 assert.throws(()=>validateAggregateCoverage(parsed,[...raw,['A-1','','','ITEM','','',0,2]],1));
 assert.throws(()=>validateAggregateCoverage(parsed,[raw[0],['A-1','PI','P1','PART','',0,'abc']],1));
 assert.throws(()=>validateAggregateCoverage(parsed,raw,2));
});
test('R6B historical LOCREC does not take priority over the current inventory window',()=>{
 const c=context({receipts:[rec(1,1),rec(2,2)],locrec:[{numero_recibo:'2',pn:'P1',qtd_documental:2,qtd_auditada_aplicada:1,loc_escolhida:'A-1',destino_indicado:'PPU',data_auditoria:'2026-10-02'}]});
 const plan=run(c,[row(2)]);
 assert.equal(plan[0].receiptId,1);assert.equal(plan[0].method,'QTD_EXATA');
});

test('R7 historical review stays consultative and subtracts incremental allocations',()=>{
 const c=context({receipts:[rec(1,4)],locrec:[{numero_recibo:'1',pn:'P1',qtd_documental:4,qtd_auditada_aplicada:3,loc_escolhida:'A-1',destino_indicado:'PPU',data_auditoria:'2026-10-02'}]});
 const result=buildRetroactiveReview(c,[row(4)],opts,[{itemId:10,quantity:1}]);
 assert.equal(result.automatic,false);assert.equal(result.candidates[0].candidateQuantity,2);
 assert.equal(result.candidates[0].remaining,3);assert.equal(result.candidates[0].reason,'EVIDENCIA_ANTERIOR_AO_INVENTARIO');
 assert.equal(buildRetroactiveReview({...c,serial_pns:['P1']},[row(4)],opts).candidates[0].candidateQuantity,0);
 assert.equal(buildRetroactiveReview(c,[row(2)],opts).candidates[0].candidateQuantity,0);
});
test('R7 dedicated endpoint cannot fall back to old destructive importer',()=>{
 const fs=require('node:fs'),path=require('node:path');
 const routes=fs.readFileSync(path.resolve(__dirname,'../../src/routes/importRoutes.js'),'utf8');
 const controller=fs.readFileSync(path.resolve(__dirname,'../../src/controllers/importController.js'),'utf8');
 const ui=fs.readFileSync(path.resolve(__dirname,'../../../sisha-frontend/src/pages/Cadastro.jsx'),'utf8');
 assert.match(routes,/router\.post\('\/ppu\/reconciliacao', requireRole\(\['admin'\]\)/);
 assert.match(routes,/inventario_ppu_simulacao/);
 assert.match(controller,/req\.ppuReconciliationRequest && process\.env\.PPU_RECEIPT_RECONCILIATION_ENABLED !== 'true'/);
 assert.match(ui,/apiFetch\('\/import\/ppu\/reconciliacao'/);
 assert.match(ui,/previewToken/);
});

test('R7B1 historical review requires dated inventory, individual evidence and a fresh token',async()=>{
 const c=context({source_file_sha256:'a'.repeat(64),previous_observed_on:'2026-11-26',previous_rows:[row(4)],receipts:[rec(1,4)],locrec:[{id:99,numero_recibo:'1',pn:'P1',qtd_documental:4,qtd_auditada_aplicada:3,loc_escolhida:'A-1',destino_indicado:'PPU',data_auditoria:'2026-10-02'}]});
 let current=c;const calls=[];
 const db={rpc:async(n,args)=>{calls.push({n,args});return {data:n==='sisha_ppu_r6_context'?current:{status:'APPLIED',pending:3}};}};
 const actor='fixture@example.invalid';
 const review=await getRetroactiveReview(db,actor);
 assert.equal(review.status,'REVIEW_READY');assert.equal(review.candidates[0].candidateQuantity,3);
 const body={token:review.token,itemId:10,locrecId:99,quantity:1,evidence:'Synthetic actual entry reference',confirmed:true};
 await assert.rejects(applyRetroactiveReview(db,actor,{...body,confirmed:false}),/Confirme/);
 await assert.rejects(applyRetroactiveReview(db,actor,{...body,quantity:4}),/não elegível/);
 await assert.rejects(applyRetroactiveReview(db,'other@example.invalid',body),/desatualizada/);
 current={...c,token:'changed'};
 await assert.rejects(applyRetroactiveReview(db,actor,body),/desatualizada/);
 assert.equal(calls.filter(c=>c.n==='sisha_ppu_r7_retro_apply').length,0);
 current=c;
 assert.equal((await applyRetroactiveReview(db,actor,body)).status,'APPLIED');
 assert.equal(calls.filter(c=>c.n==='sisha_ppu_r7_retro_apply').length,1);
 current={...c,source_file_sha256:null,previous_observed_on:null};
 assert.equal((await getRetroactiveReview(db,actor)).status,'WAITING_NEW_INVENTORY');
});

test('R7B2 native report preserves SN and source row without using quantity to debit its PN',async()=>{
 const {parsePpuInventoryRows,validateNativeCoverage}=require('../../src/services/ppuInventoryParserService');
 const raw=[['EQUIPAMENTOS'],['LOCALIZAÇÃO : Z'],['PN','SN','QNTD'],['P-SERIAL','S1',1],['SOBRESSALENTES'],['LOCALIZAÇÃO : A-1'],['PN','QNTD'],['P1',2]];
 const parsed=parsePpuInventoryRows(raw);
 assert.deepEqual(validateNativeCoverage(parsed,raw,1),{recognized:2,serials:1});
 const bad=[...raw.slice(0,3),['P-SERIAL','S1',2],...raw.slice(4)];
 assert.throws(()=>validateNativeCoverage(parsePpuInventoryRows(bad),bad,1));
 const duplicate=[...raw.slice(0,4),['P-SERIAL','S1',1],...raw.slice(4)];
 assert.throws(()=>validateNativeCoverage(parsePpuInventoryRows(duplicate),duplicate,1));
 const serialReceipt={...rec(2,1,{sn:'S1',tipo_item:'EQUIPAMENTO'}),recebimento_itens:[{...rec(2,1,{sn:'S1',tipo_item:'EQUIPAMENTO'}).recebimento_itens[0],pn:'P-SERIAL'}]};
 const c=context({receipts:[rec(1,2),serialReceipt]});
 const rows=parsed.items.map(({pn,localizacao,quantidade,sn,nsn_pi,nomenclatura})=>({pn,localizacao,quantidade,sn,nsn_pi,nomenclatura}));
 const calls=[];
 const db={rpc:async(n,args)=>{calls.push({n,args});return {data:n==='sisha_ppu_r6_context'?c:{status:'APPLIED',book_sync:{state:'PENDING'}}};}};
 const args={supabase:db,parsed,rows,rawRows:raw,sheetCount:1,buffer:Buffer.from('native-fixture'),fileName:'fixture.xls',logId:'fixture',user:{email:'fixture@example.invalid'},options:{...opts,preview:true}};
 const preview=await importPpuR6(args);
 assert.equal(preview.serialEvidenceRows,1);assert.equal(preview.plans.length,1);
 assert.ok(preview.plans.every(p=>p.pn==='P1'));
 await importPpuR6({...args,options:{...opts,previewToken:preview.previewToken}});
 const write=calls.find(c=>c.n==='sisha_ppu_r6_apply');
 assert.equal(write.args.p_rows[0].sn,'S1');assert.equal(write.args.p_rows[0].source_row,4);
});
test('R7B2 Livro sync uses existing source identity and acknowledges only a complete batch',async()=>{
 const sourceHash='a'.repeat(64),items=[{pn:'P-SERIAL',sn:'S1',source_row:4}];
 const claim={state:'RUNNING',attempt_id:'attempt',items,sourceHash,fileName:'fixture.xls',capturedAt:'2025-04-01T00:00:00Z',observedOn:'2025-03-31'};
 const calls=[];
 const db={rpc:async(n,args)=>{calls.push({n,args});return {data:n==='sisha_ppu_r7_book_claim'?claim:{state:args.p_ok?'COMPLETE':'PENDING',cursor:args.p_ok?1:0}};}};
 const ok=await continueBookSync(db,'fixture@example.invalid','snapshot',async(parsed,options)=>{
    assert.deepEqual(parsed.items,items);assert.equal(options.sourceHash,sourceHash);assert.equal(options.capturedAt,claim.capturedAt);
    return {source_sha256:sourceHash,events:1};
 });
 assert.equal(ok.state,'COMPLETE');assert.equal(calls[1].args.p_ok,true);
 const failed=await continueBookSync(db,'fixture@example.invalid','snapshot',async()=>{throw new Error('fixture failure');});
 assert.equal(failed.retryRequired,true);assert.equal(calls[3].args.p_ok,false);
 const missing=await continueBookSync(db,'fixture@example.invalid','snapshot',async()=>({source_sha256:sourceHash,events:0}));
 assert.equal(missing.retryRequired,true);assert.equal(calls[5].args.p_ok,false);
});
