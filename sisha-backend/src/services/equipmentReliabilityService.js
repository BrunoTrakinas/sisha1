const crypto = require('crypto');
const supabase = require('../config/supabaseClient');
const {
  normalizeCycle,
  summarizeA3Cycles,
} = require('./reliabilityAnalysisService');

function clean(value) {
  const text = String(value ?? '').trim();
  return text || null;
}

function upper(value) {
  const text = clean(value);
  return text ? text.toUpperCase() : null;
}

function normalizeSn(value) {
  const text = upper(value);
  return text ? text.replace(/\s+/g, '') : null;
}

function normalizeUuid(value) {
  const text = clean(value);
  if (!text) return crypto.randomUUID();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(text)) {
    throw new Error('operation_id inválido.');
  }
  return text.toLowerCase();
}

function optionalIso(value, label) {
  const text = clean(value);
  if (!text) return null;
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?$/.test(text)) {
    throw new Error(`${label} sem fuso não é aceita. Envie ISO com Z ou offset.`);
  }
  const date = new Date(text);
  if (Number.isNaN(date.getTime())) throw new Error(`${label} inválida.`);
  return date.toISOString();
}

function numberOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  if (!Number.isFinite(number)) throw new Error('Leitura de utilização inválida.');
  return number;
}

async function chunkedIn(table, select, field, values = [], chunkSize = 200) {
  const unique = [...new Set(values.filter((value) => value !== null && value !== undefined))];
  const rows = [];
  for (let i = 0; i < unique.length; i += chunkSize) {
    const { data, error } = await supabase.from(table).select(select).in(field, unique.slice(i, i + chunkSize));
    if (error) throw error;
    rows.push(...(data || []));
  }
  return rows;
}

async function loadManufacturerSuggestions(pns = []) {
  const unique = [...new Set(pns.map(upper).filter(Boolean))];
  if (!unique.length) return new Map();
  try {
    const rows = await chunkedIn('v_sisha_manual_pn_aplicacao', 'pn,fabricante', 'pn', unique, 100);
    const grouped = new Map();
    for (const row of rows) {
      const pn = upper(row.pn);
      const manufacturer = clean(row.fabricante);
      if (!pn || !manufacturer) continue;
      if (!grouped.has(pn)) grouped.set(pn, new Set());
      grouped.get(pn).add(manufacturer);
    }
    const out = new Map();
    for (const [pn, manufacturers] of grouped.entries()) {
      if (manufacturers.size === 1) out.set(pn, [...manufacturers][0]);
    }
    return out;
  } catch (_error) {
    // Fabricante é enriquecimento opcional. Nunca bloqueia o motor de confiabilidade.
    return new Map();
  }
}

function eventTechnicalSuggestion(event = {}) {
  const text = [event.condicao_resultante, event.motivo, event.observacao, event?.payload?.resultado_tecnico]
    .filter(Boolean)
    .join(' ')
    .toUpperCase();
  if (/\bNFF\b|NO\s+FAULT\s+FOUND/.test(text)) return 'NFF';
  if (/IRREPAR/.test(text)) return 'IRREPARABLE';
  if (/REPARAD/.test(text)) return 'REPAIRED';
  return null;
}

function buildEvidenceSuggestions(cycle, events = [], manufacturerSuggestion = null, nextInstalledAt = null) {
  const start = new Date(cycle.removed_at || cycle.installed_at || 0).getTime();
  const end = nextInstalledAt ? new Date(nextInstalledAt).getTime() : null;
  const relevant = (events || [])
    .filter((event) => {
      const eventTime = new Date(event.data_evento || 0).getTime();
      return eventTime >= start && (end === null || eventTime < end);
    })
    .sort((a, b) => new Date(a.data_evento || 0).getTime() - new Date(b.data_evento || 0).getTime());
  const sends = relevant.filter((event) => upper(event.tipo_evento) === 'ENVIO_WO_REPARO');
  const returns = relevant.filter((event) => upper(event.tipo_evento) === 'RETORNO_WO_REPARO');
  const results = relevant.filter((event) => upper(event.tipo_evento) === 'RESULTADO_TECNICO_WO');
  const repairer = sends.map((event) => clean(event?.payload?.empresa)).find(Boolean) || null;
  const result = [...results, ...returns].map(eventTechnicalSuggestion).find(Boolean) || null;

  return {
    repairer: repairer || null,
    manufacturer: manufacturerSuggestion || null,
    external_send_at: sends[0]?.data_evento || null,
    external_return_at: returns.length ? returns[returns.length - 1].data_evento : null,
    technical_result: result,
    note: 'Sugestões vindas do Livro de Eventos/Manual. Não entram nos indicadores até confirmação Admin/Dono.',
  };
}

