import React, { useMemo, useState } from 'react';
import { Truck, Package, Check, Upload, Download, LoaderCircle, X, FileQuestion } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { apiFetch } from '../lib/api';
import CotacaoRequestModal from '../components/CotacaoRequestModal';

const SOURCE_LABELS = {
    ITEMS: 'Cadastro base',
    DICIONARIO_MESTRE: 'Manual',
    ESTOQUE_PPU: 'Inventário PPU',
    INVENTARIO_PPU_RASTREIO: 'Inventário PPU — rastreio físico',
    SN_ESTOQUE_PPU: 'SN do inventário PPU',
    PPU_CUSTODIA_EXTERNA: 'PPU — custódia externa em caixa no CEIMSPA',
    LISDE: 'LISDE',
    PRICE_LIST: 'Price List',
    RFQ_COTACOES: 'RFQ',
    PN_ALTERNATIVOS_DOCUMENTO: 'Doc. alternativos',
    CEIMSPA_VIA_DICIONARIO: 'CeIMSPA via manual',
    CEIMSPA_SEM_PN_CONFIRMADO: 'CeIMSPA sem PN confirmado',
    ESTOQUE_CEIMSPA: 'Estoque CeIMSPA',
    RECIBO_CEIMSPA: 'Recibo destinado ao CeIMSPA',
    SERVICE_BULLETIN: 'Service Bulletin',
    MANUAL_TECNICO_WTP: 'WTP / Manual técnico',
};

const formatSource = (value) => SOURCE_LABELS[value] || value || 'N/A';
const formatQuantity = (value) => Number(value || 0).toLocaleString('pt-BR', { maximumFractionDigits: 2 });

const simplifyReceiptLocation = (location, receiptNumber) => {
    let text = String(location || '').trim();
    const receipt = String(receiptNumber || '').trim();
    if (!text) return 'Local não informado';

    if (receipt) {
        const escaped = receipt.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        text = text.replace(new RegExp(`\\bRECIBO\\s*${escaped}\\b`, 'gi'), ' ');
    }

    text = text
        .replace(/\bRECIBO\b/gi, ' ')
        .replace(/\s*[—–-]+\s*/g, ' — ')
        .replace(/(?:\s*—\s*){2,}/g, ' — ')
        .replace(/^\s*—\s*|\s*—\s*$/g, '')
        .replace(/\s{2,}/g, ' ')
        .trim();

    return text || 'Local não informado';
};

const LOCATION_DESTINATION_LABELS = {
    PPU: 'PPU',
    CEIMSPA: 'CEIMSPA',
    FORA_LINHA: 'Fora da linha de voo',
};

const OPERATIONAL_SITUATION_LABELS = {
    DISPONIVEL: 'Disponível',
    A_CONFIRMAR: 'A confirmar',
    AGUARDANDO_REPARO: 'Aguardando reparo',
    EM_REPARO: 'Em reparo',
    EM_WO: 'Em WO',
    CONDENADO_LIXO: 'Condenado / lixo',
    ARMAZENADO_EXTERNAMENTE: 'Armazenado externamente',
    QUARENTENA: 'Quarentena',
    OUTRO: 'Outro',
};

