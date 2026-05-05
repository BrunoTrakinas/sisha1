const xlsx = require('xlsx');
const supabase = require('../config/supabaseClient');
const { normalizePn } = require('../utils/importAliases');

const PAGE_SIZE = 1000;
const ANV_CODES = ['4001', '4003', '4004', '4005', '4010', '4012'];
const OFICINA_MAP = {
  HV: 'OFICINA DE HV',
  MV: 'OFICINA DE MV',
  SV: 'OFICINA DE SV',
  VN: 'OFICINA DE VN',
  PA: 'OFICINA DE PA',
  MT: 'MANUTENÇÃO',
};
const ORIGEM_ALLOWED_ORDER = [
  { tipo: 'OFICINA', codigo: 'HV', descricao: OFICINA_MAP.HV },
  { tipo: 'OFICINA', codigo: 'MV', descricao: OFICINA_MAP.MV },
  { tipo: 'OFICINA', codigo: 'SV', descricao: OFICINA_MAP.SV },
  { tipo: 'OFICINA', codigo: 'VN', descricao: OFICINA_MAP.VN },
  { tipo: 'OFICINA', codigo: 'PA', descricao: OFICINA_MAP.PA },
  { tipo: 'OFICINA', codigo: 'MT', descricao: OFICINA_MAP.MT },
  { tipo: 'ANV', codigo: '4001', descricao: 'AERONAVE 4001' },
  { tipo: 'ANV', codigo: '4003', descricao: 'AERONAVE 4003' },
  { tipo: 'ANV', codigo: '4004', descricao: 'AERONAVE 4004' },
  { tipo: 'ANV', codigo: '4005', descricao: 'AERONAVE 4005' },
  { tipo: 'ANV', codigo: '4010', descricao: 'AERONAVE 4010' },
  { tipo: 'ANV', codigo: '4012', descricao: 'AERONAVE 4012' },
];

const PPU_LOCATIONS_EXCLUDED_FROM_GENERATOR = [
  'WORK ORDER',
  'VN',
  'SV',
  'MV',
  'HV',
  'RECEX',
  'CAIXA',
  'LEONARDO',
  'ITENS DEVOLVIDOS',
  'GRFLINX',
  'GERENCIA',
  'GANM',
  'FLIR',
  'EXTERIOR',
  'DIV',
  'BANCADA',
];

const CONTEXT_TTL_MS = 15000;
const needsCache = {
  full: null,
  fullAt: 0,
  filters: null,
  filtersAt: 0,
};

function invalidateNeedsCache() {
  needsCache.full = null;
  needsCache.fullAt = 0;
  needsCache.filters = null;
  needsCache.filtersAt = 0;
}
const ODC_QTY_CANDIDATES = ['quantidade', 'qtd', 'qtd_pendente', 'qtd_solicitada', 'qty'];
const ODC_PD_CANDIDATES = ['pd', 'documento_referencia'];

function safeString(value) {
  const text = value == null ? '' : String(value).trim();
  return text || null;
}

function normalizeUpper(value) {
  return String(value || '').trim().toUpperCase();
}

function normalizeKey(value) {
  return normalizeUpper(value);
}

function toNumber(value) {
  const num = Number(value);
  return Number.isFinite(num) ? num : 0;
}

function firstExistingKey(obj = {}, candidates = []) {
  return candidates.find((key) => Object.prototype.hasOwnProperty.call(obj, key));
}

