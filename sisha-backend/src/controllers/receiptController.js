const XLSX = require('xlsx');
const supabase = require('../config/supabaseClient');
const { saveReceipt, deactivateReceipt } = require('../services/receiptService');
const { confirmDocumentAnalysis } = require('../services/chatLinceService');
const { registrarAuditoria } = require('../utils/auditLogger');
const { unpackReceiptZip } = require('../utils/receiptBatchZip');
const {
  createReceiptImportJob,
  listReceiptImportJobs,
  getReceiptImportJob,
  markReceiptImportItemSaved,
} = require('../services/receiptImportJobService');

function normalizeUpper(value = '') {
  return String(value || '').trim().toUpperCase();
}

function normalizeNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function requireAdmin(req, res) {
  if (!['admin', 'dono'].includes(req.user?.role)) {
    res.status(403).json({ status: 'error', message: 'Apenas ADMIN ou DONO pode criar ou alterar recibos.' });
    return false;
  }
  return true;
}

function activeItems(receipt) {
  return (receipt.recebimento_itens || [])
    .filter((item) => item.ativo !== false)
    .sort((a, b) => Number(a.sequencia_item || 0) - Number(b.sequencia_item || 0));
}

function buildMatch(receipt, query) {
  const q = normalizeUpper(query);
  if (!q) return { matched: true, score: 0, tipo: 'TODOS', item_ids: [], quantidade: 0 };

  const headerFields = [
    receipt.numero_recibo,
    receipt.tipo_recebimento,
    receipt.documento_referencia,
    receipt.fornecedor,
    receipt.origem_material,
    receipt.programa_origem,
    receipt.codigo_om_recebedora,
    receipt.sigla_recebedora,
    receipt.recebido_por_nome,
    receipt.conferido_por_nome,
    receipt.observacao,
  ];
  const headerExact = normalizeUpper(receipt.numero_recibo) === q;
  const headerPartial = headerFields.some((value) => normalizeUpper(value).includes(q));

  const itemMatches = activeItems(receipt).filter((item) => [
    item.pn,
    item.nsn_pi,
    item.nomenclatura,
    item.sn,
    item.documento_referencia,
    item.delivery_note,
    item.invoice_no,
    item.di,
    item.batch_no,
    item.coc_no,
    item.status_documento,
    item.moeda,
    item.localizacao_ppu,
    item.destino_previsto,
    item.destino_previsto_fonte,
    item.destino_estoque,
    item.validade_status,
    item.validade_observacao,
    item.observacao_item,
  ].some((value) => normalizeUpper(value).includes(q)));

  const exactPnItems = itemMatches.filter((item) => normalizeUpper(item.pn) === q);
  const exactSnItems = itemMatches.filter((item) => normalizeUpper(item.sn) === q);
  const matched = headerPartial || itemMatches.length > 0;
  let tipo = 'TEXTO';
  let score = matched ? 10 : -1;
  if (headerExact) { tipo = 'RECIBO_EXATO'; score = 100; }
  else if (exactPnItems.length) { tipo = 'PN_EXATO'; score = 90; }
  else if (exactSnItems.length) { tipo = 'SN_EXATO'; score = 85; }
  else if (itemMatches.length) { tipo = 'ITEM'; score = 60; }
  else if (headerPartial) { tipo = 'CABECALHO'; score = 40; }

  const quantityBase = exactPnItems.length ? exactPnItems : itemMatches;
  return {
    matched,
    score,
    tipo,
    item_ids: itemMatches.map((item) => item.id),
    pn_exato: exactPnItems.length ? q : null,
    sn_exato: exactSnItems.length ? q : null,
    quantidade: quantityBase.reduce((sum, item) => sum + normalizeNumber(item.quantidade), 0),
  };
}

async function searchReceiptIds(query = '', limit = 2000) {
  const term = String(query || '').trim();
  if (!term) return null;

  const { data, error } = await supabase
    .from('v_sisha_receipt_search')
    .select('recebimento_id')
    .ilike('search_text', `%${term}%`)
    .limit(limit);
  if (error) throw error;
  return [...new Set((data || []).map((row) => row.recebimento_id).filter(Boolean))];
}

