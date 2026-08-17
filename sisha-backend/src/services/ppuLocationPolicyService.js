const supabase = require('../config/supabaseClient');
const {
  DESTINATIONS,
  SITUATIONS,
  normalizeLocation,
  normalizeDestination,
  normalizeSituation,
  enrichRows,
} = require('./ppuLocationPolicy');

async function loadPolicyMap() {
  const { data, error } = await supabase
    .from('ppu_localizacoes_config')
    .select('localizacao_normalizada,localizacao_exibicao,contabiliza_ppu,ativo,observacao,destino_contabilizacao,situacao_operacional');
  if (error) throw error;
  const map = new Map();
  (data || []).forEach((row) => {
    const key = normalizeLocation(row.localizacao_normalizada || row.localizacao_exibicao);
    map.set(key, {
      ...row,
      contabiliza_ppu: row.contabiliza_ppu !== false,
      destino_contabilizacao: normalizeDestination(row.destino_contabilizacao, row.contabiliza_ppu !== false),
      situacao_operacional: normalizeSituation(row.situacao_operacional, row.contabiliza_ppu !== false),
    });
  });
  return map;
}

async function loadTrackingRowsByPns(pns = []) {
  const safePns = [...new Set((pns || []).map((pn) => String(pn || '').trim().toUpperCase()).filter(Boolean))];
  if (!safePns.length) return [];
  const [inventoryResult, policyMap] = await Promise.all([
    supabase
      .from('estoque_ppu')
      .select('id,pn,nsn_pi,nomenclatura,quantidade,localizacao,sn,data_chegada,data_garantia')
      .in('pn', safePns),
    loadPolicyMap(),
  ]);
  if (inventoryResult.error) throw inventoryResult.error;
  return enrichRows(inventoryResult.data || [], policyMap);
}

module.exports = {
  DESTINATIONS,
  SITUATIONS,
  normalizeLocation,
  normalizeDestination,
  normalizeSituation,
  loadPolicyMap,
  enrichRows,
  loadTrackingRowsByPns,
};