async function fetchAllRows(table, columns = '*', pageSize = PAGE_SIZE) {
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

async function fetchOdcRows() {
  try {
    return await fetchAllRows('odc_requests', '*');
  } catch (_) {
    try {
      return await fetchAllRows('pd_odc', '*');
    } catch (_) {
      return [];
    }
  }
}

function parseDateInput(value) {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString().split('T')[0];
  const text = String(value).trim();
  if (!text) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;
  if (/^\d{2}\/\d{2}\/\d{4}$/.test(text)) {
    const [d, m, y] = text.split('/');
    return `${y}-${m}-${d}`;
  }
  const dt = new Date(text);
  if (!Number.isNaN(dt.getTime())) return dt.toISOString().split('T')[0];
  return null;
}

function parseOsOrigem(osVinculada) {
  const raw = normalizeUpper(osVinculada);
  if (!raw) {
    return { origem_tipo: 'OUTROS', origem_codigo: null, origem_descricao: 'SEM OS' };
  }

  const anv = ANV_CODES.find((code) => raw.startsWith(code));
  if (anv) {
    return { origem_tipo: 'ANV', origem_codigo: anv, origem_descricao: `AERONAVE ${anv}` };
  }

  const prefixosOficina = ['HV', 'MV', 'SV', 'VN', 'PA', 'MT'];
  const prefixo = prefixosOficina.find((item) => raw.startsWith(item));
  if (prefixo) {
    return {
      origem_tipo: 'OFICINA',
      origem_codigo: prefixo,
      origem_descricao: OFICINA_MAP[prefixo] || `OFICINA DE ${prefixo}`,
    };
  }

  return { origem_tipo: 'OUTROS', origem_codigo: null, origem_descricao: raw };
}

function resolvePimOrigem(row = {}) {
  const hasOs = !!normalizeUpper(row.os_vinculada);
  if (hasOs) {
    return normalizeOrigemDisplay(parseOsOrigem(row.os_vinculada));
  }

  return normalizeOrigemDisplay({
    origem_tipo: row.origem_tipo,
    origem_codigo: row.origem_codigo,
    origem_descricao: row.origem_descricao,
  });
}

function hydratePimOrigem(row = {}) {
  const origem = resolvePimOrigem(row);
  return {
    ...row,
    origem_tipo: origem.origem_tipo,
    origem_codigo: origem.origem_codigo,
    origem_descricao: origem.origem_descricao,
  };
}

function buildOrigemKey(row = {}) {
  const tipo = normalizeUpper(row.origem_tipo) || 'OUTROS';
  const codigo = normalizeUpper(row.origem_codigo || row.origem_descricao || 'SEM-CODIGO');
  return `${tipo}:${codigo}`;
}

function buildOrigemLabel(row = {}) {
  return row.origem_descricao || row.origem_tipo || 'Sem origem';
}

function isSupportedOrigem(row = {}) {
  const origemTipo = normalizeUpper(row.origem_tipo);
  const origemCodigo = normalizeUpper(row.origem_codigo);
  if (origemTipo === 'ANV') return ANV_CODES.includes(origemCodigo);
  if (origemTipo === 'OFICINA') return Object.prototype.hasOwnProperty.call(OFICINA_MAP, origemCodigo);
  return false;
}


function normalizeOrigemDisplay(row = {}) {
  const origemTipo = normalizeUpper(row.origem_tipo);
  const origemCodigo = normalizeUpper(row.origem_codigo);

  if (origemTipo === 'OFICINA' || OFICINA_MAP[origemCodigo]) {
    const codigo = origemCodigo || 'OF';
    return {
      origem_tipo: 'OFICINA',
      origem_codigo: codigo,
      origem_descricao: OFICINA_MAP[codigo] || `OFICINA ${codigo}`,
    };
  }

  if (origemTipo === 'ANV' && origemCodigo) {
    return {
      origem_tipo: 'ANV',
      origem_codigo: origemCodigo,
      origem_descricao: `AERONAVE ${origemCodigo}`,
    };
  }

  return {
    origem_tipo: row.origem_tipo || 'OUTROS',
    origem_codigo: row.origem_codigo || null,
    origem_descricao: row.origem_descricao || row.origem_tipo || 'SEM ORIGEM',
  };
}

function shouldExcludePpuLocationFromGenerator(location) {
  const normalized = normalizeUpper(location);
  if (!normalized) return false;
  return PPU_LOCATIONS_EXCLUDED_FROM_GENERATOR.some((prefix) => normalized.startsWith(prefix));
}

function formatWorkbookRows(rows = []) {
  return rows.map((row) => ({
    PN: row.pn,
    NSN: row.nsn || '',
    Nomenclatura: row.nomenclatura || '',
    Necessidade_Total: row.necessidade_total,
    Cobertura_Etapa: row.cobertura_etapa ?? '',
    Saldo_Apos_Etapa: row.saldo_apos_etapa ?? '',
    Receitas: row.receitas_texto || '',
    PIMs: row.pims_texto || '',
    Origens: row.origens_texto || '',
    Observacao: row.observacao || '',
    Documento_Ref: row.documento_referencia || '',
    Valor_Unitario_GBP: row.valor_unitario_gbp ?? '',
    Valor_Total_GBP: row.valor_total_gbp ?? '',
  }));
}

function appendNeed(map, row) {
  const key = normalizeKey(row.pn);
  if (!key) return;

  if (!map.has(key)) {
    map.set(key, {
      pn: key,
      nsn: safeString(row.nsn),
      nomenclatura: safeString(row.nomenclatura) || 'N/A',
      necessidade_total: 0,
      receitas: new Set(),
      pims: new Set(),
      origens: new Set(),
      observacoes: new Set(),
    });
  }

  const current = map.get(key);
  current.necessidade_total += toNumber(row.quantidade);
  if (!current.nsn && row.nsn) current.nsn = safeString(row.nsn);
  if ((!current.nomenclatura || current.nomenclatura === 'N/A') && row.nomenclatura) current.nomenclatura = safeString(row.nomenclatura);
  (row.receitas || []).forEach((item) => item && current.receitas.add(item));
  (row.pims || []).forEach((item) => item && current.pims.add(item));
  (row.origens || []).forEach((item) => item && current.origens.add(item));
  (row.observacoes || []).forEach((item) => item && current.observacoes.add(item));
}

function finalizeNeedRows(map) {
  return Array.from(map.values())
    .map((row) => ({
      pn: row.pn,
      nsn: row.nsn || null,
      nomenclatura: row.nomenclatura || 'N/A',
      necessidade_total: Number(row.necessidade_total.toFixed(2)),
      receitas: Array.from(row.receitas).sort(),
      pims: Array.from(row.pims).sort(),
      origens: Array.from(row.origens).sort(),
      observacoes: Array.from(row.observacoes).sort(),
      receitas_texto: Array.from(row.receitas).sort().join(' | '),
      pims_texto: Array.from(row.pims).sort().join(' | '),
      origens_texto: Array.from(row.origens).sort().join(' | '),
      observacao: Array.from(row.observacoes).sort().join(' | '),
    }))
    .sort((a, b) => a.pn.localeCompare(b.pn));
}

async function buscarPnAlternativoAutomatico(pn) {
  const pnNorm = normalizePn(pn);
  if (!pnNorm) return null;

  try {
    const { data: base } = await supabase
      .from('dicionario_mestre')
      .select('dmc, item_num')
      .eq('pn', pnNorm)
      .limit(1)
      .maybeSingle();

    if (base?.dmc && base?.item_num) {
      const { data: siblings } = await supabase
        .from('dicionario_mestre')
        .select('pn')
        .eq('dmc', base.dmc)
        .eq('item_num', base.item_num);

      const alternativos = [...new Set((siblings || [])
        .map((row) => normalizePn(row.pn))
        .filter((alt) => alt && alt !== pnNorm))];

      if (alternativos.length > 0) {
        return alternativos.join(' | ');
      }
    }
  } catch (_) {}

  try {
    const { data } = await supabase
      .from('pn_equivalencia')
      .select('*')
      .or(`pn.eq.${pnNorm},pn_alt.eq.${pnNorm}`)
      .limit(30);

    const alternativos = [...new Set((data || []).flatMap((row) => [row.pn, row.pn_alt])
      .map((item) => normalizePn(item))
      .filter((alt) => alt && alt !== pnNorm))];

    return alternativos.length > 0 ? alternativos.join(' | ') : null;
  } catch (_) {
    return null;
  }
}


function parseRfQEndDate(validade) {
  const text = String(validade || '').trim();
  if (!text) return null;
  const normalized = text.replace(/\./g, '/');
  const matches = [...normalized.matchAll(/(\d{2}\/\d{2}\/\d{4})/g)].map((match) => match[1]);
  if (!matches.length) return null;
  const [dia, mes, ano] = matches[matches.length - 1].split('/');
  const date = new Date(`${ano}-${mes}-${dia}T00:00:00Z`);
  return Number.isNaN(date.getTime()) ? null : date;
}

function isOpenSbStatus(status) {
  const key = normalizeUpper(status);
  if (!key) return true;
  return !['CONCLUIDA', 'CONCLUÍDA', 'FECHADA', 'FINALIZADA', 'VERDE'].includes(key);
}

function inferSbActionType(header = {}, items = []) {
  const haystack = `${header.titulo || ''} ${header.observacao || ''}`.toUpperCase();
  if (/ALERT|ALERTA|INSPECT|INSPECTION|CHECK/.test(haystack)) return 'INSPEÇÃO';
  if (/REPLACE|CHANGE TO|CHANGE|SUBSTITU/i.test(haystack)) return 'SUBSTITUIÇÃO';
  if (/INTRODUCTION OF MODIFICATION|MODIFICATION|MODIFICAÇÃO|MODIFICACAO/.test(haystack)) return 'MODIFICAÇÃO';
  if (items.length > 0) return 'AÇÃO COM MATERIAL';
  return 'ANÁLISE TÉCNICA';
}

function buildSbShortSummary(header = {}, items = []) {
  const tipo = header.tipo_sb || 'N/A';
  const acao = inferSbActionType(header, items);
  const itensComPn = items.filter((item) => normalizeKey(item.pn)).length;
  const trecho = String(header.observacao || '').replace(/\s+/g, ' ').trim().slice(0, 240);
  const resumoBase = `${header.sb_numero} • ${tipo} • ${acao}`;
  if (trecho) return `${resumoBase}. ${trecho}`;
  if (itensComPn > 0) return `${resumoBase}. ${itensComPn} PN(s) vinculados à SB.`;
  return `${resumoBase}. SB sem lista de PN estruturada.`;
}

function buildSbActions(header = {}, items = [], coverage = []) {
  const actions = [];
  const actionType = inferSbActionType(header, items);
  if (actionType === 'INSPEÇÃO') actions.push('Executar inspeção/cumprimento técnico conforme a SB.');
  if (actionType === 'SUBSTITUIÇÃO') actions.push('Avaliar substituição dos PNs afetados e registrar cumprimento documental.');
  if (actionType === 'MODIFICAÇÃO') actions.push('Planejar a modificação/intervenção e validar aplicabilidade antes da execução.');
  if (items.length > 0) actions.push('Conferir cobertura logística dos itens e abrir compra/cadastro apenas para o saldo não coberto.');
  if (coverage.some((item) => item.precisa_cadastro)) actions.push('Há PN(s) sem referência clara no cadastro/manual; validar necessidade de cadastro técnico.');
  if (coverage.some((item) => item.saldo_pos_cascata > 0)) actions.push('Há saldo pendente após a cascata logística; considerar compra.');
  return [...new Set(actions)];
}

function buildReceitaOptions(receitaRows = [], politicaRows = []) {
  const politicaReceitaMap = new Map();
  (politicaRows || []).forEach((row) => {
    const tipo = normalizeUpper(row.tipo);
    const tarefa = normalizeUpper(row.tarefas);
    if (!tarefa || tipo !== 'RECEITA') return;
    politicaReceitaMap.set(tarefa, row);
  });

  const receitasMap = new Map();
  (receitaRows || []).forEach((row) => {
    const inspecao = String(row.inspecao || '').trim();
    if (!inspecao) return;
    if (!receitasMap.has(inspecao)) receitasMap.set(inspecao, []);
    receitasMap.get(inspecao).push(row);
  });

  return Array.from(receitasMap.entries())
    .map(([inspecao, itens]) => {
      const politica = politicaReceitaMap.get(normalizeUpper(inspecao));
      const prioridade = toNumber(politica?.prioridade);
      const fator = toNumber(politica?.qtde_2_anos) > 0 ? toNumber(politica?.qtde_2_anos) : 1;
      return {
        inspecao,
        total_itens: itens.length,
        prioridade,
        fator_planejado: fator,
        priorizada: prioridade > 0 || fator > 1,
      };
    })
    .sort((a, b) => a.inspecao.localeCompare(b.inspecao));
}

function buildOrigemOptions(pimRows = []) {
  const origemMap = new Map();

  ORIGEM_ALLOWED_ORDER.forEach((item) => {
    const origem = normalizeOrigemDisplay({
      origem_tipo: item.tipo,
      origem_codigo: item.codigo,
      origem_descricao: item.descricao,
    });
    const key = buildOrigemKey(origem);
    origemMap.set(key, {
      key,
      tipo: origem.origem_tipo,
      codigo: origem.origem_codigo,
      descricao: origem.origem_descricao,
      label: buildOrigemLabel(origem),
      total_pims: 0,
    });
  });

  (pimRows || []).forEach((row) => {
    const merged = resolvePimOrigem(row);
    if (!isSupportedOrigem(merged)) return;
    const key = buildOrigemKey(merged);
    if (!origemMap.has(key)) return;
    origemMap.get(key).total_pims += 1;
  });

  return ORIGEM_ALLOWED_ORDER
    .map((item) => {
      const key = buildOrigemKey({ origem_tipo: item.tipo, origem_codigo: item.codigo });
      return origemMap.get(key);
    })
    .filter(Boolean);
}

function buildSbOptions(sbRows = [], sbItemsByNumero = new Map()) {
  return (sbRows || [])
    .map((row) => {
      const itens = sbItemsByNumero.get(row.sb_numero) || [];
      const hasQtdDefinida = itens.some((item) => toNumber(item.qtd) > 0);
      return {
        sb_numero: row.sb_numero,
        titulo: row.titulo || 'Service Bulletin',
        tipo_sb: row.tipo_sb || 'N/A',
        status_acao: row.status_acao || 'SEM_ACAO',
        data_publicacao: row.data_publicacao || null,
        updated_at: row.updated_at || null,
        total_itens: itens.length,
        possui_itens: itens.length > 0,
        qtd_definida: hasQtdDefinida,
        aberta: isOpenSbStatus(row.status_acao),
        resumo_curto: buildSbShortSummary(row, itens),
      };
    })
    .sort((a, b) => String(a.sb_numero || '').localeCompare(String(b.sb_numero || '')));
}

async function loadOptionsContext(force = false) {
  if (!force && needsCache.filters && (Date.now() - needsCache.filtersAt) < CONTEXT_TTL_MS) {
    return needsCache.filters;
  }

  const [receitaRows, politicaRows, pimRows, sbRows, sbItemRows] = await Promise.all([
    fetchAllRows('receita_itens', '*').catch(() => []),
    fetchAllRows('politica_estoque_tarefas', '*').catch(() => []),
    fetchAllRows('pim_demandas', '*').catch(() => []),
    fetchAllRows('service_bulletins', 'sb_numero, titulo, tipo_sb, status_acao, data_publicacao, observacao, fonte_documento, updated_at').catch(() => []),
    fetchAllRows('service_bulletin_items', 'sb_numero, pn, nsn, nomenclatura, qtd, capitulo, item_num, aplicabilidade').catch(() => []),
  ]);

  const sbItemsByNumero = new Map();
  (sbItemRows || []).forEach((row) => {
    const sbNumero = String(row.sb_numero || '').trim();
    if (!sbNumero) return;
    if (!sbItemsByNumero.has(sbNumero)) sbItemsByNumero.set(sbNumero, []);
    sbItemsByNumero.get(sbNumero).push(row);
  });

  const context = {
    receitaOptions: buildReceitaOptions(receitaRows, politicaRows),
    origemOptions: buildOrigemOptions(pimRows),
    sbOptions: buildSbOptions(sbRows, sbItemsByNumero),
    sbRows,
    sbItemsByNumero,
  };

  needsCache.filters = context;
  needsCache.filtersAt = Date.now();
  return context;
}

async function loadGeneratorContext(force = false) {
  if (!force && needsCache.full && (Date.now() - needsCache.fullAt) < CONTEXT_TTL_MS) {
    return needsCache.full;
  }

  const today = new Date();
  const [
    receitaRows,
    politicaRows,
    pimRows,
    ppuRows,
    odaRows,
    odcRows,
    priceRows,
    dicRows,
    ceimspaRows,
    rfqRows,
    receiptRows,
    itemRows,
    sbRows,
    sbItemRows,
  ] = await Promise.all([
    fetchAllRows('receita_itens', '*').catch(() => []),
    fetchAllRows('politica_estoque_tarefas', '*').catch(() => []),
    fetchAllRows('pim_demandas', '*').catch(() => []),
    fetchAllRows('estoque_ppu', 'pn, quantidade, localizacao').catch(() => []),
    fetchAllRows('leonardo_spares', 'pn, qtd_pendente, documento_referencia').catch(() => []),
    fetchOdcRows(),
    fetchAllRows('price_list', 'pn, valor_unitario, nomenclatura, nsn').catch(() => []),
    fetchAllRows('dicionario_mestre', 'pn, pi, nsn, nomenclatura').catch(() => []),
    fetchAllRows('estoque_ceimspa', 'pi, quantidade, nomenclatura').catch(() => []),
    fetchAllRows('rfq_cotacoes', 'pn, valor_unitario, validade, data_insercao').catch(() => []),
    fetchAllRows('recebimento_itens', 'pn, valor_unitario, created_at').catch(() => []),
    fetchAllRows('items', 'pn, nomenclatura, nsn').catch(() => []),
    fetchAllRows('service_bulletins', 'sb_numero, titulo, tipo_sb, status_acao, data_publicacao, observacao, fonte_documento, updated_at').catch(() => []),
    fetchAllRows('service_bulletin_items', 'sb_numero, pn, nsn, nomenclatura, qtd, capitulo, item_num, aplicabilidade').catch(() => []),
  ]);

  const receitaOptions = buildReceitaOptions(receitaRows, politicaRows);
  const origemOptions = buildOrigemOptions(pimRows);

  const ppuMap = new Map();
  (ppuRows || []).forEach((row) => {
    const pn = normalizeKey(row.pn);
    if (!pn) return;
    if (shouldExcludePpuLocationFromGenerator(row.localizacao)) return;
    if (!ppuMap.has(pn)) ppuMap.set(pn, { quantidade: 0, locais: new Set() });
    const ref = ppuMap.get(pn);
    ref.quantidade += toNumber(row.quantidade);
    if (row.localizacao) ref.locais.add(row.localizacao);
  });

  const odaMap = new Map();
  (odaRows || []).forEach((row) => {
    const pn = normalizeKey(row.pn);
    if (!pn) return;
    if (!odaMap.has(pn)) odaMap.set(pn, { quantidade: 0, docs: new Set() });
    const ref = odaMap.get(pn);
    ref.quantidade += toNumber(row.qtd_pendente);
    if (row.documento_referencia) ref.docs.add(String(row.documento_referencia).trim());
  });

  const odcMap = new Map();
  (odcRows || []).forEach((row) => {
    const pn = normalizeKey(row.pn);
    if (!pn) return;
    if (!odcMap.has(pn)) odcMap.set(pn, { quantidade: 0, docs: new Set() });
    const qtyKey = firstExistingKey(row, ODC_QTY_CANDIDATES);
    const pdKey = firstExistingKey(row, ODC_PD_CANDIDATES);
    const ref = odcMap.get(pn);
    ref.quantidade += qtyKey ? toNumber(row[qtyKey]) : 0;
    if (pdKey && row[pdKey]) ref.docs.add(String(row[pdKey]).trim());
  });

  const pnPiMap = new Map();
  const pnMetaMap = new Map();
  (itemRows || []).forEach((row) => {
    const pn = normalizeKey(row.pn);
    if (!pn) return;
    if (!pnMetaMap.has(pn)) pnMetaMap.set(pn, {
      nsn: safeString(row.nsn),
      nomenclatura: safeString(row.nomenclatura),
    });
  });
  (dicRows || []).forEach((row) => {
    const pn = normalizeKey(row.pn);
    if (!pn) return;
    if (!pnPiMap.has(pn)) pnPiMap.set(pn, new Set());
    if (row.pi) pnPiMap.get(pn).add(String(row.pi).trim());
    const current = pnMetaMap.get(pn) || {};
    pnMetaMap.set(pn, {
      nsn: current.nsn || safeString(row.nsn),
      nomenclatura: current.nomenclatura || safeString(row.nomenclatura),
    });
  });

  const priceMap = new Map();
  const costRefMap = new Map();
  (priceRows || []).forEach((row) => {
    const pn = normalizeKey(row.pn);
    if (!pn) return;
    const info = {
      valor_unitario: toNumber(row.valor_unitario),
      nomenclatura: safeString(row.nomenclatura),
      nsn: safeString(row.nsn),
    };
    if (!priceMap.has(pn)) priceMap.set(pn, info);
    const currentMeta = pnMetaMap.get(pn) || {};
    pnMetaMap.set(pn, {
      nsn: currentMeta.nsn || info.nsn,
      nomenclatura: currentMeta.nomenclatura || info.nomenclatura,
    });
  });

  receiptRows
    .filter((row) => toNumber(row.valor_unitario) > 0)
    .sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0))
    .forEach((row) => {
      const pn = normalizeKey(row.pn);
      if (!pn || costRefMap.has(pn)) return;
      costRefMap.set(pn, { valor_unitario: toNumber(row.valor_unitario), fonte: 'RECIBO' });
    });

  (rfqRows || [])
    .filter((row) => toNumber(row.valor_unitario) > 0)
    .map((row) => ({ ...row, endDate: parseRfQEndDate(row.validade) }))
    .filter((row) => row.endDate && row.endDate >= today)
    .sort((a, b) => new Date(b.data_insercao || 0) - new Date(a.data_insercao || 0))
    .forEach((row) => {
      const pn = normalizeKey(row.pn);
      if (!pn || costRefMap.has(pn)) return;
      costRefMap.set(pn, { valor_unitario: toNumber(row.valor_unitario), fonte: 'RFQ VÁLIDA' });
    });

  (priceRows || []).forEach((row) => {
    const pn = normalizeKey(row.pn);
    if (!pn || costRefMap.has(pn) || toNumber(row.valor_unitario) <= 0) return;
    costRefMap.set(pn, { valor_unitario: toNumber(row.valor_unitario), fonte: 'PRICE LIST' });
  });

  const ceimspaMap = new Map();
  (ceimspaRows || []).forEach((row) => {
    const pi = normalizeUpper(row.pi);
    if (!pi) return;
    if (!ceimspaMap.has(pi)) ceimspaMap.set(pi, { quantidade: 0 });
    ceimspaMap.get(pi).quantidade += toNumber(row.quantidade);
  });

  const sbItemsByNumero = new Map();
  (sbItemRows || []).forEach((row) => {
    const sbNumero = String(row.sb_numero || '').trim();
    if (!sbNumero) return;
    if (!sbItemsByNumero.has(sbNumero)) sbItemsByNumero.set(sbNumero, []);
    sbItemsByNumero.get(sbNumero).push(row);
    const pn = normalizeKey(row.pn);
    if (!pn) return;
    const current = pnMetaMap.get(pn) || {};
    pnMetaMap.set(pn, {
      nsn: current.nsn || safeString(row.nsn),
      nomenclatura: current.nomenclatura || safeString(row.nomenclatura),
    });
  });

  const sbOptions = buildSbOptions(sbRows, sbItemsByNumero);

  const context = {
    receitaOptions,
    origemOptions,
    sbOptions,
    receitaRows,
    politicaRows,
    pimRows,
    sbRows,
    sbItemRows,
    sbItemsByNumero,
    ppuMap,
    odaMap,
    odcMap,
    priceMap,
    costRefMap,
    pnPiMap,
    pnMetaMap,
    ceimspaMap,
  };

  needsCache.full = context;
  needsCache.fullAt = Date.now();
  return context;
}

