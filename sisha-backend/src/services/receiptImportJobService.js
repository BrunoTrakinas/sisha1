const os = require('os');
const crypto = require('crypto');
const { getSupabaseAdmin } = require('../config/supabaseAdminClient');
const { unpackReceiptZip } = require('../utils/receiptBatchZip');
const {
  assertConfigured,
  storeArchive,
  storeDirectFile,
  loadObject,
  deletePrivateObject,
} = require('./receiptBatchStorageService');
const { analyzeReceiptFile, classifyTriage, ANALYSIS_VERSION } = require('./receiptBatchTriageService');

const WORKER_ID = `${os.hostname()}-${process.pid}-${crypto.randomUUID().slice(0, 8)}`;
const POLL_MS = Math.max(750, Math.min(Number(process.env.RECEIPT_IMPORT_POLL_MS || 2000), 10000));
const STRUCTURAL_CONCURRENCY = Math.max(1, Math.min(Number(process.env.RECEIPT_IMPORT_CONCURRENCY || 4), 6));
const LEASE_SECONDS = Math.max(60, Math.min(Number(process.env.RECEIPT_IMPORT_LEASE_SECONDS || 120), 600));
const LEASE_HEARTBEAT_MS = Math.max(15000, Math.min(Math.floor((LEASE_SECONDS * 1000) / 3), 30000));

let workerStarted = false;
let stopping = false;
const archiveCache = new Map();
const archiveLoads = new Map();
let aiTail = Promise.resolve();

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

function withAiSemaphore(task) {
  const run = aiTail.then(task, task);
  aiTail = run.catch(() => null);
  return run;
}

function actorFromClaim(claim) {
  return {
    email: claim.created_by_email,
    role: claim.created_by_role,
    auth_user_id: claim.created_by_auth_user_id,
  };
}

async function createReceiptImportJob({ files, actor, requestId }) {
  assertConfigured();
  const selected = Array.isArray(files) ? files.filter((file) => file?.buffer) : [];
  if (!selected.length) throw new Error('Selecione um ZIP ou documentos de recibo.');
  if (selected.length > 150) throw new Error('O lote ultrapassa 150 documentos.');

  const zipFiles = selected.filter((file) => /\.zip$/i.test(file.originalname || ''));
  if (zipFiles.length && selected.length !== 1) {
    throw new Error('Quando usar ZIP, envie apenas um ZIP por lote. Documentos avulsos podem ser enviados juntos em outro lote.');
  }

  const uploadedKeys = [];
  try {
    let archiveName;
    let archiveSha256;
    let storageBucket;
    let storageKey;
    let storageMode;
    let items;

    if (zipFiles.length === 1) {
      const archive = zipFiles[0];
      const unpacked = unpackReceiptZip(archive.buffer, { outputMode: 'buffer' });
      const stored = await storeArchive({ buffer: archive.buffer, fileName: archive.originalname, contentType: archive.mimetype || 'application/zip' });
      uploadedKeys.push(stored.key);
      archiveName = archive.originalname || 'recibos.zip';
      archiveSha256 = stored.sha256;
      storageBucket = stored.bucket;
      storageKey = stored.key;
      storageMode = 'ARCHIVE';
      const seenHashes = new Map();
      items = [
        ...unpacked.files.map((entry, index) => {
          const prior = seenHashes.get(entry.sha256);
          if (!prior) seenHashes.set(entry.sha256, entry.name);
          return {
            sequence_no: index + 1,
            file_name: entry.name,
            file_sha256: entry.sha256,
            mime_type: entry.mime,
            size_bytes: entry.size,
            storage_key: stored.key,
            archive_entry_name: entry.name,
            initial_status: prior ? 'DUPLICATE' : 'PENDING',
            initial_diagnostic: prior ? `Arquivo idêntico repetido no ZIP; primeira ocorrência: ${prior}.` : null,
          };
        }),
        ...unpacked.ignored.map((entry, ignoredIndex) => ({
          sequence_no: unpacked.files.length + ignoredIndex + 1,
          file_name: entry.name || `ignorado-${ignoredIndex + 1}`,
          file_sha256: null,
          mime_type: null,
          size_bytes: 0,
          storage_key: stored.key,
          archive_entry_name: entry.name || null,
          ignored_reason: entry.reason || 'FORMATO_NAO_SUPORTADO',
        })),
      ];
    } else {
      archiveName = selected.length === 1 ? selected[0].originalname : `Lote de ${selected.length} recibos`;
      archiveSha256 = null;
      storageMode = 'MULTI_OBJECT';
      items = [];
      const seenHashes = new Map();
      for (let index = 0; index < selected.length; index += 1) {
        const file = selected[index];
        const stored = await storeDirectFile({ buffer: file.buffer, fileName: file.originalname, contentType: file.mimetype || 'application/octet-stream' });
        uploadedKeys.push(stored.key);
        if (!storageBucket) storageBucket = stored.bucket;
        if (!storageKey) storageKey = stored.key;
        const prior = seenHashes.get(stored.sha256);
        if (!prior) seenHashes.set(stored.sha256, file.originalname);
        items.push({
          sequence_no: index + 1, file_name: file.originalname, file_sha256: stored.sha256,
          mime_type: file.mimetype || 'application/octet-stream', size_bytes: file.size || file.buffer.length,
          storage_key: stored.key, archive_entry_name: null,
          initial_status: prior ? 'DUPLICATE' : 'PENDING',
          initial_diagnostic: prior ? `Arquivo idêntico repetido no lote; primeira ocorrência: ${prior}.` : null,
        });
      }
    }

    const admin = getSupabaseAdmin();
    const { data, error } = await admin.rpc('sisha_create_receipt_import_job_atomic', {
      p_archive_name: archiveName,
      p_archive_sha256: archiveSha256,
      p_storage_bucket: storageBucket,
      p_storage_key: storageKey,
      p_storage_mode: storageMode,
      p_items: items,
      p_actor_auth_user_id: actor?.auth_user_id || null,
      p_actor_email: actor?.email || null,
      p_actor_role: actor?.role || null,
      p_request_id: requestId || null,
    });
    if (error) throw error;
    return getReceiptImportJob(data);
  } catch (error) {
    await Promise.all(uploadedKeys.map((key) => deletePrivateObject({ key }).catch(() => null)));
    throw error;
  }
}

