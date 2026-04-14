const supabase = require('../config/supabaseClient');

async function startImportLog({ tipoArquivo, nomeArquivo, uploadedByEmail, uploadedByRole, rota }) {
  const payload = {
    tipo_arquivo: tipoArquivo || 'desconhecido',
    nome_arquivo: nomeArquivo || null,
    status: 'PROCESSANDO',
    tabela_alvo: null,
    linhas_lidas: 0,
    linhas_importadas: 0,
    linhas_ignoradas: 0,
    mensagem: 'Processando importação...',
    detalhes: rota ? { rota } : {},
    uploaded_by_email: uploadedByEmail || null,
    uploaded_by_role: uploadedByRole || null,
  };

  const { data, error } = await supabase
    .from('import_logs')
    .insert(payload)
    .select('id')
    .single();

  if (error) throw error;
  return data.id;
}

async function finalizeImportLog(logId, summary = {}) {
  if (!logId) return;

  const updatePayload = {
    status: summary.status || 'SUCESSO',
    tabela_alvo: summary.tabelaAlvo || null,
    linhas_lidas: Number(summary.linhasLidas) || 0,
    linhas_importadas: Number(summary.linhasImportadas) || 0,
    linhas_ignoradas: Number(summary.linhasIgnoradas) || 0,
    mensagem: summary.mensagem || null,
    detalhes: summary.detalhes || {},
    finished_at: new Date().toISOString(),
  };

  const { error } = await supabase.from('import_logs').update(updatePayload).eq('id', logId);
  if (error) throw error;
}

async function insertImportIssues(logId, issues = []) {
  if (!logId || !issues.length) return;

  const payload = issues.slice(0, 500).map((issue) => ({
    import_log_id: logId,
    linha_numero: issue.linha_numero || null,
    campo: issue.campo || null,
    valor_original: issue.valor_original == null ? null : String(issue.valor_original),
    motivo: issue.motivo || 'Linha ignorada',
  }));

  const { error } = await supabase.from('import_log_errors').insert(payload);
  if (error) throw error;
}

function ensureAuditState(req) {
  if (!req.importAudit) {
    req.importAudit = {
      logId: null,
      issues: [],
      summary: {},
    };
  }
  return req.importAudit;
}

function recordAuditIssue(req, issue) {
  const state = ensureAuditState(req);
  state.issues.push(issue);
}

function setAuditSummary(req, summary = {}) {
  const state = ensureAuditState(req);
  state.summary = { ...state.summary, ...summary };
}

module.exports = {
  startImportLog,
  finalizeImportLog,
  insertImportIssues,
  ensureAuditState,
  recordAuditIssue,
  setAuditSummary,
};