function resolveSelectedReceitas(mode, receitaOptions, requested = []) {
  const requestedSet = new Set((requested || []).map((item) => String(item || '').trim()).filter(Boolean));
  if (mode === 'all') return receitaOptions.map((item) => item.inspecao);
  if (mode === 'prioritized') return receitaOptions.filter((item) => item.priorizada).map((item) => item.inspecao);
  return receitaOptions.filter((item) => requestedSet.has(item.inspecao)).map((item) => item.inspecao);
}

function resolveSelectedSbs(mode, sbOptions = [], requested = []) {
  const requestedSet = new Set((requested || []).map((item) => String(item || '').trim()).filter(Boolean));
  if (mode === 'all') return sbOptions.filter((item) => item.possui_itens).map((item) => item.sb_numero);
  if (mode === 'open') return sbOptions.filter((item) => item.aberta && item.possui_itens).map((item) => item.sb_numero);
  if (mode === 'none') return [];
  return sbOptions.filter((item) => requestedSet.has(item.sb_numero)).map((item) => item.sb_numero);
}

function buildSbCoverageItem(item = {}, context) {
  const pn = normalizeKey(item.pn);
  const meta = context.pnMetaMap.get(pn) || {};
  const qtyRaw = toNumber(item.qtd);
  const quantidadeReferencial = qtyRaw > 0 ? qtyRaw : 1;
  const pis = Array.from(context.pnPiMap.get(pn) || []);
  const ppu = toNumber(context.ppuMap.get(pn)?.quantidade);
  const ceimspa = pis.reduce((acc, pi) => acc + toNumber(context.ceimspaMap.get(pi)?.quantidade), 0);
  const oda = toNumber(context.odaMap.get(pn)?.quantidade);
  const odc = toNumber(context.odcMap.get(pn)?.quantidade);
  const coberturaTotal = ppu + ceimspa + oda + odc;
  const saldo = Math.max(quantidadeReferencial - coberturaTotal, 0);
  const priceInfo = context.costRefMap.get(pn) || context.priceMap.get(pn) || null;
  const precisaCadastro = !meta.nomenclatura && !meta.nsn && !context.priceMap.has(pn);
  return {
    pn,
    nsn: item.nsn || meta.nsn || null,
    nomenclatura: item.nomenclatura || meta.nomenclatura || 'N/A',
    qtd_solicitada: qtyRaw > 0 ? qtyRaw : null,
    qtd_referencial: quantidadeReferencial,
    qtd_indefinida: qtyRaw <= 0,
    ppu_qtd: ppu,
    ceimspa_qtd: ceimspa,
    oda_qtd: oda,
    odc_qtd: odc,
    saldo_pos_cascata: Number(saldo.toFixed(2)),
    price_ref_gbp: priceInfo ? toNumber(priceInfo.valor_unitario) : null,
    price_ref_fonte: priceInfo?.fonte || (context.priceMap.has(pn) ? 'PRICE LIST' : null),
    precisa_cadastro: precisaCadastro,
    cobertura_status: saldo <= 0 ? 'COBERTO' : (coberturaTotal > 0 ? 'PARCIAL' : 'SEM_COBERTURA'),
    aplicabilidade: item.aplicabilidade || null,
    capitulo: item.capitulo || null,
    item_num: item.item_num || null,
  };
}

