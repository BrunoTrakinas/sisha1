const supabase = require('../config/supabaseClient');
const { loadReferencePriceMap } = require('../services/pricingService');
const { loadAllEffectivePpuRows } = require('../services/ppuEffectiveAvailabilityService');

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

async function computeStockValuationFallback() {
  const [ppuRows, priceMap] = await Promise.all([
    loadAllEffectivePpuRows(),
    loadReferencePriceMap(),
  ]);

  const qtyByPn = new Map();
  ppuRows.forEach((row) => {
    const pn = normalizePn(row.pn);
    if (!pn) return;
    qtyByPn.set(pn, (qtyByPn.get(pn) || 0) + (Number(row.quantidade) || 0));
  });

  let estoqueValorizado = 0;
  let pnsValorizados = 0;

  for (const [pn, quantidade] of qtyByPn.entries()) {
    const reference = priceMap.get(pn);
    const price = Number(reference?.valor_unitario_gbp ?? reference?.valor_unitario);
    if (!Number.isFinite(price) || price <= 0) continue;
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
