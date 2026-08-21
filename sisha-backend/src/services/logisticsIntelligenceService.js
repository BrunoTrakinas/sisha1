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

function numeric(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function positive(value) {
  const n = numeric(value);
  return n !== null && n > 0 ? n : 0;
}

function dateValue(value) {
  if (!value) return null;
  const time = new Date(value).getTime();
  return Number.isFinite(time) ? time : null;
}

function daysBetween(a, b) {
  const x = dateValue(a);
  const y = dateValue(b);
  if (x === null || y === null) return null;
  return (y - x) / 86400000;
}

function round(value, digits = 2) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  const factor = 10 ** digits;
  return Math.round(n * factor) / factor;
}

function median(values = []) {
  const list = values.map(Number).filter(Number.isFinite).sort((a, b) => a - b);
  if (!list.length) return null;
  const middle = Math.floor(list.length / 2);
  return list.length % 2 ? list[middle] : (list[middle - 1] + list[middle]) / 2;
}

function average(values = []) {
  const list = values.map(Number).filter(Number.isFinite);
  if (!list.length) return null;
  return list.reduce((sum, value) => sum + value, 0) / list.length;
}

function parseLeadTimeDays(value) {
  const direct = numeric(value);
  if (direct !== null && direct >= 0) return direct;
  const text = upper(value);
  if (!text) return null;
  const days = text.match(/(\d+(?:[.,]\d+)?)\s*(?:DIA|DIAS|DAY|DAYS)\b/);
  if (days) return Number(days[1].replace(',', '.'));
  const weeks = text.match(/(\d+(?:[.,]\d+)?)\s*(?:SEMANA|SEMANAS|WEEK|WEEKS)\b/);
  if (weeks) return Number(weeks[1].replace(',', '.')) * 7;
  const months = text.match(/(\d+(?:[.,]\d+)?)\s*(?:MES|MESES|MÊS|MESES|MONTH|MONTHS)\b/);
  if (months) return Number(months[1].replace(',', '.')) * 30;
  return null;
}

function buildConsumptionProjection(rows = [], horizonDays = 90, now = new Date()) {
  const horizon = Math.max(1, Number(horizonDays) || 90);
  const nowTime = now instanceof Date ? now.getTime() : new Date(now).getTime();
  const lookbackStart = nowTime - (365 * 86400000);
  const valid = (rows || [])
    .map((row) => ({
      date: dateValue(row.data_movimentacao || row.data || row.created_at),
      qty: positive(row.quantidade ?? row.qtd),
    }))
    .filter((row) => row.date !== null && row.date >= lookbackStart && row.date <= nowTime && row.qty > 0)
    .sort((a, b) => a.date - b.date);

  const distinctDates = [...new Set(valid.map((row) => new Date(row.date).toISOString().slice(0, 10)))];
  if (valid.length < 2 || distinctDates.length < 2) {
    return {
      ready: false,
      projected_qty: null,
      daily_rate: null,
      total_qty_lookback: valid.reduce((sum, row) => sum + row.qty, 0),
      observations: valid.length,
      distinct_dates: distinctDates.length,
      blocker: 'HISTORICAL_CONSUMPTION_COVERAGE_INSUFFICIENT',
    };
  }

  const firstDate = valid[0].date;
  const observationDays = Math.max(1, (nowTime - firstDate) / 86400000);
  if (observationDays < 30) {
    return {
      ready: false,
      projected_qty: null,
      daily_rate: null,
      total_qty_lookback: valid.reduce((sum, row) => sum + row.qty, 0),
      observations: valid.length,
      distinct_dates: distinctDates.length,
      observation_days: round(observationDays, 1),
      blocker: 'HISTORICAL_WINDOW_LT_30_DAYS',
    };
  }

  const total = valid.reduce((sum, row) => sum + row.qty, 0);
  const rate = total / observationDays;
  return {
    ready: true,
    projected_qty: round(rate * horizon, 3),
    daily_rate: round(rate, 6),
    total_qty_lookback: round(total, 3),
    observations: valid.length,
    distinct_dates: distinctDates.length,
    observation_days: round(observationDays, 1),
    blocker: null,
    method: 'SUM_POSITIVE_MOVEMENTS_LAST_365D / DAYS_FROM_FIRST_OBSERVATION_TO_NOW',
  };
}

