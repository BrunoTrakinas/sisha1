import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Activity, AlertTriangle, CheckCircle2, RefreshCcw, Search, ShieldCheck, X } from 'lucide-react';
import { apiFetch } from '../lib/api';

const inputClass = 'w-full px-3 py-2.5 rounded-xl border-2 border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-900 dark:text-white font-bold outline-none focus:border-blue-500';
const labelClass = 'block text-[10px] font-black uppercase tracking-wider text-slate-500 dark:text-slate-400 mb-1';

const BLOCKERS = {
  HOURS_COUNTER_INTERVAL_REQUIRED: 'Sem intervalo A2 com contador em horas.',
  USAGE_HOURS_COVERAGE_INCOMPLETE: 'Há intervalos em horas sem leitura de utilização confirmada.',
  CONFIRMED_FAILURE_REQUIRED: 'Ainda não existe falha técnica efetiva confirmada no recorte.',
  UNSCHEDULED_REMOVAL_REQUIRED: 'Ainda não existe remoção não programada no recorte.',
  POSITIVE_UTILIZATION_REQUIRED: 'Utilização positiva é necessária.',
  CYCLE_COUNTER_INTERVAL_REQUIRED: 'Sem intervalo A2 com contador em ciclos.',
  USAGE_CYCLES_COVERAGE_INCOMPLETE: 'Há intervalos em ciclos sem leitura confirmada.',
  TECHNICAL_RESULT_COVERAGE_INCOMPLETE: 'Há remoções não programadas sem resultado técnico final confirmado.',
  REPAIRED_CYCLE_REQUIRED: 'Nenhum ciclo reparado confirmado.',
  EXPLICIT_REPAIR_CLOCK_COVERAGE_INCOMPLETE: 'Falta início/fim técnico de reparo em ciclo reparado.',
  AVAILABLE_AT_COVERAGE_INCOMPLETE: 'Falta confirmar quando algum equipamento ficou novamente disponível.',
  RETURNABLE_CYCLE_REQUIRED: 'Os ciclos finalizados no recorte são irreparáveis; não há retorno à disponibilidade para calcular TAT.',
};

function fmt(value, digits = 1) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '—';
  return n.toLocaleString('pt-BR', { maximumFractionDigits: digits, minimumFractionDigits: digits });
}

function fmtDate(value) {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString('pt-BR');
}

function isoToLocalInput(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
  return local.toISOString().slice(0, 16);
}

function localInputToIso(value) {
  if (!value) return '';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toISOString();
}

function operationId() {
  if (globalThis?.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (char) => {
    const value = Math.floor(Math.random() * 16);
    return (char === 'x' ? value : (value & 0x3) | 0x8).toString(16);
  });
}

async function readJson(response) {
  const json = await response.json().catch(() => ({}));
  if (!response.ok || json.status !== 'success') throw new Error(json.message || 'Falha no A3.');
  return json;
}

function MetricCard({ title, ready, value, suffix, blocker, detail }) {
  return <div className="rounded-2xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 p-4">
    <p className="text-[10px] font-black uppercase tracking-wider text-slate-400">{title}</p>
    <p className={`mt-1 text-2xl font-black ${ready ? 'text-slate-900 dark:text-white' : 'text-amber-600 dark:text-amber-300'}`}>{ready ? `${value}${suffix || ''}` : 'A CONFIRMAR'}</p>
    <p className="mt-1 text-[11px] font-bold text-slate-500 dark:text-slate-400">{ready ? detail : (BLOCKERS[blocker] || blocker || 'Evidência insuficiente.')}</p>
  </div>;
}

function emptyConfirmation() {
  return {
    usage_start_value: '', usage_end_value: '', technical_result: '',
    repair_started_at: '', repair_completed_at: '', available_at: '',
    repairer: '', manufacturer: '', source_document: '', confirmation_reason: '',
  };
}

