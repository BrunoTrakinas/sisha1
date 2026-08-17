const path = require('path');
const { getSupabaseAdmin } = require('../config/supabaseAdminClient');
const { parseReceiptDocument } = require('./receiptDocumentParser');
const { sanitizeReceiptFormMetadata } = require('./receiptMetadataSanitizerService');
const { metadataResidueKinds } = require('./receiptDescriptionSemanticNormalizerService');
const { analyzeDocumentWithAi, saveDocumentAnalysis, compactText } = require('./chatLinceService');
const { extractTextFromFile } = require('./documentTextExtractionService');

const ANALYSIS_VERSION = 'A1.1A-HF12-V1';
const STRUCTURAL_EXTENSIONS = new Set(['.xlsx', '.xls', '.csv', '.ods', '.doc', '.docx']);
const STRUCTURAL_AI_FALLBACK_EXTENSIONS = new Set(['.docx']);
const RECEIPT_AI_TIMEOUT_MS = Math.max(15000, Math.min(Number(process.env.RECEIPT_IMPORT_AI_TIMEOUT_MS || 45000), 120000));
const AI_EXTENSIONS = new Set(['.pdf', '.jpg', '.jpeg', '.png', '.webp', '.docx', '.odt', '.txt']);

function emptyItem() {
  return {
    sequencia_item: 1, pn: '', nsn_pi: '', nomenclatura: '', quantidade: 1,
    quantidade_inventariada: 0, sn: '', localizacao_ppu: '', destino_previsto: '',
    destino_previsto_fonte: '', destino_estoque: '', validade_status: 'NAO_INFORMADA',
    validade_observacao: '', sn_extraido_documento: false, equipamento_id: null,
    contabiliza_pelo_recibo: true, condicao_item: 'RECEBIDO_DISPONIVEL', observacao_item: '',
    inventariado_ppu: false, data_garantia: '', valor_unitario: '', valor_total_documento: '',
    moeda: '', documento_referencia: '', delivery_note: '', invoice_no: '', di: '', batch_no: '',
    coc_no: '', status_documento: '', dados_originais: {},
  };
}

function itemFromData(item = {}, index = 0) {
  return {
    ...emptyItem(),
    sequencia_item: item.sequencia_item || index + 1,
    pn: item.pn || '',
    nsn_pi: item.nsn_pi || '',
    nomenclatura: item.nomenclatura || '',
    quantidade: item.quantidade ?? 1,
    quantidade_inventariada: item.quantidade_inventariada ?? (item.inventariado_ppu ? item.quantidade ?? 1 : 0),
    sn: item.sn || item.sns_finais || (item.sns_pre_carregados || []).join(', '),
    localizacao_ppu: item.localizacao_ppu || '',
    destino_previsto: item.destino_previsto || '',
    destino_previsto_fonte: item.destino_previsto_fonte || '',
    destino_estoque: item.destino_estoque || '',
    validade_status: item.validade_status || 'NAO_INFORMADA',
    validade_observacao: item.validade_observacao || '',
    sn_extraido_documento: Boolean(item.sn_extraido_documento),
    equipamento_id: item.equipamento_id || null,
    contabiliza_pelo_recibo: item.contabiliza_pelo_recibo !== false,
    condicao_item: item.condicao_item || 'RECEBIDO_DISPONIVEL',
    observacao_item: item.observacao_item || '',
    inventariado_ppu: Boolean(item.inventariado_ppu),
    data_garantia: item.data_garantia ? String(item.data_garantia).slice(0, 10) : '',
    valor_unitario: item.valor_unitario ?? '',
    valor_total_documento: item.valor_total_documento ?? '',
    moeda: item.moeda || '',
    documento_referencia: item.documento_referencia || '',
    delivery_note: item.delivery_note || '', invoice_no: item.invoice_no || '', di: item.di || '',
    batch_no: item.batch_no || '', coc_no: item.coc_no || '', status_documento: item.status_documento || '',
    dados_originais: item.dados_originais || {},
  };
}

