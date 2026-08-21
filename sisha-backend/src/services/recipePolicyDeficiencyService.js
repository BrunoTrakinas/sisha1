const { pendingPurchaseQty, isFuturePurchaseCoverageStatus, isOdcProcessStatus, isDeliveredHistoricalStatus } = require('./pdLifecyclePolicyService');

function clean(value) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return text || null;
}

function upper(value) {
  const text = clean(value);
  return text ? text.toUpperCase() : null;
}

function normalizePn(value) {
  const text = upper(value);
  return text ? text.replace(/\s+/g, '') : null;
}

function numberValue(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function positive(value) {
  return Math.max(0, numberValue(value));
}

function round(value, digits = 2) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  const factor = 10 ** digits;
  return Math.round(n * factor) / factor;
}

function parseDate(value) {
  if (!value) return null;
  const dt = new Date(value);
  return Number.isNaN(dt.getTime()) ? null : dt;
}

function buildPurchaseCoverage(rows = [], pn, { now = new Date(), horizonDays = 730 } = {}) {
  const targetPn = normalizePn(pn);
  const horizonEnd = new Date(now.getTime() + (Math.max(1, Number(horizonDays) || 730) * 86400000));
  const excludedStatuses = new Set(['CAN', 'EXCLUIDO', 'EXCLUÍDO']);
  let odaWithinHorizon = 0;
  let odaWithoutDate = 0;
  let odaOutsideHorizon = 0;
  let odcWithinHorizon = 0;
  let odcWithoutDate = 0;
  let odcOutsideHorizon = 0;
  let historicalDeliveredRows = 0;
  const futureDocs = new Set();
  const odcDocs = new Set();
  const historicalDocs = new Set();
  let canonicalRows = 0;

  (rows || []).forEach((row) => {
    if (row?.ativo === false) return;
    if (normalizePn(row?.pn) !== targetPn) return;
    const status = upper(row.status_grupo || row.status);
    if (!status || excludedStatuses.has(status)) return;
    canonicalRows += 1;

    const ref = clean(row.numero_pd || row.documento_referencia || row.numero_oc);
    if (isDeliveredHistoricalStatus(status)) {
      historicalDeliveredRows += 1;
      if (ref) historicalDocs.add(`${ref} (${status})`);
      return;
    }

    const qty = pendingPurchaseQty(row);
    if (qty <= 0) return;
    const expected = parseDate(row.data_previsao_entrega || row.data_previsao);
    const inside = expected && expected.getTime() <= horizonEnd.getTime();

    if (isFuturePurchaseCoverageStatus(status)) {
      if (ref) futureDocs.add(ref);
      if (!expected) odaWithoutDate += qty;
      else if (inside) odaWithinHorizon += qty;
      else odaOutsideHorizon += qty;
      return;
    }

    if (isOdcProcessStatus(status)) {
      if (ref) odcDocs.add(ref);
      if (!expected) odcWithoutDate += qty;
      else if (inside) odcWithinHorizon += qty;
      else odcOutsideHorizon += qty;
    }
  });

  return {
    canonical_rows: canonicalRows,
    committed_within_horizon: round(odaWithinHorizon),
    committed_without_date: round(odaWithoutDate),
    committed_outside_horizon: round(odaOutsideHorizon),
    potential_within_horizon: round(odcWithinHorizon),
    potential_without_date: round(odcWithoutDate),
    potential_outside_horizon: round(odcOutsideHorizon),
    documents: Array.from(futureDocs).sort(),
    odc_documents: Array.from(odcDocs).sort(),
    historical_delivered_rows: historicalDeliveredRows,
    historical_documents: Array.from(historicalDocs).sort(),
  };
}

function ceimspaQuantity(rows = [], pn, piSet = new Set()) {
  const targetPn = normalizePn(pn);
  const normalizedPi = new Set(Array.from(piSet || []).map(upper).filter(Boolean));
  return round((rows || []).reduce((sum, row) => {
    const rowPn = normalizePn(row.pn);
    const rowPi = upper(row.pi);
    const direct = rowPn && rowPn === targetPn;
    const byPi = !rowPn && rowPi && normalizedPi.has(rowPi);
    return direct || byPi ? sum + positive(row.quantidade) : sum;
  }, 0));
}

