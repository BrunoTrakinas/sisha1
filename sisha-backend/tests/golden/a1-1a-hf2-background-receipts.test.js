const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const backend = path.resolve(__dirname, '../..');
const root = path.resolve(backend, '..');
const frontend = path.join(root, 'sisha-frontend');
const migrationPath = path.join(backend, 'sql/migrations/20260814_A1_1A_HF2_001_receipt_background_jobs.sql');
const workerPath = path.join(backend, 'src/services/receiptImportJobService.js');
const triagePath = path.join(backend, 'src/services/receiptBatchTriageService.js');
const routesPath = path.join(backend, 'src/routes/receiptRoutes.js');
const receiptServicePath = path.join(backend, 'src/services/receiptService.js');
const purchasesPagePath = path.join(frontend, 'src/pages/OrdensCompras.jsx');

function read(file) { return fs.readFileSync(file, 'utf8'); }

test('A1.1A HF2: migration cria job, itens e cache persistentes server-only', () => {
  const sql = read(migrationPath);
  assert.match(sql, /create table if not exists public\.receipt_import_jobs/i);
  assert.match(sql, /create table if not exists public\.receipt_import_job_items/i);
  assert.match(sql, /create table if not exists public\.receipt_import_analysis_cache/i);
  assert.match(sql, /enable row level security/i);
  assert.match(sql, /revoke all on table public\.receipt_import_jobs from public, anon, authenticated/i);
  assert.match(sql, /grant select, insert, update on table public\.receipt_import_jobs to service_role/i);
});

test('A1.1A HF2: claim usa SKIP LOCKED, lease e pode ser retomado após queda do worker', () => {
  const sql = read(migrationPath);
  assert.match(sql, /for update of i skip locked/i);
  assert.match(sql, /lease_until/i);
  assert.match(sql, /i\.status = 'PROCESSING'.*lease_until/s);
  assert.match(sql, /sisha_renew_receipt_import_item_lease/i);
});

test('A1.1A HF2: worker é durável, concorrente no parser e serializa IA', () => {
  const src = read(workerPath);
  assert.match(src, /RECEIPT_IMPORT_CONCURRENCY \|\| 4/);
  assert.match(src, /Math\.min\([^\n]*, 6\)/);
  assert.match(src, /let aiTail = Promise\.resolve\(\)/);
  assert.match(src, /withAiSemaphore/);
  assert.match(src, /sisha_claim_receipt_import_item/);
  assert.match(src, /sisha_renew_receipt_import_item_lease/);
});

test('A1.1A HF2: IA continua fallback; documentos estruturais tentam parser determinístico primeiro', () => {
  const src = read(triagePath);
  assert.match(src, /STRUCTURAL_EXTENSIONS/);
  assert.match(src, /parseReceiptDocument\(\{ file, requestedType: 'recibo_auto' \}\)/);
  assert.match(src, /if \(!form && AI_EXTENSIONS\.has\(extension\)\)/);
  // HF4 endureceu DOC legado: falha estrutural vira REVIEW, nunca lista de PNs criada por IA.
  assert.doesNotMatch(src, /extension === '\.doc'/);
});

test('A1.1A HF2: hash reaproveita análise e detecta duplicidade antes da gravação operacional', () => {
  const src = read(triagePath);
  assert.match(src, /receipt_import_analysis_cache/);
  assert.match(src, /loadCached\(fileHash\)/);
  assert.match(src, /findExistingByHash\(fileHash\)/);
  assert.doesNotMatch(src, /receiptController\.criar|saveReceipt|insert\([^)]*recebimentos/i);
});

