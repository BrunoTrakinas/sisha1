const supabase = require('../config/supabaseClient');
const {
  parseDateToIso,
  ensureRecebimentoHeader,
  replaceRecebimentoItens,
} = require('../utils/receiptLedger');
const {
  resolvePdLifecycleStatus,
  loadPdHistoricalEvidence,
} = require('./orderBookReconciliationService');

function normalizeText(value) {
  const text = String(value ?? '').trim();
  return text === '' ? null : text;
}

function normalizeUpper(value) {
  const text = normalizeText(value);
  return text ? text.toUpperCase() : null;
}

function normalizeNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function actorEmail(actor) {
  return actor?.email || actor?.sub || null;
}

const AUDITED_ITEM_FIELDS = [
  'sequencia_item',
  'pn',
  'nomenclatura',
  'nsn_pi',
  'quantidade',
  'quantidade_inventariada',
  'contabiliza_pelo_recibo',
  'sn',
  'tipo_item',
  'localizacao_ppu',
  'destino_previsto',
  'destino_previsto_fonte',
  'destino_estoque',
  'condicao_item',
  'validade_status',
  'validade_observacao',
  'sn_extraido_documento',
  'equipamento_id',
  'observacao_item',
  'data_garantia',
  'valor_unitario',
  'valor_total_documento',
  'moeda',
  'documento_referencia',
  'delivery_note',
  'invoice_no',
  'di',
  'batch_no',
  'coc_no',
  'status_documento',
  'ativo',
];

const AUDITED_HEADER_FIELDS = [
  'numeroRecibo',
  'tipoRecebimento',
  'dataRecebimento',
  'documentoReferencia',
  'fornecedor',
  'origemMaterial',
  'programaOrigem',
  'programaOrigemFonte',
  'codigoOmRecebedora',
  'siglaRecebedora',
  'recebidoPorNome',
  'conferidoPorNome',
  'metodoImportacao',
  'isFoc',
  'observacao',
];

function comparableValue(value) {
  if (value === undefined || value === '') return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  return value;
}

function buildChanges(before = {}, after = {}, fields = []) {
  const changes = {};
  for (const field of fields) {
    const previous = comparableValue(before?.[field]);
    const current = comparableValue(after?.[field]);
    if (JSON.stringify(previous) !== JSON.stringify(current)) {
      changes[field] = { antes: previous, depois: current };
    }
  }
  return changes;
}

function auditItemSnapshot(item = {}) {
  return Object.fromEntries(AUDITED_ITEM_FIELDS.map((field) => [field, comparableValue(item?.[field])]));
}

function itemKey(item = {}, defaultDocument = null) {
  return [
    normalizeUpper(item.documento_referencia || defaultDocument || 'SEM_DOCUMENTO'),
    normalizeUpper(item.pn),
  ].join('|');
}

function orderBookQuantity(item = {}) {
  if (normalizeUpper(item.condicao_item) === 'FALTANTE') return 0;
  return Math.max(0, normalizeNumber(item.quantidade));
}

function aggregateItems(items = [], defaultDocument = null) {
  const map = new Map();
  for (const item of items || []) {
    const key = itemKey(item, defaultDocument);
    if (!map.has(key)) {
      map.set(key, {
        ...item,
        documento_referencia: item.documento_referencia || defaultDocument || null,
        quantidade: 0,
      });
    }
    map.get(key).quantidade += orderBookQuantity(item);
  }
  return map;
}

function allocateQuantity(rows = [], delta = 0, { deliveredField = 'qtd_entregue', pendingField = 'qtd_pendente' } = {}) {
  let remaining = Math.abs(normalizeNumber(delta));
  const allocations = [];

  for (const row of rows) {
    if (remaining <= 0) break;
    const available = delta > 0
      ? Math.max(0, normalizeNumber(row[pendingField]))
      : Math.max(0, normalizeNumber(row[deliveredField]));
    const amount = Math.min(remaining, available);
    if (amount > 0) allocations.push({ row, amount });
    remaining -= amount;
  }

  return { allocations, remaining };
}

async function fetchReceiptItems(recebimentoId, includeInactive = false) {
  let query = supabase
    .from('recebimento_itens')
    .select('*')
    .eq('recebimento_id', recebimentoId)
    .order('sequencia_item', { ascending: true })
    .order('created_at', { ascending: true });
  if (!includeInactive) query = query.neq('ativo', false);
  const { data, error } = await query;
  if (error) throw error;
  return data || [];
}

async function logReceiptEvent(recebimentoId, tipoEvento, detalhe = {}, actor = null, itemId = null) {
  const { error } = await supabase.from('recebimento_eventos').insert({
    recebimento_id: recebimentoId,
    recebimento_item_id: itemId,
    tipo_evento: tipoEvento,
    detalhe,
    created_by_email: actorEmail(actor),
  });
  if (error) {
    const migrationMissing = ['42P01', 'PGRST205'].includes(error.code);
    if (!migrationMissing) throw error;
  }
}