function buildReliabilityProjection(summary = {}, expectedFlightHours = 0) {
  const hours = positive(expectedFlightHours);
  const mtbf = summary?.mtbf || {};
  if (hours <= 0) {
    return { ready: false, expected_failures: null, mtbf_hours: mtbf.value_hours ?? null, blocker: 'EXPECTED_FLIGHT_HOURS_REQUIRED' };
  }
  if (!mtbf.ready || !Number.isFinite(Number(mtbf.value_hours)) || Number(mtbf.value_hours) <= 0) {
    return { ready: false, expected_failures: null, mtbf_hours: mtbf.value_hours ?? null, blocker: mtbf.blocker || 'MTBF_NOT_READY' };
  }
  return {
    ready: true,
    expected_failures: round(hours / Number(mtbf.value_hours), 4),
    mtbf_hours: round(Number(mtbf.value_hours), 2),
    blocker: null,
    method: 'EXPECTED_FLIGHT_HOURS / A3_MTBF_HOURS',
  };
}

function scheduledNeedInsideHorizon(row = {}, horizonEnd, expectedFlightHours = 0, expectedCycles = 0) {
  if (upper(row.planning_status) === 'OVERDUE') return { include: true, reason: 'OVERDUE' };
  const trigger = row.trigger || {};
  const type = upper(trigger.type);
  if (type === 'DATE') {
    const due = dateValue(trigger.due_date);
    return { include: due !== null && due <= horizonEnd.getTime(), reason: due !== null ? 'DATE' : 'INVALID_DATE' };
  }
  if (type === 'HOURS_REMAINING') {
    const remaining = numeric(trigger.value);
    const expected = positive(expectedFlightHours);
    if (remaining === null || expected <= 0) return { include: false, reason: expected <= 0 ? 'EXPECTED_HOURS_REQUIRED' : 'INVALID_REMAINING' };
    return { include: remaining <= expected, reason: 'HOURS_REMAINING' };
  }
  if (type === 'CYCLES_REMAINING') {
    const remaining = numeric(trigger.value);
    const expected = positive(expectedCycles);
    if (remaining === null || expected <= 0) return { include: false, reason: expected <= 0 ? 'EXPECTED_CYCLES_REQUIRED' : 'INVALID_REMAINING' };
    return { include: remaining <= expected, reason: 'CYCLES_REMAINING' };
  }
  return { include: false, reason: 'UNSUPPORTED_TRIGGER' };
}

function buildScheduledProjection(rows = [], horizonDays = 90, expectedFlightHours = 0, expectedCycles = 0, now = new Date()) {
  const horizonEnd = new Date((now instanceof Date ? now.getTime() : new Date(now).getTime()) + (Math.max(1, Number(horizonDays) || 90) * 86400000));
  const included = [];
  const blocked = [];
  for (const row of rows || []) {
    const decision = scheduledNeedInsideHorizon(row, horizonEnd, expectedFlightHours, expectedCycles);
    if (decision.include) included.push({ ...row, horizon_reason: decision.reason });
    else if (decision.reason && !['DATE', 'HOURS_REMAINING', 'CYCLES_REMAINING'].includes(decision.reason)) blocked.push({ ...row, horizon_blocker: decision.reason });
  }
  return {
    ready: true,
    projected_qty: round(included.reduce((sum, row) => sum + positive(row.quantidade || 1), 0), 3),
    included,
    blocked,
  };
}

function pendingPurchaseQty(row = {}) {
  const base = positive(row.qtd_comprada) || positive(row.quantidade) || positive(row.qtd_pedida);
  const received = positive(row.qtd_recebida);
  return Math.max(0, base - received);
}

