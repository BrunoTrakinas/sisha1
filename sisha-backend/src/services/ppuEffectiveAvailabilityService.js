const crypto = require('crypto');
const { normalizePn, normalizeLocation } = require('./ppuExternalCustodyParserService');
const { normalizeReceipt, normalizeLocation: normalizeLocrecLocation } = require('./locrecParserService');

function clean(value) { return String(value ?? '').trim(); }
function getDb() { return require('../config/supabaseClient'); }
function isMissingCustodySchemaError(error) {
  const code = clean(error?.code).toUpperCase();
  const message = clean(error?.message).toLowerCase();
  return ['42P01', 'PGRST204', 'PGRST205'].includes(code) || (message.includes('ppu_custodia_externa') && (message.includes('does not exist') || message.includes('not found')));
}
function num(value) { const n = Number(value); return Number.isFinite(n) ? n : 0; }
function round(value) { return Number(num(value).toFixed(6)); }



function groupLocrecRowsForAvailability(rows = []) {
  const map = new Map();
  (rows || []).forEach((row) => {
    const receiptNo = normalizeReceipt(row.numero_recibo);
    const pn = normalizePn(row.pn);
    if (!receiptNo || !pn) return;
    const key = `${receiptNo}|${pn}`;
    if (!map.has(key)) map.set(key, { receipt_no: receiptNo, pn, locrec_document_qty: 0, source_rows: [], allocations: new Map() });
    const group = map.get(key);
    group.locrec_document_qty += Math.max(0, num(row.qtd_documental));
    group.source_rows.push(row.source_row);
    const audited = Math.max(0, num(row.qtd_auditada_aplicada ?? row.qtd_auditada_original));
    const location = normalizeLocrecLocation(row.loc_escolhida);
    const destiny = clean(row.destino_indicado).toUpperCase();
    if (audited <= 0 || !location || location === '-' || destiny === 'PENDENTE') return;
    if (!group.allocations.has(location)) group.allocations.set(location, { quantity: 0, destino_indicado: destiny, source_rows: [] });
    const allocation = group.allocations.get(location);
    allocation.quantity += audited;
    allocation.source_rows.push(row.source_row);
    if (destiny === 'CEIMSPA') allocation.destino_indicado = 'CEIMSPA';
    else if (destiny === 'CAIXA' && allocation.destino_indicado !== 'CEIMSPA') allocation.destino_indicado = 'CAIXA';
  });
  return map;
}

function operationalQuantity(row = {}) {
  const explicit = Number(row.quantidade_disponivel);
  if (Number.isFinite(explicit)) return Math.max(0, explicit);
  if (clean(row.origem_saldo).toUpperCase() === 'PPU_CUSTODIA_EXTERNA') return 0;
  return Math.max(0, num(row.quantidade));
}

function isOperationalPpuRow(row = {}) {
  return operationalQuantity(row) > 0;
}

function applyLocrecReceiptLocations(baseRows = [], locrecRows = []) {
  const locrecMap = groupLocrecRowsForAvailability(locrecRows);
  const passthrough = [];
  const receiptGroups = new Map();

  (baseRows || []).forEach((row, index) => {
    const origem = clean(row.origem_saldo).toUpperCase();
    if (!origem.startsWith('RECIBO_PENDENTE')) {
      passthrough.push(row);
      return;
    }
    const pn = normalizePn(row.pn);
    const receiptNo = normalizeReceipt(row.numero_recibo);
    const key = receiptNo && pn ? `${receiptNo}|${pn}` : `UNMATCHED|${row.recebimento_item_id || row.recebimento_id || index}`;
    if (!receiptGroups.has(key)) receiptGroups.set(key, { key, pn, receiptNo, rows: [], quantity: 0 });
    const group = receiptGroups.get(key);
    group.rows.push(row);
    group.quantity += Math.max(0, num(row.quantidade));
  });

  const projected = [];
  receiptGroups.forEach((group) => {
    const template = group.rows[0] || {};
    const locrec = group.receiptNo && group.pn ? locrecMap.get(`${group.receiptNo}|${group.pn}`) : null;
    let remaining = round(group.quantity);
    const allocations = locrec
      ? Array.from(locrec.allocations.entries()).map(([location, data]) => ({ location, ...data }))
      : [];
    const distinctSns = [...new Set(group.rows.map((row) => clean(row.sn).toUpperCase()).filter(Boolean))];
    const preserveSingleSn = distinctSns.length === 1 && allocations.length <= 1;

    allocations.forEach((allocation) => {
      if (remaining <= 0) return;
      const qty = round(Math.min(remaining, Math.max(0, num(allocation.quantity))));
      if (qty <= 0) return;
      projected.push({
        ...template,
        sn: preserveSingleSn ? distinctSns[0] : null,
        quantidade: qty,
        localizacao: allocation.location,
        locrec_consultivo: true,
        locrec_status: 'PROCESSADO',
        locrec_destino_indicado: allocation.destino_indicado || null,
        locrec_source_rows: allocation.source_rows || [],
        locrec_quantidade_documental: round(locrec.locrec_document_qty),
      });
      remaining = round(Math.max(0, remaining - qty));
    });

    if (remaining > 0 || !allocations.length) {
      const qty = allocations.length ? remaining : round(group.quantity);
      if (qty > 0) {
        projected.push({
          ...template,
          sn: distinctSns.length === 1 ? distinctSns[0] : null,
          quantidade: qty,
          localizacao: 'HANGAR',
          locrec_consultivo: true,
          locrec_status: allocations.length ? 'PROCESSAMENTO_PARCIAL' : 'AGUARDANDO_PROCESSAMENTO',
          locrec_destino_indicado: 'PENDENTE',
          locrec_source_rows: locrec?.source_rows || [],
          locrec_quantidade_documental: locrec ? round(locrec.locrec_document_qty) : null,
        });
      }
    }
  });

  return [...passthrough, ...projected];
}

