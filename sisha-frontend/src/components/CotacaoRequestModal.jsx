import React, { useEffect, useMemo, useState } from 'react';
import { Download, LoaderCircle, X } from 'lucide-react';
import { apiFetch, buildAuthHeaders } from '../lib/api';

function fileNameFromDisposition(value = '') {
  const match = String(value).match(/filename="?([^";]+)"?/i);
  return match?.[1] || 'solicitacao_cotacao.xlsx';
}

export default function CotacaoRequestModal({ open, onClose, token, source = 'SISHA', items = [] }) {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!open) return;
    let active = true;
    setLoading(true);
    setError('');
    apiFetch('/needs/quote-request/prepare', {
      method: 'POST',
      headers: buildAuthHeaders(token, { 'Content-Type': 'application/json' }),
      body: JSON.stringify({ items, source }),
    }, token)
      .then(async (response) => {
        const payload = await response.json();
        if (!response.ok || payload.status !== 'success') throw new Error(payload.message || 'Falha ao preparar a cotação.');
        if (active) setRows(payload.data || []);
      })
      .catch((err) => { if (active) setError(err.message || 'Falha ao preparar a cotação.'); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [open, token, source, items]);

  const pendingCount = useMemo(() => rows.filter((row) => row.solicitado_anteriormente).length, [rows]);

  const updateRow = (index, field, value) => {
    setRows((current) => current.map((row, rowIndex) => rowIndex === index ? { ...row, [field]: value } : row));
  };

  const removeRow = (index) => setRows((current) => current.filter((_, rowIndex) => rowIndex !== index));

  const handleExport = async () => {
    if (!rows.length) return;
    setExporting(true);
    setError('');
    try {
      const response = await apiFetch('/needs/quote-request/export/xlsx', {
        method: 'POST',
        headers: buildAuthHeaders(token, { 'Content-Type': 'application/json' }),
        body: JSON.stringify({ source, items: rows }),
      }, token);
      if (!response.ok) {
        let message = 'Falha ao exportar a solicitação de cotação.';
        try { message = (await response.json())?.message || message; } catch { /* arquivo não-json */ }
        throw new Error(message);
      }
      const blob = await response.blob();
      const url = window.URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = fileNameFromDisposition(response.headers.get('Content-Disposition'));
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.URL.revokeObjectURL(url);
    } catch (err) {
      setError(err.message || 'Falha ao exportar a solicitação de cotação.');
    } finally {
      setExporting(false);
    }
  };

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[90] bg-slate-950/65 backdrop-blur-sm flex items-center justify-center p-3 sm:p-6">
      <div className="w-full max-w-7xl max-h-[92vh] bg-white dark:bg-slate-900 rounded-2xl shadow-2xl border border-slate-200 dark:border-slate-800 overflow-hidden flex flex-col">
        <div className="px-5 py-4 border-b border-slate-200 dark:border-slate-800 flex items-start justify-between gap-4">
          <div>
            <h3 className="text-xl font-black text-slate-900 dark:text-slate-100 uppercase">Solicitar cotação</h3>
            <p className="text-sm font-semibold text-slate-500 dark:text-slate-400 mt-1">Itens sem preço vigente ou com referência vencida/histórica. Revise todos os campos antes de exportar.</p>
            {pendingCount > 0 ? <p className="text-xs font-black text-amber-700 dark:text-amber-300 mt-2">{pendingCount} PN(s) já possuem solicitação aguardando resposta.</p> : null}
          </div>
          <button onClick={onClose} className="p-2 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-500 dark:text-slate-400"><X size={20} /></button>
        </div>

        <div className="overflow-auto flex-1 p-4">
          {loading ? (
            <div className="min-h-56 flex items-center justify-center gap-3 font-black text-slate-500 dark:text-slate-400"><LoaderCircle className="animate-spin" /> PREPARANDO DADOS...</div>
          ) : error ? (
            <div className="bg-red-50 dark:bg-red-950/30 border border-red-200 dark:border-red-800 text-red-700 dark:text-red-300 rounded-xl p-4 font-bold">{error}</div>
          ) : rows.length === 0 ? (
            <div className="bg-emerald-50 dark:bg-emerald-950/30 border border-emerald-200 dark:border-emerald-800 text-emerald-800 dark:text-emerald-300 rounded-xl p-4 font-bold">Nenhum item precisa de atualização de cotação.</div>
          ) : (
            <table className="w-full min-w-[1180px] text-sm border-separate border-spacing-0">
              <thead className="sticky top-0 z-10 bg-slate-900 text-white">
                <tr>
                  {['ITEM (NOMENCLATURA)', 'P/N', 'NSN', 'MANUAL', 'FIG', 'ITEM', 'CODEMP', 'QTD', ''].map((label) => <th key={label || 'acao'} className="px-3 py-3 text-left text-xs font-black uppercase">{label}</th>)}
                </tr>
              </thead>
              <tbody>
                {rows.map((row, index) => (
                  <tr key={`${row.pn}-${index}`} className="border-b border-slate-100 dark:border-slate-800 align-top">
                    <td className="p-2 min-w-[250px]"><input value={row.nomenclatura || ''} onChange={(e) => updateRow(index, 'nomenclatura', e.target.value)} className="w-full border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 text-slate-900 dark:text-slate-100 rounded-lg p-2 font-bold uppercase" /></td>
                    <td className="p-2 min-w-[190px]"><input value={row.pn || ''} onChange={(e) => updateRow(index, 'pn', e.target.value)} className="w-full border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 text-slate-900 dark:text-slate-100 rounded-lg p-2 font-black uppercase" /></td>
                    <td className="p-2 min-w-[180px]"><input value={row.nsn || ''} onChange={(e) => updateRow(index, 'nsn', e.target.value)} className="w-full border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 text-slate-900 dark:text-slate-100 rounded-lg p-2 font-bold" /></td>
                    <td className="p-2 min-w-[190px]">
                      <input value={row.manual || ''} onChange={(e) => updateRow(index, 'manual', e.target.value)} className="w-full border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 text-slate-900 dark:text-slate-100 rounded-lg p-2 font-bold uppercase" />
                      {row.manual_aviso ? <p className="mt-1 text-[11px] leading-tight font-bold text-amber-700 dark:text-amber-300">{row.manual_aviso}</p> : null}
                    </td>
                    <td className="p-2 w-20"><input value={row.fig || '1'} onChange={(e) => updateRow(index, 'fig', e.target.value)} className="w-full border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 text-slate-900 dark:text-slate-100 rounded-lg p-2 font-bold text-center" /></td>
                    <td className="p-2 min-w-[100px]"><input value={row.item || ''} onChange={(e) => updateRow(index, 'item', e.target.value)} className="w-full border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 text-slate-900 dark:text-slate-100 rounded-lg p-2 font-bold uppercase" /></td>
                    <td className="p-2 min-w-[120px]"><input value={row.codemp || ''} onChange={(e) => updateRow(index, 'codemp', e.target.value)} placeholder="Preencher" className="w-full border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 text-slate-900 dark:text-slate-100 rounded-lg p-2 font-bold uppercase" /></td>
                    <td className="p-2 w-24"><input type="number" min="0" step="0.01" value={row.qtd ?? ''} onChange={(e) => updateRow(index, 'qtd', Number(e.target.value) || 0)} className="w-full border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 text-slate-900 dark:text-slate-100 rounded-lg p-2 font-black text-center" /></td>
                    <td className="p-2 w-12"><button onClick={() => removeRow(index)} className="p-2 rounded-lg text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-950/30"><X size={16} /></button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        <div className="px-5 py-4 border-t border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-800/80 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <p className="text-xs font-semibold text-slate-500 dark:text-slate-400">O SISHA registra somente os PNs solicitados e a referência da solicitação. O arquivo Excel gerado não é armazenado.</p>
          <div className="flex gap-2 justify-end">
            <button onClick={onClose} className="px-5 py-2.5 rounded-xl bg-slate-200 dark:bg-slate-700 text-slate-800 dark:text-white font-black hover:bg-slate-300 dark:hover:bg-slate-600">FECHAR</button>
            <button disabled={exporting || loading || rows.length === 0} onClick={handleExport} className="px-5 py-2.5 rounded-xl bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white font-black flex items-center gap-2">
              {exporting ? <LoaderCircle size={17} className="animate-spin" /> : <Download size={17} />} EXPORTAR COTAÇÃO
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
