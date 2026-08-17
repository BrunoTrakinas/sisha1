const XLSX = require('xlsx');
const {
  listEquipments,
  getEquipment,
  createEquipment,
  updateEquipment,
  removeEquipment,
  addEvent,
  invalidateEvent,
  fetchEventsForEquipmentIds,
  listLocationConflicts,
  resolveLocationConflict,
  applyEquipmentMaster,
  applyEquipmentInventory,
  listEquipmentReconciliation,
  listEquipmentInventoryImports,
} = require('../services/equipmentService');
const { registrarAuditoria } = require('../utils/auditLogger');
const { parseEquipmentInventory, parseEquipmentMaster } = require('../utils/equipmentInventoryParser');
const stcEquipmentService = require('../services/stcEquipmentService');
const osPimEquipmentService = require('../services/osPimEquipmentService');
const equipmentOperationalService = require('../services/equipmentOperationalService');
const equipmentReliabilityService = require('../services/equipmentReliabilityService');

function replyError(res, error, fallback = 'Falha ao processar equipamentos.') {
  const message = error?.message || fallback;
  const status = /não encontrado/i.test(message) ? 404 : /obrigat|já existe|inválid|informe|não pode|reconcil/i.test(message) ? 400 : 500;
  return res.status(status).json({ status: 'error', message });
}

exports.listar = async (req, res) => {
  try {
    const data = await listEquipments({ q: req.query.q || '', limit: req.query.limit || 250 });
    return res.status(200).json({ status: 'success', data, meta: { total: data.length, busca: req.query.q || null } });
  } catch (error) {
    console.error('[SISHA][equipamentos] listar:', error);
    return replyError(res, error, 'Falha ao consultar equipamentos.');
  }
};

exports.obter = async (req, res) => {
  try {
    const data = await getEquipment(req.params.id);
    if (!data) return res.status(404).json({ status: 'error', message: 'Equipamento não encontrado.' });
    return res.status(200).json({ status: 'success', data });
  } catch (error) {
    console.error('[SISHA][equipamentos] obter:', error);
    return replyError(res, error, 'Falha ao abrir o dossiê do equipamento.');
  }
};

exports.criar = async (req, res) => {
  try {
    const data = await createEquipment(req.body || {}, req.user || {});
    await registrarAuditoria({
      req,
      action: 'CREATE',
      entity: 'EQUIPAMENTO_SERIALIZADO',
      entityId: data.id,
      summary: `Equipamento ${data.pn} / SN ${data.sn} cadastrado.`,
      details: { pn: data.pn, sn: data.sn },
      visibility: 'PUBLIC',
    });
    return res.status(201).json({ status: 'success', data });
  } catch (error) {
    console.error('[SISHA][equipamentos] criar:', error);
    return replyError(res, error, 'Falha ao cadastrar equipamento.');
  }
};

exports.atualizar = async (req, res) => {
  try {
    const before = await getEquipment(req.params.id);
    if (!before) return res.status(404).json({ status: 'error', message: 'Equipamento não encontrado.' });
    const data = await updateEquipment(req.params.id, req.body || {}, req.user || {});
    await registrarAuditoria({
      req,
      action: 'UPDATE',
      entity: 'EQUIPAMENTO_SERIALIZADO',
      entityId: data.id,
      summary: `Cadastro técnico/garantia do equipamento ${data.pn} / SN ${data.sn} atualizado.`,
      details: { before, after: data },
      visibility: 'PUBLIC',
    });
    return res.status(200).json({ status: 'success', data });
  } catch (error) {
    console.error('[SISHA][equipamentos] atualizar:', error);
    return replyError(res, error, 'Falha ao atualizar equipamento.');
  }
};

