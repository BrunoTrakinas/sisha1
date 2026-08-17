import React, { useEffect, useMemo, useState } from 'react';
import { CheckCircle2, ChevronDown, ChevronUp, RefreshCw, Save } from 'lucide-react';
import { apiFetch } from '../lib/api';

const STATE_OPTIONS = [
  ['AVAILABLE', 'Disponível'],
  ['UNAVAILABLE', 'Indisponível'],
  ['PRESERVED', 'Preservada / inoperante'],
  ['IN_INSPECTION', 'Em inspeção / PROGEM'],
  ['IN_MODERNIZATION', 'Em modernização'],
  ['WAITING_MATERIAL', 'Aguardando material'],
  ['OUT_OF_OPERATIONAL_FLEET', 'Fora da frota operacional'],
  ['TO_CONFIRM', 'A confirmar'],
];

const stateLabel = (value) => STATE_OPTIONS.find(([key]) => key === value)?.[1] || value || 'A confirmar';

const roleLabel = (value) => String(value || '').toLowerCase() === 'dono' ? 'Dono' : String(value || '').toLowerCase() === 'admin' ? 'Admin' : value || 'Administração';

function formatConfirmedAt(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleString('pt-BR');
}

function RowEditor({ row, token, onSaved }) {
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState(null);
  const [form, setForm] = useState({
    operational_state: row.operational_state || 'TO_CONFIRM',
    operational_location: row.operational_location || '',
    admin_note: row.admin_note || '',
    confirmation_reason: '',
    mt_additive_eligible: row.has_admin_confirmation ? row.mt_additive_eligible === true : false,
    flight_projection_enabled: row.has_admin_confirmation ? row.flight_projection_enabled !== false : row.raw_status === 'D',
  });

  useEffect(() => {
    setForm({
      operational_state: row.operational_state || 'TO_CONFIRM',
      operational_location: row.operational_location || '',
      admin_note: row.admin_note || '',
      confirmation_reason: '',
      mt_additive_eligible: row.has_admin_confirmation ? row.mt_additive_eligible === true : false,
      flight_projection_enabled: row.has_admin_confirmation ? row.flight_projection_enabled !== false : row.raw_status === 'D',
    });
  }, [row]);

  const changeOperationalState = (value) => {
    const noFlight = ['PRESERVED', 'IN_INSPECTION', 'IN_MODERNIZATION', 'WAITING_MATERIAL', 'OUT_OF_OPERATIONAL_FLEET', 'TO_CONFIRM'].includes(value);
    setForm((prev) => ({
      ...prev,
      operational_state: value,
      mt_additive_eligible: value === 'WAITING_MATERIAL' ? true : (value === 'UNAVAILABLE' ? prev.mt_additive_eligible : false),
      flight_projection_enabled: value === 'AVAILABLE' ? true : (noFlight ? false : prev.flight_projection_enabled),
    }));
  };

  const save = async () => {
    if (!form.confirmation_reason.trim() || form.confirmation_reason.trim().length < 5) {
      setMessage({ type: 'error', text: 'Informe o motivo da confirmação administrativa.' });
      return;
    }
    setSaving(true);
    setMessage(null);
    try {
      const response = await apiFetch(`/needs/aircraft-operational-state/${row.aircraft_code}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(form),
      }, token);
      const result = await response.json();
      if (!response.ok || result.status !== 'success') throw new Error(result.message || 'Falha ao confirmar estado.');
      setMessage({ type: 'success', text: result.message });
      setOpen(false);
      await onSaved();
    } catch (error) {
      setMessage({ type: 'error', text: error.message || 'Falha ao confirmar estado.' });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-950/40 overflow-hidden">
      <button type="button" onClick={() => setOpen((value) => !value)} className="w-full p-4 text-left hover:bg-slate-50 dark:hover:bg-slate-900/70 transition-colors">
        <div className="flex items-center justify-between gap-4">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-black text-slate-900 dark:text-white text-lg">{row.aircraft_code}</span>
              <span className={`rounded-full px-2.5 py-1 text-[10px] font-black uppercase ${row.raw_status === 'I' ? 'bg-red-100 text-red-700 dark:bg-red-950/40 dark:text-red-300' : row.raw_status === 'D' ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300' : 'bg-amber-100 text-amber-700 dark:bg-amber-950/40 dark:text-amber-300'}`}>
                Fonte: {row.raw_status || 'UNKNOWN'}
              </span>
              {row.has_admin_confirmation && (
                <span className="rounded-full bg-blue-100 dark:bg-blue-950/40 px-2.5 py-1 text-[10px] font-black uppercase text-blue-700 dark:text-blue-300">Confirmado</span>
              )}
            </div>
            <p className="mt-1 font-black text-sm text-slate-800 dark:text-slate-200">{stateLabel(row.operational_state)}</p>
            <p className="mt-1 text-xs font-bold text-slate-500 dark:text-slate-400">
              Fonte bruta: {row.raw_reason || 'sem motivo informado'}{row.source_document ? ` • ${row.source_document}` : ''}
            </p>
            {row.has_admin_confirmation && row.confirmed_by && (
              <p className="mt-1 text-xs font-bold text-blue-700 dark:text-blue-300">
                Confirmação administrativa: {roleLabel(row.confirmed_role)} • {row.confirmed_by}{row.confirmed_at ? ` • ${formatConfirmedAt(row.confirmed_at)}` : ''}
              </p>
            )}
            {row.operational_location && <p className="mt-1 text-xs font-bold text-slate-600 dark:text-slate-300">Local: {row.operational_location}</p>}
            {row.admin_note && <p className="mt-1 text-xs font-bold text-slate-600 dark:text-slate-300">Obs.: {row.admin_note}</p>}
          </div>
          {open ? <ChevronUp size={20} /> : <ChevronDown size={20} />}
        </div>
      </button>

      {open && (
        <div className="border-t border-slate-200 dark:border-slate-800 p-4 space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <label className="text-xs font-black text-slate-700 dark:text-slate-300">
              ESTADO ADMINISTRATIVO
              <select value={form.operational_state} onChange={(e) => changeOperationalState(e.target.value)} className="mt-1 w-full rounded-xl border-2 border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 p-3 font-bold text-slate-900 dark:text-white">
                {STATE_OPTIONS.map(([key, label]) => <option key={key} value={key}>{label}</option>)}
              </select>
            </label>
            <label className="text-xs font-black text-slate-700 dark:text-slate-300">
              LOCAL / FASE
              <input value={form.operational_location} onChange={(e) => setForm((prev) => ({ ...prev, operational_location: e.target.value }))} placeholder="Ex.: PROGEM; Leonardo — Yeovil" className="mt-1 w-full rounded-xl border-2 border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 p-3 font-bold text-slate-900 dark:text-white" />
            </label>
          </div>

          <label className="block text-xs font-black text-slate-700 dark:text-slate-300">
            OBSERVAÇÃO OPERACIONAL
            <textarea value={form.admin_note} onChange={(e) => setForm((prev) => ({ ...prev, admin_note: e.target.value }))} rows={2} className="mt-1 w-full rounded-xl border-2 border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 p-3 font-bold text-slate-900 dark:text-white" />
          </label>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <label className="flex items-start gap-3 rounded-xl border border-slate-200 dark:border-slate-800 p-3 text-sm font-bold text-slate-700 dark:text-slate-300">
              <input type="checkbox" checked={form.mt_additive_eligible} onChange={(e) => setForm((prev) => ({ ...prev, mt_additive_eligible: e.target.checked }))} className="mt-1" />
              <span><strong className="block text-slate-900 dark:text-white">Necessidade de material</strong>Permite que MT correlata seja demanda adicional no Gerador.</span>
            </label>
            <label className="flex items-start gap-3 rounded-xl border border-slate-200 dark:border-slate-800 p-3 text-sm font-bold text-slate-700 dark:text-slate-300">
              <input type="checkbox" checked={form.flight_projection_enabled} onChange={(e) => setForm((prev) => ({ ...prev, flight_projection_enabled: e.target.checked }))} className="mt-1" />
              <span><strong className="block text-slate-900 dark:text-white">Projetar utilização futura</strong>Deixe desmarcado para aeronave preservada/fora da linha de voo.</span>
            </label>
          </div>

          <label className="block text-xs font-black text-slate-700 dark:text-slate-300">
            MOTIVO DA CONFIRMAÇÃO *
            <input value={form.confirmation_reason} onChange={(e) => setForm((prev) => ({ ...prev, confirmation_reason: e.target.value }))} placeholder="Ex.: confirmado pelo Planejamento em 14/08/2026" className="mt-1 w-full rounded-xl border-2 border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 p-3 font-bold text-slate-900 dark:text-white" />
          </label>

          {message && <p className={`text-sm font-black ${message.type === 'success' ? 'text-emerald-600' : 'text-red-600'}`}>{message.text}</p>}
          <div className="flex justify-end">
            <button type="button" onClick={save} disabled={saving} className="inline-flex items-center gap-2 rounded-xl bg-blue-600 px-5 py-3 text-sm font-black text-white hover:bg-blue-700 disabled:opacity-50">
              <Save size={16} /> {saving ? 'SALVANDO...' : 'CONFIRMAR ESTADO'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

export default function AircraftOperationalStateAdmin({ token }) {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const load = async () => {
    if (!token) return;
    setLoading(true);
    setError(null);
    try {
      const response = await apiFetch('/needs/aircraft-operational-state/current', {}, token);
      const result = await response.json();
      if (!response.ok || result.status !== 'success') throw new Error(result.message || 'Falha ao carregar frota.');
      setRows(result.data || []);
    } catch (err) {
      setError(err.message || 'Falha ao carregar frota.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [token]);

  const pending = useMemo(() => rows.filter((row) => !row.has_admin_confirmation).length, [rows]);

  return (
    <section className="mb-6 rounded-3xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-6 shadow-sm">
      <div className="flex flex-col md:flex-row md:items-start md:justify-between gap-4">
        <div>
          <h2 className="text-xl font-black uppercase text-slate-900 dark:text-white">Estado operacional da frota</h2>
          <p className="mt-1 text-sm font-bold text-slate-600 dark:text-slate-300">A planilha permanece como evidência bruta. Admin/Dono confirma situações que exigem interpretação humana sem apagar a fonte original.</p>
          <p className="mt-2 text-xs font-black text-amber-700 dark:text-amber-300">{pending} aeronave(s) ainda sem confirmação administrativa.</p>
        </div>
        <button type="button" onClick={load} disabled={loading} className="inline-flex items-center justify-center gap-2 rounded-xl bg-slate-900 dark:bg-slate-700 px-4 py-3 text-xs font-black text-white disabled:opacity-50">
          <RefreshCw size={15} className={loading ? 'animate-spin' : ''} /> ATUALIZAR
        </button>
      </div>

      {error && <p className="mt-4 rounded-xl bg-red-50 dark:bg-red-950/30 p-3 text-sm font-black text-red-700 dark:text-red-300">{error}</p>}
      {!error && rows.length === 0 && !loading && <p className="mt-4 text-sm font-bold text-slate-500">Nenhuma evidência de disponibilidade importada ainda.</p>}

      <div className="mt-5 grid grid-cols-1 gap-3">
        {rows.map((row) => <RowEditor key={row.aircraft_code} row={row} token={token} onSaved={load} />)}
      </div>

      <div className="mt-4 flex items-start gap-2 rounded-xl bg-emerald-50 dark:bg-emerald-950/30 p-3 text-xs font-bold text-emerald-800 dark:text-emerald-300">
        <CheckCircle2 size={16} className="mt-0.5 shrink-0" />
        Cada confirmação gera uma nova linha histórica com usuário, data, motivo e snapshot documental usado como base. Nenhuma confirmação anterior é sobrescrita.
      </div>
    </section>
  );
}
