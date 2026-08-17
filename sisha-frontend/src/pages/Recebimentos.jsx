import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Download,
  Eye,
  FileUp,
  Pencil,
  Plus,
  Printer,
  RefreshCcw,
  Save,
  Search,
  Trash2,
  X,
} from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { API_BASE_URL, apiFetch, buildAuthHeaders } from '../lib/api';

const DRAFT_KEY = 'sisha_receipt_draft';
const inputClass = 'w-full px-3 py-2.5 rounded-xl border-2 border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-900 dark:text-white font-bold outline-none focus:border-blue-500';
const labelClass = 'block text-[10px] font-black uppercase tracking-wider text-slate-500 dark:text-slate-400 mb-1';
const conditionOptions = [
  ['RECEBIDO_DISPONIVEL', 'Recebido e disponível'],
  ['QUARENTENA', 'Em quarentena'],
  ['DEFEITUOSO', 'Defeituoso'],
  ['FALTANTE', 'Faltante no recibo'],
  ['DIVERGENTE', 'Divergência documental'],
];
const receiptTypeOptions = [
  ['GARANTIA', 'Itens de garantia'],
  ['PD', 'Recibo de PD'],
  ['DOACAO_DISPOSE', 'Doação / Dispose'],
  ['FOC', 'FOC'],
  ['MATERIAL', 'Material'],
  ['OUTRO', 'Outro'],
];

function formatDate(value) {
  if (!value) return 'Não informada';
  const text = String(value).slice(0, 10);
  const [year, month, day] = text.split('-');
  return year && month && day ? `${day}/${month}/${year}` : value;
}

function formatNumber(value) {
  return Number(value || 0).toLocaleString('pt-BR', { maximumFractionDigits: 2 });
}

function realSerial(value) {
  const serial = String(value || '').trim().toUpperCase();
  return Boolean(serial && !['N/A', 'NA', 'S/N', 'SEM SN', 'SEM S/N', '-'].includes(serial));
}

function receiptDocumentOrigin(item = {}) {
  const origin = Number(item?.dados_originais?.linha_documental_origem);
  return Number.isInteger(origin) && origin > 0 ? origin : null;
}

function receiptDocumentSubSequence(item = {}) {
  const original = item?.dados_originais || {};
  const serials = Array.isArray(original.sns_documentais_origem) ? original.sns_documentais_origem : [];
  const currentSerial = String(original.sn_operacional || item?.sn || '').trim().toUpperCase();
  const serialIndex = currentSerial
    ? serials.findIndex((serial) => String(serial || '').trim().toUpperCase() === currentSerial)
    : -1;
  if (serialIndex >= 0) return serialIndex + 1;
  if (original.saldo_sem_sn_expandido) return serials.length + 1;
  return null;
}

function receiptDisplayRows(items = []) {
  const prepared = (Array.isArray(items) ? items : []).map((item, formIndex) => {
    const documentOrigin = receiptDocumentOrigin(item);
    const documentSubSequence = receiptDocumentSubSequence(item);
    const fallbackSequence = Number(item?.sequencia_item) || formIndex + 1;
    return {
      item,
      formIndex,
      documentOrigin,
      documentSubSequence,
      fallbackSequence,
    };
  });

  prepared.sort((a, b) => {
    if (a.fallbackSequence !== b.fallbackSequence) return a.fallbackSequence - b.fallbackSequence;
    if (a.documentOrigin && b.documentOrigin && a.documentOrigin === b.documentOrigin && a.documentSubSequence !== b.documentSubSequence) {
      if (a.documentSubSequence == null) return 1;
      if (b.documentSubSequence == null) return -1;
      return a.documentSubSequence - b.documentSubSequence;
    }
    return a.formIndex - b.formIndex;
  });

  const hasDocumentOrigins = prepared.some((row) => row.documentOrigin);
  if (!hasDocumentOrigins) {
    return prepared.map((row) => ({
      ...row,
      displaySequence: String(row.fallbackSequence),
      displayDocumentOrigin: null,
      expandedDocumentItem: false,
    }));
  }

  const documentGroupCounts = new Map();
  prepared.forEach((row) => {
    if (!row.documentOrigin) return;
    documentGroupCounts.set(row.documentOrigin, (documentGroupCounts.get(row.documentOrigin) || 0) + 1);
  });

  let displayDocumentOrigin = 0;
  let previousGroupKey = null;
  let groupPosition = 0;

  return prepared.map((row) => {
    const groupKey = row.documentOrigin
      ? `DOCUMENT:${row.documentOrigin}`
      : `SINGLE:${row.fallbackSequence}:${row.formIndex}`;

    if (groupKey !== previousGroupKey) {
      displayDocumentOrigin += 1;
      groupPosition = 0;
      previousGroupKey = groupKey;
    } else {
      groupPosition += 1;
    }

    return {
      ...row,
      displayDocumentOrigin,
      // O primeiro registro mantém o número do item original; somente as
      // unidades adicionais recebem subitem (22, 22.1, 22.2...).
      displaySequence: groupPosition === 0
        ? String(displayDocumentOrigin)
        : `${displayDocumentOrigin}.${groupPosition}`,
      expandedDocumentItem: Boolean(row.documentOrigin && (documentGroupCounts.get(row.documentOrigin) || 0) > 1),
    };
  });
}

function emptyItem() {
  return {
    id: undefined,
    sequencia_item: 1,
    pn: '',
    nsn_pi: '',
    nomenclatura: '',
    quantidade: 1,
    quantidade_inventariada: 0,
    sn: '',
    localizacao_ppu: '',
    destino_previsto: '',
    destino_previsto_fonte: '',
    destino_estoque: '',
    validade_status: 'NAO_INFORMADA',
    validade_observacao: '',
    sn_extraido_documento: false,
    equipamento_id: null,
    contabiliza_pelo_recibo: true,
    condicao_item: 'RECEBIDO_DISPONIVEL',
    observacao_item: '',
    inventariado_ppu: false,
    data_garantia: '',
    valor_unitario: '',
    valor_total_documento: '',
    moeda: '',
    documento_referencia: '',
    delivery_note: '',
    invoice_no: '',
    di: '',
    batch_no: '',
    coc_no: '',
    status_documento: '',
  };
}

function emptyForm(method = 'MANUAL') {
  return {
    numero_recibo: '',
    tipo_recebimento: 'MATERIAL',
    data_recebimento: '',
    documento_referencia: '',
    fornecedor: '',
    origem_material: '',
    programa_origem: '',
    programa_origem_fonte: '',
    codigo_om_recebedora: '',
    sigla_recebedora: '',
    recebido_por_nome: '',
    conferido_por_nome: '',
    metodo_importacao: method,
    arquivo_nome: '',
    arquivo_hash: '',
    chat_lince_documento_id: null,
    is_foc: false,
    observacao: '',
    avisos_triagem: [],
    dados_originais: {},
    itens: [emptyItem()],
  };
}

function itemFromApi(item = {}, index = 0) {
  return {
    id: item.id,
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
    inventariado_em: item.inventariado_em || null,
    data_garantia: item.data_garantia ? String(item.data_garantia).slice(0, 10) : '',
    valor_unitario: item.valor_unitario ?? '',
    valor_total_documento: item.valor_total_documento ?? '',
    moeda: item.moeda || '',
    documento_referencia: item.documento_referencia || '',
    delivery_note: item.delivery_note || '',
    invoice_no: item.invoice_no || '',
    di: item.di || '',
    batch_no: item.batch_no || '',
    coc_no: item.coc_no || '',
    status_documento: item.status_documento || '',
    dados_originais: item.dados_originais || {},
  };
}

function receiptToForm(receipt = {}) {
  return {
    numero_recibo: receipt.numero_recibo || '',
    tipo_recebimento: receipt.tipo_recebimento || 'MATERIAL',
    data_recebimento: receipt.data_recebimento ? String(receipt.data_recebimento).slice(0, 10) : '',
    documento_referencia: receipt.documento_referencia || '',
    fornecedor: receipt.fornecedor || '',
    origem_material: receipt.origem_material || '',
    programa_origem: receipt.programa_origem || '',
    programa_origem_fonte: receipt.programa_origem_fonte || '',
    codigo_om_recebedora: receipt.codigo_om_recebedora || '',
    sigla_recebedora: receipt.sigla_recebedora || '',
    recebido_por_nome: receipt.recebido_por_nome || '',
    conferido_por_nome: receipt.conferido_por_nome || '',
    metodo_importacao: receipt.metodo_importacao || 'MANUAL',
    arquivo_nome: receipt.arquivo_nome || '',
    arquivo_hash: receipt.arquivo_hash || '',
    chat_lince_documento_id: receipt.chat_lince_documento_id || null,
    is_foc: Boolean(receipt.is_foc),
    observacao: receipt.observacao || '',
    avisos_triagem: Array.isArray(receipt.avisos_triagem) ? receipt.avisos_triagem : [],
    dados_originais: receipt.dados_originais || {},
    itens: (receipt.recebimento_itens || []).filter((item) => item.ativo !== false).map(itemFromApi),
  };
}

function importResponseToForm(data = {}) {
  const items = Array.isArray(data.data_triagem) ? data.data_triagem.map(itemFromApi) : [];
  return {
    ...emptyForm(data.metodo_importacao || 'DOCUMENTO'),
    numero_recibo: data.recibo_ref || '',
    tipo_recebimento: data.tipo_recebimento || (data.is_foc ? 'FOC' : 'MATERIAL'),
    data_recebimento: data.data_entrega_ref ? String(data.data_entrega_ref).slice(0, 10) : '',
    documento_referencia: data.documento_referencia || '',
    fornecedor: data.fornecedor || '',
    origem_material: data.origem_material || '',
    programa_origem: data.programa_origem || '',
    programa_origem_fonte: data.programa_origem_fonte || '',
    codigo_om_recebedora: data.codigo_om_recebedora || '',
    sigla_recebedora: data.sigla_recebedora || '',
    recebido_por_nome: data.recebido_por_nome || '',
    conferido_por_nome: data.conferido_por_nome || '',
    metodo_importacao: data.metodo_importacao || 'DOCUMENTO',
    arquivo_nome: data.arquivo_nome || '',
    arquivo_hash: data.arquivo_hash || '',
    is_foc: Boolean(data.is_foc),
    observacao: data.observacao_sugerida || 'Documento lido. Dados revisados antes da gravação operacional.',
    avisos_triagem: Array.isArray(data.avisos_triagem) ? data.avisos_triagem : [],
    dados_originais: data.dados_originais || {},
    itens: items.length ? items : [emptyItem()],
  };
}

