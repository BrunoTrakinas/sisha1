const SOURCE_CLASSES = Object.freeze({
  LIVE_OPERATIONAL: 'LIVE_OPERATIONAL',
  EXTERNAL_OPERATIONAL_REFERENCE: 'EXTERNAL_OPERATIONAL_REFERENCE',
  TECHNICAL_PRIMARY: 'TECHNICAL_PRIMARY',
  PLANNING_ANALYTICAL: 'PLANNING_ANALYTICAL',
  DOCUMENTARY_ANALYSIS: 'DOCUMENTARY_ANALYSIS',
  RAG_DERIVED: 'RAG_DERIVED',
  UNKNOWN: 'UNKNOWN',
});

const CURRENT_STATE_TABLES = new Set([
  'v_sisha_ppu_disponibilidade',
  'estoque_ppu',
  'compras_pds',
  'compras_ordens',
  'work_orders',
  'recebimentos',
  'recebimento_itens',
  'equipamentos_serializados',
  'equipamento_eventos',
  'pim_demandas',
]);

const EXTERNAL_REFERENCE_TABLES = new Set([
  'v_sisha_ceimspa_disponibilidade',
  'estoque_ceimspa',
  'leonardo_spares',
  'leonardo_foc_spares',
  'leonardo_repairs',
  'leonardo_admin_docs',
  'rfq_cotacoes',
  'price_list',
]);

const TECHNICAL_PRIMARY_TABLES = new Set([
  'dicionario_mestre',
  'dicionario_manual',
  'v_sisha_manual_pn_aplicacao',
  'v_sisha_manual_falhas',
  'v_sisha_manual_recursos',
  'v_sisha_manual_trechos',
  'manuais_tecnicos',
  'manual_tecnico_pns',
  'manual_tecnico_falhas',
  'manual_tecnico_recursos',
  'manual_tecnico_trechos',
  'service_bulletins',
  'service_bulletin_items',
]);

const PLANNING_TABLES = new Set([
  'receita_itens',
  'politica_estoque_tarefas',
  'historico_movimentacao',
  'v_sisha_preco_referencia',
]);

const PUBLIC_LABELS = Object.freeze({
  v_sisha_ppu_disponibilidade: 'Estoque consolidado do PPU',
  estoque_ppu: 'Estoque do PPU',
  v_sisha_ceimspa_disponibilidade: 'Referência de disponibilidade do CeIMSPA',
  estoque_ceimspa: 'Referência de estoque do CeIMSPA',
  compras_pds: 'Pedidos ao Depósito (PD)',
  compras_ordens: 'Ordens de Compra (OC)',
  work_orders: 'Work Orders (WO)',
  recebimentos: 'Recebimentos SISHA',
  recebimento_itens: 'Itens de recebimento SISHA',
  equipamentos_serializados: 'Livro de Equipamentos PN+SN',
  equipamento_eventos: 'Histórico de eventos PN+SN',
  pim_demandas: 'PIM/OS/Demandas',
  leonardo_spares: 'Order Book Leonardo — Spares',
  leonardo_foc_spares: 'Order Book Leonardo — FOC',
  leonardo_repairs: 'Order Book Leonardo — Repairs/Warranty',
  leonardo_admin_docs: 'Documentos administrativos Leonardo',
  rfq_cotacoes: 'RFQ/Cotações',
  price_list: 'Price List',
  dicionario_mestre: 'Dicionário Mestre',
  dicionario_manual: 'Dicionário do Manual',
  v_sisha_manual_pn_aplicacao: 'Manual técnico — aplicação de PN',
  v_sisha_manual_falhas: 'Manual técnico — fault isolation',
  v_sisha_manual_recursos: 'Manual técnico — recursos',
  v_sisha_manual_trechos: 'Manual técnico — trechos',
  service_bulletins: 'Service Bulletin',
  service_bulletin_items: 'Itens de Service Bulletin',
  receita_itens: 'Receitas/Inspeções',
  politica_estoque_tarefas: 'Política de Estoque',
  historico_movimentacao: 'Histórico de movimentação',
  os_master_evidencias: 'Master OS — Divisão de Planejamento',
  v_sisha_os_historico_atual: 'Histórico consolidado do Master OS',
  chat_lince_documentos: 'Documento analisado pelo Chat Lince',
  chat_lince_rag_chunks: 'Trecho indexado no RAG documental',
});

function normalizeTable(value = '') {
  return String(value || '').trim().toLowerCase();
}

function sourcePublicLabel(table = '') {
  const key = normalizeTable(table);
  return PUBLIC_LABELS[key] || (key ? `Fonte SISHA: ${key}` : 'Fonte não identificada');
}