export default function ReliabilityAnalysisModal({ token, onClose }) {
  const [filters, setFilters] = useState({ pn: '', sn: '', aircraft: '', from: '', to: '' });
  const [data, setData] = useState({ summary: null, cycles: [], meta: null });
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [selectedId, setSelectedId] = useState('');
  const [form, setForm] = useState(emptyConfirmation());
  const [breakdown, setBreakdown] = useState('by_pn');

  const load = useCallback(async () => {
    setLoading(true); setError(''); setNotice('');
    try {
      const params = new URLSearchParams();
      Object.entries(filters).forEach(([key, value]) => { if (String(value || '').trim()) params.set(key, value); });
      const response = await apiFetch(`/equipments/reliability?${params.toString()}`, {}, token);
      const json = await readJson(response);
      setData(json.data || { summary: null, cycles: [] });
    } catch (err) {
      setError(err.message || 'Falha ao calcular confiabilidade.');
    } finally { setLoading(false); }
  }, [filters, token]);

  useEffect(() => { load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const selected = useMemo(() => (data.cycles || []).find((row) => String(row.interval_id) === String(selectedId)) || null, [data.cycles, selectedId]);
  const summary = data.summary || {};

  const selectCycle = (cycle) => {
    setSelectedId(String(cycle.interval_id));
    const usage = cycle.official_usage || cycle.usage_suggestion || {};
    const evidence = cycle.evidence_suggestion || {};
    setForm({
      usage_start_value: usage.start_value ?? '',
      usage_end_value: usage.end_value ?? '',
      technical_result: cycle.technical_result || evidence.technical_result || '',
      repair_started_at: isoToLocalInput(cycle.repair_started_at),
      repair_completed_at: isoToLocalInput(cycle.repair_completed_at),
      available_at: isoToLocalInput(cycle.available_at),
      repairer: cycle.repairer || evidence.repairer || '',
      manufacturer: cycle.manufacturer || evidence.manufacturer || '',
      source_document: cycle.source_document || '',
      confirmation_reason: '',
    });
    setError(''); setNotice('');
  };

  const confirm = async () => {
    if (!selected) return;
    setSaving(true); setError(''); setNotice('');
    try {
      const response = await apiFetch('/equipments/reliability/confirm', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          interval_id: selected.interval_id,
          ...form,
          repair_started_at: localInputToIso(form.repair_started_at),
          repair_completed_at: localInputToIso(form.repair_completed_at),
          available_at: localInputToIso(form.available_at),
          operation_id: operationId(),
        }),
      }, token);
      const json = await readJson(response);
      setNotice(json.message || 'Evidência confirmada.');
      await load();
    } catch (err) {
      setError(err.message || 'Falha ao confirmar ciclo.');
    } finally { setSaving(false); }
  };

  const breakdownRows = summary?.breakdowns?.[breakdown] || [];

  return <div className="fixed inset-0 z-[95] bg-black/70 backdrop-blur-sm flex items-center justify-center p-3 sm:p-5">
    <div className="w-full max-w-7xl max-h-[95vh] bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-700 rounded-3xl shadow-2xl flex flex-col overflow-hidden">
      <div className="px-5 py-4 bg-white dark:bg-slate-900 border-b border-slate-200 dark:border-slate-700 flex items-start justify-between gap-4">
        <div><h3 className="font-black uppercase tracking-tight text-slate-900 dark:text-white flex items-center gap-2"><Activity size={19} /> A3 — Motor de Confiabilidade</h3><p className="text-xs text-slate-500 mt-1">MTBF, MTBUR, MTTR técnico, TAT, NFF e repeat removal. Sem previsão de ruptura ou recomendação de compra/reparo nesta etapa.</p></div>
        <button onClick={onClose} className="p-2 rounded-xl bg-slate-100 dark:bg-slate-800" aria-label="Fechar"><X size={18} /></button>
      </div>

      <div className="p-5 flex-1 overflow-auto space-y-5">
        {error ? <div className="rounded-2xl bg-red-50 border border-red-200 text-red-700 p-3 text-sm font-bold">{error}</div> : null}
        {notice ? <div className="rounded-2xl bg-emerald-50 border border-emerald-200 text-emerald-700 p-3 text-sm font-bold">{notice}</div> : null}

        <div className="rounded-2xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 p-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-6 gap-2">
            <input className={inputClass} placeholder="PN" value={filters.pn} onChange={(e) => setFilters((v) => ({ ...v, pn: e.target.value }))} />
            <input className={inputClass} placeholder="SN" value={filters.sn} onChange={(e) => setFilters((v) => ({ ...v, sn: e.target.value }))} />
            <input className={inputClass} placeholder="Aeronave" value={filters.aircraft} onChange={(e) => setFilters((v) => ({ ...v, aircraft: e.target.value }))} />
            <input type="date" className={inputClass} value={filters.from} onChange={(e) => setFilters((v) => ({ ...v, from: e.target.value }))} />
            <input type="date" className={inputClass} value={filters.to} onChange={(e) => setFilters((v) => ({ ...v, to: e.target.value }))} />
            <button onClick={load} disabled={loading} className="rounded-xl bg-blue-600 text-white font-black inline-flex items-center justify-center gap-2"><Search size={16} />{loading ? 'CALCULANDO...' : 'CALCULAR'}</button>
          </div>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-3">
          <MetricCard title="MTBF" ready={summary.mtbf?.ready} value={fmt(summary.mtbf?.value_hours)} suffix=" h" blocker={summary.mtbf?.blocker} detail={`${summary.mtbf?.failures || 0} falha(s) efetiva(s)`} />
          <MetricCard title="MTBUR" ready={summary.mtbur?.ready} value={fmt(summary.mtbur?.value_hours)} suffix=" h" blocker={summary.mtbur?.blocker} detail={`${summary.mtbur?.unscheduled_removals || 0} remoção(ões) não programada(s)`} />
          <MetricCard title="Falhas / 1000 h" ready={summary.failures_per_1000_hours?.ready} value={fmt(summary.failures_per_1000_hours?.value, 2)} suffix="" blocker={summary.failures_per_1000_hours?.blocker} detail="Taxa de falhas efetivas por exposição confirmada" />
          <MetricCard title="MTTR técnico" ready={summary.mttr?.ready} value={fmt(summary.mttr?.value_hours)} suffix=" h" blocker={summary.mttr?.blocker} detail="Início efetivo → reparo concluído" />
          <MetricCard title="TAT" ready={summary.tat?.ready} value={fmt(summary.tat?.value_hours)} suffix=" h" blocker={summary.tat?.blocker} detail="Remoção → disponível novamente" />
          <MetricCard title="NFF" ready={summary.nff?.ready} value={fmt(summary.nff?.rate_percent)} suffix="%" blocker={summary.nff?.blocker} detail={`${summary.nff?.count || 0} NFF`} />
          <MetricCard title="Repeat removal" ready={summary.repeat_removal?.ready} value={String(summary.repeat_removal?.count || 0)} suffix="" blocker={summary.repeat_removal?.blocker} detail="Nova remoção não programada do mesmo SN" />
        </div>

        <div className="grid grid-cols-1 xl:grid-cols-5 gap-4">
          <div className="xl:col-span-3 rounded-2xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 overflow-hidden">
            <div className="px-4 py-3 border-b border-slate-200 dark:border-slate-700 flex items-center justify-between gap-3"><div><p className="font-black uppercase text-sm">Ciclos A2 encerrados</p><p className="text-xs text-slate-500">{data.cycles?.length || 0} ciclo(s) no recorte</p></div><button onClick={load} className="p-2 rounded-xl bg-slate-100 dark:bg-slate-800"><RefreshCcw size={16} /></button></div>
            <div className="max-h-[48vh] overflow-auto divide-y divide-slate-100 dark:divide-slate-800">
              {(data.cycles || []).map((cycle) => <button type="button" onClick={() => selectCycle(cycle)} key={cycle.interval_id} className={`w-full text-left p-4 hover:bg-slate-50 dark:hover:bg-slate-800/60 ${String(selectedId) === String(cycle.interval_id) ? 'bg-blue-50 dark:bg-blue-900/20' : ''}`}>
                <div className="flex flex-wrap items-center justify-between gap-2"><p className="font-black">{cycle.pn} / SN {cycle.sn}</p><div className="flex gap-1">{cycle.unscheduled_removal ? <span className="px-2 py-1 rounded-lg bg-amber-100 text-amber-700 text-[10px] font-black">NÃO PROGRAMADA</span> : <span className="px-2 py-1 rounded-lg bg-slate-100 text-slate-600 text-[10px] font-black">PRONTO USO</span>}{cycle.repeat_removal ? <span className="px-2 py-1 rounded-lg bg-red-100 text-red-700 text-[10px] font-black">REPEAT</span> : null}</div></div>
                <p className="text-xs font-bold text-slate-500 mt-1">ANV {cycle.aircraft_code} • {cycle.position_code} • {cycle.removal_reason || '—'} • removido {fmtDate(cycle.removed_at)}</p>
                <p className="text-xs mt-1 text-slate-500">Utilização: {cycle.official_usage ? `${fmt(cycle.official_usage.delta)} ${cycle.official_usage.unit}` : cycle.usage_suggestion ? `sugestão ${fmt(cycle.usage_suggestion.delta)} ${cycle.usage_suggestion.unit}` : 'a confirmar'} • Resultado: {cycle.technical_result || 'a confirmar'}</p>
              </button>)}
              {!loading && !(data.cycles || []).length ? <p className="p-6 text-sm font-bold text-slate-400 text-center">Nenhum ciclo A2 encerrado no recorte.</p> : null}
            </div>
          </div>

          <div className="xl:col-span-2 rounded-2xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 p-4">
            {!selected ? <div className="h-full min-h-64 flex items-center justify-center text-center text-sm font-bold text-slate-400">Selecione um ciclo para revisar/confirmar a evidência A3.</div> : <div className="space-y-4">
              <div><p className="font-black text-sm">{selected.pn} / SN {selected.sn}</p><p className="text-xs text-slate-500 mt-1">Aeronave {selected.aircraft_code} • {selected.position_code}</p></div>
              {selected.usage_suggestion && !selected.official_usage ? <div className="rounded-xl bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-900 p-3 text-xs font-bold text-blue-800 dark:text-blue-300">Livro dos Motores sugere {fmt(selected.usage_suggestion.start_value)} → {fmt(selected.usage_suggestion.end_value)} ({fmt(selected.usage_suggestion.delta)} {selected.usage_suggestion.unit}). É somente sugestão até você confirmar.</div> : null}
              {selected.evidence_suggestion?.external_return_at ? <div className="rounded-xl bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-900 p-3 text-xs font-bold text-amber-800 dark:text-amber-300">WO evidencia retorno externo em {fmtDate(selected.evidence_suggestion.external_return_at)}. Retorno não significa automaticamente “disponível”; confirme abaixo somente se houver evidência.</div> : null}

              <div className="grid grid-cols-2 gap-2"><div><label className={labelClass}>Leitura inicial</label><input type="number" step="any" className={inputClass} value={form.usage_start_value} onChange={(e) => setForm((v) => ({ ...v, usage_start_value: e.target.value }))} /></div><div><label className={labelClass}>Leitura final</label><input type="number" step="any" className={inputClass} value={form.usage_end_value} onChange={(e) => setForm((v) => ({ ...v, usage_end_value: e.target.value }))} /></div></div>
              <div><label className={labelClass}>Resultado técnico</label><select className={inputClass} value={form.technical_result} onChange={(e) => setForm((v) => ({ ...v, technical_result: e.target.value }))}><option value="">A confirmar</option><option value="REPAIRED">Reparado</option><option value="NFF">NFF — No Fault Found</option><option value="IRREPARABLE">Irreparável</option></select></div>
              <div className="grid grid-cols-2 gap-2"><div><label className={labelClass}>Início técnico do reparo</label><input type="datetime-local" className={inputClass} value={form.repair_started_at} onChange={(e) => setForm((v) => ({ ...v, repair_started_at: e.target.value }))} /></div><div><label className={labelClass}>Reparo concluído</label><input type="datetime-local" className={inputClass} value={form.repair_completed_at} onChange={(e) => setForm((v) => ({ ...v, repair_completed_at: e.target.value }))} /></div></div>
              <div><label className={labelClass}>Disponível novamente</label><input type="datetime-local" className={inputClass} value={form.available_at} onChange={(e) => setForm((v) => ({ ...v, available_at: e.target.value }))} /></div>
              <div className="grid grid-cols-2 gap-2"><div><label className={labelClass}>Reparador</label><input className={inputClass} value={form.repairer} onChange={(e) => setForm((v) => ({ ...v, repairer: e.target.value }))} /></div><div><label className={labelClass}>Fabricante</label><input className={inputClass} value={form.manufacturer} onChange={(e) => setForm((v) => ({ ...v, manufacturer: e.target.value }))} /></div></div>
              <div><label className={labelClass}>Documento / evidência</label><input className={inputClass} value={form.source_document} onChange={(e) => setForm((v) => ({ ...v, source_document: e.target.value }))} placeholder="WO / relatório / inspeção / outra evidência" /></div>
              <div><label className={labelClass}>Motivo da confirmação *</label><textarea className={`${inputClass} min-h-20`} value={form.confirmation_reason} onChange={(e) => setForm((v) => ({ ...v, confirmation_reason: e.target.value }))} placeholder="Explique a evidência usada. O histórico anterior não será apagado." /></div>
              <button onClick={confirm} disabled={saving || form.confirmation_reason.trim().length < 5} className="w-full rounded-xl bg-blue-600 text-white py-3 font-black disabled:opacity-50 inline-flex items-center justify-center gap-2"><ShieldCheck size={16} />{saving ? 'CONFIRMANDO...' : 'CONFIRMAR EVIDÊNCIA A3'}</button>
            </div>}
          </div>
        </div>

        <div className="rounded-2xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 p-4">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-3"><div><p className="font-black uppercase text-sm">Confiabilidade por dimensão</p><p className="text-xs text-slate-500">PN, SN, aeronave, reparador e fabricante usam as mesmas regras de cobertura.</p></div><select className={`${inputClass} sm:w-56`} value={breakdown} onChange={(e) => setBreakdown(e.target.value)}><option value="by_pn">Por PN</option><option value="by_sn">Por PN + SN</option><option value="by_aircraft">Por aeronave</option><option value="by_repairer">Por reparador</option><option value="by_manufacturer">Por fabricante</option></select></div>
          <div className="overflow-auto"><table className="w-full text-xs"><thead><tr className="text-left text-slate-400 uppercase"><th className="py-2 pr-3">Grupo</th><th className="py-2 pr-3">Ciclos</th><th className="py-2 pr-3">MTBF</th><th className="py-2 pr-3">MTBUR</th><th className="py-2 pr-3">MTTR</th><th className="py-2 pr-3">TAT</th><th className="py-2">NFF</th></tr></thead><tbody>{breakdownRows.slice(0, 100).map((row) => <tr key={row.key} className="border-t border-slate-100 dark:border-slate-800"><td className="py-2 pr-3 font-black">{row.key}</td><td className="py-2 pr-3">{row.rows.length}</td><td className="py-2 pr-3">{row.summary.mtbf.ready ? `${fmt(row.summary.mtbf.value_hours)} h` : '—'}</td><td className="py-2 pr-3">{row.summary.mtbur.ready ? `${fmt(row.summary.mtbur.value_hours)} h` : '—'}</td><td className="py-2 pr-3">{row.summary.mttr.ready ? `${fmt(row.summary.mttr.value_hours)} h` : '—'}</td><td className="py-2 pr-3">{row.summary.tat.ready ? `${fmt(row.summary.tat.value_hours)} h` : '—'}</td><td className="py-2">{row.summary.nff.ready ? `${fmt(row.summary.nff.rate_percent)}%` : '—'}</td></tr>)}</tbody></table></div>
        </div>

        <div className="rounded-2xl border border-amber-200 bg-amber-50 dark:bg-amber-900/10 dark:border-amber-900 p-4 text-xs font-bold text-amber-900 dark:text-amber-200 flex gap-2"><AlertTriangle size={16} className="shrink-0" /><span><strong>Regra A3:</strong> retorno de WO não é MTTR e não prova sozinho que o item ficou disponível. MTTR técnico e TAT possuem relógios diferentes. Previsão logística permanece fora deste patch.</span></div>
      </div>

      <div className="px-5 py-4 bg-white dark:bg-slate-900 border-t border-slate-200 dark:border-slate-700 flex justify-between gap-3"><div className="text-xs font-bold text-slate-500 flex items-center gap-2"><CheckCircle2 size={14} />Cálculos oficiais usam apenas evidência confirmada.</div><button onClick={onClose} className="px-5 py-2.5 rounded-xl bg-slate-200 dark:bg-slate-700 font-black">Fechar</button></div>
    </div>
  </div>;
}
