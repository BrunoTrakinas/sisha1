import React, { useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  BadgeDollarSign,
  Boxes,
  CheckCircle2,
  ChevronRight,
  Clock3,
  FileText,
  LoaderCircle,
  MessageSquare,
  RefreshCw,
  RotateCcw,
  Search,
  ShieldCheck,
  Trash2,
  Upload,
  X,
  XCircle,
} from 'lucide-react';
import { apiFetch, buildAuthHeaders } from '../lib/api';

const safeArray = (value) => Array.isArray(value) ? value : [];
const safeObject = (value) => value && typeof value === 'object' && !Array.isArray(value) ? value : {};

const sourceMeta = {
  CHAT_DOCUMENT: { label: 'Documento do Chat Lince', icon: FileText, tone: 'blue' },
  HELPDESK: { label: 'Help Desk', icon: MessageSquare, tone: 'violet' },
  EQUIPMENT_CONFLICT: { label: 'Conflito PN + SN', icon: Boxes, tone: 'amber' },
  PPU_CUSTODY: { label: 'Custódia externa PPU', icon: ShieldCheck, tone: 'orange' },
  RECEIPT_JOB: { label: 'Recibos em revisão', icon: FileText, tone: 'emerald' },
  RFQ_JOB: { label: 'Cotação / RFQ em revisão', icon: BadgeDollarSign, tone: 'cyan' },
  PD_ORDERBOOK_GAP: { label: 'PD do Order Book sem origem', icon: AlertTriangle, tone: 'amber' },
};

const toneClasses = {
  blue: 'bg-blue-50 text-blue-700 border-blue-200 dark:bg-blue-950/30 dark:text-blue-300 dark:border-blue-900',
  violet: 'bg-violet-50 text-violet-700 border-violet-200 dark:bg-violet-950/30 dark:text-violet-300 dark:border-violet-900',
  amber: 'bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-950/30 dark:text-amber-300 dark:border-amber-900',
  orange: 'bg-orange-50 text-orange-700 border-orange-200 dark:bg-orange-950/30 dark:text-orange-300 dark:border-orange-900',
  emerald: 'bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-950/30 dark:text-emerald-300 dark:border-emerald-900',
  cyan: 'bg-cyan-50 text-cyan-700 border-cyan-200 dark:bg-cyan-950/30 dark:text-cyan-300 dark:border-cyan-900',
};

const rfqDocumentTypeLabels = {
  LEONARDO_QUOTATION: 'Leonardo Quotation',
  LEONARDO_PRICE_LETTER: 'Carta Leonardo — preço/venda',
  LEONARDO_REPAIR_PRICE_LETTER: 'Carta Leonardo — Repair / Overhaul',
  GENERIC_COMMERCIAL_DOCUMENT: 'Documento comercial genérico',
};
const rfqTypeOptions = ['MATERIAL', 'REPARO', 'OVERHAUL', 'SERVICO', 'OUTRO'];
const rfqPriceStatusOptions = ['PRICED', 'AWAITING_PRICE', 'UNDER_INVESTIGATION', 'UNPRICED'];

function rfqQualityRank(value) {
  const status = String(value || '').toUpperCase();
  if (['READY', 'OK', 'REVIEW'].includes(status)) return 3;
  if (status === 'BLOCKED') return 1;
  return 2;
}

function rfqPendingRank(row = {}) {
  if (String(row.quality_status || '').toUpperCase() === 'DISCARDED') return -1000;
  const status = String(row.status || '').toUpperCase();
  const statusRank = status === 'PROCESSING' ? 50 : status === 'QUEUED' ? 45 : status === 'REVIEW_READY' ? 40 : 0;
  const currentReaderBoost = row.analysis_current === true ? 100 : 0;
  return currentReaderBoost + statusRank + rfqQualityRank(row.quality_status);
}

function pickRelevantRfqJobs(rows) {
  const groupedByFile = new Map();

  safeArray(rows).forEach((row) => {
    const identity = row.file_sha256 || `JOB:${row.id}`;
    const group = groupedByFile.get(identity) || [];
    group.push(row);
    groupedByFile.set(identity, group);
  });

  const picked = [];

  groupedByFile.forEach((group) => {
    // C3.4 HF1: se qualquer processamento deste mesmo arquivo ja foi gravado,
    // jobs historicos/legados do mesmo SHA-256 nao podem ressuscitar na Central.
    const documentResolved = group.some((row) => (
      String(row.status || '').toUpperCase() === 'SAVED'
      || row.resolved_by_persisted_quote === true
      || row.resolved_by_same_document === true
    ));
    if (documentResolved) return;

    let best = null;
    group
      .filter((row) => ['REVIEW_READY', 'PROCESSING', 'QUEUED'].includes(String(row.status || '').toUpperCase()))
      .filter((row) => String(row.quality_status || '').toUpperCase() !== 'DISCARDED')
      .forEach((row) => {
        if (!best) {
          best = row;
          return;
        }
        const currentRank = rfqPendingRank(best);
        const nextRank = rfqPendingRank(row);
        const currentTime = new Date(best.updated_at || best.completed_at || best.created_at || 0).getTime();
        const nextTime = new Date(row.updated_at || row.completed_at || row.created_at || 0).getTime();
        if (nextRank > currentRank || (nextRank === currentRank && nextTime > currentTime)) best = row;
      });

    if (best) picked.push(best);
  });

  return picked;
}

function receiptPendingActionCount(job = {}) {
  const explicit = Number(job.pending_action_items);
  if (Number.isFinite(explicit)) return Math.max(0, explicit);
  return ['ready_items', 'review_items', 'conflict_items', 'error_items']
    .reduce((sum, field) => sum + Math.max(0, Number(job[field] || 0)), 0);
}

function isReceiptItemPending(item = {}) {
  return ['READY', 'REVIEW', 'CONFLICT', 'ERROR'].includes(String(item.effective_status || item.status || '').toUpperCase());
}

function formatDate(value) {
  if (!value) return 'Sem data';
  const dt = new Date(value);
  return Number.isNaN(dt.getTime()) ? String(value) : dt.toLocaleString('pt-BR');
}

function stringify(value) {
  return JSON.stringify(value ?? null, null, 2);
}

function compactText(value, max = 180) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (!text) return '';
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

function humanLocation(state = {}) {
  const local = String(state?.local_atual || state?.local_destino || '').trim();
  const anv = String(state?.anv_atual || state?.anv_destino || '').trim();
  const categoria = String(state?.categoria_local_atual || state?.categoria_destino || '').trim();
  if (local) return local;
  if (anv) return `Aeronave ${anv}`;
  if (categoria && categoria !== 'DESCONHECIDO') return categoria.replaceAll('_', ' ');
  return 'Local não informado';
}

function humanSource(source = {}) {
  return source?.documento || source?.arquivo || source?.source_type || 'Fonte não identificada';
}

function evidenceStrength(value) {
  const normalized = String(value || '').toUpperCase();
  if (['ALTA', 'CONFIRMADA', 'HIGH'].includes(normalized)) return 'Forte';
  if (['MEDIA', 'MÉDIA', 'MEDIUM'].includes(normalized)) return 'Moderada';
  if (['BAIXA', 'LOW'].includes(normalized)) return 'Fraca';
  if (normalized === 'CONFLITANTE') return 'Conflitante';
  return 'Não classificada';
}

function TechnicalDetails({ title = 'Ver evidências completas', children }) {
  return (
    <details className="group rounded-2xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900">
      <summary className="cursor-pointer list-none px-4 py-3 text-xs font-black uppercase tracking-wide text-slate-600 dark:text-slate-300">{title}</summary>
      <div className="border-t border-slate-200 dark:border-slate-700 p-4">{children}</div>
    </details>
  );
}

function DecisionIntro({ title, children }) {
  return (
    <div className="rounded-2xl border-2 border-blue-100 dark:border-blue-900 bg-blue-50/60 dark:bg-blue-950/20 p-5">
      <p className="text-[10px] font-black uppercase tracking-[0.18em] text-blue-600 dark:text-blue-300">O que precisa ser decidido?</p>
      <h4 className="mt-2 text-lg font-black text-slate-900 dark:text-white">{title}</h4>
      <div className="mt-2 text-sm font-semibold leading-relaxed text-slate-600 dark:text-slate-300">{children}</div>
    </div>
  );
}

function parseJsonField(value, label, expected) {
  try {
    const parsed = JSON.parse(value || (expected === 'array' ? '[]' : '{}'));
    if (expected === 'array' && !Array.isArray(parsed)) throw new Error(`${label} deve ser uma lista JSON.`);
    if (expected === 'object' && (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))) throw new Error(`${label} deve ser um objeto JSON.`);
    return parsed;
  } catch (error) {
    throw new Error(error.message || `${label} contém JSON inválido.`);
  }
}

function EvidenceBlock({ title, children }) {
  return (
    <div className="rounded-2xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950/40 p-4">
      <p className="mb-2 text-[10px] font-black uppercase tracking-[0.18em] text-slate-400">{title}</p>
      {children}
    </div>
  );
}

