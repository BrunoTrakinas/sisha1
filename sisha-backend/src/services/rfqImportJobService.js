const os = require('os');
const crypto = require('crypto');
const { getSupabaseAdmin } = require('../config/supabaseAdminClient');
const { parseRfqDocument } = require('./rfqParserService');
const { assertConfigured, sha256, storeFile, loadFile, deletePrivateObject } = require('./rfqImportStorageService');

const ANALYSIS_VERSION = 'C2.7-HF2-LOCAL-OCR-RETRY-CACHE-1';
const WORKER_ID = `${os.hostname()}-${process.pid}-${crypto.randomUUID().slice(0, 8)}`;
const POLL_MS = Math.max(1000, Math.min(Number(process.env.RFQ_IMPORT_POLL_MS || 2000), 10000));
const LEASE_SECONDS = Math.max(60, Math.min(Number(process.env.RFQ_IMPORT_LEASE_SECONDS || 180), 900));
const LEASE_HEARTBEAT_MS = Math.max(15000, Math.min(Math.floor((LEASE_SECONDS * 1000) / 3), 30000));

let workerStarted = false;
let stopping = false;

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

function withAnalysisState(row) {
  if (!row) return row;
  const analysisCurrent = String(row.analysis_version || '') === ANALYSIS_VERSION;
  return {
    ...row,
    analysis_current: analysisCurrent,
    legacy_analysis: !analysisCurrent,
  };
}

async function findPersistedRfqResolution(jobRows) {
  const rows = (Array.isArray(jobRows) ? jobRows : [jobRows]).filter(Boolean);
  const ids = Array.from(new Set(rows.map((row) => row.id).filter(Boolean).map((value) => String(value))));
  const hashes = Array.from(new Set(rows.map((row) => row.file_sha256).filter(Boolean).map((value) => String(value))));
  if (!ids.length && !hashes.length) return { persistedIds: new Set(), persistedHashes: new Set() };

  const admin = getSupabaseAdmin();
  let siblings = rows
    .filter((row) => row.id)
    .map((row) => ({ id: row.id, file_sha256: row.file_sha256 || null }));

  // C3.4 HF1: um mesmo PDF pode possuir varios jobs historicos (leitor antigo,
  // reprocessamento atual etc.). Depois que QUALQUER job do mesmo SHA-256 gera
  // rfq_cotacoes, nenhum job irmao pode ressuscitar como pendencia.
  if (hashes.length) {
    const { data: siblingRows, error: siblingError } = await admin
      .from('rfq_import_jobs')
      .select('id,file_sha256')
      .in('file_sha256', hashes);

    if (siblingError) {
      if (!/file_sha256|does not exist|schema cache/i.test(siblingError.message || '')) throw siblingError;
    } else {
      siblings = siblingRows || siblings;
    }
  }

  const siblingIds = Array.from(new Set(siblings.map((row) => row.id).filter(Boolean).map((value) => String(value))));
  if (!siblingIds.length) return { persistedIds: new Set(), persistedHashes: new Set() };

  const { data, error } = await admin
    .from('rfq_cotacoes')
    .select('rfq_import_job_id')
    .in('rfq_import_job_id', siblingIds);

  // Compatibilidade defensiva com uma base que ainda nao recebeu C2.4.
  if (error) {
    if (/rfq_import_job_id|does not exist|schema cache/i.test(error.message || '')) {
      return { persistedIds: new Set(), persistedHashes: new Set() };
    }
    throw error;
  }

  const persistedIds = new Set(
    (data || [])
      .map((row) => row.rfq_import_job_id)
      .filter(Boolean)
      .map((value) => String(value))
  );

  const persistedHashes = new Set(
    siblings
      .filter((row) => persistedIds.has(String(row.id)) && row.file_sha256)
      .map((row) => String(row.file_sha256))
  );

  return { persistedIds, persistedHashes };
}

async function reconcilePersistedRfqState(rows) {
  const list = (Array.isArray(rows) ? rows : [rows]).filter(Boolean);
  if (!list.length) return [];

  const unresolved = list.filter((row) => row.id && String(row.status || '').toUpperCase() !== 'SAVED');
  const { persistedIds, persistedHashes } = await findPersistedRfqResolution(unresolved);

  return list.map((row) => {
    const exactPersisted = persistedIds.has(String(row.id));
    const sameDocumentPersisted = Boolean(
      row.file_sha256 && persistedHashes.has(String(row.file_sha256))
    );

    return withAnalysisState(
      exactPersisted || sameDocumentPersisted
        ? {
            ...row,
            status: 'SAVED',
            resolved_by_persisted_quote: exactPersisted,
            resolved_by_same_document: !exactPersisted && sameDocumentPersisted,
            resolution_source: exactPersisted
              ? 'rfq_cotacoes.rfq_import_job_id'
              : 'rfq_import_jobs.file_sha256 -> rfq_cotacoes.rfq_import_job_id',
          }
        : row
    );
  });
}