function mapEntry(map, pn) {
  const target = normalizePn(pn);
  if (!target || !map?.get) return null;
  const direct = map.get(target);
  if (direct) return direct;
  for (const [key, value] of map.entries()) {
    if (normalizePn(key) === target) return value;
  }
  return null;
}

function mapQuantity(map, pn) {
  return positive(mapEntry(map, pn)?.quantidade);
}

function mapDocs(map, pn) {
  const docs = mapEntry(map, pn)?.docs;
  if (!docs) return [];
  return Array.from(docs).map(clean).filter(Boolean).sort();
}

function buildRecipePolicyDeficiency({
  selectedRecipes = [],
  recipeRows = [],
  policyRows = [],
  ppuMap = new Map(),
  ceimspaRows = [],
  pnPiMap = new Map(),
  pnMetaMap = new Map(),
  purchaseRows = [],
  odaFallbackMap = new Map(),
  odcFallbackMap = new Map(),
  now = new Date(),
  horizonDays = 730,
} = {}) {
  const selected = new Set((selectedRecipes || []).map((value) => clean(value)).filter(Boolean));
  const policyMap = new Map();
  (policyRows || []).forEach((row) => {
    if (upper(row.tipo) !== 'RECEITA') return;
    const task = upper(row.tarefas);
    if (!task) return;
    policyMap.set(task, row);
  });

  const demandByPn = new Map();
  const blockers = [];
  const policyRecipes = new Set();

  const recipeGroups = new Map();
  (recipeRows || []).forEach((row) => {
    const recipe = clean(row.inspecao);
    if (!recipe || (selected.size && !selected.has(recipe))) return;
    if (!recipeGroups.has(recipe)) recipeGroups.set(recipe, []);
    recipeGroups.get(recipe).push(row);
  });

  for (const [recipe, items] of recipeGroups.entries()) {
    const policy = policyMap.get(upper(recipe));
    if (!policy) {
      blockers.push({ receita: recipe, codigo: 'POLITICA_NAO_CADASTRADA', detalhe: 'Receita sem Política de Estoque correspondente; nenhuma quantidade foi inventada.' });
      continue;
    }
    const cycles = positive(policy.qtde_2_anos);
    const priority = positive(policy.prioridade);
    if (cycles <= 0) {
      blockers.push({ receita: recipe, codigo: 'POLITICA_SEM_QTDE_2_ANOS', detalhe: 'A Política de Estoque não informa quantidade planejada maior que zero para 2 anos.' });
      continue;
    }
    policyRecipes.add(recipe);

    items.forEach((item) => {
      const pn = normalizePn(item.pn);
      const qtyPerCycle = positive(item.qtd_por_ciclo);
      if (!pn) {
        blockers.push({ receita: recipe, codigo: 'ITEM_RECEITA_SEM_PN', detalhe: clean(item.nomenclatura) || 'Item de receita sem PN; não entra no cálculo automático.' });
        return;
      }
      if (qtyPerCycle <= 0) {
        blockers.push({ receita: recipe, pn, codigo: 'ITEM_RECEITA_SEM_QTD_POR_CICLO', detalhe: 'Qtd por ciclo ausente/zero; o SISHA não presume consumo.' });
        return;
      }
      const required = round(cycles * qtyPerCycle);
      if (!demandByPn.has(pn)) {
        const meta = mapEntry(pnMetaMap, pn) || {};
        demandByPn.set(pn, {
          pn,
          nsn: clean(item.nsn) || clean(meta.nsn),
          nomenclatura: clean(item.nomenclatura) || clean(meta.nomenclatura) || 'N/A',
          necessidade_2_anos: 0,
          receitas: [],
          prioridade_mais_alta: priority > 0 ? priority : null,
        });
      }
      const entry = demandByPn.get(pn);
      entry.necessidade_2_anos += required;
      if (!entry.nsn && item.nsn) entry.nsn = clean(item.nsn);
      if ((!entry.nomenclatura || entry.nomenclatura === 'N/A') && item.nomenclatura) entry.nomenclatura = clean(item.nomenclatura);
      if (priority > 0 && (entry.prioridade_mais_alta === null || priority < entry.prioridade_mais_alta)) entry.prioridade_mais_alta = priority;
      entry.receitas.push({
        receita: recipe,
        prioridade: priority || null,
        ciclos_planejados_2_anos: round(cycles),
        qtd_por_ciclo: round(qtyPerCycle),
        necessidade: required,
      });
    });
  }

  const deficientRecipes = new Set();
  const rows = Array.from(demandByPn.values()).map((entry) => {
    const need = round(entry.necessidade_2_anos);
    const ppu = round(mapQuantity(ppuMap, entry.pn));
    const ceimspa = ceimspaQuantity(ceimspaRows, entry.pn, mapEntry(pnPiMap, entry.pn) || new Set());
    const physicalCoverage = round(Math.min(need, ppu + ceimspa));
    const afterPhysical = round(Math.max(0, need - ppu - ceimspa));
    const canonical = buildPurchaseCoverage(purchaseRows, entry.pn, { now, horizonDays });

    let odaWithin = canonical.committed_within_horizon;
    let odaUndated = canonical.committed_without_date;
    let odaOutside = canonical.committed_outside_horizon;
    let odcWithin = canonical.potential_within_horizon;
    let odcUndated = canonical.potential_without_date;
    let odcOutside = canonical.potential_outside_horizon;
    let purchaseSource = 'COMPRAS_PDS';
    let odaDocs = canonical.documents;
    let odcDocs = canonical.odc_documents || [];

    // Compatibilidade com base histórica: só usa snapshot do Order Book quando
    // não há qualquer PD canônico daquele PN. ODA reduz a compra; ODC só alerta.
    if (canonical.canonical_rows === 0) {
      const legacyOda = round(mapQuantity(odaFallbackMap, entry.pn));
      const legacyOdc = round(mapQuantity(odcFallbackMap, entry.pn));
      if (legacyOda > 0 || legacyOdc > 0) {
        odaUndated = legacyOda;
        odcUndated = legacyOdc;
        purchaseSource = 'FALLBACK_ORDER_BOOK';
        odaDocs = mapDocs(odaFallbackMap, entry.pn);
        odcDocs = mapDocs(odcFallbackMap, entry.pn);
      }
    }

    const odaTotal = round(odaWithin + odaUndated + odaOutside);
    const odaApplied = round(Math.min(afterPhysical, odaTotal));
    const deficitToProvide = round(Math.max(0, afterPhysical - odaTotal));
    const odcTotal = round(odcWithin + odcUndated + odcOutside);

    // ODA já comprado nunca gera compra duplicada. Se estiver sem data ou fora
    // do horizonte, permanece como risco de disponibilidade, não como novo débito.
    const odaWithinApplied = round(Math.min(afterPhysical, odaWithin));
    const horizonAvailabilityShortage = round(Math.max(0, afterPhysical - odaWithinApplied));
    const odaRiskQty = deficitToProvide <= 0
      ? round(Math.max(0, afterPhysical - odaWithinApplied))
      : round(Math.min(odaUndated + odaOutside, afterPhysical));

    const coverageForPurchase = round(Math.min(need, physicalCoverage + odaApplied));
    const confirmedCoveragePct = need > 0 ? round((coverageForPurchase / need) * 100, 1) : 100;

    let status = 'DEFICIENTE';
    if (afterPhysical <= 0) status = 'COBERTO_PPU_CEIMSPA';
    else if (deficitToProvide <= 0 && odaRiskQty <= 0) status = 'COBERTO_COM_ODA_NO_HORIZONTE';
    else if (deficitToProvide <= 0) status = 'COBERTO_COM_ODA_RISCO_PRAZO';
    else if (odcTotal > 0) status = 'DEFICIENTE_COM_ODC_EM_ANDAMENTO';

    if (deficitToProvide > 0) entry.receitas.forEach((item) => deficientRecipes.add(item.receita));

    return {
      pn: entry.pn,
      nsn: entry.nsn || null,
      nomenclatura: entry.nomenclatura || 'N/A',
      prioridade_mais_alta: entry.prioridade_mais_alta,
      necessidade_2_anos: need,
      ppu_efetivo: ppu,
      ceimspa_disponivel: ceimspa,
      cobertura_fisica_atual: physicalCoverage,
      deficit_apos_estoques: afterPhysical,
      oda_no_horizonte: round(odaWithin),
      oda_sem_data: round(odaUndated),
      oda_fora_horizonte: round(odaOutside),
      oda_a_receber_total: odaTotal,
      oda_aplicada_na_necessidade: odaApplied,
      deficit_a_providenciar: deficitToProvide,
      odc_em_andamento: odcTotal,
      odc_no_horizonte: round(odcWithin),
      odc_sem_data: round(odcUndated),
      odc_fora_horizonte: round(odcOutside),
      risco_cobertura_no_horizonte: odaRiskQty,
      disponibilidade_faltante_no_horizonte: horizonAvailabilityShortage,
      cobertura_confirmada_percentual: confirmedCoveragePct,
      entregas_historicas_fat_emb_rec: canonical.historical_delivered_rows || 0,
      documentos_historicos_fat_emb_rec: (canonical.historical_documents || []).join(' | '),
      status,
      receitas: entry.receitas,
      receitas_texto: entry.receitas.map((item) => `${item.receita}: ${item.ciclos_planejados_2_anos} ciclo(s) × ${item.qtd_por_ciclo} = ${item.necessidade}`).join(' | '),
      documentos_oda: (odaDocs || []).join(' | '),
      documentos_odc: (odcDocs || []).join(' | '),
      fonte_compra: purchaseSource,
      nota: deficitToProvide > 0
        ? (odcTotal > 0
          ? `Faltam ${deficitToProvide} un para cumprir a Política × Receita após PPU, CeIMSPA e ODA. Existe ODC em andamento (${odcTotal} un), que não abate a necessidade e deve ser priorizado para suplementação/liberação.`
          : `Faltam ${deficitToProvide} un para cumprir a Política × Receita após PPU, CeIMSPA e ODA. FAT/EMB/REC são históricos de material já entregue/recebido e não são somados novamente.`)
        : odaRiskQty > 0
          ? `A quantidade de aquisição já está coberta por ODA, porém ${odaRiskQty} un não possuem previsão dentro do horizonte de 2 anos. Acompanhar prazo sem duplicar compra.`
          : 'Cobertura suficiente por PPU, CeIMSPA e/ou saldo ODA ainda a receber.',
    };
  }).sort((a, b) => {
    const aDef = a.deficit_a_providenciar > 0 ? 0 : 1;
    const bDef = b.deficit_a_providenciar > 0 ? 0 : 1;
    if (aDef !== bDef) return aDef - bDef;
    const aPrio = a.prioridade_mais_alta || 999999;
    const bPrio = b.prioridade_mais_alta || 999999;
    if (aPrio !== bPrio) return aPrio - bPrio;
    if (b.deficit_a_providenciar !== a.deficit_a_providenciar) return b.deficit_a_providenciar - a.deficit_a_providenciar;
    return a.pn.localeCompare(b.pn);
  });

  const deficientRows = rows.filter((row) => row.deficit_a_providenciar > 0);
  const summary = {
    horizonte_dias: Math.max(1, Number(horizonDays) || 730),
    receitas_com_politica: policyRecipes.size,
    receitas_deficientes: deficientRecipes.size,
    pns_planejados: rows.length,
    pns_deficientes: deficientRows.length,
    necessidade_2_anos: round(rows.reduce((sum, row) => sum + row.necessidade_2_anos, 0)),
    ppu_efetivo: round(rows.reduce((sum, row) => sum + Math.min(row.ppu_efetivo, row.necessidade_2_anos), 0)),
    ceimspa_disponivel: round(rows.reduce((sum, row) => sum + Math.min(row.ceimspa_disponivel, Math.max(0, row.necessidade_2_anos - row.ppu_efetivo)), 0)),
    oda_a_receber: round(rows.reduce((sum, row) => sum + row.oda_aplicada_na_necessidade, 0)),
    odc_em_andamento: round(rows.reduce((sum, row) => sum + row.odc_em_andamento, 0)),
    deficit_a_providenciar: round(rows.reduce((sum, row) => sum + row.deficit_a_providenciar, 0)),
    risco_cobertura_no_horizonte: round(rows.reduce((sum, row) => sum + row.risco_cobertura_no_horizonte, 0)),
    blockers: blockers.length,
  };

  return {
    summary,
    rows,
    deficient_rows: deficientRows,
    blockers,
    rules: [
      'Demanda = Qtde planejada em 2 anos na Política × Qtd por ciclo da Receita.',
      'Demandas de um mesmo PN são consolidadas antes da cobertura para não reutilizar o mesmo estoque em duas receitas.',
      'PPU efetivo e CeIMSPA disponível reduzem a necessidade porque representam disponibilidade atual consultável.',
      'Somente o saldo ODA ainda a receber reduz a necessidade de nova aquisição.',
      'ODC não reduz a necessidade: permanece em evidência como processo em andamento que requer suplementação/liberação.',
      'FAT, EMB e REC são evidências históricas de material já entregue/recebido e nunca são somados novamente como cobertura futura.',
      'ODA sem data ou fora do horizonte evita compra duplicada, mas permanece sinalizada como risco de prazo.',
      'CAN, registros inativos e quantidades já recebidas não entram no saldo ODA a receber.',
      'Receita/política incompleta falha fechada: o SISHA não presume 1 ciclo nem quantidade por ciclo.',
    ],
  };
}