function buildGeneratorPreview(selection, context) {
  const { mode = 'prioritized', receitas = [], origens = [], incluirPims = true, sbMode = 'none', sbs = [] } = selection || {};
  const selectedReceitas = resolveSelectedReceitas(mode, context.receitaOptions, receitas);
  const selectedSbs = resolveSelectedSbs(sbMode, context.sbOptions, sbs);
  const selectedOrigemSet = new Set((origens || []).map((item) => String(item || '').trim()).filter(Boolean));
  const needMap = new Map();
  const receitaFactorMap = new Map();

  (context.politicaRows || []).forEach((row) => {
    if (normalizeUpper(row.tipo) !== 'RECEITA') return;
    receitaFactorMap.set(normalizeUpper(row.tarefas), {
      prioridade: toNumber(row.prioridade),
      fator: toNumber(row.qtde_2_anos) > 0 ? toNumber(row.qtde_2_anos) : 1,
    });
  });

  selectedReceitas.forEach((inspecao) => {
    const itens = (context.receitaRows || []).filter((row) => String(row.inspecao || '').trim() === inspecao);
    const policy = receitaFactorMap.get(normalizeUpper(inspecao));
    const fator = policy?.fator || 1;
    itens.forEach((item) => {
      appendNeed(needMap, {
        pn: item.pn,
        nsn: item.nsn,
        nomenclatura: item.nomenclatura,
        quantidade: toNumber(item.qtd_por_ciclo) * fator,
        receitas: [inspecao],
        observacoes: [`Receita x${fator}`],
      });
    });
  });

  if (incluirPims) {
    (context.pimRows || []).forEach((row) => {
      const origemNormalizada = resolvePimOrigem(row);
      const origemKey = buildOrigemKey(origemNormalizada);
      if (selectedOrigemSet.size > 0 && !selectedOrigemSet.has(origemKey)) return;

      appendNeed(needMap, {
        pn: row.pn,
        nsn: row.nsn,
        nomenclatura: row.nomenclatura,
        quantidade: toNumber(row.quantidade),
        pims: [row.pim],
        origens: [buildOrigemLabel(origemNormalizada)],
        observacoes: [`PIM x1 • OS ${row.os_vinculada}`],
      });
    });
  }

  selectedSbs.forEach((sbNumero) => {
    const header = (context.sbRows || []).find((row) => row.sb_numero === sbNumero) || {};
    const itens = context.sbItemsByNumero.get(sbNumero) || [];
    itens.forEach((item) => {
      const qtyRaw = toNumber(item.qtd);
      const qtyGerador = qtyRaw > 0 ? qtyRaw : 1;
      appendNeed(needMap, {
        pn: item.pn,
        nsn: item.nsn,
        nomenclatura: item.nomenclatura,
        quantidade: qtyGerador,
        origens: [`SB ${sbNumero}`],
        observacoes: [
          header.titulo || 'Service Bulletin',
          qtyRaw > 0 ? `SB com qty definida (${qtyRaw})` : 'SB sem qty definida — verificação simbólica de cobertura (1 un).',
        ],
      });
    });
  });

  const baseRows = finalizeNeedRows(needMap).map((row) => {
    const meta = context.pnMetaMap.get(row.pn) || {};
    return {
      ...row,
      nsn: row.nsn || meta.nsn || null,
      nomenclatura: row.nomenclatura === 'N/A' ? (meta.nomenclatura || 'N/A') : row.nomenclatura,
    };
  });

  const sections = {
    ppu: [],
    ceimspa: [],
    oda: [],
    pricelist: [],
    odc: [],
    comprar: [],
  };

  let totalPpu = 0;
  let totalCeimspa = 0;
  let totalOda = 0;
  let totalOdc = 0;
  let totalComprar = 0;
  let valorComprar = 0;

  baseRows.forEach((row) => {
    const necessidade = toNumber(row.necessidade_total);
    let saldo = necessidade;

    const ppuInfo = context.ppuMap.get(row.pn);
    const coberturaPpu = Math.min(saldo, toNumber(ppuInfo?.quantidade));
    saldo -= coberturaPpu;
    totalPpu += coberturaPpu;
    sections.ppu.push({
      ...row,
      cobertura_etapa: Number(coberturaPpu.toFixed(2)),
      saldo_apos_etapa: Number(saldo.toFixed(2)),
      documento_referencia: ppuInfo?.locais ? Array.from(ppuInfo.locais).join(' | ') : '',
      row_tone: coberturaPpu >= necessidade && necessidade > 0 ? 'full' : (coberturaPpu > 0 ? 'partial' : 'none'),
    });

    const pis = Array.from(context.pnPiMap.get(row.pn) || []);
    const ceimspaDisponivel = pis.reduce((acc, pi) => acc + toNumber(context.ceimspaMap.get(pi)?.quantidade), 0);
    const coberturaCeimspa = Math.min(saldo, ceimspaDisponivel);
    if (coberturaCeimspa > 0) {
      saldo -= coberturaCeimspa;
      totalCeimspa += coberturaCeimspa;
      sections.ceimspa.push({
        ...row,
        cobertura_etapa: Number(coberturaCeimspa.toFixed(2)),
        saldo_apos_etapa: Number(saldo.toFixed(2)),
        documento_referencia: pis.join(' | '),
        row_tone: coberturaCeimspa >= Math.max(necessidade - coberturaPpu, 0) && (necessidade - coberturaPpu) > 0 ? 'full' : 'partial',
      });
    }

    const odaInfo = context.odaMap.get(row.pn);
    const coberturaOda = Math.min(saldo, toNumber(odaInfo?.quantidade));
    if (coberturaOda > 0) {
      saldo -= coberturaOda;
      totalOda += coberturaOda;
      sections.oda.push({
        ...row,
        cobertura_etapa: Number(coberturaOda.toFixed(2)),
        saldo_apos_etapa: Number(saldo.toFixed(2)),
        documento_referencia: odaInfo?.docs ? Array.from(odaInfo.docs).join(' | ') : '',
        row_tone: 'partial',
      });
    }

    const priceInfo = context.costRefMap.get(row.pn) || context.priceMap.get(row.pn);
    if (saldo > 0 && priceInfo) {
      const valorUnit = toNumber(priceInfo.valor_unitario);
      sections.pricelist.push({
        ...row,
        cobertura_etapa: '',
        saldo_apos_etapa: Number(saldo.toFixed(2)),
        valor_unitario_gbp: valorUnit,
        valor_total_gbp: Number((valorUnit * saldo).toFixed(2)),
        observacao: `Referência de preço (${priceInfo.fonte || 'PRICE LIST'}) — não consome saldo.`,
        row_tone: 'info',
      });
    }

    const odcInfo = context.odcMap.get(row.pn);
    const coberturaOdc = Math.min(saldo, toNumber(odcInfo?.quantidade));
    if (coberturaOdc > 0) {
      saldo -= coberturaOdc;
      totalOdc += coberturaOdc;
      sections.odc.push({
        ...row,
        cobertura_etapa: Number(coberturaOdc.toFixed(2)),
        saldo_apos_etapa: Number(saldo.toFixed(2)),
        documento_referencia: odcInfo?.docs ? Array.from(odcInfo.docs).join(' | ') : '',
        row_tone: 'partial',
      });
    }

    if (saldo > 0) {
      const valorUnit = toNumber(priceInfo?.valor_unitario);
      const valorTotal = valorUnit > 0 ? Number((valorUnit * saldo).toFixed(2)) : 0;
      totalComprar += saldo;
      valorComprar += valorTotal;
      sections.comprar.push({
        ...row,
        cobertura_etapa: '',
        saldo_apos_etapa: Number(saldo.toFixed(2)),
        valor_unitario_gbp: valorUnit || null,
        valor_total_gbp: valorTotal || null,
        observacao: priceInfo ? `Comprar — valor estimado por ${priceInfo.fonte || 'PRICE LIST'}.` : 'Comprar — sem referência vigente de valor.',
        row_tone: 'buy',
      });
    }
  });

  const summary = {
    receitas_selecionadas: selectedReceitas.length,
    sbs_selecionadas: selectedSbs.length,
    origens_selecionadas: selectedOrigemSet.size,
    linhas_base: baseRows.length,
    necessidade_total: Number(baseRows.reduce((acc, row) => acc + toNumber(row.necessidade_total), 0).toFixed(2)),
    coberto_ppu: Number(totalPpu.toFixed(2)),
    coberto_ceimspa: Number(totalCeimspa.toFixed(2)),
    coberto_oda: Number(totalOda.toFixed(2)),
    coberto_odc: Number(totalOdc.toFixed(2)),
    comprar_qtd: Number(totalComprar.toFixed(2)),
    comprar_valor_gbp: Number(valorComprar.toFixed(2)),
  };

  return {
    filtros: {
      modo: mode,
      receitas: selectedReceitas,
      sbMode,
      sbs: selectedSbs,
      origens: Array.from(selectedOrigemSet),
      incluirPims: !!incluirPims,
    },
    summary,
    base: baseRows,
    sections,
  };
}

