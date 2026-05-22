import React, { useEffect, useMemo, useRef, useState } from 'react';
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
  const [ocMeta, setOcMeta] = useState({ pd_pipeline: {} });
  const [loading, setLoading] = useState(false);
  const [msg, setMsg] = useState(null);
  const [modalOc, setModalOc] = useState(false);
  const [modalWo, setModalWo] = useState(false);
  const [supTarget, setSupTarget] = useState(null);
  const [editWoTarget, setEditWoTarget] = useState(null);
  const [pdsUploadTarget, setPdsUploadTarget] = useState(null);

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
    numero_wo: '', pn: '', nomenclatura: '', sn: '', empresa: '', origem: 'MANUAL', status: 'ELB', tipo_wo: 'PENDENTE', resultado_tecnico: 'PENDENTE', valor_total: '', moeda: 'USD', data_previsao: '', observacao: '',
  });

  const [editWoForm, setEditWoForm] = useState({ nomenclatura: '', sn: '', tipo_wo: 'PENDENTE', resultado_tecnico: 'PENDENTE', status: '', observacao: '' });
  const [supForm, setSupForm] = useState({ valor: '', moeda: 'USD', msg_referencia: '', data_msg: '', observacao: '' });

  const carregar = async () => {
    setLoading(true);
    setMsg(null);
    try {
      const [ocRes, woRes] = await Promise.all([
        apiFetch(`/purchases/ordens?q=${encodeURIComponent(q)}`, {}, token),
        apiFetch(`/purchases/work-orders?q=${encodeURIComponent(q)}`, {}, token),
      ]);
      const [ocJson, woJson] = await Promise.all([ocRes.json(), woRes.json()]);
      if (ocJson.status === 'success') {
        setOrdens(ocJson.data || []);
        setOcMeta(ocJson.meta || { pd_pipeline: {} });
      }
      if (woJson.status === 'success') setWos(woJson.data || []);
      if (ocJson.status !== 'success') setMsg({ tipo: 'error', texto: ocJson.message || 'Falha ao consultar OC.' });
      if (woJson.status !== 'success') setMsg({ tipo: 'error', texto: woJson.message || 'Falha ao consultar WO.' });
    } catch {
      setMsg({ tipo: 'error', texto: 'Falha de comunicação com o backend.' });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { carregar(); }, []);

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
        carregar();
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
        carregar();
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
        setWoForm({ numero_wo: '', pn: '', nomenclatura: '', sn: '', empresa: '', origem: 'MANUAL', status: 'ELB', tipo_wo: 'PENDENTE', resultado_tecnico: 'PENDENTE', valor_total: '', moeda: 'USD', data_previsao: '', observacao: '' });
        carregar();
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
        carregar();
      } else {
        setMsg({ tipo: 'error', texto: json.message || 'Falha ao atualizar WO.' });
      }
    } catch {
      setMsg({ tipo: 'error', texto: 'Falha ao atualizar WO.' });
    }
  };

  const salvarSuplementacao = async (e) => {
    e.preventDefault();
    if (!supTarget) return;
    try {
      const endpoint = supTarget.tipo === 'oc' ? `/purchases/ordens/${supTarget.id}/suplementacoes` : `/purchases/work-orders/${supTarget.id}/suplementacoes`;
      const response = await apiFetch(endpoint, {
        method: 'POST',
        headers: buildAuthHeaders(token, { 'Content-Type': 'application/json' }),
        body: JSON.stringify(supForm),
      }, token);
      const json = await response.json();
      if (json.status === 'success') {
        setMsg({ tipo: 'success', texto: json.message });
        setSupTarget(null);
        setSupForm({ valor: '', moeda: 'USD', msg_referencia: '', data_msg: '', observacao: '' });
        carregar();
      } else {
        setMsg({ tipo: 'error', texto: json.message || 'Falha ao suplementar.' });
      }
    } catch {
      setMsg({ tipo: 'error', texto: 'Falha ao suplementar.' });
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
        } catch (_) {}
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

  const renderSuplementacoes = (suplementacoes = [], moedaFallback = 'USD') => {
    const rows = (suplementacoes || []).filter((sup) => sup && sup.ativo !== false);
    if (rows.length === 0) return null;
    return (
      <div className="space-y-3">
        <h4 className="text-xs font-black uppercase tracking-[0.2em] text-slate-500">Suplementações registradas</h4>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {rows.map((sup) => (
            <div key={sup.id || `${sup.msg_referencia}-${sup.valor}-${sup.data_msg}`} className="p-4 rounded-2xl bg-blue-50/60 dark:bg-blue-950/20 border border-blue-100 dark:border-blue-900/40 shadow-sm">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <p className="text-[10px] font-black uppercase tracking-wider text-blue-500 dark:text-blue-300">MSG / Documento</p>
                  <p className="text-sm font-black text-slate-900 dark:text-white break-all">{sup.msg_referencia || 'Referência não informada'}</p>
                </div>
                <p className="text-sm font-black text-blue-700 dark:text-blue-300 whitespace-nowrap">{formatMoney(sup.valor, sup.moeda || moedaFallback)}</p>
              </div>
              <div className="mt-3 grid grid-cols-1 sm:grid-cols-2 gap-2 text-[11px] font-bold text-slate-600 dark:text-slate-300">
                <span>Data MSG: {formatDateLabel(sup.data_msg)}</span>
                <span>Moeda: {sup.moeda || moedaFallback}</span>
                {sup.created_at && <span>Cadastrado: {formatDateLabel(sup.created_at)}</span>}
              </div>
              {sup.observacao && <p className="mt-3 text-xs font-bold text-slate-700 dark:text-slate-200 bg-white/70 dark:bg-slate-900/50 border border-blue-100 dark:border-blue-900/40 rounded-xl px-3 py-2">Obs: {sup.observacao}</p>}
            </div>
          ))}
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
    carregar();
  };

  const excluir = async (tipo, id) => {
    const ok = window.confirm('Confirmar exclusão lógica? O histórico será preservado.');
    if (!ok) return;
    const endpoint = tipo === 'oc' ? `/purchases/ordens/${id}` : `/purchases/work-orders/${id}`;
    const response = await apiFetch(endpoint, { method: 'DELETE' }, token);
    const json = await response.json();
    setMsg({ tipo: json.status === 'success' ? 'success' : 'error', texto: json.message });
    carregar();
  };

  const abrirEdicaoWo = (wo) => {
    setEditWoTarget(wo);
    setEditWoForm({ nomenclatura: wo.nomenclatura || '', sn: wo.sn || '', tipo_wo: wo.tipo_wo || 'PENDENTE', resultado_tecnico: wo.resultado_tecnico || wo.resultado || 'PENDENTE', status: wo.status || 'ELB', observacao: wo.observacao || '' });
  };

  const renderOcCard = (ordem) => {
    const resumo = ordem.resumo || {};
    const moeda = ordem.moeda || ordem.sigla_moeda || 'USD';
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
            {isOrderBook && <p className="text-xs font-black text-emerald-600 dark:text-emerald-300 mt-2 uppercase tracking-wider">Leitura importada do Order Book. Edição/correção deve ser feita pela importação/manutenção do documento de origem.</p>}
          </div>
          <div className="flex gap-2 flex-wrap">
            <button onClick={() => baixarExportacao(`/purchases/ordens/${encodeURIComponent(ordem.id)}/export`, `OC_${ordem.numero_oc || ordem.id}.xlsx`)} className="px-4 py-2 rounded-xl bg-emerald-600 text-white font-black text-xs hover:bg-emerald-700 flex items-center gap-2"><Download size={14} /> EXPORTAR OC</button>
            {isAdmin && !isOrderBook && ordem.status !== 'CAN' && <button onClick={() => setSupTarget({ tipo: 'oc', id: ordem.id, titulo: ordem.numero_oc })} className="px-4 py-2 rounded-xl bg-blue-600 text-white font-black text-xs hover:bg-blue-700">SUPLEMENTAR</button>}
            {isAdmin && !isOrderBook && ordem.status !== 'CAN' && <button onClick={() => { setPdsUploadTarget(ordem); setTimeout(() => pdsDaOcUploadRef.current?.click(), 0); }} className="px-4 py-2 rounded-xl bg-slate-900 text-white font-black text-xs hover:bg-slate-800 flex items-center gap-2"><Link2 size={14} /> ANEXAR PDs</button>}
            {isAdmin && !isOrderBook && ordem.status !== 'CAN' && <button onClick={() => cancelarOc(ordem)} className="px-4 py-2 rounded-xl bg-amber-500 text-white font-black text-xs hover:bg-amber-600 flex items-center gap-2"><Ban size={14} /> CAN</button>}
            {isAdmin && !isOrderBook && <button onClick={() => excluir('oc', ordem.id)} className="px-4 py-2 rounded-xl bg-red-600 text-white font-black text-xs hover:bg-red-700 flex items-center gap-2"><Trash2 size={14} /> EXCLUIR</button>}
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <div className="p-4 rounded-2xl bg-slate-50 dark:bg-slate-900/40 border border-slate-100 dark:border-slate-700"><p className="text-[10px] uppercase font-black text-slate-400 tracking-wider">Valor total</p><p className="text-lg font-black text-slate-900 dark:text-white">{formatMoney(resumo.valor_total_calculado, moeda)}</p></div>
          <div className="p-4 rounded-2xl bg-slate-50 dark:bg-slate-900/40 border border-slate-100 dark:border-slate-700"><p className="text-[10px] uppercase font-black text-slate-400 tracking-wider">Suplementado</p><p className="text-lg font-black text-blue-600 dark:text-blue-300">{formatMoney(resumo.valor_suplementado, moeda)}</p></div>
          <div className="p-4 rounded-2xl bg-slate-50 dark:bg-slate-900/40 border border-slate-100 dark:border-slate-700"><p className="text-[10px] uppercase font-black text-slate-400 tracking-wider">Falta</p><p className="text-lg font-black text-amber-600 dark:text-amber-300">{formatMoney(resumo.saldo_restante, moeda)}</p></div>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <div className="space-y-2">
            <div className="flex justify-between text-xs font-black uppercase text-slate-500 dark:text-slate-400"><span>{isOrderBook ? 'Progresso de aprovação / Order Book' : 'Progresso de suplementação'}</span><span>{resumo.percentual_suplementado || 0}%</span></div>
            <ProgressBar percent={resumo.percentual_suplementado} />
          </div>
          <div className="space-y-2">
            <div className="flex justify-between text-xs font-black uppercase text-slate-500 dark:text-slate-400"><span>Completude dos PDs anexados</span><span>{resumo.pds_anexados || 0}/{resumo.qtde_se_informada || (ordem.compras_pds || []).length || 0} • {resumo.percentual_pds_anexados || 0}%</span></div>
            <ProgressBar percent={resumo.percentual_pds_anexados} />
          </div>
        </div>

        {renderSuplementacoes(ordem.compras_suplementacoes, moeda)}

        <div className="space-y-3">
          <h4 className="text-xs font-black uppercase tracking-[0.2em] text-slate-500">PD/SEPD vinculados</h4>
          {(ordem.compras_pds || []).length > 0 ? (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              {ordem.compras_pds.map((pd) => (
                <div key={pd.id} className={`p-4 rounded-2xl border ${pd.status === 'CAN' || pd.ativo === false ? 'bg-red-50 dark:bg-red-900/10 border-red-200 dark:border-red-900/40' : 'bg-slate-50 dark:bg-slate-900/40 border-slate-100 dark:border-slate-700'}`}>
                  <div className="flex items-center gap-2 flex-wrap"><p className="font-black text-slate-900 dark:text-white">{pd.numero_pd}</p><Badge danger={pd.status === 'CAN' || pd.ativo === false}>{pd.status_grupo || pd.status || 'ATIVO'}</Badge></div>
                  <p className="text-sm font-bold text-slate-600 dark:text-slate-300">PN {pd.pn} • Qtd comprada {numberBr(pd.qtd_comprada || pd.quantidade)}</p>
                  <p className="text-xs text-slate-500 dark:text-slate-400 truncate">{pd.nomenclatura || 'Sem nomenclatura'}</p>
                  <div className="mt-2 grid grid-cols-2 gap-2 text-[11px] font-bold text-slate-500 dark:text-slate-400">
                    <span>Pedida: {numberBr(pd.qtd_pedida || pd.quantidade)}</span>
                    <span>Recebida: {numberBr(pd.qtd_recebida || pd.qtd_entregue || 0)}</span>
                    <span>GBP: {formatMoney(pd.valor_total_gbp || pd.valor_total, 'GBP')}</span>
                    <span>USD: {formatMoney(pd.valor_total_usd || 0, 'USD')}</span>
                    {pd.source === 'ORDER_BOOK' && <><span>Coleta: {pd.qtd_aguardando_coleta ?? 0}</span><span>Em rota: {pd.qtd_em_rota ?? 0}</span></>}
                  </div>
                </div>
              ))}
            </div>
          ) : <p className="text-sm font-bold text-slate-500">Nenhum PD anexado nesta OC.</p>}
        </div>
      </div>
    );
  };

  const renderWoCard = (wo) => {
    const resumo = wo.resumo || {};
    const moeda = wo.moeda || 'USD';
    const isOrderBook = wo.source === 'ORDER_BOOK_REPAIR' || wo.order_book_ref;
    const snPendente = !wo.sn || wo.sn_pendente;
    return (
      <div key={wo.id} className="bg-white dark:bg-slate-800 rounded-3xl border border-slate-200 dark:border-slate-700 shadow-sm p-6 space-y-5">
        <div className="flex flex-col lg:flex-row lg:items-start lg:justify-between gap-4">
          <div>
            <div className="flex items-center gap-3 flex-wrap">
              <h3 className="text-xl font-black text-slate-900 dark:text-white uppercase">WO {wo.numero_wo}</h3>
              <Badge amber={wo.status === 'EMB' || wo.status === 'REC'} green={wo.status === 'FAT'}>{wo.status}</Badge>
              {snPendente && <Badge amber>SN PENDENTE</Badge>}
              {isOrderBook && <Badge green>ORDER BOOK</Badge>}
            </div>
            <p className="text-sm font-bold text-slate-500 dark:text-slate-400 mt-1">PN {wo.pn} • SN {wo.sn || 'Pendente'} • {wo.codemp || wo.empresa || 'Empresa não informada'}</p>
            <p className="text-sm font-black text-slate-700 dark:text-slate-200 mt-1">{wo.nomenclatura || 'Nomenclatura pendente'}</p>
            <div className="mt-2 flex flex-wrap gap-2 text-[11px] font-bold text-slate-500 dark:text-slate-400">
              {wo.tipo_wo && wo.tipo_wo !== 'PENDENTE' && <span>Tipo WO: {wo.tipo_wo}</span>}
              <span>Resultado técnico: {wo.resultado_tecnico || wo.resultado || 'PENDENTE'}</span>
              {wo.fonte_nomenclatura && <span>Nome: {wo.fonte_nomenclatura}</span>}
              {wo.responsavel && <span>Resp: {wo.responsavel}</span>}
              {wo.data_previsao_entrega && <span>Previsão: {wo.data_previsao_entrega}</span>}
              {wo.modelo && <span>Modelo: {wo.modelo}</span>}
            </div>
            {wo.observacao && <p className="mt-2 text-xs font-bold text-slate-600 dark:text-slate-300 bg-slate-100 dark:bg-slate-900/50 border border-slate-200 dark:border-slate-700 rounded-xl px-3 py-2">Obs: {wo.observacao}</p>}
          </div>
          <div className="flex gap-2 flex-wrap">
            <button onClick={() => baixarExportacao(`/purchases/work-orders/${encodeURIComponent(wo.id)}/export`, `WO_${wo.numero_wo || wo.id}.xlsx`)} className="px-4 py-2 rounded-xl bg-emerald-600 text-white font-black text-xs hover:bg-emerald-700 flex items-center gap-2"><Download size={14} /> EXPORTAR WO</button>
            {isAdmin && !isOrderBook && <button onClick={() => abrirEdicaoWo(wo)} className="px-4 py-2 rounded-xl bg-slate-900 text-white font-black text-xs hover:bg-slate-800 flex items-center gap-2"><Pencil size={14} /> DADOS WO</button>}
            {isAdmin && !isOrderBook && <button onClick={() => setSupTarget({ tipo: 'wo', id: wo.id, titulo: wo.numero_wo })} className="px-4 py-2 rounded-xl bg-blue-600 text-white font-black text-xs hover:bg-blue-700">SUPLEMENTAR</button>}
            {isAdmin && !isOrderBook && <button onClick={() => excluir('wo', wo.id)} className="px-4 py-2 rounded-xl bg-red-600 text-white font-black text-xs hover:bg-red-700 flex items-center gap-2"><Trash2 size={14} /> EXCLUIR</button>}
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <div className="p-4 rounded-2xl bg-slate-50 dark:bg-slate-900/40 border border-slate-100 dark:border-slate-700"><p className="text-[10px] uppercase font-black text-slate-400 tracking-wider">Valor total</p><p className="text-lg font-black text-slate-900 dark:text-white">{formatMoney(resumo.valor_total_calculado, moeda)}</p></div>
          <div className="p-4 rounded-2xl bg-slate-50 dark:bg-slate-900/40 border border-slate-100 dark:border-slate-700"><p className="text-[10px] uppercase font-black text-slate-400 tracking-wider">Suplementado</p><p className="text-lg font-black text-blue-600 dark:text-blue-300">{formatMoney(resumo.valor_suplementado, moeda)}</p></div>
          <div className="p-4 rounded-2xl bg-slate-50 dark:bg-slate-900/40 border border-slate-100 dark:border-slate-700"><p className="text-[10px] uppercase font-black text-slate-400 tracking-wider">Falta</p><p className="text-lg font-black text-amber-600 dark:text-amber-300">{formatMoney(resumo.saldo_restante, moeda)}</p></div>
        </div>

        <div className="space-y-2">
          <div className="flex justify-between text-xs font-black uppercase text-slate-500 dark:text-slate-400"><span>Progresso de suplementação</span><span>{resumo.percentual_suplementado || 0}%</span></div>
          <ProgressBar percent={resumo.percentual_suplementado} />
        </div>

        {renderSuplementacoes(wo.work_order_suplementacoes, moeda)}
      </div>
    );
  };

  return (
    <div className="space-y-8 animate-fade-in">
      <input ref={ocUploadRef} type="file" accept=".xls,.xlsx,.csv,.ods" className="hidden" onChange={(e) => { const file = e.target.files?.[0]; e.target.value = ''; uploadFile('/purchases/ordens/import', file, 'OCs importadas.'); }} />
      <input ref={pdPipelineUploadRef} type="file" accept=".xls,.xlsx,.csv,.ods" className="hidden" onChange={(e) => { const file = e.target.files?.[0]; e.target.value = ''; uploadFile('/purchases/pds-pipeline/import', file, 'Pipeline de PDs importado.'); }} />
      <input ref={pdsDaOcUploadRef} type="file" accept=".xls,.xlsx,.csv,.ods" className="hidden" onChange={(e) => { const file = e.target.files?.[0]; e.target.value = ''; if (pdsUploadTarget?.id) uploadFile(`/purchases/ordens/${pdsUploadTarget.id}/pds/import`, file, 'PDs anexados à OC.'); }} />
      <input ref={woUploadRef} type="file" accept=".xls,.xlsx,.csv,.ods" className="hidden" onChange={(e) => { const file = e.target.files?.[0]; e.target.value = ''; uploadFile('/purchases/work-orders/import', file, 'WOs importadas.'); }} />

      <section className="bg-white dark:bg-slate-800 rounded-3xl p-6 border border-slate-200 dark:border-slate-700 shadow-sm space-y-5">
        <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-4">
          <div>
            <h2 className="text-2xl font-black text-slate-900 dark:text-white uppercase">Ordens de Compra e WO</h2>
            <p className="text-sm font-bold text-slate-500 dark:text-slate-400">Consulta, importação, edição segura e suplementação de OC/ODC/PD e Work Orders.</p>
          </div>
          {isAdmin && (
            <div className="flex flex-wrap gap-3">
              <button onClick={() => setModalOc(true)} className="px-5 py-3 rounded-2xl bg-blue-600 text-white font-black hover:bg-blue-700 flex items-center gap-2"><PlusCircle size={18} /> Nova OC</button>
              <button onClick={() => setModalWo(true)} className="px-5 py-3 rounded-2xl bg-slate-900 text-white font-black hover:bg-slate-800 flex items-center gap-2"><Wrench size={18} /> Nova WO</button>
              <button onClick={() => ocUploadRef.current?.click()} className="px-5 py-3 rounded-2xl bg-emerald-600 text-white font-black hover:bg-emerald-700 flex items-center gap-2"><Upload size={18} /> Importar OCs</button>
              <button onClick={() => pdPipelineUploadRef.current?.click()} className="px-5 py-3 rounded-2xl bg-teal-600 text-white font-black hover:bg-teal-700 flex items-center gap-2"><FileSpreadsheet size={18} /> PD ODC</button>
              <button onClick={() => woUploadRef.current?.click()} className="px-5 py-3 rounded-2xl bg-amber-600 text-white font-black hover:bg-amber-700 flex items-center gap-2"><Upload size={18} /> Importar WO</button>
            </div>
          )}
        </div>

        <div className="flex flex-col lg:flex-row gap-3">
          <div className="flex gap-2 p-1 bg-slate-100 dark:bg-slate-900 rounded-2xl">
            <button onClick={() => setTab('oc')} className={`px-5 py-3 rounded-xl font-black text-sm flex items-center gap-2 ${tab === 'oc' ? 'bg-blue-600 text-white' : 'text-slate-600 dark:text-slate-300'}`}><ShoppingCart size={16} /> OC/ODC</button>
            <button onClick={() => setTab('wo')} className={`px-5 py-3 rounded-xl font-black text-sm flex items-center gap-2 ${tab === 'wo' ? 'bg-blue-600 text-white' : 'text-slate-600 dark:text-slate-300'}`}><Wrench size={16} /> WO</button>
          </div>
          <div className="flex-1 flex gap-3">
            <input value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') carregar(); }} placeholder="Pesquisar por OC, PD, PN, nomenclatura, WO, SN, empresa ou status" className="flex-1 p-3 rounded-2xl border-2 border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 font-bold text-slate-900 dark:text-white placeholder:text-slate-400" />
            <button onClick={carregar} className="px-5 py-3 rounded-2xl bg-blue-600 text-white font-black hover:bg-blue-700 flex items-center gap-2"><Search size={18} /> Buscar</button>
            <button onClick={() => { setQ(''); setTimeout(carregar, 0); }} className="px-4 py-3 rounded-2xl bg-slate-200 dark:bg-slate-700 text-slate-900 dark:text-white font-black"><RefreshCcw size={18} /></button>
          </div>
        </div>

        {msg && <p className={`font-black ${msg.tipo === 'success' ? 'text-green-600' : 'text-red-600'}`}>{msg.texto}</p>}
      </section>

      {tab === 'oc' && (
        <section className="space-y-5">
          <div className="grid grid-cols-1 md:grid-cols-3 xl:grid-cols-6 gap-3">
            <SummaryMiniCard title="ELB" value={pdPipeline.elaboracao || 0} subtitle="PDs em elaboração" />
            <SummaryMiniCard title="TRI / ANS" value={pdPipeline.triagem_analise || 0} subtitle="Triagem e análise" />
            <SummaryMiniCard title="COT / LPC" value={pdPipeline.cotacao_lpc || 0} subtitle="Cotação e liberados" />
            <SummaryMiniCard title="ODC" value={pdPipeline.odc || 0} subtitle="PDs em ODC" />
            <SummaryMiniCard title="Com OC" value={pdPipeline.com_oc || 0} subtitle="PDs já anexados" />
            <SummaryMiniCard title="CAN" value={pdPipeline.cancelados || 0} subtitle="Cancelados" />
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
          {loading ? <p className="font-black text-slate-500">Carregando...</p> : null}
          {wos.map(renderWoCard)}
          {!loading && wos.length === 0 && <p className="font-black text-slate-500">Nenhuma WO localizada.</p>}
        </section>
      )}

      {modalOc && (
        <div className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-4">
          <form onSubmit={salvarOc} className="bg-white dark:bg-slate-900 rounded-3xl p-8 w-full max-w-5xl max-h-[90vh] overflow-auto space-y-5">
            <h3 className="text-xl font-black text-slate-900 dark:text-white uppercase">Cadastrar OC / ODC</h3>
            <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
              <input required value={ocForm.numero_oc} onChange={(e) => setOcForm({ ...ocForm, numero_oc: e.target.value })} placeholder="OC: P2026-0001" className="p-3 rounded-xl border-2 font-bold text-slate-900" />
              <select value={ocForm.status} onChange={(e) => setOcForm({ ...ocForm, status: e.target.value })} className="p-3 rounded-xl border-2 font-bold text-slate-900"><option>ELB</option><option>ODC</option><option>ODA</option><option>ODA_RESSALVA</option><option>ADP</option><option>REC</option><option>CAN</option></select>
              <input value={ocForm.moeda} onChange={(e) => setOcForm({ ...ocForm, moeda: e.target.value })} placeholder="Moeda" className="p-3 rounded-xl border-2 font-bold text-slate-900" />
              <input value={ocForm.valor_total} onChange={(e) => setOcForm({ ...ocForm, valor_total: e.target.value })} placeholder="Valor total" className="p-3 rounded-xl border-2 font-bold text-slate-900" />
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
          <form onSubmit={salvarEdicaoWo} className={`${modalPanelClass} max-w-2xl`}>
            <h3 className="text-xl font-black text-slate-900 dark:text-white uppercase">Atualizar dados da WO {editWoTarget.numero_wo}</h3>
            <p className="text-sm font-bold text-slate-600 dark:text-slate-300">Campos editáveis em destaque: SN, tipo da WO, resultado técnico, status e observações operacionais.</p>
            <div className="rounded-2xl bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 p-4 text-xs font-bold text-slate-600 dark:text-slate-300">
              <p><span className="font-black">PN:</span> {editWoTarget.pn || 'N/I'}</p>
              <p><span className="font-black">Nome atual:</span> {editWoTarget.nomenclatura || 'Pendente'}</p>
              <p><span className="font-black">Empresa/CODEMP:</span> {editWoTarget.codemp || editWoTarget.empresa || 'N/I'}</p>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <label><span className={modalLabelClass}>Nomenclatura manual</span><input value={editWoForm.nomenclatura} onChange={(e) => setEditWoForm({ ...editWoForm, nomenclatura: e.target.value })} placeholder="Nomenclatura manual" className={modalInputClass} /></label>
              <label><span className={modalLabelClass}>Serial Number (SN)</span><input value={editWoForm.sn} onChange={(e) => setEditWoForm({ ...editWoForm, sn: e.target.value })} placeholder="Informar SN" className={modalInputClass} /></label>
              <label><span className={modalLabelClass}>Tipo da WO</span><select value={editWoForm.tipo_wo} onChange={(e) => setEditWoForm({ ...editWoForm, tipo_wo: e.target.value })} className={modalSelectClass}><option>PENDENTE</option><option>GARANTIA</option><option>OVERHAUL</option><option>REPARO</option><option>INSPECAO</option><option>FABRICANTE</option><option>OUTRO</option></select></label>
              <label><span className={modalLabelClass}>Resultado técnico</span><select value={editWoForm.resultado_tecnico} onChange={(e) => setEditWoForm({ ...editWoForm, resultado_tecnico: e.target.value })} className={modalSelectClass}><option>PENDENTE</option><option>REPARADO</option><option>IRREPARAVEL</option><option>DEVOLVIDO_SEM_REPARO</option><option>CANCELADO</option></select></label>
              <label><span className={modalLabelClass}>Status administrativo</span><select value={editWoForm.status} onChange={(e) => setEditWoForm({ ...editWoForm, status: e.target.value })} className={modalSelectClass}><option>ELB</option><option>TRI</option><option>ANS</option><option>COT</option><option>PRO</option><option>LPC</option><option>ODC</option><option>ODA</option><option>EMB</option><option>REC</option><option>FAT</option><option>CAN</option></select></label>
            </div>
            <label className="block"><span className={modalLabelClass}>Observações operacionais</span><textarea value={editWoForm.observacao} onChange={(e) => setEditWoForm({ ...editWoForm, observacao: e.target.value })} placeholder="Observações operacionais: tipo de necessidade, garantia, overhaul, corrosão, obsoleto, motivo do reparo etc." className={modalTextAreaClass} /></label>
            <div className="flex justify-end gap-3"><button type="button" onClick={() => setEditWoTarget(null)} className="px-6 py-3 rounded-xl bg-slate-200 text-slate-900 font-black hover:bg-slate-300">Cancelar</button><button type="submit" className="px-6 py-3 rounded-xl bg-blue-600 text-white font-black hover:bg-blue-700">Salvar</button></div>
          </form>
        </div>
      )}

      {supTarget && (
        <div className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-4">
          <form onSubmit={salvarSuplementacao} className={`${modalPanelClass} max-w-2xl`}>
            <h3 className="text-xl font-black text-slate-900 dark:text-white uppercase">Suplementar {supTarget.titulo}</h3>
            <p className="text-sm font-bold text-slate-600 dark:text-slate-300">Informe valor, moeda, mensagem/documento de referência, data e observações da suplementação.</p>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <label><span className={modalLabelClass}>Valor suplementado</span><input required value={supForm.valor} onChange={(e) => setSupForm({ ...supForm, valor: e.target.value })} placeholder="Valor suplementado" className={modalInputClass} /></label>
              <label><span className={modalLabelClass}>Moeda</span><input value={supForm.moeda} onChange={(e) => setSupForm({ ...supForm, moeda: e.target.value })} placeholder="Moeda" className={modalInputClass} /></label>
              <label><span className={modalLabelClass}>Mensagem / Documento</span><input value={supForm.msg_referencia} onChange={(e) => setSupForm({ ...supForm, msg_referencia: e.target.value })} placeholder="Mensagem/documento" className={modalInputClass} /></label>
              <label><span className={modalLabelClass}>Data da mensagem</span><input type="date" value={supForm.data_msg} onChange={(e) => setSupForm({ ...supForm, data_msg: e.target.value })} className={modalInputClass} /></label>
            </div>
            <label className="block"><span className={modalLabelClass}>Observações da suplementação</span><textarea value={supForm.observacao} onChange={(e) => setSupForm({ ...supForm, observacao: e.target.value })} placeholder="Observação da suplementação" className={modalTextAreaClass} /></label>
            <div className="flex justify-end gap-3"><button type="button" onClick={() => setSupTarget(null)} className="px-6 py-3 rounded-xl bg-slate-200 text-slate-900 font-black hover:bg-slate-300">Cancelar</button><button type="submit" className="px-6 py-3 rounded-xl bg-blue-600 text-white font-black hover:bg-blue-700">Registrar</button></div>
          </form>
        </div>
      )}
    </div>
  );
}
