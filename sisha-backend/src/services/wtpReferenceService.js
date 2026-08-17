function normalizeUpper(value) {
  return String(value || '').trim().toUpperCase();
}

function normalizeItem(value) {
  return normalizeUpper(value).replace(/^[-–—]\s*/, '').replace(/\s+/g, '');
}

function splitItemVariant(value) {
  const item = normalizeItem(value);
  const match = item.match(/^(\d+)([A-Z]+)?$/);
  if (!match) return null;
  return {
    raw: item,
    base: match[1],
    suffix: match[2] || '',
  };
}

function sameFigure(a, b) {
  return normalizeUpper(a || '1') === normalizeUpper(b || '1');
}

function sameManual(a, b) {
  return String(a || '') === String(b || '');
}


function containsPnToken(text, pn) {
  const haystack = normalizeUpper(text);
  const needle = normalizeUpper(pn);
  if (!haystack || !needle) return false;
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^A-Z0-9])${escaped}([^A-Z0-9]|$)`, 'i').test(haystack);
}

function isWtpRow(row = {}) {
  const manualCode = normalizeUpper(row.manual_codigo);
  const manualType = normalizeUpper(row.tipo_manual);
  return manualType === 'WTP' || manualCode.startsWith('WTP');
}

/**
 * Converte uma ocorrência textual de um PN/TYPE dentro da nomenclatura de outro
 * PN da WTP em referência informativa. Nunca promove o PN documental a cartão
 * logístico nem a alternativo confirmado.
 *
 * Exemplo: busca 2030H08 encontra a linha PN 203837 /
 * "PUMP, ASSY TYPE 2030H08". O cartão continua sendo 2030H08 e 203837
 * aparece somente como REFERENCIA_TEXTO_WTP, com validação obrigatória do CQ.
 */
function buildWtpTextReferences({ pn, rows = [], confirmedAlternatives = [] } = {}) {
  const currentPn = normalizeUpper(pn);
  if (!currentPn) return [];

  const confirmed = new Set((confirmedAlternatives || []).map((value) => normalizeUpper(value)).filter(Boolean));

  const out = (rows || [])
    .filter((row) => isWtpRow(row))
    .filter((row) => {
      const relatedPn = normalizeUpper(row.pn);
      return relatedPn && relatedPn !== currentPn && !confirmed.has(relatedPn);
    })
    .filter((row) => containsPnToken(row.nomenclatura, currentPn))
    .map((row) => ({
      tipo_relacao: 'WTP_TEXT_REFERENCE',
      classificacao: 'REFERENCIA_TEXTO_WTP',
      equivalencia_confirmada: false,
      requer_cq: true,
      manual_id: row.manual_id,
      manual_codigo: row.manual_codigo || null,
      tipo_manual: row.tipo_manual || 'WTP',
      revisao: row.revisao || null,
      ata_dmc: row.ata_dmc || null,
      fig: row.fig || null,
      pn_consultado: currentPn,
      pn_relacionado: normalizeUpper(row.pn),
      item_consultado: null,
      item_relacionado: normalizeItem(row.item) || null,
      usage_code_consultado: null,
      usage_code_relacionado: row.usage_code || null,
      nomenclatura_consultada: null,
      nomenclatura_relacionada: row.nomenclatura || null,
      page_ref: row.page_ref || null,
      referencia_textual: currentPn,
    }));

  return uniqueRows(out);
}

function uniqueRows(rows = []) {
  const map = new Map();
  rows.forEach((row) => {
    if (!row?.pn_relacionado || !row?.manual_id) return;
    const key = [
      row.tipo_relacao,
      row.manual_id,
      normalizeUpper(row.pn_relacionado),
      normalizeUpper(row.fig || '1'),
      normalizeItem(row.item_consultado),
      normalizeItem(row.item_relacionado),
    ].join('|');
    if (!map.has(key)) map.set(key, row);
  });
  return Array.from(map.values());
}

/**
 * Gera relações WTP de apoio ao CQ sem promover automaticamente nenhum PN
 * para a lista de alternativos confirmados.
 *
 * Regras:
 * 1) Mesmo manual + mesma FIG + mesmo ITEM-base (ex.: 380/380A/380B)
 *    => POSSIVEL_EQUIVALENCIA_WTP, sempre pendente de CQ.
 * 2) Para PN principal do manual, outro PN principal da mesma WTP
 *    => REFERENCIA_MESMA_WTP, pendente de CQ.
 * 3) Relações já confirmadas pelas regras oficiais de alternativos são omitidas
 *    desta lista de alerta para não duplicar informação.
 */
function buildWtpReferences({ pn, applications = [], manualRows = [], confirmedAlternatives = [] } = {}) {
  const currentPn = normalizeUpper(pn);
  if (!currentPn) return [];

  const confirmed = new Set((confirmedAlternatives || []).map((value) => normalizeUpper(value)).filter(Boolean));
  const currentApps = (applications || []).filter((row) => normalizeUpper(row.pn || currentPn) === currentPn);
  const currentManualIds = new Set(currentApps.map((row) => String(row.manual_id || '')).filter(Boolean));
  if (!currentManualIds.size) return [];

  const contextRows = (manualRows || []).filter((row) => currentManualIds.has(String(row.manual_id || '')));
  const out = [];

  currentApps.forEach((current) => {
    const currentItem = splitItemVariant(current.item);
    if (!currentItem) return;

    contextRows.forEach((candidate) => {
      const relatedPn = normalizeUpper(candidate.pn);
      if (!relatedPn || relatedPn === currentPn || confirmed.has(relatedPn)) return;
      if (!sameManual(current.manual_id, candidate.manual_id) || !sameFigure(current.fig, candidate.fig)) return;

      const candidateItem = splitItemVariant(candidate.item);
      if (!candidateItem || candidateItem.base !== currentItem.base || candidateItem.raw === currentItem.raw) return;

      out.push({
        tipo_relacao: 'WTP_ITEM_VARIANT',
        classificacao: 'POSSIVEL_EQUIVALENCIA_WTP',
        equivalencia_confirmada: false,
        requer_cq: true,
        manual_id: current.manual_id,
        manual_codigo: current.manual_codigo || candidate.manual_codigo || null,
        tipo_manual: current.tipo_manual || candidate.tipo_manual || 'WTP',
        revisao: current.revisao || candidate.revisao || null,
        ata_dmc: current.ata_dmc || candidate.ata_dmc || null,
        fig: current.fig || candidate.fig || '1',
        pn_consultado: currentPn,
        pn_relacionado: relatedPn,
        item_consultado: currentItem.raw,
        item_relacionado: candidateItem.raw,
        usage_code_consultado: current.usage_code || null,
        usage_code_relacionado: candidate.usage_code || null,
        nomenclatura_consultada: current.nomenclatura || null,
        nomenclatura_relacionada: candidate.nomenclatura || null,
        page_ref: candidate.page_ref || current.page_ref || null,
      });
    });
  });

  // Referência TYPE / PN principal da mesma publicação. É deliberadamente
  // restrita a PNs principais para não relacionar cada peça interna da IPL
  // com todos os PNs de capa do manual.
  const currentIsPrincipal = currentApps.some((row) => normalizeUpper(row.tipo_vinculo) === 'PN_PRINCIPAL');
  if (currentIsPrincipal) {
    contextRows
      .filter((row) => normalizeUpper(row.tipo_vinculo) === 'PN_PRINCIPAL')
      .forEach((candidate) => {
        const relatedPn = normalizeUpper(candidate.pn);
        if (!relatedPn || relatedPn === currentPn || confirmed.has(relatedPn)) return;
        const alreadyVariant = out.some((row) => normalizeUpper(row.pn_relacionado) === relatedPn && String(row.manual_id) === String(candidate.manual_id));
        if (alreadyVariant) return;

        out.push({
          tipo_relacao: 'WTP_SAME_MANUAL_REFERENCE',
          classificacao: 'REFERENCIA_MESMA_WTP',
          equivalencia_confirmada: false,
          requer_cq: true,
          manual_id: candidate.manual_id,
          manual_codigo: candidate.manual_codigo || null,
          tipo_manual: candidate.tipo_manual || 'WTP',
          revisao: candidate.revisao || null,
          ata_dmc: candidate.ata_dmc || null,
          fig: null,
          pn_consultado: currentPn,
          pn_relacionado: relatedPn,
          item_consultado: null,
          item_relacionado: null,
          usage_code_consultado: null,
          usage_code_relacionado: null,
          nomenclatura_consultada: currentApps.find((row) => row.nomenclatura)?.nomenclatura || null,
          nomenclatura_relacionada: candidate.nomenclatura || null,
          page_ref: candidate.page_ref || null,
        });
      });
  }

  return uniqueRows(out).sort((a, b) => {
    const typeDiff = String(a.tipo_relacao).localeCompare(String(b.tipo_relacao));
    if (typeDiff !== 0) return typeDiff;
    const itemDiff = normalizeItem(a.item_relacionado).localeCompare(normalizeItem(b.item_relacionado), undefined, { numeric: true });
    if (itemDiff !== 0) return itemDiff;
    return normalizeUpper(a.pn_relacionado).localeCompare(normalizeUpper(b.pn_relacionado));
  });
}

module.exports = {
  normalizeItem,
  splitItemVariant,
  buildWtpReferences,
  buildWtpTextReferences,
};
