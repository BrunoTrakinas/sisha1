const ACTIVE_AIRCRAFT_CODES = ['4001', '4003', '4004', '4005', '4010', '4012'];
const HISTORICAL_AIRCRAFT_CODES = ['4006', '4009'];
const KNOWN_AIRCRAFT_CODES = [...ACTIVE_AIRCRAFT_CODES, ...HISTORICAL_AIRCRAFT_CODES];

const STANDARD_WORKSHOP_MAP = {
  HV: 'OFICINA DE HIDRÁULICA',
  MV: 'OFICINA DE MOTORES',
  SV: 'OFICINA DE ESTRUTURA',
  VN: 'OFICINA DE AVIÔNICA',
  PA: 'OFICINA DE PÁ',
};

const MT_WORKSHOP_MAP = {
  MTVN: 'MANUTENÇÃO • OFICINA DE AVIÔNICA',
  MTMV: 'MANUTENÇÃO • OFICINA DE MOTORES',
  MTHV: 'MANUTENÇÃO • OFICINA DE HIDRÁULICA',
  MTAP: 'MANUTENÇÃO • PAIOL DE APOIO',
  MTSV: 'MANUTENÇÃO • OFICINA DE ESTRUTURA',
  MTPA: 'MANUTENÇÃO • OFICINA DE PÁ',
  MTVA: 'MANUTENÇÃO • OFICINA DE ARMAMENTO',
  MT: 'MANUTENÇÃO • DEMANDA GERAL (LEGADO)',
};

const WORKSHOP_MAP = {
  ...STANDARD_WORKSHOP_MAP,
  ...MT_WORKSHOP_MAP,
};

const MT_PREFIXES = Object.keys(MT_WORKSHOP_MAP).sort((a, b) => b.length - a.length);
const STANDARD_WORKSHOP_PREFIXES = Object.keys(STANDARD_WORKSHOP_MAP).sort((a, b) => b.length - a.length);

function normalizeOs(value = '') {
  return String(value || '').trim().toUpperCase().replace(/\s+/g, '');
}

function isMtCode(code = '') {
  return Object.prototype.hasOwnProperty.call(MT_WORKSHOP_MAP, String(code || '').trim().toUpperCase());
}

function parseOsDomain(value = '') {
  const raw = normalizeOs(value);
  if (!raw) {
    return {
      raw: null,
      tipo: 'OUTROS',
      codigo: null,
      descricao: 'SEM OS',
      familia: null,
      demanda_material_mt: false,
      historica: false,
    };
  }

  const aircraft = KNOWN_AIRCRAFT_CODES.find((code) => raw.startsWith(code));
  if (aircraft) {
    return {
      raw,
      tipo: 'ANV',
      codigo: aircraft,
      descricao: `AERONAVE ${aircraft}`,
      familia: 'ANV',
      demanda_material_mt: false,
      historica: HISTORICAL_AIRCRAFT_CODES.includes(aircraft),
    };
  }

  // Prefixos MT precisam ser avaliados antes de MT genérica e antes das oficinas
  // convencionais para que MTVN/MTMV/... não sejam reduzidas indevidamente a MT.
  const mt = MT_PREFIXES.find((prefix) => raw.startsWith(prefix));
  if (mt) {
    return {
      raw,
      tipo: 'OFICINA',
      codigo: mt,
      descricao: MT_WORKSHOP_MAP[mt],
      familia: 'MT',
      demanda_material_mt: true,
      historica: false,
    };
  }

  const workshop = STANDARD_WORKSHOP_PREFIXES.find((prefix) => raw.startsWith(prefix));
  if (workshop) {
    return {
      raw,
      tipo: 'OFICINA',
      codigo: workshop,
      descricao: STANDARD_WORKSHOP_MAP[workshop],
      familia: 'OFICINA',
      demanda_material_mt: false,
      historica: false,
    };
  }

  return {
    raw,
    tipo: 'OUTROS',
    codigo: null,
    descricao: raw,
    familia: null,
    demanda_material_mt: false,
    historica: false,
  };
}

module.exports = {
  ACTIVE_AIRCRAFT_CODES,
  HISTORICAL_AIRCRAFT_CODES,
  KNOWN_AIRCRAFT_CODES,
  STANDARD_WORKSHOP_MAP,
  MT_WORKSHOP_MAP,
  WORKSHOP_MAP,
  MT_PREFIXES,
  normalizeOs,
  isMtCode,
  parseOsDomain,
};
