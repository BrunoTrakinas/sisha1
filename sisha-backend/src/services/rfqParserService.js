const xlsx = require('xlsx');
const pdfParse = require('pdf-parse');
const {
  extractTextFromImagesWithAi,
  extractCommercialTableFromPdfWithAi,
  extractRepairOverhaulTranscriptFromPdfWithAi,
  extractTextFromPdfWithAi,
  extractRfqDataWithAi,
  compactText,
} = require('./chatLinceService');
const {
  classifyCommercialDocument,
  looksLikeLeonardoQuotation,
  parseDeterministicCommercialDocument,
} = require('./commercialDocumentDeterministicService');
const {
  renderPdfPageWithLayout,
  looksLikeLeonardoQuotationHeader,
} = require('./pdfLayoutTextService');
const {
  normalizeVisualRepairOverhaulPayload,
  normalizeFocusedRepairOverhaulTranscript,
} = require('./commercialVisualTableService');
const {
  extractScannedRepairOverhaulWithLocalOcr,
} = require('./commercialLocalOcrService');

function safeString(value) {
  const text = value == null ? '' : String(value).trim();
  return text || '';
}

function normalizePn(value) {
  return safeString(value).toUpperCase();
}

function parseNumber(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  let text = safeString(value).replace(/\s/g, '');
  if (!text) return 0;
  if (text.includes(',') && text.includes('.')) {
    const comma = text.lastIndexOf(',');
    const dot = text.lastIndexOf('.');
    text = comma > dot ? text.replace(/\./g, '').replace(',', '.') : text.replace(/,/g, '');
  } else if (text.includes(',')) {
    text = text.replace(',', '.');
  }
  const parsed = Number(text.replace(/[^0-9.-]/g, ''));
  return Number.isFinite(parsed) ? parsed : 0;
}

function extractJpegImagesFromPdfBuffer(buffer, maxImages = 8) {
  const images = [];
  if (!Buffer.isBuffer(buffer) || !buffer.length) return images;
  const startMarker = Buffer.from([0xff, 0xd8]);
  const endMarker = Buffer.from([0xff, 0xd9]);
  let offset = 0;
  while (images.length < maxImages) {
    const start = buffer.indexOf(startMarker, offset);
    if (start === -1) break;
    const end = buffer.indexOf(endMarker, start + 2);
    if (end === -1) break;
    const imageBuffer = buffer.subarray(start, end + 2);
    offset = end + 2;
    if (imageBuffer.length < 25000) continue;
    images.push({ mime: 'image/jpeg', base64: imageBuffer.toString('base64') });
  }
  return images;
}

function workbookToText(buffer) {
  const workbook = xlsx.read(buffer, { type: 'buffer' });
  let text = '';
  workbook.SheetNames.forEach((sheetName) => {
    const sheet = workbook.Sheets[sheetName];
    const rows = xlsx.utils.sheet_to_json(sheet, { header: 1, defval: '' });
    rows.forEach((row) => {
      const clean = row
        .map((cell) => String(cell ?? '').replace(/\r?\n/g, ' ').trim())
        .filter(Boolean)
        .join(' | ');
      if (clean) text += `${clean} `;
    });
  });
  return compactText(text, 50000);
}

