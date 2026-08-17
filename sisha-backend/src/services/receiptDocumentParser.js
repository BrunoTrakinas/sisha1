const XLSX = require('xlsx');
const crypto = require('crypto');
const { findHeaderRow, buildIndexMap, normalizePn } = require('../utils/importAliases');
const { extractOfficeDocument } = require('../utils/officeDocumentText');
const {
  analyzeReceiptDescription,
  extractSerialsFromDescription,
  normalizeSerialToken: normalizeSemanticSerialToken,
} = require('./receiptDescriptionSemanticNormalizerService');

const EMPTY_SERIALS = new Set(['', 'N/A', 'NA', 'S/N', 'SEM SN', 'SEM S/N', '-']);

function text(value) {
  return String(value ?? '').trim();
}

function upper(value) {
  return text(value).toUpperCase();
}

function compact(value) {
  return text(value).replace(/\s+/g, ' ');
}

function parseLocaleNumber(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  let raw = text(value).replace(/[^0-9,.-]/g, '');
  if (!raw) return 0;

  const comma = raw.lastIndexOf(',');
  const dot = raw.lastIndexOf('.');
  if (comma !== -1 && dot !== -1) {
    if (comma > dot) raw = raw.replace(/\./g, '').replace(',', '.');
    else raw = raw.replace(/,/g, '');
  } else if (comma !== -1) {
    raw = raw.replace(',', '.');
  }

  const number = Number(raw);
  return Number.isFinite(number) ? number : 0;
}

function formatIsoDate(value) {
  if (!value) return null;
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString().slice(0, 10);
  if (typeof value === 'number' && Number.isFinite(value)) {
    const date = new Date(Math.round((value - 25569) * 86400 * 1000));
    return Number.isNaN(date.getTime()) ? null : date.toISOString().slice(0, 10);
  }

  const raw = text(value);
  const br = raw.match(/\b(\d{1,2})[/-](\d{1,2})[/-](\d{4})\b/);
  if (br) return `${br[3]}-${String(br[2]).padStart(2, '0')}-${String(br[1]).padStart(2, '0')}`;
  const iso = raw.match(/\b(\d{4})[/-](\d{1,2})[/-](\d{1,2})\b/);
  if (iso) return `${iso[1]}-${String(iso[2]).padStart(2, '0')}-${String(iso[3]).padStart(2, '0')}`;
  return null;
}

function normalizeReceiptNumber(value) {
  const match = text(value).match(/\b(\d{1,4})\s*[/-]\s*(\d{4})\b/);
  if (!match) return null;
  const prefix = match[1].padStart(3, '0');
  return `${prefix}/${match[2]}`;
}

function receiptNumberFromText(value) {
  const source = String(value || '');
  const patterns = [
    /RECIBO(?:\s+DE\s+ENTREGA\s+DE\s+MATERIAL)?\s+(?:N[ÚU]MERO|N[º°.]?)\s*[:\-]?\s*(\d{1,4}\s*[/-]\s*\d{4})/i,
    /RECIBO\s*[:\-]?\s*(\d{1,4}\s*[/-]\s*\d{4})/i,
  ];
  for (const pattern of patterns) {
    const match = source.match(pattern);
    if (match) return normalizeReceiptNumber(match[1]);
  }
  return null;
}

function receiptNumberFromFileName(name) {
  const source = String(name || '');
  const match = source.match(/RECIBO\s*[-_ ]*([0-9]{1,4})\s*[-/]\s*(20[0-9]{2})/i);
  return match ? normalizeReceiptNumber(`${match[1]}/${match[2]}`) : null;
}

function buildFallbackReceiptNumber(file, type) {
  const hash = crypto.createHash('sha256').update(file?.buffer || Buffer.from(String(file?.originalname || 'recibo'))).digest('hex').slice(0, 12).toUpperCase();
  const safeType = upper(type || 'RECIBO').replace(/[^A-Z0-9]+/g, '-').replace(/^-|-$/g, '') || 'RECIBO';
  return `SEM-NUMERO-${safeType}-${hash}`.slice(0, 120);
}

function extractContractReference(value) {
  const source = compact(value);
  const patterns = [
    /BNCE\s+Order\s+Contrato\s+(?:No\.?|N[º°])?\s*[:\-]?\s*([A-Z0-9./-]+)/i,
    /Contract\s+(?:No\.?|N[º°])?\s*[:\-]?\s*([A-Z0-9./-]+)/i,
    /Contrato\s+(?:No\.?|N[º°])?\s*[:\-]?\s*([A-Z0-9./-]+)/i,
  ];
  for (const pattern of patterns) {
    const match = source.match(pattern);
    if (match) return text(match[1]).replace(/[.;,]+$/, '');
  }
  return null;
}

function extractDate(value) {
  const source = String(value || '');
  const patterns = [
    /\bDATA\s+DE\s+ENTREGA\s*[:\-]?\s*(\d{1,2}[/-]\d{1,2}[/-]\d{4})/i,
    /\bDATA\s*[:\-]?\s*(\d{1,2}[/-]\d{1,2}[/-]\d{4})/i,
  ];
  for (const pattern of patterns) {
    const match = source.match(pattern);
    if (match) return formatIsoDate(match[1]);
  }
  return null;
}

function extractOrigin(value) {
  const source = compact(value);
  const match = source.match(/Recebi\s+do\s+(.+?),\s+o\s+material/i);
  return match ? text(match[1]) : null;
}


function extractReceivingOrganization(value) {
  const source = compact(value);
  const omMatch = source.match(/C[ÓO]DIGO\s+OM\s*[:\-]?\s*([0-9A-Z-]+)/i);
  const siglaMatch = source.match(/SIGLA\s*[^A-Z0-9]{0,4}\s*([A-Z][A-Z0-9-]{1,19})/i);
  return {
    codigoOm: omMatch ? upper(omMatch[1]) : null,
    sigla: siglaMatch ? upper(siglaMatch[1]) : null,
  };
}

function extractProgramOrigin(value) {
  const source = compact(value);
  const patterns = [
    /\b(BRAZIL\s+7\s*&\s*8\s+PLANNING\s+REMOVAL)\b/i,
    /\b(N-4010\s+WARRANTY\s+SPARES)\b/i,
    /\b(WARRANTY\s+SPARES)\b/i,
    /\b(MODERNI[ZS]ATION\s+PROGRAM(?:ME)?)\b/i,
  ];
  for (const pattern of patterns) {
    const match = source.match(pattern);
    if (match) return upper(match[1]).replace(/\s+/g, ' ');
  }
  return null;
}

function inferPredictedDestination({ pd = null, receiver = {}, fullText = '' } = {}) {
  const pdUpper = upper(pd).replace(/\s+/g, '');
  const sigla = upper(receiver?.sigla);
  const body = upper(fullText);

  if (/^PD?71200-/.test(pdUpper) || /^71200-/.test(pdUpper)) {
    return { destino: 'CEIMSPA', fonte: 'PD_71200' };
  }
  if (sigla === 'CEIMSPA' || /SIGLA\s*[–—-]?\s*CEIMSPA/.test(body)) {
    return { destino: 'CEIMSPA', fonte: 'RECEBEDOR_CEIMSPA' };
  }
  return { destino: null, fonte: null };
}