exports.remover = async (req, res) => {
  try {
    const before = await getEquipment(req.params.id);
    if (!before) return res.status(404).json({ status: 'error', message: 'Equipamento não encontrado.' });
    const result = await removeEquipment(req.params.id, req.user || {});
    await registrarAuditoria({
      req,
      action: result.mode === 'DELETE' ? 'DELETE' : 'ARCHIVE',
      entity: 'EQUIPAMENTO_SERIALIZADO',
      entityId: req.params.id,
      summary: result.mode === 'DELETE'
        ? `Equipamento ${before.pn} / SN ${before.sn} excluído por não possuir histórico.`
        : `Equipamento ${before.pn} / SN ${before.sn} arquivado; histórico preservado.`,
      details: { before, result },
      visibility: 'PUBLIC',
    });
    return res.status(200).json({
      status: 'success',
      message: result.mode === 'DELETE'
        ? 'Equipamento sem histórico excluído.'
        : 'Equipamento arquivado. O Livro de Eventos foi preservado.',
      data: result,
    });
  } catch (error) {
    console.error('[SISHA][equipamentos] remover/arquivar:', error);
    return replyError(res, error, 'Falha ao excluir/arquivar equipamento.');
  }
};

exports.listarConflitosLocalizacao = async (req, res) => {
  try {
    const data = await listLocationConflicts(req.query.limit || 250);
    return res.status(200).json({ status: 'success', data, meta: { total: data.length } });
  } catch (error) {
    console.error('[SISHA][equipamentos] conflitos de localização:', error);
    return replyError(res, error, 'Falha ao consultar conflitos de localização.');
  }
};

exports.resolverConflitoLocalizacao = async (req, res) => {
  try {
    const result = await resolveLocationConflict(req.params.id, req.params.eventId, req.body || {}, req.user || {});
    await registrarAuditoria({
      req,
      action: 'RECONCILE_LOCATION',
      entity: 'EQUIPAMENTO_SERIALIZADO',
      entityId: req.params.id,
      summary: `Conflito de localização do equipamento ${result.equipamento?.pn || ''} / SN ${result.equipamento?.sn || ''} reconciliado.`,
      details: { decision: req.body?.decision, motivo: req.body?.motivo, conflict_event_id: req.params.eventId },
      visibility: 'PUBLIC',
    });
    return res.status(200).json({ status: 'success', message: 'Localização reconciliada e registrada no Livro de Eventos.', data: result });
  } catch (error) {
    console.error('[SISHA][equipamentos] resolver conflito:', error);
    return replyError(res, error, 'Falha ao reconciliar localização.');
  }
};

exports.registrarEvento = async (req, res) => {
  try {
    const event = await addEvent(req.params.id, req.body || {}, req.user || {});
    const data = await getEquipment(req.params.id);
    await registrarAuditoria({
      req,
      action: 'MOVEMENT',
      entity: 'EQUIPAMENTO_SERIALIZADO',
      entityId: req.params.id,
      summary: `${data.pn} / SN ${data.sn}: ${event.tipo_evento} → ${event.local_destino || event.categoria_destino || 'sem local informado'}.`,
      details: { event },
      visibility: 'PUBLIC',
    });
    return res.status(201).json({ status: 'success', data, event });
  } catch (error) {
    console.error('[SISHA][equipamentos] registrar evento:', error);
    return replyError(res, error, 'Falha ao registrar movimentação.');
  }
};

exports.invalidarEvento = async (req, res) => {
  try {
    const data = await invalidateEvent(req.params.id, req.params.eventId, req.body?.motivo, req.user || {});
    await registrarAuditoria({
      req,
      action: 'INVALIDATE_EVENT',
      entity: 'EQUIPAMENTO_SERIALIZADO',
      entityId: req.params.id,
      summary: `Evento ${req.params.eventId} invalidado sem apagar o histórico.`,
      details: { event_id: req.params.eventId, motivo: req.body?.motivo },
      visibility: 'PUBLIC',
    });
    return res.status(200).json({ status: 'success', data });
  } catch (error) {
    console.error('[SISHA][equipamentos] invalidar evento:', error);
    return replyError(res, error, 'Falha ao invalidar evento.');
  }
};

