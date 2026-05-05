const XLSX = require('xlsx');
const supabase = require('../config/supabaseClient');
const { registrarAuditoria } = require('../utils/auditLogger');

const OC_STATUSES = new Set(['ELB', 'ODC', 'ODA', 'ODA_RESSALVA', 'REC', 'CAN', 'ADP']);
const PD_STATUSES = new Set(['ELB', 'TRI', 'ANS', 'COT', 'PRO', 'LPC', 'ODC', 'ODA', 'EMB', 'REC', 'FAT', 'CAN', 'ATIVO', 'EXCLUIDO']);
const WO_STATUSES = new Set([
  'ELB', 'TRI', 'ANS', 'COT', 'PRO', 'LPC', 'ODC', 'ODA', 'EMB', 'REC', 'FAT', 'CAN',
  'AGUARDANDO_VERBA', 'WO_ABERTA', 'ENVIADO', 'EM_REPARO', 'AGUARDANDO_ORCAMENTO',
  'AGUARDANDO_APROVACAO', 'REPARADO', 'IRREPARAVEL', 'REGRESSANDO', 'RECEBIDO', 'CANCELADO',
]);
const WO_RESULTADOS = new Set(['PENDENTE', 'REPARADO', 'IRREPARAVEL', 'DEVOLVIDO_SEM_REPARO', 'CANCELADO', 'NAO_INFORMADO']);
const WO_TIPOS = new Set(['GARANTIA', 'OVERHAUL', 'REPARO', 'INSPECAO', 'FABRICANTE', 'OUTRO', 'PENDENTE']);

function normalizeUpper(value = '') {
  return String(value || '').trim().toUpperCase();
}

function normalizeComparable(value = '') {
  return normalizeUpper(value).replace(/[^A-Z0-9]/g, '');
}

function normalizeOcRaiz(value = '') {
  const oc = normalizeUpper(value);
  if (!oc) return '';
  return oc.split('/')[0].trim();
}

function isEmptyValue(value) {
  return value == null || String(value).trim() === '';
}

function toNumber(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const raw = String(value ?? '').trim();
  if (!raw) return 0;
  const cleaned = raw.replace(/[^0-9,.-]/g, '');
  if (!cleaned || cleaned === '-' || cleaned === ',' || cleaned === '.') return 0;
  let normalized = cleaned;
  if (cleaned.includes(',') && cleaned.includes('.')) {
    normalized = cleaned.replace(/\./g, '').replace(',', '.');
  } else if (cleaned.includes(',')) {
    normalized = cleaned.replace(',', '.');
  }
  const n = Number(normalized);
  return Number.isFinite(n) ? n : 0;
}