function buildProcurementSnapshot(rows = [], horizonDays = 90, now = new Date(), referenceLeadTime = null) {
  const horizonEnd = new Date((now instanceof Date ? now.getTime() : new Date(now).getTime()) + (Math.max(1, Number(horizonDays) || 90) * 86400000));
  const committedStatuses = new Set(['ODA']);
  const potentialStatuses = new Set(['ODC', 'ELB', 'TRI', 'ANS', 'COT', 'PRO']);
  let committedWithinHorizon = 0;
  let potentialWithinHorizon = 0;
  let pipelineWithoutDate = 0;
  const historicalLead = [];
  const delayValues = [];
  const pipeline = [];

  for (const row of rows || []) {
    const qty = pendingPurchaseQty(row);
    const status = upper(row.status_grupo || row.status);
    const expected = dateValue(row.data_previsao_entrega);
    const delivered = dateValue(row.data_entrega);
    const expectedInside = expected !== null && expected <= horizonEnd.getTime();
    const lead = positive(row.dias_entrega);
    if (lead > 0) historicalLead.push(lead);
    if (expected !== null && delivered !== null) {
      const delay = (delivered - expected) / 86400000;
      if (Number.isFinite(delay)) delayValues.push(delay);
    }
    if (qty <= 0 || ['CAN', 'EXCLUIDO'].includes(status)) continue;
    if (['FAT', 'EMB', 'REC'].includes(status)) {
      pipeline.push({
        numero_pd: clean(row.numero_pd),
        numero_oc: clean(row.numero_oc),
        status,
        pending_qty: 0,
        expected_date: expected !== null ? new Date(expected).toISOString().slice(0, 10) : null,
        committed: false,
        within_horizon: false,
        coverage_role: 'HISTORICAL_DELIVERED',
      });
      continue;
    }
    if (committedStatuses.has(status) && expectedInside) committedWithinHorizon += qty;
    else if (potentialStatuses.has(status) && expectedInside) potentialWithinHorizon += qty;
    else if (expected === null) pipelineWithoutDate += qty;
    pipeline.push({
      numero_pd: clean(row.numero_pd),
      numero_oc: clean(row.numero_oc),
      status,
      pending_qty: round(qty, 3),
      expected_date: expected !== null ? new Date(expected).toISOString().slice(0, 10) : null,
      committed: committedStatuses.has(status),
      within_horizon: expectedInside,
    });
  }

  const actualLead = median(historicalLead);
  const referenceLead = parseLeadTimeDays(referenceLeadTime);
  const effectiveLead = actualLead !== null ? actualLead : referenceLead;
  return {
    committed_within_horizon: round(committedWithinHorizon, 3),
    potential_within_horizon: round(potentialWithinHorizon, 3),
    pipeline_without_date: round(pipelineWithoutDate, 3),
    pipeline,
    lead_time: {
      effective_days: effectiveLead !== null ? round(effectiveLead, 1) : null,
      source: actualLead !== null ? 'HISTORICAL_PD_DIAS_ENTREGA_MEDIAN' : referenceLead !== null ? 'REFERENCE_PRICE_OR_RFQ' : null,
      historical_samples: historicalLead.length,
      historical_median_days: actualLead !== null ? round(actualLead, 1) : null,
      reference_days: referenceLead !== null ? round(referenceLead, 1) : null,
    },
    historical_delay: {
      samples: delayValues.length,
      average_days: delayValues.length ? round(average(delayValues), 1) : null,
      median_days: delayValues.length ? round(median(delayValues), 1) : null,
    },
  };
}