function extractBoxCode(location = '') {
  const text = clean(location).toUpperCase();
  const match = text.match(/(?:^|\b)(?:CX|CAIXA)\s*[- ]?\s*0*(\d{1,3})(?:\b|$)/i);
  return match ? `CX-${String(Number(match[1])).padStart(3, '0')}` : null;
}

function boxDisplay(boxCode) { return `${boxCode} — CEIMSPA`; }

function aggregateCustodyRows(rows = []) {
  const map = new Map();
  rows.forEach((row) => {
    const pn = normalizePn(row.pn);
    const originalNorm = normalizeLocation(row.original_location_normalized || row.original_location);
    const boxCode = clean(row.box_code).toUpperCase();
    if (!pn || !originalNorm || !boxCode) return;
    const groupKey = row.group_key || crypto.createHash('sha256').update(`${pn}|${originalNorm}|${boxCode}`).digest('hex').slice(0, 32);
    if (!map.has(groupKey)) {
      map.set(groupKey, {
        group_key: groupKey,
        import_id: row.import_id || null,
        pn,
        box_code: boxCode,
        original_location: row.original_location || originalNorm,
        original_location_normalized: originalNorm,
        quantity: 0,
        nomenclature: row.nomenclature || row.nomenclatura || null,
        nsn_pi: row.nsn_normalized || row.nsn_original || row.nsn_pi || null,
        sns: new Set(),
        source_rows: 0,
      });
    }
    const group = map.get(groupKey);
    group.quantity += Math.max(0, num(row.quantity ?? row.quantidade));
    group.source_rows += 1;
    if (row.sn) group.sns.add(clean(row.sn).toUpperCase().replace(/\s+/g, ''));
    if (!group.nomenclature && (row.nomenclature || row.nomenclatura)) group.nomenclature = row.nomenclature || row.nomenclatura;
    if (!group.nsn_pi && (row.nsn_normalized || row.nsn_original || row.nsn_pi)) group.nsn_pi = row.nsn_normalized || row.nsn_original || row.nsn_pi;
  });
  return Array.from(map.values()).map((group) => ({ ...group, sns: Array.from(group.sns) }));
}

function latestDecisionsMap(rows = []) {
  const map = new Map();
  rows.forEach((row) => {
    const key = clean(row.group_key);
    if (!key || map.has(key)) return;
    map.set(key, row);
  });
  return map;
}