async function fetchReceipts(query = '', receiptId = null, options = {}) {
  const includeEvents = Boolean(options.includeEvents);
  const limit = Math.max(1, Math.min(Number(options.limit) || 300, 5000));
  const relation = includeEvents
    ? '*, recebimento_itens(*), recebimento_eventos(*)'
    : '*, recebimento_itens(*)';

  let request = supabase
    .from('recebimentos')
    .select(relation)
    .neq('ativo', false)
    .order('data_recebimento', { ascending: false })
    .order('created_at', { ascending: false })
    .limit(limit);

  if (receiptId) {
    request = request.eq('id', receiptId);
  } else if (String(query || '').trim()) {
    const receiptIds = await searchReceiptIds(query);
    if (!receiptIds.length) return [];
    request = request.in('id', receiptIds.slice(0, limit));
  }

  const { data, error } = await request;
  if (error) throw error;

  return (data || [])
    .map((receipt) => {
      const match = buildMatch(receipt, query);
      return {
        ...receipt,
        recebimento_itens: activeItems(receipt),
        recebimento_eventos: includeEvents
          ? (receipt.recebimento_eventos || []).sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
          : [],
        _match: match,
      };
    })
    .filter((receipt) => receipt._match.matched)
    .sort((a, b) => b._match.score - a._match.score || String(b.data_recebimento || '').localeCompare(String(a.data_recebimento || '')));
}

function bodyToSavePayload(body = {}, current = {}) {
  return {
    numeroRecibo: body.numero_recibo ?? current.numero_recibo,
    tipoRecebimento: body.tipo_recebimento ?? current.tipo_recebimento,
    dataRecebimento: body.data_recebimento ?? current.data_recebimento,
    documentoReferencia: body.documento_referencia ?? current.documento_referencia,
    fornecedor: body.fornecedor ?? current.fornecedor,
    origemMaterial: body.origem_material ?? current.origem_material,
    programaOrigem: body.programa_origem ?? current.programa_origem,
    programaOrigemFonte: body.programa_origem_fonte ?? current.programa_origem_fonte,
    codigoOmRecebedora: body.codigo_om_recebedora ?? current.codigo_om_recebedora,
    siglaRecebedora: body.sigla_recebedora ?? current.sigla_recebedora,
    recebidoPorNome: body.recebido_por_nome ?? current.recebido_por_nome,
    conferidoPorNome: body.conferido_por_nome ?? current.conferido_por_nome,
    metodoImportacao: body.metodo_importacao ?? current.metodo_importacao ?? 'MANUAL',
    arquivoNome: body.arquivo_nome ?? current.arquivo_nome,
    arquivoHash: body.arquivo_hash ?? current.arquivo_hash,
    chatLinceDocumentoId: body.chat_lince_documento_id ?? current.chat_lince_documento_id,
    isFoc: body.is_foc ?? current.is_foc,
    observacao: body.observacao ?? current.observacao,
    avisosTriagem: body.avisos_triagem ?? current.avisos_triagem ?? [],
    dadosOriginais: body.dados_originais ?? current.dados_originais ?? {},
  };
}

async function finalizeAiDocument(receipt, user) {
  if (!receipt?.chat_lince_documento_id) return receipt;
  try {
    await confirmDocumentAnalysis({
      id: receipt.chat_lince_documento_id,
      user,
      observacaoAdmin: `Recibo ${receipt.numero_recibo} validado e salvo no módulo de recebimentos.`,
      destinoAdmin: 'recebimentos',
    });
    return receipt;
  } catch (error) {
    const warning = `O recibo foi salvo, mas o documento do Chat Lince não pôde ser finalizado no staging: ${error.message || String(error)}`;
    return {
      ...receipt,
      _avisos_sincronizacao: [...(receipt._avisos_sincronizacao || []), warning],
    };
  }
}

exports.listar = async (req, res) => {
  try {
    const data = await fetchReceipts(req.query.q || '', null, { limit: 300 });
    return res.status(200).json({
      status: 'success',
      data,
      meta: {
        total: data.length,
        busca: req.query.q || null,
        quantidade_encontrada: data.reduce((sum, receipt) => sum + normalizeNumber(receipt._match?.quantidade), 0),
      },
    });
  } catch (error) {
    console.error('[SISHA][recebimentos] listar:', error);
    return res.status(500).json({ status: 'error', message: error.message || 'Falha ao consultar recibos.' });
  }
};

exports.obter = async (req, res) => {
  try {
    const data = await fetchReceipts(req.query.q || '', req.params.id, { includeEvents: true, limit: 1 });
    if (!data.length) return res.status(404).json({ status: 'error', message: 'Recibo não encontrado.' });
    return res.status(200).json({ status: 'success', data: data[0] });
  } catch (error) {
    console.error('[SISHA][recebimentos] obter:', error);
    return res.status(500).json({ status: 'error', message: error.message || 'Falha ao abrir o recibo.' });
  }
};

