const crypto = require('crypto');
const supabase = require('../config/supabaseClient');

function sourceHash(buffer) {
  return crypto.createHash('sha256').update(buffer || Buffer.alloc(0)).digest('hex');
}

async function importExternalCustodySnapshot(parsed, { buffer, fileName, user } = {}) {
  const hash = sourceHash(buffer);
  const payloadItems = (parsed.items || []).map((item) => ({
    box_code: item.box_code,
    sheet_name: item.sheet_name,
    source_row: item.source_row,
    evidence_at: item.evidence_at,
    pn: item.pn,
    pn_original: item.pn_original || item.pn,
    nsn_original: item.nsn_original,
    nsn_normalized: item.nsn_normalized,
    nomenclature: item.nomenclature,
    quantity: item.quantity,
    sn: item.sn,
    original_location: item.original_location,
    original_location_normalized: item.original_location_normalized,
    auditor_name: item.auditor_name,
    auditor_nip: item.auditor_nip,
    group_key: item.group_key,
    source_fingerprint: item.source_fingerprint,
  }));

  const { data, error } = await supabase.rpc('rpc_import_ppu_custodia_externa_snapshot', {
    p_source_hash: hash,
    p_file_name: fileName || 'Backend_Auditoria_Paiol.xlsx',
    p_imported_by_auth_user_id: user?.auth_user_id || user?.id || null,
    p_imported_by_email: user?.email || null,
    p_summary: parsed.summary || {},
    p_items: payloadItems,
  });
  if (error) throw error;
  return { ...(data || {}), source_hash: hash };
}

async function saveReconciliationDecision({ importId, groupKey, decision, reason, user } = {}) {
  if (!importId || !groupKey) throw new Error('Importação/grupo obrigatório para reconciliação.');
  if (!['CONFIRMAR_CUSTODIA', 'IGNORAR_MOVIMENTACAO'].includes(decision)) throw new Error('Decisão de reconciliação inválida.');
  if (!String(reason || '').trim()) throw new Error('Motivo é obrigatório para confirmar/ignorar divergência.');
  const { data, error } = await supabase.rpc('rpc_decidir_ppu_custodia_externa', {
    p_import_id: importId,
    p_group_key: groupKey,
    p_decision: decision,
    p_reason: String(reason).trim(),
    p_decided_by_auth_user_id: user?.auth_user_id || user?.id || null,
    p_decided_by_email: user?.email || null,
  });
  if (error) throw error;
  return data || null;
}

module.exports = { sourceHash, importExternalCustodySnapshot, saveReconciliationDecision };
