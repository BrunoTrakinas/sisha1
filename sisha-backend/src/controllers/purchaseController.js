const XLSX = require('xlsx');
const supabase = require('../config/supabaseClient');
const { registrarAuditoria } = require('../utils/auditLogger');
const workOrderEquipmentService = require('../services/workOrderEquipmentService');
const { listOrderBookPdGaps, reconcileExistingPdLifecycle } = require('../services/orderBookReconciliationService');

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

async function safeSyncWorkOrderLedger(wo, req) {
  try {
    return await workOrderEquipmentService.syncWorkOrderToEquipment(wo, {
      email: req.user?.email || req.user?.sub || null,
      role: req.user?.role || null,
    });
  } catch (error) {
    console.warn('[SISHA][WO][Livro] Falha não bloqueante ao sincronizar WO:', error.message || error);
    return { status: 'ERROR', message: error.message || 'Falha ao sincronizar WO com o Livro do Equipamento.' };
  }
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

const PURCHASE_HEADER_ALIASES = {
  NUMEROCOMPLETO: ['NUMERO', 'NUMEROPD', 'PD', 'SE', 'SEPD', 'NUMEROWO', 'WO', 'WORKORDER'],
  SE: ['PD', 'SEPD', 'NUMEROPD', 'NUMEROSE'],
  PN: ['PARTNUMBER', 'PARTNO', 'P/N', 'CODIGOPN'],
  NSN: ['NATIONALSTOCKNUMBER', 'NATO STOCK NUMBER'],
  NOMENCLATURA: ['DESCRICAO', 'DESCRICAODOITEM', 'ITEMDESCRIPTION', 'TECHNAME'],
  SERIALNUMBER: ['SN', 'S/N', 'SERIAL', 'NUMERODESERIE'],
  STATUSSE: ['STATUSPD', 'STATUSSEPD', 'STATUSDOPD'],
  STATUSITEM: ['STATUSDOITEM', 'SITUACAOITEM'],
  QTDECOMPRADA: ['QUANTIDADECOMPRADA', 'QTDCOMPRADA', 'QTYBOUGHT'],
  QTDEPEDIDA: ['QUANTIDADEPEDIDA', 'QTDPEDIDA', 'QTYREQUESTED'],
  QTDECOTADA: ['QUANTIDADECOTADA', 'QTDCOTADA'],
  QTDEFATURADA: ['QUANTIDADEFATURADA', 'QTDFATURADA'],
  QTDERECEBIDA: ['QUANTIDADERECEBIDA', 'QTDRECEBIDA'],
  PRECOUNITARIO: ['VALORUNITARIO', 'UNITPRICE', 'PRECOUNIT'],
  PRECOTOTAL: ['VALORTOTAL', 'TOTALGBP', 'TOTAL'],
  PRECOUSD: ['VALORUSD', 'TOTALUSD'],
  DATADEENTREGA: ['DTENTREGA', 'DELIVERYDATE'],
  DATAPREVISAOENTREGA: ['DTPRVENTREGA', 'PREVISAOENTREGA'],
  DATASTATUS: ['DTSTATUS', 'DATADESTATUS'],
  CODEMP: ['EMPRESA', 'CODIGOEMPRESA', 'FORNECEDOR'],
  RESPONSAVEL: ['RESP', 'ENCARREGADO'],
};

function normalizeHeader(value = '') {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');
}

function get(row, ...keys) {
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(row, key)) return row[key];
  }

  const entries = Object.entries(row || {}).map(([header, value]) => [normalizeHeader(header), value]);
  for (const key of keys) {
    const normalizedKey = normalizeHeader(key);
    const candidates = new Set([normalizedKey, ...(PURCHASE_HEADER_ALIASES[normalizedKey] || []).map(normalizeHeader)]);
    const found = entries.find(([header]) => candidates.has(header));
    if (found) return found[1];
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
  const sups = Array.isArray(ordem.compras_suplementacoes) ? ordem.compras_suplementacoes.filter((sup) => sup.ativo !== false) : [];
  const supsUsd = sups.filter((sup) => normalizeUpper(sup.moeda || 'USD') === 'USD');
  const supsLegadas = sups.filter((sup) => normalizeUpper(sup.moeda || 'USD') !== 'USD');

  const totalPdsUsd = pds.reduce((acc, pd) => acc + (toNumber(pd.valor_total_usd) || (normalizeUpper(pd.moeda) === 'USD' ? toNumber(pd.valor_total) : 0)), 0);
  const valorTotalUsd = toNumber(ordem.valor_total_usd) || (normalizeUpper(ordem.moeda) === 'USD' ? toNumber(ordem.valor_total) : 0) || totalPdsUsd;
  const valorTotalGbp = toNumber(ordem.valor_total_gbp) || (normalizeUpper(ordem.moeda) === 'GBP' ? toNumber(ordem.valor_total) : 0);
  let valorSuplementadoUsd = supsUsd.reduce((acc, sup) => acc + toNumber(sup.valor), 0);
  let saldoRestanteUsd = Math.max(0, valorTotalUsd - valorSuplementadoUsd);
  let percentual = valorTotalUsd > 0 ? Math.min(100, Math.round((valorSuplementadoUsd / valorTotalUsd) * 100)) : 0;

  // Order Book aprovado continua sendo uma confirmação financeira/logística já homologada.
  const confirmadaOrderBook = ordem.order_book_pd_auto === true || normalizeUpper(ordem.fonte_confirmacao) === 'ORDER_BOOK' || ordem.order_book_ref === true;
  if (confirmadaOrderBook && normalizeUpper(ordem.status) === 'ODA' && valorTotalUsd > 0) {
    valorSuplementadoUsd = valorTotalUsd;
    saldoRestanteUsd = 0;
    percentual = 100;
  }

  const qtdeSe = toNumber(ordem.qtde_se_informada);
  const pdsAnexados = pds.length;
  const percentualPds = qtdeSe > 0 ? Math.min(100, Math.round((pdsAnexados / qtdeSe) * 100)) : (pdsAnexados > 0 ? 100 : 0);
  return {
    valor_total_calculado: valorTotalUsd,
    valor_total_usd: valorTotalUsd,
    valor_total_gbp: valorTotalGbp,
    moeda_financeira: 'USD',
    valor_suplementado: valorSuplementadoUsd,
    saldo_restante: saldoRestanteUsd,
    percentual_suplementado: percentual,
    totalmente_suplementada: valorTotalUsd > 0 && saldoRestanteUsd <= 0.005,
    suplementacoes_legadas: supsLegadas.length,
    valor_suplementacoes_legadas: supsLegadas.reduce((acc, sup) => acc + toNumber(sup.valor), 0),
    qtde_se_informada: qtdeSe,
    pds_anexados: pdsAnexados,
    percentual_pds_anexados: percentualPds,
  };
}

function calcWoResumo(wo = {}) {
  const sups = Array.isArray(wo.work_order_suplementacoes) ? wo.work_order_suplementacoes.filter((sup) => sup.ativo !== false) : [];
  const supsUsd = sups.filter((sup) => normalizeUpper(sup.moeda || 'USD') === 'USD');
  const supsLegadas = sups.filter((sup) => normalizeUpper(sup.moeda || 'USD') !== 'USD');
  const valorTotalUsd = toNumber(wo.valor_total_usd) || toNumber(wo.valor_total);
  const valorSuplementadoUsd = supsUsd.reduce((acc, sup) => acc + toNumber(sup.valor), 0);
  const saldoRestanteUsd = Math.max(0, valorTotalUsd - valorSuplementadoUsd);
  const percentual = valorTotalUsd > 0 ? Math.min(100, Math.round((valorSuplementadoUsd / valorTotalUsd) * 100)) : 0;
  return {
    valor_total_calculado: valorTotalUsd,
    valor_total_usd: valorTotalUsd,
    moeda_financeira: 'USD',
    valor_suplementado: valorSuplementadoUsd,
    saldo_restante: saldoRestanteUsd,
    percentual_suplementado: percentual,
    totalmente_suplementada: valorTotalUsd > 0 && saldoRestanteUsd <= 0.005,
    suplementacoes_legadas: supsLegadas.length,
    valor_suplementacoes_legadas: supsLegadas.reduce((acc, sup) => acc + toNumber(sup.valor), 0),
  };
}

function excelSafe(value) {
  if (value === undefined || value === null) return '';
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'object') {
    try { return JSON.stringify(value); } catch { return String(value); }
  }
  return value;
}

function flattenForExcel(row = {}) {
  return Object.fromEntries(Object.entries(row || {}).map(([key, value]) => [key, excelSafe(value)]));
}

function appendJsonSheet(workbook, name, rows = []) {
  const safeName = String(name || 'Planilha').slice(0, 31);
  const safeRows = (rows || []).map(flattenForExcel);
  const sheet = safeRows.length > 0
    ? XLSX.utils.json_to_sheet(safeRows)
    : XLSX.utils.aoa_to_sheet([['Sem registros para esta seção.']]);
  XLSX.utils.book_append_sheet(workbook, sheet, safeName);
}