function parseDate(value) {
  if (value == null || value === '') return null;
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString().slice(0, 10);
  if (typeof value === 'number') {
    const parsed = XLSX.SSF.parse_date_code(value);
    if (parsed) {
      const m = String(parsed.m).padStart(2, '0');
      const d = String(parsed.d).padStart(2, '0');
      return `${parsed.y}-${m}-${d}`;
    }
  }
  const text = String(value).trim();
  if (!text || /^sem\s/i.test(text)) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;
  const br = text.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (br) {
    const [, d, m, y] = br;
    return `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
  }
  const dt = new Date(text);
  return Number.isNaN(dt.getTime()) ? null : dt.toISOString().slice(0, 10);
}

function requireAdmin(req, res) {
  if (!['admin', 'dono'].includes(req.user?.role)) {
    res.status(403).json({ status: 'error', message: 'Apenas ADMIN ou DONO pode alterar, excluir, inserir ou importar dados de compras/reparos.' });
    return false;
  }
  return true;
}

async function auditCompra(req, action, entity, entityId, summary, details = {}, visibility = 'PUBLIC') {
  await registrarAuditoria({
    req,
    action,
    entity,
    entityId,
    summary,
    details,
    level: 'INFO',
    visibility,
  });
}

function matchesQuery(value, query) {
  if (!query) return true;
  const raw = normalizeUpper(value);
  const compact = normalizeComparable(value);
  const qRaw = normalizeUpper(query);
  const qCompact = normalizeComparable(query);
  return raw.includes(qRaw) || (qCompact && compact.includes(qCompact));
}

function readRowsFromUpload(file) {
  if (!file?.buffer) throw new Error('Arquivo não enviado.');
  const wb = XLSX.read(file.buffer, { type: 'buffer', raw: false, cellDates: false });
  const sheetName = wb.SheetNames[0];
  const ws = wb.Sheets[sheetName];
  return XLSX.utils.sheet_to_json(ws, { defval: '', raw: false });
}

function get(row, ...keys) {
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(row, key)) return row[key];
  }
  return '';
}

function cleanText(value = '') {
  const text = String(value || '').trim();
  return text || null;
}

function isMeaningfulText(value = '') {
  const text = String(value || '').trim();
  if (!text) return false;
  return !['N/A', 'NA', '-', 'NULL', 'UNDEFINED', 'SEM NOMENCLATURA'].includes(text.toUpperCase());
}

function chooseNameFromRow(row = {}) {
  const direct = cleanText(row.nomenclatura);
  const tech = cleanText(row.techname);
  if (isMeaningfulText(direct)) return direct;
  if (isMeaningfulText(tech)) return tech;
  return null;
}

async function buscarNomenclaturasPorPns(pns = []) {
  const unique = Array.from(new Set((pns || []).map(normalizeUpper).filter(Boolean)));
  const result = new Map();
  if (unique.length === 0) return result;

  const chunks = [];
  for (let i = 0; i < unique.length; i += 200) chunks.push(unique.slice(i, i + 200));

  for (const chunk of chunks) {
    const { data, error } = await supabase
      .from('dicionario_mestre')
      .select('pn,nomenclatura,techname')
      .in('pn', chunk);
    if (!error) {
      (data || []).forEach((row) => {
        const key = normalizeUpper(row.pn);
        if (!key || result.has(key)) return;
        const nome = chooseNameFromRow(row);
        if (nome) result.set(key, { nomenclatura: nome, fonte: 'DICIONARIO_MESTRE' });
      });
    }
  }

  const missing = unique.filter((pn) => !result.has(pn));
  for (let i = 0; i < missing.length; i += 200) {
    const chunk = missing.slice(i, i + 200);
    const { data, error } = await supabase
      .from('items')
      .select('pn,nomenclatura,techname')
      .in('pn', chunk);
    if (!error) {
      (data || []).forEach((row) => {
        const key = normalizeUpper(row.pn);
        if (!key || result.has(key)) return;
        const nome = chooseNameFromRow(row);
        if (nome) result.set(key, { nomenclatura: nome, fonte: 'ITEMS' });
      });
    }
  }

  return result;
}

function mapOcStatus(statusOriginal = '', apareceOrderBook = false) {
  const st = normalizeUpper(statusOriginal).normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  if (st.includes('CANCEL')) return { status: 'CAN', motivo: 'OC cancelada no export da Marinha.' };
  if (st.includes('ADENDO')) return { status: 'ADP', motivo: 'OC com adendo/documento pendente.' };
  if (st.includes('RECEB')) return { status: 'REC', motivo: null };
  if (st.includes('APROV')) {
    if (apareceOrderBook) return { status: 'ODA', motivo: null };
    return { status: 'ODA_RESSALVA', motivo: 'OC aprovada no sistema MB, ainda não confirmada no Order Book Leonardo.' };
  }
  if (st.includes('GERADA')) return { status: 'ODC', motivo: null };
  return { status: 'ELB', motivo: null };
}

function mapProcessStatus(statusOriginal = '') {
  const st = normalizeUpper(statusOriginal);
  if (!st) return 'ELB';
  if (st === 'PRO') return 'COT';
  return st;
}

function isCancelledStatus(status = '', statusItem = '') {
  const a = normalizeUpper(status);
  const b = normalizeUpper(statusItem).normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  return a === 'CAN' || a.includes('CANCEL') || b.includes('CANCEL');
}

function suplementacaoMatches(sup, q) {
  return (
    matchesQuery(sup.msg_referencia, q) ||
    matchesQuery(sup.observacao, q) ||
    matchesQuery(sup.moeda, q) ||
    matchesQuery(sup.valor, q) ||
    matchesQuery(sup.data_msg, q)
  );
}

function pdMatches(pd, q, linkedPns = new Set()) {
  return (
    matchesQuery(pd.numero_pd, q) ||
    matchesQuery(pd.numero_oc, q) ||
    matchesQuery(pd.numero_oc_original, q) ||
    matchesQuery(pd.pn, q) ||
    matchesQuery(pd.nsn, q) ||
    matchesQuery(pd.nomenclatura, q) ||
    matchesQuery(pd.status, q) ||
    matchesQuery(pd.status_grupo, q) ||
    matchesQuery(pd.status_item, q) ||
    matchesQuery(pd.codemp, q) ||
    matchesQuery(pd.fabricante, q) ||
    matchesQuery(pd.responsavel, q) ||
    linkedPns.has(normalizeUpper(pd.pn))
  );
}

function ordemMatches(ordem, q, linkedPns = new Set()) {
  if (!q && linkedPns.size === 0) return true;
  if (
    matchesQuery(ordem.numero_oc, q) ||
    matchesQuery(ordem.numero_oc_original, q) ||
    matchesQuery(ordem.status, q) ||
    matchesQuery(ordem.status_mb_original, q) ||
    matchesQuery(ordem.substatus, q) ||
    matchesQuery(ordem.moeda, q) ||
    matchesQuery(ordem.sigla_moeda, q) ||
    matchesQuery(ordem.codemp, q) ||
    matchesQuery(ordem.razao_social, q) ||
    matchesQuery(ordem.processo_obtencao, q) ||
    matchesQuery(ordem.responsavel, q) ||
    matchesQuery(ordem.observacao, q) ||
    matchesQuery(ordem.motivo_cancelamento, q) ||
    matchesQuery(ordem.motivo_ressalva, q)
  ) return true;

  if ((ordem.compras_pds || []).some((pd) => pdMatches(pd, q, linkedPns))) return true;
  if ((ordem.compras_suplementacoes || []).some((sup) => suplementacaoMatches(sup, q))) return true;
  return false;
}

function woMatches(wo, q) {
  if (!q) return true;
  return (
    matchesQuery(wo.numero_wo, q) ||
    matchesQuery(wo.documento_referencia, q) ||
    matchesQuery(wo.pn, q) ||
    matchesQuery(wo.nomenclatura, q) ||
    matchesQuery(wo.fonte_nomenclatura, q) ||
    matchesQuery(wo.nsn, q) ||
    matchesQuery(wo.sn, q) ||
    matchesQuery(wo.serial_number_relatorio, q) ||
    matchesQuery(wo.empresa, q) ||
    matchesQuery(wo.codemp, q) ||
    matchesQuery(wo.origem, q) ||
    matchesQuery(wo.status, q) ||
    matchesQuery(wo.status_original, q) ||
    matchesQuery(wo.status_grupo, q) ||
    matchesQuery(wo.tipo, q) ||
    matchesQuery(wo.tipo_wo, q) ||
    matchesQuery(wo.resultado, q) ||
    matchesQuery(wo.resultado_tecnico, q) ||
    matchesQuery(wo.observacao, q) ||
    matchesQuery(wo.aeronave, q) ||
    matchesQuery(wo.pn_saida, q) ||
    matchesQuery(wo.responsavel, q) ||
    matchesQuery(wo.equipamento_codigo, q) ||
    matchesQuery(wo.modelo, q) ||
    (wo.work_order_suplementacoes || []).some((sup) => suplementacaoMatches(sup, q))
  );
}

function calcOrdemResumo(ordem = {}) {
  const pds = Array.isArray(ordem.compras_pds) ? ordem.compras_pds.filter((pd) => pd.ativo !== false) : [];
  const sups = Array.isArray(ordem.compras_suplementacoes) ? ordem.compras_suplementacoes.filter((s) => s.ativo !== false) : [];
  const totalPds = pds.reduce((acc, pd) => acc + (toNumber(pd.valor_total_gbp) || toNumber(pd.valor_total) || toNumber(pd.valor_total_usd)), 0);
  const valorTotal = toNumber(ordem.valor_total_gbp) || toNumber(ordem.valor_total) || totalPds;
  let valorSuplementado = sups.reduce((acc, sup) => acc + toNumber(sup.valor), 0);
  let saldoRestante = Math.max(0, valorTotal - valorSuplementado);
  let percentual = valorTotal > 0 ? Math.min(100, Math.round((valorSuplementado / valorTotal) * 100)) : 0;

  // Regra SISHA 10/10: se a OC já está confirmada no Order Book, ela deve aparecer
  // como aprovada/atendida financeiramente na visão de compras. O detalhe logístico
  // dos itens vem dos PDs automáticos do Order Book.
  const confirmadaOrderBook = ordem.order_book_pd_auto === true || normalizeUpper(ordem.fonte_confirmacao) === 'ORDER_BOOK' || ordem.order_book_ref === true;
  if (confirmadaOrderBook && normalizeUpper(ordem.status) === 'ODA' && valorTotal > 0) {
    valorSuplementado = valorTotal;
    saldoRestante = 0;
    percentual = 100;
  }

  const qtdeSe = toNumber(ordem.qtde_se_informada);
  const pdsAnexados = pds.length;
  const percentualPds = qtdeSe > 0 ? Math.min(100, Math.round((pdsAnexados / qtdeSe) * 100)) : (pdsAnexados > 0 ? 100 : 0);
  return {
    valor_total_calculado: valorTotal,
    valor_suplementado: valorSuplementado,
    saldo_restante: saldoRestante,
    percentual_suplementado: percentual,
    qtde_se_informada: qtdeSe,
    pds_anexados: pdsAnexados,
    percentual_pds_anexados: percentualPds,
  };
}

function calcWoResumo(wo = {}) {
  const sups = Array.isArray(wo.work_order_suplementacoes) ? wo.work_order_suplementacoes.filter((s) => s.ativo !== false) : [];
  const valorTotal = toNumber(wo.valor_total_usd) || toNumber(wo.valor_total);
  const valorSuplementado = sups.reduce((acc, sup) => acc + toNumber(sup.valor), 0);
  const saldoRestante = Math.max(0, valorTotal - valorSuplementado);
  const percentual = valorTotal > 0 ? Math.min(100, Math.round((valorSuplementado / valorTotal) * 100)) : 0;
  return {
    valor_total_calculado: valorTotal,
    valor_suplementado: valorSuplementado,
    saldo_restante: saldoRestante,
    percentual_suplementado: percentual,
  };
}

async function buscarPnsRelacionadosPorWoOuSn(q = '') {
  const linked = new Set();
  if (!q) return linked;
  const [manual, orderBook] = await Promise.all([
    supabase.from('work_orders').select('*').limit(5000),
    supabase.from('leonardo_repairs').select('pn,sn,descricao,tipo,documento_referencia,status,data_previsao').limit(5000),
  ]);
  if (!manual.error) (manual.data || []).forEach((wo) => { if (woMatches(wo, q)) linked.add(normalizeUpper(wo.pn)); });
  if (!orderBook.error) (orderBook.data || []).forEach((row) => {
    const woLike = { numero_wo: row.documento_referencia, documento_referencia: row.documento_referencia, pn: row.pn, sn: row.sn, empresa: 'Leonardo', origem: `ORDER_BOOK_${row.tipo || 'REPAIR'}`, status: row.status, tipo: row.tipo, resultado: row.status, observacao: row.descricao, aeronave: row.aeronave, pn_saida: row.pn_saida };
    if (woMatches(woLike, q)) linked.add(normalizeUpper(row.pn));
  });
  return linked;
}

function buildOrderBookOrdens(rows = []) {
  const grupos = new Map();
  (rows || []).forEach((row) => {
    const numeroOriginal = normalizeUpper(row.oc_referencia || row.numero_oc || '');
    const numeroOc = normalizeOcRaiz(numeroOriginal);
    if (!numeroOc || numeroOc === 'N/A' || numeroOc === '-') return;
    if (!grupos.has(numeroOc)) {
      grupos.set(numeroOc, { id: `orderbook-${numeroOc}`, source: 'ORDER_BOOK', fonte: 'ORDER_BOOK', numero_oc: numeroOc, numero_oc_original: numeroOriginal, status: 'ODA', moeda: 'GBP', valor_total: 0, valor_total_gbp: 0, observacao: 'OC/ODA importada automaticamente do Order Book Leonardo.', ativo: true, compras_pds: [], compras_suplementacoes: [], order_book_ref: true, read_only: true });
    }
    const grupo = grupos.get(numeroOc);
    const qtdPendente = toNumber(row.qtd_pendente);
    const qtdAguardandoColeta = toNumber(row.qtd_aguardando_coleta);
    const qtdEmRota = toNumber(row.qtd_em_rota);
    const qtdEntregue = toNumber(row.qtd_entregue);
    const quantidadeTotal = qtdPendente + qtdAguardandoColeta + qtdEmRota + qtdEntregue;
    const quantidade = quantidadeTotal > 0 ? quantidadeTotal : qtdPendente;
    const valorUnitario = toNumber(row.valor_unitario);
    const valorTotal = toNumber(row.valor_total) || (valorUnitario * quantidade);
    grupo.compras_pds.push({
      id: `orderbook-pd-${row.id || `${numeroOc}-${row.documento_referencia}-${row.pn}`}`,
      source: 'ORDER_BOOK',
      fonte: 'ORDER_BOOK',
      ordem_id: grupo.id,
      numero_oc: numeroOc,
      numero_oc_original: numeroOriginal,
      numero_pd: normalizeUpper(row.documento_referencia || 'N/A'),
      pn: normalizeUpper(row.pn || ''),
      nomenclatura: row.descricao || row.nomenclatura || null,
      quantidade,
      qtd_pedida: quantidade,
      qtd_comprada: quantidade,
      valor_unitario: valorUnitario,
      valor_unitario_gbp: valorUnitario,
      valor_total: valorTotal,
      valor_total_gbp: valorTotal,
      moeda: 'GBP',
      status: normalizeUpper(row.status_categoria || 'ODA'),
      status_grupo: 'ODA',
      ativo: true,
      qtd_pendente: qtdPendente,
      qtd_aguardando_coleta: qtdAguardandoColeta,
      qtd_em_rota: qtdEmRota,
      qtd_entregue: qtdEntregue,
      qtd_recebida: qtdEntregue,
      data_previsao_lh: row.data_previsao_lh || null,
      data_previsao_entrega: row.data_previsao_entrega || row.data_previsao_lh || null,
      status_categoria: row.status_categoria || null,
      origem_importacao: 'ORDER_BOOK_AUTO',
    });
  });
  return Array.from(grupos.values()).map((ordem) => {
    const valorTotal = ordem.compras_pds.reduce((acc, pd) => acc + toNumber(pd.valor_total_gbp || pd.valor_total), 0);
    return { ...ordem, valor_total: valorTotal, valor_total_gbp: valorTotal, resumo: { valor_total_calculado: valorTotal, valor_suplementado: valorTotal, saldo_restante: 0, percentual_suplementado: valorTotal > 0 ? 100 : 0, qtde_se_informada: ordem.compras_pds.length, pds_anexados: ordem.compras_pds.length, percentual_pds_anexados: 100 } };
  });
}

function mergeOrderBookPdsIntoOrdem(ordem = {}, orderBookOrdem = null) {
  if (!orderBookOrdem || !Array.isArray(orderBookOrdem.compras_pds) || orderBookOrdem.compras_pds.length === 0) {
    return { ...ordem, resumo: calcOrdemResumo(ordem) };
  }

  const pdsManuais = Array.isArray(ordem.compras_pds) ? ordem.compras_pds : [];
  const seen = new Set();
  pdsManuais.forEach((pd) => {
    const key = `${normalizeComparable(pd.numero_pd || pd.documento_referencia)}|${normalizeComparable(pd.pn)}`;
    if (key !== '|') seen.add(key);
  });

  const pdsOrderBook = orderBookOrdem.compras_pds
    .filter((pd) => {
      const key = `${normalizeComparable(pd.numero_pd || pd.documento_referencia)}|${normalizeComparable(pd.pn)}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .map((pd) => ({ ...pd, ordem_id: ordem.id, numero_oc: ordem.numero_oc, numero_oc_original: ordem.numero_oc_original || ordem.numero_oc }));

  const merged = {
    ...ordem,
    compras_pds: [...pdsManuais, ...pdsOrderBook],
    order_book_pd_auto: true,
    order_book_pds_count: pdsOrderBook.length,
    order_book_oc_original: orderBookOrdem.numero_oc_original,
    fonte_confirmacao: ordem.fonte_confirmacao || 'ORDER_BOOK',
  };
  return { ...merged, resumo: calcOrdemResumo(merged) };
}

async function listarOrdensOrderBook(q = '', linkedPns = new Set()) {
  const { data, error } = await supabase.from('leonardo_spares').select('id,pn,descricao,documento_referencia,oc_referencia,qtd_pendente,valor_unitario,valor_total,data_previsao_lh,status_categoria,qtd_aguardando_coleta,qtd_em_rota,qtd_entregue').limit(5000);
  if (error) {
    console.warn('[SISHA][compras] Order Book indisponível na consulta de OC:', error.message || error);
    return [];
  }
  let rows = data || [];
  if (q || linkedPns.size > 0) rows = rows.filter((row) => matchesQuery(row.oc_referencia, q) || matchesQuery(normalizeOcRaiz(row.oc_referencia), q) || matchesQuery(row.documento_referencia, q) || matchesQuery(row.pn, q) || matchesQuery(row.descricao, q) || matchesQuery(row.status_categoria, q) || linkedPns.has(normalizeUpper(row.pn)));
  return buildOrderBookOrdens(rows);
}

function buildOrderBookWorkOrders(rows = []) {
  return (rows || []).filter((row) => normalizeUpper(row.pn)).map((row) => {
    const tipo = normalizeUpper(row.tipo || 'REPAIR');
    const documento = normalizeUpper(row.documento_referencia || `ORDERBOOK-${tipo}-${row.sn || row.pn}`);
    const status = normalizeUpper(row.status || tipo || 'EM_REPARO');
    return { id: `orderbook-repair-${row.id || `${documento}-${row.pn}-${row.sn || 'SN'}`}`, source: 'ORDER_BOOK_REPAIR', fonte: 'ORDER_BOOK', order_book_ref: true, read_only: true, numero_wo: documento, documento_referencia: documento, pn: normalizeUpper(row.pn), sn: normalizeUpper(row.sn), sn_pendente: !normalizeUpper(row.sn), quantidade: 1, empresa: tipo === 'WARRANTY' ? 'Leonardo / Warranty' : 'Leonardo / Repair', origem: `ORDER_BOOK_${tipo}`, tipo, tipo_wo: tipo === 'WARRANTY' ? 'GARANTIA' : 'REPARO', status, status_original: row.status || null, resultado: null, resultado_tecnico: 'PENDENTE', valor_total: 0, valor_total_usd: 0, moeda: 'USD', data_previsao: row.data_previsao || null, data_previsao_entrega: row.data_previsao || null, data_retorno: null, nomenclatura: row.descricao || null, fonte_nomenclatura: row.descricao ? 'ORDER_BOOK' : 'PENDENTE', observacao: row.descricao || null, aeronave: row.aeronave || null, pn_saida: row.pn_saida || null, ativo: true, work_order_suplementacoes: [], resumo: calcWoResumo({ valor_total: 0, work_order_suplementacoes: [] }) };
  });
}

async function listarWorkOrdersOrderBook(q = '', status = '') {
  const { data, error } = await supabase.from('leonardo_repairs').select('id,pn,sn,descricao,tipo,documento_referencia,status,data_previsao').limit(5000);
  if (error) {
    console.warn('[SISHA][compras] Repairs/Warranty do Order Book indisponíveis na consulta de WO:', error.message || error);
    return [];
  }
  let wos = buildOrderBookWorkOrders(data || []);
  if (status) wos = wos.filter((wo) => matchesQuery(wo.status, status) || matchesQuery(wo.tipo, status) || matchesQuery(wo.origem, status));
  if (q) wos = wos.filter((wo) => woMatches(wo, q));
  return wos;
}

async function buildPdPipelineSummary() {
  const { data, error } = await supabase.from('compras_pds').select('status,status_grupo,ordem_id,ativo');
  if (error) return { elaboracao: 0, triagem_analise: 0, cotacao_lpc: 0, odc: 0, com_oc: 0, cancelados: 0, total: 0 };
  const summary = { elaboracao: 0, triagem_analise: 0, cotacao_lpc: 0, odc: 0, com_oc: 0, cancelados: 0, total: 0 };
  (data || []).forEach((pd) => {
    const st = normalizeUpper(pd.status_grupo || pd.status);
    summary.total += 1;
    if (pd.ativo === false || st === 'CAN') summary.cancelados += 1;
    else if (pd.ordem_id) summary.com_oc += 1;
    else if (st === 'ELB') summary.elaboracao += 1;
    else if (st === 'TRI' || st === 'ANS') summary.triagem_analise += 1;
    else if (st === 'COT' || st === 'PRO' || st === 'LPC') summary.cotacao_lpc += 1;
    else if (st === 'ODC') summary.odc += 1;
  });
  return summary;
}

exports.listarOrdens = async (req, res) => {
  try {
    const q = normalizeUpper(req.query.q || '');
    const status = normalizeUpper(req.query.status || '');
    const linkedPns = await buscarPnsRelacionadosPorWoOuSn(q);
    let query = supabase.from('compras_ordens').select('*, compras_pds(*), compras_suplementacoes(*)').eq('ativo', true).order('created_at', { ascending: false }).limit(5000);
    if (status) query = query.eq('status', status);
    const [{ data, error }, ordensOrderBook, pipelineSummary] = await Promise.all([
      query,
      status && status !== 'ODA' ? Promise.resolve([]) : listarOrdensOrderBook(q, linkedPns),
      buildPdPipelineSummary(),
    ]);
    if (error) throw error;
    const orderBookByOc = new Map((ordensOrderBook || []).map((ordem) => [normalizeOcRaiz(ordem.numero_oc), ordem]));
    let ordensManuais = (data || []).map((ordem) => {
      const orderBookDaOc = orderBookByOc.get(normalizeOcRaiz(ordem.numero_oc));
      const base = { ...ordem, source: 'SISHA', fonte: 'SISHA' };
      return mergeOrderBookPdsIntoOrdem(base, orderBookDaOc);
    });
    if (q || linkedPns.size > 0) ordensManuais = ordensManuais.filter((ordem) => ordemMatches(ordem, q, linkedPns));
    const ocManuais = new Set(ordensManuais.map((ordem) => normalizeOcRaiz(ordem.numero_oc)));
    const ordensBookSemDuplicar = (ordensOrderBook || []).filter((ordem) => !ocManuais.has(normalizeOcRaiz(ordem.numero_oc)));
    const ordens = [...ordensManuais, ...ordensBookSemDuplicar];
    return res.status(200).json({ status: 'success', data: ordens, meta: { sisha: ordensManuais.length, order_book: ordensBookSemDuplicar.length, linked_pns: Array.from(linkedPns), busca: q || null, pd_pipeline: pipelineSummary } });
  } catch (error) {
    console.error('[SISHA][compras] listarOrdens:', error);
    return res.status(500).json({ status: 'error', message: 'Falha ao consultar Ordens de Compra.' });
  }
};

exports.criarOrdem = async (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    const numeroOriginal = normalizeUpper(req.body.numero_oc);
    const numeroOc = normalizeOcRaiz(numeroOriginal);
    const status = normalizeUpper(req.body.status || 'ELB');
    if (!numeroOc) return res.status(400).json({ status: 'error', message: 'Número da OC é obrigatório.' });
    if (!OC_STATUSES.has(status)) return res.status(400).json({ status: 'error', message: 'Status inválido para OC.' });
    const pds = Array.isArray(req.body.pds) ? req.body.pds : [];
    if (pds.length > 20) return res.status(400).json({ status: 'error', message: 'Uma OC pode possuir no máximo 20 PD/SEPD.' });
    const { data: ordem, error } = await supabase.from('compras_ordens').upsert({ numero_oc: numeroOc, numero_oc_original: numeroOriginal || numeroOc, status, moeda: normalizeUpper(req.body.moeda || 'USD'), sigla_moeda: normalizeUpper(req.body.moeda || 'USD'), valor_total: toNumber(req.body.valor_total), observacao: req.body.observacao || null, ativo: status !== 'CAN', updated_at: new Date().toISOString() }, { onConflict: 'numero_oc' }).select('*').single();
    if (error) throw error;
    const pdsPayload = pds.filter((pd) => normalizeUpper(pd.numero_pd) && normalizeUpper(pd.pn)).slice(0, 20).map((pd) => {
      const quantidade = Math.max(1, toNumber(pd.quantidade) || 1);
      const valorUnitario = toNumber(pd.valor_unitario);
      const valorTotal = toNumber(pd.valor_total) || (valorUnitario * quantidade);
      return { ordem_id: ordem.id, numero_oc: numeroOc, numero_oc_original: numeroOriginal || numeroOc, numero_pd: normalizeUpper(pd.numero_pd), pn: normalizeUpper(pd.pn), nomenclatura: pd.nomenclatura || null, quantidade, qtd_pedida: quantidade, qtd_comprada: quantidade, valor_unitario: valorUnitario, valor_total: valorTotal, moeda: normalizeUpper(pd.moeda || req.body.moeda || 'USD'), status: status === 'CAN' ? 'CAN' : 'ATIVO', status_grupo: status === 'CAN' ? 'CAN' : 'ODC', ativo: status !== 'CAN', updated_at: new Date().toISOString() };
    });
    if (pdsPayload.length > 0) {
      const { error: pdError } = await supabase.from('compras_pds').upsert(pdsPayload, { onConflict: 'numero_pd' });
      if (pdError) throw pdError;
    }
    await auditCompra(req, 'OC_CRIADA_ATUALIZADA', 'OC', ordem.numero_oc, `OC ${ordem.numero_oc} cadastrada/atualizada.`, { status: ordem.status, valor_total: ordem.valor_total, pds: pdsPayload.length });
    return res.status(201).json({ status: 'success', message: 'OC cadastrada/atualizada com sucesso.', data: ordem });
  } catch (error) {
    console.error('[SISHA][compras] criarOrdem:', error);
    return res.status(500).json({ status: 'error', message: 'Falha ao cadastrar OC.' });
  }
};

