const supabase = require('../config/supabaseClient');

function normalizeUpper(value = '') {
  return String(value || '').trim().toUpperCase();
}

function normalizeComparable(value = '') {
  return normalizeUpper(value).replace(/[^A-Z0-9]/g, '');
}

function normalizeNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function positiveNumber(...values) {
  for (const value of values) {
    const n = normalizeNumber(value);
    if (n > 0) return n;
  }
  return 0;
}

function parseDetail(value) {
  if (!value) return {};
  if (typeof value === 'object') return value;
  try { return JSON.parse(value); } catch (_) { return {}; }
}

/**
 * Regra canônica do lifecycle do PD.
 *
 * Normalmente o ciclo é monotônico: um snapshot novo ausente ou atrasado não
 * desfaz ODA/REC já comprovado. Regressão só é permitida quando o chamador
 * sinaliza explicitamente uma correção/revogação da evidência que causou o avanço.
 */
function resolvePdLifecycleStatus({
  currentStatus = '',
  ordered = 0,
  delivered = 0,
  orderBookPresent = false,
  historicalOdaEvidence = false,
  historicalRecEvidence = false,
  allowRegression = false,
} = {}) {
  const current = normalizeUpper(currentStatus);
  const total = Math.max(0, normalizeNumber(ordered));
  const received = Math.max(0, normalizeNumber(delivered));
  const preOdaStatuses = new Set(['', 'ELB', 'TRI', 'ANS', 'COT', 'PRO', 'LPC', 'LIB', 'LIBERADA', 'LIBERADO', 'ODC', 'ATIVO']);

  if (['CAN', 'EXCLUIDO'].includes(current)) return current;
  if (total > 0 && received >= total) return 'REC';

  // Evidência terminal positiva não some porque um Order Book posterior deixou
  // de listar o PD. Somente uma correção explícita pode autorizar regressão.
  if (!allowRegression && (current === 'REC' || historicalRecEvidence)) return 'REC';

  if (allowRegression && current === 'REC' && (total <= 0 || received < total)) {
    return (orderBookPresent || historicalOdaEvidence || received > 0) ? 'ODA' : 'ODC';
  }

  if ((orderBookPresent || historicalOdaEvidence || received > 0) && preOdaStatuses.has(current)) return 'ODA';
  return current || 'ODC';
}

function normalizeOcRoot(value = '') {
  const normalized = normalizeUpper(value);
  return normalized ? normalized.split('/')[0].trim() : '';
}

function buildOrderBookIndex(spares = []) {
  const strong = new Map();
  const byPd = new Map();

  for (const row of spares || []) {
    const numeroPd = normalizeUpper(row.documento_referencia);
    const pn = normalizeUpper(row.pn);
    if (!numeroPd || numeroPd === 'N/A') continue;

    const normalized = {
      numeroPd,
      pn,
      numeroOc: normalizeOcRoot(row.oc_referencia),
      numeroOcOriginal: normalizeUpper(row.oc_referencia) || null,
    };

    if (pn) strong.set(`${normalizeComparable(numeroPd)}|${normalizeComparable(pn)}`, normalized);
    if (!byPd.has(normalizeComparable(numeroPd))) byPd.set(normalizeComparable(numeroPd), []);
    byPd.get(normalizeComparable(numeroPd)).push(normalized);
  }

  return { strong, byPd };
}

function findOrderBookMatch(pd, index) {
  const numeroPd = normalizeComparable(pd.numero_pd);
  const pn = normalizeComparable(pd.pn);
  if (!numeroPd) return null;

  const strong = index.strong.get(`${numeroPd}|${pn}`);
  if (strong) return strong;

  const candidates = index.byPd.get(numeroPd) || [];
  // O número completo do PD é a identidade canônica. Para vínculo de OC usamos
  // fallback somente quando há uma linha inequívoca; divergência de PN continua alerta.
  if (candidates.length === 1) return candidates[0];
  return null;
}

function orderBookBusinessLineKey(row = {}, index = 0) {
  const stableParts = [
    normalizeComparable(row.documento_referencia),
    normalizeComparable(row.pn),
    normalizeComparable(row.oc_referencia),
    normalizeComparable(row.cust_po_item),
    normalizeComparable(row.sales_order),
    normalizeComparable(row.sales_order_item),
  ];
  // Quando o Order Book não possui identificador de item, a linha física é a
  // última fronteira para não colapsar entregas realmente fracionadas.
  if (!stableParts.slice(3).some(Boolean)) {
    stableParts.push(normalizeComparable(row.source_sheet), String(row.source_row ?? index));
  }
  return stableParts.join('|');
}

