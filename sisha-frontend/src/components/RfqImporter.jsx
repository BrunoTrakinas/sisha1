import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Plus, RefreshCw, Pencil, Trash2, X } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { apiFetch, buildAuthHeaders } from '../lib/api';

const relationOptions = [
    ['', 'Sem relação'],
    ['ALTERNATIVO', 'Alternativo'],
    ['EQUIVALENTE', 'Equivalente'],
    ['SUPERSEDES', 'PN cotado é evolução/fornecimento atual do PN relacionado'],
    ['SUPERSEDED_BY', 'Este PN foi substituído pelo PN relacionado'],
];
const typeOptions = ['MATERIAL', 'REPARO', 'OVERHAUL', 'SERVICO', 'OUTRO'];
const documentTypeLabels = { LEONARDO_QUOTATION: 'Leonardo Quotation', LEONARDO_PRICE_LETTER: 'Carta Leonardo — preço/venda', LEONARDO_REPAIR_PRICE_LETTER: 'Carta Leonardo — Repair / Overhaul', GENERIC_COMMERCIAL_DOCUMENT: 'Documento comercial genérico' };
const priceStatusOptions = ['PRICED', 'AWAITING_PRICE', 'UNDER_INVESTIGATION', 'UNPRICED'];
const jobStatusLabels = { QUEUED: 'Na fila', PROCESSING: 'Processando', REVIEW_READY: 'Pronto para revisão', ERROR: 'Falha', SAVED: 'Gravado' };
const ACTIVE_JOB_KEY = 'sisha_rfq_active_job_id';
const CURRENT_ANALYSIS_VERSION = 'C2.7-HF2-LOCAL-OCR-RETRY-CACHE-1';
const emptyItem = () => ({ item_num: 1, pn: '', nsn: '', material_reference: '', material_reference_status: '', nomenclatura: '', source_description_status: '', sn: '', wo_referencia: '', qtd_solicitada: 1, lead_time: 0, lead_time_original: '', estoque_pronto: 0, valor_unitario: 0, valor_total_item: 0, preco_base: 0, desconto_percentual: 0, price_status: 'UNPRICED', tipo_cotacao: 'MATERIAL', one_time_only: false, limite_quantidade: 0, prazo_condicao: '', match_mode: 'EXACT', pn_original_solicitado: '', correcao_pn_tipo: '', source_page: '', source_excerpt: '', condicao_item: '', pn_relacionado: '', tipo_relacao_pn: '', relacao_pn_texto: '', observacoes: '' });
const manualMetadata = () => ({ quotation_number: '', quotation_date: '', quotation_printed_date: '', validity: '', reference: '', contract_reference: '', condicao: '', moeda: 'GBP', fornecedor: '', tipo_cotacao: 'MATERIAL', documento_tipo: 'GENERIC_COMMERCIAL_DOCUMENT', payment_terms: '', delivery_terms: '', stock_availability_note: '', items_total: 0, packing_delivery_percent: 0, packing_delivery_value: 0, final_amount: 0, quality_status: 'REVIEW', quality_warnings: [], observacoes: '', origem_registro: 'MANUAL', metodo_leitura: '' });

