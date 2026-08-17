function clean(value) {
  return value == null ? '' : String(value).replace(/\r/g, '').trim();
}

function normalizePn(value) {
  return clean(value).toUpperCase().replace(/[.,;:]+$/g, '');
}

function parseMoney(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  let text = clean(value).replace(/£/g, '').replace(/\s/g, '');
  if (!text || /^TBA$/i.test(text)) return 0;
  if (text.includes(',') && text.includes('.')) {
    text = text.lastIndexOf(',') > text.lastIndexOf('.')
      ? text.replace(/\./g, '').replace(',', '.')
      : text.replace(/,/g, '');
  } else if (text.includes(',')) {
    const parts = text.split(',');
    text = parts.length === 2 && parts[1].length <= 2 ? text.replace(',', '.') : text.replace(/,/g, '');
  }
  const num = Number(text.replace(/[^0-9.-]/g, ''));
  return Number.isFinite(num) ? num : 0;
}

function round2(value) {
  return Math.round((Number(value) + Number.EPSILON) * 100) / 100;
}

function dateBr(day, month, year) {
  const d = String(day).padStart(2, '0');
  const m = String(month).padStart(2, '0');
  const y = String(year);
  return `${d}/${m}/${y}`;
}

const EN_MONTHS = {
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6,
  july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
};

function normalizeDateToken(value) {
  const text = clean(value);
  if (!text) return '';
  const numeric = text.match(/\b(\d{1,2})[.\/-](\d{1,2})[.\/-](\d{4})\b/);
  if (numeric) return dateBr(numeric[1], numeric[2], numeric[3]);
  const english = text.match(/\b(\d{1,2})(?:st|nd|rd|th)?\s+(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{4})\b/i);
  if (english) return dateBr(english[1], EN_MONTHS[english[2].toLowerCase()], english[3]);
  return text;
}

function normalizeMaterialReference(value) {
  const original = clean(value).toUpperCase();
  if (!original) return { original: '', nsn: '', status: 'AUSENTE' };
  const digits = original.replace(/\D/g, '');
  if (digits.length === 13) {
    if (/^(\d)\1{12}$/.test(digits) || /^8{13}$/.test(digits)) return { original, nsn: '', status: 'PLACEHOLDER' };
    const normalized = `${digits.slice(0, 4)}-${digits.slice(4, 6)}-${digits.slice(6, 9)}-${digits.slice(9, 13)}`;
    const canonical = /^\d{4}-\d{2}-\d{3}-\d{4}$/.test(original);
    return {
      original,
      nsn: normalized,
      status: canonical ? 'NSN_DOCUMENTAL' : 'NSN_NORMALIZADO',
    };
  }
  return { original, nsn: '', status: 'REFERENCIA' };
}

function looksLikeLeonardoQuotation(text = '', fileName = '') {
  const source = `${fileName}\n${text}`.toUpperCase();
  const core = [
    /\bLEONARDO\s+UK\s+LTD\b/,
    /\bQUOTATION\b/,
    /(NUMBER\/DATE|DOC\.\s*NO\.\/DATE)/,
    /REFERENCE\s+NO\.\/DATE/,
  ];
  const table = [/\bITEM\b/, /\bMATERIAL\b/, /\bDESCRIPTION\b/, /\bQTY\b/, /\bPRICE\b/, /\bVALUE\b/, /ITEMS\s+TOTAL/];
  return core.every((regex) => regex.test(source)) && table.filter((regex) => regex.test(source)).length >= 3;
}

function classifyCommercialDocument(text = '', fileName = '') {
  const source = `${fileName}\n${text}`.toUpperCase();
  if (/FIXED\s+PRICE\s+REPAIR/.test(source) && /FIXED\s+PRICE\s+OVERHAUL/.test(source)) return 'LEONARDO_REPAIR_PRICE_LETTER';
  if (/ONE[-\s]?TIME/.test(source) && /(WORLDWIDE\s+PRICE\s+LIST|PRICE\s+LIST)/.test(source) && /PURCHASE\s+ORDER/.test(source)) return 'LEONARDO_PRICE_LETTER';
  if (looksLikeLeonardoQuotation(text, fileName)) return 'LEONARDO_QUOTATION';
  return 'GENERIC_COMMERCIAL_DOCUMENT';
}