function structuralParsedToForm(parsed = {}, fileName = '', fileHash = '') {
  const items = Array.isArray(parsed.data_triagem) ? parsed.data_triagem.map(itemFromData) : [];
  return {
    numero_recibo: parsed.recibo_ref || '',
    tipo_recebimento: parsed.tipo_recebimento || (parsed.is_foc ? 'FOC' : 'MATERIAL'),
    data_recebimento: parsed.data_entrega_ref ? String(parsed.data_entrega_ref).slice(0, 10) : '',
    documento_referencia: parsed.documento_referencia || '', fornecedor: parsed.fornecedor || '',
    origem_material: parsed.origem_material || '', programa_origem: parsed.programa_origem || '',
    programa_origem_fonte: parsed.programa_origem_fonte || '', codigo_om_recebedora: parsed.codigo_om_recebedora || '',
    sigla_recebedora: parsed.sigla_recebedora || '', recebido_por_nome: parsed.recebido_por_nome || '',
    conferido_por_nome: parsed.conferido_por_nome || '', metodo_importacao: parsed.metodo_importacao || 'DOCUMENTO',
    arquivo_nome: fileName || parsed.arquivo_nome || '', arquivo_hash: fileHash || parsed.arquivo_hash || '',
    chat_lince_documento_id: null, is_foc: Boolean(parsed.is_foc),
    observacao: parsed.observacao_sugerida || 'Documento lido. Dados revisados antes da gravação operacional.',
    avisos_triagem: Array.isArray(parsed.avisos_triagem) ? parsed.avisos_triagem : [],
    dados_originais: parsed.dados_originais || {}, itens: items.length ? items : [emptyItem()],
  };
}

function aiAnalysisToForm({ analysis = {}, documentId = null, fileName = '', fileHash = '' }) {
  const extracted = analysis?.entidades?.recibo || analysis?.recibo_extraido || {};
  const suggested = Array.isArray(analysis?.registros_sugeridos) ? analysis.registros_sugeridos : [];
  const candidates = Array.isArray(extracted.itens) && extracted.itens.length
    ? extracted.itens
    : suggested.map((record) => record?.payload || record?.campos || record).filter(Boolean);
  const items = candidates.map((item, index) => itemFromData({
    sequencia_item: item.sequencia_item || index + 1,
    pn: item.pn || item.part_number || item.identificador || '', nsn_pi: item.nsn_pi || item.nsn || item.pi || '',
    nomenclatura: item.nomenclatura || item.descricao || item.description || '',
    quantidade: Number(item.quantidade ?? item.qtd ?? item.qty ?? 1) || 1,
    sn: item.sn || item.serial_number || '', localizacao_ppu: item.localizacao_ppu || item.local || '',
    destino_previsto: item.destino_previsto || '', destino_previsto_fonte: item.destino_previsto_fonte || '',
    destino_estoque: item.destino_estoque || '', validade_status: item.validade_status || 'NAO_INFORMADA',
    validade_observacao: item.validade_observacao || '', sn_extraido_documento: Boolean(item.sn_extraido_documento || item.serial_number || item.sn),
    contabiliza_pelo_recibo: item.contabiliza_pelo_recibo !== false,
    condicao_item: item.condicao_item || 'RECEBIDO_DISPONIVEL', observacao_item: item.observacao_item || item.observacao || '',
    data_garantia: item.data_garantia || '', valor_unitario: item.valor_unitario ?? item.preco_unitario ?? '',
    valor_total_documento: item.valor_total_documento ?? item.valor_total ?? '', moeda: item.moeda || '',
    documento_referencia: item.documento_referencia || item.pd || extracted.documento_referencia || '',
    delivery_note: item.delivery_note || item.delivery_number || '', invoice_no: item.invoice_no || item.invoice || '',
    di: item.di || '', batch_no: item.batch_no || item.batch || '', coc_no: item.coc_no || item.coc || '',
    status_documento: item.status_documento || item.status || '', dados_originais: item,
  }, index)).filter((item) => String(item.pn || '').trim());
  return {
    numero_recibo: extracted.numero_recibo || extracted.numero || extracted.recibo_ref || '',
    tipo_recebimento: extracted.tipo_recebimento || 'MATERIAL',
    data_recebimento: extracted.data_recebimento || extracted.data_entrega || '',
    documento_referencia: extracted.documento_referencia || '', fornecedor: extracted.fornecedor || '',
    origem_material: extracted.origem_material || '', programa_origem: extracted.programa_origem || '',
    programa_origem_fonte: extracted.programa_origem_fonte || '', codigo_om_recebedora: extracted.codigo_om_recebedora || '',
    sigla_recebedora: extracted.sigla_recebedora || '', recebido_por_nome: extracted.recebido_por_nome || extracted.recebido_por || '',
    conferido_por_nome: extracted.conferido_por_nome || extracted.conferido_por || '', metodo_importacao: 'IA_CHAT_LINCE',
    arquivo_nome: fileName, arquivo_hash: fileHash, chat_lince_documento_id: documentId,
    is_foc: Boolean(extracted.is_foc), observacao: extracted.observacao || 'Rascunho extraído pelo Chat Lince. Revisão humana obrigatória.',
    avisos_triagem: Array.isArray(extracted.avisos_triagem) ? extracted.avisos_triagem : [],
    dados_originais: { classificacao: analysis.classificacao, entidades: analysis.entidades },
    itens: items.length ? items : [emptyItem()],
  };
}

