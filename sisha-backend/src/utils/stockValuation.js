const supabase = require('../config/supabaseClient');

const PAGE_SIZE = 1000;

function normalizePn(value = '') {
  return String(value || '').trim().toUpperCase();
}

async function fetchAllRows(table, columns, pageSize = PAGE_SIZE) {
  let allRows = [];
  let from = 0;

  while (true) {
    const to = from + pageSize - 1;
    const { data, error } = await supabase
      .from(table)
      .select(columns)
      .range(from, to);

    if (error) throw error;
    if (!data || data.length === 0) break;

    allRows = allRows.concat(data);
    if (data.length < pageSize) break;
    from += pageSize;
  }

  return allRows;
}

function parseRfQEndDate(validade) {
  const text = String(validade || '').trim();
  if (!text) return null;
  const matches = [...text.matchAll(/(\d{2}\/\d{2}\/\d{4})/g)].map((match) => match[1]);
  if (!matches.length) return null;
  const [dia, mes, ano] = matches[matches.length - 1].split('/');
  const date = new Date(`${ano}-${mes}-${dia}T00:00:00Z`);
  return Number.isNaN(date.getTime()) ? null : date;
}

async function computeStockValuationFallback() {
  const today = new Date();
  const [ppuRows, priceListRows, rfqRows] = await Promise.all([
    fetchAllRows('estoque_ppu', 'pn, quantidade'),
    fetchAllRows('price_list', 'pn, valor_unitario'),
    fetchAllRows('rfq_cotacoes', 'pn, valor_unitario, validade').catch(() => []),
  ]);

  const receiptRows = await fetchAllRows('recebimento_itens', 'pn, valor_unitario, created_at')
    .catch(() => []);

  const qtyByPn = new Map();
  ppuRows.forEach((row) => {
    const pn = normalizePn(row.pn);
    if (!pn) return;
    qtyByPn.set(pn, (qtyByPn.get(pn) || 0) + (Number(row.quantidade) || 0));
  });

  const latestReceiptPriceByPn = new Map();
  receiptRows
    .filter((row) => Number(row.valor_unitario) > 0)
    .sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0))
    .forEach((row) => {
      const pn = normalizePn(row.pn);
      if (!pn || latestReceiptPriceByPn.has(pn)) return;
      latestReceiptPriceByPn.set(pn, Number(row.valor_unitario));
    });

  const validRfqPriceByPn = new Map();
  rfqRows
    .filter((row) => Number(row.valor_unitario) > 0)
    .map((row) => ({ ...row, endDate: parseRfQEndDate(row.validade) }))
    .filter((row) => row.endDate && row.endDate >= today)
    .sort((a, b) => b.endDate - a.endDate)
    .forEach((row) => {
      const pn = normalizePn(row.pn);
      if (!pn || validRfqPriceByPn.has(pn)) return;
      validRfqPriceByPn.set(pn, Number(row.valor_unitario));
    });

  const priceListByPn = new Map();
  priceListRows
    .filter((row) => Number(row.valor_unitario) > 0)
    .forEach((row) => {
      const pn = normalizePn(row.pn);
      if (!pn || priceListByPn.has(pn)) return;
      priceListByPn.set(pn, Number(row.valor_unitario));
    });

  let estoqueValorizado = 0;
  let pnsValorizados = 0;

  for (const [pn, quantidade] of qtyByPn.entries()) {
    const price = latestReceiptPriceByPn.get(pn) ?? validRfqPriceByPn.get(pn) ?? priceListByPn.get(pn) ?? null;
    if (price == null) continue;
    estoqueValorizado += quantidade * price;
    pnsValorizados += 1;
  }

  return {
    estoqueValorizado: Number(estoqueValorizado.toFixed(2)),
    pnsValorizados,
  };
}

module.exports = {
  fetchAllRows,
  normalizePn,
  computeStockValuationFallback,
};
