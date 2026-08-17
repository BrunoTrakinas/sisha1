const xlsx = require('xlsx');
const supabase = require('../config/supabaseClient');

function normalizePn(value = '') {
  return String(value || '').trim().toUpperCase();
}

function safeString(value) {
  const text = value == null ? '' : String(value).trim();
  return text || '';
}

function numberValue(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function makeRequestRef() {
  const now = new Date();
  const stamp = now.toISOString().replace(/[-:TZ.]/g, '').slice(0, 17);
  const entropy = Math.random().toString(36).slice(2, 6).toUpperCase();
  return `COT-${stamp}-${entropy}`;
}

function uniqueManualFamilies(rows = []) {
  const seen = new Map();
  rows.forEach((row) => {
    const dmc = safeString(row.dmc);
    const item = safeString(row.item_num);
    if (!dmc || !item) return;
    const key = `${dmc}|${item}`;
    if (!seen.has(key)) seen.set(key, row);
    if (String(row.sub_item || '').trim().toUpperCase() === '00A') seen.set(key, row);
  });
  return Array.from(seen.values());
}

async function loadDictionaryRows(pns = []) {
  if (!pns.length) return [];
  const chunks = [];
  for (let index = 0; index < pns.length; index += 200) chunks.push(pns.slice(index, index + 200));
  let rows = [];
  for (const chunk of chunks) {
    const { data, error } = await supabase
      .from('dicionario_mestre')
      .select('pn,dmc,item_num,sub_item,nsn,pi,nomenclatura,techname')
      .in('pn', chunk);
    if (error) throw error;
    rows = rows.concat(data || []);
  }
  return rows;
}


async function loadTechnicalManualRows(pns = []) {
  if (!pns.length) return [];
  const chunks = [];
  for (let index = 0; index < pns.length; index += 200) chunks.push(pns.slice(index, index + 200));
  let rows = [];
  for (const chunk of chunks) {
    try {
      const { data, error } = await supabase
        .from('v_sisha_manual_pn_aplicacao')
        .select('pn,manual_codigo,tipo_manual,fig,item,nomenclatura,units_per_assy,usage_code,manual_id')
        .in('pn', chunk);
      if (error) throw error;
      rows = rows.concat(data || []);
    } catch (_) {
      // 28.12 é compatível com bancos ainda sem a view até o SQL ser aplicado.
    }
  }
  return rows;
}

async function loadPendingRequests(pns = []) {
  if (!pns.length) return [];
  try {
    const { data, error } = await supabase
      .from('cotacao_solicitacao_itens')
      .select('pn,solicitacao_ref,status,created_at,qtd,origem_tela')
      .in('pn', pns)
      .eq('status', 'AGUARDANDO_RESPOSTA')
      .order('created_at', { ascending: false });
    if (error) throw error;
    return data || [];
  } catch (_) {
    return [];
  }
}

async function prepareQuoteRequestItems(items = []) {
  const normalized = (items || [])
    .map((item) => ({
      pn: normalizePn(item.pn),
      nsn: safeString(item.nsn),
      nomenclatura: safeString(item.nomenclatura),
      qtd: Math.max(0, numberValue(item.qtd ?? item.quantidade ?? item.quantidade_total ?? item.faltam, 0)),
      manual: safeString(item.manual),
      fig: safeString(item.fig),
      item: safeString(item.item),
      codemp: safeString(item.codemp),
    }))
    .filter((item) => item.pn && item.qtd > 0);

  const pns = Array.from(new Set(normalized.map((item) => item.pn)));
  const [dictionaryRows, technicalManualRows, pendingRows] = await Promise.all([
    loadDictionaryRows(pns),
    loadTechnicalManualRows(pns),
    loadPendingRequests(pns),
  ]);

  const dictionaryByPn = new Map();
  dictionaryRows.forEach((row) => {
    const pn = normalizePn(row.pn);
    if (!dictionaryByPn.has(pn)) dictionaryByPn.set(pn, []);
    dictionaryByPn.get(pn).push(row);
  });

  const technicalByPn = new Map();
  technicalManualRows.forEach((row) => {
    const pn = normalizePn(row.pn);
    if (!technicalByPn.has(pn)) technicalByPn.set(pn, []);
    technicalByPn.get(pn).push(row);
  });

  const pendingByPn = new Map();
  pendingRows.forEach((row) => {
    const pn = normalizePn(row.pn);
    if (!pendingByPn.has(pn)) pendingByPn.set(pn, row);
  });

  return normalized.map((item) => {
    const dictionary = dictionaryByPn.get(item.pn) || [];
    const families = uniqueManualFamilies(dictionary);
    const chosen = families.length === 1 ? families[0] : null;
    const preferredName = item.nomenclatura || safeString(chosen?.nomenclatura) || safeString(dictionary[0]?.nomenclatura);
    const preferredNsn = item.nsn || safeString(chosen?.nsn) || safeString(dictionary[0]?.nsn);
    const technical = technicalByPn.get(item.pn) || [];
    const uniqueTechnical = Array.from(new Map(technical.map((row) => [`${row.manual_codigo}|${row.fig || ''}|${row.item || ''}`, row])).values());
    const technicalChosen = uniqueTechnical.length === 1 ? uniqueTechnical[0] : null;
    const useTechnical = !item.manual && !chosen && technicalChosen;
    const pending = pendingByPn.get(item.pn) || null;

    return {
      nomenclatura: preferredName || safeString(technicalChosen?.nomenclatura),
      pn: item.pn,
      nsn: preferredNsn,
      manual: item.manual || (chosen?.dmc ? `CIETP ${String(chosen.dmc).trim()}` : (useTechnical ? safeString(technicalChosen.manual_codigo) : '')),
      fig: item.fig || (chosen ? '1' : (useTechnical ? safeString(technicalChosen.fig) || '1' : '')),
      item: item.item || safeString(chosen?.item_num) || (useTechnical ? safeString(technicalChosen.item) : ''),
      codemp: item.codemp || '',
      qtd: item.qtd,
      manual_aviso: families.length > 1
        ? `${families.length} aplicações CIETP encontradas para este PN. Confirme MANUAL/ITEM antes de exportar.`
        : (!chosen && uniqueTechnical.length > 1
          ? `${uniqueTechnical.length} aplicações em WTP/manuais técnicos encontradas. Confirme MANUAL/FIG/ITEM antes de exportar.`
          : ''),
      solicitado_anteriormente: Boolean(pending),
      solicitacao_anterior_ref: pending?.solicitacao_ref || null,
      solicitacao_anterior_em: pending?.created_at || null,
      solicitacao_anterior_qtd: pending?.qtd ?? null,
    };
  });
}

function buildWorkbook(items = []) {
  const workbook = xlsx.utils.book_new();
  const rows = [
    ['MARINHA DO BRASIL', '', '', '', '', '', '', ''],
    ['1º ESQUADRÃO DE HELICÓPTEROS DE ESCLARECIMENTO E ATAQUE', '', '', '', '', '', '', ''],
    ['SOLICITAÇÃO DE COTAÇÃO', '', '', '', '', '', '', ''],
    ['', '', '', '', '', '', '', ''],
    ['ITEM(NOMENCLATURA)', 'P/N', 'NSN', 'MANUAL', 'FIG', 'ITEM', 'CODEMP', 'QTD'],
    ...items.map((item) => [
      safeString(item.nomenclatura).toUpperCase(),
      normalizePn(item.pn),
      safeString(item.nsn),
      safeString(item.manual).toUpperCase(),
      safeString(item.fig) || '1',
      safeString(item.item).toUpperCase(),
      safeString(item.codemp).toUpperCase(),
      numberValue(item.qtd, 0),
    ]),
  ];

  const sheet = xlsx.utils.aoa_to_sheet(rows);
  sheet['!merges'] = [
    { s: { r: 0, c: 0 }, e: { r: 0, c: 7 } },
    { s: { r: 1, c: 0 }, e: { r: 1, c: 7 } },
    { s: { r: 2, c: 0 }, e: { r: 2, c: 7 } },
  ];
  sheet['!cols'] = [
    { wch: 36 }, { wch: 24 }, { wch: 22 }, { wch: 24 },
    { wch: 8 }, { wch: 12 }, { wch: 14 }, { wch: 9 },
  ];
  sheet['!rows'] = [
    { hpt: 22 }, { hpt: 22 }, { hpt: 24 }, { hpt: 8 }, { hpt: 22 },
  ];
  xlsx.utils.book_append_sheet(workbook, sheet, 'SOLICITACAO_COTACAO');
  return workbook;
}

async function recordRequestItems({ ref, source, items, user }) {
  const payload = items.map((item) => ({
    solicitacao_ref: ref,
    origem_tela: String(source || 'SISHA').trim().toUpperCase(),
    pn: normalizePn(item.pn),
    nsn: safeString(item.nsn) || null,
    nomenclatura: safeString(item.nomenclatura) || null,
    manual: safeString(item.manual) || null,
    fig: safeString(item.fig) || '1',
    item_manual: safeString(item.item) || null,
    codemp: safeString(item.codemp) || null,
    qtd: Math.max(0, numberValue(item.qtd, 0)),
    status: 'AGUARDANDO_RESPOSTA',
    created_by_email: user?.email || null,
    created_by_role: user?.role || null,
  })).filter((item) => item.pn && item.qtd > 0);

  if (!payload.length) return;
  const { error } = await supabase.from('cotacao_solicitacao_itens').insert(payload);
  if (error) throw error;
}

async function exportQuoteRequest({ items = [], source = 'SISHA', user = null }) {
  const prepared = await prepareQuoteRequestItems(items);
  if (!prepared.length) {
    const error = new Error('Nenhum item sem preço vigente ou com referência vencida/histórica foi informado para a solicitação de cotação.');
    error.statusCode = 400;
    throw error;
  }

  const ref = makeRequestRef();
  await recordRequestItems({ ref, source, items: prepared, user });
  const workbook = buildWorkbook(prepared);
  const buffer = xlsx.write(workbook, { type: 'buffer', bookType: 'xlsx' });
  return {
    ref,
    buffer,
    filename: `solicitacao_cotacao_${ref}.xlsx`,
    items: prepared,
  };
}

async function markRequestsAnswered({ pns = [], quotationNumber = null }) {
  const normalized = Array.from(new Set((pns || []).map(normalizePn).filter(Boolean)));
  if (!normalized.length) return;
  try {
    await supabase
      .from('cotacao_solicitacao_itens')
      .update({
        status: 'RESPONDIDA',
        respondida_cotacao_numero: quotationNumber || null,
        respondida_em: new Date().toISOString(),
      })
      .in('pn', normalized)
      .eq('status', 'AGUARDANDO_RESPOSTA');
  } catch (_) {
    // O histórico de solicitação é auxiliar e nunca deve impedir o salvamento da RFQ.
  }
}

module.exports = {
  prepareQuoteRequestItems,
  exportQuoteRequest,
  markRequestsAnswered,
};