/**
 * Consolida as colunas quantitativas do Order Book por PD sem misturar fontes.
 * qtd_comprada = quantidade contratada/solicitada no Order Book
 * qtd_em_rota   = "in delivery / in shipment" (não é recebimento)
 * qtd_entregue  = entrega cumulativa declarada pelo Order Book
 */
function buildOrderBookPdEvidence(rows = []) {
  const dedupedLines = new Map();
  (rows || []).forEach((row, index) => {
    const pdKey = normalizeComparable(row?.documento_referencia);
    if (!pdKey || normalizeUpper(row?.documento_referencia) === 'N/A') return;
    const lineKey = orderBookBusinessLineKey(row, index);
    const previous = dedupedLines.get(lineKey);
    if (!previous) {
      dedupedLines.set(lineKey, row);
      return;
    }
    // Duplicata exata de chave comercial: preserva o maior acumulado observado,
    // evitando dobrar uma linha repetida do Excel.
    dedupedLines.set(lineKey, {
      ...previous,
      qtd_comprada: Math.max(normalizeNumber(previous.qtd_comprada), normalizeNumber(row.qtd_comprada)),
      qtd_pendente: Math.max(normalizeNumber(previous.qtd_pendente), normalizeNumber(row.qtd_pendente)),
      qtd_aguardando_coleta: Math.max(normalizeNumber(previous.qtd_aguardando_coleta), normalizeNumber(row.qtd_aguardando_coleta)),
      qtd_em_rota: Math.max(normalizeNumber(previous.qtd_em_rota), normalizeNumber(row.qtd_em_rota)),
      qtd_entregue: Math.max(normalizeNumber(previous.qtd_entregue), normalizeNumber(row.qtd_entregue)),
    });
  });

  const grouped = new Map();
  for (const row of dedupedLines.values()) {
    const numeroPd = normalizeUpper(row.documento_referencia);
    const key = normalizeComparable(numeroPd);
    if (!grouped.has(key)) {
      grouped.set(key, {
        numero_pd: numeroPd,
        pns: new Set(),
        ocs: new Set(),
        status_order_book: new Set(),
        qtd_comprada: 0,
        qtd_pendente: 0,
        qtd_aguardando_coleta: 0,
        qtd_em_rota: 0,
        qtd_entregue: 0,
        latest_snapshot_date: null,
        linhas: 0,
      });
    }
    const evidence = grouped.get(key);
    if (normalizeUpper(row.pn)) evidence.pns.add(normalizeUpper(row.pn));
    if (normalizeUpper(row.oc_referencia)) evidence.ocs.add(normalizeUpper(row.oc_referencia));
    if (normalizeUpper(row.status_categoria)) evidence.status_order_book.add(normalizeUpper(row.status_categoria));

    const delivered = Math.max(0, normalizeNumber(row.qtd_entregue));
    const pending = Math.max(0, normalizeNumber(row.qtd_pendente));
    const ordered = positiveNumber(row.qtd_comprada, delivered + pending);
    evidence.qtd_comprada += ordered;
    evidence.qtd_pendente += pending;
    evidence.qtd_aguardando_coleta += Math.max(0, normalizeNumber(row.qtd_aguardando_coleta));
    evidence.qtd_em_rota += Math.max(0, normalizeNumber(row.qtd_em_rota));
    evidence.qtd_entregue += delivered;
    evidence.linhas += 1;

    const snapshot = row.snapshot_date || null;
    if (snapshot && (!evidence.latest_snapshot_date || String(snapshot) > String(evidence.latest_snapshot_date))) {
      evidence.latest_snapshot_date = snapshot;
    }
  }

  return grouped;
}