function buildOperationalCostPreview(selection, context) {
  const { mode = 'prioritized', receitas = [], origens = [], incluirPims = true, sbMode = 'none', sbs = [] } = selection || {};
  const selectedReceitas = resolveSelectedReceitas(mode, context.receitaOptions, receitas);
  const selectedSbs = resolveSelectedSbs(sbMode, context.sbOptions, sbs);
  const selectedOrigemSet = new Set((origens || []).map((item) => String(item || '').trim()).filter(Boolean));

  const receitaPolicyMap = new Map();
  (context.politicaRows || []).forEach((row) => {
    if (normalizeUpper(row.tipo) !== 'RECEITA') return;
    const tarefa = normalizeUpper(row.tarefas);
    if (!tarefa) return;
    receitaPolicyMap.set(tarefa, {
      prioridade: toNumber(row.prioridade),
      fator: toNumber(row.qtde_2_anos) > 0 ? toNumber(row.qtde_2_anos) : 1,
    });
  });

  const aggregate = new Map();

  const ensureRow = (pn, base = {}) => {
    const key = normalizeKey(pn);
    if (!key) return null;
    if (!aggregate.has(key)) {
      const meta = context.pnMetaMap.get(key) || {};
      aggregate.set(key, {
        pn: key,
        nsn: safeString(base.nsn) || meta.nsn || null,
        nomenclatura: safeString(base.nomenclatura) || meta.nomenclatura || 'N/A',
        qtd_unitaria: 0,
        qtd_planejada: 0,
        receitas: new Set(),
        pims: new Set(),
        origens: new Set(),
        sbs: new Set(),
        fatores: new Set(),
        observacoes: new Set(),
      });
    }
    const ref = aggregate.get(key);
    if (!ref.nsn && base.nsn) ref.nsn = safeString(base.nsn);
    if ((!ref.nomenclatura || ref.nomenclatura === 'N/A') && base.nomenclatura) {
      ref.nomenclatura = safeString(base.nomenclatura);
    }
    return ref;
  };

  const addCostLine = ({ pn, nsn, nomenclatura, qtdUnitaria, qtdPlanejada, receita, pim, origem, sb, fator, observacao }) => {
    const ref = ensureRow(pn, { nsn, nomenclatura });
    if (!ref) return;
    ref.qtd_unitaria += toNumber(qtdUnitaria);
    ref.qtd_planejada += toNumber(qtdPlanejada);
    if (receita) ref.receitas.add(receita);
    if (pim) ref.pims.add(pim);
    if (origem) ref.origens.add(origem);
    if (sb) ref.sbs.add(sb);
    if (fator && toNumber(fator) > 0) ref.fatores.add(Number(toNumber(fator).toFixed(2)));
    if (observacao) ref.observacoes.add(observacao);
  };

  selectedReceitas.forEach((inspecao) => {
    const itens = (context.receitaRows || []).filter((row) => String(row.inspecao || '').trim() === inspecao);
    const policy = receitaPolicyMap.get(normalizeUpper(inspecao));
    const fatorPlanejado = policy?.fator || 1;

    itens.forEach((item) => {
      const qtdPorExecucao = toNumber(item.qtd_por_ciclo);
      if (qtdPorExecucao <= 0) return;
      addCostLine({
        pn: item.pn,
        nsn: item.nsn,
        nomenclatura: item.nomenclatura,
        qtdUnitaria: qtdPorExecucao,
        qtdPlanejada: qtdPorExecucao * fatorPlanejado,
        receita: inspecao,
        fator: fatorPlanejado,
        observacao: `Receita: ${inspecao} • 1 execução x${qtdPorExecucao} • projeção x${fatorPlanejado}`,
      });
    });
  });

  if (incluirPims) {
    (context.pimRows || []).forEach((row) => {
      const origemNormalizada = resolvePimOrigem(row);
      const origemKey = buildOrigemKey(origemNormalizada);
      if (selectedOrigemSet.size > 0 && !selectedOrigemSet.has(origemKey)) return;
      const quantidade = toNumber(row.quantidade);
      if (quantidade <= 0) return;
      addCostLine({
        pn: row.pn,
        nsn: row.nsn,
        nomenclatura: row.nomenclatura,
        qtdUnitaria: quantidade,
        qtdPlanejada: quantidade,
        pim: row.pim,
        origem: buildOrigemLabel(origemNormalizada),
        fator: 1,
        observacao: `PIM avulsa x${quantidade} • OS ${row.os_vinculada}`,
      });
    });
  }

  selectedSbs.forEach((sbNumero) => {
    const itens = context.sbItemsByNumero.get(sbNumero) || [];
    itens.forEach((item) => {
      const qtyRaw = toNumber(item.qtd);
      const quantidade = qtyRaw > 0 ? qtyRaw : 1;
      addCostLine({
        pn: item.pn,
        nsn: item.nsn,
        nomenclatura: item.nomenclatura,
        qtdUnitaria: quantidade,
        qtdPlanejada: quantidade,
        sb: sbNumero,
        fator: 1,
        observacao: `SB ${sbNumero} x${quantidade}`,
      });
    });
  });

  const linhas = Array.from(aggregate.values())
    .map((row) => {
      const priceInfo = context.costRefMap.get(row.pn) || context.priceMap.get(row.pn) || null;
      const valorUnit = priceInfo ? toNumber(priceInfo.valor_unitario) : null;
      const valorExecucao = valorUnit != null && row.qtd_unitaria > 0
        ? Number((valorUnit * row.qtd_unitaria).toFixed(2))
        : null;
      const valorPlanejado = valorUnit != null && row.qtd_planejada > 0
        ? Number((valorUnit * row.qtd_planejada).toFixed(2))
        : null;
      return {
        pn: row.pn,
        nsn: row.nsn,
        nomenclatura: row.nomenclatura,
        qtd_unitaria: Number(row.qtd_unitaria.toFixed(2)),
        qtd_planejada: Number(row.qtd_planejada.toFixed(2)),
        fator_planejado_texto: Array.from(row.fatores).sort((a, b) => a - b).join(' | '),
        receitas_texto: Array.from(row.receitas).sort().join(' | '),
        pims_texto: Array.from(row.pims).sort().join(' | '),
        origens_texto: Array.from(row.origens).sort().join(' | '),
        sbs_texto: Array.from(row.sbs).sort().join(' | '),
        observacao: Array.from(row.observacoes).sort().join(' | '),
        valor_unitario_gbp: valorUnit,
        valor_execucao_gbp: valorExecucao,
        valor_planejado_gbp: valorPlanejado,
        // Compatibilidade com a tela antiga: agora o valor_total_gbp representa 1 execução, não a projeção.
        valor_total_gbp: valorExecucao,
        fonte_valor: priceInfo?.fonte || null,
      };
    })
    .sort((a, b) => a.pn.localeCompare(b.pn));

  const summary = {
    receitas_selecionadas: selectedReceitas.length,
    sbs_selecionadas: selectedSbs.length,
    origens_selecionadas: selectedOrigemSet.size,
    linhas: linhas.length,
    pns_com_valor: linhas.filter((row) => row.valor_unitario_gbp != null).length,
    pns_sem_valor: linhas.filter((row) => row.valor_unitario_gbp == null).length,
    qtd_unitaria_total: Number(linhas.reduce((acc, row) => acc + toNumber(row.qtd_unitaria), 0).toFixed(2)),
    qtd_planejada_total: Number(linhas.reduce((acc, row) => acc + toNumber(row.qtd_planejada), 0).toFixed(2)),
    custo_execucao_gbp: Number(linhas.reduce((acc, row) => acc + toNumber(row.valor_execucao_gbp), 0).toFixed(2)),
    custo_projetado_gbp: Number(linhas.reduce((acc, row) => acc + toNumber(row.valor_planejado_gbp), 0).toFixed(2)),
    // Compatibilidade com a tela antiga.
    valor_total_gbp: Number(linhas.reduce((acc, row) => acc + toNumber(row.valor_execucao_gbp), 0).toFixed(2)),
  };

  return {
    filtros: {
      modo: mode,
      receitas: selectedReceitas,
      sbMode,
      sbs: selectedSbs,
      origens: Array.from(selectedOrigemSet),
      incluirPims: !!incluirPims,
    },
    summary,
    linhas,
  };
}

function buildSbDetail(header, context) {
  const items = (context.sbItemsByNumero.get(header.sb_numero) || []).map((item) => buildSbCoverageItem(item, context));
  const acaoPrincipal = inferSbActionType(header, items);
  const acoes = buildSbActions(header, items, items);
  const totalEstimado = items.reduce((acc, item) => {
    if (!item.price_ref_gbp || !item.qtd_solicitada) return acc;
    return acc + (item.price_ref_gbp * item.qtd_solicitada);
  }, 0);

  return {
    header: {
      sb_numero: header.sb_numero,
      titulo: header.titulo || 'Service Bulletin',
      tipo_sb: header.tipo_sb || 'N/A',
      status_acao: header.status_acao || 'SEM_ACAO',
      data_publicacao: header.data_publicacao || null,
      observacao: header.observacao || null,
      fonte_documento: header.fonte_documento || null,
      updated_at: header.updated_at || null,
    },
    resumo_curto: buildSbShortSummary(header, items),
    acao_principal: acaoPrincipal,
    acoes_recomendadas: acoes,
    itens: items,
    summary: {
      total_itens: items.length,
      itens_cobertos: items.filter((item) => item.cobertura_status === 'COBERTO').length,
      itens_parciais: items.filter((item) => item.cobertura_status === 'PARCIAL').length,
      itens_sem_cobertura: items.filter((item) => item.cobertura_status === 'SEM_COBERTURA').length,
      itens_sem_qtd_definida: items.filter((item) => item.qtd_indefinida).length,
      itens_com_preco: items.filter((item) => item.price_ref_gbp != null).length,
      valor_estimado_gbp: Number(totalEstimado.toFixed(2)),
    },
  };
}