function classifyValidity(statusValue, description) {
  const status = upper(statusValue);
  const source = `${status} ${upper(description)}`;
  if (/NO\s+STOCK/.test(source)) {
    return {
      condition: 'FALTANTE',
      validity: 'SEM_ESTOQUE',
      note: `Status do documento: ${text(statusValue) || 'No Stock'}.`,
      validityNote: 'Documento informa ausência de estoque; a linha não compõe disponibilidade.',
    };
  }
  if (/NEAR\s+EXPIR|EXPIRING|PR[ÓO]XIM[OA].*VENC|VENCENDO/.test(source)) {
    return {
      condition: 'RECEBIDO_DISPONIVEL',
      validity: 'PROXIMO_VENCIMENTO',
      note: 'Item próximo do vencimento conforme o documento; permanece disponível até confirmação de vencimento.',
      validityNote: text(statusValue) || 'Próximo do vencimento',
    };
  }
  if (/EXPIRE|EXPIRED|VENCID/.test(source)) {
    return {
      condition: 'QUARENTENA',
      validity: 'VENCIDO',
      note: 'Batch/lote vencido ou com uso restrito conforme o documento; não contabilizar como pronto uso.',
      validityNote: text(statusValue) || 'Vencido',
    };
  }
  if (!status) {
    return { condition: 'RECEBIDO_DISPONIVEL', validity: 'NAO_INFORMADA', note: null, validityNote: null };
  }
  if (status === 'OK') {
    return { condition: 'RECEBIDO_DISPONIVEL', validity: 'OK', note: null, validityNote: 'Status OK no documento.' };
  }
  return {
    condition: 'DIVERGENTE',
    validity: 'REVISAR',
    note: `Status documental a conferir: ${text(statusValue)}.`,
    validityNote: text(statusValue),
  };
}

function receiptTypeSignals(fileName, fullText, requestedType, hasPdColumn) {
  const file = upper(fileName);
  const body = upper(fullText);
  const isFoc = /\bFOC\b|FREE\s+OF\s+CHARGE/.test(body) || /\bFOC\b/.test(file);
  const fileGuarantee = /GARANTIA|WARRANTY/.test(file);
  const bodyGuarantee = /GARANTIA|WARRANTY/.test(body);
  const fileDispose = /DISPOSE|DOA[CÇ][AÃ]O|DONATION/.test(file);
  const bodyDispose = /DISPOSE|DOA[CÇ][AÃ]O|DONATION/.test(body);
  const requestedPd = requestedType === 'recibo_pd';

  let type = 'MATERIAL';
  if (requestedPd || hasPdColumn) type = 'PD';
  // O nome do arquivo representa a classificação escolhida pelo operador e
  // prevalece sobre palavras soltas do corpo (ex.: peças em garantia dentro
  // de um recibo de DISPOSE). O conteúdo continua gerando aviso de conflito.
  else if (fileGuarantee) type = 'GARANTIA';
  else if (fileDispose) type = 'DOACAO_DISPOSE';
  else if (bodyGuarantee) type = 'GARANTIA';
  else if (bodyDispose) type = 'DOACAO_DISPOSE';
  else if (isFoc) type = 'FOC';

  const warnings = [];
  if (fileGuarantee && bodyDispose) warnings.push('O nome do arquivo indica GARANTIA, mas o conteúdo menciona DISPOSE/DOAÇÃO. Confirme o tipo antes de salvar.');
  if (fileDispose && bodyGuarantee) warnings.push('O nome do arquivo indica DISPOSE/DOAÇÃO, mas o conteúdo menciona GARANTIA/WARRANTY. Confirme o tipo antes de salvar.');
  if (fileGuarantee && isFoc) warnings.push('O documento foi identificado como GARANTIA e também contém indicação FOC. O tipo ficou GARANTIA e a marcação FOC foi preservada separadamente.');
  if (fileDispose && isFoc) warnings.push('O documento foi identificado como DISPOSE/DOAÇÃO e também contém indicação FOC. O tipo ficou DISPOSE/DOAÇÃO e a marcação FOC foi preservada separadamente.');

  return { type, isFoc, warnings };
}


const INLINE_CONTRACT_PATTERN_SOURCE = String.raw`\d{4,6}\/\d{4}-\d{3}\/\d{2}`;

function inlineContractMatch(value = '') {
  const source = compact(value);
  if (!source) return null;
  return new RegExp(`\\b(${INLINE_CONTRACT_PATTERN_SOURCE})\\b`, 'i').exec(source);
}

function extractInlineContractReference(value = '') {
  const match = inlineContractMatch(value);
  return match ? upper(match[1]) : null;
}

function normalizeSerialToken(value) {
  return normalizeSemanticSerialToken(value);
}

function extractSerials(description) {
  return extractSerialsFromDescription(description);
}


function semanticMarkerCutIndex(source, matchIndex) {
  let cut = Number(matchIndex);
  if (!Number.isFinite(cut) || cut < 0) return source.length;
  const prefix = source.slice(0, cut);
  const separator = /\s*[-–—]\s*$/.exec(prefix);
  if (separator) return separator.index;
  while (cut > 0 && /\s/.test(source[cut - 1])) cut -= 1;
  return cut;
}

function parseDescriptionMetadata(description) {
  const semantic = analyzeReceiptDescription(description);
  return {
    original: semantic.original,
    nomenclatura: semantic.nomenclatura,
    referencia: semantic.reference,
    ordemCompra: semantic.order,
    itemOrdemCompra: semantic.item,
    programaLogistico: semantic.program,
    contratoLinha: semantic.contract,
    isFoc: semantic.isFoc,
    warranty: semantic.warranty,
    contextoAeronave: semantic.aircraftContext,
    codigoAuxiliar: semantic.auxCode,
  };
}


function serialsFromItem(item = {}) {
  const preloaded = Array.isArray(item.sns_pre_carregados) ? item.sns_pre_carregados : [];
  const inline = String(item.sn || '')
    .split(/[,;|]+/)
    .map(normalizeSerialToken)
    .filter(Boolean);
  return [...new Set([...preloaded.map(normalizeSerialToken), ...inline]
    .filter((serial) => serial && !EMPTY_SERIALS.has(serial)))];
}