function baseDescriptor(table = '') {
  const key = normalizeTable(table);

  if (CURRENT_STATE_TABLES.has(key)) {
    return {
      source_class: SOURCE_CLASSES.LIVE_OPERATIONAL,
      trust_score: 100,
      public_label: sourcePublicLabel(key),
      scope: 'Estado operacional registrado no SISHA.',
      can_confirm_current_state: true,
      requires_primary_validation: false,
    };
  }

  if (EXTERNAL_REFERENCE_TABLES.has(key)) {
    const ceimspa = key.includes('ceimspa');
    return {
      source_class: SOURCE_CLASSES.EXTERNAL_OPERATIONAL_REFERENCE,
      trust_score: ceimspa ? 78 : 88,
      public_label: sourcePublicLabel(key),
      scope: ceimspa
        ? 'Referência externa de disponibilidade; exige confirmação com o CeIMSPA.'
        : 'Fonte externa/oficial para compra, cotação, fornecimento ou reparo dentro de seu escopo.',
      can_confirm_current_state: !ceimspa,
      requires_primary_validation: ceimspa,
    };
  }

  if (TECHNICAL_PRIMARY_TABLES.has(key)) {
    return {
      source_class: SOURCE_CLASSES.TECHNICAL_PRIMARY,
      trust_score: 92,
      public_label: sourcePublicLabel(key),
      scope: 'Fonte técnica para aplicação, identificação, procedimento ou configuração; não comprova estoque atual.',
      can_confirm_current_state: false,
      requires_primary_validation: false,
    };
  }

  if (key === 'os_master_evidencias' || key === 'v_sisha_os_historico_atual') {
    return {
      source_class: SOURCE_CLASSES.PLANNING_ANALYTICAL,
      trust_score: 94,
      public_label: sourcePublicLabel(key),
      scope: 'Fonte oficial da Divisão de Planejamento para abertura, acompanhamento, fechamento e cancelamento de OS. OS fechada pode confirmar movimento quando a orquestração PN+SN/destino foi inequívoca; a localização física atual deve ser lida no Livro de Equipamentos/Eventos.',
      can_confirm_current_state: false,
      requires_primary_validation: false,
    };
  }

  if (PLANNING_TABLES.has(key)) {
    return {
      source_class: SOURCE_CLASSES.PLANNING_ANALYTICAL,
      trust_score: 72,
      public_label: sourcePublicLabel(key),
      scope: 'Fonte analítica/histórica para apoio à decisão; não deve substituir o estado operacional atual.',
      can_confirm_current_state: false,
      requires_primary_validation: true,
    };
  }

  if (key === 'chat_lince_documentos') {
    return {
      source_class: SOURCE_CLASSES.DOCUMENTARY_ANALYSIS,
      trust_score: 35,
      public_label: sourcePublicLabel(key),
      scope: 'Documento analisado/extraído. É evidência documental e não confirmação operacional automática.',
      can_confirm_current_state: false,
      requires_primary_validation: true,
    };
  }

  if (key === 'chat_lince_rag_chunks') {
    return {
      source_class: SOURCE_CLASSES.RAG_DERIVED,
      trust_score: 30,
      public_label: sourcePublicLabel(key),
      scope: 'Trecho recuperado por busca documental. Não confirma sozinho estoque, status, localização ou decisão operacional.',
      can_confirm_current_state: false,
      requires_primary_validation: true,
    };
  }

  return {
    source_class: SOURCE_CLASSES.UNKNOWN,
    trust_score: 50,
    public_label: sourcePublicLabel(key),
    scope: 'Fonte sem classificação explícita; usar com ressalva e validar a origem primária.',
    can_confirm_current_state: false,
    requires_primary_validation: true,
  };
}

function ragOriginTable(row = {}) {
  return normalizeTable(
    row?.documento?.origem_tabela
    || row?.chat_lince_rag_documents?.origem_tabela
    || row?.metadata?.origem_tabela
    || row?.metadata?.source_table
    || ''
  );
}

function describeRagRowProvenance(row = {}) {
  const originTable = ragOriginTable(row);
  const structured = Boolean(
    row?.metadata?.fonte_logistica_estruturada
    || (originTable && originTable !== 'chat_lince_documentos')
  );
  const origin = originTable ? baseDescriptor(originTable) : baseDescriptor('chat_lince_documentos');
  const document = row?.documento || row?.chat_lince_rag_documents || {};

  return {
    source_class: SOURCE_CLASSES.RAG_DERIVED,
    trust_score: structured ? Math.max(45, origin.trust_score - 15) : 30,
    public_label: document.nome_arquivo
      ? `RAG documental — ${String(document.nome_arquivo).slice(0, 180)}`
      : structured
        ? `RAG derivado de ${origin.public_label}`
        : 'RAG documental',
    origin_table: originTable || null,
    origin_label: origin.public_label,
    document_key: row.document_key || document.document_key || null,
    document_status: document.status || null,
    structured_source_snapshot: structured,
    can_confirm_current_state: false,
    requires_primary_validation: true,
    scope: structured
      ? 'Snapshot indexado de uma fonte estruturada. Para estado atual, consultar novamente a fonte primária.'
      : 'Trecho de documento analisado. Serve como indício/evidência documental, não como confirmação operacional.',
  };
}