async function listReliabilityCycles(filters = {}) {
  const pageSize = 1000;
  const maxRows = 20000;
  const rows = [];

  for (let from = 0; from < maxRows; from += pageSize) {
    let query = supabase
      .from('equipment_operational_intervals')
      .select('*')
      .not('removed_at', 'is', null)
      .order('removed_at', { ascending: false })
      .range(from, from + pageSize - 1);

    if (clean(filters.pn)) query = query.ilike('pn', `%${upper(filters.pn)}%`);
    if (clean(filters.sn)) query = query.ilike('sn', `%${normalizeSn(filters.sn)}%`);
    if (clean(filters.aircraft)) query = query.eq('aircraft_code', upper(filters.aircraft).replace(/^N[-\s]*/, ''));
    if (clean(filters.from)) query = query.gte('removed_at', filters.from);
    if (clean(filters.to)) query = query.lte('removed_at', filters.to);

    const { data, error } = await query;
    if (error) throw error;
    rows.push(...(data || []));
    if (!data || data.length < pageSize) break;
    if (rows.length >= maxRows) {
      throw new Error('A3: recorte excede 20.000 ciclos. Refine PN/SN/aeronave/período para evitar indicador truncado.');
    }
  }

  if (!rows.length) return [];

  const intervalIds = rows.map((row) => row.id);
  const equipmentIds = rows.map((row) => row.equipment_id);
  const aircraftCodes = [...new Set(rows.map((row) => row.aircraft_code).filter(Boolean))];
  const pns = rows.map((row) => row.pn);

  const [confirmations, equipments, events, manufacturers] = await Promise.all([
    chunkedIn('v_sisha_a3_current_cycle_confirmations', '*', 'interval_id', intervalIds),
    chunkedIn('equipamentos_serializados', 'id,nomenclatura,pn,sn', 'id', equipmentIds),
    chunkedIn('equipamento_eventos', 'id,equipment_id,tipo_evento,data_evento,documento,condicao_resultante,motivo,observacao,payload,invalidado', 'equipment_id', equipmentIds),
    loadManufacturerSuggestions(pns),
  ]);

  let runningSnapshots = [];
  if (aircraftCodes.length) {
    const { data, error: runningError } = await supabase
      .from('aircraft_running_log_snapshots')
      .select('aircraft_code,source_observed_at,aircraft_hours,landings,rotor_stop_starts,engine_1_hours,engine_1_starts,engine_1_power_turbine_cycles,engine_1_gas_generator_cycles,engine_2_hours,engine_2_starts,engine_2_power_turbine_cycles,engine_2_gas_generator_cycles,source_document')
      .in('aircraft_code', aircraftCodes)
      .order('source_observed_at', { ascending: true })
      .limit(5000);
    if (runningError) throw runningError;
    runningSnapshots = data || [];
  }

  const confirmationMap = new Map(confirmations.map((row) => [String(row.interval_id), row]));
  const equipmentMap = new Map(equipments.map((row) => [String(row.id), row]));
  const nextInstallMap = new Map();
  const intervalsByEquipment = new Map();
  for (const row of rows) {
    const key = String(row.equipment_id);
    if (!intervalsByEquipment.has(key)) intervalsByEquipment.set(key, []);
    intervalsByEquipment.get(key).push(row);
  }
  for (const list of intervalsByEquipment.values()) {
    list.sort((a, b) => new Date(a.installed_at || 0).getTime() - new Date(b.installed_at || 0).getTime());
    for (let index = 0; index < list.length; index += 1) {
      const current = list[index];
      const next = list.slice(index + 1).find((candidate) => new Date(candidate.installed_at || 0).getTime() > new Date(current.removed_at || 0).getTime());
      nextInstallMap.set(String(current.id), next?.installed_at || null);
    }
  }
  const eventsByEquipment = new Map();
  for (const event of events.filter((row) => row.invalidado !== true)) {
    const key = String(event.equipment_id);
    if (!eventsByEquipment.has(key)) eventsByEquipment.set(key, []);
    eventsByEquipment.get(key).push(event);
  }

  const scopeCanHideFutureInstall = Boolean(clean(filters.aircraft) || clean(filters.from) || clean(filters.to));
  return rows.map((row) => {
    const equipment = equipmentMap.get(String(row.equipment_id)) || {};
    const cycle = normalizeCycle({ ...row, nomenclatura: equipment.nomenclatura || null }, confirmationMap.get(String(row.id)) || null, runningSnapshots);
    const nextInstalledAt = nextInstallMap.get(String(row.id)) || null;
    const evidenceEvents = nextInstalledAt || !scopeCanHideFutureInstall
      ? (eventsByEquipment.get(String(row.equipment_id)) || [])
      : [];
    return {
      ...cycle,
      evidence_suggestion: buildEvidenceSuggestions(
        cycle,
        evidenceEvents,
        manufacturers.get(upper(row.pn)) || null,
        nextInstalledAt,
      ),
    };
  });
}