function normalizeQualityText(value = '') {
  return String(value || '').trim().replace(/\s+/g, ' ');
}

function isObviousNonPnReference(value = '') {
  const candidate = normalizeQualityText(value).toUpperCase().replace(/\s+/g, '');
  if (!candidate) return false;
  // Declarações de Importação não são Part Number.
  if (/^\d{2}BR\d{8,}(?:-\d+)?$/.test(candidate)) return true;
  // MAWB no padrão prefixo numérico + aeroporto IATA + sequência longa.
  if (/^\d{3}[A-Z]{3}\d{7,}$/.test(candidate)) return true;
  // HAWB usados nos recibos auditados (aeroporto + identificador alfanumérico).
  if (/^[A-Z]{3}[A-Z0-9]{7,}$/.test(candidate) && /^(LHR|GRU|GIG|VCP|MIA|JFK|ATL|LAX)/.test(candidate)) return true;
  return false;
}


const CONTRACT_REFERENCE_RESIDUE_RE = /\b\d{4,6}\/\d{4}-\d{3}(?:\/\d{2})?\b/i;
const NOMENCLATURE_METADATA_RESIDUE_RE = /\b(?:P\d{4}-\d{4}(?:\/\d+)?|ITEM\s*:?[\s-]*\d+|CUST(?:OMER)?\.?\s*REF\.?\s*:|F\s*\.?\s*O\s*\.?\s*C\s*\.?|WARRANTY(?:\s+SPARES)?|THIS\s+ITEM\s+IS\s+(?:FREE\s+OF\s+CHARGE|FOC)|(?:BRAZIL|BRASIL)\s*7\s*&\s*8\s*PLANNING\s*REMOVAL|N\s*[- ]\s*\d{4}\s+WARRANTY)\b/i;

function metadataResidueWarnings(item = {}, index = 0) {
  const warnings = [];
  const nomenclature = normalizeQualityText(item.nomenclatura);
  const serial = normalizeQualityText(item.sn);
  const label = `Item ${index + 1} (${normalizeQualityText(item.pn) || 'sem PN'})`;
  const nomenclatureResidues = metadataResidueKinds(nomenclature);
  const serialResidues = metadataResidueKinds(serial, { serial: true });

  if (CONTRACT_REFERENCE_RESIDUE_RE.test(nomenclature)) {
    warnings.push(`${label}: número de contrato permaneceu dentro da nomenclatura; revisão obrigatória.`);
  }
  if (NOMENCLATURE_METADATA_RESIDUE_RE.test(nomenclature) || nomenclatureResidues.length) {
    warnings.push(`${label}: metadado documental permaneceu dentro da nomenclatura (${nomenclatureResidues.join(', ') || 'RESIDUO'}); revisão obrigatória.`);
  }
  if (CONTRACT_REFERENCE_RESIDUE_RE.test(serial)) {
    warnings.push(`${label}: número de contrato permaneceu dentro do SN; revisão obrigatória.`);
  }
  if (serialResidues.length) {
    warnings.push(`${label}: metadado documental permaneceu dentro do SN (${serialResidues.join(', ')}); revisão obrigatória.`);
  }
  return warnings;
}

