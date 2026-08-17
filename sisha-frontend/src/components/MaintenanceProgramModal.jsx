import React, { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, CheckCircle2, LoaderCircle, Save, X } from 'lucide-react';
import { apiFetch } from '../lib/api';

const inputClass = 'w-full px-3 py-2.5 rounded-xl border-2 border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-900 dark:text-white font-bold outline-none focus:border-blue-500';
const labelClass = 'block text-[10px] font-black uppercase tracking-wider text-slate-500 dark:text-slate-400 mb-1';

const emptyForm = (row = null) => ({
  aircraft_code: row?.aircraft_code || '',
  indicator_key: row?.indicator_key || '',
  source_cell: row?.source_cell || '',
  pn: row?.binding?.pn || '',
  sn: row?.binding?.sn || '',
  quantidade: row?.binding?.quantidade || 1,
  maintenance_action: row?.binding?.maintenance_action || 'OVERHAUL',
  planning_enabled: row?.binding?.planning_enabled !== false,
  confirmation_reason: '',
});

const statusTone = (status) => status === 'OVERDUE'
  ? 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300'
  : status === 'PLANNED'
    ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300'
    : 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300';

function triggerLabel(row) {
  if (row?.trigger?.due_date) return `Vence em ${row.trigger.due_date}`;
  if (row?.trigger?.value !== null && row?.trigger?.value !== undefined && Number.isFinite(Number(row.trigger.value))) return `${row.trigger.value} ${row.trigger.unit || ''} restantes`;
  return row?.value_type || 'Sem gatilho utilizável';
}