exports.atualizarOrdem = async (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    const { id } = req.params;
    const status = req.body.status ? normalizeUpper(req.body.status) : null;
    if (String(id).startsWith('orderbook-')) return res.status(400).json({ status: 'error', message: 'OC importada do Order Book é somente leitura. Corrija pela importação/manutenção documental.' });
    if (status && !OC_STATUSES.has(status)) return res.status(400).json({ status: 'error', message: 'Status inválido para OC.' });
    const payload = { updated_at: new Date().toISOString() };
    if (status) payload.status = status;
    if (req.body.moeda !== undefined) { payload.moeda = normalizeUpper(req.body.moeda || 'USD'); payload.sigla_moeda = payload.moeda; }
    if (req.body.valor_total !== undefined) payload.valor_total = toNumber(req.body.valor_total);
    if (req.body.observacao !== undefined) payload.observacao = req.body.observacao || null;
    if (status === 'CAN') { payload.ativo = false; payload.cancelada_em = new Date().toISOString(); payload.cancelada_por = req.user?.email || req.user?.sub || null; payload.motivo_cancelamento = req.body.motivo_cancelamento || req.body.observacao || 'Cancelada pelo ADMIN.'; }
    const { data: ordem, error } = await supabase.from('compras_ordens').update(payload).eq('id', id).select('*').single();
    if (error) throw error;
    if (status === 'CAN') {
      const { error: pdError } = await supabase.from('compras_pds').update({ status: 'CAN', status_grupo: 'CAN', ativo: false, cancelado_em: new Date().toISOString(), motivo_cancelamento: payload.motivo_cancelamento, updated_at: new Date().toISOString() }).eq('ordem_id', id);
      if (pdError) throw pdError;
    }
    await auditCompra(req, status === 'CAN' ? 'OC_CANCELADA' : 'OC_EDITADA', 'OC', ordem.numero_oc, status === 'CAN' ? `OC ${ordem.numero_oc} cancelada.` : `OC ${ordem.numero_oc} editada.`, { status: ordem.status, valor_total: ordem.valor_total, observacao: ordem.observacao }, status === 'CAN' ? 'GOD' : 'PUBLIC');
    return res.status(200).json({ status: 'success', message: status === 'CAN' ? 'OC cancelada e PDs vinculados cancelados logicamente.' : 'OC atualizada com sucesso.', data: ordem });
  } catch (error) {
    console.error('[SISHA][compras] atualizarOrdem:', error);
    return res.status(500).json({ status: 'error', message: 'Falha ao atualizar OC.' });
  }
};

