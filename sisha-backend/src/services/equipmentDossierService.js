function normalizeUpper(value) {
  return String(value || '').trim().toUpperCase();
}

function isKnownLocation(equipment = {}) {
  const category = normalizeUpper(equipment.categoria_local_atual);
  return Boolean(
    equipment.local_atual
    || equipment.anv_atual
    || (category && !['DESCONHECIDO', 'N/A', 'NA'].includes(category))
  );
}

function sourceLabelsFromEvent(event = {}) {
  const labels = new Set();
  const payload = event.payload && typeof event.payload === 'object' ? event.payload : {};
  const tipo = normalizeUpper(event.tipo_evento);
  const docType = normalizeUpper(event.documento_tipo);
  const origem = normalizeUpper(event.origem_evento);

  if (payload.order_book || tipo.includes('ORDER_BOOK') || origem.includes('ORDER_BOOK')) labels.add('ORDER BOOK');
  if (payload.stc || tipo.includes('STC') || docType === 'STC') labels.add('STC');
  if (payload.os_pim || tipo.includes('INSTALACAO') || tipo.includes('REMOCAO') || tipo.includes('TRANSFERENCIA') || docType === 'OS' || docType === 'OSR' || docType === 'PIM') labels.add('OS/PIM');
  if (payload.custo_reparo || tipo.includes('WO') || docType === 'WO' || origem.includes('WO')) labels.add('WO');
  if (tipo.includes('GARANTIA') || normalizeUpper(event.categoria_destino) === 'GARANTIA') labels.add('GARANTIA');
  if (event.pim) labels.add('PIM');
  if (event.os) labels.add('OS');
  if (docType && !['EVIDENCIA', 'RECONCILIACAO', 'CORRECAO_CADASTRAL'].includes(docType)) labels.add(docType);
  if (origem && !['MANUAL', 'RECONCILIACAO', 'IMPORTACAO'].includes(origem)) labels.add(origem.replaceAll('_', ' '));

  return Array.from(labels);
}

function compareEventDesc(a = {}, b = {}) {
  const aTime = new Date(a.data_evento || 0).getTime();
  const bTime = new Date(b.data_evento || 0).getTime();
  if (aTime !== bTime) return bTime - aTime;
  return Number(b.id || 0) - Number(a.id || 0);
}

function buildEquipmentDossierSummary(equipment = {}, events = []) {
  const sorted = [...(events || [])].sort(compareEventDesc);
  const valid = sorted.filter((event) => !event.invalidado);
  const invalid = sorted.filter((event) => event.invalidado);
  const pendingConflicts = sorted.filter((event) => (
    normalizeUpper(event.tipo_evento) === 'CONFLITO_LOCALIZACAO'
    && event?.payload?.conflito_status === 'PENDENTE'
  ));
  const sourceSet = new Set();
  sorted.forEach((event) => sourceLabelsFromEvent(event).forEach((label) => sourceSet.add(label)));

  const chronological = [...valid].sort((a, b) => new Date(a.data_evento || 0).getTime() - new Date(b.data_evento || 0).getTime());
  const firstEvent = chronological[0] || null;
  const latestEvent = valid[0] || null;

  return {
    eventos_total: sorted.length,
    eventos_validos: valid.length,
    eventos_invalidos: invalid.length,
    conflitos_pendentes: pendingConflicts.length,
    fontes_historicas: Array.from(sourceSet).sort((a, b) => a.localeCompare(b, 'pt-BR')),
    primeira_evidencia_em: firstEvent?.data_evento || null,
    ultima_evidencia_em: latestEvent?.data_evento || null,
    ultimo_evento_tipo: latestEvent?.tipo_evento || equipment.ultima_evidencia_tipo || null,
    ultimo_evento_documento: latestEvent?.documento || equipment.ultima_evidencia_documento || null,
    localizacao_status: pendingConflicts.length > 0 ? 'CONFLITO' : isKnownLocation(equipment) ? 'CONHECIDA' : 'DESCONHECIDA',
    historico_disponivel: sorted.length > 0,
  };
}

async function fetchEventsForIds(ids = []) {
  const supabase = require('../config/supabaseClient');
  const uniqueIds = [...new Set((ids || []).map(Number).filter(Number.isFinite))];
  if (!uniqueIds.length) return [];

  const result = [];
  const chunkSize = 50;
  for (let index = 0; index < uniqueIds.length; index += chunkSize) {
    const chunk = uniqueIds.slice(index, index + chunkSize);
    const { data, error } = await supabase
      .from('equipamento_eventos')
      .select('id,equipamento_id,pn,sn,tipo_evento,data_evento,pim,os,anv,local_origem,local_destino,categoria_origem,categoria_destino,status_resultante,condicao_resultante,anv_destino,documento_tipo,documento,origem_evento,confianca,automatico,invalidado,motivo_invalidacao,payload')
      .in('equipamento_id', chunk)
      .order('data_evento', { ascending: false })
      .limit(5000);
    if (error) throw error;
    result.push(...(data || []));
  }
  return result;
}

async function enrichEquipmentRowsWithDossier(equipmentRows = []) {
  const rows = equipmentRows || [];
  const events = await fetchEventsForIds(rows.map((row) => row.id));
  const byEquipment = new Map();
  events.forEach((event) => {
    const key = String(event.equipamento_id);
    if (!byEquipment.has(key)) byEquipment.set(key, []);
    byEquipment.get(key).push(event);
  });

  return rows.map((equipment) => ({
    ...equipment,
    dossie_resumo: buildEquipmentDossierSummary(equipment, byEquipment.get(String(equipment.id)) || []),
  }));
}

module.exports = {
  buildEquipmentDossierSummary,
  enrichEquipmentRowsWithDossier,
  sourceLabelsFromEvent,
};