function buildRepairSnapshot(rows = [], horizonDays = 90, now = new Date()) {
  const horizonEnd = new Date((now instanceof Date ? now.getTime() : new Date(now).getTime()) + (Math.max(1, Number(horizonDays) || 90) * 86400000));
  let openUnits = 0;
  let potentialWithinHorizon = 0;
  const items = [];
  for (const row of rows || []) {
    const status = upper(row.status_grupo || row.status);
    const result = upper(row.resultado_tecnico || row.resultado);
    const returned = dateValue(row.data_retorno);
    if (['CAN', 'REC', 'EXCLUIDO'].includes(status) || result === 'IRREPARAVEL' || result === 'IRREPARABLE' || returned !== null) continue;
    openUnits += 1;
    const forecast = dateValue(row.data_previsao_entrega || row.data_previsao);
    const within = forecast !== null && forecast <= horizonEnd.getTime();
    if (within) potentialWithinHorizon += 1;
    items.push({
      numero_wo: clean(row.numero_wo),
      sn: clean(row.sn),
      status,
      resultado_tecnico: result,
      expected_date: forecast !== null ? new Date(forecast).toISOString().slice(0, 10) : null,
      within_horizon: within,
    });
  }
  return {
    open_units: openUnits,
    potential_return_within_horizon: potentialWithinHorizon,
    items,
    note: 'WO/reparo em aberto é cobertura potencial. Não vira estoque confirmado antes do retorno/disponibilidade.',
  };
}

function deriveCriticality(rows = []) {
  const raw = [];
  let critical = false;
  for (const row of rows || []) {
    for (const value of [row.critica, row.prioridade]) {
      const text = upper(value);
      if (!text) continue;
      raw.push(text);
      if (/^(?:S|SIM|YES|Y|1|P1|ALTA|HIGH|CRITICA|CRÍTICA|CRITICAL)$/.test(text) || text.includes('CRIT')) critical = true;
    }
  }
  return {
    status: critical ? 'CRITICAL' : raw.length ? 'DOCUMENTED_NOT_CONFIRMED_CRITICAL' : 'UNCONFIRMED',
    raw_values: [...new Set(raw)],
    note: critical ? 'Criticidade explícita encontrada em compra/reparo.' : 'O A4 não inventa criticidade quando a fonte não a confirma.',
  };
}

function sumQuantity(rows = []) {
  return round((rows || []).reduce((sum, row) => sum + positive(row.quantidade ?? row.qtd), 0), 3) || 0;
}

function buildRecommendation({ shortageStrict, shortageAfterPotential, ceimspaQty, repairPotential, purchasePotential, leadTimeDays, horizonDays, criticality }) {
  const actions = [];
  let remaining = Math.max(0, shortageStrict);
  const ceimspaUse = Math.min(remaining, Math.max(0, ceimspaQty));
  if (ceimspaUse > 0) {
    actions.push({ action: 'CONFIRM_CEIMSPA', quantity: round(ceimspaUse, 3), reason: 'CeIMSPA é possibilidade de cobertura e exige confirmação externa.' });
    remaining -= ceimspaUse;
  }
  const repairUse = Math.min(remaining, Math.max(0, repairPotential));
  if (repairUse > 0) {
    actions.push({ action: 'EXPEDITE_REPAIR_RETURN', quantity: round(repairUse, 3), reason: 'Há WO/reparo com previsão dentro do horizonte, mas retorno ainda não é estoque confirmado.' });
    remaining -= repairUse;
  }
  const pipelineUse = Math.min(remaining, Math.max(0, purchasePotential));
  if (pipelineUse > 0) {
    actions.push({ action: 'CONFIRM_OR_EXPEDITE_PURCHASE_PIPELINE', quantity: round(pipelineUse, 3), reason: 'Há compra/PD potencial no horizonte, ainda sem o grau de compromisso de uma ODA.' });
    remaining -= pipelineUse;
  }
  if (shortageAfterPotential > 0) {
    actions.push({
      action: 'ACQUIRE_OR_REPAIR',
      quantity: round(shortageAfterPotential, 3),
      reason: leadTimeDays !== null && leadTimeDays > horizonDays
        ? `Déficit persiste mesmo após coberturas potenciais e o lead time (${round(leadTimeDays, 1)} dias) excede o horizonte.`
        : 'Déficit persiste mesmo após coberturas potenciais.',
    });
  }
  if (!actions.length) actions.push({ action: 'MONITOR', quantity: 0, reason: 'Cobertura confirmada atende à demanda projetada no horizonte analisado.' });
  return {
    actions,
    primary_action: actions[0]?.action || 'MONITOR',
    contingency_purchase_qty: round(Math.max(0, shortageAfterPotential), 3),
    criticality: criticality?.status || 'UNCONFIRMED',
  };
}