function isInformationalReceiptWarning(value = '') {
  const message = String(value || '').trim();
  if (!message) return false;
  if (/^\[INFO\]\s*/i.test(message)) return true;
  // Compatibilidade com análises/cache legados anteriores ao C3.4 HF2:
  // GARANTIA + FOC é uma combinação logística válida e, isoladamente,
  // não representa erro de leitura nem exige uma segunda conferência.
  return /documento foi identificado como GARANTIA[\s\S]*indica(?:ç|c)[aã]o FOC[\s\S]*marca(?:ç|c)[aã]o FOC foi preservada/i.test(message);
}

function receiptQualityWarnings(form = {}, sourceMethod = '') {
  const warnings = [];
  const number = normalizeQualityText(form.numero_recibo);
  const date = normalizeQualityText(form.data_recebimento);
  const method = normalizeQualityText(form.metodo_importacao || sourceMethod).toUpperCase();
  const items = Array.isArray(form.itens) ? form.itens : [];
  const validItems = items.filter((item) => normalizeQualityText(item?.pn) && Number(item?.quantidade || 0) > 0);

  if (!number) warnings.push('Número do recibo não foi extraído; revisão obrigatória.');
  if (!date) warnings.push('Data do recebimento não foi extraída; revisão obrigatória.');
  if (!validItems.length) warnings.push('Nenhum item com PN e quantidade válidos foi extraído.');

  validItems.forEach((item, index) => {
    const pn = normalizeQualityText(item.pn);
    const nomenclature = normalizeQualityText(item.nomenclatura);
    if (isObviousNonPnReference(pn)) {
      warnings.push(`Linha ${index + 1}: identificador logístico ${pn} foi bloqueado como PN (MAWB/HAWB/DI).`);
    }
    if (!nomenclature) warnings.push(`Item ${index + 1} (${pn || 'sem PN'}) sem nomenclatura; revisão obrigatória.`);
    warnings.push(...metadataResidueWarnings(item, index));
    if (!Number.isFinite(Number(item.quantidade)) || Number(item.quantidade) <= 0) {
      warnings.push(`Item ${index + 1} (${pn || 'sem PN'}) sem quantidade válida.`);
    }
  });

  if (/DOCX_BONDED_STORE/.test(method)) {
    validItems.forEach((item, index) => {
      if (!normalizeQualityText(item.delivery_note)) warnings.push(`Item ${index + 1}: Delivery Number não foi extraído do DOCX.`);
      if (!normalizeQualityText(item.invoice_no)) warnings.push(`Item ${index + 1}: Invoice Number não foi extraído do DOCX.`);
    });
  }

  return [...new Set(warnings)];
}

function sanitizeAiForm(form = {}) {
  if (!Array.isArray(form.itens)) return form;
  const blocked = [];
  const kept = [];
  for (const item of form.itens) {
    const pn = normalizeQualityText(item?.pn);
    // Não apaga PN numérico genérico: só bloqueia padrões inequívocos de DI/AWB.
    if (pn && isObviousNonPnReference(pn)) {
      blocked.push(pn);
      continue;
    }
    kept.push(item);
  }
  if (blocked.length) {
    form.itens = kept.length ? kept : [emptyItem()];
    form.avisos_triagem = [
      ...(Array.isArray(form.avisos_triagem) ? form.avisos_triagem : []),
      `A IA tentou tratar referência logística como PN e a linha foi bloqueada: ${blocked.join(', ')}.`,
    ];
  }
  return form;
}

function normalizeReceiptNumber(value = '') {
  return String(value || '').trim().toUpperCase().replace(/\s+/g, '');
}

async function findExistingByHash(hash) {
  if (!hash) return null;
  const { data, error } = await getSupabaseAdmin().from('recebimentos').select('id,numero_recibo,arquivo_hash').eq('arquivo_hash', hash).limit(1).maybeSingle();
  if (error) throw error;
  return data || null;
}