function formatRecipePolicyDeficiencyRows(rows = []) {
  return (rows || []).map((row) => ({
    PN: row.pn,
    NSN: row.nsn || '',
    Nomenclatura: row.nomenclatura || '',
    Prioridade: row.prioridade_mais_alta ?? '',
    Receitas_Politica: row.receitas_texto || '',
    Necessidade_2_Anos: row.necessidade_2_anos,
    PPU_Efetivo: row.ppu_efetivo,
    CeIMSPA_Disponivel: row.ceimspa_disponivel,
    Cobertura_Fisica_Atual: row.cobertura_fisica_atual,
    Deficit_Apos_PPU_CeIMSPA: row.deficit_apos_estoques,
    ODA_Com_Previsao_2_Anos: row.oda_no_horizonte,
    ODA_Sem_Data: row.oda_sem_data,
    ODA_Fora_2_Anos: row.oda_fora_horizonte,
    ODA_A_Receber_Total: row.oda_a_receber_total,
    Deficit_A_Providenciar: row.deficit_a_providenciar,
    ODC_Em_Andamento: row.odc_em_andamento,
    Risco_ODA_No_Horizonte: row.risco_cobertura_no_horizonte,
    Cobertura_Para_Compra_Percentual: row.cobertura_confirmada_percentual,
    FAT_EMB_REC_Historicos: row.entregas_historicas_fat_emb_rec,
    Documentos_ODA: row.documentos_oda || '',
    Documentos_ODC: row.documentos_odc || '',
    Documentos_Historicos_FAT_EMB_REC: row.documentos_historicos_fat_emb_rec || '',
    Situacao: row.status,
    Fonte_Compra: row.fonte_compra || '',
    Nota: row.nota || '',
  }));
}

module.exports = {
  normalizePn,
  pendingPurchaseQty,
  buildPurchaseCoverage,
  buildRecipePolicyDeficiency,
  formatRecipePolicyDeficiencyRows,
};
