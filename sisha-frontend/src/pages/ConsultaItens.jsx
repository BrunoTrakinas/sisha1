import React, { useState } from 'react';
import { Truck, Package, Check, Upload, Download, LoaderCircle, X } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { apiFetch } from '../lib/api';

const SOURCE_LABELS = {
    ITEMS: 'Cadastro base',
    DICIONARIO_MESTRE: 'Manual',
    ESTOQUE_PPU: 'Inventário PPU',
    LISDE: 'LISDE',
    PRICE_LIST: 'Price List',
    RFQ_COTACOES: 'RFQ',
    PN_ALTERNATIVOS_DOCUMENTO: 'Doc. alternativos',
    CEIMSPA_VIA_DICIONARIO: 'CeIMSPA via manual',
    SERVICE_BULLETIN: 'Service Bulletin',
};

const formatSource = (value) => SOURCE_LABELS[value] || value || 'N/A';

export default function ConsultaItens() {
    const { token } = useAuth();
    const [termo, setTermo] = useState('');
    const [resultados, setResultados] = useState([]);
    const [carregando, setCarregando] = useState(false);
    const [buscaRealizada, setBuscaRealizada] = useState(false);

    const [modalAplicacoes, setModalAplicacoes] = useState(false);
    const [alvoAplicacoes, setAlvoAplicacoes] = useState([]);
    const [fontesMapa, setFontesMapa] = useState([]);
    const [modalLote, setModalLote] = useState(false);
    const [arquivoLote, setArquivoLote] = useState(null);
    const [loteCarregando, setLoteCarregando] = useState(false);
    const [loteExportando, setLoteExportando] = useState(false);
    const [loteErro, setLoteErro] = useState('');
    const [lotePreview, setLotePreview] = useState(null);

    const fecharModalLote = () => {
        setModalLote(false);
        setArquivoLote(null);
        setLoteErro('');
        setLotePreview(null);
        setLoteCarregando(false);
        setLoteExportando(false);
    };

    const executarPesquisaLote = async () => {
        if (!arquivoLote) {
            setLoteErro('Escolha a planilha da pesquisa em lote.');
            return;
        }

        setLoteCarregando(true);
        setLoteErro('');
        try {
            const formData = new FormData();
            formData.append('file', arquivoLote);
            const response = await apiFetch('/needs/batch-query/preview', {
                method: 'POST',
                body: formData,
            }, token);
            const json = await response.json();
            if (json.status !== 'success') throw new Error(json.message || 'Falha ao processar a pesquisa em lote.');
            setLotePreview(json.data);
        } catch (error) {
            setLoteErro(error.message || 'Falha ao processar a pesquisa em lote.');
            setLotePreview(null);
        }
        setLoteCarregando(false);
    };

    const exportarPesquisaLote = async () => {
        if (!arquivoLote) {
            setLoteErro('Escolha a planilha da pesquisa em lote.');
            return;
        }

        setLoteExportando(true);
        setLoteErro('');
        try {
            const formData = new FormData();
            formData.append('file', arquivoLote);
            const response = await apiFetch('/needs/batch-query/export/xlsx', {
                method: 'POST',
                body: formData,
            }, token);
            if (!response.ok) {
                const json = await response.json().catch(() => null);
                throw new Error(json?.message || 'Falha ao exportar a pesquisa em lote.');
            }
            const blob = await response.blob();
            const url = window.URL.createObjectURL(blob);
            const link = document.createElement('a');
            const disposition = response.headers.get('Content-Disposition') || '';
            const match = disposition.match(/filename="([^"]+)"/);
            link.href = url;
            link.download = match?.[1] || 'pesquisa_em_lote.xlsx';
            document.body.appendChild(link);
            link.click();
            link.remove();
            window.URL.revokeObjectURL(url);
        } catch (error) {
            setLoteErro(error.message || 'Falha ao exportar a pesquisa em lote.');
        }
        setLoteExportando(false);
    };

    const buscarItem = async (e) => {
        if (e) e.preventDefault();
        if (!termo.trim()) return;
        setCarregando(true);
        setBuscaRealizada(true);
        try {
            const response = await apiFetch(`/search?q=${encodeURIComponent(termo)}`, {}, token);
            const json = await response.json();
            if (json.status === 'success') {
                setResultados(json.data);
            } else {
                setResultados([]);
            }
        } catch (error) {
            setResultados([]);
        }
        setCarregando(false);
    };

    return (
        <div className={`w-full h-full flex flex-col transition-all duration-700 ease-in-out ${buscaRealizada ? 'items-center pt-3 sm:pt-4' : 'items-center justify-center mt-[-4vh] md:mt-[-10vh]'}`}>
            {!buscaRealizada && (
                <div className="text-center mb-6 sm:mb-8 animate-fade-in px-4">
                    <h1 className="text-3xl sm:text-4xl md:text-5xl font-black text-slate-800 tracking-tight md:tracking-tighter italic leading-none">
                        RADAR <span className="text-blue-600">LOGÍSTICO</span>
                    </h1>
                    <p className="text-slate-400 font-bold mt-2 uppercase tracking-[0.18em] sm:tracking-widest text-[10px] sm:text-xs">
                        SISHA-1 V2 • Motor de Inteligência Integrada
                    </p>
                </div>
            )}

            <form onSubmit={buscarItem} className={`w-full px-3 sm:px-4 transition-all duration-700 max-w-3xl ${buscaRealizada ? 'mb-4 sm:mb-6' : ''}`}>
                <div className="relative flex flex-col sm:flex-row sm:items-center gap-2 sm:gap-0 shadow-md rounded-3xl sm:rounded-full bg-white border border-slate-200 focus-within:ring-4 focus-within:ring-blue-100 transition-all p-2 sm:p-0">
                    <div className="pl-3 sm:pl-5 pr-1 text-blue-600 flex items-center h-10 sm:h-auto">
                        <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.5" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"></path>
                        </svg>
                    </div>

                    <input
                        type="text"
                        value={termo}
                        onChange={(e) => setTermo(e.target.value)}
                        placeholder="Pesquise por PN, Nome da peça ou SN..."
                        className="w-full py-2.5 sm:py-4 px-3 sm:px-4 text-sm sm:text-base bg-transparent border-none outline-none text-slate-700 uppercase"
                    />

                    <button
                        type="submit"
                        disabled={carregando}
                        className={`w-full sm:w-auto mr-0 sm:mr-2 bg-blue-600 text-white px-6 py-3 sm:py-2.5 rounded-2xl sm:rounded-full text-sm font-black hover:bg-blue-700 transition-all disabled:opacity-50 shadow-sm ${carregando ? 'animate-pulse' : ''}`}
                    >
                        {carregando ? 'BUSCANDO...' : 'RADAR'}
                    </button>
                </div>
            </form>

            <div className="w-full max-w-3xl px-3 sm:px-4 mb-4 flex justify-center sm:justify-end">
                <button
                    type="button"
                    onClick={() => setModalLote(true)}
                    className="w-full sm:w-auto inline-flex items-center justify-center gap-2 bg-white border border-slate-200 text-slate-700 px-4 py-2.5 rounded-xl text-xs font-black hover:border-blue-300 hover:text-blue-700 transition-all shadow-sm"
                >
                    <Upload size={14} /> PESQUISA EM LOTE
                </button>
            </div>

            <div className="w-full max-w-[95rem] px-3 sm:px-4 space-y-4 sm:space-y-5 animate-fade-in pb-20">
                {buscaRealizada && resultados.length === 0 && !carregando && (
                    <div className="text-center p-6 sm:p-10 bg-white rounded-2xl border-2 border-dashed border-slate-200">
                        <p className="text-slate-500 text-base sm:text-lg font-bold uppercase tracking-wider">
                            Nenhum alvo encontrado no radar logístico.
                        </p>
                    </div>
                )}

                {resultados.map((item, index) => (
                    <div key={index} className="bg-white p-4 sm:p-5 md:p-6 rounded-2xl border border-slate-200 shadow-sm relative overflow-hidden">
                        <div className="absolute top-0 left-0 w-1.5 h-full bg-blue-600"></div>

                        <div className="flex flex-col md:flex-row justify-between items-start md:items-center mb-5 sm:mb-6 pl-3 sm:pl-4 gap-4">
                            <div className="min-w-0">
                                <h2 className="text-xl sm:text-2xl md:text-3xl font-black text-slate-800 tracking-tight break-all">
                                    {item.pn}
                                </h2>

                                <p className="text-slate-600 font-bold text-sm sm:text-base mt-1">
                                    {item.nomenclatura}
                                </p>

                                <div className="mt-2.5 flex flex-wrap gap-2 sm:gap-3">
                                    <span className={`text-xs sm:text-sm font-mono font-black px-3 py-1 rounded-lg border ${item.nsn === 'Aguardando Cadastro' ? 'bg-amber-50 text-amber-600 border-amber-200' : 'bg-slate-50 text-slate-600 border-slate-200'}`}>
                                        NSN/PI: {item.nsn}
                                    </span>

                                    {item.origem_nomenclatura ? (
                                        <span className="text-[10px] sm:text-[11px] font-black px-3 py-1 rounded-lg border bg-blue-50 text-blue-700 border-blue-200 uppercase">
                                            Nome: {formatSource(item.origem_nomenclatura)}
                                        </span>
                                    ) : null}

                                    {item.origem_nsn ? (
                                        <span className="text-[10px] sm:text-[11px] font-black px-3 py-1 rounded-lg border bg-slate-50 text-slate-600 border-slate-200 uppercase">
                                            NSN: {formatSource(item.origem_nsn)}
                                        </span>
                                    ) : null}
                                </div>

                                {item.origem_identificacao && item.origem_identificacao.length > 0 ? (
                                    <div className="mt-2 flex flex-wrap gap-2">
                                        {item.origem_identificacao.map((fonte) => (
                                            <span key={fonte} className="text-[10px] font-black px-2.5 py-1 rounded-lg border bg-slate-50 text-slate-500 border-slate-200 uppercase">
                                                {formatSource(fonte)}
                                            </span>
                                        ))}
                                    </div>
                                ) : null}
                            </div>

                            <div className="w-full md:w-auto md:min-w-[11rem] mt-0 md:mt-0 flex flex-col items-stretch md:items-end">
                                <span className={`py-2.5 px-5 sm:px-6 rounded-xl text-lg sm:text-xl font-black shadow-sm text-center ${item.ppu_qtd > 0 ? 'bg-blue-600 text-white' : 'bg-slate-800 text-white'}`}>
                                    PPU: {item.ppu_qtd || 0} un
                                </span>
                                {item.ppu_qtd > 0 && (
                                    <span className="text-[10px] sm:text-[11px] font-black text-slate-500 mt-2 bg-slate-50 px-2 py-1 rounded border border-slate-200 uppercase text-center md:text-left">
                                        📍 Local: {item.ppu_locais}
                                    </span>
                                )}
                            </div>
                        </div>

                        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 xl:grid-cols-7 gap-3.5 border-t border-slate-100 pt-5">
                            <div className="bg-purple-50/50 rounded-xl p-4 border border-purple-100 flex flex-col shadow-sm">
                                <span className="text-sm font-black text-purple-600 uppercase mb-2">1. CEIMSPA</span>
                                {item.ceimspa_qtd > 0 ? (
                                    <div>
                                        <p className="text-2xl font-black text-purple-900">{item.ceimspa_qtd} <span className="text-sm">un</span></p>
                                        <div className="mt-2 space-y-1">
                                            {item.ceimspa_detalhes && item.ceimspa_detalhes.map((c, i) => (
                                                <p key={i} className="text-sm font-bold text-purple-800 bg-purple-100/50 px-2 py-1 rounded-lg border border-purple-200/50">
                                                    PI: {c.pi} | {c.sj} : <span className="font-black text-purple-900">{c.quantidade}</span>
                                                </p>
                                            ))}
                                        </div>
                                    </div>
                                ) : <span className="text-sm font-bold text-purple-400 mt-auto text-center border border-purple-100/50 py-1.5 rounded-lg">Item não encontrado</span>}
                            </div>

                            <div className="bg-emerald-50/50 rounded-xl p-4 border border-emerald-100 flex flex-col shadow-sm">
                                <span className="text-sm font-black text-emerald-600 uppercase mb-2">2. PD (ODA)</span>
                                {item.oda && item.oda.length > 0 ? item.oda.map((oda, i) => (
                                    <div key={i} className="mb-3 last:mb-0 border-b border-emerald-200/40 pb-2 last:border-0">
                                        <div className="flex justify-between items-center">
                                            <span className="font-black text-lg text-emerald-900">{oda.qtd_pendente} un</span>
                                            {oda.qtd_entregue > 0 && <span className="bg-emerald-600 text-white text-sm px-1.5 py-0.5 rounded flex items-center gap-1"><Check size={14}/> {oda.qtd_entregue}</span>}
                                        </div>
                                        <p className="text-sm font-bold text-emerald-700 mt-0.5 uppercase break-all">OC: {oda.oc_referencia}</p>
                                        <div className="flex flex-col gap-1 mt-2">
                                            {oda.qtd_em_rota > 0 && <span className="text-sm font-black bg-blue-100 text-blue-700 px-1.5 py-0.5 rounded border border-blue-200 flex items-center gap-1"><Truck size={14}/> {oda.qtd_em_rota} EM ROTA</span>}
                                            {oda.qtd_aguardando_coleta > 0 && <span className="text-sm font-black bg-yellow-100 text-yellow-700 px-1.5 py-0.5 rounded border border-yellow-200 flex items-center gap-1"><Package size={14}/> {oda.qtd_aguardando_coleta} COLETA</span>}
                                            {oda.qtd_em_rota === 0 && oda.qtd_aguardando_coleta === 0 && <span className="text-sm font-black bg-slate-200/70 text-slate-600 px-1.5 py-0.5 rounded flex items-center gap-1 border border-slate-300">⏳ S/ PREVISÃO</span>}
                                        </div>
                                    </div>
                                )) : <span className="text-sm font-bold text-emerald-400 mt-auto text-center border border-emerald-100/50 py-1.5 rounded-lg">Item não encontrado</span>}
                            </div>

                            <div className="bg-teal-50/50 rounded-xl p-4 border border-teal-100 flex flex-col shadow-sm">
                                <span className="text-sm font-black text-teal-600 uppercase mb-2">3. PD (ODC)</span>
                                {item.odc && item.odc.length > 0 ? item.odc.map((o, i) => (
                                    <div key={i} className="mb-2 text-sm border-b border-teal-200/40 pb-2 last:border-0">
                                        <span className="font-black text-lg text-teal-900">{o.qtd_pendente} un</span> | <span className="text-sm font-mono font-bold text-teal-800 break-all">{o.pd_referencia || o.numero_pd || o.documento_referencia}</span>
                                        {(o.status_pd || o.status) && <p className="text-[11px] font-black text-teal-700 uppercase mt-1">Status: {o.status_pd || o.status}</p>}
                                        {o.numero_oc && <p className="text-[11px] font-bold text-teal-700 break-all">OC: {o.numero_oc}</p>}
                                    </div>
                                )) : <span className="text-sm font-bold text-teal-400 mt-auto text-center border border-teal-100/50 py-1.5 rounded-lg">Item não encontrado</span>}
                            </div>

                            <div className="bg-rose-50/50 rounded-xl p-4 border border-rose-100 flex flex-col shadow-sm">
                                <span className="text-sm font-black text-rose-600 uppercase mb-2">4. DE (LISDE)</span>
                                {item.lisde && item.lisde.length > 0 ? item.lisde.map((l, i) => (
                                    <div key={i} className="text-sm font-bold text-rose-900 leading-tight">
                                        Item contemplado com <span className="font-black text-base block my-1">{l.qtd_autorizada} unidades</span>
                                    </div>
                                )) : <span className="text-sm font-bold text-rose-400 mt-auto text-center border border-rose-100/50 py-1.5 rounded-lg">Item não contemplado</span>}
                            </div>

                            <div className="bg-slate-50/80 rounded-xl p-4 border border-slate-200 flex flex-col shadow-sm">
                                <span className="text-sm font-black text-slate-500 uppercase mb-3">5. Price List</span>
                                {item.price_list && item.price_list.length > 0 ? item.price_list.map((p, i) => (
                                    <div key={i} className="flex flex-col border-b border-slate-200/50 pb-3 last:border-0 last:pb-0">
                                        <span className="text-xl font-black text-emerald-700 break-words">
                                            £ {(Number(p.valor_unitario) || 0).toLocaleString('en-GB', {minimumFractionDigits: 2})} <span className="text-xs text-slate-500 font-bold uppercase tracking-wider ml-1">GBP</span>
                                        </span>
                                        <div className="mt-2 flex flex-col gap-1.5">
                                            {p.lead_time > 0 ? (
                                                <span className="text-sm font-bold text-slate-700 bg-slate-200/50 px-2 py-0.5 rounded border border-slate-300 w-fit">
                                                    Lead Time: {p.lead_time} dias
                                                </span>
                                            ) : (
                                                <span className="text-sm font-bold text-slate-500 italic">Lead Time: Sob consulta</span>
                                            )}

                                            {p.moq > 1 && <span className="text-sm font-black text-amber-600">MOQ: {p.moq} un</span>}
                                            <span className="text-sm font-bold text-slate-500 italic leading-tight">Validade: {p.validade}</span>
                                        </div>
                                    </div>
                                )) : <span className="text-sm font-bold text-slate-400 mt-auto text-center border border-slate-200/50 py-1.5 rounded-lg">Item não encontrado</span>}
                            </div>

                            <div className="bg-blue-50/50 rounded-xl p-4 border border-blue-100 flex flex-col shadow-sm">
                                <span className="text-sm font-black text-blue-600 uppercase mb-2">6. Envio FOC</span>
                                {item.foc && item.foc.length > 0 ? item.foc.map((f, i) => (
                                    <div key={i} className="text-sm font-bold text-blue-900 break-all"><span className="font-black text-lg">{f.qtd_pendente} un</span> | {f.documento_referencia}</div>
                                )) : <span className="text-sm font-bold text-blue-400 mt-auto text-center border border-blue-100/50 py-1.5 rounded-lg">Item não encontrado</span>}
                            </div>

                            <div className="bg-amber-50/50 rounded-xl p-4 border border-amber-100 flex flex-col shadow-sm">
                                <span className="text-sm font-black text-amber-600 uppercase mb-2">7. Reino Unido</span>
                                {item.repairs && item.repairs.length > 0 ? (
                                    <div className="space-y-2 overflow-y-auto max-h-32 custom-scrollbar">
                                        {item.repairs.map((r, i) => (
                                            <div key={i} className="text-sm text-amber-900 border-b border-amber-200/40 pb-1.5 break-all">
                                                <div>SN: <span className="font-mono font-black">{r.sn || 'PENDENTE'}</span> <span className="text-sm bg-amber-200 px-1 rounded font-bold uppercase">{r.tipo}</span></div>
                                                {(r.documento_referencia || r.numero_wo) && <p className="text-[11px] font-black text-amber-800 uppercase">Doc/WO: {r.documento_referencia || r.numero_wo}</p>}
                                                {r.nomenclatura && <p className="text-[11px] font-bold text-amber-800">Nome: {r.nomenclatura}</p>}
                                                {r.status && <p className="text-[11px] font-bold text-amber-700">Status: {r.status}</p>}
                                                {r.tipo_wo && <p className="text-[11px] font-bold text-amber-700">Tipo WO: {r.tipo_wo}</p>}
                                                {r.resultado_tecnico && <p className="text-[11px] font-bold text-amber-700">Resultado: {r.resultado_tecnico}</p>}
                                                {r.observacao && <p className="text-[11px] font-bold text-amber-700">Obs: {r.observacao}</p>}
                                            </div>
                                        ))}
                                    </div>
                                ) : <span className="text-sm font-bold text-amber-400 mt-auto text-center border border-amber-100/50 py-1.5 rounded-lg">Item não encontrado</span>}
                            </div>
                        </div>

                        {((item.dicionario && item.dicionario.length > 0) || (item.alternativos && item.alternativos.length > 0) || (item.sb_referencias && item.sb_referencias.length > 0)) && (
                            <div className="bg-slate-50/80 rounded-xl p-4 sm:p-5 border border-slate-200 mt-5 shadow-inner space-y-5">
                                <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-3 flex-wrap border-b border-slate-200 pb-3">
                                    <span className="text-xs font-black text-slate-700 uppercase tracking-widest flex items-center gap-2">
                                        Referências Técnicas
                                    </span>

                                    <button
                                        onClick={() => {
                                            setAlvoAplicacoes(item.dicionario || []);
                                            setFontesMapa(item.fontes_alternativos || []);
                                            setModalAplicacoes(true);
                                        }}
                                        className="w-full sm:w-auto bg-blue-600 text-white text-[10px] font-black px-4 py-2 rounded-lg hover:bg-blue-700 transition-all"
                                    >
                                        VER MAPA ({item.dicionario?.length || 0})
                                    </button>
                                </div>

                                {((item.dicionario && item.dicionario.length > 0) || (item.alternativos && item.alternativos.length > 0)) ? (
                                    <div className="space-y-3">
                                        <p className="text-[11px] font-black text-slate-500 uppercase tracking-widest">Manual & equivalências</p>
                                        {item.alternativos && item.alternativos.length > 0 ? (
                                            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
                                                {item.alternativos.map((alt, idx) => (
                                                    <div key={idx} className="bg-white border border-slate-200 p-3 rounded-xl shadow-sm hover:border-amber-300 transition-all">
                                                        <div className="flex justify-between items-center mb-1 gap-2">
                                                            <span className="font-mono text-sm font-black text-slate-800 break-all">{alt.pn}</span>
                                                            <span className={`text-[10px] font-black px-2 py-0.5 rounded border whitespace-nowrap ${alt.ppu_qtd > 0 ? 'bg-emerald-100 text-emerald-800' : 'bg-slate-50 text-slate-500'}`}>
                                                                PPU: {alt.ppu_qtd}
                                                            </span>
                                                        </div>
                                                        <span className="block text-[10px] font-bold text-slate-500">NSN: {alt.nsn || 'N/A'}</span>
                                                        <span className="block text-[10px] font-bold text-slate-500 mt-2">
                                                            Fonte: {(alt.fonte && alt.fonte.length > 0) ? alt.fonte.join(' | ') : 'MANUAL TÉCNICO'}
                                                        </span>
                                                    </div>
                                                ))}
                                            </div>
                                        ) : <p className="text-xs font-bold text-slate-400 italic">Nenhum alternativo listado.</p>}
                                    </div>
                                ) : null}

                                {item.sb_referencias && item.sb_referencias.length > 0 ? (
                                    <div className="space-y-3">
                                        <p className="text-[11px] font-black text-slate-500 uppercase tracking-widest">Service Bulletin / referência técnica</p>
                                        <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
                                            {item.sb_referencias.map((sb, idx) => (
                                                <div key={`${sb.sb_numero}-${idx}`} className="bg-white border border-amber-200 p-4 rounded-xl shadow-sm">
                                                    <div className="flex items-start justify-between gap-3">
                                                        <div className="min-w-0">
                                                            <p className="text-sm font-black text-slate-800 uppercase break-all">{sb.sb_numero}</p>
                                                            <p className="text-xs font-bold text-slate-500 mt-1">{sb.titulo || 'SB sem título registrado'}</p>
                                                        </div>
                                                        <span className="text-[10px] font-black px-2 py-1 rounded-lg border bg-amber-50 text-amber-700 border-amber-200 uppercase whitespace-nowrap">
                                                            {sb.tipo_sb || 'N/A'}
                                                        </span>
                                                    </div>
                                                    <div className="mt-3 flex flex-wrap gap-2">
                                                        <span className="text-[10px] font-black px-2 py-1 rounded-lg border bg-slate-50 text-slate-600 border-slate-200 uppercase">Status: {sb.status_acao || 'SEM_ACAO'}</span>
                                                        {sb.capitulo ? <span className="text-[10px] font-black px-2 py-1 rounded-lg border bg-slate-50 text-slate-600 border-slate-200 uppercase">Cap: {sb.capitulo}</span> : null}
                                                        {sb.item_num ? <span className="text-[10px] font-black px-2 py-1 rounded-lg border bg-slate-50 text-slate-600 border-slate-200 uppercase">Item: {sb.item_num}</span> : null}
                                                    </div>
                                                    {sb.observacao ? <p className="text-xs text-slate-500 font-bold mt-3">{sb.observacao}</p> : null}
                                                    {sb.pns_relacionados && sb.pns_relacionados.length > 0 ? (
                                                        <div className="mt-3">
                                                            <p className="text-[10px] font-black text-slate-500 uppercase mb-2">PNs relacionados na mesma SB</p>
                                                            <div className="flex flex-wrap gap-2">
                                                                {sb.pns_relacionados.map((pnRelacionado) => (
                                                                    <span key={pnRelacionado} className="text-[10px] font-black px-2.5 py-1 rounded-lg border bg-blue-50 text-blue-700 border-blue-200 uppercase">
                                                                        {pnRelacionado}
                                                                    </span>
                                                                ))}
                                                            </div>
                                                        </div>
                                                    ) : null}
                                                </div>
                                            ))}
                                        </div>
                                    </div>
                                ) : null}
                            </div>
                        )}
                    </div>
                ))}
            </div>

            {modalAplicacoes && (
                <div className="fixed inset-0 z-[100] flex items-center justify-center p-3 sm:p-4 bg-slate-900/80 backdrop-blur-sm animate-fade-in">
                    <div className="bg-white rounded-2xl shadow-xl w-full max-w-4xl max-h-[85vh] flex flex-col overflow-hidden border-2 border-blue-600">
                        <div className="bg-slate-800 p-4 sm:p-5 flex justify-between items-center border-b-4 border-blue-600 gap-4">
                            <h3 className="text-sm sm:text-lg font-black text-white uppercase tracking-wider flex items-center gap-3">
                                Mapa de Instalação (DMC)
                            </h3>
                            <button onClick={() => setModalAplicacoes(false)} className="text-slate-400 hover:text-red-400 transition-colors shrink-0">
                                <svg className="w-7 h-7 sm:w-8 sm:h-8" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.5" d="M6 18L18 6M6 6l12 12"></path>
                                </svg>
                            </button>
                        </div>

                        <div className="p-4 sm:p-6 overflow-y-auto flex-1 bg-slate-50 space-y-4">
                            {alvoAplicacoes.length > 0 ? alvoAplicacoes.map((app, i) => (
                                <div key={i} className="bg-white p-4 sm:p-5 rounded-xl border border-slate-200 shadow-sm flex flex-col md:flex-row md:items-center justify-between gap-4 hover:border-blue-300 transition-all">
                                    <div className="flex-1 min-w-0">
                                        <p className="text-sm sm:text-base font-black text-slate-800 uppercase break-words">📍 {app.techname || 'APLICAÇÃO GERAL'}</p>
                                        <p className="text-xs sm:text-sm font-bold text-slate-500 mt-1 uppercase">{app.nomenclatura}</p>
                                    </div>

                                    <div className="grid grid-cols-3 gap-2 w-full md:w-auto md:flex md:gap-2">
                                        <span className="bg-blue-50 text-blue-800 px-3 py-2 rounded-lg text-[10px] font-black border border-blue-200 flex flex-col items-center">
                                            DMC<span className="font-mono text-sm sm:text-base mt-0.5">{app.dmc}</span>
                                        </span>
                                        <span className="bg-slate-100 text-slate-700 px-3 py-2 rounded-lg text-[10px] font-black border border-slate-200 flex flex-col items-center">
                                            ITEM<span className="font-mono text-sm sm:text-base mt-0.5">{app.item_num}</span>
                                        </span>
                                        <span className="bg-slate-100 text-slate-700 px-3 py-2 rounded-lg text-[10px] font-black border border-slate-200 flex flex-col items-center">
                                            SUB<span className="font-mono text-sm sm:text-base mt-0.5">{app.sub_item}</span>
                                        </span>
                                    </div>
                                </div>
                            )) : (
                                <div className="bg-white p-4 sm:p-5 rounded-xl border border-slate-200 shadow-sm space-y-3">
                                    <p className="text-sm sm:text-base font-black text-slate-800 uppercase">Sem mapa técnico no manual</p>
                                    <p className="text-sm font-bold text-slate-500">Este item foi encontrado apenas na biblioteca complementar de PN alternativos.</p>
                                    <div className="flex flex-wrap gap-2 pt-2">
                                        {(fontesMapa || []).length > 0 ? fontesMapa.map((fonte, i) => (
                                            <span key={i} className="bg-amber-50 text-amber-800 px-3 py-2 rounded-lg text-[10px] font-black border border-amber-200 uppercase">{fonte}</span>
                                        )) : (
                                            <span className="bg-slate-100 text-slate-700 px-3 py-2 rounded-lg text-[10px] font-black border border-slate-200 uppercase">Fonte não informada</span>
                                        )}
                                    </div>
                                </div>
                            )}
                        </div>

                        <div className="bg-slate-100 p-4 sm:p-5 border-t border-slate-200 flex justify-end">
                            <button onClick={() => setModalAplicacoes(false)} className="w-full sm:w-auto bg-slate-800 text-white px-8 py-3 rounded-xl text-sm font-black hover:bg-slate-900 transition-all shadow-sm">
                                FECHAR MAPA
                            </button>
                        </div>
                    </div>
                </div>
            )}

            <style jsx>{`.custom-scrollbar::-webkit-scrollbar { width: 5px; } .custom-scrollbar::-webkit-scrollbar-thumb { background: #cbd5e1; border-radius: 5px; }`}</style>

            {modalLote && (
                <div className="fixed inset-0 z-[120] flex items-center justify-center p-3 sm:p-4 bg-slate-900/80 backdrop-blur-sm animate-fade-in">
                    <div className="w-full max-w-4xl bg-white rounded-3xl border border-slate-200 shadow-2xl overflow-hidden">
                        <div className="px-4 sm:px-6 py-4 border-b border-slate-200 bg-slate-50 flex items-start sm:items-center justify-between gap-4">
                            <div>
                                <h3 className="text-lg sm:text-xl font-black text-slate-900 uppercase">Pesquisa em lote</h3>
                                <p className="text-xs sm:text-sm font-bold text-slate-500">
                                    A planilha é usada só nesta consulta. Fechou o modal, limpou tudo.
                                </p>
                            </div>
                            <button type="button" onClick={fecharModalLote} className="p-2 rounded-xl text-slate-500 hover:text-red-500 hover:bg-red-50 transition-all shrink-0">
                                <X size={20} />
                            </button>
                        </div>

                        <div className="p-4 sm:p-6 space-y-5 max-h-[80vh] overflow-auto">
                            <div className="grid grid-cols-1 lg:grid-cols-[1fr_auto_auto] gap-3 items-end">
                                <label className="space-y-2">
                                    <span className="text-xs uppercase tracking-[0.2em] text-slate-400 font-black">Planilha</span>
                                    <input
                                        type="file"
                                        accept=".xlsx,.xls,.csv,.ods"
                                        onChange={(e) => { setArquivoLote(e.target.files?.[0] || null); setLotePreview(null); setLoteErro(''); }}
                                        className="w-full p-3 bg-white border-2 border-slate-200 rounded-xl font-bold text-slate-900 file:text-slate-900"
                                    />
                                </label>

                                <button
                                    type="button"
                                    onClick={executarPesquisaLote}
                                    disabled={loteCarregando || !arquivoLote}
                                    className="px-5 py-3 rounded-xl bg-blue-600 text-white font-black hover:bg-blue-700 disabled:opacity-50 inline-flex items-center justify-center gap-2"
                                >
                                    {loteCarregando ? <LoaderCircle size={16} className="animate-spin" /> : <Upload size={16} />} EXECUTAR
                                </button>

                                <button
                                    type="button"
                                    onClick={exportarPesquisaLote}
                                    disabled={loteExportando || !arquivoLote || !lotePreview}
                                    className="px-5 py-3 rounded-xl bg-emerald-600 text-white font-black hover:bg-emerald-700 disabled:opacity-50 inline-flex items-center justify-center gap-2"
                                >
                                    {loteExportando ? <LoaderCircle size={16} className="animate-spin" /> : <Download size={16} />} EXPORTAR EXCEL
                                </button>
                            </div>

                            {arquivoLote ? <p className="text-sm font-bold text-slate-500 break-all">Arquivo atual: {arquivoLote.name}</p> : null}
                            {loteErro ? <div className="rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-red-700 font-bold">{loteErro}</div> : null}

                            {lotePreview ? (
                                <>
                                    <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-5 gap-4">
                                        <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
                                            <p className="text-[11px] uppercase tracking-[0.2em] text-slate-400 font-black">Linhas base</p>
                                            <p className="text-2xl font-black text-slate-900 mt-2">{lotePreview.summary.linhas_base}</p>
                                        </div>
                                        <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
                                            <p className="text-[11px] uppercase tracking-[0.2em] text-slate-400 font-black">PPU + CeIMSPA</p>
                                            <p className="text-2xl font-black text-slate-900 mt-2">{(lotePreview.summary.coberto_ppu || 0) + (lotePreview.summary.coberto_ceimspa || 0)}</p>
                                        </div>
                                        <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
                                            <p className="text-[11px] uppercase tracking-[0.2em] text-slate-400 font-black">ODA + ODC</p>
                                            <p className="text-2xl font-black text-slate-900 mt-2">{(lotePreview.summary.coberto_oda || 0) + (lotePreview.summary.coberto_odc || 0)}</p>
                                        </div>
                                        <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
                                            <p className="text-[11px] uppercase tracking-[0.2em] text-slate-400 font-black">Comprar</p>
                                            <p className="text-2xl font-black text-slate-900 mt-2">{lotePreview.summary.comprar_qtd || 0}</p>
                                        </div>
                                        <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
                                            <p className="text-[11px] uppercase tracking-[0.2em] text-slate-400 font-black">Valor Comprar</p>
                                            <p className="text-2xl font-black text-slate-900 mt-2">£ {(Number(lotePreview.summary.comprar_valor_gbp) || 0).toLocaleString('en-GB', { minimumFractionDigits: 2 })}</p>
                                        </div>
                                    </div>

                                    <div className="rounded-2xl border border-slate-200 overflow-hidden">
                                        <div className="px-4 py-3 border-b border-slate-200 bg-slate-50 font-black text-slate-900 uppercase text-sm">Contrato da planilha</div>
                                        <div className="p-4 grid grid-cols-1 md:grid-cols-2 gap-4 text-sm">
                                            <div>
                                                <p className="font-black text-slate-900">Obrigatória</p>
                                                <p className="font-bold text-slate-600 mt-1">{(lotePreview.columns?.obrigatorias || []).join(', ') || 'pn'}</p>
                                            </div>
                                            <div>
                                                <p className="font-black text-slate-900">Opcional</p>
                                                <p className="font-bold text-slate-600 mt-1">{(lotePreview.columns?.opcionais || []).join(', ') || 'quantidade'}</p>
                                            </div>
                                            <div>
                                                <p className="font-black text-slate-900">Mais colunas</p>
                                                <p className="font-bold text-slate-600 mt-1">{lotePreview.columns?.aceita_mais_colunas ? 'Permitidas' : 'Não permitidas'}</p>
                                            </div>
                                            <div>
                                                <p className="font-black text-slate-900">Ordem</p>
                                                <p className="font-bold text-slate-600 mt-1">{lotePreview.columns?.ordem_importa ? 'Importa' : 'Não importa'}</p>
                                            </div>
                                        </div>
                                    </div>

                                    <div className="rounded-2xl border border-slate-200 overflow-hidden">
                                        <div className="px-4 py-3 border-b border-slate-200 bg-slate-50 font-black text-slate-900 uppercase text-sm">Resumo da cobertura</div>
                                        <div className="overflow-auto">
                                            <table className="min-w-full text-sm">
                                                <thead className="bg-slate-100 text-slate-700 uppercase text-[11px] tracking-wider">
                                                    <tr>
                                                        <th className="p-3 text-left">Etapa</th>
                                                        <th className="p-3 text-left">Linhas</th>
                                                    </tr>
                                                </thead>
                                                <tbody>
                                                    {[
                                                        ['00 • Entrada', lotePreview.input?.length || 0],
                                                        ['01 • PPU', lotePreview.sections.ppu?.length || 0],
                                                        ['02 • CEIMSPA', lotePreview.sections.ceimspa?.length || 0],
                                                        ['03 • ODA', lotePreview.sections.oda?.length || 0],
                                                        ['04 • PRICE LIST', lotePreview.sections.pricelist?.length || 0],
                                                        ['05 • ODC', lotePreview.sections.odc?.length || 0],
                                                        ['06 • COMPRAR', lotePreview.sections.comprar?.length || 0],
                                                    ].map(([etapa, total]) => (
                                                        <tr key={etapa} className="border-t border-slate-100">
                                                            <td className="p-3 font-black text-slate-900">{etapa}</td>
                                                            <td className="p-3 font-bold text-slate-700">{total}</td>
                                                        </tr>
                                                    ))}
                                                </tbody>
                                            </table>
                                        </div>
                                    </div>

                                    {[
                                      ['Entrada da planilha', lotePreview.input || [], 'input'],
                                      ['01 • PPU', lotePreview.sections.ppu || [], 'coverage'],
                                      ['02 • CEIMSPA', lotePreview.sections.ceimspa || [], 'coverage'],
                                      ['03 • ODA', lotePreview.sections.oda || [], 'coverage'],
                                      ['04 • PRICE LIST', lotePreview.sections.pricelist || [], 'value'],
                                      ['05 • ODC', lotePreview.sections.odc || [], 'coverage'],
                                      ['06 • COMPRAR', lotePreview.sections.comprar || [], 'value'],
                                    ].map(([title, rows, type]) => (
                                      <div key={title} className="rounded-2xl border border-slate-200 overflow-hidden">
                                        <div className="px-4 py-3 border-b border-slate-200 bg-slate-50 font-black text-slate-900 uppercase text-sm">{title} • {rows.length} linha(s)</div>
                                        <div className="overflow-auto max-h-[22rem]">
                                          {type === 'input' ? (
                                            <table className="min-w-full text-sm">
                                              <thead className="bg-slate-100 text-slate-700 uppercase text-[11px] tracking-wider sticky top-0">
                                                <tr>
                                                  <th className="p-3 text-left">PN</th>
                                                  <th className="p-3 text-left">NSN</th>
                                                  <th className="p-3 text-left">Nomenclatura</th>
                                                  <th className="p-3 text-left">Quantidade</th>
                                                </tr>
                                              </thead>
                                              <tbody>
                                                {rows.length === 0 ? (
                                                  <tr><td colSpan={4} className="p-6 text-center font-bold text-slate-500">Nenhuma linha nesta etapa.</td></tr>
                                                ) : rows.map((row, idx) => (
                                                  <tr key={`${title}-${row.pn}-${idx}`} className="border-t border-slate-100 align-top">
                                                    <td className="p-3 font-black text-slate-900">{row.pn}</td>
                                                    <td className="p-3 text-slate-600 font-semibold">{row.nsn || '—'}</td>
                                                    <td className="p-3 text-slate-800 font-bold">{row.nomenclatura || '—'}</td>
                                                    <td className="p-3 font-black text-slate-900">{row.quantidade_total}</td>
                                                  </tr>
                                                ))}
                                              </tbody>
                                            </table>
                                          ) : (
                                            <table className="min-w-full text-sm">
                                              <thead className="bg-slate-100 text-slate-700 uppercase text-[11px] tracking-wider sticky top-0">
                                                <tr>
                                                  <th className="p-3 text-left">PN</th>
                                                  <th className="p-3 text-left">Nomenclatura</th>
                                                  <th className="p-3 text-left">Necessidade</th>
                                                  {type === 'coverage' ? <th className="p-3 text-left">Cobertura</th> : null}
                                                  <th className="p-3 text-left">Saldo</th>
                                                  <th className="p-3 text-left">Referência</th>
                                                  {type === 'value' ? <th className="p-3 text-left">GBP</th> : null}
                                                </tr>
                                              </thead>
                                              <tbody>
                                                {rows.length === 0 ? (
                                                  <tr><td colSpan={type === 'coverage' ? 6 : 7} className="p-6 text-center font-bold text-slate-500">Nenhuma linha nesta etapa.</td></tr>
                                                ) : rows.map((row, idx) => (
                                                  <tr key={`${title}-${row.pn}-${idx}`} className="border-t border-slate-100 align-top">
                                                    <td className="p-3 font-black text-slate-900">{row.pn}</td>
                                                    <td className="p-3">
                                                      <div className="font-bold text-slate-900">{row.nomenclatura || '—'}</div>
                                                      <div className="text-xs text-slate-500 font-semibold">NSN: {row.nsn || '—'}</div>
                                                    </td>
                                                    <td className="p-3 font-black text-slate-900">{row.necessidade_total}</td>
                                                    {type === 'coverage' ? <td className="p-3 font-black text-emerald-700">{row.cobertura_etapa}</td> : null}
                                                    <td className="p-3 font-black text-amber-700">{row.saldo_apos_etapa}</td>
                                                    <td className="p-3 text-xs font-semibold text-slate-600 whitespace-pre-wrap">{row.documento_referencia || row.observacao || '—'}</td>
                                                    {type === 'value' ? <td className="p-3 font-black text-slate-900"><div>{row.valor_unitario_gbp != null ? `£ ${Number(row.valor_unitario_gbp).toLocaleString('en-GB', { minimumFractionDigits: 2 })}` : '—'}</div><div className="text-xs text-slate-500">{row.valor_total_gbp != null ? `£ ${Number(row.valor_total_gbp).toLocaleString('en-GB', { minimumFractionDigits: 2 })}` : '—'}</div></td> : null}
                                                  </tr>
                                                ))}
                                              </tbody>
                                            </table>
                                          )}
                                        </div>
                                      </div>
                                    ))}
                                </>
                            ) : null}
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}