async function applyReceiptDeltaToOrderBook(oldItems = [], newItems = [], header = {}) {
  const defaultDocument = normalizeUpper(header.documentoReferencia);
  const oldMap = aggregateItems(oldItems, defaultDocument);
  const newMap = aggregateItems(newItems, defaultDocument);
  const keys = new Set([...oldMap.keys(), ...newMap.keys()]);
  const warnings = [];

  for (const key of keys) {
    const oldItem = oldMap.get(key) || {};
    const newItem = newMap.get(key) || {};
    const delta = normalizeNumber(newItem.quantidade) - normalizeNumber(oldItem.quantidade);
    if (delta === 0) continue;

    const pn = normalizeUpper(newItem.pn || oldItem.pn);
    const pd = normalizeUpper(newItem.documento_referencia || oldItem.documento_referencia || defaultDocument);
    if (!pn || !pd || pd === 'SEM_DOCUMENTO') {
      warnings.push(`PN ${pn || 'não informado'} não sincronizado no Order Book porque o PD/documento de referência não foi informado.`);
      continue;
    }

    const { data: rows, error } = await supabase
      .from('leonardo_spares')
      .select('*')
      .eq('pn', pn)
      .eq('documento_referencia', pd)
      .order('id', { ascending: true })
      .limit(100);
    if (error) throw error;
    if (!(rows || []).length) {
      warnings.push(`Nenhuma linha do Order Book foi encontrada para PD ${pd} e PN ${pn}.`);
      continue;
    }

    const { allocations, remaining } = allocateQuantity(rows || [], delta);
    for (const { row, amount } of allocations) {
      const entregueAtual = normalizeNumber(row.qtd_entregue);
      const pendenteAtual = normalizeNumber(row.qtd_pendente);
      const rotaAtual = normalizeNumber(row.qtd_em_rota);
      const entregueNovo = delta > 0
        ? entregueAtual + amount
        : Math.max(0, entregueAtual - amount);
      const pendenteNovo = delta > 0
        ? Math.max(0, pendenteAtual - amount)
        : pendenteAtual + amount;
      const rotaNovo = delta > 0 ? Math.max(0, rotaAtual - amount) : rotaAtual;
      // O Recibo atualiza as quantidades efetivamente recebidas, mas não reescreve
      // o estágio documental do Order Book. AGUARDANDO/RECOLHIDO/EM TRANSPORTE/ENTREGUE
      // continuam sendo evidência própria do snapshot Leonardo.
      const updatePayload = {
        qtd_entregue: entregueNovo,
        qtd_pendente: pendenteNovo,
        qtd_em_rota: rotaNovo,
      };

      const { error: updateError } = await supabase
        .from('leonardo_spares')
        .update(updatePayload)
        .eq('id', row.id);
      if (updateError) throw updateError;
    }

    if (remaining > 0) {
      warnings.push(delta > 0
        ? `O recibo ${header.numeroRecibo} informou ${Math.abs(delta)} unidade(s) para PD ${pd}/PN ${pn}, mas apenas ${Math.abs(delta) - remaining} puderam ser baixadas do saldo pendente do Order Book.`
        : `A reversão do recibo ${header.numeroRecibo} para PD ${pd}/PN ${pn} excedeu em ${remaining} unidade(s) o total anteriormente entregue no Order Book.`);
    }
  }

  return warnings;
}


function aggregateReceiptDeltaByPd(oldItems = [], newItems = [], defaultDocument = null) {
  const deltas = new Map();
  const add = (item, sign) => {
    const pd = normalizeUpper(item?.documento_referencia || defaultDocument);
    if (!pd || pd === 'SEM_DOCUMENTO') return;
    const qty = orderBookQuantity(item);
    if (!qty) return;
    deltas.set(pd, (deltas.get(pd) || 0) + (sign * qty));
  };
  (oldItems || []).forEach((item) => add(item, -1));
  (newItems || []).forEach((item) => add(item, 1));
  return deltas;
}

async function tryLogPdReceiptEvent(pd, previousStatus, nextStatus, detail = {}, actor = null) {
  const { error } = await supabase.from('compras_pd_eventos').insert({
    pd_id: pd.id,
    tipo_evento: 'RECIBO_ATUALIZOU_ENTREGA_PD',
    status_anterior: previousStatus || null,
    status_novo: nextStatus || previousStatus || null,
    numero_oc: pd.numero_oc || null,
    origem: 'RECIBO',
    detalhe: detail,
    created_by_email: actorEmail(actor),
  });
  if (error && !['42P01', 'PGRST205'].includes(error.code)) throw error;
}

async function hasOrderBookEvidenceForPd(numeroPd, pd = null) {
  if (pd?.reconciliado_order_book === true || normalizeUpper(pd?.origem_importacao)?.includes('ORDER_BOOK')) return true;
  const history = pd?.id ? await loadPdHistoricalEvidence([pd.id]) : new Map();
  if (pd?.id && history.get(pd.id)?.hasOrderBookEvidence) return true;

  // Fallback positivo para bases anteriores ao histórico detalhado. A ausência
  // no snapshot atual NUNCA é usada para negar uma evidência histórica.
  const { data, error } = await supabase
    .from('leonardo_spares')
    .select('id')
    .eq('documento_referencia', numeroPd)
    .limit(1);
  if (error) throw error;
  return Boolean((data || []).length);
}

async function computeActiveReceiptQuantityForPd(numeroPd) {
  const receiptIds = new Set();

  const { data: headerReceipts, error: headerError } = await supabase
    .from('recebimentos')
    .select('id')
    .eq('documento_referencia', numeroPd)
    .neq('ativo', false)
    .limit(1000);
  if (headerError) throw headerError;
  (headerReceipts || []).forEach((row) => receiptIds.add(row.id));

  const { data: directItems, error: directError } = await supabase
    .from('recebimento_itens')
    .select('recebimento_id')
    .eq('documento_referencia', numeroPd)
    .neq('ativo', false)
    .limit(5000);
  if (directError) throw directError;
  (directItems || []).forEach((row) => receiptIds.add(row.recebimento_id));

  if (!receiptIds.size) return 0;

  const ids = [...receiptIds];
  const activeReceiptIds = new Set();
  for (let i = 0; i < ids.length; i += 500) {
    const { data, error } = await supabase
      .from('recebimentos')
      .select('id')
      .in('id', ids.slice(i, i + 500))
      .neq('ativo', false);
    if (error) throw error;
    (data || []).forEach((row) => activeReceiptIds.add(row.id));
  }
  if (!activeReceiptIds.size) return 0;

  let total = 0;
  const activeIds = [...activeReceiptIds];
  for (let i = 0; i < activeIds.length; i += 500) {
    const { data, error } = await supabase
      .from('recebimento_itens')
      .select('recebimento_id,documento_referencia,quantidade,condicao_item,ativo')
      .in('recebimento_id', activeIds.slice(i, i + 500))
      .neq('ativo', false)
      .limit(10000);
    if (error) throw error;
    for (const item of data || []) {
      const itemPd = normalizeUpper(item.documento_referencia || numeroPd);
      if (itemPd !== numeroPd) continue;
      total += orderBookQuantity(item);
    }
  }
  return Math.max(0, total);
}

