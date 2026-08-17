import React, { useMemo, useState } from 'react';
import { BrainCircuit, LoaderCircle, X, AlertTriangle, PackageCheck, Wrench, Truck, ShieldCheck } from 'lucide-react';
import { apiFetch } from '../lib/api';
import { useAuth } from '../context/AuthContext';

const numberBr = (value, digits = 2) => {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return '—';
  return Number(value).toLocaleString('pt-BR', { maximumFractionDigits: digits });
};

function Metric({ label, value, subtitle, icon }) {
  return (
    <div className="rounded-2xl border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950/40 p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-[10px] uppercase tracking-[0.16em] font-black text-slate-400">{label}</p>
          <p className="text-xl font-black text-slate-900 dark:text-white mt-1">{value}</p>
          {subtitle ? <p className="text-xs font-semibold text-slate-500 dark:text-slate-400 mt-1">{subtitle}</p> : null}
        </div>
        <div className="p-2 rounded-xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 text-slate-500">{React.createElement(icon, { size: 18 })}</div>
      </div>
    </div>
  );
}

function ActionLabel({ action }) {
  const labels = {
    COMPLETE_EVIDENCE: 'Completar evidências',
    CONFIRM_CEIMSPA: 'Confirmar CeIMSPA',
    EXPEDITE_REPAIR_RETURN: 'Priorizar retorno do reparo',
    CONFIRM_OR_EXPEDITE_PURCHASE_PIPELINE: 'Confirmar / acelerar compra em curso',
    ACQUIRE_OR_REPAIR: 'Adquirir ou recuperar cobertura',
    MONITOR: 'Monitorar',
  };
  return labels[action] || action || '—';
}

