const supabase = require('../config/supabaseClient');
const { normalizePn } = require('../utils/importAliases');

function normalizeKey(value) {
  return normalizePn(value);
}

function getSubItemPriority(value) {
  const text = String(value || '').trim().toUpperCase();
  if (!text) return 999;
  const match = text.match(/(\d+)?([A-Z])$/);
  if (match?.[2]) return match[2].charCodeAt(0) - 64;
  const numeric = text.match(/(\d+)$/);
  return numeric ? Number(numeric[1]) : 999;
}

function compareRelations(a = {}, b = {}) {
  const sourceOrder = { CIETP: 1, DOCUMENTO: 2, RFQ: 3 };
  const sourceDiff = (sourceOrder[a.origem] || 99) - (sourceOrder[b.origem] || 99);
  if (sourceDiff !== 0) return sourceDiff;
  const priorityDiff = (a.prioridade ?? 999) - (b.prioridade ?? 999);
  if (priorityDiff !== 0) return priorityDiff;
  return normalizeKey(a.pn_relacionado).localeCompare(normalizeKey(b.pn_relacionado));
}

function relationKey(row = {}) {
  return [
    normalizeKey(row.pn_relacionado),
    String(row.tipo_relacao || '').toUpperCase(),
    String(row.origem || '').toUpperCase(),
    String(row.fonte || '').trim().toUpperCase(),
  ].join('|');
}

async function loadManualRelations(pn) {
  const { data: bases, error: baseError } = await supabase
    .from('dicionario_mestre')
    .select('pn,dmc,item_num,sub_item,nsn,pi,nomenclatura')
    .eq('pn', pn);
  if (baseError) throw baseError;

  const relations = [];
  const seenFamilies = new Set();
  for (const base of (bases || [])) {
    const dmc = String(base.dmc || '').trim();
    const item = String(base.item_num || '').trim();
    if (!dmc || !item) continue;
    const familyKey = `${dmc}|${item}`;
    if (seenFamilies.has(familyKey)) continue;
    seenFamilies.add(familyKey);

    const { data: siblings, error } = await supabase
      .from('dicionario_mestre')
      .select('pn,dmc,item_num,sub_item,nsn,pi,nomenclatura')
      .eq('dmc', dmc)
      .eq('item_num', item);
    if (error) throw error;

    (siblings || []).forEach((row) => {
      const related = normalizeKey(row.pn);
      if (!related || related === pn) return;
      relations.push({
        pn_consultado: pn,
        pn_relacionado: related,
        tipo_relacao: 'ALTERNATIVO_TECNICO',
        origem: 'CIETP',
        fonte: `CIETP ${dmc} • ITEM ${item}`,
        dmc,
        item_num: item,
        sub_item: row.sub_item || null,
        nsn: row.nsn || null,
        pi: row.pi || null,
        nomenclatura: row.nomenclatura || null,
        direcional: false,
        utilizavel_para_atender: true,
        prioridade: getSubItemPriority(row.sub_item),
      });
    });
  }
  return relations;
}

async function loadDocumentRelations(pn) {
  const columns = 'id,pn,pi,pn_alt,fonte,tipo_relacao,origem_tipo,observacao,ativo,created_at,updated_at';
  const [byPn, byAlt] = await Promise.all([
    supabase.from('pn_alternativos_documento').select(columns).eq('ativo', true).eq('pn', pn),
    supabase.from('pn_alternativos_documento').select(columns).eq('ativo', true).eq('pn_alt', pn),
  ]);
  if (byPn.error) throw byPn.error;
  if (byAlt.error) throw byAlt.error;

  const rows = [...(byPn.data || []), ...(byAlt.data || [])];
  const dedupe = new Map();
  rows.forEach((row) => {
    const a = normalizeKey(row.pn);
    const b = normalizeKey(row.pn_alt);
    if (!a || !b || a === b) return;
    const related = a === pn ? b : a;
    const item = {
      pn_consultado: pn,
      pn_relacionado: related,
      tipo_relacao: String(row.tipo_relacao || 'ALTERNATIVO').toUpperCase(),
      origem: 'DOCUMENTO',
      fonte: row.fonte || 'DOCUMENTO TÉCNICO PN ALTERNATIVOS',
      pi: row.pi || null,
      dmc: null,
      item_num: null,
      sub_item: null,
      direcional: false,
      utilizavel_para_atender: true,
      prioridade: 500,
      documento_relacao_id: row.id,
      origem_tipo: row.origem_tipo || 'DOCUMENTO',
      observacao: row.observacao || null,
    };
    dedupe.set(relationKey(item), item);
  });
  return Array.from(dedupe.values());
}

