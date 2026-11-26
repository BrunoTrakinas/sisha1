'use strict';
const txt=v=>String(v??'').trim();
const norm=v=>txt(v).normalize('NFD').replace(/[\u0300-\u036f]/g,'').toUpperCase().replace(/[^A-Z0-9]+/g,' ').trim();
const pn=v=>txt(v).toUpperCase().replace(/\s+/g,'');
const loc=v=>txt(v).replace(/\s+/g,' ').toUpperCase();
const sn=v=>{const x=pn(v);return !x||['N/A','NA','S/N','SN','-','---','NULL','SEMSN','SEMS/N'].includes(x)||/^X+$/.test(x)||x.startsWith('EXCLUIR')?null:txt(v).toUpperCase();};
const REVIEW='IDENTIDADE SERIAL A CONFIRMAR';
function reportDate(v){
 let d=v instanceof Date?v.toISOString().slice(0,10):txt(v);
 if(typeof v==='number'&&Number.isInteger(v)&&v>0&&v<100000)d=new Date(Date.UTC(1899,11,30)+v*86400000).toISOString().slice(0,10);
 if(/^\d{2}\/\d{2}\/\d{4}$/.test(d))d=d.split('/').reverse().join('-');
 if(/^\d{4}-\d{2}-\d{2}T/.test(d))d=d.slice(0,10);
 if(!/^\d{4}-\d{2}-\d{2}$/.test(d)||!Number.isFinite(Date.parse(d))||new Date(d+'T00:00:00Z').toISOString().slice(0,10)!==d)throw Error('Data do cabeçalho inválida.');
 return d;
}
function quantity(v,line){
 const q=typeof v==='number'?v:/^\d+(?:[.,]\d+)?$/.test(txt(v))?Number(txt(v).replace(',','.')):NaN;
 if(!Number.isFinite(q)||q<0||Math.abs(q*1e6-Math.round(q*1e6))>1e-5)throw Error('Quantidade inválida na linha '+line);
 return q;
}
function readCanonicalInventory(rows,sheetCount){
 if(sheetCount!==1||!Array.isArray(rows)||!rows.length)throw Error('Envie o InventarioPPUGeralLoc original, com uma única aba.');
 const title=rows.slice(0,15).some(r=>r.some(v=>norm(v)==='INVENTARIO GERAL DO PPU POR LOCALIZACAO'));
 const dates=[];for(let i=0;i<Math.min(rows.length-1,14);i++)for(let j=0;j<rows[i].length;j++)if(norm(rows[i][j])==='DATA')dates.push(reportDate(rows[i+1][j]));
 if(!title||dates.length!==1)throw Error('Título ou data do Inventário Geral não identificado.');
 const observedOn=dates[0],source=[],markers=[],sections=[],headers=new Set(),footerRows=[];
 let section=null,header=null,location=null,finished=false;
 const headerFor=(r,s)=>{
  const h=r.map(norm),find=(...names)=>h.findIndex(v=>names.includes(v));
  const x={pn:find('PN','P N'),q:find('QNTD','QTD','QUANTIDADE'),name:find('NOMENCLATURA'),pi:find('PI','NSN'),sn:find('SN','S N'),dot:find('DOTACAO'),lots:h.flatMap((v,i)=>v==='LOTE'?[i]:[]),price:find('PRECO US','PRECO USD'),sjb:find('SJB'),valid:find('VALIDADE')};
  if(x.pn<0||x.q<0)return null;
  if(x.name<0||x.pi<0||x.price<0||x.sjb<0||x.valid<0||!x.lots.length||(s==='EQUIPAMENTOS'?x.sn<0:x.dot<0||x.sn>=0))throw Error('Cabeçalho incompleto em '+s);
  return x;
 };
 for(let i=0;i<rows.length;i++){
  const r=rows[i]||[],non=r.filter(v=>txt(v)),line=i+1;
  if(!non.length)continue;
  const first=norm(non[0]);
  if(finished)throw Error('Conteúdo inesperado após assinatura, linha '+line);
  if(non.length===1&&['EQUIPAMENTOS','SOBRESSALENTES'].includes(first)){
   if((sections.length===0&&first!=='EQUIPAMENTOS')||(sections.length===1&&first!=='SOBRESSALENTES')||sections.length>=2)throw Error('Ordem de seções inválida.');
   sections.push(first);section=first;header=null;location=null;continue;
  }
  if(!section){if(i>=15)throw Error('Preâmbulo inesperado, linha '+line);continue;}
  if(section==='SOBRESSALENTES'&&non.length===2&&first==='INVENTARIANTE'&&norm(non[1])==='SUPERVISOR'){footerRows.push(line);finished=true;continue;}
  if(non.length===1&&/^LOCALIZA(?:ÇÃO|CAO)\s*:/i.test(txt(non[0]))){location=loc(txt(non[0]).split(':').slice(1).join(':'));if(!location)throw Error('Localização vazia, linha '+line);continue;}
  const next=headerFor(r,section);if(next){header=next;headers.add(section);continue;}
  if(!header||!location)throw Error('Linha sem cabeçalho/localização '+line);
  const part=pn(r[header.pn]),name=txt(r[header.name]);
  if(!part)throw Error('PN ausente, linha '+line);
  const rawSn=header.sn>=0?txt(r[header.sn]):null;
  const doc={source_row:line,source_section:section,pn:part,nomenclatura:name,nsn_pi:txt(r[header.pi]),sn_original:rawSn,quantidade:quantity(r[header.q],line),localizacao:location,lotes:header.lots.map(j=>txt(r[j])||null),dotacao:header.dot>=0?txt(r[header.dot])||null:null,preco_usd:txt(r[header.price])||null,sjb:txt(r[header.sjb])||null,validade:txt(r[header.valid])||null};
  if(part==='DUPLICADO'||part.startsWith('EXCLUIR')||(norm(name).includes('DUPLICADO')&&/NAO APLICAVEL|NAO UTILIZAR/.test(norm(name)))){markers.push(doc);continue;}
  if(['PN','NULL','LIMPEZA'].includes(part))throw Error('PN inválido, linha '+line);
  source.push(doc);
 }
 if(sections.length!==2||headers.size!==2||!finished||!source.some(d=>d.source_section==='EQUIPAMENTOS')||!source.some(d=>d.source_section==='SOBRESSALENTES'))throw Error('Relatório incompleto: exige Equipamentos, Sobressalentes e rodapé original.');
 const groups=new Map();for(const d of source){const id=d.source_section==='EQUIPAMENTOS'&&sn(d.sn_original);const k=id?JSON.stringify([d.pn,pn(id)]):'ROW:'+d.source_row;if(!groups.has(k))groups.set(k,[]);groups.get(k).push(d);}
 const items=[],issues=[];for(const group of groups.values()){
  const d=group[0],equipment=d.source_section==='EQUIPAMENTOS',identity=equipment?sn(d.sn_original):null;
  const reasons=[];if(equipment){if(!identity)reasons.push('SN_AUSENTE_OU_INVALIDO');if(group.length>1)reasons.push('PN_SN_REPETIDO');if(group.some(x=>x.quantidade!==1))reasons.push('QUANTIDADE_SERIAL_DIVERGENTE');}
  const pending=reasons.length>0;
  const item={pn:d.pn,nomenclatura:d.nomenclatura||'N/A',nsn_pi:d.nsn_pi||'N/A',quantidade:Math.max(...group.map(x=>x.quantidade)),localizacao:pending?REVIEW:d.localizacao,sn:pending?null:identity,source_section:d.source_section,source_row:d.source_row,source_extra:{document_rows:group,serial_review:reasons}};
  items.push(item);if(pending)issues.push({pn:d.pn,sn:identity,rows:group.map(x=>x.source_row),locations:[...new Set(group.map(x=>x.localizacao))],quantity:item.quantidade,reasons});
 }
 const summary={physicalRows:rows.length,documentRows:source.length,equipmentRows:source.filter(x=>x.source_section==='EQUIPAMENTOS').length,spareRows:source.filter(x=>x.source_section==='SOBRESSALENTES').length,excludedMarkers:markers.length,operationalRows:items.length,serialReviewGroups:issues.length,serialEvidenceRows:items.filter(x=>x.sn).length,footerRows};
 items[0].source_extra.document_meta={observedOn,summary,excluded_rows:markers};
 return {format:'MARINHA_PPU_GERAL_POR_LOCALIZACAO',observedOn,items,issues,summary};
}
module.exports={readCanonicalInventory,REVIEW};