exports.exportar = async (req, res) => {
  try {
    const equipments = await listEquipments({ q: req.query.q || '', limit: 500 });
    const events = await fetchEventsForEquipmentIds(equipments.map((item) => item.id));

    const equipmentRows = equipments.map((item) => ({
      PN: item.pn,
      SN: item.sn,
      Nomenclatura: item.nomenclatura || '',
      Categoria_Local: item.categoria_local_atual || '',
      Local_Atual: item.local_atual || '',
      Aeronave: item.anv_atual || '',
      Status: item.status_atual || '',
      Condicao: item.condicao_atual || '',
      Confianca_Localizacao: item.confianca_localizacao || '',
      Garantia_Inicio: item.garantia_inicio || '',
      Garantia_Vencimento: item.garantia_vencimento || '',
      Garantia_Documento: item.garantia_documento || '',
      Garantia_Observacao: item.garantia_observacao || '',
      Ultima_Evidencia: item.ultima_evidencia_documento || '',
      Ultima_Evidencia_Tipo: item.ultima_evidencia_tipo || '',
      Ultima_Evidencia_Em: item.ultima_evidencia_em || '',
      Presente_Ultimo_Inventario_Serializado: item.presente_ultimo_inventario_serializado === true ? 'SIM' : item.presente_ultimo_inventario_serializado === false ? 'NAO' : '',
      Ultimo_Inventario_Serializado_Em: item.ultimo_inventario_serializado_em || '',
      Ultimo_Inventario_Serializado_Arquivo: item.ultimo_inventario_serializado_arquivo || '',
      Local_Informado_No_Ultimo_Inventario: item.local_inventario_serializado || '',
    }));

    const eventRows = events.map((event) => ({
      PN: event.pn,
      SN: event.sn,
      Data: event.data_evento,
      Evento: event.tipo_evento,
      Origem: event.local_origem || '',
      Destino: event.local_destino || '',
      Categoria_Origem: event.categoria_origem || '',
      Categoria_Destino: event.categoria_destino || '',
      Aeronave: event.anv_destino || event.anv || '',
      Documento_Tipo: event.documento_tipo || '',
      Documento: event.documento || '',
      PIM: event.pim || '',
      OS: event.os || '',
      Status_Resultante: event.status_resultante || '',
      Condicao_Resultante: event.condicao_resultante || '',
      Motivo: event.motivo || '',
      Observacao: event.observacao || '',
      Confianca: event.confianca || '',
      Automatico: event.automatico ? 'SIM' : 'NAO',
      Invalidado: event.invalidado ? 'SIM' : 'NAO',
      Motivo_Invalidacao: event.motivo_invalidacao || '',
      Usuario: event.usuario || '',
    }));

    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(equipmentRows), 'Equipamentos');
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(eventRows), 'Historico');
    const buffer = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="SISHA_Rastreabilidade_Equipamentos.xlsx"');
    return res.status(200).send(buffer);
  } catch (error) {
    console.error('[SISHA][equipamentos] exportar:', error);
    return replyError(res, error, 'Falha ao exportar equipamentos.');
  }
};


exports.previewCadastroMestre = async (req, res) => {
  try {
    if (!req.file?.buffer) return res.status(400).json({ status: 'error', message: 'Selecione o arquivo ou ZIP do Cadastro Mestre.' });
    const parsed = parseEquipmentMaster(req.file.buffer, req.file.originalname || 'cadastro_mestre_equipamentos');
    return res.status(200).json({
      status: 'success',
      message: `${parsed.linhas_validas} equipamentos PN + SN identificados. Localização é opcional e nunca será inventada.`,
      data: parsed,
    });
  } catch (error) {
    console.error('[SISHA][equipamentos] preview cadastro mestre:', error);
    return replyError(res, error, 'Falha ao ler o Cadastro Mestre de equipamentos.');
  }
};

exports.aplicarCadastroMestre = async (req, res) => {
  try {
    const result = await applyEquipmentMaster(req.body || {}, req.user || {});
    await registrarAuditoria({
      req,
      action: 'IMPORT_EQUIPMENT_MASTER',
      entity: 'EQUIPAMENTO_CADASTRO_MESTRE',
      entityId: null,
      summary: `Cadastro Mestre processou ${result.processados || 0} PN+SN: ${result.criados || 0} novos e ${result.conflitos_localizacao || 0} conflito(s) de localização.`,
      details: result,
      visibility: 'PUBLIC',
    });
    return res.status(200).json({
      status: 'success',
      message: result.conflitos_localizacao
        ? `Cadastro Mestre aplicado. ${result.conflitos_localizacao} localização(ões) ficaram pendentes de confirmação; nenhuma delas sobrescreveu o estado atual.`
        : 'Cadastro Mestre aplicado com sucesso.',
      data: result,
    });
  } catch (error) {
    console.error('[SISHA][equipamentos] aplicar cadastro mestre:', error);
    return replyError(res, error, 'Falha ao aplicar o Cadastro Mestre de equipamentos.');
  }
};