export default function LogisticsIntelligenceModal({ open, onClose }) {
  const { token } = useAuth();
  const [pn, setPn] = useState('');
  const [horizon, setHorizon] = useState(90);
  const [flightHours, setFlightHours] = useState('');
  const [cycles, setCycles] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [result, setResult] = useState(null);

  const title = useMemo(() => result?.pn ? `A4 — ${result.pn}` : 'A4 — Inteligência Logística', [result]);
  if (!open) return null;

  const analyze = async () => {
    try {
      setLoading(true);
      setError(null);
      setResult(null);
      const query = new URLSearchParams({
        pn: String(pn || '').trim(),
        horizon_days: String(horizon || 90),
        expected_flight_hours: String(flightHours || 0),
        expected_cycles: String(cycles || 0),
      });
      const response = await apiFetch(`/needs/intelligence/a4?${query.toString()}`, {}, token);
      const json = await response.json();
      if (!response.ok || json.status !== 'success') throw new Error(json.message || 'Falha ao analisar o PN.');
      setResult(json.data);
    } catch (err) {
      setError(err.message || 'Falha ao executar a Inteligência Logística A4.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[80] bg-black/50 flex items-center justify-center p-4">
      <div className="w-full max-w-6xl max-h-[92vh] overflow-hidden rounded-3xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 shadow-2xl flex flex-col">
        <div className="px-6 py-5 border-b border-slate-200 dark:border-slate-800 flex items-start justify-between gap-4">
          <div>
            <h2 className="text-xl font-black text-slate-900 dark:text-white flex items-center gap-2"><BrainCircuit size={20} /> {title}</h2>
            <p className="text-xs font-semibold text-slate-500 dark:text-slate-400 mt-1">Previsão read-only: consumo + A3/MTBF + manutenção programada + estoque + compras + reparos + lead time. Não cria OC, PD ou WO.</p>
          </div>
          <button type="button" onClick={onClose} className="p-2 rounded-xl hover:bg-slate-100 dark:hover:bg-slate-800"><X size={20} /></button>
        </div>

        <div className="overflow-auto p-6 space-y-6">
          <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
            <label className="space-y-1">
              <span className="text-[10px] uppercase tracking-[0.16em] font-black text-slate-400">PN</span>
              <input value={pn} onChange={(e) => setPn(e.target.value)} placeholder="Ex.: WG1234-..." className="w-full px-3 py-2.5 rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 text-sm font-bold" />
            </label>
            <label className="space-y-1">
              <span className="text-[10px] uppercase tracking-[0.16em] font-black text-slate-400">Horizonte</span>
              <select value={horizon} onChange={(e) => setHorizon(Number(e.target.value))} className="w-full px-3 py-2.5 rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 text-sm font-bold">
                <option value={30}>30 dias</option><option value={60}>60 dias</option><option value={90}>90 dias</option><option value={180}>180 dias</option><option value={365}>365 dias</option>
              </select>
            </label>
            <label className="space-y-1">
              <span className="text-[10px] uppercase tracking-[0.16em] font-black text-slate-400">Horas previstas</span>
              <input type="number" min="0" value={flightHours} onChange={(e) => setFlightHours(e.target.value)} placeholder="Opcional" className="w-full px-3 py-2.5 rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 text-sm font-bold" />
            </label>
            <label className="space-y-1">
              <span className="text-[10px] uppercase tracking-[0.16em] font-black text-slate-400">Ciclos previstos</span>
              <input type="number" min="0" value={cycles} onChange={(e) => setCycles(e.target.value)} placeholder="Opcional" className="w-full px-3 py-2.5 rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 text-sm font-bold" />
            </label>
          </div>
          <div className="flex justify-end">
            <button type="button" onClick={analyze} disabled={loading || !String(pn || '').trim()} className="px-5 py-3 rounded-2xl bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white font-black inline-flex items-center gap-2">
              {loading ? <LoaderCircle size={18} className="animate-spin" /> : <BrainCircuit size={18} />} ANALISAR PN
            </button>
          </div>

          {error ? <div className="rounded-2xl border border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-950/30 p-4 text-sm font-bold text-red-700 dark:text-red-300">{error}</div> : null}

          {result ? (
            <>
              <div className={`rounded-2xl border p-4 ${result.status === 'PROJECTED_RUPTURE' ? 'border-amber-300 bg-amber-50 dark:bg-amber-950/20 dark:border-amber-800' : result.status === 'BLOCKED' ? 'border-slate-300 bg-slate-50 dark:bg-slate-950/30 dark:border-slate-700' : 'border-emerald-300 bg-emerald-50 dark:bg-emerald-950/20 dark:border-emerald-800'}`}>
                <p className="text-sm font-black text-slate-900 dark:text-white">{result.answer}</p>
                <p className="text-xs font-semibold text-slate-500 dark:text-slate-400 mt-2">{result.risk?.explanation}</p>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-3">
                <Metric label="Risco de ruptura" value={result.risk?.index_percent == null ? 'BLOQUEADO' : `${numberBr(result.risk.index_percent, 1)}%`} subtitle={result.status} icon={AlertTriangle} />
                <Metric label="Demanda prevista" value={result.demand?.predicted_qty == null ? '—' : `${numberBr(result.demand.predicted_qty)} UN`} subtitle={`${result.horizon_days} dias`} icon={BrainCircuit} />
                <Metric label="PPU confirmado" value={`${numberBr(result.supply?.ppu_confirmed)} UN`} subtitle={`Cobertura confirmada total ${numberBr(result.supply?.confirmed_total)} UN`} icon={PackageCheck} />
                <Metric label="CeIMSPA potencial" value={`${numberBr(result.supply?.ceimspa_potential)} UN`} subtitle="Exige confirmação externa" icon={ShieldCheck} />
                <Metric label="Em reparo" value={`${numberBr(result.supply?.repair_open_units, 0)} UN`} subtitle={`${numberBr(result.supply?.repair_potential_within_horizon, 0)} com previsão no horizonte`} icon={Wrench} />
                <Metric label="Compra comprometida" value={`${numberBr(result.supply?.purchase_committed_within_horizon)} UN`} subtitle={`Pipeline potencial ${numberBr(result.supply?.purchase_potential_within_horizon)} UN`} icon={Truck} />
                <Metric label="Lead time" value={result.procurement?.lead_time?.effective_days == null ? '—' : `${numberBr(result.procurement.lead_time.effective_days, 1)} dias`} subtitle={result.procurement?.lead_time?.source || 'Sem evidência'} icon={Truck} />
                <Metric label="Déficit confirmado" value={result.risk?.shortage_confirmed_qty == null ? '—' : `${numberBr(result.risk.shortage_confirmed_qty)} UN`} subtitle={`Após potenciais: ${numberBr(result.risk?.shortage_after_potential_qty)} UN`} icon={AlertTriangle} />
              </div>

              <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
                <section className="rounded-2xl border border-slate-200 dark:border-slate-800 p-4">
                  <h3 className="font-black text-slate-900 dark:text-white">Composição da demanda</h3>
                  <div className="mt-3 space-y-2 text-sm font-semibold text-slate-600 dark:text-slate-300">
                    <p>Consumo histórico: {result.demand?.consumption?.ready ? `${numberBr(result.demand.consumption.projected_qty)} UN` : `bloqueado (${result.demand?.consumption?.blocker || 'sem evidência'})`}</p>
                    <p>Falhas esperadas por MTBF: {result.demand?.reliability?.ready ? `${numberBr(result.demand.reliability.expected_failures)} UN` : `bloqueado (${result.demand?.reliability?.blocker || 'sem evidência'})`}</p>
                    <p>Manutenção programada no horizonte: {numberBr(result.demand?.scheduled?.projected_qty)} UN</p>
                    <p>Criticidade: {result.criticality?.status || 'UNCONFIRMED'}</p>
                  </div>
                </section>
                <section className="rounded-2xl border border-slate-200 dark:border-slate-800 p-4">
                  <h3 className="font-black text-slate-900 dark:text-white">Ação logística recomendada</h3>
                  <div className="mt-3 space-y-2">
                    {(result.recommendation?.actions || []).map((item, index) => (
                      <div key={`${item.action}-${index}`} className="rounded-xl bg-slate-50 dark:bg-slate-950/40 border border-slate-200 dark:border-slate-800 p-3">
                        <p className="text-sm font-black text-slate-900 dark:text-white">{index + 1}. <ActionLabel action={item.action} />{Number(item.quantity) > 0 ? ` — ${numberBr(item.quantity)} UN` : ''}</p>
                        <p className="text-xs font-semibold text-slate-500 dark:text-slate-400 mt-1">{item.reason}</p>
                      </div>
                    ))}
                  </div>
                </section>
              </div>
            </>
          ) : null}
        </div>
      </div>
    </div>
  );
}