function buildA4PnAnalysis({
  pn,
  nomenclature = null,
  horizonDays = 90,
  expectedFlightHours = 0,
  expectedCycles = 0,
  historyRows = [],
  ppuRows = [],
  ceimspaRows = [],
  purchaseRows = [],
  repairRows = [],
  scheduledNeeds = [],
  reliabilitySummary = {},
  referencePrice = null,
  now = new Date(),
} = {}) {
  const normalizedPn = normalizePn(pn);
  if (!normalizedPn) throw new Error('A4: PN é obrigatório.');
  const horizon = Math.min(365, Math.max(7, Number(horizonDays) || 90));
  const consumption = buildConsumptionProjection(historyRows, horizon, now);
  const reliability = buildReliabilityProjection(reliabilitySummary, expectedFlightHours);
  const scheduled = buildScheduledProjection(scheduledNeeds, horizon, expectedFlightHours, expectedCycles, now);
  const procurement = buildProcurementSnapshot(purchaseRows, horizon, now, referencePrice?.lead_time);
  const repairs = buildRepairSnapshot(repairRows, horizon, now);
  const criticality = deriveCriticality([...(purchaseRows || []), ...(repairRows || [])]);

  const ppuQty = sumQuantity(ppuRows);
  const ceimspaQty = sumQuantity(ceimspaRows);
  const demandSourcesReady = Boolean(consumption.ready || reliability.ready || scheduled.projected_qty > 0);
  const rawDemand = (consumption.ready ? Number(consumption.projected_qty || 0) : 0)
    + (reliability.ready ? Number(reliability.expected_failures || 0) : 0)
    + Number(scheduled.projected_qty || 0);
  const predictedNeed = demandSourcesReady ? Math.ceil(Math.max(0, rawDemand - 1e-9)) : null;

  const confirmedSupply = ppuQty + Number(procurement.committed_within_horizon || 0);
  const potentialSupply = confirmedSupply
    + ceimspaQty
    + Number(procurement.potential_within_horizon || 0)
    + Number(repairs.potential_return_within_horizon || 0);
  const shortageStrict = predictedNeed === null ? null : Math.max(0, predictedNeed - confirmedSupply);
  const shortageAfterPotential = predictedNeed === null ? null : Math.max(0, predictedNeed - potentialSupply);
  const riskIndex = predictedNeed && predictedNeed > 0
    ? round((shortageStrict / predictedNeed) * 100, 1)
    : predictedNeed === 0 ? 0 : null;
  const equivalentDailyDemand = predictedNeed && predictedNeed > 0 ? predictedNeed / horizon : null;
  const coverageDays = equivalentDailyDemand ? confirmedSupply / equivalentDailyDemand : null;
  const leadTimeDays = procurement.lead_time.effective_days;
  const leadTimeExposure = coverageDays !== null && leadTimeDays !== null && coverageDays < leadTimeDays;

  const recommendation = predictedNeed === null
    ? {
        actions: [{ action: 'COMPLETE_EVIDENCE', quantity: 0, reason: 'Consumo, MTBF/horas previstas ou necessidade programada ainda não sustentam uma projeção quantitativa.' }],
        primary_action: 'COMPLETE_EVIDENCE',
        contingency_purchase_qty: null,
        criticality: criticality.status,
      }
    : buildRecommendation({
        shortageStrict,
        shortageAfterPotential,
        ceimspaQty,
        repairPotential: repairs.potential_return_within_horizon,
        purchasePotential: procurement.potential_within_horizon,
        leadTimeDays,
        horizonDays: horizon,
        criticality,
      });

  const status = predictedNeed === null
    ? 'BLOCKED'
    : shortageStrict > 0
      ? 'PROJECTED_RUPTURE'
      : leadTimeExposure
        ? 'LEAD_TIME_EXPOSURE'
        : 'COVERED';

  const riskExplanation = riskIndex === null
    ? 'Sem índice: a projeção quantitativa está bloqueada por evidência insuficiente.'
    : 'Índice = parcela da demanda prevista que não possui cobertura confirmada. Não é probabilidade estatística fabricada.';

  const answer = predictedNeed === null
    ? `PN ${normalizedPn}: o A4 não calcula risco de ruptura sem base quantitativa suficiente. Complete consumo histórico, MTBF + horas previstas ou necessidade programada confirmada.`
    : `PN ${normalizedPn} — horizonte ${horizon} dias: demanda prevista ${predictedNeed} un.; PPU confirmado ${round(ppuQty, 2)}; CeIMSPA potencial ${round(ceimspaQty, 2)}; compras comprometidas no horizonte ${round(procurement.committed_within_horizon, 2)}; ${repairs.open_units} unidade(s) em reparo. Déficit com cobertura confirmada ${round(shortageStrict, 2)} un.; déficit após coberturas potenciais ${round(shortageAfterPotential, 2)} un. Índice de risco de ruptura ${riskIndex}%.${leadTimeDays !== null ? ` Lead time ${round(leadTimeDays, 1)} dias.` : ''} Ação principal: ${recommendation.primary_action}.`;

  return {
    pn: normalizedPn,
    nomenclature: nomenclature || referencePrice?.nomenclatura || null,
    horizon_days: horizon,
    expected_flight_hours: positive(expectedFlightHours),
    expected_cycles: positive(expectedCycles),
    status,
    demand: {
      predicted_qty: predictedNeed,
      raw_expected_qty: demandSourcesReady ? round(rawDemand, 4) : null,
      consumption,
      reliability,
      scheduled,
    },
    supply: {
      ppu_confirmed: ppuQty,
      ceimspa_potential: ceimspaQty,
      purchase_committed_within_horizon: procurement.committed_within_horizon,
      purchase_potential_within_horizon: procurement.potential_within_horizon,
      repair_open_units: repairs.open_units,
      repair_potential_within_horizon: repairs.potential_return_within_horizon,
      confirmed_total: round(confirmedSupply, 3),
      potential_total: round(potentialSupply, 3),
    },
    procurement,
    repairs,
    criticality,
    risk: {
      index_percent: riskIndex,
      explanation: riskExplanation,
      shortage_confirmed_qty: shortageStrict,
      shortage_after_potential_qty: shortageAfterPotential,
      coverage_days_confirmed: coverageDays !== null ? round(coverageDays, 1) : null,
      lead_time_exposure: leadTimeExposure,
    },
    recommendation,
    reference_price: referencePrice ? {
      source: referencePrice.fonte_exibicao || referencePrice.fonte_preco || referencePrice.fonte || null,
      lead_time: referencePrice.lead_time ?? null,
      status_preco: referencePrice.status_preco || null,
      estimativa: Boolean(referencePrice.estimativa),
    } : null,
    answer,
    rules: [
      'PPU é cobertura confirmada; localizações excluídas já ficam fora da view de disponibilidade.',
      'CeIMSPA é cobertura potencial e exige confirmação externa.',
      'WO/reparo em aberto é potencial até retorno/disponibilidade confirmados.',
      'Somente ODA reduz déficit futuro de aquisição quando possui previsão dentro do horizonte. FAT/EMB/REC são evidências de material já entregue/recebido e não são somadas novamente como cobertura futura.',
      'ODC e estágios anteriores são pipeline potencial, não estoque confirmado.',
      'Índice de risco não é probabilidade estatística: representa a fração da demanda prevista sem cobertura confirmada.',
      'A4 é somente recomendação read-only; não cria OC, PD, WO ou movimentação automaticamente.',
    ],
  };
}