function sendExcelWorkbook(res, workbook, fileName) {
  const buffer = XLSX.write(workbook, { bookType: 'xlsx', type: 'buffer' });
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
  return res.status(200).send(buffer);
}

function exportFileName(prefix, identifier) {
  const clean = normalizeComparable(identifier || 'export') || 'export';
  return `${prefix}_${clean}.xlsx`;
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
    const valorTotalGbp = ordem.compras_pds.reduce((acc, pd) => acc + toNumber(pd.valor_total_gbp || pd.valor_total), 0);
    // O snapshot do Order Book não fornece, neste contrato, um valor USD confiável para esta OC sintética.
    // Preservamos a referência GBP e não a rotulamos/convertemos como USD.
    return {
      ...ordem,
      valor_total: valorTotalGbp,
      valor_total_gbp: valorTotalGbp,
      valor_total_usd: 0,
      resumo: {
        valor_total_calculado: 0,
        valor_total_usd: 0,
        valor_total_gbp: valorTotalGbp,
        moeda_financeira: 'USD',
        valor_suplementado: 0,
        saldo_restante: 0,
        percentual_suplementado: valorTotalGbp > 0 ? 100 : 0,
        totalmente_suplementada: false,
        suplementacoes_legadas: 0,
        valor_suplementacoes_legadas: 0,
        qtde_se_informada: ordem.compras_pds.length,
        pds_anexados: ordem.compras_pds.length,
        percentual_pds_anexados: 100,
      },
    };
  });
}

function mergeOrderBookPdsIntoOrdem(ordem = {}, orderBookOrdem = null) {
  if (!orderBookOrdem || !Array.isArray(orderBookOrdem.compras_pds) || orderBookOrdem.compras_pds.length === 0) {
    return { ...ordem, resumo: calcOrdemResumo(ordem) };
  }

  const pdsManuais = Array.isArray(ordem.compras_pds) ? ordem.compras_pds : [];
  const seen = new Set();
  pdsManuais.forEach((pd) => {
    const key = normalizeComparable(pd.numero_pd || pd.documento_referencia);
    if (key) seen.add(key);
  });

  const pdsOrderBook = orderBookOrdem.compras_pds
    .filter((pd) => {
      const key = normalizeComparable(pd.numero_pd || pd.documento_referencia);
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
  const { data, error } = await supabase.from('leonardo_spares').select('*').limit(10000);
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
    return { id: `orderbook-repair-${row.id || `${documento}-${row.pn}-${row.sn || 'SN'}`}`, source: 'ORDER_BOOK_REPAIR', fonte: 'ORDER_BOOK', order_book_ref: true, read_only: true, numero_wo: documento, documento_referencia: documento, pn: normalizeUpper(row.pn), sn: normalizeUpper(row.sn), sn_pendente: !normalizeUpper(row.sn), quantidade: 1, empresa: tipo === 'WARRANTY' ? 'Leonardo / Warranty' : 'Leonardo / Repair', origem: `ORDER_BOOK_${tipo}`, tipo, tipo_wo: tipo === 'WARRANTY' ? 'GARANTIA' : 'REPARO', status, status_original: row.status || null, resultado: null, resultado_tecnico: 'PENDENTE', valor_total: 0, valor_total_usd: 0, moeda: 'USD', data_previsao: row.data_previsao || row.forecast_date_lh || null, data_previsao_entrega: row.data_previsao || row.forecast_date_lh || null, data_retorno: null, nomenclatura: row.descricao || null, fonte_nomenclatura: row.descricao ? 'ORDER_BOOK' : 'PENDENTE', observacao: row.lh_updates || row.bn_comments || row.descricao || null, aeronave: row.aeronave || null, pn_saida: row.pn_saida || null, notification: row.notification || null, po_number: row.po_number || null, delivery_number: row.delivery_number || null, lh_updates: row.lh_updates || null, bn_comments: row.bn_comments || null, event_report_title: row.event_report_title || null, raw_payload: row.raw_payload || null, ativo: true, work_order_suplementacoes: [], resumo: calcWoResumo({ valor_total: 0, work_order_suplementacoes: [] }) };
  });
}

async function listarWorkOrdersOrderBook(q = '', status = '') {
  const { data, error } = await supabase.from('leonardo_repairs').select('*').limit(10000);
  if (error) {
    console.warn('[SISHA][compras] Repairs/Warranty do Order Book indisponíveis na consulta de WO:', error.message || error);
    return [];
  }
  let wos = buildOrderBookWorkOrders(data || []);
  if (status) wos = wos.filter((wo) => matchesQuery(wo.status, status) || matchesQuery(wo.tipo, status) || matchesQuery(wo.origem, status));
  if (q) wos = wos.filter((wo) => woMatches(wo, q));
  return wos;
}

function positivePdQty(...values) {
  for (const value of values) {
    const number = Number(value);
    if (Number.isFinite(number) && number > 0) return number;
  }
  return 0;
}

function classifyPdPipelineStage(pd = {}) {
  const st = normalizeUpper(pd.status_grupo || pd.status);
  const ordered = positivePdQty(pd.qtd_comprada, pd.quantidade, pd.qtd_pedida);
  const delivered = Math.max(0, Number(pd.qtd_recebida || 0) || 0);

  if (pd.ativo === false || st === 'CAN' || st === 'EXCLUIDO') return 'cancelados';

  // A entrega física é a evidência mais forte do estágio corrente do PD.
  if (st === 'REC' || (ordered > 0 && delivered >= ordered)) return 'entregue';
  if (delivered > 0) return 'entrega_parcial';

  // Estágios pré-ODC permanecem mutuamente exclusivos na visão geral.
  if (st === 'ELB') return 'elaboracao';
  if (st === 'TRI' || st === 'ANS') return 'triagem_analise';
  if (['COT', 'PRO', 'LPC', 'LIB', 'LIBERADA', 'LIBERADO', 'LIBERADA_PARA_COTACAO', 'LIBERADO_PARA_COTACAO'].includes(st)) return 'cotacao_lpc';

  // ODA representa aprovação/compromisso. FAT e EMB já avançaram além da ODA
  // e precisam de leitura própria para não esconder o estágio financeiro/logístico.
  if (st === 'FAT' || st === 'EMB') return 'fat_emb';
  if (st === 'ODA' || st === 'ODA_RESSALVA') return 'oda';

  // Um PD ainda sem vínculo de OC é uma condição operacional própria; não deve
  // ser somado também em ODC. Assim cada PD aparece em exatamente um card.
  if (!pd.ordem_id) return 'sem_oc';

  // ODC/ATIVO e estados legados ativos vinculados ficam no estágio ODC.
  return 'odc';
}

async function buildPdPipelineSummary() {
  const empty = {
    elaboracao: 0,
    triagem_analise: 0,
    cotacao_lpc: 0,
    sem_oc: 0,
    odc: 0,
    oda: 0,
    fat_emb: 0,
    entrega_parcial: 0,
    entregue: 0,
    cancelados: 0,
    ativos: 0,
    total: 0,
  };
  const { data, error } = await supabase
    .from('compras_pds')
    .select('status,status_grupo,ordem_id,ativo,quantidade,qtd_pedida,qtd_comprada,qtd_recebida');
  if (error) return empty;

  const summary = { ...empty };
  (data || []).forEach((pd) => {
    const bucket = classifyPdPipelineStage(pd);
    summary.total += 1;
    if (bucket !== 'cancelados') summary.ativos += 1;
    summary[bucket] += 1;
  });
  return summary;
}


async function registrarEventoPd(pdId, req, tipoEvento, statusAnterior, statusNovo, detalhe = {}) {
  const payload = {
    pd_id: pdId,
    tipo_evento: tipoEvento,
    status_anterior: statusAnterior || null,
    status_novo: statusNovo || null,
    numero_oc: detalhe.numero_oc || null,
    origem: detalhe.origem || 'SISHA',
    detalhe,
    created_by_email: req.user?.email || req.user?.sub || null,
  };
  const { error } = await supabase.from('compras_pd_eventos').insert(payload);
  if (error && !['42P01', 'PGRST205'].includes(error.code)) throw error;
}


exports.reconciliarCicloPdsExistentes = async (req, res) => {
  try {
    const confirmation = normalizeUpper(req.body?.confirmation);
    if (confirmation !== 'RECONCILIAR PDS EXISTENTES') {
      return res.status(400).json({ status: 'error', message: 'Confirmação inválida. Nenhum PD foi alterado.' });
    }
    const result = await reconcileExistingPdLifecycle({
      email: req.user?.email || req.user?.sub || null,
      role: req.user?.role || null,
    });
    await auditCompra(
      req,
      'PD_RECONCILIACAO_RETROATIVA',
      'PD',
      'PD_RECONCILIACAO_RETROATIVA',
      `${result.alterados} PD(s) existente(s) reconciliado(s) com Order Book e Recibos ativos.`,
      result
    );
    return res.status(200).json({
      status: 'success',
      message: result.alterados
        ? `${result.alterados} PD(s) existente(s) foram atualizados sem criar novos registros.`
        : 'Os PDs existentes já estavam coerentes. Nenhuma alteração foi necessária.',
      data: result,
    });
  } catch (error) {
    console.error('[SISHA][compras] reconciliarCicloPdsExistentes:', error);
    return res.status(500).json({ status: 'error', message: 'Falha ao reconciliar retroativamente os PDs existentes.' });
  }
};

