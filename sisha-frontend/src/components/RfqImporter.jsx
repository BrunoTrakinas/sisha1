import React, { useState } from 'react';
import { useAuth } from '../context/AuthContext';
import { apiFetch, buildAuthHeaders } from '../lib/api';

export default function RfqImporter() {
    const { token } = useAuth();
    const [file, setFile] = useState(null);
    const [isUploading, setIsUploading] = useState(false);
    const [rfqData, setRfqData] = useState(null);

    const handleLerPdf = async () => {
        if (!file) return alert("Selecione a planilha (.xlsx) primeiro, Comando!");
        setIsUploading(true);
        const formData = new FormData();
        formData.append('file', file);

        try {
            const response = await apiFetch('/import/rfq', {
                method: 'POST',
                headers: buildAuthHeaders(token),
                body: formData
            }, token);
            const result = await response.json();
            
            if (result.status === 'success') {
                setRfqData({ metadados: result.metadados, items: result.items });
            } else {
                alert("Erro na leitura: " + result.message);
            }
        } catch (error) {
            alert("Falha na comunicação com o motor do servidor.");
        } finally {
            setIsUploading(false);
        }
    };

    const handleMetaChange = (field, value) => {
        setRfqData(prev => ({ ...prev, metadados: { ...prev.metadados, [field]: value } }));
    };

    const handleItemChange = (index, field, value) => {
        setRfqData(prev => {
            const newItems = [...prev.items];
            newItems[index][field] = value;
            return { ...prev, items: newItems };
        });
    };

    const handleSalvarDefinitivo = async () => {
        setIsUploading(true);
        try {
            const response = await apiFetch('/import/rfq/salvar', {
                method: 'POST',
                headers: buildAuthHeaders(token, { 'Content-Type': 'application/json' }),
                body: JSON.stringify(rfqData)
            }, token);
            const result = await response.json();
            if (result.status === 'success') {
                alert(result.message);
                setRfqData(null);
                setFile(null);
            } else {
                alert("Erro ao gravar: " + result.message);
            }
        } catch (error) {
            alert("Falha ao salvar no banco.");
        } finally {
            setIsUploading(false);
        }
    };

    return (
        <div className="p-6 bg-slate-50 border border-slate-200 rounded-xl mb-6 shadow-sm">
            <h2 className="text-lg font-black text-slate-800 mb-4 uppercase flex items-center gap-2">
                <svg className="w-5 h-5 text-blue-600" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"></path></svg>
                Importar Cotação (RFQ I Love PDF)
            </h2>
            <div className="flex flex-col sm:flex-row items-center gap-4">
                <input 
                    type="file" 
                    accept=".xlsx, .xls"
                    onChange={(e) => setFile(e.target.files[0])}
                    className="flex-1 w-full p-2 border-2 border-dashed border-slate-300 rounded-lg bg-white file:mr-4 file:py-2 file:px-4 file:rounded-lg file:border-0 file:text-sm file:font-black file:bg-blue-50 file:text-blue-700 hover:file:bg-blue-100 cursor-pointer"
                />
                <button 
                    onClick={handleLerPdf}
                    disabled={isUploading || !file}
                    className="w-full sm:w-auto bg-slate-800 text-white px-8 py-3 rounded-lg font-black hover:bg-slate-900 disabled:opacity-50 uppercase tracking-wide"
                >
                    {isUploading ? 'A VARRER...' : 'LER FICHEIRO'}
                </button>
            </div>

            {rfqData && (
                <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-sm flex justify-center items-center z-50 p-4 sm:p-8">
                    <div className="bg-white rounded-2xl shadow-2xl w-full max-w-6xl max-h-[90vh] overflow-hidden flex flex-col border-4 border-blue-600">
                        
                        <div className="bg-blue-600 text-white p-5 flex justify-between items-center">
                            <div>
                                <h3 className="text-xl font-black uppercase tracking-wider">Revisão Tática - RFQ</h3>
                                <p className="text-sm text-blue-100 font-bold">Campos editáveis para ajuste fino.</p>
                            </div>
                            <span className="bg-white text-blue-800 px-3 py-1 rounded-full text-sm font-black">{rfqData.items.length} ITENS</span>
                        </div>

                        <div className="p-6 overflow-y-auto bg-slate-100 flex-1 space-y-6">
                            
                            {/* METADADOS */}
                            <div className="grid grid-cols-2 md:grid-cols-4 gap-4 bg-white p-5 rounded-xl border border-slate-200 shadow-sm">
                                <div><label className="block text-xs font-black text-slate-500 uppercase mb-1">Nº Cotação</label><input type="text" value={rfqData.metadados.quotation_number} onChange={e => handleMetaChange('quotation_number', e.target.value)} className="w-full font-bold text-slate-900 border-b-2 border-slate-200 focus:border-blue-500 outline-none p-1 bg-white" /></div>
                                <div><label className="block text-xs font-black text-slate-500 uppercase mb-1">Data</label><input type="text" value={rfqData.metadados.quotation_date} onChange={e => handleMetaChange('quotation_date', e.target.value)} className="w-full font-bold text-slate-900 border-b-2 border-slate-200 focus:border-blue-500 outline-none p-1 bg-white" /></div>
                                <div><label className="block text-xs font-black text-slate-500 uppercase mb-1">Validade</label><input type="text" value={rfqData.metadados.validity} onChange={e => handleMetaChange('validity', e.target.value)} className="w-full font-bold text-amber-700 border-b-2 border-slate-200 focus:border-amber-500 outline-none p-1 bg-white" /></div>
                                <div><label className="block text-xs font-black text-slate-500 uppercase mb-1">Condição</label><input type="text" value={rfqData.metadados.condicao} onChange={e => handleMetaChange('condicao', e.target.value)} className="w-full font-bold text-slate-900 border-b-2 border-slate-200 focus:border-blue-500 outline-none p-1 bg-white" /></div>
                            </div>

                            {/* ITENS */}
                            <div className="space-y-4">
                                {rfqData.items.map((item, idx) => (
                                    <div key={idx} className="bg-white border-2 border-slate-200 rounded-xl p-5 shadow-sm relative hover:border-blue-300 transition-colors">
                                        
                                        <div className="absolute top-4 right-4">
                                            <button onClick={() => setRfqData({...rfqData, items: rfqData.items.filter((_, i) => i !== idx)})} className="bg-red-50 text-red-500 hover:bg-red-500 hover:text-white rounded-lg p-2 font-black">X</button>
                                        </div>

                                        <div className="flex items-start gap-4">
                                            <div className="w-12 h-12 bg-slate-800 rounded-lg flex items-center justify-center font-black text-white text-lg shrink-0">
                                                {item.item_num}
                                            </div>
                                            
                                            <div className="flex-1 grid grid-cols-1 md:grid-cols-12 gap-4">
                                                <div className="col-span-12 md:col-span-3">
                                                    <label className="block text-[10px] font-black text-slate-500 uppercase">Part Number</label>
                                                    <input type="text" value={item.pn} onChange={e => handleItemChange(idx, 'pn', e.target.value)} className="w-full font-black text-lg text-slate-900 border-b-2 border-slate-300 focus:border-blue-500 outline-none bg-transparent uppercase" />
                                                </div>
                                                <div className="col-span-12 md:col-span-3">
                                                    <label className="block text-[10px] font-black text-slate-500 uppercase">NSN</label>
                                                    <input type="text" value={item.nsn} onChange={e => handleItemChange(idx, 'nsn', e.target.value)} className="w-full font-bold text-sm text-slate-700 border-b-2 border-slate-200 focus:border-blue-500 outline-none bg-transparent mt-1" />
                                                </div>
                                                <div className="col-span-12 md:col-span-6">
                                                    <label className="block text-[10px] font-black text-slate-500 uppercase">Descrição / Nomenclatura</label>
                                                    <input type="text" value={item.nomenclatura} onChange={e => handleItemChange(idx, 'nomenclatura', e.target.value)} className="w-full font-bold text-sm text-slate-700 border-b-2 border-slate-200 focus:border-blue-500 outline-none bg-transparent mt-1 uppercase" />
                                                </div>

                                                {/* NÚMEROS COM CORREÇÃO DE COR */}
                                                <div className="col-span-12 md:col-span-3">
                                                    <label className="block text-[10px] font-black text-blue-600 uppercase">Qtd Solicitada</label>
                                                    <input type="number" step="0.01" value={item.qtd_solicitada || ''} onChange={e => handleItemChange(idx, 'qtd_solicitada', parseFloat(e.target.value) || 0)} className="w-full font-black text-center border-2 border-blue-100 bg-blue-50 rounded-lg p-2 focus:border-blue-400 outline-none text-blue-900" />
                                                </div>
                                                <div className="col-span-12 md:col-span-3">
                                                    <label className="block text-[10px] font-black text-slate-600 uppercase">Lead Time (Dias)</label>
                                                    <input type="number" value={item.lead_time || ''} onChange={e => handleItemChange(idx, 'lead_time', parseInt(e.target.value) || 0)} className="w-full font-black text-center border-2 border-blue-100 bg-blue-50 rounded-lg p-2 focus:border-slate-400 outline-none text-blue-900" />
                                                </div>
                                                <div className="col-span-12 md:col-span-3">
                                                    <label className="block text-[10px] font-black text-slate-600 uppercase">Estoque (Available)</label>
                                                    <input type="number" step="0.01" value={item.estoque_pronto || ''} onChange={e => handleItemChange(idx, 'estoque_pronto', parseFloat(e.target.value) || 0)} className="w-full font-black text-center border-2 border-slate-200 bg-slate-100 rounded-lg p-2 focus:border-slate-400 outline-none text-slate-900" />
                                                </div>
                                                <div className="col-span-12 md:col-span-3">
                                                    <label className="block text-[10px] font-black text-emerald-700 uppercase">Preço Unit (£)</label>
                                                    <input type="number" step="0.01" value={item.valor_unitario || ''} onChange={e => handleItemChange(idx, 'valor_unitario', parseFloat(e.target.value) || 0)} className="w-full font-black text-emerald-900 text-center border-2 border-emerald-200 bg-emerald-50 rounded-lg p-2 focus:border-emerald-500 outline-none" />
                                                </div>
                                            </div>
                                        </div>
                                    </div>
                                ))}
                            </div>
                        </div>

                        <div className="bg-white p-5 border-t border-slate-200 flex justify-end gap-4 shadow-inner">
                            <button onClick={() => setRfqData(null)} className="px-8 py-3 font-black text-slate-500 hover:bg-slate-100 rounded-xl">ABORTAR</button>
                            <button onClick={handleSalvarDefinitivo} className="px-8 py-3 font-black text-white bg-blue-600 hover:bg-blue-700 rounded-xl shadow-lg flex items-center gap-2 transition-all transform hover:scale-105">GRAVAR NO COFRE</button>
                        </div>

                    </div>
                </div>
            )}
        </div>
    );
}