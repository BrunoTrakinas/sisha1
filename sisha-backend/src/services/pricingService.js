let supabaseClient = null;

function getSupabaseClient() {
  if (!supabaseClient) supabaseClient = require('../config/supabaseClient');
  return supabaseClient;
}

const PAGE_SIZE = 1000;

function normalizePn(value = '') {
  return String(value || '').trim().toUpperCase();
}

function toNumber(value) {
  const num = Number(value);
  return Number.isFinite(num) ? num : 0;
}

function parseFlexibleDate(value) {
  const text = String(value || '').trim();
  if (!text) return null;

  const iso = text.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (iso) {
    const [, year, month, day] = iso;
    const date = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
    return Number.isNaN(date.getTime()) ? null : date;
  }

  const br = text.match(/(\d{1,2})[./-](\d{1,2})[./-](\d{4})/);
  if (br) {
    const [, day, month, year] = br;
    const date = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
    return Number.isNaN(date.getTime()) ? null : date;
  }

  const parsed = new Date(text);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function parseRfqValidityEnd(value) {
  const text = String(value || '').trim();
  if (!text) return null;
  const matches = [...text.matchAll(/(\d{1,4}[./-]\d{1,2}[./-]\d{1,4})/g)].map((match) => match[1]);
  if (!matches.length) return parseFlexibleDate(text);
  return parseFlexibleDate(matches[matches.length - 1]);
}

function addUtcDays(date, days) {
  if (!date || !Number.isFinite(Number(days))) return null;
  const copy = new Date(date.getTime());
  copy.setUTCDate(copy.getUTCDate() + Number(days));
  return copy;
}

function addUtcMonths(date, months) {
  if (!date || !Number.isFinite(Number(months))) return null;
  const copy = new Date(date.getTime());
  copy.setUTCMonth(copy.getUTCMonth() + Number(months));
  return copy;
}

function resolveRfqValidityEnd(row = {}) {
  const explicit = parseRfqValidityEnd(row.validade);
  if (explicit) return explicit;

  const text = String(row.validade || '').trim().toUpperCase();
  if (!text) return null;
  const base = parseFlexibleDate(row.data_cotacao) || parseFlexibleDate(row.data_insercao) || parseFlexibleDate(row.updated_at);
  if (!base) return null;

  const days = text.match(/(\d+)\s*(?:DIA|DIAS|DAY|DAYS)\b/);
  if (days) return addUtcDays(base, Number(days[1]));

  const weeks = text.match(/(\d+)\s*(?:SEMANA|SEMANAS|WEEK|WEEKS)\b/);
  if (weeks) return addUtcDays(base, Number(weeks[1]) * 7);

  const months = text.match(/(\d+)\s*(?:MES|MESES|MÊS|MONTH|MONTHS)\b/);
  if (months) return addUtcMonths(base, Number(months[1]));

  return null;
}

function startOfUtcDay(value = new Date()) {
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (Number.isNaN(date.getTime())) return startOfUtcDay(new Date());
  date.setUTCHours(0, 0, 0, 0);
  return date;
}

async function fetchAllRows(table, columns = '*', pageSize = PAGE_SIZE) {
  let rows = [];
  let from = 0;
  while (true) {
    const to = from + pageSize - 1;
    const { data, error } = await getSupabaseClient().from(table).select(columns).range(from, to);
    if (error) throw error;
    if (!data?.length) break;
    rows = rows.concat(data);
    if (data.length < pageSize) break;
    from += pageSize;
  }
  return rows;
}

function buildReferencePriceMap(rows = []) {
  const map = new Map();
  rows.forEach((row) => {
    const pn = normalizePn(row.pn);
    const value = toNumber(row.valor_unitario_gbp ?? row.valor_unitario);
    if (!pn || value <= 0 || map.has(pn)) return;
    map.set(pn, {
      pn,
      valor_unitario: value,
      valor_unitario_gbp: value,
      moeda: row.moeda || 'GBP',
      fonte: row.fonte_preco || row.fonte || null,
      fonte_preco: row.fonte_preco || row.fonte || null,
      fonte_exibicao: row.fonte_exibicao || row.fonte_preco || row.fonte || null,
      prioridade: Number(row.prioridade || 0) || null,
      documento_fonte: row.documento_fonte || null,
      data_referencia: row.data_referencia || null,
      validade: row.validade || null,
      vigente: row.vigente ?? null,
      estimativa: Boolean(row.estimativa),
      necessita_cotacao: Boolean(row.necessita_cotacao),
      status_preco: row.status_preco || null,
      nomenclatura: row.nomenclatura || null,
      nsn: row.nsn || null,
      lead_time: row.lead_time ?? row.lead_time_dias ?? null,
      moq: row.moq ?? row.qtd_solicitada ?? null,
    });
  });
  return map;
}

function latestByPn(rows = [], dateGetter) {
  const sorted = [...rows].sort((a, b) => {
    const aDate = dateGetter(a);
    const bDate = dateGetter(b);
    return (bDate?.getTime?.() || 0) - (aDate?.getTime?.() || 0);
  });

  const map = new Map();
  sorted.forEach((row) => {
    const pn = normalizePn(row.pn);
    if (!pn || map.has(pn) || toNumber(row.valor_unitario ?? row.valor_unitario_gbp) <= 0) return;
    map.set(pn, row);
  });
  return map;
}

function officialViewRows(viewRows = []) {
  const officialSources = new Set(['CARTA', 'CARTA_OFICIAL', 'CARTA OFICIAL', 'OFFICIAL_LETTER']);
  return (viewRows || []).filter((row) => {
    const source = String(row.fonte_preco || row.fonte || '').trim().toUpperCase();
    return officialSources.has(source) && row.vigente !== false && toNumber(row.valor_unitario_gbp ?? row.valor_unitario) > 0;
  });
}

function buildReferencePriceRows({
  priceListRows = [],
  rfqRows = [],
  receiptRows = [],
  receiptHeaderRows = [],
  viewRows = [],
  now = new Date(),
} = {}) {
  const references = new Map();
  const today = startOfUtcDay(now);

  // PRIORIDADE 1A — PRICE LIST oficial atual. A importação substitui a lista oficial vigente.
  priceListRows.forEach((row) => {
    const pn = normalizePn(row.pn);
    const value = toNumber(row.valor_unitario);
    if (!pn || value <= 0 || references.has(pn)) return;
    references.set(pn, {
      pn,
      valor_unitario_gbp: value,
      moeda: row.moeda || 'GBP',
      fonte_preco: 'PRICE_LIST',
      fonte_exibicao: 'PRICE LIST',
      prioridade: 1,
      documento_fonte: row.documento_fonte || 'PRICE LIST',
      data_referencia: row.updated_at || null,
      validade: row.validade || null,
      vigente: true,
      estimativa: false,
      necessita_cotacao: false,
      status_preco: 'OFICIAL_VIGENTE',
      nomenclatura: row.nomenclatura || null,
      nsn: row.nsn || null,
      lead_time: row.lead_time || null,
      moq: row.moq || null,
    });
  });

  // PRIORIDADE 1B — cartas oficiais eventualmente já estruturadas pela view do banco.
  officialViewRows(viewRows)
    .sort((a, b) => Number(a.prioridade || 1) - Number(b.prioridade || 1))
    .forEach((row) => {
      const pn = normalizePn(row.pn);
      if (!pn || references.has(pn)) return;
      references.set(pn, {
        ...row,
        pn,
        valor_unitario_gbp: toNumber(row.valor_unitario_gbp ?? row.valor_unitario),
        moeda: row.moeda || 'GBP',
        fonte_preco: row.fonte_preco || row.fonte || 'CARTA_OFICIAL',
        fonte_exibicao: row.fonte_exibicao || row.fonte_preco || row.fonte || 'CARTA OFICIAL',
        prioridade: 1,
        vigente: true,
        estimativa: false,
        necessita_cotacao: false,
        status_preco: 'OFICIAL_VIGENTE',
      });
    });

  const eligibleRfqRows = (rfqRows || []).filter((row) => {
    if (row.ativo === false) return false;
    if (String(row.tipo_cotacao || 'MATERIAL').trim().toUpperCase() !== 'MATERIAL') return false;
    if (String(row.match_mode || 'EXACT').trim().toUpperCase() === 'PATTERN') return false;
    // Preço one-time é evidência documental condicionada e não vira referência automática
    // sem controle explícito de consumo da condição/PO.
    if (row.one_time_only === true) return false;
    const moeda = String(row.moeda || 'GBP').trim().toUpperCase();
    if (moeda !== 'GBP') return false;
    return toNumber(row.valor_unitario) > 0;
  });

  const currentRfqRows = eligibleRfqRows.filter((row) => {
    const end = resolveRfqValidityEnd(row);
    return Boolean(end) && startOfUtcDay(end) >= today;
  });
  const latestCurrentRfq = latestByPn(currentRfqRows, (row) => parseFlexibleDate(row.data_cotacao) || parseFlexibleDate(row.data_insercao));
  latestCurrentRfq.forEach((row, pn) => {
    if (references.has(pn)) return;
    const end = resolveRfqValidityEnd(row);
    references.set(pn, {
      pn,
      valor_unitario_gbp: toNumber(row.valor_unitario),
      moeda: row.moeda || 'GBP',
      fonte_preco: 'RFQ',
      fonte_exibicao: 'COTAÇÃO VÁLIDA',
      prioridade: 2,
      documento_fonte: row.cotacao_numero ? `RFQ ${row.cotacao_numero}` : 'RFQ',
      data_referencia: parseFlexibleDate(row.data_cotacao)?.toISOString().slice(0, 10) || row.data_insercao || null,
      validade: row.validade || null,
      vigente: true,
      estimativa: false,
      necessita_cotacao: false,
      status_preco: 'COTACAO_VALIDA',
      nomenclatura: row.nomenclatura || null,
      nsn: row.nsn || null,
      lead_time: row.lead_time_dias || null,
      moq: row.qtd_solicitada || null,
    });
  });

  // PRIORIDADE 3 — cotação vencida mais recente. Serve como estimativa e continua elegível a nova cotação.
  const expiredRfqRows = eligibleRfqRows.filter((row) => {
    const end = resolveRfqValidityEnd(row);
    return Boolean(end) && startOfUtcDay(end) < today;
  });
  const latestExpiredRfq = latestByPn(expiredRfqRows, (row) => parseFlexibleDate(row.data_cotacao) || parseFlexibleDate(row.data_insercao));
  latestExpiredRfq.forEach((row, pn) => {
    if (references.has(pn)) return;
    references.set(pn, {
      pn,
      valor_unitario_gbp: toNumber(row.valor_unitario),
      moeda: row.moeda || 'GBP',
      fonte_preco: 'RFQ_VENCIDA',
      fonte_exibicao: 'COTAÇÃO VENCIDA',
      prioridade: 3,
      documento_fonte: row.cotacao_numero ? `RFQ ${row.cotacao_numero}` : 'RFQ',
      data_referencia: parseFlexibleDate(row.data_cotacao)?.toISOString().slice(0, 10) || row.data_insercao || null,
      validade: row.validade || null,
      vigente: false,
      estimativa: true,
      necessita_cotacao: true,
      status_preco: 'ESTIMATIVA_COTACAO_VENCIDA',
      nomenclatura: row.nomenclatura || null,
      nsn: row.nsn || null,
      lead_time: row.lead_time_dias || null,
      moq: row.qtd_solicitada || null,
    });
  });

  // PRIORIDADE 4 — recibo mais recente pela data documental do recebimento.
  const headerMap = new Map((receiptHeaderRows || []).map((row) => [String(row.id), row]));
  const receiptWithDate = (receiptRows || []).map((row) => {
    const header = headerMap.get(String(row.recebimento_id)) || {};
    return {
      ...row,
      _receipt_date: header.data_recebimento || header.created_at || row.created_at || null,
      _receipt_number: header.numero_recibo || row.recebimento_id || null,
      _receipt_active: header.ativo,
    };
  }).filter((row) => row._receipt_active !== false && String(row.moeda || 'GBP').trim().toUpperCase() === 'GBP');

  const latestReceipt = latestByPn(receiptWithDate, (row) => parseFlexibleDate(row._receipt_date));
  latestReceipt.forEach((row, pn) => {
    if (references.has(pn)) return;
    references.set(pn, {
      pn,
      valor_unitario_gbp: toNumber(row.valor_unitario),
      moeda: row.moeda || 'GBP',
      fonte_preco: 'RECIBO',
      fonte_exibicao: 'RECIBO HISTÓRICO',
      prioridade: 4,
      documento_fonte: row._receipt_number ? `RECIBO ${row._receipt_number}` : 'RECIBO',
      data_referencia: row._receipt_date || null,
      validade: null,
      vigente: false,
      estimativa: true,
      necessita_cotacao: true,
      status_preco: 'ESTIMATIVA_RECIBO',
      nomenclatura: row.nomenclatura || null,
      nsn: row.nsn_pi || null,
      lead_time: null,
      moq: null,
    });
  });

  return Array.from(references.values()).sort((a, b) => a.pn.localeCompare(b.pn));
}

async function loadReferencePriceRows() {
  const [priceListResult, rfqResult, receiptResult, receiptHeaderResult, viewResult] = await Promise.allSettled([
    fetchAllRows('price_list', 'pn,valor_unitario,nomenclatura,nsn,lead_time,moq,validade,updated_at'),
    fetchAllRows('rfq_cotacoes', '*'),
    fetchAllRows('recebimento_itens', 'pn,valor_unitario,moeda,nomenclatura,nsn_pi,recebimento_id,created_at'),
    fetchAllRows('recebimentos', 'id,numero_recibo,data_recebimento,created_at,ativo'),
    fetchAllRows('v_sisha_preco_referencia', 'pn,valor_unitario_gbp,moeda,fonte_preco,prioridade,documento_fonte,data_referencia,validade,vigente,nomenclatura,nsn,lead_time,moq'),
  ]);

  const value = (result) => result.status === 'fulfilled' ? (result.value || []) : [];
  const sourceRows = buildReferencePriceRows({
    priceListRows: value(priceListResult),
    rfqRows: value(rfqResult),
    receiptRows: value(receiptResult),
    receiptHeaderRows: value(receiptHeaderResult),
    viewRows: value(viewResult),
  });

  if (sourceRows.length) return sourceRows;

  // Fallback de contingência: se as tabelas-fonte estiverem indisponíveis, preserva a view existente.
  return value(viewResult).map((row) => ({
    ...row,
    estimativa: row.vigente === false,
    necessita_cotacao: row.vigente === false,
    status_preco: row.vigente === false ? 'ESTIMATIVA_FALLBACK' : 'REFERENCIA_VIGENTE',
    fonte_exibicao: row.fonte_preco || null,
  }));
}

async function loadReferencePriceMap() {
  const rows = await loadReferencePriceRows();
  return buildReferencePriceMap(rows);
}

module.exports = {
  normalizePn,
  toNumber,
  parseFlexibleDate,
  parseRfqValidityEnd,
  resolveRfqValidityEnd,
  buildReferencePriceRows,
  loadReferencePriceRows,
  loadReferencePriceMap,
  buildReferencePriceMap,
};