async function getRfqImportJob(jobId) {
  const { data, error } = await getSupabaseAdmin()
    .from('rfq_import_jobs')
    .select('*')
    .eq('id', jobId)
    .single();
  if (error) throw error;
  const [resolved] = await reconcilePersistedRfqState([data]);
  return resolved;
}

async function listRfqImportJobs(limit = 20) {
  const safeLimit = Math.max(1, Math.min(Number(limit || 20), 50));
  const { data, error } = await getSupabaseAdmin()
    .from('rfq_import_jobs')
    .select('id,status,file_name,file_sha256,document_type,quotation_number,analysis_method,analysis_version,quality_status,diagnostic,created_at,updated_at,started_at,completed_at,saved_at,created_by_email')
    .order('created_at', { ascending: false })
    .limit(safeLimit);
  if (error) throw error;
  return reconcilePersistedRfqState(data || []);
}

async function createRfqImportJob({ file, actor, requestId }) {
  if (!file?.buffer) throw new Error('Selecione uma Cotação/RFQ (.pdf, .xlsx ou .xls).');
  assertConfigured();

  const hash = sha256(file.buffer);
  const admin = getSupabaseAdmin();
  const { data: reusable, error: reusableError } = await admin
    .from('rfq_import_jobs')
    .select('*')
    .eq('file_sha256', hash)
    .eq('analysis_version', ANALYSIS_VERSION)
    .in('status', ['REVIEW_READY', 'SAVED'])
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (reusableError && !/does not exist|schema cache/i.test(reusableError.message || '')) throw reusableError;

  // C2.7 HF2: resultado bloqueado por indisponibilidade TRANSITÓRIA do OCR local
  // não pode virar cache autoritativo. Ex.: o primeiro processamento ocorreu antes
  // de Tesseract/Poppler entrarem no PATH/.env; após corrigir o ambiente, reenviar
  // o mesmo PDF precisa criar novo job e executar OCR de verdade, preservando o
  // job antigo apenas como evidência/auditoria.
  const reusableMethod = String(
    reusable?.analysis_method
      || reusable?.result_payload?.metadados?.metodo_leitura
      || ''
  );
  const reusableBlocking = [
    reusable?.diagnostic,
    ...(Array.isArray(reusable?.result_payload?.metadados?.quality_warnings)
      ? reusable.result_payload.metadados.quality_warnings
      : []),
    ...(Array.isArray(reusable?.result_payload?.visualCommercial?.blocking)
      ? reusable.result_payload.visualCommercial.blocking
      : []),
  ].filter(Boolean).join(' | ');
  const transientOcrUnavailable = Boolean(
    reusable?.result_payload?.visualCommercial?.unavailable === true
    || /OCR_LOCAL_INDISPONIVEL_BLOQUEADO/i.test(reusableMethod)
    || /TESSERACT_INDISPONIVEL|PDFTOPPM_INDISPONIVEL|OCR local indispon[ií]vel/i.test(reusableBlocking)
  );

  if (reusable?.result_payload && !transientOcrUnavailable) {
    return { ...reusable, reused_analysis: true };
  }

  const stored = await storeFile({
    buffer: file.buffer,
    fileName: file.originalname,
    contentType: file.mimetype || 'application/octet-stream',
  });

  try {
    const { data, error } = await admin
      .from('rfq_import_jobs')
      .insert({
        status: 'QUEUED',
        file_name: file.originalname || 'documento',
        file_sha256: stored.sha256,
        mime_type: file.mimetype || 'application/octet-stream',
        size_bytes: file.size || file.buffer.length,
        storage_bucket: stored.bucket,
        storage_key: stored.key,
        analysis_version: ANALYSIS_VERSION,
        created_by_auth_user_id: actor?.auth_user_id || null,
        created_by_email: actor?.email || null,
        created_by_role: actor?.role || null,
        request_id: requestId || null,
      })
      .select('*')
      .single();
    if (error) throw error;
    return data;
  } catch (error) {
    await deletePrivateObject({ key: stored.key }).catch(() => null);
    throw error;
  }
}