async function extractSourceText(file) {
  const name = safeString(file?.originalname).toLowerCase();
  const mime = safeString(file?.mimetype).toLowerCase();
  const isPdf = name.endsWith('.pdf') || mime.includes('pdf');

  if (isPdf) {
    const parsed = await pdfParse(file.buffer);
    const text = compactText(parsed?.text || '', 120000);

    // C2.3: Quotation Leonardo exige reconstrução por coordenadas. O pdf-parse padrão
    // pode devolver tabelas em ordem interna/por coluna (1,2,3... antes dos PNs),
    // que é visualmente falsa. Reconstruímos Y->X e só então interpretamos os itens.
    if (text && looksLikeLeonardoQuotationHeader(text, file.originalname || '')) {
      try {
        const layoutParsed = await pdfParse(file.buffer, { pagerender: renderPdfPageWithLayout });
        const layoutText = compactText(layoutParsed?.text || '', 180000);
        if (layoutText && layoutText.length >= 80) {
          return { text: layoutText, method: 'PDF_LAYOUT_COORDENADAS' };
        }
      } catch (layoutError) {
        // Não voltamos ao parser genérico. O Fidelity Gate abaixo reconhecerá o cabeçalho
        // Leonardo e bloqueará a gravação caso a tabela visual não possa ser reconstruída.
        console.warn('[SISHA][rfq] Falha ao reconstruir layout da Quotation Leonardo:', layoutError.message || layoutError);
      }
    }

    if (text && text.length >= 80) return { text, method: 'PDF_TEXTO' };

    // C2.7: para PDF comercial escaneado, PN e preço deixam de ser extraídos
    // primariamente por IA generativa. O SISHA tenta OCR local determinístico
    // (Poppler -> Tesseract -> coordenadas da tabela -> validação célula a célula).
    // Se uma carta Repair/Overhaul for reconhecida, esse resultado é AUTORITATIVO:
    // sucesso segue para o parser determinístico; ambiguidade bloqueia.
    const localOcr = await extractScannedRepairOverhaulWithLocalOcr({
      buffer: file.buffer,
      fileName: file.originalname || 'documento-comercial.pdf',
    });
    if (localOcr.recognized) {
      if (localOcr.valid) {
        return {
          text: compactText(localOcr.transcript, 350000),
          method: 'OCR_LOCAL_TESSERACT_POPPLER',
          visualCommercial: localOcr,
        };
      }
      return {
        text: '',
        method: localOcr.unavailable ? 'OCR_LOCAL_INDISPONIVEL_BLOQUEADO' : 'OCR_LOCAL_REVIEW_BLOQUEADO',
        visualCommercial: localOcr,
      };
    }

    // Se o OCR local nem sequer está disponível, um PDF comercial sem camada textual
    // não é liberado para IA preencher PN/preço. É melhor bloquear do que fabricar
    // uma tabela plausível. PDFs não reconhecidos só chegam aos fallbacks abaixo
    // quando o motor local ESTÁ disponível e efetivamente não classificou a carta.
    if (localOcr.unavailable) {
      return {
        text: '',
        method: 'OCR_LOCAL_INDISPONIVEL_BLOQUEADO',
        visualCommercial: {
          ...localOcr,
          recognized: true,
          valid: false,
          blocking: [
            ...(localOcr.blocking || []),
            'PDF comercial escaneado bloqueado: o SISHA não usa IA generativa como substituto do OCR local para definir PN ou preço.',
          ],
        },
      };
    }

    // C2.5: PDF escaneado sem camada textual tenta primeiro um contrato visual ESTRUTURADO
    // específico para cartas Leonardo Fixed Price Repair / Overhaul. O retorno é validado
    // antes de virar texto determinístico; Termos e Condições nunca entram como linhas de preço.
    const structuredVisual = await extractCommercialTableFromPdfWithAi({
      buffer: file.buffer,
      fileName: file.originalname || 'documento-comercial.pdf',
    });
    if (structuredVisual.ok) {
      const normalizedVisual = normalizeVisualRepairOverhaulPayload(structuredVisual.payload, file.originalname || '');
      if (normalizedVisual.recognized) {
        if (normalizedVisual.valid) {
          return {
            text: compactText(normalizedVisual.transcript, 350000),
            method: `CHAT_LINCE_PDF_VISUAL_ESTRUTURADO:${structuredVisual.model || 'IA'}:${structuredVisual.engine || 'file-parser'}`,
            visualCommercial: normalizedVisual,
          };
        }
        return {
          text: '',
          method: `CHAT_LINCE_PDF_VISUAL_BLOQUEADO:${structuredVisual.model || 'IA'}:${structuredVisual.engine || 'file-parser'}`,
          visualCommercial: normalizedVisual,
        };
      }
    }

    // C2.6: o contrato JSON do provider pode falhar mesmo quando o PDF é visualmente legível.
    // Nessa situação fazemos uma SEGUNDA leitura do mesmo PDF em contrato textual rígido,
    // focado exclusivamente no Attachment 1 de Fixed Price Repair/Overhaul.
    const focusedVisual = await extractRepairOverhaulTranscriptFromPdfWithAi({
      buffer: file.buffer,
      fileName: file.originalname || 'documento-comercial.pdf',
    });
    if (focusedVisual.ok) {
      const focusedNormalized = normalizeFocusedRepairOverhaulTranscript(focusedVisual.text, file.originalname || '');
      if (focusedNormalized.recognized) {
        if (focusedNormalized.valid) {
          return {
            text: compactText(focusedNormalized.transcript, 350000),
            method: `CHAT_LINCE_PDF_VISUAL_FOCADO:${focusedVisual.model || 'IA'}:${focusedVisual.engine || 'file-parser'}`,
            visualCommercial: focusedNormalized,
          };
        }
        return {
          text: '',
          method: `CHAT_LINCE_PDF_VISUAL_FOCADO_BLOQUEADO:${focusedVisual.model || 'IA'}:${focusedVisual.engine || 'file-parser'}`,
          visualCommercial: focusedNormalized,
        };
      }
    }

    // Só agora tentamos transcrição comercial genérica. Porém ela não tem permissão para
    // transformar uma carta Repair/Overhaul reconhecível em "Documento comercial genérico".
    // Se a própria transcrição revelar a assinatura da carta, tentamos parser determinístico;
    // se a tabela não fechar, bloqueamos em vez de cair no merge genérico/IA.
    const pdfVisual = await extractTextFromPdfWithAi({
      buffer: file.buffer,
      fileName: file.originalname || 'documento-comercial.pdf',
      tipoDocumento: 'DOCUMENTO_COMERCIAL',
      prompt: [
        'Extraia fielmente o conteúdo comercial do PDF e preserve a ordem por página.',
        'Dê prioridade às páginas iniciais e ao Attachment 1 com qualquer tabela Fixed Price Repair / Overhaul.',
        'Se houver tabela, transcreva cada linha como: Description | Part Number | Repair Price | Overhaul Price.',
        'Não use números ou valores de Terms and Conditions como linhas comerciais.',
        'Não invente preço, PN, NSN, validade ou relação entre PNs. Quando ilegível, marque [REVISAR].',
      ].join('\n'),
    });
    if (pdfVisual.ok) {
      const genericText = compactText(pdfVisual.text, 350000);
      const genericType = classifyCommercialDocument(genericText, file.originalname || '');
      if (genericType === 'LEONARDO_REPAIR_PRICE_LETTER') {
        const rescue = parseDeterministicCommercialDocument({
          text: genericText,
          fileName: file.originalname || '',
          documentType: 'LEONARDO_REPAIR_PRICE_LETTER',
        });
        if (rescue?.items?.length) {
          return {
            text: genericText,
            method: `CHAT_LINCE_PDF_VISUAL_RESCUE:${pdfVisual.model || 'IA'}:${pdfVisual.engine || 'file-parser'}`,
          };
        }
        return {
          text: '',
          method: `CHAT_LINCE_PDF_REPAIR_RECONHECIDO_BLOQUEADO:${pdfVisual.model || 'IA'}:${pdfVisual.engine || 'file-parser'}`,
          visualCommercial: {
            recognized: true,
            valid: false,
            blocking: ['Carta Leonardo Fixed Price Repair/Overhaul reconhecida na transcrição genérica, mas a tabela não fechou de forma determinística.'],
            warnings: [],
            rows: [],
            transcript: '',
          },
        };
      }
      return { text: genericText, method: `CHAT_LINCE_PDF:${pdfVisual.model || 'IA'}:${pdfVisual.engine || 'file-parser'}` };
    }

    // Nome Leonardo/LUKL/LHUK em PDF escaneado sem texto + duas tentativas visuais falhas:
    // não permitimos degradação silenciosa para parser genérico.
    if (/(?:^|[^A-Z])(LUKL|LHUK|LEONARDO)/i.test(file.originalname || '')) {
      return {
        text: '',
        method: 'PDF_ESCANEADO_LEONARDO_BLOQUEADO',
        visualCommercial: {
          recognized: true,
          valid: false,
          blocking: ['PDF Leonardo escaneado não pôde ser estruturado com segurança. O documento foi bloqueado para evitar 0 itens/genérico ou preços incorretos.'],
          warnings: [],
          rows: [],
          transcript: '',
        },
      };
    }

    // Fallback de contingência para PDFs que encapsulam páginas como JPEGs.
    const images = extractJpegImagesFromPdfBuffer(file.buffer, 8);
    const visual = await extractTextFromImagesWithAi({
      images,
      fileName: file.originalname || 'cotacao.pdf',
      tipoDocumento: 'DOCUMENTO_COMERCIAL',
    });
    if (visual.ok) return { text: compactText(visual.text, 50000), method: `CHAT_LINCE_VISUAL:${visual.model || 'IA'}` };

    const error = new Error(`Não foi possível ler o PDF comercial. ${pdfVisual.reason || visual.reason || 'O documento pode estar escaneado e o leitor visual não está configurado.'}`);
    error.statusCode = 400;
    throw error;
  }

  return { text: workbookToText(file.buffer), method: 'PLANILHA_ESTRUTURAL' };
}

