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
  compactText,
} = require('../services/chatLinceService');

async function extractTextFromFile(file) {
  if (!file?.buffer) throw new Error('Arquivo não enviado.');
  const name = String(file.originalname || '').toLowerCase();
  const mime = String(file.mimetype || '').toLowerCase();

  if (mime.includes('pdf') || name.endsWith('.pdf')) {
    const parsed = await pdfParse(file.buffer);
    return parsed.text || '';
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

    const data = await answerConsultQuestion(pergunta, req.user);
    return res.status(200).json({ status: 'success', data });
  } catch (error) {
    console.error('[Chat Lince] Falha consultiva:', error);
    return res.status(500).json({ status: 'error', message: 'Falha ao consultar o Chat Lince.' });
  }
};

exports.analisarDocumento = async (req, res) => {
  try {
    const tipoDocumento = String(req.body?.tipoDocumento || req.body?.tipo_documento || '').trim();
    const text = await extractTextFromFile(req.file);
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
    return res.status(500).json({ status: 'error', message: 'Falha ao analisar documento no Chat Lince.' });
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
    return res.status(200).json({ status: 'success', message: 'Documento rejeitado pelo Admin.', data });
  } catch (error) {
    return res.status(500).json({ status: 'error', message: error.message || 'Falha ao rejeitar documento.' });
  }
};


exports.confirmarApelido = async (req, res) => {
  try {
    const result = await confirmarApelidoSugerido({ sugestao: req.body || {}, user: req.user });
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
    return res.status(200).json({ status: 'success', message: 'Pendência respondida pelo PPU/Admin.', data });
  } catch (error) {
    console.error('[Chat Lince] Falha ao responder Help Desk:', error);
    return res.status(500).json({ status: 'error', message: error.message || 'Falha ao responder pendência do Help Desk.' });
  }
};