exports.previewInventario = async (req, res) => {
  try {
    if (!req.file?.buffer) return res.status(400).json({ status: 'error', message: 'Selecione o arquivo do inventário de equipamentos.' });
    const parsed = parseEquipmentInventory(req.file.buffer, req.file.originalname || 'inventario_equipamentos');
    return res.status(200).json({
      status: 'success',
      message: `${parsed.linhas_validas} equipamentos válidos identificados para conferência.`,
      data: parsed,
    });
  } catch (error) {
    console.error('[SISHA][equipamentos] preview inventário:', error);
    return replyError(res, error, 'Falha ao ler o inventário de equipamentos.');
  }
};

exports.aplicarInventario = async (req, res) => {
  try {
    const result = await applyEquipmentInventory(req.body || {}, req.user || {});
    await registrarAuditoria({
      req,
      action: 'IMPORT_EQUIPMENT_INVENTORY',
      entity: 'EQUIPAMENTO_INVENTARIO',
      entityId: result.importacao_id || null,
      summary: `Inventário serializado aplicado em modo ${result.modo || req.body?.mode || 'MERGE'} com ${result.processados || 0} equipamentos.`,
      details: result,
      visibility: 'PUBLIC',
    });
    return res.status(200).json({ status: 'success', message: 'Inventário de equipamentos aplicado com rastreabilidade.', data: result });
  } catch (error) {
    console.error('[SISHA][equipamentos] aplicar inventário:', error);
    return replyError(res, error, 'Falha ao aplicar o inventário de equipamentos.');
  }
};

exports.reconciliacaoPpu = async (req, res) => {
  try {
    const data = await listEquipmentReconciliation({ q: req.query.q || '', limit: req.query.limit || 500 });
    const resumo = data.reduce((acc, row) => {
      acc.ppu += Number(row.qtd_ppu || 0);
      acc.serializados += Number(row.qtd_serializada || 0);
      acc.identificados += Number(row.qtd_identificada || 0);
      acc.semSn += Number(row.qtd_ppu_sem_sn || 0);
      acc.excedentes += Number(row.qtd_sn_sem_ppu || 0);
      if (row.status_reconciliacao === 'CONCILIADO') acc.conciliados += 1;
      else acc.divergencias += 1;
      return acc;
    }, { ppu: 0, serializados: 0, identificados: 0, semSn: 0, excedentes: 0, conciliados: 0, divergencias: 0 });
    return res.status(200).json({ status: 'success', data, meta: resumo });
  } catch (error) {
    console.error('[SISHA][equipamentos] reconciliação PPU:', error);
    return replyError(res, error, 'Falha ao reconciliar PPU e inventário serializado.');
  }
};

exports.listarImportacoesInventario = async (req, res) => {
  try {
    const data = await listEquipmentInventoryImports(req.query.limit || 30);
    return res.status(200).json({ status: 'success', data });
  } catch (error) {
    console.error('[SISHA][equipamentos] histórico de inventários:', error);
    return replyError(res, error, 'Falha ao consultar histórico de inventários de equipamentos.');
  }
};

exports.listarStc = async (req, res) => {
  try {
    const data = await stcEquipmentService.listStcCards({ q: req.query.q || '', limit: req.query.limit || 500 });
    return res.status(200).json({ status: 'success', data, meta: { total: data.length, busca: req.query.q || null } });
  } catch (error) {
    console.error('[SISHA][equipamentos][STC] listar:', error);
    return replyError(res, error, 'Falha ao consultar STCs.');
  }
};

