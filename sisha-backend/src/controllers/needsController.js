const xlsx = require('xlsx');
const crypto = require('crypto');
const supabase = require('../config/supabaseClient');
const { normalizePn } = require('../utils/importAliases');
const { loadReferencePriceRows, buildReferencePriceMap } = require('../services/pricingService');
const { prepareQuoteRequestItems, exportQuoteRequest } = require('../services/quoteRequestService');
const { resolvePnRelations } = require('../services/pnRelationsService');
const { ACTIVE_AIRCRAFT_CODES, WORKSHOP_MAP, parseOsDomain, isMtCode } = require('../services/osDomainService');
const { buildAircraftAvailabilityMap, buildMtAvailabilityDecision } = require('../services/mtNeedPolicyService');
const { loadCurrentAvailabilityRows, loadCurrentMaintenanceIndicators } = require('../services/aircraftAvailabilityService');
const { loadGeneratorOperationalRows, classifyMaintenanceIndicatorSemantic } = require('../services/aircraftOperationalStateService');
const { loadMaintenanceProgram } = require('../services/maintenancePlanningService');
const { loadAllEffectivePpuRows } = require('../services/ppuEffectiveAvailabilityService');
const { buildRecipePolicyDeficiency, formatRecipePolicyDeficiencyRows } = require('../services/recipePolicyDeficiencyService');
const { pendingPurchaseQty, isFuturePurchaseCoverageStatus, isOdcProcessStatus } = require('../services/pdLifecyclePolicyService');
const { setAuditSummary, recordAuditIssue } = require('../utils/importAudit');