function pageSegments(text = '') {
  const raw = String(text || '').replace(/\r/g, '');
  const split = raw.split(/\f/);
  return split.length > 1 ? split.map((page, i) => ({ page: i + 1, text: page })) : [{ page: null, text: raw }];
}

function itemCandidates(lines = []) {
  const candidates = [];
  let expected = 1;
  for (let i = 0; i < lines.length; i += 1) {
    const line = clean(lines[i]);
    const match = line.match(/^(\d{1,3})(?:\s+(.*))?$/);
    if (!match) continue;
    const num = Number(match[1]);
    if (num !== expected) continue;
    const rest = clean(match[2]);
    if (rest && !/[A-Z0-9]/i.test(rest)) continue;
    candidates.push({ lineIndex: i, item_num: num, rest });
    expected += 1;
  }
  return candidates;
}

function parseQuotedItemBlock({ itemNum, firstRest, lines, sourcePage }) {
  const blockLines = lines.map(clean).filter(Boolean);
  let pn = '';
  let description = '';
  let consumedFirstFollowingLine = false;

  if (firstRest) {
    const m = firstRest.match(/^([^\s]+)(?:\s+(.*))?$/);
    pn = normalizePn(m?.[1]);
    description = clean(m?.[2]);
  } else if (blockLines.length) {
    const m = blockLines[0].match(/^([^\s]+)(?:\s+(.*))?$/);
    pn = normalizePn(m?.[1]);
    description = clean(m?.[2]);
    consumedFirstFollowingLine = true;
  }

  const remaining = consumedFirstFollowingLine ? blockLines.slice(1) : blockLines;
  const block = remaining.join('\n');
  const flat = remaining.join(' ').replace(/\s+/g, ' ').trim();

  const refMatch = flat.match(/\b(\d{4}-\d{2}-\d{3}-\d{4}|\d{4}-\d{9}|\d{13})\b/);
  const ref = normalizeMaterialReference(refMatch?.[1] || '');

  let leadWeeks = 0;
  for (const line of remaining) {
    const trimmed = clean(line);
    if (/^\d{1,3}$/.test(trimmed)) {
      const n = Number(trimmed);
      if (n >= 1 && n <= 260) { leadWeeks = n; break; }
    }
    if (ref.original && trimmed.includes(ref.original)) {
      const tail = trimmed.slice(trimmed.indexOf(ref.original) + ref.original.length).match(/\b(\d{1,3})\b/);
      if (tail) { leadWeeks = Number(tail[1]); break; }
    }
  }

  const stockMatch = flat.match(/Available\s+Stock\s+Quantity\s+([\d.,]+)/i);
  const qtyLine = flat.match(/([\d]+(?:[.,]\d{3})?)\s+N\b(?:\s+(TBA|[\d,]+\.\d{2}))?(?:\s+(TBA|[\d,]+\.\d{2}))?/i);
  const qty = parseMoney(qtyLine?.[1]);
  const unitPrice = parseMoney(qtyLine?.[2]);
  const itemValue = parseMoney(qtyLine?.[3]);
  const readyStock = parseMoney(stockMatch?.[1]);

  const awaiting = /Awaiting\s+Price/i.test(flat);
  const investigating = /Under\s+Investigation/i.test(flat);
  const priceStatus = awaiting ? 'AWAITING_PRICE' : investigating ? 'UNDER_INVESTIGATION' : unitPrice > 0 ? 'PRICED' : 'UNPRICED';

  const correction = flat.match(/original\s+request\s+was\s+P\/?N\s+([A-Z0-9./*-]+)\.?.*?correct\s+format\s+P\/?N\s+([A-Z0-9./*-]+)/i);
  let pnOriginalRequested = '';
  let correctionKind = '';
  let correctionNote = '';
  if (correction) {
    pnOriginalRequested = normalizePn(correction[1]);
    const corrected = normalizePn(correction[2]);
    if (corrected) pn = corrected;
    correctionKind = 'FORMAT_CORRECTION';
    correctionNote = clean(correction[0]).slice(0, 1000);
  }

  if (!description) {
    const candidates = remaining.filter((line) => {
      const t = clean(line);
      if (!t || t === ref.original || /^\d{1,3}$/.test(t)) return false;
      if (/Available\s+Stock|Awaiting\s+Price|Under\s+Investigation|\b\d+(?:[.,]\d{3})?\s+N\b/i.test(t)) return false;
      if (/original\s+request/i.test(t)) return false;
      return /[A-Z]/i.test(t);
    });
    if (candidates.length) description = candidates[0];
  }

  const warnings = [];
  if (!pn) warnings.push(`Item ${itemNum}: PN ausente.`);
  if (!description) warnings.push(`Item ${itemNum}: descrição/nomenclatura não informada na fonte.`);
  if (ref.status === 'PLACEHOLDER') warnings.push(`Item ${itemNum}: referência ${ref.original} é placeholder documental e não NSN confiável.`);
  if (unitPrice > 0 && qty > 0 && itemValue > 0 && Math.abs(round2(qty * unitPrice) - round2(itemValue)) > 0.01) {
    warnings.push(`Item ${itemNum}: quantidade x preço não fecha com o valor da linha.`);
  }

  return {
    item_num: itemNum,
    pn,
    nsn: ref.nsn,
    material_reference: ref.original,
    material_reference_status: ref.status,
    nomenclatura: clean(description).replace(/\s+/g, ' ').toUpperCase(),
    source_description_status: description ? 'SOURCE_PRESENT' : 'SOURCE_MISSING',
    qtd_solicitada: qty,
    lead_time: leadWeeks ? leadWeeks * 7 : 0,
    lead_time_original: leadWeeks ? `${leadWeeks} WEEK(S)` : '',
    estoque_pronto: readyStock,
    valor_unitario: unitPrice,
    valor_total_item: itemValue,
    price_status: priceStatus,
    tipo_cotacao: 'MATERIAL',
    match_mode: /\*/.test(pn) ? 'PATTERN' : 'EXACT',
    pn_original_solicitado: pnOriginalRequested,
    correcao_pn_tipo: correctionKind,
    source_page: sourcePage,
    source_excerpt: correctionNote || clean(block).slice(0, 1800),
    observacoes: correctionNote,
    _warnings: warnings,
  };
}

function detectSequentialQuotationItemCount(text = '') {
  const lines = String(text || '').replace(/\r/g, '').split('\n');
  let expected = 1;
  let insideItems = false;
  for (const raw of lines) {
    const line = clean(raw);
    if (/Item\s+Material/i.test(line) || (/\bItem\b/i.test(line) && /\bMaterial\b/i.test(line))) insideItems = true;
    if (!insideItems) continue;
    if (/Items\s+total/i.test(line)) break;
    const match = line.match(/^(\d{1,3})(?:\s+.*)?$/);
    if (match && Number(match[1]) === expected) expected += 1;
  }
  return expected - 1;
}

function parseQuotationItems(text = '') {
  const pages = pageSegments(text);
  const items = [];
  let expected = 1;

  pages.forEach(({ page, text: pageText }) => {
    const lines = pageText.split('\n');
    let start = lines.findIndex((line) => /Item\s+Material/i.test(line));
    if (start < 0 && expected === 1) return;
    if (start < 0) start = 0;
    const end = lines.findIndex((line, idx) => idx > start && /Items\s+total/i.test(line));
    const section = lines.slice(start + 1, end >= 0 ? end : lines.length);
    const candidates = [];
    for (let i = 0; i < section.length; i += 1) {
      const line = clean(section[i]);
      const match = line.match(/^(\d{1,3})(?:\s+(.*))?$/);
      if (!match || Number(match[1]) !== expected) continue;
      candidates.push({ lineIndex: i, item_num: expected, rest: clean(match[2]) });
      expected += 1;
    }
    candidates.forEach((candidate, index) => {
      const nextIndex = candidates[index + 1]?.lineIndex ?? section.length;
      const following = section.slice(candidate.lineIndex + 1, nextIndex);
      items.push(parseQuotedItemBlock({
        itemNum: candidate.item_num,
        firstRest: candidate.rest,
        lines: following,
        sourcePage: page,
      }));
    });
  });

  return items;
}

function parseLeonardoQuotation(text = '', fileName = '') {
  const flat = String(text || '').replace(/\r/g, '').replace(/[\t ]+/g, ' ');
  const compact = flat.replace(/\s+/g, ' ');
  const quote = compact.match(/(?:Number\/Date|Doc\.\s*no\.\/Date)\b[\s\S]{0,180}?(\d{6,})\s*\/\s*(\d{1,2}[.\/-]\d{1,2}[.\/-]\d{4})/i);
  const reference = compact.match(/Reference\s+no\.\/Date\b[\s\S]{0,180}?((?:Q|RFQ)\s*\d{4}\s*-\s*[A-Z]{1,5}\s*-\s*\d+)\s*\/\s*(\d{1,2}[.\/-]\d{1,2}[.\/-]\d{4})/i);
  const contract = compact.match(/Contract\s+Reference\.?\s+([^\s]+(?:\/[^\s]+)*)/i);
  const validity = compact.match(/Validity\s+period\s+(\d{1,2}[.\/-]\d{1,2}[.\/-]\d{4})\s+to\s+(\d{1,2}[.\/-]\d{1,2}[.\/-]\d{4})/i);
  const payment = compact.match(/Terms\s+of\s+payment\s+(.+?)(?=Terms\s+of\s+delivery|_{3,}|Item\s+Material)/i);
  const delivery = compact.match(/Terms\s+of\s+delivery\s+(.+?)(?=_{3,}|Item\s+Material)/i);
  const itemsTotal = compact.match(/Items\s+total\s+([\d,]+\.\d{2})/i);
  const packing = compact.match(/Packing\s*&\s*Delivery\s+([\d.]+)\s*%\s+[\d,]+\.\d{2}\s+([\d,]+\.\d{2})/i);
  const finalAmount = compact.match(/Final\s+amount\s+([\d,]+\.\d{2})/i);
  const printed = compact.match(/Quotation\s+Printed\s+(\d{1,2}[.\/-]\d{1,2}[.\/-]\d{4})/i);

  const items = parseQuotationItems(text);
  const warnings = items.flatMap((item) => item._warnings || []);
  const blockingWarnings = [];
  const expectedItemCount = detectSequentialQuotationItemCount(text);
  const contiguous = items.every((item, index) => Number(item.item_num) === index + 1);
  if (expectedItemCount && items.length !== expectedItemCount) blockingWarnings.push(`Estrutura incompleta: fonte contém ${expectedItemCount} item(ns), parser retornou ${items.length}.`);
  if (!contiguous) blockingWarnings.push('Numeração dos itens não está contínua e fiel à fonte.');
  const parsedItemsTotal = parseMoney(itemsTotal?.[1]);
  const computedTotal = round2(items.reduce((sum, item) => sum + (Number(item.valor_total_item) || 0), 0));
  if (parsedItemsTotal > 0 && Math.abs(round2(parsedItemsTotal) - computedTotal) > 0.01) blockingWarnings.push('Items total não fecha com a soma das linhas precificadas.');
  const packingValue = parseMoney(packing?.[2]);
  const parsedFinal = parseMoney(finalAmount?.[1]);
  if (parsedItemsTotal > 0 && parsedFinal > 0 && Math.abs(round2(parsedItemsTotal + packingValue) - round2(parsedFinal)) > 0.01) blockingWarnings.push('Final amount não fecha com Items total + Packing & Delivery.');
  const allWarnings = [...blockingWarnings, ...warnings];
  const qualityStatus = blockingWarnings.length ? 'BLOCKED' : allWarnings.length ? 'REVIEW' : 'READY';

  const cleanItems = items.map(({ _warnings, ...item }) => item);
  return {
    metadados: {
      documento_tipo: 'LEONARDO_QUOTATION',
      quotation_number: clean(quote?.[1]) || 'N/A',
      quotation_date: normalizeDateToken(quote?.[2]),
      reference: clean(reference?.[1]).replace(/\s+/g, ' ') || 'N/A',
      contract_reference: clean(contract?.[1]),
      validity: validity ? `${normalizeDateToken(validity[1])} a ${normalizeDateToken(validity[2])}` : '',
      condicao: '',
      moeda: 'GBP',
      fornecedor: /Leonardo\s+UK\s+Ltd/i.test(text) ? 'LEONARDO UK LTD' : 'LEONARDO',
      tipo_cotacao: 'MATERIAL',
      payment_terms: clean(payment?.[1]).replace(/\s+/g, ' '),
      delivery_terms: clean(delivery?.[1]).replace(/\s+/g, ' '),
      quotation_printed_date: normalizeDateToken(printed?.[1]),
      stock_availability_note: /cannot\s+guarantee\s+availability\s+of\s+this\s+stock/i.test(compact)
        ? 'Available Stock Quantity é fotografia da data da cotação; Leonardo não garante disponibilidade até a emissão/aceitação da PO.'
        : '',
      expected_item_count: expectedItemCount,
      parsed_item_count: items.length,
      items_total: parsedItemsTotal,
      packing_delivery_percent: parseMoney(packing?.[1]),
      packing_delivery_value: packingValue,
      final_amount: parsedFinal,
      quality_status: qualityStatus,
      quality_warnings: allWarnings,
      arquivo_nome: fileName || null,
    },
    items: cleanItems,
  };
}

function parseLeonardoPriceLetter(text = '', fileName = '') {
  const flat = String(text || '').replace(/\r/g, '').replace(/\s+/g, ' ');
  const ref = flat.match(/LHUK\s+Ref\.?\s*:\s*([^\s]+)/i);
  const date = flat.match(/Date\s*:\s*(\d{1,2}(?:st|nd|rd|th)?\s+[A-Za-z]+\s+\d{4})/i);
  const contract = flat.match(/Contract\s+No\.\s*([^\s“”"()]+(?:\/[^\s“”"()]+)*)/i);
  const quantity = flat.match(/quantity\s+(?:[A-Za-z-]+\s*)?\((\d+)\)/i) || flat.match(/quantity\s+(\d+)/i);
  const pnMatch = flat.match(/(?:Part\s+Number|Part\s+No\.)\s+([A-Z0-9./*-]+)/i);
  const nsnMatch = flat.match(/(?:Nato\s+Stock\s+reference|NSN)\s*,?\s*([0-9-]{10,20})/i);
  const discount = flat.match(/(?:five|\d+(?:\.\d+)?)\s+percent\s*\((\d+(?:\.\d+)?)%\)/i) || flat.match(/(\d+(?:\.\d+)?)\s*%\s+reduction/i);
  const prices = flat.match(/reducing\s+the\s+price\s+from\s+£\s*([\d,]+\.\d{2}).*?to\s+a\s+price\s+of\s+£\s*([\d,]+\.\d{2})/i);
  const deadline = flat.match(/no\s+later\s+than\s+(\d{1,2}(?:st|nd|rd|th)?\s+[A-Za-z]+\s+\d{4})/i);
  const description = flat.match(/purchase\s+of\s+quantity\s+(?:[A-Za-z-]+\s*)?\(\d+\)\s+([^.;]{2,100})[.;]/i)
    || flat.match(/quantity\s+(?:[A-Za-z-]+\s*)?\(\d+\)\s+([^,.;]{2,100}),\s+reference\s+Part\s+Number/i);

  const materialRef = normalizeMaterialReference(nsnMatch?.[1] || '');
  const warnings = [];
  if (!pnMatch?.[1]) warnings.push('PN não localizado na carta de preço.');
  if (!prices?.[2]) warnings.push('Preço especial não localizado na carta.');
  if (!deadline?.[1]) warnings.push('Prazo da condição one-time não localizado.');

  const conditionDeadline = normalizeDateToken(deadline?.[1]);
  return {
    metadados: {
      documento_tipo: 'LEONARDO_PRICE_LETTER',
      quotation_number: clean(ref?.[1]) || fileName || 'CARTA LEONARDO',
      quotation_date: normalizeDateToken(date?.[1]),
      reference: clean(ref?.[1]) || '',
      contract_reference: clean(contract?.[1]),
      validity: conditionDeadline,
      condicao: 'ONE_TIME_ONLY',
      moeda: 'GBP',
      fornecedor: 'LEONARDO UK LTD',
      tipo_cotacao: 'MATERIAL',
      quality_status: warnings.length ? 'REVIEW' : 'READY',
      quality_warnings: warnings,
      arquivo_nome: fileName || null,
    },
    items: [{
      item_num: 1,
      pn: normalizePn(pnMatch?.[1]),
      nsn: materialRef.nsn,
      material_reference: materialRef.original,
      material_reference_status: materialRef.status,
      nomenclatura: clean(description?.[1]).replace(/\s+/g, ' ').toUpperCase(),
      qtd_solicitada: parseMoney(quantity?.[1]),
      lead_time: 0,
      estoque_pronto: 0,
      valor_unitario: parseMoney(prices?.[2]),
      valor_total_item: parseMoney(prices?.[2]) * (parseMoney(quantity?.[1]) || 1),
      preco_base: parseMoney(prices?.[1]),
      desconto_percentual: parseMoney(discount?.[1]),
      price_status: prices?.[2] ? 'PRICED' : 'UNPRICED',
      tipo_cotacao: 'MATERIAL',
      one_time_only: true,
      limite_quantidade: parseMoney(quantity?.[1]),
      prazo_condicao: conditionDeadline,
      match_mode: 'EXACT',
      source_page: 1,
      source_excerpt: prices ? clean(prices[0]).slice(0, 1800) : clean(flat).slice(0, 1800),
      observacoes: 'Preço excepcional one-time; não substitui silenciosamente a Price List fora das condições da carta.',
    }],
  };
}

function splitTableLine(line) {
  const trimmed = clean(line).replace(/^\|/, '').replace(/\|$/, '');
  if (trimmed.includes('|')) return trimmed.split('|').map((part) => clean(part));
  return trimmed.split(/\s{2,}/).map((part) => clean(part)).filter(Boolean);
}

function looksLikePrice(value) {
  return /^£?\s*[\d,]+\.\d{2}$/.test(clean(value));
}

function parseLeonardoRepairPriceLetter(text = '', fileName = '') {
  const raw = String(text || '').replace(/\r/g, '');
  const flat = raw.replace(/\s+/g, ' ');
  const validity = flat.match(/validity\s*,?\s*(\d{1,2}(?:st|nd|rd|th)?\s+[A-Za-z]+\s+\d{4})/i);
  const date = flat.match(/(?:Date\s*:?\s*|dated\s+)(\d{1,2}(?:st|nd|rd|th)?\s+[A-Za-z]+\s+\d{4})/i);
  const contract = flat.match(/Contract\s+No\.\s*([^\s“”"()]+(?:\/[^\s“”"()]+)*)/i);
  const ref = flat.match(/(?:LHUK|LUKL)\s*(?:Ref\.)?\s*:?\s*([A-Z0-9/.-]{8,})/i);
  const rows = [];

  raw.split('\n').forEach((line) => {
    if (!line.trim() || /Component\s+Description/i.test(line) || /Part\s+Number/i.test(line) || /Fixed\s+Price/i.test(line)) return;
    const cols = splitTableLine(line);
    if (cols.length < 3) return;
    let [description, pn, repair, overhaul] = cols;
    if (!pn || !/[A-Z0-9]/i.test(pn)) return;
    const repairPrice = looksLikePrice(repair) ? parseMoney(repair) : 0;
    const overhaulPrice = looksLikePrice(overhaul) ? parseMoney(overhaul) : 0;
    if (!repairPrice && !overhaulPrice) return;
    rows.push({ description, pn: normalizePn(pn), repairPrice, overhaulPrice });
  });

  const items = [];
  rows.forEach((row) => {
    const base = {
      pn: row.pn,
      nsn: '',
      material_reference: '',
      material_reference_status: 'AUSENTE',
      nomenclatura: clean(row.description).toUpperCase(),
      qtd_solicitada: 0,
      lead_time: 0,
      estoque_pronto: 0,
      price_status: 'PRICED',
      match_mode: /\*/.test(row.pn) ? 'PATTERN' : 'EXACT',
      source_excerpt: `${row.description} | ${row.pn} | ${row.repairPrice || ''} | ${row.overhaulPrice || ''}`,
    };
    if (row.repairPrice > 0) items.push({ ...base, item_num: items.length + 1, tipo_cotacao: 'REPARO', valor_unitario: row.repairPrice, valor_total_item: row.repairPrice, condicao_item: 'FIXED_PRICE_REPAIR' });
    if (row.overhaulPrice > 0) items.push({ ...base, item_num: items.length + 1, tipo_cotacao: 'OVERHAUL', valor_unitario: row.overhaulPrice, valor_total_item: row.overhaulPrice, condicao_item: 'FIXED_PRICE_OVERHAUL' });
  });

  const warnings = [];
  if (!items.length) warnings.push('A tabela de preços de Repair/Overhaul não foi extraída em formato estruturado.');
  const normalizedValidity = normalizeDateToken(validity?.[1]);
  return {
    metadados: {
      documento_tipo: 'LEONARDO_REPAIR_PRICE_LETTER',
      quotation_number: clean(ref?.[1]) || fileName || 'CARTA REPAIR/OVERHAUL',
      quotation_date: normalizeDateToken(date?.[1]),
      reference: clean(ref?.[1]) || '',
      contract_reference: clean(contract?.[1]),
      validity: normalizedValidity,
      condicao: 'FIXED_PRICE_REPAIR_OVERHAUL',
      moeda: 'GBP',
      fornecedor: 'LEONARDO UK LTD',
      tipo_cotacao: 'REPARO',
      quality_status: warnings.length ? 'REVIEW' : 'READY',
      quality_warnings: warnings,
      arquivo_nome: fileName || null,
    },
    items,
  };
}

function parseDeterministicCommercialDocument({ text = '', fileName = '', documentType = '' } = {}) {
  const type = documentType || classifyCommercialDocument(text, fileName);
  if (type === 'LEONARDO_QUOTATION') return parseLeonardoQuotation(text, fileName);
  if (type === 'LEONARDO_PRICE_LETTER') return parseLeonardoPriceLetter(text, fileName);
  if (type === 'LEONARDO_REPAIR_PRICE_LETTER') return parseLeonardoRepairPriceLetter(text, fileName);
  return null;
}

module.exports = {
  clean,
  normalizePn,
  parseMoney,
  normalizeDateToken,
  normalizeMaterialReference,
  looksLikeLeonardoQuotation,
  detectSequentialQuotationItemCount,
  classifyCommercialDocument,
  parseLeonardoQuotation,
  parseLeonardoPriceLetter,
  parseLeonardoRepairPriceLetter,
  parseDeterministicCommercialDocument,
};
