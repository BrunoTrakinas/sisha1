const supabase = require('../config/supabaseClient');

const VALID_CONDITIONS = new Set([
  'RECEBIDO_DISPONIVEL',
  'QUARENTENA',
  'DEFEITUOSO',
  'FALTANTE',
  'DIVERGENTE',
]);

function normalizeText(value) {
  const text = String(value ?? '').trim();
  return text === '' ? null : text;
}

function normalizeUpper(value) {
  const text = normalizeText(value);
  return text ? text.toUpperCase() : null;
}

function normalizeNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function normalizeNullableNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function clamp(value, minimum, maximum) {
  return Math.min(Math.max(value, minimum), maximum);
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
  return parsed.toISOString().slice(0, 10);
}

function isRealSerial(value) {
  const serial = normalizeUpper(value);
  return Boolean(serial && !['N/A', 'NA', 'S/N', 'SEM SN', 'SEM S/N', '-'].includes(serial));
}

function normalizeCondition(value) {
  const condition = normalizeUpper(value) || 'RECEBIDO_DISPONIVEL';
  return VALID_CONDITIONS.has(condition) ? condition : 'RECEBIDO_DISPONIVEL';
}

function normalizeStockDestination(value) {
  const destination = normalizeUpper(value);
  if (!destination) return null;
  return destination === 'CEIMSPA' ? 'CEIMSPA' : 'PPU';
}

function normalizePredictedDestination(value) {
  const destination = normalizeUpper(value);
  if (!destination) return null;
  return destination === 'CEIMSPA' ? 'CEIMSPA' : destination === 'PPU' ? 'PPU' : null;
}

function normalizeValidityStatus(value) {
  const allowed = new Set(['NAO_INFORMADA', 'OK', 'PROXIMO_VENCIMENTO', 'VENCIDO', 'SEM_ESTOQUE', 'REVISAR']);
  const status = normalizeUpper(value) || 'NAO_INFORMADA';
  return allowed.has(status) ? status : 'REVISAR';
}

function splitSerials(value) {
  if (!value) return [];
  return String(value)
    .split(/[,;\n|]+/)
    .map((serial) => normalizeUpper(serial))
    .filter(isRealSerial);
}