async function applyReceiptDeltaToPdLifecycle(oldItems = [], newItems = [], header = {}, actor = null, options = {}) {
  const defaultDocument = normalizeUpper(header.documentoReferencia);
  const deltas = aggregateReceiptDeltaByPd(oldItems, newItems, defaultDocument);
  const warnings = [];
  const databaseAlreadyReflectsChange = options.databaseAlreadyReflectsChange !== false;

  for (const [numeroPd, delta] of deltas.entries()) {
    if (!delta) continue;
    const { data: pd, error } = await supabase
      .from('compras_pds')
      .select('*')
      .eq('numero_pd', numeroPd)
      .neq('ativo', false)
      .maybeSingle();
    if (error) throw error;
    if (!pd) {
      warnings.push(`Recibo ${header.numeroRecibo} referencia o PD ${numeroPd}, mas esse PD não existe na base canônica do SISHA.`);
      continue;
    }

    const ordered = Math.max(0, normalizeNumber(pd.qtd_comprada) || normalizeNumber(pd.quantidade) || normalizeNumber(pd.qtd_pedida));
    const beforeDelivered = Math.max(0, normalizeNumber(pd.qtd_recebida));
    let receiptDelivered = await computeActiveReceiptQuantityForPd(numeroPd);
    if (!databaseAlreadyReflectsChange) receiptDelivered = Math.max(0, receiptDelivered + delta);

    const historyMap = await loadPdHistoricalEvidence([pd.id]);
    const history = historyMap.get(pd.id) || {};
    const independentOrderBookFloor = Math.max(0, normalizeNumber(history.maxOrderBookDelivered));
    const explicitCorrection = delta < 0;

    // Recibo e Order Book são duas leituras cumulativas da mesma entrega física.
    // Portanto usamos MAX entre as fontes; nunca somamos uma fonte à outra.
    const sourceDelivered = Math.max(receiptDelivered, independentOrderBookFloor);
    const afterDelivered = explicitCorrection
      ? sourceDelivered
      : Math.max(beforeDelivered, sourceDelivered);
    const missing = ordered > 0 ? Math.max(0, ordered - afterDelivered) : 0;
    const previousStatus = normalizeUpper(pd.status_grupo || pd.status || '');
    const historicalOdaEvidence = Boolean(
      history.hasOrderBookEvidence ||
      pd.reconciliado_order_book === true ||
      normalizeUpper(pd.origem_importacao)?.includes('ORDER_BOOK') ||
      await hasOrderBookEvidenceForPd(numeroPd, pd)
    );

    const nextStatus = resolvePdLifecycleStatus({
      currentStatus: previousStatus,
      ordered,
      delivered: afterDelivered,
      orderBookPresent: false,
      historicalOdaEvidence,
      // Na própria correção explícita não reaplicamos o REC histórico derivado
      // do Recibo que está sendo corrigido. Evidência independente do Order Book
      // continua preservada pelo piso quantitativo acima.
      historicalRecEvidence: explicitCorrection ? false : Boolean(history.preserveRec),
      allowRegression: explicitCorrection,
    });

    const payload = {
      qtd_recebida: afterDelivered,
      updated_at: new Date().toISOString(),
    };
    if (nextStatus !== previousStatus) {
      payload.status = nextStatus;
      payload.status_grupo = nextStatus;
    }
    if (nextStatus === 'REC' && header.dataRecebimento) payload.data_entrega = header.dataRecebimento;
    if (explicitCorrection && previousStatus === 'REC' && nextStatus !== 'REC') payload.data_entrega = null;

    const { error: updateError } = await supabase.from('compras_pds').update(payload).eq('id', pd.id);
    if (updateError) throw updateError;

    await tryLogPdReceiptEvent(pd, previousStatus, nextStatus, {
      numero_pd: numeroPd,
      numero_recibo: header.numeroRecibo,
      delta_recebido: delta,
      qtd_pedida_comprada: ordered,
      qtd_por_recibos_ativos: receiptDelivered,
      qtd_entregue_order_book_preservada: independentOrderBookFloor,
      qtd_entregue: afterDelivered,
      qtd_faltante: missing,
      entrega_total: ordered > 0 && afterDelivered >= ordered,
      entrega_parcial: afterDelivered > 0 && ordered > 0 && afterDelivered < ordered,
      regressao_explicita: explicitCorrection,
      regra: 'FONTES_CUMULATIVAS_USAM_MAX; AUSENCIA_DE_SNAPSHOT_NAO_REGRIDE',
    }, actor);

    if (ordered > 0 && afterDelivered > ordered) {
      warnings.push(`PD ${numeroPd}: as evidências de entrega totalizam ${afterDelivered} unidade(s), acima das ${ordered} unidade(s) previstas. O excesso foi preservado como evidência e deve ser conferido.`);
    }
  }

  return warnings;
}

