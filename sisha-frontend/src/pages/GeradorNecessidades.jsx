import React, { useEffect, useMemo, useState } from 'react';
import { Download, LoaderCircle, PackageCheck, ShieldAlert, FileText } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { apiFetch, buildAuthHeaders } from '../lib/api';

const numberBr = (value) => Number(value || 0).toLocaleString('pt-BR');
const moneyGbp = (value) => new Intl.NumberFormat('en-GB', { style: 'currency', currency: 'GBP' }).format(Number(value || 0));

function SummaryCard({ title, value, subtitle, icon: Icon }) {
  return (
    <div className="bg-white rounded-3xl border border-slate-200 shadow-sm p-6 flex items-start justify-between gap-4">
      <div>
        <p className="text-[11px] uppercase tracking-[0.2em] text-slate-400 font-black">{title}</p>
        <p className="text-3xl font-black text-slate-900 mt-2">{value}</p>
        {subtitle ? <p className="text-sm text-slate-600 mt-2 font-bold">{subtitle}</p> : null}
      </div>
      <div className="p-4 rounded-2xl bg-slate-100 text-slate-500"><Icon size={24} /></div>
    </div>
  );
}

function ChipToggle({ active, onClick, children }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`px-3 py-2 rounded-xl text-xs font-black border transition-none ${active ? 'bg-blue-600 text-white border-blue-600' : 'bg-white text-slate-700 border-slate-200 hover:border-blue-300'}`}
    >
      {children}
    </button>
  );
}

