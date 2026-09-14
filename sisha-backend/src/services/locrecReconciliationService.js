const supabase = require('../config/supabaseClient');
const { normalizePn, normalizeReceipt, normalizeLocation } = require('./locrecParserService');

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}
function round(value) { return Number(num(value).toFixed(6)); }
function missingRelation(error) { return ['42P01', 'PGRST205', 'PGRST204'].includes(String(error?.code || '')); }

function groupReceiptItems(receipts = []) {
  const map = new Map();
  for (const receipt of receipts || []) {
    const receiptNo = normalizeReceipt(receipt.numero_recibo);
    if (!receiptNo) continue;
    for (const item of receipt.recebimento_itens || []) {
      if (item?.ativo === false) continue;
      const pn = normalizePn(item?.pn);
      if (!pn) continue;
      const key = `${receiptNo}|${pn}`;
      if (!map.has(key)) map.set(key, { receipt_no: receiptNo, pn, receipt_ids: new Set(), item_ids: new Set(), quantity: 0, rows: [] });
      const group = map.get(key);
      group.receipt_ids.add(receipt.id);
      group.item_ids.add(item.id);
      group.quantity += num(item.quantidade);
      group.rows.push(item);
    }
  }
  return map;
}

function groupLocrecRows(rows = []) {
  const map = new Map();
  for (const row of rows || []) {
    const receiptNo = normalizeReceipt(row.numero_recibo);
    const pn = normalizePn(row.pn);
    if (!receiptNo || !pn) continue;
    const key = `${receiptNo}|${pn}`;
    if (!map.has(key)) {
      map.set(key, {
        receipt_no: receiptNo,
        pn,
        locrec_document_qty: 0,
        audited_qty_raw: 0,
        source_rows: [],
        allocations: new Map(),
        latest_audit_at: null,
      });
    }
    const group = map.get(key);
    const documentQty = Math.max(0, num(row.qtd_documental));
    const audited = Math.max(0, num(row.qtd_auditada_aplicada ?? row.qtd_auditada_original));
    group.locrec_document_qty += documentQty;
    group.audited_qty_raw += audited;
    group.source_rows.push(row.source_row);

    const location = normalizeLocation(row.loc_escolhida);
    const destiny = String(row.destino_indicado || '').toUpperCase();
    if (audited > 0 && location && location !== '-' && destiny !== 'PENDENTE') {
      if (!group.allocations.has(location)) group.allocations.set(location, { quantity: 0, destino_indicado: destiny, source_rows: [] });
      const allocation = group.allocations.get(location);
      allocation.quantity += audited;
      allocation.source_rows.push(row.source_row);
      if (destiny === 'CEIMSPA') allocation.destino_indicado = 'CEIMSPA';
      else if (destiny === 'CAIXA' && allocation.destino_indicado !== 'CEIMSPA') allocation.destino_indicado = 'CAIXA';
    }

    const auditAt = row.data_auditoria ? String(row.data_auditoria) : null;
    if (auditAt && (!group.latest_audit_at || auditAt > group.latest_audit_at)) group.latest_audit_at = auditAt;
  }
  return map;
}

function statusLabel(status) {
  const labels = {
    AGUARDANDO_PROCESSAMENTO: 'Aguardando processamento — Hangar',
    PROCESSADO_ESTOQUE_PPU: 'Processado — localização PPU informada pelo LOCREC',
    PROCESSADO_CAIXA: 'Processado — caixa informada pelo LOCREC',
    DESTINO_CEIMSPA_INFORMADO: 'Processado — destino CEIMSPA informado pelo LOCREC',
    PROCESSAMENTO_PARCIAL: 'Processamento parcial — saldo restante no Hangar',
    DIVERGENCIA_QUANTIDADE: 'Divergência de quantidade entre Recibo e LOCREC',
    LOCREC_SEM_RECIBO: 'LOCREC sem Recibo correspondente no SISHA',
  };
  return labels[status] || status;
}