async function applyFocDelta(oldItems = [], newItems = [], header = {}) {
  if (!header.isFoc) return [];
  const defaultDocument = normalizeUpper(header.documentoReferencia);
  const oldMap = aggregateItems(oldItems, defaultDocument);
  const newMap = aggregateItems(newItems, defaultDocument);
  const keys = new Set([...oldMap.keys(), ...newMap.keys()]);
  const warnings = [];

  for (const key of keys) {
    const oldItem = oldMap.get(key) || {};
    const newItem = newMap.get(key) || {};
    const delta = normalizeNumber(newItem.quantidade) - normalizeNumber(oldItem.quantidade);
    const pn = normalizeUpper(newItem.pn || oldItem.pn);
    const documentReference = normalizeUpper(newItem.documento_referencia || oldItem.documento_referencia || defaultDocument);
    if (!pn || delta === 0) continue;

    let query = supabase
      .from('leonardo_foc_spares')
      .select('*')
      .eq('pn', pn)
      .order('id', { ascending: true })
      .limit(100);
    if (documentReference && documentReference !== 'SEM_DOCUMENTO') {
      query = query.eq('documento_referencia', documentReference);
    }
    const { data: rows, error } = await query;
    if (error) throw error;
    if (!(rows || []).length) {
      warnings.push(`Nenhuma linha FOC foi encontrada para PN ${pn}${documentReference ? ` e referência ${documentReference}` : ''}.`);
      continue;
    }
    if ((!documentReference || documentReference === 'SEM_DOCUMENTO') && rows.length > 1) {
      warnings.push(`PN ${pn} não foi sincronizado no FOC porque há ${rows.length} linhas possíveis e o documento de referência não foi informado.`);
      continue;
    }

    let remaining = Math.abs(delta);
    for (const row of rows || []) {
      if (remaining <= 0) break;
      const pending = Math.max(0, normalizeNumber(row.qtd_pendente));
      const amount = delta > 0 ? Math.min(remaining, pending) : remaining;
      if (amount <= 0) continue;
      const updatePayload = {
        qtd_pendente: delta > 0 ? Math.max(0, pending - amount) : pending + amount,
        data_previsao_lh: delta > 0
          ? `✅ ENTREGUE (${header.numeroRecibo})`
          : `⚠ RECEBIMENTO REVERTIDO (${header.numeroRecibo}) — REVALIDAR PREVISÃO`,
      };
      const { error: updateError } = await supabase
        .from('leonardo_foc_spares')
        .update(updatePayload)
        .eq('id', row.id);
      if (updateError) throw updateError;
      remaining -= amount;
    }
    if (remaining > 0) {
      warnings.push(`A sincronização FOC do recibo ${header.numeroRecibo} para PN ${pn} ficou com diferença de ${remaining} unidade(s).`);
    }
  }

  return warnings;
}


function isRealSerial(value) {
  const serial = normalizeUpper(value);
  return Boolean(serial && !['N/A', 'NA', 'S/N', 'SEM SN', 'SEM S/N', '-'].includes(serial));
}

function receiptEventDate(value) {
  const date = parseDateToIso(value);
  return date ? `${date}T12:00:00.000Z` : new Date().toISOString();
}

function equipmentConditionFromReceipt(item = {}) {
  const condition = normalizeUpper(item.condicao_item);
  if (condition === 'QUARENTENA') return 'QUARENTENA';
  if (condition === 'DEFEITUOSO') return 'AVARIADO';
  if (condition === 'DIVERGENTE') return 'AGUARDANDO_AVALIACAO';
  if (condition === 'FALTANTE') return 'NAO_RECEBIDO';
  return 'PRONTO_USO';
}

function receiptEquipmentPosition(item = {}, receipt = {}) {
  const receiptNumber = receipt.numero_recibo || 'SEM NÚMERO';
  const local = normalizeText(item.localizacao_ppu);
  const incorporated = item.contabiliza_pelo_recibo === false
    || (normalizeNumber(item.quantidade) > 0 && normalizeNumber(item.quantidade_inventariada) >= normalizeNumber(item.quantidade));

  if (incorporated) {
    const destination = normalizeUpper(item.destino_estoque) === 'CEIMSPA' ? 'CEIMSPA' : 'PPU';
    return {
      categoria: destination,
      local: destination === 'CEIMSPA'
        ? (local && /CEIMSPA/i.test(local) ? local : 'CEIMSPA')
        : (local || 'PPU — LOCAL NÃO INFORMADO'),
      status: `INCORPORADO_${destination}`,
      confianca: local || destination === 'CEIMSPA' ? 'CONFIRMADA' : 'ALTA',
    };
  }

  if (normalizeUpper(item.destino_previsto) === 'CEIMSPA') {
    return {
      categoria: 'CEIMSPA',
      local: local || `CEIMSPA — RECIBO ${receiptNumber}`,
      status: 'RECEBIDO_CEIMSPA',
      confianca: ['PD_71200', 'RECEBEDOR_CEIMSPA'].includes(normalizeUpper(item.destino_previsto_fonte)) ? 'ALTA' : 'PROVAVEL',
    };
  }

  return {
    categoria: 'RECEBIMENTO',
    local: local || `RECIBO ${receiptNumber} — LOCAL NÃO INFORMADO`,
    status: 'RECEBIDO',
    confianca: local ? 'ALTA' : 'PROVAVEL',
  };
}

async function invalidateReceiptEquipmentEvent(itemId, actor = null, reason = 'Item do recibo deixou de representar equipamento serializado.') {
  if (!itemId) return;
  const originId = `RECEBIMENTO_ITEM:${itemId}`;
  const { error } = await supabase
    .from('equipamento_eventos')
    .update({
      invalidado: true,
      invalidado_em: new Date().toISOString(),
      invalidado_por: actorEmail(actor),
      motivo_invalidacao: reason,
    })
    .eq('origem_evento', 'RECIBO')
    .eq('origem_registro_id', originId)
    .neq('invalidado', true);
  if (error && !['42P01', '42703', 'PGRST204', 'PGRST205'].includes(error.code)) throw error;
}