async function findExistingByNumber(number) {
  const key = normalizeReceiptNumber(number);
  if (!key) return null;
  const { data, error } = await getSupabaseAdmin().from('recebimentos').select('id,numero_recibo,arquivo_hash').eq('numero_recibo', number).limit(1).maybeSingle();
  if (error) throw error;
  return data || null;
}

async function loadCached(hash) {
  if (!hash) return null;
  const { data, error } = await getSupabaseAdmin().from('receipt_import_analysis_cache').select('*').eq('file_sha256', hash).eq('analysis_version', ANALYSIS_VERSION).maybeSingle();
  if (error) throw error;
  return data || null;
}

async function cacheAnalysis(hash, result) {
  if (!hash || !result?.form) return;
  const payload = {
    file_sha256: hash, analysis_version: ANALYSIS_VERSION, source_method: result.sourceMethod,
    triage_payload: result.form, receipt_number: result.form.numero_recibo || null,
    receipt_type: result.form.tipo_recebimento || null, item_count: result.itemCount || 0,
    warnings: result.warnings || [], updated_at: new Date().toISOString(),
  };
  const { error } = await getSupabaseAdmin().from('receipt_import_analysis_cache').upsert(payload, { onConflict: 'file_sha256' });
  if (error) throw error;
}

async function analyzeReceiptFile({ file, fileHash, actor, aiSemaphore = null }) {
  const extension = path.extname(file.originalname || '').toLowerCase();
  const cached = await loadCached(fileHash);
  if (cached?.triage_payload) {
    const cachedForm = sanitizeReceiptFormMetadata(cached.triage_payload);
    const cachedWarnings = [...new Set([
      ...(Array.isArray(cached.warnings) ? cached.warnings : []),
      ...receiptQualityWarnings(cachedForm, cached.source_method || 'CACHE'),
    ])];
    cachedForm.avisos_triagem = cachedWarnings;
    return {
      form: cachedForm,
      sourceMethod: cached.source_method || 'CACHE',
      warnings: cachedWarnings,
      itemCount: (cachedForm.itens || []).filter((item) => String(item.pn || '').trim() && Number(item.quantidade || 0) > 0).length,
      reusedAnalysis: true,
    };
  }

  let form;
  let sourceMethod = 'DOCUMENTO_ESTRUTURAL';
  let structuralError = null;
  if (STRUCTURAL_EXTENSIONS.has(extension)) {
    try {
      const parsed = parseReceiptDocument({ file, requestedType: 'recibo_auto' });
      form = structuralParsedToForm(parsed, file.originalname, fileHash);
    } catch (error) {
      structuralError = error;
      if (!STRUCTURAL_AI_FALLBACK_EXTENSIONS.has(extension)) throw error;
    }
  }

  if (!form && AI_EXTENSIONS.has(extension)) {
    const runAi = async () => {
      const text = compactText(await extractTextFromFile(file, 'recibo_auto'), 50000);
      if (!text) throw new Error('Não foi possível extrair texto suficiente do recibo.');
      const analysis = await analyzeDocumentWithAi({
        tipoDocumento: 'recibo_auto',
        text,
        fileName: file.originalname,
        timeoutMs: RECEIPT_AI_TIMEOUT_MS,
      });
      const saved = await saveDocumentAnalysis({ file, tipoDocumento: 'recibo_auto', text, analysis, user: actor });
      form = aiAnalysisToForm({ analysis, documentId: saved.ok ? saved.data.id : null, fileName: file.originalname, fileHash });
      form = sanitizeAiForm(form);
      if (structuralError) {
        form.avisos_triagem = [...(form.avisos_triagem || []), `Leitor estrutural não concluiu o DOC; usado fallback inteligente: ${structuralError.message || structuralError}`];
      }
      sourceMethod = 'IA_CHAT_LINCE';
    };
    if (aiSemaphore) await aiSemaphore(runAi); else await runAi();
  }

  if (!form) throw new Error(`Formato ${extension || '?'} não suportado no lote persistente.`);
  // HF11: barreira final global. Mesmo que um parser, IA ou cache deixe SN/contrato
  // dentro da nomenclatura, a triagem normaliza antes de qualidade, cache e UI.
  form = sanitizeReceiptFormMetadata(form);
  const validItems = (form.itens || []).filter((item) => String(item.pn || '').trim() && Number(item.quantidade || 0) > 0);
  const warnings = [...new Set([
    ...(Array.isArray(form.avisos_triagem) ? form.avisos_triagem : []),
    ...receiptQualityWarnings(form, sourceMethod),
  ])];
  form.avisos_triagem = warnings;
  const result = { form, sourceMethod, warnings, itemCount: validItems.length, reusedAnalysis: false };
  await cacheAnalysis(fileHash, result);
  return result;
}

