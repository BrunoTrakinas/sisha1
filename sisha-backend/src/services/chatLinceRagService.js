const supabase = require('../config/supabaseClient');
const { describeRagRowProvenance } = require('./chatLinceEvidenceTrustService');

const DEFAULT_CHUNK_SIZE = 1800;
const DEFAULT_CHUNK_OVERLAP = 220;
const SENSITIVE_TERMS = [
  'authorized_users', 'senha', 'password', 'token', 'jwt', 'perfil', 'login',
  'system_user_presence', 'system_audit_logs', 'service_role', 'anon_key', 'api_key',
];

function stripAccents(value = '') {
  return String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

function normalizeText(value = '') {
  return stripAccents(value).toUpperCase();
}

function compactText(value = '', max = 50000) {
  return String(value || '')
    .replace(/\r/g, '')
    .replace(/[\t ]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, max);
}

function sanitizeForRag(text = '') {
  const clean = compactText(text, 120000);
  if (!clean) return '';
  const lines = clean.split('\n');
  return lines
    .filter((line) => {
      const n = normalizeText(line);
      return !SENSITIVE_TERMS.some((term) => n.includes(normalizeText(term)));
    })
    .join('\n')
    .trim();
}

function tokenize(text = '') {
  const normalized = normalizeText(text);
  const tokens = normalized.match(/\b[A-Z0-9][A-Z0-9\-\/]{2,}\b/g) || [];
  const stop = new Set([
    'COM', 'PARA', 'POR', 'QUE', 'QUAL', 'QUAIS', 'ITEM', 'ITENS', 'TEMOS', 'EXISTE',
    'ONDE', 'SISHA', 'CHAT', 'LINCE', 'DADOS', 'REGISTRO', 'REGISTROS', 'TABELA',
  ]);
  return Array.from(new Set(tokens
    .map((token) => token.replace(/[.,;:]+$/g, ''))
    .filter((token) => token.length >= 3 && token.length <= 48 && !stop.has(token))))
    .slice(0, 24);
}

function buildChunks(text = '', { chunkSize = DEFAULT_CHUNK_SIZE, overlap = DEFAULT_CHUNK_OVERLAP } = {}) {
  const clean = sanitizeForRag(text);
  if (!clean) return [];

  const paragraphs = clean.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
  const chunks = [];
  let current = '';

  paragraphs.forEach((paragraph) => {
    if ((current + '\n\n' + paragraph).trim().length <= chunkSize) {
      current = (current ? `${current}\n\n${paragraph}` : paragraph).trim();
      return;
    }
    if (current) chunks.push(current);

    if (paragraph.length <= chunkSize) {
      current = paragraph;
      return;
    }

    for (let i = 0; i < paragraph.length; i += (chunkSize - overlap)) {
      chunks.push(paragraph.slice(i, i + chunkSize).trim());
    }
    current = '';
  });

  if (current) chunks.push(current);
  return chunks.filter(Boolean).slice(0, 250);
}

function documentKeyFrom(row = {}) {
  return String(row.id || row.documento_id || row.nome_arquivo || '').trim();
}

function safe(value, fallback = '') {
  if (value === undefined || value === null) return fallback;
  const text = String(value).trim();
  return text || fallback;
}

function rowText(title, fields = []) {
  const lines = [];
  if (title) lines.push(title);
  fields.forEach(([label, value]) => {
    const text = safe(value);
    if (text) lines.push(`${label}: ${text}`);
  });
  return lines.join('\n');
}

async function upsertRagDocument({ documentKey, origemTabela, origemId, tipoDocumento, nomeArquivo, titulo, resumo, status, metadata, text, createdByEmail, db = supabase }) {
  const cleanText = sanitizeForRag(text || resumo || '');
  if (!documentKey || !cleanText) return { ok: false, reason: 'Documento sem chave ou texto útil para RAG.' };

  // Compatibilidade de schema RAG:
  // O banco legado do SISHA mantém source_table/source_id como contrato obrigatório,
  // enquanto a camada nova usa document_key/origem_tabela/origem_id.
  // Gravamos ambos apontando para a mesma origem para preservar a rastreabilidade
  // sem migration destrutiva e sem duplicar documentos.
  const resolvedSourceTable = origemTabela || 'chat_lince_documentos';
  const resolvedSourceId = String(origemId || documentKey);
  const resolvedSourceType = tipoDocumento || 'SISHA_RAG_DOCUMENT';

  const docPayload = {
    // Contrato legado ainda obrigatório no banco atual.
    source_type: resolvedSourceType,
    source_table: resolvedSourceTable,
    source_id: resolvedSourceId,

    // Contrato atual do Chat Lince/RAG.
    document_key: String(documentKey),
    origem_tabela: resolvedSourceTable,
    origem_id: resolvedSourceId,
    tipo_documento: tipoDocumento || null,
    nome_arquivo: nomeArquivo || null,
    titulo: titulo || nomeArquivo || String(documentKey),
    resumo: resumo || compactText(cleanText, 900),
    status: status || 'ATIVO',
    created_by_email: createdByEmail || null,
    metadata: metadata || {},
    updated_at: new Date().toISOString(),
  };

  const { data: doc, error: docError } = await db
    .from('chat_lince_rag_documents')
    .upsert(docPayload, { onConflict: 'document_key' })
    .select('*')
    .single();

  if (docError) return { ok: false, reason: docError.message, documentKey };

  await db.from('chat_lince_rag_chunks').delete().eq('document_key', String(documentKey));

  const chunks = buildChunks(cleanText).map((chunkText, index) => ({
    // Contrato legado ainda presente em chat_lince_rag_chunks.
    document_id: doc.id,
    source_table: resolvedSourceTable,
    source_id: resolvedSourceId,
    content: chunkText,
    pn_candidates: [],
    sn_candidates: [],
    doc_candidates: [],

    // Contrato atual do Chat Lince/RAG.
    rag_document_id: doc.id,
    document_key: String(documentKey),
    chunk_index: index,
    chunk_text: chunkText,
    tokens: tokenize(`${titulo || ''} ${tipoDocumento || ''} ${resolvedSourceTable} ${chunkText}`),
    metadata: {
      ...(metadata || {}),
      nome_arquivo: nomeArquivo || null,
      tipo_documento: tipoDocumento || null,
      origem_tabela: resolvedSourceTable,
      source_table: resolvedSourceTable,
      source_id: resolvedSourceId,
    },
  }));

  if (!chunks.length) return { ok: true, document: doc, chunks: 0 };

  const { error: chunkError } = await db.from('chat_lince_rag_chunks').insert(chunks);
  if (chunkError) return { ok: false, reason: chunkError.message, document: doc, documentKey };

  return { ok: true, document: doc, chunks: chunks.length };
}

async function indexChatLinceDocument(documento = {}) {
  const documentKey = documentKeyFrom(documento);
  const text = documento.texto_extraido || documento.resumo || '';
  return upsertRagDocument({
    documentKey,
    origemTabela: 'chat_lince_documentos',
    origemId: documentKey,
    tipoDocumento: documento.tipo_documento || documento.classificacao || null,
    nomeArquivo: documento.nome_arquivo || null,
    titulo: documento.nome_arquivo || documento.resumo || documentKey,
    resumo: documento.resumo || null,
    status: documento.status || null,
    createdByEmail: documento.created_by_email || null,
    metadata: {
      classificacao: documento.classificacao || null,
      destino_sugerido: documento.destino_sugerido || null,
      entidades: documento.entidades || {},
    },
    text,
  });
}

async function reindexChatLinceDocuments({ limit = 250 } = {}) {
  const { data, error } = await supabase
    .from('chat_lince_documentos')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(Math.min(Math.max(Number(limit) || 250, 1), 1000));

  if (error) return { ok: false, reason: error.message, processed: 0, indexed: 0, chunks: 0 };

  let indexed = 0;
  let chunks = 0;
  const failures = [];
  for (const documento of data || []) {
    const result = await indexChatLinceDocument(documento);
    if (result.ok) {
      indexed += 1;
      chunks += Number(result.chunks || 0);
    } else {
      failures.push({ id: documento.id, nome_arquivo: documento.nome_arquivo, reason: result.reason });
    }
  }

  return { ok: true, processed: (data || []).length, indexed, chunks, failures };
}

const LOGISTIC_SOURCE_SPECS = [
  {
    table: 'dicionario_mestre', type: 'MANUAL_DICIONARIO', limit: 2500,
    columns: 'id,pn,dmc,item_num,sub_item,nsn,pi,nomenclatura,techname,created_at',
    title: (r) => `Manual/Dicionário — PN ${safe(r.pn, 'não informado')}`,
    text: (r) => rowText(`Fonte logística: Manual/Dicionário Mestre`, [
      ['PN', r.pn], ['PI', r.pi], ['NSN', r.nsn], ['DMC', r.dmc], ['Item', r.item_num], ['Subitem', r.sub_item],
      ['Nomenclatura', r.nomenclatura], ['Aplicação técnica/Techname', r.techname],
    ]),
  },
  {
    table: 'v_sisha_manual_pn_aplicacao', type: 'MANUAL_TECNICO_WTP', limit: 5000,
    columns: '*',
    title: (r) => `${safe(r.tipo_manual, 'Manual')} ${safe(r.manual_codigo, '')} — PN ${safe(r.pn, 'não informado')}`,
    text: (r) => rowText(`Fonte técnica: WTP/CMM/Manual indexado`, [
      ['Manual', r.manual_codigo], ['Tipo', r.tipo_manual], ['Fabricante', r.fabricante], ['ATA/DMC', r.ata_dmc], ['Revisão', r.revisao],
      ['PN', r.pn], ['Figura', r.fig], ['Item', r.item], ['Nomenclatura/Description', r.nomenclatura], ['Usage code', r.usage_code],
      ['Units per assy', r.units_per_assy], ['Página/referência', r.page_ref],
    ]),
  },
  {
    table: 'v_sisha_manual_falhas', type: 'MANUAL_FAULT_ISOLATION', limit: 2500,
    columns: '*',
    title: (r) => `${safe(r.manual_codigo, 'Manual')} — Fault isolation — ${safe(r.fault, 'falha')}`,
    text: (r) => rowText(`Fonte técnica: Fault Isolation`, [
      ['Manual', r.manual_codigo], ['Revisão', r.revisao], ['ATA/DMC', r.ata_dmc],
      ['Falha', r.fault], ['Causa provável', r.probable_cause], ['Correção', r.correction], ['Task', r.task_ref], ['Página', r.page_ref],
    ]),
  },
  {
    table: 'v_sisha_manual_recursos', type: 'MANUAL_RECURSOS', limit: 3000,
    columns: '*',
    title: (r) => `${safe(r.manual_codigo, 'Manual')} — ${safe(r.categoria, 'Recurso')} — ${safe(r.pn || r.designacao, 'item')}`,
    text: (r) => rowText(`Fonte técnica: Ferramentas/consumíveis/equipamentos`, [
      ['Manual', r.manual_codigo], ['Revisão', r.revisao], ['ATA/DMC', r.ata_dmc], ['Categoria', r.categoria],
      ['PN', r.pn], ['Designação', r.designacao], ['Fornecedor', r.fornecedor], ['Página', r.page_ref],
    ]),
  },
  {
    table: 'v_sisha_manual_trechos', type: 'MANUAL_TRECHO_TECNICO', limit: 5000,
    columns: '*',
    title: (r) => `${safe(r.manual_codigo, 'Manual')} — ${safe(r.secao, 'Trecho técnico')}`,
    text: (r) => rowText(`Fonte técnica: trecho de WTP/CMM/manual`, [
      ['Manual', r.manual_codigo], ['Tipo', r.tipo_manual], ['Revisão', r.revisao], ['ATA/DMC', r.ata_dmc],
      ['Seção', r.secao], ['Página', r.page_ref], ['Trecho', r.trecho],
    ]),
  },
  {
    table: 'dicionario_manual', type: 'MANUAL_DICIONARIO', limit: 2500,
    columns: '*',
    title: (r) => `Manual/Dicionário — PN ${safe(r.pn || r.part_number, 'não informado')}`,
    text: (r) => rowText(`Fonte logística: Manual/Dicionário`, [
      ['PN', r.pn || r.part_number], ['PI', r.pi || r.nsn_pi], ['NSN', r.nsn], ['DMC', r.dmc], ['Item', r.item_num || r.item], ['Subitem', r.sub_item || r.subitem],
      ['Nomenclatura', r.nomenclatura || r.descricao], ['Aplicação técnica', r.techname || r.aplicacao || r.application],
    ]),
  },
  {
    table: 'receita_itens', type: 'RECEITAS_INSPECAO', limit: 5000,
    columns: '*',
    title: (r) => `Receita/Inspeção — PN ${safe(r.pn || r.pn_alt, 'não informado')}`,
    text: (r) => rowText(`Fonte logística: Receitas e inspeções`, [
      ['Inspeção/Receita', r.inspecao || r.receita || r.tarefa], ['PN', r.pn], ['PN alternativo', r.pn_alt],
      ['Nomenclatura', r.nomenclatura || r.descricao], ['Qtd por ciclo', r.qtd_por_ciclo || r.quantidade || r.qtd], ['Observação', r.observacao],
    ]),
  },
  {
    table: 'politica_estoque_tarefas', type: 'POLITICA_ESTOQUE', limit: 3000,
    columns: '*',
    title: (r) => `Política de Estoque — ${safe(r.tarefas || r.tarefa || r.tipo, r.id)}`,
    text: (r) => rowText(`Fonte logística: Política de Estoque`, [
      ['Tarefa', r.tarefas || r.tarefa], ['Tipo', r.tipo], ['Prioridade', r.prioridade], ['Quantidade planejada', r.quantidade || r.qtd], ['Observação', r.observacao],
    ]),
  },
  {
    table: 'rfq_cotacoes', type: 'RFQ_COTACOES', limit: 3000,
    columns: '*',
    title: (r) => `RFQ/Cotação — PN ${safe(r.pn, 'não informado')}`,
    text: (r) => rowText(`Fonte logística: RFQ/Cotação`, [
      ['Cotação', r.cotacao_numero], ['PN', r.pn], ['NSN', r.nsn], ['Nomenclatura', r.nomenclatura], ['Validade', r.validade],
      ['Data cotação', r.data_cotacao], ['Condição', r.condicao], ['Qtd solicitada', r.qtd_solicitada], ['Lead time dias', r.lead_time_dias],
      ['Estoque pronto fornecedor', r.estoque_pronto], ['Valor unitário GBP', r.valor_unitario], ['Moeda', r.moeda || 'GBP'], ['Referência pedido', r.referencia_pedido],
      ['Fornecedor', r.fornecedor], ['Tipo cotação', r.tipo_cotacao], ['WO', r.wo_referencia], ['SN', r.sn], ['Observações', r.observacoes],
      ['PN relacionado', r.pn_relacionado], ['Tipo relação PN', r.tipo_relacao_pn], ['Evidência relação PN', r.relacao_pn_texto],
    ]),
  },
  {
    table: 'leonardo_spares', type: 'ORDER_BOOK_SPARES', limit: 5000,
    columns: '*',
    title: (r) => `Order Book Spares — PN ${safe(r.pn, 'não informado')}`,
    text: (r) => rowText(`Fonte logística: Order Book / Spares`, [
      ['PN', r.pn], ['Descrição', r.descricao], ['PD/documento', r.documento_referencia], ['OC', r.oc_referencia],
      ['Qtd pendente', r.qtd_pendente], ['Qtd em rota', r.qtd_em_rota], ['Qtd aguardando coleta', r.qtd_aguardando_coleta], ['Qtd entregue', r.qtd_entregue],
      ['Status categoria', r.status_categoria], ['Previsão LH', r.data_previsao_lh], ['Valor unitário', r.valor_unitario], ['Valor total', r.valor_total],
    ]),
  },
  {
    table: 'leonardo_foc_spares', type: 'ORDER_BOOK_FOC', limit: 5000,
    columns: '*',
    title: (r) => `FOC Spares — PN ${safe(r.pn, 'não informado')}`,
    text: (r) => rowText(`Fonte logística: Order Book / FOC Spares`, [
      ['PN', r.pn], ['Descrição', r.descricao], ['Documento referência', r.documento_referencia], ['Qtd pendente', r.qtd_pendente], ['Previsão LH', r.data_previsao_lh],
    ]),
  },
  {
    table: 'leonardo_repairs', type: 'ORDER_BOOK_REPAIR_WARRANTY', limit: 5000,
    columns: '*',
    title: (r) => `Repair/Warranty — PN ${safe(r.pn, 'não informado')}${r.sn ? ` SN ${r.sn}` : ''}`,
    text: (r) => rowText(`Fonte logística: Order Book / Repairs / Warranty Repairs`, [
      ['PN', r.pn], ['SN', r.sn], ['Descrição', r.descricao], ['Tipo', r.tipo], ['Documento referência', r.documento_referencia],
      ['Status', r.status], ['Valor estimado', r.valor_estimado], ['Previsão', r.data_previsao], ['Aeronave', r.aeronave || r.tail_number],
      ['Notification', r.notification], ['PO', r.po], ['Delivery Number', r.delivery_number], ['LH Updates', r.lh_updates], ['BN Comments', r.bn_comments],
    ]),
  },
  {
    table: 'leonardo_admin_docs', type: 'ORDER_BOOK_DOCS_ADMIN', limit: 5000,
    columns: '*',
    title: (r) => `${safe(r.tipo_doc, 'Documento Leonardo')} ${safe(r.numero_doc, r.id)}`,
    text: (r) => rowText(`Fonte logística: Order Book / documentos administrativos Leonardo`, [
      ['Tipo', r.tipo_doc], ['Número', r.numero_doc], ['PN/Assunto', r.assunto_pn], ['Status', r.status], ['Data abertura', r.data_abertura],
    ]),
  },
  {
    table: 'historico_movimentacao', type: 'HISTORICO_MOVIMENTACAO', limit: 5000,
    columns: '*',
    title: (r) => `Histórico de Movimentação — PN ${safe(r.pn, 'não informado')}`,
    text: (r) => rowText(`Fonte logística: Histórico de movimentação`, [
      ['PN', r.pn], ['Data', r.data || r.data_movimentacao], ['Quantidade', r.qtd || r.quantidade], ['OS', r.os], ['Observação', r.observacao], ['Arquivo origem', r.arquivo_origem],
    ]),
  },
  {
    table: 'pim_demandas', type: 'PIM_OS_DEMANDAS', limit: 5000,
    columns: '*',
    title: (r) => `PIM/OS — ${safe(r.pim || r.os_vinculada || r.origem_codigo, r.id)}`,
    text: (r) => rowText(`Fonte logística: PIM/OS/Demandas`, [
      ['PIM', r.pim], ['OS vinculada', r.os_vinculada], ['PN', r.pn], ['NSN', r.nsn], ['Quantidade', r.quantidade || r.qtd],
      ['Origem tipo', r.origem_tipo], ['Origem código', r.origem_codigo], ['Origem descrição', r.origem_descricao], ['Status', r.status],
    ]),
  },
  {
    table: 'service_bulletins', type: 'SERVICE_BULLETIN', limit: 3000,
    columns: '*',
    title: (r) => `Service Bulletin — ${safe(r.sb_numero || r.numero || r.id)}`,
    text: (r) => rowText(`Fonte logística: Service Bulletin`, [
      ['SB', r.sb_numero || r.numero], ['Tipo', r.tipo], ['Título', r.titulo || r.assunto], ['Aplicabilidade', r.aplicabilidade], ['Status', r.status], ['Observação', r.observacao],
    ]),
  },
  {
    table: 'service_bulletin_items', type: 'SERVICE_BULLETIN_ITEM', limit: 5000,
    columns: '*',
    title: (r) => `Item de SB — PN ${safe(r.pn, 'não informado')}`,
    text: (r) => rowText(`Fonte logística: Item de Service Bulletin`, [
      ['SB', r.sb_numero || r.service_bulletin_id], ['PN', r.pn], ['Nomenclatura', r.nomenclatura], ['Quantidade', r.quantidade || r.qtd], ['Observação', r.observacao],
    ]),
  },
  {
    table: 'equipamentos_serializados', type: 'EQUIPAMENTO_SERIALIZADO', limit: 5000,
    columns: '*',
    title: (r) => `Equipamento serializado — PN ${safe(r.pn, 'não informado')}${r.sn ? ` SN ${r.sn}` : ''}`,
    text: (r) => rowText(`Fonte logística: Equipamento serializado`, [
      ['PN', r.pn], ['SN', r.sn], ['Nomenclatura', r.nomenclatura], ['Status', r.status], ['Localização', r.localizacao], ['Aeronave', r.aeronave || r.anv], ['Observação', r.observacao],
    ]),
  },
  {
    table: 'equipamento_eventos', type: 'EVENTO_EQUIPAMENTO', limit: 5000,
    columns: '*',
    title: (r) => `Evento de equipamento — PN ${safe(r.pn, 'não informado')}${r.sn ? ` SN ${r.sn}` : ''}`,
    text: (r) => rowText(`Fonte logística: Eventos de equipamento`, [
      ['PN', r.pn], ['SN', r.sn], ['Tipo evento', r.tipo_evento], ['Data evento', r.data_evento], ['PIM', r.pim], ['OS', r.os], ['Aeronave', r.anv || r.aeronave], ['Origem', r.local_origem], ['Destino', r.local_destino], ['Motivo', r.motivo], ['Documento', r.documento], ['Observação', r.observacao],
    ]),
  },
];

async function fetchSourceRows(spec, limitPerSource) {
  try {
    const max = Math.min(Math.max(Number(limitPerSource || spec.limit || 1000), 1), 10000);
    let query = supabase.from(spec.table).select(spec.columns || '*').limit(max);
    if (spec.orderBy) query = query.order(spec.orderBy, { ascending: false });
    const { data, error } = await query;
    if (error) return { ok: false, table: spec.table, error: error.message, rows: [] };
    return { ok: true, table: spec.table, rows: data || [] };
  } catch (error) {
    return { ok: false, table: spec.table, error: error.message, rows: [] };
  }
}

function structuredDocumentKey(spec, row, index) {
  const rawId = row.id || row.manual_pn_id || row.manual_falha_id || row.manual_recurso_id || row.manual_trecho_id || row.numero_doc || row.numero_oc || row.numero_pd || row.numero_wo || row.pn || row.sn || index;
  return `${spec.table}:${String(rawId).replace(/\s+/g, '_')}`;
}

async function indexStructuredRow(spec, row, index) {
  const documentKey = structuredDocumentKey(spec, row, index);
  const title = spec.title ? spec.title(row) : `${spec.type || spec.table} ${row.id || index}`;
  const text = spec.text ? spec.text(row) : rowText(title, Object.entries(row || {}));
  return upsertRagDocument({
    documentKey,
    origemTabela: spec.table,
    origemId: String(row.id || row.manual_pn_id || row.manual_falha_id || row.manual_recurso_id || row.manual_trecho_id || row.numero_doc || row.pn || index),
    tipoDocumento: spec.type || spec.table.toUpperCase(),
    nomeArquivo: null,
    titulo: title,
    resumo: compactText(text, 900),
    status: row.status || row.status_categoria || row.ativo || 'ATIVO',
    metadata: {
      fonte_logistica_estruturada: true,
      tabela: spec.table,
      pn: row.pn || row.pn_alt || null,
      sn: row.sn || null,
      documento: row.numero_doc || row.documento_referencia || row.numero_oc || row.numero_pd || row.numero_wo || null,
    },
    text,
  });
}

async function reindexStructuredLogisticSources({ limitPerSource = 1000 } = {}) {
  const bySource = [];
  let processed = 0;
  let indexed = 0;
  let chunks = 0;
  const failures = [];

  for (const spec of LOGISTIC_SOURCE_SPECS) {
    const fetched = await fetchSourceRows(spec, limitPerSource || spec.limit);
    if (!fetched.ok) {
      bySource.push({ table: spec.table, ok: false, processed: 0, indexed: 0, chunks: 0, error: fetched.error });
      failures.push({ table: spec.table, reason: fetched.error });
      continue;
    }

    let sourceIndexed = 0;
    let sourceChunks = 0;
    const rows = fetched.rows || [];
    for (let i = 0; i < rows.length; i += 1) {
      const result = await indexStructuredRow(spec, rows[i], i);
      processed += 1;
      if (result.ok) {
        indexed += 1;
        sourceIndexed += 1;
        chunks += Number(result.chunks || 0);
        sourceChunks += Number(result.chunks || 0);
      } else {
        failures.push({ table: spec.table, id: rows[i]?.id || null, reason: result.reason });
      }
    }
    bySource.push({ table: spec.table, ok: true, processed: rows.length, indexed: sourceIndexed, chunks: sourceChunks });
  }

  return { ok: true, processed, indexed, chunks, failures, bySource };
}

async function reindexChatLinceKnowledgeBase({ limit = 250, limitPerSource = 1000, includeChatDocuments = true, includeStructuredSources = true } = {}) {
  const docs = includeChatDocuments
    ? await reindexChatLinceDocuments({ limit })
    : { ok: true, processed: 0, indexed: 0, chunks: 0, failures: [] };

  const structured = includeStructuredSources
    ? await reindexStructuredLogisticSources({ limitPerSource })
    : { ok: true, processed: 0, indexed: 0, chunks: 0, failures: [], bySource: [] };

  const ok = Boolean(docs.ok && structured.ok);
  return {
    ok,
    processed: Number(docs.processed || 0) + Number(structured.processed || 0),
    indexed: Number(docs.indexed || 0) + Number(structured.indexed || 0),
    chunks: Number(docs.chunks || 0) + Number(structured.chunks || 0),
    documentos_chat: docs,
    fontes_logisticas: structured,
    failures: [...(docs.failures || []), ...(structured.failures || [])].slice(0, 200),
    reason: ok ? null : (docs.reason || structured.reason || 'Falha parcial na reindexação.'),
  };
}

function buildSearchClause(terms = []) {
  const cleanTerms = Array.from(new Set((terms || []).map(String).map((t) => t.trim()).filter((t) => t.length >= 3))).slice(0, 12);
  if (!cleanTerms.length) return '';
  return cleanTerms
    .map((term) => {
      const escaped = term.replace(/[%_]/g, '');
      return `chunk_text.ilike.%${escaped}%,tokens.cs.{${escaped}}`;
    })
    .join(',');
}

async function searchChatLinceRag({ question = '', terms = [], limit = 12 } = {}) {
  const searchTerms = Array.from(new Set([...tokenize(question), ...(terms || []).map(String)])).slice(0, 12);
  const clause = buildSearchClause(searchTerms);
  if (!clause) return [];

  const { data, error } = await supabase
    .from('chat_lince_rag_chunks')
    .select('id,document_key,chunk_index,chunk_text,tokens,metadata,chat_lince_rag_documents(document_key,origem_tabela,tipo_documento,nome_arquivo,titulo,resumo,status)')
    .or(clause)
    .limit(Math.min(Math.max(Number(limit) || 12, 1), 25));

  if (error) return [];

  return (data || []).map((row) => {
    const enriched = {
      ...row,
      trecho: compactText(row.chunk_text, 1800),
      documento: row.chat_lince_rag_documents || null,
    };
    return {
      ...enriched,
      proveniencia: describeRagRowProvenance(enriched),
    };
  });
}


async function removeManualTechnicalRag(manualId, { db = supabase } = {}) {
  const prefix = `manual:${String(manualId)}:%`;
  const { data: docs, error } = await db
    .from('chat_lince_rag_documents')
    .select('document_key')
    .like('document_key', prefix)
    .limit(10000);

  if (error) return { ok: false, reason: error.message, removed: 0 };
  const keys = (docs || []).map((row) => row.document_key).filter(Boolean);
  if (!keys.length) return { ok: true, removed: 0 };

  for (let i = 0; i < keys.length; i += 200) {
    const batch = keys.slice(i, i + 200);
    const { error: chunkError } = await db.from('chat_lince_rag_chunks').delete().in('document_key', batch);
    if (chunkError) return { ok: false, reason: chunkError.message, removed: 0 };
    const { error: docError } = await db.from('chat_lince_rag_documents').delete().in('document_key', batch);
    if (docError) return { ok: false, reason: docError.message, removed: 0 };
  }
  return { ok: true, removed: keys.length };
}

async function indexManualTechnicalById(manualId, { db = supabase } = {}) {
  const { data: manual, error: manualError } = await db
    .from('manuais_tecnicos')
    .select('*')
    .eq('id', manualId)
    .maybeSingle();

  if (manualError) return { ok: false, reason: manualError.message, indexed: 0, chunks: 0 };
  if (!manual) return { ok: false, reason: 'Manual técnico não encontrado para indexação RAG.', indexed: 0, chunks: 0 };

  const removal = await removeManualTechnicalRag(manualId, { db });
  if (!removal?.ok) {
    return {
      ok: false,
      reason: `Falha ao limpar o RAG anterior deste manual: ${removal?.reason || 'erro não detalhado'}.`,
      indexed: 0,
      chunks: 0,
      failures: [],
    };
  }
  if (manual.ativo === false) return { ok: true, indexed: 0, chunks: 0, skipped: 'manual_inativo' };

  const [pns, falhas, recursos, trechos] = await Promise.all([
    db.from('manual_tecnico_pns').select('*').eq('manual_id', manualId).limit(5000),
    db.from('manual_tecnico_falhas').select('*').eq('manual_id', manualId).limit(1000),
    db.from('manual_tecnico_recursos').select('*').eq('manual_id', manualId).limit(3000),
    db.from('manual_tecnico_trechos').select('*').eq('manual_id', manualId).limit(1000),
  ]);

  const queryErrors = [pns.error, falhas.error, recursos.error, trechos.error].filter(Boolean);
  if (queryErrors.length) {
    return { ok: false, reason: queryErrors.map((e) => e.message).join(' | '), indexed: 0, chunks: 0 };
  }

  const baseMeta = {
    manual_id: manual.id,
    manual_codigo: manual.codigo,
    tipo_manual: manual.tipo_manual,
    revisao: manual.revisao,
    ata_dmc: manual.ata_dmc,
    fabricante: manual.fabricante,
    fonte_logistica_estruturada: true,
  };

  const docs = [];
  docs.push({
    key: `manual:${manual.id}:metadata`,
    sourceTable: 'manuais_tecnicos',
    sourceId: manual.id,
    type: 'MANUAL_TECNICO',
    title: `${manual.tipo_manual || 'Manual'} ${manual.codigo}`,
    text: rowText('Fonte técnica: manual indexado', [
      ['Manual', manual.codigo], ['Tipo', manual.tipo_manual], ['Título', manual.titulo],
      ['Fabricante', manual.fabricante], ['ATA/DMC', manual.ata_dmc], ['Revisão', manual.revisao],
      ['PNs principais', Array.isArray(manual.pns_principais) ? manual.pns_principais.join(', ') : ''],
      ['Método de leitura', manual.metodo_leitura],
    ]),
    metadata: baseMeta,
  });

  (pns.data || []).forEach((row) => docs.push({
    key: `manual:${manual.id}:pn:${row.id}`,
    sourceTable: 'manual_tecnico_pns',
    sourceId: row.id,
    type: 'MANUAL_TECNICO_WTP',
    title: `${manual.codigo} — PN ${safe(row.pn, 'não informado')}`,
    text: rowText('Fonte técnica: Detailed/Illustrated Parts List', [
      ['Manual', manual.codigo], ['Revisão', manual.revisao], ['ATA/DMC', manual.ata_dmc],
      ['PN', row.pn], ['Figura', row.fig], ['Item', row.item], ['Nomenclatura/Description', row.nomenclatura],
      ['Airline Part No.', row.airline_part_no], ['Usage code', row.usage_code],
      ['Units per assy', row.units_per_assy], ['Página/referência', row.page_ref],
    ]),
    metadata: { ...baseMeta, pn: row.pn || null, page_ref: row.page_ref || null },
  }));

  (falhas.data || []).forEach((row) => docs.push({
    key: `manual:${manual.id}:fault:${row.id}`,
    sourceTable: 'manual_tecnico_falhas',
    sourceId: row.id,
    type: 'MANUAL_FAULT_ISOLATION',
    title: `${manual.codigo} — Fault isolation — ${safe(row.fault, 'falha')}`,
    text: rowText('Fonte técnica: Fault Isolation', [
      ['Manual', manual.codigo], ['Revisão', manual.revisao], ['ATA/DMC', manual.ata_dmc],
      ['Falha', row.fault], ['Causa provável', row.probable_cause], ['Correção', row.correction],
      ['Task', row.task_ref], ['Página', row.page_ref],
    ]),
    metadata: { ...baseMeta, page_ref: row.page_ref || null },
  }));

  (recursos.data || []).forEach((row) => docs.push({
    key: `manual:${manual.id}:resource:${row.id}`,
    sourceTable: 'manual_tecnico_recursos',
    sourceId: row.id,
    type: 'MANUAL_RECURSOS',
    title: `${manual.codigo} — ${safe(row.categoria, 'Recurso')} — ${safe(row.pn || row.designacao, 'item')}`,
    text: rowText('Fonte técnica: ferramentas/consumíveis/equipamentos', [
      ['Manual', manual.codigo], ['Revisão', manual.revisao], ['ATA/DMC', manual.ata_dmc],
      ['Categoria', row.categoria], ['PN', row.pn], ['Designação', row.designacao],
      ['Fornecedor', row.fornecedor], ['Página', row.page_ref],
    ]),
    metadata: { ...baseMeta, pn: row.pn || null, page_ref: row.page_ref || null },
  }));

  (trechos.data || []).slice(0, 500).forEach((row) => docs.push({
    key: `manual:${manual.id}:chunk:${row.id}`,
    sourceTable: 'manual_tecnico_trechos',
    sourceId: row.id,
    type: 'MANUAL_TRECHO_TECNICO',
    title: `${manual.codigo} — ${safe(row.secao, 'Trecho técnico')}`,
    text: rowText('Fonte técnica: trecho de manual', [
      ['Manual', manual.codigo], ['Revisão', manual.revisao], ['ATA/DMC', manual.ata_dmc],
      ['Seção', row.secao], ['Página', row.page_ref], ['Trecho', row.trecho],
    ]),
    metadata: { ...baseMeta, page_ref: row.page_ref || null },
  }));

  let indexed = 0;
  let chunksCount = 0;
  const failures = [];
  for (const doc of docs) {
    const result = await upsertRagDocument({
      documentKey: doc.key,
      // Contrato legado: cada documento RAG representa exatamente um registro-fonte.
      // Isso preserva a UNIQUE(source_table, source_id) sem perder o vínculo do manual,
      // que continua em metadata.manual_id/document_key.
      origemTabela: doc.sourceTable || 'manuais_tecnicos',
      origemId: String(doc.sourceId ?? manual.id),
      tipoDocumento: doc.type,
      nomeArquivo: manual.arquivo_nome || null,
      titulo: doc.title,
      resumo: compactText(doc.text, 900),
      status: 'ATIVO',
      metadata: doc.metadata,
      text: doc.text,
      createdByEmail: manual.updated_by_email || manual.created_by_email || null,
      db,
    });
    if (result.ok) {
      indexed += 1;
      chunksCount += Number(result.chunks || 0);
    } else {
      failures.push({ key: doc.key, reason: result.reason });
    }
  }

  const ok = failures.length === 0;
  return {
    ok,
    indexed,
    chunks: chunksCount,
    failures: failures.slice(0, 50),
    reason: ok
      ? null
      : failures
          .slice(0, 3)
          .map((failure) => `${failure.key}: ${failure.reason || 'erro não detalhado'}`)
          .join(' | '),
  };
}

module.exports = {
  compactText,
  tokenize,
  buildChunks,
  indexChatLinceDocument,
  reindexChatLinceDocuments,
  reindexStructuredLogisticSources,
  reindexChatLinceKnowledgeBase,
  searchChatLinceRag,
  indexManualTechnicalById,
  removeManualTechnicalRag,
};
