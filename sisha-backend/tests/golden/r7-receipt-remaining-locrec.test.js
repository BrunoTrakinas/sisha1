'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {applyLocrecReceiptLocations}=require('../../src/services/ppuEffectiveAvailabilityService');
const base={origem_saldo:'RECIBO_PENDENTE',recebimento_id:1,recebimento_item_id:10,numero_recibo:'R-1',pn:'P1',quantidade:1,localizacao:'HANGAR'};
const evidence={numero_recibo:'R-1',pn:'P1',qtd_documental:2,qtd_auditada_aplicada:2,loc_escolhida:'A-1',destino_indicado:'PPU'};
test('R7 remaining receipt balance keeps original identity and quantity instead of full LOCREC location',()=>{
 const official={origem_saldo:'PPU_OFICIAL',pn:'P1',quantidade:2,localizacao:'A-1'};
 const rows=applyLocrecReceiptLocations([base,official],[evidence],new Set([JSON.stringify(['1','P1'])]));
 assert.equal(rows.length,2);
 const pending=rows.find(r=>r.origem_saldo==='RECIBO_PENDENTE');
 assert.equal(pending.quantidade,1);assert.equal(pending.recebimento_item_id,10);
 assert.equal(pending.locrec_status,'SALDO_REMANESCENTE_LOCAL_A_CONFIRMAR');
 assert.equal(pending.localizacao,'Localização a confirmar');
 assert.equal(rows.reduce((n,r)=>n+r.quantidade,0),3);
});
test('R7 no incorporation preserves prior LOCREC display',()=>{
 const rows=applyLocrecReceiptLocations([base],[evidence]);
 assert.equal(rows[0].localizacao,'A-1');assert.equal(rows[0].quantidade,1);
});
test('R7 repeated receipt number across different receipts preserves separate identities',()=>{
 const rows=applyLocrecReceiptLocations([base,{...base,recebimento_id:2,recebimento_item_id:20,sn:'SN-2'}],[evidence]);
 assert.equal(rows.length,2);assert.equal(rows[1].sn,'SN-2');
 assert.ok(rows.every(r=>r.locrec_status==='SALDO_REMANESCENTE_LOCAL_A_CONFIRMAR'));
});
