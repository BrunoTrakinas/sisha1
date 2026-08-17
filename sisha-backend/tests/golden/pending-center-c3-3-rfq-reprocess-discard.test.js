const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const service = read('sisha-backend/src/services/rfqImportJobService.js');
const controller = read('sisha-backend/src/controllers/importController.js');
const routes = read('sisha-backend/src/routes/importRoutes.js');
const modal = read('sisha-frontend/src/components/PendingCenterModal.jsx');

test('C3.3: backend expõe versão atual e marca análise legada sem alterar o parser', () => {
  assert.match(service, /function withAnalysisState/);
  assert.match(service, /analysis_current: analysisCurrent/);
  assert.match(service, /legacy_analysis: !analysisCurrent/);
  assert.match(service, /analysis_version,quality_status/);
});

test('C3.3: reprocessar reutiliza o arquivo privado original e cria novo job na versão atual', () => {
  assert.match(service, /async function reprocessRfqImportJob/);
  assert.match(service, /storage_bucket: original\.storage_bucket/);
  assert.match(service, /storage_key: original\.storage_key/);
  assert.match(service, /analysis_version: ANALYSIS_VERSION/);
  assert.match(service, /status: 'QUEUED'/);
  assert.doesNotMatch(service, /reprocessRfqImportJob[\s\S]{0,4000}storeFile\(/);
});

test('C3.3: duplo clique em reprocessar reaproveita job atual em fila/processamento', () => {
  assert.match(service, /\.eq\('analysis_version', ANALYSIS_VERSION\)/);
  assert.match(service, /\.in\('status', \['QUEUED', 'PROCESSING'\]\)/);
  assert.match(service, /reused_inflight: true/);
});

test('C3.3: excluir é soft-discard auditável e não executa DELETE físico', () => {
  assert.match(service, /async function discardRfqImportJob/);
  assert.match(service, /quality_status: 'DISCARDED'/);
  assert.match(service, /status: 'ERROR'/);
  assert.match(service, /DESCARTADO_PELO_ADMIN/);
  assert.doesNotMatch(service, /from\('rfq_import_jobs'\)[\s\S]{0,400}\.delete\(/);
});

test('C3.3: exclusão exige motivo e preserva result_payload/arquivo original', () => {
  assert.match(service, /Informe o motivo da exclusão desta pendência/);
  assert.doesNotMatch(service, /result_payload:\s*null/);
  assert.doesNotMatch(service, /deletePrivateObject\(\{ key: original/);
  assert.match(service, /diagnóstico_anterior=/);
});

test('C3.3: jobs SAVED não podem ser descartados ou reprocessados pela Central', () => {
  assert.match(service, /Documento já gravado: use o gerenciador comercial/);
  assert.match(service, /Este documento já foi gravado e não pode ser excluído pela Central/);
});

test('C3.3: rotas novas permanecem Admin e auditadas', () => {
  assert.match(routes, /\/rfq\/jobs\/:jobId\/reprocess'.*requireRole\(\['admin'\]\).*createImportAudit\('rfq_job_reprocessar'\)/);
  assert.match(routes, /\/rfq\/jobs\/:jobId\/discard'.*requireRole\(\['admin'\]\).*createImportAudit\('rfq_job_descartar'\)/);
  assert.match(controller, /modo: 'rfq_job_reprocessar'/);
  assert.match(controller, /modo: 'rfq_job_descartar'/);
  assert.match(controller, /exclusao_fisica: false/);
});

test('C3.3: Central prioriza leitor atual mesmo diante de análise legada READY', () => {
  assert.match(modal, /function rfqPendingRank/);
  assert.match(modal, /currentReaderBoost = row\.analysis_current === true \? 100 : 0/);
  assert.match(modal, /\['REVIEW_READY', 'PROCESSING', 'QUEUED'\]/);
  assert.match(modal, /ANÁLISE LEGADA/);
  assert.match(modal, /REPROCESSANDO/);
});

test('C3.3: modal oferece Reprocessar, Subir novamente e Excluir sem navegar para outra página', () => {
  assert.match(modal, /REPROCESSAR COM LEITOR ATUAL/);
  assert.match(modal, /SUBIR NOVAMENTE/);
  assert.match(modal, /> EXCLUIR</);
  assert.match(modal, /\/import\/rfq\/jobs\/\$\{selected\.id\}\/reprocess/);
  assert.match(modal, /apiFetch\('\/import\/rfq\/jobs'/);
  assert.match(modal, /FormData\(\)/);
});

test('C3.3: confirmação de exclusão é explícita e explica preservação histórica', () => {
  assert.match(modal, /Excluir esta pendência\?/);
  assert.match(modal, /O arquivo, o hash, o resultado original e a auditoria serão preservados/);
  assert.match(modal, /Motivo da exclusão/);
  assert.match(modal, /CONFIRMAR EXCLUSÃO/);
  assert.match(modal, /\/import\/rfq\/jobs\/\$\{selected\.id\}\/discard/);
});

test('C3.3: reprocessamento em andamento não é confundido com leitura bloqueada', () => {
  assert.match(modal, /Reprocessamento em andamento/);
  assert.match(modal, /processing \? \(/);
  assert.match(modal, /worker continuará/);
  assert.match(modal, /versao_analise: detail\.analysis_version/);
});

test('C3.4 HF1: backend reconcilia todos os jobs do mesmo arquivo pelo SHA-256', () => {
  assert.match(service, /async function findPersistedRfqResolution/);
  assert.match(service, /\.select\('id,file_sha256'\)/);
  assert.match(service, /\.in\('file_sha256', hashes\)/);
  assert.match(service, /persistedHashes/);
  assert.match(service, /resolved_by_same_document/);
});

test('C3.4 HF1: job legado irmão vira resolvido quando qualquer job do mesmo PDF já foi gravado', () => {
  assert.match(service, /exactPersisted \|\| sameDocumentPersisted/);
  assert.match(service, /status: 'SAVED'/);
  assert.match(service, /rfq_import_jobs\.file_sha256 -> rfq_cotacoes\.rfq_import_job_id/);
});

test('C3.4 HF1: frontend agrupa antes de filtrar SAVED para impedir ressurreição de análise legada', () => {
  assert.match(modal, /const groupedByFile = new Map\(\)/);
  assert.match(modal, /const documentResolved = group\.some/);
  assert.match(modal, /String\(row\.status \|\| ''\)\.toUpperCase\(\) === 'SAVED'/);
  assert.match(modal, /if \(documentResolved\) return/);
});

test('C3.4 HF1: frontend ainda escolhe o melhor job apenas quando o documento permanece pendente', () => {
  assert.match(modal, /let best = null/);
  assert.match(modal, /\['REVIEW_READY', 'PROCESSING', 'QUEUED'\]/);
  assert.match(modal, /rfqPendingRank\(best\)/);
  assert.match(modal, /if \(best\) picked\.push\(best\)/);
});


test('C3.4 HF2: Central de Pendências mostra somente recibos que ainda exigem ação', () => {
  assert.match(modal, /function receiptPendingActionCount/);
  assert.match(modal, /row\.resolved !== true && receiptPendingActionCount\(row\) > 0/);
  assert.match(modal, /receiptPendingActionCount\(row\).*documento\(s\) ainda exigem ação/s);
  assert.doesNotMatch(modal, /row\.total_items \|\| row\.item_count \|\| 0} documento\(s\) • revisão de recibos pendente/);
});

test('C3.4 HF2: detalhe do lote não manda revisar novamente itens já SAVED ou reconciliados', () => {
  assert.match(modal, /function isReceiptItemPending/);
  assert.match(modal, /const pendingReceiptItems = safeArray\(detail\.items\)\.filter\(isReceiptItemPending\)/);
  assert.match(modal, /Recibos já gravados com o mesmo arquivo não são solicitados novamente/);
  assert.match(modal, /Nenhum documento deste lote precisa ser revisado novamente/);
});
