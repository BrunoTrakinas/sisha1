const xlsx = require('xlsx');
const pdfParse = require('pdf-parse');
const supabase = require('../config/supabaseClient');
const {
  analyzeDocumentWithAi,
  answerConsultQuestion,
  saveDocumentAnalysis,
  getDocumentAnalysisById,
  confirmDocumentAnalysis,
  rejectDocumentAnalysis,
  listHelpdeskTickets,
  answerHelpdeskTicket,
  confirmarApelidoSugerido,
  extractTextFromImagesWithAi,
  compactText,
  hasStrongReceiptSignature,
  extractReceiptNumber,
  normalizeReceiptNumber,
} = require('../services/chatLinceService');
const { buildActionPlan, executeActionPlan } = require('../services/chatLinceActionService');
const { inspectUserPrompt } = require('../services/chatLinceSafetyGateway');
const {
  inspectReauth,
  recordReauthFailure,
  clearReauthFailures,
} = require('../services/chatLinceAbuseGuardService');
const { reindexChatLinceKnowledgeBase } = require('../services/chatLinceRagService');
const { registrarAuditoria } = require('../utils/auditLogger');
const { extractLegacyDocText } = require('../services/receiptDocumentParser');
const { extractOfficeDocument } = require('../utils/officeDocumentText');
const { publicChatLinceSecurityReadiness } = require('../services/chatLinceSecurityReadinessService');
const {
  spreadsheetRecords,
  analysisRecords,
  compareRecordsWithSisha,
} = require('../services/chatLinceUniversalAnalystService');
const {
  createXlsxBuffer,
  createPdfBuffer,
  fileNameFor,
} = require('../services/chatLinceReportService');

function extractJpegImagesFromPdfBuffer(buffer, maxImages = 8) {
  const images = [];
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) return images;

  const startMarker = Buffer.from([0xff, 0xd8]);
  const endMarker = Buffer.from([0xff, 0xd9]);
  let offset = 0;

  while (images.length < maxImages) {
    const start = buffer.indexOf(startMarker, offset);
    if (start === -1) break;

    const end = buffer.indexOf(endMarker, start + startMarker.length);
    if (end === -1) break;

    const imageBuffer = buffer.subarray(start, end + endMarker.length);
    offset = end + endMarker.length;

    // Ignora ícones/logos muito pequenos e prioriza imagens de página.
    if (imageBuffer.length < 25 * 1024) continue;

    images.push({
      mime: 'image/jpeg',
      base64: imageBuffer.toString('base64'),
      bytes: imageBuffer.length,
    });
  }

  return images;
}

function publicError(message, statusCode = 400) {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.publicMessage = message;
  return error;
}