async function upsertEquipmentFromReceiptItem(item = {}, receipt = {}, actor = null) {
  const pn = normalizeUpper(item.pn);
  const sn = normalizeUpper(item.sn);
  if (!item.id || !pn || !isRealSerial(sn) || normalizeUpper(item.condicao_item) === 'FALTANTE') {
    if (item.id) await invalidateReceiptEquipmentEvent(item.id, actor, 'Linha sem equipamento físico válido após revisão do recibo.');
    return null;
  }

  const { data: existing, error: existingError } = await supabase
    .from('equipamentos_serializados')
    .select('*')
    .eq('pn', pn)
    .eq('sn', sn)
    .maybeSingle();
  if (existingError) throw existingError;

  let equipment = existing;
  if (!equipment) {
    const { data, error } = await supabase
      .from('equipamentos_serializados')
      .upsert({
        pn,
        sn,
        nomenclatura: normalizeText(item.nomenclatura),
        status_atual: 'DESCONHECIDO',
        condicao_atual: 'DESCONHECIDA',
        categoria_local_atual: 'DESCONHECIDO',
        confianca_localizacao: 'DESCONHECIDA',
        garantia_vencimento: parseDateToIso(item.data_garantia),
        garantia_documento: receipt.numero_recibo || null,
        origem_entrada: 'RECIBO',
        documento_entrada: receipt.numero_recibo || null,
        data_entrada: parseDateToIso(receipt.data_recebimento),
        atualizado_por: actorEmail(actor),
        ativo: true,
      }, { onConflict: 'pn,sn', ignoreDuplicates: true })
      .select('*')
      .maybeSingle();
    if (error) throw error;
    equipment = data;

    // Se outra importação criou o PN+SN na mesma janela, o ignoreDuplicates
    // não retorna linha. Recarregamos a identidade vencedora e seguimos o
    // Recibo sem duplicar nem abortar o processamento.
    if (!equipment) {
      const { data: racedExisting, error: racedError } = await supabase
        .from('equipamentos_serializados')
        .select('*')
        .eq('pn', pn)
        .eq('sn', sn)
        .maybeSingle();
      if (racedError) throw racedError;
      if (!racedExisting) throw new Error(`PN ${pn} / SN ${sn} não pôde ser reconciliado após gravação idempotente do Recibo.`);
      equipment = racedExisting;
    }
  } else {
    const update = {
      ativo: true,
      atualizado_por: actorEmail(actor),
      updated_at: new Date().toISOString(),
    };
    if (!normalizeText(equipment.nomenclatura) && normalizeText(item.nomenclatura)) update.nomenclatura = normalizeText(item.nomenclatura);
    if (item.data_garantia) {
      update.garantia_vencimento = parseDateToIso(item.data_garantia);
      update.garantia_documento = receipt.numero_recibo || equipment.garantia_documento || null;
    }
    const { data, error } = await supabase
      .from('equipamentos_serializados')
      .update(update)
      .eq('id', equipment.id)
      .select('*')
      .single();
    if (error) throw error;
    equipment = data;
  }

  const position = receiptEquipmentPosition(item, receipt);
  const originId = `RECEBIMENTO_ITEM:${item.id}`;
  const { data: previousEvent, error: previousEventError } = await supabase
    .from('equipamento_eventos')
    .select('*')
    .eq('origem_evento', 'RECIBO')
    .eq('origem_registro_id', originId)
    .maybeSingle();
  if (previousEventError && !['42703', 'PGRST204'].includes(previousEventError.code)) throw previousEventError;

  const eventPayload = {
    equipamento_id: equipment.id,
    pn,
    sn,
    tipo_evento: 'RECEBIMENTO',
    data_evento: receiptEventDate(receipt.data_recebimento),
    local_origem: previousEvent?.local_origem ?? equipment.local_atual ?? null,
    local_destino: position.local,
    categoria_origem: previousEvent?.categoria_origem ?? equipment.categoria_local_atual ?? null,
    categoria_destino: position.categoria,
    status_resultante: position.status,
    condicao_resultante: equipmentConditionFromReceipt(item),
    motivo: `Equipamento identificado no Recibo ${receipt.numero_recibo || 'sem número'}.`,
    documento_tipo: 'RECIBO',
    documento: receipt.numero_recibo || null,
    observacao: normalizeText(item.observacao_item),
    usuario: actorEmail(actor),
    origem_evento: 'RECIBO',
    origem_registro_id: originId,
    confianca: position.confianca,
    automatico: true,
    invalidado: false,
    invalidado_em: null,
    invalidado_por: null,
    motivo_invalidacao: null,
    payload: {
      recebimento_id: receipt.id,
      recebimento_item_id: item.id,
      tipo_recebimento: receipt.tipo_recebimento,
      is_foc: Boolean(receipt.is_foc),
      programa_origem: receipt.programa_origem || null,
      destino_previsto: item.destino_previsto || null,
      destino_previsto_fonte: item.destino_previsto_fonte || null,
      destino_estoque: item.destino_estoque || null,
      validade_status: item.validade_status || null,
      sn_extraido_documento: Boolean(item.sn_extraido_documento),
    },
  };

  const { error: eventError } = await supabase
    .from('equipamento_eventos')
    .upsert(eventPayload, { onConflict: 'origem_evento,origem_registro_id' });
  if (eventError) throw eventError;

  const { error: linkError } = await supabase
    .from('recebimento_itens')
    .update({ equipamento_id: equipment.id, updated_at: new Date().toISOString() })
    .eq('id', item.id);
  if (linkError && !['42703', 'PGRST204'].includes(linkError.code)) throw linkError;

  return equipment.id;
}