function aggregateBaseRows(rows = []) {
  const map = new Map();
  rows.forEach((row, index) => {
    const pn = normalizePn(row.pn);
    const locRaw = clean(row.localizacao || 'NÃO INFORMADO') || 'NÃO INFORMADO';
    const locNorm = normalizeLocation(locRaw);
    if (!pn || !locNorm) return;
    const origem = clean(row.origem_saldo || 'PPU_OFICIAL').toUpperCase() || 'PPU_OFICIAL';
    const sn = clean(row.sn).toUpperCase().replace(/\s+/g, '') || null;
    const discriminator = sn ? `SN:${sn}` : `REC:${row.recebimento_item_id || row.recebimento_id || index}`;
    const key = `${pn}|${locNorm}|${origem}|${discriminator}`;
    if (!map.has(key)) {
      map.set(key, {
        key, pn, loc_norm: locNorm, localizacao: locRaw,
        quantidade: 0,
        nomenclatura: row.nomenclatura || null,
        nsn_pi: row.nsn_pi || null,
        sn,
        origem_saldo: origem,
        numero_recibo: row.numero_recibo || null,
        recebimento_id: row.recebimento_id || null,
        recebimento_item_id: row.recebimento_item_id || null,
        tipo_item: row.tipo_item || null,
        eligible_for_custody: origem !== 'RECIBO_PENDENTE',
      });
    }
    const group = map.get(key);
    group.quantidade += Math.max(0, num(row.quantidade));
    if (!group.nomenclatura && row.nomenclatura) group.nomenclatura = row.nomenclatura;
    if (!group.nsn_pi && row.nsn_pi) group.nsn_pi = row.nsn_pi;
  });
  return map;
}