exports.listarPdsOrderBookSemOrigem = async (req, res) => {
  try {
    const [{ data: spares, error: sparesError }, { data: pds, error: pdsError }] = await Promise.all([
      supabase.from('leonardo_spares').select('id,documento_referencia,pn,oc_referencia,status_categoria,qtd_pendente,qtd_aguardando_coleta,qtd_em_rota,qtd_entregue').limit(20000),
      supabase.from('compras_pds').select('id,numero_pd,pn,status,status_grupo,ativo').limit(20000),
    ]);
    if (sparesError) throw sparesError;
    if (pdsError) throw pdsError;
    const result = listOrderBookPdGaps(spares || [], pds || []);
    return res.status(200).json({
      status: 'success',
      data: result.gaps,
      meta: { total: result.gaps.length, divergencias_pn: result.pnDivergences },
    });
  } catch (error) {
    console.error('[SISHA][compras] listarPdsOrderBookSemOrigem:', error);
    return res.status(500).json({ status: 'error', message: 'Falha ao reconciliar PDs do Order Book com a base canônica do SISHA.' });
  }
};

exports.listarPds = async (req, res) => {
  try {
    const q = normalizeUpper(req.query.q || '');
    const status = normalizeUpper(req.query.status || '');
    const incluirInativos = String(req.query.incluir_inativos || '').toLowerCase() === 'true';
    let query = supabase.from('compras_pds').select('*').order('updated_at', { ascending: false }).limit(10000);
    if (!incluirInativos) query = query.neq('ativo', false);
    if (status) query = query.eq('status_grupo', status);
    const { data, error } = await query;
    if (error) throw error;
    let rows = data || [];
    if (q) rows = rows.filter((pd) => pdMatches(pd, q));
    return res.status(200).json({ status: 'success', data: rows, meta: { total: rows.length, busca: q || null } });
  } catch (error) {
    console.error('[SISHA][compras] listarPds:', error);
    return res.status(500).json({ status: 'error', message: 'Falha ao consultar PD/SEPD.' });
  }
};

exports.exportarPds = async (req, res) => {
  try {
    const q = normalizeUpper(req.query.q || '');
    const { data, error } = await supabase.from('compras_pds').select('*').order('updated_at', { ascending: false }).limit(20000);
    if (error) throw error;
    const rows = q ? (data || []).filter((pd) => pdMatches(pd, q)) : (data || []);
    const workbook = XLSX.utils.book_new();
    appendJsonSheet(workbook, 'PD_SEPD', rows);
    await auditCompra(req, 'PD_EXPORTADO_LOTE', 'PD', 'PD_SEPD', `${rows.length} PD/SEPD exportados.`, { busca: q || null, total: rows.length });
    return sendExcelWorkbook(res, workbook, exportFileName('PD_SEPD', q || 'TODOS'));
  } catch (error) {
    console.error('[SISHA][compras] exportarPds:', error);
    return res.status(500).json({ status: 'error', message: 'Falha ao exportar PD/SEPD.' });
  }
};

exports.criarPd = async (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    const numeroPd = normalizeUpper(req.body.numero_pd);
    const pn = normalizeUpper(req.body.pn);
    const status = normalizeUpper(req.body.status || 'ELB');
    if (!numeroPd || !pn) return res.status(400).json({ status: 'error', message: 'Número do PD e PN são obrigatórios.' });
    if (!PD_STATUSES.has(status)) return res.status(400).json({ status: 'error', message: 'Status inválido para PD.' });
    const quantidade = Math.max(1, toNumber(req.body.qtd_comprada ?? req.body.quantidade) || 1);
    const valorUnitario = toNumber(req.body.valor_unitario);
    const numeroOcOriginal = normalizeUpper(req.body.numero_oc);
    const numeroOc = normalizeOcRaiz(numeroOcOriginal);
    let linkedOrderId = null;
    if (numeroOc) {
      const { data: linkedOrder, error: linkedOrderError } = await supabase
        .from('compras_ordens')
        .select('id')
        .eq('numero_oc', numeroOc)
        .maybeSingle();
      if (linkedOrderError) throw linkedOrderError;
      linkedOrderId = linkedOrder?.id || null;
    }
    const payload = {
      numero_pd: numeroPd,
      numero_oc: numeroOc || null,
      numero_oc_original: numeroOcOriginal || null,
      ordem_id: linkedOrderId,
      pn,
      nsn: normalizeUpper(req.body.nsn) || null,
      nomenclatura: cleanText(req.body.nomenclatura),
      fabricante: normalizeUpper(req.body.fabricante) || null,
      quantidade,
      qtd_pedida: toNumber(req.body.qtd_pedida) || quantidade,
      qtd_comprada: toNumber(req.body.qtd_comprada) || quantidade,
      qtd_faturada: toNumber(req.body.qtd_faturada),
      qtd_recebida: toNumber(req.body.qtd_recebida),
      valor_unitario: valorUnitario,
      valor_total: toNumber(req.body.valor_total) || valorUnitario * quantidade,
      valor_total_usd: req.body.valor_total_usd !== undefined ? toNumber(req.body.valor_total_usd) : null,
      valor_total_gbp: req.body.valor_total_gbp !== undefined ? toNumber(req.body.valor_total_gbp) : null,
      moeda: normalizeUpper(req.body.moeda || 'USD'),
      status,
      status_grupo: mapProcessStatus(status),
      status_item: cleanText(req.body.status_item),
      responsavel: cleanText(req.body.responsavel),
      data_previsao_entrega: parseDate(req.body.data_previsao_entrega),
      data_entrega: parseDate(req.body.data_entrega),
      observacao: cleanText(req.body.observacao),
      origem_importacao: normalizeUpper(req.body.origem_importacao || 'MANUAL'),
      ativo: !['CAN', 'EXCLUIDO'].includes(status),
      updated_at: new Date().toISOString(),
    };
    const { data, error } = await supabase.from('compras_pds').upsert(payload, { onConflict: 'numero_pd' }).select('*').single();
    if (error) throw error;
    await registrarEventoPd(data.id, req, 'PD_CRIADO_ATUALIZADO', null, data.status_grupo || data.status, { numero_pd: data.numero_pd, pn: data.pn, origem: payload.origem_importacao });
    await auditCompra(req, 'PD_CRIADO_ATUALIZADO', 'PD', data.numero_pd, `PD ${data.numero_pd} cadastrado/atualizado.`, { pn: data.pn, status: data.status, quantidade: data.quantidade });
    return res.status(201).json({ status: 'success', message: 'PD cadastrado/atualizado com sucesso.', data });
  } catch (error) {
    console.error('[SISHA][compras] criarPd:', error);
    return res.status(500).json({ status: 'error', message: error.message || 'Falha ao cadastrar PD.' });
  }
};

