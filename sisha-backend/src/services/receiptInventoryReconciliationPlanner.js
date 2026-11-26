'use strict';

// Pure reconciliation planner. No database writes. Integration must use a single atomic transaction,
// a durable snapshot identity, complete reliable observation dates and audited location policies.
// Inferred accounting allocations are not proof of physical receipt provenance.
function planReceiptInventoryReconciliation({ previous, current, receipts = [], locrecMatches = [] } = {}) {
  const upper = v => String(v ?? '').trim().toUpperCase();
  const pn = v => upper(v).replace(/\s+/g, '');
  const serial = v => { const s = upper(v).replace(/\s+/g, ''); return !s || ['N/A','NA','S/N','SN','-','---','NULL','SEMSN','SEMS/N'].includes(s) || /^X+$/.test(s) || s.startsWith('EXCLUIR') ? '' : s; };
  const loc = v => upper(v).replace(/\s+/g,' ');
  const units = v => { const n = Number(v); return Number.isFinite(n) && n >= 0 && n <= Number.MAX_SAFE_INTEGER / 1e6 ? Math.round(n * 1e6) : 0; };
  const value = v => v / 1e6;
  const date = v => v ? Date.parse(v) : NaN;
  const order = (a,b) => a < b ? -1 : a > b ? 1 : 0;
  const key = (...p) => JSON.stringify(p);
  const plans = [], warnings = [];
  const oldDate = date(previous?.observedAt), newDate = date(current?.observedAt);
  if (previous?.complete !== true || current?.complete !== true || !Array.isArray(previous.rows) || !Array.isArray(current.rows) || !Number.isFinite(oldDate) || !Number.isFinite(newDate) || newDate <= oldDate) return { status:'BASELINE_REQUIRED', plans, warnings:['Inventários completos e datas observacionais crescentes são obrigatórios.'] };
  function aggregate(rows) {
    const byPn = new Map(), bySerial = new Map();
    for (const row of rows) {
      const p = pn(row.pn), s = serial(row.sn), l = loc(row.localizacao), q = units(row.quantidade);
      if (!p || !q) continue;
      if (s) {
        const k = key(p,s);
        if (!bySerial.has(k)) bySerial.set(k, []);
        bySerial.get(k).push({l,q,eligible:row.eligibleLocation === true});
      } else {
        if (!byPn.has(p)) byPn.set(p,{total:0,locations:new Map(),eligible:new Map()});
        const group = byPn.get(p);
        group.total += q;
        group.locations.set(l,(group.locations.get(l)||0)+q);
        if (row.eligibleLocation === true) group.eligible.set(l,(group.eligible.get(l)||0)+q);
      }
    }
    return {byPn,bySerial};
  }
  const old = aggregate(previous.rows), now = aggregate(current.rows);
  const candidates = [], ids = new Set();
  for (const receipt of receipts) {
    if (receipt.ativo !== true || !receipt.id || !Number.isFinite(date(receipt.data_recebimento)) || date(receipt.data_recebimento) > newDate) continue;
    for (const item of receipt.recebimento_itens || []) {
      if (!item.id || ids.has(item.id) || item.ativo !== true || item.contabiliza_pelo_recibo !== true || upper(item.condicao_item) !== 'RECEBIDO_DISPONIVEL' || upper(item.validade_status) === 'VENCIDO' || [item.destino_previsto,item.destino_estoque].some(v=>upper(v)==='CEIMSPA')) continue;
      const p = pn(item.pn), s = serial(item.sn), q = units(item.quantidade), incorporated = units(item.quantidade_inventariada);
      if (!p || !q || incorporated >= q || (s && (q !== 1e6 || incorporated !== 0)) || (!s && upper(item.tipo_item)==='EQUIPAMENTO')) continue;
      ids.add(item.id);
      candidates.push({receiptId:receipt.id, receiptNo:receipt.numero_recibo, itemId:item.id, p,s,q,incorporated,remaining:q-incorporated,at:date(receipt.data_recebimento)});
    }
  }
  candidates.sort((a,b)=>a.at-b.at || order(String(a.receiptId),String(b.receiptId)) || order(String(a.itemId),String(b.itemId)));
  function debit(c, amount, method, location = null, observedLocations = []) {
    if (amount <= 0 || amount > c.remaining) throw new Error('Invalid reconciliation allocation');
    const before = c.incorporated;
    c.incorporated += amount; c.remaining -= amount;
    plans.push({receiptId:c.receiptId,receiptNo:c.receiptNo,itemId:c.itemId,pn:c.p,sn:c.s||null,quantity:value(amount),before:value(before),after:value(c.incorporated),pending:value(c.remaining),full:c.remaining===0,method,location,observedLocations,provenance:method==='PN_SN'?'IDENTIDADE_SERIAL':method==='LOCREC'?'EVIDENCIA_DOCUMENTAL':'INFERENCIA_CONTABIL'});
  }
  const serialGroups = new Map();
  for (const c of candidates.filter(c=>c.s)) {
    const k=key(c.p,c.s);
    if (!serialGroups.has(k)) serialGroups.set(k,[]);
    serialGroups.get(k).push(c);
  }
  for (const [k, group] of serialGroups) {
    const rows = now.bySerial.get(k)||[];
    if (group.length!==1 || rows.length!==1 || rows[0].q!==1e6 || !rows[0].eligible || old.bySerial.has(k)) {
      if (rows.length) warnings.push({pn:group[0].p,sn:group[0].s,reason:'SERIAL_SEM_NOVA_EVIDENCIA_UNIVOCA'});
      continue;
    }
    debit(group[0],1e6,'PN_SN',rows[0].l,[rows[0].l]);
  }
  const byItem = new Map(candidates.filter(c=>!c.s).map(c=>[c.itemId,c]));
  // Caller must validate and uniquely map LOCREC to an active receipt item.
  // Multiple conflicting allocations for the same item are not trusted here.
  const matches = new Map();
  for (const m of locrecMatches) {
    if (m.verified!==true || !m.itemId || !byItem.has(m.itemId) || !loc(m.location)) continue;
    if (!matches.has(m.itemId)) matches.set(m.itemId,[]);
    matches.get(m.itemId).push(m);
  }
  for (const [p, group] of now.byPn) {
    const prev = old.byPn.get(p)||{total:0,locations:new Map()};
    const net = group.total-prev.total;
    if (net<=0) continue;
    const pool = new Map();
    for (const [l,q] of group.eligible) {
      const gain=q-(prev.locations.get(l)||0);
      if (gain>0) pool.set(l,gain);
    }
    let budget=Math.min(net,[...pool.values()].reduce((a,b)=>a+b,0));
    if (budget<=0) continue;
    const cs=candidates.filter(c=>!c.s && c.p===p && c.remaining>0);
    const decreasing=[...prev.locations].some(([l,q])=>(group.locations.get(l)||0)<q);
    const observedLocations=[...pool.keys()].sort(order);
    for (const c of cs) {
      const ms=matches.get(c.itemId)||[];
      if (ms.length!==1 || budget<=0) continue;
      const m=ms[0], l=loc(m.location);
      if (pn(m.pn)!==p || date(m.observedAt)>newDate || !Number.isFinite(date(m.observedAt)) || date(m.observedAt)<c.at || decreasing) continue;
      const q=Math.min(budget,c.remaining,pool.get(l)||0,Math.max(0,units(m.quantity)-c.incorporated));
      if(q>0){debit(c,q,'LOCREC',l,[l]);budget-=q;pool.set(l,pool.get(l)-q);}
    }
    // Exact match is evaluated per receipt, not merely per line.
    while(budget>0) {
      const active=cs.filter(c=>c.remaining>0);
      if (!active.length) break;
      const grouped=new Map();
      for (const c of active) {
        if (!grouped.has(c.receiptId)) grouped.set(c.receiptId,[]);
        grouped.get(c.receiptId).push(c);
      }
      const exact=[...grouped.values()].find(g=>g.reduce((s,c)=>s+c.remaining,0)===budget);
      const chosen=exact||[active[0]];
      for(const c of chosen) {
        if(budget<=0)break;
        const q=Math.min(budget,c.remaining);
        const possible=[...pool].filter(([,n])=>n>0);
        const l=!decreasing && possible.length===1 && possible[0][1]>=q ? possible[0][0] : null;
        debit(c,q,exact?'QTD_EXATA':'FIFO',l,observedLocations);
        budget-=q;
        // When multiple locations are possible, do not claim any exact physical allocation.
        if(l)pool.set(l,pool.get(l)-q);
        else { let rest=q; for(const k of [...pool.keys()].sort(order)){const used=Math.min(rest,pool.get(k));pool.set(k,pool.get(k)-used);rest-=used;} }
      }
    }
    if (budget>0 && cs.length) warnings.push({pn:p,reason:'INCREMENTO_SEM_RECIBO_PENDENTE',quantity:value(budget)});
  }
  return {status:'PLAN_READY',plans,warnings};
}

module.exports = { planReceiptInventoryReconciliation };
