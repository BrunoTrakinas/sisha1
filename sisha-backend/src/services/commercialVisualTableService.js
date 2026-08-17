function clean(value) {
  return value == null ? '' : String(value).replace(/\r/g, '').trim();
}

function normalizePn(value) {
  return clean(value).toUpperCase().replace(/[.,;:]+$/g, '');
}

function parseMoney(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  let text = clean(value).replace(/£/g, '').replace(/\s/g, '');
  if (!text || /^(?:N\/A|NA|NULL|NONE|-|TBA)$/i.test(text)) return 0;
  if (text.includes(',') && text.includes('.')) {
    text = text.lastIndexOf(',') > text.lastIndexOf('.')
      ? text.replace(/\./g, '').replace(',', '.')
      : text.replace(/,/g, '');
  } else if (text.includes(',')) {
    const parts = text.split(',');
    text = parts.length === 2 && parts[1].length <= 2 ? text.replace(',', '.') : text.replace(/,/g, '');
  }
  const number = Number(text.replace(/[^0-9.-]/g, ''));
  return Number.isFinite(number) ? number : 0;
}

function formatMoneyForTranscript(value) {
  const n = Number(value) || 0;
  if (!n) return '';
  return n.toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2, useGrouping: true });
}

function normalizeVisualRepairOverhaulPayload(payload = {}, fileName = '') {
  const type = clean(payload.documento_tipo || payload.document_type || payload?.document?.documento_tipo).toUpperCase();
  const recognized = type === 'LEONARDO_REPAIR_PRICE_LETTER';
  if (!recognized) return { recognized: false, valid: false, blocking: [], warnings: [], rows: [], transcript: '' };

  const doc = payload.document || payload.metadados || {};
  const table = payload.table || {};
  const sourceRows = Array.isArray(table.rows) ? table.rows : Array.isArray(payload.rows) ? payload.rows : [];
  const blocking = [];
  const warnings = [];
  const rows = [];
  const pnMap = new Map();

  const forbiddenDescription = /\b(?:TERMS?\s+AND\s+CONDITIONS?|PAYMENT|WARRANTY|LIABILITY|EXPORT\s+CONTROL|ANTI[-\s]?BRIBERY|LAW\s+AND\s+JURISDICTION|FORCE\s+MAJEURE|CLAUSE|CONTRACT\s+PRICE)\b/i;
  const pnPattern = /^[A-Z0-9][A-Z0-9./*+\-]{1,58}$/;

  sourceRows.forEach((source, index) => {
    const description = clean(source.description || source.component_description || source.nomenclatura);
    const pn = normalizePn(source.pn || source.part_number || source.partNumber);
    const repair = parseMoney(source.repair_gbp ?? source.fixed_price_repair_gbp ?? source.repair_price ?? source.repair);
    const overhaul = parseMoney(source.overhaul_gbp ?? source.fixed_price_overhaul_gbp ?? source.overhaul_price ?? source.overhaul);
    const page = Number(source.source_page || source.page || table.page || 0) || null;

    if (!description && !pn && !repair && !overhaul) return;
    if (forbiddenDescription.test(description)) {
      warnings.push(`Linha visual ${index + 1} descartada por pertencer a Termos e Condições, não à tabela de preços.`);
      return;
    }
    if (!pn || !pnPattern.test(pn)) {
      warnings.push(`Linha visual ${index + 1} descartada: PN ausente ou fora do formato documental permitido.`);
      return;
    }
    if (!description || description.length < 2) {
      warnings.push(`PN ${pn}: descrição ausente/ilegível na leitura visual.`);
    }
    if (!repair && !overhaul) {
      warnings.push(`PN ${pn}: linha sem preço de Repair nem Overhaul; não foi criada referência comercial.`);
      return;
    }

    const row = { description, pn, repair, overhaul, source_page: page };
    const previous = pnMap.get(pn);
    if (previous && (previous.repair !== row.repair || previous.overhaul !== row.overhaul || previous.description !== row.description)) {
      blocking.push(`PN ${pn} apareceu mais de uma vez com conteúdo/preço divergente na mesma tabela visual.`);
      return;
    }
    if (previous) return;
    pnMap.set(pn, row);
    rows.push(row);
  });

  if (!rows.length) blocking.push('Carta Repair/Overhaul reconhecida, porém nenhuma linha comercial válida foi extraída da tabela visual.');
  if (payload.table_complete === false || table.complete === false) blocking.push('Leitor visual informou que a tabela não foi extraída por completo.');
  const unreadable = Array.isArray(payload.unreadable_rows) ? payload.unreadable_rows : Array.isArray(table.unreadable_rows) ? table.unreadable_rows : [];
  if (unreadable.length) blocking.push(`Existem ${unreadable.length} linha(s) da tabela marcadas como ilegíveis/revisar pelo leitor visual.`);

  const reference = clean(doc.reference || doc.letter_reference || doc.document_reference);
  const contract = clean(doc.contract_reference || doc.contract);
  const date = clean(doc.date || doc.letter_date || doc.quotation_date);
  const validity = clean(doc.validity || doc.valid_until || table.validity);
  const subject = clean(doc.subject || payload.subject);

  const lines = [
    'Leonardo UK Ltd',
    'Document Type: LEONARDO_REPAIR_PRICE_LETTER',
  ];
  if (reference) lines.push(`LUKL Ref.: ${reference}`);
  if (date) lines.push(`Date: ${date}`);
  if (contract) lines.push(`Contract No. ${contract}`);
  if (subject) lines.push(`Subject: ${subject}`);
  if (validity) lines.push(`Attachment 1 - Fixed Price Repair / Overhaul Listing - validity, ${validity}.`);
  else lines.push('Attachment 1 - Fixed Price Repair / Overhaul Listing.');
  lines.push('Component Description | Part Number | Fixed Price Repair (GBP) | Fixed Price Overhaul (GBP)');
  rows.forEach((row) => {
    lines.push(`${row.description || '[REVISAR]'} | ${row.pn} | ${formatMoneyForTranscript(row.repair)} | ${formatMoneyForTranscript(row.overhaul)}`);
  });

  return {
    recognized: true,
    valid: blocking.length === 0,
    blocking,
    warnings,
    rows,
    transcript: lines.join('\n'),
    metadata: {
      reference,
      contract_reference: contract,
      date,
      validity,
      subject,
      source_file: fileName || '',
      source_table_page: Number(table.page || 0) || null,
    },
  };
}


function normalizeFocusedRepairOverhaulTranscript(text = '', fileName = '') {
  const raw = String(text || '').replace(/\r/g, '');
  const upper = raw.toUpperCase();
  const typeMatch = raw.match(/DOCUMENT_TYPE\s*:\s*([A-Z0-9_]+)/i);
  const recognized = (typeMatch && String(typeMatch[1]).toUpperCase() === 'LEONARDO_REPAIR_PRICE_LETTER')
    || (/FUTURE\s+SUPPORT\s+AND\s+FIXED\s+PRICE\s+REPAIRS/i.test(raw)
      && /FIXED\s+PRICE\s+REPAIR/i.test(raw)
      && /FIXED\s+PRICE\s+OVERHAUL/i.test(raw));

  if (!recognized) return { recognized: false, valid: false, blocking: [], warnings: [], rows: [], transcript: '' };

  const completeMatch = raw.match(/TABLE_COMPLETE\s*:\s*(YES|NO|TRUE|FALSE)/i);
  const tableComplete = completeMatch ? /^(YES|TRUE)$/i.test(completeMatch[1]) : false;
  const reference = clean(raw.match(/(?:LETTER_)?REFERENCE\s*:\s*([^\n]+)/i)?.[1]);
  const date = clean(raw.match(/(?:LETTER_)?DATE\s*:\s*([^\n]+)/i)?.[1]);
  const contract = clean(raw.match(/CONTRACT(?:_REFERENCE)?\s*:\s*([^\n]+)/i)?.[1]);
  const subject = clean(raw.match(/SUBJECT\s*:\s*([^\n]+)/i)?.[1]);
  const validity = clean(raw.match(/VALIDITY\s*:\s*([^\n]+)/i)?.[1]);
  const unreadableLine = clean(raw.match(/UNREADABLE_ROWS\s*:\s*([^\n]+)/i)?.[1]);
  const unreadable = unreadableLine && !/^(?:NONE|NULL|N\/A|0)$/i.test(unreadableLine)
    ? unreadableLine.split(/\s*;\s*/).filter(Boolean)
    : [];

  const start = upper.indexOf('TABLE_START');
  const end = upper.indexOf('TABLE_END');
  const tableBody = start >= 0 && end > start ? raw.slice(start + 'TABLE_START'.length, end) : '';
  const rows = [];
  const warnings = [];
  const pnSeen = new Map();

  tableBody.split('\n').map(clean).filter(Boolean).forEach((line, index) => {
    if (/^(?:DESCRIPTION|COMPONENT\s+DESCRIPTION)\s*\|/i.test(line)) return;
    const cols = line.replace(/^\|/, '').replace(/\|$/, '').split('|').map(clean);
    if (cols.length < 4) {
      warnings.push(`Linha focada ${index + 1} descartada: colunas insuficientes.`);
      return;
    }
    const [description, pnRaw, repairRaw, overhaulRaw, pageRaw] = cols;
    const pn = normalizePn(pnRaw);
    const page = Number(String(pageRaw || '').replace(/[^0-9]/g, '')) || null;
    if (page && page > 4) {
      warnings.push(`Linha focada ${index + 1} descartada: página ${page} pertence aos Termos e Condições.`);
      return;
    }
    if (!pn || /^\d+(?:\.\d+)+$/.test(pn)) {
      warnings.push(`Linha focada ${index + 1} descartada: PN inválido/compatível com número de cláusula.`);
      return;
    }
    const repair = parseMoney(repairRaw);
    const overhaul = parseMoney(overhaulRaw);
    if (!repair && !overhaul) {
      warnings.push(`PN ${pn}: linha sem preço Repair/Overhaul.`);
      return;
    }
    const row = { description, pn, repair, overhaul, source_page: page || 3 };
    const previous = pnSeen.get(pn);
    if (previous && (previous.repair !== row.repair || previous.overhaul !== row.overhaul || previous.description !== row.description)) {
      unreadable.push(`PN ${pn} repetido com conteúdo divergente`);
      return;
    }
    if (previous) return;
    pnSeen.set(pn, row);
    rows.push(row);
  });

  const payload = {
    documento_tipo: 'LEONARDO_REPAIR_PRICE_LETTER',
    document: {
      reference,
      date,
      contract_reference: contract,
      subject,
      validity,
    },
    table: {
      page: 3,
      complete: tableComplete,
      rows: rows.map((row) => ({
        description: row.description,
        pn: row.pn,
        repair_gbp: row.repair || null,
        overhaul_gbp: row.overhaul || null,
        source_page: row.source_page,
      })),
    },
    table_complete: tableComplete,
    unreadable_rows: unreadable,
  };
  const normalized = normalizeVisualRepairOverhaulPayload(payload, fileName);
  normalized.warnings = [...(normalized.warnings || []), ...warnings];
  if (!completeMatch) normalized.blocking = [...(normalized.blocking || []), 'Transcrição focada não informou TABLE_COMPLETE; fluxo bloqueado por segurança.'];
  normalized.valid = normalized.blocking.length === 0;
  return normalized;
}

module.exports = {
  parseMoney,
  normalizeVisualRepairOverhaulPayload,
  normalizeFocusedRepairOverhaulTranscript,
};