function expandSerializedReceiptItems(items = [], warnings = []) {
  const expanded = [];

  (items || []).forEach((item, sourceIndex) => {
    const totalQuantity = parseLocaleNumber(item.quantidade);
    const serials = serialsFromItem(item);
    const baseOriginal = item.dados_originais && typeof item.dados_originais === 'object' ? item.dados_originais : {};

    if (!serials.length) {
      expanded.push({ ...item });
      return;
    }

    if (!Number.isInteger(totalQuantity) || totalQuantity <= 0) {
      warnings.push(`Item ${sourceIndex + 1} (${item.pn || 'sem PN'}): existem SNs, mas a quantidade documental (${item.quantidade}) não é inteira/positiva; revisão obrigatória.`);
      expanded.push({ ...item, sn: serials.join(', '), sns_pre_carregados: serials });
      return;
    }

    if (serials.length > totalQuantity) {
      warnings.push(`Item ${sourceIndex + 1} (${item.pn || 'sem PN'}): quantidade ${totalQuantity} menor que ${serials.length} SNs encontrados; nenhuma unidade foi descartada automaticamente.`);
      expanded.push({ ...item, sn: serials.join(', '), sns_pre_carregados: serials });
      return;
    }

    const rawUnit = item.valor_unitario == null || item.valor_unitario === '' ? null : parseLocaleNumber(item.valor_unitario);
    const rawTotal = item.valor_total_documento == null || item.valor_total_documento === '' ? null : parseLocaleNumber(item.valor_total_documento);
    const effectiveUnit = rawUnit != null && rawUnit > 0
      ? rawUnit
      : rawTotal != null && rawTotal > 0 && totalQuantity > 0
        ? rawTotal / totalQuantity
        : null;

    serials.forEach((serial, serialIndex) => {
      expanded.push({
        ...item,
        id_temp: `${item.id_temp ?? sourceIndex}-SN-${serialIndex + 1}`,
        quantidade: 1,
        sn: serial,
        sns_pre_carregados: [serial],
        sn_extraido_documento: true,
        tipo_item: 'EQUIPAMENTO',
        valor_total_documento: effectiveUnit == null ? item.valor_total_documento : Number(effectiveUnit.toFixed(2)),
        dados_originais: {
          ...baseOriginal,
          unidade_serializada_expandida: true,
          linha_documental_origem: sourceIndex + 1,
          quantidade_documental_origem: totalQuantity,
          sns_documentais_origem: serials,
          sn_operacional: serial,
        },
      });
    });

    const remaining = totalQuantity - serials.length;
    if (remaining > 0) {
      expanded.push({
        ...item,
        id_temp: `${item.id_temp ?? sourceIndex}-SALDO`,
        quantidade: remaining,
        sn: '',
        sns_pre_carregados: [],
        sn_extraido_documento: false,
        tipo_item: 'SOBRESSALENTE',
        valor_total_documento: effectiveUnit == null ? item.valor_total_documento : Number((remaining * effectiveUnit).toFixed(2)),
        observacao_item: joinObservation(item.observacao_item, `Saldo de ${remaining} unidade(s) sem SN informado no documento.`),
        dados_originais: {
          ...baseOriginal,
          saldo_sem_sn_expandido: true,
          linha_documental_origem: sourceIndex + 1,
          quantidade_documental_origem: totalQuantity,
          sns_documentais_origem: serials,
        },
      });
    }
  });

  return expanded.map((item, index) => ({ ...item, sequencia_item: index + 1 }));
}

function deriveCondition(statusValue, description) {
  return classifyValidity(statusValue, description);
}

function joinObservation(...parts) {
  return parts.map((part) => text(part)).filter(Boolean).join(' ').trim() || null;
}

function rawPayload(headers, row) {
  const payload = {};
  (headers || []).forEach((header, index) => {
    const key = text(header) || `COL_${index + 1}`;
    const value = row?.[index];
    if (value !== undefined && value !== null && text(value) !== '') payload[key] = value;
  });
  return payload;
}

function workbookRows(workbook) {
  return workbook.SheetNames.map((sheetName) => ({
    sheetName,
    rows: XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { header: 1, defval: '', raw: false }),
  }));
}

function scoreSheet(rows, requestedType) {
  const flattened = rows.slice(0, 80).map((row) => row.join(' ')).join(' ');
  const receipt = receiptNumberFromText(flattened);
  const headerPn = findHeaderRow(rows, ['pn', 'qtd']);
  const headerPd = findHeaderRow(rows, ['pd', 'qtd']);
  let score = receipt ? 100 : 0;
  if (headerPn >= 0) score += 40;
  if (headerPd >= 0) score += requestedType === 'recibo_pd' ? 50 : 25;
  if (/RECEBI\s+DO\s+DEP[ÓO]SITO/i.test(flattened)) score += 20;
  if (/RECIBO\s+DE\s+ENTREGA/i.test(flattened)) score += 20;
  return score;
}

function selectReceiptSheet(workbook, requestedType) {
  const candidates = workbookRows(workbook).map((candidate) => ({
    ...candidate,
    score: scoreSheet(candidate.rows, requestedType),
  })).sort((a, b) => b.score - a.score || b.rows.length - a.rows.length);
  return candidates[0] || null;
}