exports.excluirOrdem = async (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    const { id } = req.params;
    if (String(id).startsWith('orderbook-')) return res.status(400).json({ status: 'error', message: 'OC importada do Order Book é somente leitura. Corrija pela importação/manutenção documental.' });
    const motivo = req.body?.motivo || 'Exclusão administrativa.';
    const { error } = await supabase.from('compras_ordens').update({ ativo: false, excluida_em: new Date().toISOString(), excluida_por: req.user?.email || req.user?.sub || null, motivo_exclusao: motivo, updated_at: new Date().toISOString() }).eq('id', id);
    if (error) throw error;
    await supabase.from('compras_pds').update({ ativo: false, status: 'EXCLUIDO', status_grupo: 'CAN', updated_at: new Date().toISOString() }).eq('ordem_id', id);
    await auditCompra(req, 'OC_EXCLUIDA_LOGICAMENTE', 'OC', id, `OC ${id} excluída logicamente.`, { id }, 'GOD');
    return res.status(200).json({ status: 'success', message: 'OC excluída logicamente. Histórico preservado.' });
  } catch (error) {
    console.error('[SISHA][compras] excluirOrdem:', error);
    return res.status(500).json({ status: 'error', message: 'Falha ao excluir OC.' });
  }
};

exports.adicionarSuplementacaoOrdem = async (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    const { id } = req.params;
    if (String(id).startsWith('orderbook-')) return res.status(400).json({ status: 'error', message: 'OC importada do Order Book não recebe suplementação manual.' });
    const valor = toNumber(req.body.valor);
    if (valor <= 0) return res.status(400).json({ status: 'error', message: 'Valor de suplementação deve ser maior que zero.' });
    const { data: ordem, error: ordemError } = await supabase.from('compras_ordens').select('id, status').eq('id', id).single();
    if (ordemError) throw ordemError;
    if (ordem.status === 'CAN') return res.status(400).json({ status: 'error', message: 'OC cancelada não pode receber suplementação.' });
    const { data, error } = await supabase.from('compras_suplementacoes').insert({ ordem_id: id, valor, moeda: normalizeUpper(req.body.moeda || 'USD'), msg_referencia: req.body.msg_referencia || null, data_msg: req.body.data_msg || null, observacao: req.body.observacao || null, ativo: true }).select('*').single();
    if (error) throw error;
    await auditCompra(req, 'OC_SUPLEMENTADA', 'OC', id, `Suplementação registrada na OC ${id}.`, { valor, moeda: req.body.moeda || 'USD', msg_referencia: req.body.msg_referencia });
    return res.status(201).json({ status: 'success', message: 'Suplementação registrada na OC.', data });
  } catch (error) {
    console.error('[SISHA][compras] adicionarSuplementacaoOrdem:', error);
    return res.status(500).json({ status: 'error', message: 'Falha ao registrar suplementação da OC.' });
  }
};

