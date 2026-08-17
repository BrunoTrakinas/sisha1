import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertTriangle, CheckCircle2, Search, Wrench, X } from 'lucide-react';
import { apiFetch } from '../lib/api';

const inputClass = 'w-full px-3 py-2.5 rounded-xl border-2 border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-900 dark:text-white font-bold outline-none focus:border-blue-500';
const labelClass = 'block text-[10px] font-black uppercase tracking-wider text-slate-500 dark:text-slate-400 mb-1';

const COUNTERS = [
  ['HORAS_DE_VOO', 'Horas de voo da aeronave'],
  ['MOTOR_1', 'Horas do Motor 1'],
  ['MOTOR_2', 'Horas do Motor 2'],
  ['CICLOS', 'Ciclos / acionamentos'],
  ['CALENDARIO', 'Calendário'],
];

const CYCLE_METRICS = [
  ['landings', 'Pousos'],
  ['rotor_stop_starts', 'Rotor stop/start'],
  ['engine_1_starts', 'Starts Motor 1'],
  ['engine_1_power_turbine_cycles', 'Ciclos turbina de potência Motor 1'],
  ['engine_1_gas_generator_cycles', 'Ciclos gerador de gás Motor 1'],
  ['engine_2_starts', 'Starts Motor 2'],
  ['engine_2_power_turbine_cycles', 'Ciclos turbina de potência Motor 2'],
  ['engine_2_gas_generator_cycles', 'Ciclos gerador de gás Motor 2'],
];

const DESTINATIONS = [
  ['DESCONHECIDO', 'A confirmar / desconhecido'],
  ['PPU', 'PPU'],
  ['OFICINA', 'Oficina do Esquadrão'],
  ['RECEX', 'RECEX'],
  ['GANM', 'GANM'],
  ['WO_EXTERIOR', 'WO / reparo exterior'],
  ['REPARO_EXTERNO', 'Reparo externo / Leonardo'],
  ['GARANTIA', 'Garantia / fabricante'],
  ['TRANSITO', 'Em trânsito'],
  ['DESFAZIMENTO', 'Desfazimento'],
];

