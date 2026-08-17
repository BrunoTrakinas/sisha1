import React, { useEffect, useMemo, useState } from 'react';
import { Database, Plus, RefreshCcw, Save, Search, Trash2, X } from 'lucide-react';
import { apiFetch } from '../lib/api';

const STATUS_OC = ['ELB', 'ODC', 'ODA', 'ODA_RESSALVA', 'REC', 'CAN', 'ADP'];
const STATUS_PD = ['ELB', 'TRI', 'ANS', 'COT', 'PRO', 'LPC', 'ODC', 'ODA', 'EMB', 'REC', 'FAT', 'CAN', 'ATIVO', 'EXCLUIDO'];
const STATUS_WO = ['ELB', 'TRI', 'ANS', 'COT', 'PRO', 'LPC', 'ODC', 'ODA', 'EMB', 'REC', 'FAT', 'CAN', 'AGUARDANDO_VERBA', 'WO_ABERTA', 'ENVIADO', 'EM_REPARO', 'AGUARDANDO_ORCAMENTO', 'AGUARDANDO_APROVACAO', 'REPARADO', 'IRREPARAVEL', 'REGRESSANDO', 'RECEBIDO', 'CANCELADO'];
const TIPO_WO = ['PENDENTE', 'GARANTIA', 'OVERHAUL', 'REPARO', 'INSPECAO', 'FABRICANTE', 'OUTRO'];
const RESULTADO_WO = ['PENDENTE', 'REPARADO', 'IRREPARAVEL', 'DEVOLVIDO_SEM_REPARO', 'CANCELADO', 'NAO_INFORMADO'];

