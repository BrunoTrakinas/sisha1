const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '../..');
const migration = fs.readFileSync(path.join(root, 'sql/migrations/20260815_C2_4_001_rfq_single_save_idempotency.sql'), 'utf8');
const controller = fs.readFileSync(path.join(root, 'src/controllers/importController.js'), 'utf8');
const frontend = fs.readFileSync(path.join(root, '../sisha-frontend/src/components/RfqImporter.jsx'), 'utf8');

test('C2.4: migration vincula cada linha comercial ao job persistente sem criar nova tabela de preços', () => {
  assert.match(migration, /add column if not exists rfq_import_job_id uuid/i);
  assert.match(migration, /add column if not exists rfq_import_row_key text/i);
  assert.match(migration, /references public\.rfq_import_jobs\(id\)/i);
  assert.doesNotMatch(migration, /create table\s+(if not exists\s+)?public\.(?!rfq_cotacoes)/i);
});

test('C2.4: índice UNIQUE é a barreira física contra duplo clique e race', () => {
  assert.match(migration, /create unique index if not exists uq_rfq_cotacoes_import_job_row/i);
  assert.match(migration, /rfq_import_job_id\s*,\s*rfq_import_row_key/i);
  assert.match(migration, /where rfq_import_job_id is not null and rfq_import_row_key is not null/i);
});

test('C2.4: backend reconhece job SAVED antes de tentar novo insert', () => {
  assert.match(controller, /if \(importJob\.status === 'SAVED'\)/);
  assert.match(controller, /já havia sido gravado\. Nenhuma linha foi duplicada/i);
  assert.match(controller, /already_saved:\s*true/);
});

test('C2.4: job importado só pode gravar a partir de REVIEW_READY', () => {
  assert.match(controller, /if \(importJob\.status !== 'REVIEW_READY'\)/);
  assert.match(controller, /não pode ser gravado agora/i);
});

test('C2.4: cada linha recebe chave estável de revisão e vínculo com o job', () => {
  assert.match(controller, /rfq_import_job_id:\s*origemRegistro === 'IMPORTADO' && importJobId \? importJobId : null/);
  assert.match(controller, /rfq_import_row_key:\s*origemRegistro === 'IMPORTADO' && importJobId \? `ROW:\$\{String\(itemIndex \+ 1\)\.padStart\(4, '0'\)\}` : null/);
});

test('C2.4: violação UNIQUE 23505 vira sucesso idempotente e não segunda gravação', () => {
  assert.match(controller, /String\(insertResult\.error\.code \|\| ''\) === '23505'/);
  assert.match(controller, /\.eq\('rfq_import_job_id', importJobId\)/);
  assert.match(controller, /markRfqImportJobSaved\(importJobId\)/);
});

test('C2.4: frontend bloqueia segundo clique e usa uma única ação APROVAR E GRAVAR', () => {
  assert.match(frontend, /const \[isSaving, setIsSaving\] = useState\(false\)/);
  assert.match(frontend, /if \(isSaving\) return/);
  assert.match(frontend, /disabled=\{isSaving \|\| reviewAlreadySaved/);
  assert.match(frontend, /'APROVAR E GRAVAR'/);
  assert.doesNotMatch(frontend, />GRAVAR DOCUMENTO COMERCIAL<\/button>/);
});

test('C2.4: job SAVED reabre somente para consulta e informa DOCUMENTO JÁ GRAVADO', () => {
  assert.match(frontend, /import_job_status: job\.status \|\| 'REVIEW_READY'/);
  assert.match(frontend, /job\.status === 'SAVED' \? 'Visualizar' : 'Reabrir'/);
  assert.match(frontend, /'DOCUMENTO JÁ GRAVADO'/);
  assert.match(frontend, /JÁ GRAVADO/);
});