function listOrderBookPdGaps(spares = [], pds = []) {
  const localByPd = new Map();
  for (const pd of pds || []) {
    if (pd?.ativo === false) continue;
    const key = normalizeComparable(pd?.numero_pd);
    if (!key) continue;
    localByPd.set(key, pd);
  }

  const grouped = buildOrderBookPdEvidence(spares);
  const gaps = [];
  const pnDivergences = [];
  for (const [key, info] of grouped.entries()) {
    const local = localByPd.get(key);
    if (!local) {
      gaps.push({
        numero_pd: info.numero_pd,
        pns: [...info.pns],
        ocs: [...info.ocs],
        status_order_book: [...info.status_order_book],
        linhas_order_book: info.linhas,
        qtd_comprada: info.qtd_comprada,
        qtd_em_rota: info.qtd_em_rota,
        qtd_entregue: info.qtd_entregue,
        motivo: 'PD aparece no Order Book, mas não existe na base canônica de PD/SEPD do SISHA.',
      });
      continue;
    }
    const localPn = normalizeUpper(local.pn);
    if (localPn && info.pns.size && !info.pns.has(localPn)) {
      pnDivergences.push({
        numero_pd: local.numero_pd,
        pn_sisha: localPn,
        pns_order_book: [...info.pns],
        motivo: 'O número do PD é o mesmo, porém o PN do SISHA diverge do PN observado no Order Book.',
      });
    }
  }

  return { gaps, pnDivergences };
}

async function tryInsertEvents(events = []) {
  if (!events.length) return;
  const { error } = await supabase.from('compras_pd_eventos').insert(events);
  if (error && !['42P01', 'PGRST205'].includes(error.code)) throw error;
}

function emptyHistoricalEvidence() {
  return {
    hasOrderBookEvidence: false,
    maxOrderBookDelivered: 0,
    preserveRec: false,
    recDeliveredFloor: 0,
  };
}

/**
 * Reconstrói somente evidências positivas já registradas. Uma correção explícita
 * de Recibo (delta negativo) pode derrubar o REC derivado desse Recibo, mas nunca
 * apaga uma entrega independente já comprovada pelo Order Book.
 */
async function loadPdHistoricalEvidence(pdIds = []) {
  const result = new Map((pdIds || []).filter(Boolean).map((id) => [id, emptyHistoricalEvidence()]));
  const ids = [...result.keys()];
  if (!ids.length) return result;

  try {
    for (let i = 0; i < ids.length; i += 200) {
      const chunk = ids.slice(i, i + 200);
      const { data, error } = await supabase
        .from('compras_pd_eventos')
        .select('pd_id,tipo_evento,status_anterior,status_novo,origem,detalhe,created_at')
        .in('pd_id', chunk)
        .order('created_at', { ascending: true })
        .limit(20000);
      if (error) throw error;

      for (const event of data || []) {
        if (!result.has(event.pd_id)) result.set(event.pd_id, emptyHistoricalEvidence());
        const state = result.get(event.pd_id);
        const detail = parseDetail(event.detalhe);
        const type = normalizeUpper(event.tipo_evento);
        const origin = normalizeUpper(event.origem);
        const previous = normalizeUpper(event.status_anterior);
        const next = normalizeUpper(event.status_novo);
        const deltaReceipt = normalizeNumber(detail.delta_recebido);

        const isOrderBook = origin === 'ORDER_BOOK' || type.includes('ORDER_BOOK');
        if (isOrderBook) {
          state.hasOrderBookEvidence = true;
          state.maxOrderBookDelivered = Math.max(
            state.maxOrderBookDelivered,
            Math.max(0, normalizeNumber(detail.qtd_entregue_order_book)),
            Math.max(0, normalizeNumber(detail.qtd_entregue)),
          );
        }
        if (type === 'RECONCILIACAO_RETROATIVA_PD' && detail.order_book_presente === true) {
          state.hasOrderBookEvidence = true;
        }

        // Correção/revogação explícita do Recibo pode desfazer a terminalidade
        // que dependia apenas do próprio Recibo.
        if (type === 'RECIBO_ATUALIZOU_ENTREGA_PD' && deltaReceipt < 0) {
          state.preserveRec = false;
          state.recDeliveredFloor = 0;
        }

        if (next === 'REC' && !(type === 'RECONCILIACAO_RETROATIVA_PD' && previous === 'REC')) {
          state.preserveRec = true;
          state.recDeliveredFloor = Math.max(
            state.recDeliveredFloor,
            Math.max(0, normalizeNumber(detail.qtd_entregue)),
            Math.max(0, normalizeNumber(detail.qtd_recebida_recalculada)),
          );
        }

        // HF: a reconciliação retroativa antiga podia regredir REC só porque o
        // último snapshot não tinha o PD. Esse evento não revoga a evidência REC.
        if (type === 'RECONCILIACAO_RETROATIVA_PD' && previous === 'REC' && next !== 'REC') {
          state.preserveRec = true;
          state.recDeliveredFloor = Math.max(
            state.recDeliveredFloor,
            Math.max(0, normalizeNumber(detail.qtd_recebida_anterior)),
          );
        }
      }
    }
  } catch (error) {
    if (!['42P01', 'PGRST205'].includes(error.code)) {
      console.warn('[SISHA][PD] Histórico compras_pd_eventos indisponível para reconciliação:', error.message || error);
    }
  }

  return result;
}

