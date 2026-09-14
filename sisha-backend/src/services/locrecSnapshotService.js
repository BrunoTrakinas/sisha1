const crypto = require('crypto');
const supabase = require('../config/supabaseClient');

function sourceHash(buffer) {
  return crypto.createHash('sha256').update(buffer || Buffer.alloc(0)).digest('hex');
}

async function importLocrecSnapshot(parsed, { buffer, fileName, user } = {}) {
  const hash = sourceHash(buffer);
  const payloadItems = (parsed.items || []).map((item) => ({
    sheet_name: item.sheet_name,
    source_row: item.source_row,
    numero_recibo: item.numero_recibo,
    pd: item.pd,
    pn: item.pn,
    qtd_documental: item.qtd_documental,
    qtd_auditada_original: item.qtd_auditada_original,
    qtd_auditada_aplicada: item.qtd_auditada_aplicada,
    loc_escolhida: item.loc_escolhida,
    loc_normalizada: item.loc_normalizada,
    destino_indicado: item.destino_indicado,
    box_code: item.box_code,
    nip: item.nip,
    data_auditoria: item.data_auditoria,
    restante_original: item.restante_original,
    restante_calculado: item.restante_calculado,
    source_fingerprint: item.source_fingerprint,
  }));

  const { data, error } = await supabase.rpc('rpc_import_locrec_snapshot', {
    p_source_hash: hash,
    p_file_name: fileName || 'LOCREC.xlsx',
    p_imported_by_auth_user_id: user?.auth_user_id || user?.id || null,
    p_imported_by_email: user?.email || null,
    p_summary: parsed.summary || {},
    p_items: payloadItems,
  });
  if (error) throw error;
  return { ...(data || {}), source_hash: hash };
}

module.exports = { sourceHash, importLocrecSnapshot };
