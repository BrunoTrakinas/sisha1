'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const xlsx=require('xlsx');
const {readCanonicalInventory,REVIEW}=require('../../src/services/ppuCanonicalInventoryService');
function row(x){const r=Array(25).fill('');for(const [k,v] of Object.entries(x))r[Number(k)-1]=v;return r;}
const equipment=(part,serial,q)=>row({1:'Equipment',2:part,8:serial,9:'00123',12:q,15:'LOT-E',17:0,20:'F',23:'2030-05-15T00:00:00'});
const fixture=()=>[
 row({5:'Synthetic fixture',19:'DATA'}),row({5:'Inventário Geral do PPU por Localização',19:46352}),['EQUIPAMENTOS'],
 row({1:'NOMENCLATURA',2:'PN',8:'SN',9:'PI',12:'QNTD',15:'LOTE',17:'PREÇO US$',20:'SJB',23:'VALIDADE'}),
 ['LOCALIZAÇÃO : A-1'],equipment('E1','0001',1),equipment('E2','0002',2),equipment('E3','',1),equipment('E4','0004',1),equipment('DUPLICADO','EXCLUIR',1),
 ['LOCALIZAÇÃO : Z'],equipment('E4','0004',1),[],['SOBRESSALENTES'],
 row({1:'NOMENCLATURA',3:'PN',7:'Lote',10:'PI',11:'DOTAÇÃO',13:'QNTD',16:'LOTE',18:'PREÇO US$',21:'SJB',22:'VALIDADE'}),
 ['LOCALIZAÇÃO : A-1'],row({1:'Spare',3:'P1',7:'L-A',10:'00009',11:99,13:3,16:'L-B',18:1.25,21:'VH',22:'2030-05-15'}),[],row({1:'Inventariante',14:'Supervisor'})
];
test('R8HF SheetJS reads native XML Spreadsheet with merged cells, dates and exceptions',()=>{
 const rows=fixture(),ws=xlsx.utils.aoa_to_sheet(rows);
 ws['!merges']=[{s:{r:0,c:4},e:{r:0,c:17}},{s:{r:1,c:4},e:{r:1,c:17}},{s:{r:2,c:0},e:{r:2,c:24}},{s:{r:5,c:1},e:{r:5,c:6}},{s:{r:13,c:0},e:{r:13,c:24}},{s:{r:18,c:0},e:{r:18,c:12}}];
 const wb=xlsx.utils.book_new();xlsx.utils.book_append_sheet(wb,ws,'Report');
 const buffer=xlsx.write(wb,{bookType:'xlml',type:'buffer'});
 const decoded=xlsx.read(buffer,{type:'buffer'}),raw=xlsx.utils.sheet_to_json(decoded.Sheets.Report,{header:1,defval:''});
 const result=readCanonicalInventory(raw,decoded.SheetNames.length);
 assert.equal(result.observedOn,'2026-11-26');
 assert.equal(result.summary.documentRows,6);assert.equal(result.summary.operationalRows,5);
 assert.equal(result.summary.excludedMarkers,1);assert.equal(result.summary.serialReviewGroups,3);
 assert.equal(result.summary.serialEvidenceRows,1);
 assert.equal(result.items.find(x=>x.pn==='E1').sn,'0001');
 assert.equal(result.items.find(x=>x.pn==='E2').quantidade,2);
 assert.equal(result.items.find(x=>x.pn==='E4').source_extra.document_rows.length,2);
 assert.ok(result.items.filter(x=>x.source_extra.serial_review.length).every(x=>x.sn===null&&x.localizacao===REVIEW));
 const p=result.items.find(x=>x.pn==='P1');
 assert.equal(p.quantidade,3);assert.equal(p.source_extra.document_rows[0].dotacao,'99');
 assert.deepEqual(p.source_extra.document_rows[0].lotes,['L-A','L-B']);
});
test('R8HF rejects summarized, truncated and malformed reports',()=>{
 assert.throws(()=>readCanonicalInventory([['PN','QTD','Localizacao'],['P1',2,'A-1']],1));
 const r=fixture();assert.throws(()=>readCanonicalInventory(r.slice(0,-1),1));
 const bad=fixture();bad[16][12]='invalid';assert.throws(()=>readCanonicalInventory(bad,1),/Quantidade/);
});