async function fetchRows(table, columns, builder = null) {
  const supabase = require('../config/supabaseClient');
  let query = supabase.from(table).select(columns);
  if (builder) query = builder(query);
  const { data, error } = await query.limit(10000);
  if (error) throw error;
  return data || [];
}

async function getLogisticsIntelligence(input = {}) {
  const { loadReferencePriceRows } = require('./pricingService');
  const { loadMaintenanceProgram } = require('./maintenancePlanningService');
  const { listReliabilityCycles } = require('./equipmentReliabilityService');
  const { summarizeA3Cycles } = require('./reliabilityAnalysisService');
  const { loadEffectivePpuRowsByPns } = require('./ppuEffectiveAvailabilityService');
  const pn = normalizePn(input.pn);
  if (!pn) throw new Error('Informe o PN para análise A4.');
  const horizonDays = Math.min(365, Math.max(7, Number(input.horizon_days || input.horizonDays) || 90));
  const expectedFlightHours = positive(input.expected_flight_hours ?? input.expectedFlightHours);
  const expectedCycles = positive(input.expected_cycles ?? input.expectedCycles);

  const [historyRows, ppuRows, ceimspaRows, purchaseRows, repairRows, maintenance, reliabilityCycles, priceRows] = await Promise.all([
    fetchRows('historico_movimentacao', 'pn,data_movimentacao,quantidade,os,created_at', (q) => q.eq('pn', pn)).catch(() => []),
    loadEffectivePpuRowsByPns([pn]).catch(() => []),
    fetchRows('v_sisha_ceimspa_disponibilidade', 'pn,pi,quantidade,nomenclatura,origem_saldo,numero_recibo', (q) => q.eq('pn', pn)).catch(() => []),
    fetchRows('compras_pds', 'pn,numero_pd,numero_oc,quantidade,qtd_pedida,qtd_comprada,qtd_recebida,dias_entrega,data_previsao_entrega,data_entrega,status,status_grupo,critica,prioridade,ativo', (q) => q.eq('pn', pn).eq('ativo', true)).catch(() => []),
    fetchRows('work_orders', 'pn,sn,numero_wo,status,status_grupo,resultado_tecnico,data_previsao,data_previsao_entrega,data_retorno,critica,prioridade,ativo', (q) => q.eq('pn', pn).eq('ativo', true)).catch(() => []),
    loadMaintenanceProgram().catch(() => ({ scheduled_needs: [] })),
    listReliabilityCycles({ pn }).catch(() => []),
    loadReferencePriceRows().catch(() => []),
  ]);

  const referencePrice = (priceRows || []).find((row) => normalizePn(row.pn) === pn) || null;
  const scheduledNeeds = (maintenance?.scheduled_needs || []).filter((row) => normalizePn(row.pn) === pn);
  const reliabilitySummary = summarizeA3Cycles(reliabilityCycles || []);
  const nomenclature = ppuRows.find((row) => clean(row.nomenclatura))?.nomenclatura
    || ceimspaRows.find((row) => clean(row.nomenclatura))?.nomenclatura
    || referencePrice?.nomenclatura
    || null;

  return buildA4PnAnalysis({
    pn,
    nomenclature,
    horizonDays,
    expectedFlightHours,
    expectedCycles,
    historyRows,
    ppuRows,
    ceimspaRows,
    purchaseRows,
    repairRows,
    scheduledNeeds,
    reliabilitySummary,
    referencePrice,
  });
}

module.exports = {
  normalizePn,
  parseLeadTimeDays,
  buildConsumptionProjection,
  buildReliabilityProjection,
  buildScheduledProjection,
  buildProcurementSnapshot,
  buildRepairSnapshot,
  deriveCriticality,
  buildA4PnAnalysis,
  getLogisticsIntelligence,
};