async function loadOrdersByNumber(orderNumbers = []) {
  const orderByNumber = new Map();
  for (let i = 0; i < orderNumbers.length; i += 200) {
    const chunk = orderNumbers.slice(i, i + 200);
    if (!chunk.length) continue;
    const { data: orders, error } = await supabase
      .from('compras_ordens')
      .select('id,numero_oc,numero_oc_original,status')
      .in('numero_oc', chunk);
    if (error) throw error;
    for (const order of orders || []) orderByNumber.set(normalizeOcRoot(order.numero_oc), order);
  }
  return orderByNumber;
}

async function reconcileOrderBookPds(spares = [], actor = null) {
  const index = buildOrderBookIndex(spares);
  const evidenceByPd = buildOrderBookPdEvidence(spares);
  if (evidenceByPd.size === 0) {
    return {
      analisados: 0, reconciliados: 0, jaOda: 0, ignoradosStatusAvancado: 0,
      ambiguos: 0, naoEncontrados: 0, quantidades_atualizadas: 0,
      entrega_parcial_order_book: 0, entregues_order_book: 0,
      pds_sem_origem: [], divergencias_pn: [],
    };
  }

  const { data: pds, error } = await supabase
    .from('compras_pds')
    .select('*')
    .neq('ativo', false)
    .limit(20000);
  if (error) throw error;

  const pdsByKey = new Map();
  for (const pd of pds || []) {
    const key = normalizeComparable(pd.numero_pd);
    if (key) pdsByKey.set(key, pd);
  }

  const historical = await loadPdHistoricalEvidence((pds || []).map((pd) => pd.id));
  const orderNumbers = new Set();
  for (const evidence of evidenceByPd.values()) {
    for (const oc of evidence.ocs) {
      const root = normalizeOcRoot(oc);
      if (root) orderNumbers.add(root);
    }
  }
  const orderByNumber = await loadOrdersByNumber([...orderNumbers]);

  let reconciliados = 0;
  let jaOda = 0;
  let ignoradosStatusAvancado = 0;
  let ambiguos = 0;
  let naoEncontrados = 0;
  let quantidadesAtualizadas = 0;
  let parciais = 0;
  let entregues = 0;
  const events = [];
  const now = new Date().toISOString();

  for (const [key, evidence] of evidenceByPd.entries()) {
    const pd = pdsByKey.get(key);
    if (!pd) continue; // listado separadamente como PD sem origem

    const history = historical.get(pd.id) || emptyHistoricalEvidence();
    const currentStatus = normalizeUpper(pd.status_grupo || pd.status || '');
    const canonicalOrdered = positiveNumber(pd.qtd_comprada, pd.quantidade, pd.qtd_pedida);
    const ordered = canonicalOrdered || Math.max(0, evidence.qtd_comprada);
    const beforeDelivered = Math.max(0, normalizeNumber(pd.qtd_recebida));
    const orderBookDelivered = Math.max(0, normalizeNumber(evidence.qtd_entregue));
    const afterDelivered = Math.max(beforeDelivered, history.maxOrderBookDelivered, orderBookDelivered);
    const nextStatus = resolvePdLifecycleStatus({
      currentStatus,
      ordered,
      delivered: afterDelivered,
      orderBookPresent: true,
      historicalOdaEvidence: history.hasOrderBookEvidence,
      historicalRecEvidence: history.preserveRec,
      allowRegression: false,
    });

    if (currentStatus === 'ODA' && nextStatus === 'ODA' && afterDelivered === beforeDelivered) jaOda += 1;
    if (afterDelivered > 0 && ordered > 0 && afterDelivered < ordered) parciais += 1;
    if (nextStatus === 'REC') entregues += 1;

    const ocRoots = [...new Set([...evidence.ocs].map(normalizeOcRoot).filter(Boolean))];
    const singleOc = ocRoots.length === 1 ? ocRoots[0] : null;
    const linkedOrder = singleOc ? orderByNumber.get(singleOc) : null;
    if (ocRoots.length > 1) ambiguos += 1;

    const payload = {};
    if (afterDelivered > beforeDelivered) {
      payload.qtd_recebida = afterDelivered;
      quantidadesAtualizadas += 1;
    }
    if (nextStatus !== currentStatus) {
      payload.status = nextStatus;
      payload.status_grupo = nextStatus;
    }
    if (singleOc && !pd.numero_oc) payload.numero_oc = singleOc;
    if (singleOc && !pd.numero_oc_original) payload.numero_oc_original = [...evidence.ocs][0] || singleOc;
    if (linkedOrder?.id && !pd.ordem_id) payload.ordem_id = linkedOrder.id;
    if (nextStatus === 'REC' && !pd.data_entrega && evidence.latest_snapshot_date) payload.data_entrega = evidence.latest_snapshot_date;

    const shouldRecordEvidence = !history.hasOrderBookEvidence || orderBookDelivered > history.maxOrderBookDelivered;
    if (Object.keys(payload).length) {
      payload.updated_at = now;
      // Metadados extras são compatíveis com bases que já receberam o lifecycle;
      // em schema antigo, cai para o payload essencial sem bloquear o import.
      const enriched = {
        ...payload,
        reconciliado_order_book: true,
        reconciliado_em: now,
        status_anterior_reconciliacao: currentStatus || null,
        origem_importacao: pd.origem_importacao || 'ORDER_BOOK_RECONCILIADO',
      };
      let update = await supabase.from('compras_pds').update(enriched).eq('id', pd.id);
      if (update.error && update.error.code === '42703') {
        update = await supabase.from('compras_pds').update(payload).eq('id', pd.id);
      }
      if (update.error) throw update.error;
      reconciliados += 1;
    } else if (!['', 'ELB', 'TRI', 'ANS', 'COT', 'PRO', 'LPC', 'LIB', 'LIBERADA', 'LIBERADO', 'ODC', 'ODA', 'ATIVO', 'REC'].includes(currentStatus)) {
      ignoradosStatusAvancado += 1;
    }

    if (Object.keys(payload).length || shouldRecordEvidence) {
      events.push({
        pd_id: pd.id,
        tipo_evento: 'ORDER_BOOK_ATUALIZOU_CICLO_PD',
        status_anterior: currentStatus || null,
        status_novo: nextStatus || currentStatus || null,
        numero_oc: singleOc || pd.numero_oc || null,
        origem: 'ORDER_BOOK',
        detalhe: {
          numero_pd: pd.numero_pd,
          pns_order_book: [...evidence.pns],
          qtd_comprada_order_book: evidence.qtd_comprada,
          qtd_aguardando_coleta_order_book: evidence.qtd_aguardando_coleta,
          qtd_em_rota_order_book: evidence.qtd_em_rota,
          qtd_entregue_order_book: orderBookDelivered,
          qtd_pendente_order_book: evidence.qtd_pendente,
          qtd_recebida_canonica_antes: beforeDelivered,
          qtd_recebida_canonica_depois: afterDelivered,
          entrega_parcial: afterDelivered > 0 && ordered > 0 && afterDelivered < ordered,
          entrega_total: ordered > 0 && afterDelivered >= ordered,
          snapshot_date: evidence.latest_snapshot_date,
          regra: 'IN_DELIVERY_NAO_E_ENTREGA; DELIVERED_E_EVIDENCIA_CUMULATIVA; AUSENCIA_POSTERIOR_NAO_REGRIDE',
        },
        created_by_email: actor?.email || actor?.sub || null,
      });
    }
  }

  // Quantos PDs locais simplesmente não constam deste snapshot não é erro: snapshot
  // mais novo nunca apaga a trilha. O contador só informa que não houve evidência nova.
  for (const pd of pds || []) {
    const key = normalizeComparable(pd.numero_pd);
    if (key && !evidenceByPd.has(key)) naoEncontrados += 1;
  }

  await tryInsertEvents(events);
  const presence = listOrderBookPdGaps(spares, pds || []);
  return {
    analisados: (pds || []).length,
    reconciliados,
    jaOda,
    ignoradosStatusAvancado,
    ambiguos,
    naoEncontrados,
    quantidades_atualizadas: quantidadesAtualizadas,
    entrega_parcial_order_book: parciais,
    entregues_order_book: entregues,
    pds_sem_origem: presence.gaps,
    divergencias_pn: presence.pnDivergences,
  };
}