function buildEffectivePpuAvailability(baseRows = [], custodyRows = [], decisionRows = []) {
  const baseMap = aggregateBaseRows(baseRows);
  const groups = aggregateCustodyRows(custodyRows).sort((a, b) => `${a.pn}|${a.original_location_normalized}|${a.box_code}`.localeCompare(`${b.pn}|${b.original_location_normalized}|${b.box_code}`));
  const decisions = latestDecisionsMap(decisionRows);
  const originalRemaining = new Map();
  const officialBoxRemaining = new Map();

  baseMap.forEach((group) => {
    if (!group.eligible_for_custody) return;
    const originKey = `${group.pn}|${group.loc_norm}`;
    originalRemaining.set(originKey, num(originalRemaining.get(originKey)) + num(group.quantidade));
    const box = extractBoxCode(group.localizacao);
    if (!box) return;
    const key = `${group.pn}|${box}`;
    officialBoxRemaining.set(key, num(officialBoxRemaining.get(key)) + num(group.quantidade));
  });

  const synthetic = [];
  const reconciliation = [];
  const reductions = new Map(); // PN|LOC -> quantidade oficial a retirar da LOC original

  groups.forEach((group) => {
    const decision = decisions.get(group.group_key) || null;
    const declared = round(group.quantity);
    if (decision?.decision === 'IGNORAR_MOVIMENTACAO') {
      reconciliation.push({ ...group, declared_qty: declared, absorbed_qty: 0, reallocated_qty: 0, confirmed_extra_qty: 0, blocked_qty: declared, status: 'IGNORADO_ADMIN', decision_reason: decision.reason || null });
      return;
    }

    const boxPoolKey = `${group.pn}|${group.box_code}`;
    const officialBoxQty = Math.max(0, num(officialBoxRemaining.get(boxPoolKey)));
    const absorbed = Math.min(declared, officialBoxQty);
    officialBoxRemaining.set(boxPoolKey, Math.max(0, officialBoxQty - absorbed));

    const residual = Math.max(0, declared - absorbed);
    const originKey = `${group.pn}|${group.original_location_normalized}`;
    const originQty = Math.max(0, num(originalRemaining.get(originKey)));
    const reallocated = Math.min(residual, originQty);
    originalRemaining.set(originKey, Math.max(0, originQty - reallocated));
    reductions.set(originKey, num(reductions.get(originKey)) + reallocated);

    const unreconciled = Math.max(0, residual - reallocated);
    const confirmedExtra = decision?.decision === 'CONFIRMAR_CUSTODIA' ? unreconciled : 0;
    const blocked = Math.max(0, unreconciled - confirmedExtra);
    const syntheticQty = reallocated + confirmedExtra;

    if (syntheticQty > 0) {
      synthetic.push({
        pn: group.pn,
        nomenclatura: group.nomenclature || null,
        nsn_pi: group.nsn_pi || null,
        sn: group.sns.length === 1 ? group.sns[0] : null,
        quantidade: round(syntheticQty),
        quantidade_controlada: round(syntheticQty),
        quantidade_disponivel: 0,
        disponivel_operacional: false,
        localizacao: boxDisplay(group.box_code),
        origem_saldo: 'PPU_CUSTODIA_EXTERNA',
        custodia: 'PPU',
        local_fisico: 'CEIMSPA',
        caixa: group.box_code,
        localizacao_original: group.original_location,
        custodia_externa: true,
        reconciliation_status: blocked > 0 ? 'DIVERGENCIA' : (confirmedExtra > 0 ? 'CONFIRMADO_ADMIN' : 'RECONCILIADO'),
      });
    }

    let status = 'RECONCILIADO';
    if (absorbed >= declared && declared > 0) status = 'ABSORVIDO_PELO_INVENTARIO';
    else if (blocked > 0) status = 'DIVERGENCIA';
    else if (confirmedExtra > 0) status = 'CONFIRMADO_ADMIN';
    else if (absorbed > 0) status = 'PARCIALMENTE_ABSORVIDO';

    reconciliation.push({
      ...group,
      declared_qty: declared,
      absorbed_qty: round(absorbed),
      reallocated_qty: round(reallocated),
      confirmed_extra_qty: round(confirmedExtra),
      blocked_qty: round(blocked),
      official_origin_qty_before: round(originQty),
      status,
      decision_reason: decision?.reason || null,
    });
  });

  const effectiveBase = [];
  const reductionRemaining = new Map(reductions);
  Array.from(baseMap.values()).sort((a, b) => a.key.localeCompare(b.key)).forEach((group) => {
    let reduced = num(group.quantidade);
    const originKey = `${group.pn}|${group.loc_norm}`;
    if (group.eligible_for_custody && num(reductionRemaining.get(originKey)) > 0) {
      const take = Math.min(reduced, num(reductionRemaining.get(originKey)));
      reduced -= take;
      reductionRemaining.set(originKey, Math.max(0, num(reductionRemaining.get(originKey)) - take));
    }
    if (reduced <= 0) return;
    const box = extractBoxCode(group.localizacao);
    effectiveBase.push({
      pn: group.pn,
      nomenclatura: group.nomenclatura,
      nsn_pi: group.nsn_pi,
      sn: group.sn || null,
      quantidade: round(reduced),
      quantidade_controlada: round(reduced),
      quantidade_disponivel: round(reduced),
      disponivel_operacional: true,
      localizacao: box ? boxDisplay(box) : group.localizacao,
      origem_saldo: group.origem_saldo || 'PPU_OFICIAL',
      numero_recibo: group.numero_recibo || null,
      recebimento_id: group.recebimento_id || null,
      recebimento_item_id: group.recebimento_item_id || null,
      tipo_item: group.tipo_item || null,
      custodia_externa: false,
    });
  });

  return {
    rows: [...effectiveBase, ...synthetic],
    reconciliation,
    summary: {
      official_qty: round(Array.from(baseMap.values()).reduce((sum, row) => sum + num(row.quantidade), 0)),
      effective_qty: round([...effectiveBase, ...synthetic].reduce((sum, row) => sum + num(row.quantidade), 0)),
      operational_qty: round([...effectiveBase, ...synthetic].reduce((sum, row) => sum + operationalQuantity(row), 0)),
      custody_qty: round(synthetic.reduce((sum, row) => sum + num(row.quantidade_controlada ?? row.quantidade), 0)),
      custody_declared_qty: round(groups.reduce((sum, row) => sum + num(row.quantity), 0)),
      custody_counted_qty: round(reconciliation.reduce((sum, row) => sum + num(row.absorbed_qty) + num(row.reallocated_qty) + num(row.confirmed_extra_qty), 0)),
      blocked_qty: round(reconciliation.reduce((sum, row) => sum + num(row.blocked_qty), 0)),
      divergence_groups: reconciliation.filter((row) => row.status === 'DIVERGENCIA').length,
      absorbed_groups: reconciliation.filter((row) => row.status === 'ABSORVIDO_PELO_INVENTARIO').length,
    },
  };
}

async function getActiveImport() {
  const supabase = getDb();
  const { data, error } = await supabase.from('ppu_custodia_externa_importacoes').select('*').eq('status', 'ACTIVE').order('imported_at', { ascending: false }).limit(1).maybeSingle();
  if (error) {
    if (isMissingCustodySchemaError(error)) return null;
    throw error;
  }
  return data || null;
}