async function extractTextFromFile(file, tipoDocumento = '') {
  if (!file?.buffer) throw new Error('Arquivo não enviado.');
  const name = String(file.originalname || '').toLowerCase();
  const mime = String(file.mimetype || '').toLowerCase();

  if (mime.startsWith('image/') || /\.(jpg|jpeg|png|webp)$/i.test(name)) {
    const imageMime = mime.startsWith('image/')
      ? mime
      : name.endsWith('.png')
        ? 'image/png'
        : name.endsWith('.webp')
          ? 'image/webp'
          : 'image/jpeg';
    const visual = await extractTextFromImagesWithAi({
      images: [{
        mime: imageMime,
        base64: file.buffer.toString('base64'),
        bytes: file.buffer.length,
      }],
      fileName: file.originalname || 'recibo-imagem',
      tipoDocumento,
    });

    if (!visual.ok) {
      throw publicError(`A leitura visual da imagem não conseguiu concluir: ${visual.reason || 'sem detalhe'}.`);
    }

    return [
      '[EXTRAÇÃO VISUAL POR IA - IMAGEM]',
      `Modelo: ${visual.model || 'não informado'}`,
      '',
      visual.text,
    ].join('\n');
  }

  if (mime.includes('pdf') || name.endsWith('.pdf')) {
    const parsed = await pdfParse(file.buffer).catch(() => ({ text: '' }));
    const parsedText = compactText(parsed.text || '', 50000);
    if (parsedText && parsedText.length >= 30) return parsedText;

    const extractedImages = extractJpegImagesFromPdfBuffer(file.buffer, 8);
    if (extractedImages.length === 0) {
      throw publicError('O PDF não possui texto selecionável e não foi possível extrair imagens internas para leitura visual. Envie PDF pesquisável ou imagem nítida do documento.');
    }

    const visual = await extractTextFromImagesWithAi({
      images: extractedImages,
      fileName: file.originalname || 'documento.pdf',
      tipoDocumento,
    });

    if (!visual.ok) {
      throw publicError(`O PDF parece ser imagem/scan. A extração visual por IA não conseguiu concluir: ${visual.reason || 'sem detalhe'}.`);
    }

    return [
      '[EXTRAÇÃO VISUAL POR IA - PDF SEM TEXTO PESQUISÁVEL]',
      `Modelo: ${visual.model || 'não informado'}`,
      '',
      visual.text,
    ].join('\n');
  }



  if (/\.(docx|odt)$/i.test(name)) {
    const office = extractOfficeDocument(file.buffer, file.originalname || name);
    const officeText = compactText(office.text || '', 50000);
    if (officeText && officeText.length >= 30) {
      return [
        `[EXTRAÇÃO ESTRUTURAL ${office.format}]`,
        '',
        officeText,
      ].join('\n');
    }

    if (office.images?.length) {
      const visual = await extractTextFromImagesWithAi({
        images: office.images,
        fileName: file.originalname || `documento.${office.format.toLowerCase()}`,
        tipoDocumento,
      });
      if (visual.ok) {
        return [
          `[EXTRAÇÃO VISUAL POR IA - ${office.format} SEM TEXTO SUFICIENTE]`,
          `Modelo: ${visual.model || 'não informado'}`,
          '',
          visual.text,
        ].join('\n');
      }
    }

    throw publicError(`${office.format} sem texto legível suficiente. Se o documento for uma digitalização, exporte-o como PDF ou imagem nítida e tente novamente.`);
  }

  if (name.endsWith('.doc')) {
    try {
      return extractLegacyDocText(file.buffer);
    } catch (error) {
      throw publicError(`Não foi possível ler o DOC legado: ${error.message || 'estrutura incompatível'}.`);
    }
  }

  if (/\.(xlsx|xls|csv|ods)$/i.test(name) || mime.includes('spreadsheet') || mime.includes('excel') || mime.includes('csv')) {
    const workbook = xlsx.read(file.buffer, { type: 'buffer', cellDates: false, raw: false });
    const maxRowsPerSheet = Math.min(Math.max(Number(process.env.CHAT_LINCE_MAX_ROWS_PER_SHEET || 1200), 100), 5000);
    return workbook.SheetNames.map((sheetName) => {
      const sheet = workbook.Sheets[sheetName];
      const rows = xlsx.utils.sheet_to_json(sheet, { header: 1, defval: '', raw: false });
      const selected = rows.length <= maxRowsPerSheet
        ? rows
        : [...rows.slice(0, maxRowsPerSheet - 100), ...rows.slice(-100)];
      const renderedRows = selected.map((row) => row.map((cell) => String(cell || '').trim()).join(' | '));
      const warning = rows.length > selected.length
        ? `\n[ATENÇÃO: aba com ${rows.length} linhas; ${selected.length} linhas representativas foram enviadas à IA. A importação operacional deve usar o arquivo original.]`
        : '';
      return `ABA: ${sheetName} | LINHAS: ${rows.length}\n${renderedRows.join('\n')}${warning}`;
    }).join('\n\n');
  }

  if (/\.(txt|json)$/i.test(name) || mime.startsWith('text/') || mime.includes('json')) {
    return compactText(file.buffer.toString('utf8'), 50000);
  }

  throw publicError('Formato não reconhecido para leitura documental. Use PDF, JPG/JPEG, PNG, WEBP, XLSX, XLS, CSV, ODS, DOC, DOCX, ODT, TXT ou JSON.');
}



function analystReportFromConsult(question, data = {}) {
  if (data?.resultado_estruturado?.rows) {
    return {
      ...data.resultado_estruturado,
      question: data.resultado_estruturado.question || question,
      answer: data.resposta || '',
      sources: data.resultado_estruturado.sources || data?.contexto?.fontes || [],
    };
  }
  return {
    title: 'Consulta Chat Lince',
    question,
    summary: data?.resposta || 'Consulta concluída sem linhas estruturadas.',
    answer: data?.resposta || '',
    columns: ['Resposta'],
    rows: [{ Resposta: data?.resposta || '' }],
    sources: data?.contexto?.fontes || [],
    fileBase: 'SISHA_Consulta_Chat_Lince',
  };
}