function localDateTime() {
  const date = new Date();
  const pad = (value) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function localInputToIso(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  const date = new Date(text);
  if (Number.isNaN(date.getTime())) return text;
  return date.toISOString();
}

function operationId() {
  if (globalThis?.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (char) => {
    const value = Math.floor(Math.random() * 16);
    const out = char === 'x' ? value : (value & 0x3) | 0x8;
    return out.toString(16);
  });
}

async function readJson(response) {
  const json = await response.json().catch(() => ({}));
  if (!response.ok || json.status !== 'success') throw new Error(json.message || 'Falha na operação A2.');
  return json;
}

function equipmentLabel(item) {
  return `${item.pn || 'PN?'} / SN ${item.sn || '?'}${item.nomenclatura ? ` — ${item.nomenclatura}` : ''}`;
}

export default function EquipmentOperationsModal({ token, onClose, onChanged }) {
  const [tab, setTab] = useState('INSTALL');
  const [pn, setPn] = useState('');
  const [candidates, setCandidates] = useState([]);
  const [installations, setInstallations] = useState([]);
  const [pendingTests, setPendingTests] = useState([]);
  const [selectedId, setSelectedId] = useState('');
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const [installForm, setInstallForm] = useState({
    aircraft_code: '', position_code: '', usage_counter: 'HORAS_DE_VOO', usage_metric: 'aircraft_hours',
    installed_at: localDateTime(), document: '', observation: '',
  });
  const [removeForm, setRemoveForm] = useState({
    removal_reason: 'PANE', removed_at: localDateTime(), destination_category: 'DESCONHECIDO',
    destination_location: '', document: '', observation: '',
  });
  const [testForm, setTestForm] = useState({
    test_result: 'APROVADO', result_at: localDateTime(), destination_category: 'DESCONHECIDO',
    destination_location: '', document: '', observation: '',
  });

  const loadPendingTests = useCallback(async () => {
    const response = await apiFetch('/equipments/operations/pending-tests', {}, token);
    const json = await readJson(response);
    setPendingTests(json.data || []);
  }, [token]);

  const search = useCallback(async () => {
    setError('');
    setNotice('');
    setSelectedId('');
    setLoading(true);
    try {
      if (tab === 'TEST') {
        await loadPendingTests();
        return;
      }
      if (pn.trim().length < 2) {
        setCandidates([]);
        setInstallations([]);
        throw new Error('Digite ao menos 2 caracteres do PN.');
      }
      if (tab === 'INSTALL') {
        const response = await apiFetch(`/equipments/operations/candidates?mode=INSTALL&pn=${encodeURIComponent(pn.trim())}`, {}, token);
        const json = await readJson(response);
        setCandidates(json.data || []);
      } else {
        const response = await apiFetch(`/equipments/operations/installations?pn=${encodeURIComponent(pn.trim())}`, {}, token);
        const json = await readJson(response);
        setInstallations(json.data || []);
      }
    } catch (err) {
      setError(err.message || 'Falha ao consultar PN+SN.');
    } finally {
      setLoading(false);
    }
  }, [loadPendingTests, pn, tab, token]);

  useEffect(() => {
    setError('');
    setNotice('');
    setSelectedId('');
    setCandidates([]);
    setInstallations([]);
    if (tab === 'TEST') {
      setLoading(true);
      loadPendingTests().catch((err) => setError(err.message || 'Falha ao consultar testes.')).finally(() => setLoading(false));
    }
  }, [loadPendingTests, tab]);

  const selected = useMemo(() => {
    if (tab === 'INSTALL') return candidates.find((item) => String(item.id) === String(selectedId));
    if (tab === 'REMOVE') return installations.find((item) => String(item.equipment_id) === String(selectedId));
    return pendingTests.find((item) => String(item.id) === String(selectedId));
  }, [candidates, installations, pendingTests, selectedId, tab]);

  const submit = async () => {
    setSaving(true);
    setError('');
    setNotice('');
    try {
      let path;
      let body;
      if (tab === 'INSTALL') {
        if (!selected) throw new Error('Selecione o PN+SN a instalar.');
        if (!installForm.aircraft_code.trim() || !installForm.position_code.trim()) throw new Error('Informe aeronave e posição.');
        path = '/equipments/operations/install';
        body = { equipment_id: selected.id, ...installForm, installed_at: localInputToIso(installForm.installed_at), operation_id: operationId() };
      } else if (tab === 'REMOVE') {
        if (!selected) throw new Error('Selecione o PN+SN instalado.');
        path = '/equipments/operations/remove';
        body = { equipment_id: selected.equipment_id, ...removeForm, removed_at: localInputToIso(removeForm.removed_at), operation_id: operationId() };
      } else {
        if (!selected) throw new Error('Selecione um TESTE pendente.');
        path = '/equipments/operations/test-result';
        body = { interval_id: selected.id, ...testForm, result_at: localInputToIso(testForm.result_at), operation_id: operationId() };
      }
      const response = await apiFetch(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }, token);
      const json = await readJson(response);
      setNotice(json.message || 'Operação registrada.');
      setSelectedId('');
      if (tab === 'TEST') await loadPendingTests();
      else await search();
      onChanged?.();
    } catch (err) {
      setError(err.message || 'Falha ao registrar operação.');
    } finally {
      setSaving(false);
    }
  };

  const rows = tab === 'INSTALL' ? candidates : tab === 'REMOVE' ? installations : pendingTests;

  return (
    <div className="fixed inset-0 z-[90] bg-black/70 backdrop-blur-sm flex items-center justify-center p-3 sm:p-5">
      <div className="w-full max-w-5xl max-h-[94vh] bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-3xl shadow-2xl flex flex-col overflow-hidden">
        <div className="px-5 py-4 border-b border-slate-200 dark:border-slate-700 flex items-start justify-between gap-4">
          <div>
            <h3 className="font-black uppercase tracking-tight text-slate-900 dark:text-white">A2 — Instalar / Remover PN+SN</h3>
            <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">Fluxo guiado e auditável. Não substitui OS/PIM e não calcula MTBF/MTTR nesta etapa.</p>
          </div>
          <button onClick={onClose} className="p-2 rounded-xl bg-slate-100 dark:bg-slate-800" aria-label="Fechar"><X size={18} /></button>
        </div>

        <div className="p-5 flex-1 overflow-auto space-y-5">
          <div className="flex flex-wrap gap-2">
            {[['INSTALL','Instalar'],['REMOVE','Remover'],['TEST','Testes pendentes']].map(([key,label]) => (
              <button key={key} onClick={() => setTab(key)} className={`px-4 py-2.5 rounded-xl text-sm font-black ${tab === key ? 'bg-blue-600 text-white' : 'bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-200'}`}>{label}</button>
            ))}
          </div>

          {tab !== 'TEST' ? (
            <form onSubmit={(event) => { event.preventDefault(); search(); }} className="flex flex-col sm:flex-row gap-2">
              <div className="relative flex-1"><Search size={17} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" /><input className={`${inputClass} pl-10`} value={pn} onChange={(event) => setPn(event.target.value)} placeholder="Digite o PN" /></div>
              <button disabled={loading} className="px-4 py-2.5 rounded-xl bg-slate-800 text-white font-black disabled:opacity-50">{loading ? 'BUSCANDO...' : 'BUSCAR PN+SN'}</button>
            </form>
          ) : null}

          {error ? <div className="rounded-2xl border border-red-200 bg-red-50 dark:bg-red-900/20 dark:border-red-900 p-3 text-sm font-bold text-red-700 dark:text-red-300">{error}</div> : null}
          {notice ? <div className="rounded-2xl border border-emerald-200 bg-emerald-50 dark:bg-emerald-900/20 dark:border-emerald-900 p-3 text-sm font-bold text-emerald-700 dark:text-emerald-300">{notice}</div> : null}

          <div className="grid grid-cols-1 lg:grid-cols-5 gap-4">
            <div className="lg:col-span-2 rounded-2xl border border-slate-200 dark:border-slate-700 overflow-hidden">
              <div className="px-4 py-3 bg-slate-50 dark:bg-slate-800 border-b border-slate-200 dark:border-slate-700 text-xs font-black uppercase text-slate-500">
                {tab === 'INSTALL' ? 'SN disponíveis' : tab === 'REMOVE' ? 'Instalações abertas' : 'Testes pendentes'} ({rows.length})
              </div>
              <div className="max-h-[48vh] overflow-auto p-2 space-y-2">
                {!loading && rows.length === 0 ? <p className="p-4 text-sm font-bold text-slate-400">Nenhum registro encontrado.</p> : null}
                {rows.map((item) => {
                  const key = tab === 'INSTALL' ? item.id : tab === 'REMOVE' ? item.equipment_id : item.id;
                  return <button type="button" key={`${tab}-${key}`} onClick={() => setSelectedId(String(key))} className={`w-full text-left rounded-xl border p-3 ${String(selectedId) === String(key) ? 'border-blue-500 bg-blue-50 dark:bg-blue-900/20' : 'border-slate-200 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800'}`}>
                    <p className="font-black text-sm">{equipmentLabel(item)}</p>
                    {tab === 'INSTALL' ? <p className="text-xs font-bold text-slate-500 mt-1">Atual: {item.local_atual || item.categoria_local_atual || 'local a confirmar'}</p> : null}
                    {tab === 'REMOVE' ? <p className="text-xs font-bold text-slate-500 mt-1">ANV {item.aircraft_code} • {item.position_code} • {item.usage_counter}</p> : null}
                    {tab === 'TEST' ? <p className="text-xs font-bold text-slate-500 mt-1">Removido da ANV {item.aircraft_code} • {item.position_code}</p> : null}
                  </button>;
                })}
              </div>
            </div>

            <div className="lg:col-span-3 space-y-4">
              {!selected ? <div className="rounded-2xl border border-dashed border-slate-300 dark:border-slate-700 p-8 text-center text-sm font-bold text-slate-400">Selecione um PN+SN para continuar.</div> : null}

              {selected && tab === 'INSTALL' ? <>
                <div className="rounded-2xl bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-900 p-4 text-sm font-bold text-blue-800 dark:text-blue-300">Instalação abre um intervalo operacional e vincula este PN+SN a um contador auditável do A1.</div>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  <div><label className={labelClass}>Aeronave *</label><input className={inputClass} value={installForm.aircraft_code} onChange={(e) => setInstallForm((v) => ({ ...v, aircraft_code: e.target.value }))} placeholder="4005" /></div>
                  <div><label className={labelClass}>Posição *</label><input className={inputClass} value={installForm.position_code} onChange={(e) => setInstallForm((v) => ({ ...v, position_code: e.target.value }))} placeholder="Ex.: BOOSTER PUMP LH" /></div>
                  <div><label className={labelClass}>Contador *</label><select className={inputClass} value={installForm.usage_counter} onChange={(e) => setInstallForm((v) => ({ ...v, usage_counter: e.target.value, usage_metric: e.target.value === 'CICLOS' ? 'landings' : '' }))}>{COUNTERS.map(([k,l]) => <option key={k} value={k}>{l}</option>)}</select></div>
                  {installForm.usage_counter === 'CICLOS' ? <div><label className={labelClass}>Métrica de ciclos *</label><select className={inputClass} value={installForm.usage_metric} onChange={(e) => setInstallForm((v) => ({ ...v, usage_metric: e.target.value }))}>{CYCLE_METRICS.map(([k,l]) => <option key={k} value={k}>{l}</option>)}</select></div> : null}
                  <div><label className={labelClass}>Data/hora *</label><input type="datetime-local" className={inputClass} value={installForm.installed_at} onChange={(e) => setInstallForm((v) => ({ ...v, installed_at: e.target.value }))} /></div>
                  <div><label className={labelClass}>Documento</label><input className={inputClass} value={installForm.document} onChange={(e) => setInstallForm((v) => ({ ...v, document: e.target.value }))} placeholder="OS / PIM / referência" /></div>
                  <div className="md:col-span-2"><label className={labelClass}>Observação</label><textarea className={`${inputClass} min-h-20`} value={installForm.observation} onChange={(e) => setInstallForm((v) => ({ ...v, observation: e.target.value }))} /></div>
                </div>
              </> : null}

              {selected && tab === 'REMOVE' ? <>
                <div className="rounded-2xl border border-amber-200 bg-amber-50 dark:bg-amber-900/20 dark:border-amber-900 p-4 text-sm font-bold text-amber-900 dark:text-amber-200 space-y-1">
                  <p><strong>PANE:</strong> confirma falha.</p><p><strong>TESTE:</strong> não conta como falha até APROVADO/REPROVADO.</p><p><strong>PRONTO USO:</strong> fecha a instalação sem falha.</p>
                </div>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  <div><label className={labelClass}>Motivo *</label><select className={inputClass} value={removeForm.removal_reason} onChange={(e) => setRemoveForm((v) => ({ ...v, removal_reason: e.target.value }))}><option value="PANE">PANE</option><option value="TESTE">TESTE</option><option value="PRONTO_USO">PRONTO USO</option></select></div>
                  <div><label className={labelClass}>Data/hora *</label><input type="datetime-local" className={inputClass} value={removeForm.removed_at} onChange={(e) => setRemoveForm((v) => ({ ...v, removed_at: e.target.value }))} /></div>
                  <div><label className={labelClass}>Destino conhecido?</label><select className={inputClass} value={removeForm.destination_category} onChange={(e) => setRemoveForm((v) => ({ ...v, destination_category: e.target.value }))}>{DESTINATIONS.map(([k,l]) => <option key={k} value={k}>{l}</option>)}</select></div>
                  <div><label className={labelClass}>Local físico</label><input className={inputClass} value={removeForm.destination_location} onChange={(e) => setRemoveForm((v) => ({ ...v, destination_location: e.target.value }))} placeholder="Deixe vazio se ainda não souber" /></div>
                  <div><label className={labelClass}>Documento</label><input className={inputClass} value={removeForm.document} onChange={(e) => setRemoveForm((v) => ({ ...v, document: e.target.value }))} /></div>
                  <div className="md:col-span-2"><label className={labelClass}>Observação</label><textarea className={`${inputClass} min-h-20`} value={removeForm.observation} onChange={(e) => setRemoveForm((v) => ({ ...v, observation: e.target.value }))} /></div>
                </div>
                {removeForm.destination_category === 'DESCONHECIDO' ? <p className="text-xs font-black text-amber-700 dark:text-amber-300">Sem destino confiável, o SISHA mantém “a confirmar”. Nunca envia automaticamente para o PPU.</p> : null}
              </> : null}

              {selected && tab === 'TEST' ? <>
                <div className="rounded-2xl border border-violet-200 bg-violet-50 dark:bg-violet-900/20 dark:border-violet-900 p-4 text-sm font-bold text-violet-900 dark:text-violet-200">APROVADO não caracteriza falha. REPROVADO confirma a falha com data efetiva da remoção original.</div>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  <div><label className={labelClass}>Resultado *</label><select className={inputClass} value={testForm.test_result} onChange={(e) => setTestForm((v) => ({ ...v, test_result: e.target.value }))}><option value="APROVADO">APROVADO</option><option value="REPROVADO">REPROVADO</option></select></div>
                  <div><label className={labelClass}>Data/hora do resultado *</label><input type="datetime-local" className={inputClass} value={testForm.result_at} onChange={(e) => setTestForm((v) => ({ ...v, result_at: e.target.value }))} /></div>
                  <div><label className={labelClass}>Destino atual, se confirmado</label><select className={inputClass} value={testForm.destination_category} onChange={(e) => setTestForm((v) => ({ ...v, destination_category: e.target.value }))}>{DESTINATIONS.map(([k,l]) => <option key={k} value={k}>{l}</option>)}</select></div>
                  <div><label className={labelClass}>Local físico, se conhecido</label><input className={inputClass} value={testForm.destination_location} onChange={(e) => setTestForm((v) => ({ ...v, destination_location: e.target.value }))} /></div>
                  <div><label className={labelClass}>Documento</label><input className={inputClass} value={testForm.document} onChange={(e) => setTestForm((v) => ({ ...v, document: e.target.value }))} /></div>
                  <div className="md:col-span-2"><label className={labelClass}>Observação</label><textarea className={`${inputClass} min-h-20`} value={testForm.observation} onChange={(e) => setTestForm((v) => ({ ...v, observation: e.target.value }))} /></div>
                </div>
              </> : null}
            </div>
          </div>
        </div>

        <div className="px-5 py-4 border-t border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950/40 flex flex-wrap items-center justify-between gap-3">
          <div className="text-xs font-bold text-slate-500 flex items-center gap-2"><AlertTriangle size={14} /> A2 registra fatos; os indicadores MTBF/MTTR/TAT são calculados somente no A3.</div>
          <div className="flex gap-2"><button onClick={onClose} className="px-4 py-2.5 rounded-xl bg-slate-200 dark:bg-slate-700 font-black">Fechar</button><button onClick={submit} disabled={saving || !selected} className="px-5 py-2.5 rounded-xl bg-blue-600 text-white font-black disabled:opacity-50 inline-flex items-center gap-2">{tab === 'TEST' ? <CheckCircle2 size={16} /> : <Wrench size={16} />}{saving ? 'SALVANDO...' : tab === 'INSTALL' ? 'CONFIRMAR INSTALAÇÃO' : tab === 'REMOVE' ? 'CONFIRMAR REMOÇÃO' : 'CONFIRMAR RESULTADO'}</button></div>
        </div>
      </div>
    </div>
  );
}