exports.listReceitas = async (req, res) => {
  try {
    const q = String(req.query.q || '').trim();
    let query = supabase
      .from('receita_itens')
      .select('inspecao')
      .order('inspecao', { ascending: true });

    if (q) query = query.ilike('inspecao', `%${q}%`);

    const { data, error } = await query;
    if (error) throw error;

    const grouped = new Map();
    (data || []).forEach((row) => {
      if (!row.inspecao) return;
      grouped.set(row.inspecao, (grouped.get(row.inspecao) || 0) + 1);
    });

    return res.status(200).json({
      status: 'success',
      data: Array.from(grouped.entries()).map(([inspecao, total_itens]) => ({ inspecao, total_itens })),
    });
  } catch (_) {
    return res.status(500).json({ status: 'error', message: 'Falha ao listar receitas.' });
  }
};

exports.getReceitaItens = async (req, res) => {
  try {
    const inspecao = String(req.params.inspecao || '').trim();
    if (!inspecao) {
      return res.status(400).json({ status: 'error', message: 'Informe a inspeção.' });
    }

    const { data, error } = await supabase
      .from('receita_itens')
      .select('*')
      .eq('inspecao', inspecao)
      .order('pn', { ascending: true });

    if (error) throw error;

    return res.status(200).json({ status: 'success', data: data || [] });
  } catch (_) {
    return res.status(500).json({ status: 'error', message: 'Falha ao consultar itens da receita.' });
  }
};

exports.upsertReceitaItem = async (req, res) => {
  try {
    const { id, inspecao, pn, nsn, pn_alt, nomenclatura, qtd_por_ciclo } = req.body || {};
    const pnNorm = normalizePn(pn);
    if (!inspecao || !pnNorm || !nomenclatura || Number(qtd_por_ciclo) <= 0) {
      return res.status(400).json({ status: 'error', message: 'Preencha inspeção, PN, nomenclatura e quantidade por ciclo.' });
    }

    const pnAltAuto = !safeString(pn_alt) ? await buscarPnAlternativoAutomatico(pnNorm) : null;

    const payload = {
      inspecao: String(inspecao).trim(),
      pn: pnNorm,
      nsn: safeString(nsn),
      pn_alt: safeString(pn_alt) || pnAltAuto,
      nomenclatura: String(nomenclatura).trim(),
      qtd_por_ciclo: Number(qtd_por_ciclo) || 0,
      updated_at: new Date().toISOString(),
    };

    if (id) {
      const { error } = await supabase.from('receita_itens').update(payload).eq('id', id);
      if (error) throw error;
      invalidateNeedsCache();
      return res.status(200).json({ status: 'success', message: 'Item da receita atualizado com sucesso.' });
    }

    const { error } = await supabase.from('receita_itens').insert(payload);
    if (error) throw error;
    invalidateNeedsCache();
    return res.status(200).json({ status: 'success', message: 'Item da receita cadastrado com sucesso.' });
  } catch (_) {
    return res.status(500).json({ status: 'error', message: 'Falha ao salvar item da receita.' });
  }
};

exports.deleteReceitaItem = async (req, res) => {
  try {
    const { id } = req.params;
    const { error } = await supabase.from('receita_itens').delete().eq('id', id);
    if (error) throw error;
    invalidateNeedsCache();
    return res.status(200).json({ status: 'success', message: 'Item da receita excluído com sucesso.' });
  } catch (_) {
    return res.status(500).json({ status: 'error', message: 'Falha ao excluir item da receita.' });
  }
};

exports.listPims = async (req, res) => {
  try {
    const q = String(req.query.q || '').trim();
    let query = supabase
      .from('pim_demandas')
      .select('*')
      .order('data_solicitacao', { ascending: false })
      .order('pim', { ascending: false });

    if (q) {
      query = query.or([
        `pim.ilike.%${q}%`,
        `pn.ilike.%${q}%`,
        `nsn.ilike.%${q}%`,
        `os_vinculada.ilike.%${q}%`,
        `origem_codigo.ilike.%${q}%`,
        `origem_tipo.ilike.%${q}%`,
      ].join(','));
    }

    const { data, error } = await query.limit(200);
    if (error) throw error;

    const normalized = (data || []).map(hydratePimOrigem);
    return res.status(200).json({ status: 'success', data: normalized });
  } catch (_) {
    return res.status(500).json({ status: 'error', message: 'Falha ao listar PIMs.' });
  }
};

exports.upsertPim = async (req, res) => {
  try {
    const { id, pim, data_solicitacao, pn, nsn, quantidade, os_vinculada, observacoes } = req.body || {};
    const pnNorm = normalizePn(pn);
    if (!pim || !pnNorm || Number(quantidade) <= 0 || !os_vinculada) {
      return res.status(400).json({ status: 'error', message: 'Preencha PIM, PN, quantidade e OS vinculada.' });
    }

    const origem = parseOsOrigem(os_vinculada);
    const payload = {
      pim: String(pim).trim(),
      data_solicitacao: parseDateInput(data_solicitacao),
      pn: pnNorm,
      nsn: safeString(nsn),
      quantidade: Number(quantidade) || 0,
      os_vinculada: normalizeUpper(os_vinculada),
      observacoes: safeString(observacoes),
      origem_tipo: origem.origem_tipo,
      origem_codigo: origem.origem_codigo,
      origem_descricao: origem.origem_descricao,
      fator_multiplicador: 1,
      updated_at: new Date().toISOString(),
    };

    if (id) {
      const { error } = await supabase.from('pim_demandas').update(payload).eq('id', id);
      if (error) throw error;
      invalidateNeedsCache();
      return res.status(200).json({ status: 'success', message: 'PIM atualizado com sucesso.' });
    }

    const { error } = await supabase.from('pim_demandas').insert(payload);
    if (error) throw error;
    invalidateNeedsCache();
    return res.status(200).json({ status: 'success', message: 'PIM cadastrado com sucesso.' });
  } catch (_) {
    return res.status(500).json({ status: 'error', message: 'Falha ao salvar PIM.' });
  }
};

exports.deletePim = async (req, res) => {
  try {
    const { id } = req.params;
    const { error } = await supabase.from('pim_demandas').delete().eq('id', id);
    if (error) throw error;
    invalidateNeedsCache();
    return res.status(200).json({ status: 'success', message: 'PIM excluído com sucesso.' });
  } catch (_) {
    return res.status(500).json({ status: 'error', message: 'Falha ao excluir PIM.' });
  }
};

exports.listPoliticas = async (req, res) => {
  try {
    const q = String(req.query.q || '').trim();
    let query = supabase
      .from('politica_estoque_tarefas')
      .select('*')
      .order('prioridade', { ascending: true })
      .order('tarefas', { ascending: true });

    if (q) {
      query = query.or(`tarefas.ilike.%${q}%,tipo.ilike.%${q}%`);
    }

    const { data, error } = await query.limit(200);
    if (error) throw error;

    const normalized = (data || []).map(hydratePimOrigem);
    return res.status(200).json({ status: 'success', data: normalized });
  } catch (_) {
    return res.status(500).json({ status: 'error', message: 'Falha ao listar políticas.' });
  }
};

exports.upsertPolitica = async (req, res) => {
  try {
    const { id, tarefas, tipo, prioridade, qtde_2_anos } = req.body || {};
    if (!tarefas || !tipo) {
      return res.status(400).json({ status: 'error', message: 'Preencha tarefa e tipo.' });
    }

    const payload = {
      tarefas: String(tarefas).trim(),
      tipo: String(tipo).trim(),
      prioridade: Number(prioridade) || 0,
      qtde_2_anos: Number(qtde_2_anos) || 0,
      updated_at: new Date().toISOString(),
    };

    if (id) {
      const { error } = await supabase.from('politica_estoque_tarefas').update(payload).eq('id', id);
      if (error) throw error;
      invalidateNeedsCache();
      return res.status(200).json({ status: 'success', message: 'Política atualizada com sucesso.' });
    }

    const { error } = await supabase.from('politica_estoque_tarefas').insert(payload);
    if (error) throw error;
    invalidateNeedsCache();
    return res.status(200).json({ status: 'success', message: 'Política cadastrada com sucesso.' });
  } catch (_) {
    return res.status(500).json({ status: 'error', message: 'Falha ao salvar política.' });
  }
};

exports.deletePolitica = async (req, res) => {
  try {
    const { id } = req.params;
    const { error } = await supabase.from('politica_estoque_tarefas').delete().eq('id', id);
    if (error) throw error;
    invalidateNeedsCache();
    return res.status(200).json({ status: 'success', message: 'Política excluída com sucesso.' });
  } catch (_) {
    return res.status(500).json({ status: 'error', message: 'Falha ao excluir política.' });
  }
};

exports.getFoundationSnapshot = async (req, res) => {
  try {
    const [{ count: receitasCount }, { count: pimCount }, { count: politicaCount }] = await Promise.all([
      supabase.from('receita_itens').select('*', { count: 'exact', head: true }),
      supabase.from('pim_demandas').select('*', { count: 'exact', head: true }),
      supabase.from('politica_estoque_tarefas').select('*', { count: 'exact', head: true }),
    ]);

    return res.status(200).json({
      status: 'success',
      data: {
        receitaItens: receitasCount || 0,
        pims: pimCount || 0,
        politicas: politicaCount || 0,
      },
    });
  } catch (_) {
    return res.status(500).json({ status: 'error', message: 'Falha ao consultar a base do gerador.' });
  }
};

exports.getGeneratorOptions = async (req, res) => {
  try {
    const context = await loadOptionsContext();
    return res.status(200).json({
      status: 'success',
      data: {
        receitas: context.receitaOptions,
        origens: context.origemOptions,
        sbs: context.sbOptions,
      },
    });
  } catch (_) {
    return res.status(500).json({ status: 'error', message: 'Falha ao carregar filtros do gerador.' });
  }
};


const BATCH_PN_HEADERS = [
  'pn',
  'p/n',
  'p_n',
  'part_number',
  'partnumber',
  'part number',
  'part no',
  'part_no',
  'part n',
  'part_n',
  'numero_peca',
  'número peça',
  'numero da peca',
  'número da peça',
  'codigo',
  'código',
  'cod_item',
];
const BATCH_QTY_HEADERS = [
  'quantidade',
  'qtd',
  'qtde',
  'qtd.',
  'qtde.',
  'qty',
  'quantity',
  'necessidade',
  'necessidade_total',
  'demanda',
];
const BATCH_NSN_HEADERS = ['nsn', 'nato_stock_number', 'nato stock number', 'niin'];
const BATCH_NOMENCLATURE_HEADERS = [
  'nomenclatura',
  'nome',
  'nome_item',
  'nome do item',
  'descricao',
  'descrição',
  'description',
  'item',
  'material',
];

