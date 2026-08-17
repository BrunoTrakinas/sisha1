const supabase = require('../config/supabaseClient');
const { hashBuffer } = require('./rawOperationalDocumentParserService');
const { orchestrateMasterOsEquipment } = require('./masterOsEquipmentOrchestratorService');

function chunks(list, size = 400) {
  const out = [];
  for (let i = 0; i < (list || []).length; i += size) out.push(list.slice(i, i + size));
  return out;
}

function numericOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

async function importMasterOsHistory(parsed, { buffer, fileName, user } = {}) {
  if (!buffer) throw new Error('MASTER OS: arquivo bruto é obrigatório para preservar SHA-256.');
  const sourceSha256 = hashBuffer(buffer);
  const payload = (parsed?.items || []).map((item) => ({
    os_numero: item.os_numero || item.os_numero_normalizado,
    os_numero_normalizado: item.os_numero_normalizado,
    os_ano: Number(item.os_ano),
    dominio_tipo: item.dominio_tipo || 'OUTROS',
    dominio_codigo: item.dominio_codigo || null,
    dominio_descricao: item.dominio_descricao || null,
    dominio_historico: Boolean(item.dominio_historico),
    fonte_dominio: item.fonte_dominio || item.source_sheet || null,
    data_abertura: item.data_abertura || null,
    situacao: item.situacao || null,
    destino: item.destino || null,
    descricao: item.descricao || null,
    data_fechamento: item.data_fechamento || null,
    responsavel: item.responsavel || null,
    tipo_inspecao: item.tipo_inspecao || null,
    pane: item.pane || null,
    hora_abertura: numericOrNull(item.hora_abertura),
    hora_fechamento: numericOrNull(item.hora_fechamento),
    horas_total: numericOrNull(item.horas_total),
    hv_total: numericOrNull(item.hv_total),
    status_evidencia: item.status_evidencia || 'ABERTA',
    cronologia_consistente: item.cronologia_consistente !== false,
    movimento_tipo: item.movimento?.tipo || null,
    movimento_estado: item.movimento?.detectado ? 'PENDENTE_ORQUESTRACAO' : 'NAO_APLICAVEL',
    movimento_payload: { parser: item.movimento || null },
    source_file_name: fileName || 'MASTER OS.xlsx',
    source_sha256: sourceSha256,
    source_sheet: item.source_sheet || null,
    source_row: Number(item.source_row || 0) || null,
    source_payload: {
      master_os: true,
      source_sheet: item.source_sheet || null,
      source_row: item.source_row || null,
      source_domain: item.fonte_dominio || null,
      status_evidencia: item.status_evidencia || null,
      cronologia_consistente: item.cronologia_consistente !== false,
      raw_os: item.os_numero || null,
      movimento: item.movimento || null,
    },
    imported_by: user?.email || null,
    invalidado: false,
  }));

  let inserted = 0;
  for (const part of chunks(payload, 400)) {
    if (!part.length) continue;
    const { data, error } = await supabase
      .from('os_master_evidencias')
      .upsert(part, { onConflict: 'source_sha256,source_sheet,source_row', ignoreDuplicates: true })
      .select('id');
    if (error) throw error;
    inserted += (data || []).length;
  }

  const orchestration = await orchestrateMasterOsEquipment(parsed?.items || [], {
    fileName: fileName || 'MASTER OS.xlsx',
    sourceSha256,
    user: user || {},
  });

  return {
    source_sha256: sourceSha256,
    evidencias_novas: inserted,
    evidencias_ja_existentes: Math.max(0, payload.length - inserted),
    os_canonicas_no_arquivo: payload.length,
    orquestracao_equipamentos: orchestration,
    regra_historica: 'Append-only: ausência em arquivo posterior não remove nem regride OS já registrada.',
    regra_movimento: 'OS ABERTA registra intenção sem mover; CANCELADA preserva a intenção sem mover; FECHADA só movimenta PN+SN quando ação, identidade e destino forem inequívocos. Evento histórico mais antigo nunca substitui evidência física mais recente.',
  };
}

module.exports = { importMasterOsHistory };
