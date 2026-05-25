const xlsx = require('xlsx');
const pdfParse = require('pdf-parse');
const supabase = require('../config/supabaseClient');
const {
  analyzeDocumentWithAi,
  answerConsultQuestion,
  saveDocumentAnalysis,
  confirmDocumentAnalysis,
  rejectDocumentAnalysis,
  listHelpdeskTickets,
  answerHelpdeskTicket,
  confirmarApelidoSugerido,
  extractTextFromImagesWithAi,
  compactText,
} = require('../services/chatLinceService');
const { buildActionPlan, executeActionPlan } = require('../services/chatLinceActionService');
const { reindexChatLinceDocuments } = require('../services/chatLinceRagService');
const { registrarAuditoria } = require('../utils/auditLogger');

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

  if (/\.(xlsx|xls|csv|ods)$/i.test(name) || mime.includes('spreadsheet') || mime.includes('excel') || mime.includes('csv')) {
    const workbook = xlsx.read(file.buffer, { type: 'buffer', cellDates: false, raw: false });
    return workbook.SheetNames.map((sheetName) => {
      const sheet = workbook.Sheets[sheetName];
      const rows = xlsx.utils.sheet_to_json(sheet, { header: 1, defval: '', raw: false });
      const renderedRows = rows.slice(0, 250).map((row) => row.map((cell) => String(cell || '').trim()).join(' | '));
      return `ABA: ${sheetName}\n${renderedRows.join('\n')}`;
    }).join('\n\n');
  }

  return file.buffer.toString('utf8');
}

exports.perguntar = async (req, res) => {
  try {
    const pergunta = String(req.body?.pergunta || '').trim();
    if (!pergunta) {
      return res.status(400).json({ status: 'error', message: 'Informe uma pergunta para o Chat Lince.' });
    }

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

exports.listarDocumentos = async (req, res) => {
  try {
    const status = String(req.query?.status || 'PENDENTE_CONFIRMACAO').trim().toUpperCase();
    const { data, error } = await supabase
      .from('chat_lince_documentos')
      .select('id,tipo_documento,nome_arquivo,resumo,classificacao,destino_sugerido,destinos_possiveis,confianca,status,created_by_email,created_at,confirmado_por,confirmado_em,observacao_admin')
      .eq('status', status)
      .order('created_at', { ascending: false })
      .limit(50);

    if (error) throw error;
    return res.status(200).json({ status: 'success', data: data || [] });
  } catch (error) {
    return res.status(500).json({ status: 'error', message: 'Falha ao listar documentos do Chat Lince.' });
  }
};

exports.confirmarDocumento = async (req, res) => {
  try {
    const observacaoAdmin = String(req.body?.observacaoAdmin || req.body?.observacao_admin || '').trim();
    const destinoAdmin = String(req.body?.destinoAdmin || req.body?.destino_admin || '').trim();
    const result = await confirmDocumentAnalysis({ id: req.params.id, user: req.user, observacaoAdmin, destinoAdmin });
    await registrarAuditoria({
      req,
      action: 'DOCUMENTO_CONFIRMADO',
      entity: 'CHAT_LINCE_DOCUMENTOS',
      entityId: req.params.id,
      summary: `${req.user?.email || 'Admin'} confirmou documento do Chat Lince.`,
      details: { documento_id: req.params.id, destinoAdmin, observacaoAdmin },
      level: 'INFO',
      visibility: 'GOD',
    });
    return res.status(200).json({
      status: 'success',
      message: result.alreadyConfirmed
        ? 'Documento já estava confirmado.'
        : 'Documento confirmado pelo Admin e gravado no banco como registro documental validado.',
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
    const limit = Number(req.body?.limit || req.query?.limit || 250);
    const result = await reindexChatLinceDocuments({ limit });
    await registrarAuditoria({
      req,
      action: 'CHAT_LINCE_RAG_REINDEXADO',
      entity: 'CHAT_LINCE_RAG',
      entityId: 'REINDEX',
      summary: `${req.user?.email || 'Admin'} reindexou documentos do Chat Lince para RAG.`,
      details: { limit, result },
      level: result.ok ? 'INFO' : 'WARN',
      visibility: 'GOD',
    });
    return res.status(result.ok ? 200 : 500).json({ status: result.ok ? 'success' : 'error', message: result.ok ? 'RAG reindexado com sucesso.' : result.reason, data: result });
  } catch (error) {
    console.error('[Chat Lince] Falha ao reindexar RAG:', error);
    return res.status(500).json({ status: 'error', message: 'Falha ao reindexar documentos do Chat Lince.' });
  }
};

exports.confirmarAcaoExecutor = async (req, res) => {
  try {
    const senha = String(req.body?.senha || '');
    const result = await executeActionPlan({ actionId: req.params.id, senha, user: req.user });

    await registrarAuditoria({
      req,
      action: result.ok ? 'CHAT_LINCE_ACAO_EXECUTADA' : 'CHAT_LINCE_ACAO_NEGADA',
      entity: 'CHAT_LINCE_ACTION_PLANS',
      entityId: req.params.id,
      summary: result.ok
        ? `${req.user?.email || 'Admin'} executou ação pelo Chat Lince.`
        : `${req.user?.email || 'Usuário'} tentou confirmar ação pelo Chat Lince sem sucesso.`,
      details: { actionId: req.params.id, ok: result.ok, message: result.message, data: result.ok ? result.data : null },
      level: result.ok ? 'INFO' : 'WARN',
      visibility: 'GOD',
    });

    if (!result.ok) {
      return res.status(result.statusCode || 400).json({ status: 'error', message: result.message });
    }

    return res.status(200).json({ status: 'success', message: result.message, data: result.data });
  } catch (error) {
    console.error('[Chat Lince] Falha ao executar ação:', error);
    return res.status(500).json({ status: 'error', message: error.message || 'Falha ao executar ação pelo Chat Lince.' });
  }
};