exports.criarStc = async (req, res) => {
  try {
    const result = await stcEquipmentService.saveStc(req.body || {}, req.user || {});
    await registrarAuditoria({
      req,
      action: 'CREATE_STC',
      entity: 'EQUIPAMENTO_STC',
      entityId: result.card_key,
      summary: `STC ${result.numero_stc} registrada para PN ${result.pn} / SN ${result.sn}.`,
      details: result,
      visibility: 'PUBLIC',
    });
    return res.status(201).json({
      status: 'success',
      message: result.conflito_localizacao
        ? 'STC registrada. A nova localização conflita com o estado atual e foi enviada para reconciliação.'
        : 'STC registrada e vinculada ao Livro de Eventos do equipamento.',
      data: result,
    });
  } catch (error) {
    console.error('[SISHA][equipamentos][STC] criar:', error);
    return replyError(res, error, 'Falha ao registrar STC.');
  }
};

exports.atualizarStc = async (req, res) => {
  try {
    const cardKey = decodeURIComponent(req.params.cardKey || '');
    const before = await stcEquipmentService.getStcCard(cardKey);
    if (!before) return res.status(404).json({ status: 'error', message: 'STC não encontrada.' });
    const payload = {
      ...(req.body || {}),
      equipment_id: before.equipment_id,
      pn: before.pn,
      sn: before.sn,
      numero_stc: before.numero_stc,
    };
    const result = await stcEquipmentService.saveStc(payload, req.user || {}, cardKey);
    await registrarAuditoria({
      req,
      action: 'UPDATE_STC',
      entity: 'EQUIPAMENTO_STC',
      entityId: cardKey,
      summary: `STC ${before.numero_stc} atualizada para PN ${before.pn} / SN ${before.sn}.`,
      details: { before, result },
      visibility: 'PUBLIC',
    });
    return res.status(200).json({
      status: 'success',
      message: result.conflito_localizacao
        ? 'STC atualizada. A alteração de localização gerou conflito para reconciliação.'
        : 'STC atualizada. O Livro do equipamento foi sincronizado.',
      data: result,
    });
  } catch (error) {
    console.error('[SISHA][equipamentos][STC] atualizar:', error);
    return replyError(res, error, 'Falha ao atualizar STC.');
  }
};

exports.cancelarStc = async (req, res) => {
  try {
    const cardKey = decodeURIComponent(req.params.cardKey || '');
    const before = await stcEquipmentService.getStcCard(cardKey);
    if (!before) return res.status(404).json({ status: 'error', message: 'STC não encontrada.' });
    const result = await stcEquipmentService.cancelStc(cardKey, req.body?.motivo, req.user || {});
    await registrarAuditoria({
      req,
      action: 'CANCEL_STC',
      entity: 'EQUIPAMENTO_STC',
      entityId: cardKey,
      summary: `STC ${before.numero_stc} cancelada sem apagar o histórico do equipamento.`,
      details: { motivo: req.body?.motivo, before, result },
      visibility: 'PUBLIC',
    });
    return res.status(200).json({ status: 'success', message: 'STC cancelada. Os eventos anteriores foram invalidados, não apagados.', data: result });
  } catch (error) {
    console.error('[SISHA][equipamentos][STC] cancelar:', error);
    return replyError(res, error, 'Falha ao cancelar STC.');
  }
};

exports.listarOsPim = async (req, res) => {
  try {
    const data = await osPimEquipmentService.listMovementCards({ q: req.query.q || '', limit: req.query.limit || 500 });
    return res.status(200).json({ status: 'success', data, meta: { total: data.length, busca: req.query.q || null } });
  } catch (error) {
    console.error('[SISHA][equipamentos][OS_PIM] listar:', error);
    return replyError(res, error, 'Falha ao consultar movimentações OS/PIM.');
  }
};

exports.criarOsPim = async (req, res) => {
  try {
    const result = await osPimEquipmentService.saveMovement(req.body || {}, req.user || {});
    await registrarAuditoria({
      req,
      action: 'CREATE_OS_PIM_MOVEMENT',
      entity: 'EQUIPAMENTO_OS_PIM',
      entityId: result.card_key,
      summary: `${result.tipo_movimento} ${result.documento || result.os || result.pim || ''} vinculada ao PN ${result.pn} / SN ${result.sn}.`,
      details: result,
      visibility: 'PUBLIC',
    });
    return res.status(201).json({
      status: 'success',
      message: result.conflito_localizacao
        ? 'Movimentação registrada, mas a nova posição conflita com o estado atual e aguarda reconciliação.'
        : 'Movimentação OS/PIM registrada no Livro do Equipamento.',
      data: result,
    });
  } catch (error) {
    console.error('[SISHA][equipamentos][OS_PIM] criar:', error);
    return replyError(res, error, 'Falha ao registrar movimentação OS/PIM.');
  }
};