exports.importarOrdens = async (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    const rows = readRowsFromUpload(req.file);
    const { data: orderBookRows } = await supabase.from('leonardo_spares').select('oc_referencia').limit(5000);
    const orderBookOcs = new Set((orderBookRows || []).map((r) => normalizeOcRaiz(r.oc_referencia)).filter(Boolean));
    const payload = [];
    const now = new Date().toISOString();
    rows.forEach((row) => {
      const original = normalizeUpper(get(row, 'Número OC'));
      const raiz = normalizeOcRaiz(original);
      if (!raiz) return;
      const statusOriginal = get(row, 'Status');
      const mapped = mapOcStatus(statusOriginal, orderBookOcs.has(raiz));
      payload.push({ numero_oc: raiz, numero_oc_original: original || raiz, status: mapped.status, status_mb_original: statusOriginal || null, substatus: get(row, 'SubStatus') || null, data_emissao: parseDate(get(row, 'Data Emissão')), data_aprovacao: parseDate(get(row, 'Data Aprovação')), data_recebimento: parseDate(get(row, 'Data Recebimento')), data_cancelamento: parseDate(get(row, 'Data Cancelamento')), data_ack: parseDate(get(row, 'Data Ack')), processo_obtencao: get(row, 'Processo de Obtenção') || null, codemp: normalizeUpper(get(row, 'CODEMP')) || null, razao_social: get(row, 'Razão Social(CODEMP)') || null, qtde_se_informada: toNumber(get(row, 'Qtde SE')), responsavel: get(row, 'Responsável') || null, sigla_moeda: normalizeUpper(get(row, 'Sigla Moeda')) || null, moeda: normalizeUpper(get(row, 'Sigla Moeda')) || 'GBP', valor_total: toNumber(get(row, 'Preço Total c/ CIO')), valor_total_gbp: toNumber(get(row, 'Preço Total c/ CIO')), valor_total_usd: toNumber(get(row, 'Preço Total USD c/ CIO')), valor_total_moeda_contrato: toNumber(get(row, 'Total c/ CIO Moeda Contrato')), fonte_importacao: 'EXPORT_OC_MB', fonte_confirmacao: orderBookOcs.has(raiz) ? 'ORDER_BOOK' : 'EXPORT_MB', motivo_ressalva: mapped.motivo, observacao: mapped.motivo || null, ativo: mapped.status !== 'CAN', data_importacao: now, updated_at: now });
    });
    if (payload.length === 0) return res.status(400).json({ status: 'error', message: 'Nenhuma OC válida encontrada no arquivo.' });
    const { error } = await supabase.from('compras_ordens').upsert(payload, { onConflict: 'numero_oc' });
    if (error) throw error;
    await auditCompra(req, 'OC_IMPORTADA_LOTE', 'OC', 'EXPORT_OC', `${payload.length} OC(s) importadas/atualizadas.`, { linhas_lidas: rows.length, importadas: payload.length });
    return res.status(200).json({ status: 'success', message: `${payload.length} OC(s) importadas/atualizadas.`, data: { linhas_lidas: rows.length, importadas: payload.length } });
  } catch (error) {
    console.error('[SISHA][compras] importarOrdens:', error);
    return res.status(500).json({ status: 'error', message: 'Falha ao importar relatório geral de OC.' });
  }
};