async function loadCustodyState({ pns = null } = {}) {
  const supabase = getDb();
  const active = await getActiveImport();
  if (!active) return { active: null, items: [], decisions: [] };
  let itemQuery = supabase.from('ppu_custodia_externa_itens').select('*').eq('import_id', active.id);
  if (Array.isArray(pns) && pns.length) itemQuery = itemQuery.in('pn', pns.map(normalizePn));
  const [itemsResult, decisionsResult] = await Promise.all([
    itemQuery,
    supabase.from('v_sisha_ppu_custodia_externa_decisao_atual').select('*').eq('import_id', active.id),
  ]);
  if (itemsResult.error) throw itemsResult.error;
  if (decisionsResult.error) throw decisionsResult.error;
  return { active, items: itemsResult.data || [], decisions: decisionsResult.data || [] };
}

async function loadBaseRowsByPns(pns = []) {
  const supabase = getDb();
  const safe = [...new Set((pns || []).map(normalizePn).filter(Boolean))];
  if (!safe.length) return [];
  const { data, error } = await supabase.from('v_sisha_ppu_disponibilidade').select('*').in('pn', safe);
  if (error) throw error;
  return data || [];
}

async function loadAllBaseRows() {
  const supabase = getDb();
  const pageSize = 1000;
  let rows = [];
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await supabase.from('v_sisha_ppu_disponibilidade').select('*').range(from, from + pageSize - 1);
    if (error) throw error;
    rows = rows.concat(data || []);
    if (!data || data.length < pageSize) break;
  }
  return rows;
}


async function loadActiveLocrecRowsByPns(pns = []) {
  const supabase = getDb();
  const safe = [...new Set((pns || []).map(normalizePn).filter(Boolean))];
  if (!safe.length) return { available: true, active: null, rows: [] };
  const { data: active, error: activeError } = await supabase
    .from('locrec_importacoes')
    .select('id,status')
    .eq('status', 'ACTIVE')
    .order('imported_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (activeError) {
    if (isMissingCustodySchemaError(activeError) || ['42P01', 'PGRST204', 'PGRST205'].includes(clean(activeError.code).toUpperCase())) {
      return { available: false, active: null, rows: [] };
    }
    throw activeError;
  }
  if (!active) return { available: true, active: null, rows: [] };
  const rows = [];
  for (let i = 0; i < safe.length; i += 80) {
    const chunk = safe.slice(i, i + 80);
    const { data, error } = await supabase.from('locrec_itens').select('*').eq('import_id', active.id).in('pn', chunk).limit(10000);
    if (error) throw error;
    rows.push(...(data || []));
  }
  return { available: true, active, rows };
}

async function loadEffectivePpuRowsByPns(pns = []) {
  const safe = [...new Set((pns || []).map(normalizePn).filter(Boolean))];
  if (!safe.length) return [];
  const [baseRows, state, locrecState] = await Promise.all([
    loadBaseRowsByPns(safe),
    loadCustodyState({ pns: safe }),
    loadActiveLocrecRowsByPns(safe),
  ]);
  const receiptAwareRows = locrecState.available ? applyLocrecReceiptLocations(baseRows, locrecState.rows) : baseRows;
  return buildEffectivePpuAvailability(receiptAwareRows, state.items, state.decisions).rows;
}

async function loadAllEffectivePpuRows() {
  const [baseRows, state] = await Promise.all([loadAllBaseRows(), loadCustodyState()]);
  const safePns = [...new Set(baseRows.map((row) => normalizePn(row.pn)).filter(Boolean))];
  const locrecState = await loadActiveLocrecRowsByPns(safePns);
  const receiptAwareRows = locrecState.available ? applyLocrecReceiptLocations(baseRows, locrecState.rows) : baseRows;
  return buildEffectivePpuAvailability(receiptAwareRows, state.items, state.decisions).rows;
}

async function getExternalCustodyReconciliation() {
  const state = await loadCustodyState();
  if (!state.active) return { active: null, rows: [], summary: { divergence_groups: 0, blocked_qty: 0 } };
  const pns = [...new Set(state.items.map((row) => normalizePn(row.pn)).filter(Boolean))];
  const baseRows = await loadBaseRowsByPns(pns);
  const result = buildEffectivePpuAvailability(baseRows, state.items, state.decisions);
  return { active: state.active, rows: result.reconciliation, summary: result.summary };
}

module.exports = {
  extractBoxCode,
  boxDisplay,
  aggregateCustodyRows,
  applyLocrecReceiptLocations,
  operationalQuantity,
  isOperationalPpuRow,
  buildEffectivePpuAvailability,
  loadEffectivePpuRowsByPns,
  loadAllEffectivePpuRows,
  getExternalCustodyReconciliation,
};
