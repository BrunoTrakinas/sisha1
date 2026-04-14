import React, { useEffect, useMemo, useState } from 'react';
import { LoaderCircle, Save } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { apiFetch } from '../lib/api';

const moneyGbp = (value) => new Intl.NumberFormat('en-GB', { style: 'currency', currency: 'GBP' }).format(Number(value || 0));

function statusColor(status) {
  const key = String(status || '').toUpperCase();
  if (['CONCLUIDA', 'CONCLUÍDA', 'FINALIZADA', 'VERDE'].includes(key)) return 'bg-emerald-500';
  if (['EM_ANDAMENTO', 'INICIADA', 'AMARELA', 'ANALISE', 'ANÁLISE'].includes(key)) return 'bg-amber-400';
  return 'bg-red-500';
}

export default function ServiceBulletins() {
  const { token } = useAuth();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [list, setList] = useState([]);
  const [selected, setSelected] = useState(null);
  const [detail, setDetail] = useState(null);
  const [statusAcao, setStatusAcao] = useState('SEM_ACAO');
  const [observacao, setObservacao] = useState('');

  const loadList = async () => {
    try {
      setLoading(true);
      setError(null);
      const response = await apiFetch('/needs/sb/list', {}, token);
      const json = await response.json();
      if (json.status !== 'success') throw new Error(json.message || 'Falha ao carregar SBs.');
      setList(json.data || []);
      if (!selected && json.data?.length) setSelected(json.data[0].sb_numero);
    } catch (err) {
      setError(err.message || 'Falha ao carregar SBs.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { loadList(); }, [token]);

  useEffect(() => {
    if (!selected) return;
    const loadDetail = async () => {
      try {
        const response = await apiFetch(`/needs/sb/${encodeURIComponent(selected)}`, {}, token);
        const json = await response.json();
        if (json.status !== 'success') throw new Error(json.message || 'Falha ao carregar detalhe.');
        setDetail(json.data);
        setStatusAcao(json.data.header.status_acao || 'SEM_ACAO');
        setObservacao(json.data.header.observacao || '');
      } catch (err) {
        setError(err.message || 'Falha ao carregar detalhe da SB.');
      }
    };
    loadDetail();
  }, [selected, token]);

  const selectedRow = useMemo(() => list.find((item) => item.sb_numero === selected) || null, [list, selected]);

  const handleSave = async () => {
    if (!selected) return;
    try {
      setSaving(true);
      setError(null);
      const response = await apiFetch(`/needs/sb/${encodeURIComponent(selected)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status_acao: statusAcao, observacao }),
      }, token);
      const json = await response.json();
      if (json.status !== 'success') throw new Error(json.message || 'Falha ao salvar SB.');
      await loadList();
    } catch (err) {
      setError(err.message || 'Falha ao salvar SB.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-8 animate-fade-in">
      <section className="bg-white rounded-3xl border border-slate-200 shadow-sm p-8">
        <h1 className="text-2xl font-black text-slate-900 uppercase">Service Bulletin</h1>
        <p className="text-sm text-slate-600 font-bold mt-2 max-w-4xl">
          Aqui o admin acompanha as SBs, vê o resumo automático, a ação principal, a cobertura dos PN e atualiza o status operacional.
        </p>
        {error ? <div className="mt-4 rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-red-700 font-bold">{error}</div> : null}
      </section>

      <div className="grid grid-cols-1 xl:grid-cols-[420px_minmax(0,1fr)] gap-8">
        <section className="bg-white rounded-3xl border border-slate-200 shadow-sm overflow-hidden">
          <div className="px-6 py-4 border-b border-slate-200 bg-slate-50">
            <h3 className="text-lg font-black text-slate-900 uppercase">SBs cadastradas</h3>
          </div>
          <div className="max-h-[70vh] overflow-auto p-4 space-y-3">
            {loading ? <div className="p-4 text-slate-500 font-bold inline-flex items-center gap-2"><LoaderCircle className="animate-spin" size={18} /> Carregando...</div> : null}
            {list.map((item) => (
              <button key={item.sb_numero} type="button" onClick={() => setSelected(item.sb_numero)} className={`w-full text-left rounded-2xl border p-4 transition-all ${selected === item.sb_numero ? 'border-blue-600 bg-blue-50' : 'border-slate-200 hover:border-blue-300 bg-white'}`}>
                <div className="flex items-start gap-3">
                  <span className={`mt-1 w-3 h-3 rounded-full ${statusColor(item.status_acao)}`} />
                  <div className="min-w-0">
                    <div className="font-black text-slate-900 break-all">{item.sb_numero}</div>
                    <div className="text-sm font-bold text-slate-700 mt-1">{item.titulo}</div>
                    <div className="text-xs text-slate-500 mt-1">{item.tipo_sb} • {item.total_itens} item(ns)</div>
                    <div className="text-xs text-slate-500 mt-1">{item.resumo_curto}</div>
                  </div>
                </div>
              </button>
            ))}
          </div>
        </section>

        <section className="bg-white rounded-3xl border border-slate-200 shadow-sm overflow-hidden">
          <div className="px-6 py-4 border-b border-slate-200 bg-slate-50 flex items-center justify-between gap-4">
            <div>
              <h3 className="text-lg font-black text-slate-900 uppercase">{selectedRow?.sb_numero || 'Selecione uma SB'}</h3>
              <p className="text-sm font-bold text-slate-500">{selectedRow?.titulo || '—'}</p>
            </div>
            <div className="flex items-center gap-2 text-sm font-black text-slate-700">
              <span className={`w-3 h-3 rounded-full ${statusColor(statusAcao)}`} /> {statusAcao}
            </div>
          </div>

          {detail ? (
            <div className="p-6 space-y-6 max-h-[70vh] overflow-auto">
              <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
                <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
                  <p className="text-[11px] uppercase tracking-[0.2em] text-slate-400 font-black">Tipo</p>
                  <p className="text-lg font-black text-slate-900 mt-2">{detail.header.tipo_sb}</p>
                </div>
                <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
                  <p className="text-[11px] uppercase tracking-[0.2em] text-slate-400 font-black">Ação principal</p>
                  <p className="text-lg font-black text-slate-900 mt-2">{detail.acao_principal}</p>
                </div>
                <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
                  <p className="text-[11px] uppercase tracking-[0.2em] text-slate-400 font-black">Itens sem cobertura</p>
                  <p className="text-lg font-black text-slate-900 mt-2">{detail.summary.itens_sem_cobertura}</p>
                </div>
                <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
                  <p className="text-[11px] uppercase tracking-[0.2em] text-slate-400 font-black">Valor estimado</p>
                  <p className="text-lg font-black text-slate-900 mt-2">{moneyGbp(detail.summary.valor_estimado_gbp || 0)}</p>
                </div>
              </div>

              <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
                <p className="text-[11px] uppercase tracking-[0.2em] text-slate-400 font-black">Resumo automático</p>
                <p className="text-sm font-bold text-slate-700 mt-2">{detail.resumo_curto}</p>
                <ul className="mt-3 space-y-2 text-sm font-bold text-slate-700">
                  {detail.acoes_recomendadas.map((item, idx) => <li key={idx}>• {item}</li>)}
                </ul>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
  <label className="space-y-2">
    <span className="text-xs uppercase tracking-[0.2em] text-slate-400 font-black">
      Status operacional
    </span>
    <select
      value={statusAcao}
      onChange={(e) => setStatusAcao(e.target.value)}
      className="w-full rounded-2xl border border-slate-200 bg-white px-4 py-3 font-bold text-slate-900"
    >
      <option value="SEM_ACAO">SEM_ACAO</option>
      <option value="EM_ANDAMENTO">EM_ANDAMENTO</option>
      <option value="CONCLUIDA">CONCLUIDA</option>
    </select>
  </label>

  <div className="md:col-span-2 space-y-2">
    <span className="text-xs uppercase tracking-[0.2em] text-slate-400 font-black">
      Observação operacional
    </span>
    <textarea
      value={observacao}
      onChange={(e) => setObservacao(e.target.value)}
      className="w-full min-h-[110px] rounded-2xl border border-slate-200 bg-white px-4 py-3 font-bold text-slate-900"
    />
  </div>
</div>

              <div className="flex justify-end">
                <button type="button" onClick={handleSave} disabled={saving} className="px-6 py-3 rounded-2xl bg-blue-600 text-white font-black hover:bg-blue-700 disabled:opacity-50 inline-flex items-center gap-2">
                  {saving ? <LoaderCircle size={18} className="animate-spin" /> : <Save size={18} />} SALVAR SB
                </button>
              </div>

              <div className="rounded-2xl border border-slate-200 overflow-hidden">
                <div className="px-4 py-3 border-b border-slate-200 bg-slate-50 font-black text-slate-900 uppercase text-sm">Itens vinculados</div>
                <div className="overflow-auto">
                  <table className="min-w-full text-sm">
                    <thead className="bg-slate-100 text-slate-700 uppercase text-[11px] tracking-wider">
                      <tr>
                        <th className="p-3 text-left">PN</th>
                        <th className="p-3 text-left">Qtd</th>
                        <th className="p-3 text-left">Cobertura</th>
                        <th className="p-3 text-left">PPU / CeIMSPA / ODA / ODC</th>
                        <th className="p-3 text-left">Saldo</th>
                        <th className="p-3 text-left">GBP</th>
                      </tr>
                    </thead>
                    <tbody>
                      {detail.itens.length === 0 ? (
                        <tr><td colSpan={6} className="p-6 text-center font-bold text-slate-500">Esta SB ainda não possui PN estruturado.</td></tr>
                      ) : detail.itens.map((item) => (
                        <tr key={`${detail.header.sb_numero}-${item.pn}`} className="border-t border-slate-100 align-top">
                          <td className="p-3">
                            <div className="font-black text-slate-900">{item.pn}</div>
                            <div className="text-xs text-slate-500 font-semibold">{item.nomenclatura || '—'}</div>
                          </td>
                          <td className="p-3 font-black text-slate-900">{item.qtd_indefinida ? 'Indefinida' : item.qtd_solicitada}</td>
                          <td className="p-3 font-black text-slate-900">{item.cobertura_status}</td>
                          <td className="p-3 text-xs font-bold text-slate-600">PPU {item.ppu_qtd} • CEI {item.ceimspa_qtd} • ODA {item.oda_qtd} • ODC {item.odc_qtd}</td>
                          <td className="p-3 font-black text-amber-700">{item.saldo_pos_cascata}</td>
                          <td className="p-3 font-black text-slate-900">{item.price_ref_gbp != null ? `${moneyGbp(item.price_ref_gbp)} • ${item.price_ref_fonte || 'REF'}` : '—'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          ) : (
            <div className="p-8 text-slate-500 font-bold">Selecione uma SB para ver o resumo automático e o detalhamento.</div>
          )}
        </section>
      </div>
    </div>
  );
}