exports.importarPdsDaOrdem = async (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    const { id } = req.params;
    if (String(id).startsWith('orderbook-')) return res.status(400).json({ status: 'error', message: 'Anexe PDs a uma OC cadastrada no SISHA, não a um card sintético do Order Book.' });
    const { data: ordem, error: ordemError } = await supabase.from('compras_ordens').select('*').eq('id', id).single();
    if (ordemError) throw ordemError;
    const rows = readRowsFromUpload(req.file);
    const payload = [];
    const now = new Date().toISOString();
    rows.forEach((row) => {
      const numeroPd = normalizeUpper(get(row, 'SE'));
      const pn = normalizeUpper(get(row, 'PN'));
      if (!numeroPd || !pn) return;
      const status = normalizeUpper(get(row, 'Status SE') || 'ODC');
      const statusItem = get(row, 'Status Item');
      const cancelado = isCancelledStatus(status, statusItem);
      const qtdComprada = toNumber(get(row, 'Qtde Comprada')) || toNumber(get(row, 'Qtde Pedida')) || 1;
      const valorUnitario = toNumber(get(row, 'Preço Unitário'));
      const valorTotalGbp = toNumber(get(row, 'Preço Total')) || (valorUnitario * qtdComprada);
      payload.push({ ordem_id: ordem.id, numero_oc: ordem.numero_oc, numero_oc_original: ordem.numero_oc_original || ordem.numero_oc, numero_pd: numeroPd, pn, nsn: normalizeUpper(get(row, 'NSN')) || null, nomenclatura: get(row, 'Nomenclatura') || null, fabricante: normalizeUpper(get(row, 'Fabricante')) || null, uf_pedida: get(row, 'UF Pedida') || null, qtd_pedida: toNumber(get(row, 'Qtde Pedida')), uf_cotada: get(row, 'UF Cotada') || null, qtd_cotada: toNumber(get(row, 'Qtde Cotada')), qtd_comprada: qtdComprada, qtd_faturada: toNumber(get(row, 'Qtde Faturada')), qtd_recebida: toNumber(get(row, 'Qtde Recebida')), quantidade: qtdComprada, valor_unitario: valorUnitario, valor_unitario_gbp: valorUnitario, valor_total: valorTotalGbp, valor_total_gbp: valorTotalGbp, valor_total_usd: toNumber(get(row, 'Preço USD')), moeda: 'GBP', dias_entrega: toNumber(get(row, 'Dias de Entrega')), data_entrega: parseDate(get(row, 'Data de Entrega')), desconto_percentual: toNumber(get(row, 'Desc. (%)')), status, status_grupo: mapProcessStatus(status), status_item: statusItem || null, origem_importacao: 'EXPORT_PD_OC_MB', ativo: !cancelado && ordem.status !== 'CAN', cancelado_em: cancelado ? now : null, motivo_cancelamento: cancelado ? 'PD cancelado no export de PD da OC.' : null, updated_at: now });
    });
    if (payload.length === 0) return res.status(400).json({ status: 'error', message: 'Nenhum PD válido encontrado no arquivo.' });
    const { error } = await supabase.from('compras_pds').upsert(payload, { onConflict: 'numero_pd' });
    if (error) throw error;
    await auditCompra(req, 'PD_ANEXADO_OC', 'PD', ordem.numero_oc, `${payload.length} PD(s) anexados/atualizados na OC ${ordem.numero_oc}.`, { linhas_lidas: rows.length, importadas: payload.length, numero_oc: ordem.numero_oc });
    return res.status(200).json({ status: 'success', message: `${payload.length} PD(s) anexados/atualizados na OC ${ordem.numero_oc}.`, data: { linhas_lidas: rows.length, importadas: payload.length } });
  } catch (error) {
    console.error('[SISHA][compras] importarPdsDaOrdem:', error);
    return res.status(500).json({ status: 'error', message: 'Falha ao anexar PDs à OC.' });
  }
};

exports.importarPipelinePds = async (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    const rows = readRowsFromUpload(req.file);
    const payload = [];
    const now = new Date().toISOString();
    rows.forEach((row) => {
      const numeroPd = normalizeUpper(get(row, 'Número Completo'));
      const pn = normalizeUpper(get(row, 'PN'));
      if (!numeroPd || !pn) return;
      const statusOriginal = normalizeUpper(get(row, 'Status')) || 'ELB';
      const statusGrupo = mapProcessStatus(statusOriginal);
      const cancelado = isCancelledStatus(statusOriginal);
      const qtd = toNumber(get(row, 'Qtde')) || 1;
      const valorUnitUsd = toNumber(get(row, 'Preço Unit. (USD)'));
      payload.push({ numero_pd: numeroPd, pn, nsn: normalizeUpper(get(row, 'NSN')) || null, codemp: normalizeUpper(get(row, 'CODEMP')) || null, quantidade: qtd, qtd_pedida: qtd, uf_pedida: get(row, 'UF') || null, valor_unitario: valorUnitUsd, valor_total: toNumber(get(row, 'Total (USD)')) || valorUnitUsd * qtd, moeda: 'USD', valor_total_usd: toNumber(get(row, 'Total (USD)')) || valorUnitUsd * qtd, valor_contratado: toNumber(get(row, 'Valor Contratado')), status: statusOriginal, status_grupo: statusGrupo, data_status: parseDate(get(row, 'Data Status')), org_obt: get(row, 'Org. Obt') || null, ext: get(row, 'Ext') || null, sub: get(row, 'Sub') || null, critica: get(row, 'Crítica') || null, prioridade: get(row, 'Pri') || null, tl: get(row, 'T.L.') || null, co: get(row, 'C.O.') || null, sj: get(row, 'SJ') || null, lote_envio: get(row, 'Lote Envio') || null, omd: get(row, 'OMD') || null, omc: get(row, 'OMC') || null, cam: get(row, 'CAM') || null, equipamento_codigo: get(row, 'Equipamento') || null, modelo: get(row, 'Modelo') || null, serial_number_relatorio: get(row, 'Serial Number') || null, responsavel: get(row, 'Responsável') || null, data_previsao_entrega: parseDate(get(row, 'Dt.Prv. Entrega')), origem_importacao: 'EXPORT_PD_ODC_MB', ativo: !cancelado, cancelado_em: cancelado ? now : null, motivo_cancelamento: cancelado ? 'PD cancelado no pipeline ODC.' : null, updated_at: now });
    });
    if (payload.length === 0) return res.status(400).json({ status: 'error', message: 'Nenhum PD de pipeline válido encontrado no arquivo.' });
    const { error } = await supabase.from('compras_pds').upsert(payload, { onConflict: 'numero_pd' });
    if (error) throw error;
    await auditCompra(req, 'PD_PIPELINE_IMPORTADO', 'PD', 'PD_ODC', `${payload.length} PD(s) de pipeline importados/atualizados.`, { linhas_lidas: rows.length, importadas: payload.length });
    return res.status(200).json({ status: 'success', message: `${payload.length} PD(s) de pipeline importados/atualizados.`, data: { linhas_lidas: rows.length, importadas: payload.length } });
  } catch (error) {
    console.error('[SISHA][compras] importarPipelinePds:', error);
    return res.status(500).json({ status: 'error', message: 'Falha ao importar pipeline de PD/ODC.' });
  }
};

