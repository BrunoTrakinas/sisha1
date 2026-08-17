const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const pendingModal = fs.readFileSync(path.join(ROOT, 'sisha-frontend', 'src', 'components', 'PendingCenterModal.jsx'), 'utf8');

test('C3.2: RFQ é revisada dentro da própria Central sem navegar para a página de Cotações', () => {
  assert.doesNotMatch(pendingModal, /onOpenRfq/);
  assert.doesNotMatch(pendingModal, /REVISAR EM COTAÇÕES E RFQ/);
  assert.match(pendingModal, /Revise e corrija aqui mesmo/);
});

test('C3.2: Central carrega payload completo do job e prepara edição vinculada ao mesmo import_job_id', () => {
  assert.match(pendingModal, /fetchData\(`\/import\/rfq\/jobs\/\$\{item\.id\}`\)/);
  assert.match(pendingModal, /import_job_id: data\.id/);
  assert.match(pendingModal, /import_job_status: data\.status \|\| 'REVIEW_READY'/);
});

test('C3.2: aprovação inline reutiliza exatamente o endpoint comercial homologado', () => {
  assert.match(pendingModal, /apiFetch\('\/import\/rfq\/salvar'/);
  assert.match(pendingModal, /body: JSON\.stringify\(rfqReview\)/);
  assert.match(pendingModal, /não cria regra paralela de preço, validade ou idempotência/);
});

test('C3.2: leitura BLOCKED permanece fail-closed e nunca ganha aprovação manual de preço', () => {
  assert.match(pendingModal, /reviewBlocked \|\| !reviewItems\.length/);
  assert.match(pendingModal, /não permite aprovar nem fabricar PN\/preço/);
  assert.match(pendingModal, /Este processamento está bloqueado pelo Fidelity Gate e não pode ser gravado/);
});

test('C3.2: revisão inline expõe dados principais e itens editáveis sem despejar JSON', () => {
  assert.match(pendingModal, /Dados principais do documento/);
  assert.match(pendingModal, /Itens a revisar/);
  assert.match(pendingModal, /changeRfqMeta\('validity'/);
  assert.match(pendingModal, /changeRfqItem\(index, 'pn'/);
  assert.match(pendingModal, /changeRfqItem\(index, 'valor_unitario'/);
});

test('C3.2: campos secundários e evidência ficam recolhidos para preservar leitura rápida', () => {
  assert.match(pendingModal, /Mais dados do documento/);
  assert.match(pendingModal, /Mais campos deste item/);
  assert.match(pendingModal, /Ver detalhes técnicos preservados/);
});

test('C3.2: ação APROVAR E GRAVAR fica no fluxo da Central e usa o mesmo estado editado', () => {
  assert.match(pendingModal, /onClick=\{saveRfqReview\}/);
  assert.match(pendingModal, /APROVAR E GRAVAR/);
  assert.match(pendingModal, /sticky bottom-0/);
});

test('C3.2: lista comercial reduz duplicatas técnicas do mesmo PDF e prefere análise aproveitável', () => {
  assert.match(pendingModal, /function pickRelevantRfqJobs/);
  assert.match(pendingModal, /row\.file_sha256 \|\| `JOB:\$\{row\.id\}`/);
  assert.match(pendingModal, /rfqQualityRank/);
  assert.match(pendingModal, /nextRank > currentRank/);
});