export default function MaintenanceProgramModal({ token, onClose }) {
  const [data, setData] = useState({ rows: [], scheduled_needs: [], summary: {} });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [editingKey, setEditingKey] = useState(null);
  const [form, setForm] = useState(emptyForm());

  const load = async () => {
    setLoading(true);
    setError('');
    try {
      const response = await apiFetch('/needs/maintenance-program', {}, token);
      const json = await response.json();
      if (!response.ok || json.status !== 'success') throw new Error(json.message || 'Falha ao carregar programa de manutenção.');
      setData(json.data || { rows: [], scheduled_needs: [], summary: {} });
    } catch (err) {
      setError(err.message || 'Falha ao carregar programa de manutenção.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const grouped = useMemo(() => {
    const map = new Map();
    (data.rows || []).forEach((row) => {
      if (!map.has(row.aircraft_code)) map.set(row.aircraft_code, []);
      map.get(row.aircraft_code).push(row);
    });
    return Array.from(map.entries());
  }, [data.rows]);

  const edit = (row) => {
    setEditingKey(`${row.aircraft_code}|${row.indicator_key}|${row.source_cell}`);
    setForm(emptyForm(row));
    setError('');
  };

  const save = async () => {
    try {
      setSaving(true);
      setError('');
      const response = await apiFetch('/needs/maintenance-program/binding', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(form),
      }, token);
      const json = await response.json();
      if (!response.ok || json.status !== 'success') throw new Error(json.message || 'Falha ao confirmar vínculo.');
      setEditingKey(null);
      setForm(emptyForm());
      await load();
    } catch (err) {
      setError(err.message || 'Falha ao confirmar vínculo.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[100] bg-slate-950/60 backdrop-blur-sm flex items-center justify-center p-4">
      <div className="w-full max-w-6xl max-h-[92vh] overflow-hidden rounded-3xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 shadow-2xl flex flex-col">
        <div className="px-6 py-5 border-b border-slate-200 dark:border-slate-800 flex items-start justify-between gap-4">
          <div>
            <h3 className="text-lg font-black uppercase text-slate-900 dark:text-white">A1.2 • Programa TBO / horas / ciclos</h3>
            <p className="mt-1 text-xs font-bold text-slate-500 dark:text-slate-400">O indicador técnico só vira necessidade programada depois de Admin/Dono confirmar o PN ou PN+SN. Nenhum vínculo é inferido.</p>
          </div>
          <button onClick={onClose} className="p-2 rounded-xl bg-slate-100 dark:bg-slate-800"><X size={18} /></button>
        </div>

        <div className="px-6 py-4 border-b border-slate-200 dark:border-slate-800 grid grid-cols-2 md:grid-cols-5 gap-3">
          {[['Indicadores', data.summary?.indicators], ['Vinculados', data.summary?.bound], ['Programados', data.summary?.planned], ['Vencidos', data.summary?.overdue], ['Bloqueados', data.summary?.blocked]].map(([label, value]) => (
            <div key={label} className="rounded-2xl bg-slate-50 dark:bg-slate-800 px-4 py-3"><p className="text-[9px] font-black uppercase tracking-wider text-slate-400">{label}</p><p className="text-xl font-black">{Number(value || 0)}</p></div>
          ))}
        </div>

        {error ? <div className="mx-6 mt-4 rounded-2xl bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-900 px-4 py-3 text-sm font-bold text-red-700 dark:text-red-300">{error}</div> : null}

        <div className="flex-1 overflow-auto p-6 space-y-5">
          {loading ? <div className="py-12 text-center font-bold text-slate-400"><LoaderCircle className="inline animate-spin mr-2" size={18} />Carregando...</div> : null}
          {!loading && grouped.length === 0 ? <div className="py-12 text-center font-bold text-slate-400">Nenhum indicador técnico atual encontrado.</div> : null}

          {grouped.map(([aircraft, rows]) => (
            <section key={aircraft} className="rounded-2xl border border-slate-200 dark:border-slate-800 overflow-hidden">
              <div className="px-4 py-3 bg-slate-50 dark:bg-slate-800 font-black">Aeronave {aircraft}</div>
              <div className="divide-y divide-slate-200 dark:divide-slate-800">
                {rows.map((row) => {
                  const key = `${row.aircraft_code}|${row.indicator_key}|${row.source_cell}`;
                  const editing = editingKey === key;
                  return (
                    <div key={key} className="p-4 space-y-3">
                      <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-3">
                        <div className="min-w-0">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="font-black text-sm">{row.label}</span>
                            <span className={`text-[10px] font-black px-2 py-1 rounded-lg ${statusTone(row.planning_status)}`}>{row.planning_status}</span>
                            <span className="text-[10px] font-bold text-slate-400">{row.source_cell}</span>
                          </div>
                          <p className="text-xs font-bold text-slate-500 mt-1">{triggerLabel(row)} • {row.source_document || 'fonte técnica'}</p>
                          <p className="text-xs font-bold mt-1">{row.binding ? `Vínculo atual: PN ${row.binding.pn}${row.binding.sn ? ` • SN ${row.binding.sn}` : ''} • ${row.binding.maintenance_action}` : `Bloqueador: ${row.blocker || 'BINDING_REQUIRED'}`}</p>
                        </div>
                        <button onClick={() => edit(row)} className="px-4 py-2 rounded-xl bg-blue-600 text-white font-black text-xs">{row.binding ? 'Revisar vínculo' : 'Vincular PN/SN'}</button>
                      </div>

                      {editing ? (
                        <div className="rounded-2xl bg-slate-50 dark:bg-slate-800 p-4 grid grid-cols-1 md:grid-cols-3 gap-3">
                          <div><label className={labelClass}>PN *</label><input className={inputClass} value={form.pn} onChange={(e) => setForm((v) => ({ ...v, pn: e.target.value }))} /></div>
                          <div><label className={labelClass}>SN — opcional</label><input className={inputClass} value={form.sn} onChange={(e) => setForm((v) => ({ ...v, sn: e.target.value }))} placeholder="Se informado, PN+SN deve existir no Livro" /></div>
                          <div><label className={labelClass}>Quantidade *</label><input type="number" min="0.01" step="0.01" className={inputClass} value={form.quantidade} onChange={(e) => setForm((v) => ({ ...v, quantidade: e.target.value }))} /></div>
                          <div><label className={labelClass}>Ação</label><select className={inputClass} value={form.maintenance_action} onChange={(e) => setForm((v) => ({ ...v, maintenance_action: e.target.value }))}><option value="OVERHAUL">Overhaul</option><option value="REPAIR">Reparo</option><option value="REPLACEMENT">Substituição</option><option value="INSPECTION">Inspeção</option><option value="OTHER">Outro</option></select></div>
                          <label className="flex items-center gap-2 rounded-xl border border-slate-200 dark:border-slate-700 px-3 py-2.5 font-bold text-sm"><input type="checkbox" checked={form.planning_enabled} onChange={(e) => setForm((v) => ({ ...v, planning_enabled: e.target.checked }))} /> Habilitar no planejamento</label>
                          <div className="md:col-span-3"><label className={labelClass}>Motivo da vinculação *</label><textarea className={`${inputClass} min-h-20`} value={form.confirmation_reason} onChange={(e) => setForm((v) => ({ ...v, confirmation_reason: e.target.value }))} placeholder="Ex.: TBO do componente PN X instalado/previsto nesta posição, conforme documentação conferida." /></div>
                          <div className="md:col-span-3 flex justify-end gap-2"><button onClick={() => setEditingKey(null)} className="px-4 py-2 rounded-xl bg-slate-200 dark:bg-slate-700 font-black text-sm">Cancelar</button><button onClick={save} disabled={saving} className="px-5 py-2 rounded-xl bg-emerald-600 text-white font-black text-sm inline-flex items-center gap-2 disabled:opacity-60">{saving ? <LoaderCircle size={16} className="animate-spin" /> : <Save size={16} />} Confirmar</button></div>
                        </div>
                      ) : null}
                    </div>
                  );
                })}
              </div>
            </section>
          ))}

          <div className="rounded-2xl border border-amber-200 dark:border-amber-800 bg-amber-50 dark:bg-amber-900/20 p-4 text-xs font-bold text-amber-800 dark:text-amber-300 flex gap-2"><AlertTriangle size={17} className="shrink-0" />Horas/ciclos do LIVRO DOS MOTORES são evidência de utilização; não substituem o indicador de TBO. WO/TAT também não vira MTTR automaticamente.</div>
          {(data.scheduled_needs || []).length ? <div className="rounded-2xl border border-emerald-200 dark:border-emerald-800 bg-emerald-50 dark:bg-emerald-900/20 p-4 text-xs font-bold text-emerald-800 dark:text-emerald-300 flex gap-2"><CheckCircle2 size={17} className="shrink-0" />{data.scheduled_needs.length} necessidade(s) programada(s) estão aptas a entrar no Gerador quando a fonte “manutenção programada” for selecionada.</div> : null}
        </div>
      </div>
    </div>
  );
}