function JsonEvidence({ title, value }) {
  return (
    <EvidenceBlock title={title}>
      <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words text-xs font-semibold leading-relaxed text-slate-700 dark:text-slate-200">{stringify(value)}</pre>
    </EvidenceBlock>
  );
}

function PendingCard({ item, onOpen }) {
  const meta = sourceMeta[item.type] || sourceMeta.CHAT_DOCUMENT;
  const Icon = meta.icon;
  return (
    <button
      type="button"
      onClick={() => onOpen(item)}
      className="w-full rounded-2xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 p-4 text-left transition hover:border-blue-300 dark:hover:border-blue-700 hover:shadow-sm"
    >
      <div className="flex items-start gap-3">
        <div className={`rounded-xl border p-2 ${toneClasses[meta.tone] || toneClasses.blue}`}><Icon size={18} /></div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[10px] font-black uppercase tracking-[0.14em] text-slate-400">{meta.label}</span>
            {item.badge && <span className="rounded-full bg-slate-100 dark:bg-slate-800 px-2 py-0.5 text-[10px] font-black text-slate-600 dark:text-slate-300">{item.badge}</span>}
          </div>
          <h4 className="mt-1 truncate text-sm font-black text-slate-900 dark:text-white">{item.title}</h4>
          <p className="mt-1 line-clamp-2 text-xs font-semibold text-slate-500 dark:text-slate-400">{item.subtitle || 'Revisão humana necessária.'}</p>
          <div className="mt-2 flex items-center gap-1 text-[10px] font-bold uppercase tracking-wide text-slate-400">
            <Clock3 size={12} /> {formatDate(item.createdAt)}
          </div>
        </div>
        <ChevronRight size={18} className="mt-2 shrink-0 text-slate-400" />
      </div>
    </button>
  );
}