const RECEIPT_ACTIONABLE_ITEM_STATUSES = new Set(['READY', 'REVIEW', 'CONFLICT', 'ERROR']);
const RECEIPT_RESOLVED_ITEM_STATUSES = new Set(['SAVED', 'DUPLICATE', 'IGNORED']);

function normalizedReceiptHash(value = '') {
  return String(value || '').trim().toLowerCase();
}

function chunkValues(values = [], size = 200) {
  const chunks = [];
  for (let index = 0; index < values.length; index += size) chunks.push(values.slice(index, index + size));
  return chunks;
}

async function savedReceiptsByHash(items = []) {
  const hashes = [...new Set((items || [])
    .map((item) => normalizedReceiptHash(item.file_sha256))
    .filter(Boolean))];
  if (!hashes.length) return new Map();

  const admin = getSupabaseAdmin();
  const rows = [];
  for (const batch of chunkValues(hashes)) {
    const { data, error } = await admin
      .from('recebimentos')
      .select('id,numero_recibo,arquivo_hash')
      .in('arquivo_hash', batch);
    if (error) throw error;
    rows.push(...(data || []));
  }

  return new Map(rows
    .map((row) => [normalizedReceiptHash(row.arquivo_hash), row])
    .filter(([hash]) => Boolean(hash)));
}

function effectiveReceiptImportItem(item = {}, savedByHash = new Map()) {
  const status = String(item.status || '').toUpperCase();
  const hash = normalizedReceiptHash(item.file_sha256);
  const savedReceipt = hash ? savedByHash.get(hash) : null;

  if (savedReceipt && RECEIPT_ACTIONABLE_ITEM_STATUSES.has(status)) {
    return {
      ...item,
      status: 'SAVED',
      effective_status: 'SAVED',
      resolved_by_receipt: true,
      resolved_receipt_id: savedReceipt.id,
      resolved_receipt_number: savedReceipt.numero_recibo || null,
      diagnostic: `Arquivo já gravado no módulo de Recibos como Recibo ${savedReceipt.numero_recibo || 'existente'}; nenhuma nova conferência é necessária.`,
    };
  }

  return {
    ...item,
    effective_status: status,
    resolved_by_receipt: status === 'SAVED',
  };
}