function sendAnalystExport(res, report, requestedFormat = 'xlsx') {
  const format = String(requestedFormat || 'xlsx').toLowerCase() === 'pdf' ? 'pdf' : 'xlsx';
  const buffer = format === 'pdf' ? createPdfBuffer(report) : createXlsxBuffer(report);
  const filename = fileNameFor(report, format);
  res.setHeader('Content-Type', format === 'pdf'
    ? 'application/pdf'
    : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.setHeader('Cache-Control', 'no-store');
  return res.status(200).send(buffer);
}

async function analystRecordsFromUploadedFile(file, question = '') {
  const name = String(file?.originalname || '').toLowerCase();
  if (/\.(xlsx|xls|csv|ods)$/i.test(name)) {
    return spreadsheetRecords(file);
  }
  const text = await extractTextFromFile(file, 'AUDITORIA_COMPARATIVA');
  const clean = compactText(text, 50000);
  if (!clean) return [];
  const analysis = await analyzeDocumentWithAi({
    tipoDocumento: 'AUDITORIA_COMPARATIVA',
    text: clean,
    fileName: file?.originalname || 'documento',
    instruction: question,
  });
  return analysisRecords(analysis);
}

exports.securityReadiness = async (_req, res) => {
  try {
    return res.status(200).json({
      status: 'success',
      data: publicChatLinceSecurityReadiness(),
    });
  } catch (error) {
    console.error('[Chat Lince] Falha no security readiness:', error);
    return res.status(500).json({
      status: 'error',
      message: 'Falha ao avaliar o readiness de segurança do Chat Lince.',
    });
  }
};

exports.perguntar = async (req, res) => {
  try {
    const perguntaRecebida = String(req.body?.pergunta || '');
    const safety = inspectUserPrompt(perguntaRecebida);

    if (!safety.allowed) {
      await registrarAuditoria({
        req,
        action: 'CHAT_LINCE_SAFETY_GATE_BLOCK',
        entity: 'CHAT_LINCE',
        entityId: safety.code,
        summary: `${req.user?.email || 'Usuário'} teve uma entrada bloqueada pelo gateway de segurança do Chat Lince.`,
        details: { safety_code: safety.code, prompt_length: perguntaRecebida.length },
        level: 'WARN',
        visibility: 'GOD',
      }).catch(() => null);

      return res.status(400).json({
        status: 'error',
        code: `CHAT_LINCE_${safety.code}`,
        message: safety.publicMessage,
      });
    }

    const pergunta = safety.normalized;
    const actionPlan = await buildActionPlan({ pergunta, user: req.user });
    if (actionPlan) {
      await registrarAuditoria({
        req,
        action: actionPlan.blocked ? 'CHAT_LINCE_ACAO_BLOQUEADA' : 'CHAT_LINCE_PLANO_ACAO_CRIADO',
        entity: 'CHAT_LINCE_ACTION_PLANS',
        entityId: actionPlan.id || pergunta.slice(0, 120),
        summary: actionPlan.blocked
          ? `${req.user?.email || 'Usuário'} tentou ação bloqueada no Chat Lince.`
          : `${req.user?.email || 'Usuário'} criou plano de alteração pelo Chat Lince.`,
        details: { pergunta: pergunta.slice(0, 1000), action_type: actionPlan.action_type || null, blocked: Boolean(actionPlan.blocked) },
        level: actionPlan.blocked ? 'WARN' : 'INFO',
        visibility: 'GOD',
      });

      return res.status(200).json({
        status: 'success',
        data: {
          resposta: actionPlan.resposta,
          modelo: 'agente-executor-planejador',
          aviso_ia: null,
          contexto: {
            agente: { versao: 'AGENTE_LOGISTICO_LINCE_EXECUTOR_V1', intencao: actionPlan.blocked ? 'ACAO_BLOQUEADA' : 'PLANO_ACAO', rotulo: actionPlan.blocked ? 'Ação bloqueada' : 'Plano de ação' },
            acao_pendente: actionPlan.blocked ? null : { id: actionPlan.id, action_type: actionPlan.action_type, status: actionPlan.status, plan_payload: actionPlan.plan_payload },
            fontes: [],
          },
        },
      });
    }

    const data = await answerConsultQuestion(pergunta, req.user);
    await registrarAuditoria({
      req,
      action: 'CHAT_LINCE_CONSULTA',
      entity: 'CHAT_LINCE',
      entityId: pergunta.slice(0, 120),
      summary: `${req.user?.email || 'Usuário'} consultou o Chat Lince.`,
      details: { pergunta: pergunta.slice(0, 1000), modelo: data?.modelo || null },
      level: 'INFO',
      visibility: 'GOD',
    });
    return res.status(200).json({ status: 'success', data });
  } catch (error) {
    console.error('[Chat Lince] Falha consultiva:', error);
    return res.status(500).json({ status: 'error', message: 'Falha ao consultar o Chat Lince.' });
  }
};


exports.exportarConsultaAnalista = async (req, res) => {
  try {
    const perguntaRecebida = String(req.body?.pergunta || '').trim();
    const format = String(req.body?.formato || 'xlsx').toLowerCase();
    const safety = inspectUserPrompt(perguntaRecebida);
    if (!safety.allowed) {
      return res.status(400).json({ status: 'error', code: `CHAT_LINCE_${safety.code}`, message: safety.publicMessage });
    }
    if (!safety.normalized) return res.status(400).json({ status: 'error', message: 'Informe a pergunta que será exportada.' });
    const data = await answerConsultQuestion(safety.normalized, req.user);
    const report = analystReportFromConsult(safety.normalized, data);
    await registrarAuditoria({
      req,
      action: 'CHAT_LINCE_CONSULTA_EXPORTADA',
      entity: 'CHAT_LINCE',
      entityId: safety.normalized.slice(0, 120),
      summary: `${req.user?.email || 'Usuário'} exportou uma consulta do Chat Lince em ${format === 'pdf' ? 'PDF' : 'Excel'}.`,
      details: { formato: format === 'pdf' ? 'pdf' : 'xlsx', pergunta: safety.normalized.slice(0, 1000), linhas: report.rows?.length || 0 },
      level: 'INFO',
      visibility: 'GOD',
    }).catch(() => null);
    return sendAnalystExport(res, report, format);
  } catch (error) {
    console.error('[Chat Lince] Falha ao exportar consulta:', error);
    return res.status(500).json({ status: 'error', message: 'Falha ao exportar a consulta do Chat Lince.' });
  }
};

exports.auditarDocumentoComparandoSisha = async (req, res) => {
  try {
    const perguntaRecebida = String(req.body?.pergunta || '').trim();
    const safety = inspectUserPrompt(perguntaRecebida || 'Compare o documento com o SISHA.');
    if (!safety.allowed) return res.status(400).json({ status: 'error', code: `CHAT_LINCE_${safety.code}`, message: safety.publicMessage });
    if (!req.file?.buffer) return res.status(400).json({ status: 'error', message: 'Envie um documento para a auditoria comparativa.' });
    const records = await analystRecordsFromUploadedFile(req.file, safety.normalized || perguntaRecebida);
    if (!records.length) {
      return res.status(422).json({
        status: 'error',
        message: 'Não identifiquei PN, SN ou PI/NSN suficientes para comparar este documento com o SISHA. Para planilhas, mantenha uma coluna de PN, SN ou PI/NSN.',
      });
    }
    const report = await compareRecordsWithSisha(records, safety.normalized || perguntaRecebida);
    await registrarAuditoria({
      req,
      action: 'CHAT_LINCE_AUDITORIA_COMPARATIVA',
      entity: 'CHAT_LINCE',
      entityId: req.file.originalname || 'documento',
      summary: `${req.user?.email || 'Usuário'} comparou um documento com as fontes operacionais do SISHA em modo somente leitura.`,
      details: { nome_arquivo: req.file.originalname || null, registros_documento: records.length, linhas_resultado: report.rows?.length || 0, pergunta: (safety.normalized || '').slice(0, 1000) },
      level: 'INFO',
      visibility: 'GOD',
    }).catch(() => null);
    return res.status(200).json({ status: 'success', data: { resposta: report.summary, resultado_estruturado: report, exportavel: true } });
  } catch (error) {
    console.error('[Chat Lince] Falha na auditoria comparativa:', error);
    return res.status(error.statusCode || 500).json({ status: 'error', message: error.publicMessage || 'Falha ao comparar o documento com o SISHA.' });
  }
};

exports.exportarAuditoriaComparativa = async (req, res) => {
  try {
    const perguntaRecebida = String(req.body?.pergunta || '').trim();
    const format = String(req.body?.formato || 'xlsx').toLowerCase();
    const safety = inspectUserPrompt(perguntaRecebida || 'Compare o documento com o SISHA.');
    if (!safety.allowed) return res.status(400).json({ status: 'error', code: `CHAT_LINCE_${safety.code}`, message: safety.publicMessage });
    if (!req.file?.buffer) return res.status(400).json({ status: 'error', message: 'Envie novamente o documento para gerar o relatório.' });
    const records = await analystRecordsFromUploadedFile(req.file, safety.normalized || perguntaRecebida);
    if (!records.length) return res.status(422).json({ status: 'error', message: 'O documento não possui PN, SN ou PI/NSN identificável para exportação comparativa.' });
    const report = await compareRecordsWithSisha(records, safety.normalized || perguntaRecebida);
    return sendAnalystExport(res, report, format);
  } catch (error) {
    console.error('[Chat Lince] Falha ao exportar auditoria:', error);
    return res.status(500).json({ status: 'error', message: 'Falha ao exportar a auditoria comparativa.' });
  }
};

exports.analisarDocumento = async (req, res) => {
  try {
    const tipoDocumento = String(req.body?.tipoDocumento || req.body?.tipo_documento || '').trim();
    const text = await extractTextFromFile(req.file, tipoDocumento);
    const clean = compactText(text, 50000);

    if (!clean) {
      return res.status(400).json({ status: 'error', message: 'Não foi possível extrair texto do documento.' });
    }

    const analise = await analyzeDocumentWithAi({
      tipoDocumento,
      text: clean,
      fileName: req.file?.originalname || 'documento_sem_nome',
    });

    const saved = await saveDocumentAnalysis({
      file: req.file,
      tipoDocumento,
      text: clean,
      analysis: analise,
      user: req.user,
    });

    if (!saved.ok) {
      await registrarAuditoria({
        req,
        action: 'DOCUMENTO_ANALISADO_SEM_STAGING',
        entity: 'CHAT_LINCE_DOCUMENTOS',
        entityId: req.file?.originalname || 'documento',
        summary: `Documento analisado, mas não gravado em staging: ${req.file?.originalname || 'documento'}.`,
        details: { tipoDocumento, erro: saved.error, classificacao: analise?.classificacao },
        level: 'WARN',
        visibility: 'GOD',
      });
      return res.status(200).json({
        status: 'partial_success',
        message: 'Documento analisado, mas a tabela chat_lince_documentos ainda não existe. Rode o SQL do patch para habilitar confirmação pelo Admin.',
        data: {
          documento_id: null,
          analise,
          erro_gravacao: saved.error,
        },
      });
    }

    await registrarAuditoria({
      req,
      action: 'DOCUMENTO_ANALISADO',
      entity: 'CHAT_LINCE_DOCUMENTOS',
      entityId: saved.data.id,
      summary: `${req.user?.email || 'Usuário'} analisou documento ${req.file?.originalname || 'sem nome'} no Chat Lince.`,
      details: {
        tipoDocumento,
        nomeArquivo: req.file?.originalname || null,
        classificacao: analise?.classificacao || null,
        destino_sugerido: analise?.destino_sugerido || null,
        confianca: analise?.confianca || 0,
        origem: analise?.origem || null,
      },
      level: 'INFO',
      visibility: 'GOD',
    });

    return res.status(200).json({
      status: 'success',
      message: 'Documento analisado pelo Chat Lince e aguardando confirmação do Admin.',
      data: {
        documento_id: saved.data.id,
        documento: saved.data,
        analise,
      },
    });
  } catch (error) {
    console.error('[Chat Lince] Falha documental:', error);
    return res.status(error.statusCode || 500).json({ status: 'error', message: error.publicMessage || 'Falha ao analisar documento no Chat Lince.' });
  }
};


function normalizeReceiptFileName(value = '') {
  return String(value || '')
    .trim()
    .toUpperCase()
    .replace(/\(\d+\)(?=\.[A-Z0-9]+$)/, '')
    .replace(/\s+/g, ' ');
}

function receiptNumberVariants(value = '') {
  const canonical = normalizeReceiptNumber(value);
  if (!canonical) return [];
  const [sequence, year] = canonical.split('/');
  const padded = String(sequence).padStart(3, '0');
  return [...new Set([
    `${sequence}/${year}`,
    `${padded}/${year}`,
    `${sequence}-${year}`,
    `${padded}-${year}`,
  ])];
}

function receiptIdentityFromChatDocument(row = {}) {
  const source = [
    row.nome_arquivo,
    row.resumo,
    row.texto_extraido,
  ].filter(Boolean).join('\n');

  const isReceipt = hasStrongReceiptSignature({
    tipoDocumento: row.tipo_documento,
    fileName: row.nome_arquivo,
    resumo: row.resumo,
    text: row.texto_extraido,
  });

  return {
    isReceipt,
    numero: isReceipt ? extractReceiptNumber(source) : '',
    arquivo: isReceipt ? normalizeReceiptFileName(row.nome_arquivo) : '',
  };
}

async function reconcileChatReceiptDocuments(rows = []) {
  const docs = Array.isArray(rows) ? rows : [];
  const candidates = docs
    .map((row) => ({ row, identity: receiptIdentityFromChatDocument(row) }))
    .filter(({ identity }) => identity.isReceipt);

  if (!candidates.length) return docs.map((row) => ({ ...row, central_resolved: false }));

  const documentIds = [...new Set(candidates.map(({ row }) => String(row.id || '').trim()).filter(Boolean))];
  const numberVariants = [...new Set(candidates.flatMap(({ identity }) => receiptNumberVariants(identity.numero)))];
  const fileVariants = [...new Set(candidates.flatMap(({ row }) => {
    const original = String(row.nome_arquivo || '').trim();
    const withoutCopySuffix = original.replace(/\(\d+\)(?=\.[^.]+$)/, '');
    return [original, withoutCopySuffix].filter(Boolean);
  }))];

  const receiptRows = [];
  const selectFields = 'id,numero_recibo,tipo_recebimento,arquivo_nome,arquivo_hash,chat_lince_documento_id,is_foc,ativo';

  async function collect(query) {
    if (!query) return;
    const { data, error } = await query;
    // A reconciliação é somente um filtro de pendência. Se a consulta auxiliar
    // falhar, mantemos a pendência visível em vez de esconder algo sem prova.
    if (!error && Array.isArray(data)) receiptRows.push(...data);
  }

  if (documentIds.length) {
    await collect(
      supabase.from('recebimentos').select(selectFields).neq('ativo', false).in('chat_lince_documento_id', documentIds)
    );
  }
  if (numberVariants.length) {
    await collect(
      supabase.from('recebimentos').select(selectFields).neq('ativo', false).in('numero_recibo', numberVariants)
    );
  }
  if (fileVariants.length) {
    await collect(
      supabase.from('recebimentos').select(selectFields).neq('ativo', false).in('arquivo_nome', fileVariants)
    );
  }

  const uniqueReceipts = [...new Map(receiptRows.map((row) => [String(row.id), row])).values()];
  const byDocumentId = new Map();
  const byNumber = new Map();
  const byFile = new Map();

  uniqueReceipts.forEach((receipt) => {
    const linkedId = String(receipt.chat_lince_documento_id || '').trim();
    if (linkedId) byDocumentId.set(linkedId, receipt);

    const number = normalizeReceiptNumber(receipt.numero_recibo);
    if (number) {
      const current = byNumber.get(number) || [];
      current.push(receipt);
      byNumber.set(number, current);
    }

    const file = normalizeReceiptFileName(receipt.arquivo_nome);
    if (file) {
      const current = byFile.get(file) || [];
      current.push(receipt);
      byFile.set(file, current);
    }
  });

  return docs.map((row) => {
    const identity = receiptIdentityFromChatDocument(row);
    if (!identity.isReceipt) return { ...row, central_resolved: false };

    const direct = byDocumentId.get(String(row.id || '').trim()) || null;
    const numberMatches = identity.numero ? (byNumber.get(normalizeReceiptNumber(identity.numero)) || []) : [];
    const fileMatches = identity.arquivo ? (byFile.get(identity.arquivo) || []) : [];

    const matches = [...new Map(
      [direct, ...numberMatches, ...fileMatches]
        .filter(Boolean)
        .map((receipt) => [String(receipt.id), receipt])
    ).values()];

    // Um vínculo direto é prova inequívoca. Sem vínculo direto, só reconciliamos
    // automaticamente quando número/arquivo apontam para um único recibo ativo.
    const resolvedReceipt = direct || (matches.length === 1 ? matches[0] : null);
    const originalClassification = row.classificacao || null;
    const originalDestination = row.destino_sugerido || null;

    return {
      ...row,
      central_resolved: Boolean(resolvedReceipt),
      central_domain: 'RECEIPT',
      central_action: resolvedReceipt ? 'ALREADY_SAVED_IN_RECEIPTS' : 'REVIEW_IN_RECEIPTS',
      central_receipt_number: identity.numero || resolvedReceipt?.numero_recibo || null,
      central_operational_receipt_id: resolvedReceipt?.id || null,
      classificacao_ia_original: originalClassification,
      destino_ia_original: originalDestination,
      classificacao: 'RECIBO_MATERIAL',
      destino_sugerido: 'recebimentos',
      destinos_possiveis: [
        { tabela: 'recebimentos', finalidade: 'Revisão e gravação pelo módulo dono de Recibos.' },
        { tabela: 'recebimento_itens', finalidade: 'Itens do recibo, gravados somente pelo fluxo de Recibos.' },
      ],
    };
  });
}

exports.listarDocumentos = async (req, res) => {
  try {
    const status = String(req.query?.status || 'PENDENTE_CONFIRMACAO').trim().toUpperCase();
    const { data, error } = await supabase
      .from('chat_lince_documentos')
      .select('id,tipo_documento,nome_arquivo,texto_extraido,resumo,classificacao,destino_sugerido,destinos_possiveis,confianca,status,created_by_email,created_at,confirmado_por,confirmado_em,observacao_admin')
      .eq('status', status)
      .order('created_at', { ascending: false })
      .limit(250);

    if (error) throw error;

    const reconciled = await reconcileChatReceiptDocuments(data || []);
    const visible = reconciled
      .filter((row) => row.central_resolved !== true)
      .map(({ texto_extraido, ...row }) => row);

    return res.status(200).json({ status: 'success', data: visible });
  } catch (error) {
    return res.status(500).json({ status: 'error', message: 'Falha ao listar documentos do Chat Lince.' });
  }
};

exports.obterDocumento = async (req, res) => {
  try {
    const data = await getDocumentAnalysisById(req.params.id);
    const [reconciled] = await reconcileChatReceiptDocuments([data]);
    return res.status(200).json({ status: 'success', data: reconciled || data });
  } catch (error) {
    console.error('[Chat Lince] Falha ao abrir documento:', error);
    return res.status(404).json({ status: 'error', message: error.message || 'Documento não encontrado.' });
  }
};

exports.confirmarDocumento = async (req, res) => {
  try {
    const observacaoAdmin = String(req.body?.observacaoAdmin || req.body?.observacao_admin || '').trim();
    const destinoAdmin = String(req.body?.destinoAdmin || req.body?.destino_admin || '').trim();
    const correcoesAdmin = req.body?.correcoesAdmin || req.body?.correcoes_admin || null;
    const result = await confirmDocumentAnalysis({ id: req.params.id, user: req.user, observacaoAdmin, destinoAdmin, correcoesAdmin });
    await registrarAuditoria({
      req,
      action: 'DOCUMENTO_CONFIRMADO',
      entity: 'CHAT_LINCE_DOCUMENTOS',
      entityId: req.params.id,
      summary: `${req.user?.email || 'Admin'} confirmou documento do Chat Lince.`,
      details: { documento_id: req.params.id, destinoAdmin, observacaoAdmin, correcoesAdmin: correcoesAdmin || null },
      level: 'INFO',
      visibility: 'GOD',
    });
    return res.status(200).json({
      status: 'success',
      message: result.alreadyConfirmed
        ? 'Documento já estava confirmado.'
        : `Documento confirmado e normalizado em staging (${result.importStaging?.inserted || 0} registro(s)); nenhuma tabela operacional foi alterada automaticamente.`,
      data: result,
    });
  } catch (error) {
    console.error('[Chat Lince] Falha ao confirmar:', error);
    return res.status(500).json({ status: 'error', message: error.message || 'Falha ao confirmar documento.' });
  }
};

exports.rejeitarDocumento = async (req, res) => {
  try {
    const observacaoAdmin = String(req.body?.observacaoAdmin || req.body?.observacao_admin || '').trim();
    const data = await rejectDocumentAnalysis({ id: req.params.id, user: req.user, observacaoAdmin });
    await registrarAuditoria({
      req,
      action: 'DOCUMENTO_REJEITADO',
      entity: 'CHAT_LINCE_DOCUMENTOS',
      entityId: req.params.id,
      summary: `${req.user?.email || 'Admin'} rejeitou documento do Chat Lince.`,
      details: { documento_id: req.params.id, observacaoAdmin },
      level: 'WARN',
      visibility: 'GOD',
    });
    return res.status(200).json({ status: 'success', message: 'Documento rejeitado pelo Admin.', data });
  } catch (error) {
    return res.status(500).json({ status: 'error', message: error.message || 'Falha ao rejeitar documento.' });
  }
};


exports.exportarDocumentoNormalizado = async (req, res) => {
  try {
    const { data: documento, error: documentError } = await supabase
      .from('chat_lince_documentos')
      .select('*')
      .eq('id', req.params.id)
      .single();
    if (documentError || !documento) throw documentError || new Error('Documento não encontrado.');

    const { data: staged, error: stagingError } = await supabase
      .from('chat_lince_import_staging')
      .select('*')
      .eq('documento_id', req.params.id)
      .order('registro_index', { ascending: true });

    const stagingUnavailable = stagingError && ['42P01', 'PGRST205'].includes(stagingError.code);
    if (stagingError && !stagingUnavailable) throw stagingError;

    const sourceRows = Array.isArray(staged) && staged.length
      ? staged.map((row) => ({
        registro_index: row.registro_index,
        destino_confirmado: row.destino_confirmado,
        tipo_registro: row.tipo_registro,
        identificador: row.identificador,
        validacao: row.validation_status,
        erros_validacao: Array.isArray(row.validation_errors) ? row.validation_errors.join(' | ') : '',
        status_importacao: row.status,
        ...(row.payload && typeof row.payload === 'object' ? row.payload : { payload: row.payload }),
      }))
      : (Array.isArray(documento.registros_sugeridos) ? documento.registros_sugeridos : []).map((payload, index) => ({
        registro_index: index + 1,
        destino_confirmado: documento.destino_confirmado || documento.destino_sugerido || '',
        validacao: 'NAO_VALIDADO_EM_STAGING',
        ...(payload && typeof payload === 'object' ? payload : { payload }),
      }));

    const workbook = xlsx.utils.book_new();
    xlsx.utils.book_append_sheet(workbook, xlsx.utils.json_to_sheet([{
      documento_id: documento.id,
      arquivo: documento.nome_arquivo,
      classificacao: documento.classificacao,
      destino_sugerido: documento.destino_sugerido,
      destino_confirmado: documento.destino_confirmado,
      confianca: documento.confianca,
      status: documento.status,
      observacao_admin: documento.observacao_admin,
    }]), 'Documento');
    xlsx.utils.book_append_sheet(workbook, xlsx.utils.json_to_sheet(sourceRows.length ? sourceRows : [{ aviso: 'Nenhum registro estruturado foi extraído.' }]), 'Registros normalizados');

    const buffer = xlsx.write(workbook, { type: 'buffer', bookType: 'xlsx' });
    const safeName = String(documento.nome_arquivo || 'documento').replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 80);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="SISHA_IA_Normalizado_${safeName}.xlsx"`);
    return res.status(200).send(buffer);
  } catch (error) {
    console.error('[Chat Lince] Falha ao exportar normalizado:', error);
    return res.status(500).json({ status: 'error', message: error.message || 'Falha ao exportar documento normalizado.' });
  }
};


exports.confirmarApelido = async (req, res) => {
  try {
    const result = await confirmarApelidoSugerido({ sugestao: req.body || {}, user: req.user });
    await registrarAuditoria({
      req,
      action: 'APELIDO_CONFIRMADO_CHAT_LINCE',
      entity: 'ITEM_APELIDOS',
      entityId: result?.data?.pn || null,
      summary: `${req.user?.email || 'Admin'} confirmou apelido operacional pelo Chat Lince.`,
      details: { sugestao: req.body || {}, resultado: result?.data || null },
      level: 'INFO',
      visibility: 'GOD',
    });
    return res.status(200).json({
      status: 'success',
      message: result.updated
        ? 'Apelido operacional atualizado pelo Chat Lince.'
        : 'Apelido operacional cadastrado pelo Chat Lince.',
      data: result.data,
    });
  } catch (error) {
    console.error('[Chat Lince] Falha ao confirmar apelido:', error);
    return res.status(500).json({ status: 'error', message: error.message || 'Falha ao cadastrar apelido operacional.' });
  }
};


exports.listarHelpdesk = async (req, res) => {
  try {
    const status = String(req.query?.status || 'ABERTO').trim().toUpperCase();
    const limit = Number(req.query?.limit || 50);
    const data = await listHelpdeskTickets({ status, limit });
    return res.status(200).json({ status: 'success', data });
  } catch (error) {
    console.error('[Chat Lince] Falha ao listar Help Desk:', error);
    return res.status(500).json({ status: 'error', message: 'Falha ao listar pendências do Help Desk.' });
  }
};

exports.responderHelpdesk = async (req, res) => {
  try {
    const respostaAdmin = String(req.body?.respostaAdmin || req.body?.resposta_admin || req.body?.resposta || '').trim();
    const responderPeloChat = req.body?.responderPeloChat !== false;
    const data = await answerHelpdeskTicket({ id: req.params.id, respostaAdmin, user: req.user, responderPeloChat });
    await registrarAuditoria({
      req,
      action: 'HELPDESK_RESPONDIDO',
      entity: 'CHAT_LINCE_HELPDESK',
      entityId: req.params.id,
      summary: `${req.user?.email || 'Admin'} respondeu pendência do Chat Lince/Help Desk.`,
      details: { helpdesk_id: req.params.id, responderPeloChat },
      level: 'INFO',
      visibility: 'GOD',
    });
    return res.status(200).json({ status: 'success', message: 'Pendência respondida pelo PPU/Admin.', data });
  } catch (error) {
    console.error('[Chat Lince] Falha ao responder Help Desk:', error);
    return res.status(500).json({ status: 'error', message: error.message || 'Falha ao responder pendência do Help Desk.' });
  }
};

exports.reindexarRag = async (req, res) => {
  try {
    const limit = Number(req.body?.limit || req.query?.limit || 1000);
    const limitPerSource = Number(req.body?.limitPerSource || req.query?.limitPerSource || 1000);
    const includeChatDocuments = req.body?.includeChatDocuments !== false;
    const includeStructuredSources = req.body?.includeStructuredSources !== false;

    const result = await reindexChatLinceKnowledgeBase({
      limit,
      limitPerSource,
      includeChatDocuments,
      includeStructuredSources,
    });

    await registrarAuditoria({
      req,
      action: 'CHAT_LINCE_RAG_REINDEXADO',
      entity: 'CHAT_LINCE_RAG',
      entityId: 'REINDEX_BASE_LOGISTICA',
      summary: `${req.user?.email || 'Admin'} reindexou a base de conhecimento logística do Chat Lince.`,
      details: { limit, limitPerSource, includeChatDocuments, includeStructuredSources, result },
      level: result.ok ? 'INFO' : 'WARN',
      visibility: 'GOD',
    });

    return res.status(result.ok ? 200 : 500).json({
      status: result.ok ? 'success' : 'error',
      message: result.ok ? 'Base logística do RAG reindexada com sucesso.' : result.reason,
      data: result,
    });
  } catch (error) {
    console.error('[Chat Lince] Falha ao reindexar RAG:', error);
    return res.status(500).json({ status: 'error', message: 'Falha ao reindexar a base logística do Chat Lince.' });
  }
};

exports.confirmarAcaoExecutor = async (req, res) => {
  try {
    const reauthSubject = String(req.user?.auth_user_id || req.user?.id || req.user?.email || '').trim().toLowerCase();
    const reauthGate = inspectReauth(reauthSubject);
    if (!reauthGate.allowed) {
      res.setHeader('Retry-After', String(reauthGate.retryAfterSeconds || 1));
      await registrarAuditoria({
        req,
        action: 'CHAT_LINCE_REAUTH_RATE_BLOCK',
        entity: 'CHAT_LINCE_ACTION_PLANS',
        entityId: req.params.id,
        summary: `${req.user?.email || 'Usuário'} teve reautenticação temporariamente bloqueada por excesso de falhas.`,
        details: {
          code: reauthGate.code,
          retry_after_seconds: reauthGate.retryAfterSeconds,
        },
        level: 'WARN',
        visibility: 'GOD',
      }).catch(() => null);
      return res.status(429).json({
        status: 'error',
        code: 'CHAT_LINCE_REAUTH_TEMPORARILY_LOCKED',
        message: 'Muitas tentativas de reautenticação sem sucesso. Aguarde antes de tentar novamente.',
        retry_after_seconds: reauthGate.retryAfterSeconds,
      });
    }

    const senha = String(req.body?.senha || '');
    const result = await executeActionPlan({ actionId: req.params.id, senha, user: req.user });

    if (!result.ok && result.code === 'ACTION_REAUTH_FAILED') {
      const failure = recordReauthFailure(reauthSubject);
      await registrarAuditoria({
        req,
        action: 'CHAT_LINCE_REAUTH_FAILURE',
        entity: 'CHAT_LINCE_ACTION_PLANS',
        entityId: req.params.id,
        summary: `${req.user?.email || 'Usuário'} falhou na reautenticação de uma ação do Chat Lince.`,
        details: {
          failures_in_window: failure.failuresInWindow,
          temporarily_locked: failure.locked,
          retry_after_seconds: failure.retryAfterSeconds || 0,
        },
        level: 'WARN',
        visibility: 'GOD',
      }).catch(() => null);

      if (failure.locked) {
        res.setHeader('Retry-After', String(failure.retryAfterSeconds || 1));
        return res.status(429).json({
          status: 'error',
          code: 'CHAT_LINCE_REAUTH_TEMPORARILY_LOCKED',
          message: 'Muitas tentativas de reautenticação sem sucesso. O Chat Lince bloqueou novas tentativas temporariamente.',
          retry_after_seconds: failure.retryAfterSeconds,
        });
      }
    } else if (result.ok) {
      clearReauthFailures(reauthSubject);
    }

    await registrarAuditoria({
      req,
      action: result.ok ? 'CHAT_LINCE_ACAO_EXECUTADA' : 'CHAT_LINCE_ACAO_NEGADA',
      entity: 'CHAT_LINCE_ACTION_PLANS',
      entityId: req.params.id,
      summary: result.ok
        ? `${req.user?.email || 'Admin'} executou ação pelo Chat Lince.`
        : `${req.user?.email || 'Usuário'} tentou confirmar ação pelo Chat Lince sem sucesso.`,
      details: {
        actionId: req.params.id,
        ok: result.ok,
        code: result.code || null,
        message: result.message,
        mutation_committed: Boolean(result.mutationCommitted),
        data: result.data || null,
      },
      level: result.ok ? 'INFO' : 'WARN',
      visibility: 'GOD',
    });

    if (!result.ok) {
      return res.status(result.statusCode || 400).json({
        status: 'error',
        code: result.code || 'CHAT_LINCE_ACTION_DENIED',
        message: result.message,
      });
    }

    return res.status(200).json({ status: 'success', message: result.message, data: result.data });
  } catch (error) {
    console.error('[Chat Lince] Falha ao executar ação:', error);
    return res.status(500).json({ status: 'error', message: error.message || 'Falha ao executar ação pelo Chat Lince.' });
  }
};