async function getReliabilityDashboard(filters = {}) {
  const cycles = await listReliabilityCycles(filters);
  return {
    summary: summarizeA3Cycles(cycles),
    cycles,
    meta: {
      total_cycles: cycles.length,
      filters: {
        pn: clean(filters.pn),
        sn: clean(filters.sn),
        aircraft: clean(filters.aircraft),
        from: clean(filters.from),
        to: clean(filters.to),
      },
      rules: [
        'MTBF/MTBUR em horas exigem utilização oficial de todos os intervalos de contador em horas do recorte.',
        'MTTR usa somente início efetivo do reparo -> reparo concluído.',
        'TAT usa remoção não programada -> equipamento disponível novamente.',
        'NFF não é convertido em falha técnica efetiva no A3.',
        'Repeat removal não usa limiar inventado de dias/horas; registra nova remoção não programada do mesmo PN+SN.',
        'Previsão de ruptura e recomendação comprar/reparar pertencem ao A4.',
      ],
    },
  };
}

async function confirmReliabilityCycle(input = {}, user = {}, requestId = null) {
  const intervalId = Number(input.interval_id);
  if (!Number.isInteger(intervalId) || intervalId <= 0) throw new Error('Selecione um ciclo A2 encerrado.');
  const reason = clean(input.confirmation_reason || input.motivo);
  if (!reason || reason.length < 5) throw new Error('Informe a evidência/motivo da confirmação.');
  const technicalResult = upper(input.technical_result);
  if (technicalResult && !['REPAIRED', 'NFF', 'IRREPARABLE'].includes(technicalResult)) throw new Error('Resultado técnico inválido.');
  const operationId = normalizeUuid(input.operation_id);

  const { data, error } = await supabase.rpc('sisha_a3_confirm_reliability_cycle_atomic', {
    p_interval_id: intervalId,
    p_usage_start_value: numberOrNull(input.usage_start_value),
    p_usage_end_value: numberOrNull(input.usage_end_value),
    p_technical_result: technicalResult,
    p_repair_started_at: optionalIso(input.repair_started_at, 'Início do reparo'),
    p_repair_completed_at: optionalIso(input.repair_completed_at, 'Conclusão do reparo'),
    p_available_at: optionalIso(input.available_at, 'Data de disponibilidade'),
    p_repairer: clean(input.repairer),
    p_manufacturer: clean(input.manufacturer),
    p_source_document: clean(input.source_document),
    p_confirmation_reason: reason,
    p_operation_id: operationId,
    p_actor_email: user.email || null,
    p_actor_role: user.role || null,
    p_request_id: clean(requestId),
  });
  if (error) throw error;
  return { ...(data || {}), operation_id: operationId };
}

module.exports = {
  listReliabilityCycles,
  getReliabilityDashboard,
  confirmReliabilityCycle,
  buildEvidenceSuggestions,
};
