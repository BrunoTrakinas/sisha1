const DESTINATIONS = new Set(['PPU', 'CEIMSPA', 'FORA_LINHA']);
const SITUATIONS = new Set([
  'DISPONIVEL',
  'A_CONFIRMAR',
  'AGUARDANDO_REPARO',
  'EM_REPARO',
  'EM_WO',
  'CONDENADO_LIXO',
  'ARMAZENADO_EXTERNAMENTE',
  'QUARENTENA',
  'OUTRO',
]);

function normalizeLocation(value) {
  const normalized = String(value || '').trim().toUpperCase().replace(/\s+/g, ' ');
  return normalized || 'NÃO DEFINIDO';
}

function normalizeDestination(value, contabilizaPpu = true) {
  if (contabilizaPpu !== false) return 'PPU';
  const candidate = String(value || '').trim().toUpperCase();
  return DESTINATIONS.has(candidate) && candidate !== 'PPU' ? candidate : 'FORA_LINHA';
}

function normalizeSituation(value, contabilizaPpu = true) {
  if (contabilizaPpu !== false) return 'DISPONIVEL';
  const candidate = String(value || '').trim().toUpperCase();
  return SITUATIONS.has(candidate) && candidate !== 'DISPONIVEL' ? candidate : 'A_CONFIRMAR';
}

function enrichRows(rows = [], policyMap = new Map()) {
  return (rows || []).map((row) => {
    const key = normalizeLocation(row.localizacao);
    const configured = policyMap.get(key);
    const contabilizaPpu = configured ? configured.contabiliza_ppu !== false : true;
    return {
      ...row,
      localizacao_normalizada: key,
      contabiliza_ppu: contabilizaPpu,
      destino_contabilizacao: normalizeDestination(configured?.destino_contabilizacao, contabilizaPpu),
      situacao_operacional: normalizeSituation(configured?.situacao_operacional, contabilizaPpu),
      observacao_classificacao: configured?.observacao || null,
    };
  });
}

module.exports = {
  DESTINATIONS,
  SITUATIONS,
  normalizeLocation,
  normalizeDestination,
  normalizeSituation,
  enrichRows,
};