function classifyLocrecGroup(locrec, receipt, authoritativeQty) {
  const auditedQtyRaw = round(locrec?.audited_qty_raw || 0);
  const auditedQty = round(Math.min(auditedQtyRaw, authoritativeQty));
  const pendingQty = round(Math.max(0, authoritativeQty - auditedQty));
  const allocations = locrec ? Array.from(locrec.allocations.entries()).map(([location, data]) => ({
    location,
    quantity: round(data.quantity),
    destino_indicado: data.destino_indicado,
    source_rows: data.source_rows,
  })) : [];
  const quantityMismatch = Boolean(receipt && locrec)
    && Math.abs(round(locrec.locrec_document_qty) - round(receipt.quantity)) > 0.000001;
  const auditOverflow = Boolean(locrec) && auditedQtyRaw > authoritativeQty + 0.000001;

  let status = 'AGUARDANDO_PROCESSAMENTO';
  let confidence = receipt ? 'ALTA' : 'BAIXA';
  if (!receipt) {
    status = 'LOCREC_SEM_RECIBO';
    confidence = 'BAIXA';
  } else if (quantityMismatch || auditOverflow) {
    status = 'DIVERGENCIA_QUANTIDADE';
    confidence = 'MEDIA';
  } else if (!allocations.length || auditedQty <= 0) {
    status = 'AGUARDANDO_PROCESSAMENTO';
  } else if (pendingQty > 0) {
    status = 'PROCESSAMENTO_PARCIAL';
    confidence = 'MEDIA';
  } else if (allocations.some((entry) => entry.destino_indicado === 'CEIMSPA')) {
    status = 'DESTINO_CEIMSPA_INFORMADO';
  } else if (allocations.some((entry) => entry.destino_indicado === 'CAIXA')) {
    status = 'PROCESSADO_CAIXA';
  } else {
    status = 'PROCESSADO_ESTOQUE_PPU';
  }
  return { auditedQtyRaw, auditedQty, pendingQty, allocations, quantityMismatch, auditOverflow, status, confidence };
}