function summarizeReceiptImportItems(items = []) {
  const counters = {
    total_items: items.length,
    processed_items: 0,
    ready_items: 0,
    review_items: 0,
    conflict_items: 0,
    duplicate_items: 0,
    error_items: 0,
    saved_items: 0,
    ignored_items: 0,
    pending_action_items: 0,
  };

  let backgroundItems = 0;
  for (const item of items) {
    const status = String(item.effective_status || item.status || '').toUpperCase();
    if (['READY', 'REVIEW', 'CONFLICT', 'DUPLICATE', 'ERROR', 'SAVED', 'IGNORED'].includes(status)) counters.processed_items += 1;
    if (status === 'READY') counters.ready_items += 1;
    else if (status === 'REVIEW') counters.review_items += 1;
    else if (status === 'CONFLICT') counters.conflict_items += 1;
    else if (status === 'DUPLICATE') counters.duplicate_items += 1;
    else if (status === 'ERROR') counters.error_items += 1;
    else if (status === 'SAVED') counters.saved_items += 1;
    else if (status === 'IGNORED') counters.ignored_items += 1;
    else if (status === 'PENDING' || status === 'PROCESSING') backgroundItems += 1;
  }

  counters.pending_action_items = counters.ready_items + counters.review_items + counters.conflict_items + counters.error_items;
  counters.resolved_items = counters.saved_items + counters.duplicate_items + counters.ignored_items;
  counters.resolved = counters.total_items > 0
    && counters.resolved_items === counters.total_items
    && counters.pending_action_items === 0
    && backgroundItems === 0;
  return counters;
}

function buildReceiptImportJobReadModel(job = {}, items = [], savedByHash = new Map()) {
  const effectiveItems = (items || []).map((item) => effectiveReceiptImportItem(item, savedByHash));
  const summary = summarizeReceiptImportItems(effectiveItems);
  return {
    ...job,
    ...summary,
    effective_status: summary.resolved ? 'RESOLVED' : String(job.status || '').toUpperCase(),
    items: effectiveItems,
  };
}

async function listReceiptImportJobs(limit = 20) {
  const safeLimit = Math.max(1, Math.min(Number(limit || 20), 50));
  const admin = getSupabaseAdmin();
  const { data: jobs, error } = await admin
    .from('receipt_import_jobs').select('*').order('created_at', { ascending: false }).limit(safeLimit);
  if (error) throw error;
  if (!(jobs || []).length) return [];

  const jobIds = jobs.map((job) => job.id).filter(Boolean);
  const { data: items, error: itemsError } = await admin
    .from('receipt_import_job_items')
    .select('id,job_id,status,file_sha256')
    .in('job_id', jobIds);
  if (itemsError) throw itemsError;

  const savedByHash = await savedReceiptsByHash(items || []);
  const byJob = new Map();
  for (const item of items || []) {
    const bucket = byJob.get(item.job_id) || [];
    bucket.push(item);
    byJob.set(item.job_id, bucket);
  }

  return jobs.map((job) => {
    const readModel = buildReceiptImportJobReadModel(job, byJob.get(job.id) || [], savedByHash);
    const { items: _items, ...summary } = readModel;
    return summary;
  });
}

async function getReceiptImportJob(jobId) {
  const admin = getSupabaseAdmin();
  const [{ data: job, error: jobError }, { data: items, error: itemsError }] = await Promise.all([
    admin.from('receipt_import_jobs').select('*').eq('id', jobId).single(),
    admin.from('receipt_import_job_items').select('*').eq('job_id', jobId).order('sequence_no', { ascending: true }),
  ]);
  if (jobError) throw jobError;
  if (itemsError) throw itemsError;
  const savedByHash = await savedReceiptsByHash(items || []);
  return buildReceiptImportJobReadModel(job, items || [], savedByHash);
}

async function markReceiptImportItemSaved({ itemId, actor, requestId }) {
  const { error } = await getSupabaseAdmin().rpc('sisha_mark_receipt_import_item_saved', {
    p_item_id: itemId,
    p_actor_email: actor?.email || null,
    p_actor_role: actor?.role || null,
    p_request_id: requestId || null,
  });
  if (error) throw error;
}

async function claimItem() {
  const { data, error } = await getSupabaseAdmin().rpc('sisha_claim_receipt_import_item', {
    p_worker_id: WORKER_ID,
    p_lease_seconds: LEASE_SECONDS,
  });
  if (error) {
    if (/sisha_claim_receipt_import_item|does not exist|schema cache/i.test(error.message || '')) return null;
    throw error;
  }
  return Array.isArray(data) && data.length ? data[0] : null;
}

async function renewLease(claim) {
  const { data, error } = await getSupabaseAdmin().rpc('sisha_renew_receipt_import_item_lease', {
    p_item_id: claim.item_id,
    p_claim_token: claim.claim_token,
    p_lease_seconds: LEASE_SECONDS,
  });
  if (error) throw error;
  return data !== false;
}

