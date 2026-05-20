import React, { useState } from 'react';
import { CalendarDays, ClipboardList, LoaderCircle, PackageSearch, Search } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { apiFetch } from '../lib/api';

const formatDateBR = (value) => {
    if (!value) return '—';
    const [year, month, day] = String(value).split('-');
    if (!year || !month || !day) return value;
    return `${day}/${month}/${year}`;
};

export default function HistoricoMovimentacao() {
    const { token } = useAuth();
    const [termo, setTermo] = useState('');
    const [resultado, setResultado] = useState(null);
    const [carregando, setCarregando] = useState(false);
    const [buscaRealizada, setBuscaRealizada] = useState(false);
    const [erro, setErro] = useState('');

    const buscarHistorico = async (e) => {
        if (e) e.preventDefault();
        if (!termo.trim()) return;

        setCarregando(true);
        setBuscaRealizada(true);
        setErro('');
        setResultado(null);

        try {
            const response = await apiFetch(`/history/movimentacoes?pn=${encodeURIComponent(termo)}`, {}, token);
            const json = await response.json();
            if (json.status !== 'success') throw new Error(json.message || 'Falha ao consultar histórico.');
            setResultado(json.data);
        } catch (error) {
            setErro(error.message || 'Falha ao consultar histórico de movimentação.');
            setResultado(null);
        }

        setCarregando(false);
    };

    const movimentos = resultado?.movimentos || [];

    return (
        <div className={`w-full h-full flex flex-col transition-all duration-700 ease-in-out ${buscaRealizada ? 'items-center pt-3 sm:pt-4' : 'items-center justify-center mt-[-4vh] md:mt-[-10vh]'}`}>
            {!buscaRealizada && (
                <div className="text-center mb-6 sm:mb-8 animate-fade-in px-4">
                    <h1 className="text-3xl sm:text-4xl md:text-5xl font-black text-slate-800 tracking-tight md:tracking-tighter italic leading-none">
                        HISTÓRICO <span className="text-blue-600">DE MOVIMENTAÇÃO</span>
                    </h1>
                    <p className="text-slate-400 font-bold mt-2 uppercase tracking-[0.18em] sm:tracking-widest text-[10px] sm:text-xs">
                        SISHA-1 V2 • Saídas por PN, Data, QTD e OS
                    </p>
                </div>
            )}

            <form onSubmit={buscarHistorico} className={`w-full px-3 sm:px-4 transition-all duration-700 max-w-3xl ${buscaRealizada ? 'mb-4 sm:mb-6' : ''}`}>
                <div className="relative flex flex-col sm:flex-row sm:items-center gap-2 sm:gap-0 shadow-md rounded-3xl sm:rounded-full bg-white border border-slate-200 focus-within:ring-4 focus-within:ring-blue-100 transition-all p-2 sm:p-0">
                    <div className="pl-3 sm:pl-5 pr-1 text-blue-600 flex items-center h-10 sm:h-auto">
                        <Search size={20} />
                    </div>

                    <input
                        type="text"
                        value={termo}
                        onChange={(e) => setTermo(e.target.value)}
                        placeholder="Digite o PN para consultar o histórico de saída..."
                        className="w-full py-2.5 sm:py-4 px-3 sm:px-4 text-sm sm:text-base bg-transparent border-none outline-none text-slate-700 uppercase"
                    />

                    <button
                        type="submit"
                        disabled={carregando}
                        className={`w-full sm:w-auto mr-0 sm:mr-2 bg-blue-600 text-white px-6 py-3 sm:py-2.5 rounded-2xl sm:rounded-full text-sm font-black hover:bg-blue-700 transition-all disabled:opacity-50 shadow-sm ${carregando ? 'animate-pulse' : ''}`}
                    >
                        {carregando ? 'BUSCANDO...' : 'CONSULTAR'}
                    </button>
                </div>
            </form>

            <div className="w-full max-w-[95rem] px-3 sm:px-4 space-y-4 sm:space-y-5 animate-fade-in pb-20">
                {carregando && (
                    <div className="text-center p-6 sm:p-10 bg-white rounded-2xl border border-slate-200 shadow-sm">
                        <LoaderCircle className="animate-spin mx-auto text-blue-600" size={28} />
                        <p className="mt-3 text-slate-500 font-black uppercase tracking-wider">Consultando movimentações...</p>
                    </div>
                )}

                {erro && !carregando && (
                    <div className="text-center p-6 sm:p-10 bg-white rounded-2xl border-2 border-dashed border-red-200">
                        <p className="text-red-600 text-base sm:text-lg font-bold uppercase tracking-wider">{erro}</p>
                    </div>
                )}

                {buscaRealizada && !carregando && !erro && resultado && movimentos.length === 0 && (
                    <div className="text-center p-6 sm:p-10 bg-white rounded-2xl border-2 border-dashed border-slate-200">
                        <p className="text-slate-500 text-base sm:text-lg font-bold uppercase tracking-wider">
                            Nenhuma movimentação encontrada para este PN.
                        </p>
                    </div>
                )}

                {resultado && !carregando && movimentos.length > 0 && (
                    <div className="bg-white p-4 sm:p-5 md:p-6 rounded-2xl border border-slate-200 shadow-sm relative overflow-hidden">
                        <div className="absolute top-0 left-0 w-1.5 h-full bg-blue-600"></div>

                        <div className="flex flex-col md:flex-row justify-between items-start md:items-center mb-5 sm:mb-6 pl-3 sm:pl-4 gap-4">
                            <div className="min-w-0">
                                <h2 className="text-xl sm:text-2xl md:text-3xl font-black text-slate-800 tracking-tight break-all">
                                    {resultado.pn}
                                </h2>
                                <p className="text-slate-600 font-bold text-sm sm:text-base mt-1">
                                    {resultado.nomenclatura}
                                </p>
                                <div className="mt-2.5 flex flex-wrap gap-2 sm:gap-3">
                                    <span className="text-xs sm:text-sm font-mono font-black px-3 py-1 rounded-lg border bg-slate-50 text-slate-600 border-slate-200">
                                        NSN/PI: {resultado.nsn_pi || '—'}
                                    </span>
                                    <span className="text-xs sm:text-sm font-black px-3 py-1 rounded-lg border bg-blue-50 text-blue-700 border-blue-200">
                                        Fonte: Histórico de Movimentação
                                    </span>
                                </div>
                            </div>
                        </div>

                        <div className="grid grid-cols-1 md:grid-cols-3 gap-3 sm:gap-4 pl-3 sm:pl-4 mb-6">
                            <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
                                <p className="text-[11px] uppercase tracking-[0.2em] text-slate-400 font-black">Total movimentado</p>
                                <p className="text-2xl font-black text-slate-900 mt-2">{Number(resultado.resumo.quantidade_total || 0).toLocaleString('pt-BR')}</p>
                            </div>
                            <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
                                <p className="text-[11px] uppercase tracking-[0.2em] text-slate-400 font-black">Registros</p>
                                <p className="text-2xl font-black text-slate-900 mt-2">{Number(resultado.resumo.total_registros || 0).toLocaleString('pt-BR')}</p>
                            </div>
                            <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
                                <p className="text-[11px] uppercase tracking-[0.2em] text-slate-400 font-black">Período</p>
                                <p className="text-lg font-black text-slate-900 mt-2">
                                    {formatDateBR(resultado.resumo.data_inicial)} até {formatDateBR(resultado.resumo.data_final)}
                                </p>
                            </div>
                        </div>

                        <div className="pl-3 sm:pl-4 space-y-3">
                            {movimentos.map((mov) => (
                                <div key={mov.id} className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm flex flex-col md:flex-row md:items-center md:justify-between gap-3">
                                    <div className="flex items-start gap-3 min-w-0">
                                        <div className="p-3 rounded-2xl bg-blue-50 text-blue-600 shrink-0">
                                            <CalendarDays size={18} />
                                        </div>
                                        <div className="min-w-0">
                                            <p className="text-xs uppercase tracking-[0.2em] text-slate-400 font-black">Data da movimentação</p>
                                            <p className="text-lg font-black text-slate-900">{formatDateBR(mov.data)}</p>
                                            <p className="text-xs font-bold text-slate-400 mt-1 break-all">Arquivo: {mov.fonte_arquivo || '—'}</p>
                                        </div>
                                    </div>

                                    <div className="flex flex-wrap gap-2 md:justify-end">
                                        <span className="inline-flex items-center gap-2 rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-sm font-black text-slate-700">
                                            <ClipboardList size={15} /> OS {mov.os || '—'}
                                        </span>
                                        <span className="inline-flex items-center gap-2 rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm font-black text-emerald-700">
                                            <PackageSearch size={15} /> QTD {Number(mov.quantidade || 0).toLocaleString('pt-BR')}
                                        </span>
                                    </div>
                                </div>
                            ))}
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
}