function normalizeHeaderName(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function resolveHeaderKey(headerMap, candidates = []) {
  const normalized = candidates.map(normalizeHeaderName);
  const found = normalized.find((key) => headerMap.has(key));
  return found ? headerMap.get(found) : null;
}

function parseBatchQuantity(value, fallback = 1) {
  if (value === null || value === undefined || String(value).trim() === '') return fallback;
  if (typeof value === 'number') return Number.isFinite(value) ? value : Number.NaN;

  let text = String(value).trim();
  text = text.replace(/\s/g, '');

  // Aceita padrões BR e EN: 1.234,50 / 1,234.50 / 1234,50 / 1234.50
  if (text.includes(',') && text.includes('.')) {
    const lastComma = text.lastIndexOf(',');
    const lastDot = text.lastIndexOf('.');
    if (lastComma > lastDot) {
      text = text.replace(/\./g, '').replace(',', '.');
    } else {
      text = text.replace(/,/g, '');
    }
  } else if (text.includes(',')) {
    text = text.replace(',', '.');
  }

  const parsed = Number(text);
  return Number.isFinite(parsed) ? parsed : Number.NaN;
}

function parseUploadedBatchWorkbook(file) {
  if (!file || !file.buffer) {
    const error = new Error('Envie a planilha da pesquisa em lote.');
    error.statusCode = 400;
    throw error;
  }

  let workbook;
  try {
    workbook = xlsx.read(file.buffer, { type: 'buffer', cellDates: false, dense: false });
  } catch (_) {
    const error = new Error('Não foi possível ler a planilha enviada. Use .xlsx, .xls, .csv ou .ods.');
    error.statusCode = 400;
    throw error;
  }

  const firstSheetName = workbook.SheetNames[0];
  if (!firstSheetName) {
    const error = new Error('A planilha enviada não possui abas legíveis.');
    error.statusCode = 400;
    throw error;
  }

  const worksheet = workbook.Sheets[firstSheetName];
  const rows = xlsx.utils.sheet_to_json(worksheet, { defval: '', raw: false });
  if (!rows.length) {
    const error = new Error('A planilha enviada está vazia.');
    error.statusCode = 400;
    throw error;
  }

  const firstRow = rows[0] || {};
  const headerMap = new Map(Object.keys(firstRow).map((key) => [normalizeHeaderName(key), key]));
  const pnKey = resolveHeaderKey(headerMap, BATCH_PN_HEADERS);
  const qtyKey = resolveHeaderKey(headerMap, BATCH_QTY_HEADERS);
  const nsnKey = resolveHeaderKey(headerMap, BATCH_NSN_HEADERS);
  const nomenclaturaKey = resolveHeaderKey(headerMap, BATCH_NOMENCLATURE_HEADERS);

  if (!pnKey) {
    const error = new Error('A planilha precisa ter a coluna obrigatória PN. Aceito também P/N, Part Number ou Part No. Colunas extras são permitidas e a ordem não importa.');
    error.statusCode = 400;
    throw error;
  }

  const aggregated = new Map();
  let linhasLidas = 0;

  rows.forEach((row, index) => {
    const pnRaw = row[pnKey];
    const pn = normalizeKey(pnRaw);
    const qtyRaw = qtyKey ? row[qtyKey] : '';
    const nsn = nsnKey ? normalizeUpper(row[nsnKey]) : '';
    const nomenclatura = nomenclaturaKey ? String(row[nomenclaturaKey] || '').trim() : '';

    if (!pn && !String(qtyRaw || '').trim() && !nsn && !nomenclatura) return;
    linhasLidas += 1;

    if (!pn) {
      const error = new Error(`Linha ${index + 2}: PN vazio.`);
      error.statusCode = 400;
      throw error;
    }

    const quantidade = parseBatchQuantity(qtyRaw, 1);
    if (!Number.isFinite(quantidade) || quantidade <= 0) {
      const error = new Error(`Linha ${index + 2}: quantidade inválida para o PN ${pn}.`);
      error.statusCode = 400;
      throw error;
    }

    if (!aggregated.has(pn)) {
      aggregated.set(pn, { pn, nsn: nsn || null, nomenclatura: nomenclatura || null, quantidade_total: 0 });
    }

    const current = aggregated.get(pn);
    current.quantidade_total += quantidade;
    if (!current.nsn && nsn) current.nsn = nsn;
    if (!current.nomenclatura && nomenclatura) current.nomenclatura = nomenclatura;
  });

  if (!aggregated.size) {
    const error = new Error('Nenhuma linha válida foi encontrada na planilha.');
    error.statusCode = 400;
    throw error;
  }

  return {
    workbookName: file.originalname || 'pesquisa_em_lote',
    sheetName: firstSheetName,
    linhasLidas,
    linhasBase: Array.from(aggregated.values()).sort((a, b) => a.pn.localeCompare(b.pn)),
    columns: {
      obrigatorias: ['pn'],
      opcionais: ['quantidade', 'nsn', 'nomenclatura'],
      aceita_mais_colunas: true,
      ordem_importa: false,
      aliases: {
        pn: BATCH_PN_HEADERS,
        quantidade: BATCH_QTY_HEADERS,
        nsn: BATCH_NSN_HEADERS,
        nomenclatura: BATCH_NOMENCLATURE_HEADERS,
      },
    },
  };
}

function buildBatchQueryPreview(parsedFile, context) {
  const inputRows = (parsedFile?.linhasBase || []).map((row) => {
    const meta = context.pnMetaMap.get(row.pn) || {};
    return {
      pn: row.pn,
      nsn: row.nsn || meta.nsn || null,
      nomenclatura: row.nomenclatura || meta.nomenclatura || 'N/A',
      necessidade_total: Number(toNumber(row.quantidade_total).toFixed(2)),
      receitas: [],
      pims: [],
      origens: [],
      observacoes: ['Pesquisa em lote'],
      receitas_texto: '',
      pims_texto: '',
      origens_texto: '',
      observacao: 'Pesquisa em lote',
    };
  });

  const sections = { ppu: [], ceimspa: [], oda: [], pricelist: [], odc: [], comprar: [] };
  let totalPpu = 0;
  let totalCeimspa = 0;
  let totalOda = 0;
  let totalOdc = 0;
  let totalComprar = 0;
  let valorComprar = 0;

  inputRows.forEach((row) => {
    const necessidade = toNumber(row.necessidade_total);
    let saldo = necessidade;

    const ppuInfo = context.ppuMap.get(row.pn);
    const coberturaPpu = Math.min(saldo, toNumber(ppuInfo?.quantidade));
    saldo -= coberturaPpu;
    totalPpu += coberturaPpu;
    sections.ppu.push({
      ...row,
      cobertura_etapa: Number(coberturaPpu.toFixed(2)),
      saldo_apos_etapa: Number(saldo.toFixed(2)),
      documento_referencia: ppuInfo?.locais ? Array.from(ppuInfo.locais).join(' | ') : '',
      row_tone: coberturaPpu >= necessidade && necessidade > 0 ? 'full' : (coberturaPpu > 0 ? 'partial' : 'none'),
    });

    const pis = Array.from(context.pnPiMap.get(row.pn) || []);
    const ceimspaDisponivel = pis.reduce((acc, pi) => acc + toNumber(context.ceimspaMap.get(pi)?.quantidade), 0);
    const coberturaCeimspa = Math.min(saldo, ceimspaDisponivel);
    if (coberturaCeimspa > 0) {
      saldo -= coberturaCeimspa;
      totalCeimspa += coberturaCeimspa;
      sections.ceimspa.push({
        ...row,
        cobertura_etapa: Number(coberturaCeimspa.toFixed(2)),
        saldo_apos_etapa: Number(saldo.toFixed(2)),
        documento_referencia: pis.join(' | '),
        row_tone: coberturaCeimspa >= Math.max(necessidade - coberturaPpu, 0) && (necessidade - coberturaPpu) > 0 ? 'full' : 'partial',
      });
    }

    const odaInfo = context.odaMap.get(row.pn);
    const coberturaOda = Math.min(saldo, toNumber(odaInfo?.quantidade));
    if (coberturaOda > 0) {
      saldo -= coberturaOda;
      totalOda += coberturaOda;
      sections.oda.push({
        ...row,
        cobertura_etapa: Number(coberturaOda.toFixed(2)),
        saldo_apos_etapa: Number(saldo.toFixed(2)),
        documento_referencia: odaInfo?.docs ? Array.from(odaInfo.docs).join(' | ') : '',
        row_tone: 'partial',
      });
    }

    const priceInfo = context.costRefMap.get(row.pn) || context.priceMap.get(row.pn);
    if (saldo > 0 && priceInfo) {
      const valorUnit = toNumber(priceInfo.valor_unitario);
      sections.pricelist.push({
        ...row,
        cobertura_etapa: '',
        saldo_apos_etapa: Number(saldo.toFixed(2)),
        valor_unitario_gbp: valorUnit,
        valor_total_gbp: Number((valorUnit * saldo).toFixed(2)),
        observacao: `Referência de preço (${priceInfo.fonte || 'PRICE LIST'}) — não consome saldo.`,
        row_tone: 'info',
      });
    }

    const odcInfo = context.odcMap.get(row.pn);
    const coberturaOdc = Math.min(saldo, toNumber(odcInfo?.quantidade));
    if (coberturaOdc > 0) {
      saldo -= coberturaOdc;
      totalOdc += coberturaOdc;
      sections.odc.push({
        ...row,
        cobertura_etapa: Number(coberturaOdc.toFixed(2)),
        saldo_apos_etapa: Number(saldo.toFixed(2)),
        documento_referencia: odcInfo?.docs ? Array.from(odcInfo.docs).join(' | ') : '',
        row_tone: 'partial',
      });
    }

    if (saldo > 0) {
      const valorUnit = toNumber(priceInfo?.valor_unitario);
      const valorTotal = valorUnit > 0 ? Number((valorUnit * saldo).toFixed(2)) : 0;
      totalComprar += saldo;
      valorComprar += valorTotal;
      sections.comprar.push({
        ...row,
        cobertura_etapa: '',
        saldo_apos_etapa: Number(saldo.toFixed(2)),
        valor_unitario_gbp: valorUnit || null,
        valor_total_gbp: valorTotal || null,
        observacao: priceInfo ? `Comprar — valor estimado por ${priceInfo.fonte || 'PRICE LIST'}.` : 'Comprar — sem referência vigente de valor.',
        row_tone: 'buy',
      });
    }
  });

  return {
    arquivo: {
      nome: parsedFile.workbookName,
      aba_lida: parsedFile.sheetName,
      linhas_lidas: parsedFile.linhasLidas,
      linhas_base: inputRows.length,
    },
    columns: parsedFile.columns,
    input: inputRows.map((row) => ({
      pn: row.pn,
      nsn: row.nsn || '',
      nomenclatura: row.nomenclatura || '',
      quantidade_total: row.necessidade_total,
    })),
    summary: {
      linhas_base: inputRows.length,
      necessidade_total: Number(inputRows.reduce((acc, row) => acc + toNumber(row.necessidade_total), 0).toFixed(2)),
      coberto_ppu: Number(totalPpu.toFixed(2)),
      coberto_ceimspa: Number(totalCeimspa.toFixed(2)),
      coberto_oda: Number(totalOda.toFixed(2)),
      coberto_odc: Number(totalOdc.toFixed(2)),
      comprar_qtd: Number(totalComprar.toFixed(2)),
      comprar_valor_gbp: Number(valorComprar.toFixed(2)),
    },
    sections,
  };
}

function formatBatchInputRows(rows = []) {
  return rows.map((row) => ({
    PN: row.pn,
    NSN: row.nsn || '',
    Nomenclatura: row.nomenclatura || '',
    Quantidade_Solicitada: row.quantidade_total,
  }));
}

exports.previewBatchQuery = async (req, res) => {
  try {
    const context = await loadGeneratorContext();
    const parsed = parseUploadedBatchWorkbook(req.file);
    const preview = buildBatchQueryPreview(parsed, context);
    return res.status(200).json({ status: 'success', data: preview });
  } catch (error) {
    const statusCode = error?.statusCode || 500;
    return res.status(statusCode).json({ status: 'error', message: error?.message || 'Falha ao processar a pesquisa em lote.' });
  }
};

exports.exportBatchQueryXlsx = async (req, res) => {
  try {
    const context = await loadGeneratorContext();
    const parsed = parseUploadedBatchWorkbook(req.file);
    const preview = buildBatchQueryPreview(parsed, context);

    const workbook = xlsx.utils.book_new();
    const resumoRows = [
      { Indicador: 'Arquivo', Valor: preview.arquivo.nome },
      { Indicador: 'Aba lida', Valor: preview.arquivo.aba_lida },
      { Indicador: 'Linhas lidas', Valor: preview.arquivo.linhas_lidas },
      { Indicador: 'Linhas base', Valor: preview.summary.linhas_base },
      { Indicador: 'Necessidade total', Valor: preview.summary.necessidade_total },
      { Indicador: 'Coberto PPU', Valor: preview.summary.coberto_ppu },
      { Indicador: 'Coberto CeIMSPA', Valor: preview.summary.coberto_ceimspa },
      { Indicador: 'Coberto ODA', Valor: preview.summary.coberto_oda },
      { Indicador: 'Coberto ODC', Valor: preview.summary.coberto_odc },
      { Indicador: 'Comprar qtd', Valor: preview.summary.comprar_qtd },
      { Indicador: 'Comprar valor GBP', Valor: preview.summary.comprar_valor_gbp },
    ];
    xlsx.utils.book_append_sheet(workbook, xlsx.utils.json_to_sheet(resumoRows), '00_RESUMO');
    xlsx.utils.book_append_sheet(workbook, xlsx.utils.json_to_sheet(formatBatchInputRows(preview.input)), '00_ENTRADA');

    [
      ['01_PPU', preview.sections.ppu],
      ['02_CEIMSPA', preview.sections.ceimspa],
      ['03_ODA', preview.sections.oda],
      ['04_PRICELIST', preview.sections.pricelist],
      ['05_ODC', preview.sections.odc],
      ['06_COMPRAR', preview.sections.comprar],
    ].forEach(([name, rows]) => {
      xlsx.utils.book_append_sheet(workbook, xlsx.utils.json_to_sheet(formatWorkbookRows(rows)), name);
    });

    const buffer = xlsx.write(workbook, { type: 'buffer', bookType: 'xlsx' });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="pesquisa_em_lote_${stamp}.xlsx"`);
    return res.status(200).send(buffer);
  } catch (error) {
    const statusCode = error?.statusCode || 500;
    return res.status(statusCode).json({ status: 'error', message: error?.message || 'Falha ao exportar o Excel da pesquisa em lote.' });
  }
};

exports.previewGenerator = async (req, res) => {
  try {
    const context = await loadGeneratorContext();
    const preview = buildGeneratorPreview(req.body || {}, context);
    return res.status(200).json({ status: 'success', data: preview });
  } catch (_) {
    return res.status(500).json({ status: 'error', message: 'Falha ao gerar a prévia da necessidade.' });
  }
};

exports.exportGeneratorXlsx = async (req, res) => {
  try {
    const context = await loadGeneratorContext();
    const preview = buildGeneratorPreview(req.body || {}, context);

    const workbook = xlsx.utils.book_new();
    const sheets = [
      ['01_PPU', preview.sections.ppu],
      ['02_CEIMSPA', preview.sections.ceimspa],
      ['03_ODA', preview.sections.oda],
      ['04_PRICELIST', preview.sections.pricelist],
      ['05_ODC', preview.sections.odc],
      ['06_COMPRAR', preview.sections.comprar],
    ];

    sheets.forEach(([name, rows]) => {
      const worksheet = xlsx.utils.json_to_sheet(formatWorkbookRows(rows));
      xlsx.utils.book_append_sheet(workbook, worksheet, name);
    });

    const buffer = xlsx.write(workbook, { type: 'buffer', bookType: 'xlsx' });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="gerador_necessidades_${stamp}.xlsx"`);
    return res.status(200).send(buffer);
  } catch (_) {
    return res.status(500).json({ status: 'error', message: 'Falha ao exportar o Excel do gerador.' });
  }
};