async function classifyTriage({ jobId, itemId, fileHash, analysis }) {
  const form = analysis.form;
  const numberKey = normalizeReceiptNumber(form.numero_recibo);
  const validItems = (form.itens || []).filter((item) => String(item.pn || '').trim() && Number(item.quantidade || 0) > 0);
  const warnings = Array.isArray(form.avisos_triagem) ? form.avisos_triagem : [];
  const blockingWarnings = warnings.filter((warning) => !isInformationalReceiptWarning(warning));
  let status = blockingWarnings.length || !numberKey || !validItems.length ? 'REVIEW' : 'READY';
  let diagnostic = blockingWarnings.length
    ? blockingWarnings.join(' | ')
    : warnings.length
      ? `Leitura concluída sem pendências bloqueantes. ${warnings.join(' | ')}`
      : 'Leitura concluída e campos obrigatórios presentes.';

  const existingExact = await findExistingByHash(fileHash);
  if (existingExact) {
    status = 'DUPLICATE';
    diagnostic = `Arquivo idêntico já importado como Recibo ${existingExact.numero_recibo}.`;
    return { status, diagnostic, form, warnings, itemCount: validItems.length };
  }

  const { data: priorSameHash, error: priorHashError } = await getSupabaseAdmin()
    .from('receipt_import_job_items')
    .select('id,file_name,status')
    .eq('job_id', jobId).eq('file_sha256', fileHash).neq('id', itemId)
    .lt('sequence_no', (await getSupabaseAdmin().from('receipt_import_job_items').select('sequence_no').eq('id', itemId).single()).data?.sequence_no || 2147483647)
    .limit(1).maybeSingle();
  if (priorHashError) throw priorHashError;
  if (priorSameHash) {
    return { status: 'DUPLICATE', diagnostic: `Arquivo repetido dentro deste lote (${priorSameHash.file_name}).`, form, warnings, itemCount: validItems.length };
  }

  const existingNumber = await findExistingByNumber(form.numero_recibo);
  if (existingNumber && String(existingNumber.arquivo_hash || '').toLowerCase() !== String(fileHash || '').toLowerCase()) {
    status = 'CONFLICT';
    diagnostic = `O Recibo ${form.numero_recibo} já existe, mas o arquivo é diferente. Revise antes de qualquer gravação.`;
  } else if (numberKey) {
    const { data: sameNumber, error } = await getSupabaseAdmin().from('receipt_import_job_items')
      .select('id,file_sha256,file_name').eq('job_id', jobId).eq('receipt_number', form.numero_recibo).neq('id', itemId).limit(1).maybeSingle();
    if (error) throw error;
    if (sameNumber && String(sameNumber.file_sha256 || '').toLowerCase() !== String(fileHash || '').toLowerCase()) {
      status = 'CONFLICT';
      diagnostic = `Há mais de um arquivo diferente para o Recibo ${form.numero_recibo} neste lote.`;
    }
  }

  return { status, diagnostic, form, warnings, itemCount: validItems.length };
}

module.exports = {
  ANALYSIS_VERSION,
  analyzeReceiptFile,
  classifyTriage,
  structuralParsedToForm,
  aiAnalysisToForm,
  normalizeReceiptNumber,
  receiptQualityWarnings,
  isInformationalReceiptWarning,
  isObviousNonPnReference,
  metadataResidueWarnings,
};
