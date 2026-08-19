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

function pendingPurchaseQty(row = {}) {
  const base = positive(row.qtd_comprada) || positive(row.quantidade) || positive(row.qtd_pedida);
  const received = positive(row.qtd_recebida);
  return Math.max(0, base - received);
}

function buildPurchaseCoverage(rows = [], pn, { now = new Date(), horizonDays = 730 } = {}) {
  const targetPn = normalizePn(pn);
  const horizonEnd = new Date(now.getTime() + (Math.max(1, Number(horizonDays) || 730) * 86400000));
  const committedStatuses = new Set(['ODA', 'FAT', 'EMB']);
  const potentialStatuses = new Set(['ODC', 'ELB', 'TRI', 'ANS', 'COT', 'PRO', 'LIB', 'LPC']);
  const excludedStatuses = new Set(['CAN', 'REC', 'EXCLUIDO', 'EXCLUÍDO']);
  let committedWithinHorizon = 0;
  let committedWithoutDate = 0;
  let committedOutsideHorizon = 0;
  let potentialWithinHorizon = 0;
  let potentialWithoutDate = 0;
  let potentialOutsideHorizon = 0;
  const docs = new Set();
  let canonicalRows = 0;

  (rows || []).forEach((row) => {
    if (row?.ativo === false) return;
    if (normalizePn(row?.pn) !== targetPn) return;
    const status = upper(row.status_grupo || row.status);
    if (!status || excludedStatuses.has(status)) return;
    const qty = pendingPurchaseQty(row);
    if (qty <= 0) return;
    canonicalRows += 1;
    const ref = clean(row.numero_pd || row.documento_referencia || row.numero_oc);
    if (ref) docs.add(ref);
    const expected = parseDate(row.data_previsao_entrega || row.data_previsao);
    const inside = expected && expected.getTime() <= horizonEnd.getTime();

    if (committedStatuses.has(status)) {
      if (!expected) committedWithoutDate += qty;
      else if (inside) committedWithinHorizon += qty;
      else committedOutsideHorizon += qty;
      return;
    }

    if (potentialStatuses.has(status)) {
      if (!expected) potentialWithoutDate += qty;
      else if (inside) potentialWithinHorizon += qty;
      else potentialOutsideHorizon += qty;
    }
  });

  return {
    canonical_rows: canonicalRows,
    committed_within_horizon: round(committedWithinHorizon),
    committed_without_date: round(committedWithoutDate),
    committed_outside_horizon: round(committedOutsideHorizon),
    potential_within_horizon: round(potentialWithinHorizon),
    potential_without_date: round(potentialWithoutDate),
    potential_outside_horizon: round(potentialOutsideHorizon),
    documents: Array.from(docs).sort(),
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
    const immediateShortage = round(Math.max(0, need - ppu));
    const canonical = buildPurchaseCoverage(purchaseRows, entry.pn, { now, horizonDays });

    let committedWithin = canonical.committed_within_horizon;
    let committedUndated = canonical.committed_without_date;
    let committedOutside = canonical.committed_outside_horizon;
    let potentialWithin = canonical.potential_within_horizon;
    let potentialUndated = canonical.potential_without_date;
    let potentialOutside = canonical.potential_outside_horizon;
    let purchaseSource = 'COMPRAS_PDS';
    let purchaseDocs = canonical.documents;

    if (canonical.canonical_rows === 0) {
      const legacyOda = round(mapQuantity(odaFallbackMap, entry.pn));
      const legacyOdc = round(mapQuantity(odcFallbackMap, entry.pn));
      if (legacyOda > 0 || legacyOdc > 0) {
        committedUndated = legacyOda;
        potentialUndated = legacyOdc;
        purchaseSource = 'FALLBACK_ORDER_BOOK_ODC';
        purchaseDocs = [...new Set([...mapDocs(odaFallbackMap, entry.pn), ...mapDocs(odcFallbackMap, entry.pn)])];
      }
    }

    const committedTotal = round(committedWithin + committedUndated + committedOutside);
    const horizonCoverageRisk = round(Math.max(0, immediateShortage - committedWithin));
    const deficitToProvide = round(Math.max(0, immediateShortage - committedTotal));
    const ceimspa = ceimspaQuantity(ceimspaRows, entry.pn, mapEntry(pnPiMap, entry.pn) || new Set());
    const potentialPipeline = round(potentialWithin + potentialUndated);
    const afterPotential = round(Math.max(0, deficitToProvide - ceimspa - potentialPipeline));
    const committedCoverage = round(Math.min(need, ppu + committedTotal));
    const confirmedCoveragePct = need > 0 ? round((committedCoverage / need) * 100, 1) : 100;

    let status = 'DEFICIENTE';
    if (immediateShortage <= 0) status = 'COBERTO_NO_PPU';
    else if (deficitToProvide <= 0 && horizonCoverageRisk <= 0) status = 'COBERTO_COMPROMETIDO_NO_HORIZONTE';
    else if (deficitToProvide <= 0) status = 'COBERTO_COMPROMETIDO_COM_RISCO_PRAZO';
    else if (afterPotential <= 0) status = 'COBERTURA_POTENCIAL';

    if (deficitToProvide > 0) entry.receitas.forEach((item) => deficientRecipes.add(item.receita));

    return {
      pn: entry.pn,
      nsn: entry.nsn || null,
      nomenclatura: entry.nomenclatura || 'N/A',
      prioridade_mais_alta: entry.prioridade_mais_alta,
      necessidade_2_anos: need,
      ppu_efetivo: ppu,
      deficit_imediato: immediateShortage,
      compras_comprometidas_no_horizonte: round(committedWithin),
      compras_comprometidas_sem_data: round(committedUndated),
      compras_comprometidas_fora_horizonte: round(committedOutside),
      compras_comprometidas_total: committedTotal,
      risco_cobertura_no_horizonte: horizonCoverageRisk,
      deficit_a_providenciar: deficitToProvide,
      ceimspa_potencial: ceimspa,
      pipeline_potencial_no_horizonte: round(potentialWithin),
      pipeline_potencial_sem_data: round(potentialUndated),
      pipeline_potencial_fora_horizonte: round(potentialOutside),
      deficit_apos_potenciais: afterPotential,
      cobertura_confirmada_percentual: confirmedCoveragePct,
      status,
      receitas: entry.receitas,
      receitas_texto: entry.receitas.map((item) => `${item.receita}: ${item.ciclos_planejados_2_anos} ciclo(s) × ${item.qtd_por_ciclo} = ${item.necessidade}`).join(' | '),
      documentos_compra: purchaseDocs.join(' | '),
      fonte_compra: purchaseSource,
      nota: deficitToProvide > 0
        ? 'Déficit a providenciar = necessidade da Política/Receita menos PPU efetivo e toda compra ativa ODA/FAT/EMB ainda pendente. CeIMSPA e ODC/pipeline são apenas potenciais. Compromissos sem data ou fora do horizonte não geram compra duplicada, mas aparecem como risco de prazo.'
        : horizonCoverageRisk > 0
          ? 'Quantidade de aquisição já está coberta por ODA/FAT/EMB, porém parte da cobertura não possui previsão dentro do horizonte de 2 anos; acompanhar como risco de prazo, sem duplicar compra.'
          : 'Cobertura física/comprometida suficiente para a necessidade Política × Receita.',
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
    compras_comprometidas_no_horizonte: round(rows.reduce((sum, row) => sum + row.compras_comprometidas_no_horizonte, 0)),
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
      'PPU efetivo é cobertura física confirmada.',
      'Toda compra ativa ODA/FAT/EMB pendente reduz o déficit a providenciar, evitando compra duplicada.',
      'ODA/FAT/EMB sem data ou fora do horizonte continuam visíveis como risco de prazo, mas não viram nova demanda de aquisição.',
      'ODC/estágios anteriores e CeIMSPA são cobertura potencial e não reduzem o déficit a providenciar enquanto não forem confirmados.',
      'CAN, REC e registros inativos não entram como compra pendente.',
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
    Deficit_Imediato: row.deficit_imediato,
    ODA_FAT_EMB_Com_Previsao_2_Anos: row.compras_comprometidas_no_horizonte,
    ODA_FAT_EMB_Sem_Data: row.compras_comprometidas_sem_data,
    ODA_FAT_EMB_Fora_2_Anos: row.compras_comprometidas_fora_horizonte,
    ODA_FAT_EMB_Comprometido_Total: row.compras_comprometidas_total,
    Risco_Cobertura_No_Horizonte: row.risco_cobertura_no_horizonte,
    Deficit_A_Providenciar: row.deficit_a_providenciar,
    CeIMSPA_Potencial: row.ceimspa_potencial,
    ODC_Pipeline_Potencial_2_Anos: row.pipeline_potencial_no_horizonte,
    ODC_Pipeline_Potencial_Sem_Data: row.pipeline_potencial_sem_data,
    Deficit_Apos_Potenciais: row.deficit_apos_potenciais,
    Cobertura_Confirmada_Percentual: row.cobertura_confirmada_percentual,
    Situacao: row.status,
    Documentos_Compra: row.documentos_compra || '',
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