const SOURCES = {
  ppu: {
    label: 'PPU',
    description: 'Fotografia operacional atual do Paiol de Pronto Uso.',
    endpoint: '/items/ppu',
    createEndpoint: '/items/ppu',
    updateEndpoint: (id) => `/items/ppu/id/${id}`,
    deleteEndpoint: (id) => `/items/ppu/id/${id}`,
    idField: 'id',
    fields: [
      { key: 'pn', label: 'PN', required: true, width: 150 },
      { key: 'sn', label: 'SN', width: 150 },
      { key: 'nsn_pi', label: 'NSN / PI', width: 150 },
      { key: 'nomenclatura', label: 'Nomenclatura', width: 260 },
      { key: 'quantidade', label: 'Qtd', type: 'number', width: 90 },
      { key: 'localizacao', label: 'Localização', width: 180 },
      { key: 'data_chegada', label: 'Chegada', type: 'date', width: 135 },
      { key: 'data_garantia', label: 'Garantia', type: 'date', width: 135 },
    ],
    defaults: { pn: '', sn: '', nsn_pi: '', nomenclatura: '', quantidade: 0, localizacao: 'NÃO DEFINIDO', data_chegada: '', data_garantia: '' },
  },
  ceimspa: {
    label: 'CeIMSPA',
    description: 'Base operacional administrável. Permite reduzir saldo conforme consumo e incluir novos registros.',
    endpoint: '/items/ceimspa',
    createEndpoint: '/items/ceimspa',
    updateEndpoint: (id) => `/items/ceimspa/id/${id}`,
    deleteEndpoint: (id) => `/items/ceimspa/id/${id}`,
    idField: 'id',
    fields: [
      { key: 'pi', label: 'PI / NSN', required: true, width: 160 },
      { key: 'pn', label: 'PN', width: 160 },
      { key: 'nomenclatura', label: 'Nomenclatura', width: 280 },
      { key: 'quantidade', label: 'Qtd', type: 'number', width: 90 },
      { key: 'sj', label: 'SJ', width: 120 },
      { key: 'uf', label: 'UF', width: 100 },
    ],
    defaults: { pi: '', pn: '', nomenclatura: '', quantidade: 0, sj: 'N/A', uf: 'N/A' },
  },
  oc: {
    label: 'OC / ODC',
    description: 'Ordens de Compra locais do SISHA. ODC é tratado pelo status da OC; registros do Order Book continuam somente leitura.',
    endpoint: '/purchases/ordens',
    createEndpoint: '/purchases/ordens',
    updateEndpoint: (id) => `/purchases/ordens/${id}`,
    deleteEndpoint: (id) => `/purchases/ordens/${id}`,
    idField: 'id',
    filterRows: (rows) => rows.filter((r) => !String(r.id || '').startsWith('orderbook-') && String(r.source || r.fonte || 'SISHA').toUpperCase() === 'SISHA'),
    fields: [
      { key: 'numero_oc', label: 'OC', required: true, width: 170, immutableExisting: true },
      { key: 'status', label: 'Status', type: 'select', options: STATUS_OC, width: 145 },
      { key: 'moeda', label: 'Moeda', width: 95 },
      { key: 'valor_total', label: 'Valor total', type: 'number', step: '0.01', width: 130 },
      { key: 'observacao', label: 'Observação', width: 330 },
    ],
    defaults: { numero_oc: '', status: 'ELB', moeda: 'USD', valor_total: 0, observacao: '' },
  },
  pd: {
    label: 'PD / SEPD',
    description: 'Pedidos locais com edição pelas regras do módulo de compras.',
    endpoint: '/purchases/pds',
    createEndpoint: '/purchases/pds',
    updateEndpoint: (id) => `/purchases/pds/${id}`,
    deleteEndpoint: (id) => `/purchases/pds/${id}`,
    idField: 'id',
    fields: [
      { key: 'numero_pd', label: 'PD / SEPD', required: true, width: 170 },
      { key: 'numero_oc', label: 'OC', width: 160 },
      { key: 'pn', label: 'PN', required: true, width: 160 },
      { key: 'nsn', label: 'NSN', width: 145 },
      { key: 'nomenclatura', label: 'Nomenclatura', width: 280 },
      { key: 'quantidade', label: 'Qtd', type: 'number', width: 80 },
      { key: 'qtd_recebida', label: 'Recebida', type: 'number', width: 95 },
      { key: 'status', label: 'Status', type: 'select', options: STATUS_PD, width: 135 },
      { key: 'valor_unitario', label: 'Valor unit.', type: 'number', step: '0.01', width: 120 },
      { key: 'valor_total', label: 'Valor total', type: 'number', step: '0.01', width: 120 },
      { key: 'moeda', label: 'Moeda', width: 90 },
      { key: 'responsavel', label: 'Responsável', width: 160 },
      { key: 'observacao', label: 'Observação', width: 260 },
    ],
    defaults: { numero_pd: '', numero_oc: '', pn: '', nsn: '', nomenclatura: '', quantidade: 1, qtd_recebida: 0, status: 'ELB', valor_unitario: 0, valor_total: 0, moeda: 'USD', responsavel: '', observacao: '' },
  },
  wo: {
    label: 'WO',
    description: 'Work Orders locais. Alterações continuam sincronizando o Livro do Equipamento pelas regras do 2B.5B.',
    endpoint: '/purchases/work-orders',
    createEndpoint: '/purchases/work-orders',
    updateEndpoint: (id) => `/purchases/work-orders/${id}`,
    deleteEndpoint: (id) => `/purchases/work-orders/${id}`,
    idField: 'id',
    filterRows: (rows) => rows.filter((r) => !String(r.id || '').startsWith('orderbook-repair-') && String(r.source || r.fonte || 'SISHA').toUpperCase() === 'SISHA'),
    fields: [
      { key: 'numero_wo', label: 'WO', required: true, width: 180 },
      { key: 'pn', label: 'PN', required: true, width: 150 },
      { key: 'sn', label: 'SN', width: 145 },
      { key: 'nomenclatura', label: 'Nomenclatura', width: 260 },
      { key: 'status', label: 'Status', type: 'select', options: STATUS_WO, width: 170 },
      { key: 'tipo_wo', label: 'Serviço', type: 'select', options: TIPO_WO, width: 145 },
      { key: 'resultado_tecnico', label: 'Resultado', type: 'select', options: RESULTADO_WO, width: 190 },
      { key: 'empresa', label: 'Empresa', width: 170 },
      { key: 'valor_total', label: 'Valor', type: 'number', step: '0.01', width: 120 },
      { key: 'moeda', label: 'Moeda', width: 90 },
      { key: 'data_abertura', label: 'Abertura', type: 'date', width: 135 },
      { key: 'data_envio', label: 'Envio', type: 'date', width: 135 },
      { key: 'data_previsao', label: 'Previsão', type: 'date', width: 135 },
      { key: 'data_retorno', label: 'Retorno', type: 'date', width: 135 },
      { key: 'aeronave', label: 'Aeronave', width: 110 },
      { key: 'pn_saida', label: 'PN saída', width: 150 },
      { key: 'observacao', label: 'Observação', width: 270 },
    ],
    defaults: { numero_wo: '', pn: '', sn: '', nomenclatura: '', status: 'ELB', tipo_wo: 'PENDENTE', resultado_tecnico: 'PENDENTE', empresa: '', valor_total: 0, moeda: 'USD', data_abertura: '', data_envio: '', data_previsao: '', data_retorno: '', aeronave: '', pn_saida: '', observacao: '' },
  },
};