function parseMetadata(text) {
  const flat = compactText(text, 50000).replace(/\s+/g, ' ');
  const dateToken = '[0-9]{1,4}[./-][0-9]{1,2}[./-][0-9]{1,4}';

  // PDFs de cotação podem posicionar endereço entre o rótulo e o valor.
  // Limitamos a captura até o próximo rótulo para não confundir a cotação atual
  // com a linha "Quotation no./Date" de uma cotação anterior.
  const numberBlock = flat.match(/Number\/Date\b([\s\S]{0,220}?)(?=Reference\s+no\.\/Date|$)/i)?.[1] || '';
  const quoteMatch = numberBlock.match(new RegExp('([A-Z0-9-]{5,})\\s*\\/\\s*(' + dateToken + ')', 'i'))
    || flat.match(new RegExp('Quotation\\s+(?:Number\\/Date|Number)\\b[\\s\\S]{0,120}?([A-Z0-9-]{5,})\\s*\\/\\s*(' + dateToken + ')', 'i'));

  const referenceBlock = flat.match(/Reference\s+no\.\/Date\b([\s\S]{0,260}?)(?=Contract\s+Reference|Quotation\s+no\.\/Date|Validity\s+period|$)/i)?.[1] || '';
  const refMatch = referenceBlock.match(new RegExp('((?:Q|RFQ)?[A-Z0-9]+(?:\\s*-\\s*[A-Z0-9]+)+)\\s*\\/\\s*' + dateToken, 'i'))
    || referenceBlock.match(new RegExp('([^/]{2,80}?)\\s*\\/\\s*' + dateToken, 'i'));

  const valMatch = flat.match(new RegExp('Validity\\s+period\\b[\\s\\S]{0,120}?(' + dateToken + '\\s*(?:to|a)\\s*' + dateToken + ')', 'i'));

  return {
    quotation_number: quoteMatch ? safeString(quoteMatch[1]) : 'N/A',
    quotation_date: quoteMatch ? safeString(quoteMatch[2]) : 'N/A',
    reference: refMatch ? safeString(refMatch[1]).replace(/\s+/g, ' ') : 'N/A',
    validity: valMatch ? safeString(valMatch[1]).replace(/\s+to\s+/i, ' a ') : 'N/A',
    condicao: '',
    moeda: 'GBP',
    fornecedor: /Leonardo\s+UK\s+Ltd/i.test(flat) ? 'LEONARDO UK LTD' : '',
    tipo_cotacao: 'MATERIAL',
  };
}

