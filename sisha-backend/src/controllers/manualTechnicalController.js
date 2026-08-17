const supabase = require('../config/supabaseClient');
const { getSupabaseAdmin, checkSupabaseAdminReadiness } = require('../config/supabaseAdminClient');
const { registrarAuditoria } = require('../utils/auditLogger');
const { parseManualTechnicalPdf, hashBuffer } = require('../services/manualTechnicalService');
const { isConfigured: isR2Configured, putPrivateObject, getPrivateObject, deletePrivateObject, checkReadiness } = require('../services/manualStorageService');
const { indexManualTechnicalById, removeManualTechnicalRag } = require('../services/chatLinceRagService');

function normalizeCode(value = '') {
  return String(value || '').trim().toUpperCase();
}

function normalizePn(value = '') {
  return String(value || '').trim().toUpperCase().replace(/[‐‑–—]/g, '-');
}

function safeJson(value, fallback = {}) {
  if (!value) return fallback;
  if (typeof value === 'object') return value;
  try { return JSON.parse(value); } catch (_) { return fallback; }
}

function cleanMetadata(input = {}) {
  return {
    codigo: normalizeCode(input.codigo),
    tipo_manual: normalizeCode(input.tipo_manual || 'WTP'),
    titulo: String(input.titulo || '').trim() || null,
    fabricante: String(input.fabricante || '').trim() || null,
    ata_dmc: String(input.ata_dmc || '').trim() || null,
    revisao: String(input.revisao || '').trim() || null,
    data_revisao: input.data_revisao || null,
    observacoes: String(input.observacoes || '').trim() || null,
  };
}


function boolValue(value) {
  if (typeof value === 'boolean') return value;
  return ['1', 'true', 'sim', 'yes', 'on'].includes(String(value || '').trim().toLowerCase());
}

