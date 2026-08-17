import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { PlusCircle, Search, Trash2, RefreshCcw, Ban, Wrench, ShoppingCart, Upload, FileSpreadsheet, Link2, Pencil, Download } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { API_BASE_URL, apiFetch, buildAuthHeaders } from '../lib/api';

const currencyFormatter = (moeda = 'USD') => new Intl.NumberFormat('pt-BR', {
  style: 'currency',
  currency: moeda || 'USD',
  minimumFractionDigits: 2,
});

const formatMoney = (value, moeda = 'USD') => {
  const number = Number(value || 0);
  try {
    return currencyFormatter(moeda).format(number);
  } catch {
    return `${moeda || 'USD'} ${number.toLocaleString('pt-BR', { minimumFractionDigits: 2 })}`;
  }
};

const numberBr = (value) => Number(value || 0).toLocaleString('pt-BR', { maximumFractionDigits: 2 });

const pdOrderedQty = (pd = {}) => Number(pd.qtd_comprada || pd.quantidade || pd.qtd_pedida || 0) || 0;
const pdDeliveredQty = (pd = {}) => Math.max(0, Number(pd.qtd_recebida || pd.qtd_entregue || 0) || 0);
const pdMissingQty = (pd = {}) => Math.max(0, pdOrderedQty(pd) - pdDeliveredQty(pd));
const pdLifecycleLabel = (pd = {}) => {
  const ordered = pdOrderedQty(pd);
  const delivered = pdDeliveredQty(pd);
  if (ordered > 0 && delivered >= ordered) return 'ENTREGUE';
  if (delivered > 0) return 'ENTREGA PARCIAL';
  return pd.status_grupo || pd.status || 'SEM STATUS';
};

const ProgressBar = ({ percent = 0 }) => (
  <div className="w-full h-4 bg-slate-200 dark:bg-slate-900 rounded-full overflow-hidden border border-slate-300 dark:border-slate-700">
    <div className="h-full bg-blue-600 rounded-full transition-all" style={{ width: `${Math.max(0, Math.min(100, Number(percent || 0)))}%` }} />
  </div>
);

const Badge = ({ children, danger = false, amber = false, green = false }) => {
  const tone = danger
    ? 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300'
    : amber
      ? 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300'
      : green
        ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300'
        : 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300';
  return <span className={`inline-flex px-3 py-1 rounded-full text-[10px] font-black uppercase tracking-wider ${tone}`}>{children}</span>;
};

const modalInputClass = "w-full px-4 py-3 rounded-xl border-2 border-blue-300 dark:border-blue-500/70 bg-white dark:bg-slate-800 text-slate-900 dark:text-white placeholder:text-slate-500 dark:placeholder:text-slate-400 font-bold shadow-inner outline-none focus:ring-4 focus:ring-blue-500/20 focus:border-blue-500 transition";
const modalSelectClass = "w-full px-4 py-3 rounded-xl border-2 border-blue-300 dark:border-blue-500/70 bg-white dark:bg-slate-800 text-slate-900 dark:text-white font-bold shadow-inner outline-none focus:ring-4 focus:ring-blue-500/20 focus:border-blue-500 transition";
const modalTextAreaClass = "w-full min-h-[110px] px-4 py-3 rounded-xl border-2 border-blue-300 dark:border-blue-500/70 bg-white dark:bg-slate-800 text-slate-900 dark:text-white placeholder:text-slate-500 dark:placeholder:text-slate-400 font-bold shadow-inner outline-none focus:ring-4 focus:ring-blue-500/20 focus:border-blue-500 transition";
const modalLabelClass = "block text-[11px] font-black uppercase tracking-wider text-slate-600 dark:text-slate-300 mb-1";
const modalPanelClass = "bg-slate-50 dark:bg-slate-950 rounded-3xl p-8 w-full shadow-2xl border border-slate-200 dark:border-slate-700 space-y-5 text-slate-900 dark:text-white";

const SummaryMiniCard = ({ title, value, subtitle }) => (
  <div className="p-4 rounded-2xl bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 shadow-sm">
    <p className="text-[10px] uppercase font-black text-slate-400 tracking-wider">{title}</p>
    <p className="text-2xl font-black text-slate-900 dark:text-white">{value}</p>
    {subtitle && <p className="text-xs font-bold text-slate-500 dark:text-slate-400 mt-1">{subtitle}</p>}
  </div>
);