exports.criar = async (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    let receipt = await saveReceipt({
      header: bodyToSavePayload(req.body),
      items: Array.isArray(req.body.itens) ? req.body.itens : [],
      actor: req.user,
    });
    receipt = await finalizeAiDocument(receipt, req.user);

    await registrarAuditoria({
      req,
      action: 'RECIBO_CRIADO',
      entity: 'RECEBIMENTO',
      entityId: receipt.id,
      summary: `Recibo ${receipt.numero_recibo} criado após triagem humana.`,
      details: { itens: (receipt.recebimento_itens || []).length, metodo: receipt.metodo_importacao },
      visibility: 'PUBLIC',
    });

    const warnings = receipt._avisos_sincronizacao || [];
    return res.status(201).json({
      status: warnings.length ? 'success_with_warnings' : 'success',
      message: warnings.length
        ? 'Recibo salvo e saldo temporário atualizado. Há uma pendência de reconciliação com o Order Book/FOC registrada no histórico.'
        : 'Recibo salvo. O saldo pendente permanece identificado pelo Recibo/local temporário; recebimentos destinados diretamente ao CEIMSPA aparecem separados do estoque oficial até a incorporação.',
      warnings,
      data: receipt,
    });
  } catch (error) {
    console.error('[SISHA][recebimentos] criar:', error);
    const statusCode = ['RECEIPT_REFERENCE_REQUIRED', 'RECEIPT_ITEMS_REQUIRED', 'RECEIPT_SERIAL_QUANTITY_MISMATCH', 'RECEIPT_SERIAL_INVENTORY_MISMATCH', 'RECEIPT_STOCK_DESTINATION_REQUIRED'].includes(error.code) ? 400 : 500;
    return res.status(statusCode).json({ status: 'error', message: error.message || 'Falha ao criar recibo.' });
  }
};

exports.atualizar = async (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    const { data: current, error: currentError } = await supabase
      .from('recebimentos')
      .select('*')
      .eq('id', req.params.id)
      .single();
    if (currentError) throw currentError;

    let receipt = await saveReceipt({
      receiptId: current.id,
      header: bodyToSavePayload(req.body, current),
      items: Array.isArray(req.body.itens) ? req.body.itens : [],
      actor: req.user,
    });
    receipt = await finalizeAiDocument(receipt, req.user);

    await registrarAuditoria({
      req,
      action: 'RECIBO_EDITADO',
      entity: 'RECEBIMENTO',
      entityId: receipt.id,
      summary: `Recibo ${receipt.numero_recibo} editado.`,
      details: {
        itens: (receipt.recebimento_itens || []).length,
        saldo_temporario: (receipt.recebimento_itens || [])
          .filter((item) => item.condicao_item === 'RECEBIDO_DISPONIVEL' && item.contabiliza_pelo_recibo !== false)
          .reduce((sum, item) => sum + Math.max(0, normalizeNumber(item.quantidade) - normalizeNumber(item.quantidade_inventariada)), 0),
      },
      visibility: 'PUBLIC',
    });

    const warnings = receipt._avisos_sincronizacao || [];
    return res.status(200).json({
      status: warnings.length ? 'success_with_warnings' : 'success',
      message: warnings.length
        ? 'Recibo atualizado e histórico preservado. Há uma pendência de reconciliação com o Order Book/FOC registrada no histórico.'
        : 'Recibo atualizado. O histórico foi preservado; itens marcados continuam no saldo do recibo e itens desmarcados permanecem apenas como rastreabilidade do estoque oficial informado.',
      warnings,
      data: receipt,
    });
  } catch (error) {
    console.error('[SISHA][recebimentos] atualizar:', error);
    const statusCode = ['RECEIPT_REFERENCE_REQUIRED', 'RECEIPT_ITEMS_REQUIRED', 'RECEIPT_SERIAL_QUANTITY_MISMATCH', 'RECEIPT_SERIAL_INVENTORY_MISMATCH', 'RECEIPT_STOCK_DESTINATION_REQUIRED'].includes(error.code) ? 400 : 500;
    return res.status(statusCode).json({ status: 'error', message: error.message || 'Falha ao atualizar recibo.' });
  }
};

