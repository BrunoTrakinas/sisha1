import React, { useEffect, useState } from 'react';
import { apiFetch } from '../lib/api';

const emptyForm = {
  pn: '',
  pi: '',
  pn_alt: '',
  fonte: 'INSERÇÃO MANUAL SISHA',
  tipo_relacao: 'ALTERNATIVO',
  observacao: '',
  ativo: true,
};

function parseBatch(text = '') {
  return String(text || '')
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .map((line) => {
      const parts = line.includes('\t') ? line.split('\t') : line.split(';');
      return parts.map((part) => String(part || '').trim());
    })
    .filter((parts, index) => {
      if (!parts.length) return false;
      const first = String(parts[0] || '').trim().toUpperCase();
      if (index === 0 && ['PN', 'P/N', 'PART NUMBER'].includes(first)) return false;
      return true;
    })
    .map(([pn, pi, pn_alt, fonte, observacao]) => ({
      pn,
      pi,
      pn_alt,
      fonte: fonte || 'INSERÇÃO MANUAL SISHA',
      observacao: observacao || null,
      tipo_relacao: 'ALTERNATIVO',
    }));
}

export default function PnAlternativosAdmin({ token }) {
  const [q, setQ] = useState('');
  const [includeInactive, setIncludeInactive] = useState(false);
  const [rows, setRows] = useState([]);
  const [form, setForm] = useState(emptyForm);
  const [editingId, setEditingId] = useState(null);
  const [batchText, setBatchText] = useState('');
  const [showBatch, setShowBatch] = useState(false);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState(null);

  const load = async (term = q) => {
    setLoading(true);
    setMessage(null);
    try {
      const params = new URLSearchParams();
      if (term.trim()) params.set('q', term.trim());
      if (includeInactive) params.set('include_inactive', 'true');
      const response = await apiFetch(`/items/alternativos?${params.toString()}`, {}, token);
      const json = await response.json();
      if (!response.ok || json.status !== 'success') throw new Error(json.message || 'Falha ao consultar.');
      setRows(json.data || []);
    } catch (error) {
      setMessage({ type: 'error', text: error.message || 'Falha ao consultar PN alternativos.' });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load('');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [includeInactive]);

  const resetForm = () => {
    setEditingId(null);
    setForm(emptyForm);
  };

  const save = async () => {
    if (!form.pn.trim() || !form.pn_alt.trim()) {
      setMessage({ type: 'error', text: 'Preencha PN e PN alternativo.' });
      return;
    }
    setLoading(true);
    setMessage(null);
    try {
      const endpoint = editingId ? `/items/alternativos/${editingId}` : '/items/alternativos';
      const method = editingId ? 'PUT' : 'POST';
      const response = await apiFetch(endpoint, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(form) }, token);
      const json = await response.json();
      if (!response.ok || json.status !== 'success') throw new Error(json.message || 'Falha ao salvar.');
      setMessage({ type: 'success', text: json.message });
      resetForm();
      await load();
    } catch (error) {
      setMessage({ type: 'error', text: error.message || 'Falha ao salvar PN alternativo.' });
    } finally {
      setLoading(false);
    }
  };

  const edit = (row) => {
    setEditingId(row.id);
    setForm({
      pn: row.pn || '',
      pi: row.pi || '',
      pn_alt: row.pn_alt || '',
      fonte: row.fonte || 'INSERÇÃO MANUAL SISHA',
      tipo_relacao: row.tipo_relacao || 'ALTERNATIVO',
      observacao: row.observacao || '',
      ativo: row.ativo !== false,
    });
    setMessage(null);
  };

  const deactivate = async (row) => {
    const motivo = window.prompt(`Motivo para desativar ${row.pn} ↔ ${row.pn_alt}:`, '') ?? null;
    if (motivo === null) return;
    if (!window.confirm('Confirmar desativação lógica? O histórico será preservado.')) return;
    setLoading(true);
    try {
      const response = await apiFetch(`/items/alternativos/${row.id}`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ motivo }),
      }, token);
      const json = await response.json();
      if (!response.ok || json.status !== 'success') throw new Error(json.message || 'Falha ao desativar.');
      setMessage({ type: 'success', text: json.message });
      await load();
    } catch (error) {
      setMessage({ type: 'error', text: error.message || 'Falha ao desativar.' });
    } finally {
      setLoading(false);
    }
  };

  const saveBatch = async () => {
    const linhas = parseBatch(batchText);
    if (!linhas.length) {
      setMessage({ type: 'error', text: 'Nenhuma linha válida no lote.' });
      return;
    }
    setLoading(true);
    try {
      const response = await apiFetch('/items/alternativos/lote', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ linhas }),
      }, token);
      const json = await response.json();
      if (!response.ok || json.status !== 'success') throw new Error(json.message || 'Falha no lote.');
      setMessage({ type: 'success', text: `${json.message} Duplicadas: ${json.duplicadas || 0}.` });
      setBatchText('');
      setShowBatch(false);
      await load();
    } catch (error) {
      setMessage({ type: 'error', text: error.message || 'Falha ao salvar lote.' });
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="space-y-5">
      <div className="rounded-2xl border border-blue-200 bg-blue-50 p-4 text-sm font-bold text-blue-950">
        CIETP continua automático pela regra <b>mesmo DMC + mesmo ITEM</b>. Este painel mantém somente relações documentais/manuais. Evoluções de fornecimento continuam vinculadas às RFQs e não são convertidas em equivalência bidirecional.
      </div>

      <div className="grid grid-cols-1 md:grid-cols-12 gap-3">
        <input className="md:col-span-7 p-3 border-2 border-slate-200 rounded-xl font-bold text-slate-900" placeholder="Buscar PN, PN alternativo, PI ou fonte" value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') load(); }} />
        <button type="button" onClick={() => load()} disabled={loading} className="md:col-span-2 rounded-xl bg-slate-900 px-4 py-3 font-black text-white disabled:opacity-50">BUSCAR</button>
        <button type="button" onClick={() => setShowBatch((value) => !value)} className="md:col-span-3 rounded-xl bg-purple-700 px-4 py-3 font-black text-white">{showBatch ? 'FECHAR LOTE' : 'INSERÇÃO EM LOTE'}</button>
      </div>

      <label className="flex items-center gap-2 text-sm font-bold text-slate-700">
        <input type="checkbox" checked={includeInactive} onChange={(e) => setIncludeInactive(e.target.checked)} /> Mostrar relações desativadas
      </label>

      {showBatch && (
        <div className="rounded-2xl border border-purple-200 bg-purple-50 p-4 space-y-3">
          <p className="text-sm font-black text-purple-950">Cole diretamente do Excel: PN → PI → PN_ALT → FONTE → OBSERVAÇÃO. Separação por TAB. Máximo 500 linhas.</p>
          <textarea rows={8} className="w-full rounded-xl border-2 border-purple-200 bg-white p-3 font-mono text-sm text-slate-900" value={batchText} onChange={(e) => setBatchText(e.target.value)} placeholder={'PN\tPI\tPN_ALT\tFONTE\tOBSERVAÇÃO'} />
          <div className="flex justify-end"><button type="button" onClick={saveBatch} disabled={loading || !batchText.trim()} className="rounded-xl bg-purple-700 px-5 py-3 font-black text-white disabled:opacity-50">SALVAR LOTE MANUAL</button></div>
        </div>
      )}

      <div className="rounded-2xl border border-slate-200 p-4 space-y-4">
        <div className="flex items-center justify-between gap-3">
          <h4 className="font-black uppercase text-slate-900">{editingId ? 'Editar relação' : 'Inserir relação manual'}</h4>
          {editingId && <button type="button" onClick={resetForm} className="rounded-lg bg-slate-200 px-3 py-2 text-xs font-black text-slate-800">CANCELAR EDIÇÃO</button>}
        </div>
        <div className="grid grid-cols-1 md:grid-cols-12 gap-3">
          <input className="md:col-span-3 p-3 border rounded-xl font-bold uppercase" placeholder="PN" value={form.pn} onChange={(e) => setForm((prev) => ({ ...prev, pn: e.target.value }))} />
          <input className="md:col-span-2 p-3 border rounded-xl font-bold" placeholder="PI / NSN" value={form.pi} onChange={(e) => setForm((prev) => ({ ...prev, pi: e.target.value }))} />
          <input className="md:col-span-3 p-3 border rounded-xl font-bold uppercase" placeholder="PN alternativo" value={form.pn_alt} onChange={(e) => setForm((prev) => ({ ...prev, pn_alt: e.target.value }))} />
          <select className="md:col-span-2 p-3 border rounded-xl bg-white font-bold" value={form.tipo_relacao} onChange={(e) => setForm((prev) => ({ ...prev, tipo_relacao: e.target.value }))}>
            <option value="ALTERNATIVO">Alternativo</option>
            <option value="EQUIVALENTE">Equivalente</option>
          </select>
          <label className="md:col-span-2 flex items-center gap-2 px-3 font-bold text-sm"><input type="checkbox" checked={form.ativo} onChange={(e) => setForm((prev) => ({ ...prev, ativo: e.target.checked }))} /> Ativo</label>
          <input className="md:col-span-5 p-3 border rounded-xl font-bold" placeholder="Fonte / documento" value={form.fonte} onChange={(e) => setForm((prev) => ({ ...prev, fonte: e.target.value }))} />
          <input className="md:col-span-7 p-3 border rounded-xl" placeholder="Observações" value={form.observacao} onChange={(e) => setForm((prev) => ({ ...prev, observacao: e.target.value }))} />
        </div>
        <div className="flex justify-end"><button type="button" onClick={save} disabled={loading} className="rounded-xl bg-blue-600 px-6 py-3 font-black text-white disabled:opacity-50">{editingId ? 'SALVAR ALTERAÇÃO' : 'INSERIR PN ALTERNATIVO'}</button></div>
      </div>

      {message && <div className={`rounded-xl p-3 text-sm font-bold ${message.type === 'error' ? 'bg-red-50 text-red-700 border border-red-200' : 'bg-green-50 text-green-700 border border-green-200'}`}>{message.text}</div>}

      <div className="space-y-3">
        {rows.map((row) => (
          <div key={row.id} className={`rounded-2xl border p-4 ${row.ativo === false ? 'border-slate-200 bg-slate-100 opacity-75' : 'border-slate-200 bg-white'}`}>
            <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-3">
              <div>
                <p className="text-xs font-black uppercase text-slate-500">{row.origem_tipo || 'DOCUMENTO'} • {row.tipo_relacao || 'ALTERNATIVO'} {row.ativo === false ? '• DESATIVADO' : ''}</p>
                <p className="text-lg font-black text-slate-900"><span className="font-mono">{row.pn}</span> ↔ <span className="font-mono">{row.pn_alt}</span></p>
                <p className="text-sm font-bold text-slate-700">PI: {row.pi || 'N/A'} • Fonte: {row.fonte || 'N/A'}</p>
                {row.observacao ? <p className="mt-1 text-sm text-slate-600">{row.observacao}</p> : null}
              </div>
              <div className="flex gap-2">
                <button type="button" onClick={() => edit(row)} className="rounded-xl bg-amber-500 px-4 py-2 text-sm font-black text-white">EDITAR</button>
                {row.ativo !== false && <button type="button" onClick={() => deactivate(row)} className="rounded-xl bg-red-600 px-4 py-2 text-sm font-black text-white">DESATIVAR</button>}
              </div>
            </div>
          </div>
        ))}
        {!loading && rows.length === 0 && <p className="py-6 text-center font-bold text-slate-500">Nenhuma relação encontrada.</p>}
      </div>
    </div>
  );
}
