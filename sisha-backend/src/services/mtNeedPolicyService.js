function normalizeUpper(value) {
  return String(value ?? '').trim().toUpperCase();
}

function safeString(value) {
  const text = String(value ?? '').trim();
  return text || null;
}

function toNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

const { buildEffectiveOperationalState } = require('./aircraftOperationalStateService');

/**
 * Mapa de evidência operacional corrente da aeronave.
 * A1.1A: quando houver confirmação administrativa, ela prevalece sobre D/I bruto.
 * Sem confirmação, I bruto mantém compatibilidade A1.1; D/UNKNOWN continuam fail-closed.
 */
function buildAircraftAvailabilityMap(rows = []) {
  const map = new Map();
  (rows || []).forEach((row) => {
    const effective = buildEffectiveOperationalState(row);
    const aircraft = normalizeUpper(effective.aircraft_code);
    if (!/^\d{4}$/.test(aircraft)) return;
    map.set(aircraft, effective);
  });
  return map;
}

/**
 * Regra canônica SISHA A1.1:
 * - necessidade de ANV não é deduplicada por PN;
 * - MT pode ser demanda adicional quando a mesma seleção possui necessidade
 *   desse PN para ANV e ao menos uma ANV relacionada está I;
 * - sem evidência atual I, a MT sobreposta fica como alerta, sem inflar a
 *   quantidade; MT sem sobreposição com ANV continua como demanda própria.
 */
function buildMtAvailabilityDecision(item, selectedPimRows = [], availabilityMap = new Map()) {
  if (!item?.isMt || !item?.pn) {
    return { blocked: false, additive: false, reason: 'NOT_MT', relatedAircraft: [], unavailableAircraft: [] };
  }

  const relatedAircraft = (selectedPimRows || [])
    .filter((candidate) => candidate?.isAircraft && candidate?.pn === item.pn)
    .map((candidate) => normalizeUpper(candidate?.origem?.origem_codigo))
    .filter((aircraft) => /^\d{4}$/.test(aircraft));

  const uniqueAircraft = [...new Set(relatedAircraft)];
  if (!uniqueAircraft.length) {
    return { blocked: false, additive: false, reason: 'NO_AIRCRAFT_OVERLAP', relatedAircraft: [], unavailableAircraft: [] };
  }

  // Compatibilidade A1.1: sem confirmação administrativa, o mapa efetivo deriva mt_additive_eligible quando status === 'I'.
  const unavailableAircraft = uniqueAircraft.filter((aircraft) => availabilityMap.get(aircraft)?.mt_additive_eligible === true);
  if (unavailableAircraft.length) {
    return {
      blocked: false,
      additive: true,
      reason: 'RELATED_AIRCRAFT_UNAVAILABLE',
      relatedAircraft: uniqueAircraft,
      unavailableAircraft,
    };
  }

  return {
    blocked: true,
    additive: false,
    reason: 'UNAVAILABLE_EVIDENCE_REQUIRED',
    relatedAircraft: uniqueAircraft,
    unavailableAircraft: [],
  };
}

module.exports = {
  buildAircraftAvailabilityMap,
  buildMtAvailabilityDecision,
};