exports.listarWorkOrders = async (req, res) => {
  try {
    const q = normalizeUpper(req.query.q || '');
    const status = normalizeUpper(req.query.status || '');
    let query = supabase.from('work_orders').select('*, work_order_suplementacoes(*)').eq('ativo', true).order('created_at', { ascending: false }).limit(5000);
    if (status) query = query.eq('status', status);
    const [{ data, error }, wosOrderBook] = await Promise.all([query, listarWorkOrdersOrderBook(q, status)]);
    if (error) throw error;
    let wosManuais = (data || []).map((wo) => ({ ...wo, source: 'SISHA', fonte: 'SISHA', resumo: calcWoResumo(wo) }));
    if (q) wosManuais = wosManuais.filter((wo) => woMatches(wo, q));
    const chavesManuais = new Set(wosManuais.map((wo) => `${normalizeComparable(wo.numero_wo)}|${normalizeComparable(wo.pn)}|${normalizeComparable(wo.sn)}`));
    const wosBookSemDuplicar = (wosOrderBook || []).filter((wo) => !chavesManuais.has(`${normalizeComparable(wo.numero_wo)}|${normalizeComparable(wo.pn)}|${normalizeComparable(wo.sn)}`));
    const wos = [...wosManuais, ...wosBookSemDuplicar];
    return res.status(200).json({ status: 'success', data: wos, meta: { sisha: wosManuais.length, order_book_repairs: wosBookSemDuplicar.length, busca: q || null } });
  } catch (error) {
    console.error('[SISHA][compras] listarWorkOrders:', error);
    return res.status(500).json({ status: 'error', message: 'Falha ao consultar WO.' });
  }
};

exports.criarWorkOrder = async (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    const numeroWo = normalizeUpper(req.body.numero_wo);
    const pn = normalizeUpper(req.body.pn);
    const sn = normalizeUpper(req.body.sn);
    const status = normalizeUpper(req.body.status || 'ELB');
    if (!numeroWo || !pn) return res.status(400).json({ status: 'error', message: 'WO e PN são obrigatórios. SN pode ser informado depois.' });
    if (!WO_STATUSES.has(status)) return res.status(400).json({ status: 'error', message: 'Status inválido para WO.' });
    const resultadoTecnico = normalizeUpper(req.body.resultado_tecnico || req.body.resultado || 'PENDENTE');
    const tipoWo = normalizeUpper(req.body.tipo_wo || 'PENDENTE');
    const nomenclaturaManual = cleanText(req.body.nomenclatura);
    const nomenclaturaAuto = nomenclaturaManual ? null : (await buscarNomenclaturasPorPns([pn])).get(pn);
    const nomenclaturaFinal = nomenclaturaManual || nomenclaturaAuto?.nomenclatura || null;
    const fonteNomenclatura = nomenclaturaManual ? 'MANUAL' : (nomenclaturaAuto?.fonte || 'PENDENTE');
    const { data, error } = await supabase.from('work_orders').upsert({ numero_wo: numeroWo, pn, nomenclatura: nomenclaturaFinal, fonte_nomenclatura: fonteNomenclatura, nomenclatura_informada_manualmente: !!nomenclaturaManual, nomenclatura_atualizada_em: nomenclaturaManual ? new Date().toISOString() : null, nomenclatura_atualizada_por: nomenclaturaManual ? (req.user?.email || req.user?.sub || null) : null, sn: sn || null, sn_pendente: !sn, quantidade: 1, empresa: req.body.empresa || req.body.codemp || null, codemp: normalizeUpper(req.body.codemp || req.body.empresa) || null, origem: normalizeUpper(req.body.origem || 'MANUAL'), status, status_original: status, status_grupo: mapProcessStatus(status), tipo_wo: WO_TIPOS.has(tipoWo) ? tipoWo : 'OUTRO', resultado_tecnico: WO_RESULTADOS.has(resultadoTecnico) ? resultadoTecnico : 'PENDENTE', valor_total: toNumber(req.body.valor_total), valor_total_usd: toNumber(req.body.valor_total), moeda: normalizeUpper(req.body.moeda || 'USD'), data_abertura: req.body.data_abertura || null, data_envio: req.body.data_envio || null, data_previsao: req.body.data_previsao || null, data_previsao_entrega: req.body.data_previsao || null, data_retorno: req.body.data_retorno || null, observacao: req.body.observacao || null, ativo: status !== 'CAN' && status !== 'CANCELADO', updated_at: new Date().toISOString() }, { onConflict: 'numero_wo' }).select('*').single();
    if (error) throw error;
    await auditCompra(req, 'WO_CRIADA_ATUALIZADA', 'WO', data.numero_wo, `WO ${data.numero_wo} cadastrada/atualizada.`, { pn: data.pn, sn: data.sn, status: data.status });
    return res.status(201).json({ status: 'success', message: 'WO cadastrada/atualizada com sucesso.', data });
  } catch (error) {
    console.error('[SISHA][compras] criarWorkOrder:', error);
    return res.status(500).json({ status: 'error', message: 'Falha ao cadastrar WO.' });
  }
};

exports.atualizarWorkOrder = async (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    const { id } = req.params;
    if (String(id).startsWith('orderbook-repair-')) return res.status(400).json({ status: 'error', message: 'WO importada do Order Book é somente leitura. Cadastre WO manual para extra-Leonardo ou corrija pela importação.' });
    const status = req.body.status ? normalizeUpper(req.body.status) : null;
    if (status && !WO_STATUSES.has(status)) return res.status(400).json({ status: 'error', message: 'Status inválido para WO.' });
    const payload = { updated_at: new Date().toISOString() };
    ['empresa', 'data_abertura', 'data_envio', 'data_previsao', 'data_retorno', 'observacao', 'data_previsao_entrega', 'responsavel'].forEach((field) => { if (req.body[field] !== undefined) payload[field] = req.body[field] || null; });
    if (req.body.tipo_wo !== undefined) {
      const tipoWo = normalizeUpper(req.body.tipo_wo || 'PENDENTE');
      payload.tipo_wo = WO_TIPOS.has(tipoWo) ? tipoWo : 'OUTRO';
    }
    if (req.body.sn !== undefined) { payload.sn = normalizeUpper(req.body.sn) || null; payload.sn_pendente = !payload.sn; payload.sn_informado_manualmente = !!payload.sn; payload.sn_atualizado_em = new Date().toISOString(); payload.sn_atualizado_por = req.user?.email || req.user?.sub || null; }
    if (req.body.nomenclatura !== undefined) {
      const nomeManual = cleanText(req.body.nomenclatura);
      payload.nomenclatura = nomeManual;
      payload.fonte_nomenclatura = nomeManual ? 'MANUAL' : 'PENDENTE';
      payload.nomenclatura_informada_manualmente = !!nomeManual;
      payload.nomenclatura_atualizada_em = new Date().toISOString();
      payload.nomenclatura_atualizada_por = req.user?.email || req.user?.sub || null;
    }
    if (status) { payload.status = status; payload.status_grupo = mapProcessStatus(status); }
    if (req.body.origem !== undefined) payload.origem = normalizeUpper(req.body.origem || 'MANUAL');
    if (req.body.resultado_tecnico !== undefined || req.body.resultado !== undefined) {
      const resultado = normalizeUpper(req.body.resultado_tecnico || req.body.resultado || 'PENDENTE');
      payload.resultado_tecnico = WO_RESULTADOS.has(resultado) ? resultado : 'PENDENTE';
    }
    if (req.body.valor_total !== undefined) { payload.valor_total = toNumber(req.body.valor_total); payload.valor_total_usd = toNumber(req.body.valor_total); }
    if (req.body.moeda !== undefined) payload.moeda = normalizeUpper(req.body.moeda || 'USD');
    if (status === 'CAN' || status === 'CANCELADO') payload.ativo = false;
    const { data, error } = await supabase.from('work_orders').update(payload).eq('id', id).select('*').single();
    if (error) throw error;
    await auditCompra(req, 'WO_EDITADA', 'WO', data.numero_wo, `WO ${data.numero_wo} editada.`, { pn: data.pn, sn: data.sn, status: data.status, tipo_wo: data.tipo_wo, resultado_tecnico: data.resultado_tecnico });
    return res.status(200).json({ status: 'success', message: 'WO atualizada com sucesso.', data });
  } catch (error) {
    console.error('[SISHA][compras] atualizarWorkOrder:', error);
    return res.status(500).json({ status: 'error', message: 'Falha ao atualizar WO.' });
  }
};