exports.atualizarOsPim = async (req, res) => {
  try {
    const cardKey = decodeURIComponent(req.params.cardKey || '');
    const before = await osPimEquipmentService.getMovementCard(cardKey);
    if (!before) return res.status(404).json({ status: 'error', message: 'Movimentação OS/PIM não encontrada.' });
    const payload = {
      ...(req.body || {}),
      equipment_id: before.equipment_id,
      pn: before.pn,
      sn: before.sn,
      os: before.os,
      osr: before.osr,
      pim: before.pim,
      tipo_movimento: before.tipo_movimento,
    };
    const result = await osPimEquipmentService.saveMovement(payload, req.user || {}, cardKey);
    await registrarAuditoria({
      req,
      action: 'UPDATE_OS_PIM_MOVEMENT',
      entity: 'EQUIPAMENTO_OS_PIM',
      entityId: cardKey,
      summary: `Movimentação OS/PIM atualizada para PN ${before.pn} / SN ${before.sn}.`,
      details: { before, result },
      visibility: 'PUBLIC',
    });
    return res.status(200).json({
      status: 'success',
      message: result.conflito_localizacao
        ? 'Movimentação atualizada. A nova posição gerou conflito para reconciliação.'
        : 'Movimentação OS/PIM atualizada e Livro sincronizado.',
      data: result,
    });
  } catch (error) {
    console.error('[SISHA][equipamentos][OS_PIM] atualizar:', error);
    return replyError(res, error, 'Falha ao atualizar movimentação OS/PIM.');
  }
};

exports.cancelarOsPim = async (req, res) => {
  try {
    const cardKey = decodeURIComponent(req.params.cardKey || '');
    const before = await osPimEquipmentService.getMovementCard(cardKey);
    if (!before) return res.status(404).json({ status: 'error', message: 'Movimentação OS/PIM não encontrada.' });
    const result = await osPimEquipmentService.cancelMovement(cardKey, req.body?.motivo, req.user || {});
    await registrarAuditoria({
      req,
      action: 'CANCEL_OS_PIM_MOVEMENT',
      entity: 'EQUIPAMENTO_OS_PIM',
      entityId: cardKey,
      summary: `Movimentação ${before.documento || before.os || before.pim || cardKey} cancelada sem apagar o histórico.`,
      details: { before, motivo: req.body?.motivo, result },
      visibility: 'PUBLIC',
    });
    return res.status(200).json({ status: 'success', message: 'Movimentação cancelada logicamente. O histórico permanece no Livro.', data: result });
  } catch (error) {
    console.error('[SISHA][equipamentos][OS_PIM] cancelar:', error);
    return replyError(res, error, 'Falha ao cancelar movimentação OS/PIM.');
  }
};

exports.configuracaoAeronaves = async (_req, res) => {
  try {
    const data = await osPimEquipmentService.listAircraftConfiguration();
    return res.status(200).json({ status: 'success', data, meta: { aeronaves: data.length, equipamentos: data.reduce((sum, row) => sum + Number(row.total || 0), 0) } });
  } catch (error) {
    console.error('[SISHA][equipamentos][OS_PIM] configuração aeronaves:', error);
    return replyError(res, error, 'Falha ao consultar configuração atual das aeronaves.');
  }
};

exports.listarOsPimStaging = async (req, res) => {
  try {
    const data = await osPimEquipmentService.listStaging({ q: req.query.q || '', limit: req.query.limit || 250 });
    return res.status(200).json({ status: 'success', data, meta: { total: data.length } });
  } catch (error) {
    console.error('[SISHA][equipamentos][OS_PIM] staging:', error);
    return replyError(res, error, 'Falha ao consultar staging OS/PIM do Chat Lince.');
  }
};