function aiAnalysisToForm({ analysis = {}, documentId = null, fileName = '', uploadType = 'recibo_material' }) {
  const extracted = analysis?.entidades?.recibo || analysis?.recibo_extraido || {};
  const suggested = Array.isArray(analysis?.registros_sugeridos) ? analysis.registros_sugeridos : [];
  const candidates = Array.isArray(extracted.itens) && extracted.itens.length
    ? extracted.itens
    : suggested.map((record) => record?.payload || record?.campos || record).filter(Boolean);

  const items = candidates.map((item, index) => itemFromApi({
    sequencia_item: item.sequencia_item || index + 1,
    pn: item.pn || item.part_number || item.identificador || '',
    nsn_pi: item.nsn_pi || item.nsn || item.pi || '',
    nomenclatura: item.nomenclatura || item.descricao || item.description || '',
    quantidade: Number(item.quantidade ?? item.qtd ?? item.qty ?? 1) || 1,
    quantidade_inventariada: 0,
    sn: item.sn || item.serial_number || '',
    localizacao_ppu: item.localizacao_ppu || item.local || '',
    destino_previsto: item.destino_previsto || '',
    destino_previsto_fonte: item.destino_previsto_fonte || '',
    destino_estoque: item.destino_estoque || '',
    validade_status: item.validade_status || 'NAO_INFORMADA',
    validade_observacao: item.validade_observacao || '',
    sn_extraido_documento: Boolean(item.sn_extraido_documento || item.serial_number || item.sn),
    contabiliza_pelo_recibo: item.contabiliza_pelo_recibo !== false,
    condicao_item: item.condicao_item || 'RECEBIDO_DISPONIVEL',
    observacao_item: item.observacao_item || item.observacao || '',
    inventariado_ppu: false,
    data_garantia: item.data_garantia || '',
    valor_unitario: item.valor_unitario ?? item.preco_unitario ?? '',
    valor_total_documento: item.valor_total_documento ?? item.valor_total ?? '',
    moeda: item.moeda || '',
    documento_referencia: item.documento_referencia || item.pd || extracted.documento_referencia || '',
    delivery_note: item.delivery_note || item.delivery_number || '',
    invoice_no: item.invoice_no || item.invoice || '',
    di: item.di || '',
    batch_no: item.batch_no || item.batch || '',
    coc_no: item.coc_no || item.coc || '',
    status_documento: item.status_documento || item.status || '',
    dados_originais: item,
  }, index)).filter((item) => String(item.pn || '').trim());

  return {
    ...emptyForm('IA_CHAT_LINCE'),
    numero_recibo: extracted.numero_recibo || extracted.numero || extracted.recibo_ref || '',
    tipo_recebimento: extracted.tipo_recebimento || (uploadType === 'recibo_pd' ? 'PD' : 'MATERIAL'),
    data_recebimento: extracted.data_recebimento || extracted.data_entrega || '',
    documento_referencia: extracted.documento_referencia || '',
    fornecedor: extracted.fornecedor || '',
    origem_material: extracted.origem_material || '',
    programa_origem: extracted.programa_origem || '',
    programa_origem_fonte: extracted.programa_origem_fonte || '',
    codigo_om_recebedora: extracted.codigo_om_recebedora || '',
    sigla_recebedora: extracted.sigla_recebedora || '',
    recebido_por_nome: extracted.recebido_por_nome || extracted.recebido_por || '',
    conferido_por_nome: extracted.conferido_por_nome || extracted.conferido_por || '',
    metodo_importacao: 'IA_CHAT_LINCE',
    arquivo_nome: fileName,
    chat_lince_documento_id: documentId,
    is_foc: Boolean(extracted.is_foc),
    observacao: extracted.observacao || 'Rascunho extraído pelo Chat Lince. Revisão humana obrigatória.',
    avisos_triagem: Array.isArray(extracted.avisos_triagem) ? extracted.avisos_triagem : [],
    dados_originais: { classificacao: analysis.classificacao, entidades: analysis.entidades },
    itens: items.length ? items : [emptyItem()],
  };
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function conditionLabel(value) {
  return conditionOptions.find(([key]) => key === value)?.[1] || value || 'Não informada';
}

function statusClasses(item) {
  if (item.contabiliza_pelo_recibo === false || item.inventariado_ppu) return 'bg-slate-200 text-slate-700 dark:bg-slate-700 dark:text-slate-200';
  if (item.condicao_item === 'RECEBIDO_DISPONIVEL') return 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300';
  return 'bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300';
}

function pendingQuantity(item = {}) {
  if (item.contabiliza_pelo_recibo === false || item.condicao_item !== 'RECEBIDO_DISPONIVEL') return 0;
  return Math.max(0, Number(item.quantidade || 0) - Number(item.quantidade_inventariada || 0));
}


function receiptFileExtension(name = '') {
  const parts = String(name || '').toLowerCase().split('.');
  return parts.length > 1 ? parts.pop() : '';
}

function inferBatchReceiptType(name = '') {
  const upper = String(name || '').toUpperCase();
  return /(^|[^A-Z0-9])PD([^A-Z0-9]|$)/.test(upper) || /PD(?:7|9)\d{4}-/.test(upper)
    ? 'recibo_pd'
    : 'recibo_material';
}

async function fileSha256(targetFile) {
  if (!targetFile?.arrayBuffer || !window.crypto?.subtle) return '';
  const digest = await window.crypto.subtle.digest('SHA-256', await targetFile.arrayBuffer());
  return Array.from(new Uint8Array(digest)).map((value) => value.toString(16).padStart(2, '0')).join('');
}

function base64EntryToFile(entry = {}) {
  const binary = window.atob(entry.base64 || '');
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return new File([bytes], entry.name || 'recibo', { type: entry.mime || 'application/octet-stream' });
}

function normalizedReceiptNumber(value = '') {
  return String(value || '').trim().toUpperCase().replace(/\s+/g, '');
}

function batchStatusLabel(status) {
  const normalized = String(status || '').toLowerCase();
  const labels = {
    pending: 'Aguardando',
    queued: 'Aguardando',
    processing: 'Lendo',
    ready: 'Pronto',
    review: 'Revisar',
    duplicate: 'Já importado',
    conflict: 'Conflito',
    saved: 'Salvo',
    error: 'Erro',
  };
  return labels[normalized] || status || 'Pendente';
}

function batchStatusClass(status) {
  const normalized = String(status || '').toLowerCase();
  if (normalized === 'ready') return 'bg-emerald-100 text-emerald-700';
  if (normalized === 'saved') return 'bg-blue-100 text-blue-700';
  if (normalized === 'review' || normalized === 'conflict') return 'bg-amber-100 text-amber-800';
  if (normalized === 'duplicate') return 'bg-slate-200 text-slate-700';
  if (normalized === 'error') return 'bg-red-100 text-red-700';
  return 'bg-slate-100 text-slate-600';
}

function isInformationalTriageNotice(value = '') {
  const message = String(value || '').trim();
  if (!message) return false;
  if (/^\[INFO\]\s*/i.test(message)) return true;
  // Compatibilidade com recibos já gravados antes do C3.4 HF2.
  return /documento foi identificado como GARANTIA[\s\S]*indica(?:ç|c)[aã]o FOC[\s\S]*marca(?:ç|c)[aã]o FOC foi preservada/i.test(message);
}

function triageNoticeText(value = '') {
  return String(value || '').replace(/^\[INFO\]\s*/i, '').trim();
}

function hasBlockingTriageWarnings(warnings = []) {
  return (Array.isArray(warnings) ? warnings : []).some((warning) => !isInformationalTriageNotice(warning));
}

function isBatchJobProcessing(job = {}) {
  return ['QUEUED', 'PROCESSING'].includes(String(job.status || '').toUpperCase());
}

function batchJobPendingActionCount(job = {}) {
  return ['ready_items', 'review_items', 'conflict_items', 'error_items']
    .reduce((sum, field) => sum + Math.max(0, Number(job[field] || 0)), 0);
}

function isBatchJobActionable(job = {}) {
  const status = String(job.status || '').toUpperCase();
  return isBatchJobProcessing(job) || status === 'FAILED' || batchJobPendingActionCount(job) > 0;
}


function persistedJobToRows(job = {}) {
  return (job.items || []).map((item) => ({
    id: item.id,
    fileName: item.file_name,
    archive: job.archive_name,
    status: String(item.status || 'PENDING').toLowerCase(),
    message: item.diagnostic || (item.status === 'PENDING' ? 'Aguardando processamento no backend...' : item.status === 'PROCESSING' ? 'Processando no backend...' : ''),
    hash: item.file_sha256 || '',
    form: item.triage_payload || null,
    receiptNumber: item.receipt_number || 'Não identificado',
    receiptType: item.receipt_type || '—',
    itemCount: Number(item.item_count || 0),
    warnings: Array.isArray(item.warnings) ? item.warnings : [],
    source: item.source_method || 'LOTE_BACKGROUND',
  }));
}

export default function Recebimentos() {
  const { token, user } = useAuth();
  const isAdmin = ['admin', 'dono'].includes(user?.role);
  const fileInputRef = useRef(null);
  const batchInputRef = useRef(null);
  const [q, setQ] = useState('');
  const [receipts, setReceipts] = useState([]);
  const [meta, setMeta] = useState({});
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState(null);
  const [selected, setSelected] = useState(null);
  const [highlightIds, setHighlightIds] = useState([]);
  const [editor, setEditor] = useState(null);
  const [form, setForm] = useState(null);
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [uploadType, setUploadType] = useState('recibo_auto');
  const [uploadMethod, setUploadMethod] = useState('AUTO');
  const [file, setFile] = useState(null);
  const [batchOpen, setBatchOpen] = useState(false);
  const [batchSelection, setBatchSelection] = useState([]);
  const [batchRows, setBatchRows] = useState([]);
  const [batchProcessing, setBatchProcessing] = useState(false);
  const [batchSaving, setBatchSaving] = useState(false);
  const [batchJobId, setBatchJobId] = useState(null);
  const [batchJobMeta, setBatchJobMeta] = useState(null);
  const [recentBatchJobs, setRecentBatchJobs] = useState([]);

  const load = useCallback(async (query = '') => {
    setLoading(true);
    setMessage(null);
    try {
      const response = await apiFetch(`/receipts?q=${encodeURIComponent(query || '')}`, {}, token);
      const json = await response.json();
      if (json.status !== 'success') throw new Error(json.message || 'Falha ao consultar recibos.');
      setReceipts(json.data || []);
      setMeta(json.meta || {});
    } catch (error) {
      setMessage({ type: 'error', text: error.message || 'Falha ao consultar recibos.' });
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => { load(''); }, [load]);


  const loadRecentBatchJobs = useCallback(async () => {
    if (!isAdmin) return;
    try {
      const response = await apiFetch('/receipts/batch/jobs?limit=8', {}, token);
      const json = await response.json();
      if (json.status === 'success') {
        setRecentBatchJobs((json.data || []).filter(isBatchJobActionable));
      }
    } catch (_) {
      // A lista de jobs é auxiliar e não bloqueia o módulo de recibos.
    }
  }, [isAdmin, token]);

  const loadBatchJob = useCallback(async (jobId, options = {}) => {
    if (!jobId || !isAdmin) return null;
    const response = await apiFetch(`/receipts/batch/jobs/${jobId}`, {}, token);
    const json = await response.json();
    if (json.status !== 'success') throw new Error(json.message || 'Falha ao consultar lote persistente.');
    const job = json.data || {};
    setBatchJobId(job.id);
    setBatchJobMeta(job);
    setBatchRows(persistedJobToRows(job));
    if (options.open !== false) setBatchOpen(true);
    return job;
  }, [isAdmin, token]);

  useEffect(() => { loadRecentBatchJobs(); }, [loadRecentBatchJobs]);

  useEffect(() => {
    if (!batchJobId || !isAdmin) return undefined;
    let cancelled = false;
    let timer = null;
    const poll = async () => {
      try {
        const job = await loadBatchJob(batchJobId, { open: false });
        if (!cancelled && ['QUEUED', 'PROCESSING'].includes(String(job?.status || '').toUpperCase())) {
          timer = window.setTimeout(poll, 2000);
        } else if (!cancelled) {
          await loadRecentBatchJobs();
        }
      } catch (_) {
        if (!cancelled) timer = window.setTimeout(poll, 4000);
      }
    };
    timer = window.setTimeout(poll, 1200);
    return () => { cancelled = true; if (timer) window.clearTimeout(timer); };
  }, [batchJobId, isAdmin, loadBatchJob, loadRecentBatchJobs]);

  useEffect(() => {
    if (!isAdmin) return;
    const rawDraft = window.sessionStorage.getItem(DRAFT_KEY);
    if (!rawDraft) return;
    try {
      const draft = JSON.parse(rawDraft);
      setEditor({ mode: 'create', source: 'CHAT_LINCE' });
      setForm({ ...emptyForm('IA_CHAT_LINCE'), ...draft, itens: (draft.itens || []).map(itemFromApi) });
      setMessage({ type: 'success', text: 'Rascunho do Chat Lince carregado. Revise todos os campos antes de salvar.' });
      window.sessionStorage.removeItem(DRAFT_KEY);
    } catch {
      window.sessionStorage.removeItem(DRAFT_KEY);
    }
  }, [isAdmin]);

  const totalItems = useMemo(
    () => receipts.reduce((sum, receipt) => sum + (receipt.recebimento_itens || []).filter((item) => item.ativo !== false).length, 0),
    [receipts],
  );
  const hasProcessingBatchJobs = useMemo(
    () => recentBatchJobs.some(isBatchJobProcessing),
    [recentBatchJobs],
  );

  const openDetail = async (receipt, ids = []) => {
    setHighlightIds(ids || []);
    try {
      const response = await apiFetch(`/receipts/${receipt.id}?q=${encodeURIComponent(q || '')}`, {}, token);
      const json = await response.json();
      if (json.status !== 'success') throw new Error(json.message || 'Falha ao abrir o recibo.');
      setSelected(json.data);
    } catch (error) {
      setMessage({ type: 'error', text: error.message });
    }
  };

  const openEdit = (receipt) => {
    setSelected(null);
    setEditor({ mode: 'edit', id: receipt.id });
    setForm(receiptToForm(receipt));
  };

  const openNew = () => {
    setEditor({ mode: 'create', source: 'MANUAL' });
    setForm(emptyForm('MANUAL'));
  };

  const updateItem = (index, field, value) => {
    setForm((current) => ({
      ...current,
      itens: current.itens.map((item, itemIndex) => {
        if (itemIndex !== index) return item;
        const next = { ...item, [field]: value };
        if (field === 'destino_previsto') next.destino_previsto_fonte = 'MANUAL';
        if (field === 'validade_status') next.validade_observacao = next.validade_observacao || 'Classificação revisada manualmente.';
        if (field === 'quantidade') {
          const quantity = Math.max(0, Number(value || 0));
          next.quantidade_inventariada = Math.min(Number(item.quantidade_inventariada || 0), quantity);
          next.inventariado_ppu = quantity > 0 && next.quantidade_inventariada >= quantity;
          next.contabiliza_pelo_recibo = !next.inventariado_ppu;
        }
        if (field === 'quantidade_inventariada') {
          const quantity = Math.max(0, Number(item.quantidade || 0));
          next.quantidade_inventariada = Math.min(Math.max(0, Number(value || 0)), quantity);
          next.inventariado_ppu = quantity > 0 && next.quantidade_inventariada >= quantity;
          next.contabiliza_pelo_recibo = !next.inventariado_ppu;
          if (next.quantidade_inventariada <= 0) next.destino_estoque = '';
        }
        if (field === 'contabiliza_pelo_recibo') {
          const checked = Boolean(value);
          next.contabiliza_pelo_recibo = checked;
          next.inventariado_ppu = !checked;
          next.quantidade_inventariada = checked ? 0 : Number(item.quantidade || 0);
          if (checked) next.destino_estoque = '';
        }
        return next;
      }),
    }));
  };

  const setCountByReceipt = (index, checked) => {
    setForm((current) => ({
      ...current,
      itens: current.itens.map((item, itemIndex) => itemIndex === index
        ? {
          ...item,
          contabiliza_pelo_recibo: checked,
          inventariado_ppu: !checked,
          quantidade_inventariada: checked ? 0 : Number(item.quantidade || 0),
          destino_estoque: checked ? '' : item.destino_estoque,
        }
        : item),
    }));
  };

  const removeItem = (index) => {
    setForm((current) => ({ ...current, itens: current.itens.filter((_, itemIndex) => itemIndex !== index) }));
  };

  const addItem = () => {
    setForm((current) => ({
      ...current,
      itens: [...current.itens, { ...emptyItem(), sequencia_item: current.itens.length + 1 }],
    }));
  };

  const save = async (event) => {
    event.preventDefault();
    if (!editor || !form) return;
    const batchRowId = editor.batchRowId || null;
    setSaving(true);
    setMessage(null);
    try {
      const path = editor.mode === 'edit' ? `/receipts/${editor.id}` : '/receipts';
      const response = await apiFetch(path, {
        method: editor.mode === 'edit' ? 'PUT' : 'POST',
        headers: buildAuthHeaders(token, { 'Content-Type': 'application/json' }),
        body: JSON.stringify(form),
      }, token);
      const json = await response.json();
      if (!['success', 'success_with_warnings'].includes(json.status)) throw new Error(json.message || 'Falha ao salvar recibo.');
      if (batchRowId) {
        const jobId = editor.batchJobId || batchJobId;
        if (jobId) {
          await apiFetch(`/receipts/batch/jobs/${jobId}/items/${batchRowId}/saved`, {
            method: 'POST', headers: buildAuthHeaders(token),
          }, token);
        }
        setBatchRows((current) => current.map((row) => row.id === batchRowId
          ? { ...row, status: 'saved', message: json.message || 'Recibo revisado e salvo.', form }
          : row));
      }
      setEditor(null);
      setForm(null);
      setMessage({
        type: json.status === 'success_with_warnings' ? 'warning' : 'success',
        text: [json.message, ...(json.warnings || [])].filter(Boolean).join(' '),
      });
      await load(q);
      if (batchRowId) await loadRecentBatchJobs();
      if (json.data) setSelected(json.data);
    } catch (error) {
      setMessage({ type: 'error', text: error.message || 'Falha ao salvar recibo.' });
    } finally {
      setSaving(false);
    }
  };

  const readReceiptFile = async (targetFile, options = {}) => {
    const requestedType = options.uploadType || uploadType;
    const requestedMethod = options.uploadMethod || uploadMethod;
    const extension = receiptFileExtension(targetFile?.name);
    const aiDocument = ['pdf', 'jpg', 'jpeg', 'png', 'webp', 'docx', 'odt', 'txt'].includes(extension);
    const structuralDocument = ['xlsx', 'xls', 'csv', 'ods', 'doc'].includes(extension);
    if (!aiDocument && !structuralDocument) throw new Error(`Formato .${extension || '?'} não suportado para recibos.`);
    if (requestedMethod === 'ESTRUTURAL' && !structuralDocument) {
      throw new Error('A leitura estrutural aceita XLSX, XLS, CSV, ODS e DOC legado. Para PDF, imagem, DOCX ou ODT use Automático ou Chat Lince.');
    }
    let useAi = requestedMethod === 'IA' || (requestedMethod === 'AUTO' && aiDocument);
    const data = new FormData();
    data.append('file', targetFile);

    let json;
    let nextForm;
    if (useAi) {
      data.append('tipoDocumento', requestedType);
      const response = await apiFetch('/chat-lince/documentos/analisar', {
        method: 'POST',
        headers: buildAuthHeaders(token),
        body: data,
      }, token);
      json = await response.json();
      if (!['success', 'partial_success'].includes(json.status)) throw new Error(json.message || 'Falha ao ler o recibo com o Chat Lince.');
      nextForm = aiAnalysisToForm({
        analysis: json.data?.analise || {},
        documentId: json.data?.documento_id || null,
        fileName: targetFile.name,
        uploadType: requestedType,
      });
      if (!nextForm.itens.some((item) => String(item.pn || '').trim())) {
        throw new Error('O Chat Lince não conseguiu estruturar nenhum PN. O documento continuará disponível no módulo da IA para revisão, mas o recibo não foi gravado.');
      }
    } else {
      data.append('tipoArquivo', requestedType);
      const response = await apiFetch('/import/upload', {
        method: 'POST',
        headers: buildAuthHeaders(token),
        body: data,
      }, token);
      json = await response.json();
      if (json.status === 'success') {
        nextForm = importResponseToForm(json);
      } else if (requestedMethod === 'AUTO' && extension === 'doc') {
        const aiData = new FormData();
        aiData.append('file', targetFile);
        aiData.append('tipoDocumento', requestedType);
        const aiResponse = await apiFetch('/chat-lince/documentos/analisar', {
          method: 'POST',
          headers: buildAuthHeaders(token),
          body: aiData,
        }, token);
        json = await aiResponse.json();
        if (!['success', 'partial_success'].includes(json.status)) throw new Error(json.message || 'Falha ao ler o DOC pelo leitor estrutural e pelo Chat Lince.');
        nextForm = aiAnalysisToForm({
          analysis: json.data?.analise || {},
          documentId: json.data?.documento_id || null,
          fileName: targetFile.name,
          uploadType: requestedType,
        });
        if (!nextForm.itens.some((item) => String(item.pn || '').trim())) {
          throw new Error('O DOC não pôde ser estruturado automaticamente. Revise este arquivo individualmente no Chat Lince.');
        }
        useAi = true;
      } else {
        throw new Error(json.message || 'Falha ao ler o recibo.');
      }
    }

    return { json, nextForm, useAi };
  };

  const importReceipt = async (event) => {
    event.preventDefault();
    if (!file) {
      setMessage({ type: 'error', text: 'Selecione o arquivo do recibo.' });
      return;
    }
    setUploading(true);
    setMessage(null);
    try {
      const result = await readReceiptFile(file);
      const hash = await fileSha256(file);
      if (hash) result.nextForm.arquivo_hash = hash;
      setEditor({ mode: 'create', source: result.useAi ? 'IA_CHAT_LINCE' : 'DOCUMENTO' });
      setForm(result.nextForm);
      setMessage({ type: result.json.status === 'partial_success' ? 'warning' : 'success', text: `${result.json.message} Nada foi gravado ainda; revise a tabela antes de salvar.` });
      setFile(null);
      if (fileInputRef.current) fileInputRef.current.value = '';
    } catch (error) {
      setMessage({ type: 'error', text: error.message || 'Falha ao importar recibo.' });
    } finally {
      setUploading(false);
    }
  };

  const processBatch = async () => {
    if (!batchSelection.length) {
      setMessage({ type: 'error', text: 'Selecione vários recibos ou um arquivo ZIP.' });
      return;
    }
    setBatchProcessing(true);
    setMessage(null);
    try {
      const data = new FormData();
      batchSelection.forEach((selectedFile) => data.append('files', selectedFile));
      const response = await apiFetch('/receipts/batch/jobs', {
        method: 'POST', headers: buildAuthHeaders(token), body: data,
      }, token);
      const json = await response.json();
      if (json.status !== 'success') throw new Error(json.message || 'Falha ao iniciar lote persistente.');
      const job = json.data || {};
      setBatchJobId(job.id);
      setBatchJobMeta(job);
      setBatchRows(persistedJobToRows(job));
      setBatchSelection([]);
      if (batchInputRef.current) batchInputRef.current.value = '';
      setMessage({ type: 'success', text: `${json.message} A análise continuará mesmo se você fechar esta página ou atualizar o navegador.` });
      await loadRecentBatchJobs();
    } catch (error) {
      setMessage({ type: 'error', text: error.message || 'Falha ao iniciar lote persistente de recibos.' });
    } finally {
      setBatchProcessing(false);
    }
  };

  const openBatchReview = (row) => {
    if (!row?.form) return;
    setEditor({ mode: 'create', source: row.source || 'LOTE', batchRowId: row.id, batchJobId });
    setForm(row.form);
  };

  const saveBatchReady = async () => {
    const readyRows = batchRows.filter((row) => row.status === 'ready' && row.form);
    if (!readyRows.length) {
      setMessage({ type: 'warning', text: 'Não há recibos classificados como prontos para gravação.' });
      return;
    }
    if (!window.confirm(`Salvar ${readyRows.length} recibo(s) já validados? Itens marcados para revisão, conflitos, duplicados e erros não serão gravados.`)) return;

    setBatchSaving(true);
    let saved = 0;
    for (const row of readyRows) {
      try {
        const response = await apiFetch('/receipts', {
          method: 'POST',
          headers: buildAuthHeaders(token, { 'Content-Type': 'application/json' }),
          body: JSON.stringify(row.form),
        }, token);
        const json = await response.json();
        if (!['success', 'success_with_warnings'].includes(json.status)) throw new Error(json.message || 'Falha ao salvar recibo.');
        saved += 1;
        if (batchJobId) {
          await apiFetch(`/receipts/batch/jobs/${batchJobId}/items/${row.id}/saved`, { method: 'POST', headers: buildAuthHeaders(token) }, token);
        }
        setBatchRows((current) => current.map((item) => item.id === row.id ? { ...item, status: 'saved', message: json.message || 'Recibo salvo.' } : item));
      } catch (error) {
        setBatchRows((current) => current.map((item) => item.id === row.id ? { ...item, status: 'error', message: error.message || 'Falha ao salvar recibo.' } : item));
      }
    }
    setBatchSaving(false);
    await load(q);
    await loadRecentBatchJobs();
    setMessage({ type: saved === readyRows.length ? 'success' : 'warning', text: `${saved} de ${readyRows.length} recibo(s) prontos foram salvos. Os demais continuam na fila para conferência.` });
  };

  const removeReceipt = async (receipt) => {
    if (!window.confirm(`Desativar o recibo ${receipt.numero_recibo}? O histórico permanecerá no banco.`)) return;
    try {
      const response = await apiFetch(`/receipts/${receipt.id}`, { method: 'DELETE' }, token);
      const json = await response.json();
      if (!['success', 'success_with_warnings'].includes(json.status)) throw new Error(json.message || 'Falha ao desativar recibo.');
      setSelected(null);
      setMessage({
        type: json.status === 'success_with_warnings' ? 'warning' : 'success',
        text: [json.message, ...(json.warnings || [])].filter(Boolean).join(' '),
      });
      await load(q);
    } catch (error) {
      setMessage({ type: 'error', text: error.message });
    }
  };

  const downloadExcel = async (receipt = null) => {
    try {
      const path = receipt
        ? `/receipts/${receipt.id}/export`
        : `/receipts/export?q=${encodeURIComponent(q || '')}`;
      const response = await fetch(`${API_BASE_URL}${path}`, { headers: buildAuthHeaders(token) });
      if (!response.ok) throw new Error('Falha ao exportar recibo(s).');
      const blob = await response.blob();
      const url = window.URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = receipt
        ? `SISHA_Recibo_${String(receipt.numero_recibo).replace(/[^a-z0-9_-]/gi, '_')}.xlsx`
        : `SISHA_Recibos_${new Date().toISOString().slice(0, 10)}.xlsx`;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      window.URL.revokeObjectURL(url);
    } catch (error) {
      setMessage({ type: 'error', text: error.message });
    }
  };

  const printReceipt = (receipt) => {
    const items = (receipt.recebimento_itens || []).filter((item) => item.ativo !== false);
    const rows = receiptDisplayRows(items).map(({ item, displaySequence }) => `
      <tr>
        <td>${escapeHtml(displaySequence)}</td>
        <td>${escapeHtml(item.pn)}</td>
        <td>${escapeHtml(item.nsn_pi || '')}</td>
        <td>${escapeHtml(item.nomenclatura || '')}</td>
        <td>${escapeHtml(formatNumber(item.quantidade))}</td>
        <td>${escapeHtml(formatNumber(item.quantidade_inventariada))}</td>
        <td>${escapeHtml(formatNumber(pendingQuantity(item)))}</td>
        <td>${escapeHtml(item.sn || '')}</td>
        <td>${escapeHtml(item.tipo_item || (realSerial(item.sn) ? 'EQUIPAMENTO' : 'SOBRESSALENTE'))}</td>
        <td>${escapeHtml(item.localizacao_ppu || '')}</td>
        <td>${escapeHtml(item.destino_estoque || 'Ainda controlado pelo recibo')}</td>
        <td>${escapeHtml(conditionLabel(item.condicao_item))}</td>
        <td>${item.contabiliza_pelo_recibo === false ? 'NÃO' : 'SIM'}</td>
        <td>${escapeHtml(item.documento_referencia || '')}</td>
        <td>${escapeHtml(item.delivery_note || '')}</td>
        <td>${escapeHtml(item.invoice_no || '')}</td>
        <td>${escapeHtml(item.di || '')}</td>
        <td>${escapeHtml(item.batch_no || '')}</td>
        <td>${escapeHtml(item.coc_no || '')}</td>
        <td>${escapeHtml(item.status_documento || '')}</td>
        <td>${escapeHtml(formatDate(item.data_garantia))}</td>
        <td>${escapeHtml(item.moeda || '')}</td>
        <td>${escapeHtml(item.valor_unitario == null ? '' : formatNumber(item.valor_unitario))}</td>
        <td>${escapeHtml(item.valor_total_documento == null ? '' : formatNumber(item.valor_total_documento))}</td>
        <td>${escapeHtml(item.observacao_item || '')}</td>
      </tr>`).join('');

    const popup = window.open('', '_blank', 'width=1200,height=800');
    if (!popup) {
      setMessage({ type: 'error', text: 'O navegador bloqueou a janela de impressão.' });
      return;
    }
    popup.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>Recibo ${escapeHtml(receipt.numero_recibo)}</title>
      <style>body{font-family:Arial,sans-serif;padding:24px;color:#111}h1{margin:0 0 6px}.meta{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin:18px 0}.box{border:1px solid #bbb;padding:8px}table{width:100%;border-collapse:collapse;font-size:11px}th,td{border:1px solid #999;padding:6px;text-align:left;vertical-align:top}th{background:#eee}.foot{margin-top:20px;font-size:11px}</style></head><body>
      <h1>SISHA — Auditoria do Recibo ${escapeHtml(receipt.numero_recibo)}</h1>
      <p>Emitido em ${escapeHtml(new Date().toLocaleString('pt-BR'))}</p>
      <div class="meta">
        <div class="box"><b>Data:</b> ${escapeHtml(formatDate(receipt.data_recebimento))}</div>
        <div class="box"><b>Tipo:</b> ${escapeHtml(receipt.tipo_recebimento || '')}</div>
        <div class="box"><b>Documento:</b> ${escapeHtml(receipt.documento_referencia || '')}</div>
        <div class="box"><b>Fornecedor:</b> ${escapeHtml(receipt.fornecedor || '')}</div>
        <div class="box"><b>Origem:</b> ${escapeHtml(receipt.origem_material || '')}</div>
        <div class="box"><b>Recebido por:</b> ${escapeHtml(receipt.recebido_por_nome || '')}</div>
        <div class="box"><b>Conferido por:</b> ${escapeHtml(receipt.conferido_por_nome || '')}</div>
        <div class="box"><b>Método:</b> ${escapeHtml(receipt.metodo_importacao || '')}</div>
        <div class="box"><b>Arquivo:</b> ${escapeHtml(receipt.arquivo_nome || '')}</div>
        <div class="box"><b>FOC:</b> ${receipt.is_foc ? 'SIM' : 'NÃO'}</div>
      </div>
      <table><thead><tr><th>#</th><th>PN</th><th>NSN/PI</th><th>Nomenclatura</th><th>Qtd recebida</th><th>Qtd incorporada</th><th>Saldo temporário</th><th>SN</th><th>Tipo</th><th>Local</th><th>Incorporado em</th><th>Condição</th><th>Contabiliza pelo recibo</th><th>PD/Doc.</th><th>Delivery</th><th>Invoice</th><th>DI</th><th>Batch</th><th>CoC</th><th>Status doc.</th><th>Garantia</th><th>Moeda</th><th>V. unit.</th><th>Total doc.</th><th>Observação</th></tr></thead><tbody>${rows}</tbody></table>
      <div class="foot"><b>Observação geral:</b> ${escapeHtml(receipt.observacao || 'Sem observação')}<br><b>Avisos de triagem:</b> ${escapeHtml((receipt.avisos_triagem || []).join(' | ') || 'Sem avisos')}<br>O recibo permanece como histórico mesmo quando seus itens já foram incorporados ao inventário oficial do PPU ou do CEIMSPA.</div>
      </body></html>`);
    popup.document.close();
    popup.focus();
    popup.print();
  };

  return (
    <div className="space-y-6 animate-fade-in">
      <section className="bg-white dark:bg-slate-800 rounded-3xl border border-slate-200 dark:border-slate-700 shadow-sm p-6 space-y-5">
        <div className="flex flex-col xl:flex-row xl:items-start xl:justify-between gap-4">
          <div>
            <h2 className="text-2xl font-black uppercase text-slate-900 dark:text-white">Recibos e Recebimentos</h2>
            <p className="text-sm font-bold text-slate-500 dark:text-slate-400 max-w-4xl">
              Auditoria completa por recibo, PN, SN ou documento. Itens ainda não incorporados permanecem rastreados pelo Recibo/local; quando o documento indica destino direto ao CEIMSPA, o Radar separa esse saldo do PPU até a incorporação oficial.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <div className="px-4 py-3 rounded-2xl bg-slate-100 dark:bg-slate-900 text-xs font-black text-slate-600 dark:text-slate-300">{receipts.length} recibo(s) • {totalItems} linha(s)</div>
            <button onClick={() => downloadExcel()} className="px-4 py-3 rounded-2xl bg-slate-700 hover:bg-slate-600 text-white font-black flex items-center gap-2"><Download size={17} /> Exportar consulta</button>
          </div>
        </div>

        <div className="flex flex-col md:flex-row gap-3">
          <input value={q} onChange={(event) => setQ(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') load(q); }} placeholder="Digite número do recibo, PN, SN, PD, local, origem ou responsável" className={`${inputClass} flex-1`} />
          <button onClick={() => load(q)} className="px-5 py-3 rounded-2xl bg-blue-600 text-white font-black flex items-center justify-center gap-2"><Search size={18} /> Buscar</button>
          <button onClick={() => { setQ(''); load(''); }} className="px-4 py-3 rounded-2xl bg-slate-200 dark:bg-slate-700 text-slate-900 dark:text-white font-black"><RefreshCcw size={18} /></button>
        </div>
        {q && meta.quantidade_encontrada > 0 && <p className="text-sm font-black text-blue-700 dark:text-blue-300">Quantidade localizada nos itens correspondentes: {formatNumber(meta.quantidade_encontrada)}</p>}
        {message && <p className={`font-black ${message.type === 'success' ? 'text-emerald-600' : message.type === 'warning' ? 'text-amber-600' : 'text-red-600'}`}>{message.text}</p>}
      </section>

      {isAdmin && recentBatchJobs.length > 0 && (
        <section className="rounded-2xl border border-indigo-200 dark:border-indigo-900 bg-indigo-50 dark:bg-indigo-950/20 p-4">
          <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-3">
            <div>
              <p className="text-[10px] font-black uppercase text-indigo-700 dark:text-indigo-300">{hasProcessingBatchJobs ? 'Processamento em andamento' : 'Revisão pendente'}</p>
              <p className="text-sm font-bold text-slate-600 dark:text-slate-300">{hasProcessingBatchJobs ? 'O lote continua mesmo se você fechar esta tela. Ao terminar o processamento, ficam visíveis somente pendências que ainda exigem sua ação.' : 'Aparecem aqui somente lotes que ainda exigem conferência. Lotes totalmente concluídos desaparecem automaticamente.'}</p>
            </div>
            <div className="flex flex-wrap gap-2">
              {recentBatchJobs.slice(0, 3).map((job) => (
                <button key={job.id} type="button" onClick={() => loadBatchJob(job.id)} className="px-3 py-2 rounded-xl bg-white dark:bg-slate-900 border border-indigo-200 dark:border-indigo-800 text-xs font-black text-indigo-700 dark:text-indigo-300">
                  {job.archive_name} • {job.processed_items || 0}/{job.total_items || 0} • {isBatchJobProcessing(job) ? batchStatusLabel(job.status) : `${batchJobPendingActionCount(job)} pendência(s)`}
                </button>
              ))}
            </div>
          </div>
        </section>
      )}

      {isAdmin && (
        <form onSubmit={importReceipt} className="bg-blue-50 dark:bg-blue-950/20 rounded-3xl border border-blue-200 dark:border-blue-900 p-6 space-y-4">
          <div className="flex flex-col lg:flex-row lg:items-start lg:justify-between gap-3">
            <div>
              <h3 className="font-black uppercase text-blue-950 dark:text-blue-100">Importar recibo para triagem</h3>
              <p className="text-xs font-bold text-blue-700 dark:text-blue-300">Área administrativa para criar ou importar recibos. Nada é gravado antes da conferência.</p>
            </div>
            <button type="button" onClick={openNew} className="px-4 py-3 rounded-2xl bg-blue-600 hover:bg-blue-700 text-white font-black flex items-center justify-center gap-2 whitespace-nowrap">
              <Plus size={17} /> Novo recibo
            </button>
          </div>
          <div className="grid grid-cols-1 lg:grid-cols-[220px_270px_1fr_auto] gap-3">
            <select value={uploadType} onChange={(event) => setUploadType(event.target.value)} className={inputClass}>
              <option value="recibo_auto">Automático — Material / Garantia / PD</option>
              <option value="recibo_material">Material / Garantia — forçar leitor</option>
              <option value="recibo_pd">PD — forçar leitor</option>
            </select>
            <select value={uploadMethod} onChange={(event) => setUploadMethod(event.target.value)} className={inputClass}>
              <option value="AUTO">Automático — escolhe o melhor leitor</option>
              <option value="IA">Leitura inteligente pelo Chat Lince</option>
              <option value="ESTRUTURAL">Leitura estrutural de planilha</option>
            </select>
            <input ref={fileInputRef} type="file" accept=".xlsx,.xls,.csv,.ods,.doc,.docx,.odt,.pdf,.txt,.jpg,.jpeg,.png,.webp" onChange={(event) => setFile(event.target.files?.[0] || null)} className={inputClass} />
            <div className="flex flex-col sm:flex-row gap-2">
              <button disabled={uploading} className="px-5 py-3 rounded-2xl bg-blue-600 disabled:opacity-50 text-white font-black flex items-center justify-center gap-2"><FileUp size={18} /> {uploading ? 'Lendo...' : 'Ler e revisar'}</button>
              <button type="button" onClick={() => setBatchOpen(true)} className="px-5 py-3 rounded-2xl bg-blue-950 dark:bg-blue-800 text-white font-black flex items-center justify-center gap-2 whitespace-nowrap"><FileUp size={18} /> Vários / ZIP</button>
            </div>
          </div>
          <p className="text-[11px] font-bold text-blue-700 dark:text-blue-300">Formatos: PDF, JPG/JPEG, PNG, WEBP, XLSX, XLS, CSV, ODS, DOC, DOCX, ODT e TXT. Para dezenas de recibos, use “Vários / ZIP”: o lote fica persistido no backend, continua mesmo se você fechar a página, separa prontos, revisões, duplicados e erros, e não grava nada antes da sua confirmação.</p>
        </form>
      )}

      {batchOpen && isAdmin && (
        <div className="fixed inset-0 z-40 bg-black/70 flex items-center justify-center p-3">
          <div className="w-full max-w-6xl max-h-[92vh] overflow-hidden rounded-3xl bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-700 shadow-2xl flex flex-col">
            <div className="p-5 border-b border-slate-200 dark:border-slate-700 flex items-start justify-between gap-4">
              <div>
                <h3 className="text-xl font-black text-slate-900 dark:text-white">Importar vários recibos</h3>
                <p className="text-xs font-bold text-slate-500 mt-1">Selecione vários documentos ou um ZIP. O SISHA processa o lote de forma persistente em segundo plano; você pode fechar esta página sem perder a fila. Nada operacional é salvo automaticamente.</p>
              </div>
              <button type="button" onClick={() => setBatchOpen(false)} className="p-2 rounded-xl bg-slate-200 dark:bg-slate-800 text-slate-700 dark:text-white"><X size={18} /></button>
            </div>

            <div className="p-5 space-y-4 overflow-auto">
              <div className="rounded-2xl bg-blue-50 dark:bg-blue-950/20 border border-blue-200 dark:border-blue-900 p-4 space-y-3">
                <input
                  ref={batchInputRef}
                  multiple
                  type="file"
                  accept=".zip,.xlsx,.xls,.csv,.ods,.doc,.docx,.odt,.pdf,.txt,.jpg,.jpeg,.png,.webp"
                  onChange={(event) => setBatchSelection(Array.from(event.target.files || []))}
                  className={inputClass}
                />
                <div className="flex flex-wrap items-center gap-3">
                  <button type="button" disabled={batchProcessing || !batchSelection.length} onClick={processBatch} className="px-5 py-3 rounded-xl bg-blue-600 disabled:opacity-50 text-white font-black flex items-center gap-2"><FileUp size={17} /> {batchProcessing ? 'Enviando lote...' : 'Processar em segundo plano'}</button>
                  <button type="button" disabled={batchProcessing} onClick={() => { setBatchSelection([]); setBatchRows([]); setBatchJobId(null); setBatchJobMeta(null); if (batchInputRef.current) batchInputRef.current.value = ''; }} className="px-4 py-3 rounded-xl bg-slate-200 dark:bg-slate-800 text-slate-800 dark:text-white font-black">Limpar fila</button>
                  <p className="text-xs font-bold text-slate-500">{batchSelection.length ? `${batchSelection.length} seleção(ões)` : 'Até 150 documentos por lote. ZIP até 50 MB.'}</p>
                </div>
                <p className="text-[11px] font-bold text-blue-700 dark:text-blue-300">No lote, você pode misturar Recibos de Material, Garantia e PD. O arquivo original fica privado no R2 e a fila no Supabase; o processamento sobrevive a reload/fechamento da página e retoma itens com lease expirado após reinício do backend. Hash repetido reaproveita análise ou vira duplicado; IA é usada apenas quando o leitor estrutural não for suficiente.</p>
              </div>

              {batchJobMeta && isBatchJobProcessing(batchJobMeta) && (
                <div className="rounded-2xl border border-indigo-300 bg-indigo-50 dark:bg-indigo-950/20 p-4">
                  <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-2">
                    <div>
                      <p className="text-[10px] font-black uppercase text-indigo-700 dark:text-indigo-300">Processamento do lote • {batchJobMeta.status}</p>
                      <p className="font-black text-slate-900 dark:text-white">{batchJobMeta.archive_name}</p>
                      <p className="text-xs font-bold text-slate-500">{batchJobMeta.processed_items || 0} de {batchJobMeta.total_items || 0} analisados • você pode fechar esta janela ou o navegador.</p>
                    </div>
                    <div className="text-right">
                      <p className="text-2xl font-black text-indigo-700 dark:text-indigo-300">{batchJobMeta.total_items ? Math.round(((batchJobMeta.processed_items || 0) / batchJobMeta.total_items) * 100) : 0}%</p>
                      <p className="text-[10px] font-black uppercase text-slate-500">em andamento</p>
                    </div>
                  </div>
                </div>
              )}

              {batchRows.length > 0 && (
                <>
                  <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-7 gap-2">
                    {[
                      ['Total', batchRows.length],
                      ['Prontos', batchRows.filter((row) => row.status === 'ready').length],
                      ['Revisar', batchRows.filter((row) => row.status === 'review').length],
                      ['Conflitos', batchRows.filter((row) => row.status === 'conflict').length],
                      ['Duplicados', batchRows.filter((row) => row.status === 'duplicate').length],
                      ['Erros', batchRows.filter((row) => row.status === 'error').length],
                      ['Salvos', batchRows.filter((row) => row.status === 'saved').length],
                    ].map(([label, value]) => <div key={label} className="rounded-xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 p-3"><p className="text-[9px] uppercase font-black text-slate-500">{label}</p><p className="text-lg font-black text-slate-900 dark:text-white">{value}</p></div>)}
                  </div>

                  <div className="overflow-auto rounded-2xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900">
                    <table className="min-w-[980px] w-full text-xs">
                      <thead className="bg-slate-100 dark:bg-slate-800 uppercase text-[9px] text-slate-600 dark:text-slate-300">
                        <tr><th className="p-3 text-left">Arquivo</th><th className="p-3 text-left">Recibo</th><th className="p-3 text-left">Tipo</th><th className="p-3 text-left">Itens</th><th className="p-3 text-left">Status</th><th className="p-3 text-left">Diagnóstico</th><th className="p-3 text-left">Ação</th></tr>
                      </thead>
                      <tbody>
                        {batchRows.map((row) => (
                          <tr key={row.id} className="border-t border-slate-200 dark:border-slate-800 align-top">
                            <td className="p-3"><p className="font-black text-slate-900 dark:text-white break-all">{row.fileName}</p>{row.archive && <p className="text-[9px] font-bold text-slate-500 mt-1">ZIP: {row.archive}</p>}</td>
                            <td className="p-3 font-black">{row.receiptNumber || '—'}</td>
                            <td className="p-3 font-bold">{row.receiptType || '—'}</td>
                            <td className="p-3 font-black">{row.itemCount ?? '—'}</td>
                            <td className="p-3"><span className={`inline-block px-3 py-1.5 rounded-full text-[10px] font-black uppercase ${batchStatusClass(row.status)}`}>{batchStatusLabel(row.status)}</span></td>
                            <td className="p-3 max-w-md"><p className="font-bold text-slate-600 dark:text-slate-300">{row.message || '—'}</p></td>
                            <td className="p-3">{row.form && !['duplicate', 'saved', 'error'].includes(row.status) ? <button type="button" onClick={() => openBatchReview(row)} className="px-3 py-2 rounded-xl bg-slate-900 dark:bg-slate-700 text-white font-black">Revisar</button> : <span className="text-slate-400 font-bold">—</span>}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </>
              )}
            </div>

            <div className="p-4 border-t border-slate-200 dark:border-slate-700 flex flex-wrap justify-between gap-3 bg-white dark:bg-slate-900">
              <p className="text-xs font-bold text-slate-500 max-w-2xl">“Salvar somente os prontos” grava apenas documentos sem avisos bloqueantes ou conflitos. Tudo que estiver em Revisar/Conflito permanece fora do banco até conferência manual.</p>
              <div className="flex gap-2">
                <button type="button" onClick={() => setBatchOpen(false)} className="px-5 py-3 rounded-xl bg-slate-200 dark:bg-slate-800 text-slate-900 dark:text-white font-black">Fechar</button>
                <button type="button" disabled={batchSaving || batchProcessing || !batchRows.some((row) => row.status === 'ready')} onClick={saveBatchReady} className="px-5 py-3 rounded-xl bg-emerald-600 disabled:opacity-50 text-white font-black flex items-center gap-2"><Save size={17} /> {batchSaving ? 'Salvando...' : 'Salvar somente os prontos'}</button>
              </div>
            </div>
          </div>
        </div>
      )}

      {loading && <p className="font-black text-slate-500">Carregando recibos...</p>}
      <section className="grid grid-cols-1 xl:grid-cols-2 gap-5">
        {!loading && receipts.map((receipt) => {
          const items = (receipt.recebimento_itens || []).filter((item) => item.ativo !== false);
          const pending = items.filter((item) => pendingQuantity(item) > 0);
          const inventoried = items.filter((item) => Number(item.quantidade_inventariada || 0) > 0);
          const exceptions = items.filter((item) => item.condicao_item !== 'RECEBIDO_DISPONIVEL');
          const matchIds = receipt._match?.item_ids || [];
          return (
            <article key={receipt.id} onClick={() => openDetail(receipt, matchIds)} className="bg-white dark:bg-slate-800 rounded-3xl border border-slate-200 dark:border-slate-700 shadow-sm p-6 space-y-4 cursor-pointer hover:border-blue-400 hover:-translate-y-0.5 transition">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="text-xl font-black text-slate-900 dark:text-white">Recibo {receipt.numero_recibo}</h3>
                    <span className="px-3 py-1 rounded-full bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300 text-[10px] font-black uppercase">{receipt.tipo_recebimento}</span>
                    {receipt.is_foc && <span className="px-3 py-1 rounded-full bg-amber-100 text-amber-700 text-[10px] font-black uppercase">FOC</span>}
                  </div>
                  <p className="text-xs font-bold text-slate-500 mt-1">Recebido em {formatDate(receipt.data_recebimento)} • {items.length} linha(s)</p>
                  {receipt.documento_referencia && <p className="text-xs font-bold text-slate-600 dark:text-slate-300 mt-1">Referência: {receipt.documento_referencia}</p>}
                  {receipt.programa_origem && <p className="text-xs font-bold text-amber-700 dark:text-amber-300 mt-1">Programa/origem: {receipt.programa_origem}</p>}
                  {(receipt.sigla_recebedora || receipt.codigo_om_recebedora) && <p className="text-xs font-bold text-slate-500 mt-1">Recebedor documental: {receipt.sigla_recebedora || 'OM'} {receipt.codigo_om_recebedora ? `• OM ${receipt.codigo_om_recebedora}` : ''}</p>}
                  {receipt.recebido_por_nome && <p className="text-xs font-bold text-slate-500 mt-1">Recebido por: {receipt.recebido_por_nome}</p>}
                </div>
                <div className="flex gap-2" onClick={(event) => event.stopPropagation()}>
                  <button onClick={() => openDetail(receipt, matchIds)} className="p-2.5 rounded-xl bg-slate-200 dark:bg-slate-700 text-slate-800 dark:text-white" title="Auditar recibo"><Eye size={16} /></button>
                  {isAdmin && <button onClick={() => openEdit(receipt)} className="p-2.5 rounded-xl bg-blue-600 text-white" title="Editar recibo"><Pencil size={16} /></button>}
                  {isAdmin && <button onClick={() => removeReceipt(receipt)} className="p-2.5 rounded-xl bg-red-600 text-white" title="Desativar recibo"><Trash2 size={16} /></button>}
                </div>
              </div>

              <div className="grid grid-cols-3 gap-2 text-center">
                <div className="rounded-2xl bg-emerald-50 dark:bg-emerald-950/20 p-3"><p className="text-lg font-black text-emerald-700 dark:text-emerald-300">{formatNumber(pending.reduce((sum, item) => sum + pendingQuantity(item), 0))}</p><p className="text-[9px] font-black uppercase text-emerald-700">Saldo temporário</p></div>
                <div className="rounded-2xl bg-slate-100 dark:bg-slate-900 p-3"><p className="text-lg font-black text-slate-700 dark:text-slate-200">{formatNumber(inventoried.reduce((sum, item) => sum + Number(item.quantidade_inventariada || 0), 0))}</p><p className="text-[9px] font-black uppercase text-slate-600">Já incorporado</p></div>
                <div className="rounded-2xl bg-amber-50 dark:bg-amber-950/20 p-3"><p className="text-lg font-black text-amber-700 dark:text-amber-300">{exceptions.length}</p><p className="text-[9px] font-black uppercase text-amber-700">Exceções</p></div>
              </div>

              {receipt._match?.tipo === 'PN_EXATO' && <div className="rounded-xl bg-blue-50 dark:bg-blue-950/30 px-4 py-2 text-sm font-black text-blue-700 dark:text-blue-300">PN {receipt._match.pn_exato}: {formatNumber(receipt._match.quantidade)} unidade(s) neste recibo.</div>}

              <div className="space-y-2 max-h-64 overflow-auto pr-1">
                {items.slice(0, 12).map((item) => {
                  const highlighted = matchIds.includes(item.id);
                  return (
                    <div key={item.id} className={`p-3 rounded-2xl border ${highlighted ? 'bg-blue-50 border-blue-400 dark:bg-blue-950/30' : 'bg-slate-50 dark:bg-slate-900/50 border-slate-100 dark:border-slate-700'}`}>
                      <div className="flex items-center justify-between gap-3">
                        <p className="font-black text-slate-900 dark:text-white">PN {item.pn}</p>
                        <p className="text-sm font-black text-blue-600 dark:text-blue-300">Qtd {formatNumber(item.quantidade)}</p>
                      </div>
                      <p className="text-xs font-bold text-slate-500 truncate">{item.nomenclatura || 'Sem nomenclatura'} • SN {item.sn || 'N/A'} • {item.localizacao_ppu || 'Local não informado'} • {item.contabiliza_pelo_recibo === false ? `Incorporado no ${item.destino_estoque || 'estoque oficial'}` : 'Controlado pelo recibo'}</p>
                    </div>
                  );
                })}
              </div>
              {items.length > 12 && <p className="text-xs font-black text-slate-500">+ {items.length - 12} linha(s). Clique para auditar o recibo completo.</p>}
            </article>
          );
        })}
      </section>
      {!loading && receipts.length === 0 && <p className="font-black text-slate-500">Nenhum recibo encontrado.</p>}

      {selected && (
        <div className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-3">
          <div className="bg-slate-50 dark:bg-slate-950 rounded-3xl p-6 w-full max-w-[96vw] max-h-[94vh] overflow-auto shadow-2xl border border-slate-200 dark:border-slate-700 space-y-5">
            <div className="flex flex-col lg:flex-row lg:items-start lg:justify-between gap-4">
              <div>
                <h3 className="text-2xl font-black uppercase text-slate-900 dark:text-white">Auditoria do Recibo {selected.numero_recibo}</h3>
                <p className="text-xs font-bold text-slate-500">Consulta permitida para Dono, Admin e Operador. O recibo permanece histórico mesmo após a entrada oficial no PPU.</p>
              </div>
              <div className="flex flex-wrap gap-2">
                <button onClick={() => printReceipt(selected)} className="px-4 py-2.5 rounded-xl bg-slate-800 text-white font-black flex items-center gap-2"><Printer size={16} /> Imprimir</button>
                <button onClick={() => downloadExcel(selected)} className="px-4 py-2.5 rounded-xl bg-emerald-600 text-white font-black flex items-center gap-2"><Download size={16} /> Extrair</button>
                {isAdmin && <button onClick={() => openEdit(selected)} className="px-4 py-2.5 rounded-xl bg-blue-600 text-white font-black flex items-center gap-2"><Pencil size={16} /> Editar</button>}
                <button onClick={() => setSelected(null)} className="p-2.5 rounded-xl bg-slate-200 dark:bg-slate-800"><X size={18} /></button>
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-3 text-sm">
              {[
                ['Data', formatDate(selected.data_recebimento)],
                ['Tipo', selected.tipo_recebimento],
                ['Documento/PD', selected.documento_referencia || 'Não informado'],
                ['Fornecedor', selected.fornecedor || 'Não informado'],
                ['Origem', selected.origem_material || 'Não informada'],
                ['Programa/origem', selected.programa_origem || 'Não informado'],
                ['OM recebedora', [selected.sigla_recebedora, selected.codigo_om_recebedora && `OM ${selected.codigo_om_recebedora}`].filter(Boolean).join(' • ') || 'Não informada'],
                ['Recebido por', selected.recebido_por_nome || 'Não informado'],
                ['Conferido por', selected.conferido_por_nome || 'Não informado'],
                ['Método de entrada', selected.metodo_importacao || 'Não informado'],
                ['Arquivo de origem', selected.arquivo_nome || 'Não informado'],
                ['Recebimento FOC', selected.is_foc ? 'SIM' : 'NÃO'],
              ].map(([title, value]) => <div key={title} className="rounded-2xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 p-3"><p className="text-[9px] font-black uppercase text-slate-500">{title}</p><p className="font-black text-slate-900 dark:text-white break-words">{value}</p></div>)}
            </div>

            {Array.isArray(selected.avisos_triagem) && selected.avisos_triagem.length > 0 && (() => {
              const blocking = hasBlockingTriageWarnings(selected.avisos_triagem);
              return (
                <div className={`rounded-2xl border p-4 ${blocking ? 'border-amber-300 bg-amber-50 dark:bg-amber-950/20' : 'border-blue-300 bg-blue-50 dark:bg-blue-950/20'}`}>
                  <p className={`text-[10px] font-black uppercase mb-2 ${blocking ? 'text-amber-800 dark:text-amber-200' : 'text-blue-800 dark:text-blue-200'}`}>{blocking ? 'Avisos preservados da importação' : 'Informações preservadas da importação'}</p>
                  <ul className={`list-disc pl-5 text-xs font-bold space-y-1 ${blocking ? 'text-amber-800 dark:text-amber-200' : 'text-blue-800 dark:text-blue-200'}`}>{selected.avisos_triagem.map((warningText, index) => <li key={`${index}-${warningText}`}>{triageNoticeText(warningText)}</li>)}</ul>
                </div>
              );
            })()}

            <div className="overflow-auto rounded-2xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900">
              <table className="min-w-[3300px] w-full text-xs">
                <thead className="bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-200 uppercase text-[9px]">
                  <tr><th className="p-3 text-left">#</th><th className="p-3 text-left">PN</th><th className="p-3 text-left">NSN/PI</th><th className="p-3 text-left">Nomenclatura</th><th className="p-3 text-left">Qtd recebida</th><th className="p-3 text-left">Qtd incorporada</th><th className="p-3 text-left">Saldo temporário</th><th className="p-3 text-left">SN</th><th className="p-3 text-left">Tipo</th><th className="p-3 text-left">Local temporário</th><th className="p-3 text-left">Destino previsto</th><th className="p-3 text-left">Incorporado em</th><th className="p-3 text-left">Validade/status</th><th className="p-3 text-left">Condição</th><th className="p-3 text-left">Situação do saldo</th><th className="p-3 text-left">PD/Documento</th><th className="p-3 text-left">Delivery</th><th className="p-3 text-left">Invoice</th><th className="p-3 text-left">DI</th><th className="p-3 text-left">Batch</th><th className="p-3 text-left">CoC</th><th className="p-3 text-left">Status doc.</th><th className="p-3 text-left">Garantia</th><th className="p-3 text-left">Moeda</th><th className="p-3 text-left">Valor unitário</th><th className="p-3 text-left">Total documento</th><th className="p-3 text-left">Observações</th></tr>
                </thead>
                <tbody>
                  {receiptDisplayRows((selected.recebimento_itens || []).filter((item) => item.ativo !== false)).map(({ item, displaySequence }) => {
                    const highlighted = highlightIds.includes(item.id) || selected._match?.item_ids?.includes(item.id);
                    const fullInventory = Number(item.quantidade || 0) > 0 && Number(item.quantidade_inventariada || 0) >= Number(item.quantidade || 0);
                    const inventoryText = item.contabiliza_pelo_recibo === false || fullInventory ? `INCORPORADO — ${item.destino_estoque || 'estoque oficial'}` : Number(item.quantidade_inventariada || 0) > 0 ? 'PARCIAL — soma apenas o restante' : item.condicao_item === 'RECEBIDO_DISPONIVEL' ? 'NO RECIBO — soma Radar' : 'SEM SALDO';
                    return <tr key={item.id} className={`border-t border-slate-100 dark:border-slate-800 ${highlighted ? 'bg-blue-100 dark:bg-blue-950/40' : ''}`}>
                      <td className="p-3 font-black">{displaySequence}</td><td className="p-3 font-black">{item.pn}</td><td className="p-3">{item.nsn_pi || '—'}</td><td className="p-3 min-w-72">{item.nomenclatura || '—'}</td><td className="p-3 font-black">{formatNumber(item.quantidade)}</td><td className="p-3 font-black">{formatNumber(item.quantidade_inventariada)}</td><td className="p-3 font-black text-emerald-700">{formatNumber(pendingQuantity(item))}</td><td className="p-3 font-black">{item.sn || '—'}</td><td className="p-3">{item.tipo_item || (realSerial(item.sn) ? 'EQUIPAMENTO' : 'SOBRESSALENTE')}</td><td className="p-3">{item.localizacao_ppu || '—'}</td><td className="p-3 font-black">{item.destino_previsto || '—'}</td><td className="p-3 font-black">{item.destino_estoque || '—'}</td><td className="p-3">{item.validade_status || 'NAO_INFORMADA'}</td><td className="p-3">{conditionLabel(item.condicao_item)}</td><td className="p-3"><span className={`px-2 py-1 rounded-full font-black text-[9px] ${statusClasses({ ...item, inventariado_ppu: fullInventory })}`}>{inventoryText}</span></td><td className="p-3">{item.documento_referencia || '—'}</td><td className="p-3">{item.delivery_note || '—'}</td><td className="p-3">{item.invoice_no || '—'}</td><td className="p-3">{item.di || '—'}</td><td className="p-3">{item.batch_no || '—'}</td><td className="p-3">{item.coc_no || '—'}</td><td className="p-3">{item.status_documento || '—'}</td><td className="p-3">{formatDate(item.data_garantia)}</td><td className="p-3">{item.moeda || '—'}</td><td className="p-3">{item.valor_unitario == null ? '—' : formatNumber(item.valor_unitario)}</td><td className="p-3">{item.valor_total_documento == null ? '—' : formatNumber(item.valor_total_documento)}</td><td className="p-3 min-w-64">{item.observacao_item || '—'}</td>
                    </tr>;
                  })}
                </tbody>
              </table>
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
              <div className="rounded-2xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 p-4"><p className="text-[10px] font-black uppercase text-slate-500">Observação geral</p><p className="text-sm font-bold text-slate-700 dark:text-slate-200 whitespace-pre-wrap">{selected.observacao || 'Sem observações gerais.'}</p></div>
              <div className="rounded-2xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 p-4"><p className="text-[10px] font-black uppercase text-slate-500 mb-2">Histórico de auditoria</p><div className="space-y-2 max-h-44 overflow-auto">{(selected.recebimento_eventos || []).length ? selected.recebimento_eventos.map((event) => <div key={event.id} className="text-xs border-l-4 border-blue-500 pl-3"><p className="font-black">{event.tipo_evento}</p><p className="text-slate-500">{new Date(event.created_at).toLocaleString('pt-BR')} • {event.created_by_email || 'Sistema'}</p></div>) : <p className="text-xs font-bold text-slate-500">Sem eventos registrados.</p>}</div></div>
            </div>
          </div>
        </div>
      )}

      {editor && form && isAdmin && (
        <div className="fixed inset-0 z-[60] bg-black/75 flex items-center justify-center p-2">
          <form onSubmit={save} className="bg-slate-50 dark:bg-slate-950 rounded-3xl p-5 w-full max-w-[98vw] max-h-[96vh] overflow-auto shadow-2xl border border-slate-200 dark:border-slate-700 space-y-5">
            <div className="flex flex-col lg:flex-row lg:items-start lg:justify-between gap-4">
              <div>
                <h3 className="text-xl font-black uppercase text-slate-900 dark:text-white">{editor.mode === 'edit' ? `Editar recibo ${form.numero_recibo}` : 'Triagem e cadastro do recibo'}</h3>
                <p className="text-xs font-bold text-slate-500">Revise tudo. Nada lido por código ou IA é considerado definitivo antes deste salvamento.</p>
              </div>
              <button type="button" onClick={() => { setEditor(null); setForm(null); }} className="p-2 rounded-xl bg-slate-200 dark:bg-slate-800 self-end lg:self-auto"><X size={18} /></button>
            </div>

            <div className="rounded-2xl border-2 border-emerald-300 bg-emerald-50 dark:bg-emerald-950/20 p-4 text-sm font-bold text-emerald-900 dark:text-emerald-200">
              <b>Regra de contabilização:</b> mantenha “Contabilizar pelo recibo” marcado enquanto o material ainda estiver no local temporário informado, como HANGAR ou CAIXA 64. Nesse estado, o Radar soma a quantidade e identifica o Recibo e o local, sem tratá-la como inventário oficial. Desmarque somente após a entrada no estoque oficial e selecione PPU ou CEIMSPA. O recibo continuará rastreável, mas não somará novamente. Itens faltantes, defeituosos, divergentes ou em quarentena não entram no disponível. “Destino previsto” é apenas a rota logística do documento (ex.: PD 71200 → CEIMSPA) e não significa que o item já foi incorporado ao inventário oficial.
            </div>

            {Array.isArray(form.avisos_triagem) && form.avisos_triagem.length > 0 && (() => {
              const blocking = hasBlockingTriageWarnings(form.avisos_triagem);
              return (
                <div className={`rounded-2xl border-2 p-4 ${blocking ? 'border-amber-300 bg-amber-50 dark:bg-amber-950/20' : 'border-blue-300 bg-blue-50 dark:bg-blue-950/20'}`}>
                  <p className={`font-black uppercase mb-2 ${blocking ? 'text-amber-900 dark:text-amber-200' : 'text-blue-900 dark:text-blue-200'}`}>{blocking ? 'Pendências encontradas na leitura' : 'Informações identificadas na leitura'}</p>
                  <ul className={`list-disc pl-5 space-y-1 text-sm font-bold ${blocking ? 'text-amber-800 dark:text-amber-200' : 'text-blue-800 dark:text-blue-200'}`}>
                    {form.avisos_triagem.map((warningText, index) => <li key={`${index}-${warningText}`}>{triageNoticeText(warningText)}</li>)}
                  </ul>
                  <p className={`text-xs font-bold mt-2 ${blocking ? 'text-amber-700 dark:text-amber-300' : 'text-blue-700 dark:text-blue-300'}`}>{blocking
                    ? 'Há pelo menos uma pendência de qualidade que deve ser conferida pelo Admin ou Dono antes da gravação em lote.'
                    : 'GARANTIA + FOC é uma combinação logística válida. Esta informação fica preservada, mas não exige uma nova revisão por si só.'}</p>
                </div>
              );
            })()}

            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-4">
              <label><span className={labelClass}>Número do recibo *</span><input required value={form.numero_recibo} onChange={(event) => setForm({ ...form, numero_recibo: event.target.value })} className={inputClass} /></label>
              <label><span className={labelClass}>Tipo</span><select value={form.tipo_recebimento} onChange={(event) => setForm({ ...form, tipo_recebimento: event.target.value })} className={inputClass}>{receiptTypeOptions.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
              <label><span className={labelClass}>Data do recebimento</span><input type="date" value={form.data_recebimento} onChange={(event) => setForm({ ...form, data_recebimento: event.target.value })} className={inputClass} /></label>
              <label><span className={labelClass}>Documento / PD de referência</span><input value={form.documento_referencia} onChange={(event) => setForm({ ...form, documento_referencia: event.target.value })} className={inputClass} /></label>
              <label><span className={labelClass}>Fornecedor</span><input value={form.fornecedor} onChange={(event) => setForm({ ...form, fornecedor: event.target.value })} className={inputClass} /></label>
              <label><span className={labelClass}>Origem do material</span><input value={form.origem_material} onChange={(event) => setForm({ ...form, origem_material: event.target.value })} placeholder="Ex.: DE, fornecedor, unidade" className={inputClass} /></label>
              <label><span className={labelClass}>Programa / origem logística</span><input value={form.programa_origem} onChange={(event) => setForm({ ...form, programa_origem: event.target.value })} placeholder="Ex.: Brazil 7&8 Planning Removal" className={inputClass} /></label>
              <label><span className={labelClass}>Sigla recebedora</span><input value={form.sigla_recebedora} onChange={(event) => setForm({ ...form, sigla_recebedora: event.target.value.toUpperCase() })} placeholder="ESQDHA-1 / CEIMSPA" className={inputClass} /></label>
              <label><span className={labelClass}>Código OM recebedora</span><input value={form.codigo_om_recebedora} onChange={(event) => setForm({ ...form, codigo_om_recebedora: event.target.value })} className={inputClass} /></label>
              <label><span className={labelClass}>Quem recebeu</span><input value={form.recebido_por_nome} onChange={(event) => setForm({ ...form, recebido_por_nome: event.target.value })} className={inputClass} /></label>
              <label><span className={labelClass}>Quem conferiu</span><input value={form.conferido_por_nome} onChange={(event) => setForm({ ...form, conferido_por_nome: event.target.value })} className={inputClass} /></label>
              <label><span className={labelClass}>Método de entrada</span><input readOnly value={form.metodo_importacao} className={`${inputClass} opacity-70`} /></label>
              <label><span className={labelClass}>Arquivo de origem</span><input readOnly value={form.arquivo_nome} className={`${inputClass} opacity-70`} /></label>
              <label className="flex items-end gap-2 pb-3"><input type="checkbox" checked={form.is_foc} onChange={(event) => setForm({ ...form, is_foc: event.target.checked })} /><span className="font-black text-sm text-slate-700 dark:text-slate-200">Recebimento FOC</span></label>
            </div>
            <label><span className={labelClass}>Observação geral do recibo</span><textarea value={form.observacao} onChange={(event) => setForm({ ...form, observacao: event.target.value })} className={`${inputClass} min-h-20`} /></label>

            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <h4 className="font-black uppercase text-slate-900 dark:text-white">Tabela editável dos itens</h4>
                <button type="button" onClick={addItem} className="px-4 py-2 rounded-xl bg-slate-900 text-white font-black text-xs flex items-center gap-2"><Plus size={15} /> Inserir item</button>
              </div>
              <div className="overflow-auto rounded-2xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900">
                <table className="min-w-[3850px] w-full text-xs">
                  <thead className="sticky top-0 bg-slate-100 dark:bg-slate-800 z-10 text-[9px] uppercase text-slate-600 dark:text-slate-300">
                    <tr><th className="p-2 text-left">#</th><th className="p-2 text-left">PN *</th><th className="p-2 text-left">NSN/PI</th><th className="p-2 text-left">Nomenclatura</th><th className="p-2 text-left">Qtd recebida *</th><th className="p-2 text-left">Qtd já incorporada</th><th className="p-2 text-left">Saldo temporário</th><th className="p-2 text-left">SN(s)</th><th className="p-2 text-left">Tipo</th><th className="p-2 text-left">Local temporário</th><th className="p-2 text-left">Destino previsto</th><th className="p-2 text-left">Contabilizar pelo recibo</th><th className="p-2 text-left">Incorporado em</th><th className="p-2 text-left">Validade/status</th><th className="p-2 text-left">Condição</th><th className="p-2 text-left">PD/Documento</th><th className="p-2 text-left">Delivery Note</th><th className="p-2 text-left">Invoice</th><th className="p-2 text-left">DI</th><th className="p-2 text-left">Batch</th><th className="p-2 text-left">CoC</th><th className="p-2 text-left">Status do documento</th><th className="p-2 text-left">Garantia</th><th className="p-2 text-left">Moeda</th><th className="p-2 text-left">Valor unitário</th><th className="p-2 text-left">Total no documento</th><th className="p-2 text-left">Observações do item</th><th className="p-2"></th></tr>
                  </thead>
                  <tbody>
                    {receiptDisplayRows(form.itens).map(({ item, formIndex, displaySequence, displayDocumentOrigin }) => (
                      <tr key={item.id || `new-${formIndex}`} className="border-t border-slate-200 dark:border-slate-800 align-top">
                        <td className="p-2">{displayDocumentOrigin ? <span className={`${inputClass} inline-flex w-16 items-center justify-center font-black bg-slate-50 dark:bg-slate-800`} title={`Item ${displayDocumentOrigin} do documento original`}>{displaySequence}</span> : <input type="number" min="1" value={item.sequencia_item || formIndex + 1} onChange={(event) => updateItem(formIndex, 'sequencia_item', event.target.value)} className={`${inputClass} w-16`} />}</td>
                        <td className="p-2"><input required value={item.pn} onChange={(event) => updateItem(formIndex, 'pn', event.target.value.toUpperCase())} className={`${inputClass} w-40`} /></td>
                        <td className="p-2"><input value={item.nsn_pi} onChange={(event) => updateItem(formIndex, 'nsn_pi', event.target.value)} className={`${inputClass} w-36`} /></td>
                        <td className="p-2"><input value={item.nomenclatura} onChange={(event) => updateItem(formIndex, 'nomenclatura', event.target.value)} className={`${inputClass} w-72`} /></td>
                        <td className="p-2"><input type="number" min="0.01" step="0.01" required value={item.quantidade} onChange={(event) => updateItem(formIndex, 'quantidade', event.target.value)} className={`${inputClass} w-28`} /></td>
                        <td className="p-2"><input type="number" min="0" max={Number(item.quantidade || 0)} step="0.01" value={item.quantidade_inventariada} onChange={(event) => updateItem(formIndex, 'quantidade_inventariada', event.target.value)} className={`${inputClass} w-28`} /></td>
                        <td className="p-2"><span className="inline-block px-3 py-2 rounded-xl bg-emerald-100 text-emerald-800 font-black">{formatNumber(pendingQuantity(item))}</span></td>
                        <td className="p-2"><input value={item.sn} onChange={(event) => updateItem(formIndex, 'sn', event.target.value.toUpperCase())} placeholder="Um ou vários separados por vírgula" className={`${inputClass} w-56`} /></td>
                        <td className="p-2"><span className={`inline-block px-3 py-2 rounded-xl font-black ${realSerial(item.sn) ? 'bg-purple-100 text-purple-700' : 'bg-slate-100 text-slate-700'}`}>{realSerial(item.sn) ? 'EQUIPAMENTO' : 'SOBRESSALENTE'}</span></td>
                        <td className="p-2"><input value={item.localizacao_ppu} onChange={(event) => updateItem(formIndex, 'localizacao_ppu', event.target.value)} placeholder="Ex.: Hangar / Caixa 64 / ALFA-10" className={`${inputClass} w-52`} /></td>
                        <td className="p-2"><select value={item.destino_previsto || ''} onChange={(event) => updateItem(formIndex, 'destino_previsto', event.target.value)} className={`${inputClass} w-44`}><option value="">Não inferido</option><option value="PPU">PPU</option><option value="CEIMSPA">CEIMSPA</option></select><p className="mt-1 text-[9px] font-bold text-slate-500">{item.destino_previsto_fonte || '—'}</p></td>
                        <td className="p-2"><label className="flex items-center gap-2 w-72 rounded-xl border-2 border-slate-200 dark:border-slate-700 p-3 font-black"><input type="checkbox" checked={item.contabiliza_pelo_recibo !== false} onChange={(event) => setCountByReceipt(formIndex, event.target.checked)} /><span>{item.contabiliza_pelo_recibo !== false ? `SIM — ${formatNumber(pendingQuantity(item))} un no Recibo/local temporário` : 'NÃO — já incorporado ao estoque oficial'}</span></label></td>
                        <td className="p-2"><select required={item.contabiliza_pelo_recibo === false || Number(item.quantidade_inventariada || 0) > 0} disabled={item.contabiliza_pelo_recibo !== false && Number(item.quantidade_inventariada || 0) <= 0} value={item.destino_estoque || ''} onChange={(event) => updateItem(formIndex, 'destino_estoque', event.target.value)} className={`${inputClass} w-40 disabled:opacity-50`}><option value="">Selecione</option><option value="PPU">PPU</option><option value="CEIMSPA">CEIMSPA</option></select></td>
                        <td className="p-2"><select value={item.validade_status || 'NAO_INFORMADA'} onChange={(event) => updateItem(formIndex, 'validade_status', event.target.value)} className={`${inputClass} w-52`}><option value="NAO_INFORMADA">Não informada</option><option value="OK">OK / pronto uso</option><option value="PROXIMO_VENCIMENTO">Próximo do vencimento</option><option value="VENCIDO">Vencido</option><option value="SEM_ESTOQUE">Sem estoque</option><option value="REVISAR">Revisar</option></select></td>
                        <td className="p-2"><select value={item.condicao_item} onChange={(event) => updateItem(formIndex, 'condicao_item', event.target.value)} className={`${inputClass} w-52`}>{conditionOptions.map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></td>
                        <td className="p-2"><input value={item.documento_referencia} onChange={(event) => updateItem(formIndex, 'documento_referencia', event.target.value)} className={`${inputClass} w-44`} /></td>
                        <td className="p-2"><input value={item.delivery_note} onChange={(event) => updateItem(formIndex, 'delivery_note', event.target.value)} className={`${inputClass} w-36`} /></td>
                        <td className="p-2"><input value={item.invoice_no} onChange={(event) => updateItem(formIndex, 'invoice_no', event.target.value)} className={`${inputClass} w-36`} /></td>
                        <td className="p-2"><input value={item.di} onChange={(event) => updateItem(formIndex, 'di', event.target.value)} className={`${inputClass} w-36`} /></td>
                        <td className="p-2"><input value={item.batch_no} onChange={(event) => updateItem(formIndex, 'batch_no', event.target.value)} className={`${inputClass} w-36`} /></td>
                        <td className="p-2"><input value={item.coc_no} onChange={(event) => updateItem(formIndex, 'coc_no', event.target.value)} className={`${inputClass} w-36`} /></td>
                        <td className="p-2"><input value={item.status_documento} onChange={(event) => updateItem(formIndex, 'status_documento', event.target.value)} className={`${inputClass} w-44`} /></td>
                        <td className="p-2"><input type="date" value={item.data_garantia} onChange={(event) => updateItem(formIndex, 'data_garantia', event.target.value)} className={`${inputClass} w-40`} /></td>
                        <td className="p-2"><input value={item.moeda} onChange={(event) => updateItem(formIndex, 'moeda', event.target.value.toUpperCase())} placeholder="GBP" className={`${inputClass} w-24`} /></td>
                        <td className="p-2"><input type="number" min="0" step="0.000001" value={item.valor_unitario} onChange={(event) => updateItem(formIndex, 'valor_unitario', event.target.value)} className={`${inputClass} w-32`} /></td>
                        <td className="p-2"><input type="number" min="0" step="0.01" value={item.valor_total_documento} onChange={(event) => updateItem(formIndex, 'valor_total_documento', event.target.value)} className={`${inputClass} w-36`} /></td>
                        <td className="p-2"><textarea value={item.observacao_item} onChange={(event) => updateItem(formIndex, 'observacao_item', event.target.value)} placeholder="Faltante, defeito, avaria, divergência..." className={`${inputClass} w-72 min-h-12`} /></td>
                        <td className="p-2"><button type="button" onClick={() => removeItem(formIndex)} className="p-3 rounded-xl bg-red-100 text-red-700"><Trash2 size={17} /></button></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="text-xs font-bold text-slate-500">“Destino previsto” registra para onde o documento indica que o material segue (PD 71200/recebedor CEIMSPA, por exemplo); ele não é incorporação oficial. Selecione “Incorporado em” PPU ou CEIMSPA somente quando alguma quantidade já tiver efetivamente entrado no estoque oficial. Enquanto “Contabilizar pelo recibo” estiver marcado, o saldo permanece no recibo/local temporário e aparece assim no Radar. Ao desmarcar, toda a linha deixa de somar pelo recibo, mas continua rastreável. Quando houver vários SNs separados por vírgula, o backend criará uma linha controlada para cada equipamento. Para incorporação parcial de equipamentos, separe os SNs em linhas distintas. Campos ausentes no recibo permanecem vazios para preenchimento pelo Admin ou Dono.</p>
            </div>

            <div className="sticky bottom-0 bg-slate-50 dark:bg-slate-950 border-t border-slate-200 dark:border-slate-700 py-3 flex justify-end gap-3">
              <button type="button" onClick={() => { setEditor(null); setForm(null); }} className="px-6 py-3 rounded-xl bg-slate-200 text-slate-900 font-black">Cancelar</button>
              <button disabled={saving} type="submit" className="px-6 py-3 rounded-xl bg-blue-600 disabled:opacity-50 text-white font-black flex items-center gap-2"><Save size={17} /> {saving ? 'Salvando...' : 'Salvar recibo'}</button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
