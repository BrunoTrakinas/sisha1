import React, { useMemo, useState } from 'react';
import { AlertTriangle, LoaderCircle, RefreshCw, Save, X } from 'lucide-react';
import { apiFetch, buildAuthHeaders } from '../lib/api';

export default function ManualTecnicoImportModal({ open, onClose, token, file, preview, onSaved }) {
  const [form, setForm] = useState(() => preview?.metadata || {});
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState(null);
  const [confirmUpgrade, setConfirmUpgrade] = useState(false);
  const [reindexingRag, setReindexingRag] = useState(false);

  React.useEffect(() => {
    if (open) {
      setForm(preview?.metadata || {});
      setMessage(null);
      setConfirmUpgrade(false);
      setReindexingRag(false);
    }
  }, [open, preview]);

  const counts = preview?.summary || {};
  const samplePns = useMemo(() => preview?.samples?.pns || [], [preview]);
  const storage = preview?.storage || {};
  const databaseAdmin = preview?.database_admin || {};
  const upgrade = preview?.upgrade || null;
  const systemReady = Boolean(storage.head_bucket_ok && databaseAdmin.ready);

  if (!open) return null;

  const reindexExistingRag = async () => {
    const duplicate = preview?.duplicate;
    if (!duplicate?.id || reindexingRag) return;
    setReindexingRag(true);
    setMessage(null);
    try {
      const response = await apiFetch(`/manuals/${encodeURIComponent(duplicate.id)}/reindex-rag`, {
        method: 'POST',
        headers: buildAuthHeaders(token),
      }, token);
      const result = await response.json();
      if (!response.ok || result.status !== 'success') {
        const detail = result?.rag?.reason || result?.message || 'Falha ao reprocessar o RAG deste manual.';
        throw new Error(detail);
      }
      const indexed = Number(result?.rag?.indexed || 0);
      const chunks = Number(result?.rag?.chunks || 0);
      setMessage({
        type: 'success',
        text: `${result.message} RAG: ${indexed} documento(s) técnico(s), ${chunks} trecho(s).`,
      });
      onSaved?.({ ...result, reindexed_existing: true });
    } catch (error) {
      setMessage({
        type: 'error',
        text: `O PDF não foi duplicado. A tentativa de reprocessar o RAG falhou: ${error.message || 'falha não detalhada'}`,
      });
    } finally {
      setReindexingRag(false);
    }
  };

  const save = async () => {
    if (!file || !String(form.codigo || '').trim()) return;
    if (upgrade && !confirmUpgrade) {
      setMessage({ type: 'error', text: 'Confirme explicitamente a atualização da revisão/versão antes de salvar.' });
      return;
    }
    setSaving(true);
    setMessage(null);
    try {
      const body = new FormData();
      body.append('file', file);
      body.append('metadata', JSON.stringify({ ...form, confirm_upgrade: Boolean(upgrade && confirmUpgrade) }));
      const response = await apiFetch('/manuals/import', {
        method: 'POST', headers: buildAuthHeaders(token), body,
      }, token);
      const result = await response.json();
      if (!response.ok || !['success', 'success_with_warnings'].includes(result.status)) {
        throw new Error(result.message || 'Falha ao salvar manual técnico.');
      }
      setMessage({ type: result.status === 'success' ? 'success' : 'warning', text: [result.message, ...(result.warnings || [])].filter(Boolean).join(' ') });
      onSaved?.(result);
    } catch (error) {
      setMessage({ type: 'error', text: error.message || 'Falha ao salvar manual técnico.' });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[95] bg-slate-950/70 backdrop-blur-sm flex items-center justify-center p-3 sm:p-6">
      <div className="w-full max-w-6xl max-h-[92vh] overflow-auto rounded-3xl bg-white shadow-2xl border border-slate-200">
        <div className="sticky top-0 bg-white border-b border-slate-200 p-5 flex items-start justify-between gap-4 z-10">
          <div>
            <h3 className="text-xl font-black text-slate-900 uppercase">Revisar WTP / Manual Técnico</h3>
            <p className="text-sm font-bold text-slate-500 mt-1">Nada foi gravado. Confira os dados técnicos antes de incorporar esta publicação ao acervo.</p>
          </div>
          <button onClick={onClose} className="p-2 rounded-xl hover:bg-slate-100 text-slate-500"><X size={20} /></button>
        </div>

        <div className="p-5 space-y-5">
          {preview?.duplicate ? (
            <div className="rounded-xl border border-amber-300 bg-amber-50 p-4 text-sm font-black text-amber-900 space-y-3">
              <div>
                <p>Arquivo idêntico já cadastrado como {preview.duplicate.codigo}. O salvamento continuará bloqueado para evitar duplicidade.</p>
                <p className="text-xs font-bold text-amber-800 mt-1">
                  Se a primeira importação ficou com o RAG pendente, você pode reprocessar somente o RAG do manual já existente. O PDF não será reenviado ao R2 e nenhum novo registro de manual será criado.
                </p>
              </div>
              {preview.duplicate.ativo !== false ? (
                <button
                  type="button"
                  onClick={reindexExistingRag}
                  disabled={reindexingRag}
                  className="inline-flex items-center gap-2 rounded-xl border-2 border-amber-500 bg-white px-4 py-2.5 text-xs font-black text-amber-900 hover:bg-amber-100 disabled:opacity-50"
                >
                  {reindexingRag ? <LoaderCircle size={16} className="animate-spin" /> : <RefreshCw size={16} />}
                  REPROCESSAR RAG DO MANUAL EXISTENTE
                </button>
              ) : (
                <p className="text-xs font-bold text-amber-800">Esta cópia pertence a uma revisão inativa/superada e não será reindexada como vigente.</p>
              )}
            </div>
          ) : null}

          <div className={`rounded-xl border p-4 ${systemReady ? 'border-emerald-200 bg-emerald-50' : 'border-amber-300 bg-amber-50'}`}>
            <p className={`text-xs font-black uppercase ${systemReady ? 'text-emerald-800' : 'text-amber-900'}`}>
              {systemReady ? 'Documento pronto para conferência' : 'Pendência para incorporação ao acervo'}
            </p>
            <p className="text-sm font-bold text-slate-700 mt-1">
              {systemReady
                ? 'Leitura concluída. Confira os dados técnicos abaixo antes de confirmar a incorporação desta publicação.'
                : 'A publicação ainda não pode ser incorporada. Se a condição persistir, acione o administrador do sistema.'}
            </p>
          </div>

          {upgrade ? (
            <div className="rounded-2xl border-2 border-amber-300 bg-amber-50 p-4 space-y-3">
              <div className="flex items-start gap-2">
                <AlertTriangle size={19} className="text-amber-700 mt-0.5" />
                <div>
                  <p className="font-black text-amber-950 uppercase">Atualização de WTP detectada</p>
                  <p className="text-sm font-bold text-amber-900 mt-1">
                    {upgrade.codigo}: revisão/versão atual {upgrade.revisao_atual || 'N/I'} → nova {form.revisao || upgrade.revisao_nova || 'N/I'}.
                  </p>
                  <p className="text-xs font-bold text-amber-800 mt-1">A revisão anterior será preservada no acervo como SUPERADA e continuará disponível para rastreabilidade.</p>
                </div>
              </div>
              <label className="flex items-center gap-2 text-sm font-black text-amber-950 cursor-pointer">
                <input type="checkbox" checked={confirmUpgrade} onChange={(e) => setConfirmUpgrade(e.target.checked)} />
                CONFIRMO QUE ESTE PDF É UMA NOVA REVISÃO/VERSÃO DE {upgrade.codigo}
              </label>
            </div>
          ) : null}

          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            <label className="text-xs font-black text-slate-700 uppercase">Código do manual<input value={form.codigo || ''} onChange={(e) => setForm({ ...form, codigo: e.target.value })} className="mt-1 w-full rounded-xl border-2 border-slate-200 p-3 font-black text-slate-900 uppercase" /></label>
            <label className="text-xs font-black text-slate-700 uppercase">Tipo<input value={form.tipo_manual || 'WTP'} onChange={(e) => setForm({ ...form, tipo_manual: e.target.value })} className="mt-1 w-full rounded-xl border-2 border-slate-200 p-3 font-black text-slate-900 uppercase" /></label>
            <label className="text-xs font-black text-slate-700 uppercase">ATA / DMC<input value={form.ata_dmc || ''} onChange={(e) => setForm({ ...form, ata_dmc: e.target.value })} className="mt-1 w-full rounded-xl border-2 border-slate-200 p-3 font-bold text-slate-900 uppercase" /></label>
            <label className="md:col-span-2 text-xs font-black text-slate-700 uppercase">Título<input value={form.titulo || ''} onChange={(e) => setForm({ ...form, titulo: e.target.value })} className="mt-1 w-full rounded-xl border-2 border-slate-200 p-3 font-bold text-slate-900" /></label>
            <label className="text-xs font-black text-slate-700 uppercase">Fabricante<input value={form.fabricante || ''} onChange={(e) => setForm({ ...form, fabricante: e.target.value })} className="mt-1 w-full rounded-xl border-2 border-slate-200 p-3 font-bold text-slate-900 uppercase" /></label>
            <label className="text-xs font-black text-slate-700 uppercase">Revisão<input value={form.revisao || ''} onChange={(e) => setForm({ ...form, revisao: e.target.value })} className="mt-1 w-full rounded-xl border-2 border-slate-200 p-3 font-bold text-slate-900" /></label>
            <label className="md:col-span-2 text-xs font-black text-slate-700 uppercase">Observações<input value={form.observacoes || ''} onChange={(e) => setForm({ ...form, observacoes: e.target.value })} className="mt-1 w-full rounded-xl border-2 border-slate-200 p-3 font-bold text-slate-900" /></label>
          </div>

          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            {[
              ['Itens / PNs', counts.pns_indexados],
              ['Análise de falhas', counts.falhas_indexadas],
              ['Recursos técnicos', counts.recursos_indexados],
              ['Trechos indexados', counts.trechos_indexados],
            ].map(([label, value]) => (
              <div key={label} className="rounded-2xl border border-blue-100 bg-blue-50 p-4">
                <p className="text-[10px] font-black uppercase text-blue-700">{label}</p>
                <p className="text-2xl font-black text-blue-950">{Number(value || 0)}</p>
              </div>
            ))}
          </div>

          <div className="rounded-2xl border border-slate-200 overflow-hidden bg-white">
            <div className="bg-slate-900 text-white px-4 py-3 text-xs font-black uppercase">Amostra do Detailed Parts List (DPL)</div>
            <div className="overflow-auto max-h-72 bg-white">
              <table className="min-w-full text-xs text-slate-900 bg-white">
                <thead className="bg-slate-100 sticky top-0 text-slate-900">
                  <tr>{['FIG', 'ITEM', 'P/N', 'NOMENCLATURA', 'QTD/CONJ.'].map((h) => <th key={h} className="p-2 text-left font-black text-slate-900 whitespace-nowrap">{h}</th>)}</tr>
                </thead>
                <tbody className="bg-white text-slate-900">
                  {samplePns.length ? samplePns.map((row, idx) => (
                    <tr key={`${row.pn}-${row.item}-${idx}`} className="border-t border-slate-100 bg-white hover:bg-slate-50 text-slate-900">
                      <td className="p-2 font-bold text-slate-900">{row.fig || '1'}</td>
                      <td className="p-2 font-bold text-slate-900">{row.item || '—'}</td>
                      <td className="p-2 font-mono font-black text-slate-950 whitespace-nowrap">{row.pn || '—'}</td>
                      <td className="p-2 font-bold text-slate-900">{row.nomenclatura || row.description || '—'}</td>
                      <td className="p-2 font-black text-slate-900">{row.units_per_assy || row.quantidade_por_conjunto || '—'}</td>
                    </tr>
                  )) : (
                    <tr>
                      <td colSpan="5" className="p-5 text-center font-bold text-slate-600 bg-white">
                        {Number(counts.pns_indexados || 0) > 0
                          ? `${Number(counts.pns_indexados || 0)} item(ns) foram identificados, mas a amostra do DPL não foi carregada nesta prévia. Refaça a leitura antes de confirmar.`
                          : 'Nenhuma linha do DPL foi identificada automaticamente. O manual ainda pode ser revisado antes da incorporação.'}
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>

          {message ? <div className={`rounded-xl p-4 font-bold ${message.type === 'error' ? 'bg-red-50 text-red-700 border border-red-200' : message.type === 'warning' ? 'bg-amber-50 text-amber-800 border border-amber-200' : 'bg-emerald-50 text-emerald-800 border border-emerald-200'}`}>{message.text}</div> : null}
        </div>

        <div className="sticky bottom-0 bg-slate-50 border-t border-slate-200 p-4 flex justify-end gap-2">
          <button onClick={onClose} className="px-5 py-3 rounded-xl font-black text-slate-600 hover:bg-slate-200">CANCELAR</button>
          <button onClick={save} disabled={saving || preview?.duplicate || !storage.head_bucket_ok || !databaseAdmin.ready || !String(form.codigo || '').trim() || Boolean(upgrade && !confirmUpgrade)} className="px-6 py-3 rounded-xl bg-blue-700 hover:bg-blue-800 disabled:opacity-50 text-white font-black flex items-center gap-2">
            {saving ? <LoaderCircle size={17} className="animate-spin" /> : <Save size={17} />} {upgrade ? 'CONFIRMAR NOVA REVISÃO E INDEXAR' : 'CONFIRMAR E INDEXAR'}
          </button>
        </div>
      </div>
    </div>
  );
}