async function reprocessRfqImportJob({ jobId, actor, requestId }) {
  const original = await getRfqImportJob(jobId);
  if (!original) throw new Error('Processamento comercial não encontrado.');
  if (String(original.status || '').toUpperCase() === 'SAVED') {
    const error = new Error('Documento já gravado: use o gerenciador comercial para desativar referências salvas.');
    error.code = 'RFQ_JOB_ALREADY_SAVED';
    throw error;
  }
  if (!original.storage_bucket || !original.storage_key || !original.file_sha256) {
    const error = new Error('Arquivo original indisponível para reprocessamento seguro. Use “Subir novamente”.');
    error.code = 'RFQ_JOB_SOURCE_UNAVAILABLE';
    throw error;
  }

  const admin = getSupabaseAdmin();
  const { data: inflight, error: inflightError } = await admin
    .from('rfq_import_jobs')
    .select('*')
    .eq('file_sha256', original.file_sha256)
    .eq('analysis_version', ANALYSIS_VERSION)
    .in('status', ['QUEUED', 'PROCESSING'])
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (inflightError && !/does not exist|schema cache/i.test(inflightError.message || '')) throw inflightError;
  if (inflight) return { ...withAnalysisState(inflight), reused_inflight: true };

  // C3.3: reprocessar reaproveita o MESMO objeto privado já armazenado. Não há
  // delete, download para o cliente ou nova cópia em R2; o histórico anterior
  // permanece íntegro e um novo job recebe a versão atual do leitor.
  const { data, error } = await admin
    .from('rfq_import_jobs')
    .insert({
      status: 'QUEUED',
      file_name: original.file_name,
      file_sha256: original.file_sha256,
      mime_type: original.mime_type,
      size_bytes: original.size_bytes || 0,
      storage_bucket: original.storage_bucket,
      storage_key: original.storage_key,
      analysis_version: ANALYSIS_VERSION,
      diagnostic: `Reprocessamento C3.3 solicitado a partir do job ${original.id}.`,
      created_by_auth_user_id: actor?.auth_user_id || null,
      created_by_email: actor?.email || null,
      created_by_role: actor?.role || null,
      request_id: requestId || null,
    })
    .select('*')
    .single();
  if (error) throw error;
  return withAnalysisState(data);
}

async function discardRfqImportJob({ jobId, actor, reason }) {
  const motivo = String(reason || '').trim().slice(0, 600);
  if (!motivo) {
    const error = new Error('Informe o motivo da exclusão desta pendência.');
    error.code = 'RFQ_DISCARD_REASON_REQUIRED';
    throw error;
  }

  const original = await getRfqImportJob(jobId);
  const status = String(original?.status || '').toUpperCase();
  if (status === 'SAVED') {
    const error = new Error('Este documento já foi gravado e não pode ser excluído pela Central. Desative as referências no gerenciador comercial.');
    error.code = 'RFQ_JOB_ALREADY_SAVED';
    throw error;
  }
  if (!['REVIEW_READY', 'ERROR'].includes(status)) {
    const error = new Error(`Processamento em ${status || 'estado desconhecido'} não pode ser excluído agora.`);
    error.code = 'RFQ_JOB_NOT_DISCARDABLE';
    throw error;
  }

  const actorLabel = String(actor?.email || actor?.auth_user_id || 'ADMIN').slice(0, 180);
  const previousDiagnostic = String(original?.diagnostic || '').trim();
  const auditDiagnostic = [
    `DESCARTADO_PELO_ADMIN em ${new Date().toISOString()}`,
    `usuário=${actorLabel}`,
    `motivo=${motivo}`,
    previousDiagnostic ? `diagnóstico_anterior=${previousDiagnostic}` : null,
  ].filter(Boolean).join(' | ');

  // “Excluir” é soft-discard auditável: some das pendências e nunca vira preço,
  // mas result_payload, hash, arquivo privado e trilha histórica são preservados.
  const { data, error } = await getSupabaseAdmin()
    .from('rfq_import_jobs')
    .update({
      status: 'ERROR',
      quality_status: 'DISCARDED',
      diagnostic: auditDiagnostic,
      claimed_by: null,
      claim_token: null,
      claimed_at: null,
      lease_until: null,
      updated_at: new Date().toISOString(),
    })
    .eq('id', jobId)
    .in('status', ['REVIEW_READY', 'ERROR'])
    .select('*')
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new Error('A pendência mudou de estado antes da exclusão. Atualize a Central e tente novamente.');
  return withAnalysisState(data);
}