function findPnRelations(text) {
  const flat = compactText(text, 50000).replace(/\s+/g, ' ');
  const relations = [];
  const patterns = [
    {
      regex: /P\/?N\s+([A-Z0-9./-]+)\s+is\s+super(?:s|c)eded\s+by\s+P\/?N\s+([A-Z0-9./-]+)/gi,
      type: 'SUPERSEDED_BY',
    },
    {
      regex: /P\/?N\s+([A-Z0-9./-]+)\s+(?:is\s+)?(?:replaced\s+by|replacement\s+P\/?N)\s+P?\/?N?\s*([A-Z0-9./-]+)/gi,
      type: 'SUPERSEDED_BY',
    },
    {
      regex: /P\/?N\s+([A-Z0-9./-]+).*?(?:alternative|alternate)\s+P\/?N\s*[:\-]?\s*([A-Z0-9./-]+)/gi,
      type: 'ALTERNATIVO',
    },
    {
      regex: /P\/?N\s+([A-Z0-9./-]+).*?equivalent\s+P\/?N\s*[:\-]?\s*([A-Z0-9./-]+)/gi,
      type: 'EQUIVALENTE',
    },
  ];

  patterns.forEach(({ regex, type }) => {
    let match;
    while ((match = regex.exec(flat)) !== null) {
      const pn = normalizePn(match[1]);
      const related = normalizePn(match[2]);
      if (!pn || !related || pn === related) continue;
      relations.push({ pn, pn_relacionado: related, tipo_relacao_pn: type, relacao_pn_texto: safeString(match[0]).slice(0, 500) });
    }
  });
  return relations;
}