const PAGE_SIZE = 1000;
const ANV_CODES = ACTIVE_AIRCRAFT_CODES;
const OFICINA_MAP = WORKSHOP_MAP;
const ORIGEM_ALLOWED_ORDER = [
  { tipo: 'OFICINA', codigo: 'HV', descricao: OFICINA_MAP.HV },
  { tipo: 'OFICINA', codigo: 'MV', descricao: OFICINA_MAP.MV },
  { tipo: 'OFICINA', codigo: 'SV', descricao: OFICINA_MAP.SV },
  { tipo: 'OFICINA', codigo: 'VN', descricao: OFICINA_MAP.VN },
  { tipo: 'OFICINA', codigo: 'PA', descricao: OFICINA_MAP.PA },
  { tipo: 'OFICINA', codigo: 'MTVN', descricao: OFICINA_MAP.MTVN },
  { tipo: 'OFICINA', codigo: 'MTMV', descricao: OFICINA_MAP.MTMV },
  { tipo: 'OFICINA', codigo: 'MTHV', descricao: OFICINA_MAP.MTHV },
  { tipo: 'OFICINA', codigo: 'MTAP', descricao: OFICINA_MAP.MTAP },
  { tipo: 'OFICINA', codigo: 'MTSV', descricao: OFICINA_MAP.MTSV },
  { tipo: 'OFICINA', codigo: 'MTPA', descricao: OFICINA_MAP.MTPA },
  { tipo: 'OFICINA', codigo: 'MTAR', descricao: OFICINA_MAP.MTAR },
  { tipo: 'OFICINA', codigo: 'MTVA', descricao: OFICINA_MAP.MTVA },
  { tipo: 'OFICINA', codigo: 'MT', descricao: OFICINA_MAP.MT },
  ...ANV_CODES.map((codigo) => ({ tipo: 'ANV', codigo, descricao: `AERONAVE ${codigo}` })),
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

function getCeimspaQuantity(context, pn, pis = []) {
  const pnKey = normalizeKey(pn);
  const piSet = new Set((pis || []).map(normalizeUpper).filter(Boolean));
  return (context.ceimspaRows || []).reduce((sum, row) => {
    const rowPn = normalizeKey(row.pn);
    const rowPi = normalizeUpper(row.pi);
    const directPnMatch = rowPn && rowPn === pnKey;
    const manualPiMatch = !rowPn && rowPi && piSet.has(rowPi);
    return directPnMatch || manualPiMatch ? sum + toNumber(row.quantidade) : sum;
  }, 0);
}

function roundQuantity(value) {
  return Number(toNumber(value).toFixed(2));
}

function formatPpuLocationReference(ppuInfo) {
  if (!ppuInfo?.locais) return '';
  if (ppuInfo.locais instanceof Map) {
    return Array.from(ppuInfo.locais.entries())
      .sort(([a], [b]) => String(a).localeCompare(String(b), 'pt-BR'))
      .map(([local, quantidade]) => `${local} (${roundQuantity(quantidade)})`)
      .join(' | ');
  }
  return Array.from(ppuInfo.locais).join(' | ');
}

function buildAvailabilitySections(baseRows = [], context) {
  const sections = { ppu: [], ceimspa: [], oda: [], pricelist: [], odc: [], comprar: [] };
  let totalPpu = 0;
  let totalCeimspa = 0;
  let totalOda = 0;
  let totalOdc = 0;
  let totalComprar = 0;
  let valorComprar = 0;
  let appliedPpu = 0;
  let appliedCeimspa = 0;
  let appliedOda = 0;

  baseRows.forEach((row) => {
    const necessidade = toNumber(row.necessidade_total);
    let faltam = necessidade;

    const ppuInfo = context.ppuMap.get(row.pn);
    const disponivelPpu = Math.max(0, toNumber(ppuInfo?.quantidade));
    const ppuAplicado = Math.min(faltam, disponivelPpu);
    faltam = Math.max(0, faltam - disponivelPpu);
    totalPpu += disponivelPpu;
    appliedPpu += ppuAplicado;
    if (disponivelPpu > 0) {
      sections.ppu.push({
        ...row,
        disponivel_etapa: roundQuantity(disponivelPpu),
        aplicado_na_necessidade: roundQuantity(ppuAplicado),
        faltam_apos_etapa: roundQuantity(faltam),
        cobertura_etapa: roundQuantity(ppuAplicado),
        saldo_apos_etapa: roundQuantity(faltam),
        documento_referencia: formatPpuLocationReference(ppuInfo),
        row_tone: faltam <= 0 ? 'full' : 'partial',
      });
    }

    const pis = Array.from(context.pnPiMap.get(row.pn) || []);
    const disponivelCeimspa = Math.max(0, getCeimspaQuantity(context, row.pn, pis));
    const ceimspaAplicado = Math.min(faltam, disponivelCeimspa);
    faltam = Math.max(0, faltam - disponivelCeimspa);
    totalCeimspa += disponivelCeimspa;
    appliedCeimspa += ceimspaAplicado;
    if (disponivelCeimspa > 0) {
      sections.ceimspa.push({
        ...row,
        disponivel_etapa: roundQuantity(disponivelCeimspa),
        aplicado_na_necessidade: roundQuantity(ceimspaAplicado),
        faltam_apos_etapa: roundQuantity(faltam),
        cobertura_etapa: roundQuantity(ceimspaAplicado),
        saldo_apos_etapa: roundQuantity(faltam),
        documento_referencia: pis.join(' | '),
        row_tone: faltam <= 0 ? 'full' : 'partial',
      });
    }

    // Somente ODA ainda pendente representa aquisição futura já efetivada.
    // FAT/EMB/REC são históricos de entrega/recebimento e não entram neste mapa.
    const odaInfo = context.odaMap.get(row.pn);
    const disponivelOda = Math.max(0, toNumber(odaInfo?.quantidade));
    const odaAplicado = Math.min(faltam, disponivelOda);
    faltam = Math.max(0, faltam - disponivelOda);
    totalOda += disponivelOda;
    appliedOda += odaAplicado;
    if (disponivelOda > 0) {
      sections.oda.push({
        ...row,
        disponivel_etapa: roundQuantity(disponivelOda),
        aplicado_na_necessidade: roundQuantity(odaAplicado),
        faltam_apos_etapa: roundQuantity(faltam),
        cobertura_etapa: roundQuantity(odaAplicado),
        saldo_apos_etapa: roundQuantity(faltam),
        documento_referencia: odaInfo?.docs ? Array.from(odaInfo.docs).join(' | ') : '',
        observacao: 'ODA = compra efetivada ainda a receber. Apenas o saldo pendente reduz nova necessidade de aquisição.',
        row_tone: faltam <= 0 ? 'full' : 'partial',
      });
    }

    const priceInfo = context.costRefMap.get(row.pn) || context.priceMap.get(row.pn);
    if (faltam > 0 && priceInfo) {
      const valorUnit = toNumber(priceInfo.valor_unitario);
      const priceMeta = buildPricePresentation(priceInfo);
      sections.pricelist.push({
        ...row,
        ...priceMeta,
        disponivel_etapa: '',
        faltam_apos_etapa: roundQuantity(faltam),
        cobertura_etapa: '',
        saldo_apos_etapa: roundQuantity(faltam),
        valor_unitario_gbp: valorUnit,
        valor_total_gbp: Number((valorUnit * faltam).toFixed(2)),
        observacao: priceMeta.preco_estimativa
          ? `ESTIMATIVA por ${priceMeta.fonte_exibicao || 'fonte histórica'} — requer atualização de cotação; não altera o que falta.`
          : `Referência de preço (${priceMeta.fonte_exibicao || 'PRICE LIST'}) — não altera o que falta.`,
        row_tone: 'info',
      });
    }

    // ODC é processo administrativo em andamento. Deve ficar em evidência para
    // suplementação/liberação, mas NUNCA abate a quantidade que ainda precisa ser adquirida.
    const odcInfo = context.odcMap.get(row.pn);
    const disponivelOdc = Math.max(0, toNumber(odcInfo?.quantidade));
    totalOdc += disponivelOdc;
    if (disponivelOdc > 0) {
      sections.odc.push({
        ...row,
        disponivel_etapa: roundQuantity(disponivelOdc),
        aplicado_na_necessidade: 0,
        faltam_apos_etapa: roundQuantity(faltam),
        cobertura_etapa: 0,
        saldo_apos_etapa: roundQuantity(faltam),
        documento_referencia: odcInfo?.docs ? Array.from(odcInfo.docs).join(' | ') : '',
        observacao: `PD ODC em andamento (${roundQuantity(disponivelOdc)} un). Não abate a necessidade; priorizar suplementação/liberação do processo existente.`,
        row_tone: 'info',
      });
    }

    if (faltam > 0) {
      const valorUnit = toNumber(priceInfo?.valor_unitario);
      const valorTotal = valorUnit > 0 ? Number((valorUnit * faltam).toFixed(2)) : 0;
      totalComprar += faltam;
      valorComprar += valorTotal;
      const priceMeta = buildPricePresentation(priceInfo || null);
      const coberturaEfetiva = Math.min(necessidade, ppuAplicado + ceimspaAplicado + odaAplicado);
      sections.comprar.push({
        ...row,
        ...priceMeta,
        necessidade_total_gerador: roundQuantity(necessidade),
        ppu_disponivel: roundQuantity(disponivelPpu),
        ppu_aplicado: roundQuantity(ppuAplicado),
        ceimspa_disponivel: roundQuantity(disponivelCeimspa),
        ceimspa_aplicado: roundQuantity(ceimspaAplicado),
        oda_a_receber: roundQuantity(disponivelOda),
        oda_aplicado: roundQuantity(odaAplicado),
        odc_em_andamento: roundQuantity(disponivelOdc),
        cobertura_total_efetiva: roundQuantity(coberturaEfetiva),
        cobertura_percentual: necessidade > 0 ? Number(((coberturaEfetiva / necessidade) * 100).toFixed(1)) : 100,
        deficit_liquido: roundQuantity(faltam),
        disponivel_etapa: '',
        faltam_apos_etapa: roundQuantity(faltam),
        cobertura_etapa: '',
        saldo_apos_etapa: roundQuantity(faltam),
        documento_referencia: odcInfo?.docs?.size
          ? `ODC em andamento: ${Array.from(odcInfo.docs).join(' | ')}`
          : '',
        valor_unitario_gbp: valorUnit || null,
        valor_total_gbp: valorTotal || null,
        observacao: `${priceInfo
          ? (priceMeta.preco_estimativa
            ? `Comprar — ESTIMATIVA por ${priceMeta.fonte_exibicao || 'fonte histórica'}; solicitar nova cotação.`
            : `Comprar — preço por ${priceMeta.fonte_exibicao || 'PRICE LIST'}.`)
          : 'Comprar — sem referência de valor; solicitar cotação.'}${disponivelOdc > 0 ? ' Já existe ODC: priorizar suplementação/liberação antes de abrir processo duplicado.' : ''}`,
        row_tone: 'buy',
      });
    }
  });

  return {
    sections,
    totals: {
      ppu: roundQuantity(totalPpu),
      ceimspa: roundQuantity(totalCeimspa),
      oda: roundQuantity(totalOda),
      odc: roundQuantity(totalOdc),
      ppu_aplicado: roundQuantity(appliedPpu),
      ceimspa_aplicado: roundQuantity(appliedCeimspa),
      oda_aplicado: roundQuantity(appliedOda),
      cobertura_efetiva: roundQuantity(appliedPpu + appliedCeimspa + appliedOda),
      comprar: roundQuantity(totalComprar),
      valorComprar: Number(valorComprar.toFixed(2)),
    },
  };
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


function buildCanonicalPurchaseStageMaps(purchaseRows = [], odaFallbackMap = new Map(), odcFallbackMap = new Map()) {
  const odaMap = new Map();
  const odcMap = new Map();
  const canonicalPn = new Set();

  const add = (map, pn, qty, doc) => {
    if (!pn || qty <= 0) return;
    if (!map.has(pn)) map.set(pn, { quantidade: 0, docs: new Set() });
    const ref = map.get(pn);
    ref.quantidade += qty;
    if (doc) ref.docs.add(doc);
  };

  (purchaseRows || []).forEach((row) => {
    if (row?.ativo === false) return;
    const pn = normalizeKey(row?.pn);
    if (!pn) return;
    canonicalPn.add(pn);
    const status = normalizeUpper(row?.status_grupo || row?.status);
    const qty = pendingPurchaseQty(row);
    const doc = safeString(row?.numero_pd || row?.documento_referencia || row?.numero_oc);
    if (isFuturePurchaseCoverageStatus(status)) add(odaMap, pn, qty, doc);
    else if (isOdcProcessStatus(status)) add(odcMap, pn, qty, doc);
  });

  // Compatibilidade: se o PN ainda não possui qualquer PD canônico, aceita a
  // leitura histórica das views/snapshots legados. Havendo PD canônico, ele é a verdade.
  for (const [pnRaw, info] of odaFallbackMap.entries()) {
    const pn = normalizeKey(pnRaw);
    if (!pn || canonicalPn.has(pn)) continue;
    add(odaMap, pn, Math.max(0, toNumber(info?.quantidade)), null);
    if (info?.docs && odaMap.has(pn)) Array.from(info.docs).forEach((doc) => doc && odaMap.get(pn).docs.add(doc));
  }
  for (const [pnRaw, info] of odcFallbackMap.entries()) {
    const pn = normalizeKey(pnRaw);
    if (!pn || canonicalPn.has(pn)) continue;
    add(odcMap, pn, Math.max(0, toNumber(info?.quantidade)), null);
    if (info?.docs && odcMap.has(pn)) Array.from(info.docs).forEach((doc) => doc && odcMap.get(pn).docs.add(doc));
  }

  return { odaMap, odcMap, canonicalPn };
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


function normalizeHeaderLabel(value = '') {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, ' ')
    .trim();
}

const PIM_HEADER_ALIASES = {
  pim: ['PIM', 'NUMERO PIM', 'NUM PIM', 'NR PIM', 'N PIM'],
  pn: ['PN', 'P N', 'PART NUMBER', 'PART NUMER', 'PART NO'],
  quantidade: ['QTD', 'QTDE', 'QTE', 'QUANTIDADE', 'QTY', 'QUANTITY'],
  os_vinculada: ['OS', 'NUMERO OS', 'NUM OS', 'NR OS', 'ORDEM DE SERVICO', 'ORDEM SERVICO'],
  data_solicitacao: ['DATA', 'DATA SOLICITACAO', 'DATA PIM', 'DT SOLICITACAO', 'DT PIM'],
  nsn: ['NSN', 'NATO STOCK NUMBER', 'PI', 'NSN PI'],
  nomenclatura: ['NOMENCLATURA', 'DESCRIPTION', 'DESCRICAO', 'ITEM'],
  observacoes: ['OBS', 'OBSERVACAO', 'OBSERVACOES', 'COMMENTS', 'COMENTARIO'],
};

function findPimHeaderIndex(rows = []) {
  const aliasSet = Object.fromEntries(Object.entries(PIM_HEADER_ALIASES).map(([key, aliases]) => [key, new Set(aliases.map(normalizeHeaderLabel))]));
  const max = Math.min(rows.length, 40);
  for (let index = 0; index < max; index += 1) {
    const normalized = (rows[index] || []).map(normalizeHeaderLabel);
    const has = (key) => normalized.some((value) => aliasSet[key].has(value));
    if (has('pim') && has('pn') && has('quantidade') && has('os_vinculada')) return index;
  }
  return -1;
}

function buildPimHeaderMap(headers = []) {
  const normalized = headers.map(normalizeHeaderLabel);
  const map = {};
  Object.entries(PIM_HEADER_ALIASES).forEach(([key, aliases]) => {
    const set = new Set(aliases.map(normalizeHeaderLabel));
    map[key] = normalized.findIndex((value) => set.has(value));
  });
  return map;
}

function parsePimSnapshotWorkbook(file) {
  if (!file?.buffer) {
    const error = new Error('Selecione o arquivo PIM a importar.');
    error.statusCode = 400;
    throw error;
  }
  if (!/\.(xlsx?|xls|csv|ods)$/i.test(file.originalname || '')) {
    const error = new Error('PIM: envie XLSX, XLS, ODS ou CSV.');
    error.statusCode = 400;
    throw error;
  }

  const workbook = xlsx.read(file.buffer, { type: 'buffer', cellDates: true });
  const parsedRows = [];
  const issues = [];
  let physicalRows = 0;
  const sheetStats = [];

  (workbook.SheetNames || []).forEach((sheetName) => {
    const sheet = workbook.Sheets[sheetName];
    const matrix = xlsx.utils.sheet_to_json(sheet, { header: 1, raw: true, defval: null });
    if (!matrix.length) return;
    const headerIndex = findPimHeaderIndex(matrix);
    if (headerIndex < 0) {
      sheetStats.push({ sheet: sheetName, status: 'IGNORADA_SEM_CABECALHO_PIM', rows: matrix.length });
      return;
    }

    const headers = matrix[headerIndex] || [];
    const columns = buildPimHeaderMap(headers);
    let validInSheet = 0;
    for (let i = headerIndex + 1; i < matrix.length; i += 1) {
      const row = matrix[i] || [];
      if (!row.some((value) => value !== null && value !== undefined && String(value).trim() !== '')) continue;
      physicalRows += 1;

      const pim = safeString(row[columns.pim]);
      const pn = normalizePn(row[columns.pn]);
      const quantidade = toNumber(row[columns.quantidade]);
      const osVinculada = normalizeUpper(row[columns.os_vinculada]);
      const sourceRow = i + 1;
      if (!pim || !pn || quantidade <= 0 || !osVinculada) {
        issues.push({
          linha_numero: sourceRow,
          campo: 'PIM/PN/QTD/OS',
          valor_original: [pim, pn, row[columns.quantidade], osVinculada].filter(Boolean).join(' | '),
          motivo: `Aba ${sheetName}: linha ignorada porque PIM, PN, quantidade positiva e OS são obrigatórios.`,
        });
        continue;
      }

      const origem = parseOsOrigem(osVinculada);
      const nomenclatura = columns.nomenclatura >= 0 ? safeString(row[columns.nomenclatura]) : null;
      const obsOriginal = columns.observacoes >= 0 ? safeString(row[columns.observacoes]) : null;
      const observacoes = [obsOriginal, nomenclatura ? `Nomenclatura do arquivo: ${nomenclatura}` : null].filter(Boolean).join(' | ') || null;
      const sourcePayload = {};
      headers.forEach((header, colIndex) => {
        const key = safeString(header) || `COL_${colIndex + 1}`;
        const value = row[colIndex];
        if (value !== null && value !== undefined && String(value).trim() !== '') sourcePayload[key] = value instanceof Date ? value.toISOString() : value;
      });

      parsedRows.push({
        pim,
        data_solicitacao: columns.data_solicitacao >= 0 ? parseDateInput(row[columns.data_solicitacao]) : null,
        pn,
        nsn: columns.nsn >= 0 ? safeString(row[columns.nsn]) : null,
        quantidade: roundQuantity(quantidade),
        os_vinculada: osVinculada,
        observacoes,
        origem_tipo: origem.origem_tipo,
        origem_codigo: origem.origem_codigo,
        origem_descricao: origem.origem_descricao,
        source_sheet: sheetName,
        source_row: sourceRow,
        source_payload: sourcePayload,
      });
      validInSheet += 1;
    }
    sheetStats.push({ sheet: sheetName, status: 'LIDA', rows: matrix.length, valid: validInSheet });
  });

  if (!parsedRows.length) {
    const error = new Error('PIM: nenhuma linha válida encontrada. O arquivo precisa conter PIM, PN, QTD e OS.');
    error.statusCode = 400;
    error.pimIssues = issues;
    throw error;
  }

  return {
    rows: parsedRows,
    issues,
    physicalRows,
    sheetStats,
    sha256: crypto.createHash('sha256').update(file.buffer).digest('hex'),
  };
}

function parseOsOrigem(osVinculada) {
  const parsed = parseOsDomain(osVinculada);
  return {
    origem_tipo: parsed.tipo,
    origem_codigo: parsed.codigo,
    origem_descricao: parsed.descricao,
  };
}

function isMtOrigem(row = {}) {
  return normalizeUpper(row.origem_tipo) === 'OFICINA' && isMtCode(row.origem_codigo);
}

function collectSelectedPimRows(pimRows = [], selectedOrigemSet = new Set()) {
  return (pimRows || []).map((row) => {
    const origem = resolvePimOrigem(row);
    const origemKey = buildOrigemKey(origem);
    return {
      row,
      origem,
      origemKey,
      pn: normalizeKey(row.pn),
      isMt: isMtOrigem(origem),
      isAircraft: normalizeUpper(origem.origem_tipo) === 'ANV',
    };
  }).filter(({ row, origemKey }) => {
    if (!normalizeKey(row.pn)) return false;
    return selectedOrigemSet.size === 0 || selectedOrigemSet.has(origemKey);
  });
}

function buildPricePresentation(priceInfo = null) {
  if (!priceInfo) {
    return {
      fonte_valor: null,
      fonte_exibicao: null,
      documento_fonte: null,
      data_referencia: null,
      validade_preco: null,
      preco_vigente: false,
      preco_estimativa: false,
      necessita_cotacao: true,
      status_preco: 'SEM_PRECO',
    };
  }
  return {
    fonte_valor: priceInfo.fonte_preco || priceInfo.fonte || null,
    fonte_exibicao: priceInfo.fonte_exibicao || priceInfo.fonte_preco || priceInfo.fonte || null,
    documento_fonte: priceInfo.documento_fonte || null,
    data_referencia: priceInfo.data_referencia || null,
    validade_preco: priceInfo.validade || null,
    preco_vigente: priceInfo.vigente === true,
    preco_estimativa: Boolean(priceInfo.estimativa),
    necessita_cotacao: Boolean(priceInfo.necessita_cotacao),
    status_preco: priceInfo.status_preco || null,
  };
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

function formatWorkbookRows(rows = []) {
  return rows.map((row) => ({
    PN: row.pn,
    NSN: row.nsn || '',
    Nomenclatura: row.nomenclatura || '',
    Necessidade_Total: row.necessidade_total,
    Necessidade_Total_Gerador: row.necessidade_total_gerador ?? row.necessidade_total ?? '',
    Necessidade_Politica_2_Anos: row.necessidade_politica_2_anos ?? '',
    PPU_Atual: row.ppu_disponivel ?? '',
    CeIMSPA_Atual: row.ceimspa_disponivel ?? '',
    ODA_A_Receber: row.oda_a_receber ?? '',
    ODC_Em_Andamento_Nao_Abate: row.odc_em_andamento ?? '',
    Cobertura_Efetiva_PPU_CeIMSPA_ODA: row.cobertura_total_efetiva ?? '',
    Cobertura_Percentual: row.cobertura_percentual ?? '',
    Deficit_Liquido_A_Comprar: row.deficit_liquido ?? '',
    Deficit_Politica_2_Anos: row.deficit_politica_2_anos ?? '',
    Politica_Receitas: row.politica_receitas_texto ?? '',
    Disponivel_na_Etapa: row.disponivel_etapa ?? row.cobertura_etapa ?? '',
    Faltam_Apos_Etapa: row.faltam_apos_etapa ?? row.saldo_apos_etapa ?? '',
    Usado_em_Receita: row.usado_em_receita || (row.receitas_texto ? 'SIM' : ''),
    Receitas: row.receitas_texto || '',
    Receita_Qtd_Por_Ciclo: row.receita_qtd_por_ciclo_texto || '',
    Receita_PN_Base: row.receita_pn_base_texto || '',
    Receita_Vinculo: row.receita_vinculo_texto || '',
    PIMs: row.pims_texto || '',
    Origens: row.origens_texto || '',
    Observacao: row.observacao || '',
    Documento_Ref: row.documento_referencia || '',
    Valor_Unitario_GBP: row.valor_unitario_gbp ?? '',
    Valor_Total_GBP: row.valor_total_gbp ?? '',
    Fonte_Preco: row.fonte_exibicao || row.fonte_valor || '',
    Documento_Preco: row.documento_fonte || '',
    Data_Preco: row.data_referencia || '',
    Validade_Preco: row.validade_preco || '',
    Status_Preco: row.status_preco || '',
    Estimativa: row.preco_estimativa ? 'SIM' : 'NÃO',
    Necessita_Cotacao: row.necessita_cotacao ? 'SIM' : 'NÃO',
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

function splitRecipePnList(value) {
  return String(value || '')
    .split(/[|;,\n\r]+/)
    .map((item) => normalizePn(item))
    .filter(Boolean);
}

function buildPnAlternativeMap(dicRows = [], altDocRows = []) {
  const map = new Map();
  const families = new Map();

  const add = (pn, related) => {
    const key = normalizeKey(pn);
    const alt = normalizeKey(related);
    if (!key || !alt || key === alt) return;
    if (!map.has(key)) map.set(key, new Set());
    map.get(key).add(alt);
  };

  (dicRows || []).forEach((row) => {
    const dmc = String(row.dmc || '').trim();
    const item = String(row.item_num || '').trim();
    const pn = normalizeKey(row.pn);
    if (!dmc || !item || !pn) return;
    const familyKey = `${dmc}|${item}`;
    if (!families.has(familyKey)) families.set(familyKey, new Set());
    families.get(familyKey).add(pn);
  });

  families.forEach((members) => {
    const list = Array.from(members);
    list.forEach((pn) => list.forEach((alt) => add(pn, alt)));
  });

  (altDocRows || []).forEach((row) => {
    add(row.pn, row.pn_alt);
    add(row.pn_alt, row.pn);
  });

  return map;
}

function buildRecipeApplicationMap(receitaRows = [], alternativeMap = new Map()) {
  const map = new Map();
  const seen = new Set();

  const addApplication = (lookupPn, row = {}, tipoVinculo = 'PN DA RECEITA') => {
    const key = normalizeKey(lookupPn);
    const pnReceita = normalizeKey(row.pn);
    const inspecao = String(row.inspecao || '').trim();
    if (!key || !inspecao) return;

    const qtdPorCiclo = toNumber(row.qtd_por_ciclo);
    const dedupeKey = [key, inspecao, pnReceita, tipoVinculo, qtdPorCiclo].join('::');
    if (seen.has(dedupeKey)) return;
    seen.add(dedupeKey);

    if (!map.has(key)) map.set(key, []);
    map.get(key).push({
      pn_consulta: key,
      pn_receita: pnReceita || key,
      inspecao,
      qtd_por_ciclo: qtdPorCiclo,
      nomenclatura: safeString(row.nomenclatura),
      tipo_vinculo: tipoVinculo,
    });
  };

  (receitaRows || []).forEach((row) => {
    const pnReceita = normalizeKey(row.pn);
    if (pnReceita) addApplication(pnReceita, row, 'PN DA RECEITA');

    splitRecipePnList(row.pn_alt).forEach((pnAlt) => {
      if (pnAlt && pnAlt !== pnReceita) addApplication(pnAlt, row, 'PN ALTERNATIVO DA RECEITA');
    });

    Array.from(alternativeMap.get(pnReceita) || []).forEach((pnAlt) => {
      if (pnAlt && pnAlt !== pnReceita) addApplication(pnAlt, row, 'PN ALTERNATIVO CONSOLIDADO (CIETP/DOCUMENTO)');
    });
  });

  map.forEach((applications) => {
    applications.sort((a, b) => {
      const byInspecao = String(a.inspecao || '').localeCompare(String(b.inspecao || ''));
      if (byInspecao !== 0) return byInspecao;
      return String(a.pn_receita || '').localeCompare(String(b.pn_receita || ''));
    });
  });

  return map;
}

function summarizeRecipeApplications(applications = []) {
  const apps = Array.isArray(applications) ? applications : [];
  if (!apps.length) {
    return {
      usado_em_receita: 'NÃO',
      receitas_texto: '',
      receita_qtd_por_ciclo_texto: '',
      receita_pn_base_texto: '',
      receita_vinculo_texto: '',
      receita_observacao: 'Não localizado em receita cadastrada.',
    };
  }

  const receitas = [...new Set(apps.map((item) => item.inspecao).filter(Boolean))].sort();
  const qtdPorCiclo = [...new Set(apps.map((item) => {
    const qtd = toNumber(item.qtd_por_ciclo);
    return `${item.inspecao}: ${qtd > 0 ? qtd : 'sem qtd'}`;
  }).filter(Boolean))].sort();
  const pnBase = [...new Set(apps.map((item) => item.pn_receita).filter(Boolean))].sort();
  const vinculos = [...new Set(apps.map((item) => item.tipo_vinculo).filter(Boolean))].sort();

  return {
    usado_em_receita: 'SIM',
    receitas_texto: receitas.join(' | '),
    receita_qtd_por_ciclo_texto: qtdPorCiclo.join(' | '),
    receita_pn_base_texto: pnBase.join(' | '),
    receita_vinculo_texto: vinculos.join(' | '),
    receita_observacao: `${apps.length} aplicação(ões) em receita cadastrada.`,
  };
}

function enrichBatchRowWithRecipeApplications(row = {}, context = {}) {
  const pn = normalizeKey(row.pn);
  const applications = context.recipeApplicationMap?.get(pn) || [];
  const summary = summarizeRecipeApplications(applications);

  return {
    ...row,
    aplicacoes_receita: applications,
    usado_em_receita: summary.usado_em_receita,
    receitas: applications.map((item) => item.inspecao).filter(Boolean),
    receitas_texto: summary.receitas_texto,
    receita_qtd_por_ciclo_texto: summary.receita_qtd_por_ciclo_texto,
    receita_pn_base_texto: summary.receita_pn_base_texto,
    receita_vinculo_texto: summary.receita_vinculo_texto,
    receita_observacao: summary.receita_observacao,
  };
}

async function buscarPnAlternativoAutomatico(pn) {
  const pnNorm = normalizePn(pn);
  if (!pnNorm) return null;

  try {
    // 28.11: uma única regra para CIETP + biblioteca documental.
    // Evolução RFQ permanece direcional e não é achatada em receita_itens.pn_alt.
    const relations = await resolvePnRelations(pnNorm, { includeRfq: false });
    const alternativos = [...new Set((relations.alternativos || [])
      .map((row) => normalizePn(row.pn_relacionado))
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
    fetchAllRows('pim_demandas', '*').then((rows) => (rows || []).filter((row) => row.ativo !== false)).catch(() => []),
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

  const [
    receitaRows,
    politicaRows,
    pimRows,
    ppuRows,
    odaRows,
    odcRows,
    purchaseRows,
    priceRows,
    dicRows,
    altDocRows,
    ceimspaRows,
    referencePriceRows,
    itemRows,
    sbRows,
    sbItemRows,
    aircraftAvailabilityRows,
    maintenanceProgram,
  ] = await Promise.all([
    fetchAllRows('receita_itens', '*').catch(() => []),
    fetchAllRows('politica_estoque_tarefas', '*').catch(() => []),
    fetchAllRows('pim_demandas', '*').then((rows) => (rows || []).filter((row) => row.ativo !== false)).catch(() => []),
    loadAllEffectivePpuRows().catch(() => []),
    fetchAllRows('leonardo_spares', 'pn, qtd_pendente, documento_referencia').catch(() => []),
    fetchOdcRows(),
    fetchAllRows('compras_pds', '*').catch(() => []),
    fetchAllRows('price_list', 'pn, valor_unitario, nomenclatura, nsn').catch(() => []),
    fetchAllRows('dicionario_mestre', 'pn, pi, nsn, nomenclatura, dmc, item_num, sub_item').catch(() => []),
    fetchAllRows('pn_alternativos_documento', 'pn, pn_alt, pi, fonte, ativo').then((rows) => (rows || []).filter((row) => row.ativo !== false)).catch(() => []),
    fetchAllRows('v_sisha_ceimspa_disponibilidade', 'pn, pi, quantidade, nomenclatura, origem_saldo, numero_recibo').catch(() => []),
    loadReferencePriceRows().catch(() => []),
    fetchAllRows('items', 'pn, nomenclatura, nsn').catch(() => []),
    fetchAllRows('service_bulletins', 'sb_numero, titulo, tipo_sb, status_acao, data_publicacao, observacao, fonte_documento, updated_at').catch(() => []),
    fetchAllRows('service_bulletin_items', 'sb_numero, pn, nsn, nomenclatura, qtd, capitulo, item_num, aplicabilidade').catch(() => []),
    loadGeneratorOperationalRows().catch(() => []),
    loadMaintenanceProgram().catch(() => ({ rows: [], scheduled_needs: [], summary: { indicators: 0, bound: 0, blocked: 0, planned: 0, overdue: 0 } })),
  ]);

  const receitaOptions = buildReceitaOptions(receitaRows, politicaRows);
  const origemOptions = buildOrigemOptions(pimRows);
  const pnAlternativeMap = buildPnAlternativeMap(dicRows, altDocRows);
  const recipeApplicationMap = buildRecipeApplicationMap(receitaRows, pnAlternativeMap);

  const ppuMap = new Map();
  (ppuRows || []).forEach((row) => {
    const pn = normalizeKey(row.pn);
    if (!pn) return;
    if (!ppuMap.has(pn)) ppuMap.set(pn, { quantidade: 0, locais: new Map() });
    const ref = ppuMap.get(pn);
    const quantidade = toNumber(row.quantidade);
    ref.quantidade += quantidade;
    if (row.localizacao) {
      const local = String(row.localizacao).trim();
      ref.locais.set(local, toNumber(ref.locais.get(local)) + quantidade);
    }
  });

  const odaFallbackMap = new Map();
  (odaRows || []).forEach((row) => {
    const pn = normalizeKey(row.pn);
    if (!pn) return;
    if (!odaFallbackMap.has(pn)) odaFallbackMap.set(pn, { quantidade: 0, docs: new Set() });
    const ref = odaFallbackMap.get(pn);
    ref.quantidade += toNumber(row.qtd_pendente);
    if (row.documento_referencia) ref.docs.add(String(row.documento_referencia).trim());
  });

  const odcFallbackMap = new Map();
  (odcRows || []).forEach((row) => {
    const pn = normalizeKey(row.pn);
    if (!pn) return;
    if (!odcFallbackMap.has(pn)) odcFallbackMap.set(pn, { quantidade: 0, docs: new Set() });
    const qtyKey = firstExistingKey(row, ODC_QTY_CANDIDATES);
    const pdKey = firstExistingKey(row, ODC_PD_CANDIDATES);
    const ref = odcFallbackMap.get(pn);
    ref.quantidade += qtyKey ? toNumber(row[qtyKey]) : 0;
    if (pdKey && row[pdKey]) ref.docs.add(String(row[pdKey]).trim());
  });

  const { odaMap, odcMap } = buildCanonicalPurchaseStageMaps(
    purchaseRows || [],
    odaFallbackMap,
    odcFallbackMap
  );

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
  const costRefMap = buildReferencePriceMap(referencePriceRows || []);
  (priceRows || []).forEach((row) => {
    const pn = normalizeKey(row.pn);
    if (!pn) return;
    const info = {
      valor_unitario: toNumber(row.valor_unitario),
      nomenclatura: safeString(row.nomenclatura),
      nsn: safeString(row.nsn),
      fonte: 'PRICE_LIST',
    };
    // Preço zero não é referência de preço. O PN continua sendo usado para
    // enriquecer nomenclatura/NSN via pnMetaMap, mas será tratado como SEM PREÇO.
    if (info.valor_unitario > 0 && !priceMap.has(pn)) priceMap.set(pn, info);
    const currentMeta = pnMetaMap.get(pn) || {};
    pnMetaMap.set(pn, {
      nsn: currentMeta.nsn || info.nsn,
      nomenclatura: currentMeta.nomenclatura || info.nomenclatura,
    });
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
    recipeApplicationMap,
    pnAlternativeMap,
    ppuMap,
    odaMap,
    odcMap,
    purchaseRows,
    priceMap,
    costRefMap,
    pnPiMap,
    pnMetaMap,
    ceimspaMap,
    ceimspaRows,
    aircraftAvailabilityRows,
    aircraftAvailabilityMap: buildAircraftAvailabilityMap(aircraftAvailabilityRows),
    maintenanceProgram,
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
  const ceimspa = getCeimspaQuantity(context, pn, pis);
  const oda = toNumber(context.odaMap.get(pn)?.quantidade);
  const odc = toNumber(context.odcMap.get(pn)?.quantidade);
  const coberturaTotal = ppu + ceimspa + oda;
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
    odc_abate_necessidade: false,
    saldo_pos_cascata: Number(saldo.toFixed(2)),
    price_ref_gbp: priceInfo ? toNumber(priceInfo.valor_unitario) : null,
    price_ref_fonte: priceInfo?.fonte_exibicao || priceInfo?.fonte_preco || priceInfo?.fonte || (context.priceMap.has(pn) ? 'PRICE LIST' : null),
    price_ref_estimativa: Boolean(priceInfo?.estimativa),
    price_ref_necessita_cotacao: priceInfo ? Boolean(priceInfo.necessita_cotacao) : true,
    price_ref_status: priceInfo?.status_preco || (priceInfo ? null : 'SEM_PRECO'),
    precisa_cadastro: precisaCadastro,
    cobertura_status: saldo <= 0 ? 'COBERTO' : (coberturaTotal > 0 ? 'PARCIAL' : 'SEM_COBERTURA'),
    aplicabilidade: item.aplicabilidade || null,
    capitulo: item.capitulo || null,
    item_num: item.item_num || null,
  };
}

function buildGeneratorPreview(selection, context) {
  const { mode = 'prioritized', receitas = [], origens = [], incluirPims = true, incluirProgramadas = false, sbMode = 'none', sbs = [] } = selection || {};
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
    const selectedPimRows = collectSelectedPimRows(context.pimRows, selectedOrigemSet);

    selectedPimRows.forEach((item) => {
      const { row, origem } = item;
      const quantidadeOriginal = toNumber(row.quantidade);
      const mtDecision = buildMtAvailabilityDecision(item, selectedPimRows, context.aircraftAvailabilityMap || new Map());
      appendNeed(needMap, {
        pn: row.pn,
        nsn: row.nsn,
        nomenclatura: row.nomenclatura,
        quantidade: mtDecision.blocked ? 0 : quantidadeOriginal,
        pims: [row.pim],
        origens: [buildOrigemLabel(origem)],
        observacoes: [
          `PIM x1 • OS ${row.os_vinculada}`,
          item.isMt ? `Demanda MT de material x${quantidadeOriginal}.` : null,
          mtDecision.additive
            ? `MT somada como demanda adicional: aeronave(s) relacionada(s) indisponível(is) ${mtDecision.unavailableAircraft.join(', ')}.`
            : null,
          mtDecision.blocked
            ? `MT preservada como alerta: ${mtDecision.relatedAircraft.join(', ') || 'ANV relacionada'} sem evidência estruturada atual de indisponibilidade (I).`
            : null,
        ].filter(Boolean),
      });
    });
  }

  if (incluirProgramadas) {
    (context.maintenanceProgram?.scheduled_needs || []).forEach((item) => {
      appendNeed(needMap, {
        pn: item.pn,
        nomenclatura: item.nomenclatura,
        quantidade: toNumber(item.quantidade || 1),
        origens: [`MANUTENÇÃO PROGRAMADA • ANV ${item.aircraft_code}`],
        observacoes: [
          `${item.maintenance_action || 'MANUTENÇÃO'} • ${item.indicator_label || item.indicator_key}`,
          item.planning_status === 'OVERDUE' ? 'Indicador vencido.' : 'Indicador futuro confirmado para planejamento.',
          item.trigger?.due_date ? `Vencimento ${item.trigger.due_date}` : null,
          item.trigger?.value !== null && item.trigger?.value !== undefined && Number.isFinite(Number(item.trigger.value)) ? `Restante ${item.trigger.value} ${item.trigger.unit || ''}` : null,
          item.sn ? `SN ${item.sn}` : 'Necessidade vinculada ao PN sem SN específico.',
        ].filter(Boolean),
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

  const availability = buildAvailabilitySections(baseRows, context);
  const { sections, totals } = availability;
  const recipeDeficiency = buildRecipePolicyDeficiency({
    selectedRecipes: selectedReceitas,
    recipeRows: context.receitaRows || [],
    policyRows: context.politicaRows || [],
    ppuMap: context.ppuMap || new Map(),
    ceimspaRows: context.ceimspaRows || [],
    pnPiMap: context.pnPiMap || new Map(),
    pnMetaMap: context.pnMetaMap || new Map(),
    purchaseRows: context.purchaseRows || [],
    odaFallbackMap: context.odaMap || new Map(),
    odcFallbackMap: context.odcMap || new Map(),
    horizonDays: 730,
  });


  const deficiencyByPn = new Map((recipeDeficiency.rows || []).map((row) => [normalizeKey(row.pn), row]));
  sections.comprar = (sections.comprar || []).map((row) => {
    const policy = deficiencyByPn.get(normalizeKey(row.pn));
    return {
      ...row,
      necessidade_politica_2_anos: policy?.necessidade_2_anos ?? 0,
      ppu_politica: policy?.ppu_efetivo ?? 0,
      ceimspa_politica: policy?.ceimspa_disponivel ?? 0,
      oda_politica: policy?.oda_a_receber_total ?? 0,
      deficit_politica_2_anos: policy?.deficit_a_providenciar ?? 0,
      odc_politica_em_andamento: policy?.odc_em_andamento ?? row.odc_em_andamento ?? 0,
      politica_receitas_texto: policy?.receitas_texto || '',
      politica_status: policy?.status || '',
    };
  });

  const summary = {
    receitas_selecionadas: selectedReceitas.length,
    sbs_selecionadas: selectedSbs.length,
    origens_selecionadas: selectedOrigemSet.size,
    programadas_selecionadas: incluirProgramadas ? (context.maintenanceProgram?.scheduled_needs || []).length : 0,
    linhas_base: baseRows.length,
    necessidade_total: Number(baseRows.reduce((acc, row) => acc + toNumber(row.necessidade_total), 0).toFixed(2)),
    disponivel_ppu: totals.ppu,
    disponivel_ceimspa: totals.ceimspa,
    disponivel_oda: totals.oda,
    disponivel_odc: totals.odc,
    coberto_ppu: totals.ppu,
    coberto_ceimspa: totals.ceimspa,
    coberto_oda: totals.oda,
    coberto_odc: 0,
    cobertura_efetiva_ppu: totals.ppu_aplicado,
    cobertura_efetiva_ceimspa: totals.ceimspa_aplicado,
    cobertura_efetiva_oda: totals.oda_aplicado,
    cobertura_efetiva_total: totals.cobertura_efetiva,
    odc_em_andamento: totals.odc,
    politica_necessidade_2_anos: recipeDeficiency.summary?.necessidade_2_anos || 0,
    politica_ppu_efetivo: recipeDeficiency.summary?.ppu_efetivo || 0,
    politica_ceimspa_disponivel: recipeDeficiency.summary?.ceimspa_disponivel || 0,
    politica_oda_a_receber: recipeDeficiency.summary?.oda_a_receber || 0,
    politica_odc_em_andamento: recipeDeficiency.summary?.odc_em_andamento || 0,
    politica_deficit_a_providenciar: recipeDeficiency.summary?.deficit_a_providenciar || 0,
    comprar_qtd: totals.comprar,
    comprar_valor_gbp: totals.valorComprar,
  };

  return {
    filtros: {
      modo: mode,
      receitas: selectedReceitas,
      sbMode,
      sbs: selectedSbs,
      origens: Array.from(selectedOrigemSet),
      incluirPims: !!incluirPims,
      incluirProgramadas: !!incluirProgramadas,
    },
    summary,
    base: baseRows,
    sections,
    recipe_deficiency: recipeDeficiency,
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
    const selectedPimRows = collectSelectedPimRows(context.pimRows, selectedOrigemSet);

    selectedPimRows.forEach((item) => {
      const { row, origem } = item;
      const quantidade = toNumber(row.quantidade);
      if (quantidade <= 0) return;
      const mtDecision = buildMtAvailabilityDecision(item, selectedPimRows, context.aircraftAvailabilityMap || new Map());
      addCostLine({
        pn: row.pn,
        nsn: row.nsn,
        nomenclatura: row.nomenclatura,
        qtdUnitaria: mtDecision.blocked ? 0 : quantidade,
        qtdPlanejada: mtDecision.blocked ? 0 : quantidade,
        pim: row.pim,
        origem: buildOrigemLabel(origem),
        fator: 1,
        observacao: mtDecision.blocked
          ? `MT ${row.os_vinculada || ''} x${quantidade} preservada como alerta; ${mtDecision.relatedAircraft.join(', ') || 'ANV relacionada'} sem evidência atual de situação I.`
          : mtDecision.additive
            ? `Demanda MT x${quantidade} somada por indisponibilidade comprovada de ${mtDecision.unavailableAircraft.join(', ')} • OS ${row.os_vinculada}`
            : `${item.isMt ? 'Demanda MT' : 'PIM avulsa'} x${quantidade} • OS ${row.os_vinculada}`,
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
        ...buildPricePresentation(priceInfo),
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
    pns_com_estimativa: linhas.filter((row) => row.preco_estimativa).length,
    pns_precisam_cotacao: linhas.filter((row) => row.necessita_cotacao || row.valor_unitario_gbp == null).length,
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

exports.importPimSnapshot = async (req, res) => {
  try {
    const parsed = parsePimSnapshotWorkbook(req.file);
    (parsed.issues || []).forEach((issue) => recordAuditIssue(req, issue));

    const { data, error } = await supabase.rpc('sisha_replace_pim_snapshot_atomic', {
      p_rows: parsed.rows,
      p_source_file_name: req.file?.originalname || 'PIM',
      p_source_file_sha256: parsed.sha256,
      p_actor_email: req.user?.email || '',
      p_actor_role: req.user?.role || '',
    });
    if (error) throw error;

    invalidateNeedsCache();
    const ignored = Math.max(0, parsed.physicalRows - parsed.rows.length);
    setAuditSummary(req, {
      status: parsed.issues.length ? 'SUCESSO_COM_ALERTAS' : 'SUCESSO',
      mensagem: `PIM atual aplicado: ${parsed.rows.length} linha(s) válida(s). O snapshot de arquivo anterior foi preservado como histórico e desativado para o Gerador.`,
      tabelaAlvo: 'pim_demandas',
      linhasLidas: parsed.physicalRows,
      linhasImportadas: parsed.rows.length,
      linhasIgnoradas: ignored,
      detalhes: {
        modo: 'PIM_SNAPSHOT_ATUAL',
        source_sha256: parsed.sha256,
        planilha: { abas_encontradas: parsed.sheetStats.length, abas: parsed.sheetStats },
        regra: 'NOVO_ARQUIVO_PIM_SUBSTITUI_SOMENTE_SNAPSHOT_DE_ARQUIVO; MANUAL_PRESERVADO; SEM_DELETE',
      },
    });

    return res.status(200).json({
      status: 'success',
      message: `PIM atualizado com ${parsed.rows.length} linha(s) válida(s).`,
      data: {
        ...(data || {}),
        valid_rows: parsed.rows.length,
        ignored_rows: ignored,
        warnings: parsed.issues.length,
        file_name: req.file?.originalname || null,
        file_sha256: parsed.sha256,
        sheets: parsed.sheetStats,
      },
    });
  } catch (error) {
    (error?.pimIssues || []).forEach((issue) => recordAuditIssue(req, issue));
    const migrationMissing = String(error?.message || '').includes('sisha_replace_pim_snapshot_atomic');
    const message = migrationMissing
      ? 'PIM: migration 20260821_HF_PIM_CURRENT_SNAPSHOT_001 ainda não foi aplicada no Supabase.'
      : (error?.message || 'Falha ao importar o PIM atual.');
    setAuditSummary(req, {
      status: 'ERRO',
      mensagem: message,
      tabelaAlvo: 'pim_demandas',
      linhasLidas: 0,
      linhasImportadas: 0,
      linhasIgnoradas: 0,
      detalhes: { modo: 'PIM_SNAPSHOT_ATUAL' },
    });
    return res.status(error?.statusCode || 500).json({ status: 'error', message });
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

    const normalized = (data || []).filter((row) => row.ativo !== false).map(hydratePimOrigem);
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
      ativo: true,
      origem_importacao: 'MANUAL',
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

    const normalized = (data || []).filter((row) => row.ativo !== false).map(hydratePimOrigem);
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

exports.getAircraftAvailabilityCurrent = async (req, res) => {
  try {
    const rows = await loadCurrentAvailabilityRows();
    return res.status(200).json({
      status: 'success',
      data: rows,
      source: 'v_sisha_aircraft_current_availability',
    });
  } catch (error) {
    return res.status(500).json({ status: 'error', message: `Falha ao consultar disponibilidade da frota: ${error.message}` });
  }
};

exports.getAircraftMaintenanceIndicators = async (req, res) => {
  try {
    const aircraft = normalizeUpper(req.params?.aircraft);
    if (!/^\d{4}$/.test(aircraft)) {
      return res.status(400).json({ status: 'error', message: 'Informe uma aeronave com 4 dígitos.' });
    }
    const rows = await loadCurrentMaintenanceIndicators([aircraft]);
    return res.status(200).json({
      status: 'success',
      aircraft,
      data: rows.map((row) => ({ ...row, ...classifyMaintenanceIndicatorSemantic(row) })),
      source: 'v_sisha_aircraft_current_maintenance_indicators',
    });
  } catch (error) {
    return res.status(500).json({ status: 'error', message: `Falha ao consultar indicadores da aeronave: ${error.message}` });
  }
};

exports.getFoundationSnapshot = async (req, res) => {
  try {
    const [{ count: receitasCount }, { count: pimCount }, { count: politicaCount }] = await Promise.all([
      supabase.from('receita_itens').select('*', { count: 'exact', head: true }),
      supabase.from('pim_demandas').select('*', { count: 'exact', head: true }).eq('ativo', true),
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
  'qte',
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
    const base = {
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

    return enrichBatchRowWithRecipeApplications(base, context);
  });

  const availability = buildAvailabilitySections(inputRows, context);
  const { sections, totals } = availability;

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
      usado_em_receita: row.usado_em_receita || '',
      receitas_texto: row.receitas_texto || '',
      receita_qtd_por_ciclo_texto: row.receita_qtd_por_ciclo_texto || '',
      receita_pn_base_texto: row.receita_pn_base_texto || '',
      receita_vinculo_texto: row.receita_vinculo_texto || '',
      aplicacoes_receita: row.aplicacoes_receita || [],
    })),
    summary: {
      linhas_base: inputRows.length,
      necessidade_total: Number(inputRows.reduce((acc, row) => acc + toNumber(row.necessidade_total), 0).toFixed(2)),
      disponivel_ppu: totals.ppu,
      disponivel_ceimspa: totals.ceimspa,
      disponivel_oda: totals.oda,
      disponivel_odc: totals.odc,
      coberto_ppu: totals.ppu,
      coberto_ceimspa: totals.ceimspa,
      coberto_oda: totals.oda,
      coberto_odc: 0,
      odc_em_andamento: totals.odc,
      cobertura_efetiva_total: totals.cobertura_efetiva,
      comprar_qtd: totals.comprar,
      comprar_valor_gbp: totals.valorComprar,
      itens_usados_em_receita: inputRows.filter((row) => row.usado_em_receita === 'SIM').length,
      itens_sem_receita: inputRows.filter((row) => row.usado_em_receita !== 'SIM').length,
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
    Usado_em_Receita: row.usado_em_receita || '',
    Receitas: row.receitas_texto || '',
    Receita_Qtd_Por_Ciclo: row.receita_qtd_por_ciclo_texto || '',
    Receita_PN_Base: row.receita_pn_base_texto || '',
    Receita_Vinculo: row.receita_vinculo_texto || '',
  }));
}

function formatBatchRecipeApplicationRows(rows = []) {
  return rows.flatMap((row) => {
    const applications = row.aplicacoes_receita || [];
    if (!applications.length) {
      return [{
        PN_Consultado: row.pn,
        Nomenclatura: row.nomenclatura || '',
        Usado_em_Receita: 'NÃO',
        Receita_Inspecao: '',
        Qtd_Por_Ciclo: '',
        PN_Base_na_Receita: '',
        Vinculo: '',
        Nomenclatura_Receita: '',
        Observacao: 'Não localizado em receita cadastrada.',
      }];
    }

    return applications.map((item) => ({
      PN_Consultado: row.pn,
      Nomenclatura: row.nomenclatura || '',
      Usado_em_Receita: 'SIM',
      Receita_Inspecao: item.inspecao || '',
      Qtd_Por_Ciclo: toNumber(item.qtd_por_ciclo) || '',
      PN_Base_na_Receita: item.pn_receita || '',
      Vinculo: item.tipo_vinculo || '',
      Nomenclatura_Receita: item.nomenclatura || '',
      Observacao: 'Aplicação encontrada em receita cadastrada.',
    }));
  });
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
      { Indicador: 'Disponível PPU + recibos pendentes', Valor: preview.summary.disponivel_ppu ?? preview.summary.coberto_ppu },
      { Indicador: 'Disponível CeIMSPA', Valor: preview.summary.disponivel_ceimspa ?? preview.summary.coberto_ceimspa },
      { Indicador: 'Disponível ODA', Valor: preview.summary.disponivel_oda ?? preview.summary.coberto_oda },
      { Indicador: 'ODC em andamento (não abate necessidade)', Valor: preview.summary.odc_em_andamento ?? preview.summary.disponivel_odc ?? 0 },
      { Indicador: 'Comprar qtd', Valor: preview.summary.comprar_qtd },
      { Indicador: 'Comprar valor GBP', Valor: preview.summary.comprar_valor_gbp },
      { Indicador: 'Itens usados em receita', Valor: preview.summary.itens_usados_em_receita },
      { Indicador: 'Itens sem receita cadastrada', Valor: preview.summary.itens_sem_receita },
    ];
    xlsx.utils.book_append_sheet(workbook, xlsx.utils.json_to_sheet(resumoRows), '00_RESUMO');
    xlsx.utils.book_append_sheet(workbook, xlsx.utils.json_to_sheet(formatBatchInputRows(preview.input)), '00_ENTRADA');

    [
      ['01_PPU', preview.sections.ppu],
      ['02_CEIMSPA', preview.sections.ceimspa],
      ['03_ODA', preview.sections.oda],
      ['04_BANCO_PRECOS', preview.sections.pricelist],
      ['05_ODC', preview.sections.odc],
      ['06_COMPRAR', preview.sections.comprar],
    ].forEach(([name, rows]) => {
      xlsx.utils.book_append_sheet(workbook, xlsx.utils.json_to_sheet(formatWorkbookRows(rows)), name);
    });

    xlsx.utils.book_append_sheet(workbook, xlsx.utils.json_to_sheet(formatBatchRecipeApplicationRows(preview.input)), '07_APLICACAO_RECEITAS');

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
    const deficiencySummaryRows = [
      { Indicador: 'Horizonte (dias)', Valor: preview.recipe_deficiency?.summary?.horizonte_dias ?? 730 },
      { Indicador: 'Receitas com política', Valor: preview.recipe_deficiency?.summary?.receitas_com_politica ?? 0 },
      { Indicador: 'Receitas afetadas por deficiência', Valor: preview.recipe_deficiency?.summary?.receitas_deficientes ?? 0 },
      { Indicador: 'PNs planejados', Valor: preview.recipe_deficiency?.summary?.pns_planejados ?? 0 },
      { Indicador: 'PNs deficientes', Valor: preview.recipe_deficiency?.summary?.pns_deficientes ?? 0 },
      { Indicador: 'Necessidade Política × Receita (2 anos)', Valor: preview.recipe_deficiency?.summary?.necessidade_2_anos ?? 0 },
      { Indicador: 'PPU efetivo aplicado à Política', Valor: preview.recipe_deficiency?.summary?.ppu_efetivo ?? 0 },
      { Indicador: 'CeIMSPA disponível aplicado à Política', Valor: preview.recipe_deficiency?.summary?.ceimspa_disponivel ?? 0 },
      { Indicador: 'ODA a receber aplicado à Política', Valor: preview.recipe_deficiency?.summary?.oda_a_receber ?? 0 },
      { Indicador: 'ODC em andamento — não abate', Valor: preview.recipe_deficiency?.summary?.odc_em_andamento ?? 0 },
      { Indicador: 'Déficit a providenciar', Valor: preview.recipe_deficiency?.summary?.deficit_a_providenciar ?? 0 },
      { Indicador: 'Risco de cobertura no horizonte', Valor: preview.recipe_deficiency?.summary?.risco_cobertura_no_horizonte ?? 0 },
      { Indicador: 'Pendências de cadastro/cálculo', Valor: preview.recipe_deficiency?.summary?.blockers ?? 0 },
    ];
    xlsx.utils.book_append_sheet(workbook, xlsx.utils.json_to_sheet(deficiencySummaryRows), '00_RESUMO_DEFICIENCIA');
    xlsx.utils.book_append_sheet(workbook, xlsx.utils.json_to_sheet(formatRecipePolicyDeficiencyRows(preview.recipe_deficiency?.deficient_rows || [])), '00_DEFICIENCIAS_RECEITAS');
    if ((preview.recipe_deficiency?.blockers || []).length > 0) {
      xlsx.utils.book_append_sheet(workbook, xlsx.utils.json_to_sheet(preview.recipe_deficiency.blockers), '00_PENDENCIAS_RECEITAS');
    }

    const sheets = [
      ['01_PPU', preview.sections.ppu],
      ['02_CEIMSPA', preview.sections.ceimspa],
      ['03_ODA', preview.sections.oda],
      ['04_BANCO_PRECOS', preview.sections.pricelist],
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

exports.prepareQuoteRequest = async (req, res) => {
  try {
    const items = Array.isArray(req.body?.items) ? req.body.items : [];
    const data = await prepareQuoteRequestItems(items);
    return res.status(200).json({ status: 'success', data });
  } catch (error) {
    const statusCode = error?.statusCode || 500;
    return res.status(statusCode).json({ status: 'error', message: error?.message || 'Falha ao preparar a solicitação de cotação.' });
  }
};

exports.exportQuoteRequestXlsx = async (req, res) => {
  try {
    const result = await exportQuoteRequest({
      items: Array.isArray(req.body?.items) ? req.body.items : [],
      source: req.body?.source || 'SISHA',
      user: req.user || null,
    });
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${result.filename}"`);
    res.setHeader('X-SISHA-Cotacao-Ref', result.ref);
    return res.status(200).send(result.buffer);
  } catch (error) {
    const statusCode = error?.statusCode || 500;
    return res.status(statusCode).json({ status: 'error', message: error?.message || 'Falha ao exportar a solicitação de cotação.' });
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
