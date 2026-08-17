const crypto = require('crypto');
const {
  startImportLog,
  finalizeImportLog,
  insertImportIssues,
  ensureAuditState,
} = require('../utils/importAudit');

function buildFileMetadata(file) {
  if (!file?.buffer) return null;
  return {
    nome: file.originalname || null,
    mime: file.mimetype || null,
    tamanho_bytes: Number(file.size || file.buffer.length || 0),
    sha256: crypto.createHash('sha256').update(file.buffer).digest('hex'),
    buffer_recebido: true,
  };
}

function buildCompletionCertificate({ summary = {}, issues = [], responseStatus = 200, interrupted = false } = {}) {
  const detalhes = summary?.detalhes && typeof summary.detalhes === 'object' ? summary.detalhes : {};
  const arquivo = detalhes?.arquivo && typeof detalhes.arquivo === 'object' ? detalhes.arquivo : null;
  const linhasLidas = Number(summary.linhasLidas) || 0;
  const linhasImportadas = Number(summary.linhasImportadas) || 0;
  const linhasIgnoradas = Number(summary.linhasIgnoradas) || 0;
  const pendencias = Array.isArray(issues) ? issues.length : 0;
  const failed = interrupted || responseStatus >= 400 || String(summary.status || '').toUpperCase() === 'ERRO';
  const resultado = failed
    ? (interrupted ? 'INTERROMPIDO_SEM_CONFIRMACAO' : 'FALHOU')
    : (pendencias > 0 ? 'CONCLUIDO_COM_PENDENCIAS' : 'CONCLUIDO');

  return {
    versao: 'SISHA_IMPORT_COMPLETION_V1',
    resultado,
    arquivo_recebido_integralmente: Boolean(arquivo?.buffer_recebido && arquivo?.sha256),
    integridade_sha256_registrada: Boolean(arquivo?.sha256),
    processamento_finalizado: !interrupted,
    http_status: Number(responseStatus) || 0,
    linhas_lidas: linhasLidas,
    linhas_aplicadas_ou_processadas: linhasImportadas,
    linhas_ignoradas: linhasIgnoradas,
    pendencias_registradas: pendencias,
    sem_pendencias_registradas: pendencias === 0,
    observacao: failed
      ? 'O upload não possui confirmação de conclusão válida. Consulte a mensagem/pendências antes de considerar o documento aplicado.'
      : 'O servidor recebeu o arquivo, registrou SHA-256 e concluiu o parser sem exceção. Linhas ignoradas/pendências permanecem explicitamente contabilizadas; este certificado não inventa cobertura de linhas que o parser não declarou.',
    concluido_em: new Date().toISOString(),
  };
}

function createImportAudit(rota = 'import') {
  return async (req, res, next) => {
    try {
      const state = ensureAuditState(req);
      const tipoArquivo = req.body?.tipoArquivo || req.body?.tipo || rota;
      const nomeArquivo = req.file?.originalname || null;
      const arquivo = buildFileMetadata(req.file);

      if (arquivo) {
        state.summary = {
          ...state.summary,
          detalhes: {
            ...(state.summary?.detalhes || {}),
            arquivo,
          },
        };
      }

      state.logId = await startImportLog({
        tipoArquivo,
        nomeArquivo,
        uploadedByEmail: req.user?.email,
        uploadedByRole: req.user?.role,
        rota,
        requestId: req.requestId || req.auditContext?.requestId || null,
        arquivo,
      });

      let finalized = false;
      let responseFinished = false;
      const finalizeOnce = async ({ interrupted = false } = {}) => {
        if (finalized) return;
        finalized = true;
        try {
          const finalState = ensureAuditState(req);
          const responseStatus = Number(res.statusCode || (interrupted ? 499 : 200));
          const certificate = buildCompletionCertificate({
            summary: finalState.summary,
            issues: finalState.issues || [],
            responseStatus,
            interrupted,
          });
          const currentDetails = finalState.summary?.detalhes && typeof finalState.summary.detalhes === 'object'
            ? finalState.summary.detalhes
            : {};

          await insertImportIssues(finalState.logId, finalState.issues || []);
          await finalizeImportLog(finalState.logId, {
            ...finalState.summary,
            status: interrupted
              ? 'ERRO'
              : (responseStatus >= 400 ? 'ERRO' : (finalState.summary.status || 'SUCESSO')),
            mensagem: interrupted
              ? (finalState.summary.mensagem || 'Upload interrompido antes da confirmação de conclusão.')
              : (finalState.summary.mensagem || (responseStatus >= 400 ? 'Falha na importação.' : 'Importação concluída.')),
            detalhes: {
              ...currentDetails,
              certificado_conclusao: certificate,
            },
          });
        } catch (error) {
          console.error('Falha ao finalizar trilha de importação:', error.message);
        }
      };

      res.once('finish', () => {
        responseFinished = true;
        void finalizeOnce({ interrupted: false });
      });
      res.once('close', () => {
        if (!responseFinished) void finalizeOnce({ interrupted: true });
      });

      next();
    } catch (error) {
      console.error('Falha ao iniciar trilha de importação:', error.message);
      next();
    }
  };
}

module.exports = { createImportAudit, buildFileMetadata, buildCompletionCertificate };
