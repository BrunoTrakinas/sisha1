'use strict';
const { test } = require('node:test');
const { planReceiptInventoryReconciliation } = require('../../src/services/receiptInventoryReconciliationPlanner');

function cases(plan) {
  const row=(q,l='A-1',sn=null,eligibleLocation=true)=>({pn:'1234',quantidade:q,localizacao:l,sn,eligibleLocation});
  const receipt=(id,q,at='2026-11-01',extra={})=>({id,numero_recibo:id,ativo:true,data_recebimento:at,recebimento_itens:[{id:id+'-i',ativo:true,pn:'1234',quantidade:q,quantidade_inventariada:0,contabiliza_pelo_recibo:true,condicao_item:'RECEBIDO_DISPONIVEL',...extra}]});
  const run=(old,now,receipts,locrecMatches=[])=>plan({previous:{complete:true,observedAt:'2026-11-10',rows:old},current:{complete:true,observedAt:'2026-11-20',rows:now},receipts,locrecMatches});
  const checks=[];
  const check=(name,ok)=>{if(!ok)throw new Error(name);checks.push(name);};
  let p=run([row(1)],[row(2)],[receipt('r1',1)]).plans;check('incorporacao total mesma loc',p.length===1&&p[0].full&&p[0].location==='A-1');
  p=run([row(1)],[row(1),row(1,'Z')],[receipt('r1',1)]).plans;check('nova localizacao',p.length===1&&p[0].location==='Z');
  p=run([row(1)],[row(2)],[receipt('r1',2)]).plans;check('incorporacao parcial',p[0].quantity===1&&p[0].pending===1);
  p=run([row(1)],[row(6)],[receipt('r1',2),receipt('r2',5,'2026-11-02'),receipt('r3',8,'2026-11-03')]).plans;check('quantidade exata antes de FIFO',p.length===1&&p[0].receiptId==='r2');
  p=run([row(1)],[row(5)],[receipt('r1',2),receipt('r2',3,'2026-11-02')]).plans;check('FIFO repartido',p.length===2&&p[0].quantity===2&&p[1].quantity===2);
  p=run([row(1)],[row(1,'Z')],[receipt('r1',1)]).plans;check('remanejamento sem aumento',p.length===0);
  p=run([row(2)],[row(2)],[receipt('r1',1)]).plans;check('reenvio sem incremento',p.length===0);
  p=run([row(2)],[row(1)],[receipt('r1',1)]).plans;check('reducao nao debita',p.length===0);
  p=run([row(1)],[row(2)],[receipt('r1',1,'2026-11-01',{destino_previsto:'CEIMSPA'})]).plans;check('exclui CEIMSPA',p.length===0);
  p=run([row(1)],[row(2)],[receipt('r1',1,'2026-11-21')]).plans;check('recibo posterior ao inventario',p.length===0);
  p=run([row(1)],[row(2)],[receipt('r1',1,'2026-11-01',{condicao_item:'QUARENTENA'})]).plans;check('exclui quarentena',p.length===0);
  p=run([row(1)],[row(2,'A-1',null,false)],[receipt('r1',1)]).plans;check('local nao classificado',p.length===0);
  p=run([],[row(1,'Z','S1')],[receipt('r1',1,'2026-11-01',{sn:'S1'})]).plans;check('PN SN novo',p.length===1&&p[0].method==='PN_SN');
  p=run([row(1,'A-1','S1')],[row(1,'Z','S1')],[receipt('r1',1,'2026-11-01',{sn:'S1'})]).plans;check('serial ja existente',p.length===0);
  p=run([],[row(1,'Z','S1')],[receipt('r1',1,'2026-11-01',{sn:'S1'}),receipt('r2',1,'2026-11-02',{sn:'S1'})]).plans;check('serial disputado',p.length===0);
  p=run([row(1)],[row(2)],[receipt('r1',1),receipt('r2',2,'2026-11-02')],[{verified:true,itemId:'r2-i',pn:'1234',location:'A-1',quantity:1,observedAt:'2026-11-15'}]).plans;check('LOCREC precede quantidade exata',p.length===1&&p[0].receiptId==='r2'&&p[0].method==='LOCREC');
  p=run([row(1)],[row(3)],[receipt('r1',3,'2026-11-01',{quantidade_inventariada:1})]).plans;check('respeita incorporacao anterior',p[0].before===1&&p[0].after===3);
  p=run([row(2)],[row(1),row(2,'Z')],[receipt('r1',1)]).plans;check('remanejamento e incremento simultaneos sem atribuir loc',p.length===1&&p[0].location===null);
  check('baseline obrigatoria',plan({current:{complete:true,observedAt:'2026-11-20',rows:[row(2)]}}).status==='BASELINE_REQUIRED');
  return checks;
}

test('receipt/inventory planner contracts', () => { cases(planReceiptInventoryReconciliation); });