function describeEvidenceSource(source = {}) {
  const table = normalizeTable(source.tabela || source.table);
  if (table === 'chat_lince_rag_chunks') {
    const rows = Array.isArray(source.linhas) ? source.linhas : (Array.isArray(source.data) ? source.data : []);
    const rowDescriptors = rows.slice(0, 10).map(describeRagRowProvenance);
    const strongest = rowDescriptors.sort((a, b) => b.trust_score - a.trust_score)[0];
    return strongest || baseDescriptor(table);
  }
  return baseDescriptor(table);
}

function buildEvidenceProfile(sources = []) {
  const descriptors = (sources || []).map((source) => ({
    ...describeEvidenceSource(source),
    table: normalizeTable(source.tabela || source.table),
  }));

  const byClass = {};
  for (const descriptor of descriptors) {
    byClass[descriptor.source_class] = (byClass[descriptor.source_class] || 0) + 1;
  }

  const currentConfirmers = descriptors.filter((item) => item.can_confirm_current_state);
  const hasRag = descriptors.some((item) => item.source_class === SOURCE_CLASSES.RAG_DERIVED);
  const hasDocumentary = descriptors.some((item) => item.source_class === SOURCE_CLASSES.DOCUMENTARY_ANALYSIS || item.source_class === SOURCE_CLASSES.RAG_DERIVED);
  const nonDocumentary = descriptors.filter((item) => ![
    SOURCE_CLASSES.DOCUMENTARY_ANALYSIS,
    SOURCE_CLASSES.RAG_DERIVED,
  ].includes(item.source_class));

  return {
    sources_total: descriptors.length,
    by_class: byClass,
    highest_trust_score: descriptors.length ? Math.max(...descriptors.map((item) => item.trust_score)) : 0,
    current_state_confirmers: currentConfirmers.length,
    has_live_operational: descriptors.some((item) => item.source_class === SOURCE_CLASSES.LIVE_OPERATIONAL),
    has_external_reference: descriptors.some((item) => item.source_class === SOURCE_CLASSES.EXTERNAL_OPERATIONAL_REFERENCE),
    has_technical_primary: descriptors.some((item) => item.source_class === SOURCE_CLASSES.TECHNICAL_PRIMARY),
    has_rag: hasRag,
    has_documentary: hasDocumentary,
    documentary_only: descriptors.length > 0 && nonDocumentary.length === 0,
    requires_primary_validation: descriptors.some((item) => item.requires_primary_validation),
  };
}

function evaluateClaimReadiness(sources = [], claimType = 'CURRENT_OPERATIONAL_STATE') {
  const profile = buildEvidenceProfile(sources);
  const type = String(claimType || '').trim().toUpperCase();

  if (type === 'CURRENT_OPERATIONAL_STATE') {
    return profile.current_state_confirmers > 0
      ? { ready: true, blocker: null, profile }
      : { ready: false, blocker: 'LIVE_OPERATIONAL_SOURCE_REQUIRED', profile };
  }

  if (type === 'TECHNICAL_APPLICABILITY') {
    return profile.has_technical_primary
      ? { ready: true, blocker: null, profile }
      : { ready: false, blocker: 'TECHNICAL_PRIMARY_SOURCE_REQUIRED', profile };
  }

  return {
    ready: profile.sources_total > 0,
    blocker: profile.sources_total > 0 ? null : 'EVIDENCE_REQUIRED',
    profile,
  };
}

function evidenceRulesForPrompt(profile = {}) {
  return [
    'HIERARQUIA DE EVIDÊNCIAS:',
    '- Estado operacional atual (estoque, posição, status interno) só pode ser confirmado por fonte operacional atual dentro do seu escopo.',
    '- CeIMSPA é referência externa e continua exigindo confirmação com o CeIMSPA.',
    '- Manual/WTP/CMM/SB pode confirmar aplicação ou referência técnica, mas nunca prova estoque atual.',
    '- Order Book/RFQ/Price List comprovam somente o que consta na respectiva fonte externa/comercial; não transformam isso em estoque do PPU.',
    '- Documento analisado e RAG são evidência documental. Use expressões como "o documento indica" ou "o trecho menciona" quando não houver confirmação operacional.',
    '- RAG derivado de tabela estruturada é snapshot indexado: para estado atual, prefira a consulta viva à fonte primária.',
    '- Se fontes de escopos equivalentes conflitarem, declare o conflito; não escolha silenciosamente a evidência mais conveniente.',
    `- Perfil desta consulta: ${JSON.stringify(profile || {})}`,
  ].join('\n');
}

module.exports = {
  SOURCE_CLASSES,
  sourcePublicLabel,
  describeEvidenceSource,
  describeRagRowProvenance,
  buildEvidenceProfile,
  evaluateClaimReadiness,
  evidenceRulesForPrompt,
};