exports.promoverOsPimStaging = async (req, res) => {
  try {
    const result = await osPimEquipmentService.promoteStaging(req.params.stagingId, req.body || {}, req.user || {});
    await registrarAuditoria({
      req,
      action: 'PROMOTE_OS_PIM_STAGING',
      entity: 'CHAT_LINCE_OS_EVENTOS_STAGING',
      entityId: req.params.stagingId,
      summary: `Staging OS/PIM promovido para o Livro do PN ${result.pn} / SN ${result.sn}.`,
      details: result,
      visibility: 'PUBLIC',
    });
    return res.status(200).json({
      status: 'success',
      message: result.conflito_localizacao
        ? 'Evento do Chat Lince aplicado, mas a localização aguarda reconciliação.'
        : 'Evento do Chat Lince aplicado ao Livro de Equipamentos após revisão humana.',
      data: result,
    });
  } catch (error) {
    console.error('[SISHA][equipamentos][OS_PIM] promover staging:', error);
    return replyError(res, error, 'Falha ao aplicar staging OS/PIM ao Livro de Equipamentos.');
  }
};

// A2 — Instalação / Remoção PN+SN guiada. Reutiliza o Livro de Eventos e mantém
// um intervalo operacional auditável para futura apuração de utilização no A3.
exports.listarCandidatosOperacionais = async (req, res) => {
  try {
    const data = await equipmentOperationalService.listCandidates({
      pn: req.query.pn || '',
      mode: req.query.mode || 'INSTALL',
      limit: req.query.limit || 100,
    });
    return res.status(200).json({ status: 'success', data, meta: { total: data.length } });
  } catch (error) {
    console.error('[SISHA][equipamentos][A2] candidatos:', error);
    return replyError(res, error, 'Falha ao consultar candidatos PN+SN do A2.');
  }
};

exports.listarInstalacoesOperacionais = async (req, res) => {
  try {
    const data = await equipmentOperationalService.listOpenInstallations({
      pn: req.query.pn || '',
      aircraft: req.query.aircraft || '',
      limit: req.query.limit || 250,
    });
    return res.status(200).json({ status: 'success', data, meta: { total: data.length } });
  } catch (error) {
    console.error('[SISHA][equipamentos][A2] instalações:', error);
    return replyError(res, error, 'Falha ao consultar instalações operacionais.');
  }
};

exports.listarTestesPendentesA2 = async (req, res) => {
  try {
    const data = await equipmentOperationalService.listPendingTests(req.query.limit || 250);
    return res.status(200).json({ status: 'success', data, meta: { total: data.length } });
  } catch (error) {
    console.error('[SISHA][equipamentos][A2] testes pendentes:', error);
    return replyError(res, error, 'Falha ao consultar testes pendentes.');
  }
};

exports.instalarEquipamentoA2 = async (req, res) => {
  try {
    const result = await equipmentOperationalService.installEquipment(req.body || {}, req.user || {});
    const interval = result.interval || {};
    await registrarAuditoria({
      req,
      action: 'A2_INSTALL_EQUIPMENT',
      entity: 'EQUIPMENT_OPERATIONAL_INTERVAL',
      entityId: interval.id || null,
      summary: `A2: PN ${interval.pn || ''} / SN ${interval.sn || ''} instalado na aeronave ${interval.aircraft_code || ''} posição ${interval.position_code || ''}.`,
      details: { operation_id: result.operation_id, interval },
      visibility: 'PUBLIC',
    });
    return res.status(result.idempotent ? 200 : 201).json({
      status: 'success',
      message: result.idempotent ? 'Instalação já registrada anteriormente; nenhuma duplicidade criada.' : 'Instalação PN+SN registrada e intervalo operacional aberto.',
      data: result,
    });
  } catch (error) {
    console.error('[SISHA][equipamentos][A2] instalar:', error);
    return replyError(res, error, 'Falha ao registrar instalação PN+SN.');
  }
};