function parseSpreadsheetReceipt({ workbook, file, requestedType }) {
  const selected = selectReceiptSheet(workbook, requestedType);
  if (!selected) throw new Error('Nenhuma aba válida foi encontrada no recibo.');

  const { sheetName, rows } = selected;
  const fullText = rows.map((row) => row.join(' ')).join('\n');
  const headerIndexPd = findHeaderRow(rows, ['pd', 'qtd']);
  const headerIndexPn = findHeaderRow(rows, ['pn', 'qtd']);
  const headerIndex = requestedType === 'recibo_pd' && headerIndexPd >= 0
    ? headerIndexPd
    : headerIndexPn >= 0 ? headerIndexPn : headerIndexPd;
  if (headerIndex < 0) throw new Error('Cabeçalho de PN/QTY não encontrado no recibo.');

  const headers = rows[headerIndex];
  const idx = buildIndexMap(headers, {
    pd: ['pd'],
    pn: 'pn',
    nsn: ['nsn', 'pi'],
    desc: 'nomenclatura',
    qty: 'qtd',
    deliveryNote: ['delivery note', 'delivery o', 'delivery order', 'delivery number', 'delivery no', 'delivery'],
    invoice: ['invoice no', 'invoice number', 'invoice'],
    di: ['di'],
    unitPrice: ['unit price', 'unit price £', 'unit. price £', 'price'],
    totalPrice: ['total price', 'total p £', 'total p. £', 'total'],
    batch: ['batch no', 'batch number', 'batch'],
    coc: ['coc. o.', 'coc o', 'coc', 'co c o'],
    status: ['status', 'condition'],
  });

  const internalNumber = receiptNumberFromText(fullText);
  const fileNumber = receiptNumberFromFileName(file?.originalname);
  const warnings = [];
  if (internalNumber && fileNumber && internalNumber !== fileNumber) {
    warnings.push(`O número dentro do documento (${internalNumber}) diverge do nome do arquivo (${fileNumber}). O sistema usou o número interno; confirme antes de salvar.`);
  }

  const typeSignals = receiptTypeSignals(file?.originalname, fullText, requestedType, idx.pd >= 0);
  warnings.push(...typeSignals.warnings);
  const receiptNumber = internalNumber || fileNumber || buildFallbackReceiptNumber(file, typeSignals.type);
  const date = extractDate(fullText);
  const receiptYear = Number(String(receiptNumber).match(/\/(\d{4})$/)?.[1]);
  const dateYear = date ? Number(date.slice(0, 4)) : null;
  if (receiptYear && dateYear && receiptYear !== dateYear) {
    warnings.push(`A data extraída (${date.split('-').reverse().join('/')}) não pertence ao mesmo ano do recibo ${receiptNumber}. Confirme a data manualmente.`);
  }

  const contract = extractContractReference(fullText);
  const origin = extractOrigin(fullText);
  const receiver = extractReceivingOrganization(fullText);
  const programOrigin = extractProgramOrigin(fullText);
  const globalObservation = rows
    .map((row) => compact(row.join(' ')))
    .filter((rowText) => /^OBS(?:ERVA[CÇ][AÃ]O)?\s*:/i.test(rowText))
    .join(' ');

  const items = [];
  rows.slice(headerIndex + 1).forEach((row, sourceIndex) => {
    const pn = normalizePn(idx.pn >= 0 ? row[idx.pn] : '');
    const quantity = parseLocaleNumber(idx.qty >= 0 ? row[idx.qty] : 0);
    const pd = idx.pd >= 0 ? text(row[idx.pd]) : null;
    const description = idx.desc >= 0 ? text(row[idx.desc]) : null;
    const descriptionMeta = parseDescriptionMetadata(description);
    const rowHasContent = row.some((cell) => text(cell) !== '');
    if (!pn || quantity <= 0) {
      if (rowHasContent && !/^OBS/i.test(compact(row.join(' ')))) {
        // A linha é preservada apenas no payload bruto do cabeçalho; não cria item inválido.
      }
      return;
    }

    const status = idx.status >= 0 ? text(row[idx.status]) : null;
    const deliveryNote = idx.deliveryNote >= 0 ? text(row[idx.deliveryNote]) : null;
    const condition = deriveCondition(status, `${description || ''} ${deliveryNote || ''}`);
    const serials = extractSerials(description);
    const predictedDestination = inferPredictedDestination({ pd, receiver, fullText });
    const unitPrice = idx.unitPrice >= 0 ? parseLocaleNumber(row[idx.unitPrice]) : 0;
    const totalPrice = idx.totalPrice >= 0 ? parseLocaleNumber(row[idx.totalPrice]) : 0;

    items.push({
      id_temp: sourceIndex,
      sequencia_item: items.length + 1,
      pn,
      nsn_pi: idx.nsn >= 0 ? text(row[idx.nsn]) : null,
      nomenclatura: descriptionMeta.nomenclatura,
      quantidade: quantity,
      sn: serials.join(', '),
      sns_pre_carregados: serials,
      localizacao_ppu: predictedDestination.destino === 'CEIMSPA' && receiver.sigla === 'CEIMSPA' ? 'CEIMSPA' : '',
      destino_previsto: predictedDestination.destino,
      destino_previsto_fonte: predictedDestination.fonte,
      condicao_item: condition.condition,
      validade_status: condition.validity,
      validade_observacao: condition.validityNote,
      sn_extraido_documento: serials.length > 0,
      observacao_item: joinObservation(condition.note, status ? `Status original: ${status}.` : null),
      inventariado_ppu: false,
      quantidade_inventariada: 0,
      documento_referencia: pd || descriptionMeta.referencia || descriptionMeta.contratoLinha || null,
      delivery_note: deliveryNote,
      invoice_no: idx.invoice >= 0 ? text(row[idx.invoice]) : null,
      di: idx.di >= 0 ? text(row[idx.di]) : null,
      batch_no: idx.batch >= 0 ? text(row[idx.batch]) : null,
      coc_no: idx.coc >= 0 ? text(row[idx.coc]) : null,
      status_documento: status,
      valor_unitario: unitPrice || null,
      valor_total_documento: totalPrice || null,
      moeda: headers.some((header) => /£|GBP/i.test(String(header || ''))) ? 'GBP' : null,
      dados_originais: {
        ...rawPayload(headers, row),
        DESCRIPTION_ORIGINAL: descriptionMeta.original || null,
        REFERENCIA_EXTRAIDA_DESCRICAO: descriptionMeta.referencia,
        FOC_EXTRAIDO_DESCRICAO: descriptionMeta.isFoc,
        WARRANTY_SPARES_EXTRAIDO_DESCRICAO: descriptionMeta.warranty,
        ORDEM_COMPRA_EXTRAIDA_DESCRICAO: descriptionMeta.ordemCompra,
        ITEM_ORDEM_COMPRA_EXTRAIDO_DESCRICAO: descriptionMeta.itemOrdemCompra,
        PROGRAMA_LOGISTICO_EXTRAIDO_DESCRICAO: descriptionMeta.programaLogistico,
        CONTRATO_LINHA_EXTRAIDO_DESCRICAO: descriptionMeta.contratoLinha,
        CONTEXTO_AERONAVE_EXTRAIDO_DESCRICAO: descriptionMeta.contextoAeronave || null,
        CODIGO_AUXILIAR_EXTRAIDO_DESCRICAO: descriptionMeta.codigoAuxiliar || null,
      },
    });
  });

  const expandedItems = expandSerializedReceiptItems(items, warnings);
  if (!expandedItems.length) throw new Error('Nenhum item válido com PN e quantidade foi encontrado no recibo.');

  if (!date) warnings.push('A data do recebimento não foi encontrada no documento e deverá ser preenchida por Admin ou Dono.');
  if (!origin) warnings.push('A origem/fornecedor não foi identificada com segurança e poderá ser preenchida manualmente.');
  if (!items.some((item) => item.localizacao_ppu)) warnings.push('O local temporário não consta no recibo e deverá ser preenchido antes do salvamento quando aplicável.');
  warnings.push('Quem recebeu, quem conferiu e observações operacionais permanecem em branco quando não estiverem efetivamente preenchidos no documento.');

  return {
    recibo_ref: receiptNumber,
    data_entrega_ref: date,
    is_foc: typeSignals.isFoc,
    tipo_recebimento: typeSignals.type,
    documento_referencia: contract,
    fornecedor: origin,
    origem_material: origin,
    programa_origem: programOrigin,
    programa_origem_fonte: programOrigin ? 'DOCUMENTO' : null,
    codigo_om_recebedora: receiver.codigoOm,
    sigla_recebedora: receiver.sigla,
    recebido_por_nome: null,
    conferido_por_nome: null,
    metodo_importacao: 'DOCUMENTO_ESTRUTURAL',
    arquivo_nome: file?.originalname || null,
    arquivo_hash: crypto.createHash('sha256').update(file?.buffer || Buffer.alloc(0)).digest('hex'),
    observacao_sugerida: joinObservation(globalObservation, warnings.length ? `Pendências de triagem: ${warnings.join(' | ')}` : null),
    avisos_triagem: warnings,
    dados_originais: {
      aba_selecionada: sheetName,
      abas_disponiveis: workbook.SheetNames,
      numero_interno: internalNumber,
      numero_nome_arquivo: fileNumber,
      contrato_extraido: contract,
      origem_extraida: origin,
      programa_origem_extraido: programOrigin,
      codigo_om_recebedora: receiver.codigoOm,
      sigla_recebedora: receiver.sigla,
      observacao_documento: globalObservation || null,
    },
    data_triagem: expandedItems,
  };
}

function getCfbStream(cfb, streamName) {
  const index = cfb.FullPaths.findIndex((path) => path.endsWith(`/${streamName}`) || path === streamName);
  if (index < 0 || !cfb.FileIndex[index]?.content) return null;
  return Buffer.from(cfb.FileIndex[index].content);
}