async function reconcileExistingPdLifecycle(actor = null) {
  const [{ data: pds, error: pdsError }, { data: spares, error: sparesError }, { data: receipts, error: receiptsError }] = await Promise.all([
    supabase.from('compras_pds').select('*').neq('ativo', false).limit(20000),
    supabase.from('leonardo_spares').select('id,documento_referencia,oc_referencia,pn,status_categoria,qtd_pendente,qtd_aguardando_coleta,qtd_em_rota,qtd_entregue,raw_payload').limit(20000),
    supabase.from('recebimentos').select('id,numero_recibo,documento_referencia,data_recebimento,ativo').neq('ativo', false).limit(20000),
  ]);
  if (pdsError) throw pdsError;
  if (sparesError) throw sparesError;
  if (receiptsError) throw receiptsError;

  const receiptById = new Map((receipts || []).map((row) => [row.id, row]));
  const receiptIds = [...receiptById.keys()];
  const receiptItems = [];
  for (let i = 0; i < receiptIds.length; i += 500) {
    const chunk = receiptIds.slice(i, i + 500);
    if (!chunk.length) continue;
    const { data, error } = await supabase
      .from('recebimento_itens')
      .select('id,recebimento_id,documento_referencia,quantidade,condicao_item,ativo')
      .in('recebimento_id', chunk)
      .neq('ativo', false)
      .limit(20000);
    if (error) throw error;
    receiptItems.push(...(data || []));
  }

  const pdsByKey = new Map();
  for (const pd of pds || []) {
    const key = normalizeComparable(pd.numero_pd);
    if (key) pdsByKey.set(key, pd);
  }

  const orderBookEvidence = buildOrderBookPdEvidence(spares || []);
  const historical = await loadPdHistoricalEvidence((pds || []).map((pd) => pd.id));
  const deliveredByPd = new Map();
  const receiptIdsByPd = new Map();
  const latestReceiptDateByPd = new Map();
  const receiptsWithoutCanonicalPd = new Map();

  for (const item of receiptItems) {
    const receipt = receiptById.get(item.recebimento_id);
    if (!receipt) continue;
    const reference = normalizeUpper(item.documento_referencia || receipt.documento_referencia);
    const key = normalizeComparable(reference);
    if (!key || !key.startsWith('PD')) continue;
    if (normalizeUpper(item.condicao_item) === 'FALTANTE') continue;
    const qty = Math.max(0, normalizeNumber(item.quantidade));
    if (!qty) continue;

    if (!pdsByKey.has(key)) {
      if (!receiptsWithoutCanonicalPd.has(key)) receiptsWithoutCanonicalPd.set(key, { numero_pd: reference, recibos: new Set() });
      receiptsWithoutCanonicalPd.get(key).recibos.add(receipt.numero_recibo);
      continue;
    }

    deliveredByPd.set(key, (deliveredByPd.get(key) || 0) + qty);
    if (!receiptIdsByPd.has(key)) receiptIdsByPd.set(key, new Set());
    receiptIdsByPd.get(key).add(receipt.id);
    const currentDate = latestReceiptDateByPd.get(key);
    const candidateDate = receipt.data_recebimento || null;
    if (candidateDate && (!currentDate || String(candidateDate) > String(currentDate))) latestReceiptDateByPd.set(key, candidateDate);
  }

  const events = [];
  let alterados = 0;
  let promovidosOda = 0;
  let entregues = 0;
  let parciais = 0;
  let semMudanca = 0;
  let regressoesBloqueadas = 0;
  const now = new Date().toISOString();

  for (const pd of pds || []) {
    const key = normalizeComparable(pd.numero_pd);
    if (!key) continue;
    const ob = orderBookEvidence.get(key);
    const history = historical.get(pd.id) || emptyHistoricalEvidence();
    const ordered = positiveNumber(pd.qtd_comprada, pd.quantidade, pd.qtd_pedida, ob?.qtd_comprada);
    const currentDelivered = Math.max(0, normalizeNumber(pd.qtd_recebida));
    const receiptDelivered = Math.max(0, deliveredByPd.get(key) || 0);
    const currentOrderBookDelivered = Math.max(0, normalizeNumber(ob?.qtd_entregue));
    const effectiveDelivered = Math.max(
      currentDelivered,
      receiptDelivered,
      currentOrderBookDelivered,
      history.maxOrderBookDelivered,
      history.recDeliveredFloor,
    );
    const previousStatus = normalizeUpper(pd.status_grupo || pd.status || '');
    const orderBookEverPresent = Boolean(ob || history.hasOrderBookEvidence);
    const nextStatus = resolvePdLifecycleStatus({
      currentStatus: previousStatus,
      ordered,
      delivered: effectiveDelivered,
      orderBookPresent: Boolean(ob),
      historicalOdaEvidence: orderBookEverPresent,
      historicalRecEvidence: history.preserveRec,
      allowRegression: false,
    });

    if (previousStatus === 'REC' && nextStatus === 'REC' && effectiveDelivered < ordered) regressoesBloqueadas += 1;
    if (effectiveDelivered > 0 && ordered > 0 && effectiveDelivered < ordered) parciais += 1;
    if (nextStatus === 'REC') entregues += 1;
    if (nextStatus === 'ODA' && previousStatus !== 'ODA') promovidosOda += 1;

    const payload = {};
    if (effectiveDelivered > currentDelivered) payload.qtd_recebida = effectiveDelivered;
    if (nextStatus !== previousStatus) {
      payload.status = nextStatus;
      payload.status_grupo = nextStatus;
    }
    const bestDeliveryDate = latestReceiptDateByPd.get(key) || ob?.latest_snapshot_date || null;
    if (nextStatus === 'REC' && bestDeliveryDate && !pd.data_entrega) payload.data_entrega = bestDeliveryDate;

    if (!Object.keys(payload).length) {
      semMudanca += 1;
      continue;
    }

    payload.updated_at = now;
    const { error: updateError } = await supabase.from('compras_pds').update(payload).eq('id', pd.id);
    if (updateError) throw updateError;
    alterados += 1;
    events.push({
      pd_id: pd.id,
      tipo_evento: 'RECONCILIACAO_RETROATIVA_PD',
      status_anterior: previousStatus || null,
      status_novo: nextStatus || previousStatus || null,
      numero_oc: pd.numero_oc || null,
      origem: 'SISHA_RECONCILIACAO',
      detalhe: {
        numero_pd: pd.numero_pd,
        qtd_recebida_anterior: currentDelivered,
        qtd_recebida_recalculada: effectiveDelivered,
        qtd_por_recibos_ativos: receiptDelivered,
        qtd_entregue_order_book_snapshot: currentOrderBookDelivered,
        qtd_entregue_order_book_historica: history.maxOrderBookDelivered,
        qtd_pedida_comprada: ordered,
        qtd_faltante: ordered > 0 ? Math.max(0, ordered - effectiveDelivered) : 0,
        order_book_presente: Boolean(ob),
        order_book_ja_comprovado_historicamente: history.hasOrderBookEvidence,
        recibos_ativos_considerados: [...(receiptIdsByPd.get(key) || [])],
        regra: 'RECONCILIACAO_NORMAL_NAO_REGRIDE_EVIDENCIA_POSITIVA',
      },
      created_by_email: actor?.email || actor?.sub || null,
    });
  }

  await tryInsertEvents(events);
  return {
    analisados: (pds || []).length,
    alterados,
    sem_mudanca: semMudanca,
    promovidos_oda: promovidosOda,
    entrega_parcial: parciais,
    entregues,
    regressoes_bloqueadas_por_historico: regressoesBloqueadas,
    regredidos_por_correcao: 0,
    recibos_sem_pd_origem: [...receiptsWithoutCanonicalPd.values()].map((entry) => ({ ...entry, recibos: [...entry.recibos] })),
  };
}

module.exports = {
  buildOrderBookIndex,
  findOrderBookMatch,
  buildOrderBookPdEvidence,
  listOrderBookPdGaps,
  resolvePdLifecycleStatus,
  loadPdHistoricalEvidence,
  reconcileOrderBookPds,
  reconcileExistingPdLifecycle,
};
