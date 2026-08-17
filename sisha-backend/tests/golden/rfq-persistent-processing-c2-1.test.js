const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '../..');
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');

const migration = read('sql/migrations/20260815_C2_1_001_rfq_persistent_jobs.sql');
const service = read('src/services/rfqImportJobService.js');
const storage = read('src/services/rfqImportStorageService.js');
const controller = read('src/controllers/importController.js');
const routes = read('src/routes/importRoutes.js');
const server = read('server.js');
const frontend = fs.readFileSync(path.resolve(root, '../sisha-frontend/src/components/RfqImporter.jsx'), 'utf8');

test('C2.1: migration cria job persistente server-only sem tabela operacional paralela de preços', () => {
  assert.match(migration, /create table if not exists public\.rfq_import_jobs/i);
  assert.match(migration, /enable row level security/i);
  assert.match(migration, /revoke all on table public\.rfq_import_jobs from public, anon, authenticated/i);
  assert.match(migration, /grant select, insert, update on table public\.rfq_import_jobs to service_role/i);
  assert.doesNotMatch(migration, /create table[^;]+cotac/i);
});

test('C2.1: claim usa SKIP LOCKED, lease e recuperação de PROCESSING expirado', () => {
  assert.match(migration, /for update skip locked/i);
  assert.match(migration, /status = 'PROCESSING'.+lease_until/is);
  assert.match(migration, /sisha_renew_rfq_import_job_lease/i);
  assert.match(migration, /claim_token/i);
});

test('C2.1: arquivo original é guardado no R2 privado antes do processamento', () => {
  assert.match(storage, /putPrivateObject/);
  assert.match(storage, /sisha\/rfq-imports/);
  assert.match(service, /storeFile/);
  assert.match(service, /loadFile/);
  assert.doesNotMatch(service, /writeFileSync|tmpdir\(/);
});

test('C2.1: worker executa parseRfqDocument fora da requisição HTTP', () => {
  assert.match(service, /async function processClaim/);
  assert.match(service, /parseRfqDocument/);
  assert.match(service, /REVIEW_READY/);
  assert.match(server, /startRfqImportWorker\(\)/);
});

test('C2.1: upload persistente retorna job e mantém rota síncrona legada por compatibilidade', () => {
  assert.match(routes, /post\('\/rfq\/jobs'/);
  assert.match(routes, /get\('\/rfq\/jobs'/);
  assert.match(routes, /get\('\/rfq\/jobs\/:jobId'/);
  assert.match(routes, /post\('\/rfq'/);
  assert.match(controller, /job\.reused_analysis \? 200 : 202/);
});

test('C2.1: frontend envia uma única vez e passa a consultar o job', () => {
  assert.match(frontend, /apiFetch\('\/import\/rfq\/jobs'/);
  assert.match(frontend, /apiFetch\(`\/import\/rfq\/jobs\/\$\{jobId\}`/);
  assert.doesNotMatch(frontend, /apiFetch\('\/import\/rfq', \{ method: 'POST'/);
});

test('C2.1: refresh/fechamento preserva job em localStorage e polling reabre revisão sem sobrescrever edição humana', () => {
  assert.match(frontend, /ACTIVE_JOB_KEY/);
  assert.match(frontend, /localStorage\.setItem/);
  assert.match(frontend, /setInterval\(poll, 1800\)/);
  assert.match(frontend, /reviewOpenedRef/);
  assert.match(frontend, /reviewOpenedRef\.current !== String\(job\.id/);
  assert.match(frontend, /openJobReview/);
  assert.match(frontend, /O processamento é persistente/);
});

test('C2.1: revisão pronta continua humana e somente depois grava rfq_cotacoes', () => {
  assert.match(frontend, /APROVAR E GRAVAR/);
  assert.match(frontend, /import_job_id/);
  assert.match(controller, /markRfqImportJobSaved/);
  assert.match(controller, /from\('rfq_cotacoes'\)\.insert/);
});

test('C2.1: hash e versão permitem reabrir análise idêntica sem novo processamento', () => {
  assert.match(service, /file_sha256/);
  assert.match(service, /analysis_version/);
  assert.match(service, /reused_analysis/);
  assert.match(service, /REVIEW_READY', 'SAVED/);
});

test('C2.1: implementação não adiciona Redis, BullMQ nem dependência de fila externa', () => {
  const combined = `${service}\n${storage}`;
  assert.doesNotMatch(combined, /bullmq|ioredis|redis|upstash/i);
});