exports.getOperationalCostOptions = async (req, res) => {
  try {
    const context = await loadOptionsContext();
    return res.status(200).json({ status: 'success', data: { receitas: context.receitaOptions, origens: context.origemOptions, sbs: context.sbOptions } });
  } catch (_) {
    return res.status(500).json({ status: 'error', message: 'Falha ao carregar filtros de custo operacional.' });
  }
};

exports.previewOperationalCost = async (req, res) => {
  try {
    const context = await loadGeneratorContext();
    const preview = buildOperationalCostPreview(req.body || {}, context);
    return res.status(200).json({ status: 'success', data: preview });
  } catch (_) {
    return res.status(500).json({ status: 'error', message: 'Falha ao calcular custo operacional.' });
  }
};

exports.listServiceBulletins = async (req, res) => {
  try {
    const context = await loadOptionsContext();
    const rows = (context.sbOptions || []).map((item) => ({
      ...item,
      acao_principal: inferSbActionType((context.sbRows || []).find((row) => row.sb_numero === item.sb_numero) || {}, context.sbItemsByNumero.get(item.sb_numero) || []),
      itens_sem_cobertura: null,
      itens_sem_qtd_definida: item.qtd_definida ? 0 : item.total_itens,
      valor_estimado_gbp: null,
    }));
    return res.status(200).json({ status: 'success', data: rows });
  } catch (_) {
    return res.status(500).json({ status: 'error', message: 'Falha ao listar Service Bulletins.' });
  }
};

exports.getServiceBulletinDetail = async (req, res) => {
  try {
    const sbNumero = String(req.params.sbNumero || '').trim();
    const context = await loadGeneratorContext();
    const header = (context.sbRows || []).find((row) => String(row.sb_numero || '').trim() === sbNumero);
    if (!header) return res.status(404).json({ status: 'error', message: 'SB não encontrada.' });
    const detail = buildSbDetail(header, context);
    return res.status(200).json({ status: 'success', data: detail });
  } catch (_) {
    return res.status(500).json({ status: 'error', message: 'Falha ao carregar a SB.' });
  }
};

exports.updateServiceBulletin = async (req, res) => {
  try {
    const sbNumero = String(req.params.sbNumero || '').trim();
    if (!sbNumero) return res.status(400).json({ status: 'error', message: 'Informe a SB.' });
    const payload = {};
    if (req.body?.status_acao != null) payload.status_acao = String(req.body.status_acao || '').trim() || 'SEM_ACAO';
    if (req.body?.observacao != null) payload.observacao = safeString(req.body.observacao);
    payload.updated_at = new Date().toISOString();
    const { error } = await supabase.from('service_bulletins').update(payload).eq('sb_numero', sbNumero);
    if (error) throw error;
    invalidateNeedsCache();
    return res.status(200).json({ status: 'success', message: 'SB atualizada com sucesso.' });
  } catch (_) {
    return res.status(500).json({ status: 'error', message: 'Falha ao atualizar a SB.' });
  }
};

exports.deleteServiceBulletin = async (req, res) => {
  try {
    const sbNumero = String(req.params.sbNumero || '').trim();
    if (!sbNumero) return res.status(400).json({ status: 'error', message: 'Informe a SB.' });

    const { error: itemsError } = await supabase.from('service_bulletin_items').delete().eq('sb_numero', sbNumero);
    if (itemsError) throw itemsError;
    const { error: headerError } = await supabase.from('service_bulletins').delete().eq('sb_numero', sbNumero);
    if (headerError) throw headerError;

    invalidateNeedsCache();
    return res.status(200).json({ status: 'success', message: 'SB excluída com sucesso.' });
  } catch (_) {
    return res.status(500).json({ status: 'error', message: 'Falha ao excluir a SB.' });
  }
};