async function syncReceiptEquipmentEvents(receipt = {}, before = [], after = [], actor = null) {
  const afterIds = new Set(after.map((item) => item.id).filter(Boolean));
  const warnings = [];

  for (const previous of before) {
    if (previous.id && !afterIds.has(previous.id)) {
      try {
        await invalidateReceiptEquipmentEvent(previous.id, actor, 'Item removido logicamente do recibo; evidência de localização invalidada.');
      } catch (error) {
        warnings.push(`Não foi possível invalidar o vínculo do equipamento do item ${previous.id}: ${error.message || error}`);
      }
    }
  }

  for (const item of after) {
    try {
      await upsertEquipmentFromReceiptItem(item, receipt, actor);
    } catch (error) {
      warnings.push(`PN ${item.pn || 'N/I'} / SN ${item.sn || 'N/I'}: vínculo com Equipamentos pendente — ${error.message || error}`);
    }
  }

  return warnings;
}

function normalizeHeader(header = {}) {
  const numeroRecibo = normalizeUpper(header.numeroRecibo);
  if (!numeroRecibo || ['N/A', 'NA', 'S/N', 'SEM NUMERO', 'SEM NÚMERO'].includes(numeroRecibo)) {
    const error = new Error('Número ou referência técnica única do recibo é obrigatório para impedir duplicidade.');
    error.code = 'RECEIPT_REFERENCE_REQUIRED';
    throw error;
  }

  return {
    numeroRecibo,
    tipoRecebimento: normalizeUpper(header.tipoRecebimento) || 'MATERIAL',
    dataRecebimento: parseDateToIso(header.dataRecebimento),
    documentoReferencia: normalizeText(header.documentoReferencia),
    fornecedor: normalizeText(header.fornecedor),
    origemMaterial: normalizeText(header.origemMaterial),
    programaOrigem: normalizeText(header.programaOrigem),
    programaOrigemFonte: normalizeText(header.programaOrigemFonte),
    codigoOmRecebedora: normalizeText(header.codigoOmRecebedora),
    siglaRecebedora: normalizeUpper(header.siglaRecebedora),
    recebidoPorNome: normalizeText(header.recebidoPorNome),
    conferidoPorNome: normalizeText(header.conferidoPorNome),
    metodoImportacao: normalizeUpper(header.metodoImportacao) || 'MANUAL',
    arquivoNome: normalizeText(header.arquivoNome),
    arquivoHash: normalizeText(header.arquivoHash),
    chatLinceDocumentoId: header.chatLinceDocumentoId || null,
    isFoc: Boolean(header.isFoc),
    observacao: normalizeText(header.observacao),
    avisosTriagem: Array.isArray(header.avisosTriagem) ? header.avisosTriagem : [],
    dadosOriginais: header.dadosOriginais && typeof header.dadosOriginais === 'object'
      ? header.dadosOriginais
      : {},
  };
}

async function updateReceiptHeader(receiptId, header, actor = null) {
  const payload = {
    numero_recibo: header.numeroRecibo,
    tipo_recebimento: header.tipoRecebimento,
    data_recebimento: header.dataRecebimento,
    documento_referencia: header.documentoReferencia,
    fornecedor: header.fornecedor,
    origem_material: header.origemMaterial,
    programa_origem: header.programaOrigem,
    programa_origem_fonte: header.programaOrigemFonte,
    codigo_om_recebedora: header.codigoOmRecebedora,
    sigla_recebedora: header.siglaRecebedora,
    recebido_por_nome: header.recebidoPorNome,
    conferido_por_nome: header.conferidoPorNome,
    metodo_importacao: header.metodoImportacao,
    arquivo_nome: header.arquivoNome,
    arquivo_hash: header.arquivoHash,
    chat_lince_documento_id: header.chatLinceDocumentoId,
    is_foc: header.isFoc,
    observacao: header.observacao,
    avisos_triagem: header.avisosTriagem,
    dados_originais: header.dadosOriginais,
    ativo: true,
    updated_by_email: actorEmail(actor),
    updated_at: new Date().toISOString(),
  };

  const { data, error } = await supabase
    .from('recebimentos')
    .update(payload)
    .eq('id', receiptId)
    .select('*')
    .single();
  if (error) throw error;
  return data;
}