async function claimJob() {
  const { data, error } = await getSupabaseAdmin().rpc('sisha_claim_rfq_import_job', {
    p_worker_id: WORKER_ID,
    p_lease_seconds: LEASE_SECONDS,
  });
  if (error) {
    if (/sisha_claim_rfq_import_job|does not exist|schema cache/i.test(error.message || '')) return null;
    throw error;
  }
  return Array.isArray(data) && data.length ? data[0] : null;
}

async function renewLease(claim) {
  const { data, error } = await getSupabaseAdmin().rpc('sisha_renew_rfq_import_job_lease', {
    p_job_id: claim.job_id,
    p_claim_token: claim.claim_token,
    p_lease_seconds: LEASE_SECONDS,
  });
  if (error) throw error;
  return data !== false;
}

async function withLeaseHeartbeat(claim, task) {
  const timer = setInterval(() => {
    renewLease(claim).catch((error) => {
      console.warn('[SISHA][rfq-import-worker] Falha ao renovar lease; conclusão seguirá fail-closed:', error.message || error);
    });
  }, LEASE_HEARTBEAT_MS);
  timer.unref?.();
  try { return await task(); } finally { clearInterval(timer); }
}

async function completeJob(claim, payload) {
  const { error } = await getSupabaseAdmin().rpc('sisha_complete_rfq_import_job', {
    p_job_id: claim.job_id,
    p_claim_token: claim.claim_token,
    p_status: payload.status,
    p_result_payload: payload.resultPayload || null,
    p_document_type: payload.documentType || null,
    p_quotation_number: payload.quotationNumber || null,
    p_analysis_method: payload.analysisMethod || null,
    p_quality_status: payload.qualityStatus || null,
    p_diagnostic: payload.diagnostic || null,
  });
  if (error) throw error;
}

async function processClaim(claim) {
  try {
    await withLeaseHeartbeat(claim, async () => {
      const object = await loadFile(claim.storage_key);
      const parsed = await parseRfqDocument({
        originalname: claim.file_name,
        mimetype: claim.mime_type || object.contentType || 'application/octet-stream',
        size: object.buffer.length,
        buffer: object.buffer,
      });
      const items = Array.isArray(parsed?.items) ? parsed.items : [];
      const metadata = parsed?.metadados || {};
      await completeJob(claim, {
        status: 'REVIEW_READY',
        resultPayload: { ...parsed, items },
        documentType: metadata.documento_tipo || null,
        quotationNumber: metadata.quotation_number || null,
        analysisMethod: metadata.metodo_leitura || null,
        qualityStatus: metadata.quality_status || 'REVIEW',
        diagnostic: items.length
          ? `${items.length} item(ns) extraído(s). Revisão humana obrigatória antes da gravação.`
          : 'Documento processado sem itens. Revisão humana necessária.',
      });
    });
  } catch (error) {
    try {
      await completeJob(claim, {
        status: 'ERROR',
        diagnostic: error.message || 'Falha ao processar documento comercial.',
      });
    } catch (completeError) {
      console.error('[SISHA][rfq-import-worker] Falha ao registrar erro do job:', completeError.message || completeError);
    }
  }
}

async function markRfqImportJobSaved(jobId) {
  if (!jobId) return;
  const { error } = await getSupabaseAdmin().rpc('sisha_mark_rfq_import_job_saved', { p_job_id: jobId });
  if (error) throw error;
}

async function workerLoop() {
  while (!stopping) {
    try {
      const claim = await claimJob();
      if (!claim) { await sleep(POLL_MS); continue; }
      await processClaim(claim);
    } catch (error) {
      console.error('[SISHA][rfq-import-worker]', error.message || error);
      await sleep(Math.max(POLL_MS, 3000));
    }
  }
}

function startRfqImportWorker() {
  if (workerStarted) return;
  workerStarted = true;
  stopping = false;
  workerLoop().catch((error) => console.error('[SISHA][rfq-import-worker] loop fatal:', error));
  console.log(`[SISHA][rfq-import-worker] Background persistente ativo: lease=${LEASE_SECONDS}s, análise=${ANALYSIS_VERSION}.`);
}

function stopRfqImportWorker() { stopping = true; }

module.exports = {
  ANALYSIS_VERSION,
  WORKER_ID,
  createRfqImportJob,
  getRfqImportJob,
  listRfqImportJobs,
  reprocessRfqImportJob,
  discardRfqImportJob,
  markRfqImportJobSaved,
  startRfqImportWorker,
  stopRfqImportWorker,
};