function normalizeReceiptItems(items = [], actor = null) {
  const normalized = [];

  (items || []).forEach((rawItem, sourceIndex) => {
    const pn = normalizeUpper(rawItem.pn);
    const totalQuantity = Math.max(0, normalizeNumber(rawItem.quantidade));
    if (!pn || totalQuantity <= 0) return;

    const serials = [...new Set(splitSerials(rawItem.sn || rawItem.sns_finais))];
    if (serials.length > totalQuantity) {
      const error = new Error(`Item ${sourceIndex + 1} (PN ${pn}): a quantidade (${totalQuantity}) não pode ser menor que o número de SNs válidos (${serials.length}).`);
      error.code = 'RECEIPT_SERIAL_QUANTITY_MISMATCH';
      throw error;
    }

    const condition = normalizeCondition(rawItem.condicao_item);
    const contabilizaPeloRecibo = rawItem.contabiliza_pelo_recibo !== false;
    const requestedInventoried = !contabilizaPeloRecibo || rawItem.inventariado_ppu
      ? totalQuantity
      : clamp(Math.max(0, normalizeNumber(rawItem.quantidade_inventariada)), 0, totalQuantity);
    const stockDestination = requestedInventoried > 0
      ? normalizeStockDestination(rawItem.destino_estoque)
      : null;

    if (requestedInventoried > 0 && !stockDestination) {
      const error = new Error(`Item ${sourceIndex + 1} (PN ${pn}): selecione PPU ou CEIMSPA para registrar onde a quantidade já foi incorporada.`);
      error.code = 'RECEIPT_STOCK_DESTINATION_REQUIRED';
      throw error;
    }

    if (serials.length && requestedInventoried > 0 && requestedInventoried < totalQuantity && !Number.isInteger(requestedInventoried)) {
      const error = new Error(`Item ${sourceIndex + 1} (PN ${pn}): equipamento com SN não admite quantidade inventariada fracionada.`);
      error.code = 'RECEIPT_SERIAL_INVENTORY_MISMATCH';
      throw error;
    }

    const unitValueInput = normalizeNullableNumber(rawItem.valor_unitario);
    const documentTotalInput = normalizeNullableNumber(rawItem.valor_total_documento);
    const effectiveUnitValue = unitValueInput != null
      ? Math.max(0, unitValueInput)
      : documentTotalInput != null && totalQuantity > 0
        ? Math.max(0, documentTotalInput / totalQuantity)
        : null;

    const common = {
      recebimento_id: rawItem.recebimento_id || undefined,
      sequencia_item: Number(rawItem.sequencia_item) || sourceIndex + 1,
      pn,
      nomenclatura: normalizeText(rawItem.nomenclatura),
      nsn_pi: normalizeText(rawItem.nsn_pi),
      localizacao_ppu: normalizeText(rawItem.localizacao_ppu),
      destino_previsto: normalizePredictedDestination(rawItem.destino_previsto),
      destino_previsto_fonte: normalizeText(rawItem.destino_previsto_fonte),
      destino_estoque: stockDestination,
      condicao_item: condition,
      validade_status: normalizeValidityStatus(rawItem.validade_status),
      validade_observacao: normalizeText(rawItem.validade_observacao),
      sn_extraido_documento: Boolean(rawItem.sn_extraido_documento || rawItem.sns_pre_carregados?.length),
      observacao_item: normalizeText(rawItem.observacao_item),
      data_garantia: parseDateToIso(rawItem.data_garantia),
      valor_unitario: effectiveUnitValue == null ? null : Number(effectiveUnitValue.toFixed(6)),
      moeda: normalizeUpper(rawItem.moeda),
      documento_referencia: normalizeText(rawItem.documento_referencia),
      delivery_note: normalizeText(rawItem.delivery_note),
      invoice_no: normalizeText(rawItem.invoice_no),
      di: normalizeText(rawItem.di),
      batch_no: normalizeText(rawItem.batch_no),
      coc_no: normalizeText(rawItem.coc_no),
      status_documento: normalizeText(rawItem.status_documento),
      dados_originais: rawItem.dados_originais && typeof rawItem.dados_originais === 'object'
        ? rawItem.dados_originais
        : {},
      ativo: rawItem.ativo !== false,
    };

    let inventoryRemaining = requestedInventoried;
    const buildInventoryFields = (quantity) => {
      const inventoriedQuantity = clamp(inventoryRemaining, 0, quantity);
      inventoryRemaining = Math.max(0, inventoryRemaining - inventoriedQuantity);
      const fullyInventoried = inventoriedQuantity >= quantity;
      return {
        quantidade_inventariada: Number(inventoriedQuantity.toFixed(6)),
        inventariado_ppu: fullyInventoried,
        contabiliza_pelo_recibo: !fullyInventoried,
        inventariado_em: inventoriedQuantity > 0
          ? (rawItem.inventariado_em || new Date().toISOString())
          : null,
        inventariado_por_email: inventoriedQuantity > 0
          ? (normalizeText(rawItem.inventariado_por_email) || actor?.email || actor?.sub || null)
          : null,
      };
    };

    serials.forEach((serial, serialIndex) => {
      const rowTotal = effectiveUnitValue == null ? null : Number(effectiveUnitValue.toFixed(2));
      normalized.push({
        ...common,
        ...buildInventoryFields(1),
        id: serialIndex === 0 && rawItem.id ? rawItem.id : undefined,
        sequencia_item: normalized.length + 1,
        quantidade: 1,
        sn: serial,
        tipo_item: 'EQUIPAMENTO',
        valor_total: rowTotal,
        valor_total_documento: rowTotal,
      });
    });

    const remainingQuantity = Math.max(0, totalQuantity - serials.length);
    if (remainingQuantity > 0 || serials.length === 0) {
      const quantity = serials.length === 0 ? totalQuantity : remainingQuantity;
      const rowTotal = effectiveUnitValue == null ? null : Number((quantity * effectiveUnitValue).toFixed(2));
      normalized.push({
        ...common,
        ...buildInventoryFields(quantity),
        id: serials.length === 0 && rawItem.id ? rawItem.id : undefined,
        sequencia_item: normalized.length + 1,
        quantidade: quantity,
        sn: null,
        tipo_item: 'SOBRESSALENTE',
        valor_total: rowTotal,
        valor_total_documento: rowTotal,
      });
    }
  });

  return normalized;
}

async function findActiveReceipt(numeroRecibo, tipoRecebimento) {
  const { data, error } = await supabase
    .from('recebimentos')
    .select('*')
    .eq('numero_recibo', normalizeUpper(numeroRecibo))
    .eq('tipo_recebimento', normalizeUpper(tipoRecebimento) || 'MATERIAL')
    .neq('ativo', false)
    .maybeSingle();

  if (error) throw error;
  return data || null;
}