async function saveReceipt({ receiptId = null, header, items = [], actor = null }) {
  const normalizedHeader = normalizeHeader(header);
  const validItems = (items || []).filter((item) => normalizeUpper(item.pn) && normalizeNumber(item.quantidade) > 0);
  if (!validItems.length) {
    const error = new Error('Informe ao menos um item com PN e quantidade maior que zero.');
    error.code = 'RECEIPT_ITEMS_REQUIRED';
    throw error;
  }

  let previousReceipt = null;
  if (receiptId) {
    const { data, error } = await supabase.from('recebimentos').select('*').eq('id', receiptId).maybeSingle();
    if (error) throw error;
    previousReceipt = data || null;
  } else {
    const { data, error } = await supabase
      .from('recebimentos')
      .select('*')
      .eq('numero_recibo', normalizedHeader.numeroRecibo)
      .eq('tipo_recebimento', normalizedHeader.tipoRecebimento)
      .neq('ativo', false)
      .maybeSingle();
    if (error) throw error;
    previousReceipt = data || null;
  }

  let receipt;
  if (receiptId) {
    receipt = await updateReceiptHeader(receiptId, normalizedHeader, actor);
  } else {
    receipt = await ensureRecebimentoHeader(normalizedHeader, actor);
  }

  const { before, after } = await replaceRecebimentoItens(receipt.id, validItems, actor);
  const previousHeader = previousReceipt ? normalizeHeader({
    numeroRecibo: previousReceipt.numero_recibo,
    tipoRecebimento: previousReceipt.tipo_recebimento,
    dataRecebimento: previousReceipt.data_recebimento,
    documentoReferencia: previousReceipt.documento_referencia,
    fornecedor: previousReceipt.fornecedor,
    origemMaterial: previousReceipt.origem_material,
    programaOrigem: previousReceipt.programa_origem,
    programaOrigemFonte: previousReceipt.programa_origem_fonte,
    codigoOmRecebedora: previousReceipt.codigo_om_recebedora,
    siglaRecebedora: previousReceipt.sigla_recebedora,
    recebidoPorNome: previousReceipt.recebido_por_nome,
    conferidoPorNome: previousReceipt.conferido_por_nome,
    metodoImportacao: previousReceipt.metodo_importacao,
    arquivoNome: previousReceipt.arquivo_nome,
    arquivoHash: previousReceipt.arquivo_hash,
    chatLinceDocumentoId: previousReceipt.chat_lince_documento_id,
    isFoc: previousReceipt.is_foc,
    observacao: previousReceipt.observacao,
    avisosTriagem: previousReceipt.avisos_triagem,
    dadosOriginais: previousReceipt.dados_originais,
  }) : null;

  const routingChanged = previousHeader && (
    previousHeader.tipoRecebimento !== normalizedHeader.tipoRecebimento
    || previousHeader.documentoReferencia !== normalizedHeader.documentoReferencia
    || previousHeader.isFoc !== normalizedHeader.isFoc
  );

  const syncWarnings = [];
  try {
    if (routingChanged) {
      syncWarnings.push(...await applyReceiptDeltaToOrderBook(before, [], previousHeader));
      syncWarnings.push(...await applyReceiptDeltaToPdLifecycle(before, [], previousHeader, actor));
      syncWarnings.push(...await applyFocDelta(before, [], previousHeader));
      syncWarnings.push(...await applyReceiptDeltaToOrderBook([], after, normalizedHeader));
      syncWarnings.push(...await applyReceiptDeltaToPdLifecycle([], after, normalizedHeader, actor));
      syncWarnings.push(...await applyFocDelta([], after, normalizedHeader));
    } else {
      syncWarnings.push(...await applyReceiptDeltaToOrderBook(before, after, normalizedHeader));
      syncWarnings.push(...await applyReceiptDeltaToPdLifecycle(before, after, normalizedHeader, actor));
      syncWarnings.push(...await applyFocDelta(before, after, normalizedHeader));
    }
  } catch (syncError) {
    const warning = `Recibo salvo, mas a projeção no Order Book/FOC precisa ser reconciliada: ${syncError.message || String(syncError)}`;
    syncWarnings.push(warning);
  }

  try {
    syncWarnings.push(...await syncReceiptEquipmentEvents({ ...receipt, ...{
      numero_recibo: normalizedHeader.numeroRecibo,
      data_recebimento: normalizedHeader.dataRecebimento,
      tipo_recebimento: normalizedHeader.tipoRecebimento,
      is_foc: normalizedHeader.isFoc,
      programa_origem: normalizedHeader.programaOrigem,
    } }, before, after, actor));
  } catch (equipmentSyncError) {
    syncWarnings.push(`Recibo salvo, mas a sincronização dos equipamentos serializados precisa ser reconciliada: ${equipmentSyncError.message || String(equipmentSyncError)}`);
  }

  if (syncWarnings.length) {
    try {
      await logReceiptEvent(receipt.id, 'SINCRONIZACAO_ORDER_BOOK_PENDENTE', {
        avisos: syncWarnings,
      }, actor);
    } catch (eventError) {
      console.error('[SISHA][recebimentos] falha ao registrar avisos de sincronização:', eventError);
    }
  }

  const beforeMap = new Map(before.map((item) => [item.id, item]));
  const afterMap = new Map(after.map((item) => [item.id, item]));

  if (previousReceipt) {
    const headerChanges = buildChanges(previousHeader, normalizedHeader, AUDITED_HEADER_FIELDS);
    if (Object.keys(headerChanges).length) {
      await logReceiptEvent(receipt.id, 'CABECALHO_RECIBO_EDITADO', {
        alteracoes: headerChanges,
      }, actor);
    }

    for (const item of after) {
      const previous = beforeMap.get(item.id);
      if (!previous) {
        await logReceiptEvent(receipt.id, 'ITEM_ADICIONADO', {
          item: auditItemSnapshot(item),
        }, actor, item.id);
        continue;
      }

      const itemChanges = buildChanges(previous, item, AUDITED_ITEM_FIELDS);
      if (Object.keys(itemChanges).length) {
        await logReceiptEvent(receipt.id, 'ITEM_EDITADO', {
          pn: item.pn,
          sn: item.sn,
          alteracoes: itemChanges,
        }, actor, item.id);
      }

      const previousInventoried = normalizeNumber(previous.quantidade_inventariada);
      const currentInventoried = normalizeNumber(item.quantidade_inventariada);
      if (previousInventoried !== currentInventoried || previous.destino_estoque !== item.destino_estoque) {
        await logReceiptEvent(receipt.id, 'ITEM_INCORPORACAO_ESTOQUE_AJUSTADA', {
          pn: item.pn,
          sn: item.sn,
          quantidade_recebida: normalizeNumber(item.quantidade),
          destino_estoque_antes: previous.destino_estoque || null,
          destino_estoque_depois: item.destino_estoque || null,
          quantidade_incorporada_antes: previousInventoried,
          quantidade_incorporada_depois: currentInventoried,
          saldo_temporario_antes: Math.max(0, normalizeNumber(previous.quantidade) - previousInventoried),
          saldo_temporario_depois: Math.max(0, normalizeNumber(item.quantidade) - currentInventoried),
          incorporacao_total: Boolean(item.inventariado_ppu),
          contabiliza_pelo_recibo: item.contabiliza_pelo_recibo !== false,
        }, actor, item.id);
      }
    }

    for (const previous of before) {
      if (!afterMap.has(previous.id)) {
        await logReceiptEvent(receipt.id, 'ITEM_REMOVIDO_LOGICAMENTE', {
          item: auditItemSnapshot(previous),
        }, actor, previous.id);
      }
    }
  }

  await logReceiptEvent(receipt.id, previousReceipt ? 'RECIBO_EDITADO' : 'RECIBO_CRIADO', {
    numero_recibo: normalizedHeader.numeroRecibo,
    tipo_recebimento: normalizedHeader.tipoRecebimento,
    metodo_importacao: normalizedHeader.metodoImportacao,
    itens_antes: before.length,
    itens_depois: after.length,
    saldo_temporario: after
      .filter((item) => item.condicao_item === 'RECEBIDO_DISPONIVEL' && item.contabiliza_pelo_recibo !== false)
      .reduce((sum, item) => sum + Math.max(0, normalizeNumber(item.quantidade) - normalizeNumber(item.quantidade_inventariada)), 0),
  }, actor);

  const { data: refreshed, error } = await supabase
    .from('recebimentos')
    .select('*, recebimento_itens(*), recebimento_eventos(*)')
    .eq('id', receipt.id)
    .single();
  if (error) throw error;
  return {
    ...refreshed,
    _avisos_sincronizacao: syncWarnings,
  };
}

