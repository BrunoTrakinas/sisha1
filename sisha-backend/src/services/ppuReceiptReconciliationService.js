'use strict';
const crypto = require('node:crypto');
const { planReceiptInventoryReconciliation } = require('./receiptInventoryReconciliationPlanner');
const pn = v => String(v ?? '').trim().toUpperCase().replace(/\s+/g,'');
const loc = v => String(v ?? '').trim().toUpperCase().replace(/\s+/g,' ');
const receiptNo = v => pn(v).replace(/\\/g,'/');
const date = v => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(v || ''))) return null;
  const d = new Date(v+'T00:00:00Z');
  return Number.isFinite(d.getTime()) && d.toISOString().slice(0,10)===v ? v : null;
};
const key = (...v) => JSON.stringify(v);
const qty = v => Number(v || 0);
function buildR6Plan(context, rows, options) {
  const observedOn=date(options.observedOn);
  const previousOn=date(context.previous_observed_on || options.previousObservedOn);
  if (!observedOn || !previousOn || previousOn>=observedOn || options.complete!==true
      || (!context.previous_observed_on && String(options.previousDateEvidence||'').trim().length<10)) {
    throw new Error('Confirme inventário completo e datas operacionais anterior e atual, com referência documental.');
  }
  if (!Array.isArray(rows)||!rows.length || rows.some(r=>!pn(r.pn)||!loc(r.localizacao)||!Number.isFinite(Number(r.quantidade))||Number(r.quantidade)<0||String(r.sn||'').trim())) {
    throw new Error('R6A aceita somente inventário resumido válido sem SN; formatos serializados exigem homologação.');
  }
  const old=context.previous_rows || [];
  const serial=new Set((context.serial_pns||[]).map(pn));
  for(const r of [...old,...rows]) if(String(r.sn||'').trim()) serial.add(pn(r.pn));
  for(const r of context.receipts||[]) for(const i of r.recebimento_itens||[])
    if(i.tipo_item==='EQUIPAMENTO'||String(i.sn||'').trim()||i.equipamento_id)serial.add(pn(i.pn));
  const allowed = p => p?.ativo===true&&p?.contabiliza_ppu===true;
  const oldPolicy=new Map((context.previous_policies||[]).map(p=>[loc(p.localizacao_normalizada),p]));
  const policy=new Map((context.policies||[]).map(p=>[loc(p.localizacao_normalizada),p]));
  const eligible=l=>allowed(policy.get(loc(l)))&&allowed(oldPolicy.get(loc(l)))&&!['NÃO DEFINIDO','CONFLITO DE LOCALIZAÇÃO'].includes(loc(l));
  const usable=r=>!serial.has(pn(r.pn))&&!['DUPLICADO','LIMPEZA','NULL','PN'].includes(pn(r.pn))&&!pn(r.pn).startsWith('EXCLUIR');
  const convert=r=>({...r,pn:pn(r.pn),sn:null,localizacao:loc(r.localizacao),eligibleLocation:eligible(r.localizacao)});
  const receipts=(context.receipts||[]).map(r=>({...r,ativo:r.ativo!==false,recebimento_itens:(r.recebimento_itens||[]).filter(i=>
    usable(i)&&i.tipo_item==='SOBRESSALENTE'&&!i.equipamento_id&&!String(i.sn||'').trim()&&!['VENCIDO','REVISAR','SEM_ESTOQUE'].includes(i.validade_status)
    &&date(r.data_recebimento)&&r.data_recebimento<observedOn).map(i=>({...i,ativo:i.ativo!==false}))}));
  // Only uniquely attributable, complete, dated LOCREC groups with a single
  // receipt line and one destination are passed to the existing planner.
  const docs=new Map(), receiptGroups=new Map(), locationClaims=new Map();
  for(const r of context.receipts||[])for(const i of r.recebimento_itens||[]){
    const k=key(receiptNo(r.numero_recibo),pn(i.pn));
    if(!receiptGroups.has(k))receiptGroups.set(k,[]);
    receiptGroups.get(k).push({r,i});
  }
  for(const d of context.locrec||[]){
    const k=key(receiptNo(d.numero_recibo),pn(d.pn));
    if(!docs.has(k))docs.set(k,[]);
    docs.get(k).push(d);
    if(d.destino_indicado==='PPU'&&qty(d.qtd_auditada_aplicada)>0){
      const l=key(pn(d.pn),loc(d.loc_escolhida));
      locationClaims.set(l,(locationClaims.get(l)||0)+qty(d.qtd_auditada_aplicada));
    }
  }
  const available=new Map();
  for(const r of rows){const k=key(pn(r.pn),loc(r.localizacao));available.set(k,(available.get(k)||0)+qty(r.quantidade));}
  const matches=[];
  for(const [k,ds] of docs){
    const rs=receiptGroups.get(k)||[];
    if(ds.length!==1||rs.length!==1)continue;
    const d=ds[0],{r,i}=rs[0],l=loc(d.loc_escolhida),q=qty(d.qtd_auditada_aplicada);
    const day=date(String(d.data_auditoria||'').slice(0,10));
    const lk=key(pn(d.pn),l);
    if(!usable(i)||!eligible(l)||d.destino_indicado!=='PPU'||q<=0||qty(d.qtd_documental)!==qty(i.quantidade)
       ||q>qty(i.quantidade)||!day||!date(r.data_recebimento)||day<r.data_recebimento||day<=previousOn||day>observedOn
       ||(available.get(lk)||0)<(locationClaims.get(lk)||0))continue;
    matches.push({verified:true,itemId:i.id,pn:pn(i.pn),location:l,quantity:q,observedAt:day});
  }
  const plan=planReceiptInventoryReconciliation({
    previous:{complete:true,observedAt:previousOn,rows:old.filter(usable).map(convert)},
    current:{complete:true,observedAt:observedOn,rows:rows.filter(usable).map(convert)},
    receipts,locrecMatches:matches
  });
  if(plan.status!=='PLAN_READY')throw new Error('R6: plano não liberado');
  return {...plan,previousOn,observedOn,blockedSerialPns:serial.size};
}
// Verify the parser covered every physical material row. This is deliberately strict
// for summarized reports: blank rows and the known footer are not material.
function validateAggregateCoverage(parsed, rawRows, sheetCount) {
  if (!Array.isArray(rawRows) || sheetCount !== 1) throw new Error('R6: relatório resumido deve ter uma única aba verificável.');
  const norm=v=>String(v??'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toUpperCase().replace(/[^A-Z0-9]+/g,' ').trim();
  const names={pn:['PN','P N','PART NUMBER','PART NO'],q:['QNTD','QTD','QTY','QTDE','QTE','QUANTIDADE','QUANTITY'],loc:['LOCALIZACAO','LOCAL','LOC','LOCATION']};
  const cols=(row,aliases)=>row.findIndex(v=>aliases.includes(norm(v)));
  const header=rawRows.slice(0,100).findIndex(row=>cols(row,names.pn)>=0&&cols(row,names.q)>=0&&cols(row,names.loc)>=0);
  if(header<0)throw new Error('R6: cabeçalho PN/QTD/LOC não identificado.');
  const indices={pn:cols(rawRows[header],names.pn),q:cols(rawRows[header],names.q),loc:cols(rawRows[header],names.loc)};
  // Preserve exact source-row identity, including zero quantities; never treat malformed
  // quantities as zero merely because the permissive legacy parser does.
  const byRow=new Map();
  for(const item of parsed.items||[]){
    if(!Number.isInteger(item.source_row)||byRow.has(item.source_row))throw new Error('R6: cobertura de linhas inconsistente.');
    byRow.set(item.source_row,item);
  }
  let recognized=0,markers=0,footers=0;
  for(let n=header+1;n<rawRows.length;n++){
    const row=rawRows[n]||[],cells=row.filter(v=>String(v??'').trim()!=='');
    if(!cells.length)continue;
    const part=pn(row[indices.pn]);
    if(part==='DUPLICADO'||part.startsWith('EXCLUIR')){if(byRow.has(n+1))throw new Error('R6: marcador virou material.');markers++;continue;}
    if(!part&&cells.length===1&&norm(cells[0])==='ASSINATURA'){footers++;continue;}
    const raw=row[indices.q];
    const qtext=String(raw??'').trim();
    let q=typeof raw==='number'?raw:NaN;
    if(typeof raw!=='number'&&/^\d+(?:[.,]\d+)?$/.test(qtext))q=Number(qtext.replace(',','.'));
    const item=byRow.get(n+1);
    if(!part||!loc(row[indices.loc])||!Number.isFinite(q)||q<0||Math.abs(q*1e6-Math.round(q*1e6))>1e-5||!item||pn(item.pn)!==part||loc(item.localizacao)!==loc(row[indices.loc])||Number(item.quantidade)!==q){
      throw new Error('R6: linha de material inválida ou não reconhecida ('+(n+1)+').');
    }
    recognized++;
  }
  if(recognized!==byRow.size||recognized===0)throw new Error('R6: cobertura do relatório diverge do parser.');
  return {recognized,markers,footers};
}
function buildRetroactiveReview(context, rows, options, plans=[]) {
  // Consultative only. Match receipt number + PN and documentary quantity.
  // Do not assert that a historical audit equals physical incorporation.
  const groups=new Map(), docs=new Map(), stock=new Map(), claims=new Map(), applied=new Map();
  const previousOn=date(context.previous_observed_on||options.previousObservedOn);
  const observedOn=date(options.observedOn);
  const policies=new Map((context.policies||[]).map(x=>[loc(x.localizacao_normalizada),x]));
  const serial=new Set((context.serial_pns||[]).map(pn));
  for(const r of [...(context.previous_rows||[]),...rows])if(String(r.sn||'').trim())serial.add(pn(r.pn));
  for(const r of context.receipts||[])for(const i of r.recebimento_itens||[]){
    if(i.ativo===false||r.ativo===false)continue;
    if(i.tipo_item==='EQUIPAMENTO'||String(i.sn||'').trim()||i.equipamento_id)serial.add(pn(i.pn));
    const k=key(receiptNo(r.numero_recibo),pn(i.pn));
    if(!groups.has(k))groups.set(k,[]);
    groups.get(k).push({r,i});
  }
  for(const d of context.locrec||[]){
    const k=key(receiptNo(d.numero_recibo),pn(d.pn));
    if(!docs.has(k))docs.set(k,[]);
    docs.get(k).push(d);
    if(d.destino_indicado==='PPU'&&qty(d.qtd_auditada_aplicada)>0){
      const lk=key(pn(d.pn),loc(d.loc_escolhida));
      claims.set(lk,(claims.get(lk)||0)+qty(d.qtd_auditada_aplicada));
    }
  }
  for(const r of rows){const k=key(pn(r.pn),loc(r.localizacao));stock.set(k,(stock.get(k)||0)+qty(r.quantidade));}
  for(const p of plans)applied.set(String(p.itemId),(applied.get(String(p.itemId))||0)+qty(p.quantity));
  const candidates=[];
  const counts={review:0,conflict:0,serial:0};
  for(const [k,ds] of docs){
    const rs=groups.get(k)||[];
    if(!rs.length||!ds.some(d=>d.destino_indicado==='PPU'&&qty(d.qtd_auditada_aplicada)>0))continue;
    const pending=rs.filter(({i})=>i.contabiliza_pelo_recibo===true&&i.condicao_item==='RECEBIDO_DISPONIVEL'&&i.destino_previsto!=='CEIMSPA'&&i.destino_estoque!=='CEIMSPA'&&qty(i.quantidade)>qty(i.quantidade_inventariada));
    if(!pending.length)continue;
    const total=rs.reduce((a,{i})=>a+qty(i.quantidade),0);
    const document=ds.reduce((a,d)=>a+qty(d.qtd_documental),0);
    const audited=ds.reduce((a,d)=>a+qty(d.qtd_auditada_aplicada),0);
    const remaining=pending.reduce((a,{i})=>a+Math.max(0,qty(i.quantidade)-qty(i.quantidade_inventariada)-(applied.get(String(i.id))||0)),0);
    if(remaining<=0)continue;
    const p=pn(rs[0].i.pn);
    let reason='REVISAR_EVIDENCIA_HISTORICA',cap=0;
    if(serial.has(p)){reason='SERIAL_EXIGE_IDENTIDADE';counts.serial++;}
    else if(!previousOn||!observedOn||rs.length!==1||ds.length!==1||Math.abs(total-document)>1e-6||audited>total){
      reason='DOCUMENTO_OU_GRUPO_AMBIGUO';counts.conflict++;
    }else{
      const d=ds[0],{r,i}=rs[0],l=loc(d.loc_escolhida),day=date(String(d.data_auditoria||'').slice(0,10)),lk=key(p,l);
      const policy=policies.get(l);
      if(!day||!date(r.data_recebimento)||r.data_recebimento>=observedOn||day<r.data_recebimento||day>observedOn||d.destino_indicado!=='PPU'||!policy?.ativo||!policy?.contabiliza_ppu||(policy.destino_contabilizacao&&policy.destino_contabilizacao!=='PPU')||i.tipo_item!=='SOBRESSALENTE'||['NÃO DEFINIDO','NAO DEFINIDO','CONFLITO DE LOCALIZAÇÃO','CONFLITO DE LOCALIZACAO'].includes(l)||['VENCIDO','REVISAR','SEM_ESTOQUE'].includes(i.validade_status)||(stock.get(lk)||0)<(claims.get(lk)||0)){
        reason='DATA_LOCAL_OU_QUANTIDADE_DIVERGENTE';counts.conflict++;
      }else{
        cap=Math.max(0,Math.min(remaining,qty(d.qtd_auditada_aplicada)-qty(i.quantidade_inventariada)-(applied.get(String(i.id))||0)));
        if(cap<=0)continue;
        counts.review++;
        reason=day<=previousOn?'EVIDENCIA_ANTERIOR_AO_INVENTARIO':'EVIDENCIA_NAO_CONSUMIDA';
      }
    }
    candidates.push({receiptNo:rs[0].r.numero_recibo,pn:p,remaining:Number(remaining.toFixed(6)),candidateQuantity:Number(cap.toFixed(6)),reason,locations:[...new Set(ds.map(d=>loc(d.loc_escolhida)).filter(Boolean))],
      itemId:cap>0&&rs.length===1?rs[0].i.id:null,locrecId:cap>0&&ds.length===1?ds[0].id:null});
  }
  return {counts,candidates,automatic:false};
}
function previewFingerprint({context,hash,options,plan,user}) {
  return crypto.createHash('sha256').update(JSON.stringify({
    version:'R7A',context:context.token,hash,actor:user.email,
    observedOn:options.observedOn,previousObservedOn:options.previousObservedOn||null,
    previousDateEvidence:options.previousDateEvidence||null,complete:options.complete===true,
    plan
  })).digest('hex');
}
function requirePreview(options,token){
  if(options.preview!==true && options.previewToken!==token)throw new Error('Simulação ausente ou desatualizada. Confira novamente antes de confirmar.');
}
async function importPpuR6({supabase,parsed,rows,rawRows,sheetCount,buffer,fileName,logId,user,options}) {
  if(parsed?.format!=='PPU_LEGADO_TABULAR'||(parsed.items||[]).some(r=>r.source_section!=='LEGADO_AGREGADO'))
    throw new Error('R6A: relatório serializado não homologado; não substitua o inventário por esta rotina.');
  if(!Buffer.isBuffer(buffer)||!buffer.length||!logId||!user?.email)throw new Error('R6: trilha de importação obrigatória.');
  validateAggregateCoverage(parsed,rawRows,sheetCount);
  const {data:context,error:readError}=await supabase.rpc('sisha_ppu_r6_context');
  if(readError)throw readError;
  const hash=crypto.createHash('sha256').update(buffer).digest('hex');
  if(context.source_file_sha256===hash && context.previous_observed_on===date(options.observedOn) && options.complete===true){
    const previewToken=previewFingerprint({context,hash,options,plan:[],user});
    if(options.preview===true)return {status:'PREVIEW_REUSED',rows:rows.length,allocations:0,quantity:0,previewToken,plans:[],retroactive:{counts:{review:0,conflict:0,serial:0},candidates:[],automatic:false}};
    requirePreview(options,previewToken);
    const {data,error}=await supabase.rpc('sisha_ppu_r6_apply',{
      p_context_token:context.token,p_source_sha256:hash,p_file_name:fileName,p_import_log_id:logId,
      p_observed_on:options.observedOn,p_previous_observed_on:null,p_previous_date_evidence:null,
      p_complete:true,p_rows:rows,p_plan:[],p_actor:user.email
    });
    if(error)throw error;
    if(data?.status!=='REUSED')throw new Error('R6: replay não confirmado.');
    return data;
  }
  const plan=buildR6Plan(context,rows,options);
  const previewToken=previewFingerprint({context,hash,options,plan:plan.plans,user});
  if(options.preview===true)return {status:'PREVIEW',rows:rows.length,allocations:plan.plans.length,quantity:plan.plans.reduce((s,p)=>s+p.quantity,0),warnings:plan.warnings,plans:plan.plans,previewToken,
    retroactive:buildRetroactiveReview(context,rows,options,plan.plans),blockedSerialPns:plan.blockedSerialPns};
  requirePreview(options,previewToken);
  const {data,error}=await supabase.rpc('sisha_ppu_r6_apply',{
    p_context_token:context.token,p_source_sha256:hash,p_file_name:fileName,p_import_log_id:logId,
    p_observed_on:plan.observedOn,p_previous_observed_on:plan.previousOn,p_previous_date_evidence:options.previousDateEvidence||null,
    p_complete:true,p_rows:rows,p_plan:plan.plans,p_actor:user.email
  });
  if(error)throw error;
  if(!['APPLIED','REUSED'].includes(data?.status))throw new Error('R6: resultado transacional inesperado.');
  return data;
}
async function getRetroactiveReview(db, actor) {
  const {data:context,error}=await db.rpc('sisha_ppu_r6_context');
  if(error)throw error;
  if(!context.previous_observed_on||!context.source_file_sha256)return {status:'WAITING_NEW_INVENTORY',candidates:[],automatic:false};
  const review=buildRetroactiveReview(context,context.previous_rows,{observedOn:context.previous_observed_on},[]);
  const token=crypto.createHash('sha256').update(JSON.stringify({version:'R7B1',context:context.token,actor})).digest('hex');
  return {...review,status:'REVIEW_READY',token,contextToken:context.token};
}
async function applyRetroactiveReview(db, actor, body={}) {
  if(!actor||body.confirmed!==true||typeof body.evidence!=='string'||body.evidence.trim().length<15||body.evidence.length>2000
    ||!Number.isSafeInteger(body.itemId)||!Number.isSafeInteger(body.locrecId)||typeof body.quantity!=='number'
    ||!Number.isFinite(body.quantity)||body.quantity<=0||Math.abs(body.quantity*1e6-Math.round(body.quantity*1e6))>1e-5)
    throw new Error('Confirme individualmente a entrada e informe a referência documental e a quantidade.');
  const review=await getRetroactiveReview(db,actor);
  if(review.status!=='REVIEW_READY'||body.token!==review.token)throw new Error('Conferência desatualizada. Recarregue os candidatos.');
  const candidate=review.candidates.find(c=>c.itemId===body.itemId&&c.locrecId===body.locrecId&&c.candidateQuantity>=body.quantity);
  if(!candidate)throw new Error('Item ou quantidade não elegível para incorporação histórica.');
  const {data,error}=await db.rpc('sisha_ppu_r7_retro_apply',{
    p_context_token:review.contextToken,p_item_id:body.itemId,p_locrec_id:body.locrecId,
    p_quantity:body.quantity,p_evidence:body.evidence.trim(),p_actor:actor
  });
  if(error)throw error;
  if(data?.status!=='APPLIED')throw new Error('Resultado histórico não confirmado.');
  return data;
}
module.exports={buildR6Plan,importPpuR6,validateAggregateCoverage,buildRetroactiveReview,getRetroactiveReview,applyRetroactiveReview};
