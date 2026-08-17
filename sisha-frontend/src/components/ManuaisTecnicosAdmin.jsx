import React, { useEffect, useState } from 'react';
import { Download, History, LoaderCircle, Plus, Save, Search, Trash2, X } from 'lucide-react';
import { apiFetch, buildAuthHeaders } from '../lib/api';

const empty = () => ({ codigo: '', tipo_manual: 'WTP', titulo: '', fabricante: '', ata_dmc: '', revisao: '', observacoes: '', pns_principais: [] });

export default function ManuaisTecnicosAdmin({ token }) {
  const [rows, setRows] = useState([]);
  const [q, setQ] = useState('');
  const [loading, setLoading] = useState(false);
  const [form, setForm] = useState(empty());
  const [editingId, setEditingId] = useState(null);
  const [message, setMessage] = useState(null);
  const [batchText, setBatchText] = useState('');
  const [includeInactive, setIncludeInactive] = useState(false);

  const load = async (include = includeInactive) => {
    setLoading(true); setMessage(null);
    try {
      const response = await apiFetch(`/manuals?q=${encodeURIComponent(q)}&include_inactive=${include ? 'true' : 'false'}`, {}, token);
      const result = await response.json();
      if (!response.ok || result.status !== 'success') throw new Error(result.message || 'Falha ao consultar manuais.');
      setRows(result.data || []);
    } catch (error) { setMessage({ type: 'error', text: error.message }); }
    finally { setLoading(false); }
  };

  useEffect(() => { load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const save = async () => {
    setLoading(true); setMessage(null);
    try {
      const endpoint = editingId ? `/manuals/${editingId}` : '/manuals/manual';
      const response = await apiFetch(endpoint, { method: editingId ? 'PUT' : 'POST', headers: buildAuthHeaders(token, { 'Content-Type': 'application/json' }), body: JSON.stringify(form) }, token);
      const result = await response.json();
      if (!response.ok || result.status !== 'success') throw new Error(result.message || 'Falha ao salvar manual.');
      setMessage({ type: 'success', text: result.message }); setForm(empty()); setEditingId(null); await load();
    } catch (error) { setMessage({ type: 'error', text: error.message }); }
    finally { setLoading(false); }
  };

  const deactivate = async (row) => {
    if (!window.confirm(`Desativar ${row.codigo}? O histórico será preservado.`)) return;
    setLoading(true);
    try {
      const response = await apiFetch(`/manuals/${row.id}`, { method: 'DELETE', headers: buildAuthHeaders(token) }, token);
      const result = await response.json();
      if (!response.ok || result.status !== 'success') throw new Error(result.message || 'Falha ao desativar manual.');
      setMessage({ type: 'success', text: result.message }); await load();
    } catch (error) { setMessage({ type: 'error', text: error.message }); }
    finally { setLoading(false); }
  };

  const downloadOriginal = async (row) => {
    setMessage(null);
    try {
      const response = await apiFetch(`/manuals/${row.id}/original`, { headers: buildAuthHeaders(token) }, token);
      if (!response.ok) {
        const payload = await response.json().catch(() => ({}));
        throw new Error(payload.message || 'Falha ao recuperar o PDF privado.');
      }
      const blob = await response.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = row.arquivo_nome || `${row.codigo}.pdf`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      window.URL.revokeObjectURL(url);
    } catch (error) {
      setMessage({ type: 'error', text: error.message || 'Falha ao recuperar o PDF.' });
    }
  };

  const importBatch = async () => {
    const lines = batchText.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    const rowsBatch = lines.map((line) => {
      const [codigo, tipo_manual = 'WTP', titulo = '', fabricante = '', ata_dmc = '', revisao = '', observacoes = '', pns = ''] = line.split(/\t|;/).map((v) => v.trim());
      return { codigo, tipo_manual, titulo, fabricante, ata_dmc, revisao, observacoes, pns_principais: pns.split(/[,|]/).map((value) => value.trim()).filter(Boolean) };
    }).filter((row) => row.codigo);
    if (!rowsBatch.length) return;
    setLoading(true);
    try {
      const response = await apiFetch('/manuals/batch', { method: 'POST', headers: buildAuthHeaders(token, { 'Content-Type': 'application/json' }), body: JSON.stringify({ rows: rowsBatch }) }, token);
      const result = await response.json();
      if (!response.ok || result.status !== 'success') throw new Error(result.message || 'Falha no lote.');
      setBatchText(''); setMessage({ type: 'success', text: result.message }); await load();
    } catch (error) { setMessage({ type: 'error', text: error.message }); }
    finally { setLoading(false); }
  };

  return (
    <div className="space-y-5">
      <div className="flex flex-col md:flex-row gap-2">
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="WTP, título, fabricante, ATA/DMC..." className="flex-1 p-3 rounded-xl border-2 border-slate-200 font-bold" />
        <button onClick={load} className="px-5 py-3 rounded-xl bg-slate-900 text-white font-black flex items-center justify-center gap-2"><Search size={16} /> BUSCAR</button>
        <button onClick={() => { const next = !includeInactive; setIncludeInactive(next); load(next); }} className={`px-4 py-3 rounded-xl font-black flex items-center justify-center gap-2 border ${includeInactive ? 'bg-amber-50 text-amber-800 border-amber-200' : 'bg-white text-slate-600 border-slate-200'}`}><History size={16} /> {includeInactive ? 'OCULTAR HISTÓRICO' : 'VER HISTÓRICO'}</button>
        <button onClick={() => { setEditingId(null); setForm(empty()); }} className="px-5 py-3 rounded-xl bg-blue-700 text-white font-black flex items-center justify-center gap-2"><Plus size={16} /> NOVO</button>
      </div>

      <div className="rounded-2xl border border-slate-200 p-4 space-y-3">
        <p className="text-xs font-black uppercase text-slate-600">Cadastro manual / correção de metadados</p>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-2">
          <input placeholder="Código ex. WTP113E-014" value={form.codigo} onChange={(e) => setForm({ ...form, codigo: e.target.value })} className="p-2.5 rounded-lg border border-slate-200 font-black uppercase" />
          <input placeholder="Tipo" value={form.tipo_manual} onChange={(e) => setForm({ ...form, tipo_manual: e.target.value })} className="p-2.5 rounded-lg border border-slate-200 font-bold uppercase" />
          <input placeholder="ATA / DMC" value={form.ata_dmc} onChange={(e) => setForm({ ...form, ata_dmc: e.target.value })} className="p-2.5 rounded-lg border border-slate-200 font-bold" />
          <input placeholder="Título" value={form.titulo} onChange={(e) => setForm({ ...form, titulo: e.target.value })} className="p-2.5 rounded-lg border border-slate-200 font-bold md:col-span-2" />
          <input placeholder="Fabricante" value={form.fabricante} onChange={(e) => setForm({ ...form, fabricante: e.target.value })} className="p-2.5 rounded-lg border border-slate-200 font-bold" />
          <input placeholder="Revisão" value={form.revisao} onChange={(e) => setForm({ ...form, revisao: e.target.value })} className="p-2.5 rounded-lg border border-slate-200 font-bold" />
          <input placeholder="PNs principais separados por vírgula" value={(form.pns_principais || []).join(', ')} onChange={(e) => setForm({ ...form, pns_principais: e.target.value.split(',').map((value) => value.trim()).filter(Boolean) })} className="p-2.5 rounded-lg border border-slate-200 font-bold md:col-span-2" />
          <input placeholder="Observações" value={form.observacoes} onChange={(e) => setForm({ ...form, observacoes: e.target.value })} className="p-2.5 rounded-lg border border-slate-200 font-bold" />
        </div>
        <div className="flex justify-end gap-2">
          {editingId ? <button onClick={() => { setEditingId(null); setForm(empty()); }} className="px-4 py-2 rounded-lg font-black text-slate-600 flex items-center gap-1"><X size={15} /> CANCELAR</button> : null}
          <button disabled={loading || !form.codigo.trim()} onClick={save} className="px-5 py-2.5 rounded-xl bg-blue-700 text-white font-black disabled:opacity-50 flex items-center gap-2"><Save size={16} /> {editingId ? 'SALVAR EDIÇÃO' : 'INSERIR MANUAL'}</button>
        </div>
      </div>

      <div className="rounded-2xl border border-slate-200 p-4 space-y-2">
        <p className="text-xs font-black uppercase text-slate-600">Inserção em lote de metadados</p>
        <p className="text-xs font-bold text-slate-500">Uma linha por manual: CODIGO ; TIPO ; TITULO ; FABRICANTE ; ATA/DMC ; REVISAO ; OBSERVACOES ; PNS PRINCIPAIS (separe PNs por vírgula)</p>
        <textarea value={batchText} onChange={(e) => setBatchText(e.target.value)} rows={4} className="w-full rounded-xl border border-slate-200 p-3 font-mono text-xs" placeholder="WTP113E-014;WTP;FUEL PUMPS;SAFRAN AEROTECHNICS;28-21-51;Jan 26/21;...;203666,203837" />
        <div className="flex justify-end"><button disabled={loading || !batchText.trim()} onClick={importBatch} className="px-5 py-2.5 rounded-xl bg-slate-800 text-white font-black disabled:opacity-50">INSERIR LOTE</button></div>
      </div>

      {message ? <div className={`rounded-xl p-3 font-bold ${message.type === 'error' ? 'bg-red-50 text-red-700' : 'bg-emerald-50 text-emerald-800'}`}>{message.text}</div> : null}

      <div className="space-y-2 max-h-80 overflow-auto">
        {loading && !rows.length ? <div className="p-5 flex items-center justify-center gap-2 font-black text-slate-500"><LoaderCircle size={17} className="animate-spin" /> CARREGANDO...</div> : null}
        {rows.map((row) => (
          <div key={row.id} className="rounded-xl border border-slate-200 p-3 bg-slate-50 flex flex-col md:flex-row md:items-center md:justify-between gap-3">
            <div><p className="font-black text-slate-900">{row.codigo} <span className="text-xs text-blue-700">{row.tipo_manual}</span> <span className={`text-[10px] font-black px-2 py-0.5 rounded-full ${row.revision_status === 'SUPERADA' ? 'bg-amber-100 text-amber-800' : row.ativo === false ? 'bg-slate-200 text-slate-700' : 'bg-emerald-100 text-emerald-800'}`}>{row.revision_status || (row.ativo === false ? 'INATIVA' : 'VIGENTE')}</span></p><p className="text-xs font-bold text-slate-600">{row.titulo || 'Sem título'} • {row.fabricante || 'Fabricante N/I'} • ATA/DMC {row.ata_dmc || 'N/I'} • Revisão {row.revisao || 'N/I'}</p><p className="text-[11px] font-bold text-slate-500">Storage: {row.storage_status || 'N/I'} {row.arquivo_nome ? `• ${row.arquivo_nome}` : ''}</p>{(row.pns_principais || []).length ? <p className="text-[11px] font-bold text-slate-500">PNs principais: {(row.pns_principais || []).join(', ')}</p> : null}</div>
            <div className="flex flex-wrap gap-2">{row.r2_key && row.storage_status === 'R2_PRIVATE' ? <button onClick={() => downloadOriginal(row)} className="px-3 py-2 rounded-lg bg-blue-50 border border-blue-200 text-blue-700 font-black text-xs flex items-center gap-1"><Download size={14} /> PDF</button> : null}<button onClick={() => { setEditingId(row.id); setForm({ ...empty(), ...row }); }} className="px-3 py-2 rounded-lg bg-white border border-slate-200 font-black text-xs">EDITAR</button>{row.ativo !== false ? <button onClick={() => deactivate(row)} className="px-3 py-2 rounded-lg bg-red-50 border border-red-200 text-red-700 font-black text-xs flex items-center gap-1"><Trash2 size={14} /> DESATIVAR</button> : null}</div>
          </div>
        ))}
      </div>
    </div>
  );
}