async function deactivateReceipt(receiptId, actor = null) {
  const { data: receipt, error: receiptError } = await supabase
    .from('recebimentos')
    .select('*, recebimento_itens(*)')
    .eq('id', receiptId)
    .single();
  if (receiptError) throw receiptError;

  const oldItems = (receipt.recebimento_itens || []).filter((item) => item.ativo !== false);
  const header = normalizeHeader({
    numeroRecibo: receipt.numero_recibo,
    tipoRecebimento: receipt.tipo_recebimento,
    dataRecebimento: receipt.data_recebimento,
    documentoReferencia: receipt.documento_referencia,
    fornecedor: receipt.fornecedor,
    origemMaterial: receipt.origem_material,
    programaOrigem: receipt.programa_origem,
    programaOrigemFonte: receipt.programa_origem_fonte,
    codigoOmRecebedora: receipt.codigo_om_recebedora,
    siglaRecebedora: receipt.sigla_recebedora,
    recebidoPorNome: receipt.recebido_por_nome,
    conferidoPorNome: receipt.conferido_por_nome,
    metodoImportacao: receipt.metodo_importacao,
    arquivoNome: receipt.arquivo_nome,
    arquivoHash: receipt.arquivo_hash,
    chatLinceDocumentoId: receipt.chat_lince_documento_id,
    isFoc: receipt.is_foc,
    observacao: receipt.observacao,
    avisosTriagem: receipt.avisos_triagem,
    dadosOriginais: receipt.dados_originais,
  });

  const syncWarnings = [];
  try {
    syncWarnings.push(...await applyReceiptDeltaToOrderBook(oldItems, [], header));
    syncWarnings.push(...await applyReceiptDeltaToPdLifecycle(oldItems, [], header, actor, { databaseAlreadyReflectsChange: false }));
    syncWarnings.push(...await applyFocDelta(oldItems, [], header));
  } catch (syncError) {
    const warning = `Recibo desativado no módulo de recebimentos, mas a projeção no Order Book/FOC precisa ser reconciliada: ${syncError.message || String(syncError)}`;
    syncWarnings.push(warning);
  }

  for (const item of oldItems) {
    if (!item.id) continue;
    try {
      await invalidateReceiptEquipmentEvent(item.id, actor, `Recibo ${receipt.numero_recibo} desativado; evidência derivada do recibo invalidada.`);
    } catch (error) {
      syncWarnings.push(`Não foi possível invalidar o evento do equipamento do item ${item.id}: ${error.message || error}`);
    }
  }

  const { error: itemsError } = await supabase
    .from('recebimento_itens')
    .update({ ativo: false, updated_at: new Date().toISOString() })
    .eq('recebimento_id', receiptId)
    .neq('ativo', false);
  if (itemsError) throw itemsError;

  const { data: deactivated, error: deactivateError } = await supabase
    .from('recebimentos')
    .update({
      ativo: false,
      updated_by_email: actorEmail(actor),
      updated_at: new Date().toISOString(),
    })
    .eq('id', receiptId)
    .select('*')
    .single();
  if (deactivateError) throw deactivateError;

  await logReceiptEvent(receiptId, 'RECIBO_DESATIVADO', {
    numero_recibo: receipt.numero_recibo,
    itens_desativados: oldItems.length,
  }, actor);

  if (syncWarnings.length) {
    try {
      await logReceiptEvent(receiptId, 'SINCRONIZACAO_ORDER_BOOK_PENDENTE', {
        avisos: syncWarnings,
      }, actor);
    } catch (eventError) {
      console.error('[SISHA][recebimentos] falha ao registrar avisos de sincronização:', eventError);
    }
  }

  return {
    ...deactivated,
    _avisos_sincronizacao: syncWarnings,
  };
}

module.exports = {
  saveReceipt,
  deactivateReceipt,
  fetchReceiptItems,
  applyReceiptDeltaToOrderBook,
  syncReceiptEquipmentEvents,
};