exports.atualizarPd = async (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    const { id } = req.params;
    if (String(id).startsWith('orderbook-pd-')) return res.status(400).json({ status: 'error', message: 'PD sintético do Order Book é somente leitura. O PD local reconciliado pode ser editado pelo botão GERENCIAR PDs da respectiva OC.' });
    const { data: current, error: currentError } = await supabase.from('compras_pds').select('*').eq('id', id).single();
    if (currentError) throw currentError;
    const status = req.body.status !== undefined ? normalizeUpper(req.body.status) : normalizeUpper(current.status);
    if (status && !PD_STATUSES.has(status)) return res.status(400).json({ status: 'error', message: 'Status inválido para PD.' });

    const payload = { updated_at: new Date().toISOString() };
    if (req.body.numero_pd !== undefined) payload.numero_pd = normalizeUpper(req.body.numero_pd);
    if (req.body.pn !== undefined) payload.pn = normalizeUpper(req.body.pn);
    if (req.body.nsn !== undefined) payload.nsn = normalizeUpper(req.body.nsn) || null;
    ['nomenclatura', 'status_item', 'responsavel', 'observacao', 'uf_pedida', 'uf_cotada'].forEach((field) => {
      if (req.body[field] !== undefined) payload[field] = cleanText(req.body[field]);
    });
    if (req.body.fabricante !== undefined) payload.fabricante = normalizeUpper(req.body.fabricante) || null;
    ['quantidade', 'qtd_pedida', 'qtd_cotada', 'qtd_comprada', 'qtd_faturada', 'qtd_recebida', 'valor_unitario', 'valor_total', 'valor_total_usd', 'valor_total_gbp', 'dias_entrega'].forEach((field) => {
      if (req.body[field] !== undefined) payload[field] = toNumber(req.body[field]);
    });
    if (req.body.moeda !== undefined) payload.moeda = normalizeUpper(req.body.moeda || current.moeda || 'USD');
    if (req.body.data_entrega !== undefined) payload.data_entrega = parseDate(req.body.data_entrega);
    if (req.body.data_previsao_entrega !== undefined) payload.data_previsao_entrega = parseDate(req.body.data_previsao_entrega);
    if (req.body.numero_oc !== undefined) {
      payload.numero_oc = normalizeOcRaiz(req.body.numero_oc) || null;
      payload.numero_oc_original = normalizeUpper(req.body.numero_oc) || null;
      payload.ordem_id = null;
      if (payload.numero_oc) {
        const { data: linkedOrder, error: linkedOrderError } = await supabase
          .from('compras_ordens')
          .select('id')
          .eq('numero_oc', payload.numero_oc)
          .maybeSingle();
        if (linkedOrderError) throw linkedOrderError;
        payload.ordem_id = linkedOrder?.id || null;
      }
    } else if (req.body.ordem_id !== undefined) {
      payload.ordem_id = req.body.ordem_id || null;
    }
    payload.status = status;
    payload.status_grupo = mapProcessStatus(status);
    payload.ativo = !['CAN', 'EXCLUIDO'].includes(status);
    if (status === 'CAN') {
      payload.cancelado_em = new Date().toISOString();
      payload.motivo_cancelamento = req.body.motivo_cancelamento || req.body.observacao || 'PD cancelado pelo ADMIN.';
    }

    const { data, error } = await supabase.from('compras_pds').update(payload).eq('id', id).select('*').single();
    if (error) throw error;
    await registrarEventoPd(data.id, req, 'PD_EDITADO', current.status_grupo || current.status, data.status_grupo || data.status, {
      numero_pd: data.numero_pd,
      pn: data.pn,
      numero_oc: data.numero_oc,
      alteracoes: Object.keys(payload),
    });
    await auditCompra(req, 'PD_EDITADO', 'PD', data.numero_pd, `PD ${data.numero_pd} editado/evoluído.`, { pn: data.pn, status_anterior: current.status, status_novo: data.status, numero_oc: data.numero_oc });
    return res.status(200).json({ status: 'success', message: 'PD atualizado e evolução registrada no histórico.', data });
  } catch (error) {
    console.error('[SISHA][compras] atualizarPd:', error);
    return res.status(500).json({ status: 'error', message: error.message || 'Falha ao atualizar PD.' });
  }
};

exports.excluirPd = async (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    const { data: current, error: currentError } = await supabase.from('compras_pds').select('*').eq('id', req.params.id).single();
    if (currentError) throw currentError;
    const { data, error } = await supabase.from('compras_pds').update({ ativo: false, status: 'EXCLUIDO', status_grupo: 'CAN', updated_at: new Date().toISOString() }).eq('id', req.params.id).select('*').single();
    if (error) throw error;
    await registrarEventoPd(data.id, req, 'PD_EXCLUIDO_LOGICAMENTE', current.status_grupo || current.status, 'EXCLUIDO', { numero_pd: data.numero_pd, pn: data.pn });
    await auditCompra(req, 'PD_EXCLUIDO_LOGICAMENTE', 'PD', data.numero_pd, `PD ${data.numero_pd} excluído logicamente.`, { pn: data.pn }, 'GOD');
    return res.status(200).json({ status: 'success', message: 'PD excluído logicamente. Histórico preservado.' });
  } catch (error) {
    return res.status(500).json({ status: 'error', message: error.message || 'Falha ao excluir PD.' });
  }
};

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


exports.exportarOrdem = async (req, res) => {
  try {
    const { id } = req.params;
    let ordem = null;
    let orderBookRows = [];

    if (String(id).startsWith('orderbook-')) {
      const numeroOc = normalizeUpper(String(id).replace(/^orderbook-/i, ''));
      const { data, error } = await supabase.from('leonardo_spares').select('*').limit(10000);
      if (error) throw error;
      orderBookRows = (data || []).filter((row) => normalizeOcRaiz(row.oc_referencia) === normalizeOcRaiz(numeroOc));
      ordem = buildOrderBookOrdens(orderBookRows)[0] || null;
    } else {
      const { data, error } = await supabase
        .from('compras_ordens')
        .select('*, compras_pds(*), compras_suplementacoes(*)')
        .eq('id', id)
        .single();
      if (error) throw error;
      ordem = { ...data, source: 'SISHA', fonte: 'SISHA', resumo: calcOrdemResumo(data) };
      const numeroOc = normalizeOcRaiz(ordem.numero_oc);
      const { data: bookData } = await supabase.from('leonardo_spares').select('*').limit(10000);
      orderBookRows = (bookData || []).filter((row) => normalizeOcRaiz(row.oc_referencia) === numeroOc);
    }

    if (!ordem) return res.status(404).json({ status: 'error', message: 'OC não encontrada para exportação.' });

    const workbook = XLSX.utils.book_new();
    appendJsonSheet(workbook, 'Resumo OC', [{
      id: ordem.id,
      numero_oc: ordem.numero_oc,
      numero_oc_original: ordem.numero_oc_original,
      status: ordem.status,
      moeda: ordem.moeda,
      valor_total: ordem.valor_total,
      valor_total_gbp: ordem.valor_total_gbp,
      valor_total_usd: ordem.valor_total_usd,
      valor_suplementado: ordem.resumo?.valor_suplementado,
      saldo_restante: ordem.resumo?.saldo_restante,
      percentual_suplementado: ordem.resumo?.percentual_suplementado,
      observacao: ordem.observacao,
      motivo_ressalva: ordem.motivo_ressalva,
      fonte: ordem.fonte || ordem.fonte_confirmacao || ordem.source,
      exportado_em: new Date().toISOString(),
    }]);
    appendJsonSheet(workbook, 'PDs', ordem.compras_pds || []);
    appendJsonSheet(workbook, 'Suplementacoes', ordem.compras_suplementacoes || []);
    appendJsonSheet(workbook, 'OrderBook', orderBookRows || []);

    await auditCompra(req, 'OC_EXPORTADA', 'OC', ordem.numero_oc || id, `OC ${ordem.numero_oc || id} exportada.`, { id, pds: (ordem.compras_pds || []).length, order_book: orderBookRows.length }, 'PUBLIC');
    return sendExcelWorkbook(res, workbook, exportFileName('OC', ordem.numero_oc_original || ordem.numero_oc || id));
  } catch (error) {
    console.error('[SISHA][compras] exportarOrdem:', error);
    return res.status(500).json({ status: 'error', message: 'Falha ao exportar OC.' });
  }
};