export default function ConsultaItens() {
    const { token } = useAuth();
    const [termo, setTermo] = useState('');
    const [resultados, setResultados] = useState([]);
    const [carregando, setCarregando] = useState(false);
    const [buscaRealizada, setBuscaRealizada] = useState(false);

    const [modalAplicacoes, setModalAplicacoes] = useState(false);
    const [modalIndisponiveis, setModalIndisponiveis] = useState(false);
    const [alvoIndisponiveis, setAlvoIndisponiveis] = useState(null);
    const [alvoAplicacoes, setAlvoAplicacoes] = useState([]);
    const [alvoManuaisTecnicos, setAlvoManuaisTecnicos] = useState([]);
    const [alvoWtpReferencias, setAlvoWtpReferencias] = useState([]);
    const [fontesMapa, setFontesMapa] = useState([]);
    const [modalLote, setModalLote] = useState(false);
    const [arquivoLote, setArquivoLote] = useState(null);
    const [loteCarregando, setLoteCarregando] = useState(false);
    const [loteExportando, setLoteExportando] = useState(false);
    const [loteErro, setLoteErro] = useState('');
    const [lotePreview, setLotePreview] = useState(null);
    const [quoteOpen, setQuoteOpen] = useState(false);


    const loteMissingQuoteItems = useMemo(() => (lotePreview?.sections?.comprar || [])
        .filter((row) => !(Number(row.valor_unitario_gbp) > 0))
        .map((row) => ({
            pn: row.pn,
            nsn: row.nsn,
            nomenclatura: row.nomenclatura,
            qtd: Number(row.faltam_apos_etapa ?? row.saldo_apos_etapa ?? row.necessidade_total ?? 0),
        }))
        .filter((row) => row.pn && row.qtd > 0), [lotePreview]);

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
        } catch {
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
                        placeholder="Pesquise por PN, PI/NSN, SN ou Nome..."
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
                <p className="mt-2 px-2 text-[10px] sm:text-[11px] font-bold text-slate-400 uppercase tracking-wide">
                    PN, PI/NSN e SN: busca pelo início do código • Nome: busca por trecho do texto
                </p>
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

                                {item.aviso_operacional ? (
                                    <div className="mt-3 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-xs sm:text-sm font-bold text-amber-800">
                                        {item.aviso_operacional}
                                    </div>
                                ) : null}
                            </div>

                            <div className="w-full md:w-auto md:min-w-[11rem] mt-0 md:mt-0 flex flex-col items-stretch md:items-end">
                                <span className={`py-2.5 px-5 sm:px-6 rounded-xl text-lg sm:text-xl font-black shadow-sm text-center ${item.ppu_qtd > 0 ? 'bg-blue-600 text-white' : 'bg-slate-800 text-white'}`}>
                                    PPU: {item.ppu_qtd || 0} un
                                </span>
                                {(item.ppu_qtd > 0 || (item.recibos_incorporados || []).some((row) => row.destino_estoque === 'PPU')) && (
                                    <div className="mt-2 w-full md:w-[23rem] space-y-1.5">
                                        {(item.ppu_detalhes || []).map((saldo, saldoIndex) => (
                                            <div key={`${saldo.origem_saldo}-${saldo.recebimento_item_id || saldoIndex}`} className={`text-[10px] sm:text-[11px] font-black px-2.5 py-2 rounded-lg border ${saldo.origem_saldo === 'RECIBO_PENDENTE' ? 'bg-amber-50 border-amber-200 text-amber-800' : 'bg-slate-50 border-slate-200 text-slate-600'}`}>
                                                <span>{formatQuantity(saldo.quantidade)} un • {saldo.origem_saldo === 'RECIBO_PENDENTE' ? simplifyReceiptLocation(saldo.localizacao, saldo.numero_recibo) : saldo.localizacao}</span>
                                                {saldo.origem_saldo === 'RECIBO_PENDENTE'
                                                    ? <span className="block mt-0.5">Recibo {saldo.numero_recibo || 'sem número'} — aguardando incorporação ao inventário oficial</span>
                                                    : saldo.origem_saldo === 'PPU_CUSTODIA_EXTERNA'
                                                        ? <span className="block mt-0.5">Custódia PPU • localização física em caixa no CEIMSPA</span>
                                                        : <span className="block mt-0.5">Inventário oficial do PPU</span>}
                                                {saldo.sn ? <span className="block mt-0.5">SN: {saldo.sn}</span> : null}
                                            </div>
                                        ))}
                                        {(item.recibos_incorporados || []).filter((row) => row.destino_estoque === 'PPU').map((row) => (
                                            <div key={`ppu-incorporado-${row.recebimento_item_id}`} className="text-[10px] sm:text-[11px] font-black px-2.5 py-2 rounded-lg border bg-emerald-50 border-emerald-200 text-emerald-800">
                                                {row.incorporado_totalmente
                                                    ? <>Item do Recibo {row.numero_recibo || 'sem número'} já incluído no estoque do PPU</>
                                                    : <>Item do Recibo {row.numero_recibo || 'sem número'} parcialmente incluído no estoque do PPU</>}
                                                {!row.incorporado_totalmente ? <span className="block mt-0.5">Incorporado: {formatQuantity(row.quantidade_incorporada)} de {formatQuantity(row.quantidade_recebida)} un • saldo: {formatQuantity(row.saldo_pendente)} un</span> : null}
                                            </div>
                                        ))}
                                    </div>
                                )}
                                {Number(item.itens_fora_linha_qtd || 0) > 0 ? (
                                    <button
                                        type="button"
                                        onClick={() => { setAlvoIndisponiveis(item); setModalIndisponiveis(true); }}
                                        className="mt-2 w-full md:w-[23rem] rounded-xl border border-amber-300 bg-amber-50 px-3 py-2 text-xs font-black text-amber-900 hover:bg-amber-100 transition-colors"
                                    >
                                        ITENS FORA DA LINHA DE VOO — {formatQuantity(item.itens_fora_linha_qtd)} UN
                                    </button>
                                ) : null}
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
                                                <p key={c.id || i} className="text-sm font-bold text-purple-800 bg-purple-100/50 px-2 py-1 rounded-lg border border-purple-200/50">
                                                    {c.origem_saldo === 'RECIBO_PENDENTE_CEIMSPA'
                                                        ? <>Recibo {c.numero_recibo || 'sem número'} • {c.uf || 'local não informado'}: <span className="font-black text-purple-900">{formatQuantity(c.quantidade)}</span></>
                                                        : c.origem_saldo === 'PPU_LOCAL_RECLASSIFICADO_CEIMSPA'
                                                            ? <>LOC {c.localizacao_fisica || c.uf || 'não informada'}{c.sn ? <> • SN {c.sn}</> : null}: <span className="font-black text-purple-900">{formatQuantity(c.quantidade)}</span></>
                                                            : <>PI: {c.pi || 'N/I'} | {c.sj || 'N/I'}: <span className="font-black text-purple-900">{formatQuantity(c.quantidade)}</span></>}
                                                </p>
                                            ))}
                                            {(item.recibos_incorporados || []).filter((row) => row.destino_estoque === 'CEIMSPA').map((row) => (
                                                <p key={`ceimspa-incorporado-${row.recebimento_item_id}`} className="text-[11px] font-black text-emerald-800 bg-emerald-50 px-2 py-1.5 rounded-lg border border-emerald-200">
                                                    {row.incorporado_totalmente
                                                        ? <>Item do Recibo {row.numero_recibo || 'sem número'} já incluído no estoque do CEIMSPA</>
                                                        : <>Item do Recibo {row.numero_recibo || 'sem número'} parcialmente incluído no estoque do CEIMSPA • {formatQuantity(row.quantidade_incorporada)}/{formatQuantity(row.quantidade_recebida)} incorporado(s)</>}
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
                                <span className="text-sm font-black text-slate-500 uppercase mb-3">5. Banco de Preços</span>
                                {item.price_list && item.price_list.length > 0 ? item.price_list.map((p, i) => (
                                    <div key={i} className="flex flex-col border-b border-slate-200/50 pb-3 last:border-0 last:pb-0">
                                        <span className="text-xl font-black text-emerald-700 break-words">
                                            £ {(Number(p.valor_unitario) || 0).toLocaleString('en-GB', {minimumFractionDigits: 2})} <span className="text-xs text-slate-500 font-bold uppercase tracking-wider ml-1">GBP</span>
                                        </span>
                                        <div className="mt-2 flex flex-col gap-1.5">
                                            <div className="flex flex-wrap gap-1.5">
                                                <span className="text-[10px] font-black uppercase tracking-wide bg-white border border-slate-200 rounded px-2 py-0.5 text-slate-600">{p.origem || 'PRICE_LIST'}</span>
                                                {p.resolvido ? <span className="text-[10px] font-black uppercase tracking-wide bg-emerald-100 border border-emerald-200 rounded px-2 py-0.5 text-emerald-800">Referência usada</span> : null}
                                            </div>
                                            {p.documento_fonte ? <span className="text-xs font-bold text-slate-600">Fonte: {p.documento_fonte}</span> : null}{p.fornecedor ? <span className="text-xs font-bold text-slate-600">Fornecedor: {p.fornecedor}</span> : null}{p.origem === 'RFQ' && p.vigente === false ? <span className="text-[10px] font-black text-amber-700">PREÇO HISTÓRICO/VENCIDO — NÃO USADO COMO PREÇO ATUAL</span> : null}
                                            {p.data_referencia ? <span className="text-xs font-semibold text-slate-500">Data: {p.data_referencia}</span> : null}
                                            {p.pn_relacionado ? <span className="text-xs font-black text-blue-700">PN relacionado: {p.pn_relacionado}{p.tipo_relacao_pn ? ` • ${p.tipo_relacao_pn}` : ''}</span> : null}
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
                                                {Number(r.valor_orcamento) > 0 && <p className="text-[11px] font-black text-emerald-700">Orçamento/ref.: {(r.moeda_orcamento || 'GBP').toUpperCase() === 'GBP' ? '£ ' : `${r.moeda_orcamento || ''} `}{Number(r.valor_orcamento).toLocaleString('en-GB', { minimumFractionDigits: 2 })} {r.origem_orcamento ? `• ${r.origem_orcamento}` : ''}</p>}
                                                {r.fornecedor && <p className="text-[11px] font-bold text-amber-700">Fornecedor: {r.fornecedor}</p>}
                                                {r.validade && <p className="text-[11px] font-bold text-amber-700">Validade: {r.validade}</p>}
                                                {r.aeronave && <p className="text-[11px] font-bold text-amber-700">ANV: {r.aeronave}</p>}
                                                {r.notification && <p className="text-[11px] font-bold text-amber-700">Notification: {r.notification}</p>}
                                                {r.po_number && <p className="text-[11px] font-bold text-amber-700">PO: {r.po_number}</p>}
                                                {r.delivery_number && <p className="text-[11px] font-bold text-amber-700">Delivery: {r.delivery_number}</p>}
                                                {r.lh_updates && <p className="text-[11px] font-bold text-amber-700">LH Updates: {r.lh_updates}</p>}
                                                {r.tipo_wo && <p className="text-[11px] font-bold text-amber-700">Tipo WO: {r.tipo_wo}</p>}
                                                {r.resultado_tecnico && <p className="text-[11px] font-bold text-amber-700">Resultado: {r.resultado_tecnico}</p>}
                                                {r.bn_comments && <p className="text-[11px] font-bold text-amber-700">BN: {r.bn_comments}</p>}
                                                {r.observacao && <p className="text-[11px] font-bold text-amber-700">Obs: {r.observacao}</p>}
                                            </div>
                                        ))}
                                    </div>
                                ) : <span className="text-sm font-bold text-amber-400 mt-auto text-center border border-amber-100/50 py-1.5 rounded-lg">Item não encontrado</span>}
                            </div>
                        </div>

                        {((item.dicionario && item.dicionario.length > 0) || (item.manual_tecnico_aplicacoes && item.manual_tecnico_aplicacoes.length > 0) || (item.wtp_referencias && item.wtp_referencias.length > 0) || (item.alternativos && item.alternativos.length > 0) || (item.sb_referencias && item.sb_referencias.length > 0) || (item.rfq_evolucoes && item.rfq_evolucoes.length > 0)) && (
                            <div className="bg-slate-50/80 rounded-xl p-4 sm:p-5 border border-slate-200 mt-5 shadow-inner space-y-5">
                                <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-3 flex-wrap border-b border-slate-200 pb-3">
                                    <span className="text-xs font-black text-slate-700 uppercase tracking-widest flex items-center gap-2">
                                        Referências Técnicas
                                    </span>

                                    <button
                                        onClick={() => {
                                            setAlvoAplicacoes(item.dicionario || []);
                                            setAlvoManuaisTecnicos(item.manual_tecnico_aplicacoes || []);
                                            setAlvoWtpReferencias(item.wtp_referencias || []);
                                            setFontesMapa(item.fontes_alternativos || []);
                                            setModalAplicacoes(true);
                                        }}
                                        className="w-full sm:w-auto bg-blue-600 text-white text-[10px] font-black px-4 py-2 rounded-lg hover:bg-blue-700 transition-all"
                                    >
                                        VER MAPA ({(item.dicionario?.length || 0) + (item.manual_tecnico_aplicacoes?.length || 0) + (item.wtp_referencias?.length || 0)})
                                    </button>
                                </div>

                                {item.rfq_evolucoes && item.rfq_evolucoes.length > 0 ? (
                                    <div className="space-y-2">
                                        <p className="text-[10px] font-black text-blue-700 uppercase tracking-wider">Evolução / fornecimento atual informado por RFQ</p>
                                        {item.rfq_evolucoes.map((evo, evoIndex) => (
                                            <div key={`${evo.pn_anterior}-${evo.pn_atual_fornecimento}-${evo.cotacao_numero || evoIndex}`} className="rounded-xl border border-blue-200 bg-blue-50 p-3">
                                                <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
                                                    <div className="font-black text-blue-950"><span className="font-mono">{evo.pn_anterior}</span> <span className="mx-2">→</span> <span className="font-mono">{evo.pn_atual_fornecimento}</span></div>
                                                    <span className="text-[10px] font-black px-2 py-1 rounded border bg-white text-blue-700 border-blue-200">RFQ {evo.cotacao_numero || 'N/I'}</span>
                                                </div>
                                                <p className="text-xs font-bold text-blue-800 mt-1">PN atual de fornecimento informado por {evo.fornecedor || 'fornecedor'}. Isto não invalida automaticamente o uso técnico do PN anterior.</p>
                                                {evo.relacao_pn_texto ? <p className="text-xs text-slate-600 mt-1 italic">{evo.relacao_pn_texto}</p> : null}
                                                <div className="mt-2 flex flex-wrap gap-2 text-[10px] font-black">
                                                    {Number(evo.valor_unitario) > 0 ? <span className={`px-2 py-1 rounded border ${evo.preco_vigente === false ? 'bg-slate-100 text-slate-600 border-slate-200' : 'bg-emerald-50 text-emerald-700 border-emerald-200'}`}>Preço RFQ: £ {Number(evo.valor_unitario).toLocaleString('en-GB', { minimumFractionDigits: 2 })} {evo.preco_vigente === false ? '• VENCIDO' : ''}</span> : null}
                                                    {evo.validade ? <span className="px-2 py-1 rounded border bg-white text-slate-600 border-slate-200">Validade preço: {evo.validade}</span> : null}
                                                </div>
                                            </div>
                                        ))}
                                    </div>
                                ) : null}

                                {((item.dicionario && item.dicionario.length > 0) || (item.alternativos && item.alternativos.length > 0) || (item.manual_tecnico_aplicacoes && item.manual_tecnico_aplicacoes.length > 0) || (item.wtp_referencias && item.wtp_referencias.length > 0)) ? (
                                    <div className="space-y-4">
                                        <p className="text-[11px] font-black text-slate-500 uppercase tracking-widest">Manual, equivalências & referências WTP</p>

                                        {item.alternativos && item.alternativos.length > 0 ? (
                                            <div className="space-y-2">
                                                <p className="text-[10px] font-black text-emerald-700 uppercase tracking-wider">Alternativos / equivalências confirmados pelas regras do SISHA</p>
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
                                            </div>
                                        ) : (
                                            <p className="text-xs font-bold text-slate-400 italic">Nenhum alternativo confirmado pelas regras atuais.</p>
                                        )}

                                        {item.wtp_referencias && item.wtp_referencias.length > 0 ? (
                                            <div className="space-y-2">
                                                <p className="text-[10px] font-black text-amber-700 uppercase tracking-wider">Possíveis relações identificadas na WTP — validação obrigatória do CQ</p>
                                                <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
                                                    {item.wtp_referencias.map((ref, idx) => (
                                                        <div key={`${ref.manual_id}-${ref.pn_relacionado}-${ref.item_relacionado || idx}`} className="rounded-xl border border-amber-200 bg-amber-50 p-3">
                                                            <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-2">
                                                                <div>
                                                                    <p className="text-xs font-black text-amber-950 uppercase">
                                                                        {ref.tipo_relacao === 'WTP_ITEM_VARIANT' ? 'Possível equivalência / variante WTP' : ref.tipo_relacao === 'WTP_TEXT_REFERENCE' ? 'Referência textual WTP' : 'Referência técnica WTP'}
                                                                    </p>
                                                                    <p className="text-sm font-black text-slate-900 mt-1">
                                                                        PN relacionado: <span className="font-mono">{ref.pn_relacionado}</span>
                                                                    </p>
                                                                </div>
                                                                <span className="text-[10px] font-black px-2 py-1 rounded border bg-white text-amber-800 border-amber-200 whitespace-nowrap">
                                                                    {ref.manual_codigo || ref.tipo_manual || 'WTP'}
                                                                </span>
                                                            </div>

                                                            {ref.tipo_relacao === 'WTP_ITEM_VARIANT' ? (
                                                                <p className="text-xs font-bold text-amber-900 mt-2">
                                                                    ITEM {ref.item_consultado || 'N/I'} ↔ {ref.item_relacionado || 'N/I'}{ref.fig ? ` • FIG ${ref.fig}` : ''}
                                                                    {(ref.usage_code_consultado || ref.usage_code_relacionado) ? ` • Usage ${ref.usage_code_consultado || 'N/I'} ↔ ${ref.usage_code_relacionado || 'N/I'}` : ''}.
                                                                    {' '}A WTP relaciona os itens como variantes da mesma posição técnica, porém isto não confirma automaticamente intercambialidade.
                                                                </p>
                                                            ) : (
                                                                <p className="text-xs font-bold text-amber-900 mt-2">
                                                                    O referido item é citado na WTP como referência ao PN {ref.pn_relacionado}, mas isso não significa que seja alternativo ou intercambiável.
                                                                </p>
                                                            )}
                                                            <p className="text-xs font-black text-red-700 mt-2 uppercase">Consulte o CQ antes de qualquer substituição.</p>
                                                            {ref.page_ref ? <p className="text-[10px] font-bold text-slate-500 mt-1">Ref.: {ref.page_ref}</p> : null}
                                                        </div>
                                                    ))}
                                                </div>
                                            </div>
                                        ) : null}

                                        {item.manual_tecnico_aplicacoes && item.manual_tecnico_aplicacoes.length > 0 ? (
                                            <div className="space-y-2">
                                                <p className="text-[10px] font-black text-purple-700 uppercase tracking-wider">Aplicação documentada em WTP / Manual técnico</p>
                                                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
                                                    {item.manual_tecnico_aplicacoes.map((app, idx) => (
                                                        <div key={`${app.manual_id}-${app.fig}-${app.item}-${idx}`} className="rounded-xl border border-purple-200 bg-purple-50 p-3">
                                                            <div className="flex items-start justify-between gap-2">
                                                                <div>
                                                                    <p className="font-black text-purple-950">{app.manual_codigo || app.tipo_manual || 'Manual técnico'}</p>
                                                                    <p className="text-xs font-bold text-purple-800">FIG {app.fig || '1'} • ITEM {app.item || 'N/I'}</p>
                                                                </div>
                                                                <span className="text-[10px] font-black px-2 py-1 rounded border bg-white text-purple-700 border-purple-200">{app.tipo_manual || 'MANUAL'}</span>
                                                            </div>
                                                            <p className="text-xs font-bold text-slate-700 mt-2">{app.nomenclatura || 'Descrição não informada'}</p>
                                                            {app.usage_code ? <p className="text-[11px] font-black text-slate-600 mt-1">Usage Code: {app.usage_code}</p> : null}
                                                            {app.units_per_assy ? <p className="text-[11px] font-black text-slate-600 mt-1">Units/Assy: {app.units_per_assy}</p> : null}
                                                            {app.ata_dmc ? <p className="text-[11px] font-bold text-slate-500">ATA/DMC: {app.ata_dmc}</p> : null}
                                                            {app.revisao ? <p className="text-[11px] font-bold text-slate-500">Revisão: {app.revisao}</p> : null}
                                                            {app.page_ref ? <p className="text-[11px] font-bold text-slate-500">Ref.: {app.page_ref}</p> : null}
                                                            <p className="text-[10px] font-black text-purple-700 mt-2 uppercase">Referência técnica — não representa estoque</p>
                                                        </div>
                                                    ))}
                                                </div>
                                            </div>
                                        ) : null}
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
                                Mapa de Instalação / Referências Técnicas
                            </h3>
                            <button onClick={() => setModalAplicacoes(false)} className="text-slate-400 hover:text-red-400 transition-colors shrink-0">
                                <svg className="w-7 h-7 sm:w-8 sm:h-8" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.5" d="M6 18L18 6M6 6l12 12"></path>
                                </svg>
                            </button>
                        </div>

                        <div className="p-4 sm:p-6 overflow-y-auto flex-1 bg-slate-50 space-y-4">
                            {alvoAplicacoes.length > 0 ? (
                                <div className="space-y-3">
                                    <p className="text-[11px] font-black text-slate-500 uppercase tracking-widest">Manual / DMC</p>
                                    {alvoAplicacoes.map((app, i) => (
                                        <div key={`dmc-${i}`} className="bg-white p-4 sm:p-5 rounded-xl border border-slate-200 shadow-sm flex flex-col md:flex-row md:items-center justify-between gap-4 hover:border-blue-300 transition-all">
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
                                    ))}
                                </div>
                            ) : null}

                            {alvoManuaisTecnicos.length > 0 ? (
                                <div className="space-y-3">
                                    <p className="text-[11px] font-black text-purple-700 uppercase tracking-widest">WTP / Manual técnico</p>
                                    {alvoManuaisTecnicos.map((app, i) => (
                                        <div key={`wtp-${app.manual_id}-${app.item}-${i}`} className="bg-white p-4 sm:p-5 rounded-xl border border-purple-200 shadow-sm">
                                            <div className="flex flex-col md:flex-row md:items-start md:justify-between gap-3">
                                                <div className="min-w-0">
                                                    <p className="text-sm sm:text-base font-black text-purple-950 uppercase break-words">{app.manual_codigo || app.tipo_manual || 'MANUAL TÉCNICO'}</p>
                                                    <p className="text-xs sm:text-sm font-bold text-slate-600 mt-1">{app.nomenclatura || 'Descrição não informada'}</p>
                                                    {app.page_ref ? <p className="text-[11px] font-bold text-slate-500 mt-1">Ref.: {app.page_ref}</p> : null}
                                                </div>
                                                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                                                    <span className="bg-purple-50 text-purple-800 px-3 py-2 rounded-lg text-[10px] font-black border border-purple-200 flex flex-col items-center">FIG<span className="font-mono text-sm mt-0.5">{app.fig || '1'}</span></span>
                                                    <span className="bg-purple-50 text-purple-800 px-3 py-2 rounded-lg text-[10px] font-black border border-purple-200 flex flex-col items-center">ITEM<span className="font-mono text-sm mt-0.5">{app.item || 'N/I'}</span></span>
                                                    <span className="bg-slate-100 text-slate-700 px-3 py-2 rounded-lg text-[10px] font-black border border-slate-200 flex flex-col items-center">USAGE<span className="font-mono text-sm mt-0.5">{app.usage_code || 'N/I'}</span></span>
                                                    <span className="bg-slate-100 text-slate-700 px-3 py-2 rounded-lg text-[10px] font-black border border-slate-200 flex flex-col items-center">QTY<span className="font-mono text-sm mt-0.5">{app.units_per_assy || 'N/I'}</span></span>
                                                </div>
                                            </div>
                                            <p className="text-[10px] font-black text-purple-700 mt-3 uppercase">Fonte técnica — não representa estoque nem confirma alternativo</p>
                                        </div>
                                    ))}
                                </div>
                            ) : null}

                            {alvoWtpReferencias.length > 0 ? (
                                <div className="space-y-3">
                                    <p className="text-[11px] font-black text-amber-700 uppercase tracking-widest">Relações WTP pendentes de validação do CQ</p>
                                    {alvoWtpReferencias.map((ref, i) => (
                                        <div key={`wtp-ref-${ref.manual_id}-${ref.pn_relacionado}-${i}`} className="bg-amber-50 p-4 rounded-xl border border-amber-200 shadow-sm">
                                            <p className="text-sm font-black text-amber-950">
                                                PN relacionado: <span className="font-mono">{ref.pn_relacionado}</span>
                                            </p>
                                            {ref.tipo_relacao === 'WTP_ITEM_VARIANT' ? (
                                                <p className="text-xs font-bold text-amber-900 mt-1">{ref.manual_codigo || 'WTP'} • FIG {ref.fig || '1'} • ITEM {ref.item_consultado || 'N/I'} ↔ {ref.item_relacionado || 'N/I'} • possível variante/equivalência documental.</p>
                                            ) : (
                                                <p className="text-xs font-bold text-amber-900 mt-1">O referido item é citado na {ref.manual_codigo || 'WTP'} como referência ao PN {ref.pn_relacionado}, mas isso não significa que seja alternativo ou intercambiável.</p>
                                            )}
                                            <p className="text-xs font-black text-red-700 mt-2 uppercase">Consulte o CQ antes de qualquer substituição.</p>
                                        </div>
                                    ))}
                                </div>
                            ) : null}

                            {alvoAplicacoes.length === 0 && alvoManuaisTecnicos.length === 0 ? (
                                <div className="bg-white p-4 sm:p-5 rounded-xl border border-slate-200 shadow-sm space-y-3">
                                    <p className="text-sm sm:text-base font-black text-slate-800 uppercase">Sem mapa técnico documental</p>
                                    <p className="text-sm font-bold text-slate-500">Este item foi encontrado apenas em fontes complementares de relacionamento.</p>
                                    <div className="flex flex-wrap gap-2 pt-2">
                                        {(fontesMapa || []).length > 0 ? fontesMapa.map((fonte, i) => (
                                            <span key={i} className="bg-amber-50 text-amber-800 px-3 py-2 rounded-lg text-[10px] font-black border border-amber-200 uppercase">{fonte}</span>
                                        )) : (
                                            <span className="bg-slate-100 text-slate-700 px-3 py-2 rounded-lg text-[10px] font-black border border-slate-200 uppercase">Fonte não informada</span>
                                        )}
                                    </div>
                                </div>
                            ) : null}
                        </div>

                        <div className="bg-slate-100 p-4 sm:p-5 border-t border-slate-200 flex justify-end">
                            <button onClick={() => setModalAplicacoes(false)} className="w-full sm:w-auto bg-slate-800 text-white px-8 py-3 rounded-xl text-sm font-black hover:bg-slate-900 transition-all shadow-sm">
                                FECHAR MAPA
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {modalIndisponiveis && alvoIndisponiveis && (
                <div className="fixed inset-0 z-[125] flex items-center justify-center p-3 sm:p-4 bg-slate-900/80 backdrop-blur-sm animate-fade-in">
                    <div className="w-full max-w-4xl bg-white rounded-3xl border border-slate-200 shadow-2xl overflow-hidden">
                        <div className="px-4 sm:px-6 py-4 border-b border-slate-200 bg-slate-50 flex items-start sm:items-center justify-between gap-4">
                            <div>
                                <h3 className="text-lg sm:text-xl font-black text-slate-900 uppercase">Itens fora da linha de voo</h3>
                                <p className="text-xs sm:text-sm font-bold text-slate-500">
                                    {alvoIndisponiveis.pn} • localização física preservada • não contabilizados no card PPU.
                                </p>
                            </div>
                            <button
                                type="button"
                                onClick={() => { setModalIndisponiveis(false); setAlvoIndisponiveis(null); }}
                                className="p-2 rounded-xl text-slate-500 hover:text-red-500 hover:bg-red-50 transition-all shrink-0"
                            >
                                <X size={20} />
                            </button>
                        </div>

                        <div className="p-4 sm:p-6 max-h-[75vh] overflow-auto custom-scrollbar space-y-3">
                            {(alvoIndisponiveis.itens_fora_linha || []).map((row, index) => (
                                <div key={row.id || `${row.pn}-${row.sn || index}`} className="rounded-2xl border border-amber-200 bg-amber-50/60 p-4">
                                    <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3">
                                        <div>
                                            <p className="text-sm font-black text-slate-900">{row.nomenclatura || alvoIndisponiveis.nomenclatura || 'Nomenclatura não informada'}</p>
                                            <p className="mt-1 text-xs font-bold text-slate-600">PN <span className="font-mono text-slate-900">{row.pn}</span>{row.sn ? <> • SN <span className="font-mono text-slate-900">{row.sn}</span></> : ' • SN não informado'}</p>
                                            <p className="mt-1 text-xs font-black text-amber-900">Localização física: {row.localizacao_fisica || 'NÃO DEFINIDO'}</p>
                                        </div>
                                        <span className="rounded-xl bg-slate-900 px-3 py-2 text-sm font-black text-white shrink-0">{formatQuantity(row.quantidade)} un</span>
                                    </div>

                                    <div className="mt-3 grid grid-cols-1 sm:grid-cols-2 gap-2">
                                        <div className="rounded-xl border border-slate-200 bg-white px-3 py-2">
                                            <p className="text-[10px] font-black uppercase tracking-wider text-slate-400">Contabiliza em</p>
                                            <p className="text-xs font-black text-slate-800">{LOCATION_DESTINATION_LABELS[row.contabiliza_em] || row.contabiliza_em || 'Fora da linha de voo'}</p>
                                        </div>
                                        <div className="rounded-xl border border-slate-200 bg-white px-3 py-2">
                                            <p className="text-[10px] font-black uppercase tracking-wider text-slate-400">Situação operacional</p>
                                            <p className="text-xs font-black text-slate-800">{OPERATIONAL_SITUATION_LABELS[row.situacao_operacional] || row.situacao_operacional || 'A confirmar'}</p>
                                        </div>
                                    </div>

                                    {row.observacao_classificacao ? (
                                        <div className="mt-2 rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs font-bold text-slate-700">
                                            <span className="font-black">Observação:</span> {row.observacao_classificacao}
                                        </div>
                                    ) : null}

                                    {(row.evidencias || []).length > 0 ? (
                                        <div className="mt-2 space-y-1.5">
                                            <p className="text-[10px] font-black uppercase tracking-wider text-slate-500">Evidências vinculadas pelo SN</p>
                                            {row.evidencias.map((evidencia, evidenceIndex) => (
                                                <div key={`${evidencia.documento || 'evidencia'}-${evidenceIndex}`} className="rounded-xl border border-blue-200 bg-blue-50 px-3 py-2 text-xs font-bold text-blue-900">
                                                    {evidencia.documento || evidencia.origem || 'Registro técnico'}
                                                    {evidencia.status ? ` • ${evidencia.status}` : ''}
                                                    {evidencia.tipo ? ` • ${evidencia.tipo}` : ''}
                                                </div>
                                            ))}
                                        </div>
                                    ) : null}
                                </div>
                            ))}
                        </div>

                        <div className="bg-slate-100 p-4 sm:p-5 border-t border-slate-200 flex justify-end">
                            <button
                                type="button"
                                onClick={() => { setModalIndisponiveis(false); setAlvoIndisponiveis(null); }}
                                className="w-full sm:w-auto bg-slate-800 text-white px-8 py-3 rounded-xl text-sm font-black hover:bg-slate-900 transition-all shadow-sm"
                            >
                                FECHAR
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
                            <div className="grid grid-cols-1 lg:grid-cols-[1fr_auto_auto_auto] gap-3 items-end">
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

                                <button
                                    type="button"
                                    onClick={() => setQuoteOpen(true)}
                                    disabled={!lotePreview || loteMissingQuoteItems.length === 0}
                                    className="px-5 py-3 rounded-xl bg-amber-500 text-slate-950 font-black hover:bg-amber-600 disabled:opacity-50 inline-flex items-center justify-center gap-2"
                                >
                                    <FileQuestion size={16} /> COTAÇÃO {loteMissingQuoteItems.length > 0 ? `(${loteMissingQuoteItems.length})` : ''}
                                </button>
                            </div>

                            <div className="rounded-2xl border border-blue-200 bg-blue-50 px-4 py-3 text-sm text-blue-950">
                                <p className="font-black uppercase tracking-wide">Como deve estar a planilha</p>
                                <div className="mt-2 grid grid-cols-1 md:grid-cols-2 gap-2 font-bold">
                                    <p><b>PN obrigatório:</b> PN, P/N, PART NUMBER, PART NO, NÚMERO DA PEÇA ou CÓDIGO.</p>
                                    <p><b>Quantidade opcional:</b> QTD, QTDE, QTE, QTY, QUANTITY, NECESSIDADE ou DEMANDA. Sem essa coluna, o sistema considera 1 unidade por linha.</p>
                                    <p><b>NSN opcional:</b> NSN, NATO STOCK NUMBER ou NIIN.</p>
                                    <p><b>Nomenclatura opcional:</b> NOMENCLATURA, NOME, DESCRIÇÃO, DESCRIPTION, ITEM ou MATERIAL.</p>
                                </div>
                                <p className="mt-2 text-xs font-black">A ordem das colunas não importa e colunas adicionais são permitidas. Formatos aceitos: XLSX, XLS, CSV e ODS.</p>
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
                                            <p className="text-[11px] uppercase tracking-[0.2em] text-slate-400 font-black">PPU + Recibos + CeIMSPA</p>
                                            <p className="text-2xl font-black text-slate-900 mt-2">{(lotePreview.summary.disponivel_ppu ?? lotePreview.summary.coberto_ppu ?? 0) + (lotePreview.summary.disponivel_ceimspa ?? lotePreview.summary.coberto_ceimspa ?? 0)}</p>
                                        </div>
                                        <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
                                            <p className="text-[11px] uppercase tracking-[0.2em] text-slate-400 font-black">ODA + ODC</p>
                                            <p className="text-2xl font-black text-slate-900 mt-2">{(lotePreview.summary.disponivel_oda ?? lotePreview.summary.coberto_oda ?? 0) + (lotePreview.summary.disponivel_odc ?? lotePreview.summary.coberto_odc ?? 0)}</p>
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
                                        <div className="px-4 py-3 border-b border-slate-200 bg-slate-50 font-black text-slate-900 uppercase text-sm">Resumo por fonte</div>
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
                                                        ['04 • BANCO DE PREÇOS', lotePreview.sections.pricelist?.length || 0],
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
                                      ['04 • BANCO DE PREÇOS', lotePreview.sections.pricelist || [], 'value'],
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
                                                  {type === 'coverage' ? <th className="p-3 text-left">Disponível</th> : null}
                                                  <th className="p-3 text-left">Faltam</th>
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
                                                    {type === 'coverage' ? <td className="p-3 font-black text-emerald-700">{row.disponivel_etapa ?? row.cobertura_etapa}</td> : null}
                                                    <td className="p-3 font-black text-amber-700">{row.faltam_apos_etapa ?? row.saldo_apos_etapa}</td>
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

            <CotacaoRequestModal
                open={quoteOpen}
                onClose={() => setQuoteOpen(false)}
                token={token}
                source="PESQUISA_EM_LOTE"
                items={loteMissingQuoteItems}
            />
        </div>
    );
}