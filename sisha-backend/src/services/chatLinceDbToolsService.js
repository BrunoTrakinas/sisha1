const supabase = require('../config/supabaseClient');

const SENSITIVE_TERMS = [
  'SENHA', 'PASSWORD', 'TOKEN', 'JWT', 'LOGIN', 'LOGINS', 'PERFIL', 'PERFIS',
  'AUTHORIZED_USERS', 'USUARIO', 'USUÁRIO', 'USUARIOS', 'USUÁRIOS', 'ROLE', 'ADMIN', 'DONO',
  'SYSTEM_AUDIT_LOGS', 'SYSTEM_USER_PRESENCE', 'ENV', 'SECRET', 'CHAVE API', 'API KEY'
];

function stripAccents(value = '') {
  return String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

function normalizeUpper(value = '') {
  return stripAccents(value).trim().toUpperCase();
}

function normalizePn(value = '') {
  return normalizeUpper(value).replace(/[^A-Z0-9]/g, '');
}

function compactText(value = '', max = 700) {
  return String(value || '')
    .replace(/\r/g, '')
    .replace(/[\t ]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, max);
}

function unique(values = []) {
  return Array.from(new Set(values.filter(Boolean)));
}

function safeNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function getFirst(row = {}, fields = []) {
  for (const field of fields) {
    const value = row?.[field];
    if (value !== undefined && value !== null && String(value).trim() !== '') return value;
  }
  return null;
}

function formatDate(value) {
  if (!value) return 'sem data';
  const text = String(value);
  if (/^\d{4}-\d{2}-\d{2}/.test(text)) {
    const [y, m, d] = text.slice(0, 10).split('-');
    return `${d}/${m}/${y}`;
  }
  return text.slice(0, 10);
}

function isSensitiveQuestion(question = '') {
  const q = normalizeUpper(question);
  return SENSITIVE_TERMS.some((term) => q.includes(term));
}

function extractCandidateTokens(text = '') {
  const upper = normalizeUpper(text);
  const ignored = new Set([
    'SISHA', 'CHAT', 'LINCE', 'COMO', 'QUAL', 'QUAIS', 'PORQUE', 'PARA', 'ITEM', 'ITENS',
    'ESTOQUE', 'CONSULTA', 'PRECISO', 'SABER', 'SOBRE', 'AERONAVE', 'MATERIAL', 'ORDER',
    'BOOK', 'SERVICE', 'BULLETIN', 'DOCUMENTO', 'DOCUMENTOS', 'STATUS', 'VALOR', 'TOTAL',
    'LOCAL', 'LOCALIZACAO', 'LOCALIZACAO', 'QUANTIDADE', 'NOMENCLATURA', 'LEONARDO', 'MARINHA', 'BRASIL',
    'RECIBO', 'RECEBIMENTO', 'ENTRARAM', 'ENTRADA', 'SAIRAM', 'SAIDA', 'SAÍDA', 'QUAIS', 'FORAM',
  ]);
  const raw = upper.match(/\b[A-Z0-9][A-Z0-9.\-\/]{3,}\b/g) || [];
  return unique(raw.map((token) => token.replace(/[.,;:]+$/g, '')).filter((token) => {
    const comparable = normalizePn(token);
    if (!comparable || ignored.has(token) || ignored.has(comparable)) return false;
    if (comparable.length < 4 || comparable.length > 45) return false;
    if (!/[0-9]/.test(comparable)) return false;
    if (/^\d{1,3}$/.test(comparable)) return false;
    return true;
  })).slice(0, 20);
}

function extractDocNumbers(text = '') {
  const upper = normalizeUpper(text);
  const docs = [];
  const patterns = [
    /\bPD\s*[A-Z0-9\-\/]*\d[A-Z0-9\-\/]*/g,
    /\bSEPD\s*[A-Z0-9\-\/]*\d[A-Z0-9\-\/]*/g,
    /\bP\d{4}\-\d{3,6}(?:\/\d+)?\b/g,
    /\bWO\s*[A-Z0-9\-\/]*\d[A-Z0-9\-\/]*/g,
    /\bOS\s*[A-Z0-9\-\/]*\d[A-Z0-9\-\/]*/g,
    /\bPIM\s*[A-Z0-9\-\/]*\d[A-Z0-9\-\/]*/g,
    /\bER\-\d+[A-Z]?\-\d+\b/g,
    /\bLX[_\-A-Z0-9.\/]{4,}\b/g,
  ];
  patterns.forEach((regex) => (upper.match(regex) || []).forEach((item) => docs.push(item.replace(/\s+/g, '').replace(/[.,;:]+$/g, ''))));
  return unique(docs).slice(0, 30);
}

function extractReceiptCandidates(text = '') {
  const upper = normalizeUpper(text);
  const candidates = [];
  const explicit = upper.match(/\b(?:RECIBO|RECEBIMENTO|ENTREGA)\s*(?:N[ºO.]?|NUMERO|NÚMERO|REF|REFERENCIA|REFERÊNCIA)?\s*[:#\-]?\s*([A-Z0-9][A-Z0-9.\-\/]{2,30})/g) || [];
  explicit.forEach((match) => {
    const value = match.replace(/^(RECIBO|RECEBIMENTO|ENTREGA)\s*(N[ºO.]?|NUMERO|NÚMERO|REF|REFERENCIA|REFERÊNCIA)?\s*[:#\-]?\s*/i, '');
    if (value) candidates.push(value.replace(/[.,;:]+$/g, ''));
  });
  if (/\b(RECIBO|RECEBIMENTO|ENTRARAM|ENTRADA|ENTREGUE|ENTREGA)\b/.test(upper)) {
    (upper.match(/\b\d{2,8}(?:\/\d{2,4})?\b/g) || []).forEach((item) => candidates.push(item));
  }
  return unique(candidates).slice(0, 8);
}

async function safeSelect(table, columns, builderFn, meta = {}) {
  try {
    let query = supabase.from(table).select(columns).limit(meta.limit || 40);
    if (builderFn) query = builderFn(query);
    const { data, error } = await query;
    if (error) return { table, ok: false, error: error.message, data: [], meta };
    return { table, ok: true, data: data || [], meta };
  } catch (error) {
    return { table, ok: false, error: error.message, data: [], meta };
  }
}

function addSource(sources, result, label = '') {
  if (result?.ok && Array.isArray(result.data) && result.data.length) {
    sources.push({ tabela: result.table, motivo: label || result.meta?.motivo || 'consulta segura do banco', linhas: result.data });
  }
}

function sourceSummary(sources = []) {
  return sources.map((source) => ({ tabela: source.tabela, motivo: source.motivo, quantidade: (source.linhas || []).length }));
}

function sumRows(rows = [], fields = ['quantidade', 'qtd_pendente', 'qtd_comprada', 'qtd_pedida']) {
  return rows.reduce((sum, row) => sum + safeNumber(getFirst(row, fields)), 0);
}

function groupPdByStatus(rows = []) {
  const acc = {};
  rows.forEach((row) => {
    const status = normalizeUpper(getFirst(row, ['status_grupo', 'status_item', 'status']) || 'SEM_STATUS');
    if (!acc[status]) acc[status] = { qtd: 0, linhas: 0 };
    acc[status].qtd += safeNumber(getFirst(row, ['quantidade', 'qtd_comprada', 'qtd_pedida']));
    acc[status].linhas += 1;
  });
  return acc;
}

function tableRows(sources = [], table = '') {
  return sources.filter((source) => source.tabela === table).flatMap((source) => source.linhas || []);
}

function buildReceiptAnswer(question, sources, receiptCandidates = []) {
  const recibos = tableRows(sources, 'recebimentos');
  const itens = tableRows(sources, 'recebimento_itens');
  const ppu = tableRows(sources, 'estoque_ppu');

  if (!recibos.length && !itens.length && !ppu.length) {
    const ref = receiptCandidates.length ? ` ${receiptCandidates.join(', ')}` : '';
    return `Procurei o recibo${ref} nos registros de recebimento e também nas entradas do PPU, mas não encontrei item vinculado com segurança.\n\nMinha sugestão é conferir se o número do recibo foi digitado exatamente como consta no documento, incluindo barra ou ano, e validar se esse recibo já foi importado pela Central de Inserção.`;
  }

  const lines = [];
  const ref = recibos[0]?.numero_recibo || receiptCandidates[0] || 'informado';
  lines.push(`Encontrei informação de entrada relacionada ao recibo ${ref}.`);
  if (recibos.length) {
    const header = recibos[0];
    lines.push(`Data do recebimento: ${formatDate(header.data_recebimento)}${header.tipo_recebimento ? ` • Tipo: ${header.tipo_recebimento}` : ''}${header.is_foc ? ' • FOC' : ''}.`);
  }
  lines.push('');

  if (itens.length) {
    lines.push('Itens registrados no recebimento:');
    itens.slice(0, 20).forEach((item, index) => {
      const parts = [`${index + 1}. PN ${item.pn || 'não informado'}`];
      if (item.nomenclatura) parts.push(compactText(item.nomenclatura, 90));
      parts.push(`qtd ${safeNumber(item.quantidade)}`);
      if (item.sn) parts.push(`SN ${item.sn}`);
      if (item.localizacao_ppu) parts.push(`local ${item.localizacao_ppu}`);
      lines.push(parts.join(' — '));
    });
  }

  if (ppu.length) {
    if (itens.length) lines.push('');
    lines.push('Também localizei reflexo no PPU:');
    ppu.slice(0, 12).forEach((item) => {
      lines.push(`- PN ${item.pn || 'não informado'} — ${item.nomenclatura || 'sem nomenclatura'} — qtd ${safeNumber(item.quantidade)} — local ${item.localizacao || 'não informado'}${item.sn ? ` — SN ${item.sn}` : ''}.`);
    });
  }

  lines.push('');
  lines.push('Fonte usada: tabelas operacionais de recebimento/entrada e PPU. Se o recibo foi apenas analisado como documento e ainda não confirmado, ele pode aparecer no RAG/documentos, mas não como entrada operacional consolidada.');
  return lines.join('\n');
}

function buildAvailabilityAnswer(question, sources, pns = []) {
  const ppu = tableRows(sources, 'estoque_ppu');
  const ceimspa = tableRows(sources, 'estoque_ceimspa');
  const pds = tableRows(sources, 'compras_pds');
  const wos = tableRows(sources, 'work_orders');
  const spares = tableRows(sources, 'leonardo_spares');
  const foc = tableRows(sources, 'leonardo_foc_spares');
  const repairs = tableRows(sources, 'leonardo_repairs');
  const price = tableRows(sources, 'price_list');
  const rfq = tableRows(sources, 'rfq_cotacoes');
  const receitas = tableRows(sources, 'receita_itens');
  const historico = tableRows(sources, 'historico_movimentacao');
  const manual = [...tableRows(sources, 'dicionario_mestre'), ...tableRows(sources, 'dicionario_manual')];

  const anyRows = [ppu, ceimspa, pds, wos, spares, foc, repairs, price, rfq, receitas, historico, manual].some((rows) => rows.length);
  const alvo = pns.length ? pns.join(', ') : 'item informado';
  if (!anyRows) {
    return `Procurei por ${alvo} nas bases logísticas do SISHA, mas não encontrei registro operacional confiável.\n\nNão vou afirmar que existe estoque, compra, WO, receita ou preço sem fonte confirmada. Recomendo conferir se o PN/PI/NSN foi digitado corretamente ou tentar pela nomenclatura.`;
  }

  const pdStatus = groupPdByStatus(pds);
  const lines = [];
  lines.push(`Procurei por ${alvo} nas bases logísticas do SISHA.`);
  lines.push('');
  if (manual.length) {
    const first = manual[0];
    lines.push(`Identificação técnica: ${first.pn ? `PN ${first.pn}` : alvo}${first.nomenclatura ? ` — ${first.nomenclatura}` : ''}${first.pi ? ` • PI ${first.pi}` : ''}${first.nsn ? ` • NSN ${first.nsn}` : ''}.`);
  }
  lines.push(`PPU: ${sumRows(ppu, ['quantidade'])} unidade(s) encontrada(s).`);
  if (ppu.length) {
    ppu.slice(0, 6).forEach((row) => lines.push(`- PPU: qtd ${safeNumber(row.quantidade)} em ${row.localizacao || 'local não informado'}${row.sn ? ` • SN ${row.sn}` : ''}.`));
  }
  lines.push(`CeIMSPA: ${sumRows(ceimspa, ['quantidade'])} unidade(s) como possibilidade. Confirme com o CeIMSPA antes de considerar disponível.`);

  if (Object.keys(pdStatus).length) {
    const statusText = Object.entries(pdStatus).map(([status, info]) => `${status}: ${info.qtd}`).join(' • ');
    lines.push(`PD/OC: ${statusText}.`);
  } else {
    lines.push('PD/OC: não encontrei PD ativo para esse item nas tabelas consultadas.');
  }

  if (spares.length || foc.length || repairs.length) {
    lines.push(`Order Book/Leonardo: ${spares.length} spare(s), ${foc.length} FOC, ${repairs.length} repair/warranty.`);
    [...spares, ...foc, ...repairs].slice(0, 8).forEach((row) => {
      const ref = row.documento_referencia || row.oc_referencia || row.numero_wo || row.id;
      const status = row.status_categoria || row.status || row.data_previsao_lh || row.data_previsao || 'sem status';
      lines.push(`- ${ref || 'referência'}: ${row.descricao || row.nomenclatura || 'sem descrição'} • qtd ${safeNumber(row.qtd_pendente || row.quantidade || 0)} • ${status}${row.sn ? ` • SN ${row.sn}` : ''}.`);
    });
  }

  if (wos.length) lines.push(`WO: encontrei ${wos.length} registro(s) de WO relacionado(s).`);
  if (price.length || rfq.length) lines.push(`Preço/cotação: ${price.length ? 'há Price List' : 'sem Price List'}; ${rfq.length ? 'há RFQ/cotação' : 'sem RFQ/cotação'} nas fontes consultadas.`);
  if (receitas.length) lines.push(`Receitas/inspeções: aparece em ${receitas.length} registro(s) de receita. Isso indica uso operacional cadastrado.`);
  if (historico.length) lines.push(`Histórico de movimentação: encontrei ${historico.length} saída(s)/movimentação(ões) registrada(s).`);

  lines.push('');
  lines.push('Conclusão: use essa leitura para decisão logística. Estoque PPU é disponibilidade real; CeIMSPA é possibilidade; PD/OC/Order Book indicam caminho de suprimento; receitas e histórico ajudam a decidir se o item é de interesse operacional.');
  return lines.join('\n');
}

function buildDocumentAnswer(question, sources, docs = []) {
  const ordens = tableRows(sources, 'compras_ordens');
  const pds = tableRows(sources, 'compras_pds');
  const wos = tableRows(sources, 'work_orders');
  const suplementosOc = tableRows(sources, 'compras_suplementacoes');
  const suplementosWo = tableRows(sources, 'work_order_suplementacoes');
  const adminDocs = tableRows(sources, 'leonardo_admin_docs');
  const rowsFound = ordens.length + pds.length + wos.length + suplementosOc.length + suplementosWo.length + adminDocs.length;

  if (!rowsFound) {
    return `Procurei ${docs.length ? docs.join(', ') : 'o documento informado'} nas tabelas logísticas do SISHA, mas não encontrei registro operacional confirmado.\n\nVerifique se o número foi digitado completo, por exemplo com prefixo PD, OC/P, WO, ER ou PIM.`;
  }

  const lines = ['Encontrei registros para o documento informado:'];
  if (ordens.length) {
    lines.push('', 'OC/ODC/ODA:');
    ordens.slice(0, 10).forEach((row) => lines.push(`- ${row.numero_oc || row.numero_oc_original}: status ${row.status || 'não informado'} • valor ${row.valor_total_gbp || row.valor_total || 0} ${row.moeda || row.sigla_moeda || 'GBP'}${row.observacao ? ` • ${compactText(row.observacao, 100)}` : ''}.`));
  }
  if (pds.length) {
    lines.push('', 'PDs:');
    pds.slice(0, 20).forEach((row) => lines.push(`- ${row.numero_pd}: PN ${row.pn || 'não informado'} • qtd ${safeNumber(row.quantidade || row.qtd_pedida || row.qtd_comprada)} • status ${row.status_grupo || row.status_item || row.status || 'não informado'} • OC ${row.numero_oc || 'não vinculada'}.`));
  }
  if (wos.length) {
    lines.push('', 'WO/Repair:');
    wos.slice(0, 15).forEach((row) => lines.push(`- ${row.numero_wo}: PN ${row.pn || 'não informado'}${row.sn ? ` • SN ${row.sn}` : ''} • status ${row.status || 'não informado'} • resultado ${row.resultado_tecnico || row.resultado || 'pendente'}.`));
  }
  if (suplementosOc.length || suplementosWo.length) {
    lines.push('', 'Suplementações vinculadas:');
    [...suplementosOc, ...suplementosWo].slice(0, 10).forEach((row) => lines.push(`- ${row.msg_referencia || row.id}: ${safeNumber(row.valor)} ${row.moeda || ''}${row.data_msg ? ` • MSG ${formatDate(row.data_msg)}` : ''}${row.observacao ? ` • ${compactText(row.observacao, 120)}` : ''}.`));
  }
  if (adminDocs.length) {
    lines.push('', 'Documentos Leonardo/Admin:');
    adminDocs.slice(0, 10).forEach((row) => lines.push(`- ${row.tipo_doc || 'Doc'} ${row.numero_doc || ''}: ${row.assunto_pn || 'sem PN'} • status ${row.status || 'não informado'}.`));
  }
  return lines.join('\n');
}

function buildRecipeHistoryAnswer(question, sources, pns = []) {
  const receitas = tableRows(sources, 'receita_itens');
  const hist = tableRows(sources, 'historico_movimentacao');
  const pim = tableRows(sources, 'pim_demandas');
  const sb = tableRows(sources, 'service_bulletin_items');
  const alvo = pns.length ? pns.join(', ') : 'item informado';
  if (!receitas.length && !hist.length && !pim.length && !sb.length) {
    return `Procurei uso operacional de ${alvo} em receitas, histórico de movimentação, PIM/OS e SB, mas não encontrei evidência cadastrada.\n\nIsso não significa que o item nunca seja usado; significa apenas que, no SISHA, não encontrei consumo/aplicação operacional confirmado nessas fontes.`;
  }
  const lines = [`Encontrei evidências de uso operacional para ${alvo}:`];
  if (receitas.length) {
    lines.push('', 'Receitas/inspeções:');
    receitas.slice(0, 20).forEach((row) => lines.push(`- ${row.inspecao || row.receita || row.tarefa || 'Receita'}: PN ${row.pn || 'não informado'}${row.pn_alt ? ` • alternativo ${row.pn_alt}` : ''} • qtd/ciclo ${safeNumber(row.qtd_por_ciclo || row.quantidade || row.qtd)}${row.nomenclatura ? ` • ${compactText(row.nomenclatura, 90)}` : ''}.`));
  }
  if (hist.length) {
    lines.push('', 'Histórico de movimentação:');
    hist.slice(0, 20).forEach((row) => lines.push(`- ${formatDate(row.data || row.data_movimentacao || row.created_at)}: qtd ${safeNumber(row.qtd || row.quantidade)}${row.os ? ` • OS ${row.os}` : ''}${row.observacao ? ` • ${compactText(row.observacao, 100)}` : ''}.`));
  }
  if (pim.length) {
    lines.push('', 'PIM/OS pendentes ou registradas:');
    pim.slice(0, 12).forEach((row) => lines.push(`- ${row.pim || 'PIM'}${row.os_vinculada ? ` / OS ${row.os_vinculada}` : ''}: PN ${row.pn || 'não informado'} • qtd ${safeNumber(row.quantidade || row.qtd)} • ${row.origem_descricao || row.status || 'sem detalhe'}.`));
  }
  if (sb.length) {
    lines.push('', 'Service Bulletin:');
    sb.slice(0, 12).forEach((row) => lines.push(`- ${row.sb_numero || row.service_bulletin_id || 'SB'}: PN ${row.pn || 'não informado'} • qtd ${safeNumber(row.quantidade || row.qtd)}${row.nomenclatura ? ` • ${compactText(row.nomenclatura, 90)}` : ''}.`));
  }
  lines.push('', 'Essa é a leitura que ajuda a separar item de interesse operacional de item apenas ofertado pelo fornecedor.');
  return lines.join('\n');
}

async function runReceiptTool(question, sources, modules) {
  const receiptCandidates = extractReceiptCandidates(question);
  const wantsReceipt = /\b(RECIBO|RECEBIMENTO|ENTRARAM|ENTRADA|ENTREGUE|ENTREGA)\b/.test(normalizeUpper(question));
  if (!wantsReceipt) return null;

  modules.recebimentos = true;
  const tasks = [];
  if (receiptCandidates.length) {
    receiptCandidates.forEach((ref) => {
      const clean = String(ref).replace(/[%_]/g, '');
      tasks.push(safeSelect('recebimentos', '*', (q) => q.ilike('numero_recibo', `%${clean}%`), { motivo: `Recebimento pelo recibo ${clean}`, limit: 10 }));
      tasks.push(safeSelect('estoque_ppu', '*', (q) => q.ilike('localizacao', `%${clean}%`), { motivo: `PPU com referência ao recibo ${clean}`, limit: 30 }));
    });
  } else {
    tasks.push(safeSelect('recebimentos', '*', (q) => q.order('created_at', { ascending: false }), { motivo: 'Últimos recebimentos', limit: 10 }));
  }

  const headers = await Promise.all(tasks);
  headers.forEach((result) => addSource(sources, result));

  const recebimentoIds = unique(tableRows(sources, 'recebimentos').map((row) => row.id).filter(Boolean));
  if (recebimentoIds.length) {
    const itens = await safeSelect('recebimento_itens', '*', (q) => q.in('recebimento_id', recebimentoIds), { motivo: 'Itens vinculados ao recebimento', limit: 200 });
    addSource(sources, itens);
  } else if (receiptCandidates.length) {
    receiptCandidates.forEach(async () => {});
  }

  return { answer: buildReceiptAnswer(question, sources, receiptCandidates), intent: 'CONSULTA_RECIBO', tokens: receiptCandidates };
}

async function runDocumentTool(question, sources, modules) {
  const docs = extractDocNumbers(question);
  const q = normalizeUpper(question);
  if (!docs.length && !/\b(OC|ODC|ODA|PD|SEPD|WO|PIM|ER|TQS|SUPLEMENTACAO|SUPLEMENTAÇÃO)\b/.test(q)) return null;

  modules.documentos_logisticos = true;
  const cleanDocs = unique([...docs, ...docs.map((doc) => doc.replace(/^(OC|ODC|ODA|PD|SEPD|WO|OS|PIM)/, ''))]);
  const tasks = [];
  if (cleanDocs.length) {
    tasks.push(safeSelect('compras_ordens', '*', (query) => query.in('numero_oc', cleanDocs), { motivo: 'OC por número', limit: 30 }));
    tasks.push(safeSelect('compras_ordens', '*', (query) => query.in('numero_oc_original', cleanDocs), { motivo: 'OC por número original', limit: 30 }));
    tasks.push(safeSelect('compras_pds', '*', (query) => query.in('numero_pd', cleanDocs), { motivo: 'PD por número', limit: 80 }));
    tasks.push(safeSelect('compras_pds', '*', (query) => query.in('numero_oc', cleanDocs), { motivo: 'PDs vinculados à OC', limit: 80 }));
    tasks.push(safeSelect('work_orders', '*', (query) => query.in('numero_wo', cleanDocs), { motivo: 'WO por número', limit: 30 }));
    tasks.push(safeSelect('leonardo_admin_docs', '*', (query) => query.in('numero_doc', cleanDocs), { motivo: 'ER/TQS/Admin Leonardo', limit: 30 }));
  }
  const settled = await Promise.all(tasks);
  settled.forEach((result) => addSource(sources, result));

  const ordemIds = unique(tableRows(sources, 'compras_ordens').map((row) => row.id).filter(Boolean));
  if (ordemIds.length) {
    const supp = await safeSelect('compras_suplementacoes', '*', (query) => query.in('ordem_id', ordemIds), { motivo: 'Suplementações da OC', limit: 50 });
    addSource(sources, supp);
  }
  return { answer: buildDocumentAnswer(question, sources, docs), intent: 'CONSULTA_DOCUMENTO', tokens: docs };
}

async function runPnTool(question, sources, modules) {
  const pns = unique(extractCandidateTokens(question).map(normalizePn)).slice(0, 12);
  const q = normalizeUpper(question);
  const wantsPn = pns.length > 0 && /\b(TEMOS|EXISTE|ESTOQUE|SALDO|PN|P\/N|ITEM|QUANTIDADE|DISPONIVEL|DISPONÍVEL|COMPRAR|OFERTA|LEONARDO|RECEITA|USADO|USADA|HISTORICO|HISTÓRICO|PIM|OS|COTACAO|COTAÇÃO|PRECO|PREÇO)\b/.test(q);
  if (!wantsPn) return null;

  modules.consulta_pn = true;
  const tasks = [
    safeSelect('dicionario_mestre', '*', (query) => query.in('pn', pns), { motivo: 'Dicionário mestre por PN', limit: 50 }),
    safeSelect('dicionario_manual', '*', (query) => query.in('pn', pns), { motivo: 'Dicionário manual por PN', limit: 50 }),
    safeSelect('estoque_ppu', '*', (query) => query.in('pn', pns), { motivo: 'PPU por PN', limit: 100 }),
    safeSelect('compras_pds', '*', (query) => query.in('pn', pns), { motivo: 'PD/OC por PN', limit: 100 }),
    safeSelect('work_orders', '*', (query) => query.in('pn', pns), { motivo: 'WO por PN', limit: 80 }),
    safeSelect('leonardo_spares', '*', (query) => query.in('pn', pns), { motivo: 'Order Book Spares por PN', limit: 100 }),
    safeSelect('leonardo_foc_spares', '*', (query) => query.in('pn', pns), { motivo: 'FOC Spares por PN', limit: 100 }),
    safeSelect('leonardo_repairs', '*', (query) => query.in('pn', pns), { motivo: 'Repair/Warranty por PN', limit: 100 }),
    safeSelect('price_list', '*', (query) => query.in('pn', pns), { motivo: 'Price List por PN', limit: 50 }),
    safeSelect('rfq_cotacoes', '*', (query) => query.in('pn', pns), { motivo: 'RFQ/cotações por PN', limit: 50 }),
    safeSelect('receita_itens', '*', (query) => query.in('pn', pns), { motivo: 'Receitas por PN', limit: 100 }),
    safeSelect('receita_itens', '*', (query) => query.in('pn_alt', pns), { motivo: 'Receitas por PN alternativo', limit: 100 }),
    safeSelect('historico_movimentacao', '*', (query) => query.in('pn', pns), { motivo: 'Histórico de movimentação por PN', limit: 100 }),
    safeSelect('pim_demandas', '*', (query) => query.in('pn', pns), { motivo: 'PIM/OS por PN', limit: 80 }),
    safeSelect('service_bulletin_items', '*', (query) => query.in('pn', pns), { motivo: 'SB por PN', limit: 80 }),
  ];

  // PI/CeIMSPA: se o dicionário tiver PI, consulta por PI também.
  const settled = await Promise.all(tasks);
  settled.forEach((result) => addSource(sources, result));
  const pis = unique([...tableRows(sources, 'dicionario_mestre'), ...tableRows(sources, 'dicionario_manual')].map((row) => row.pi || row.nsn_pi).filter(Boolean));
  if (pis.length) {
    const ceimspa = await safeSelect('estoque_ceimspa', '*', (query) => query.in('pi', pis), { motivo: 'CeIMSPA por PI extraído do manual', limit: 80 });
    addSource(sources, ceimspa);
  }

  if (/\b(RECEITA|INSPECAO|INSPEÇÃO|USADO|USADA|HISTORICO|HISTÓRICO|MOVIMENTACAO|MOVIMENTAÇÃO|PIM|OS|SB)\b/.test(q)) {
    return { answer: buildRecipeHistoryAnswer(question, sources, pns), intent: 'CONSULTA_USO_OPERACIONAL', tokens: pns };
  }
  return { answer: buildAvailabilityAnswer(question, sources, pns), intent: 'CONSULTA_PN_BANCO', tokens: pns };
}

async function answerWithDbTools(question = '', user = null) {
  const q = normalizeUpper(question);
  const sources = [];
  const modules = {
    ferramentas_banco: true,
    recebimentos: false,
    documentos_logisticos: false,
    consulta_pn: false,
    bloqueio_sensivel: false,
  };

  if (isSensitiveQuestion(question)) {
    return {
      handled: true,
      data: {
        resposta: 'Essa área não é tratada pelo Chat Lince. Eu posso responder sobre logística, estoque, PN, PI, CeIMSPA, OC, PD, WO, RFQ, receitas, PIM, OS, histórico e documentos operacionais, mas não consulto nem exponho senha, token, login, perfil ou dado sensível de administração.',
        modelo: 'db-tools-safe-guard',
        aviso_ia: null,
        contexto: {
          agente: { versao: 'CHAT_LINCE_DB_TOOLS_V1', intencao: 'BLOQUEIO_SENSIVEL', rotulo: 'Bloqueio de área sensível', confianca_intencao: 1 },
          tokens: [], sn: [], identificadores_documentais: [], os: [], modulos: { ...modules, bloqueio_sensivel: true }, trilha_sn: [], aplicacoes_manual: [], fontes: [], helpdesk: null,
        },
      },
    };
  }

  let result = null;
  if (/\b(RECIBO|RECEBIMENTO|ENTRARAM|ENTRADA|ENTREGUE|ENTREGA)\b/.test(q)) {
    result = await runReceiptTool(question, sources, modules);
  }
  if (!result && /\b(OC|ODC|ODA|PD|SEPD|WO|PIM|ER|TQS|SUPLEMENTACAO|SUPLEMENTAÇÃO)\b/.test(q)) {
    result = await runDocumentTool(question, sources, modules);
  }
  if (!result) {
    result = await runPnTool(question, sources, modules);
  }

  if (!result) return { handled: false };

  return {
    handled: true,
    data: {
      resposta: result.answer,
      modelo: 'chat-lince-db-tools-v1',
      aviso_ia: null,
      contexto: {
        agente: {
          versao: 'CHAT_LINCE_DB_TOOLS_V1',
          intencao: result.intent,
          rotulo: 'Consulta segura ao banco logístico',
          confianca_intencao: 0.92,
          observacao: 'Ferramenta de leitura whitelisted. Não executa SQL livre e não acessa login/senha/perfis/tokens.',
        },
        tokens: result.tokens || [],
        termos: [],
        sn: [],
        identificadores_documentais: result.intent === 'CONSULTA_DOCUMENTO' ? (result.tokens || []) : [],
        os: [],
        modulos: modules,
        trilha_sn: [],
        aplicacoes_manual: [],
        correlacoes_sugeridas: [],
        fontes: sourceSummary(sources),
        helpdesk: null,
        indisponiveis: [],
      },
    },
  };
}

module.exports = {
  answerWithDbTools,
};