function extractLegacyDocText(buffer) {
  const cfb = XLSX.CFB.read(buffer, { type: 'buffer' });
  const word = getCfbStream(cfb, 'WordDocument');
  if (!word || word.length < 0x40) throw new Error('O arquivo DOC não contém o stream WordDocument esperado.');

  const flags = word.readUInt16LE(0x0A);
  const preferredTable = (flags & 0x0200) ? '1Table' : '0Table';
  const table = getCfbStream(cfb, preferredTable) || getCfbStream(cfb, '1Table') || getCfbStream(cfb, '0Table');
  if (!table) throw new Error('O arquivo DOC não contém a tabela de texto esperada.');

  let offset = 0x20;
  const csw = word.readUInt16LE(offset);
  offset += 2 + (csw * 2);
  const cslw = word.readUInt16LE(offset);
  offset += 2 + (cslw * 4);
  const pairCount = word.readUInt16LE(offset);
  offset += 2;
  if (pairCount <= 33) throw new Error('O arquivo DOC não possui a tabela de trechos de texto compatível.');

  const fcClx = word.readUInt32LE(offset + (33 * 8));
  const lcbClx = word.readUInt32LE(offset + (33 * 8) + 4);
  if (!lcbClx || fcClx + lcbClx > table.length) throw new Error('A estrutura de texto do DOC está inválida ou truncada.');

  const clx = table.subarray(fcClx, fcClx + lcbClx);
  let cursor = 0;
  while (cursor < clx.length && clx[cursor] === 0x01) {
    const groupLength = clx.readUInt16LE(cursor + 1);
    cursor += 3 + groupLength;
  }
  if (clx[cursor] !== 0x02) throw new Error('A tabela de trechos do DOC não foi localizada.');

  const plcLength = clx.readUInt32LE(cursor + 1);
  const plc = clx.subarray(cursor + 5, cursor + 5 + plcLength);
  const pieceCount = (plcLength - 4) / 12;
  if (!Number.isInteger(pieceCount) || pieceCount <= 0) throw new Error('A tabela de trechos do DOC possui tamanho inválido.');

  const cps = [];
  for (let index = 0; index <= pieceCount; index += 1) cps.push(plc.readUInt32LE(index * 4));
  const pcdStart = (pieceCount + 1) * 4;
  const decoder = new TextDecoder('windows-1252');
  let result = '';

  for (let index = 0; index < pieceCount; index += 1) {
    const characterCount = cps[index + 1] - cps[index];
    const pcdOffset = pcdStart + (index * 8);
    const rawFc = plc.readUInt32LE(pcdOffset + 2);
    const compressed = Boolean(rawFc & 0x40000000);
    let fileOffset = rawFc & 0x3FFFFFFF;
    if (compressed) fileOffset = Math.floor(fileOffset / 2);
    if (fileOffset < 0 || fileOffset >= word.length) continue;

    if (compressed) result += decoder.decode(word.subarray(fileOffset, fileOffset + characterCount));
    else result += word.subarray(fileOffset, fileOffset + (characterCount * 2)).toString('utf16le');
  }

  return result
    .replace(/\u0007/g, '\t')
    .replace(/\r/g, '\n')
    .replace(/\u000b|\u000c/g, '\n')
    .replace(/[\u0000-\u0006\u0008\u000e-\u001f]/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function legacyDocSchemaFromHeader(headerText = '') {
  const header = upper(headerText)
    .replace(/[“”]/g, '"')
    .replace(/\b\d+\s+(?=PD\b|PART NUMBER\b|QTY\b|UNIT\b|TOTAL\b|DI\b)/g, '')
    .replace(/\s+/g, ' ');
  // Assinatura tolerante a pontuação/aspas quebradas de DOC legado. O objetivo
  // não é inferir posições pelo formato visual, mas reconhecer a família do
  // cabeçalho antes de mapear qualquer célula como PART NUMBER.
  const canonical = header
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^A-Z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const hasPd = /(^|\s)PD\s+PART NUMBER/.test(header) || /\bPD PART NUMBER\b/.test(canonical);
  const hasDeliveryBs = /\bDELIVERY\s+BS\b/.test(header) || /\bDELIVERY BS\b/.test(canonical);
  const hasBatch = /\bBATCH\s*NO\b/.test(header) || /\bBATCH NO\b/.test(canonical);
  const hasCoc = /\bCOC\b/.test(canonical);
  const hasBs = /\bBS\b/.test(canonical);
  const hasCocBs = hasCoc && hasBs;

  // Schema lock: BATCH nunca pode cair silenciosamente no STANDARD. Se há
  // Batch, o cabeçalho precisa provar qual família está sendo usada.
  if (hasBatch) {
    if (hasDeliveryBs) {
      return {
        key: hasPd ? 'PD_DELIVERY_BATCH' : 'DELIVERY_BATCH',
        hasPd,
        columns: hasPd
          ? ['pd', 'pn', 'description', 'deliveryBs', 'deliveryO', 'batchNo', 'qty', 'invoice', 'unitPrice', 'totalPrice', 'di']
          : ['pn', 'description', 'deliveryBs', 'deliveryO', 'batchNo', 'qty', 'invoice', 'unitPrice', 'totalPrice', 'di'],
      };
    }
    if (hasCocBs) {
      return {
        key: 'COC_BATCH',
        hasPd: false,
        columns: ['pn', 'description', 'cocBs', 'batchNo', 'cocO', 'qty', 'invoice', 'unitPrice', 'totalPrice', 'di'],
      };
    }
    return null;
  }

  return {
    key: hasPd ? 'PD_STANDARD' : 'STANDARD',
    hasPd,
    columns: hasPd
      ? ['pd', 'pn', 'description', 'deliveryO', 'qty', 'invoice', 'unitPrice', 'totalPrice', 'di']
      : ['pn', 'description', 'deliveryO', 'qty', 'invoice', 'unitPrice', 'totalPrice', 'di'],
  };
}

function legacyDocHeader(textContent = '') {
  const source = String(textContent || '').replace(/\r/g, '\n');
  const pnIndex = source.search(/PART\s+NUMBER/i);
  if (pnIndex < 0) return null;

  // O cabeçalho termina na célula DI. Procuramos um DI delimitado por TAB
  // para não confundir com palavras/descrições que contenham essas letras.
  const afterPn = source.slice(pnIndex);
  const diMatch = /\t\s*(?:\d+\s*)?DI\b/i.exec(afterPn);
  if (!diMatch) return null;
  const headerEnd = pnIndex + diMatch.index + diMatch[0].length;
  const prefixStart = Math.max(0, pnIndex - 80);
  const headerText = source.slice(prefixStart, headerEnd);
  return { source, headerText, tableStart: headerEnd, schema: legacyDocSchemaFromHeader(headerText) };
}

function isLegacyDocRowPlausible(mapped, schema) {
  const pn = normalizePn(mapped.pn || '');
  const description = text(mapped.description);
  const qty = parseLocaleNumber(mapped.qty);
  const invoice = text(mapped.invoice).replace(/\D/g, '');
  const di = text(mapped.di).replace(/\s+/g, '');
  const pd = text(mapped.pd).replace(/\s+/g, '');

  if (!pn || pn.length > 80 || !description || qty <= 0) return false;
  if (schema.hasPd && !/^PD\d/i.test(pd)) return false;
  // Invoice/DI são âncoras fortes de estrutura. Quando presentes no modelo,
  // evitam transformar tokens soltos (SN, contrato, Delivery etc.) em PN.
  if (invoice && invoice.length < 5) return false;
  if (di && !/^\d{2}(?:\/|BR)[A-Z0-9./-]+$/i.test(di)) return false;

  // Âncoras específicas impedem que um deslocamento de células transforme
  // CoC/Batch/Delivery em PN. Se a família foi reconhecida, suas colunas
  // distintivas precisam estar presentes na mesma linha.
  if (schema.key === 'COC_BATCH') {
    if (!text(mapped.cocBs) || !text(mapped.batchNo) || !text(mapped.cocO)) return false;
  }
  if (schema.key === 'DELIVERY_BATCH' || schema.key === 'PD_DELIVERY_BATCH') {
    if (!text(mapped.deliveryBs) || !text(mapped.deliveryO) || !text(mapped.batchNo)) return false;
  }
  if (schema.key === 'STANDARD' || schema.key === 'PD_STANDARD') {
    if (!text(mapped.deliveryO)) return false;
  }
  return true;
}

function parseLegacyDocTable(textContent) {
  const header = legacyDocHeader(textContent);
  if (!header) {
    return {
      schema: null,
      rows: [],
      warning: 'A tabela PART NUMBER / DESCRIPTION / QTY não pôde ser reconstruída com segurança no DOC legado.',
    };
  }

  const { source, schema, tableStart } = header;
  if (!schema) {
    return {
      schema: null,
      rows: [],
      warning: 'O DOC contém Batch/BS, mas o cabeçalho não provou com segurança se a família é CoC/BS ou Delivery BS. Revisão obrigatória; nenhum PN foi inferido.',
    };
  }
  const tail = source.slice(tableStart);
  const footerIndex = tail.search(/\n\s*P[aá]gina\b|\n\s*RECEBIDO POR:|\n\s*-{5,}/i);
  const tableText = footerIndex >= 0 ? tail.slice(0, footerIndex) : tail;
  const cells = tableText
    .split('\t')
    .map((cell) => compact(cell).replace(/^\|+|\|+$/g, '').trim())
    .filter(Boolean);

  const width = schema.columns.length;
  const rows = [];
  let structuralMismatch = null;
  for (let index = 0; index + width - 1 < cells.length; index += width) {
    const raw = cells.slice(index, index + width);
    const mapped = Object.fromEntries(schema.columns.map((column, offset) => [column, raw[offset]]));
    if (isLegacyDocRowPlausible(mapped, schema)) {
      rows.push(mapped);
      continue;
    }
    // Schema lock fail-closed: NÃO deslizar uma célula para tentar "achar" um
    // novo PN. Esse comportamento foi a causa de CoC/Batch virarem PN quando o
    // layout era interpretado com largura incorreta. Ao primeiro grupo completo
    // incompatível, interrompemos e exigimos revisão.
    structuralMismatch = `A linha estrutural ${Math.floor(index / width) + 1} não corresponde ao schema ${schema.key}; o mapeamento foi interrompido para não deslocar PART NUMBER.`;
    break;
  }

  if (structuralMismatch && !rows.length) {
    return { schema, rows: [], warning: structuralMismatch };
  }
  return {
    schema,
    rows,
    warning: structuralMismatch || (rows.length ? null : `O cabeçalho ${schema.key} foi reconhecido, mas nenhuma linha completa passou pela validação estrutural.`),
  };
}

function legacyDocReviewResult({ fileName = '', fileBuffer = Buffer.alloc(0), content = '', requestedType, warning }) {
  const internalNumber = receiptNumberFromText(content);
  const fileNumber = receiptNumberFromFileName(fileName);
  const receiptNumber = internalNumber || fileNumber || buildFallbackReceiptNumber({ originalname: fileName, buffer: fileBuffer }, 'RECIBO');
  const date = extractDate(content);
  const signals = receiptTypeSignals(fileName, content, requestedType, false);
  const warnings = [...signals.warnings, warning || 'DOC legado exige revisão humana antes de qualquer gravação.'];
  return {
    recibo_ref: receiptNumber,
    data_entrega_ref: date,
    is_foc: signals.isFoc,
    tipo_recebimento: signals.type,
    documento_referencia: extractContractReference(content),
    fornecedor: extractOrigin(content),
    origem_material: extractOrigin(content),
    programa_origem: extractProgramOrigin(content),
    programa_origem_fonte: extractProgramOrigin(content) ? 'DOCUMENTO' : null,
    codigo_om_recebedora: extractReceivingOrganization(content).codigoOm,
    sigla_recebedora: extractReceivingOrganization(content).sigla,
    recebido_por_nome: null,
    conferido_por_nome: null,
    metodo_importacao: 'DOCUMENTO_ESTRUTURAL_DOC_REVIEW',
    arquivo_nome: fileName || null,
    arquivo_hash: crypto.createHash('sha256').update(fileBuffer).digest('hex'),
    observacao_sugerida: `Revisão obrigatória: ${warnings.join(' | ')}`,
    avisos_triagem: warnings,
    dados_originais: { formato: 'DOC_BINARIO_LEGADO_NAO_CONFIRMADO' },
    data_triagem: [],
    texto_extraido: content,
  };
}

function parseLegacyDocTextReceipt({ content, fileName = '', fileBuffer = Buffer.alloc(0), requestedType }) {
  const parsedTable = parseLegacyDocTable(content);
  if (!parsedTable.schema || !parsedTable.rows.length) {
    return legacyDocReviewResult({
      fileName,
      fileBuffer,
      content,
      requestedType,
      warning: parsedTable.warning,
    });
  }

  const { schema, rows } = parsedTable;
  const internalNumber = receiptNumberFromText(content);
  const fileNumber = receiptNumberFromFileName(fileName);
  const warnings = [];
  if (internalNumber && fileNumber && internalNumber !== fileNumber) {
    warnings.push(`O número dentro do documento (${internalNumber}) diverge do nome do arquivo (${fileNumber}). O sistema usou o número interno; confirme antes de salvar.`);
  }

  const signals = receiptTypeSignals(fileName, content, requestedType, schema.hasPd);
  warnings.push(...signals.warnings);
  const receiptNumber = internalNumber || fileNumber || buildFallbackReceiptNumber({ originalname: fileName, buffer: fileBuffer }, signals.type);
  const date = extractDate(content);
  const receiptYear = Number(String(receiptNumber).match(/\/(\d{4})$/)?.[1]);
  const dateYear = date ? Number(date.slice(0, 4)) : null;
  if (receiptYear && dateYear && receiptYear !== dateYear) {
    warnings.push(`A data extraída (${date.split('-').reverse().join('/')}) não pertence ao mesmo ano do recibo ${receiptNumber}. Confirme a data manualmente.`);
  }
  if (!date) warnings.push('A data do recebimento não foi encontrada e deverá ser preenchida por Admin ou Dono.');

  const contract = extractContractReference(content);
  const origin = extractOrigin(content);
  const receiver = extractReceivingOrganization(content);
  const programOrigin = extractProgramOrigin(content);

  const documentItems = rows.map((row, index) => {
    const descriptionMeta = parseDescriptionMetadata(row.description);
    const serials = extractSerials(row.description);
    const predictedDestination = inferPredictedDestination({ pd: row.pd, receiver, fullText: content });
    const delivery = row.deliveryO || row.cocO || '';
    const coc = row.cocBs || '';
    return {
      id_temp: index,
      sequencia_item: index + 1,
      documento_referencia: text(row.pd) || descriptionMeta.referencia || descriptionMeta.contratoLinha || null,
      pn: normalizePn(row.pn),
      nomenclatura: descriptionMeta.nomenclatura,
      quantidade: parseLocaleNumber(row.qty),
      sn: serials.join(', '),
      sns_pre_carregados: serials,
      localizacao_ppu: predictedDestination.destino === 'CEIMSPA' && receiver.sigla === 'CEIMSPA' ? 'CEIMSPA' : '',
      destino_previsto: predictedDestination.destino,
      destino_previsto_fonte: predictedDestination.fonte,
      condicao_item: 'RECEBIDO_DISPONIVEL',
      validade_status: 'NAO_INFORMADA',
      validade_observacao: null,
      sn_extraido_documento: serials.length > 0,
      observacao_item: '',
      inventariado_ppu: false,
      quantidade_inventariada: 0,
      delivery_note: text(delivery),
      invoice_no: text(row.invoice),
      di: text(row.di),
      batch_no: text(row.batchNo) || null,
      coc_no: text(coc) || null,
      status_documento: null,
      valor_unitario: parseLocaleNumber(row.unitPrice) || null,
      valor_total_documento: parseLocaleNumber(row.totalPrice) || null,
      moeda: 'GBP',
      is_foc_item: descriptionMeta.isFoc,
      dados_originais: {
        esquema_doc: schema.key,
        PD: row.pd || null,
        'PART NUMBER': row.pn,
        DESCRIPTION: row.description,
        NOMENCLATURA_NORMALIZADA: descriptionMeta.nomenclatura,
        REFERENCIA_EXTRAIDA_DESCRICAO: descriptionMeta.referencia,
        FOC_EXTRAIDO_DESCRICAO: descriptionMeta.isFoc,
        WARRANTY_SPARES_EXTRAIDO_DESCRICAO: descriptionMeta.warranty,
        ORDEM_COMPRA_EXTRAIDA_DESCRICAO: descriptionMeta.ordemCompra,
        ITEM_ORDEM_COMPRA_EXTRAIDO_DESCRICAO: descriptionMeta.itemOrdemCompra,
        PROGRAMA_LOGISTICO_EXTRAIDO_DESCRICAO: descriptionMeta.programaLogistico,
        CONTRATO_LINHA_EXTRAIDO_DESCRICAO: descriptionMeta.contratoLinha,
        CONTEXTO_AERONAVE_EXTRAIDO_DESCRICAO: descriptionMeta.contextoAeronave || null,
        CODIGO_AUXILIAR_EXTRAIDO_DESCRICAO: descriptionMeta.codigoAuxiliar || null,
        'DELIVERY BS': row.deliveryBs || null,
        'DELIVERY O.': row.deliveryO || null,
        'CoC BS': row.cocBs || null,
        'CoC O.': row.cocO || null,
        'Batch No': row.batchNo || null,
        QTY: row.qty,
        'INVOICE No.': row.invoice,
        'UNIT PRICE £': row.unitPrice,
        'TOTAL P. £': row.totalPrice,
        DI: row.di,
      },
    };
  }).filter((item) => item.pn && item.quantidade > 0);

  const items = expandSerializedReceiptItems(documentItems, warnings);

  if (!items.length) {
    return legacyDocReviewResult({
      fileName,
      fileBuffer,
      content,
      requestedType,
      warning: 'Nenhuma linha completa do DOC passou pelo gate estrutural de PN/quantidade/referências.',
    });
  }

  return {
    recibo_ref: receiptNumber,
    data_entrega_ref: date,
    is_foc: signals.isFoc,
    tipo_recebimento: signals.type,
    documento_referencia: contract,
    fornecedor: origin,
    origem_material: origin,
    programa_origem: programOrigin,
    programa_origem_fonte: programOrigin ? 'DOCUMENTO' : null,
    codigo_om_recebedora: receiver.codigoOm,
    sigla_recebedora: receiver.sigla,
    recebido_por_nome: null,
    conferido_por_nome: null,
    metodo_importacao: `DOCUMENTO_ESTRUTURAL_DOC_${schema.key}`,
    arquivo_nome: fileName || null,
    arquivo_hash: crypto.createHash('sha256').update(fileBuffer).digest('hex'),
    observacao_sugerida: warnings.length ? `Pendências de triagem: ${warnings.join(' | ')}` : null,
    avisos_triagem: warnings,
    dados_originais: {
      numero_interno: internalNumber,
      numero_nome_arquivo: fileNumber,
      contrato_extraido: contract,
      origem_extraida: origin,
      programa_origem_extraido: programOrigin,
      codigo_om_recebedora: receiver.codigoOm,
      sigla_recebedora: receiver.sigla,
      formato: 'DOC_BINARIO_LEGADO',
      esquema_tabela: schema.key,
      linhas_tabela: items.length,
    },
    data_triagem: items,
    texto_extraido: content,
  };
}

function parseLegacyDocReceipt({ file, requestedType }) {
  const content = extractLegacyDocText(file.buffer);
  return parseLegacyDocTextReceipt({
    content,
    fileName: file.originalname || '',
    fileBuffer: file.buffer,
    requestedType,
  });
}

function normalizeSpacedDigits(value = '') {
  return String(value || '').replace(/\s+/g, '');
}

function bondedStoreReceiptNumber(fullText = '', fileName = '') {
  const source = String(fullText || '');
  const match = source.match(/\bREF\s*:\s*([0-9\s]{1,8})\/\s*([0-9\s]{4,8})/i);
  if (match) {
    const number = normalizeSpacedDigits(match[1]);
    const year = normalizeSpacedDigits(match[2]).slice(0, 4);
    if (/^\d{1,4}$/.test(number) && /^20\d{2}$/.test(year)) return `${number.padStart(3, '0')}/${year}`;
  }
  return receiptNumberFromFileName(fileName);
}

function bondedStoreReceiptDate(fullText = '') {
  const source = String(fullText || '');
  const match = source.match(/received\s+into\s+the\s+Bonded\s+Store\s+on\s+([0-9\s]{1,6})\/\s*([0-9\s]{1,6})\/\s*([0-9\s]{4,8})/i);
  if (!match) return null;
  const day = normalizeSpacedDigits(match[1]);
  const month = normalizeSpacedDigits(match[2]);
  const year = normalizeSpacedDigits(match[3]).slice(0, 4);
  if (!/^\d{1,2}$/.test(day) || !/^\d{1,2}$/.test(month) || !/^20\d{2}$/.test(year)) return null;
  return `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
}

function bondedStoreDi(fullText = '') {
  const source = compact(fullText);
  const match = source.match(/\bDI\s+N\s*o\s*\.\s*([0-9A-Z./-]+)/i) || source.match(/\bDI\s+No\.?\s*[:.-]?\s*([0-9A-Z./-]+)/i);
  return match ? text(match[1]) : null;
}

function parseBondedStoreDocxReceipt({ file, requestedType }) {
  const office = extractOfficeDocument(file.buffer, file.originalname || 'recibo.docx');
  const fullText = office.text || '';
  if (!/BONDED\s+STORE/i.test(fullText) || !/RECEIPT\s+OF\s+MATERIAL\s+FORM/i.test(fullText)) {
    throw new Error('DOCX não corresponde ao modelo estruturado Bonded Store / Receipt of Material.');
  }

  const rows = Array.isArray(office.tableRows) ? office.tableRows : [];
  const headerIndex = rows.findIndex((row) => {
    const normalized = row.map((cell) => upper(cell));
    return normalized.includes('PART NUMBER') && normalized.includes('DESCRIPTION') && normalized.some((cell) => /DELIVERY/.test(cell)) && normalized.includes('QTY');
  });
  if (headerIndex < 0) throw new Error('Tabela PART NUMBER / DESCRIPTION / QTY não encontrada no DOCX Bonded Store.');

  const dataRows = rows.slice(headerIndex + 1).filter((row) => row.length >= 8 && normalizePn(row[0] || ''));
  if (!dataRows.length) throw new Error('Nenhum item foi localizado na tabela do DOCX Bonded Store.');

  const receiptNumber = bondedStoreReceiptNumber(fullText, file.originalname);
  const date = bondedStoreReceiptDate(fullText);
  const di = bondedStoreDi(fullText);
  const warnings = [];
  if (!receiptNumber) warnings.push('Número do Receipt of Material não pôde ser confirmado automaticamente.');
  if (!date) warnings.push('Data do recebimento não pôde ser confirmada automaticamente.');

  const documentItems = dataRows.map((row, index) => {
    const [pn, description, reference, itemRef, foc, deliveryNo, qty, invoiceNo] = row;
    const descriptionMeta = parseDescriptionMetadata(description);
    const serials = extractSerials(description);
    return {
      id_temp: index,
      sequencia_item: index + 1,
      documento_referencia: text(reference),
      pn: normalizePn(pn),
      nomenclatura: descriptionMeta.nomenclatura,
      quantidade: parseLocaleNumber(qty),
      sn: serials.join(', '),
      sns_pre_carregados: serials,
      localizacao_ppu: '',
      destino_previsto: null,
      destino_previsto_fonte: null,
      condicao_item: 'RECEBIDO_DISPONIVEL',
      validade_status: 'NAO_INFORMADA',
      validade_observacao: null,
      sn_extraido_documento: serials.length > 0,
      observacao_item: '',
      inventariado_ppu: false,
      quantidade_inventariada: 0,
      delivery_note: text(deliveryNo),
      invoice_no: text(invoiceNo),
      di: di || '',
      batch_no: null,
      coc_no: null,
      status_documento: null,
      valor_unitario: null,
      valor_total_documento: null,
      moeda: 'GBP',
      is_foc_item: /^(YES|Y|SIM|S)$/i.test(text(foc)),
      dados_originais: {
        'PART NUMBER': pn,
        DESCRIPTION: description,
        NOMENCLATURA_NORMALIZADA: descriptionMeta.nomenclatura,
        REFERENCIA_EXTRAIDA_DESCRICAO: descriptionMeta.referencia,
        FOC_EXTRAIDO_DESCRICAO: descriptionMeta.isFoc,
        WARRANTY_SPARES_EXTRAIDO_DESCRICAO: descriptionMeta.warranty,
        ORDEM_COMPRA_EXTRAIDA_DESCRICAO: descriptionMeta.ordemCompra,
        ITEM_ORDEM_COMPRA_EXTRAIDO_DESCRICAO: descriptionMeta.itemOrdemCompra,
        PROGRAMA_LOGISTICO_EXTRAIDO_DESCRICAO: descriptionMeta.programaLogistico,
        CONTRATO_LINHA_EXTRAIDO_DESCRICAO: descriptionMeta.contratoLinha,
        CONTEXTO_AERONAVE_EXTRAIDO_DESCRICAO: descriptionMeta.contextoAeronave || null,
        CODIGO_AUXILIAR_EXTRAIDO_DESCRICAO: descriptionMeta.codigoAuxiliar || null,
        REFERENCE: reference,
        ITEM: itemRef,
        FOC: foc,
        'DELIVERY No.': deliveryNo,
        QTY: qty,
        'INVOICE No.': invoiceNo,
        DI: di,
      },
    };
  }).filter((item) => item.pn && item.quantidade > 0);

  const items = expandSerializedReceiptItems(documentItems, warnings);
  const hasPdReference = items.some((item) => /^PD\d/i.test(String(item.documento_referencia || '').replace(/\s+/g, '')));
  const warranty = /\bWARRANTY\b|\bGARANTIA\b/i.test(`${file.originalname || ''} ${fullText}`);
  const isFoc = items.some((item) => item.is_foc_item);
  let type = 'MATERIAL';
  if (requestedType === 'recibo_pd' || hasPdReference) type = 'PD';
  else if (warranty) type = 'GARANTIA';

  return {
    recibo_ref: receiptNumber || buildFallbackReceiptNumber(file, type),
    data_entrega_ref: date,
    is_foc: isFoc,
    tipo_recebimento: type,
    documento_referencia: null,
    fornecedor: null,
    origem_material: null,
    programa_origem: /BRAZIL\s+7\s*&\s*8\s+PLANNING\s+REMOVAL/i.test(fullText) ? 'BRAZIL 7&8 PLANNING REMOVAL' : null,
    programa_origem_fonte: /BRAZIL\s+7\s*&\s*8\s+PLANNING\s+REMOVAL/i.test(fullText) ? 'DOCUMENTO' : null,
    codigo_om_recebedora: null,
    sigla_recebedora: null,
    recebido_por_nome: null,
    conferido_por_nome: null,
    metodo_importacao: 'DOCUMENTO_ESTRUTURAL_DOCX_BONDED_STORE',
    arquivo_nome: file.originalname || null,
    arquivo_hash: crypto.createHash('sha256').update(file.buffer).digest('hex'),
    observacao_sugerida: warnings.length ? `Pendências de triagem: ${warnings.join(' | ')}` : null,
    avisos_triagem: warnings,
    dados_originais: {
      formato: 'DOCX_BONDED_STORE',
      numero_extraido: receiptNumber,
      data_extraida: date,
      di_extraida: di,
      linhas_tabela: items.length,
    },
    data_triagem: items,
    texto_extraido: fullText,
  };
}

function parseReceiptDocument({ file, requestedType, workbook = null }) {
  if (!file?.buffer) throw new Error('Arquivo do recibo não enviado.');
  const name = String(file.originalname || '').toLowerCase();
  if (name.endsWith('.doc')) return parseLegacyDocReceipt({ file, requestedType });
  if (name.endsWith('.docx')) return parseBondedStoreDocxReceipt({ file, requestedType });
  const parsedWorkbook = workbook || XLSX.read(file.buffer, { type: 'buffer' });
  return parseSpreadsheetReceipt({ workbook: parsedWorkbook, file, requestedType });
}

module.exports = {
  parseReceiptDocument,
  parseSpreadsheetReceipt,
  parseLegacyDocReceipt,
  parseLegacyDocTextReceipt,
  parseLegacyDocTable,
  legacyDocSchemaFromHeader,
  parseBondedStoreDocxReceipt,
  extractLegacyDocText,
  extractSerials,
  parseDescriptionMetadata,
  extractInlineContractReference,
  expandSerializedReceiptItems,
  serialsFromItem,
  parseLocaleNumber,
  extractReceivingOrganization,
  extractProgramOrigin,
  inferPredictedDestination,
  classifyValidity,
  receiptTypeSignals,
};
