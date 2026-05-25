const supabase = require('../config/supabaseClient');

const DEFAULT_CHUNK_SIZE = 1800;
const DEFAULT_CHUNK_OVERLAP = 220;
const SENSITIVE_TERMS = [
  'authorized_users', 'senha', 'password', 'token', 'jwt', 'perfil', 'login',
  'system_user_presence', 'system_audit_logs'
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
  const stop = new Set(['COM', 'PARA', 'POR', 'QUE', 'QUAL', 'QUAIS', 'ITEM', 'ITENS', 'TEMOS', 'EXISTE', 'ONDE', 'SISHA', 'CHAT', 'LINCE']);
  return Array.from(new Set(tokens
    .map((token) => token.replace(/[.,;:]+$/g, ''))
    .filter((token) => token.length >= 3 && token.length <= 48 && !stop.has(token))))
    .slice(0, 18);
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

async function indexChatLinceDocument(documento = {}) {
  const documentKey = documentKeyFrom(documento);
  const text = sanitizeForRag(documento.texto_extraido || documento.resumo || '');
  if (!documentKey || !text) return { ok: false, reason: 'Documento sem chave ou texto útil para RAG.' };

  const docPayload = {
    document_key: documentKey,
    origem_tabela: 'chat_lince_documentos',
    origem_id: documentKey,
    tipo_documento: documento.tipo_documento || documento.classificacao || null,
    nome_arquivo: documento.nome_arquivo || null,
    titulo: documento.nome_arquivo || documento.resumo || documentKey,
    resumo: documento.resumo || null,
    status: documento.status || null,
    created_by_email: documento.created_by_email || null,
    metadata: {
      classificacao: documento.classificacao || null,
      destino_sugerido: documento.destino_sugerido || null,
      entidades: documento.entidades || {},
    },
    updated_at: new Date().toISOString(),
  };

  const { data: doc, error: docError } = await supabase
    .from('chat_lince_rag_documents')
    .upsert(docPayload, { onConflict: 'document_key' })
    .select('*')
    .single();

  if (docError) return { ok: false, reason: docError.message };

  await supabase.from('chat_lince_rag_chunks').delete().eq('document_key', documentKey);

  const chunks = buildChunks(text).map((chunkText, index) => ({
    rag_document_id: doc.id,
    document_key: documentKey,
    chunk_index: index,
    chunk_text: chunkText,
    tokens: tokenize(`${documento.nome_arquivo || ''} ${documento.tipo_documento || ''} ${documento.classificacao || ''} ${chunkText}`),
    metadata: {
      nome_arquivo: documento.nome_arquivo || null,
      tipo_documento: documento.tipo_documento || documento.classificacao || null,
      origem_tabela: 'chat_lince_documentos',
    },
  }));

  if (!chunks.length) return { ok: true, document: doc, chunks: 0 };

  const { error: chunkError } = await supabase.from('chat_lince_rag_chunks').insert(chunks);
  if (chunkError) return { ok: false, reason: chunkError.message, document: doc };

  return { ok: true, document: doc, chunks: chunks.length };
}

async function reindexChatLinceDocuments({ limit = 250 } = {}) {
  const { data, error } = await supabase
    .from('chat_lince_documentos')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(Math.min(Math.max(Number(limit) || 250, 1), 1000));

  if (error) return { ok: false, reason: error.message, processed: 0, indexed: 0 };

  let indexed = 0;
  const failures = [];
  for (const documento of data || []) {
    const result = await indexChatLinceDocument(documento);
    if (result.ok) indexed += 1;
    else failures.push({ id: documento.id, nome_arquivo: documento.nome_arquivo, reason: result.reason });
  }

  return { ok: true, processed: (data || []).length, indexed, failures };
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
    .select('id,document_key,chunk_index,chunk_text,tokens,metadata,chat_lince_rag_documents(document_key,tipo_documento,nome_arquivo,titulo,resumo,status)')
    .or(clause)
    .limit(Math.min(Math.max(Number(limit) || 12, 1), 25));

  if (error) return [];

  return (data || []).map((row) => ({
    ...row,
    trecho: compactText(row.chunk_text, 1800),
    documento: row.chat_lince_rag_documents || null,
  }));
}

module.exports = {
  compactText,
  tokenize,
  buildChunks,
  indexChatLinceDocument,
  reindexChatLinceDocuments,
  searchChatLinceRag,
};