function CoverageTable({ title, rows, type = 'coverage' }) {
  return (
    <section className="bg-white rounded-3xl border border-slate-200 shadow-sm overflow-hidden">
      <div className="px-6 py-4 border-b border-slate-200 bg-slate-50">
        <h3 className="text-lg font-black text-slate-900 uppercase">{title}</h3>
        <p className="text-sm font-bold text-slate-500">{rows.length} linha(s)</p>
      </div>
      <div className="overflow-auto">
        <table className="min-w-full text-sm">
          <thead className="bg-slate-100 text-slate-700 uppercase text-[11px] tracking-wider">
            <tr>
              <th className="p-3 text-left">PN</th>
              <th className="p-3 text-left">Nomenclatura</th>
              <th className="p-3 text-left">Necessidade</th>
              {type === 'coverage' ? <th className="p-3 text-left">Cobertura</th> : null}
              <th className="p-3 text-left">Saldo</th>
              <th className="p-3 text-left">Origem</th>
              <th className="p-3 text-left">Referência</th>
              {type !== 'coverage' ? <th className="p-3 text-left">GBP</th> : null}
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr><td colSpan={type === 'coverage' ? 7 : 8} className="p-6 text-center font-bold text-slate-500">Nenhuma linha nesta etapa.</td></tr>
            ) : rows.map((row) => {
              const rowTone = row.row_tone === 'full'
                ? 'bg-emerald-50'
                : row.row_tone === 'partial'
                  ? 'bg-white'
                  : row.row_tone === 'buy'
                    ? 'bg-amber-50/40'
                    : 'bg-white';

              return (
                <tr key={`${title}-${row.pn}-${row.observacao}-${row.origens_texto}`} className={`border-t border-slate-100 align-top ${rowTone}`}>
                  <td className="p-3 font-black text-slate-900">{row.pn}</td>
                  <td className="p-3">
                    <div className="font-bold text-slate-900">{row.nomenclatura || '—'}</div>
                    <div className="text-xs text-slate-500 font-semibold">NSN: {row.nsn || '—'}</div>
                  </td>
                  <td className="p-3 font-black text-slate-900">{numberBr(row.necessidade_total)}</td>
                  {type === 'coverage' ? <td className="p-3 font-black text-emerald-700">{numberBr(row.cobertura_etapa)}</td> : null}
                  <td className="p-3 font-black text-amber-700">{numberBr(row.saldo_apos_etapa)}</td>
                  <td className="p-3">
                    <div className="font-bold text-slate-800">{row.receitas_texto || row.origens_texto || '—'}</div>
                    <div className="text-xs text-slate-500 font-semibold">{row.pims_texto || row.observacao || '—'}</div>
                  </td>
                  <td className="p-3 text-xs font-semibold text-slate-600 whitespace-pre-wrap">{row.documento_referencia || '—'}</td>
                  {type !== 'coverage' ? (
                    <td className="p-3 font-black text-slate-900">
                      <div>{row.valor_unitario_gbp != null ? moneyGbp(row.valor_unitario_gbp) : '—'}</div>
                      <div className="text-xs text-slate-500">{row.valor_total_gbp != null ? moneyGbp(row.valor_total_gbp) : '—'}</div>
                    </td>
                  ) : null}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}

export default function GeradorNecessidades() {
  const { token } = useAuth();
  const [loadingOptions, setLoadingOptions] = useState(true);
  const [loadingPreview, setLoadingPreview] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [error, setError] = useState(null);
  const [options, setOptions] = useState({ receitas: [], origens: [], sbs: [] });
  const [mode, setMode] = useState('prioritized');
  const [selectedReceitas, setSelectedReceitas] = useState([]);
  const [selectedOrigens, setSelectedOrigens] = useState([]);
  const [includePims, setIncludePims] = useState(true);
  const [sbMode, setSbMode] = useState('open');
  const [selectedSbs, setSelectedSbs] = useState([]);
  const [preview, setPreview] = useState(null);

  useEffect(() => {
    const cacheKey = 'sisha.needs.options.v4';
    try {
      const cached = sessionStorage.getItem(cacheKey);
      if (cached) {
        const parsed = JSON.parse(cached);
        setOptions(parsed || { receitas: [], origens: [], sbs: [] });
        setLoadingOptions(false);
      }
    } catch (_) {}

    const loadOptions = async () => {
      try {
        setError(null);
        const response = await apiFetch('/needs/generator/options', {}, token);
        const json = await response.json();
        if (json.status !== 'success') throw new Error(json.message || 'Falha ao carregar filtros.');
        setOptions(json.data || { receitas: [], origens: [], sbs: [] });
        sessionStorage.setItem(cacheKey, JSON.stringify(json.data || { receitas: [], origens: [], sbs: [] }));
      } catch (err) {
        setError(err.message || 'Falha ao carregar filtros do gerador.');
      } finally {
        setLoadingOptions(false);
      }
    };
    loadOptions();
  }, [token]);

  const buildPayload = () => ({
    mode,
    receitas: mode === 'custom' ? selectedReceitas : [],
    origens: selectedOrigens,
    incluirPims: includePims,
    sbMode,
    sbs: sbMode === 'custom' ? selectedSbs : [],
  });

  const toggleReceita = (inspecao) => setSelectedReceitas((current) => current.includes(inspecao) ? current.filter((item) => item !== inspecao) : [...current, inspecao]);
  const toggleOrigem = (key) => setSelectedOrigens((current) => current.includes(key) ? current.filter((item) => item !== key) : [...current, key]);
  const toggleSb = (sbNumero) => setSelectedSbs((current) => current.includes(sbNumero) ? current.filter((item) => item !== sbNumero) : [...current, sbNumero]);

  const selectedSbCount = useMemo(() => {
    if (sbMode === 'none') return 0;
    if (sbMode === 'open') return (options.sbs || []).filter((item) => item.aberta && item.possui_itens).length;
    if (sbMode === 'all') return (options.sbs || []).filter((item) => item.possui_itens).length;
    return selectedSbs.length;
  }, [options.sbs, sbMode, selectedSbs.length]);

  const handlePreview = async () => {
    try {
      setLoadingPreview(true);
      setError(null);
      const response = await apiFetch('/needs/generator/preview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(buildPayload()),
      }, token);
      const json = await response.json();
      if (json.status !== 'success') throw new Error(json.message || 'Falha ao gerar prévia.');
      setPreview(json.data);
    } catch (err) {
      setError(err.message || 'Falha ao gerar prévia.');
    } finally {
      setLoadingPreview(false);
    }
  };

  const handleExport = async () => {
    try {
      setExporting(true);
      setError(null);
      const response = await apiFetch('/needs/generator/export/xlsx', {
        method: 'POST',
        headers: buildAuthHeaders(token, { 'Content-Type': 'application/json' }),
        body: JSON.stringify(buildPayload()),
      }, token);
      if (!response.ok) {
        const json = await response.json().catch(() => null);
        throw new Error(json?.message || 'Falha ao exportar Excel.');
      }
      const blob = await response.blob();
      const url = window.URL.createObjectURL(blob);
      const link = document.createElement('a');
      const disposition = response.headers.get('Content-Disposition') || '';
      const match = disposition.match(/filename="([^"]+)"/);
      link.href = url;
      link.download = match?.[1] || 'gerador_necessidades.xlsx';
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.URL.revokeObjectURL(url);
    } catch (err) {
      setError(err.message || 'Falha ao exportar Excel.');
    } finally {
      setExporting(false);
    }
  };

  return (
    <div className="space-y-8 animate-fade-in">
      <section className="bg-white rounded-3xl border border-slate-200 shadow-sm p-8 space-y-6">
        <div className="flex flex-col xl:flex-row xl:items-start xl:justify-between gap-6">
          <div>
            <h1 className="text-2xl font-black text-slate-900 uppercase">Gerador de Necessidades</h1>
            <p className="text-sm text-slate-600 font-bold mt-2 max-w-3xl">
              Agora o Gerador aceita Receitas, PIMs e SBs. A cascata operacional segue PPU → CeIMSPA → ODA → Price List → ODC → Comprar.
            </p>
          </div>
          <div className="flex gap-3 flex-wrap">
            <button type="button" onClick={handlePreview} disabled={loadingOptions || loadingPreview} className="px-6 py-3 rounded-2xl bg-blue-600 text-white font-black hover:bg-blue-700 disabled:opacity-50 inline-flex items-center gap-2">
              {loadingPreview ? <LoaderCircle size={18} className="animate-spin" /> : <PackageCheck size={18} />} GERAR PRÉVIA
            </button>
            <button type="button" onClick={handleExport} disabled={loadingOptions || exporting} className="px-6 py-3 rounded-2xl bg-emerald-600 text-white font-black hover:bg-emerald-700 disabled:opacity-50 inline-flex items-center gap-2">
              <Download size={18} /> {exporting ? 'EXPORTANDO...' : 'EXPORTAR EXCEL'}
            </button>
          </div>
        </div>

        {error ? <div className="rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-red-700 font-bold">{error}</div> : null}

        <div className="grid grid-cols-1 xl:grid-cols-3 gap-6">
          <div className="space-y-3">
            <p className="text-xs uppercase tracking-[0.2em] text-slate-400 font-black">Receitas</p>
            <div className="flex gap-2 flex-wrap">
              <ChipToggle active={mode === 'prioritized'} onClick={() => setMode('prioritized')}>Priorizadas</ChipToggle>
              <ChipToggle active={mode === 'all'} onClick={() => setMode('all')}>Todas</ChipToggle>
              <ChipToggle active={mode === 'custom'} onClick={() => setMode('custom')}>Seleção manual</ChipToggle>
            </div>
            {mode === 'custom' ? (
              <div className="max-h-52 overflow-auto rounded-2xl border border-slate-200 p-3 space-y-2">
                {(options.receitas || []).map((item) => (
                  <label key={item.inspecao} className="flex items-center justify-between gap-3 text-sm font-bold text-slate-700">
                    <span>{item.inspecao}</span>
                    <input type="checkbox" checked={selectedReceitas.includes(item.inspecao)} onChange={() => toggleReceita(item.inspecao)} />
                  </label>
                ))}
              </div>
            ) : <p className="text-sm font-bold text-slate-500">{mode === 'prioritized' ? 'Receitas com política/priorização aplicada.' : 'Todas as receitas cadastradas.'}</p>}
          </div>

          <div className="space-y-3">
            <p className="text-xs uppercase tracking-[0.2em] text-slate-400 font-black">PIMs / Origem</p>
            <label className="inline-flex items-center gap-2 text-sm font-black text-slate-700"><input type="checkbox" checked={includePims} onChange={(e) => setIncludePims(e.target.checked)} /> Incluir PIMs</label>
            <div className="max-h-52 overflow-auto rounded-2xl border border-slate-200 p-3 space-y-2">
              {(options.origens || []).map((item) => (
                <label key={item.key} className="flex items-center justify-between gap-3 text-sm font-bold text-slate-700">
                  <span>{item.label}</span>
                  <input type="checkbox" checked={selectedOrigens.includes(item.key)} onChange={() => toggleOrigem(item.key)} disabled={!includePims} />
                </label>
              ))}
            </div>
          </div>

          <div className="space-y-3">
            <p className="text-xs uppercase tracking-[0.2em] text-slate-400 font-black">Service Bulletins</p>
            <div className="flex gap-2 flex-wrap">
              <ChipToggle active={sbMode === 'open'} onClick={() => setSbMode('open')}>Abertas</ChipToggle>
              <ChipToggle active={sbMode === 'all'} onClick={() => setSbMode('all')}>Todas com itens</ChipToggle>
              <ChipToggle active={sbMode === 'custom'} onClick={() => setSbMode('custom')}>Seleção manual</ChipToggle>
              <ChipToggle active={sbMode === 'none'} onClick={() => setSbMode('none')}>Sem SB</ChipToggle>
            </div>
            {sbMode === 'custom' ? (
              <div className="max-h-52 overflow-auto rounded-2xl border border-slate-200 p-3 space-y-2">
                {(options.sbs || []).filter((item) => item.possui_itens).map((item) => (
                  <label key={item.sb_numero} className="flex items-start justify-between gap-3 text-sm font-bold text-slate-700">
                    <span>
                      <span className="block">{item.sb_numero}</span>
                      <span className="block text-xs text-slate-500">{item.titulo}</span>
                    </span>
                    <input type="checkbox" checked={selectedSbs.includes(item.sb_numero)} onChange={() => toggleSb(item.sb_numero)} />
                  </label>
                ))}
              </div>
            ) : (
              <p className="text-sm font-bold text-slate-500">{sbMode === 'none' ? 'SBs fora desta simulação.' : `${selectedSbCount} SB(s) entrarão na análise.`}</p>
            )}
          </div>
        </div>
      </section>

      {preview ? (
        <>
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-6">
            <SummaryCard title="Necessidade total" value={numberBr(preview.summary.necessidade_total)} subtitle={`${preview.summary.linhas_base} PN(s) consolidados`} icon={ShieldAlert} />
            <SummaryCard title="Coberto PPU + CeIMSPA" value={numberBr((preview.summary.coberto_ppu || 0) + (preview.summary.coberto_ceimspa || 0))} subtitle={`PPU ${numberBr(preview.summary.coberto_ppu)} • CeIMSPA ${numberBr(preview.summary.coberto_ceimspa)}`} icon={PackageCheck} />
            <SummaryCard title="Coberto ODA + ODC" value={numberBr((preview.summary.coberto_oda || 0) + (preview.summary.coberto_odc || 0))} subtitle={`ODA ${numberBr(preview.summary.coberto_oda)} • ODC ${numberBr(preview.summary.coberto_odc)}`} icon={FileText} />
            <SummaryCard title="Comprar" value={numberBr(preview.summary.comprar_qtd)} subtitle={`Estimado ${moneyGbp(preview.summary.comprar_valor_gbp || 0)}`} icon={Download} />
          </div>

          <CoverageTable title="01 • PPU" rows={preview.sections.ppu || []} />
          <CoverageTable title="02 • CEIMSPA" rows={preview.sections.ceimspa || []} />
          <CoverageTable title="03 • ODA" rows={preview.sections.oda || []} />
          <CoverageTable title="04 • PRICE LIST" rows={preview.sections.pricelist || []} type="price" />
          <CoverageTable title="05 • ODC" rows={preview.sections.odc || []} />
          <CoverageTable title="06 • COMPRAR" rows={preview.sections.comprar || []} type="buy" />
        </>
      ) : null}
    </div>
  );
}