export default function PendingCenterModal({ open, onClose, token, onOpenReceipts, onOpenPurchases }) {
  const [loading, setLoading] = useState(false);
  const [items, setItems] = useState([]);
  const [errors, setErrors] = useState([]);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState('ALL');
  const [selected, setSelected] = useState(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detail, setDetail] = useState(null);
  const [actionLoading, setActionLoading] = useState(false);
  const [actionMsg, setActionMsg] = useState(null);
  const [reason, setReason] = useState('');
  const [helpdeskAnswer, setHelpdeskAnswer] = useState('');
  const [destination, setDestination] = useState('');
  const [correctSummary, setCorrectSummary] = useState('');
  const [correctClassification, setCorrectClassification] = useState('');
  const [correctEntities, setCorrectEntities] = useState('{}');
  const [correctRecords, setCorrectRecords] = useState('[]');
  const [correctionOpen, setCorrectionOpen] = useState(false);
  const [rfqReview, setRfqReview] = useState(null);
  const [rfqDiscardOpen, setRfqDiscardOpen] = useState(false);
  const [rfqDiscardReason, setRfqDiscardReason] = useState('');

  const fetchData = async (path) => {
    const response = await apiFetch(path, {}, token);
    const json = await response.json();
    if (!response.ok || json.status !== 'success') throw new Error(json.message || `Falha ao carregar ${path}.`);
    return json.data;
  };

  const reload = async () => {
    if (!open || !token) return;
    setLoading(true);
    setErrors([]);
    try {
      const sources = [
        ['CHAT_DOCUMENT', '/chat-lince/documentos?status=PENDENTE_CONFIRMACAO'],
        ['HELPDESK', '/chat-lince/helpdesk?status=ABERTO&limit=100'],
        ['EQUIPMENT_CONFLICT', '/equipments/location-conflicts?limit=250'],
        ['PPU_CUSTODY', '/import/custodia-externa-ppu/reconciliacao'],
        ['RECEIPT_JOB', '/receipts/batch/jobs?limit=30'],
        ['RFQ_JOB', '/import/rfq/jobs?limit=50'],
        ['PD_ORDERBOOK_GAP', '/purchases/pds/orderbook-gaps'],
      ];
      const settled = await Promise.allSettled(sources.map(([, path]) => fetchData(path)));
      const next = [];
      const nextErrors = [];

      settled.forEach((result, index) => {
        const [type] = sources[index];
        if (result.status === 'rejected') {
          nextErrors.push(`${sourceMeta[type]?.label || type}: ${result.reason?.message || 'indisponível'}`);
          return;
        }
        const data = result.value;
        if (type === 'CHAT_DOCUMENT') {
          safeArray(data).forEach((row) => {
            const receiptOwned = row.central_domain === 'RECEIPT';
            next.push({
              type,
              key: `${type}:${row.id}`,
              id: row.id,
              title: row.nome_arquivo || row.classificacao || 'Documento sem nome',
              subtitle: receiptOwned
                ? `Recibo ${row.central_receipt_number || 'sem número confirmado'} ainda precisa ser tratado no módulo de Recibos; não corrija classificação genérica aqui.`
                : (row.resumo || `Destino sugerido: ${row.destino_sugerido || 'a confirmar'}`),
              badge: receiptOwned ? 'RECIBO • MÓDULO PRÓPRIO' : (row.classificacao || 'DOCUMENTO'),
              createdAt: row.created_at,
              raw: row,
            });
          });
        } else if (type === 'HELPDESK') {
          safeArray(data).forEach((row) => next.push({
            type,
            key: `${type}:${row.id}`,
            id: row.id,
            title: row.termo_pesquisado || row.protocolo || 'Dúvida do Chat Lince',
            subtitle: row.pergunta_original || 'Pergunta aguardando resposta humana.',
            badge: row.protocolo || 'ABERTO',
            createdAt: row.created_at,
            raw: row,
          }));
        } else if (type === 'EQUIPMENT_CONFLICT') {
          safeArray(data).forEach((row) => next.push({
            type,
            key: `${type}:${row.id}`,
            id: row.id,
            equipmentId: row.equipamento_id,
            title: `Conflito de localização • ${row.equipamento?.pn || 'PN ?'} / SN ${row.equipamento?.sn || '?'}`,
            subtitle: `${humanLocation(row.estado_atual)} ↔ ${humanLocation(row.estado_candidato)}`,
            badge: 'LOCALIZAÇÃO',
            createdAt: row.data_evento || row.created_at,
            raw: row,
          }));
        } else if (type === 'PPU_CUSTODY') {
          const active = data?.active || null;
          safeArray(data?.rows).filter((row) => row.status === 'DIVERGENCIA' || Number(row.blocked_qty || 0) > 0).forEach((row) => next.push({
            type,
            key: `${type}:${row.group_key}`,
            id: row.group_key,
            importId: active?.id,
            title: `Divergência de custódia • ${row.pn || 'PN ?'}`,
            subtitle: `${Number(row.blocked_qty || 0).toLocaleString('pt-BR')} un a confirmar • ${row.original_location || 'origem não informada'} → ${row.box_code || 'caixa não informada'}`,
            badge: 'DIVERGÊNCIA',
            createdAt: active?.imported_at || row.evidence_at,
            raw: row,
          }));
        } else if (type === 'RECEIPT_JOB') {
          safeArray(data)
            .filter((row) => ['REVIEW_READY'].includes(String(row.status || '').toUpperCase()))
            .filter((row) => row.resolved !== true && receiptPendingActionCount(row) > 0)
            .forEach((row) => next.push({
              type,
              key: `${type}:${row.id}`,
              id: row.id,
              title: row.archive_name || row.file_name || `Lote ${String(row.id).slice(0, 8)}`,
              subtitle: `${receiptPendingActionCount(row)} documento(s) ainda exigem ação • os já gravados não voltam para revisão`,
              badge: row.status,
              createdAt: row.created_at,
              raw: row,
            }));
        } else if (type === 'PD_ORDERBOOK_GAP') {
          safeArray(data).forEach((row) => next.push({
            type,
            key: `${type}:${row.numero_pd}`,
            id: row.numero_pd,
            title: row.numero_pd || 'PD não cadastrado',
            subtitle: `Aparece no Order Book${safeArray(row.pns).length ? ` • PN ${safeArray(row.pns).join(', ')}` : ''}, mas não nasceu no SISHA por PD/ODC.`,
            badge: 'ORIGEM DO PD AUSENTE',
            createdAt: null,
            raw: row,
          }));
        } else if (type === 'RFQ_JOB') {
          pickRelevantRfqJobs(data).forEach((row) => {
            const jobStatus = String(row.status || '').toUpperCase();
            const legacy = row.legacy_analysis === true || row.analysis_current === false;
            const processing = ['QUEUED', 'PROCESSING'].includes(jobStatus);
            next.push({
              type,
              key: `${type}:${row.id}`,
              id: row.id,
              title: row.file_name || row.quotation_number || 'Cotação / RFQ',
              subtitle: processing
                ? `Reprocessamento com leitor atual • ${jobStatus === 'QUEUED' ? 'aguardando processamento' : 'processando agora'}`
                : legacy
                  ? `${rfqDocumentTypeLabels[row.document_type] || row.document_type || 'Documento comercial'} • análise antiga; reprocessamento recomendado`
                  : `${rfqDocumentTypeLabels[row.document_type] || row.document_type || 'Documento comercial'} • ${row.quality_status || 'REVIEW'}`,
              badge: processing ? 'REPROCESSANDO' : legacy ? 'ANÁLISE LEGADA' : (row.quality_status || row.status),
              createdAt: row.updated_at || row.completed_at || row.created_at,
              raw: row,
            });
          });
        }
      });

      next.sort((a, b) => new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime());
      setItems(next);
      setErrors(nextErrors);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (open) reload();
    else {
      setSelected(null);
      setDetail(null);
      setActionMsg(null);
      setQuery('');
      setFilter('ALL');
      setRfqReview(null);
      setRfqDiscardOpen(false);
      setRfqDiscardReason('');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, token]);

  const counts = useMemo(() => items.reduce((acc, item) => {
    acc.ALL += 1;
    acc[item.type] = (acc[item.type] || 0) + 1;
    return acc;
  }, { ALL: 0 }), [items]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return items.filter((item) => {
      if (filter !== 'ALL' && item.type !== filter) return false;
      if (!q) return true;
      return `${item.title} ${item.subtitle} ${item.badge}`.toLowerCase().includes(q);
    });
  }, [items, filter, query]);

  const openItem = async (item) => {
    setSelected(item);
    setActionMsg(null);
    setReason('');
    setHelpdeskAnswer('');
    setCorrectionOpen(false);
    setRfqReview(null);
    setRfqDiscardOpen(false);
    setRfqDiscardReason(item.type === 'RFQ_JOB' && (item.raw?.legacy_analysis === true || item.raw?.analysis_current === false)
      ? 'Leitura legada incorreta; reprocessamento com o leitor atual recomendado.'
      : '');
    setDetail(item.raw || null);
    setDetailLoading(false);

    if (item.type === 'CHAT_DOCUMENT') {
      setDetailLoading(true);
      try {
        const data = await fetchData(`/chat-lince/documentos/${item.id}`);
        setDetail(data);
        setDestination(data.destino_sugerido || safeArray(data.destinos_possiveis)[0]?.tabela || '');
        setCorrectSummary(data.resumo || '');
        setCorrectClassification(data.classificacao || '');
        setCorrectEntities(stringify(safeObject(data.entidades)));
        setCorrectRecords(stringify(safeArray(data.registros_sugeridos)));
      } catch (error) {
        setActionMsg({ type: 'error', text: error.message });
      } finally {
        setDetailLoading(false);
      }
    } else if (item.type === 'RECEIPT_JOB') {
      setDetailLoading(true);
      try { setDetail(await fetchData(`/receipts/batch/jobs/${item.id}`)); }
      catch (error) { setActionMsg({ type: 'error', text: error.message }); }
      finally { setDetailLoading(false); }
    } else if (item.type === 'RFQ_JOB') {
      setDetailLoading(true);
      try {
        const data = await fetchData(`/import/rfq/jobs/${item.id}`);
        setDetail(data);
        const payload = data?.result_payload;
        if (payload && Array.isArray(payload.items)) {
          setRfqReview({
            metadados: {
              ...(payload.metadados || {}),
              origem_registro: 'IMPORTADO',
              tipo_cotacao: payload.metadados?.tipo_cotacao || 'MATERIAL',
              import_job_id: data.id,
              import_job_status: data.status || 'REVIEW_READY',
            },
            items: payload.items.map((row) => ({ ...row })),
          });
        }
      }
      catch (error) { setActionMsg({ type: 'error', text: error.message }); }
      finally { setDetailLoading(false); }
    }
  };

  const postJson = async (path, body) => {
    const response = await apiFetch(path, {
      method: 'POST',
      headers: buildAuthHeaders(token, { 'Content-Type': 'application/json' }),
      body: JSON.stringify(body || {}),
    }, token);
    const json = await response.json();
    if (!response.ok || json.status !== 'success') throw new Error(json.message || 'Operação não concluída.');
    return json;
  };

  const completeAction = async (fn) => {
    if (actionLoading) return;
    setActionLoading(true);
    setActionMsg(null);
    try {
      const message = await fn();
      setActionMsg({ type: 'success', text: message || 'Pendência resolvida.' });
      setSelected(null);
      setDetail(null);
      await reload();
    } catch (error) {
      setActionMsg({ type: 'error', text: error.message || 'Falha ao tratar pendência.' });
    } finally {
      setActionLoading(false);
    }
  };

  const approveDocument = (corrected = false) => completeAction(async () => {
    const doc = detail || {};
    const body = { destinoAdmin: corrected ? destination : (doc.destino_sugerido || destination), observacaoAdmin: corrected ? reason.trim() : '' };
    if (corrected) {
      if (!reason.trim()) throw new Error('Informe o motivo da correção administrativa.');
      body.correcoesAdmin = {
        resumo: correctSummary.trim(),
        classificacao: correctClassification.trim(),
        entidades: parseJsonField(correctEntities, 'Entidades', 'object'),
        registros_sugeridos: parseJsonField(correctRecords, 'Registros sugeridos', 'array'),
      };
    }
    const result = await postJson(`/chat-lince/documentos/${selected.id}/confirmar`, body);
    return result.message;
  });

  const rejectDocument = () => completeAction(async () => {
    if (!reason.trim()) throw new Error('Informe o motivo da rejeição.');
    const result = await postJson(`/chat-lince/documentos/${selected.id}/rejeitar`, { observacaoAdmin: reason.trim() });
    return result.message;
  });

  const resolveHelpdesk = () => completeAction(async () => {
    if (!helpdeskAnswer.trim()) throw new Error('Informe a resposta do PPU/Admin.');
    const result = await postJson(`/chat-lince/helpdesk/${selected.id}/responder`, { respostaAdmin: helpdeskAnswer.trim(), responderPeloChat: true });
    return result.message;
  });

  const resolveEquipmentConflict = (decision) => completeAction(async () => {
    if (!reason.trim()) throw new Error('Informe o motivo da reconciliação.');
    const result = await postJson(`/equipments/${selected.equipmentId}/location-conflicts/${selected.id}/resolve`, { decision, motivo: reason.trim() });
    return result.message;
  });

  const resolveCustody = (decision) => completeAction(async () => {
    if (!reason.trim()) throw new Error('Informe o motivo da decisão.');
    const result = await postJson('/import/custodia-externa-ppu/reconciliacao', {
      import_id: selected.importId,
      group_key: selected.id,
      decision,
      reason: reason.trim(),
    });
    return result.message;
  });

  if (!open) return null;

  const changeRfqMeta = (field, value) => setRfqReview((current) => current ? ({ ...current, metadados: { ...current.metadados, [field]: value } }) : current);

  const changeRfqItem = (index, field, value) => setRfqReview((current) => current ? ({
    ...current,
    items: current.items.map((row, rowIndex) => rowIndex === index ? { ...row, [field]: value } : row),
  }) : current);

  const saveRfqReview = () => completeAction(async () => {
    if (!rfqReview) throw new Error('A análise comercial não possui dados editáveis.');
    if (String(rfqReview.metadados?.quality_status || detail?.quality_status || '').toUpperCase() === 'BLOCKED') {
      throw new Error('Este processamento está bloqueado pelo Fidelity Gate e não pode ser gravado.');
    }
    if (!safeArray(rfqReview.items).length) throw new Error('Não há itens confiáveis para aprovar e gravar.');

    const response = await apiFetch('/import/rfq/salvar', {
      method: 'POST',
      headers: buildAuthHeaders(token, { 'Content-Type': 'application/json' }),
      body: JSON.stringify(rfqReview),
    }, token);
    const result = await response.json();
    if (!response.ok || result.status !== 'success') throw new Error(result.message || 'Falha ao gravar documento comercial.');
    const warnings = safeArray(result.post_save_warnings).filter(Boolean);
    return [result.message || 'Documento comercial aprovado e gravado.', ...warnings].join(' ');
  });


  const reprocessRfqWithCurrentReader = () => completeAction(async () => {
    const result = await postJson(`/import/rfq/jobs/${selected.id}/reprocess`, {});
    return result.message || 'Reprocessamento iniciado com o leitor atual.';
  });

  const uploadRfqAgain = (file) => {
    if (!file) return;
    return completeAction(async () => {
      const formData = new FormData();
      formData.append('file', file);
      const response = await apiFetch('/import/rfq/jobs', {
        method: 'POST',
        headers: buildAuthHeaders(token),
        body: formData,
      }, token);
      const result = await response.json();
      if (!response.ok || result.status !== 'success') throw new Error(result.message || 'Falha ao subir novamente o documento comercial.');
      return result.message || 'Nova cópia recebida para análise.';
    });
  };

  const discardRfqFromPendingCenter = () => completeAction(async () => {
    if (!rfqDiscardReason.trim()) throw new Error('Informe o motivo da exclusão desta pendência.');
    const result = await postJson(`/import/rfq/jobs/${selected.id}/discard`, { motivo: rfqDiscardReason.trim() });
    return result.message || 'Pendência excluída da Central com histórico preservado.';
  });

  const filters = ['ALL', 'CHAT_DOCUMENT', 'HELPDESK', 'EQUIPMENT_CONFLICT', 'PPU_CUSTODY', 'RECEIPT_JOB', 'RFQ_JOB', 'PD_ORDERBOOK_GAP'];

  return (
    <div className="fixed inset-0 z-[90] bg-slate-950/75 backdrop-blur-sm p-2 sm:p-4 lg:p-6" onMouseDown={(e) => e.target === e.currentTarget && onClose?.()}>
      <div className="mx-auto flex h-full max-w-[1500px] flex-col overflow-hidden rounded-3xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 shadow-2xl">
        <div className="flex items-start justify-between gap-4 border-b border-slate-200 dark:border-slate-800 px-5 py-4 sm:px-7">
          <div>
            <div className="flex items-center gap-2">
              <AlertTriangle size={21} className="text-amber-500" />
              <h2 className="text-xl font-black uppercase text-slate-900 dark:text-white">Central de Pendências</h2>
            </div>
            <p className="mt-1 text-xs font-semibold text-slate-500 dark:text-slate-400">A Central agrega a revisão. Cada domínio continua dono da própria regra e da própria gravação.</p>
          </div>
          <div className="flex items-center gap-2">
            <button type="button" onClick={reload} disabled={loading} className="rounded-xl bg-slate-100 dark:bg-slate-800 p-3 text-slate-600 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-slate-700 disabled:opacity-50" title="Atualizar">
              <RefreshCw size={18} className={loading ? 'animate-spin' : ''} />
            </button>
            <button type="button" onClick={onClose} className="rounded-xl bg-slate-900 p-3 text-white hover:bg-slate-800" title="Fechar"><X size={18} /></button>
          </div>
        </div>

        <div className="grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-[470px_minmax(0,1fr)]">
          <aside className="min-h-0 border-b lg:border-b-0 lg:border-r border-slate-200 dark:border-slate-800 p-4 sm:p-5 flex flex-col">
            <div className="relative">
              <Search size={16} className="absolute left-3 top-3.5 text-slate-400" />
              <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Buscar PN, SN, arquivo, protocolo..." className="w-full rounded-xl border-2 border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 py-3 pl-10 pr-3 text-sm font-bold text-slate-900 dark:text-white" />
            </div>

            <div className="mt-3 flex flex-wrap gap-2 pb-2">
              {filters.map((key) => (
                <button key={key} type="button" onClick={() => setFilter(key)} className={`shrink-0 rounded-xl px-3 py-2 text-[10px] font-black uppercase ${filter === key ? 'bg-blue-600 text-white' : 'bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300'}`}>
                  {key === 'ALL' ? 'Todas' : sourceMeta[key]?.label} ({counts[key] || 0})
                </button>
              ))}
            </div>

            {errors.length > 0 && (
              <div className="mb-3 rounded-xl border border-amber-200 bg-amber-50 dark:bg-amber-950/30 p-3 text-xs font-bold text-amber-800 dark:text-amber-200">
                Algumas fontes não responderam: {errors.join(' • ')}
              </div>
            )}

            <div className="min-h-0 flex-1 space-y-2 overflow-y-auto pr-1">
              {loading && items.length === 0 ? (
                <div className="flex h-40 items-center justify-center gap-2 text-sm font-black text-slate-500"><LoaderCircle className="animate-spin" size={20} /> CARREGANDO...</div>
              ) : filtered.length > 0 ? filtered.map((item) => <PendingCard key={item.key} item={item} onOpen={openItem} />) : (
                <div className="rounded-2xl border border-dashed border-slate-300 dark:border-slate-700 p-8 text-center">
                  <CheckCircle2 size={28} className="mx-auto text-emerald-500" />
                  <p className="mt-2 text-sm font-black text-slate-700 dark:text-slate-200">Nenhuma pendência neste filtro.</p>
                </div>
              )}
            </div>
          </aside>

          <main className="min-h-0 overflow-y-auto p-4 sm:p-6 lg:p-7">
            {!selected ? (
              <div className="flex min-h-[420px] items-center justify-center">
                <div className="max-w-lg text-center">
                  <ShieldCheck size={42} className="mx-auto text-blue-600" />
                  <h3 className="mt-3 text-lg font-black text-slate-900 dark:text-white">Selecione uma pendência</h3>
                  <p className="mt-2 text-sm font-semibold leading-relaxed text-slate-500 dark:text-slate-400">O card mostra somente o resumo. A evidência original, interpretação do SISHA e decisão humana aparecem aqui, sem sobrescrever silenciosamente a fonte.</p>
                </div>
              </div>
            ) : detailLoading ? (
              <div className="flex min-h-[420px] items-center justify-center gap-2 font-black text-slate-500"><LoaderCircle className="animate-spin" size={22} /> ABRINDO EVIDÊNCIA...</div>
            ) : (
              <div className="space-y-5">
                <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                  <div>
                    <p className="text-[10px] font-black uppercase tracking-[0.18em] text-blue-600 dark:text-blue-400">{sourceMeta[selected.type]?.label}</p>
                    <h3 className="mt-1 text-xl font-black text-slate-900 dark:text-white">{selected.title}</h3>
                    <p className="mt-1 text-xs font-semibold text-slate-500">{formatDate(selected.createdAt)}</p>
                  </div>
                  <button type="button" onClick={() => { setSelected(null); setDetail(null); setActionMsg(null); }} className="self-start rounded-xl bg-slate-100 dark:bg-slate-800 px-4 py-2 text-xs font-black text-slate-600 dark:text-slate-300">VOLTAR À LISTA</button>
                </div>

                {actionMsg && <div className={`rounded-xl border p-3 text-sm font-black ${actionMsg.type === 'success' ? 'border-emerald-200 bg-emerald-50 text-emerald-700' : 'border-red-200 bg-red-50 text-red-700'}`}>{actionMsg.text}</div>}

                {selected.type === 'CHAT_DOCUMENT' && detail && (
                  <>
                    {detail.central_domain === 'RECEIPT' ? (
                      <>
                        <DecisionIntro title="Este arquivo é um Recibo. A decisão pertence ao módulo de Recibos.">
                          {detail.central_resolved ? (
                            <p>O SISHA encontrou este mesmo recibo já gravado na fonte operacional. Ele não deve exigir nova conferência nem nova classificação; atualize a Central para retirar a ocorrência antiga.</p>
                          ) : (
                            <p>O conteúdo foi reconhecido como <strong>Recibo de Entrega de Material</strong>. Não escolha ORDER_BOOK, OS ou outra tabela genérica aqui. Se ainda não estiver gravado, a revisão deve acontecer uma única vez no módulo de Recibos.</p>
                          )}
                          <p className="mt-2 text-xs font-bold text-slate-500">
                            Recibo: {detail.central_receipt_number || 'número não confirmado'} • destino correto: recebimentos
                          </p>
                        </DecisionIntro>

                        {(detail.classificacao_ia_original || detail.destino_ia_original) && (
                          <div className="rounded-2xl border border-amber-200 bg-amber-50 dark:bg-amber-950/20 dark:border-amber-900 p-4">
                            <p className="text-xs font-black uppercase tracking-wide text-amber-700 dark:text-amber-300">Por que aparecia confuso?</p>
                            <p className="mt-1 text-sm font-semibold text-slate-700 dark:text-slate-200">
                              Uma interpretação antiga do Chat Lince marcou este recibo como <strong>{detail.classificacao_ia_original || 'classificação genérica'}</strong>
                              {detail.destino_ia_original ? <> e sugeriu <strong>{detail.destino_ia_original}</strong></> : null}. Essa leitura não define mais a ação: palavras internas como Warranty, Leonardo, OS, S/N ou FOC não transformam um Recibo em Order Book ou OS.
                            </p>
                          </div>
                        )}

                        <TechnicalDetails title="Ver evidência original">
                          <pre className="max-h-80 overflow-auto whitespace-pre-wrap text-xs font-semibold leading-relaxed text-slate-700 dark:text-slate-200">{detail.texto_extraido || 'Texto original não disponível.'}</pre>
                        </TechnicalDetails>

                        <div className="rounded-2xl border border-slate-200 dark:border-slate-700 p-5">
                          <p className="text-sm font-black text-slate-900 dark:text-white">O que fazer agora?</p>
                          <p className="mt-1 text-xs font-semibold text-slate-500">
                            {detail.central_resolved
                              ? 'Nenhuma nova revisão é necessária. O recibo operacional já é a evidência canônica.'
                              : 'Revise/salve no módulo de Recibos. Depois de gravado, esta ocorrência deixa automaticamente a Central.'}
                          </p>
                          <div className="mt-4 flex justify-end gap-2">
                            {detail.central_resolved ? (
                              <button type="button" disabled={actionLoading} onClick={reload} className="rounded-xl bg-emerald-600 px-5 py-3 text-xs font-black text-white disabled:opacity-50"><RefreshCw size={16} className="inline mr-1" /> ATUALIZAR CENTRAL</button>
                            ) : (
                              <button type="button" onClick={() => { onClose?.(); onOpenReceipts?.(); }} className="rounded-xl bg-blue-600 px-5 py-3 text-xs font-black text-white">REVISAR NO MÓDULO DE RECIBOS</button>
                            )}
                          </div>
                        </div>

                        <TechnicalDetails title="Detalhes técnicos preservados">
                          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                            <EvidenceBlock title="Interpretação histórica"><p className="text-sm font-bold text-slate-700 dark:text-slate-200">{detail.classificacao_ia_original || detail.classificacao || 'não definida'} → {detail.destino_ia_original || detail.destino_sugerido || 'a confirmar'}</p></EvidenceBlock>
                            <EvidenceBlock title="Roteamento atual"><p className="text-sm font-bold text-emerald-700 dark:text-emerald-300">RECIBO_MATERIAL → recebimentos</p></EvidenceBlock>
                          </div>
                          <div className="mt-4 space-y-4"><JsonEvidence title="Entidades originais" value={detail.entidades} /><JsonEvidence title="Registros sugeridos originais" value={detail.registros_sugeridos} /></div>
                        </TechnicalDetails>
                      </>
                    ) : (
                      <>
                    <DecisionIntro title="O SISHA interpretou este documento e precisa da sua confirmação.">
                      <p>{detail.resumo || 'A interpretação automática foi concluída, mas exige revisão humana antes de qualquer gravação.'}</p>
                      <p className="mt-2 text-xs font-bold text-slate-500">Classificação: {detail.classificacao || 'não definida'} • destino sugerido: {detail.destino_sugerido || 'a confirmar'}</p>
                    </DecisionIntro>

                    <TechnicalDetails title="Ver evidência original">
                      <pre className="max-h-80 overflow-auto whitespace-pre-wrap text-xs font-semibold leading-relaxed text-slate-700 dark:text-slate-200">{detail.texto_extraido || 'Texto original não disponível.'}</pre>
                    </TechnicalDetails>

                    {!correctionOpen ? (
                      <div className="rounded-2xl border border-slate-200 dark:border-slate-700 p-5">
                        <p className="text-sm font-black text-slate-900 dark:text-white">O que deseja fazer?</p>
                        <p className="mt-1 text-xs font-semibold text-slate-500">Aprovar mantém a interpretação acima. Corrigir abre somente os campos necessários; os dados técnicos continuam preservados.</p>
                        <label className="mt-4 block text-xs font-black text-slate-600 dark:text-slate-300">Motivo da rejeição, se aplicável<textarea value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Obrigatório somente para rejeitar." className="mt-1 min-h-16 w-full rounded-xl border-2 border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 p-3 text-sm font-semibold text-slate-900 dark:text-white" /></label>
                        <div className="mt-4 flex flex-col sm:flex-row justify-end gap-2">
                          <button type="button" disabled={actionLoading} onClick={rejectDocument} className="rounded-xl bg-red-600 px-4 py-3 text-xs font-black text-white disabled:opacity-50"><XCircle size={16} className="inline mr-1" /> REJEITAR</button>
                          <button type="button" disabled={actionLoading} onClick={() => approveDocument(false)} className="rounded-xl bg-emerald-600 px-4 py-3 text-xs font-black text-white disabled:opacity-50"><CheckCircle2 size={16} className="inline mr-1" /> APROVAR INTERPRETAÇÃO</button>
                          <button type="button" disabled={actionLoading} onClick={() => setCorrectionOpen(true)} className="rounded-xl bg-blue-600 px-4 py-3 text-xs font-black text-white disabled:opacity-50"><ShieldCheck size={16} className="inline mr-1" /> CORRIGIR INTERPRETAÇÃO</button>
                        </div>
                      </div>
                    ) : (
                      <div className="rounded-2xl border-2 border-blue-100 dark:border-blue-900 bg-blue-50/50 dark:bg-blue-950/20 p-5 space-y-4">
                        <div>
                          <p className="text-xs font-black uppercase tracking-[0.16em] text-blue-700 dark:text-blue-300">Correção administrativa</p>
                          <p className="mt-1 text-xs font-semibold text-slate-500">A evidência original permanece intacta; altere apenas o que estiver incorreto.</p>
                        </div>
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                          <label className="text-xs font-black text-slate-600 dark:text-slate-300">Classificação confirmada<input value={correctClassification} onChange={(e) => setCorrectClassification(e.target.value)} className="mt-1 w-full rounded-xl border-2 border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 p-3 text-sm font-bold text-slate-900 dark:text-white" /></label>
                          <label className="text-xs font-black text-slate-600 dark:text-slate-300">Destino confirmado<select value={destination} onChange={(e) => setDestination(e.target.value)} className="mt-1 w-full rounded-xl border-2 border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 p-3 text-sm font-bold text-slate-900 dark:text-white">{safeArray(detail.destinos_possiveis).map((option) => <option key={option.tabela || option} value={option.tabela || option}>{option.tabela || option}</option>)}{!safeArray(detail.destinos_possiveis).length && <option value={destination}>{destination || 'cadastros_manuais'}</option>}</select></label>
                        </div>
                        <label className="block text-xs font-black text-slate-600 dark:text-slate-300">Resumo confirmado<textarea value={correctSummary} onChange={(e) => setCorrectSummary(e.target.value)} className="mt-1 min-h-24 w-full rounded-xl border-2 border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 p-3 text-sm font-semibold text-slate-900 dark:text-white" /></label>
                        <TechnicalDetails title="Ajustes técnicos avançados">
                          <div className="grid grid-cols-1 xl:grid-cols-2 gap-3">
                            <label className="text-xs font-black text-slate-600 dark:text-slate-300">Entidades confirmadas (JSON)<textarea value={correctEntities} onChange={(e) => setCorrectEntities(e.target.value)} className="mt-1 min-h-40 w-full rounded-xl border-2 border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 p-3 font-mono text-xs text-slate-900 dark:text-white" /></label>
                            <label className="text-xs font-black text-slate-600 dark:text-slate-300">Registros confirmados (JSON)<textarea value={correctRecords} onChange={(e) => setCorrectRecords(e.target.value)} className="mt-1 min-h-40 w-full rounded-xl border-2 border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 p-3 font-mono text-xs text-slate-900 dark:text-white" /></label>
                          </div>
                        </TechnicalDetails>
                        <label className="block text-xs font-black text-slate-600 dark:text-slate-300">Por que esta correção é necessária?<textarea value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Obrigatório para corrigir e aprovar." className="mt-1 min-h-20 w-full rounded-xl border-2 border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 p-3 text-sm font-semibold text-slate-900 dark:text-white" /></label>
                        <div className="flex flex-col sm:flex-row justify-end gap-2">
                          <button type="button" onClick={() => setCorrectionOpen(false)} className="rounded-xl bg-slate-200 dark:bg-slate-800 px-4 py-3 text-xs font-black text-slate-700 dark:text-slate-200">CANCELAR CORREÇÃO</button>
                          <button type="button" disabled={actionLoading} onClick={() => approveDocument(true)} className="rounded-xl bg-blue-600 px-4 py-3 text-xs font-black text-white disabled:opacity-50">CORRIGIR E APROVAR</button>
                        </div>
                      </div>
                    )}

                    <TechnicalDetails title="Detalhes técnicos preservados">
                      <div className="space-y-4"><JsonEvidence title="Entidades originais" value={detail.entidades} /><JsonEvidence title="Registros sugeridos originais" value={detail.registros_sugeridos} /></div>
                    </TechnicalDetails>
                      </>
                    )}
                  </>
                )}

                {selected.type === 'HELPDESK' && detail && (
                  <>
                    <DecisionIntro title="O Chat Lince não conseguiu concluir esta resposta sozinho.">
                      <p>{detail.pergunta_original || 'Pergunta aguardando orientação humana.'}</p>
                    </DecisionIntro>
                    <label className="block text-xs font-black text-slate-600 dark:text-slate-300">Resposta do PPU/Admin<textarea value={helpdeskAnswer} onChange={(e) => setHelpdeskAnswer(e.target.value)} className="mt-1 min-h-32 w-full rounded-xl border-2 border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 p-3 text-sm font-semibold text-slate-900 dark:text-white" /></label>
                    <div className="flex justify-end"><button type="button" disabled={actionLoading} onClick={resolveHelpdesk} className="rounded-xl bg-emerald-600 px-5 py-3 text-xs font-black text-white disabled:opacity-50">RESPONDER / MARCAR RESOLVIDO</button></div>
                    <TechnicalDetails title="Ver contexto completo"><pre className="max-h-72 overflow-auto whitespace-pre-wrap text-xs font-semibold text-slate-700 dark:text-slate-200">{stringify(detail.contexto || detail.context_payload || detail)}</pre></TechnicalDetails>
                  </>
                )}

                {selected.type === 'EQUIPMENT_CONFLICT' && detail && (() => {
                  const currentLocation = humanLocation(detail.estado_atual);
                  const candidateLocation = humanLocation(detail.estado_candidato);
                  const source = detail.payload?.fonte || {};
                  const candidateStrength = evidenceStrength(detail.estado_candidato?.confianca_localizacao || detail.confianca);
                  return (
                    <>
                      <DecisionIntro title="O mesmo equipamento aparece em duas localizações incompatíveis.">
                        <p>O cadastro vigente informa <strong>{currentLocation}</strong>, enquanto uma nova evidência indica <strong>{candidateLocation}</strong>. O SISHA bloqueou a alteração automática para não mover o item sem sua confirmação.</p>
                      </DecisionIntro>

                      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                        <EvidenceBlock title="Localização atualmente confirmada"><p className="text-lg font-black text-slate-900 dark:text-white">{currentLocation}</p><p className="mt-1 text-xs font-semibold text-slate-500">Estado que permanece válido até a reconciliação.</p></EvidenceBlock>
                        <EvidenceBlock title="Localização indicada pela nova evidência"><p className="text-lg font-black text-blue-700 dark:text-blue-300">{candidateLocation}</p><p className="mt-1 text-xs font-semibold text-slate-500">Fonte: {humanSource(source)} • força: {candidateStrength}</p></EvidenceBlock>
                      </div>

                      <div className="rounded-2xl border border-amber-200 bg-amber-50 dark:bg-amber-950/20 dark:border-amber-900 p-4">
                        <p className="text-xs font-black uppercase tracking-wide text-amber-700 dark:text-amber-300">Leitura do SISHA</p>
                        <p className="mt-1 text-sm font-semibold text-slate-700 dark:text-slate-200">Existe evidência suficiente para levantar a possibilidade de o equipamento estar em <strong>{candidateLocation}</strong>, mas há conflito com o estado já confirmado. A decisão deve ser humana.</p>
                      </div>

                      <div className="rounded-2xl border border-slate-200 dark:border-slate-700 p-5">
                        <p className="text-sm font-black text-slate-900 dark:text-white">Onde este equipamento está atualmente?</p>
                        <label className="mt-3 block text-xs font-black text-slate-600 dark:text-slate-300">Motivo da decisão<textarea value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Ex.: conferido fisicamente no RECEX em 16/08/2026." className="mt-1 min-h-20 w-full rounded-xl border-2 border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 p-3 text-sm font-semibold text-slate-900 dark:text-white" /></label>
                        <div className="mt-4 grid grid-cols-1 sm:grid-cols-2 gap-2">
                          <button type="button" disabled={actionLoading} onClick={() => resolveEquipmentConflict('CURRENT')} className="rounded-xl bg-slate-700 px-4 py-3 text-xs font-black text-white disabled:opacity-50">MANTER {currentLocation.toUpperCase()}</button>
                          <button type="button" disabled={actionLoading} onClick={() => resolveEquipmentConflict('CANDIDATE')} className="rounded-xl bg-blue-600 px-4 py-3 text-xs font-black text-white disabled:opacity-50">CONFIRMAR {candidateLocation.toUpperCase()}</button>
                        </div>
                      </div>

                      <TechnicalDetails title="Ver evidências completas">
                        <div className="grid grid-cols-1 xl:grid-cols-2 gap-4"><JsonEvidence title="Estado atual" value={detail.estado_atual} /><JsonEvidence title="Estado candidato" value={detail.estado_candidato} /></div>
                        <div className="mt-4"><JsonEvidence title="Evento de conflito original" value={detail.payload || detail} /></div>
                      </TechnicalDetails>
                    </>
                  );
                })()}

                {selected.type === 'PPU_CUSTODY' && detail && (
                  <>
                    <DecisionIntro title="A auditoria física não fecha integralmente com a posição oficial do PPU.">
                      <p>O PN <strong>{detail.pn || 'não informado'}</strong> aparece associado à caixa <strong>{detail.box_code || 'não informada'}</strong>, fisicamente no CEIMSPA, mas {Number(detail.blocked_qty || 0).toLocaleString('pt-BR')} unidade(s) ainda precisam de confirmação administrativa para reconciliar a custódia.</p>
                    </DecisionIntro>
                    <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                      <EvidenceBlock title="Origem oficial"><p className="text-sm font-black text-slate-900 dark:text-white">{detail.original_location || 'Não informada'}</p></EvidenceBlock>
                      <EvidenceBlock title="Local físico indicado"><p className="text-sm font-black text-slate-900 dark:text-white">{detail.box_code || 'Caixa não informada'} — CEIMSPA</p></EvidenceBlock>
                      <EvidenceBlock title="Quantidade a confirmar"><p className="text-sm font-black text-slate-900 dark:text-white">{Number(detail.blocked_qty || 0).toLocaleString('pt-BR')} un</p></EvidenceBlock>
                    </div>
                    <label className="block text-xs font-black text-slate-600 dark:text-slate-300">Motivo da decisão<textarea value={reason} onChange={(e) => setReason(e.target.value)} className="mt-1 min-h-20 w-full rounded-xl border-2 border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 p-3 text-sm font-semibold text-slate-900 dark:text-white" /></label>
                    <div className="flex flex-col sm:flex-row justify-end gap-2"><button type="button" disabled={actionLoading} onClick={() => resolveCustody('IGNORAR_MOVIMENTACAO')} className="rounded-xl bg-slate-700 px-4 py-3 text-xs font-black text-white">MANTER INVENTÁRIO OFICIAL</button><button type="button" disabled={actionLoading} onClick={() => resolveCustody('CONFIRMAR_CUSTODIA')} className="rounded-xl bg-blue-600 px-4 py-3 text-xs font-black text-white">CONFIRMAR CUSTÓDIA NA CAIXA</button></div>
                    <TechnicalDetails title="Ver evidências completas"><pre className="max-h-72 overflow-auto whitespace-pre-wrap text-xs font-semibold text-slate-700 dark:text-slate-200">{stringify(detail)}</pre></TechnicalDetails>
                  </>
                )}

                {selected.type === 'PD_ORDERBOOK_GAP' && detail && (
                  <div className="space-y-4">
                    <DecisionIntro title="Este PD apareceu no Order Book sem ter sido cadastrado antes no SISHA.">
                      <p>O Order Book confirma que o processo existe, mas o SISHA não encontrou o nascimento canônico do PD/SEPD. Não será criado um segundo PD automaticamente: primeiro é preciso cadastrar/importar o PD pelo fluxo oficial.</p>
                    </DecisionIntro>
                    <div className="grid gap-3 md:grid-cols-2">
                      <EvidenceBlock title="PD"><p className="text-sm font-black text-slate-900 dark:text-white">{detail.numero_pd || selected.id}</p></EvidenceBlock>
                      <EvidenceBlock title="PN observado no Order Book"><p className="text-sm font-black text-slate-900 dark:text-white">{safeArray(detail.pns).join(', ') || 'Não informado'}</p></EvidenceBlock>
                      <EvidenceBlock title="OC observada"><p className="text-sm font-black text-slate-900 dark:text-white">{safeArray(detail.ocs).join(', ') || 'Não informada'}</p></EvidenceBlock>
                      <EvidenceBlock title="Estágio do Order Book"><p className="text-sm font-black text-slate-900 dark:text-white">{safeArray(detail.status_order_book).join(', ') || 'Não informado'}</p></EvidenceBlock>
                    </div>
                    <div className="flex justify-end"><button type="button" onClick={() => { onClose?.(); onOpenPurchases?.(); }} className="rounded-xl bg-blue-600 px-5 py-3 text-xs font-black text-white">ABRIR ORDENS DE COMPRAS / PDs</button></div>
                  </div>
                )}

                {selected.type === 'RECEIPT_JOB' && detail && (() => {
                  const pendingReceiptItems = safeArray(detail.items).filter(isReceiptItemPending);
                  return (
                    <>
                      <DecisionIntro title={pendingReceiptItems.length ? 'Este lote ainda possui recibos que exigem uma decisão humana.' : 'Este lote já foi integralmente resolvido.'}>
                        <p>{pendingReceiptItems.length
                          ? `${pendingReceiptItems.length} documento(s) ainda aguardam ação no módulo especializado de Recibos. Recibos já gravados com o mesmo arquivo não são solicitados novamente.`
                          : 'Nenhum documento deste lote precisa ser revisado novamente.'}</p>
                      </DecisionIntro>
                      <div className="space-y-2">{pendingReceiptItems.map((item) => <div key={item.id} className="rounded-xl border border-slate-200 dark:border-slate-700 p-3"><p className="text-sm font-black text-slate-900 dark:text-white">{item.file_name || item.receipt_number || item.id}</p><p className="text-xs font-bold text-slate-500">{item.effective_status || item.status} • {compactText(item.diagnostic || 'Aguardando revisão.', 140)}</p></div>)}</div>
                      {pendingReceiptItems.length > 0 && <div className="flex justify-end"><button type="button" onClick={() => { onClose?.(); onOpenReceipts?.(); }} className="rounded-xl bg-blue-600 px-5 py-3 text-xs font-black text-white">REVISAR NO MÓDULO DE RECIBOS</button></div>}
                    </>
                  );
                })()}

                {selected.type === 'RFQ_JOB' && detail && (() => {
                  const jobStatus = String(detail.status || '').toUpperCase();
                  const processing = ['QUEUED', 'PROCESSING'].includes(jobStatus);
                  const legacyAnalysis = detail.legacy_analysis === true || detail.analysis_current === false;
                  const reviewBlocked = String(rfqReview?.metadados?.quality_status || detail.quality_status || '').toUpperCase() === 'BLOCKED';
                  const reviewItems = safeArray(rfqReview?.items);
                  const warnings = safeArray(rfqReview?.metadados?.quality_warnings);
                  return (
                    <>
                      <DecisionIntro title="Esta referência comercial precisa de revisão antes de entrar na base de preços.">
                        <p><strong>{detail.file_name || 'Documento comercial'}</strong> • {rfqDocumentTypeLabels[detail.document_type] || detail.document_type || 'tipo não identificado'}.</p>
                        <p className="mt-2 text-xs font-bold text-slate-500">{compactText(detail.diagnostic || 'Revisão comercial necessária.', 180)}</p>
                      </DecisionIntro>

                      {legacyAnalysis && !processing ? (
                        <div className="rounded-2xl border-2 border-amber-300 bg-amber-50 dark:bg-amber-950/25 dark:border-amber-800 p-4">
                          <p className="text-xs font-black uppercase tracking-wide text-amber-800 dark:text-amber-200">ANÁLISE LEGADA — reprocessamento recomendado</p>
                          <p className="mt-2 text-sm font-semibold text-slate-700 dark:text-slate-200">Esta leitura foi produzida por uma versão anterior do analisador. Você pode revisá-la manualmente, mas o caminho preferencial é executar novamente o arquivo original com o leitor atual.</p>
                        </div>
                      ) : null}

                      <div className="rounded-2xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950/40 p-4">
                        <div className="flex flex-col xl:flex-row xl:items-center xl:justify-between gap-3">
                          <div>
                            <p className="text-sm font-black text-slate-900 dark:text-white">Processamento antigo, incorreto ou incompleto?</p>
                            <p className="mt-1 text-xs font-semibold text-slate-500">Reprocesse o arquivo privado já guardado, envie outra cópia ou exclua esta pendência sem apagar o histórico.</p>
                          </div>
                          <div className="flex flex-wrap gap-2">
                            <button type="button" disabled={actionLoading || processing} onClick={reprocessRfqWithCurrentReader} className="inline-flex items-center gap-2 rounded-xl bg-blue-600 px-4 py-3 text-xs font-black text-white disabled:opacity-50"><RotateCcw size={15} /> {processing ? 'REPROCESSANDO...' : 'REPROCESSAR COM LEITOR ATUAL'}</button>
                            <label className={`inline-flex cursor-pointer items-center gap-2 rounded-xl border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 px-4 py-3 text-xs font-black text-slate-700 dark:text-slate-200 ${actionLoading ? 'pointer-events-none opacity-50' : ''}`}>
                              <Upload size={15} /> SUBIR NOVAMENTE
                              <input type="file" accept=".pdf,.xlsx,.xls" className="hidden" disabled={actionLoading} onChange={(event) => { const file = event.target.files?.[0] || null; event.target.value = ''; uploadRfqAgain(file); }} />
                            </label>
                            {!processing ? <button type="button" disabled={actionLoading} onClick={() => setRfqDiscardOpen(true)} className="inline-flex items-center gap-2 rounded-xl border border-red-300 bg-red-50 dark:bg-red-950/30 dark:border-red-900 px-4 py-3 text-xs font-black text-red-700 dark:text-red-300 disabled:opacity-50"><Trash2 size={15} /> EXCLUIR</button> : null}
                          </div>
                        </div>

                        {rfqDiscardOpen && !processing ? (
                          <div className="mt-4 rounded-xl border border-red-300 bg-white dark:bg-slate-900 dark:border-red-900 p-4">
                            <p className="text-sm font-black text-red-700 dark:text-red-300">Excluir esta pendência?</p>
                            <p className="mt-1 text-xs font-semibold text-slate-600 dark:text-slate-300">Ela sumirá da Central e não poderá ser aprovada como referência comercial. O arquivo, o hash, o resultado original e a auditoria serão preservados; não há exclusão física.</p>
                            <label className="mt-3 block text-xs font-black text-slate-600 dark:text-slate-300">Motivo da exclusão<textarea value={rfqDiscardReason} onChange={(event) => setRfqDiscardReason(event.target.value)} placeholder="Ex.: leitura legada incorreta; documento será reprocessado com OCR atual." className="mt-1 min-h-20 w-full rounded-xl border-2 border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 p-3 text-sm font-semibold text-slate-900 dark:text-white" /></label>
                            <div className="mt-3 flex justify-end gap-2"><button type="button" disabled={actionLoading} onClick={() => setRfqDiscardOpen(false)} className="rounded-xl bg-slate-200 dark:bg-slate-800 px-4 py-2 text-xs font-black text-slate-700 dark:text-slate-200">CANCELAR</button><button type="button" disabled={actionLoading || !rfqDiscardReason.trim()} onClick={discardRfqFromPendingCenter} className="rounded-xl bg-red-600 px-4 py-2 text-xs font-black text-white disabled:opacity-50">CONFIRMAR EXCLUSÃO</button></div>
                          </div>
                        ) : null}
                      </div>

                      {processing ? (
                        <div className="rounded-2xl border border-blue-200 bg-blue-50 dark:bg-blue-950/30 dark:border-blue-900 p-5"><p className="text-xs font-black uppercase tracking-wide text-blue-700 dark:text-blue-300">Reprocessamento em andamento</p><p className="mt-2 text-sm font-semibold text-slate-700 dark:text-slate-200">O SISHA já selecionou a versão atual do leitor para este mesmo arquivo. Você pode fechar a Central; o worker continuará e a revisão correta aparecerá aqui quando terminar.</p></div>
                      ) : reviewBlocked || !reviewItems.length ? (
                        <div className="rounded-2xl border border-red-300 bg-red-50 dark:bg-red-950/30 dark:border-red-900 p-5">
                          <p className="text-xs font-black uppercase tracking-wide text-red-700 dark:text-red-300">Leitura bloqueada — não há preço confiável para corrigir manualmente</p>
                          <p className="mt-2 text-sm font-semibold leading-relaxed text-slate-700 dark:text-slate-200">Este processamento não produziu itens comerciais confiáveis. O SISHA mantém a pendência, mas não permite aprovar nem fabricar PN/preço a partir de uma leitura bloqueada. Reprocesse o documento original pela entrada comercial quando necessário.</p>
                          {warnings.length ? <div className="mt-3 space-y-1">{warnings.map((warning, index) => <p key={index} className="text-xs font-bold text-red-700 dark:text-red-300">• {warning}</p>)}</div> : null}
                        </div>
                      ) : (
                        <>
                          <div className="rounded-xl border border-cyan-200 bg-cyan-50 dark:bg-cyan-950/30 p-3 text-xs font-bold text-cyan-800 dark:text-cyan-200">Revise e corrija aqui mesmo. A Central usa o mesmo endpoint comercial <span className="font-mono">/import/rfq/salvar</span>; não cria regra paralela de preço, validade ou idempotência.</div>

                          {warnings.length ? (
                            <div className="rounded-xl border border-amber-300 bg-amber-50 dark:bg-amber-950/30 dark:border-amber-900 p-4">
                              <p className="text-xs font-black uppercase text-amber-800 dark:text-amber-200">O que merece conferência</p>
                              <div className="mt-2 space-y-1">{warnings.map((warning, index) => <p key={index} className="text-xs font-bold text-amber-800 dark:text-amber-300">• {warning}</p>)}</div>
                            </div>
                          ) : null}

                          <div className="rounded-2xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 p-4">
                            <p className="mb-3 text-xs font-black uppercase tracking-wide text-slate-500">Dados principais do documento</p>
                            <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                              <label className="text-[10px] font-black uppercase text-slate-500">Tipo documental<select value={rfqReview.metadados?.documento_tipo || 'GENERIC_COMMERCIAL_DOCUMENT'} onChange={(e) => changeRfqMeta('documento_tipo', e.target.value)} className="mt-1 w-full rounded-lg border p-2 bg-white dark:bg-slate-950 dark:border-slate-700"><option value="LEONARDO_QUOTATION">Leonardo Quotation</option><option value="LEONARDO_PRICE_LETTER">Carta Leonardo — preço/venda</option><option value="LEONARDO_REPAIR_PRICE_LETTER">Carta Leonardo — Repair/Overhaul</option><option value="GENERIC_COMMERCIAL_DOCUMENT">Genérico</option></select></label>
                              <label className="text-[10px] font-black uppercase text-slate-500">Nº / referência principal<input value={rfqReview.metadados?.quotation_number || ''} onChange={(e) => changeRfqMeta('quotation_number', e.target.value)} className="mt-1 w-full rounded-lg border p-2 dark:bg-slate-950 dark:border-slate-700" /></label>
                              <label className="text-[10px] font-black uppercase text-slate-500">Validade / prazo<input value={rfqReview.metadados?.validity || ''} onChange={(e) => changeRfqMeta('validity', e.target.value)} className="mt-1 w-full rounded-lg border p-2 dark:bg-slate-950 dark:border-slate-700" /></label>
                              <label className="text-[10px] font-black uppercase text-slate-500">Data da cotação<input value={rfqReview.metadados?.quotation_date || ''} onChange={(e) => changeRfqMeta('quotation_date', e.target.value)} className="mt-1 w-full rounded-lg border p-2 dark:bg-slate-950 dark:border-slate-700" /></label>
                              <label className="text-[10px] font-black uppercase text-slate-500">Fornecedor<input value={rfqReview.metadados?.fornecedor || ''} onChange={(e) => changeRfqMeta('fornecedor', e.target.value)} className="mt-1 w-full rounded-lg border p-2 dark:bg-slate-950 dark:border-slate-700" /></label>
                              <label className="text-[10px] font-black uppercase text-slate-500">Contrato<input value={rfqReview.metadados?.contract_reference || ''} onChange={(e) => changeRfqMeta('contract_reference', e.target.value)} className="mt-1 w-full rounded-lg border p-2 dark:bg-slate-950 dark:border-slate-700" /></label>
                            </div>
                            <TechnicalDetails title="Mais dados do documento">
                              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                                <label className="text-[10px] font-black uppercase text-slate-500">Referência documental<input value={rfqReview.metadados?.reference || ''} onChange={(e) => changeRfqMeta('reference', e.target.value)} className="mt-1 w-full rounded-lg border p-2 dark:bg-slate-950 dark:border-slate-700" /></label>
                                <label className="text-[10px] font-black uppercase text-slate-500">Condição<input value={rfqReview.metadados?.condicao || ''} onChange={(e) => changeRfqMeta('condicao', e.target.value)} className="mt-1 w-full rounded-lg border p-2 dark:bg-slate-950 dark:border-slate-700" /></label>
                                <label className="text-[10px] font-black uppercase text-slate-500">Pagamento<input value={rfqReview.metadados?.payment_terms || ''} onChange={(e) => changeRfqMeta('payment_terms', e.target.value)} className="mt-1 w-full rounded-lg border p-2 dark:bg-slate-950 dark:border-slate-700" /></label>
                                <label className="text-[10px] font-black uppercase text-slate-500">Entrega / Incoterm<input value={rfqReview.metadados?.delivery_terms || ''} onChange={(e) => changeRfqMeta('delivery_terms', e.target.value)} className="mt-1 w-full rounded-lg border p-2 dark:bg-slate-950 dark:border-slate-700" /></label>
                              </div>
                            </TechnicalDetails>
                          </div>

                          <div className="rounded-2xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950/40 p-4">
                            <div className="mb-3 flex items-center justify-between gap-3"><div><p className="text-xs font-black uppercase tracking-wide text-slate-500">Itens a revisar</p><p className="text-xs font-semibold text-slate-500">{reviewItems.length} referência(s). Corrija somente o que a evidência documental sustenta.</p></div><span className="rounded-full bg-blue-100 text-blue-800 dark:bg-blue-950 dark:text-blue-200 px-3 py-1 text-xs font-black">{reviewItems.length} ITENS</span></div>
                            <div className="max-h-[42vh] overflow-y-auto pr-1 space-y-3">
                              {reviewItems.map((item, index) => (
                                <div key={`${item.item_num || index}-${item.pn || 'sem-pn'}`} className="rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 p-4">
                                  <div className="grid grid-cols-1 md:grid-cols-12 gap-3">
                                    <div className="md:col-span-1"><p className="text-[10px] font-black uppercase text-slate-400">Item</p><p className="mt-2 text-sm font-black text-slate-700 dark:text-slate-200">#{item.item_num || index + 1}</p></div>
                                    <label className="md:col-span-3 text-[10px] font-black uppercase text-slate-500">Part Number<input value={item.pn || ''} onChange={(e) => changeRfqItem(index, 'pn', e.target.value)} className="mt-1 w-full rounded-lg border p-2 font-black uppercase dark:bg-slate-950 dark:border-slate-700" /></label>
                                    <label className="md:col-span-3 text-[10px] font-black uppercase text-slate-500">Descrição<input value={item.nomenclatura || ''} onChange={(e) => changeRfqItem(index, 'nomenclatura', e.target.value)} className="mt-1 w-full rounded-lg border p-2 font-bold uppercase dark:bg-slate-950 dark:border-slate-700" /></label>
                                    <label className="md:col-span-2 text-[10px] font-black uppercase text-slate-500">Tipo<select value={item.tipo_cotacao || rfqReview.metadados?.tipo_cotacao || 'MATERIAL'} onChange={(e) => changeRfqItem(index, 'tipo_cotacao', e.target.value)} className="mt-1 w-full rounded-lg border p-2 bg-white dark:bg-slate-950 dark:border-slate-700">{rfqTypeOptions.map((type) => <option key={type}>{type}</option>)}</select></label>
                                    <label className="md:col-span-1 text-[10px] font-black uppercase text-slate-500">Qtd<input type="number" step="0.01" value={item.qtd_solicitada ?? ''} onChange={(e) => changeRfqItem(index, 'qtd_solicitada', Number(e.target.value) || 0)} className="mt-1 w-full rounded-lg border p-2 text-center dark:bg-slate-950 dark:border-slate-700" /></label>
                                    <label className="md:col-span-2 text-[10px] font-black uppercase text-emerald-700">Preço unit. (£)<input type="number" step="0.01" value={item.valor_unitario ?? ''} onChange={(e) => changeRfqItem(index, 'valor_unitario', Number(e.target.value) || 0)} className="mt-1 w-full rounded-lg border border-emerald-300 bg-emerald-50 dark:bg-emerald-950/30 p-2 font-black dark:border-emerald-800" /></label>
                                  </div>
                                  <TechnicalDetails title="Mais campos deste item">
                                    <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
                                      <label className="text-[10px] font-black uppercase text-slate-500">Situação do preço<select value={item.price_status || 'UNPRICED'} onChange={(e) => changeRfqItem(index, 'price_status', e.target.value)} className="mt-1 w-full rounded-lg border p-2 bg-white dark:bg-slate-950 dark:border-slate-700">{rfqPriceStatusOptions.map((value) => <option key={value}>{value}</option>)}</select></label>
                                      <label className="text-[10px] font-black uppercase text-slate-500">Referência / NSN<input value={item.material_reference || item.nsn || ''} onChange={(e) => changeRfqItem(index, 'material_reference', e.target.value)} className="mt-1 w-full rounded-lg border p-2 dark:bg-slate-950 dark:border-slate-700" /></label>
                                      <label className="text-[10px] font-black uppercase text-slate-500">Lead time original<input value={item.lead_time_original || ''} onChange={(e) => changeRfqItem(index, 'lead_time_original', e.target.value)} className="mt-1 w-full rounded-lg border p-2 dark:bg-slate-950 dark:border-slate-700" /></label>
                                      <label className="text-[10px] font-black uppercase text-slate-500">Match PN<select value={item.match_mode || 'EXACT'} onChange={(e) => changeRfqItem(index, 'match_mode', e.target.value)} className="mt-1 w-full rounded-lg border p-2 bg-white dark:bg-slate-950 dark:border-slate-700"><option>EXACT</option><option>PATTERN</option></select></label>
                                      <label className="md:col-span-4 text-[10px] font-black uppercase text-slate-500">Evidência original<textarea value={item.source_excerpt || ''} onChange={(e) => changeRfqItem(index, 'source_excerpt', e.target.value)} className="mt-1 min-h-16 w-full rounded-lg border p-2 font-mono text-xs dark:bg-slate-950 dark:border-slate-700" /></label>
                                    </div>
                                  </TechnicalDetails>
                                </div>
                              ))}
                            </div>
                          </div>

                          <div className="sticky bottom-0 z-10 rounded-2xl border border-slate-200 dark:border-slate-700 bg-white/95 dark:bg-slate-900/95 backdrop-blur p-4 shadow-lg flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
                            <div><p className="text-sm font-black text-slate-900 dark:text-white">Pronto para gravar?</p><p className="text-xs font-semibold text-slate-500">A aprovação grava {reviewItems.length} registro(s) pelo fluxo comercial já homologado.</p></div>
                            <button type="button" disabled={actionLoading} onClick={saveRfqReview} className="rounded-xl bg-blue-600 px-6 py-3 text-xs font-black text-white disabled:opacity-50">{actionLoading ? 'GRAVANDO...' : 'APROVAR E GRAVAR'}</button>
                          </div>
                        </>
                      )}

                      <TechnicalDetails title="Ver detalhes técnicos preservados"><pre className="max-h-72 overflow-auto whitespace-pre-wrap text-xs font-semibold text-slate-700 dark:text-slate-200">{stringify({ status: detail.status, arquivo: detail.file_name, hash: detail.file_sha256, tipo: detail.document_type, cotacao: detail.quotation_number, metodo: detail.analysis_method, versao_analise: detail.analysis_version, analise_atual: detail.analysis_current, qualidade: detail.quality_status, diagnostico: detail.diagnostic, metadados: detail.result_payload?.metadados })}</pre></TechnicalDetails>
                    </>
                  );
                })()}
              </div>
            )}
          </main>
        </div>
      </div>
    </div>
  );
}