test('A1.1A HF2: rotas persistentes permanecem restritas a Admin e preservam revisão humana', () => {
  const src = read(routesPath);
  assert.match(src, /router\.post\('\/batch\/jobs', requireRole\(\['admin'\]\)/);
  assert.match(src, /router\.get\('\/batch\/jobs\/:jobId', requireRole\(\['admin'\]\)/);
  assert.match(src, /items\/:itemId\/saved', requireRole\(\['admin'\]\)/);
});

test('A1.1A HF2: frontend envia uma vez, consulta job persistente e pode reabrir após reload', () => {
  const src = read(path.join(frontend, 'src/pages/Recebimentos.jsx'));
  assert.match(src, /apiFetch\('\/receipts\/batch\/jobs'/);
  assert.match(src, /apiFetch\(`\/receipts\/batch\/jobs\/\$\{jobId\}`/);
  assert.match(src, /recentBatchJobs/);
  assert.match(src, /continua mesmo se você fechar a página/i);
  assert.match(src, /Processar em segundo plano/);
});

test('A1.1A HF2: implementação não adiciona Redis/BullMQ nem outra fila externa', () => {
  const backPkg = read(path.join(backend, 'package.json'));
  const frontPkg = read(path.join(frontend, 'package.json'));
  assert.doesNotMatch(backPkg, /bullmq|ioredis|redis\"/i);
  assert.doesNotMatch(frontPkg, /bullmq|ioredis|redis\"/i);
  const worker = read(workerPath);
  assert.match(worker, /getSupabaseAdmin/);
});


test('A1.1A C3.4 HF2: lote usa recibo operacional pelo mesmo hash como evidência de resolução', () => {
  const src = read(workerPath);
  assert.match(src, /async function savedReceiptsByHash/);
  assert.match(src, /from\('recebimentos'\)/);
  assert.match(src, /\.in\('arquivo_hash', batch\)/);
  assert.match(src, /function effectiveReceiptImportItem/);
  assert.match(src, /resolved_by_receipt: true/);
  assert.match(src, /effective_status: 'SAVED'/);
});

test('A1.1A C3.4 HF2: contadores efetivos deixam lote concluído fora da fila de ação sem migration nova', () => {
  const src = read(workerPath);
  assert.match(src, /function summarizeReceiptImportItems/);
  assert.match(src, /pending_action_items/);
  assert.match(src, /resolved_items/);
  assert.match(src, /effective_status: summary\.resolved \? 'RESOLVED'/);
  assert.doesNotMatch(src, /alter table public\.receipt_import_jobs/);
});

test('A1.1A C3.4 HF2: aviso informativo GARANTIA + FOC não força REVIEW no lote', () => {
  const src = read(triagePath);
  assert.match(src, /function isInformationalReceiptWarning/);
  assert.match(src, /const blockingWarnings = warnings\.filter/);
  assert.match(src, /let status = blockingWarnings\.length \|\| !numberKey \|\| !validItems\.length \? 'REVIEW' : 'READY'/);
  const front = read(path.join(frontend, 'src/pages/Recebimentos.jsx'));
  assert.match(front, /GARANTIA \+ FOC é uma combinação logística válida/);
  assert.match(front, /Informações identificadas na leitura/);
});


test('PD lifecycle: Recibo atualiza o PD canônico sem sobrescrever estágio do Order Book', () => {
  const src = read(receiptServicePath);
  assert.match(src, /applyReceiptDeltaToPdLifecycle/);
  assert.match(src, /from\('compras_pds'\)/);
  assert.match(src, /qtd_recebida: afterDelivered/);
  assert.match(src, /resolvePdLifecycleStatus/);
  assert.match(src, /const sourceDelivered = Math\.max\(receiptDelivered, independentOrderBookFloor\)/);
  assert.match(src, /allowRegression: explicitCorrection/);
  const orderBookBlock = src.slice(src.indexOf('async function applyReceiptDeltaToOrderBook'), src.indexOf('function aggregateReceiptDeltaByPd'));
  assert.doesNotMatch(orderBookBlock, /status_categoria\s*:/);
});

test('PD lifecycle: UI mostra uma única evolução com entregue X e falta Y', () => {
  const src = read(purchasesPagePath);
  assert.match(src, /pdLifecycleLabel/);
  assert.match(src, /Entrega efetiva/);
  assert.match(src, /Falta \{numberBr\(pdMissingQty\(pd\)\)\} un/);
  assert.match(src, /Ciclo do PD: ODC → ODA →/);
});
