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
       ||q>qty(i.quantidade)||!day||!date(r.data_recebimento)||day<r.data_recebimento||day>observedOn
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
async function importPpuR6({supabase,parsed,rows,buffer,fileName,logId,user,options}) {
  if(parsed?.format!=='PPU_LEGADO_TABULAR'||(parsed.items||[]).some(r=>r.source_section!=='LEGADO_AGREGADO'))
    throw new Error('R6A: relatório serializado não homologado; não substitua o inventário por esta rotina.');
  if(!Buffer.isBuffer(buffer)||!buffer.length||!logId||!user?.email)throw new Error('R6: trilha de importação obrigatória.');
  // Only tolerate explicit placeholder lines and the known report footer.
  // Unknown parser omissions must be reviewed rather than silently accepted.
  const issues=parsed.issues||[];
  if(issues.some(i=>i.field!=='pn'||(!/^(DUPLICADO|EXCLUIR.*)$/i.test(String(i.value||'').trim())&&String(i.value||'').trim()!=='')))
    throw new Error('R6: pendências de leitura exigem conferência.');
  const {data:context,error:readError}=await supabase.rpc('sisha_ppu_r6_context');
  if(readError)throw readError;
  const hash=crypto.createHash('sha256').update(buffer).digest('hex');
  if(context.source_file_sha256===hash && context.previous_observed_on===date(options.observedOn) && options.complete===true){
    if(options.preview===true)return {status:'PREVIEW_REUSED',rows:rows.length,allocations:0,quantity:0};
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
  if(options.preview===true)return {status:'PREVIEW',rows:rows.length,allocations:plan.plans.length,quantity:plan.plans.reduce((s,p)=>s+p.quantity,0),warnings:plan.warnings};
  const {data,error}=await supabase.rpc('sisha_ppu_r6_apply',{
    p_context_token:context.token,p_source_sha256:hash,p_file_name:fileName,p_import_log_id:logId,
    p_observed_on:plan.observedOn,p_previous_observed_on:plan.previousOn,p_previous_date_evidence:options.previousDateEvidence||null,
    p_complete:true,p_rows:rows,p_plan:plan.plans,p_actor:user.email
  });
  if(error)throw error;
  if(!['APPLIED','REUSED'].includes(data?.status))throw new Error('R6: resultado transacional inesperado.');
  return data;
}
module.exports={buildR6Plan,importPpuR6};