function reconcileLocrecEvidence({ locrecRows = [], receipts = [] } = {}) {
  const receiptMap = groupReceiptItems(receipts);
  const locrecMap = groupLocrecRows(locrecRows);
  const rows = [];
  const allKeys = new Set([...receiptMap.keys(), ...locrecMap.keys()]);

  for (const key of allKeys) {
    const locrec = locrecMap.get(key) || null;
    const receipt = receiptMap.get(key) || null;
    const receiptNo = receipt?.receipt_no || locrec?.receipt_no || '';
    const pn = receipt?.pn || locrec?.pn || '';
    const authoritativeQty = receipt ? round(receipt.quantity) : round(locrec?.locrec_document_qty || 0);
    const classified = classifyLocrecGroup(locrec, receipt, authoritativeQty);
    const locations = classified.allocations.map((entry) => entry.location);
    if (receipt && classified.pendingQty > 0) locations.push('HANGAR');
    if (receipt && !classified.allocations.length) locations.splice(0, locations.length, 'HANGAR');

    rows.push({
      key,
      numero_recibo: receiptNo,
      pn,
      receipt_found: Boolean(receipt),
      locrec_found: Boolean(locrec),
      receipt_ids: receipt ? Array.from(receipt.receipt_ids) : [],
      receipt_item_ids: receipt ? Array.from(receipt.item_ids) : [],
      qtd_recibo: receipt ? round(receipt.quantity) : null,
      qtd_locrec_documental: locrec ? round(locrec.locrec_document_qty) : null,
      qtd_auditada: classified.auditedQty,
      qtd_pendente: classified.pendingQty,
      allocations: classified.allocations,
      locations: Array.from(new Set(locations)),
      localizacao_consolidada: Array.from(new Set(locations)).join(' / ') || null,
      localizacao_fonte: classified.allocations.length ? 'LOCREC' : (receipt ? 'RECIBO_DEFAULT_HANGAR' : null),
      status: classified.status,
      status_label: statusLabel(classified.status),
      confidence: classified.confidence,
      quantity_mismatch: classified.quantityMismatch,
      audit_overflow: classified.auditOverflow,
      source_rows: locrec?.source_rows || [],
      latest_audit_at: locrec?.latest_audit_at || null,
    });
  }

  const priority = { DIVERGENCIA_QUANTIDADE: 0, LOCREC_SEM_RECIBO: 1, AGUARDANDO_PROCESSAMENTO: 2, PROCESSAMENTO_PARCIAL: 3, PROCESSADO_CAIXA: 4, DESTINO_CEIMSPA_INFORMADO: 5, PROCESSADO_ESTOQUE_PPU: 6 };
  rows.sort((a, b) => (priority[a.status] ?? 99) - (priority[b.status] ?? 99) || a.numero_recibo.localeCompare(b.numero_recibo) || a.pn.localeCompare(b.pn));
  const counts = rows.reduce((acc, row) => { acc[row.status] = (acc[row.status] || 0) + 1; return acc; }, {});

  return {
    rows,
    summary: {
      groups: rows.length,
      receipt_matched_groups: rows.filter((row) => row.receipt_found).length,
      locrec_matched_groups: rows.filter((row) => row.locrec_found).length,
      receipt_without_locrec_groups: rows.filter((row) => row.receipt_found && !row.locrec_found).length,
      missing_receipt_groups: rows.filter((row) => !row.receipt_found).length,
      processed_ppu_groups: counts.PROCESSADO_ESTOQUE_PPU || 0,
      processed_box_groups: counts.PROCESSADO_CAIXA || 0,
      ceimspa_informed_groups: counts.DESTINO_CEIMSPA_INFORMADO || 0,
      pending_groups: counts.AGUARDANDO_PROCESSAMENTO || 0,
      partial_groups: counts.PROCESSAMENTO_PARCIAL || 0,
      divergence_groups: counts.DIVERGENCIA_QUANTIDADE || 0,
      hangar_groups: rows.filter((row) => row.locations.includes('HANGAR')).length,
      audited_quantity: round(rows.reduce((sum, row) => sum + num(row.qtd_auditada), 0)),
      pending_quantity: round(rows.reduce((sum, row) => sum + num(row.qtd_pendente), 0)),
      status_counts: counts,
    },
  };
}

async function fetchActiveLocrec() {
  const { data: active, error: activeError } = await supabase.from('locrec_importacoes').select('*').eq('status', 'ACTIVE').order('imported_at', { ascending: false }).limit(1).maybeSingle();
  if (activeError) {
    if (missingRelation(activeError)) return { active: null, rows: [] };
    throw activeError;
  }
  if (!active) return { active: null, rows: [] };
  const { data: rows, error } = await supabase.from('locrec_itens').select('*').eq('import_id', active.id).order('source_row', { ascending: true }).limit(10000);
  if (error) throw error;
  return { active, rows: rows || [] };
}

async function fetchReceiptsForReconciliation() {
  const receipts = [];
  const pageSize = 500;
  for (let offset = 0; offset < 20000; offset += pageSize) {
    const { data, error } = await supabase
      .from('recebimentos')
      .select('id,numero_recibo,data_recebimento,recebimento_itens(id,pn,quantidade,ativo,localizacao_ppu,destino_previsto,destino_previsto_fonte,quantidade_inventariada,contabiliza_pelo_recibo)')
      .neq('ativo', false)
      .order('numero_recibo', { ascending: true })
      .range(offset, offset + pageSize - 1);
    if (error) throw error;
    const page = data || [];
    receipts.push(...page);
    if (page.length < pageSize) break;
  }
  return receipts;
}

async function getLocrecReconciliation() {
  const current = await fetchActiveLocrec();
  const receipts = await fetchReceiptsForReconciliation();
  const reconciled = reconcileLocrecEvidence({ locrecRows: current.rows, receipts });
  return { active: current.active, ...reconciled };
}

module.exports = {
  groupLocrecRows,
  reconcileLocrecEvidence,
  fetchActiveLocrec,
  getLocrecReconciliation,
};