function parseItems(text) {
  const flat = compactText(text, 50000).replace(/\s+/g, ' ');
  const items = [];
  const qtyRegex = /(\d+(?:[.,]\d{3})?)\s*N\b/g;
  const matches = [...flat.matchAll(qtyRegex)];
  const ignored = ['MATERIAL', 'NUMBER', 'DATE', 'VALIDITY', 'PERIOD', 'LEAD', 'TIME', 'STOCK', 'QUANTITY', 'AVAILABLE', 'PRICE', 'VALUE', 'TOTAL', 'AMOUNT', 'PAGE', 'ITEM', 'DESCRIPTION', 'REFERENCE', 'UNDER', 'INVESTIGATION', 'AWAITING', 'EACH', 'DAYS', 'WEEKS', 'QUOTATION'];

  matches.forEach((match, index) => {
    let start = index === 0 ? 0 : matches[index - 1].index + matches[index - 1][0].length;
    const end = match.index;
    let middle = flat.substring(start, end);
    if (index === 0) {
      const headerEnd = Math.max(middle.lastIndexOf('Value'), middle.lastIndexOf('Price'));
      if (headerEnd !== -1) middle = middle.substring(headerEnd + 5);
    }

    const qty = parseNumber(match[1]);
    const after = flat.substring(end + match[0].length, end + match[0].length + 80);
    const priceMatch = after.match(/^\s*\|?\s*([\d,]+\.\d{2})/);
    let unitPrice = priceMatch ? parseNumber(priceMatch[1]) : 0;
    if (!unitPrice) {
      const fallback = middle.match(/([\d,]+\.\d{2})\s*\|?\s*$/);
      if (fallback) unitPrice = parseNumber(fallback[1]);
    }

    const nsnMatch = middle.match(/\b\d{4}-\d{2}-\d{3}-\d{4}\b/);
    const nsn = nsnMatch ? nsnMatch[0] : '';
    const textNoNsn = middle.replace(/\b\d{4}-\d{2}-\d{3}-\d{4}\b/g, ' ').replace(/\b\d{1,2}[./]\d{1,2}[./]\d{4}\b/g, ' ');
    const pnMatches = [...textNoNsn.matchAll(/\b([A-Z0-9][A-Z0-9-./()]{3,})\b/g)].map((m) => m[1]);
    let pn = '';
    for (const candidate of pnMatches) {
      const clean = candidate.replace(/[()]/g, '').toUpperCase();
      if (/\d/.test(clean) && !/^\d+$/.test(clean) && !ignored.includes(clean)) {
        pn = clean;
        break;
      }
    }

    const stockMatch = middle.match(/Available\s+Stock\s+Quantity\s+(\d+(?:\.\d+)?)/i) || middle.match(/Stock\s+Quantity\s+(\d+(?:\.\d+)?)/i);
    const readyStock = stockMatch ? parseNumber(stockMatch[1]) : 0;

    let leadDays = 0;
    const leadMatch = middle.match(/(?:Lead\s*Time\s*)?(\d{1,3})\s*(?:week|weeks|wk|wks)\b/i);
    if (leadMatch) leadDays = Number(leadMatch[1]) * 7;
    if (!leadDays) {
      const ints = [...middle.replace(/\b\d{1,3}(?:,\d{3})*\.\d{2}\b/g, ' ').matchAll(/\b(\d{2,3})\b/g)].map((m) => Number(m[1]));
      if (ints.length) leadDays = Math.max(...ints) * 7;
    }

    let description = middle;
    if (pn) description = description.replace(new RegExp(pn.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'), ' ');
    if (nsn) description = description.replace(nsn, ' ');
    description = description
      .replace(/\b\d{1,3}(?:,\d{3})*\.\d{2}\b/g, ' ')
      .replace(/Available\s+Stock\s+Quantity\s+\d+(?:\.\d+)?/ig, ' ')
      .replace(/Under Investigation|Awaiting Price/ig, ' ')
      .replace(/\|/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();

    if (pn || unitPrice > 0) {
      // Algumas RFQs Leonardo trazem a relação diretamente na própria linha,
      // por exemplo "Alternative P/N: XXXXX". Como o usuário já informou
      // que o documento é uma RFQ, capturamos a relação sem tentar inferir
      // outro tipo documental. A confirmação continua acontecendo na triagem.
      const localAlt = middle.match(/(?:alternative|alternate|alternativo)\s*(?:P\/?N|PN|part\s*number)?\s*[:\-]?\s*([A-Z0-9][A-Z0-9./-]{2,})/i);
      const localEq = middle.match(/(?:equivalent|equivalente)\s*(?:P\/?N|PN|part\s*number)?\s*[:\-]?\s*([A-Z0-9][A-Z0-9./-]{2,})/i);
      const relatedAlt = normalizePn(localAlt?.[1]);
      const relatedEq = normalizePn(localEq?.[1]);
      const related = relatedAlt && relatedAlt !== normalizePn(pn)
        ? { pn: relatedAlt, type: 'ALTERNATIVO', text: localAlt?.[0] }
        : relatedEq && relatedEq !== normalizePn(pn)
          ? { pn: relatedEq, type: 'EQUIVALENTE', text: localEq?.[0] }
          : null;

      items.push({
        item_num: index + 1,
        pn,
        nsn,
        nomenclatura: description.toUpperCase(),
        qtd_solicitada: qty,
        lead_time: leadDays,
        estoque_pronto: readyStock,
        valor_unitario: unitPrice,
        pn_relacionado: related?.pn || null,
        tipo_relacao_pn: related?.type || null,
        relacao_pn_texto: related?.text ? safeString(related.text).slice(0, 500) : null,
      });
    }
  });

  const relations = findPnRelations(flat);
  relations.forEach((relation) => {
    const direct = items.find((row) => normalizePn(row.pn) === relation.pn);
    if (direct) {
      Object.assign(direct, relation);
      return;
    }

    // Em PDFs Leonardo, a extração de texto pode colar ITEM + PN + DESCRIPTION
    // (ex.: 2WG...07552BOLTED). Se a própria observação de supersession informa
    // o PN exato, usamos essa evidência documental para corrigir a segmentação.
    let reverse = items.find((row) => normalizePn(row.pn) === relation.pn_relacionado);
    if (!reverse) {
      reverse = items.find((row) => normalizePn(row.pn).includes(relation.pn_relacionado));
      if (reverse) reverse.pn = relation.pn_relacionado;
    }
    if (!reverse) return;

    // A própria frase de supersession nos dá os dois PNs exatos. Aproveitamos
    // isso também para limpar a segmentação da linha do item em PDFs Leonardo.
    const escapedPn = relation.pn_relacionado.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const detail = flat.match(new RegExp(`${escapedPn}\\s*([A-Z][A-Z0-9 ,.&()\\/-]{2,}?)\\s+(\\d{1,3})\\s+(\\d+(?:[.,]\\d{3})?)\\s*N\\b`, 'i'));
    if (detail) {
      reverse.nomenclatura = safeString(detail[1]).replace(/_+/g, ' ').replace(/\\s+/g, ' ').trim().toUpperCase();
      reverse.lead_time = Number(detail[2]) * 7;
      reverse.qtd_solicitada = parseNumber(detail[3]);
    }
    const itemRef = flat.match(new RegExp(`(?:^|\\s)(\\d{1,3})\\s*${escapedPn}`, 'i'));
    if (itemRef) reverse.item_num = Number(itemRef[1]);

    reverse.pn_relacionado = relation.pn;
    reverse.tipo_relacao_pn = relation.tipo_relacao_pn === 'SUPERSEDED_BY'
      ? 'SUPERSEDES'
      : relation.tipo_relacao_pn;
    reverse.relacao_pn_texto = relation.relacao_pn_texto;
  });

  return items;
}

function mergeMetadata(base = {}, ai = {}) {
  const out = { ...base };
  Object.entries(ai || {}).forEach(([key, value]) => {
    if (value !== null && value !== undefined && safeString(value) && (!safeString(out[key]) || out[key] === 'N/A')) out[key] = value;
  });
  out.moeda = 'GBP';
  out.tipo_cotacao = safeString(out.tipo_cotacao || 'MATERIAL').toUpperCase();
  return out;
}

function mergeItems(baseItems = [], aiItems = []) {
  if (!Array.isArray(aiItems) || !aiItems.length) return baseItems;
  const output = baseItems.map((item) => ({ ...item }));

  aiItems.forEach((aiItem, index) => {
    const pn = normalizePn(aiItem.pn);
    let target = output.find((item) => pn && normalizePn(item.pn) === pn);
    if (!target && output[index]) target = output[index];
    if (!target) {
      target = { item_num: output.length + 1 };
      output.push(target);
    }

    const fill = (field, transform = (value) => value) => {
      const value = aiItem[field];
      if (value === null || value === undefined || value === '') return;
      if (target[field] === null || target[field] === undefined || target[field] === '' || Number(target[field]) === 0) {
        target[field] = transform(value);
      }
    };

    fill('pn', normalizePn);
    fill('nsn', safeString);
    fill('nomenclatura', (value) => safeString(value).toUpperCase());
    fill('qtd_solicitada', parseNumber);
    fill('lead_time', parseNumber);
    fill('estoque_pronto', parseNumber);
    fill('valor_unitario', parseNumber);
    fill('valor_total_item', parseNumber);
    fill('preco_base', parseNumber);
    fill('desconto_percentual', parseNumber);
    fill('limite_quantidade', parseNumber);
    fill('material_reference', safeString);
    fill('price_status', (value) => safeString(value).toUpperCase());
    fill('tipo_cotacao', (value) => safeString(value).toUpperCase());
    fill('prazo_condicao', safeString);
    fill('match_mode', (value) => safeString(value).toUpperCase());
    fill('pn_original_solicitado', normalizePn);
    fill('correcao_pn_tipo', (value) => safeString(value).toUpperCase());
    fill('source_page', parseNumber);
    fill('source_excerpt', (value) => safeString(value).slice(0, 4000));
    if (aiItem.one_time_only === true) target.one_time_only = true;

    if (aiItem.pn_relacionado) target.pn_relacionado = normalizePn(aiItem.pn_relacionado);
    if (aiItem.tipo_relacao_pn) target.tipo_relacao_pn = safeString(aiItem.tipo_relacao_pn).toUpperCase();
    if (aiItem.relacao_pn_texto) target.relacao_pn_texto = safeString(aiItem.relacao_pn_texto).slice(0, 500);
  });

  return output.filter((item) => normalizePn(item.pn) || parseNumber(item.valor_unitario) > 0);
}

async function parseRfqDocument(file) {
  if (!file?.buffer) {
    const error = new Error('Nenhum ficheiro enviado.');
    error.statusCode = 400;
    throw error;
  }

  const { text, method, visualCommercial = null } = await extractSourceText(file);
  const fileName = file.originalname || 'documento-comercial';
  if (visualCommercial?.recognized && !visualCommercial.valid) {
    return {
      metadados: {
        documento_tipo: 'LEONARDO_REPAIR_PRICE_LETTER',
        moeda: 'GBP',
        fornecedor: 'LEONARDO UK LTD',
        arquivo_nome: file.originalname || null,
        metodo_leitura: method,
        quality_status: 'BLOCKED',
        quality_warnings: [
          ...(visualCommercial.blocking || []),
          ...(visualCommercial.warnings || []),
          'Carta escaneada reconhecida, mas a tabela visual não fechou integralmente. Nenhum preço foi liberado para gravação.',
        ],
      },
      items: [],
    };
  }
  let documentType = classifyCommercialDocument(text, fileName);

  // C2.2 Fidelity Gate:
  // uma Quotation Leonardo reconhecível nunca pode cair no merge genérico com IA.
  // O smoke real mostrou que esse fallback pode cruzar campos de itens diferentes.
  if (documentType === 'GENERIC_COMMERCIAL_DOCUMENT'
    && (looksLikeLeonardoQuotation(text, fileName) || looksLikeLeonardoQuotationHeader(text, fileName))) {
    documentType = 'LEONARDO_QUOTATION';
  }

  const deterministic = parseDeterministicCommercialDocument({
    text,
    fileName,
    documentType,
  });

  const isHomologatedLeonardo = ['LEONARDO_QUOTATION', 'LEONARDO_PRICE_LETTER', 'LEONARDO_REPAIR_PRICE_LETTER'].includes(documentType);

  // Modelos Leonardo homologados usam parser determinístico primeiro. A IA já pode ter sido
  // usada apenas para transcrever PDF escaneado; não fazemos uma segunda interpretação se
  // a estrutura documental fechou.
  if (deterministic && Array.isArray(deterministic.items) && deterministic.items.length > 0) {
    return {
      metadados: {
        ...deterministic.metadados,
        moeda: 'GBP',
        arquivo_nome: file.originalname || null,
        metodo_leitura: `${method}+DETERMINISTICO:${documentType}`,
        aviso_ia: method.startsWith('CHAT_LINCE_') ? null : undefined,
        quality_status: (method.startsWith('CHAT_LINCE_PDF_VISUAL_ESTRUTURADO') || method === 'OCR_LOCAL_TESSERACT_POPPLER')
          ? 'REVIEW'
          : (deterministic.metadados?.quality_status || 'READY'),
        quality_warnings: method === 'OCR_LOCAL_TESSERACT_POPPLER'
          ? [
            ...(deterministic.metadados?.quality_warnings || []),
            ...(visualCommercial?.warnings || []),
            `OCR local determinístico: ${visualCommercial?.evidence?.row_count || 0} componente(s) / ${visualCommercial?.evidence?.price_reference_count || 0} referência(s) de preço. Revisão humana obrigatória antes da gravação.`,
          ]
          : (method.startsWith('CHAT_LINCE_PDF_VISUAL_ESTRUTURADO')
            ? [
              ...(deterministic.metadados?.quality_warnings || []),
              ...(visualCommercial?.warnings || []),
              'Carta escaneada lida visualmente em formato estruturado; revisão humana obrigatória antes da gravação.',
            ]
            : (deterministic.metadados?.quality_warnings || [])),
      },
      items: deterministic.items.map((item, index) => ({
        ...item,
        item_num: Number(item.item_num || index + 1),
        pn: normalizePn(item.pn),
        nsn: safeString(item.nsn),
        material_reference: safeString(item.material_reference),
        material_reference_status: safeString(item.material_reference_status),
        nomenclatura: safeString(item.nomenclatura).toUpperCase(),
        qtd_solicitada: parseNumber(item.qtd_solicitada),
        lead_time: parseNumber(item.lead_time),
        lead_time_original: safeString(item.lead_time_original),
        estoque_pronto: parseNumber(item.estoque_pronto),
        valor_unitario: parseNumber(item.valor_unitario),
        valor_total_item: parseNumber(item.valor_total_item),
        preco_base: parseNumber(item.preco_base),
        desconto_percentual: parseNumber(item.desconto_percentual),
        limite_quantidade: parseNumber(item.limite_quantidade),
        one_time_only: Boolean(item.one_time_only),
        prazo_condicao: safeString(item.prazo_condicao),
        price_status: safeString(item.price_status).toUpperCase(),
        tipo_cotacao: safeString(item.tipo_cotacao || deterministic.metadados?.tipo_cotacao || 'MATERIAL').toUpperCase(),
        match_mode: safeString(item.match_mode || 'EXACT').toUpperCase(),
        pn_original_solicitado: normalizePn(item.pn_original_solicitado),
        correcao_pn_tipo: safeString(item.correcao_pn_tipo).toUpperCase(),
        source_page: Number(item.source_page || visualCommercial?.metadata?.source_table_page) || null,
        source_excerpt: safeString(item.source_excerpt).slice(0, 4000),
        source_description_status: safeString(item.source_description_status),
        condicao_item: safeString(item.condicao_item),
        pn_relacionado: normalizePn(item.pn_relacionado) || '',
        tipo_relacao_pn: safeString(item.tipo_relacao_pn).toUpperCase(),
        relacao_pn_texto: safeString(item.relacao_pn_texto),
        sn: safeString(item.sn),
        wo_referencia: safeString(item.wo_referencia),
        observacoes: safeString(item.observacoes),
      })),
    };
  }

  if (isHomologatedLeonardo) {
    return {
      metadados: {
        documento_tipo: documentType,
        moeda: 'GBP',
        arquivo_nome: file.originalname || null,
        metodo_leitura: `${method}+DETERMINISTICO_BLOQUEADO:${documentType}`,
        quality_status: 'BLOCKED',
        quality_warnings: ['Documento Leonardo reconhecido, mas a estrutura determinística não fechou. Nenhum dado comercial foi preenchido por IA para evitar cruzamento entre itens.'],
      },
      items: [],
    };
  }

  // Compatibilidade: fornecedores/planilhas ainda não homologados preservam o parser anterior
  // e usam IA apenas como fallback/complemento de revisão.
  const metadados = parseMetadata(text);
  const deterministicItems = parseItems(text);
  const ai = await extractRfqDataWithAi({ text, fileName: file.originalname || 'cotacao', tipoDocumento: documentType || 'RFQ_COTACAO' });
  const mergedMetadata = ai.ok ? mergeMetadata(metadados, ai.metadados) : metadados;
  const items = ai.ok ? mergeItems(deterministicItems, ai.items) : deterministicItems;

  return {
    metadados: {
      ...mergedMetadata,
      documento_tipo: documentType,
      moeda: 'GBP',
      arquivo_nome: file.originalname || null,
      metodo_leitura: ai.ok ? `${method}+CHAT_LINCE_TEXTO:${ai.model || 'IA'}` : method,
      aviso_ia: ai.ok ? null : (ai.reason || null),
      quality_status: items.length ? 'REVIEW' : 'BLOCKED',
      quality_warnings: ['Modelo comercial ainda não homologado: revise todos os campos antes de gravar.'],
    },
    items: items.map((item, index) => ({
      item_num: Number(item.item_num || index + 1),
      pn: normalizePn(item.pn),
      nsn: safeString(item.nsn),
      nomenclatura: safeString(item.nomenclatura).toUpperCase(),
      qtd_solicitada: parseNumber(item.qtd_solicitada),
      lead_time: parseNumber(item.lead_time),
      estoque_pronto: parseNumber(item.estoque_pronto),
      valor_unitario: parseNumber(item.valor_unitario),
      price_status: parseNumber(item.valor_unitario) > 0 ? 'PRICED' : 'UNPRICED',
      tipo_cotacao: safeString(mergedMetadata.tipo_cotacao || 'MATERIAL').toUpperCase(),
      match_mode: 'EXACT',
      pn_relacionado: normalizePn(item.pn_relacionado) || '',
      tipo_relacao_pn: safeString(item.tipo_relacao_pn).toUpperCase(),
      relacao_pn_texto: safeString(item.relacao_pn_texto),
      sn: safeString(item.sn),
      wo_referencia: safeString(item.wo_referencia),
      observacoes: safeString(item.observacoes),
    })),
  };
}

module.exports = {
  parseRfqDocument,
};