exports.excluir = async (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    const data = await deactivateReceipt(req.params.id, req.user);
    await registrarAuditoria({
      req,
      action: 'RECIBO_EXCLUIDO_LOGICAMENTE',
      entity: 'RECEBIMENTO',
      entityId: req.params.id,
      summary: `Recibo ${data.numero_recibo} desativado.`,
      details: { numero_recibo: data.numero_recibo },
      visibility: 'GOD',
    });
    const warnings = data._avisos_sincronizacao || [];
    return res.status(200).json({
      status: warnings.length ? 'success_with_warnings' : 'success',
      message: warnings.length
        ? 'Recibo desativado logicamente e histórico preservado. Há uma pendência de reconciliação com o Order Book/FOC registrada no histórico.'
        : 'Recibo desativado logicamente. Ele deixou de compor o saldo temporário, mas o histórico foi preservado.',
      warnings,
    });
  } catch (error) {
    console.error('[SISHA][recebimentos] excluir:', error);
    return res.status(500).json({ status: 'error', message: error.message || 'Falha ao desativar recibo.' });
  }
};

function appendWorkbookSheets(workbook, receipts) {
  const headers = receipts.map((receipt) => {
    const items = activeItems(receipt);
    return {
      id: receipt.id,
      numero_recibo: receipt.numero_recibo,
      tipo_recebimento: receipt.tipo_recebimento,
      data_recebimento: receipt.data_recebimento,
      documento_referencia: receipt.documento_referencia,
      fornecedor: receipt.fornecedor,
      origem_material: receipt.origem_material,
      programa_origem: receipt.programa_origem,
      programa_origem_fonte: receipt.programa_origem_fonte,
      codigo_om_recebedora: receipt.codigo_om_recebedora,
      sigla_recebedora: receipt.sigla_recebedora,
      recebido_por: receipt.recebido_por_nome,
      conferido_por: receipt.conferido_por_nome,
      metodo_importacao: receipt.metodo_importacao,
      arquivo_nome: receipt.arquivo_nome,
      is_foc: receipt.is_foc,
      observacao: receipt.observacao,
      avisos_triagem: JSON.stringify(receipt.avisos_triagem || []),
      total_linhas: items.length,
      quantidade_total: items.reduce((sum, item) => sum + normalizeNumber(item.quantidade), 0),
      quantidade_saldo_temporario: items
        .filter((item) => item.condicao_item === 'RECEBIDO_DISPONIVEL' && item.contabiliza_pelo_recibo !== false)
        .reduce((sum, item) => sum + Math.max(0, normalizeNumber(item.quantidade) - normalizeNumber(item.quantidade_inventariada)), 0),
    };
  });

  const items = receipts.flatMap((receipt) => activeItems(receipt).map((item) => ({
    numero_recibo: receipt.numero_recibo,
    data_recebimento: receipt.data_recebimento,
    sequencia_item: item.sequencia_item,
    pn: item.pn,
    nsn_pi: item.nsn_pi,
    nomenclatura: item.nomenclatura,
    quantidade_recebida: item.quantidade,
    quantidade_inventariada: item.quantidade_inventariada,
    saldo_temporario: item.condicao_item === 'RECEBIDO_DISPONIVEL' && item.contabiliza_pelo_recibo !== false
      ? Math.max(0, normalizeNumber(item.quantidade) - normalizeNumber(item.quantidade_inventariada))
      : 0,
    sn: item.sn,
    tipo_item: item.tipo_item,
    local_temporario: item.localizacao_ppu,
    destino_previsto: item.destino_previsto || '',
    destino_previsto_fonte: item.destino_previsto_fonte || '',
    incorporado_em_estoque: item.destino_estoque || '',
    contabiliza_pelo_recibo: item.contabiliza_pelo_recibo !== false,
    condicao_item: item.condicao_item,
    validade_status: item.validade_status || 'NAO_INFORMADA',
    validade_observacao: item.validade_observacao || '',
    sn_extraido_documento: Boolean(item.sn_extraido_documento),
    equipamento_id: item.equipamento_id || '',
    ja_incorporado_estoque_oficial: item.contabiliza_pelo_recibo === false || item.inventariado_ppu,
    inventariado_em: item.inventariado_em,
    documento_referencia: item.documento_referencia,
    delivery_note: item.delivery_note,
    invoice_no: item.invoice_no,
    di: item.di,
    batch_no: item.batch_no,
    coc_no: item.coc_no,
    status_documento: item.status_documento,
    data_garantia: item.data_garantia,
    moeda: item.moeda,
    valor_unitario: item.valor_unitario,
    valor_total_calculado: item.valor_total,
    valor_total_documento: item.valor_total_documento,
    observacao_item: item.observacao_item,
  })));

  const events = receipts.flatMap((receipt) => (receipt.recebimento_eventos || []).map((event) => ({
    numero_recibo: receipt.numero_recibo,
    tipo_evento: event.tipo_evento,
    item_id: event.recebimento_item_id,
    criado_por: event.created_by_email,
    criado_em: event.created_at,
    detalhe_json: JSON.stringify(event.detalhe || {}),
  })));

  XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(headers.length ? headers : [{}]), 'Recibos');
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(items.length ? items : [{}]), 'Itens');
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(events.length ? events : [{}]), 'Histórico');
}