async function ensureRecebimentoHeader(header, actor = null) {
  const payload = {
    numero_recibo: normalizeUpper(header.numeroRecibo),
    tipo_recebimento: normalizeUpper(header.tipoRecebimento) || 'MATERIAL',
    data_recebimento: parseDateToIso(header.dataRecebimento),
    documento_referencia: normalizeText(header.documentoReferencia),
    fornecedor: normalizeText(header.fornecedor),
    origem_material: normalizeText(header.origemMaterial),
    programa_origem: normalizeText(header.programaOrigem),
    programa_origem_fonte: normalizeText(header.programaOrigemFonte),
    codigo_om_recebedora: normalizeText(header.codigoOmRecebedora),
    sigla_recebedora: normalizeUpper(header.siglaRecebedora),
    recebido_por_nome: normalizeText(header.recebidoPorNome),
    conferido_por_nome: normalizeText(header.conferidoPorNome),
    metodo_importacao: normalizeUpper(header.metodoImportacao) || 'MANUAL',
    arquivo_nome: normalizeText(header.arquivoNome),
    arquivo_hash: normalizeText(header.arquivoHash),
    chat_lince_documento_id: header.chatLinceDocumentoId || null,
    is_foc: Boolean(header.isFoc),
    observacao: normalizeText(header.observacao),
    avisos_triagem: Array.isArray(header.avisosTriagem) ? header.avisosTriagem : [],
    dados_originais: header.dadosOriginais && typeof header.dadosOriginais === 'object'
      ? header.dadosOriginais
      : {},
    ativo: true,
    updated_by_email: actor?.email || actor?.sub || null,
    updated_at: new Date().toISOString(),
  };

  let current = await findActiveReceipt(payload.numero_recibo, payload.tipo_recebimento);
  if (current) {
    const { data, error } = await supabase
      .from('recebimentos')
      .update(payload)
      .eq('id', current.id)
      .select('*')
      .single();
    if (error) throw error;
    return data;
  }

  const { data, error } = await supabase
    .from('recebimentos')
    .insert({ ...payload, created_by_email: actor?.email || actor?.sub || null })
    .select('*')
    .single();
  if (error) throw error;
  return data;
}

async function replaceRecebimentoItens(recebimentoId, itens = [], actor = null) {
  if (!recebimentoId) throw new Error('Recebimento inválido para gravação dos itens.');

  const normalized = normalizeReceiptItems(itens, actor).map((item) => ({
    ...item,
    recebimento_id: recebimentoId,
    updated_at: new Date().toISOString(),
  }));

  const { data: existing, error: existingError } = await supabase
    .from('recebimento_itens')
    .select('*')
    .eq('recebimento_id', recebimentoId)
    .neq('ativo', false);
  if (existingError) throw existingError;

  const existingIds = new Set((existing || []).map((row) => row.id));
  const incomingIds = new Set(normalized.map((row) => row.id).filter((id) => existingIds.has(id)));
  const removedIds = (existing || []).map((row) => row.id).filter((id) => !incomingIds.has(id));

  if (removedIds.length) {
    const { error } = await supabase
      .from('recebimento_itens')
      .update({ ativo: false, updated_at: new Date().toISOString() })
      .in('id', removedIds);
    if (error) throw error;
  }

  const updates = normalized.filter((row) => row.id && existingIds.has(row.id));
  for (const row of updates) {
    const { id, ...payload } = row;
    const { error } = await supabase
      .from('recebimento_itens')
      .update(payload)
      .eq('id', id);
    if (error) throw error;
  }

  const inserts = normalized
    .filter((row) => !row.id || !existingIds.has(row.id))
    .map(({ id: _ignored, ...row }) => row);

  for (let index = 0; index < inserts.length; index += 500) {
    const { error } = await supabase
      .from('recebimento_itens')
      .insert(inserts.slice(index, index + 500));
    if (error) throw error;
  }

  const { data: saved, error: savedError } = await supabase
    .from('recebimento_itens')
    .select('*')
    .eq('recebimento_id', recebimentoId)
    .neq('ativo', false)
    .order('sequencia_item', { ascending: true })
    .order('created_at', { ascending: true });
  if (savedError) throw savedError;

  return { before: existing || [], after: saved || [] };
}

module.exports = {
  VALID_CONDITIONS,
  parseDateToIso,
  isRealSerial,
  normalizeReceiptItems,
  ensureRecebimentoHeader,
  replaceRecebimentoItens,
};
