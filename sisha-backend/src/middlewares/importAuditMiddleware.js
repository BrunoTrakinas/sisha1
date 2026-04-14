const {
  startImportLog,
  finalizeImportLog,
  insertImportIssues,
  ensureAuditState,
} = require('../utils/importAudit');

function createImportAudit(rota = 'import') {
  return async (req, res, next) => {
    try {
      const state = ensureAuditState(req);
      const tipoArquivo = req.body?.tipoArquivo || req.body?.tipo || rota;
      const nomeArquivo = req.file?.originalname || null;
      state.logId = await startImportLog({
        tipoArquivo,
        nomeArquivo,
        uploadedByEmail: req.user?.email,
        uploadedByRole: req.user?.role,
        rota,
      });

      res.once('finish', async () => {
        try {
          const finalState = ensureAuditState(req);
          await insertImportIssues(finalState.logId, finalState.issues || []);
          await finalizeImportLog(finalState.logId, {
            ...finalState.summary,
            status: res.statusCode >= 400 ? 'ERRO' : (finalState.summary.status || 'SUCESSO'),
            mensagem: finalState.summary.mensagem || (res.statusCode >= 400 ? 'Falha na importação.' : 'Importação concluída.'),
          });
        } catch (error) {
          console.error('Falha ao finalizar trilha de importação:', error.message);
        }
      });

      next();
    } catch (error) {
      console.error('Falha ao iniciar trilha de importação:', error.message);
      next();
    }
  };
}

module.exports = { createImportAudit };