export default function OrdensCompras() {
  const { token, user } = useAuth();
  const isAdmin = ['admin', 'dono'].includes(user?.role);
  const [tab, setTab] = useState('oc');
  const [q, setQ] = useState('');
  const [ordens, setOrdens] = useState([]);
  const [wos, setWos] = useState([]);
  const [pds, setPds] = useState([]);
  const [ocMeta, setOcMeta] = useState({ pd_pipeline: {} });
  const [loading, setLoading] = useState(false);
  const [msg, setMsg] = useState(null);
  const [modalOc, setModalOc] = useState(false);
  const [modalWo, setModalWo] = useState(false);
  const [supTarget, setSupTarget] = useState(null);
  const [supEditId, setSupEditId] = useState(null);
  const [supControl, setSupControl] = useState({ valor_alvo_usd: '', marcar_total: false, motivo: '' });
  const [editWoTarget, setEditWoTarget] = useState(null);
  const [pdTarget, setPdTarget] = useState(null);
  const [pdsUploadTarget, setPdsUploadTarget] = useState(null);
  const [pdManagerTarget, setPdManagerTarget] = useState(null);
  const [actionMenu, setActionMenu] = useState(null);
  const [moreTarget, setMoreTarget] = useState(null);

  const ocUploadRef = useRef(null);
  const pdPipelineUploadRef = useRef(null);
  const pdsDaOcUploadRef = useRef(null);
  const woUploadRef = useRef(null);

  const [ocForm, setOcForm] = useState({
    numero_oc: '',
    status: 'ELB',
    moeda: 'USD',
    valor_total: '',
    observacao: '',
    pds: [{ numero_pd: '', pn: '', nomenclatura: '', quantidade: 1, valor_unitario: '', valor_total: '' }],
  });

  const [woForm, setWoForm] = useState({
    numero_wo: '', pn: '', nomenclatura: '', sn: '', empresa: '', origem: 'MANUAL', status: 'ELB',
    tipo_wo: 'PENDENTE', resultado_tecnico: 'PENDENTE', valor_total: '', moeda: 'USD',
    data_previsao: '', aeronave: '', pn_saida: '', equipamento_codigo: '', modelo: '',
    responsavel: '', observacao: '',
  });

  const [editWoForm, setEditWoForm] = useState({
    numero_wo: '', pn: '', nsn: '', nomenclatura: '', sn: '', empresa: '', quantidade: 1,
    tipo_wo: 'PENDENTE', resultado_tecnico: 'PENDENTE', status: '', valor_total: '', moeda: 'USD',
    data_abertura: '', data_envio: '', data_previsao: '', data_retorno: '', aeronave: '',
    pn_saida: '', equipamento_codigo: '', modelo: '', responsavel: '', observacao: '',
  });
  const [pdForm, setPdForm] = useState({ numero_pd: '', numero_oc: '', pn: '', nsn: '', nomenclatura: '', fabricante: '', quantidade: 1, qtd_pedida: 1, qtd_comprada: 1, qtd_faturada: 0, qtd_recebida: 0, valor_unitario: '', valor_total: '', moeda: 'USD', status: 'ELB', status_item: '', data_previsao_entrega: '', responsavel: '', observacao: '' });
  const [supForm, setSupForm] = useState({ valor: '', moeda: 'USD', msg_referencia: '', data_msg: '', observacao: '', motivo_retificacao: '' });

  const carregar = useCallback(async (query = '') => {
    setLoading(true);
    setMsg(null);
    try {
      const [ocRes, woRes, pdRes] = await Promise.all([
        apiFetch(`/purchases/ordens?q=${encodeURIComponent(query)}`, {}, token),
        apiFetch(`/purchases/work-orders?q=${encodeURIComponent(query)}`, {}, token),
        apiFetch('/purchases/pds', {}, token),
      ]);
      const [ocJson, woJson, pdJson] = await Promise.all([ocRes.json(), woRes.json(), pdRes.json()]);
      if (ocJson.status === 'success') {
        setOrdens(ocJson.data || []);
        setOcMeta(ocJson.meta || { pd_pipeline: {} });
      }
      if (woJson.status === 'success') setWos(woJson.data || []);
      if (pdJson.status === 'success') setPds(pdJson.data || []);
      if (ocJson.status !== 'success') setMsg({ tipo: 'error', texto: ocJson.message || 'Falha ao consultar OC.' });
      if (woJson.status !== 'success') setMsg({ tipo: 'error', texto: woJson.message || 'Falha ao consultar WO.' });
      if (pdJson.status !== 'success') setMsg({ tipo: 'error', texto: pdJson.message || 'Falha ao consultar PD.' });
    } catch {
      setMsg({ tipo: 'error', texto: 'Falha de comunicação com o backend.' });
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => { carregar(''); }, [carregar]);

  const ocAtivas = useMemo(() => ordens.filter((o) => o.status !== 'CAN'), [ordens]);
  const ocCanceladas = useMemo(() => ordens.filter((o) => o.status === 'CAN'), [ordens]);
  const pdPipeline = ocMeta?.pd_pipeline || {};

  const addPdLine = () => {
    if (ocForm.pds.length >= 20) return;
    setOcForm((old) => ({
      ...old,
      pds: [...old.pds, { numero_pd: '', pn: '', nomenclatura: '', quantidade: 1, valor_unitario: '', valor_total: '' }],
    }));
  };

  const updatePd = (index, field, value) => {
    setOcForm((old) => ({ ...old, pds: old.pds.map((pd, i) => (i === index ? { ...pd, [field]: value } : pd)) }));
  };

  const uploadFile = async (endpoint, file, successPrefix) => {
    if (!file) return;
    setMsg(null);
    const formData = new FormData();
    formData.append('file', file);
    try {
      const response = await fetch(`${API_BASE_URL}${endpoint}`, {
        method: 'POST',
        headers: buildAuthHeaders(token),
        body: formData,
      });
      const json = await response.json();
      if (json.status === 'success') {
        setMsg({ tipo: 'success', texto: json.message || successPrefix });
        carregar(q);
      } else {
        setMsg({ tipo: 'error', texto: json.message || 'Falha na importação.' });
      }
    } catch {
      setMsg({ tipo: 'error', texto: 'Falha ao enviar relatório.' });
    }
  };

  const salvarOc = async (e) => {
    e.preventDefault();
    setMsg(null);
    try {
      const response = await apiFetch('/purchases/ordens', {
        method: 'POST',
        headers: buildAuthHeaders(token, { 'Content-Type': 'application/json' }),
        body: JSON.stringify(ocForm),
      }, token);
      const json = await response.json();
      if (json.status === 'success') {
        setMsg({ tipo: 'success', texto: json.message });
        setModalOc(false);
        setOcForm({ numero_oc: '', status: 'ELB', moeda: 'USD', valor_total: '', observacao: '', pds: [{ numero_pd: '', pn: '', nomenclatura: '', quantidade: 1, valor_unitario: '', valor_total: '' }] });
        carregar(q);
      } else {
        setMsg({ tipo: 'error', texto: json.message || 'Falha ao cadastrar OC.' });
      }
    } catch {
      setMsg({ tipo: 'error', texto: 'Falha ao cadastrar OC.' });
    }
  };

  const salvarWo = async (e) => {
    e.preventDefault();
    setMsg(null);
    try {
      const response = await apiFetch('/purchases/work-orders', {
        method: 'POST',
        headers: buildAuthHeaders(token, { 'Content-Type': 'application/json' }),
        body: JSON.stringify(woForm),
      }, token);
      const json = await response.json();
      if (json.status === 'success') {
        setMsg({ tipo: 'success', texto: json.message });
        setModalWo(false);
        setWoForm({
          numero_wo: '', pn: '', nomenclatura: '', sn: '', empresa: '', origem: 'MANUAL', status: 'ELB',
          tipo_wo: 'PENDENTE', resultado_tecnico: 'PENDENTE', valor_total: '', moeda: 'USD',
          data_previsao: '', aeronave: '', pn_saida: '', equipamento_codigo: '', modelo: '',
          responsavel: '', observacao: '',
        });
        carregar(q);
      } else {
        setMsg({ tipo: 'error', texto: json.message || 'Falha ao cadastrar WO.' });
      }
    } catch {
      setMsg({ tipo: 'error', texto: 'Falha ao cadastrar WO.' });
    }
  };

  const salvarEdicaoWo = async (e) => {
    e.preventDefault();
    if (!editWoTarget) return;
    try {
      const response = await apiFetch(`/purchases/work-orders/${editWoTarget.id}`, {
        method: 'PUT',
        headers: buildAuthHeaders(token, { 'Content-Type': 'application/json' }),
        body: JSON.stringify(editWoForm),
      }, token);
      const json = await response.json();
      if (json.status === 'success') {
        setMsg({ tipo: 'success', texto: json.message });
        setEditWoTarget(null);
        carregar(q);
      } else {
        setMsg({ tipo: 'error', texto: json.message || 'Falha ao atualizar WO.' });
      }
    } catch {
      setMsg({ tipo: 'error', texto: 'Falha ao atualizar WO.' });
    }
  };

  const abrirSuplementacao = (tipo, item) => {
    const resumo = item?.resumo || {};
    setSupTarget({ tipo, id: item.id, titulo: tipo === 'oc' ? item.numero_oc : item.numero_wo, item });
    setSupEditId(null);
    setSupForm({ valor: '', moeda: 'USD', msg_referencia: '', data_msg: '', observacao: '', motivo_retificacao: '' });
    setSupControl({ valor_alvo_usd: String(resumo.valor_total_usd ?? resumo.valor_total_calculado ?? ''), marcar_total: false, motivo: '' });
  };

  const iniciarRetificacaoSuplementacao = (sup) => {
    setSupEditId(sup.id);
    setSupForm({
      valor: String(sup.valor ?? ''),
      moeda: 'USD',
      msg_referencia: sup.msg_referencia || '',
      data_msg: String(sup.data_msg || '').slice(0, 10),
      observacao: sup.observacao || '',
      motivo_retificacao: '',
    });
  };

  const salvarSuplementacao = async (e) => {
    e.preventDefault();
    if (!supTarget) return;
    try {
      const base = supTarget.tipo === 'oc' ? `/purchases/ordens/${supTarget.id}/suplementacoes` : `/purchases/work-orders/${supTarget.id}/suplementacoes`;
      const endpoint = supEditId ? `${base}/${supEditId}` : base;
      const response = await apiFetch(endpoint, {
        method: supEditId ? 'PUT' : 'POST',
        headers: buildAuthHeaders(token, { 'Content-Type': 'application/json' }),
        body: JSON.stringify({ ...supForm, moeda: 'USD' }),
      }, token);
      const json = await response.json();
      if (json.status !== 'success') throw new Error(json.message || 'Falha ao salvar suplementação.');
      setMsg({ tipo: 'success', texto: json.message });
      setSupEditId(null);
      setSupForm({ valor: '', moeda: 'USD', msg_referencia: '', data_msg: '', observacao: '', motivo_retificacao: '' });
      setSupTarget(null);
      carregar(q);
    } catch (error) {
      setMsg({ tipo: 'error', texto: error.message || 'Falha ao salvar suplementação.' });
    }
  };

  const salvarControleSuplementacao = async () => {
    if (!supTarget) return;
    try {
      const endpoint = supTarget.tipo === 'oc'
        ? `/purchases/ordens/${supTarget.id}/suplementacao-config`
        : `/purchases/work-orders/${supTarget.id}/suplementacao-config`;
      const response = await apiFetch(endpoint, {
        method: 'PUT',
        headers: buildAuthHeaders(token, { 'Content-Type': 'application/json' }),
        body: JSON.stringify({
          valor_alvo_usd: supControl.valor_alvo_usd,
          marcar_total: supControl.marcar_total,
          motivo: supControl.motivo,
        }),
      }, token);
      const json = await response.json();
      if (json.status !== 'success') throw new Error(json.message || 'Falha ao atualizar controle financeiro.');
      setMsg({ tipo: 'success', texto: json.message });
      setSupTarget(null);
      carregar(q);
    } catch (error) {
      setMsg({ tipo: 'error', texto: error.message || 'Falha ao atualizar controle financeiro.' });
    }
  };

  const vincularPdSemOc = async (pd) => {
    if (!pdManagerTarget?.id) return;
    try {
      const numeroOc = pdManagerTarget.numero_oc_original || pdManagerTarget.numero_oc;
      const response = await apiFetch(`/purchases/pds/${pd.id}`, {
        method: 'PUT',
        headers: buildAuthHeaders(token, { 'Content-Type': 'application/json' }),
        body: JSON.stringify({ numero_oc: numeroOc }),
      }, token);
      const json = await response.json();
      if (json.status !== 'success') throw new Error(json.message || 'Falha ao vincular PD.');
      setMsg({ tipo: 'success', texto: `${pd.numero_pd} vinculado à OC ${numeroOc}.` });
      setPdManagerTarget(null);
      carregar(q);
    } catch (error) {
      setMsg({ tipo: 'error', texto: error.message || 'Falha ao vincular PD sem OC.' });
    }
  };


  const baixarExportacao = async (endpoint, fallbackFileName) => {
    try {
      setMsg(null);
      const response = await fetch(`${API_BASE_URL}${endpoint}`, {
        method: 'GET',
        headers: buildAuthHeaders(token),
      });
      if (!response.ok) {
        let message = 'Falha ao exportar arquivo.';
        try {
          const json = await response.json();
          message = json.message || message;
        } catch {
          // O backend pode devolver erro sem corpo JSON; mantém a mensagem padrão.
        }
        setMsg({ tipo: 'error', texto: message });
        return;
      }
      const blob = await response.blob();
      const disposition = response.headers.get('Content-Disposition') || '';
      const match = disposition.match(/filename="?([^";]+)"?/i);
      const fileName = match?.[1] || fallbackFileName;
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = fileName;
      document.body.appendChild(a);
      a.click();
      a.remove();
      window.URL.revokeObjectURL(url);
      setMsg({ tipo: 'success', texto: 'Exportação gerada com sucesso.' });
    } catch {
      setMsg({ tipo: 'error', texto: 'Falha ao exportar arquivo.' });
    }
  };

  const formatDateLabel = (value) => {
    if (!value) return 'Data não informada';
    return String(value).slice(0, 10).split('-').reverse().join('/');
  };

  const renderSuplementacoes = (suplementacoes = [], moedaFallback = 'USD', onRetificar = null) => {
    const rows = (suplementacoes || []).filter(Boolean);
    if (rows.length === 0) return null;
    return (
      <div className="space-y-3">
        <h4 className="text-xs font-black uppercase tracking-[0.2em] text-slate-500">Suplementações registradas</h4>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {rows.map((sup, index) => {
            const moeda = String(sup.moeda || moedaFallback || 'USD').toUpperCase();
            const legado = moeda !== 'USD';
            const historico = sup.ativo === false;
            return (
              <div key={sup.id || `${sup.msg_referencia}-${sup.valor}-${sup.data_msg}`} className={`p-4 rounded-2xl border shadow-sm ${historico ? 'bg-slate-50/80 dark:bg-slate-950/30 border-slate-200 dark:border-slate-700 opacity-80' : legado ? 'bg-amber-50/70 dark:bg-amber-950/20 border-amber-200 dark:border-amber-900/50' : 'bg-blue-50/60 dark:bg-blue-950/20 border-blue-100 dark:border-blue-900/40'}`}>
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <div className="flex items-center gap-2 flex-wrap">
                      <p className="text-[10px] font-black uppercase tracking-wider text-slate-500">Suplementação {index + 1}</p>
                      {historico && <Badge>HISTÓRICO / RETIFICADO</Badge>}
                      {!historico && legado && <Badge amber>LEGADO {moeda}</Badge>}
                    </div>
                    <p className="text-sm font-black text-slate-900 dark:text-white break-all mt-1">{sup.msg_referencia || 'MSG / referência não informada'}</p>
                  </div>
                  <p className={`text-sm font-black whitespace-nowrap ${legado ? 'text-amber-700 dark:text-amber-300' : 'text-blue-700 dark:text-blue-300'}`}>{formatMoney(sup.valor, moeda)}</p>
                </div>
                <div className="mt-3 grid grid-cols-1 sm:grid-cols-2 gap-2 text-[11px] font-bold text-slate-600 dark:text-slate-300">
                  <span>Data MSG: {formatDateLabel(sup.data_msg)}</span>
                  <span>Moeda registrada: {moeda}</span>
                  {sup.created_at && <span>Cadastrado: {formatDateLabel(sup.created_at)}</span>}
                </div>
                {historico && <p className="mt-3 text-[11px] font-bold text-slate-500 dark:text-slate-400">Registro anterior preservado para auditoria. Não participa dos cálculos atuais.</p>}
                {!historico && legado && <p className="mt-3 text-[11px] font-bold text-amber-700 dark:text-amber-300">Registro legado em {moeda}. Não é somado ao progresso operacional USD até ser retificado.</p>}
                {sup.observacao && <p className="mt-3 text-xs font-bold text-slate-700 dark:text-slate-200 bg-white/70 dark:bg-slate-900/50 border border-slate-200 dark:border-slate-700 rounded-xl px-3 py-2">Obs: {sup.observacao}</p>}
                {isAdmin && onRetificar && !historico && <div className="mt-3 flex justify-end"><button type="button" onClick={() => onRetificar(sup)} className="px-3 py-2 rounded-xl bg-slate-700 text-white font-black text-[10px] hover:bg-slate-600 flex items-center gap-2"><Pencil size={12} /> RETIFICAR</button></div>}
              </div>
            );
          })}
        </div>
      </div>
    );
  };


  const cancelarOc = async (ordem) => {
    const motivo = window.prompt(`Motivo do cancelamento da OC ${ordem.numero_oc}:`);
    if (!motivo) return;
    const response = await apiFetch(`/purchases/ordens/${ordem.id}`, {
      method: 'PUT',
      headers: buildAuthHeaders(token, { 'Content-Type': 'application/json' }),
      body: JSON.stringify({ status: 'CAN', motivo_cancelamento: motivo }),
    }, token);
    const json = await response.json();
    setMsg({ tipo: json.status === 'success' ? 'success' : 'error', texto: json.message });
    carregar(q);
  };

  const excluir = async (tipo, id) => {
    const ok = window.confirm('Confirmar exclusão lógica? O histórico será preservado.');
    if (!ok) return;
    const endpoint = tipo === 'oc' ? `/purchases/ordens/${id}` : `/purchases/work-orders/${id}`;
    const response = await apiFetch(endpoint, { method: 'DELETE' }, token);
    const json = await response.json();
    setMsg({ tipo: json.status === 'success' ? 'success' : 'error', texto: json.message });
    carregar(q);
  };


  const reconciliarPdsExistentes = async () => {
    if (!isAdmin) return;
    const ok = window.confirm('Reconciliar agora todos os PDs já existentes com os Recibos ativos e o Order Book? O processo é idempotente, atualiza somente o mesmo PD e não altera os estágios próprios do Order Book.');
    if (!ok) return;
    try {
      setMsg({ tipo: 'success', texto: 'Reconciliando PDs existentes...' });
      const response = await apiFetch('/purchases/pds/reconcile-existing-lifecycle', {
        method: 'POST',
        headers: buildAuthHeaders(token, { 'Content-Type': 'application/json' }),
        body: JSON.stringify({ confirmation: 'RECONCILIAR PDS EXISTENTES' }),
      }, token);
      const json = await response.json();
      if (json.status !== 'success') throw new Error(json.message || 'Falha ao reconciliar PDs existentes.');
      const summary = json.data || {};
      const parts = [
        `${summary.alterados || 0} alterado(s)`,
        `${summary.entrega_parcial || 0} com entrega parcial`,
        `${summary.entregues || 0} entregue(s)`,
        `${summary.promovidos_oda || 0} promovido(s) para ODA`,
        summary.recibos_sem_pd_origem?.length ? `${summary.recibos_sem_pd_origem.length} referência(s) de recibo sem PD de origem` : null,
      ].filter(Boolean).join(' • ');
      setMsg({ tipo: 'success', texto: `${json.message} ${parts}.` });
      carregar(q);
    } catch (error) {
      setMsg({ tipo: 'error', texto: error.message || 'Falha ao reconciliar PDs existentes.' });
    }
  };

  const sincronizarLivroWo = async () => {
    if (!isAdmin) return;
    const ok = window.confirm('Sincronizar as WOs locais já existentes com o Livro de Eventos dos Equipamentos? O processo é idempotente e não cria equipamento nem SN por suposição.');
    if (!ok) return;
    try {
      setMsg({ tipo: 'success', texto: 'Sincronizando WOs com o Livro de Equipamentos...' });
      const response = await apiFetch('/purchases/work-orders/sync-equipment-ledger', {
        method: 'POST',
        headers: buildAuthHeaders(token, { 'Content-Type': 'application/json' }),
      }, token);
      const json = await response.json();
      if (json.status !== 'success') throw new Error(json.message || 'Falha ao sincronizar o Livro.');
      const summary = json.data?.summary || {};
      const parts = [
        summary.SYNCED ? `${summary.SYNCED} vinculada(s)` : null,
        summary.PENDING_SN ? `${summary.PENDING_SN} sem SN` : null,
        summary.EQUIPMENT_NOT_FOUND ? `${summary.EQUIPMENT_NOT_FOUND} PN+SN não cadastrado(s)` : null,
        summary.ERROR ? `${summary.ERROR} erro(s)` : null,
      ].filter(Boolean).join(' • ');
      setMsg({ tipo: 'success', texto: `${json.message}${parts ? ` ${parts}.` : ''}` });
      carregar(q);
    } catch (error) {
      setMsg({ tipo: 'error', texto: error.message || 'Falha ao sincronizar WOs com o Livro.' });
    }
  };

  const abrirEdicaoWo = (wo) => {
    setEditWoTarget(wo);
    setEditWoForm({
      numero_wo: wo.numero_wo || '', pn: wo.pn || '', nsn: wo.nsn || '', nomenclatura: wo.nomenclatura || '', sn: wo.sn || '',
      empresa: wo.codemp || wo.empresa || '', quantidade: wo.quantidade || 1, tipo_wo: wo.tipo_wo || 'PENDENTE',
      resultado_tecnico: wo.resultado_tecnico || wo.resultado || 'PENDENTE', status: wo.status || 'ELB',
      valor_total: wo.valor_total ?? '', moeda: wo.moeda || 'USD', data_abertura: String(wo.data_abertura || '').slice(0, 10),
      data_envio: String(wo.data_envio || '').slice(0, 10), data_previsao: String(wo.data_previsao || wo.data_previsao_entrega || '').slice(0, 10),
      data_retorno: String(wo.data_retorno || '').slice(0, 10), aeronave: wo.aeronave || '',
      pn_saida: wo.pn_saida || '', equipamento_codigo: wo.equipamento_codigo || '', modelo: wo.modelo || '',
      responsavel: wo.responsavel || '', observacao: wo.observacao || '',
    });
  };

  const emptyPdForm = () => ({ numero_pd: '', numero_oc: '', pn: '', nsn: '', nomenclatura: '', fabricante: '', quantidade: 1, qtd_pedida: 1, qtd_comprada: 1, qtd_faturada: 0, qtd_recebida: 0, valor_unitario: '', valor_total: '', moeda: 'USD', status: 'ELB', status_item: '', data_previsao_entrega: '', responsavel: '', observacao: '' });

  const abrirNovoPd = () => {
    setPdTarget({ id: null, novo: true });
    setPdForm(emptyPdForm());
  };

  const abrirNovoPdParaOc = (ordem) => {
    setPdTarget({ id: null, novo: true });
    setPdForm({ ...emptyPdForm(), numero_oc: ordem.numero_oc_original || ordem.numero_oc || '' });
  };

  const abrirEdicaoPd = (pd) => {
    setPdTarget(pd);
    setPdForm({
      numero_pd: pd.numero_pd || '', numero_oc: pd.numero_oc_original || pd.numero_oc || '', pn: pd.pn || '', nsn: pd.nsn || '',
      nomenclatura: pd.nomenclatura || '', fabricante: pd.fabricante || '', quantidade: pd.quantidade || pd.qtd_comprada || 1,
      qtd_pedida: pd.qtd_pedida ?? pd.quantidade ?? 1, qtd_comprada: pd.qtd_comprada ?? pd.quantidade ?? 1,
      qtd_faturada: pd.qtd_faturada ?? 0, qtd_recebida: pd.qtd_recebida ?? 0, valor_unitario: pd.valor_unitario ?? '',
      valor_total: pd.valor_total ?? '', moeda: pd.moeda || 'USD', status: pd.status || pd.status_grupo || 'ELB', status_item: pd.status_item || '',
      data_previsao_entrega: String(pd.data_previsao_entrega || pd.data_entrega || '').slice(0, 10), responsavel: pd.responsavel || '', observacao: pd.observacao || '',
    });
  };

  const salvarPd = async (event) => {
    event.preventDefault();
    if (!pdTarget) return;
    try {
      const endpoint = pdTarget.id ? `/purchases/pds/${pdTarget.id}` : '/purchases/pds';
      const response = await apiFetch(endpoint, {
        method: pdTarget.id ? 'PUT' : 'POST',
        headers: buildAuthHeaders(token, { 'Content-Type': 'application/json' }),
        body: JSON.stringify(pdForm),
      }, token);
      const json = await response.json();
      if (json.status !== 'success') throw new Error(json.message || 'Falha ao salvar PD.');
      setMsg({ tipo: 'success', texto: json.message });
      setPdTarget(null);
      setPdForm(emptyPdForm());
      carregar(q);
    } catch (error) {
      setMsg({ tipo: 'error', texto: error.message || 'Falha ao salvar PD.' });
    }
  };

  const excluirPd = async (pd) => {
    if (!window.confirm(`Excluir logicamente o PD ${pd.numero_pd}?`)) return;
    const response = await apiFetch(`/purchases/pds/${pd.id}`, { method: 'DELETE' }, token);
    const json = await response.json();
    setMsg({ tipo: json.status === 'success' ? 'success' : 'error', texto: json.message });
    if (json.status === 'success') carregar(q);
  };

  const renderPdCard = (pd) => {
    const inactive = pd.ativo === false || ['CAN', 'EXCLUIDO'].includes(pd.status);
    return (
      <article key={pd.id} className={`bg-white dark:bg-slate-800 rounded-3xl border shadow-sm p-5 space-y-4 ${inactive ? 'border-red-200 dark:border-red-900/50' : 'border-slate-200 dark:border-slate-700'}`}>
        <div className="flex flex-col lg:flex-row lg:items-start lg:justify-between gap-4">
          <div>
            <div className="flex items-center gap-2 flex-wrap">
              <h3 className="text-lg font-black text-slate-900 dark:text-white">{pd.numero_pd}</h3>
              <Badge danger={inactive} amber={pd.status_grupo === 'ODC'} green={['ODA', 'REC', 'FAT'].includes(pd.status_grupo || pd.status) || pdDeliveredQty(pd) > 0}>{pdLifecycleLabel(pd)}</Badge>
              {pd.reconciliado_order_book && <Badge green>RECONCILIADO ORDER BOOK</Badge>}
            </div>
            <p className="text-sm font-black text-slate-700 dark:text-slate-200 mt-1">PN {pd.pn} • {pd.nomenclatura || 'Sem nomenclatura'}</p>
            <p className="text-xs font-bold text-slate-500 mt-1">OC {pd.numero_oc_original || pd.numero_oc || 'Ainda não vinculada'} • Origem {pd.origem_importacao || 'SISHA'}</p>
          </div>
          {isAdmin && pd.id && <div className="flex gap-2">
            <button onClick={() => abrirEdicaoPd(pd)} className="px-4 py-2 rounded-xl bg-blue-600 text-white font-black text-xs flex items-center gap-2"><Pencil size={14} /> EDITAR / EVOLUIR</button>
            <button onClick={() => excluirPd(pd)} className="px-3 py-2 rounded-xl bg-red-600 text-white font-black text-xs"><Trash2 size={14} /></button>
          </div>}
        </div>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-xs font-bold text-slate-600 dark:text-slate-300">
          <div className="p-3 rounded-xl bg-slate-50 dark:bg-slate-900/50"><span className="block text-[9px] uppercase text-slate-400">Pedida</span>{numberBr(pd.qtd_pedida || pd.quantidade)}</div>
          <div className="p-3 rounded-xl bg-slate-50 dark:bg-slate-900/50"><span className="block text-[9px] uppercase text-slate-400">Comprada</span>{numberBr(pd.qtd_comprada || pd.quantidade)}</div>
          <div className="p-3 rounded-xl bg-slate-50 dark:bg-slate-900/50"><span className="block text-[9px] uppercase text-slate-400">Faturada</span>{numberBr(pd.qtd_faturada || 0)}</div>
          <div className="p-3 rounded-xl bg-slate-50 dark:bg-slate-900/50"><span className="block text-[9px] uppercase text-slate-400">Entrega efetiva</span><span className="font-black">{numberBr(pdDeliveredQty(pd))} un</span><span className="block text-[10px] font-bold text-slate-500">Falta {numberBr(pdMissingQty(pd))} un</span></div>
        </div>
        <div className="flex flex-wrap gap-3 text-xs font-bold text-slate-500">
          <span>Valor: {formatMoney(pd.valor_total || 0, pd.moeda || 'USD')}</span>
          <span>Ciclo do PD: ODC → ODA → {pdDeliveredQty(pd) > 0 ? `${pdLifecycleLabel(pd)} (${numberBr(pdDeliveredQty(pd))}/${numberBr(pdOrderedQty(pd))} un)` : 'aguardando entrega'}</span>
          {pd.status_item && <span>Status item da fonte: {pd.status_item}</span>}
          {pd.responsavel && <span>Responsável: {pd.responsavel}</span>}
          {pd.data_previsao_entrega && <span>Previsão: {formatDateLabel(pd.data_previsao_entrega)}</span>}
        </div>
        {pd.observacao && <p className="text-xs font-bold text-slate-600 dark:text-slate-300 bg-slate-50 dark:bg-slate-900/50 rounded-xl p-3">Obs: {pd.observacao}</p>}
      </article>
    );
  };

  const renderOcCard = (ordem) => {
    const resumo = ordem.resumo || {};
    const danger = ordem.status === 'CAN';
    const amber = ordem.status === 'ODA_RESSALVA' || ordem.status === 'ADP';
    const isOrderBook = ordem.source === 'ORDER_BOOK' || ordem.fonte === 'ORDER_BOOK' || ordem.order_book_ref;
    return (
      <div key={ordem.id} className="bg-white dark:bg-slate-800 rounded-3xl border border-slate-200 dark:border-slate-700 shadow-sm p-6 space-y-5">
        <div className="flex flex-col lg:flex-row lg:items-start lg:justify-between gap-4">
          <div>
            <div className="flex items-center gap-3 flex-wrap">
              <h3 className="text-xl font-black text-slate-900 dark:text-white uppercase">OC {ordem.numero_oc_original || ordem.numero_oc}</h3>
              <Badge danger={danger} amber={amber}>{ordem.status}</Badge>
              {resumo.totalmente_suplementada && !isOrderBook && <Badge green>SUPLEMENTAÇÃO CONCLUÍDA</Badge>}
              {isOrderBook && <Badge green>ORDER BOOK</Badge>}
              {ordem.status_mb_original && <Badge>MB: {ordem.status_mb_original}</Badge>}
            </div>
            <p className="text-sm font-bold text-slate-500 dark:text-slate-400 mt-1">{ordem.observacao || ordem.motivo_ressalva || 'Sem observação registrada.'}</p>
            <div className="mt-2 flex flex-wrap gap-2 text-[11px] font-bold text-slate-500 dark:text-slate-400">
              {ordem.codemp && <span>CODEMP {ordem.codemp}</span>}
              {ordem.razao_social && <span>{ordem.razao_social}</span>}
              {ordem.data_ack && <span>ACK {ordem.data_ack}</span>}
              {ordem.data_recebimento && <span>Receb. {ordem.data_recebimento}</span>}
              {ordem.fonte_confirmacao && <span>Fonte: {ordem.fonte_confirmacao}</span>}
            </div>
            {isOrderBook && <p className="text-xs font-black text-emerald-600 dark:text-emerald-300 mt-2 uppercase tracking-wider">Leitura importada do Order Book. Edição/correção deve ser feita pela fonte documental.</p>}
          </div>
          <div className="flex gap-2 flex-wrap">
            {isAdmin && !isOrderBook && ordem.status !== 'CAN' && <button onClick={() => abrirSuplementacao('oc', ordem)} className="px-4 py-2 rounded-xl bg-blue-600 text-white font-black text-xs hover:bg-blue-700">SUPLEMENTAÇÃO</button>}
            {isAdmin && !isOrderBook && ordem.status !== 'CAN' && <button onClick={() => setPdManagerTarget(ordem)} className="px-4 py-2 rounded-xl bg-slate-700 text-white font-black text-xs hover:bg-slate-600 flex items-center gap-2"><Link2 size={14} /> GERENCIAR PDs</button>}
            <button onClick={() => baixarExportacao(`/purchases/ordens/${encodeURIComponent(ordem.id)}/export`, `OC_${ordem.numero_oc || ordem.id}.xlsx`)} className="px-4 py-2 rounded-xl bg-slate-700 text-white font-black text-xs hover:bg-slate-600 flex items-center gap-2"><Download size={14} /> EXPORTAR</button>
            {isAdmin && !isOrderBook && <button onClick={() => setMoreTarget({ tipo: 'oc', item: ordem })} className="px-4 py-2 rounded-xl bg-slate-700 text-white font-black text-xs hover:bg-slate-600">MAIS AÇÕES</button>}
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <div className="p-4 rounded-2xl bg-slate-50 dark:bg-slate-900/40 border border-slate-100 dark:border-slate-700">
            <p className="text-[10px] uppercase font-black text-slate-400 tracking-wider">Valor da OC — USD</p>
            <p className="text-lg font-black text-slate-900 dark:text-white">{Number(resumo.valor_total_usd ?? resumo.valor_total_calculado ?? 0) > 0 ? formatMoney(resumo.valor_total_usd ?? resumo.valor_total_calculado, 'USD') : 'USD não informado'}</p>
            {Number(resumo.valor_total_gbp || ordem.valor_total_gbp || 0) > 0 && <p className="text-[10px] font-bold text-slate-500 mt-1">Referência GBP preservada: {formatMoney(resumo.valor_total_gbp || ordem.valor_total_gbp, 'GBP')}</p>}
          </div>
          <div className="p-4 rounded-2xl bg-slate-50 dark:bg-slate-900/40 border border-slate-100 dark:border-slate-700"><p className="text-[10px] uppercase font-black text-slate-400 tracking-wider">Suplementado — USD</p><p className="text-lg font-black text-blue-600 dark:text-blue-300">{formatMoney(resumo.valor_suplementado, 'USD')}</p></div>
          <div className="p-4 rounded-2xl bg-slate-50 dark:bg-slate-900/40 border border-slate-100 dark:border-slate-700"><p className="text-[10px] uppercase font-black text-slate-400 tracking-wider">Falta — USD</p><p className="text-lg font-black text-amber-600 dark:text-amber-300">{formatMoney(resumo.saldo_restante, 'USD')}</p></div>
        </div>

        {Number(resumo.suplementacoes_legadas || 0) > 0 && <div className="rounded-2xl border border-amber-200 dark:border-amber-900/50 bg-amber-50 dark:bg-amber-950/20 px-4 py-3 text-xs font-bold text-amber-800 dark:text-amber-200">Existem {resumo.suplementacoes_legadas} suplementação(ões) legada(s) fora de USD. Elas permanecem auditáveis, mas não entram no progresso USD até retificação.</div>}

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <div className="space-y-2">
            <div className="flex justify-between text-xs font-black uppercase text-slate-500 dark:text-slate-400"><span>{isOrderBook ? 'Progresso de aprovação / Order Book' : 'Progresso de suplementação USD'}</span><span>{resumo.percentual_suplementado || 0}%</span></div>
            <ProgressBar percent={resumo.percentual_suplementado} />
          </div>
          <div className="space-y-2">
            <div className="flex justify-between text-xs font-black uppercase text-slate-500 dark:text-slate-400"><span>Completude dos PDs vinculados</span><span>{resumo.pds_anexados || 0}/{resumo.qtde_se_informada || (ordem.compras_pds || []).length || 0} • {resumo.percentual_pds_anexados || 0}%</span></div>
            <ProgressBar percent={resumo.percentual_pds_anexados} />
          </div>
        </div>

        {renderSuplementacoes(ordem.compras_suplementacoes, 'USD')}

        <div className="space-y-3">
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <h4 className="text-xs font-black uppercase tracking-[0.2em] text-slate-500">PD/SEPD vinculados</h4>
            {isAdmin && !isOrderBook && <button onClick={() => setPdManagerTarget(ordem)} className="text-[10px] font-black uppercase text-blue-600 dark:text-blue-300">Gerenciar nesta OC</button>}
          </div>
          {(ordem.compras_pds || []).length > 0 ? (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              {ordem.compras_pds.map((pd) => (
                <div key={pd.id} className={`p-4 rounded-2xl border ${pd.status === 'CAN' || pd.ativo === false ? 'border-red-200 dark:border-red-900/50 bg-red-50/50 dark:bg-red-950/10' : 'border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-900/40'}`}>
                  <div className="flex items-center justify-between gap-3"><p className="font-black text-slate-900 dark:text-white">{pd.numero_pd}</p><Badge danger={pd.status === 'CAN' || pd.ativo === false}>{pd.status_grupo || pd.status}</Badge></div>
                  <p className="text-sm font-bold text-slate-600 dark:text-slate-300">PN {pd.pn} • Qtd {numberBr(pd.qtd_comprada || pd.quantidade)}</p>
                  <p className="text-xs text-slate-500 dark:text-slate-400 truncate">{pd.nomenclatura || 'Sem nomenclatura'}</p>
                  <div className="mt-2 grid grid-cols-2 gap-2 text-[11px] font-bold text-slate-500 dark:text-slate-400">
                    <span>Pedida: {numberBr(pd.qtd_pedida || pd.quantidade)}</span>
                    <span>Recebida: {numberBr(pd.qtd_recebida || 0)}</span>
                    <span>GBP: {formatMoney(pd.valor_total_gbp || 0, 'GBP')}</span>
                    <span>USD: {formatMoney(pd.valor_total_usd || (String(pd.moeda).toUpperCase() === 'USD' ? pd.valor_total : 0), 'USD')}</span>
                  </div>
                </div>
              ))}
            </div>
          ) : <p className="text-sm font-bold text-slate-500">Nenhum PD vinculado nesta OC.</p>}
        </div>
      </div>
    );
  };

  const renderWoCard = (wo) => {
    const resumo = wo.resumo || {};
    const isOrderBook = wo.source === 'ORDER_BOOK_REPAIR' || wo.order_book_ref;
    const snPendente = !wo.sn || wo.sn_pendente;
    const trace = wo.equipment_trace || {};
    return (
      <div key={wo.id} className="bg-white dark:bg-slate-800 rounded-3xl border border-slate-200 dark:border-slate-700 shadow-sm p-6 space-y-5">
        <div className="flex flex-col lg:flex-row lg:items-start lg:justify-between gap-4">
          <div>
            <div className="flex items-center gap-3 flex-wrap">
              <h3 className="text-xl font-black text-slate-900 dark:text-white uppercase">WO {wo.numero_wo}</h3>
              <Badge amber={wo.status === 'EMB' || wo.status === 'REC'} green={wo.status === 'FAT'}>{wo.status}</Badge>
              {resumo.totalmente_suplementada && !isOrderBook && <Badge green>SUPLEMENTAÇÃO CONCLUÍDA</Badge>}
              {snPendente && <Badge amber>SN PENDENTE</Badge>}
              {trace.status === 'LINKED' && <Badge green>LIVRO VINCULADO</Badge>}
              {trace.status === 'EQUIPMENT_NOT_FOUND' && <Badge amber>PN+SN NÃO CADASTRADO</Badge>}
              {isOrderBook && <Badge green>ORDER BOOK</Badge>}
            </div>
            <p className="text-sm font-bold text-slate-500 dark:text-slate-400 mt-1">PN {wo.pn} • SN {wo.sn || 'Pendente'} • {wo.codemp || wo.empresa || 'Empresa não informada'}</p>
            <p className="text-sm font-black text-slate-700 dark:text-slate-200 mt-1">{wo.nomenclatura || 'Nomenclatura pendente'}</p>
            <div className="mt-2 flex flex-wrap gap-2 text-[11px] font-bold text-slate-500 dark:text-slate-400">
              {wo.tipo_wo && wo.tipo_wo !== 'PENDENTE' && <span>Tipo WO: {wo.tipo_wo}</span>}
              <span>Resultado técnico: {wo.resultado_tecnico || wo.resultado || 'PENDENTE'}</span>
              {wo.responsavel && <span>Resp: {wo.responsavel}</span>}
              {wo.data_previsao_entrega && <span>Previsão: {wo.data_previsao_entrega}</span>}
            </div>
            {wo.observacao && <p className="mt-2 text-xs font-bold text-slate-600 dark:text-slate-300 bg-slate-100 dark:bg-slate-900/50 border border-slate-200 dark:border-slate-700 rounded-xl px-3 py-2">Obs: {wo.observacao}</p>}
          </div>
          <div className="flex gap-2 flex-wrap">
            {isAdmin && !isOrderBook && <button onClick={() => abrirSuplementacao('wo', wo)} className="px-4 py-2 rounded-xl bg-blue-600 text-white font-black text-xs hover:bg-blue-700">SUPLEMENTAÇÃO</button>}
            {isAdmin && !isOrderBook && <button onClick={() => abrirEdicaoWo(wo)} className="px-4 py-2 rounded-xl bg-slate-700 text-white font-black text-xs hover:bg-slate-600 flex items-center gap-2"><Pencil size={14} /> EDITAR WO</button>}
            <button onClick={() => baixarExportacao(`/purchases/work-orders/${encodeURIComponent(wo.id)}/export`, `WO_${wo.numero_wo || wo.id}.xlsx`)} className="px-4 py-2 rounded-xl bg-slate-700 text-white font-black text-xs hover:bg-slate-600 flex items-center gap-2"><Download size={14} /> EXPORTAR</button>
            {isAdmin && !isOrderBook && <button onClick={() => setMoreTarget({ tipo: 'wo', item: wo })} className="px-4 py-2 rounded-xl bg-slate-700 text-white font-black text-xs hover:bg-slate-600">MAIS AÇÕES</button>}
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <div className="p-4 rounded-2xl bg-slate-50 dark:bg-slate-900/40 border border-slate-100 dark:border-slate-700"><p className="text-[10px] uppercase font-black text-slate-400 tracking-wider">Valor da WO — USD</p><p className="text-lg font-black text-slate-900 dark:text-white">{formatMoney(resumo.valor_total_usd ?? resumo.valor_total_calculado, 'USD')}</p></div>
          <div className="p-4 rounded-2xl bg-slate-50 dark:bg-slate-900/40 border border-slate-100 dark:border-slate-700"><p className="text-[10px] uppercase font-black text-slate-400 tracking-wider">Suplementado — USD</p><p className="text-lg font-black text-blue-600 dark:text-blue-300">{formatMoney(resumo.valor_suplementado, 'USD')}</p></div>
          <div className="p-4 rounded-2xl bg-slate-50 dark:bg-slate-900/40 border border-slate-100 dark:border-slate-700"><p className="text-[10px] uppercase font-black text-slate-400 tracking-wider">Falta — USD</p><p className="text-lg font-black text-amber-600 dark:text-amber-300">{formatMoney(resumo.saldo_restante, 'USD')}</p></div>
        </div>

        {Number(resumo.suplementacoes_legadas || 0) > 0 && <div className="rounded-2xl border border-amber-200 dark:border-amber-900/50 bg-amber-50 dark:bg-amber-950/20 px-4 py-3 text-xs font-bold text-amber-800 dark:text-amber-200">Há suplementação legada fora de USD. Ela permanece no histórico e não é somada ao progresso USD até retificação.</div>}
        <div className="space-y-2"><div className="flex justify-between text-xs font-black uppercase text-slate-500 dark:text-slate-400"><span>Progresso de suplementação USD</span><span>{resumo.percentual_suplementado || 0}%</span></div><ProgressBar percent={resumo.percentual_suplementado} /></div>
        {renderSuplementacoes(wo.work_order_suplementacoes, 'USD')}
      </div>
    );
  };


  return (
    <div className="space-y-8 animate-fade-in">
      <input ref={ocUploadRef} type="file" accept=".xls,.xlsx,.csv,.ods" className="hidden" onChange={(e) => { const file = e.target.files?.[0]; e.target.value = ''; uploadFile('/purchases/ordens/import', file, 'OCs importadas.'); }} />
      <input ref={pdPipelineUploadRef} type="file" accept=".xls,.xlsx,.csv,.ods" className="hidden" onChange={(e) => { const file = e.target.files?.[0]; e.target.value = ''; uploadFile('/purchases/pds-pipeline/import', file, 'PDs sem OC importados/atualizados.'); }} />
      <input ref={pdsDaOcUploadRef} type="file" accept=".xls,.xlsx,.csv,.ods" className="hidden" onChange={(e) => { const file = e.target.files?.[0]; e.target.value = ''; if (pdsUploadTarget?.id) uploadFile(`/purchases/ordens/${pdsUploadTarget.id}/pds/import`, file, 'PDs anexados à OC.'); }} />
      <input ref={woUploadRef} type="file" accept=".xls,.xlsx,.csv,.ods" className="hidden" onChange={(e) => { const file = e.target.files?.[0]; e.target.value = ''; uploadFile('/purchases/work-orders/import', file, 'WOs importadas.'); }} />

      <section className="bg-white dark:bg-slate-800 rounded-3xl p-6 border border-slate-200 dark:border-slate-700 shadow-sm space-y-5">
        <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-4">
          <div>
            <h2 className="text-2xl font-black text-slate-900 dark:text-white uppercase">Ordens de Compra e WO</h2>
            <p className="text-sm font-bold text-slate-500 dark:text-slate-400">Consulta, importação, gestão de PDs sem OC, edição segura e suplementações auditáveis de OC e WO.</p>
          </div>
          {isAdmin && (
            <div className="flex flex-wrap gap-3">
              <button onClick={() => setActionMenu('oc')} className="px-5 py-3 rounded-2xl bg-blue-600 text-white font-black hover:bg-blue-700 flex items-center gap-2"><ShoppingCart size={18} /> NOVA / IMPORTAR OC</button>
              <button onClick={() => setActionMenu('wo')} className="px-5 py-3 rounded-2xl bg-slate-700 text-white font-black hover:bg-slate-600 flex items-center gap-2"><Wrench size={18} /> NOVA / IMPORTAR WO</button>
            </div>
          )}
        </div>

        <div className="flex flex-col lg:flex-row gap-3">
          <div className="flex gap-2 p-1 bg-slate-100 dark:bg-slate-900 rounded-2xl">
            <button onClick={() => setTab('oc')} className={`px-5 py-3 rounded-xl font-black text-sm flex items-center gap-2 ${tab === 'oc' ? 'bg-blue-600 text-white' : 'text-slate-600 dark:text-slate-300'}`}><ShoppingCart size={16} /> OC / ODC</button>
            <button onClick={() => setTab('wo')} className={`px-5 py-3 rounded-xl font-black text-sm flex items-center gap-2 ${tab === 'wo' ? 'bg-blue-600 text-white' : 'text-slate-600 dark:text-slate-300'}`}><Wrench size={16} /> WO / REPAROS</button>
          </div>
          <div className="flex-1 flex gap-3">
            <input value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') carregar(q); }} placeholder="Pesquisar por OC, PD, PN, nomenclatura, WO, SN, empresa ou status" className="flex-1 p-3 rounded-2xl border-2 border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 font-bold text-slate-900 dark:text-white placeholder:text-slate-400" />
            <button onClick={carregar} className="px-5 py-3 rounded-2xl bg-blue-600 text-white font-black hover:bg-blue-700 flex items-center gap-2"><Search size={18} /> Buscar</button>
            <button onClick={() => { setQ(''); setTimeout(carregar, 0); }} className="px-4 py-3 rounded-2xl bg-slate-200 dark:bg-slate-700 text-slate-900 dark:text-white font-black"><RefreshCcw size={18} /></button>
          </div>
        </div>

        {msg && <p className={`font-black ${msg.tipo === 'success' ? 'text-green-600' : 'text-red-600'}`}>{msg.texto}</p>}
      </section>

      {tab === 'oc' && (
        <section className="space-y-5">
          {isAdmin && <div className="flex justify-end"><button onClick={reconciliarPdsExistentes} className="px-4 py-2 rounded-xl bg-slate-900 text-white font-black text-xs flex items-center gap-2" title="Recalcula os PDs já cadastrados usando Recibos ativos e presença no Order Book, sem criar outro PD."><RefreshCcw size={14} /> RECONCILIAR PDs EXISTENTES</button></div>}
          <div className="grid grid-cols-1 md:grid-cols-3 xl:grid-cols-5 gap-3">
            <SummaryMiniCard title="ELB" value={pdPipeline.elaboracao || 0} subtitle="PDs em elaboração" />
            <SummaryMiniCard title="TRI / ANS" value={pdPipeline.triagem_analise || 0} subtitle="Triagem e análise" />
            <SummaryMiniCard title="COT / LPC" value={pdPipeline.cotacao_lpc || 0} subtitle="Cotação e liberação" />
            <SummaryMiniCard title="PD sem OC" value={pdPipeline.sem_oc || 0} subtitle="Ainda sem vínculo com OC" />
            <SummaryMiniCard title="ODC" value={pdPipeline.odc || 0} subtitle="Com OC, ainda não promovidos a ODA" />
            <SummaryMiniCard title="ODA / FAT / EMB" value={pdPipeline.oda || 0} subtitle="Aprovados/avançados, ainda sem recebimento" />
            <SummaryMiniCard title="ENTREGA PARCIAL" value={pdPipeline.entrega_parcial || 0} subtitle="Recebido em parte; ainda há saldo" />
            <SummaryMiniCard title="ENTREGUE" value={pdPipeline.entregue || 0} subtitle="Quantidade recebida atingiu o pedido" />
            <SummaryMiniCard title="CAN" value={pdPipeline.cancelados || 0} subtitle="Cancelados / excluídos logicamente" />
          </div>
          {loading ? <p className="font-black text-slate-500">Carregando...</p> : null}
          {ocAtivas.map(renderOcCard)}
          {ocCanceladas.length > 0 && <h3 className="text-xs font-black uppercase tracking-[0.2em] text-red-500 pt-4">Canceladas — histórico preservado</h3>}
          {ocCanceladas.map(renderOcCard)}
          {!loading && ordens.length === 0 && <p className="font-black text-slate-500">Nenhuma OC localizada.</p>}
        </section>
      )}



      {tab === 'wo' && (
        <section className="space-y-5">
          {isAdmin && <div className="flex justify-end"><button onClick={sincronizarLivroWo} className="px-4 py-2 rounded-xl bg-slate-900 text-white font-black text-xs flex items-center gap-2" title="Reprocessa as WOs locais antigas de forma idempotente e liga PN+SN já cadastrados ao Livro de Eventos."><Link2 size={14} /> SINCRONIZAR LIVRO</button></div>}
          {loading ? <p className="font-black text-slate-500">Carregando...</p> : null}
          {wos.map(renderWoCard)}
          {!loading && wos.length === 0 && <p className="font-black text-slate-500">Nenhuma WO localizada.</p>}
        </section>
      )}

      {actionMenu && (
        <div className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-4">
          <div className={`${modalPanelClass} max-w-xl`}>
            <div className="flex items-start justify-between gap-4">
              <div><h3 className="text-xl font-black uppercase">{actionMenu === 'oc' ? 'Nova / Importar OC' : 'Nova / Importar WO'}</h3><p className="text-sm font-bold text-slate-500 dark:text-slate-400 mt-1">Escolha apenas a ação que deseja executar.</p></div>
              <button type="button" onClick={() => setActionMenu(null)} className="px-3 py-2 rounded-xl bg-slate-200 dark:bg-slate-800 font-black">FECHAR</button>
            </div>
            {actionMenu === 'oc' ? (
              <div className="grid grid-cols-1 gap-3">
                <button type="button" onClick={() => { setActionMenu(null); setModalOc(true); }} className="p-4 rounded-2xl bg-blue-600 text-white font-black text-left"><PlusCircle size={18} className="inline mr-2" /> Criar nova OC manualmente</button>
                <button type="button" onClick={() => { setActionMenu(null); setTimeout(() => ocUploadRef.current?.click(), 0); }} className="p-4 rounded-2xl bg-slate-700 text-white font-black text-left"><Upload size={18} className="inline mr-2" /> Importar documento com OCs</button>
                <button type="button" onClick={() => { setActionMenu(null); setTimeout(() => pdPipelineUploadRef.current?.click(), 0); }} className="p-4 rounded-2xl bg-slate-700 text-white font-black text-left"><FileSpreadsheet size={18} className="inline mr-2" /> Importar PDs sem OC</button>
              </div>
            ) : (
              <div className="grid grid-cols-1 gap-3">
                <button type="button" onClick={() => { setActionMenu(null); setModalWo(true); }} className="p-4 rounded-2xl bg-blue-600 text-white font-black text-left"><PlusCircle size={18} className="inline mr-2" /> Criar nova WO manualmente</button>
                <button type="button" onClick={() => { setActionMenu(null); setTimeout(() => woUploadRef.current?.click(), 0); }} className="p-4 rounded-2xl bg-slate-700 text-white font-black text-left"><Upload size={18} className="inline mr-2" /> Importar documento com WOs</button>
              </div>
            )}
          </div>
        </div>
      )}

      {pdManagerTarget && (
        <div className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-4">
          <div className={`${modalPanelClass} max-w-6xl max-h-[92vh] overflow-auto`}>
            <div className="flex flex-col lg:flex-row lg:items-start lg:justify-between gap-4">
              <div><h3 className="text-xl font-black uppercase">Gerenciar PDs — OC {pdManagerTarget.numero_oc_original || pdManagerTarget.numero_oc}</h3><p className="text-sm font-bold text-slate-500 dark:text-slate-400 mt-1">Edite somente os PDs desta OC ou vincule um PD que ainda está sem OC.</p></div>
              <div className="flex flex-wrap gap-2">
                <button type="button" onClick={() => abrirNovoPdParaOc(pdManagerTarget)} className="px-4 py-2 rounded-xl bg-blue-600 text-white font-black text-xs"><PlusCircle size={14} className="inline mr-1" /> ADICIONAR PD</button>
                <button type="button" onClick={() => { setPdsUploadTarget(pdManagerTarget); setTimeout(() => pdsDaOcUploadRef.current?.click(), 0); }} className="px-4 py-2 rounded-xl bg-slate-700 text-white font-black text-xs"><Upload size={14} className="inline mr-1" /> IMPORTAR PDs DESTA OC</button>
                <button type="button" onClick={() => pdPipelineUploadRef.current?.click()} className="px-4 py-2 rounded-xl bg-slate-700 text-white font-black text-xs"><FileSpreadsheet size={14} className="inline mr-1" /> IMPORTAR PDs SEM OC</button>
                <button type="button" onClick={() => setPdManagerTarget(null)} className="px-4 py-2 rounded-xl bg-slate-200 dark:bg-slate-800 font-black text-xs">FECHAR</button>
              </div>
            </div>

            <div className="space-y-3">
              <h4 className="text-xs font-black uppercase tracking-[0.2em] text-slate-500">PDs vinculados a esta OC</h4>
              {(pdManagerTarget.compras_pds || []).length > 0 ? (pdManagerTarget.compras_pds || []).map((pd) => (
                <div key={pd.id} className="p-4 rounded-2xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 flex flex-col md:flex-row md:items-center md:justify-between gap-3">
                  <div><p className="font-black">{pd.numero_pd} • PN {pd.pn}</p><p className="text-xs font-bold text-slate-500">{pd.nomenclatura || 'Sem nomenclatura'} • {pd.status_grupo || pd.status}</p></div>
                  <button type="button" onClick={() => abrirEdicaoPd(pd)} className="px-4 py-2 rounded-xl bg-slate-700 text-white font-black text-xs"><Pencil size={14} className="inline mr-1" /> EDITAR</button>
                </div>
              )) : <p className="text-sm font-bold text-slate-500">Nenhum PD vinculado.</p>}
            </div>

            <div className="space-y-3 pt-3 border-t border-slate-200 dark:border-slate-800">
              <div className="flex items-center justify-between gap-3"><h4 className="text-xs font-black uppercase tracking-[0.2em] text-slate-500">PDs sem OC disponíveis para vínculo</h4><Badge amber>{pds.filter((pd) => pd.ativo !== false && !pd.ordem_id && !['CAN', 'EXCLUIDO'].includes(pd.status)).length}</Badge></div>
              {pds.filter((pd) => pd.ativo !== false && !pd.ordem_id && !['CAN', 'EXCLUIDO'].includes(pd.status)).slice(0, 250).map((pd) => (
                <div key={pd.id} className="p-4 rounded-2xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 flex flex-col md:flex-row md:items-center md:justify-between gap-3">
                  <div><p className="font-black">{pd.numero_pd} • PN {pd.pn}</p><p className="text-xs font-bold text-slate-500">{pd.status_grupo || pd.status} • USD {numberBr(pd.valor_total_usd || (String(pd.moeda).toUpperCase() === 'USD' ? pd.valor_total : 0))}</p></div>
                  <button type="button" onClick={() => vincularPdSemOc(pd)} className="px-4 py-2 rounded-xl bg-blue-600 text-white font-black text-xs"><Link2 size={14} className="inline mr-1" /> VINCULAR A ESTA OC</button>
                </div>
              ))}
              {pds.filter((pd) => pd.ativo !== false && !pd.ordem_id && !['CAN', 'EXCLUIDO'].includes(pd.status)).length === 0 && <p className="text-sm font-bold text-slate-500">Nenhum PD sem OC disponível.</p>}
            </div>
          </div>
        </div>
      )}

      {moreTarget && (
        <div className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-4">
          <div className={`${modalPanelClass} max-w-md`}>
            <h3 className="text-lg font-black uppercase">Mais ações — {moreTarget.tipo === 'oc' ? `OC ${moreTarget.item.numero_oc}` : `WO ${moreTarget.item.numero_wo}`}</h3>
            <p className="text-sm font-bold text-slate-500 dark:text-slate-400">Ações destrutivas ficam separadas das operações de rotina.</p>
            <div className="grid gap-3">
              {moreTarget.tipo === 'oc' && moreTarget.item.status !== 'CAN' && <button type="button" onClick={() => { const item = moreTarget.item; setMoreTarget(null); cancelarOc(item); }} className="p-3 rounded-xl bg-slate-700 text-white font-black"><Ban size={14} className="inline mr-2" /> CANCELAR OC</button>}
              <button type="button" onClick={() => { const { tipo, item } = moreTarget; setMoreTarget(null); excluir(tipo, item.id); }} className="p-3 rounded-xl bg-red-600 text-white font-black"><Trash2 size={14} className="inline mr-2" /> EXCLUIR LOGICAMENTE</button>
              <button type="button" onClick={() => setMoreTarget(null)} className="p-3 rounded-xl bg-slate-200 dark:bg-slate-800 font-black">VOLTAR</button>
            </div>
          </div>
        </div>
      )}

      {pdTarget && (
        <div className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-4">
          <form onSubmit={salvarPd} className={`${modalPanelClass} max-w-5xl max-h-[92vh] overflow-auto`}>
            <h3 className="text-xl font-black text-slate-900 dark:text-white uppercase">{pdTarget.id ? `Editar / Evoluir ${pdTarget.numero_pd}` : 'Cadastrar PD / SEPD'}</h3>
            <p className="text-sm font-bold text-slate-600 dark:text-slate-300">A alteração de status fica registrada no histórico do PD. ODA, REC e FAT deixam de contar como ODC.</p>
            <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
              <label><span className={modalLabelClass}>Número do PD</span><input required value={pdForm.numero_pd} onChange={(e) => setPdForm({ ...pdForm, numero_pd: e.target.value })} className={modalInputClass} /></label>
              <label><span className={modalLabelClass}>OC vinculada</span><input value={pdForm.numero_oc} onChange={(e) => setPdForm({ ...pdForm, numero_oc: e.target.value })} className={modalInputClass} /></label>
              <label><span className={modalLabelClass}>PN</span><input required value={pdForm.pn} onChange={(e) => setPdForm({ ...pdForm, pn: e.target.value })} className={modalInputClass} /></label>
              <label><span className={modalLabelClass}>NSN / PI</span><input value={pdForm.nsn} onChange={(e) => setPdForm({ ...pdForm, nsn: e.target.value })} className={modalInputClass} /></label>
              <label className="md:col-span-2"><span className={modalLabelClass}>Nomenclatura</span><input value={pdForm.nomenclatura} onChange={(e) => setPdForm({ ...pdForm, nomenclatura: e.target.value })} className={modalInputClass} /></label>
              <label><span className={modalLabelClass}>Fabricante</span><input value={pdForm.fabricante} onChange={(e) => setPdForm({ ...pdForm, fabricante: e.target.value })} className={modalInputClass} /></label>
              <label><span className={modalLabelClass}>Status</span><select value={pdForm.status} onChange={(e) => setPdForm({ ...pdForm, status: e.target.value })} className={modalSelectClass}><option>ELB</option><option>TRI</option><option>ANS</option><option>COT</option><option>PRO</option><option>LPC</option><option>ODC</option><option>ODA</option><option>EMB</option><option>REC</option><option>FAT</option><option>CAN</option></select></label>
              <label><span className={modalLabelClass}>Qtd pedida</span><input type="number" step="0.01" value={pdForm.qtd_pedida} onChange={(e) => setPdForm({ ...pdForm, qtd_pedida: e.target.value, quantidade: e.target.value })} className={modalInputClass} /></label>
              <label><span className={modalLabelClass}>Qtd comprada</span><input type="number" step="0.01" value={pdForm.qtd_comprada} onChange={(e) => setPdForm({ ...pdForm, qtd_comprada: e.target.value, quantidade: e.target.value })} className={modalInputClass} /></label>
              <label><span className={modalLabelClass}>Qtd faturada</span><input type="number" step="0.01" value={pdForm.qtd_faturada} onChange={(e) => setPdForm({ ...pdForm, qtd_faturada: e.target.value })} className={modalInputClass} /></label>
              <label><span className={modalLabelClass}>Qtd recebida</span><input type="number" step="0.01" value={pdForm.qtd_recebida} onChange={(e) => setPdForm({ ...pdForm, qtd_recebida: e.target.value })} className={modalInputClass} /></label>
              <label><span className={modalLabelClass}>Valor unitário</span><input value={pdForm.valor_unitario} onChange={(e) => setPdForm({ ...pdForm, valor_unitario: e.target.value })} className={modalInputClass} /></label>
              <label><span className={modalLabelClass}>Valor total</span><input value={pdForm.valor_total} onChange={(e) => setPdForm({ ...pdForm, valor_total: e.target.value })} className={modalInputClass} /></label>
              <label><span className={modalLabelClass}>Moeda</span><input value={pdForm.moeda} onChange={(e) => setPdForm({ ...pdForm, moeda: e.target.value })} className={modalInputClass} /></label>
              <label><span className={modalLabelClass}>Previsão de entrega</span><input type="date" value={pdForm.data_previsao_entrega} onChange={(e) => setPdForm({ ...pdForm, data_previsao_entrega: e.target.value })} className={modalInputClass} /></label>
              <label className="md:col-span-2"><span className={modalLabelClass}>Status do item</span><input value={pdForm.status_item} onChange={(e) => setPdForm({ ...pdForm, status_item: e.target.value })} className={modalInputClass} /></label>
              <label className="md:col-span-2"><span className={modalLabelClass}>Responsável</span><input value={pdForm.responsavel} onChange={(e) => setPdForm({ ...pdForm, responsavel: e.target.value })} className={modalInputClass} /></label>
            </div>
            <label><span className={modalLabelClass}>Observações</span><textarea value={pdForm.observacao} onChange={(e) => setPdForm({ ...pdForm, observacao: e.target.value })} className={modalTextAreaClass} /></label>
            <div className="flex justify-end gap-3"><button type="button" onClick={() => setPdTarget(null)} className="px-6 py-3 rounded-xl bg-slate-200 text-slate-900 font-black">Cancelar</button><button type="submit" className="px-6 py-3 rounded-xl bg-blue-600 text-white font-black">Salvar PD</button></div>
          </form>
        </div>
      )}

      {modalOc && (
        <div className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-4">
          <form onSubmit={salvarOc} className="bg-white dark:bg-slate-900 rounded-3xl p-8 w-full max-w-5xl max-h-[90vh] overflow-auto space-y-5">
            <h3 className="text-xl font-black text-slate-900 dark:text-white uppercase">Cadastrar OC / ODC</h3>
            <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
              <input required value={ocForm.numero_oc} onChange={(e) => setOcForm({ ...ocForm, numero_oc: e.target.value })} placeholder="OC: P2026-0001" className={modalInputClass} />
              <select value={ocForm.status} onChange={(e) => setOcForm({ ...ocForm, status: e.target.value })} className={modalSelectClass}><option>ELB</option><option>ODC</option><option>ODA</option><option>ODA_RESSALVA</option><option>ADP</option><option>REC</option><option>CAN</option></select>
              <input value="USD" readOnly className={`${modalInputClass} opacity-75 cursor-not-allowed`} />
              <input value={ocForm.valor_total} onChange={(e) => setOcForm({ ...ocForm, valor_total: e.target.value })} placeholder="Valor total USD" className={modalInputClass} />
            </div>
            <textarea value={ocForm.observacao} onChange={(e) => setOcForm({ ...ocForm, observacao: e.target.value })} placeholder="Observação da OC" className="w-full p-3 rounded-xl border-2 font-bold text-slate-900" />
            <div className="space-y-3">
              <div className="flex items-center justify-between"><h4 className="font-black text-slate-900 dark:text-white uppercase">PD/SEPD anexados</h4><button type="button" onClick={addPdLine} className="px-4 py-2 rounded-xl bg-slate-900 text-white font-black text-xs">Adicionar PD</button></div>
              {ocForm.pds.map((pd, index) => (
                <div key={index} className="grid grid-cols-1 md:grid-cols-6 gap-3 p-3 rounded-2xl bg-slate-50 dark:bg-slate-800">
                  <input value={pd.numero_pd} onChange={(e) => updatePd(index, 'numero_pd', e.target.value)} placeholder="PD91100-2026-00001" className="p-3 rounded-xl border font-bold text-slate-900" />
                  <input value={pd.pn} onChange={(e) => updatePd(index, 'pn', e.target.value)} placeholder="PN" className="p-3 rounded-xl border font-bold text-slate-900" />
                  <input value={pd.nomenclatura} onChange={(e) => updatePd(index, 'nomenclatura', e.target.value)} placeholder="Nomenclatura" className="p-3 rounded-xl border font-bold text-slate-900" />
                  <input value={pd.quantidade} onChange={(e) => updatePd(index, 'quantidade', e.target.value)} placeholder="Qtd" className="p-3 rounded-xl border font-bold text-slate-900" />
                  <input value={pd.valor_unitario} onChange={(e) => updatePd(index, 'valor_unitario', e.target.value)} placeholder="Valor unit." className="p-3 rounded-xl border font-bold text-slate-900" />
                  <input value={pd.valor_total} onChange={(e) => updatePd(index, 'valor_total', e.target.value)} placeholder="Valor total" className="p-3 rounded-xl border font-bold text-slate-900" />
                </div>
              ))}
            </div>
            <div className="flex justify-end gap-3"><button type="button" onClick={() => setModalOc(false)} className="px-6 py-3 rounded-xl bg-slate-200 text-slate-900 font-black">Cancelar</button><button type="submit" className="px-6 py-3 rounded-xl bg-blue-600 text-white font-black">Salvar OC</button></div>
          </form>
        </div>
      )}

      {modalWo && (
        <div className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-4">
          <form onSubmit={salvarWo} className={`${modalPanelClass} max-w-4xl max-h-[90vh] overflow-auto`}>
            <h3 className="text-xl font-black text-slate-900 dark:text-white uppercase">Cadastrar WO</h3>
            <p className="text-sm font-bold text-slate-600 dark:text-slate-300">SN pode ficar em branco no cadastro/importação e ser vinculado depois pelo ADMIN.</p>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <label><span className={modalLabelClass}>Número da WO</span><input required value={woForm.numero_wo} onChange={(e) => setWoForm({ ...woForm, numero_wo: e.target.value })} placeholder="WO91100-2026-00001" className={modalInputClass} /></label>
              <label><span className={modalLabelClass}>PN</span><input required value={woForm.pn} onChange={(e) => setWoForm({ ...woForm, pn: e.target.value })} placeholder="PN" className={modalInputClass} /></label>
              <label><span className={modalLabelClass}>Nomenclatura</span><input value={woForm.nomenclatura} onChange={(e) => setWoForm({ ...woForm, nomenclatura: e.target.value })} placeholder="Nomenclatura opcional" className={modalInputClass} /></label>
              <label><span className={modalLabelClass}>Serial Number (SN)</span><input value={woForm.sn} onChange={(e) => setWoForm({ ...woForm, sn: e.target.value })} placeholder="SN opcional" className={modalInputClass} /></label>
              <label><span className={modalLabelClass}>Empresa / CODEMP</span><input value={woForm.empresa} onChange={(e) => setWoForm({ ...woForm, empresa: e.target.value })} placeholder="Empresa/CODEMP" className={modalInputClass} /></label>
              <label><span className={modalLabelClass}>Aeronave</span><input value={woForm.aeronave} onChange={(e) => setWoForm({ ...woForm, aeronave: e.target.value })} placeholder="Aeronave vinculada" className={modalInputClass} /></label>
              <label><span className={modalLabelClass}>PN de saída</span><input value={woForm.pn_saida} onChange={(e) => setWoForm({ ...woForm, pn_saida: e.target.value })} placeholder="PN após o serviço" className={modalInputClass} /></label>
              <label><span className={modalLabelClass}>Código do equipamento</span><input value={woForm.equipamento_codigo} onChange={(e) => setWoForm({ ...woForm, equipamento_codigo: e.target.value })} placeholder="Código do equipamento" className={modalInputClass} /></label>
              <label><span className={modalLabelClass}>Modelo</span><input value={woForm.modelo} onChange={(e) => setWoForm({ ...woForm, modelo: e.target.value })} placeholder="Modelo" className={modalInputClass} /></label>
              <label><span className={modalLabelClass}>Responsável</span><input value={woForm.responsavel} onChange={(e) => setWoForm({ ...woForm, responsavel: e.target.value })} placeholder="Responsável pelo acompanhamento" className={modalInputClass} /></label>
              <label><span className={modalLabelClass}>Status administrativo</span><select value={woForm.status} onChange={(e) => setWoForm({ ...woForm, status: e.target.value })} className={modalSelectClass}><option>ELB</option><option>TRI</option><option>ANS</option><option>COT</option><option>PRO</option><option>LPC</option><option>ODC</option><option>ODA</option><option>EMB</option><option>REC</option><option>FAT</option><option>CAN</option></select></label>
              <label><span className={modalLabelClass}>Tipo da WO</span><select value={woForm.tipo_wo} onChange={(e) => setWoForm({ ...woForm, tipo_wo: e.target.value })} className={modalSelectClass}><option>PENDENTE</option><option>GARANTIA</option><option>OVERHAUL</option><option>REPARO</option><option>INSPECAO</option><option>FABRICANTE</option><option>OUTRO</option></select></label>
              <label><span className={modalLabelClass}>Resultado técnico</span><select value={woForm.resultado_tecnico} onChange={(e) => setWoForm({ ...woForm, resultado_tecnico: e.target.value })} className={modalSelectClass}><option>PENDENTE</option><option>REPARADO</option><option>IRREPARAVEL</option><option>DEVOLVIDO_SEM_REPARO</option></select></label>
              <label><span className={modalLabelClass}>Valor total</span><input value={woForm.valor_total} onChange={(e) => setWoForm({ ...woForm, valor_total: e.target.value })} placeholder="Valor total USD" className={modalInputClass} /></label>
              <label><span className={modalLabelClass}>Moeda</span><input value={woForm.moeda} onChange={(e) => setWoForm({ ...woForm, moeda: e.target.value })} placeholder="Moeda" className={modalInputClass} /></label>
              <label><span className={modalLabelClass}>Previsão</span><input type="date" value={woForm.data_previsao} onChange={(e) => setWoForm({ ...woForm, data_previsao: e.target.value })} className={modalInputClass} /></label>
            </div>
            <label className="block"><span className={modalLabelClass}>Observações operacionais</span><textarea value={woForm.observacao} onChange={(e) => setWoForm({ ...woForm, observacao: e.target.value })} placeholder="Observações operacionais: tipo de necessidade, garantia, overhaul, corrosão, obsoleto, motivo do reparo etc." className={modalTextAreaClass} /></label>
            <div className="flex justify-end gap-3"><button type="button" onClick={() => setModalWo(false)} className="px-6 py-3 rounded-xl bg-slate-200 text-slate-900 font-black hover:bg-slate-300">Cancelar</button><button type="submit" className="px-6 py-3 rounded-xl bg-blue-600 text-white font-black hover:bg-blue-700">Salvar WO</button></div>
          </form>
        </div>
      )}

      {editWoTarget && (
        <div className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-4">
          <form onSubmit={salvarEdicaoWo} className={`${modalPanelClass} max-w-5xl max-h-[92vh] overflow-auto`}>
            <h3 className="text-xl font-black text-slate-900 dark:text-white uppercase">Atualizar dados da WO {editWoTarget.numero_wo}</h3>
            <p className="text-sm font-bold text-slate-600 dark:text-slate-300">Todos os dados operacionais do registro local podem ser corrigidos. Registros sintéticos do Order Book continuam protegidos como fonte externa.</p>
            <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
              <label><span className={modalLabelClass}>Número da WO</span><input required value={editWoForm.numero_wo} onChange={(e) => setEditWoForm({ ...editWoForm, numero_wo: e.target.value })} className={modalInputClass} /></label>
              <label><span className={modalLabelClass}>PN</span><input required value={editWoForm.pn} onChange={(e) => setEditWoForm({ ...editWoForm, pn: e.target.value })} className={modalInputClass} /></label>
              <label><span className={modalLabelClass}>NSN / PI</span><input value={editWoForm.nsn} onChange={(e) => setEditWoForm({ ...editWoForm, nsn: e.target.value })} className={modalInputClass} /></label>
              <label><span className={modalLabelClass}>Quantidade</span><input type="number" value="1" readOnly className={`${modalInputClass} opacity-70 cursor-not-allowed`} /><small className="block mt-1 text-[10px] font-bold text-slate-500">Uma WO representa um único equipamento/serial.</small></label>
              <label className="md:col-span-2"><span className={modalLabelClass}>Nomenclatura manual</span><input value={editWoForm.nomenclatura} onChange={(e) => setEditWoForm({ ...editWoForm, nomenclatura: e.target.value })} className={modalInputClass} /></label>
              <label><span className={modalLabelClass}>Serial Number (SN)</span><input value={editWoForm.sn} onChange={(e) => setEditWoForm({ ...editWoForm, sn: e.target.value })} className={modalInputClass} /></label>
              <label><span className={modalLabelClass}>Empresa / CODEMP</span><input value={editWoForm.empresa} onChange={(e) => setEditWoForm({ ...editWoForm, empresa: e.target.value })} className={modalInputClass} /></label>
              <label><span className={modalLabelClass}>Tipo da WO</span><select value={editWoForm.tipo_wo} onChange={(e) => setEditWoForm({ ...editWoForm, tipo_wo: e.target.value })} className={modalSelectClass}><option>PENDENTE</option><option>GARANTIA</option><option>OVERHAUL</option><option>REPARO</option><option>INSPECAO</option><option>FABRICANTE</option><option>OUTRO</option></select></label>
              <label><span className={modalLabelClass}>Resultado técnico</span><select value={editWoForm.resultado_tecnico} onChange={(e) => setEditWoForm({ ...editWoForm, resultado_tecnico: e.target.value })} className={modalSelectClass}><option>PENDENTE</option><option>REPARADO</option><option>IRREPARAVEL</option><option>DEVOLVIDO_SEM_REPARO</option><option>CANCELADO</option></select></label>
              <label><span className={modalLabelClass}>Status administrativo</span><select value={editWoForm.status} onChange={(e) => setEditWoForm({ ...editWoForm, status: e.target.value })} className={modalSelectClass}><option>ELB</option><option>TRI</option><option>ANS</option><option>COT</option><option>PRO</option><option>LPC</option><option>ODC</option><option>ODA</option><option>EMB</option><option>REC</option><option>FAT</option><option>CAN</option></select></label>
              <label><span className={modalLabelClass}>Responsável</span><input value={editWoForm.responsavel} onChange={(e) => setEditWoForm({ ...editWoForm, responsavel: e.target.value })} className={modalInputClass} /></label>
              <label><span className={modalLabelClass}>Aeronave</span><input value={editWoForm.aeronave} onChange={(e) => setEditWoForm({ ...editWoForm, aeronave: e.target.value })} className={modalInputClass} /></label>
              <label><span className={modalLabelClass}>PN de saída</span><input value={editWoForm.pn_saida} onChange={(e) => setEditWoForm({ ...editWoForm, pn_saida: e.target.value })} className={modalInputClass} /></label>
              <label><span className={modalLabelClass}>Código do equipamento</span><input value={editWoForm.equipamento_codigo} onChange={(e) => setEditWoForm({ ...editWoForm, equipamento_codigo: e.target.value })} className={modalInputClass} /></label>
              <label><span className={modalLabelClass}>Modelo</span><input value={editWoForm.modelo} onChange={(e) => setEditWoForm({ ...editWoForm, modelo: e.target.value })} className={modalInputClass} /></label>
              <label><span className={modalLabelClass}>Valor total</span><input value={editWoForm.valor_total} onChange={(e) => setEditWoForm({ ...editWoForm, valor_total: e.target.value })} className={modalInputClass} /></label>
              <label><span className={modalLabelClass}>Moeda</span><input value={editWoForm.moeda} onChange={(e) => setEditWoForm({ ...editWoForm, moeda: e.target.value })} className={modalInputClass} /></label>
              <label><span className={modalLabelClass}>Abertura</span><input type="date" value={editWoForm.data_abertura} onChange={(e) => setEditWoForm({ ...editWoForm, data_abertura: e.target.value })} className={modalInputClass} /></label>
              <label><span className={modalLabelClass}>Envio</span><input type="date" value={editWoForm.data_envio} onChange={(e) => setEditWoForm({ ...editWoForm, data_envio: e.target.value })} className={modalInputClass} /></label>
              <label><span className={modalLabelClass}>Previsão</span><input type="date" value={editWoForm.data_previsao} onChange={(e) => setEditWoForm({ ...editWoForm, data_previsao: e.target.value, data_previsao_entrega: e.target.value })} className={modalInputClass} /></label>
              <label><span className={modalLabelClass}>Retorno</span><input type="date" value={editWoForm.data_retorno} onChange={(e) => setEditWoForm({ ...editWoForm, data_retorno: e.target.value })} className={modalInputClass} /></label>
            </div>
            <label className="block"><span className={modalLabelClass}>Observações operacionais</span><textarea value={editWoForm.observacao} onChange={(e) => setEditWoForm({ ...editWoForm, observacao: e.target.value })} className={modalTextAreaClass} /></label>
            <div className="flex justify-end gap-3"><button type="button" onClick={() => setEditWoTarget(null)} className="px-6 py-3 rounded-xl bg-slate-200 text-slate-900 font-black hover:bg-slate-300">Cancelar</button><button type="submit" className="px-6 py-3 rounded-xl bg-blue-600 text-white font-black hover:bg-blue-700">Salvar alterações</button></div>
          </form>
        </div>
      )}

      {supTarget && (
        <div className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-4">
          <div className={`${modalPanelClass} max-w-5xl max-h-[92vh] overflow-auto`}>
            <div className="flex items-start justify-between gap-4">
              <div><h3 className="text-xl font-black uppercase">Suplementações — {supTarget.titulo}</h3><p className="text-sm font-bold text-slate-500 dark:text-slate-400 mt-1">Controle financeiro operacional em USD. Valores GBP permanecem apenas como referência histórica/comercial quando existirem.</p></div>
              <button type="button" onClick={() => { setSupTarget(null); setSupEditId(null); }} className="px-3 py-2 rounded-xl bg-slate-200 dark:bg-slate-800 font-black">FECHAR</button>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
              <SummaryMiniCard title="Alvo USD" value={formatMoney(supTarget.item?.resumo?.valor_total_usd ?? supTarget.item?.resumo?.valor_total_calculado, 'USD')} />
              <SummaryMiniCard title="Suplementado USD" value={formatMoney(supTarget.item?.resumo?.valor_suplementado, 'USD')} />
              <SummaryMiniCard title="Falta USD" value={formatMoney(supTarget.item?.resumo?.saldo_restante, 'USD')} />
            </div>

            {renderSuplementacoes(
              supTarget.tipo === 'oc' ? supTarget.item?.compras_suplementacoes : supTarget.item?.work_order_suplementacoes,
              'USD',
              iniciarRetificacaoSuplementacao,
            )}

            <div className="rounded-2xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 p-5 space-y-4">
              <div><h4 className="font-black uppercase">Controle do valor a suplementar</h4><p className="text-xs font-bold text-slate-500 mt-1">O valor alvo operacional é USD. Alterações ficam registradas na auditoria e não apagam a referência GBP da OC.</p></div>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <label><span className={modalLabelClass}>Valor alvo da suplementação — USD</span><input value={supControl.valor_alvo_usd} onChange={(e) => setSupControl({ ...supControl, valor_alvo_usd: e.target.value })} className={modalInputClass} /></label>
                <label><span className={modalLabelClass}>Motivo do ajuste / encerramento</span><input value={supControl.motivo} onChange={(e) => setSupControl({ ...supControl, motivo: e.target.value })} placeholder="Obrigatório se o valor for alterado" className={modalInputClass} /></label>
              </div>
              <label className="flex items-start gap-3 p-3 rounded-xl bg-slate-100 dark:bg-slate-800 cursor-pointer"><input type="checkbox" checked={supControl.marcar_total} onChange={(e) => setSupControl({ ...supControl, marcar_total: e.target.checked })} className="mt-1" /><span><strong className="block">Marcar como totalmente suplementada</strong><small className="font-bold text-slate-500">Se marcado, o alvo USD será ajustado ao total USD já suplementado. O valor anterior permanece na auditoria.</small></span></label>
              <div className="flex justify-end"><button type="button" onClick={salvarControleSuplementacao} className="px-5 py-3 rounded-xl bg-slate-700 text-white font-black">SALVAR CONTROLE FINANCEIRO</button></div>
            </div>

            <form onSubmit={salvarSuplementacao} className="rounded-2xl border border-blue-200 dark:border-blue-900/50 bg-blue-50/40 dark:bg-blue-950/10 p-5 space-y-4">
              <div><h4 className="font-black uppercase">{supEditId ? 'Retificar suplementação' : 'Nova suplementação'}</h4><p className="text-xs font-bold text-slate-500 mt-1">Cada lançamento permanece separado. Retificar cria um novo registro e inativa o anterior, preservando a trilha de auditoria.</p></div>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <label><span className={modalLabelClass}>Valor — USD</span><input required value={supForm.valor} onChange={(e) => setSupForm({ ...supForm, valor: e.target.value })} placeholder="Valor suplementado" className={modalInputClass} /></label>
                <label><span className={modalLabelClass}>Moeda operacional</span><input value="USD" readOnly className={`${modalInputClass} opacity-75 cursor-not-allowed`} /></label>
                <label><span className={modalLabelClass}>MSG / referência (texto)</span><input value={supForm.msg_referencia} onChange={(e) => setSupForm({ ...supForm, msg_referencia: e.target.value })} placeholder="Ex.: R191732Z/MAI/2026" className={modalInputClass} /></label>
                <label><span className={modalLabelClass}>Data da MSG</span><input type="date" value={supForm.data_msg} onChange={(e) => setSupForm({ ...supForm, data_msg: e.target.value })} className={modalInputClass} /></label>
              </div>
              {supEditId && <label><span className={modalLabelClass}>Motivo da retificação</span><input required value={supForm.motivo_retificacao} onChange={(e) => setSupForm({ ...supForm, motivo_retificacao: e.target.value })} placeholder="Por que o lançamento anterior precisa ser corrigido?" className={modalInputClass} /></label>}
              <label><span className={modalLabelClass}>Observações da suplementação</span><textarea value={supForm.observacao} onChange={(e) => setSupForm({ ...supForm, observacao: e.target.value })} className={modalTextAreaClass} /></label>
              <div className="flex justify-end gap-3">{supEditId && <button type="button" onClick={() => { setSupEditId(null); setSupForm({ valor: '', moeda: 'USD', msg_referencia: '', data_msg: '', observacao: '', motivo_retificacao: '' }); }} className="px-5 py-3 rounded-xl bg-slate-200 dark:bg-slate-800 font-black">CANCELAR RETIFICAÇÃO</button>}<button type="submit" className="px-5 py-3 rounded-xl bg-blue-600 text-white font-black">{supEditId ? 'SALVAR RETIFICAÇÃO' : 'REGISTRAR SUPLEMENTAÇÃO'}</button></div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