exports.excluirWorkOrder = async (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    const { id } = req.params;
    if (String(id).startsWith('orderbook-repair-')) return res.status(400).json({ status: 'error', message: 'WO importada do Order Book é somente leitura.' });
    const { error } = await supabase.from('work_orders').update({ ativo: false, status: 'CAN', updated_at: new Date().toISOString() }).eq('id', id);
    if (error) throw error;
    await auditCompra(req, 'WO_EXCLUIDA_LOGICAMENTE', 'WO', id, `WO ${id} excluída logicamente.`, { id }, 'GOD');
    return res.status(200).json({ status: 'success', message: 'WO excluída logicamente. Histórico preservado.' });
  } catch (error) {
    console.error('[SISHA][compras] excluirWorkOrder:', error);
    return res.status(500).json({ status: 'error', message: 'Falha ao excluir WO.' });
  }
};

exports.adicionarSuplementacaoWorkOrder = async (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    const { id } = req.params;
    if (String(id).startsWith('orderbook-repair-')) return res.status(400).json({ status: 'error', message: 'WO importada do Order Book não recebe suplementação manual.' });
    const valor = toNumber(req.body.valor);
    if (valor <= 0) return res.status(400).json({ status: 'error', message: 'Valor de suplementação deve ser maior que zero.' });
    const { data, error } = await supabase.from('work_order_suplementacoes').insert({ work_order_id: id, valor, moeda: normalizeUpper(req.body.moeda || 'USD'), msg_referencia: req.body.msg_referencia || null, data_msg: req.body.data_msg || null, observacao: req.body.observacao || null, ativo: true }).select('*').single();
    if (error) throw error;
    await auditCompra(req, 'WO_SUPLEMENTADA', 'WO', id, `Suplementação registrada na WO ${id}.`, { valor, moeda: req.body.moeda || 'USD', msg_referencia: req.body.msg_referencia });
    return res.status(201).json({ status: 'success', message: 'Suplementação registrada na WO.', data });
  } catch (error) {
    console.error('[SISHA][compras] adicionarSuplementacaoWorkOrder:', error);
    return res.status(500).json({ status: 'error', message: 'Falha ao registrar suplementação da WO.' });
  }
};

exports.importarWorkOrders = async (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    const rows = readRowsFromUpload(req.file);
    const now = new Date().toISOString();
    const existing = await supabase.from('work_orders').select('numero_wo,sn,resultado_tecnico,tipo_wo,observacao,nomenclatura,fonte_nomenclatura,nomenclatura_informada_manualmente').limit(10000);
    const existingByWo = new Map((existing.data || []).map((wo) => [normalizeUpper(wo.numero_wo), wo]));
    const pnsDoArquivo = rows.map((row) => normalizeUpper(get(row, 'PN'))).filter(Boolean);
    const nomesPorPn = await buscarNomenclaturasPorPns(pnsDoArquivo);
    const payload = [];
    rows.forEach((row) => {
      const numeroWo = normalizeUpper(get(row, 'Número Completo'));
      const pn = normalizeUpper(get(row, 'PN'));
      if (!numeroWo || !pn) return;
      const current = existingByWo.get(numeroWo) || {};
      const snArquivo = normalizeUpper(get(row, 'Serial Number'));
      const snFinal = snArquivo || normalizeUpper(current.sn) || null;
      const statusOriginal = normalizeUpper(get(row, 'Status')) || 'ELB';
      const statusGrupo = mapProcessStatus(statusOriginal);
      const nomeAuto = nomesPorPn.get(pn);
      const nomeManualExistente = current.nomenclatura_informada_manualmente && isMeaningfulText(current.nomenclatura);
      const nomenclaturaFinal = nomeManualExistente ? current.nomenclatura : (nomeAuto?.nomenclatura || current.nomenclatura || null);
      const fonteNomenclatura = nomeManualExistente ? 'MANUAL' : (nomeAuto?.fonte || current.fonte_nomenclatura || (nomenclaturaFinal ? 'SISHA_EXISTENTE' : 'PENDENTE'));
      payload.push({ numero_wo: numeroWo, pn, nomenclatura: nomenclaturaFinal, fonte_nomenclatura: fonteNomenclatura, nomenclatura_informada_manualmente: !!nomeManualExistente, nsn: normalizeUpper(get(row, 'NSN')) || null, sn: snFinal, sn_pendente: !snFinal, serial_number_relatorio: snArquivo || null, quantidade: 1, empresa: normalizeUpper(get(row, 'CODEMP')) || null, codemp: normalizeUpper(get(row, 'CODEMP')) || null, origem: 'EXPORT_WO_MB', status: statusOriginal, status_original: statusOriginal, status_grupo: statusGrupo, data_status: parseDate(get(row, 'Data Status')), tipo_wo: current.tipo_wo || 'PENDENTE', observacao: current.observacao || null, resultado_tecnico: normalizeUpper(current.resultado_tecnico) || 'PENDENTE', valor_unitario_usd: toNumber(get(row, 'Preço Unit. (USD)')), valor_total: toNumber(get(row, 'Total (USD)')), valor_total_usd: toNumber(get(row, 'Total (USD)')), valor_contratado: toNumber(get(row, 'Valor Contratado')), moeda: 'USD', data_previsao: parseDate(get(row, 'Dt.Prv. Entrega')), data_previsao_entrega: parseDate(get(row, 'Dt.Prv. Entrega')), org_obt: get(row, 'Org. Obt') || null, ext: get(row, 'Ext') || null, sub: get(row, 'Sub') || null, critica: get(row, 'Crítica') || null, prioridade: get(row, 'Pri') || null, tl: get(row, 'T.L.') || null, co: get(row, 'C.O.') || null, sj: get(row, 'SJ') || null, lote_envio: get(row, 'Lote Envio') || null, omd: get(row, 'OMD') || null, omc: get(row, 'OMC') || null, cam: get(row, 'CAM') || null, equipamento_codigo: get(row, 'Equipamento') || null, modelo: get(row, 'Modelo') || null, responsavel: get(row, 'Responsável') || null, preco_contrato: toNumber(get(row, 'Preço Contrato')), ativo: statusOriginal !== 'CAN', updated_at: now });
    });
    if (payload.length === 0) return res.status(400).json({ status: 'error', message: 'Nenhuma WO válida encontrada no arquivo.' });
    const { error } = await supabase.from('work_orders').upsert(payload, { onConflict: 'numero_wo' });
    if (error) throw error;
    await auditCompra(req, 'WO_IMPORTADA_LOTE', 'WO', 'EXPORT_WO', `${payload.length} WO(s) importadas/atualizadas.`, { linhas_lidas: rows.length, importadas: payload.length });
    return res.status(200).json({ status: 'success', message: `${payload.length} WO(s) importadas/atualizadas. SN manual preservado quando o relatório vier vazio.`, data: { linhas_lidas: rows.length, importadas: payload.length } });
  } catch (error) {
    console.error('[SISHA][compras] importarWorkOrders:', error);
    return res.status(500).json({ status: 'error', message: 'Falha ao importar relatório de WO.' });
  }
};