exports.exportarWorkOrder = async (req, res) => {
  try {
    const { id } = req.params;
    let wo = null;
    let orderBookRows = [];

    if (String(id).startsWith('orderbook-repair-')) {
      const rawId = String(id).replace(/^orderbook-repair-/i, '');
      const { data, error } = await supabase.from('leonardo_repairs').select('*').limit(10000);
      if (error) throw error;
      orderBookRows = (data || []).filter((row) => String(row.id) === rawId || normalizeComparable(`${row.documento_referencia}-${row.pn}-${row.sn || 'SN'}`) === normalizeComparable(rawId));
      wo = buildOrderBookWorkOrders(orderBookRows)[0] || null;
    } else {
      const { data, error } = await supabase
        .from('work_orders')
        .select('*, work_order_suplementacoes(*)')
        .eq('id', id)
        .single();
      if (error) throw error;
      wo = { ...data, source: 'SISHA', fonte: 'SISHA', resumo: calcWoResumo(data) };
      const { data: bookData } = await supabase.from('leonardo_repairs').select('*').eq('pn', wo.pn).limit(1000);
      orderBookRows = bookData || [];
    }

    if (!wo) return res.status(404).json({ status: 'error', message: 'WO não encontrada para exportação.' });

    const workbook = XLSX.utils.book_new();
    appendJsonSheet(workbook, 'Resumo WO', [{
      id: wo.id,
      numero_wo: wo.numero_wo,
      documento_referencia: wo.documento_referencia,
      pn: wo.pn,
      sn: wo.sn,
      status: wo.status,
      tipo_wo: wo.tipo_wo || wo.tipo,
      resultado_tecnico: wo.resultado_tecnico || wo.resultado,
      empresa: wo.empresa || wo.codemp,
      valor_total: wo.valor_total,
      moeda: wo.moeda,
      valor_suplementado: wo.resumo?.valor_suplementado,
      saldo_restante: wo.resumo?.saldo_restante,
      data_previsao: wo.data_previsao || wo.data_previsao_entrega,
      lh_updates: wo.lh_updates,
      bn_comments: wo.bn_comments,
      observacao: wo.observacao,
      fonte: wo.fonte || wo.source,
      exportado_em: new Date().toISOString(),
    }]);
    appendJsonSheet(workbook, 'Suplementacoes', wo.work_order_suplementacoes || []);
    appendJsonSheet(workbook, 'OrderBook_Repair', orderBookRows || []);

    await auditCompra(req, 'WO_EXPORTADA', 'WO', wo.numero_wo || id, `WO ${wo.numero_wo || id} exportada.`, { id, order_book: orderBookRows.length }, 'PUBLIC');
    return sendExcelWorkbook(res, workbook, exportFileName('WO', wo.numero_wo || wo.documento_referencia || id));
  } catch (error) {
    console.error('[SISHA][compras] exportarWorkOrder:', error);
    return res.status(500).json({ status: 'error', message: 'Falha ao exportar WO.' });
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
    const valorTotalUsd = toNumber(req.body.valor_total_usd ?? req.body.valor_total);
    const { data: ordem, error } = await supabase.from('compras_ordens').upsert({ numero_oc: numeroOc, numero_oc_original: numeroOriginal || numeroOc, status, moeda: 'USD', sigla_moeda: 'USD', valor_total: valorTotalUsd, valor_total_usd: valorTotalUsd, observacao: req.body.observacao || null, ativo: status !== 'CAN', updated_at: new Date().toISOString() }, { onConflict: 'numero_oc' }).select('*').single();
    if (error) throw error;
    const pdsPayload = pds.filter((pd) => normalizeUpper(pd.numero_pd) && normalizeUpper(pd.pn)).slice(0, 20).map((pd) => {
      const quantidade = Math.max(1, toNumber(pd.quantidade) || 1);
      const valorUnitario = toNumber(pd.valor_unitario);
      const valorTotal = toNumber(pd.valor_total) || (valorUnitario * quantidade);
      return { ordem_id: ordem.id, numero_oc: numeroOc, numero_oc_original: numeroOriginal || numeroOc, numero_pd: normalizeUpper(pd.numero_pd), pn: normalizeUpper(pd.pn), nomenclatura: pd.nomenclatura || null, quantidade, qtd_pedida: quantidade, qtd_comprada: quantidade, valor_unitario: valorUnitario, valor_total: valorTotal, valor_total_usd: valorTotal, moeda: 'USD', status: status === 'CAN' ? 'CAN' : 'ATIVO', status_grupo: status === 'CAN' ? 'CAN' : 'ODC', ativo: status !== 'CAN', updated_at: new Date().toISOString() };
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


const OC_MANUAL_ADVANCE_FROM = new Set(['ODC', 'ODA_RESSALVA', 'ADP']);
const PD_MANUAL_ADVANCE_FROM = new Set(['ODC', 'ATIVO', 'ODA_RESSALVA']);
const PD_ADVANCED_BLOCK_CANCEL = new Set(['FAT', 'EMB', 'REC']);

function planManualOcStatusTransition(ordem = {}, pds = [], targetStatus = '') {
  const current = normalizeUpper(ordem.status);
  const target = normalizeUpper(targetStatus);
  if (target === current) return { action: 'NOOP', current, target, promote: [], cancel: [], preserved: pds || [] };

  if (target === 'ODA') {
    if (!OC_MANUAL_ADVANCE_FROM.has(current)) {
      throw Object.assign(new Error(`A OC só pode ser promovida manualmente para ODA a partir de ODC, ODA com ressalva ou ADP. Situação atual: ${current || 'não informada'}.`), { statusCode: 409 });
    }
    const promote = (pds || []).filter((pd) => pd.ativo !== false && PD_MANUAL_ADVANCE_FROM.has(normalizeUpper(pd.status_grupo || pd.status)));
    const preserved = (pds || []).filter((pd) => !promote.some((candidate) => String(candidate.id) === String(pd.id)));
    return { action: 'PROMOTE_ODA', current, target, promote, cancel: [], preserved };
  }

  if (target === 'CAN') {
    const blocking = (pds || []).filter((pd) => {
      const st = normalizeUpper(pd.status_grupo || pd.status);
      const delivered = Math.max(0, Number(pd.qtd_recebida || 0) || 0);
      return pd.ativo !== false && (PD_ADVANCED_BLOCK_CANCEL.has(st) || delivered > 0);
    });
    if (blocking.length) {
      throw Object.assign(new Error(`Cancelamento bloqueado: ${blocking.length} PD(s) já possuem evidência FAT/EMB/REC ou recebimento físico. Regularize esses PDs individualmente antes de cancelar a OC.`), { statusCode: 409, blocking });
    }
    const cancel = (pds || []).filter((pd) => pd.ativo !== false && !['CAN', 'EXCLUIDO'].includes(normalizeUpper(pd.status_grupo || pd.status)));
    return { action: 'CANCEL', current, target, promote: [], cancel, preserved: (pds || []).filter((pd) => !cancel.some((candidate) => String(candidate.id) === String(pd.id))) };
  }

  throw Object.assign(new Error('Transição manual inválida. Use ODA para avançar a OC ou CAN para cancelar.'), { statusCode: 400 });
}

async function rollbackPdStatusRows(rows = []) {
  for (const row of rows || []) {
    if (!row?.id) continue;
    await supabase.from('compras_pds').update({
      status: row.status,
      status_grupo: row.status_grupo,
      ativo: row.ativo,
      cancelado_em: row.cancelado_em || null,
      motivo_cancelamento: row.motivo_cancelamento || null,
      updated_at: row.updated_at || new Date().toISOString(),
    }).eq('id', row.id);
  }
}

exports.transicionarStatusOrdem = async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const { id } = req.params;
  try {
    if (String(id).startsWith('orderbook-')) return res.status(400).json({ status: 'error', message: 'OC importada do Order Book é somente leitura. Corrija pela fonte documental.' });
    const targetStatus = normalizeUpper(req.body?.status);
    const motivo = cleanText(req.body?.motivo || req.body?.observacao || req.body?.motivo_cancelamento);
    if (!['ODA', 'CAN'].includes(targetStatus)) return res.status(400).json({ status: 'error', message: 'Situação de destino inválida. Use ODA ou CAN.' });
    if (targetStatus === 'CAN' && !motivo) return res.status(400).json({ status: 'error', message: 'Informe o motivo do cancelamento para preservar a auditoria.' });

    const { data: ordem, error: ordemError } = await supabase.from('compras_ordens').select('*').eq('id', id).single();
    if (ordemError || !ordem) throw ordemError || new Error('OC não encontrada.');
    const { data: pds, error: pdsError } = await supabase.from('compras_pds').select('*').eq('ordem_id', id);
    if (pdsError) throw pdsError;

    const plan = planManualOcStatusTransition(ordem, pds || [], targetStatus);
    if (plan.action === 'NOOP') return res.status(200).json({ status: 'success', message: `A OC ${ordem.numero_oc} já está em ${targetStatus}. Nenhuma alteração foi necessária.`, data: { ordem, alterados: 0, preservados: (pds || []).length } });

    const changedBefore = plan.action === 'PROMOTE_ODA' ? plan.promote : plan.cancel;
    const ids = changedBefore.map((pd) => pd.id).filter(Boolean);
    const now = new Date().toISOString();
    if (ids.length) {
      const pdPayload = plan.action === 'PROMOTE_ODA'
        ? { status: 'ODA', status_grupo: 'ODA', ativo: true, updated_at: now }
        : { status: 'CAN', status_grupo: 'CAN', ativo: false, cancelado_em: now, motivo_cancelamento: motivo, updated_at: now };
      const { error: pdUpdateError } = await supabase.from('compras_pds').update(pdPayload).in('id', ids);
      if (pdUpdateError) throw pdUpdateError;
    }

    const ordemPayload = plan.action === 'PROMOTE_ODA'
      ? { status: 'ODA', ativo: true, updated_at: now }
      : { status: 'CAN', ativo: false, cancelada_em: now, cancelada_por: req.user?.email || req.user?.sub || null, motivo_cancelamento: motivo, updated_at: now };
    const { data: updatedOrder, error: updateOrderError } = await supabase.from('compras_ordens').update(ordemPayload).eq('id', id).select('*').single();
    if (updateOrderError) {
      await rollbackPdStatusRows(changedBefore).catch(() => {});
      throw updateOrderError;
    }

    for (const pd of changedBefore) {
      await registrarEventoPd(pd.id, req, plan.action === 'PROMOTE_ODA' ? 'OC_MANUAL_PROMOVIDA_ODA' : 'OC_MANUAL_CANCELADA', pd.status_grupo || pd.status, targetStatus, {
        numero_oc: ordem.numero_oc,
        origem: 'AJUSTE_MANUAL_OC',
        motivo: motivo || null,
      });
    }

    await auditCompra(req, plan.action === 'PROMOTE_ODA' ? 'OC_STATUS_PROMOVIDO_ODA' : 'OC_CANCELADA', 'OC', ordem.numero_oc, plan.action === 'PROMOTE_ODA'
      ? `OC ${ordem.numero_oc} promovida manualmente de ${plan.current} para ODA; ${changedBefore.length} PD(s) acompanharam a transição.`
      : `OC ${ordem.numero_oc} cancelada manualmente; ${changedBefore.length} PD(s) elegíveis foram cancelados.`, {
        status_anterior: plan.current,
        status_novo: targetStatus,
        motivo: motivo || null,
        pds_alterados: changedBefore.map((pd) => ({ id: pd.id, numero_pd: pd.numero_pd, status_anterior: pd.status_grupo || pd.status })),
        pds_preservados: plan.preserved.map((pd) => ({ id: pd.id, numero_pd: pd.numero_pd, status: pd.status_grupo || pd.status })),
      }, targetStatus === 'CAN' ? 'GOD' : 'PUBLIC');

    return res.status(200).json({
      status: 'success',
      message: plan.action === 'PROMOTE_ODA'
        ? `OC ${ordem.numero_oc} avançada para ODA. ${changedBefore.length} PD(s) vinculados foram promovidos; estágios mais avançados foram preservados.`
        : `OC ${ordem.numero_oc} cancelada. ${changedBefore.length} PD(s) vinculados foram cancelados logicamente.`,
      data: { ordem: updatedOrder, alterados: changedBefore.length, preservados: plan.preserved.length, plano: plan.action },
    });
  } catch (error) {
    console.error('[SISHA][compras] transicionarStatusOrdem:', error);
    return res.status(error.statusCode || 500).json({ status: 'error', message: error.message || 'Falha ao alterar situação da OC.' });
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
    if (req.body.valor_total_usd !== undefined) payload.valor_total_usd = toNumber(req.body.valor_total_usd);
    if (req.body.valor_total_gbp !== undefined) payload.valor_total_gbp = toNumber(req.body.valor_total_gbp);
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
    const { data: ordem, error: ordemError } = await supabase.from('compras_ordens').select('id, numero_oc, status').eq('id', id).single();
    if (ordemError) throw ordemError;
    if (ordem.status === 'CAN') return res.status(400).json({ status: 'error', message: 'OC cancelada não pode receber suplementação.' });
    const { data, error } = await supabase.from('compras_suplementacoes').insert({ ordem_id: id, valor, moeda: 'USD', msg_referencia: req.body.msg_referencia || null, data_msg: req.body.data_msg || null, observacao: req.body.observacao || null, ativo: true }).select('*').single();
    if (error) throw error;
    await auditCompra(req, 'OC_SUPLEMENTADA', 'OC', ordem.numero_oc || id, `Suplementação USD registrada na OC ${ordem.numero_oc || id}.`, { valor, moeda: 'USD', msg_referencia: req.body.msg_referencia, data_msg: req.body.data_msg || null });
    return res.status(201).json({ status: 'success', message: 'Suplementação USD registrada na OC.', data });
  } catch (error) {
    console.error('[SISHA][compras] adicionarSuplementacaoOrdem:', error);
    return res.status(500).json({ status: 'error', message: 'Falha ao registrar suplementação da OC.' });
  }
};

exports.retificarSuplementacaoOrdem = async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const { id, suplementacaoId } = req.params;
  let oldRow = null;
  try {
    const valor = toNumber(req.body.valor);
    const motivo = cleanText(req.body.motivo_retificacao || req.body.motivo);
    if (valor <= 0) return res.status(400).json({ status: 'error', message: 'O novo valor deve ser maior que zero.' });
    if (!motivo) return res.status(400).json({ status: 'error', message: 'Motivo da retificação é obrigatório para auditoria.' });
    const { data: ordem, error: ordemError } = await supabase.from('compras_ordens').select('id, numero_oc, status').eq('id', id).single();
    if (ordemError) throw ordemError;
    if (ordem.status === 'CAN') return res.status(400).json({ status: 'error', message: 'OC cancelada não pode ter suplementação retificada.' });
    const { data: current, error: currentError } = await supabase.from('compras_suplementacoes').select('*').eq('id', suplementacaoId).eq('ordem_id', id).single();
    if (currentError) throw currentError;
    oldRow = current;
    if (current.ativo === false) return res.status(409).json({ status: 'error', message: 'Esta suplementação já foi substituída/inativada.' });
    const { error: deactivateError } = await supabase.from('compras_suplementacoes').update({ ativo: false }).eq('id', suplementacaoId);
    if (deactivateError) throw deactivateError;
    const { data: replacement, error: insertError } = await supabase.from('compras_suplementacoes').insert({
      ordem_id: id,
      valor,
      moeda: 'USD',
      msg_referencia: req.body.msg_referencia ?? current.msg_referencia ?? null,
      data_msg: req.body.data_msg ?? current.data_msg ?? null,
      observacao: cleanText(req.body.observacao) || `Retificação da suplementação #${current.id}. Motivo: ${motivo}`,
      ativo: true,
    }).select('*').single();
    if (insertError) {
      await supabase.from('compras_suplementacoes').update({ ativo: true }).eq('id', suplementacaoId);
      throw insertError;
    }
    await auditCompra(req, 'OC_SUPLEMENTACAO_RETIFICADA', 'OC', ordem.numero_oc || id, `Suplementação da OC ${ordem.numero_oc || id} retificada sem apagar o registro anterior.`, { motivo, anterior: current, atual: replacement }, 'GOD');
    return res.status(200).json({ status: 'success', message: 'Suplementação retificada. O registro anterior foi preservado como inativo para auditoria.', data: replacement, anterior: current });
  } catch (error) {
    console.error('[SISHA][compras] retificarSuplementacaoOrdem:', error);
    return res.status(500).json({ status: 'error', message: error.message || 'Falha ao retificar suplementação da OC.' });
  }
};

exports.atualizarControleSuplementacaoOrdem = async (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    const { id } = req.params;
    if (String(id).startsWith('orderbook-')) return res.status(400).json({ status: 'error', message: 'OC do Order Book é somente leitura.' });
    const motivo = cleanText(req.body.motivo);
    const marcarTotal = req.body.marcar_total === true;
    const { data: ordem, error: ordemError } = await supabase.from('compras_ordens').select('id, numero_oc, status, valor_total_usd, valor_total_gbp, valor_total, moeda').eq('id', id).single();
    if (ordemError) throw ordemError;
    if (ordem.status === 'CAN') return res.status(400).json({ status: 'error', message: 'OC cancelada não pode ter controle financeiro alterado.' });
    const { data: sups, error: supsError } = await supabase.from('compras_suplementacoes').select('valor,moeda,ativo').eq('ordem_id', id).eq('ativo', true);
    if (supsError) throw supsError;
    const suplementadoUsd = (sups || []).filter((sup) => normalizeUpper(sup.moeda || 'USD') === 'USD').reduce((acc, sup) => acc + toNumber(sup.valor), 0);
    const anterior = toNumber(ordem.valor_total_usd) || (normalizeUpper(ordem.moeda) === 'USD' ? toNumber(ordem.valor_total) : 0);
    let novoAlvo = req.body.valor_alvo_usd !== undefined ? toNumber(req.body.valor_alvo_usd) : anterior;
    if (marcarTotal) {
      if (suplementadoUsd <= 0) return res.status(400).json({ status: 'error', message: 'Não há suplementação USD ativa para encerrar como totalmente suplementada.' });
      novoAlvo = suplementadoUsd;
    }
    if (novoAlvo < 0) return res.status(400).json({ status: 'error', message: 'Valor alvo USD inválido.' });
    if (Math.abs(novoAlvo - anterior) > 0.005 && !motivo) return res.status(400).json({ status: 'error', message: 'Informe o motivo da alteração do valor alvo USD.' });
    const { data, error } = await supabase.from('compras_ordens').update({ valor_total_usd: novoAlvo, updated_at: new Date().toISOString() }).eq('id', id).select('*').single();
    if (error) throw error;
    await auditCompra(req, marcarTotal ? 'OC_SUPLEMENTACAO_ENCERRADA' : 'OC_VALOR_ALVO_USD_AJUSTADO', 'OC', ordem.numero_oc || id, marcarTotal ? `OC ${ordem.numero_oc || id} marcada como totalmente suplementada por ajuste auditável do alvo USD.` : `Valor alvo USD da OC ${ordem.numero_oc || id} ajustado.`, { valor_alvo_usd_anterior: anterior, valor_alvo_usd_novo: novoAlvo, suplementado_usd: suplementadoUsd, motivo, valor_total_gbp_preservado: ordem.valor_total_gbp });
    return res.status(200).json({ status: 'success', message: marcarTotal ? 'OC marcada como totalmente suplementada. Valores GBP e histórico foram preservados.' : 'Valor alvo USD atualizado com auditoria.', data, suplementado_usd: suplementadoUsd });
  } catch (error) {
    console.error('[SISHA][compras] atualizarControleSuplementacaoOrdem:', error);
    return res.status(500).json({ status: 'error', message: error.message || 'Falha ao atualizar controle de suplementação da OC.' });
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
      payload.push({ numero_pd: numeroPd, pn, nsn: normalizeUpper(get(row, 'NSN')) || null, codemp: normalizeUpper(get(row, 'CODEMP')) || null, quantidade: qtd, qtd_pedida: qtd, uf_pedida: get(row, 'UF') || null, valor_unitario: valorUnitUsd, valor_total: toNumber(get(row, 'Total (USD)')) || valorUnitUsd * qtd, moeda: 'USD', valor_total_usd: toNumber(get(row, 'Total (USD)')) || valorUnitUsd * qtd, valor_contratado: toNumber(get(row, 'Valor Contratado')), status: statusOriginal, status_grupo: statusGrupo, data_status: parseDate(get(row, 'Data Status')), org_obt: get(row, 'Org. Obt') || null, ext: get(row, 'Ext') || null, sub: get(row, 'Sub') || null, critica: get(row, 'Crítica') || null, prioridade: get(row, 'Pri') || null, tl: get(row, 'T.L.') || null, co: get(row, 'C.O.') || null, sj: get(row, 'SJ') || null, lote_envio: get(row, 'Lote Envio') || null, omd: get(row, 'OMD') || null, omc: get(row, 'OMC') || null, cam: get(row, 'CAM') || null, equipamento_codigo: get(row, 'Equipamento') || null, modelo: get(row, 'Modelo') || null, serial_number_relatorio: get(row, 'Serial Number') || null, responsavel: get(row, 'Responsável') || null, data_previsao_entrega: parseDate(get(row, 'Dt.Prv. Entrega')), origem_importacao: 'EXPORT_PD_ODC_MB', ativo: !cancelado, cancelado_em: cancelado ? now : null, motivo_cancelamento: cancelado ? 'PD sem OC cancelado no arquivo de origem.' : null, updated_at: now });
    });
    if (payload.length === 0) return res.status(400).json({ status: 'error', message: 'Nenhum PD de pipeline válido encontrado no arquivo.' });
    const { error } = await supabase.from('compras_pds').upsert(payload, { onConflict: 'numero_pd' });
    if (error) throw error;
    await auditCompra(req, 'PD_SEM_OC_IMPORTADO', 'PD', 'PD_SEM_OC', `${payload.length} PD(s) sem OC importados/atualizados.`, { linhas_lidas: rows.length, importadas: payload.length });
    return res.status(200).json({ status: 'success', message: `${payload.length} PD(s) sem OC importados/atualizados.`, data: { linhas_lidas: rows.length, importadas: payload.length } });
  } catch (error) {
    console.error('[SISHA][compras] importarPipelinePds:', error);
    return res.status(500).json({ status: 'error', message: 'Falha ao importar PDs sem OC.' });
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
    const wos = await workOrderEquipmentService.decorateWorkOrdersWithEquipmentTrace([...wosManuais, ...wosBookSemDuplicar]);
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
    const { data, error } = await supabase.from('work_orders').upsert({
      numero_wo: numeroWo,
      pn,
      nomenclatura: nomenclaturaFinal,
      fonte_nomenclatura: fonteNomenclatura,
      nomenclatura_informada_manualmente: !!nomenclaturaManual,
      nomenclatura_atualizada_em: nomenclaturaManual ? new Date().toISOString() : null,
      nomenclatura_atualizada_por: nomenclaturaManual ? (req.user?.email || req.user?.sub || null) : null,
      sn: sn || null,
      sn_pendente: !sn,
      quantidade: 1,
      empresa: req.body.empresa || req.body.codemp || null,
      codemp: normalizeUpper(req.body.codemp || req.body.empresa) || null,
      origem: normalizeUpper(req.body.origem || 'MANUAL'),
      status,
      status_original: status,
      status_grupo: mapProcessStatus(status),
      tipo_wo: WO_TIPOS.has(tipoWo) ? tipoWo : 'OUTRO',
      resultado_tecnico: WO_RESULTADOS.has(resultadoTecnico) ? resultadoTecnico : 'PENDENTE',
      valor_total: toNumber(req.body.valor_total),
      valor_total_usd: toNumber(req.body.valor_total),
      moeda: normalizeUpper(req.body.moeda || 'USD'),
      data_abertura: req.body.data_abertura || null,
      data_envio: req.body.data_envio || null,
      data_previsao: req.body.data_previsao || null,
      data_previsao_entrega: req.body.data_previsao || null,
      data_retorno: req.body.data_retorno || null,
      aeronave: cleanText(req.body.aeronave),
      pn_saida: normalizeUpper(req.body.pn_saida) || null,
      equipamento_codigo: cleanText(req.body.equipamento_codigo),
      modelo: cleanText(req.body.modelo),
      responsavel: cleanText(req.body.responsavel),
      observacao: req.body.observacao || null,
      ativo: status !== 'CAN' && status !== 'CANCELADO',
      updated_at: new Date().toISOString(),
    }, { onConflict: 'numero_wo' }).select('*').single();
    if (error) throw error;
    const equipmentTrace = await safeSyncWorkOrderLedger(data, req);
    await auditCompra(req, 'WO_CRIADA_ATUALIZADA', 'WO', data.numero_wo, `WO ${data.numero_wo} cadastrada/atualizada.`, { pn: data.pn, sn: data.sn, status: data.status, equipment_trace: equipmentTrace.status });
    return res.status(201).json({ status: 'success', message: 'WO cadastrada/atualizada com sucesso.', data: { ...data, equipment_trace: equipmentTrace }, equipment_trace: equipmentTrace });
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
    if (req.body.numero_wo !== undefined) payload.numero_wo = normalizeUpper(req.body.numero_wo);
    if (req.body.pn !== undefined) payload.pn = normalizeUpper(req.body.pn);
    if (req.body.nsn !== undefined) payload.nsn = normalizeUpper(req.body.nsn) || null;
    if (req.body.quantidade !== undefined && toNumber(req.body.quantidade) !== 1) {
      return res.status(400).json({
        status: 'error',
        message: 'Cada WO representa um único equipamento/serial e deve manter quantidade igual a 1.',
      });
    }
    payload.quantidade = 1;
    if (req.body.empresa !== undefined || req.body.codemp !== undefined) {
      payload.empresa = cleanText(req.body.empresa || req.body.codemp);
      payload.codemp = normalizeUpper(req.body.codemp || req.body.empresa) || null;
    }
    ['observacao', 'responsavel', 'aeronave', 'pn_saida', 'modelo', 'equipamento_codigo'].forEach((field) => {
      if (req.body[field] !== undefined) payload[field] = cleanText(req.body[field]);
    });
    ['data_abertura', 'data_envio', 'data_previsao', 'data_retorno', 'data_previsao_entrega', 'data_status'].forEach((field) => {
      if (req.body[field] !== undefined) payload[field] = parseDate(req.body[field]);
    });
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
    if (status) {
      payload.status = status;
      payload.status_original = status;
      payload.status_grupo = mapProcessStatus(status);
      payload.ativo = !['CAN', 'CANCELADO'].includes(status);
    }
    if (req.body.origem !== undefined) payload.origem = normalizeUpper(req.body.origem || 'MANUAL');
    if (req.body.resultado_tecnico !== undefined || req.body.resultado !== undefined) {
      const resultado = normalizeUpper(req.body.resultado_tecnico || req.body.resultado || 'PENDENTE');
      payload.resultado_tecnico = WO_RESULTADOS.has(resultado) ? resultado : 'PENDENTE';
    }
    if (req.body.valor_unitario_usd !== undefined) payload.valor_unitario_usd = toNumber(req.body.valor_unitario_usd);
    if (req.body.valor_total !== undefined) { payload.valor_total = toNumber(req.body.valor_total); payload.valor_total_usd = toNumber(req.body.valor_total); }
    if (req.body.valor_contratado !== undefined) payload.valor_contratado = toNumber(req.body.valor_contratado);
    if (req.body.moeda !== undefined) payload.moeda = normalizeUpper(req.body.moeda || 'USD');
    const { data, error } = await supabase.from('work_orders').update(payload).eq('id', id).select('*').single();
    if (error) throw error;
    const equipmentTrace = await safeSyncWorkOrderLedger(data, req);
    await auditCompra(req, 'WO_EDITADA', 'WO', data.numero_wo, `WO ${data.numero_wo} editada.`, { pn: data.pn, sn: data.sn, status: data.status, tipo_wo: data.tipo_wo, resultado_tecnico: data.resultado_tecnico, equipment_trace: equipmentTrace.status });
    return res.status(200).json({ status: 'success', message: 'WO atualizada com sucesso.', data: { ...data, equipment_trace: equipmentTrace }, equipment_trace: equipmentTrace });
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
    const { data: cancelledWo, error } = await supabase.from('work_orders').update({ ativo: false, status: 'CAN', updated_at: new Date().toISOString() }).eq('id', id).select('*').single();
    if (error) throw error;
    const equipmentTrace = cancelledWo ? await safeSyncWorkOrderLedger(cancelledWo, req) : null;
    await auditCompra(req, 'WO_EXCLUIDA_LOGICAMENTE', 'WO', id, `WO ${id} excluída logicamente.`, { id, equipment_trace: equipmentTrace?.status || null }, 'GOD');
    return res.status(200).json({ status: 'success', message: 'WO excluída logicamente. Histórico preservado.', equipment_trace: equipmentTrace });
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
    const { data, error } = await supabase.from('work_order_suplementacoes').insert({ work_order_id: id, valor, moeda: 'USD', msg_referencia: req.body.msg_referencia || null, data_msg: req.body.data_msg || null, observacao: req.body.observacao || null, ativo: true }).select('*').single();
    if (error) throw error;
    const { data: woAtualizada } = await supabase.from('work_orders').select('*, work_order_suplementacoes(*)').eq('id', id).maybeSingle();
    const equipmentTrace = woAtualizada ? await safeSyncWorkOrderLedger(woAtualizada, req) : null;
    await auditCompra(req, 'WO_SUPLEMENTADA', 'WO', woAtualizada?.numero_wo || id, `Suplementação USD registrada na WO ${woAtualizada?.numero_wo || id}.`, { valor, moeda: 'USD', msg_referencia: req.body.msg_referencia, equipment_trace: equipmentTrace?.status || null });
    return res.status(201).json({ status: 'success', message: 'Suplementação USD registrada na WO.', data, equipment_trace: equipmentTrace });
  } catch (error) {
    console.error('[SISHA][compras] adicionarSuplementacaoWorkOrder:', error);
    return res.status(500).json({ status: 'error', message: 'Falha ao registrar suplementação da WO.' });
  }
};

