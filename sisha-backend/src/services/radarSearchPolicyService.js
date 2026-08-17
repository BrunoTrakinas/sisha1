function normalizeRadarSearchTerm(value = '') {
  return String(value || '').trim().toUpperCase();
}

function sanitizeRadarFilterTerm(value = '') {
  return normalizeRadarSearchTerm(value)
    .replace(/[(),]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function isIdentifierLikeRadarTerm(value = '') {
  const term = normalizeRadarSearchTerm(value);
  if (!term || /\s/.test(term)) return false;
  if (!/[0-9]/.test(term)) return false;
  return /^[A-Z0-9._/+\-]+$/.test(term);
}

/**
 * Política do Radar Logístico:
 * - identificadores (PN, PI/NSN, SN, nº de documento) usam prefixo: TERMO%
 * - campos textuais (nomenclatura, descrição, título etc.) usam contém: %TERMO%
 * - quando o termo tem formato claro de identificador, a busca textual ampla é
 *   desligada para impedir falsos positivos como 123456010 ao pesquisar 010.
 */
function buildRadarOrFilter(value, { prefixFields = [], textFields = [] } = {}) {
  const term = sanitizeRadarFilterTerm(value);
  if (!term) return '';

  const clauses = [];
  prefixFields.forEach((field) => {
    if (field) clauses.push(`${field}.ilike.${term}%`);
  });

  if (!isIdentifierLikeRadarTerm(term)) {
    textFields.forEach((field) => {
      if (field) clauses.push(`${field}.ilike.%${term}%`);
    });
  }

  return clauses.join(',');
}

module.exports = {
  normalizeRadarSearchTerm,
  sanitizeRadarFilterTerm,
  isIdentifierLikeRadarTerm,
  buildRadarOrFilter,
};
