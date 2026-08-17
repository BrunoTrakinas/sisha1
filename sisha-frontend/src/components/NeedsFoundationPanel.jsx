import React, { useEffect, useMemo, useState } from 'react';
import { apiFetch, buildAuthHeaders } from '../lib/api';

const emptyReceitaForm = {
  id: null,
  inspecao: '',
  pn: '',
  nsn: '',
  pn_alt: '',
  nomenclatura: '',
  qtd_por_ciclo: '',
};

const emptyPimForm = {
  id: null,
  pim: '',
  data_solicitacao: '',
  pn: '',
  nsn: '',
  quantidade: '',
  os_vinculada: '',
  observacoes: '',
};

const emptyPoliticaForm = {
  id: null,
  tarefas: '',
  tipo: 'Receita',
  prioridade: '',
  qtde_2_anos: '',
};

function Msg({ data }) {
  if (!data) return null;
  return <p className={`font-bold ${data.tipo === 'success' ? 'text-green-600' : 'text-red-600'}`}>{data.texto}</p>;
}

export default function NeedsFoundationPanel({ token }) {
  const [activeTab, setActiveTab] = useState('receitas');
  const [snapshot, setSnapshot] = useState({ receitaItens: 0, pims: 0, politicas: 0 });
  const [loadingSnapshot, setLoadingSnapshot] = useState(false);

  const [receitas, setReceitas] = useState([]);
  const [receitaSearch, setReceitaSearch] = useState('');
  const [selectedInspecao, setSelectedInspecao] = useState('');
  const [receitaItens, setReceitaItens] = useState([]);
  const [receitaForm, setReceitaForm] = useState(emptyReceitaForm);
  const [receitaLoading, setReceitaLoading] = useState(false);
  const [receitaMsg, setReceitaMsg] = useState(null);

  const [pims, setPims] = useState([]);
  const [pimSearch, setPimSearch] = useState('');
  const [pimForm, setPimForm] = useState(emptyPimForm);
  const [pimLoading, setPimLoading] = useState(false);
  const [pimMsg, setPimMsg] = useState(null);

  const [politicas, setPoliticas] = useState([]);
  const [politicaSearch, setPoliticaSearch] = useState('');
  const [politicaForm, setPoliticaForm] = useState(emptyPoliticaForm);
  const [politicaLoading, setPoliticaLoading] = useState(false);
  const [politicaMsg, setPoliticaMsg] = useState(null);

  const tabs = useMemo(() => ([
    { key: 'receitas', label: 'Receitas' },
    { key: 'pims', label: 'PIM' },
    { key: 'politicas', label: 'Política de Estoque' },
  ]), []);

  const fetchSnapshot = async () => {
    setLoadingSnapshot(true);
    try {
      const response = await apiFetch('/needs/snapshot', {}, token);
      const json = await response.json();
      if (json.status === 'success') setSnapshot(json.data || { receitaItens: 0, pims: 0, politicas: 0 });
    } catch (_) {
    } finally {
      setLoadingSnapshot(false);
    }
  };

  const loadReceitas = async (query = '') => {
    try {
      const response = await apiFetch(`/needs/receitas${query ? `?q=${encodeURIComponent(query)}` : ''}`, {}, token);
      const json = await response.json();
      if (json.status === 'success') setReceitas(json.data || []);
    } catch (_) {}
  };

  const loadReceitaItens = async (inspecao) => {
    if (!inspecao) {
      setReceitaItens([]);
      return;
    }
    setReceitaLoading(true);
    try {
      const response = await apiFetch(`/needs/receitas/${encodeURIComponent(inspecao)}`, {}, token);
      const json = await response.json();
      if (json.status === 'success') setReceitaItens(json.data || []);
    } catch (_) {
      setReceitaItens([]);
    } finally {
      setReceitaLoading(false);
    }
  };

  const loadPims = async (query = '') => {
    try {
      const response = await apiFetch(`/needs/pims${query ? `?q=${encodeURIComponent(query)}` : ''}`, {}, token);
      const json = await response.json();
      if (json.status === 'success') setPims(json.data || []);
    } catch (_) {}
  };

  const loadPoliticas = async (query = '') => {
    try {
      const response = await apiFetch(`/needs/politicas${query ? `?q=${encodeURIComponent(query)}` : ''}`, {}, token);
      const json = await response.json();
      if (json.status === 'success') setPoliticas(json.data || []);
    } catch (_) {}
  };

  useEffect(() => { fetchSnapshot(); }, []);
  useEffect(() => { loadReceitas(receitaSearch); }, [receitaSearch]);
  useEffect(() => { loadPims(pimSearch); }, [pimSearch]);
  useEffect(() => { loadPoliticas(politicaSearch); }, [politicaSearch]);
  useEffect(() => { loadReceitaItens(selectedInspecao); }, [selectedInspecao]);

  const salvarReceita = async (e) => {
    e.preventDefault();
    setReceitaLoading(true);
    setReceitaMsg(null);
    try {
      const isEdit = !!receitaForm.id;
      const path = isEdit ? `/needs/receitas/item/${receitaForm.id}` : '/needs/receitas/item';
      const response = await apiFetch(path, {
        method: isEdit ? 'PUT' : 'POST',
        headers: buildAuthHeaders(token, { 'Content-Type': 'application/json' }),
        body: JSON.stringify(receitaForm),
      }, token);
      const json = await response.json();
      if (json.status === 'success') {
        setReceitaMsg({ tipo: 'success', texto: json.message });
        setSelectedInspecao(receitaForm.inspecao);
        setReceitaForm({ ...emptyReceitaForm, inspecao: receitaForm.inspecao });
        await loadReceitas(receitaSearch);
        await loadReceitaItens(receitaForm.inspecao);
        await fetchSnapshot();
      } else {
        setReceitaMsg({ tipo: 'error', texto: json.message });
      }
    } catch {
      setReceitaMsg({ tipo: 'error', texto: 'Falha ao salvar item da receita.' });
    } finally {
      setReceitaLoading(false);
    }
  };

  const excluirReceita = async () => {
    if (!receitaForm.id) return;
    if (!window.confirm('Confirmar exclusão do item da receita?')) return;
    setReceitaLoading(true);
    setReceitaMsg(null);
    try {
      const response = await apiFetch(`/needs/receitas/item/${receitaForm.id}`, { method: 'DELETE' }, token);
      const json = await response.json();
      if (json.status === 'success') {
        setReceitaMsg({ tipo: 'success', texto: json.message });
        setReceitaForm({ ...emptyReceitaForm, inspecao: selectedInspecao });
        await loadReceitaItens(selectedInspecao);
        await loadReceitas(receitaSearch);
        await fetchSnapshot();
      } else {
        setReceitaMsg({ tipo: 'error', texto: json.message });
      }
    } catch {
      setReceitaMsg({ tipo: 'error', texto: 'Falha ao excluir item da receita.' });
    } finally {
      setReceitaLoading(false);
    }
  };

  const salvarPim = async (e) => {
    e.preventDefault();
    setPimLoading(true);
    setPimMsg(null);
    try {
      const isEdit = !!pimForm.id;
      const path = isEdit ? `/needs/pims/${pimForm.id}` : '/needs/pims';
      const response = await apiFetch(path, {
        method: isEdit ? 'PUT' : 'POST',
        headers: buildAuthHeaders(token, { 'Content-Type': 'application/json' }),
        body: JSON.stringify(pimForm),
      }, token);
      const json = await response.json();
      if (json.status === 'success') {
        setPimMsg({ tipo: 'success', texto: json.message });
        setPimForm(emptyPimForm);
        await loadPims(pimSearch);
        await fetchSnapshot();
      } else {
        setPimMsg({ tipo: 'error', texto: json.message });
      }
    } catch {
      setPimMsg({ tipo: 'error', texto: 'Falha ao salvar PIM.' });
    } finally {
      setPimLoading(false);
    }
  };

  const excluirPim = async () => {
    if (!pimForm.id) return;
    if (!window.confirm('Confirmar exclusão do PIM selecionado?')) return;
    setPimLoading(true);
    setPimMsg(null);
    try {
      const response = await apiFetch(`/needs/pims/${pimForm.id}`, { method: 'DELETE' }, token);
      const json = await response.json();
      if (json.status === 'success') {
        setPimMsg({ tipo: 'success', texto: json.message });
        setPimForm(emptyPimForm);
        await loadPims(pimSearch);
        await fetchSnapshot();
      } else {
        setPimMsg({ tipo: 'error', texto: json.message });
      }
    } catch {
      setPimMsg({ tipo: 'error', texto: 'Falha ao excluir PIM.' });
    } finally {
      setPimLoading(false);
    }
  };

  const salvarPolitica = async (e) => {
    e.preventDefault();
    setPoliticaLoading(true);
    setPoliticaMsg(null);
    try {
      const isEdit = !!politicaForm.id;
      const path = isEdit ? `/needs/politicas/${politicaForm.id}` : '/needs/politicas';
      const response = await apiFetch(path, {
        method: isEdit ? 'PUT' : 'POST',
        headers: buildAuthHeaders(token, { 'Content-Type': 'application/json' }),
        body: JSON.stringify(politicaForm),
      }, token);
      const json = await response.json();
      if (json.status === 'success') {
        setPoliticaMsg({ tipo: 'success', texto: json.message });
        setPoliticaForm(emptyPoliticaForm);
        await loadPoliticas(politicaSearch);
        await fetchSnapshot();
      } else {
        setPoliticaMsg({ tipo: 'error', texto: json.message });
      }
    } catch {
      setPoliticaMsg({ tipo: 'error', texto: 'Falha ao salvar política.' });
    } finally {
      setPoliticaLoading(false);
    }
  };

  const excluirPolitica = async () => {
    if (!politicaForm.id) return;
    if (!window.confirm('Confirmar exclusão da política selecionada?')) return;
    setPoliticaLoading(true);
    setPoliticaMsg(null);
    try {
      const response = await apiFetch(`/needs/politicas/${politicaForm.id}`, { method: 'DELETE' }, token);
      const json = await response.json();
      if (json.status === 'success') {
        setPoliticaMsg({ tipo: 'success', texto: json.message });
        setPoliticaForm(emptyPoliticaForm);
        await loadPoliticas(politicaSearch);
        await fetchSnapshot();
      } else {
        setPoliticaMsg({ tipo: 'error', texto: json.message });
      }
    } catch {
      setPoliticaMsg({ tipo: 'error', texto: 'Falha ao excluir política.' });
    } finally {
      setPoliticaLoading(false);
    }
  };

  return (
    <section className="bg-white dark:bg-slate-900 rounded-3xl p-8 shadow-sm border border-slate-200 dark:border-slate-700 space-y-6">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h2 className="text-xl font-black text-slate-800 dark:text-slate-200 uppercase">Receitas, PIM e Política de Estoque</h2>
          <p className="text-sm text-slate-700 dark:text-slate-300 mt-1">Pesquise, cadastre e corrija informações usadas pelo Gerador de Necessidades e pela política de ressuprimento.</p>
        </div>
        <div className="grid grid-cols-3 gap-3 min-w-[280px]">
          <div className="rounded-2xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950/60 p-4 text-center">
            <p className="text-[11px] uppercase font-black text-slate-500">Itens de Receita</p>
            <p className="text-2xl font-black text-slate-900 dark:text-slate-100">{loadingSnapshot ? '...' : snapshot.receitaItens}</p>
          </div>
          <div className="rounded-2xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950/60 p-4 text-center">
            <p className="text-[11px] uppercase font-black text-slate-500">PIMs</p>
            <p className="text-2xl font-black text-slate-900 dark:text-slate-100">{loadingSnapshot ? '...' : snapshot.pims}</p>
          </div>
          <div className="rounded-2xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950/60 p-4 text-center">
            <p className="text-[11px] uppercase font-black text-slate-500">Políticas</p>
            <p className="text-2xl font-black text-slate-900 dark:text-slate-100">{loadingSnapshot ? '...' : snapshot.politicas}</p>
          </div>
        </div>
      </div>

      <div className="flex gap-3 flex-wrap">
        {tabs.map((tab) => (
          <button
            key={tab.key}
            onClick={() => setActiveTab(tab.key)}
            className={`px-5 py-3 rounded-xl font-black ${activeTab === tab.key ? 'bg-slate-900 text-white' : 'bg-slate-100 dark:bg-slate-800 text-slate-900 dark:text-slate-100 hover:bg-slate-200'}`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {activeTab === 'receitas' && (
        <div className="grid grid-cols-1 xl:grid-cols-[340px_1fr] gap-6">
          <div className="space-y-4">
            <input value={receitaSearch} onChange={(e) => setReceitaSearch(e.target.value)} placeholder="Buscar inspeção/receita" className="w-full p-3 bg-white dark:bg-slate-950 border-2 border-slate-200 dark:border-slate-700 rounded-xl font-bold text-slate-900 dark:text-slate-100 placeholder:text-slate-500" />
            <div className="border border-slate-200 dark:border-slate-700 rounded-2xl overflow-auto max-h-[420px]">
              {receitas.map((item) => (
                <button key={item.inspecao} onClick={() => { setSelectedInspecao(item.inspecao); setReceitaForm({ ...emptyReceitaForm, inspecao: item.inspecao }); }} className={`w-full text-left p-4 border-b border-slate-200 dark:border-slate-700 last:border-b-0 ${selectedInspecao === item.inspecao ? 'bg-slate-900 text-white' : 'bg-white text-slate-900 dark:text-slate-100 hover:bg-slate-50 dark:bg-slate-950/60'}`}>
                  <p className="font-black">{item.inspecao}</p>
                  <p className={`text-xs font-bold ${selectedInspecao === item.inspecao ? 'text-slate-200' : 'text-slate-500'}`}>{item.total_itens} itens</p>
                </button>
              ))}
              {receitas.length === 0 && <p className="p-4 font-bold text-slate-500">Nenhuma receita encontrada.</p>}
            </div>
          </div>

          <div className="space-y-6">
            <div className="border border-slate-200 dark:border-slate-700 rounded-2xl p-5 space-y-4">
              <div className="flex items-center justify-between gap-3 flex-wrap">
                <h3 className="text-lg font-black text-slate-900 dark:text-slate-100 uppercase">Itens da Receita</h3>
                <button onClick={() => setReceitaForm({ ...emptyReceitaForm, inspecao: selectedInspecao })} className="px-4 py-2 rounded-xl bg-slate-100 dark:bg-slate-800 text-slate-900 dark:text-slate-100 font-black hover:bg-slate-200">NOVO ITEM</button>
              </div>
              {selectedInspecao ? (
                <div className="overflow-auto border border-slate-200 dark:border-slate-700 rounded-2xl max-h-[320px]">
                  <table className="min-w-full text-sm">
                    <thead className="bg-slate-100 dark:bg-slate-800 text-slate-800 dark:text-slate-200 uppercase text-xs">
                      <tr>
                        <th className="p-3 text-left">PN</th>
                        <th className="p-3 text-left">PN Alt</th>
                        <th className="p-3 text-left">NSN</th>
                        <th className="p-3 text-left">Nome</th>
                        <th className="p-3 text-left">Qtd/Ciclo</th>
                        <th className="p-3 text-left">Ação</th>
                      </tr>
                    </thead>
                    <tbody className="text-slate-900 dark:text-slate-100">
                      {receitaItens.map((item) => (
                        <tr key={item.id} className="border-t border-slate-200 dark:border-slate-700">
                          <td className="p-3 font-bold">{item.pn}</td>
                          <td className="p-3">{item.pn_alt || '—'}</td>
                          <td className="p-3">{item.nsn || '—'}</td>
                          <td className="p-3">{item.nomenclatura}</td>
                          <td className="p-3">{item.qtd_por_ciclo}</td>
                          <td className="p-3"><button onClick={() => setReceitaForm({ id: item.id, inspecao: item.inspecao, pn: item.pn, nsn: item.nsn || '', pn_alt: item.pn_alt || '', nomenclatura: item.nomenclatura || '', qtd_por_ciclo: item.qtd_por_ciclo || '' })} className="px-3 py-2 rounded-xl bg-blue-600 text-white font-black hover:bg-blue-700">EDITAR</button></td>
                        </tr>
                      ))}
                      {receitaItens.length === 0 && <tr><td colSpan="6" className="p-4 font-bold text-slate-500">{receitaLoading ? 'Carregando...' : 'Nenhum item carregado para esta inspeção.'}</td></tr>}
                    </tbody>
                  </table>
                </div>
              ) : <p className="font-bold text-slate-500">Selecione uma inspeção à esquerda ou comece uma nova receita pelo formulário abaixo.</p>}
            </div>

            <form onSubmit={salvarReceita} className="border border-slate-200 dark:border-slate-700 rounded-2xl p-5 space-y-4">
              <h3 className="text-lg font-black text-slate-900 dark:text-slate-100 uppercase">Cadastro Manual de Receita</h3>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <input value={receitaForm.inspecao} onChange={(e) => setReceitaForm((p) => ({ ...p, inspecao: e.target.value }))} placeholder="Inspeção / Receita" className="w-full p-3 bg-white dark:bg-slate-950 border-2 border-slate-200 dark:border-slate-700 rounded-xl font-bold text-slate-900 dark:text-slate-100 placeholder:text-slate-500 md:col-span-2" />
                <input value={receitaForm.pn} onChange={(e) => setReceitaForm((p) => ({ ...p, pn: e.target.value.toUpperCase() }))} placeholder="PN" className="w-full p-3 bg-white dark:bg-slate-950 border-2 border-slate-200 dark:border-slate-700 rounded-xl font-bold text-slate-900 dark:text-slate-100 placeholder:text-slate-500" />
                <input value={receitaForm.nsn} onChange={(e) => setReceitaForm((p) => ({ ...p, nsn: e.target.value }))} placeholder="NSN" className="w-full p-3 bg-white dark:bg-slate-950 border-2 border-slate-200 dark:border-slate-700 rounded-xl font-bold text-slate-900 dark:text-slate-100 placeholder:text-slate-500" />
                <input value={receitaForm.pn_alt} onChange={(e) => setReceitaForm((p) => ({ ...p, pn_alt: e.target.value.toUpperCase() }))} placeholder="PN Alternativo (opcional)" className="w-full p-3 bg-white dark:bg-slate-950 border-2 border-slate-200 dark:border-slate-700 rounded-xl font-bold text-slate-900 dark:text-slate-100 placeholder:text-slate-500" />
                <input value={receitaForm.qtd_por_ciclo} onChange={(e) => setReceitaForm((p) => ({ ...p, qtd_por_ciclo: e.target.value }))} placeholder="Qtd por Ciclo" type="number" min="0" step="0.01" className="w-full p-3 bg-white dark:bg-slate-950 border-2 border-slate-200 dark:border-slate-700 rounded-xl font-bold text-slate-900 dark:text-slate-100 placeholder:text-slate-500" />
                <input value={receitaForm.nomenclatura} onChange={(e) => setReceitaForm((p) => ({ ...p, nomenclatura: e.target.value }))} placeholder="Nomenclatura" className="w-full p-3 bg-white dark:bg-slate-950 border-2 border-slate-200 dark:border-slate-700 rounded-xl font-bold text-slate-900 dark:text-slate-100 placeholder:text-slate-500 md:col-span-2" />
              </div>
              <div className="flex justify-end gap-3">
                <button type="button" onClick={() => setReceitaForm({ ...emptyReceitaForm, inspecao: selectedInspecao })} className="px-6 py-3 rounded-xl bg-slate-100 dark:bg-slate-800 text-slate-900 dark:text-slate-100 font-black hover:bg-slate-200">LIMPAR</button>
                <button type="button" onClick={excluirReceita} disabled={!receitaForm.id || receitaLoading} className="px-6 py-3 rounded-xl bg-red-600 text-white font-black hover:bg-red-700 disabled:opacity-50">EXCLUIR</button>
                <button type="submit" disabled={receitaLoading} className="px-6 py-3 rounded-xl bg-emerald-600 text-white font-black hover:bg-emerald-700 disabled:opacity-50">{receitaLoading ? 'SALVANDO...' : 'SALVAR ITEM'}</button>
              </div>
              <Msg data={receitaMsg} />
            </form>
          </div>
        </div>
      )}

      {activeTab === 'pims' && (
        <div className="grid grid-cols-1 xl:grid-cols-[1.2fr_0.9fr] gap-6">
          <div className="space-y-4">
            <input value={pimSearch} onChange={(e) => setPimSearch(e.target.value)} placeholder="Buscar PIM, PN, OS, ANV ou Oficina" className="w-full p-3 bg-white dark:bg-slate-950 border-2 border-slate-200 dark:border-slate-700 rounded-xl font-bold text-slate-900 dark:text-slate-100 placeholder:text-slate-500" />
            <div className="overflow-auto border border-slate-200 dark:border-slate-700 rounded-2xl max-h-[520px]">
              <table className="min-w-full text-sm">
                <thead className="bg-slate-100 dark:bg-slate-800 text-slate-800 dark:text-slate-200 uppercase text-xs">
                  <tr>
                    <th className="p-3 text-left">PIM</th>
                    <th className="p-3 text-left">PN</th>
                    <th className="p-3 text-left">Qtd</th>
                    <th className="p-3 text-left">OS</th>
                    <th className="p-3 text-left">Origem</th>
                    <th className="p-3 text-left">Ação</th>
                  </tr>
                </thead>
                <tbody className="text-slate-900 dark:text-slate-100">
                  {pims.map((item) => (
                    <tr key={item.id} className="border-t border-slate-200 dark:border-slate-700">
                      <td className="p-3 font-bold">{item.pim}</td>
                      <td className="p-3">{item.pn}</td>
                      <td className="p-3">{item.quantidade}</td>
                      <td className="p-3">{item.os_vinculada}</td>
                      <td className="p-3">{item.origem_codigo || item.origem_tipo || '—'}</td>
                      <td className="p-3"><button onClick={() => setPimForm({ id: item.id, pim: item.pim || '', data_solicitacao: item.data_solicitacao || '', pn: item.pn || '', nsn: item.nsn || '', quantidade: item.quantidade || '', os_vinculada: item.os_vinculada || '', observacoes: item.observacoes || '' })} className="px-3 py-2 rounded-xl bg-blue-600 text-white font-black hover:bg-blue-700">EDITAR</button></td>
                    </tr>
                  ))}
                  {pims.length === 0 && <tr><td colSpan="6" className="p-4 font-bold text-slate-500">Nenhum PIM encontrado.</td></tr>}
                </tbody>
              </table>
            </div>
          </div>

          <form onSubmit={salvarPim} className="border border-slate-200 dark:border-slate-700 rounded-2xl p-5 space-y-4">
            <h3 className="text-lg font-black text-slate-900 dark:text-slate-100 uppercase">Cadastro Manual de PIM</h3>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <input value={pimForm.pim} onChange={(e) => setPimForm((p) => ({ ...p, pim: e.target.value }))} placeholder="PIM" className="w-full p-3 bg-white dark:bg-slate-950 border-2 border-slate-200 dark:border-slate-700 rounded-xl font-bold text-slate-900 dark:text-slate-100 placeholder:text-slate-500" />
              <input value={pimForm.data_solicitacao} onChange={(e) => setPimForm((p) => ({ ...p, data_solicitacao: e.target.value }))} placeholder="Data Solicitação (AAAA-MM-DD)" className="w-full p-3 bg-white dark:bg-slate-950 border-2 border-slate-200 dark:border-slate-700 rounded-xl font-bold text-slate-900 dark:text-slate-100 placeholder:text-slate-500" />
              <input value={pimForm.pn} onChange={(e) => setPimForm((p) => ({ ...p, pn: e.target.value.toUpperCase() }))} placeholder="PN" className="w-full p-3 bg-white dark:bg-slate-950 border-2 border-slate-200 dark:border-slate-700 rounded-xl font-bold text-slate-900 dark:text-slate-100 placeholder:text-slate-500" />
              <input value={pimForm.nsn} onChange={(e) => setPimForm((p) => ({ ...p, nsn: e.target.value }))} placeholder="NSN" className="w-full p-3 bg-white dark:bg-slate-950 border-2 border-slate-200 dark:border-slate-700 rounded-xl font-bold text-slate-900 dark:text-slate-100 placeholder:text-slate-500" />
              <input type="number" min="0" step="0.01" value={pimForm.quantidade} onChange={(e) => setPimForm((p) => ({ ...p, quantidade: e.target.value }))} placeholder="Quantidade" className="w-full p-3 bg-white dark:bg-slate-950 border-2 border-slate-200 dark:border-slate-700 rounded-xl font-bold text-slate-900 dark:text-slate-100 placeholder:text-slate-500" />
              <input value={pimForm.os_vinculada} onChange={(e) => setPimForm((p) => ({ ...p, os_vinculada: e.target.value.toUpperCase() }))} placeholder="OS Vinculada" className="w-full p-3 bg-white dark:bg-slate-950 border-2 border-slate-200 dark:border-slate-700 rounded-xl font-bold text-slate-900 dark:text-slate-100 placeholder:text-slate-500" />
              <input value={pimForm.observacoes} onChange={(e) => setPimForm((p) => ({ ...p, observacoes: e.target.value }))} placeholder="Observações" className="w-full p-3 bg-white dark:bg-slate-950 border-2 border-slate-200 dark:border-slate-700 rounded-xl font-bold text-slate-900 dark:text-slate-100 placeholder:text-slate-500 md:col-span-2" />
            </div>
            <div className="flex justify-end gap-3">
              <button type="button" onClick={() => setPimForm(emptyPimForm)} className="px-6 py-3 rounded-xl bg-slate-100 dark:bg-slate-800 text-slate-900 dark:text-slate-100 font-black hover:bg-slate-200">LIMPAR</button>
              <button type="button" onClick={excluirPim} disabled={!pimForm.id || pimLoading} className="px-6 py-3 rounded-xl bg-red-600 text-white font-black hover:bg-red-700 disabled:opacity-50">EXCLUIR</button>
              <button type="submit" disabled={pimLoading} className="px-6 py-3 rounded-xl bg-emerald-600 text-white font-black hover:bg-emerald-700 disabled:opacity-50">{pimLoading ? 'SALVANDO...' : 'SALVAR PIM'}</button>
            </div>
            <Msg data={pimMsg} />
          </form>
        </div>
      )}

      {activeTab === 'politicas' && (
        <div className="grid grid-cols-1 xl:grid-cols-[1.1fr_0.9fr] gap-6">
          <div className="space-y-4">
            <input value={politicaSearch} onChange={(e) => setPoliticaSearch(e.target.value)} placeholder="Buscar tarefa ou tipo" className="w-full p-3 bg-white dark:bg-slate-950 border-2 border-slate-200 dark:border-slate-700 rounded-xl font-bold text-slate-900 dark:text-slate-100 placeholder:text-slate-500" />
            <div className="overflow-auto border border-slate-200 dark:border-slate-700 rounded-2xl max-h-[520px]">
              <table className="min-w-full text-sm">
                <thead className="bg-slate-100 dark:bg-slate-800 text-slate-800 dark:text-slate-200 uppercase text-xs">
                  <tr>
                    <th className="p-3 text-left">Tarefa</th>
                    <th className="p-3 text-left">Tipo</th>
                    <th className="p-3 text-left">Prioridade</th>
                    <th className="p-3 text-left">Qtde 2 Anos</th>
                    <th className="p-3 text-left">Ação</th>
                  </tr>
                </thead>
                <tbody className="text-slate-900 dark:text-slate-100">
                  {politicas.map((item) => (
                    <tr key={item.id} className="border-t border-slate-200 dark:border-slate-700">
                      <td className="p-3 font-bold">{item.tarefas}</td>
                      <td className="p-3">{item.tipo}</td>
                      <td className="p-3">{item.prioridade}</td>
                      <td className="p-3">{item.qtde_2_anos}</td>
                      <td className="p-3"><button onClick={() => setPoliticaForm({ id: item.id, tarefas: item.tarefas || '', tipo: item.tipo || 'Receita', prioridade: item.prioridade || '', qtde_2_anos: item.qtde_2_anos || '' })} className="px-3 py-2 rounded-xl bg-blue-600 text-white font-black hover:bg-blue-700">EDITAR</button></td>
                    </tr>
                  ))}
                  {politicas.length === 0 && <tr><td colSpan="5" className="p-4 font-bold text-slate-500">Nenhuma política encontrada.</td></tr>}
                </tbody>
              </table>
            </div>
          </div>

          <form onSubmit={salvarPolitica} className="border border-slate-200 dark:border-slate-700 rounded-2xl p-5 space-y-4">
            <h3 className="text-lg font-black text-slate-900 dark:text-slate-100 uppercase">Cadastro Manual de Política</h3>
            <div className="grid grid-cols-1 gap-4">
              <input value={politicaForm.tarefas} onChange={(e) => setPoliticaForm((p) => ({ ...p, tarefas: e.target.value }))} placeholder="Tarefa" className="w-full p-3 bg-white dark:bg-slate-950 border-2 border-slate-200 dark:border-slate-700 rounded-xl font-bold text-slate-900 dark:text-slate-100 placeholder:text-slate-500" />
              <select value={politicaForm.tipo} onChange={(e) => setPoliticaForm((p) => ({ ...p, tipo: e.target.value }))} className="w-full p-3 bg-white dark:bg-slate-950 border-2 border-slate-200 dark:border-slate-700 rounded-xl font-bold text-slate-900 dark:text-slate-100">
                <option value="Receita">Receita</option>
                <option value="PIM">PIM</option>
                <option value="Demanda Avulsa">Demanda Avulsa</option>
              </select>
              <input type="number" min="0" step="1" value={politicaForm.prioridade} onChange={(e) => setPoliticaForm((p) => ({ ...p, prioridade: e.target.value }))} placeholder="Prioridade" className="w-full p-3 bg-white dark:bg-slate-950 border-2 border-slate-200 dark:border-slate-700 rounded-xl font-bold text-slate-900 dark:text-slate-100 placeholder:text-slate-500" />
              <input type="number" min="0" step="0.01" value={politicaForm.qtde_2_anos} onChange={(e) => setPoliticaForm((p) => ({ ...p, qtde_2_anos: e.target.value }))} placeholder="Qtde 2 anos" className="w-full p-3 bg-white dark:bg-slate-950 border-2 border-slate-200 dark:border-slate-700 rounded-xl font-bold text-slate-900 dark:text-slate-100 placeholder:text-slate-500" />
            </div>
            <div className="flex justify-end gap-3">
              <button type="button" onClick={() => setPoliticaForm(emptyPoliticaForm)} className="px-6 py-3 rounded-xl bg-slate-100 dark:bg-slate-800 text-slate-900 dark:text-slate-100 font-black hover:bg-slate-200">LIMPAR</button>
              <button type="button" onClick={excluirPolitica} disabled={!politicaForm.id || politicaLoading} className="px-6 py-3 rounded-xl bg-red-600 text-white font-black hover:bg-red-700 disabled:opacity-50">EXCLUIR</button>
              <button type="submit" disabled={politicaLoading} className="px-6 py-3 rounded-xl bg-emerald-600 text-white font-black hover:bg-emerald-700 disabled:opacity-50">{politicaLoading ? 'SALVANDO...' : 'SALVAR POLÍTICA'}</button>
            </div>
            <Msg data={politicaMsg} />
          </form>
        </div>
      )}
    </section>
  );
}
