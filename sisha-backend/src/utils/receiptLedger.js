const supabase = require('../config/supabaseClient');

function normalizeText(value) {
  const text = String(value ?? '').trim();
  return text === '' ? null : text;
}

function normalizeNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function parseDateToIso(value) {
  if (!value) return null;

  const text = String(value).trim();
  if (!text) return null;

  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;

  const brMatch = text.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (brMatch) {
    const [, dia, mes, ano] = brMatch;
    return `${ano}-${mes}-${dia}`;
  }

  const parsed = new Date(text);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString().split('T')[0];
}

async function ensureRecebimentoHeader({
  numeroRecibo,
  tipoRecebimento,
  dataRecebimento,
  documentoReferencia = null,
  isFoc = false,
  observacao = null,
}) {
  const payload = {
    numero_recibo: normalizeText(numeroRecibo) || 'N/A',
    tipo_recebimento: tipoRecebimento,
    data_recebimento: parseDateToIso(dataRecebimento),
    documento_referencia: normalizeText(documentoReferencia),
    is_foc: Boolean(isFoc),
    observacao: normalizeText(observacao),
  };

  const { data, error } = await supabase
    .from('recebimentos')
    .upsert(payload, { onConflict: 'numero_recibo,tipo_recebimento' })
    .select('id')
    .single();

  if (error) throw error;
  return data.id;
}

async function replaceRecebimentoItens(recebimentoId, itens = []) {
  if (!recebimentoId) throw new Error('Recebimento inválido para gravação dos itens.');

  const { error: deleteError } = await supabase
    .from('recebimento_itens')
    .delete()
    .eq('recebimento_id', recebimentoId);

  if (deleteError) throw deleteError;

  if (!itens.length) return;

  const payload = itens.map((item) => {
    const quantidade = normalizeNumber(item.quantidade);
    const valorUnitario = item.valor_unitario == null || item.valor_unitario === ''
      ? null
      : normalizeNumber(item.valor_unitario);

    return {
      recebimento_id: recebimentoId,
      pn: String(item.pn || '').trim().toUpperCase(),
      nomenclatura: normalizeText(item.nomenclatura),
      quantidade,
      sn: normalizeText(item.sn),
      localizacao_ppu: normalizeText(item.localizacao_ppu),
      data_garantia: parseDateToIso(item.data_garantia),
      valor_unitario: valorUnitario,
      valor_total: valorUnitario == null ? null : Number((quantidade * valorUnitario).toFixed(2)),
      documento_referencia: normalizeText(item.documento_referencia),
    };
  });

  const chunkSize = 500;
  for (let i = 0; i < payload.length; i += chunkSize) {
    const { error } = await supabase
      .from('recebimento_itens')
      .insert(payload.slice(i, i + chunkSize));

    if (error) throw error;
  }
}

module.exports = {
  parseDateToIso,
  ensureRecebimentoHeader,
  replaceRecebimentoItens,
};