async function withLeaseHeartbeat(claim, task) {
  const timer = setInterval(() => {
    renewLease(claim).catch((error) => {
      console.warn('[SISHA][receipt-import-worker] Não foi possível renovar lease; a conclusão do claim continuará fail-closed:', error.message || error);
    });
  }, LEASE_HEARTBEAT_MS);
  timer.unref?.();
  try { return await task(); } finally { clearInterval(timer); }
}

async function loadArchiveEntries(storageKey) {
  const cached = archiveCache.get(storageKey);
  if (cached && Date.now() - cached.loadedAt < 15 * 60 * 1000) return cached.entries;
  const inFlight = archiveLoads.get(storageKey);
  if (inFlight) return inFlight;
  const loading = (async () => {
    const object = await loadObject(storageKey);
    const unpacked = unpackReceiptZip(object.buffer, { outputMode: 'buffer' });
    const entries = new Map(unpacked.files.map((entry) => [entry.name, entry]));
    archiveCache.set(storageKey, { entries, loadedAt: Date.now() });
    if (archiveCache.size > 4) {
      const oldestKey = [...archiveCache.entries()].sort((a, b) => a[1].loadedAt - b[1].loadedAt)[0]?.[0];
      if (oldestKey && oldestKey !== storageKey) archiveCache.delete(oldestKey);
    }
    return entries;
  })();
  archiveLoads.set(storageKey, loading);
  try { return await loading; } finally { archiveLoads.delete(storageKey); }
}

async function fileForClaim(claim) {
  if (claim.storage_mode === 'ARCHIVE') {
    const entries = await loadArchiveEntries(claim.storage_key);
    const entry = entries.get(claim.archive_entry_name || claim.file_name);
    if (!entry?.content) throw new Error(`Arquivo ${claim.file_name} não encontrado dentro do ZIP persistido.`);
    return { originalname: claim.file_name, mimetype: claim.mime_type || entry.mime, size: entry.size, buffer: entry.content };
  }
  const object = await loadObject(claim.storage_key);
  return { originalname: claim.file_name, mimetype: claim.mime_type || object.contentType, size: object.buffer.length, buffer: object.buffer };
}

async function completeItem(claim, payload) {
  const { error } = await getSupabaseAdmin().rpc('sisha_complete_receipt_import_item', {
    p_item_id: claim.item_id,
    p_claim_token: claim.claim_token,
    p_status: payload.status,
    p_source_method: payload.sourceMethod || null,
    p_receipt_number: payload.receiptNumber || null,
    p_receipt_type: payload.receiptType || null,
    p_item_count: payload.itemCount || 0,
    p_warnings: payload.warnings || [],
    p_diagnostic: payload.diagnostic || null,
    p_triage_payload: payload.form || null,
    p_analysis_version: ANALYSIS_VERSION,
    p_reused_analysis: Boolean(payload.reusedAnalysis),
  });
  if (error) throw error;
}

async function findSavedReceiptByHash(hash) {
  if (!hash) return null;
  const { data, error } = await getSupabaseAdmin()
    .from('recebimentos')
    .select('id,numero_recibo,arquivo_hash')
    .eq('arquivo_hash', hash)
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return data || null;
}

async function processClaim(claim) {
  try {
    await withLeaseHeartbeat(claim, async () => {
      const fileHash = String(claim.file_sha256 || '').toLowerCase();
      const existing = await findSavedReceiptByHash(fileHash);
      if (existing) {
        await completeItem(claim, {
          status: 'DUPLICATE', sourceMethod: 'HASH_DB', receiptNumber: existing.numero_recibo || null,
          receiptType: null, itemCount: 0, warnings: [],
          diagnostic: `Arquivo idêntico já importado como Recibo ${existing.numero_recibo || 'existente'}.`,
          form: null, reusedAnalysis: true,
        });
        return;
      }
      const file = await fileForClaim(claim);
      const analysis = await analyzeReceiptFile({
        file,
        fileHash,
        actor: actorFromClaim(claim),
        aiSemaphore: withAiSemaphore,
      });
      const classified = await classifyTriage({
        jobId: claim.job_id,
        itemId: claim.item_id,
        fileHash,
        analysis,
      });
      await completeItem(claim, {
        ...classified,
        sourceMethod: analysis.sourceMethod,
        receiptNumber: classified.form?.numero_recibo,
        receiptType: classified.form?.tipo_recebimento,
        reusedAnalysis: analysis.reusedAnalysis,
      });
    });
  } catch (error) {
    try {
      await completeItem(claim, {
        status: 'ERROR', sourceMethod: 'ERROR', receiptNumber: null, receiptType: null,
        itemCount: 0, warnings: [], diagnostic: error.message || 'Falha ao processar recibo.', form: null,
      });
    } catch (completeError) {
      console.error('[SISHA][receipt-import-worker] Falha ao finalizar item após erro:', completeError.message || completeError);
    }
  }
}