function tempId() {
  return `novo-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function normalizeForInput(value, type) {
  if (value == null) return '';
  if (type === 'date') return String(value).slice(0, 10);
  return value;
}

function buildPayload(row, fields) {
  const payload = {};
  fields.forEach((field) => {
    let value = row[field.key];
    if (field.type === 'number') value = value === '' || value == null ? 0 : Number(value);
    payload[field.key] = value == null ? '' : value;
  });
  return payload;
}

async function responseJson(response) {
  const text = await response.text();
  let json = {};
  try { json = text ? JSON.parse(text) : {}; } catch { json = { message: text }; }
  if (!response.ok || json.status === 'error') throw new Error(json.message || `Falha HTTP ${response.status}.`);
  return json;
}

export default function DataAdminManager({ token }) {
  const [open, setOpen] = useState(false);
  const [sourceKey, setSourceKey] = useState('ppu');
  const [rows, setRows] = useState([]);
  const [dirty, setDirty] = useState(new Set());
  const [query, setQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState(null);

  const config = SOURCES[sourceKey];

  const loadRows = async () => {
    setLoading(true);
    setMessage(null);
    try {
      const response = await apiFetch(config.endpoint, {}, token);
      const json = await responseJson(response);
      let next = Array.isArray(json.data) ? json.data : [];
      if (config.filterRows) next = config.filterRows(next);
      setRows(next.map((row) => ({ ...row, __key: String(row[config.idField]) })));
      setDirty(new Set());
    } catch (error) {
      setMessage({ type: 'error', text: error.message });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (open) loadRows();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, sourceKey]);

  const visibleRows = useMemo(() => {
    const q = query.trim().toUpperCase();
    return rows.filter((row) => {
      if (statusFilter && String(row.status || row.status_grupo || '').toUpperCase() !== statusFilter) return false;
      if (!q) return true;
      return config.fields.some((field) => String(row[field.key] ?? '').toUpperCase().includes(q));
    });
  }, [rows, query, statusFilter, config]);

  const statusOptions = useMemo(() => {
    if (!config.fields.some((f) => f.key === 'status')) return [];
    return Array.from(new Set(rows.map((r) => String(r.status || '').toUpperCase()).filter(Boolean))).sort();
  }, [rows, config]);

  const markDirty = (key) => setDirty((prev) => new Set([...prev, key]));

  const updateCell = (key, field, value) => {
    setRows((prev) => prev.map((row) => row.__key === key ? { ...row, [field]: value } : row));
    markDirty(key);
  };

  const addRow = () => {
    const key = tempId();
    setRows((prev) => [{ ...config.defaults, __key: key, __new: true }, ...prev]);
    markDirty(key);
  };

  const toggleDelete = (key) => {
    const row = rows.find((r) => r.__key === key);
    if (row?.__new) {
      setRows((prev) => prev.filter((r) => r.__key !== key));
      setDirty((prev) => {
        const next = new Set(prev); next.delete(key); return next;
      });
      return;
    }
    setRows((prev) => prev.map((r) => r.__key === key ? { ...r, __deleted: !r.__deleted } : r));
    markDirty(key);
  };

  const saveAll = async () => {
    const pending = rows.filter((row) => dirty.has(row.__key));
    if (!pending.length) return;
    for (const row of pending) {
      if (!row.__deleted) {
        const missing = config.fields.filter((f) => f.required).find((f) => !String(row[f.key] ?? '').trim());
        if (missing) {
          setMessage({ type: 'error', text: `${config.label}: preencha o campo obrigatório “${missing.label}”.` });
          return;
        }
      }
    }

    setSaving(true);
    setMessage(null);
    let completed = 0;
    try {
      for (const row of pending) {
        if (row.__deleted) {
          const response = await apiFetch(config.deleteEndpoint(row[config.idField]), {
            method: 'DELETE',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ motivo: 'Exclusão pela Administração de Dados 2.0' }),
          }, token);
          await responseJson(response);
        } else if (row.__new) {
          const response = await apiFetch(config.createEndpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(buildPayload(row, config.fields)),
          }, token);
          await responseJson(response);
        } else {
          const response = await apiFetch(config.updateEndpoint(row[config.idField]), {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(buildPayload(row, config.fields)),
          }, token);
          await responseJson(response);
        }
        completed += 1;
      }
      setMessage({ type: 'success', text: `${completed} alteração(ões) aplicada(s) em ${config.label}.` });
      await loadRows();
    } catch (error) {
      setMessage({ type: 'error', text: `${completed} alteração(ões) já foram aplicadas antes da falha. ${error.message}` });
      await loadRows();
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <section className="bg-white dark:bg-slate-900 rounded-3xl p-8 shadow-sm border border-slate-200 dark:border-slate-800">
        <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-5">
          <div className="max-w-3xl">
            <div className="flex items-center gap-3 mb-2">
              <div className="w-11 h-11 rounded-2xl bg-blue-50 dark:bg-blue-950/40 border border-blue-100 dark:border-blue-900 flex items-center justify-center text-blue-600 dark:text-blue-300"><Database size={22} /></div>
              <h2 className="text-xl font-black text-slate-900 dark:text-white uppercase">Administração de Dados 2.0</h2>
            </div>
            <p className="text-sm font-bold text-slate-600 dark:text-slate-400 leading-6">
              Abra uma base completa, pesquise, altere várias linhas, adicione ou exclua registros e salve tudo em uma única ação. IDs internos e campos de auditoria permanecem protegidos.
            </p>
          </div>
          <button type="button" onClick={() => setOpen(true)} className="bg-blue-600 hover:bg-blue-700 text-white px-6 py-3 rounded-xl font-black transition-colors">
            ABRIR GERENCIADOR DE DADOS
          </button>
        </div>
      </section>

      {open && (
        <div className="fixed inset-0 z-[70] bg-black/70 backdrop-blur-sm p-3 md:p-6 flex items-center justify-center">
          <div className="w-full max-w-[96vw] h-[92vh] bg-slate-50 dark:bg-slate-950 rounded-3xl shadow-2xl border border-slate-200 dark:border-slate-800 overflow-hidden flex flex-col">
            <div className="px-5 md:px-7 py-5 border-b border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 flex items-start justify-between gap-4">
              <div>
                <h3 className="text-xl md:text-2xl font-black text-slate-900 dark:text-white uppercase">Gerenciador de Dados</h3>
                <p className="text-sm font-bold text-slate-500 dark:text-slate-400 mt-1">{config.description}</p>
              </div>
              <button onClick={() => setOpen(false)} className="p-2 rounded-xl bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-200 hover:bg-slate-200 dark:hover:bg-slate-700"><X /></button>
            </div>

            <div className="px-5 md:px-7 pt-4 bg-white dark:bg-slate-900 border-b border-slate-200 dark:border-slate-800">
              <div className="flex gap-2 overflow-x-auto pb-4">
                {Object.entries(SOURCES).map(([key, source]) => (
                  <button key={key} onClick={() => { setSourceKey(key); setQuery(''); setStatusFilter(''); setMessage(null); }} className={`px-5 py-2.5 rounded-xl whitespace-nowrap font-black text-sm border transition ${sourceKey === key ? 'bg-blue-600 text-white border-blue-600' : 'bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-200 border-slate-200 dark:border-slate-700 hover:border-blue-400'}`}>
                    {source.label}
                  </button>
                ))}
              </div>
            </div>

            <div className="px-5 md:px-7 py-4 bg-slate-50 dark:bg-slate-950 flex flex-col xl:flex-row gap-3 xl:items-center xl:justify-between border-b border-slate-200 dark:border-slate-800">
              <div className="flex flex-col md:flex-row gap-3 flex-1">
                <div className="relative flex-1 max-w-xl">
                  <Search size={18} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
                  <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder={`Buscar em ${config.label}...`} className="w-full pl-10 pr-4 py-3 rounded-xl border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 font-bold" />
                </div>
                {statusOptions.length > 0 && (
                  <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} className="px-4 py-3 rounded-xl border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 font-bold">
                    <option value="">Todos os status</option>
                    {statusOptions.map((status) => <option key={status} value={status}>{status}</option>)}
                  </select>
                )}
              </div>
              <div className="flex flex-wrap gap-2">
                <button onClick={loadRows} disabled={loading || saving} className="px-4 py-3 rounded-xl bg-slate-200 dark:bg-slate-800 text-slate-800 dark:text-slate-100 font-black flex items-center gap-2 disabled:opacity-50"><RefreshCcw size={17} /> Recarregar</button>
                <button onClick={addRow} disabled={saving} className="px-4 py-3 rounded-xl bg-slate-200 dark:bg-slate-800 text-slate-800 dark:text-slate-100 font-black flex items-center gap-2 disabled:opacity-50"><Plus size={18} /> Adicionar registro</button>
                <button onClick={saveAll} disabled={!dirty.size || saving} className="px-5 py-3 rounded-xl bg-blue-600 hover:bg-blue-700 text-white font-black flex items-center gap-2 disabled:opacity-40"><Save size={18} /> {saving ? 'Salvando...' : `Salvar ${dirty.size || ''} alteração(ões)`}</button>
              </div>
            </div>

            {message && <div className={`mx-5 md:mx-7 mt-3 rounded-xl border px-4 py-3 text-sm font-black ${message.type === 'success' ? 'bg-emerald-50 dark:bg-emerald-950/30 border-emerald-200 dark:border-emerald-800 text-emerald-800 dark:text-emerald-200' : 'bg-red-50 dark:bg-red-950/30 border-red-200 dark:border-red-800 text-red-800 dark:text-red-200'}`}>{message.text}</div>}

            <div className="flex-1 min-h-0 p-5 md:p-7 pt-4">
              <div className="h-full overflow-auto rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900">
                <table className="min-w-max w-full text-sm">
                  <thead className="sticky top-0 z-10 bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-200 uppercase text-xs">
                    <tr>
                      <th className="px-3 py-3 text-left w-16">Ação</th>
                      {config.fields.map((field) => <th key={field.key} style={{ minWidth: field.width || 140 }} className="px-3 py-3 text-left">{field.label}{field.required ? ' *' : ''}</th>)}
                    </tr>
                  </thead>
                  <tbody>
                    {visibleRows.map((row) => (
                      <tr key={row.__key} className={`border-t border-slate-200 dark:border-slate-800 ${row.__deleted ? 'bg-red-50 dark:bg-red-950/20 opacity-70' : dirty.has(row.__key) ? 'bg-blue-50/60 dark:bg-blue-950/20' : ''}`}>
                        <td className="px-2 py-2 align-top">
                          <button title={row.__deleted ? 'Restaurar' : 'Excluir'} onClick={() => toggleDelete(row.__key)} className={`p-2 rounded-lg ${row.__deleted ? 'bg-slate-200 dark:bg-slate-700 text-slate-700 dark:text-slate-200' : 'bg-red-50 dark:bg-red-950/40 text-red-600 dark:text-red-300 hover:bg-red-100 dark:hover:bg-red-950/70'}`}><Trash2 size={16} /></button>
                        </td>
                        {config.fields.map((field) => (
                          <td key={field.key} className="px-2 py-2 align-top">
                            {field.type === 'select' ? (
                              <select disabled={row.__deleted || (field.immutableExisting && !row.__new)} value={normalizeForInput(row[field.key], field.type)} onChange={(e) => updateCell(row.__key, field.key, e.target.value)} className="w-full px-2.5 py-2 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 text-slate-900 dark:text-slate-100 font-semibold disabled:opacity-50">
                                {field.options.map((option) => <option key={option} value={option}>{option}</option>)}
                              </select>
                            ) : (
                              <input disabled={row.__deleted || (field.immutableExisting && !row.__new)} type={field.type || 'text'} step={field.step} value={normalizeForInput(row[field.key], field.type)} onChange={(e) => updateCell(row.__key, field.key, e.target.value)} className="w-full px-2.5 py-2 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 text-slate-900 dark:text-slate-100 font-semibold disabled:opacity-50" />
                            )}
                          </td>
                        ))}
                      </tr>
                    ))}
                    {!loading && visibleRows.length === 0 && <tr><td colSpan={config.fields.length + 1} className="p-10 text-center font-bold text-slate-500 dark:text-slate-400">Nenhum registro encontrado.</td></tr>}
                    {loading && <tr><td colSpan={config.fields.length + 1} className="p-10 text-center font-black text-blue-600 dark:text-blue-300">Carregando {config.label}...</td></tr>}
                  </tbody>
                </table>
              </div>
              <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-xs font-bold text-slate-500 dark:text-slate-400">
                <span>{visibleRows.length} registro(s) exibido(s) de {rows.length}.</span>
                <span>Campos técnicos, IDs e auditoria não são editáveis por esta tela.</span>
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