exports.retificarSuplementacaoWorkOrder = async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const { id, suplementacaoId } = req.params;
  try {
    const valor = toNumber(req.body.valor);
    const motivo = cleanText(req.body.motivo_retificacao || req.body.motivo);
    if (valor <= 0) return res.status(400).json({ status: 'error', message: 'O novo valor deve ser maior que zero.' });
    if (!motivo) return res.status(400).json({ status: 'error', message: 'Motivo da retificação é obrigatório para auditoria.' });
    const { data: current, error: currentError } = await supabase.from('work_order_suplementacoes').select('*').eq('id', suplementacaoId).eq('work_order_id', id).single();
    if (currentError) throw currentError;
    if (current.ativo === false) return res.status(409).json({ status: 'error', message: 'Esta suplementação já foi substituída/inativada.' });
    const { error: deactivateError } = await supabase.from('work_order_suplementacoes').update({ ativo: false }).eq('id', suplementacaoId);
    if (deactivateError) throw deactivateError;
    const { data: replacement, error: insertError } = await supabase.from('work_order_suplementacoes').insert({
      work_order_id: id,
      valor,
      moeda: 'USD',
      msg_referencia: req.body.msg_referencia ?? current.msg_referencia ?? null,
      data_msg: req.body.data_msg ?? current.data_msg ?? null,
      observacao: cleanText(req.body.observacao) || `Retificação da suplementação #${current.id}. Motivo: ${motivo}`,
      ativo: true,
    }).select('*').single();
    if (insertError) {
      await supabase.from('work_order_suplementacoes').update({ ativo: true }).eq('id', suplementacaoId);
      throw insertError;
    }
    const { data: woAtualizada } = await supabase.from('work_orders').select('*, work_order_suplementacoes(*)').eq('id', id).maybeSingle();
    const equipmentTrace = woAtualizada ? await safeSyncWorkOrderLedger(woAtualizada, req) : null;
    await auditCompra(req, 'WO_SUPLEMENTACAO_RETIFICADA', 'WO', woAtualizada?.numero_wo || id, `Suplementação da WO ${woAtualizada?.numero_wo || id} retificada sem apagar o registro anterior.`, { motivo, anterior: current, atual: replacement, equipment_trace: equipmentTrace?.status || null }, 'GOD');
    return res.status(200).json({ status: 'success', message: 'Suplementação da WO retificada. Registro anterior preservado para auditoria.', data: replacement, anterior: current, equipment_trace: equipmentTrace });
  } catch (error) {
    console.error('[SISHA][compras] retificarSuplementacaoWorkOrder:', error);
    return res.status(500).json({ status: 'error', message: error.message || 'Falha ao retificar suplementação da WO.' });
  }
};