async function requeueStaleActiveAnalyses() {
  const admin = getSupabaseAdmin();
  const { data: jobs, error: jobsError } = await admin
    .from('receipt_import_jobs')
    .select('id,status')
    .in('status', ['QUEUED', 'PROCESSING', 'REVIEW_READY']);
  if (jobsError) {
    if (/receipt_import_jobs|does not exist|schema cache/i.test(jobsError.message || '')) return 0;
    throw jobsError;
  }
  const jobIds = (jobs || []).map((job) => job.id).filter(Boolean);
  if (!jobIds.length) return 0;

  const { data: candidates, error: itemError } = await admin
    .from('receipt_import_job_items')
    .select('id,job_id,status,analysis_version')
    .in('job_id', jobIds)
    .in('status', ['READY', 'REVIEW', 'CONFLICT', 'ERROR']);
  if (itemError) throw itemError;

  const staleIds = (candidates || [])
    .filter((item) => String(item.analysis_version || '') !== ANALYSIS_VERSION)
    .map((item) => item.id)
    .filter(Boolean);
  if (!staleIds.length) return 0;

  const { error: updateError } = await admin
    .from('receipt_import_job_items')
    .update({
      status: 'PENDING',
      claim_token: null,
      claimed_by: null,
      claimed_at: null,
      lease_until: null,
      processed_at: null,
      source_method: null,
      receipt_number: null,
      receipt_type: null,
      item_count: 0,
      warnings: [],
      diagnostic: `Reanálise automática requerida pela versão ${ANALYSIS_VERSION}.`,
      triage_payload: null,
      analysis_version: null,
      reused_analysis: false,
      updated_at: new Date().toISOString(),
    })
    .in('id', staleIds);
  if (updateError) throw updateError;

  const affectedJobIds = [...new Set((candidates || [])
    .filter((item) => staleIds.includes(item.id))
    .map((item) => item.job_id)
    .filter(Boolean))];
  if (affectedJobIds.length) {
    const { error: jobUpdateError } = await admin
      .from('receipt_import_jobs')
      .update({
        status: 'QUEUED',
        completed_at: null,
        last_heartbeat_at: new Date().toISOString(),
      })
      .in('id', affectedJobIds);
    if (jobUpdateError) throw jobUpdateError;
  }
  return staleIds.length;
}

async function bootstrapWorkerLoops() {
  try {
    const requeued = await requeueStaleActiveAnalyses();
    if (requeued > 0) {
      console.log(`[SISHA][receipt-import-worker] ${requeued} análise(s) antiga(s) recolocada(s) na fila para ${ANALYSIS_VERSION}.`);
    }
  } catch (error) {
    console.warn('[SISHA][receipt-import-worker] Não foi possível revalidar análises antigas; worker seguirá sem sobrescrever dados operacionais:', error.message || error);
  }
  for (let index = 0; index < STRUCTURAL_CONCURRENCY; index += 1) {
    workerLoop(index + 1).catch((error) => console.error('[SISHA][receipt-import-worker] loop fatal:', error));
  }
}

async function workerLoop(index) {
  while (!stopping) {
    try {
      const claim = await claimItem();
      if (!claim) { await sleep(POLL_MS); continue; }
      await processClaim(claim);
    } catch (error) {
      console.error(`[SISHA][receipt-import-worker:${index}]`, error.message || error);
      await sleep(Math.max(POLL_MS, 3000));
    }
  }
}

function startReceiptImportWorker() {
  if (workerStarted) return;
  workerStarted = true;
  stopping = false;
  bootstrapWorkerLoops().catch((error) => console.error('[SISHA][receipt-import-worker] bootstrap fatal:', error));
  console.log(`[SISHA][receipt-import-worker] Background ativo: concorrência estrutural=${STRUCTURAL_CONCURRENCY}, IA=1, lease=${LEASE_SECONDS}s, análise=${ANALYSIS_VERSION}.`);
}

function stopReceiptImportWorker() { stopping = true; }

module.exports = {
  createReceiptImportJob,
  listReceiptImportJobs,
  getReceiptImportJob,
  markReceiptImportItemSaved,
  startReceiptImportWorker,
  stopReceiptImportWorker,
  WORKER_ID,
  requeueStaleActiveAnalyses,
};
