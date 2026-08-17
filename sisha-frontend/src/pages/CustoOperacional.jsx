import React, { useEffect, useMemo, useState } from 'react';
import { Calculator, LoaderCircle, FileQuestion } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { apiFetch } from '../lib/api';
import CotacaoRequestModal from '../components/CotacaoRequestModal';

const moneyGbp = (value) => new Intl.NumberFormat('en-GB', { style: 'currency', currency: 'GBP' }).format(Number(value || 0));

function Dot({ active }) {
  return <span className={`inline-block w-2.5 h-2.5 rounded-full ${active ? 'bg-blue-600' : 'bg-slate-300'}`} />;
}

function ChipToggle({ active, onClick, children }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`px-3 py-2 rounded-xl text-xs font-black border transition-none ${active ? 'bg-blue-600 text-white border-blue-600' : 'bg-white dark:bg-slate-800 text-slate-700 dark:text-slate-200 border-slate-200 dark:border-slate-700 hover:border-blue-300 dark:hover:border-blue-500'}`}
    >
      {children}
    </button>
  );
}

export default function CustoOperacional() {
  const { token } = useAuth();
  const [loading, setLoading] = useState(true);
  const [previewing, setPreviewing] = useState(false);
  const [options, setOptions] = useState({ receitas: [], origens: [], sbs: [] });
  const [mode, setMode] = useState('prioritized');
  const [selectedReceitas, setSelectedReceitas] = useState([]);
  const [selectedOrigens, setSelectedOrigens] = useState([]);
  const [includePims, setIncludePims] = useState(true);
  const [sbMode, setSbMode] = useState('open');
  const [selectedSbs, setSelectedSbs] = useState([]);
  const [preview, setPreview] = useState(null);
  const [error, setError] = useState(null);
  const [quoteOpen, setQuoteOpen] = useState(false);

  useEffect(() => {
    const cacheKey = 'sisha.cost.options.v4';
    try {
      const cached = sessionStorage.getItem(cacheKey);
      if (cached) {
        const parsed = JSON.parse(cached);
        setOptions(parsed || { receitas: [], origens: [], sbs: [] });
        setLoading(false);
      }
    } catch {
      // Cache inválido não bloqueia a consulta ao backend.
    }

    const load = async () => {
      try {
        setLoading(true);
        setError(null);
        const response = await apiFetch('/needs/cost/options', {}, token);
        const json = await response.json();
        if (json.status !== 'success') throw new Error(json.message || 'Falha ao carregar filtros de custo.');
        setOptions(json.data || { receitas: [], origens: [], sbs: [] });
        sessionStorage.setItem(cacheKey, JSON.stringify(json.data || { receitas: [], origens: [], sbs: [] }));
      } catch (err) {
        setError(err.message || 'Falha ao carregar custo operacional.');
      } finally {
        setLoading(false);
      }
    };
    load();
  }, [token]);

  const toggleReceita = (inspecao) => setSelectedReceitas((current) => current.includes(inspecao) ? current.filter((item) => item !== inspecao) : [...current, inspecao]);
  const toggleOrigem = (key) => setSelectedOrigens((current) => current.includes(key) ? current.filter((item) => item !== key) : [...current, key]);
  const toggleSb = (sbNumero) => setSelectedSbs((current) => current.includes(sbNumero) ? current.filter((item) => item !== sbNumero) : [...current, sbNumero]);

  const selectedSbCount = useMemo(() => {
    if (sbMode === 'none') return 0;
    if (sbMode === 'open') return (options.sbs || []).filter((item) => item.aberta && item.possui_itens).length;
    if (sbMode === 'all') return (options.sbs || []).filter((item) => item.possui_itens).length;
    return selectedSbs.length;
  }, [options.sbs, sbMode, selectedSbs.length]);

  const buildPayload = () => ({
    mode,
    receitas: mode === 'custom' ? selectedReceitas : [],
    origens: selectedOrigens,
    incluirPims: includePims,
    sbMode,
    sbs: sbMode === 'custom' ? selectedSbs : [],
  });


  const missingQuoteItems = useMemo(() => (preview?.linhas || [])
    .filter((row) => row.necessita_cotacao || !(Number(row.valor_unitario_gbp) > 0))
    .map((row) => ({
      pn: row.pn,
      nsn: row.nsn,
      nomenclatura: row.nomenclatura,
      qtd: Number(row.qtd_planejada ?? row.qtd_unitaria ?? 0),
    }))
    .filter((row) => row.pn && row.qtd > 0), [preview]);

  const handlePreview = async () => {
    try {
      setPreviewing(true);
      setError(null);
      const response = await apiFetch('/needs/cost/preview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(buildPayload()),
      }, token);
      const json = await response.json();
      if (json.status !== 'success') throw new Error(json.message || 'Falha ao calcular custo.');
      setPreview(json.data);
    } catch (err) {
      setError(err.message || 'Falha ao calcular custo.');
    } finally {
      setPreviewing(false);
    }
  };

  return (
    <div className="space-y-8 animate-fade-in">
      <section className="bg-white dark:bg-slate-900 rounded-3xl border border-slate-200 dark:border-slate-800 shadow-sm p-8 space-y-6">
        <div className="flex flex-col lg:flex-row lg:items-start lg:justify-between gap-4">
          <div>
            <h1 className="text-2xl font-black text-slate-900 dark:text-slate-100 uppercase">Central de Custos</h1>
            <p className="text-sm text-slate-600 dark:text-slate-400 font-bold mt-2 max-w-3xl">
              A Central de Custos separa o custo de 1 execução da projeção logística e identifica a origem de cada preço. Price List vigente tem prioridade; referências vencidas ou históricas aparecem como estimativa e continuam elegíveis a nova cotação.
            </p>
          </div>
          <button type="button" onClick={handlePreview} disabled={loading || previewing} className="px-6 py-3 rounded-2xl bg-blue-600 text-white font-black hover:bg-blue-700 disabled:opacity-50 inline-flex items-center gap-2">
            {previewing ? <LoaderCircle size={18} className="animate-spin" /> : <Calculator size={18} />} CALCULAR
          </button>
        </div>

        {error ? <div className="rounded-2xl border border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-950/30 px-4 py-3 text-red-700 dark:text-red-300 font-bold">{error}</div> : null}

        <div className="grid grid-cols-1 xl:grid-cols-3 gap-6">
          <div className="space-y-3">
            <p className="text-xs uppercase tracking-[0.2em] text-slate-400 font-black">Receitas</p>
            <div className="flex gap-2 flex-wrap">
              <ChipToggle active={mode === 'prioritized'} onClick={() => setMode('prioritized')}>Priorizadas</ChipToggle>
              <ChipToggle active={mode === 'all'} onClick={() => setMode('all')}>Todas</ChipToggle>
              <ChipToggle active={mode === 'custom'} onClick={() => setMode('custom')}>Seleção manual</ChipToggle>
            </div>
            {mode === 'custom' ? (
              <div className="max-h-52 overflow-auto rounded-2xl border border-slate-200 dark:border-slate-800 p-3 space-y-2">
                {(options.receitas || []).map((item) => (
                  <label key={item.inspecao} className="flex items-center justify-between gap-3 text-sm font-bold text-slate-700 dark:text-slate-300">
                    <span>{item.inspecao}</span>
                    <input type="checkbox" checked={selectedReceitas.includes(item.inspecao)} onChange={() => toggleReceita(item.inspecao)} />
                  </label>
                ))}
              </div>
            ) : (
              <p className="text-sm font-bold text-slate-500 dark:text-slate-400">
                {mode === 'prioritized' ? 'Serão usadas as receitas priorizadas pela política.' : 'Todas as receitas entram no cálculo.'}
              </p>
            )}
          </div>

          <div className="space-y-3">
            <div className="flex items-center justify-between gap-3">
              <p className="text-xs uppercase tracking-[0.2em] text-slate-400 font-black">Aeronaves / Oficinas</p>
              <label className="inline-flex items-center gap-2 text-xs font-black text-slate-600 dark:text-slate-400 uppercase tracking-[0.15em]">
                <input type="checkbox" checked={includePims} onChange={(e) => setIncludePims(e.target.checked)} /> incluir PIMs
              </label>
            </div>
            <div className="max-h-52 overflow-auto rounded-2xl border border-slate-200 dark:border-slate-800 p-3 space-y-2">
              {(options.origens || []).map((item) => (
                <label key={item.key} className="flex items-center justify-between gap-3 text-sm font-bold text-slate-700 dark:text-slate-300">
                  <span>{item.label}</span>
                  <input type="checkbox" checked={selectedOrigens.includes(item.key)} onChange={() => toggleOrigem(item.key)} />
                </label>
              ))}
            </div>
          </div>

          <div className="space-y-3">
            <p className="text-xs uppercase tracking-[0.2em] text-slate-400 font-black">Service Bulletins</p>
            <div className="flex gap-2 flex-wrap">
              <ChipToggle active={sbMode === 'open'} onClick={() => setSbMode('open')}>SB abertas</ChipToggle>
              <ChipToggle active={sbMode === 'all'} onClick={() => setSbMode('all')}>Todas com itens</ChipToggle>
              <ChipToggle active={sbMode === 'custom'} onClick={() => setSbMode('custom')}>Seleção manual</ChipToggle>
              <ChipToggle active={sbMode === 'none'} onClick={() => setSbMode('none')}>Sem SB</ChipToggle>
            </div>
            {sbMode === 'custom' ? (
              <div className="max-h-52 overflow-auto rounded-2xl border border-slate-200 dark:border-slate-800 p-3 space-y-2">
                {(options.sbs || []).filter((item) => item.possui_itens).map((item) => (
                  <label key={item.sb_numero} className="flex items-start justify-between gap-3 text-sm font-bold text-slate-700 dark:text-slate-300">
                    <span>
                      <span className="block">{item.sb_numero}</span>
                      <span className="block text-xs text-slate-500 dark:text-slate-400">{item.titulo}</span>
                    </span>
                    <input type="checkbox" checked={selectedSbs.includes(item.sb_numero)} onChange={() => toggleSb(item.sb_numero)} />
                  </label>
                ))}
              </div>
            ) : (
              <p className="text-sm font-bold text-slate-500 dark:text-slate-400">{sbMode === 'none' ? 'SBs fora desta simulação.' : `${selectedSbCount} SB(s) entrarão na análise.`}</p>
            )}
          </div>
        </div>
      </section>

      {preview ? (
        <section className="bg-white dark:bg-slate-900 rounded-3xl border border-slate-200 dark:border-slate-800 shadow-sm overflow-hidden">
          <div className="px-6 py-4 border-b border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-800/80 grid grid-cols-1 md:grid-cols-5 gap-4">
            <div>
              <p className="text-[11px] uppercase tracking-[0.2em] text-slate-400 font-black">Receitas + SBs</p>
              <p className="text-2xl font-black text-slate-900 dark:text-slate-100 mt-1">{preview.summary.receitas_selecionadas} / {preview.summary.sbs_selecionadas}</p>
            </div>
            <div>
              <p className="text-[11px] uppercase tracking-[0.2em] text-slate-400 font-black">Origens filtradas</p>
              <p className="text-2xl font-black text-slate-900 dark:text-slate-100 mt-1">{preview.summary.origens_selecionadas}</p>
            </div>
            <div>
              <p className="text-[11px] uppercase tracking-[0.2em] text-slate-400 font-black">Custo 1 execução</p>
              <p className="text-2xl font-black text-slate-900 dark:text-slate-100 mt-1">{moneyGbp(preview.summary.custo_execucao_gbp ?? preview.summary.valor_total_gbp ?? 0)}</p>
            </div>
            <div>
              <p className="text-[11px] uppercase tracking-[0.2em] text-slate-400 font-black">Projeção 2 anos</p>
              <p className="text-2xl font-black text-slate-900 dark:text-slate-100 mt-1">{moneyGbp(preview.summary.custo_projetado_gbp || 0)}</p>
            </div>
            <div>
              <p className="text-[11px] uppercase tracking-[0.2em] text-slate-400 font-black">Preços a atualizar</p>
              <p className="text-2xl font-black text-slate-900 dark:text-slate-100 mt-1">{preview.summary.pns_precisam_cotacao ?? preview.summary.pns_sem_valor}</p>
              <p className="text-[10px] uppercase tracking-[0.12em] text-slate-400 font-black mt-1">sem preço: {preview.summary.pns_sem_valor} • estimativas: {preview.summary.pns_com_estimativa ?? 0}</p>
            </div>
          </div>

          {missingQuoteItems.length > 0 ? (
            <div className="px-6 py-4 border-b border-slate-200 dark:border-slate-800 flex justify-end">
              <button type="button" onClick={() => setQuoteOpen(true)} className="px-5 py-3 rounded-2xl bg-slate-700 hover:bg-slate-600 text-white font-black inline-flex items-center gap-2">
                <FileQuestion size={18} /> SOLICITAR COTAÇÃO ({missingQuoteItems.length})
              </button>
            </div>
          ) : null}

          <div className="overflow-auto">
            <table className="min-w-full text-sm">
              <thead className="bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-300 uppercase text-[11px] tracking-wider">
                <tr>
                  <th className="p-3 text-left">PN</th>
                  <th className="p-3 text-left">Nomenclatura</th>
                  <th className="p-3 text-left">Origem</th>
                  <th className="p-3 text-left">Qtd 1 execução</th>
                  <th className="p-3 text-left">Qtd projetada</th>
                  <th className="p-3 text-left">Fonte do valor</th>
                  <th className="p-3 text-left">Valor unitário</th>
                  <th className="p-3 text-left">Custo 1 execução</th>
                  <th className="p-3 text-left">Projeção 2 anos</th>
                </tr>
              </thead>
              <tbody>
                {preview.linhas.length === 0 ? (
                  <tr><td colSpan={9} className="p-6 text-center font-bold text-slate-500 dark:text-slate-400">Nenhum PN consolidado para os filtros selecionados.</td></tr>
                ) : preview.linhas.map((row) => (
                  <tr key={`${row.pn}-${row.origens_texto}-${row.receitas_texto}-${row.pims_texto}-${row.sbs_texto || ''}`} className="border-t border-slate-100 dark:border-slate-800 align-top">
                    <td className="p-3 font-black text-slate-900 dark:text-slate-100">{row.pn}</td>
                    <td className="p-3">
                      <div className="font-bold text-slate-900 dark:text-slate-100">{row.nomenclatura || '—'}</div>
                      <div className="text-xs text-slate-500 dark:text-slate-400 font-semibold">NSN: {row.nsn || '—'}</div>
                    </td>
                    <td className="p-3 font-bold text-slate-700 dark:text-slate-300">
                      <div>{row.receitas_texto || row.origens_texto || row.sbs_texto || '—'}</div>
                      <div className="text-xs text-slate-500 dark:text-slate-400 mt-1">{row.pims_texto || row.observacao || '—'}</div>
                    </td>
                    <td className="p-3 font-black text-slate-900 dark:text-slate-100">{row.qtd_unitaria ?? row.qtd_planejada}</td>
                    <td className="p-3 font-black text-slate-900 dark:text-slate-100">
                      <div>{row.qtd_planejada}</div>
                      {row.fator_planejado_texto ? <div className="text-[10px] uppercase tracking-[0.15em] text-slate-400 mt-1">fator {row.fator_planejado_texto}</div> : null}
                    </td>
                    <td className="p-3 font-bold text-slate-700 dark:text-slate-300"><div>{row.fonte_exibicao || row.fonte_valor || 'Sem referência'}</div>{row.preco_estimativa ? <div className="mt-1 text-[10px] uppercase tracking-[0.12em] font-black text-amber-600 dark:text-amber-300">Estimativa • atualizar cotação</div> : null}{row.documento_fonte ? <div className="mt-1 text-[10px] font-semibold text-slate-400">{row.documento_fonte}{row.data_referencia ? ` • ${row.data_referencia}` : ''}</div> : null}</td>
                    <td className="p-3 font-black text-slate-900 dark:text-slate-100">{row.valor_unitario_gbp != null ? moneyGbp(row.valor_unitario_gbp) : '—'}</td>
                    <td className="p-3 font-black text-slate-900 dark:text-slate-100">{row.valor_execucao_gbp != null ? moneyGbp(row.valor_execucao_gbp) : (row.valor_total_gbp != null ? moneyGbp(row.valor_total_gbp) : '—')}</td>
                    <td className="p-3 font-black text-slate-900 dark:text-slate-100">{row.valor_planejado_gbp != null ? moneyGbp(row.valor_planejado_gbp) : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="px-6 py-4 border-t border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-800/80 text-xs font-bold text-slate-500 dark:text-slate-400 flex items-center gap-2">
            <Dot active /> Custo 1 execução = quantidade da receita x valor unitário. Projeção 2 anos = custo unitário x política de estoque. Hierarquia: Price List/carta oficial → cotação válida → cotação vencida → recibo. Cotação vencida e recibo são estimativas e permanecem elegíveis a nova cotação.
          </div>
        </section>
      ) : null}

      <CotacaoRequestModal
        open={quoteOpen}
        onClose={() => setQuoteOpen(false)}
        token={token}
        source="CUSTO_OPERACIONAL"
        items={missingQuoteItems}
      />
    </div>
  );
}