exports.atualizarControleSuplementacaoWorkOrder = async (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    const { id } = req.params;
    if (String(id).startsWith('orderbook-repair-')) return res.status(400).json({ status: 'error', message: 'WO do Order Book é somente leitura.' });
    const motivo = cleanText(req.body.motivo);
    const marcarTotal = req.body.marcar_total === true;
    const { data: wo, error: woError } = await supabase.from('work_orders').select('*').eq('id', id).single();
    if (woError) throw woError;
    const { data: sups, error: supsError } = await supabase.from('work_order_suplementacoes').select('valor,moeda,ativo').eq('work_order_id', id).eq('ativo', true);
    if (supsError) throw supsError;
    const suplementadoUsd = (sups || []).filter((sup) => normalizeUpper(sup.moeda || 'USD') === 'USD').reduce((acc, sup) => acc + toNumber(sup.valor), 0);
    const anterior = toNumber(wo.valor_total_usd) || toNumber(wo.valor_total);
    let novoAlvo = req.body.valor_alvo_usd !== undefined ? toNumber(req.body.valor_alvo_usd) : anterior;
    if (marcarTotal) {
      if (suplementadoUsd <= 0) return res.status(400).json({ status: 'error', message: 'Não há suplementação USD ativa para encerrar como totalmente suplementada.' });
      novoAlvo = suplementadoUsd;
    }
    if (novoAlvo < 0) return res.status(400).json({ status: 'error', message: 'Valor alvo USD inválido.' });
    if (Math.abs(novoAlvo - anterior) > 0.005 && !motivo) return res.status(400).json({ status: 'error', message: 'Informe o motivo da alteração do valor alvo USD.' });
    const { data, error } = await supabase.from('work_orders').update({ valor_total_usd: novoAlvo, valor_total: novoAlvo, moeda: 'USD', updated_at: new Date().toISOString() }).eq('id', id).select('*, work_order_suplementacoes(*)').single();
    if (error) throw error;
    const equipmentTrace = await safeSyncWorkOrderLedger(data, req);
    await auditCompra(req, marcarTotal ? 'WO_SUPLEMENTACAO_ENCERRADA' : 'WO_VALOR_ALVO_USD_AJUSTADO', 'WO', wo.numero_wo || id, marcarTotal ? `WO ${wo.numero_wo || id} marcada como totalmente suplementada por ajuste auditável do alvo USD.` : `Valor alvo USD da WO ${wo.numero_wo || id} ajustado.`, { valor_alvo_usd_anterior: anterior, valor_alvo_usd_novo: novoAlvo, suplementado_usd: suplementadoUsd, motivo, equipment_trace: equipmentTrace?.status || null });
    return res.status(200).json({ status: 'success', message: marcarTotal ? 'WO marcada como totalmente suplementada.' : 'Valor alvo USD da WO atualizado com auditoria.', data, suplementado_usd: suplementadoUsd, equipment_trace: equipmentTrace });
  } catch (error) {
    console.error('[SISHA][compras] atualizarControleSuplementacaoWorkOrder:', error);
    return res.status(500).json({ status: 'error', message: error.message || 'Falha ao atualizar controle de suplementação da WO.' });
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
    const numerosWo = payload.map((item) => item.numero_wo).filter(Boolean);
    const persisted = [];
    for (let i = 0; i < numerosWo.length; i += 200) {
      const { data: page, error: pageError } = await supabase
        .from('work_orders')
        .select('*, work_order_suplementacoes(*)')
        .in('numero_wo', numerosWo.slice(i, i + 200));
      if (pageError) throw pageError;
      persisted.push(...(page || []));
    }
    const ledger = await workOrderEquipmentService.syncWorkOrdersBatch(persisted, { email: req.user?.email || req.user?.sub || null, role: req.user?.role || null }, { concurrency: 8 });
    await auditCompra(req, 'WO_IMPORTADA_LOTE', 'WO', 'EXPORT_WO', `${payload.length} WO(s) importadas/atualizadas.`, { linhas_lidas: rows.length, importadas: payload.length, livro_equipamentos: ledger.summary });
    return res.status(200).json({ status: 'success', message: `${payload.length} WO(s) importadas/atualizadas. SN manual preservado quando o relatório vier vazio.`, data: { linhas_lidas: rows.length, importadas: payload.length, livro_equipamentos: ledger.summary }, equipment_trace: ledger });
  } catch (error) {
    console.error('[SISHA][compras] importarWorkOrders:', error);
    return res.status(500).json({ status: 'error', message: 'Falha ao importar relatório de WO.' });
  }
};

exports.sincronizarWorkOrdersComEquipamentos = async (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    const result = await workOrderEquipmentService.syncExistingWorkOrdersToEquipment({
      email: req.user?.email || req.user?.sub || null,
      role: req.user?.role || null,
    });
    await auditCompra(req, 'WO_LIVRO_EQUIPAMENTOS_SINCRONIZADO', 'WO', 'ALL', 'WOs locais sincronizadas com o Livro de Eventos dos Equipamentos.', { summary: result.summary, total: result.total });
    return res.status(200).json({
      status: 'success',
      message: 'Sincronização WO → Livro de Equipamentos concluída. Registros sem SN ou sem PN+SN no Cadastro Mestre foram preservados como pendências, sem inventar vínculos.',
      data: result,
    });
  } catch (error) {
    console.error('[SISHA][compras] sincronizarWorkOrdersComEquipamentos:', error);
    return res.status(500).json({ status: 'error', message: error.message || 'Falha ao sincronizar WOs com o Livro de Equipamentos.' });
  }
};
