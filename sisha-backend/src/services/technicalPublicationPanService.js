const MONTHS = {
  JANUARY: 1, FEBRUARY: 2, MARCH: 3, APRIL: 4, MAY: 5, JUNE: 6,
  JULY: 7, AUGUST: 8, SEPTEMBER: 9, OCTOBER: 10, NOVEMBER: 11, DECEMBER: 12,
};

function cleanLine(value = '') {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function normalizePanReference(value = '') {
  const match = String(value || '').match(/\bLX\s*\/\s*PAN\s*\/\s*(\d+)\b/i);
  return match ? `LX/PAN/${match[1]}` : null;
}

function isPanPublication(text = '', originalName = '') {
  const haystack = `${text}\n${originalName}`.toUpperCase();
  return /PRODUCT\s+ADVISORY\s+NOTICE/.test(haystack) || /\bLX\s*\/\s*PAN\s*\/\s*\d+\b/.test(haystack);
}

function parseEnglishPublicationDate(text = '') {
  const match = String(text).match(/\b(?:Date\s*:\s*)?(\d{1,2})(?:ST|ND|RD|TH|[“”'’\"])?\s+([A-Z]+)\s+(20\d{2})\b/i);
  if (!match) return null;
  const month = MONTHS[String(match[2]).toUpperCase()];
  if (!month) return null;
  const day = Number(match[1]);
  const year = Number(match[3]);
  if (day < 1 || day > 31) return null;
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function extractBetween(text = '', startPattern, endPattern) {
  const source = String(text || '').replace(/\r/g, '');
  const start = source.search(startPattern);
  if (start < 0) return '';
  const sliced = source.slice(start).replace(startPattern, '');
  const end = sliced.search(endPattern);
  return (end >= 0 ? sliced.slice(0, end) : sliced).trim();
}

function extractTitle(text = '') {
  const lines = String(text || '').replace(/\r/g, '').split('\n').map(cleanLine).filter(Boolean);
  const refIndex = lines.findIndex((line) => /LX\s*\/\s*PAN\s*\/\s*\d+/i.test(line));
  const candidates = refIndex >= 0 ? lines.slice(refIndex + 1, refIndex + 7) : lines.slice(0, 20);
  const title = candidates.find((line) => (
    line.length >= 8
    && !/^(?:Pt\.?\s*No\.?|PRODUCT ADVISORY NOTICE|ADVISORY NOTICE|Issue|Date|Page\b)/i.test(line)
    && !/LEONARDO|HELICOPTERS|AGUSTAWESTLAND/i.test(line)
  ));
  return title || 'Product Advisory Notice';
}

function normalizeOcrPn(value = '') {
  return cleanLine(value)
    .toUpperCase()
    .replace(/^£(?=\d)/, 'E')
    .replace(/[^A-Z0-9-]/g, '');
}

function parsePanMaterialRows(text = '') {
  const materialSection = extractBetween(
    text,
    /(?:as\s+individual\s+components\s*:|individual\s+components\s*:)/i,
    /(?:\*\s*\(SAFRAN|©\s*Copyright|Page\s+\d+\s+of\s+\d+)/i,
  );
  const source = materialSection || (/ITEM\s*\|\s*PART\s+NUMBER/i.test(String(text || '')) ? String(text || '') : '');
  if (!source) return [];

  const lines = source.split('\n').map(cleanLine).filter(Boolean);
  const rows = [];
  let current = null;
  const flush = () => {
    if (!current) return;
    current.nomenclatura = cleanLine(current.descriptionParts.join(' ')) || null;
    delete current.descriptionParts;
    rows.push(current);
    current = null;
  };

  for (const line of lines) {
    const match = line.match(/^(\d{1,4})\s+([A-Z£0-9][A-Z£0-9-]{3,})\s+(.+?)\s+(\d+(?:[.,]\d+)?)$/i)
      || line.match(/^(\d{1,4})\s*\|\s*([A-Z£0-9][A-Z£0-9-]{3,})\s*\|\s*(.+?)\s*\|\s*(\d+(?:[.,]\d+)?)$/i);
    if (match) {
      flush();
      const qtd = Number(String(match[4]).replace(',', '.'));
      current = {
        itemNo: String(match[1]),
        pn: normalizeOcrPn(match[2]),
        qtd: Number.isFinite(qtd) ? qtd : 0,
        descriptionParts: [match[3]],
      };
      continue;
    }
    if (current && !/^\(?[A-Z0-9-]{4,}\)?$/i.test(line)) current.descriptionParts.push(line);
  }
  flush();

  return rows.filter((row) => row.pn && row.qtd > 0);
}

function parsePanPublicationText(text = '', originalName = '') {
  const raw = String(text || '').replace(/\r/g, '');
  if (!isPanPublication(raw, originalName)) return null;

  const reference = normalizePanReference(raw) || normalizePanReference(originalName) || `PAN-${String(originalName).replace(/\.[^.]+$/, '').toUpperCase()}`;
  const issue = raw.match(/\bIssue\s*:\s*(\d+)\b/i)?.[1] || null;
  const dataPublicacao = parseEnglishPublicationDate(raw);
  const titulo = extractTitle(raw);
  const affectedMatch = raw.match(/Pt\.?\s*No\.?\s*([A-Z0-9-]+)\s*\/\s*([A-Z0-9-]+)/i);
  const affectedPns = affectedMatch ? [affectedMatch[1].toUpperCase(), affectedMatch[2].toUpperCase()] : [];
  const periodicity = raw.match(/(?:interim[^.\n]{0,80})?(\d{2,5})\s*(?:hr|hrs|flight\s+hours)/i)?.[1] || null;
  const tbo = raw.match(/TBO\s+of\s+(\d{2,5})\s*(?:flight\s+hours|hrs?)/i)?.[1] || null;
  const manual = raw.match(/\b(WTP[A-Z0-9-]+)\b/i)?.[1]?.toUpperCase() || null;
  const applicability = cleanLine(extractBetween(raw, /APPLICAB(?:ILITY|LITY)/i, /CUSTOMER\s+ACTION/i));
  const customerAction = cleanLine(extractBetween(raw, /CUSTOMER\s+ACTION/i, /ADDITIONAL\s+INFORMATION/i));
  const tipoSb = /\b(?:OPTION|OPTIONAL)\b/i.test(customerAction) ? 'OPCIONAL' : (/MANDATORY|MANDAT/i.test(customerAction) ? 'MANDATORIA' : 'N/A');
  const materialRows = parsePanMaterialRows(raw);

  const materialItems = materialRows.map((item) => ({
    sb_numero: reference,
    pn: item.pn,
    nsn: null,
    nomenclatura: item.nomenclatura,
    qtd: item.qtd,
    capitulo: manual,
    item_num: `CMM ${item.itemNo}`,
    aplicabilidade: applicability || null,
  }));
  const affectedItems = affectedPns.map((pn) => ({
    sb_numero: reference,
    pn,
    nsn: null,
    nomenclatura: `${titulo} — equipamento afetado pela publicação`,
    qtd: 0,
    capitulo: manual,
    item_num: 'APLICABILIDADE',
    aplicabilidade: applicability || null,
  }));
  const itensSb = [...affectedItems, ...materialItems];

  const parts = [
    'Documento: Product Advisory Notice (PAN).',
    issue ? `Issue ${issue}.` : null,
    affectedPns.length ? `Equipamento afetado: PN ${affectedPns.join(' / ')}.` : null,
    periodicity ? `Manutenção intermediária: ${periodicity} FH.` : null,
    tbo ? `TBO do fornecedor mantido: ${tbo} FH.` : null,
    customerAction ? `Customer Action: ${customerAction}.` : null,
    manual ? `Manual associado: ${manual}.` : null,
    applicability ? `Aplicabilidade: ${applicability}.` : null,
    materialItems.length ? `${materialItems.length} item(ns) de material estruturado(s) para provisão/substituição.` : 'Tabela de materiais não estruturada automaticamente.',
  ].filter(Boolean);

  return {
    documentType: 'PAN',
    sbNumero: reference,
    titulo,
    tipoSb,
    dataPublicacao,
    observacao: parts.join(' '),
    itensSb,
    metadata: {
      issue,
      affectedPns,
      periodicityHours: periodicity ? Number(periodicity) : null,
      tboHours: tbo ? Number(tbo) : null,
      manual,
      applicability: applicability || null,
      customerAction: customerAction || null,
      materialItemCount: materialItems.length,
    },
  };
}

module.exports = {
  isPanPublication,
  normalizePanReference,
  parseEnglishPublicationDate,
  parsePanMaterialRows,
  parsePanPublicationText,
};