function safeSegment(value, fallback = 'SEM_REVISAO') {
  const clean = String(value || '').trim().toUpperCase()
    .replace(/[‐‑–—]/g, '-')
    .replace(/[^A-Z0-9._-]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return clean || fallback;
}

function buildR2Key({ codigo, revisao, hash, fileName }) {
  const code = safeSegment(codigo, 'MANUAL');
  const revision = safeSegment(revisao, 'SEM_REVISAO');
  const baseName = String(fileName || `${code}.pdf`)
    .replace(/[\r\n]/g, '_')
    .replace(/[\\/]+/g, '_')
    .replace(/[^A-Za-z0-9._-]+/g, '_')
    .slice(0, 120) || `${code}.pdf`;
  return `manuals/wtp/${code}/revisions/${revision}/${String(hash || '').slice(0, 16)}/${baseName}`;
}

async function findCurrentManualByCode(code, db = supabase) {
  const normalized = normalizeCode(code);
  if (!normalized) return null;
  const { data, error } = await db
    .from('manuais_tecnicos')
    .select('*')
    .eq('codigo', normalized)
    .eq('ativo', true)
    .order('updated_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return data || null;
}

async function findDuplicateHash(hash, db = supabase) {
  if (!hash) return null;
  const { data, error } = await db
    .from('manuais_tecnicos')
    .select('id,codigo,revisao,arquivo_nome,ativo,revision_status')
    .eq('arquivo_hash', hash)
    .order('updated_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return data || null;
}

async function replaceManualChildren(db, manualId, parsed) {
  const tables = ['manual_tecnico_pns', 'manual_tecnico_falhas', 'manual_tecnico_recursos', 'manual_tecnico_trechos'];
  for (const table of tables) {
    const { error } = await db.from(table).delete().eq('manual_id', manualId);
    if (error) throw error;
  }

  const insertChunked = async (table, rows) => {
    const payload = (rows || []).map((row) => ({ ...row, manual_id: manualId }));
    for (let i = 0; i < payload.length; i += 500) {
      const { error } = await db.from(table).insert(payload.slice(i, i + 500));
      if (error) throw error;
    }
  };

  await insertChunked('manual_tecnico_pns', parsed.pns || []);
  await insertChunked('manual_tecnico_falhas', parsed.falhas || []);
  await insertChunked('manual_tecnico_recursos', parsed.recursos || []);
  await insertChunked('manual_tecnico_trechos', parsed.trechos || []);
}

async function syncPrincipalPnRows(db, manualId, pns = [], titulo = null) {
  const normalized = Array.from(new Set((pns || []).map(normalizePn).filter(Boolean)));
  const { error: deleteError } = await db
    .from('manual_tecnico_pns')
    .delete()
    .eq('manual_id', manualId)
    .eq('tipo_vinculo', 'PN_PRINCIPAL');
  if (deleteError) throw deleteError;
  if (!normalized.length) return;
  const { error } = await db.from('manual_tecnico_pns').insert(normalized.map((pn) => ({
    manual_id: manualId, pn, fig: null, item: null, nomenclatura: titulo || 'PN principal do manual',
    tipo_vinculo: 'PN_PRINCIPAL', page_ref: 'Cadastro manual', metadata: { origem: 'CADASTRO_MANUAL' },
  })));
  if (error) throw error;
}

exports.previewManual = async (req, res) => {
  try {
    if (!req.file?.buffer) return res.status(400).json({ status: 'error', message: 'Selecione um PDF de manual técnico.' });
    const parsed = await parseManualTechnicalPdf(req.file.buffer, req.file.originalname || 'manual.pdf');

    // A prévia é uma rota exclusiva de Admin. Quando a credencial administrativa
    // estiver pronta, use a mesma visão do banco que a confirmação/importação usa.
    // Isso evita falso negativo de duplicidade quando RLS oculta manuais do cliente anon.
    const databaseAdmin = await checkSupabaseAdminReadiness();
    const previewDb = databaseAdmin.ready ? getSupabaseAdmin() : supabase;
    const duplicate = await findDuplicateHash(parsed.metadata.arquivo_hash, previewDb);
    const currentManual = parsed.metadata.codigo ? await findCurrentManualByCode(parsed.metadata.codigo, previewDb) : null;
    const upgrade = currentManual && currentManual.arquivo_hash !== parsed.metadata.arquivo_hash
      ? {
          current_id: currentManual.id,
          codigo: currentManual.codigo,
          revisao_atual: currentManual.revisao || null,
          revisao_nova: parsed.metadata.revisao || null,
          arquivo_atual: currentManual.arquivo_nome || null,
          storage_status: currentManual.storage_status || null,
        }
      : null;
    const storage = await checkReadiness().catch((error) => ({
      configured: isR2Configured(),
      head_bucket_ok: false,
      message: error.message || 'Falha ao validar R2.',
    }));

    return res.status(200).json({
      status: 'success',
      message: duplicate
        ? `Arquivo já existe como ${duplicate.codigo}. Nada foi gravado; revise antes de prosseguir.`
        : upgrade
          ? `Nova versão/revisão detectada para ${parsed.metadata.codigo}. Confirme a atualização antes de indexar.`
          : 'Manual lido. Nada foi gravado; revise os metadados e a indexação antes de confirmar.',
      data: {
        metadata: parsed.metadata,
        duplicate,
        upgrade,
        storage,
        database_admin: databaseAdmin,
        summary: {
          pns_indexados: parsed.pns.length,
          falhas_indexadas: parsed.falhas.length,
          recursos_indexados: parsed.recursos.length,
          trechos_indexados: parsed.trechos.length,
        },
        samples: {
          pns: parsed.pns.slice(0, 20),
          falhas: parsed.falhas.slice(0, 8),
          recursos: parsed.recursos.slice(0, 12),
        },
      },
    });
  } catch (error) {
    return res.status(400).json({ status: 'error', message: error.message || 'Falha ao ler o manual técnico.' });
  }
};

exports.importManual = async (req, res) => {
  let manualId = null;
  let uploadedR2Key = null;
  try {
    if (!req.file?.buffer) return res.status(400).json({ status: 'error', message: 'Selecione o PDF confirmado.' });
    const parsed = await parseManualTechnicalPdf(req.file.buffer, req.file.originalname || 'manual.pdf');
    const rawOverride = safeJson(req.body?.metadata, {});
    const override = cleanMetadata(rawOverride);
    const metadata = { ...parsed.metadata, ...Object.fromEntries(Object.entries(override).filter(([, value]) => value !== null && value !== '')) };
    const confirmUpgrade = boolValue(rawOverride.confirm_upgrade);
    if (!metadata.codigo) return res.status(400).json({ status: 'error', message: 'Código do manual é obrigatório.' });

    const databaseAdmin = await checkSupabaseAdminReadiness();
    if (!databaseAdmin.ready) {
      return res.status(503).json({
        status: 'error',
        code: 'SUPABASE_ADMIN_NOT_READY',
        message: databaseAdmin.message || 'A credencial administrativa do Supabase não está pronta no backend.',
        readiness: databaseAdmin,
      });
    }
    const adminDb = getSupabaseAdmin();

    const duplicate = await findDuplicateHash(parsed.metadata.arquivo_hash, adminDb);
    if (duplicate) {
      return res.status(409).json({ status: 'error', message: `Este mesmo arquivo já está ativo como ${duplicate.codigo}.` });
    }

    const currentManual = await findCurrentManualByCode(metadata.codigo, adminDb);
    if (currentManual && currentManual.arquivo_hash !== parsed.metadata.arquivo_hash && !confirmUpgrade) {
      return res.status(409).json({
        status: 'error',
        code: 'MANUAL_UPGRADE_CONFIRMATION_REQUIRED',
        message: `${metadata.codigo} já possui versão/revisão ativa${currentManual.revisao ? ` (${currentManual.revisao})` : ''}. Confirme explicitamente a atualização para preservar a versão anterior e ativar a nova.`,
        current: {
          id: currentManual.id,
          codigo: currentManual.codigo,
          revisao: currentManual.revisao,
          arquivo_nome: currentManual.arquivo_nome,
        },
      });
    }

    const warnings = [];
    if (!isR2Configured()) {
      return res.status(503).json({
        status: 'error',
        code: 'R2_MANUALS_NOT_CONFIGURED',
        message: 'O R2 privado de manuais não está configurado. Para o fluxo 28.12B, o PDF original deve ser armazenado no R2 antes da indexação definitiva.',
      });
    }

    const readiness = await checkReadiness();
    if (!readiness.head_bucket_ok) {
      return res.status(503).json({
        status: 'error',
        code: 'R2_MANUALS_NOT_READY',
        message: readiness.message || 'O bucket R2 de manuais não está acessível pelo backend.',
        readiness,
      });
    }

    const key = buildR2Key({
      codigo: metadata.codigo,
      revisao: metadata.revisao,
      hash: parsed.metadata.arquivo_hash,
      fileName: req.file.originalname || `${metadata.codigo}.pdf`,
    });
    const storage = await putPrivateObject({
      key,
      buffer: req.file.buffer,
      contentType: req.file.mimetype || 'application/pdf',
    });
    uploadedR2Key = storage.key;

    const payload = {
      codigo: metadata.codigo,
      tipo_manual: metadata.tipo_manual || 'WTP',
      titulo: metadata.titulo || null,
      fabricante: metadata.fabricante || null,
      ata_dmc: metadata.ata_dmc || null,
      revisao: metadata.revisao || null,
      data_revisao: metadata.data_revisao || null,
      pns_principais: parsed.metadata.pns_principais || [],
      arquivo_nome: req.file.originalname || metadata.arquivo_nome || null,
      arquivo_hash: parsed.metadata.arquivo_hash,
      r2_bucket: storage.bucket,
      r2_key: storage.key,
      storage_status: storage.status,
      storage_verified_at: new Date().toISOString(),
      original_uploaded_at: storage.uploaded_at || new Date().toISOString(),
      source_file_size: req.file.size || req.file.buffer.length,
      metodo_leitura: parsed.metadata.metodo_leitura,
      parser_version: parsed.metadata.parser_version || 'SISHA_28_12B_WTP_V2',
      revision_status: 'VIGENTE',
      supersedes_manual_id: currentManual?.id || null,
      observacoes: metadata.observacoes || null,
      metadata: {
        parser: parsed.metadata.parser_version || 'SISHA_28_12B_WTP_V2',
        pdf_kind: parsed.metadata.pdf_kind || 'DESCONHECIDO',
        counts: { pns: parsed.pns.length, falhas: parsed.falhas.length, recursos: parsed.recursos.length, trechos: parsed.trechos.length },
        r2_etag: storage.etag || null,
      },
      ativo: true,
      created_by_email: req.user?.email || null,
      updated_by_email: req.user?.email || null,
      updated_at: new Date().toISOString(),
    };

    const { data: manual, error } = await adminDb.from('manuais_tecnicos').insert(payload).select('*').single();
    if (error) throw error;
    manualId = manual.id;

    await replaceManualChildren(adminDb, manual.id, parsed);

    if (currentManual && currentManual.id !== manual.id) {
      const { error: supersedeError } = await adminDb
        .from('manuais_tecnicos')
        .update({
          ativo: false,
          revision_status: 'SUPERADA',
          superseded_by_manual_id: manual.id,
          updated_by_email: req.user?.email || null,
          updated_at: new Date().toISOString(),
        })
        .eq('id', currentManual.id);
      if (supersedeError) throw supersedeError;
      await removeManualTechnicalRag(currentManual.id, { db: adminDb }).catch(() => null);
    }

    const rag = await indexManualTechnicalById(manual.id, { db: adminDb }).catch((error) => ({ ok: false, reason: error.message }));
    if (!rag?.ok) {
      warnings.push(`Manual salvo e indexado nas tabelas técnicas, mas a atualização imediata do RAG do Chat Lince ficou pendente: ${rag?.reason || 'falha não detalhada'}.`);
    }

    await registrarAuditoria({
      req,
      action: currentManual ? 'MANUAL_TECNICO_REVISAO_IMPORTADA' : 'MANUAL_TECNICO_IMPORTADO',
      entity: 'MANUAIS_TECNICOS',
      entityId: manual.id,
      summary: currentManual
        ? `${req.user?.email || 'Usuário'} importou nova revisão/versão do manual ${manual.codigo}, preservando a anterior.`
        : `${req.user?.email || 'Usuário'} importou o manual ${manual.codigo}.`,
      details: {
        codigo: manual.codigo,
        revisao: manual.revisao,
        storage_status: manual.storage_status,
        r2_key: manual.r2_key,
        arquivo_hash: manual.arquivo_hash,
        supersedes_manual_id: currentManual?.id || null,
        counts: payload.metadata.counts,
        metodo_leitura: manual.metodo_leitura,
      },
      level: 'INFO', visibility: 'GOD', db: adminDb,
    });

    return res.status(200).json({
      status: warnings.length ? 'success_with_warnings' : 'success',
      message: currentManual
        ? `Nova revisão/versão de ${manual.codigo} indexada com sucesso. A versão anterior foi preservada como SUPERADA.`
        : `Manual ${manual.codigo} armazenado no R2 privado e indexado com sucesso.`,
      warnings,
      data: manual,
      rag,
    });
  } catch (error) {
    if (manualId) {
      try {
        const rollbackDb = getSupabaseAdmin();
        await rollbackDb.from('manuais_tecnicos').update({
          ativo: false,
          revision_status: 'FALHA_IMPORTACAO',
          storage_status: 'FAILED_ROLLED_BACK',
          r2_bucket: null,
          r2_key: null,
          updated_at: new Date().toISOString(),
        }).eq('id', manualId);
      } catch (_) {
        // Best effort.
      }
    }
    if (uploadedR2Key) {
      try { await deletePrivateObject({ key: uploadedR2Key }); } catch (_) { /* best effort */ }
    }
    return res.status(500).json({ status: 'error', message: error.message || 'Falha ao gravar manual técnico.' });
  }
};


exports.reindexManualRag = async (req, res) => {
  try {
    const manualId = String(req.params?.id || '').trim();
    if (!manualId) {
      return res.status(400).json({ status: 'error', message: 'ID do manual técnico é obrigatório.' });
    }

    const databaseAdmin = await checkSupabaseAdminReadiness();
    if (!databaseAdmin.ready) {
      return res.status(503).json({
        status: 'error',
        code: 'SUPABASE_ADMIN_NOT_READY',
        message: databaseAdmin.message || 'A credencial administrativa do Supabase não está pronta no backend.',
        readiness: databaseAdmin,
      });
    }

    const adminDb = getSupabaseAdmin();
    const { data: manual, error } = await adminDb
      .from('manuais_tecnicos')
      .select('id,codigo,revisao,arquivo_nome,arquivo_hash,ativo,revision_status')
      .eq('id', manualId)
      .maybeSingle();

    if (error) throw error;
    if (!manual) {
      return res.status(404).json({ status: 'error', code: 'MANUAL_NOT_FOUND', message: 'Manual técnico não encontrado.' });
    }
    if (manual.ativo === false) {
      return res.status(409).json({
        status: 'error',
        code: 'MANUAL_INATIVO',
        message: `${manual.codigo || 'Este manual'} está inativo/superado. O RAG deve ser reprocessado apenas para a revisão vigente.`,
        data: manual,
      });
    }

    const rag = await indexManualTechnicalById(manual.id, { db: adminDb });

    await registrarAuditoria({
      req,
      action: rag?.ok ? 'MANUAL_TECNICO_RAG_REPROCESSADO' : 'MANUAL_TECNICO_RAG_REPROCESSAMENTO_FALHOU',
      entity: 'MANUAIS_TECNICOS',
      entityId: manual.id,
      summary: rag?.ok
        ? `${req.user?.email || 'Admin'} reprocessou o RAG do manual ${manual.codigo}.`
        : `${req.user?.email || 'Admin'} tentou reprocessar o RAG do manual ${manual.codigo}, mas a indexação permaneceu pendente.`,
      details: {
        codigo: manual.codigo,
        revisao: manual.revisao,
        arquivo_hash: manual.arquivo_hash,
        rag,
      },
      level: rag?.ok ? 'INFO' : 'WARN',
      visibility: 'GOD',
      db: adminDb,
    });

    if (!rag?.ok) {
      return res.status(500).json({
        status: 'error',
        code: 'MANUAL_RAG_REINDEX_FAILED',
        message: `O manual ${manual.codigo} continua salvo e disponível no acervo técnico, mas o RAG não foi concluído: ${rag?.reason || 'falha não detalhada'}.`,
        data: manual,
        rag,
      });
    }

    return res.status(200).json({
      status: 'success',
      message: `RAG do manual ${manual.codigo} reprocessado com sucesso. Nenhuma nova cópia do PDF ou do manual foi criada.`,
      data: manual,
      rag,
    });
  } catch (error) {
    return res.status(500).json({
      status: 'error',
      code: 'MANUAL_RAG_REINDEX_ERROR',
      message: error.message || 'Falha ao reprocessar o RAG do manual técnico.',
    });
  }
};


exports.listManuals = async (req, res) => {
  try {
    const q = String(req.query?.q || '').trim();
    const includeInactive = String(req.query?.include_inactive || '').toLowerCase() === 'true';
    let query = supabase.from('manuais_tecnicos').select('*').order('updated_at', { ascending: false }).limit(250);
    if (!includeInactive) query = query.eq('ativo', true);
    if (q) query = query.or(`codigo.ilike.%${q}%,titulo.ilike.%${q}%,fabricante.ilike.%${q}%,ata_dmc.ilike.%${q}%,revisao.ilike.%${q}%`);
    const { data, error } = await query;
    if (error) throw error;
    return res.status(200).json({ status: 'success', data: data || [], r2_configured: isR2Configured() });
  } catch (error) {
    return res.status(500).json({ status: 'error', message: error.message || 'Falha ao consultar manuais.' });
  }
};

exports.getManual = async (req, res) => {
  try {
    const { data: manual, error } = await supabase.from('manuais_tecnicos').select('*').eq('id', req.params.id).single();
    if (error || !manual) return res.status(404).json({ status: 'error', message: 'Manual não encontrado.' });
    const [pns, falhas, recursos] = await Promise.all([
      supabase.from('manual_tecnico_pns').select('*').eq('manual_id', manual.id).order('fig').order('item'),
      supabase.from('manual_tecnico_falhas').select('*').eq('manual_id', manual.id).limit(300),
      supabase.from('manual_tecnico_recursos').select('*').eq('manual_id', manual.id).limit(1000),
    ]);
    return res.status(200).json({ status: 'success', data: { ...manual, pns: pns.data || [], falhas: falhas.data || [], recursos: recursos.data || [] } });
  } catch (error) {
    return res.status(500).json({ status: 'error', message: error.message || 'Falha ao abrir manual.' });
  }
};

exports.createManualMetadata = async (req, res) => {
  try {
    const metadata = cleanMetadata(req.body || {});
    if (!metadata.codigo) return res.status(400).json({ status: 'error', message: 'Código do manual é obrigatório.' });
    const adminDb = getSupabaseAdmin();
    const { data, error } = await adminDb.from('manuais_tecnicos').insert({
      ...metadata,
      pns_principais: Array.isArray(req.body?.pns_principais) ? req.body.pns_principais.map(normalizePn).filter(Boolean) : [],
      storage_status: 'MANUAL_METADATA_ONLY',
      metodo_leitura: 'MANUAL',
      ativo: true,
      created_by_email: req.user?.email || null,
      updated_by_email: req.user?.email || null,
      updated_at: new Date().toISOString(),
    }).select('*').single();
    if (error) throw error;
    await syncPrincipalPnRows(adminDb, data.id, data.pns_principais || [], data.titulo);
    await registrarAuditoria({
      req, action: 'MANUAL_TECNICO_CRIADO_MANUALMENTE', entity: 'MANUAIS_TECNICOS', entityId: data.id,
      summary: `${req.user?.email || 'Usuário'} cadastrou manualmente ${data.codigo}.`, details: { codigo: data.codigo, tipo_manual: data.tipo_manual },
      level: 'INFO', visibility: 'GOD', db: adminDb,
    });
    return res.status(200).json({ status: 'success', message: `Manual ${data.codigo} cadastrado manualmente.`, data });
  } catch (error) {
    return res.status(500).json({ status: 'error', message: error.message || 'Falha ao cadastrar manual.' });
  }
};

exports.createManualMetadataBatch = async (req, res) => {
  try {
    const rows = Array.isArray(req.body?.rows) ? req.body.rows.slice(0, 500) : [];
    const payload = rows.map((row) => ({
      ...cleanMetadata(row),
      pns_principais: Array.isArray(row.pns_principais) ? row.pns_principais.map(normalizePn).filter(Boolean) : [],
      storage_status: 'MANUAL_METADATA_ONLY', metodo_leitura: 'MANUAL_LOTE', ativo: true,
      created_by_email: req.user?.email || null, updated_by_email: req.user?.email || null, updated_at: new Date().toISOString(),
    })).filter((row) => row.codigo);
    if (!payload.length) return res.status(400).json({ status: 'error', message: 'Nenhuma linha válida para cadastrar.' });
    const adminDb = getSupabaseAdmin();
    const { data, error } = await adminDb.from('manuais_tecnicos').insert(payload).select('*');
    if (error) throw error;
    for (const manual of (data || [])) {
      await syncPrincipalPnRows(adminDb, manual.id, manual.pns_principais || [], manual.titulo);
    }
    await registrarAuditoria({
      req, action: 'MANUAIS_TECNICOS_CRIADOS_LOTE', entity: 'MANUAIS_TECNICOS', entityId: null,
      summary: `${req.user?.email || 'Usuário'} cadastrou ${(data || []).length} manual(is) em lote.`,
      details: { codigos: (data || []).map((row) => row.codigo).slice(0, 500) }, level: 'INFO', visibility: 'GOD', db: adminDb,
    });
    return res.status(200).json({ status: 'success', message: `${(data || []).length} manual(is) cadastrado(s) em lote.`, data: data || [] });
  } catch (error) {
    return res.status(500).json({ status: 'error', message: error.message || 'Falha no lote de manuais.' });
  }
};

exports.updateManual = async (req, res) => {
  try {
    const metadata = cleanMetadata(req.body || {});
    const updates = { ...metadata, updated_by_email: req.user?.email || null, updated_at: new Date().toISOString() };
    Object.keys(updates).forEach((key) => { if (updates[key] === null && !['titulo','fabricante','ata_dmc','revisao','data_revisao','observacoes'].includes(key)) delete updates[key]; });
    if (Array.isArray(req.body?.pns_principais)) updates.pns_principais = req.body.pns_principais.map(normalizePn).filter(Boolean);
    const adminDb = getSupabaseAdmin();
    const { data: anterior } = await adminDb.from('manuais_tecnicos').select('*').eq('id', req.params.id).maybeSingle();
    const { data, error } = await adminDb.from('manuais_tecnicos').update(updates).eq('id', req.params.id).select('*').single();
    if (error) throw error;
    if (Array.isArray(req.body?.pns_principais)) await syncPrincipalPnRows(adminDb, data.id, data.pns_principais || [], data.titulo);
    await indexManualTechnicalById(data.id, { db: adminDb }).catch(() => null);
    await registrarAuditoria({
      req, action: 'MANUAL_TECNICO_EDITADO', entity: 'MANUAIS_TECNICOS', entityId: data.id, summary: `${data.codigo} atualizado manualmente.`,
      details: { anterior, novo: data }, level: 'INFO', visibility: 'GOD', db: adminDb,
    });
    return res.status(200).json({ status: 'success', message: `Manual ${data.codigo} atualizado.`, data });
  } catch (error) {
    return res.status(500).json({ status: 'error', message: error.message || 'Falha ao atualizar manual.' });
  }
};

exports.deactivateManual = async (req, res) => {
  try {
    const adminDb = getSupabaseAdmin();
    const { data, error } = await adminDb.from('manuais_tecnicos').update({ ativo: false, updated_by_email: req.user?.email || null, updated_at: new Date().toISOString() }).eq('id', req.params.id).select('*').single();
    if (error) throw error;
    await removeManualTechnicalRag(data.id, { db: adminDb }).catch(() => null);
    await registrarAuditoria({
      req, action: 'MANUAL_TECNICO_DESATIVADO', entity: 'MANUAIS_TECNICOS', entityId: data.id, summary: `${data.codigo} desativado logicamente.`,
      details: { codigo: data.codigo, motivo: String(req.body?.motivo || '').trim() || null }, level: 'WARN', visibility: 'GOD', db: adminDb,
    });
    return res.status(200).json({ status: 'success', message: `Manual ${data.codigo} desativado logicamente. O histórico foi preservado.`, data });
  } catch (error) {
    return res.status(500).json({ status: 'error', message: error.message || 'Falha ao desativar manual.' });
  }
};

exports.searchByPn = async (req, res) => {
  try {
    const pn = normalizePn(req.params.pn);
    const { data, error } = await supabase.from('v_sisha_manual_pn_aplicacao').select('*').eq('pn', pn).order('manual_codigo');
    if (error) throw error;
    return res.status(200).json({ status: 'success', data: data || [] });
  } catch (error) {
    return res.status(500).json({ status: 'error', message: error.message || 'Falha ao consultar aplicação técnica.' });
  }
};

exports.downloadOriginal = async (req, res) => {
  try {
    const adminDb = getSupabaseAdmin();
    const { data: manual, error } = await adminDb.from('manuais_tecnicos').select('codigo,arquivo_nome,r2_key,storage_status').eq('id', req.params.id).single();
    if (error || !manual) return res.status(404).json({ status: 'error', message: 'Manual não encontrado.' });
    if (!manual.r2_key || manual.storage_status !== 'R2_PRIVATE') return res.status(404).json({ status: 'error', message: 'Este manual não possui original armazenado no R2 privado.' });
    const object = await getPrivateObject({ key: manual.r2_key });
    const filename = String(manual.arquivo_nome || `${manual.codigo}.pdf`).replace(/[\r\n"]/g, '_');
    res.setHeader('Content-Type', object.contentType);
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    return res.send(object.buffer);
  } catch (error) {
    return res.status(500).json({ status: 'error', message: error.message || 'Falha ao recuperar manual privado.' });
  }
};

exports.storageReadiness = async (_req, res) => {
  try {
    const [storage, databaseAdmin] = await Promise.all([
      checkReadiness(),
      checkSupabaseAdminReadiness(),
    ]);
    const ready = Boolean(storage.head_bucket_ok && databaseAdmin.ready);
    return res.status(ready ? 200 : 503).json({
      status: ready ? 'success' : 'error',
      data: { ...storage, database_admin: databaseAdmin },
      message: ready
        ? 'R2 privado e cliente administrativo Supabase prontos.'
        : [storage.message, databaseAdmin.message].filter(Boolean).join(' | '),
    });
  } catch (error) {
    return res.status(503).json({
      status: 'error',
      message: error.message || 'Falha ao validar infraestrutura privada de manuais.',
      data: { configured: isR2Configured(), head_bucket_ok: false, database_admin: { configured: false, ready: false } },
    });
  }
};
