import React, { useEffect, useMemo, useState } from 'react';
import { Download, LoaderCircle, PackageCheck, ShieldAlert, FileText, FileQuestion, BrainCircuit } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { apiFetch, buildAuthHeaders } from '../lib/api';
import CotacaoRequestModal from '../components/CotacaoRequestModal';
import LogisticsIntelligenceModal from '../components/LogisticsIntelligenceModal';

const numberBr = (value) => Number(value || 0).toLocaleString('pt-BR');
const moneyGbp = (value) => new Intl.NumberFormat('en-GB', { style: 'currency', currency: 'GBP' }).format(Number(value || 0));

function SummaryCard({ title, value, subtitle, icon }) {
  return (
    <div className="bg-white dark:bg-slate-900 rounded-3xl border border-slate-200 dark:border-slate-800 shadow-sm p-6 flex items-start justify-between gap-4">
      <div>
        <p className="text-[11px] uppercase tracking-[0.2em] text-slate-400 font-black">{title}</p>
        <p className="text-3xl font-black text-slate-900 dark:text-slate-100 mt-2">{value}</p>
        {subtitle ? <p className="text-sm text-slate-600 dark:text-slate-400 mt-2 font-bold">{subtitle}</p> : null}
      </div>
      <div className="p-4 rounded-2xl bg-slate-100 dark:bg-slate-800 text-slate-500 dark:text-slate-400">{React.createElement(icon, { size: 24 })}</div>
    </div>
  );
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

function CoverageTable({ title, rows, type = 'coverage' }) {
  return (
    <section className="bg-white dark:bg-slate-900 rounded-3xl border border-slate-200 dark:border-slate-800 shadow-sm overflow-hidden">
      <div className="px-6 py-4 border-b border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-800/80">
        <h3 className="text-lg font-black text-slate-900 dark:text-slate-100 uppercase">{title}</h3>
        <p className="text-sm font-bold text-slate-500 dark:text-slate-400">{rows.length} linha(s)</p>
      </div>
      <div className="overflow-auto">
        <table className="min-w-full text-sm">
          <thead className="bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-300 uppercase text-[11px] tracking-wider">
            <tr>
              <th className="p-3 text-left">PN</th>
              <th className="p-3 text-left">Nomenclatura</th>
              <th className="p-3 text-left">Necessidade</th>
              {type === 'coverage' ? <th className="p-3 text-left">Disponível</th> : null}
              <th className="p-3 text-left">Faltam</th>
              <th className="p-3 text-left">Origem</th>
              <th className="p-3 text-left">Referência</th>
              {type !== 'coverage' ? <th className="p-3 text-left">GBP</th> : null}
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr><td colSpan={type === 'coverage' ? 7 : 8} className="p-6 text-center font-bold text-slate-500 dark:text-slate-400">Nenhuma linha nesta etapa.</td></tr>
            ) : rows.map((row) => {
              const rowTone = row.row_tone === 'full'
                ? 'bg-emerald-50 dark:bg-emerald-950/20'
                : row.row_tone === 'partial'
                  ? 'bg-white dark:bg-slate-900'
                  : row.row_tone === 'buy'
                    ? 'bg-amber-50/40 dark:bg-amber-950/20'
                    : 'bg-white dark:bg-slate-900';

              return (
                <tr key={`${title}-${row.pn}-${row.observacao}-${row.origens_texto}`} className={`border-t border-slate-100 dark:border-slate-800 align-top ${rowTone}`}>
                  <td className="p-3 font-black text-slate-900 dark:text-slate-100">{row.pn}</td>
                  <td className="p-3">
                    <div className="font-bold text-slate-900 dark:text-slate-100">{row.nomenclatura || '—'}</div>
                    <div className="text-xs text-slate-500 dark:text-slate-400 font-semibold">NSN: {row.nsn || '—'}</div>
                  </td>
                  <td className="p-3 font-black text-slate-900 dark:text-slate-100">{numberBr(row.necessidade_total)}</td>
                  {type === 'coverage' ? <td className="p-3 font-black text-emerald-700 dark:text-emerald-300">{numberBr(row.disponivel_etapa ?? row.cobertura_etapa)}</td> : null}
                  <td className="p-3 font-black text-amber-700 dark:text-amber-300">{numberBr(row.faltam_apos_etapa ?? row.saldo_apos_etapa)}</td>
                  <td className="p-3">
                    <div className="font-bold text-slate-800 dark:text-slate-200">{row.receitas_texto || row.origens_texto || '—'}</div>
                    <div className="text-xs text-slate-500 dark:text-slate-400 font-semibold">{row.pims_texto || row.observacao || '—'}</div>
                  </td>
                  <td className="p-3 text-xs font-semibold text-slate-600 dark:text-slate-400 whitespace-pre-wrap">{row.documento_referencia || '—'}</td>
                  {type !== 'coverage' ? (
                    <td className="p-3 font-black text-slate-900 dark:text-slate-100">
                      <div>{row.valor_unitario_gbp != null ? moneyGbp(row.valor_unitario_gbp) : '—'}</div>
                      <div className="text-xs text-slate-500 dark:text-slate-400">{row.valor_total_gbp != null ? moneyGbp(row.valor_total_gbp) : '—'}</div>
                      <div className="mt-1 text-[10px] font-semibold text-slate-400">{row.fonte_exibicao || row.fonte_valor || 'Sem referência'}</div>
                      {row.preco_estimativa ? <div className="mt-1 text-[10px] uppercase tracking-[0.12em] font-black text-amber-600 dark:text-amber-300">Estimativa • atualizar cotação</div> : null}
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


function BuyDecisionTable({ rows = [] }) {
  return (
    <section className="bg-white dark:bg-slate-900 rounded-3xl border border-slate-200 dark:border-slate-800 shadow-sm overflow-hidden">
      <div className="px-6 py-4 border-b border-slate-200 dark:border-slate-800 bg-amber-50 dark:bg-amber-950/20">
        <h3 className="text-lg font-black text-slate-900 dark:text-slate-100 uppercase">06 • COMPRAR — decisão de verba</h3>
        <p className="text-sm font-bold text-slate-600 dark:text-slate-400 mt-1">
          A comprar = necessidade total menos PPU, CeIMSPA e saldo ODA ainda a receber. ODC aparece como processo em andamento, mas não reduz a quantidade.
        </p>
      </div>
      <div className="overflow-auto">
        <table className="min-w-[1650px] w-full text-sm">
          <thead className="bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-300 uppercase text-[10px] tracking-wider">
            <tr>
              <th className="p-3 text-left">PN</th>
              <th className="p-3 text-left">Nomenclatura</th>
              <th className="p-3 text-left">Necessidade total</th>
              <th className="p-3 text-left">Política 2 anos</th>
              <th className="p-3 text-left">PPU</th>
              <th className="p-3 text-left">CeIMSPA</th>
              <th className="p-3 text-left">ODA a receber</th>
              <th className="p-3 text-left">ODC em andamento</th>
              <th className="p-3 text-left">Cobertura</th>
              <th className="p-3 text-left">Comprar</th>
              <th className="p-3 text-left">Déficit política</th>
              <th className="p-3 text-left">Receitas / motivo</th>
              <th className="p-3 text-left">Valor estimado</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr><td colSpan={13} className="p-6 text-center font-bold text-slate-500 dark:text-slate-400">Nenhuma aquisição necessária nesta simulação.</td></tr>
            ) : rows.map((row) => (
              <tr key={`buy-${row.pn}`} className="border-t border-slate-100 dark:border-slate-800 align-top bg-amber-50/30 dark:bg-amber-950/10">
                <td className="p-3 font-black text-slate-900 dark:text-slate-100">{row.pn}</td>
                <td className="p-3">
                  <div className="font-bold text-slate-900 dark:text-slate-100">{row.nomenclatura || '—'}</div>
                  <div className="text-xs font-semibold text-slate-500">NSN: {row.nsn || '—'}</div>
                </td>
                <td className="p-3 font-black">{numberBr(row.necessidade_total_gerador ?? row.necessidade_total)}</td>
                <td className="p-3 font-black text-indigo-700 dark:text-indigo-300">{numberBr(row.necessidade_politica_2_anos)}</td>
                <td className="p-3 font-black text-emerald-700 dark:text-emerald-300">{numberBr(row.ppu_disponivel)}</td>
                <td className="p-3 font-black text-purple-700 dark:text-purple-300">{numberBr(row.ceimspa_disponivel)}</td>
                <td className="p-3 font-black text-blue-700 dark:text-blue-300">{numberBr(row.oda_a_receber)}</td>
                <td className="p-3">
                  <div className="font-black text-orange-700 dark:text-orange-300">{numberBr(row.odc_em_andamento)}</div>
                  {Number(row.odc_em_andamento || 0) > 0 ? <div className="mt-1 text-[10px] font-black uppercase text-orange-600">Não abate • priorizar suplementação</div> : null}
                </td>
                <td className="p-3">
                  <div className="font-black">{numberBr(row.cobertura_total_efetiva)}</div>
                  <div className="text-[10px] font-black text-slate-500">{numberBr(row.cobertura_percentual)}%</div>
                </td>
                <td className="p-3 font-black text-amber-800 dark:text-amber-200 text-lg">{numberBr(row.deficit_liquido ?? row.faltam_apos_etapa)}</td>
                <td className="p-3 font-black text-red-700 dark:text-red-300">{numberBr(row.deficit_politica_2_anos)}</td>
                <td className="p-3 max-w-[360px]">
                  <div className="text-xs font-bold text-slate-700 dark:text-slate-300">{row.politica_receitas_texto || row.receitas_texto || row.origens_texto || '—'}</div>
                  <div className="mt-1 text-[10px] font-semibold text-slate-500 whitespace-pre-wrap">{row.observacao || '—'}</div>
                  {row.documento_referencia ? <div className="mt-1 text-[10px] font-semibold text-orange-700 dark:text-orange-300">{row.documento_referencia}</div> : null}
                </td>
                <td className="p-3 font-black">
                  <div>{row.valor_total_gbp != null ? moneyGbp(row.valor_total_gbp) : '—'}</div>
                  <div className="text-[10px] text-slate-500">{row.valor_unitario_gbp != null ? `${moneyGbp(row.valor_unitario_gbp)} / un` : 'Sem referência'}</div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}


function RecipeDeficiencyPanel({ data }) {
  if (!data) return null;
  const summary = data.summary || {};
  const rows = data.deficient_rows || [];
  const blockers = data.blockers || [];

  return (
    <section className="bg-white dark:bg-slate-900 rounded-3xl border border-slate-200 dark:border-slate-800 shadow-sm overflow-hidden">
      <div className="px-6 py-5 border-b border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-800/80">
        <div className="flex flex-col xl:flex-row xl:items-start xl:justify-between gap-4">
          <div>
            <h3 className="text-lg font-black text-slate-900 dark:text-slate-100 uppercase">Deficiência automática — Política × Receita</h3>
            <p className="text-sm font-bold text-slate-500 dark:text-slate-400 mt-1 max-w-4xl">
              O SISHA consolida primeiro a necessidade de cada PN em todas as receitas selecionadas e só depois aplica a cobertura. Assim, o mesmo saldo do PPU não é reutilizado artificialmente em duas receitas.
            </p>
          </div>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-2 min-w-fit">
            <div className="rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-3 py-2">
              <p className="text-[10px] uppercase font-black text-slate-400">Receitas afetadas</p>
              <p className="text-xl font-black text-slate-900 dark:text-slate-100">{numberBr(summary.receitas_deficientes)}</p>
            </div>
            <div className="rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-3 py-2">
              <p className="text-[10px] uppercase font-black text-slate-400">PNs deficientes</p>
              <p className="text-xl font-black text-slate-900 dark:text-slate-100">{numberBr(summary.pns_deficientes)}</p>
            </div>
            <div className="rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-3 py-2">
              <p className="text-[10px] uppercase font-black text-slate-400">Necessidade 2 anos</p>
              <p className="text-xl font-black text-slate-900 dark:text-slate-100">{numberBr(summary.necessidade_2_anos)}</p>
            </div>
            <div className="rounded-xl border border-amber-200 dark:border-amber-800 bg-amber-50 dark:bg-amber-950/20 px-3 py-2">
              <p className="text-[10px] uppercase font-black text-amber-700 dark:text-amber-300">Déficit a providenciar</p>
              <p className="text-xl font-black text-amber-800 dark:text-amber-200">{numberBr(summary.deficit_a_providenciar)}</p>
            </div>
          </div>
        </div>
      </div>

      {rows.length === 0 ? (
        <div className="p-6 text-sm font-bold text-emerald-700 dark:text-emerald-300">
          Nenhuma deficiência de aquisição nas receitas/políticas selecionadas. PPU, CeIMSPA e saldo ODA a receber já cobrem a quantidade planejada; eventuais riscos de prazo do ODA continuam sinalizados separadamente.
        </div>
      ) : (
        <div className="overflow-auto">
          <table className="min-w-[1280px] w-full text-sm">
            <thead className="bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-300 uppercase text-[10px] tracking-wider">
              <tr>
                <th className="p-3 text-left">PN</th>
                <th className="p-3 text-left">Nomenclatura</th>
                <th className="p-3 text-left">Política × Receita</th>
                <th className="p-3 text-left">Necessidade 2 anos</th>
                <th className="p-3 text-left">PPU efetivo</th>
                <th className="p-3 text-left">CeIMSPA</th>
                <th className="p-3 text-left">ODA c/ previsão</th>
                <th className="p-3 text-left">ODA s/ data</th>
                <th className="p-3 text-left">ODC em andamento</th>
                <th className="p-3 text-left">Déficit a providenciar</th>
                <th className="p-3 text-left">Cobertura</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={`def-${row.pn}`} className="border-t border-slate-100 dark:border-slate-800 align-top bg-amber-50/30 dark:bg-amber-950/10">
                  <td className="p-3 font-black text-slate-900 dark:text-slate-100">{row.pn}</td>
                  <td className="p-3">
                    <div className="font-bold text-slate-900 dark:text-slate-100">{row.nomenclatura || '—'}</div>
                    <div className="text-xs text-slate-500 dark:text-slate-400 font-semibold">NSN: {row.nsn || '—'} • Prioridade: {row.prioridade_mais_alta || '—'}</div>
                  </td>
                  <td className="p-3 text-xs font-semibold text-slate-700 dark:text-slate-300 whitespace-pre-wrap max-w-[360px]">{row.receitas_texto || '—'}</td>
                  <td className="p-3 font-black">{numberBr(row.necessidade_2_anos)}</td>
                  <td className="p-3 font-black text-emerald-700 dark:text-emerald-300">{numberBr(row.ppu_efetivo)}</td>
                  <td className="p-3 font-black text-purple-700 dark:text-purple-300">{numberBr(row.ceimspa_disponivel)}</td>
                  <td className="p-3 font-black text-blue-700 dark:text-blue-300">{numberBr(row.oda_no_horizonte)}</td>
                  <td className="p-3 font-black text-slate-700 dark:text-slate-300">{numberBr(row.oda_sem_data)}</td>
                  <td className="p-3 font-black text-orange-700 dark:text-orange-300">{numberBr(row.odc_em_andamento)}</td>
                  <td className="p-3 font-black text-amber-800 dark:text-amber-200">{numberBr(row.deficit_a_providenciar)}</td>
                  <td className="p-3">
                    <div className="font-black text-slate-900 dark:text-slate-100">{numberBr(row.cobertura_confirmada_percentual)}%</div>
                    <div className="text-[10px] uppercase font-black text-slate-500 dark:text-slate-400 mt-1">{String(row.status || '').replaceAll('_', ' ')}</div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {blockers.length > 0 ? (
        <div className="border-t border-slate-200 dark:border-slate-800 px-6 py-4 bg-red-50 dark:bg-red-950/20">
          <p className="text-xs font-black uppercase text-red-700 dark:text-red-300">{blockers.length} pendência(s) impedem cálculo automático completo</p>
          <div className="mt-2 space-y-1 text-xs font-semibold text-red-700 dark:text-red-300">
            {blockers.slice(0, 8).map((item, index) => <p key={`${item.receita}-${item.pn || 'sem-pn'}-${index}`}>• {item.receita || 'Receita'}{item.pn ? ` • PN ${item.pn}` : ''}: {item.detalhe}</p>)}
            {blockers.length > 8 ? <p>• Mais {blockers.length - 8} pendência(s) constam no Excel exportado.</p> : null}
          </div>
        </div>
      ) : null}

      <div className="border-t border-slate-200 dark:border-slate-800 px-6 py-4 text-xs font-semibold text-slate-500 dark:text-slate-400">
        Regra operacional: PPU e CeIMSPA representam disponibilidade atual; somente o saldo ODA ainda a receber reduz a nova aquisição. ODC permanece destacado como processo que precisa de suplementação/liberação, mas não abate a necessidade. FAT/EMB/REC ficam somente como histórico de material já entregue/recebido. O Excel preserva essa separação.
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
  const [includeProgrammed, setIncludeProgrammed] = useState(false);
  const [sbMode, setSbMode] = useState('open');
  const [selectedSbs, setSelectedSbs] = useState([]);
  const [preview, setPreview] = useState(null);
  const [quoteOpen, setQuoteOpen] = useState(false);
  const [intelligenceOpen, setIntelligenceOpen] = useState(false);

  useEffect(() => {
    const cacheKey = 'sisha.needs.options.v4';
    try {
      const cached = sessionStorage.getItem(cacheKey);
      if (cached) {
        const parsed = JSON.parse(cached);
        setOptions(parsed || { receitas: [], origens: [], sbs: [] });
        setLoadingOptions(false);
      }
    } catch {
      sessionStorage.removeItem(cacheKey);
    }

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
    incluirProgramadas: includeProgrammed,
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


  const missingQuoteItems = useMemo(() => (preview?.sections?.comprar || [])
    .filter((row) => row.necessita_cotacao || !(Number(row.valor_unitario_gbp) > 0))
    .map((row) => ({
      pn: row.pn,
      nsn: row.nsn,
      nomenclatura: row.nomenclatura,
      qtd: Number(row.faltam_apos_etapa ?? row.saldo_apos_etapa ?? row.necessidade_total ?? 0),
    }))
    .filter((row) => row.pn && row.qtd > 0), [preview]);

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
      <section className="bg-white dark:bg-slate-900 rounded-3xl border border-slate-200 dark:border-slate-800 shadow-sm p-8 space-y-6">
        <div className="flex flex-col xl:flex-row xl:items-start xl:justify-between gap-6">
          <div>
            <h1 className="text-2xl font-black text-slate-900 dark:text-slate-100 uppercase">Gerador de Necessidades</h1>
            <p className="text-sm text-slate-600 dark:text-slate-400 font-bold mt-2 max-w-3xl">
              O Gerador cruza Receitas, Política, PIMs e SBs. Para aquisição, a cobertura é PPU → CeIMSPA → saldo ODA a receber. ODC fica em evidência como processo em andamento, sem abater a necessidade.
            </p>
          </div>
          <div className="flex gap-3 flex-wrap">
            <button type="button" onClick={handlePreview} disabled={loadingOptions || loadingPreview} className="px-6 py-3 rounded-2xl bg-blue-600 text-white font-black hover:bg-blue-700 disabled:opacity-50 inline-flex items-center gap-2">
              {loadingPreview ? <LoaderCircle size={18} className="animate-spin" /> : <PackageCheck size={18} />} GERAR PRÉVIA
            </button>
            <button type="button" onClick={handleExport} disabled={loadingOptions || exporting} className="px-6 py-3 rounded-2xl bg-slate-700 text-white font-black hover:bg-slate-600 dark:bg-slate-700 dark:hover:bg-slate-600 disabled:opacity-50 inline-flex items-center gap-2">
              <Download size={18} /> {exporting ? 'EXPORTANDO...' : 'EXPORTAR EXCEL'}
            </button>
            <button type="button" onClick={() => setIntelligenceOpen(true)} className="px-6 py-3 rounded-2xl bg-slate-900 dark:bg-slate-800 text-white font-black hover:bg-slate-800 dark:hover:bg-slate-700 inline-flex items-center gap-2">
              <BrainCircuit size={18} /> INTELIGÊNCIA A4
            </button>
          </div>
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
            ) : <p className="text-sm font-bold text-slate-500 dark:text-slate-400">{mode === 'prioritized' ? 'Receitas com política/priorização aplicada.' : 'Todas as receitas cadastradas.'}</p>}
          </div>

          <div className="space-y-3">
            <p className="text-xs uppercase tracking-[0.2em] text-slate-400 font-black">PIMs / Origem</p>
            <label className="inline-flex items-center gap-2 text-sm font-black text-slate-700 dark:text-slate-300"><input type="checkbox" checked={includePims} onChange={(e) => setIncludePims(e.target.checked)} /> Incluir PIMs</label>
            <label className="inline-flex items-center gap-2 text-sm font-black text-slate-700 dark:text-slate-300"><input type="checkbox" checked={includeProgrammed} onChange={(e) => setIncludeProgrammed(e.target.checked)} /> Incluir manutenção programada confirmada</label>
            <div className="max-h-52 overflow-auto rounded-2xl border border-slate-200 dark:border-slate-800 p-3 space-y-2">
              {(options.origens || []).map((item) => (
                <label key={item.key} className="flex items-center justify-between gap-3 text-sm font-bold text-slate-700 dark:text-slate-300">
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
        <>
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-6">
            <SummaryCard title="Necessidade total" value={numberBr(preview.summary.necessidade_total)} subtitle={`${preview.summary.linhas_base} PN(s) consolidados`} icon={ShieldAlert} />
            <SummaryCard title="Disponível PPU + CeIMSPA" value={numberBr((preview.summary.disponivel_ppu ?? preview.summary.coberto_ppu ?? 0) + (preview.summary.disponivel_ceimspa ?? preview.summary.coberto_ceimspa ?? 0))} subtitle={`PPU + recibos ${numberBr(preview.summary.disponivel_ppu ?? preview.summary.coberto_ppu)} • CeIMSPA ${numberBr(preview.summary.disponivel_ceimspa ?? preview.summary.coberto_ceimspa)}`} icon={PackageCheck} />
            <SummaryCard title="ODA a receber" value={numberBr(preview.summary.disponivel_oda ?? preview.summary.coberto_oda ?? 0)} subtitle={`ODC em andamento ${numberBr(preview.summary.odc_em_andamento ?? preview.summary.disponivel_odc ?? 0)} • não abate necessidade`} icon={FileText} />
            <SummaryCard title="Comprar" value={numberBr(preview.summary.comprar_qtd)} subtitle={`Estimado ${moneyGbp(preview.summary.comprar_valor_gbp || 0)}`} icon={Download} />
          </div>

          <section className="rounded-3xl border border-indigo-200 dark:border-indigo-900 bg-indigo-50/50 dark:bg-indigo-950/20 p-5">
            <div className="flex flex-col xl:flex-row xl:items-center xl:justify-between gap-4">
              <div>
                <p className="text-[10px] uppercase tracking-[0.18em] font-black text-indigo-600 dark:text-indigo-300">Política de estoque • horizonte de 2 anos</p>
                <p className="mt-1 text-sm font-bold text-slate-700 dark:text-slate-300">
                  Base para decidir cortes de verba sem confundir estoque atual, aquisição já feita e processo ainda não suplementado.
                </p>
              </div>
              <div className="grid grid-cols-2 md:grid-cols-5 gap-2">
                <div className="rounded-xl bg-white dark:bg-slate-900 border border-indigo-100 dark:border-indigo-900 px-3 py-2"><p className="text-[9px] uppercase font-black text-slate-400">Preciso</p><p className="font-black">{numberBr(preview.summary.politica_necessidade_2_anos)}</p></div>
                <div className="rounded-xl bg-white dark:bg-slate-900 border border-indigo-100 dark:border-indigo-900 px-3 py-2"><p className="text-[9px] uppercase font-black text-slate-400">PPU + CeIMSPA</p><p className="font-black">{numberBr((preview.summary.politica_ppu_efetivo || 0) + (preview.summary.politica_ceimspa_disponivel || 0))}</p></div>
                <div className="rounded-xl bg-white dark:bg-slate-900 border border-indigo-100 dark:border-indigo-900 px-3 py-2"><p className="text-[9px] uppercase font-black text-slate-400">ODA</p><p className="font-black text-blue-700 dark:text-blue-300">{numberBr(preview.summary.politica_oda_a_receber)}</p></div>
                <div className="rounded-xl bg-white dark:bg-slate-900 border border-orange-200 dark:border-orange-900 px-3 py-2"><p className="text-[9px] uppercase font-black text-orange-600">ODC alerta</p><p className="font-black text-orange-700 dark:text-orange-300">{numberBr(preview.summary.politica_odc_em_andamento)}</p></div>
                <div className="rounded-xl bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-900 px-3 py-2"><p className="text-[9px] uppercase font-black text-amber-700">Falta comprar</p><p className="font-black text-amber-800 dark:text-amber-200">{numberBr(preview.summary.politica_deficit_a_providenciar)}</p></div>
              </div>
            </div>
          </section>

          <RecipeDeficiencyPanel data={preview.recipe_deficiency} />

          {missingQuoteItems.length > 0 ? (
            <div className="flex justify-end">
              <button type="button" onClick={() => setQuoteOpen(true)} className="px-5 py-3 rounded-2xl bg-slate-700 hover:bg-slate-600 text-white font-black inline-flex items-center gap-2">
                <FileQuestion size={18} /> SOLICITAR COTAÇÃO ({missingQuoteItems.length})
              </button>
            </div>
          ) : null}

          <CoverageTable title="01 • PPU" rows={preview.sections.ppu || []} />
          <CoverageTable title="02 • CEIMSPA" rows={preview.sections.ceimspa || []} />
          <CoverageTable title="03 • ODA" rows={preview.sections.oda || []} />
          <CoverageTable title="04 • BANCO DE PREÇOS" rows={preview.sections.pricelist || []} type="price" />
          <CoverageTable title="05 • ODC" rows={preview.sections.odc || []} />
          <BuyDecisionTable rows={preview.sections.comprar || []} />
        </>
      ) : null}

      <LogisticsIntelligenceModal open={intelligenceOpen} onClose={() => setIntelligenceOpen(false)} />

      <CotacaoRequestModal
        open={quoteOpen}
        onClose={() => setQuoteOpen(false)}
        token={token}
        source="GERADOR_NECESSIDADES"
        items={missingQuoteItems}
      />
    </div>
  );
}