async function exportReceipts(req, res, receiptId = null) {
  const receipts = await fetchReceipts(req.query.q || '', receiptId, { includeEvents: true, limit: receiptId ? 1 : 5000 });
  if (receiptId && !receipts.length) return res.status(404).json({ status: 'error', message: 'Recibo não encontrado.' });

  const workbook = XLSX.utils.book_new();
  appendWorkbookSheets(workbook, receipts);
  const buffer = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });
  const suffix = receiptId && receipts[0]
    ? String(receipts[0].numero_recibo).replace(/[^a-z0-9_-]/gi, '_')
    : new Date().toISOString().slice(0, 10);
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="SISHA_Recibos_${suffix}.xlsx"`);
  return res.status(200).send(buffer);
}



exports.criarLotePersistente = async (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    const files = Array.isArray(req.files) ? req.files : [];
    if (!files.length) return res.status(400).json({ status: 'error', message: 'Selecione um ZIP ou documentos de recibo.' });
    const job = await createReceiptImportJob({ files, actor: req.user, requestId: req.requestId || req.auditContext?.requestId || null });
    return res.status(202).json({
      status: 'success',
      message: `Lote persistente criado com ${job.total_items || job.items?.length || 0} documento(s). Você pode fechar esta página; o backend continuará a triagem.`,
      data: job,
    });
  } catch (error) {
    console.error('[SISHA][recebimentos] criar lote persistente:', error);
    const statusCode = /R2|ZIP|150|Selecione|apenas um ZIP/i.test(error.message || '') ? 400 : 500;
    return res.status(statusCode).json({ status: 'error', message: error.message || 'Falha ao criar lote persistente de recibos.' });
  }
};

exports.listarLotesPersistentes = async (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    const jobs = await listReceiptImportJobs(req.query.limit || 20);
    return res.status(200).json({ status: 'success', data: jobs });
  } catch (error) {
    console.error('[SISHA][recebimentos] listar lotes:', error);
    return res.status(500).json({ status: 'error', message: error.message || 'Falha ao listar lotes de recibos.' });
  }
};

exports.obterLotePersistente = async (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    const job = await getReceiptImportJob(req.params.jobId);
    return res.status(200).json({ status: 'success', data: job });
  } catch (error) {
    console.error('[SISHA][recebimentos] obter lote:', error);
    return res.status(404).json({ status: 'error', message: error.message || 'Lote não encontrado.' });
  }
};

exports.marcarItemLoteSalvo = async (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    await markReceiptImportItemSaved({
      itemId: req.params.itemId,
      actor: req.user,
      requestId: req.requestId || req.auditContext?.requestId || null,
    });
    return res.status(200).json({ status: 'success', message: 'Item do lote marcado como salvo após confirmação humana.' });
  } catch (error) {
    console.error('[SISHA][recebimentos] marcar item lote salvo:', error);
    return res.status(500).json({ status: 'error', message: error.message || 'Falha ao atualizar item do lote.' });
  }
};

exports.descompactarLote = async (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    if (!req.file?.buffer) {
      return res.status(400).json({ status: 'error', message: 'Envie um arquivo ZIP com os recibos.' });
    }
    const unpacked = unpackReceiptZip(req.file.buffer);
    return res.json({
      status: 'success',
      message: `${unpacked.files.length} arquivo(s) de recibo preparado(s) para triagem. Nada foi gravado.`,
      data: {
        archive_name: req.file.originalname || 'recibos.zip',
        files: unpacked.files,
        ignored: unpacked.ignored,
      },
    });
  } catch (error) {
    console.error('[SISHA][recebimentos] descompactar lote:', error);
    return res.status(400).json({ status: 'error', message: error.message || 'Falha ao abrir o ZIP de recibos.' });
  }
};

exports.exportar = async (req, res) => {
  try {
    return await exportReceipts(req, res);
  } catch (error) {
    console.error('[SISHA][recebimentos] exportar:', error);
    return res.status(500).json({ status: 'error', message: 'Falha ao exportar recibos.' });
  }
};

exports.exportarUm = async (req, res) => {
  try {
    return await exportReceipts(req, res, req.params.id);
  } catch (error) {
    console.error('[SISHA][recebimentos] exportar um:', error);
    return res.status(500).json({ status: 'error', message: 'Falha ao exportar o recibo.' });
  }
};