exports.removerEquipamentoA2 = async (req, res) => {
  try {
    const result = await equipmentOperationalService.removeEquipment(req.body || {}, req.user || {});
    const interval = result.interval || {};
    await registrarAuditoria({
      req,
      action: 'A2_REMOVE_EQUIPMENT',
      entity: 'EQUIPMENT_OPERATIONAL_INTERVAL',
      entityId: interval.id || null,
      summary: `A2: PN ${interval.pn || ''} / SN ${interval.sn || ''} removido por ${interval.removal_reason || ''}.`,
      details: { operation_id: result.operation_id, interval },
      visibility: 'PUBLIC',
    });
    return res.status(200).json({
      status: 'success',
      message: result.idempotent
        ? 'Remoção já registrada anteriormente; nenhuma duplicidade criada.'
        : interval.removal_reason === 'TESTE'
          ? 'Remoção registrada. O teste permanece pendente e ainda não conta como falha.'
          : interval.removal_reason === 'PANE'
            ? 'Remoção por PANE registrada como falha confirmada e fluxo de reparo pendente de destino.'
            : 'Remoção PRONTO USO registrada sem caracterizar falha.',
      data: result,
    });
  } catch (error) {
    console.error('[SISHA][equipamentos][A2] remover:', error);
    return replyError(res, error, 'Falha ao registrar remoção PN+SN.');
  }
};

exports.concluirTesteA2 = async (req, res) => {
  try {
    const result = await equipmentOperationalService.resolveTestResult(req.body || {}, req.user || {});
    const interval = result.interval || {};
    await registrarAuditoria({
      req,
      action: 'A2_TEST_RESULT',
      entity: 'EQUIPMENT_OPERATIONAL_INTERVAL',
      entityId: interval.id || null,
      summary: `A2: teste ${interval.test_result || ''} para PN ${interval.pn || ''} / SN ${interval.sn || ''}.`,
      details: { operation_id: result.operation_id, interval },
      visibility: 'PUBLIC',
    });
    return res.status(200).json({
      status: 'success',
      message: result.idempotent
        ? 'Resultado já registrado anteriormente; nenhuma duplicidade criada.'
        : interval.test_result === 'REPROVADO'
          ? 'Teste reprovado. A falha foi confirmada para o futuro cálculo de confiabilidade.'
          : 'Teste aprovado. A remoção não foi classificada como falha.',
      data: result,
    });
  } catch (error) {
    console.error('[SISHA][equipamentos][A2] resultado teste:', error);
    return replyError(res, error, 'Falha ao concluir teste do equipamento.');
  }
};


// A3 — Motor de Confiabilidade. Leitura é read-only para usuários autenticados;
// confirmação de evidência permanece Admin/Dono e append-only.
exports.painelConfiabilidadeA3 = async (req, res) => {
  try {
    const data = await equipmentReliabilityService.getReliabilityDashboard({
      pn: req.query.pn || '',
      sn: req.query.sn || '',
      aircraft: req.query.aircraft || '',
      from: req.query.from || '',
      to: req.query.to || '',
    });
    return res.status(200).json({ status: 'success', data });
  } catch (error) {
    console.error('[SISHA][equipamentos][A3] painel:', error);
    return replyError(res, error, 'Falha ao calcular indicadores de confiabilidade.');
  }
};

exports.confirmarCicloConfiabilidadeA3 = async (req, res) => {
  try {
    const requestId = req.auditContext?.requestId || req.requestId || req.id || null;
    const result = await equipmentReliabilityService.confirmReliabilityCycle(req.body || {}, req.user || {}, requestId);
    const confirmation = result.confirmation || {};
    await registrarAuditoria({
      req,
      action: 'A3_CONFIRM_RELIABILITY_CYCLE',
      entity: 'EQUIPMENT_RELIABILITY_CYCLE',
      entityId: confirmation.id || null,
      summary: `A3: evidência de confiabilidade confirmada para PN ${confirmation.pn || ''} / SN ${confirmation.sn || ''}.`,
      details: { operation_id: result.operation_id, confirmation },
      visibility: 'PUBLIC',
    });
    return res.status(result.idempotent ? 200 : 201).json({
      status: 'success',
      message: result.idempotent
        ? 'Confirmação já registrada anteriormente; nenhuma duplicidade criada.'
        : 'Ciclo de confiabilidade confirmado. Os indicadores foram recalculados sem alterar o histórico A2.',
      data: result,
    });
  } catch (error) {
    console.error('[SISHA][equipamentos][A3] confirmar ciclo:', error);
    return replyError(res, error, 'Falha ao confirmar evidência do ciclo de confiabilidade.');
  }
};