export default function RfqImporter() {
    const { token } = useAuth();
    const [file, setFile] = useState(null);
    const [isUploading, setIsUploading] = useState(false);
    const [isSaving, setIsSaving] = useState(false);
    const [rfqData, setRfqData] = useState(null);
    const [managerOpen, setManagerOpen] = useState(false);
    const [quotes, setQuotes] = useState([]);
    const [loadingQuotes, setLoadingQuotes] = useState(false);
    const [quoteSearch, setQuoteSearch] = useState('');
    const [editing, setEditing] = useState(null);
    const [activeJobId, setActiveJobId] = useState(() => { try { return window.localStorage.getItem(ACTIVE_JOB_KEY) || ''; } catch { return ''; } });
    const [activeJob, setActiveJob] = useState(null);
    const [recentJobs, setRecentJobs] = useState([]);
    const [jobsOpen, setJobsOpen] = useState(false);
    const reviewOpenedRef = useRef('');
    const legacyWarnedRef = useRef('');

    const loadQuotes = async () => {
        setLoadingQuotes(true);
        try {
            const params = new URLSearchParams({ include_inactive: 'true' });
            if (quoteSearch.trim()) params.set('q', quoteSearch.trim());
            const response = await apiFetch(`/import/rfq/cotacoes?${params.toString()}`, { headers: buildAuthHeaders(token) }, token);
            const result = await response.json();
            if (!response.ok || result.status !== 'success') throw new Error(result.message || 'Falha ao consultar cotações.');
            setQuotes(result.data || []);
        } catch (error) { alert(error.message || 'Falha ao consultar cotações.'); }
        finally { setLoadingQuotes(false); }
    };

    useEffect(() => { if (managerOpen) loadQuotes(); }, [managerOpen]); // eslint-disable-line react-hooks/exhaustive-deps

    const openJobReview = (job) => {
        if (job?.analysis_version && job.analysis_version !== CURRENT_ANALYSIS_VERSION) {
            if (legacyWarnedRef.current !== String(job.id || '')) {
                legacyWarnedRef.current = String(job.id || '');
                alert('Esta análise foi gerada por uma versão anterior ao leitor visual C2.5 e não será reaberta. Reenvie o PDF original para uma nova leitura.');
            }
            rememberActiveJob('');
            return;
        }
        const payload = job?.result_payload;
        if (!payload || !Array.isArray(payload.items)) return;
        reviewOpenedRef.current = String(job.id || '');
        setRfqData({
            metadados: {
                ...(payload.metadados || {}),
                origem_registro: 'IMPORTADO',
                tipo_cotacao: payload.metadados?.tipo_cotacao || 'MATERIAL',
                import_job_id: job.id,
                import_job_status: job.status || 'REVIEW_READY',
            },
            items: payload.items || [],
        });
    };

    const rememberActiveJob = (jobId) => {
        const safe = String(jobId || '').trim();
        setActiveJobId(safe);
        try {
            if (safe) window.localStorage.setItem(ACTIVE_JOB_KEY, safe);
            else window.localStorage.removeItem(ACTIVE_JOB_KEY);
        } catch { /* armazenamento local indisponível não bloqueia o backend */ }
    };

    const loadRecentJobs = async () => {
        try {
            const response = await apiFetch('/import/rfq/jobs?limit=20', { headers: buildAuthHeaders(token) }, token);
            const result = await response.json();
            if (!response.ok || result.status !== 'success') throw new Error(result.message || 'Falha ao consultar processamentos.');
            setRecentJobs(result.data || []);
        } catch (error) { alert(error.message || 'Falha ao consultar processamentos.'); }
    };

    const loadJob = async (jobId, { openReview = false } = {}) => {
        if (!jobId) return null;
        const response = await apiFetch(`/import/rfq/jobs/${jobId}`, { headers: buildAuthHeaders(token) }, token);
        const result = await response.json();
        if (!response.ok || result.status !== 'success') throw new Error(result.message || 'Falha ao consultar processamento.');
        const job = result.data;
        setActiveJob(job);
        if (openReview && ['REVIEW_READY', 'SAVED'].includes(job?.status) && job?.result_payload && reviewOpenedRef.current !== String(job.id || '')) openJobReview(job);
        return job;
    };

    useEffect(() => {
        if (!activeJobId) return undefined;
        let cancelled = false;
        const poll = async () => {
            try {
                const job = await loadJob(activeJobId, { openReview: true });
                if (cancelled) return;
                if (job?.status === 'ERROR') {
                    rememberActiveJob('');
                    alert(job.diagnostic || 'Falha ao processar o documento comercial.');
                }
            } catch (error) {
                if (!cancelled) console.warn('[SISHA][RFQ] Falha temporária ao consultar job:', error.message || error);
            }
        };
        poll();
        const timer = window.setInterval(poll, 1800);
        return () => { cancelled = true; window.clearInterval(timer); };
    }, [activeJobId]); // eslint-disable-line react-hooks/exhaustive-deps

    const handleLerPdf = async () => {
        if (!file) return alert('Selecione a Cotação/RFQ (.pdf, .xlsx ou .xls) primeiro.');
        setIsUploading(true);
        const formData = new FormData();
        formData.append('file', file);
        try {
            const response = await apiFetch('/import/rfq/jobs', { method: 'POST', headers: buildAuthHeaders(token), body: formData }, token);
            const result = await response.json();
            if (!response.ok || result.status !== 'success') throw new Error(result.message || 'Erro na leitura.');
            const job = result.data;
            rememberActiveJob(job.id);
            setActiveJob(job);
            if (['REVIEW_READY', 'SAVED'].includes(job.status) && job.result_payload) openJobReview(job);
        } catch (error) { alert(error.message || 'Falha na comunicação com o motor do servidor.'); }
        finally { setIsUploading(false); }
    };

    const startManual = () => setRfqData({ metadados: manualMetadata(), items: [emptyItem()] });
    const handleMetaChange = (field, value) => setRfqData((prev) => ({ ...prev, metadados: { ...prev.metadados, [field]: value } }));
    const handleItemChange = (index, field, value) => setRfqData((prev) => ({ ...prev, items: prev.items.map((row, rowIndex) => rowIndex === index ? { ...row, [field]: value } : row) }));
    const addItem = () => setRfqData((prev) => ({ ...prev, items: [...prev.items, { ...emptyItem(), item_num: prev.items.length + 1 }] }));

    const handleSalvarDefinitivo = async () => {
        if (isSaving) return;
        const alreadySaved = String(rfqData?.metadados?.import_job_status || activeJob?.status || '').toUpperCase() === 'SAVED';
        if (alreadySaved) return alert('Este documento comercial já foi gravado. A revisão reaberta é somente para consulta.');

        setIsSaving(true);
        try {
            const response = await apiFetch('/import/rfq/salvar', { method: 'POST', headers: buildAuthHeaders(token, { 'Content-Type': 'application/json' }), body: JSON.stringify(rfqData) }, token);
            const result = await response.json();
            if (!response.ok || result.status !== 'success') throw new Error(result.message || 'Falha ao gravar documento comercial.');

            const warnings = Array.isArray(result.post_save_warnings) ? result.post_save_warnings.filter(Boolean) : [];
            alert([result.message, ...warnings].join('\n'));
            reviewOpenedRef.current = '';
            setRfqData(null);
            setFile(null);
            rememberActiveJob('');
            setActiveJob(null);
            if (managerOpen) loadQuotes();
            if (jobsOpen) loadRecentJobs();
        } catch (error) {
            alert(error.message || 'Falha ao salvar no banco.');
        } finally {
            setIsSaving(false);
        }
    };

    const editValue = (field, value) => setEditing((current) => ({ ...current, [field]: value }));
    const saveEdit = async () => {
        if (!editing?.id) return;
        try {
            const response = await apiFetch(`/import/rfq/cotacoes/${editing.id}`, { method: 'PUT', headers: buildAuthHeaders(token, { 'Content-Type': 'application/json' }), body: JSON.stringify(editing) }, token);
            const result = await response.json();
            if (!response.ok || result.status !== 'success') throw new Error(result.message || 'Falha ao atualizar.');
            setEditing(null); await loadQuotes();
        } catch (error) { alert(error.message || 'Falha ao atualizar cotação.'); }
    };
    const deactivate = async (row) => {
        if (!window.confirm(`Desativar a cotação ${row.cotacao_numero} do PN ${row.pn}? O histórico será preservado.`)) return;
        try {
            const response = await apiFetch(`/import/rfq/cotacoes/${row.id}`, { method: 'DELETE', headers: buildAuthHeaders(token) }, token);
            const result = await response.json();
            if (!response.ok || result.status !== 'success') throw new Error(result.message || 'Falha ao desativar.');
            await loadQuotes();
        } catch (error) { alert(error.message || 'Falha ao desativar cotação.'); }
    };

    const closeReview = () => {
        reviewOpenedRef.current = '';
        setRfqData(null);
        rememberActiveJob('');
        setActiveJob(null);
    };

    const activeCount = useMemo(() => quotes.filter((row) => row.ativo !== false).length, [quotes]);
    const reviewAlreadySaved = String(rfqData?.metadados?.import_job_status || activeJob?.status || '').toUpperCase() === 'SAVED';
    const reviewBlocked = String(rfqData?.metadados?.quality_status || '').toUpperCase() === 'BLOCKED';

    return (
        <div className="p-6 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl mb-6 shadow-sm">
            <h2 className="text-lg font-black text-slate-800 dark:text-slate-200 mb-2 uppercase">Cotações, Cartas e RFQ</h2>
            <p className="text-xs font-bold text-slate-500 dark:text-slate-400 mb-4">Envie o documento comercial original. O SISHA identifica Quotation, carta de preço e carta de Repair/Overhaul e sempre abre revisão editável antes da gravação.</p>
            <div className="flex flex-col lg:flex-row items-stretch lg:items-center gap-3">
                <input type="file" accept=".pdf,.xlsx,.xls" onChange={(e) => setFile(e.target.files?.[0] || null)} className="flex-1 w-full p-2 border-2 border-dashed border-slate-300 dark:border-slate-700 rounded-lg bg-white dark:bg-slate-950 text-slate-900 dark:text-slate-100 file:mr-4 file:py-2 file:px-4 file:rounded-lg file:border-0 file:text-sm file:font-black file:bg-blue-50 dark:file:bg-blue-950/40 file:text-blue-700 dark:file:text-blue-300 hover:file:bg-blue-100 dark:hover:file:bg-blue-900/40 cursor-pointer" />
                <button onClick={handleLerPdf} disabled={isUploading || !file} className="bg-slate-700 text-white px-6 py-3 rounded-lg font-black hover:bg-slate-600 disabled:opacity-50 uppercase">{isUploading ? 'A LER...' : 'LER E REVISAR'}</button>
                <button onClick={startManual} className="bg-blue-600 text-white px-5 py-3 rounded-lg font-black hover:bg-blue-700 uppercase inline-flex items-center justify-center gap-2"><Plus size={17} /> Inserir manual</button>
                <button onClick={() => setManagerOpen(true)} className="bg-white dark:bg-slate-950 border border-slate-300 dark:border-slate-700 text-slate-700 dark:text-slate-300 px-5 py-3 rounded-lg font-black hover:bg-slate-100 dark:hover:bg-slate-800 uppercase">Gerenciar</button>
                <button onClick={() => { setJobsOpen((value) => !value); if (!jobsOpen) loadRecentJobs(); }} className="bg-white dark:bg-slate-950 border border-slate-300 dark:border-slate-700 text-slate-700 dark:text-slate-300 px-5 py-3 rounded-lg font-black hover:bg-slate-100 dark:hover:bg-slate-800 uppercase">Processamentos</button>
            </div>


            {activeJobId && activeJob && !rfqData ? (
                <div className="mt-4 rounded-xl border border-blue-200 dark:border-blue-900 bg-blue-50 dark:bg-blue-950/30 p-4 flex flex-col md:flex-row md:items-center md:justify-between gap-3">
                    <div><p className="text-sm font-black text-blue-900 dark:text-blue-200">{jobStatusLabels[activeJob.status] || activeJob.status} • {activeJob.file_name}</p><p className="text-xs font-bold text-blue-700 dark:text-blue-300 mt-1">O processamento é persistente. Você pode fechar ou atualizar a página; o backend continuará e esta revisão será reaberta quando estiver pronta.</p></div>
                    {activeJob.status === 'REVIEW_READY' && activeJob.result_payload ? <button onClick={() => openJobReview(activeJob)} className="px-4 py-2 rounded-lg bg-blue-600 text-white text-xs font-black uppercase">Abrir revisão</button> : null}
                </div>
            ) : null}

            {jobsOpen ? (
                <div className="mt-4 rounded-xl border border-slate-200 dark:border-slate-800 overflow-hidden">
                    <div className="p-3 bg-slate-50 dark:bg-slate-950 flex items-center justify-between"><p className="text-xs font-black uppercase text-slate-600 dark:text-slate-300">Processamentos recentes</p><button onClick={loadRecentJobs} className="p-2 rounded-lg hover:bg-slate-200 dark:hover:bg-slate-800" title="Atualizar"><RefreshCw size={15}/></button></div>
                    <div className="divide-y divide-slate-200 dark:divide-slate-800 max-h-64 overflow-auto">{recentJobs.length ? recentJobs.map((job) => <div key={job.id} className="p-3 flex flex-col md:flex-row md:items-center md:justify-between gap-2"><div><p className="text-sm font-bold text-slate-800 dark:text-slate-200">{job.file_name}</p><p className="text-[11px] font-bold text-slate-500">{jobStatusLabels[job.status] || job.status}{job.quotation_number ? ` • ${job.quotation_number}` : ''}{job.document_type ? ` • ${documentTypeLabels[job.document_type] || job.document_type}` : ''}</p></div><button disabled={!['REVIEW_READY','SAVED'].includes(job.status)} onClick={async () => { rememberActiveJob(job.id); const full = await loadJob(job.id); if (full?.result_payload) openJobReview(full); }} className="px-3 py-2 rounded-lg border text-xs font-black uppercase disabled:opacity-40">{job.status === 'SAVED' ? 'Visualizar' : 'Reabrir'}</button></div>) : <p className="p-4 text-sm text-slate-500">Nenhum processamento recente.</p>}</div>
                </div>
            ) : null}

            {rfqData && (
                <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-sm flex justify-center items-center z-50 p-4 sm:p-8">
                    <div className="bg-white dark:bg-slate-900 rounded-2xl shadow-2xl w-full max-w-7xl max-h-[94vh] overflow-hidden flex flex-col border-4 border-blue-600">
                        <div className="bg-blue-600 text-white p-5 flex justify-between items-center gap-4">
                            <div>
                                <h3 className="text-xl font-black uppercase">Revisão do Documento Comercial</h3>
                                <p className="text-sm text-blue-100 font-bold">{documentTypeLabels[rfqData.metadados.documento_tipo] || rfqData.metadados.documento_tipo || 'Documento comercial'} • leitura: {rfqData.metadados.metodo_leitura || 'manual'}</p>
                            </div>
                            <div className="flex items-center gap-2">{reviewAlreadySaved ? <span className="bg-emerald-100 text-emerald-800 px-3 py-1 rounded-full text-xs font-black">JÁ GRAVADO</span> : null}<span className="bg-white text-blue-800 px-3 py-1 rounded-full text-sm font-black">{rfqData.items.length} ITENS</span></div>
                        </div>
                        <div className="p-5 overflow-y-auto bg-slate-100 dark:bg-slate-950 flex-1 space-y-5">
                            {String(rfqData.metadados.quality_status || '').toUpperCase() === 'BLOCKED' ? (
                                <div className="bg-red-50 dark:bg-red-950/30 border border-red-300 dark:border-red-800 rounded-xl p-4 text-red-900 dark:text-red-200 font-black">Fidelity Gate bloqueou esta leitura. O documento não pode ser gravado enquanto a estrutura não for reprocessada corretamente.</div>
                            ) : null}
                            {Array.isArray(rfqData.metadados.quality_warnings) && rfqData.metadados.quality_warnings.length > 0 ? (
                                <div className="bg-amber-50 dark:bg-amber-950/30 border border-amber-300 dark:border-amber-800 rounded-xl p-4">
                                    <p className="font-black text-amber-900 dark:text-amber-200 uppercase text-xs mb-2">Revisão necessária</p>
                                    {rfqData.metadados.quality_warnings.map((warning, i) => <p key={i} className="text-sm font-bold text-amber-800 dark:text-amber-300">• {warning}</p>)}
                                </div>
                            ) : null}
                            <div className="grid grid-cols-1 md:grid-cols-4 gap-4 bg-white dark:bg-slate-900 p-5 rounded-xl border border-slate-200 dark:border-slate-700">
                                <label className="text-xs font-black text-slate-500 uppercase">Tipo documental<select value={rfqData.metadados.documento_tipo || 'GENERIC_COMMERCIAL_DOCUMENT'} onChange={(e) => handleMetaChange('documento_tipo', e.target.value)} className="mt-1 w-full border p-2 bg-white dark:bg-slate-950 dark:border-slate-700"><option value="LEONARDO_QUOTATION">Leonardo Quotation</option><option value="LEONARDO_PRICE_LETTER">Carta Leonardo — preço/venda</option><option value="LEONARDO_REPAIR_PRICE_LETTER">Carta Leonardo — Repair/Overhaul</option><option value="GENERIC_COMMERCIAL_DOCUMENT">Genérico</option></select></label>
                                <label className="text-xs font-black text-slate-500 uppercase">Nº / Ref. principal<input value={rfqData.metadados.quotation_number || ''} onChange={(e) => handleMetaChange('quotation_number', e.target.value)} className="mt-1 w-full border-b-2 p-1" /></label>
                                <label className="text-xs font-black text-slate-500 uppercase">Data da cotação<input value={rfqData.metadados.quotation_date || ''} onChange={(e) => handleMetaChange('quotation_date', e.target.value)} placeholder="DD/MM/AAAA" className="mt-1 w-full border-b-2 p-1" /></label>
                                <label className="text-xs font-black text-slate-500 uppercase">Data de impressão<input value={rfqData.metadados.quotation_printed_date || ''} onChange={(e) => handleMetaChange('quotation_printed_date', e.target.value)} placeholder="DD/MM/AAAA" className="mt-1 w-full border-b-2 p-1" /></label>
                                <label className="text-xs font-black text-slate-500 uppercase">Validade / prazo<input value={rfqData.metadados.validity || ''} onChange={(e) => handleMetaChange('validity', e.target.value)} className="mt-1 w-full border-b-2 p-1 text-amber-700" /></label>
                                <label className="text-xs font-black text-slate-500 uppercase">Fornecedor<input value={rfqData.metadados.fornecedor || ''} onChange={(e) => handleMetaChange('fornecedor', e.target.value)} className="mt-1 w-full border-b-2 p-1 uppercase" /></label>
                                <label className="text-xs font-black text-slate-500 uppercase">Contrato<input value={rfqData.metadados.contract_reference || ''} onChange={(e) => handleMetaChange('contract_reference', e.target.value)} className="mt-1 w-full border-b-2 p-1" /></label>
                                <label className="text-xs font-black text-slate-500 uppercase">Referência documental<input value={rfqData.metadados.reference || ''} onChange={(e) => handleMetaChange('reference', e.target.value)} className="mt-1 w-full border-b-2 p-1" /></label>
                                <label className="text-xs font-black text-slate-500 uppercase">Condição<input value={rfqData.metadados.condicao || ''} onChange={(e) => handleMetaChange('condicao', e.target.value)} placeholder="Não informado na fonte" className="mt-1 w-full border-b-2 p-1" /></label>
                                <label className="text-xs font-black text-slate-500 uppercase md:col-span-2">Pagamento<input value={rfqData.metadados.payment_terms || ''} onChange={(e) => handleMetaChange('payment_terms', e.target.value)} className="mt-1 w-full border p-2 rounded-lg" /></label>
                                <label className="text-xs font-black text-slate-500 uppercase md:col-span-2">Entrega / Incoterm<input value={rfqData.metadados.delivery_terms || ''} onChange={(e) => handleMetaChange('delivery_terms', e.target.value)} className="mt-1 w-full border p-2 rounded-lg" /></label>
                                <label className="text-xs font-black text-slate-500 uppercase">Items total (£)<input type="number" step="0.01" value={rfqData.metadados.items_total || ''} onChange={(e) => handleMetaChange('items_total', Number(e.target.value) || 0)} className="mt-1 w-full border p-2 rounded-lg" /></label>
                                <label className="text-xs font-black text-slate-500 uppercase">Packing %<input type="number" step="0.001" value={rfqData.metadados.packing_delivery_percent || ''} onChange={(e) => handleMetaChange('packing_delivery_percent', Number(e.target.value) || 0)} className="mt-1 w-full border p-2 rounded-lg" /></label>
                                <label className="text-xs font-black text-slate-500 uppercase">Packing valor (£)<input type="number" step="0.01" value={rfqData.metadados.packing_delivery_value || ''} onChange={(e) => handleMetaChange('packing_delivery_value', Number(e.target.value) || 0)} className="mt-1 w-full border p-2 rounded-lg" /></label>
                                <label className="text-xs font-black text-slate-500 uppercase">Final amount (£)<input type="number" step="0.01" value={rfqData.metadados.final_amount || ''} onChange={(e) => handleMetaChange('final_amount', Number(e.target.value) || 0)} className="mt-1 w-full border p-2 rounded-lg font-black" /></label>
                                <label className="text-xs font-black text-slate-500 uppercase md:col-span-4">Observações<input value={rfqData.metadados.observacoes || ''} onChange={(e) => handleMetaChange('observacoes', e.target.value)} className="mt-1 w-full border p-2 rounded-lg" /></label>
                                {rfqData.metadados.stock_availability_note ? <div className="md:col-span-4 rounded-lg border border-sky-300 bg-sky-50 dark:bg-sky-950/30 p-3 text-xs font-bold text-sky-900 dark:text-sky-200">{rfqData.metadados.stock_availability_note}</div> : null}
                            </div>
                            {rfqData.metadados.aviso_ia ? <div className="bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800 text-amber-800 dark:text-amber-300 rounded-xl p-4 text-sm font-bold">{rfqData.metadados.aviso_ia}</div> : null}
                            <div className="space-y-4">
                                {rfqData.items.map((item, idx) => (
                                    <div key={`${item.pn || 'item'}-${idx}`} className="bg-white dark:bg-slate-950 border-2 border-slate-200 dark:border-slate-700 rounded-xl p-5 shadow-sm relative">
                                        <button onClick={() => setRfqData({ ...rfqData, items: rfqData.items.filter((_, i) => i !== idx) })} className="absolute top-3 right-3 bg-red-50 dark:bg-red-950/30 text-red-500 rounded-lg p-2"><X size={16} /></button>
                                        <div className="mb-3 text-[10px] font-black uppercase tracking-wide text-slate-500">Item da fonte #{item.item_num || idx + 1}</div>
                                        <div className="grid grid-cols-1 md:grid-cols-12 gap-4 pr-10">
                                            <label className="md:col-span-2 text-[10px] font-black text-slate-500 uppercase">Tipo<select value={item.tipo_cotacao || rfqData.metadados.tipo_cotacao || 'MATERIAL'} onChange={(e) => handleItemChange(idx, 'tipo_cotacao', e.target.value)} className="w-full mt-1 border rounded-lg p-2 bg-white dark:bg-slate-950">{typeOptions.map((type) => <option key={type}>{type}</option>)}</select></label>
                                            <label className="md:col-span-3 text-[10px] font-black text-slate-500 uppercase">Part Number<input value={item.pn || ''} onChange={(e) => handleItemChange(idx, 'pn', e.target.value)} className="w-full font-black text-lg border-b-2 uppercase" /></label>
                                            <label className="md:col-span-3 text-[10px] font-black text-slate-500 uppercase">Referência / NSN da fonte<input value={item.material_reference || item.nsn || ''} onChange={(e) => { handleItemChange(idx, 'material_reference', e.target.value); }} className="w-full font-bold border-b-2" /><span className="text-[9px]">Interpretação NSN: {item.nsn || '—'} {item.material_reference_status ? `• ${item.material_reference_status}` : ''}</span></label>
                                            <label className="md:col-span-4 text-[10px] font-black text-slate-500 uppercase">Descrição<input value={item.nomenclatura || ''} onChange={(e) => handleItemChange(idx, 'nomenclatura', e.target.value)} placeholder={item.source_description_status === 'SOURCE_MISSING' ? 'Não informada na fonte' : ''} className="w-full font-bold border-b-2 uppercase" />{item.source_description_status === 'SOURCE_MISSING' ? <span className="text-[9px] text-amber-700 font-black">A fonte não informou descrição; o SISHA não inventou nomenclatura.</span> : null}</label>
                                            <label className="md:col-span-2 text-[10px] font-black text-blue-600 uppercase">Qtd<input type="number" step="0.01" value={item.qtd_solicitada || ''} onChange={(e) => handleItemChange(idx, 'qtd_solicitada', Number(e.target.value) || 0)} className="w-full border-2 rounded-lg p-2 text-center" /></label>
                                            <label className="md:col-span-2 text-[10px] font-black text-slate-600 uppercase">Lead Time original<input value={item.lead_time_original || ''} onChange={(e) => handleItemChange(idx, 'lead_time_original', e.target.value)} placeholder="Ex.: 53 WEEK(S)" className="w-full border-2 rounded-lg p-2 text-center" /></label>
                                            <label className="md:col-span-2 text-[10px] font-black text-slate-600 uppercase">Lead Time derivado (dias)<input type="number" value={item.lead_time || ''} onChange={(e) => handleItemChange(idx, 'lead_time', Number(e.target.value) || 0)} className="w-full border-2 rounded-lg p-2 text-center" /></label>
                                            <label className="md:col-span-2 text-[10px] font-black text-slate-600 uppercase">Disponível na data da cotação<input type="number" step="0.01" value={item.estoque_pronto || ''} onChange={(e) => handleItemChange(idx, 'estoque_pronto', Number(e.target.value) || 0)} className="w-full border-2 rounded-lg p-2 text-center" /></label>
                                            <label className="md:col-span-2 text-[10px] font-black text-slate-600 uppercase">Situação do preço<select value={item.price_status || 'UNPRICED'} onChange={(e) => handleItemChange(idx, 'price_status', e.target.value)} className="w-full border-2 rounded-lg p-2 bg-white dark:bg-slate-950">{priceStatusOptions.map((v) => <option key={v}>{v}</option>)}</select></label>
                                            <label className="md:col-span-2 text-[10px] font-black text-emerald-700 uppercase">Preço Unit (£)<input type="number" step="0.01" value={item.valor_unitario || ''} onChange={(e) => handleItemChange(idx, 'valor_unitario', Number(e.target.value) || 0)} className="w-full border-2 border-emerald-200 bg-emerald-50 dark:bg-emerald-950/30 rounded-lg p-2 text-center font-black" /></label>
                                            <label className="md:col-span-2 text-[10px] font-black text-slate-500 uppercase">Valor linha (£)<input type="number" step="0.01" value={item.valor_total_item || ''} onChange={(e) => handleItemChange(idx, 'valor_total_item', Number(e.target.value) || 0)} className="w-full border-2 rounded-lg p-2" /></label>
                                            <label className="md:col-span-2 text-[10px] font-black text-slate-500 uppercase">Preço-base (£)<input type="number" step="0.01" value={item.preco_base || ''} onChange={(e) => handleItemChange(idx, 'preco_base', Number(e.target.value) || 0)} className="w-full border-2 rounded-lg p-2" /></label>
                                            <label className="md:col-span-2 text-[10px] font-black text-slate-500 uppercase">Desconto %<input type="number" step="0.01" value={item.desconto_percentual || ''} onChange={(e) => handleItemChange(idx, 'desconto_percentual', Number(e.target.value) || 0)} className="w-full border-2 rounded-lg p-2" /></label>
                                            <label className="md:col-span-2 text-[10px] font-black text-slate-500 uppercase">Match PN<select value={item.match_mode || 'EXACT'} onChange={(e) => handleItemChange(idx, 'match_mode', e.target.value)} className="w-full border-2 rounded-lg p-2 bg-white dark:bg-slate-950"><option>EXACT</option><option>PATTERN</option></select></label>
                                            <label className="md:col-span-2 text-[10px] font-black text-slate-500 uppercase">Prazo condição<input value={item.prazo_condicao || ''} onChange={(e) => handleItemChange(idx, 'prazo_condicao', e.target.value)} placeholder="DD/MM/AAAA" className="w-full border-2 rounded-lg p-2" /></label>
                                            <label className="md:col-span-2 text-[10px] font-black text-slate-500 uppercase">Limite Qtd<input type="number" step="0.01" value={item.limite_quantidade || ''} onChange={(e) => handleItemChange(idx, 'limite_quantidade', Number(e.target.value) || 0)} className="w-full border-2 rounded-lg p-2" /></label>
                                            <label className="md:col-span-2 text-[10px] font-black text-slate-500 uppercase flex items-center gap-2 pt-5"><input type="checkbox" checked={Boolean(item.one_time_only)} onChange={(e) => handleItemChange(idx, 'one_time_only', e.target.checked)} /> One-time only</label>
                                            {item.pn_original_solicitado ? <div className="md:col-span-12 rounded-lg border border-amber-300 bg-amber-50 dark:bg-amber-950/30 p-3 text-xs font-bold text-amber-900 dark:text-amber-200">PN solicitado originalmente: <span className="font-mono">{item.pn_original_solicitado}</span> • correção documental: {item.correcao_pn_tipo || 'A CONFIRMAR'}. Isso não é tratado automaticamente como PN alternativo.</div> : null}
                                            {item.match_mode === 'PATTERN' ? <div className="md:col-span-12 rounded-lg border border-orange-300 bg-orange-50 dark:bg-orange-950/30 p-3 text-xs font-bold text-orange-900 dark:text-orange-200">PN com wildcard/padrão documental. Não será usado como correspondência exata nem como preço automático de outro PN sem confirmação.</div> : null}
                                            <label className="md:col-span-2 text-[10px] font-black text-slate-500 uppercase">Página fonte<input type="number" value={item.source_page || ''} onChange={(e) => handleItemChange(idx, 'source_page', Number(e.target.value) || '')} className="w-full border rounded-lg p-2" /></label>
                                            <label className="md:col-span-10 text-[10px] font-black text-slate-500 uppercase">Evidência original<textarea value={item.source_excerpt || ''} onChange={(e) => handleItemChange(idx, 'source_excerpt', e.target.value)} className="w-full border rounded-lg p-2 min-h-20 font-mono text-xs" /></label>
                                            <div className="md:col-span-12 border-t pt-4"><p className="text-[10px] font-black text-slate-500 uppercase mb-2">Relação de PN explicitamente informada</p><div className="grid grid-cols-1 md:grid-cols-12 gap-3"><input className="md:col-span-3 border rounded-lg p-2 font-bold uppercase" placeholder="PN relacionado/anterior" value={item.pn_relacionado || ''} onChange={(e) => handleItemChange(idx, 'pn_relacionado', e.target.value)} /><select className="md:col-span-4 border rounded-lg p-2 bg-white dark:bg-slate-950 font-bold" value={item.tipo_relacao_pn || ''} onChange={(e) => handleItemChange(idx, 'tipo_relacao_pn', e.target.value)}>{relationOptions.map(([value, label]) => <option key={value || 'none'} value={value}>{label}</option>)}</select><input className="md:col-span-5 border rounded-lg p-2" placeholder="Trecho/evidência" value={item.relacao_pn_texto || ''} onChange={(e) => handleItemChange(idx, 'relacao_pn_texto', e.target.value)} /></div></div>
                                            <label className="md:col-span-12 text-[10px] font-black text-slate-500 uppercase">Observação do item<input value={item.observacoes || ''} onChange={(e) => handleItemChange(idx, 'observacoes', e.target.value)} className="w-full mt-1 border rounded-lg p-2" /></label>
                                        </div>
                                    </div>
                                ))}
                                <button onClick={addItem} className="w-full py-3 border-2 border-dashed border-blue-300 text-blue-700 rounded-xl font-black hover:bg-blue-50 inline-flex items-center justify-center gap-2"><Plus size={17} /> ADICIONAR LINHA</button>
                            </div>
                        </div>
                        <div className="bg-white dark:bg-slate-900 p-5 border-t flex justify-end gap-3"><button onClick={closeReview} className="px-6 py-3 font-black text-slate-500">FECHAR REVISÃO</button><button disabled={isSaving || reviewAlreadySaved || rfqData.items.length === 0 || reviewBlocked} onClick={handleSalvarDefinitivo} className={`px-7 py-3 font-black text-white rounded-xl disabled:opacity-60 ${reviewAlreadySaved ? 'bg-emerald-700' : 'bg-blue-600'}`}>{reviewAlreadySaved ? 'DOCUMENTO JÁ GRAVADO' : isSaving ? 'GRAVANDO...' : 'APROVAR E GRAVAR'}</button></div>
                    </div>
                </div>
            )}

            {managerOpen && (
                <div className="fixed inset-0 z-[80] bg-slate-950/70 flex items-center justify-center p-4">
                    <div className="w-full max-w-7xl max-h-[92vh] bg-white dark:bg-slate-900 rounded-2xl overflow-hidden flex flex-col">
                        <div className="p-5 border-b flex items-center justify-between gap-4"><div><h3 className="font-black text-xl text-slate-900 dark:text-slate-100 uppercase">Banco de Cotações</h3><p className="text-sm font-bold text-slate-500 dark:text-slate-400">{activeCount} registro(s) ativo(s). Cotações vencidas permanecem como histórico.</p></div><button onClick={() => { setManagerOpen(false); setEditing(null); }} className="p-2"><X /></button></div>
                        <div className="p-4 border-b bg-slate-50 dark:bg-slate-950/60 flex gap-2"><input value={quoteSearch} onChange={(e) => setQuoteSearch(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && loadQuotes()} placeholder="PN, cotação, fornecedor, WO, SN..." className="flex-1 border rounded-xl p-3 font-bold" /><button onClick={loadQuotes} className="px-4 rounded-xl bg-slate-800 text-white font-black inline-flex items-center gap-2"><RefreshCw size={16} /> BUSCAR</button></div>
                        <div className="overflow-auto flex-1">
                            <table className="min-w-[1300px] w-full text-sm"><thead className="sticky top-0 bg-slate-900 text-white"><tr>{['Status','Cotação','Fornecedor','Tipo','PN','PN relacionado','WO/SN','Valor GBP','Validade','Observações','Ações'].map((h) => <th key={h} className="p-3 text-left text-xs uppercase">{h}</th>)}</tr></thead><tbody>{loadingQuotes ? <tr><td colSpan="11" className="p-8 text-center font-black">CARREGANDO...</td></tr> : quotes.map((row) => <tr key={row.id} className="border-b align-top"><td className="p-3 font-black">{row.ativo === false ? 'DESATIVADA' : 'ATIVA'}</td><td className="p-3 font-bold">{row.cotacao_numero}</td><td className="p-3">{row.fornecedor}</td><td className="p-3 font-black">{row.tipo_cotacao}<div className="text-[9px] text-slate-500">{documentTypeLabels[row.documento_tipo] || row.documento_tipo || ''}</div></td><td className="p-3 font-mono font-black">{row.pn}</td><td className="p-3 font-mono">{row.pn_relacionado || '—'}{row.tipo_relacao_pn ? <div className="text-[10px] font-black text-amber-700">{row.tipo_relacao_pn}</div> : null}</td><td className="p-3">{row.wo_referencia || '—'}<div>{row.sn || ''}</div></td><td className="p-3 font-black">£ {Number(row.valor_unitario || 0).toLocaleString('en-GB',{minimumFractionDigits:2})}</td><td className="p-3">{row.validade}</td><td className="p-3 max-w-xs">{row.observacoes || '—'}</td><td className="p-3"><div className="flex gap-1"><button onClick={() => setEditing({ ...row })} className="p-2 rounded bg-blue-50 dark:bg-blue-950/30 text-blue-700"><Pencil size={15}/></button>{row.ativo !== false ? <button onClick={() => deactivate(row)} className="p-2 rounded bg-red-50 dark:bg-red-950/30 text-red-600"><Trash2 size={15}/></button> : null}</div></td></tr>)}</tbody></table>
                        </div>
                        {editing && <div className="border-t bg-blue-50 dark:bg-blue-950/30 p-4">
                            <p className="text-xs font-black text-blue-900 dark:text-blue-200 uppercase mb-3">Editar cotação — manutenção manual com histórico preservado</p>
                            <div className="grid grid-cols-2 md:grid-cols-6 gap-2">
                                <input value={editing.cotacao_numero || ''} onChange={(e)=>editValue('cotacao_numero',e.target.value)} placeholder="Cotação / carta" className="border rounded p-2"/>
                                <input value={editing.data_cotacao || ''} onChange={(e)=>editValue('data_cotacao',e.target.value)} placeholder="Data cotação" className="border rounded p-2"/>
                                <input value={editing.validade || ''} onChange={(e)=>editValue('validade',e.target.value)} placeholder="Validade" className="border rounded p-2"/>
                                <input value={editing.fornecedor || ''} onChange={(e)=>editValue('fornecedor',e.target.value)} placeholder="Fornecedor" className="border rounded p-2"/>
                                <select value={editing.tipo_cotacao || 'MATERIAL'} onChange={(e)=>editValue('tipo_cotacao',e.target.value)} className="border rounded p-2 bg-white dark:bg-slate-950 dark:border-slate-700">{typeOptions.map((t)=><option key={t}>{t}</option>)}</select>
                                <input value={editing.referencia_pedido || ''} onChange={(e)=>editValue('referencia_pedido',e.target.value)} placeholder="Referência / pedido" className="border rounded p-2"/>
                                <input value={editing.pn || ''} onChange={(e)=>editValue('pn',e.target.value)} placeholder="PN" className="border rounded p-2 uppercase"/>
                                <input value={editing.nsn || ''} onChange={(e)=>editValue('nsn',e.target.value)} placeholder="NSN" className="border rounded p-2 uppercase"/>
                                <input value={editing.nomenclatura || ''} onChange={(e)=>editValue('nomenclatura',e.target.value)} placeholder="Nomenclatura / descrição" className="border rounded p-2 md:col-span-2"/>
                                <input value={editing.condicao || ''} onChange={(e)=>editValue('condicao',e.target.value)} placeholder="Condição" className="border rounded p-2"/>
                                <input value={editing.valor_unitario || 0} type="number" step="0.01" onChange={(e)=>editValue('valor_unitario',Number(e.target.value)||0)} placeholder="Valor GBP" className="border rounded p-2"/>
                                <input value={editing.qtd_solicitada || 0} type="number" step="0.01" onChange={(e)=>editValue('qtd_solicitada',Number(e.target.value)||0)} placeholder="Qtd" className="border rounded p-2"/>
                                <input value={editing.lead_time_dias || 0} type="number" onChange={(e)=>editValue('lead_time_dias',Number(e.target.value)||0)} placeholder="Lead time (dias)" className="border rounded p-2"/>
                                <input value={editing.estoque_pronto || 0} type="number" step="0.01" onChange={(e)=>editValue('estoque_pronto',Number(e.target.value)||0)} placeholder="Estoque ofertado" className="border rounded p-2"/>
                                <input value={editing.wo_referencia || ''} onChange={(e)=>editValue('wo_referencia',e.target.value)} placeholder="WO / reparo" className="border rounded p-2"/>
                                <input value={editing.sn || ''} onChange={(e)=>editValue('sn',e.target.value)} placeholder="SN" className="border rounded p-2"/>
                                <input value={editing.pn_relacionado || ''} onChange={(e)=>editValue('pn_relacionado',e.target.value)} placeholder="PN relacionado / anterior" className="border rounded p-2 uppercase"/>
                                <select value={editing.tipo_relacao_pn || ''} onChange={(e)=>editValue('tipo_relacao_pn',e.target.value)} className="border rounded p-2 bg-white dark:bg-slate-950 dark:border-slate-700 md:col-span-2">{relationOptions.map(([v,l])=><option key={v||'none'} value={v}>{l}</option>)}</select>
                                <input value={editing.relacao_pn_texto || ''} onChange={(e)=>editValue('relacao_pn_texto',e.target.value)} placeholder="Trecho/evidência da relação de PN" className="border rounded p-2 md:col-span-3"/>
                                <input value={editing.documento_tipo || ''} onChange={(e)=>editValue('documento_tipo',e.target.value)} placeholder="Tipo documental" className="border rounded p-2 md:col-span-2"/>
                                <input value={editing.contrato_referencia || ''} onChange={(e)=>editValue('contrato_referencia',e.target.value)} placeholder="Contrato" className="border rounded p-2 md:col-span-2"/>
                                <select value={editing.price_status || 'UNPRICED'} onChange={(e)=>editValue('price_status',e.target.value)} className="border rounded p-2 bg-white dark:bg-slate-950">{priceStatusOptions.map((v)=><option key={v}>{v}</option>)}</select>
                                <select value={editing.match_mode || 'EXACT'} onChange={(e)=>editValue('match_mode',e.target.value)} className="border rounded p-2 bg-white dark:bg-slate-950"><option>EXACT</option><option>PATTERN</option></select>
                                <input value={editing.observacoes || ''} onChange={(e)=>editValue('observacoes',e.target.value)} placeholder="Observações livres" className="border rounded p-2 md:col-span-3"/>
                            </div>
                            <div className="mt-3 flex justify-end gap-2"><button onClick={()=>setEditing(null)} className="px-4 py-2 font-black">CANCELAR</button><button onClick={saveEdit} className="px-5 py-2 rounded bg-blue-700 text-white font-black">SALVAR EDIÇÃO</button></div>
                        </div>}
                    </div>
                </div>
            )}
        </div>
    );
}