function normalizeRfqEvolution(row) {
  const relation = String(row.tipo_relacao_pn || '').trim().toUpperCase();
  const pn = normalizeKey(row.pn);
  const related = normalizeKey(row.pn_relacionado);
  if (!pn || !related || !['SUPERSEDES', 'SUPERSEDED_BY'].includes(relation)) return null;

  if (relation === 'SUPERSEDES') {
    return { pn_antigo: related, pn_atual: pn };
  }
  return { pn_antigo: pn, pn_atual: related };
}

async function loadRfqEvolutionRelations(pn) {
  const columns = 'id,pn,pn_relacionado,tipo_relacao_pn,cotacao_numero,fornecedor,data_cotacao,validade,valor_unitario,moeda,lead_time_dias,relacao_pn_texto,ativo';
  const [byPn, byRelated] = await Promise.all([
    supabase.from('rfq_cotacoes').select(columns).eq('ativo', true).eq('pn', pn),
    supabase.from('rfq_cotacoes').select(columns).eq('ativo', true).eq('pn_relacionado', pn),
  ]);
  if (byPn.error) throw byPn.error;
  if (byRelated.error) throw byRelated.error;

  const rows = [...(byPn.data || []), ...(byRelated.data || [])];
  const dedupe = new Map();
  rows.forEach((row) => {
    const evo = normalizeRfqEvolution(row);
    if (!evo || (pn !== evo.pn_antigo && pn !== evo.pn_atual)) return;
    const queryIsOld = pn === evo.pn_antigo;
    const item = {
      pn_consultado: pn,
      pn_relacionado: queryIsOld ? evo.pn_atual : evo.pn_antigo,
      pn_antigo: evo.pn_antigo,
      pn_atual_fornecimento: evo.pn_atual,
      tipo_relacao: queryIsOld ? 'EVOLUCAO_FORNECIMENTO' : 'PN_ANTERIOR_FORNECIMENTO',
      origem: 'RFQ',
      fonte: `RFQ ${row.cotacao_numero || 'SEM NÚMERO'}${row.fornecedor ? ` • ${row.fornecedor}` : ''}`,
      direcional: true,
      utilizavel_para_atender: queryIsOld,
      prioridade: 900,
      rfq_id: row.id,
      cotacao_numero: row.cotacao_numero || null,
      fornecedor: row.fornecedor || null,
      data_cotacao: row.data_cotacao || null,
      validade_preco: row.validade || null,
      valor_unitario_gbp: Number(row.valor_unitario) > 0 ? Number(row.valor_unitario) : null,
      moeda: row.moeda || 'GBP',
      lead_time_dias: Number(row.lead_time_dias) || 0,
      evidencia: row.relacao_pn_texto || null,
    };
    dedupe.set(relationKey(item), item);
  });
  return Array.from(dedupe.values());
}

async function resolvePnRelations(pnInput, { includeRfq = true } = {}) {
  const pn = normalizeKey(pnInput);
  if (!pn) return { pn: null, alternativos: [], evolucoes: [], todos: [] };

  const [manual, documental, rfq] = await Promise.all([
    loadManualRelations(pn).catch(() => []),
    loadDocumentRelations(pn).catch(() => []),
    includeRfq ? loadRfqEvolutionRelations(pn).catch(() => []) : Promise.resolve([]),
  ]);

  const all = new Map();
  [...manual, ...documental].forEach((row) => {
    const key = relationKey(row);
    if (!all.has(key)) all.set(key, row);
  });
  const alternativos = Array.from(all.values()).sort(compareRelations);
  const evolucoes = rfq.sort(compareRelations);

  return {
    pn,
    alternativos,
    evolucoes,
    todos: [...alternativos, ...evolucoes],
    utilizaveis_para_atender: [...alternativos, ...evolucoes].filter((row) => row.utilizavel_para_atender),
  };
}

module.exports = {
  normalizeKey,
  getSubItemPriority,
  compareRelations,
  normalizeRfqEvolution,
  resolvePnRelations,
};
