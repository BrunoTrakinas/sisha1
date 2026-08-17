const supabase = require('../config/supabaseClient');
const { resolvePnRelations } = require('./pnRelationsService');
const { loadEffectivePpuRowsByPns } = require('./ppuEffectiveAvailabilityService');
const { sourcePublicLabel } = require('./chatLinceEvidenceTrustService');

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
  // PN do SISHA preserva hífen, barra e ponto; remove apenas espaços de digitação.
  return normalizeUpper(value).replace(/\s+/g, '');
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


function extractExplicitPnCandidates(text = '') {
  const upper = normalizeUpper(text);
  const values = [];
  const patterns = [
    /\bP\/?N\s*[:#-]?\s*([A-Z0-9][A-Z0-9.\-\/]{2,40})\b/g,
    /\bPART\s*NUMBER\s*[:#-]?\s*([A-Z0-9][A-Z0-9.\-\/]{2,40})\b/g,
  ];
  patterns.forEach((regex) => {
    let match;
    while ((match = regex.exec(upper))) {
      const value = normalizePn(String(match[1] || '').replace(/[.,;:]+$/g, ''));
      if (value) values.push(value);
    }
  });
  if (/\b(?:PN|P\/N|PART\s*NUMBER)\b/.test(upper)) {
    extractCandidateTokens(upper).forEach((token) => values.push(normalizePn(token)));
  }
  return unique(values).slice(0, 12);
}

function isDossierQuestion(text = '') {
  const q = normalizeUpper(text);
  return /\b(DOSSIE|DOSSIÊ|DOSSIER|CRUZE|CRUZAR|CRUZAMENTO|HISTORICO COMPLETO|HISTÓRICO COMPLETO|TODOS OS SN|TODOS OS S\/N|TRILHA COMPLETA|RASTREIO COMPLETO)\b/.test(q);
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

async function safeCount(table, builderFn, meta = {}) {
  try {
    let query = supabase.from(table).select('id', { count: 'exact', head: true });
    if (builderFn) query = builderFn(query);
    const { count, error } = await query;
    if (error) return { table, ok: false, error: error.message, count: 0, meta };
    return { table, ok: true, count: Number(count || 0), meta };
  } catch (error) {
    return { table, ok: false, error: error.message, count: 0, meta };
  }
}


async function safeEffectivePpuSelect(pns = [], meta = {}) {
  try {
    const data = await loadEffectivePpuRowsByPns(pns);
    return { table: 'v_sisha_ppu_disponibilidade_efetiva', ok: true, data: data || [], meta };
  } catch (error) {
    return { table: 'v_sisha_ppu_disponibilidade_efetiva', ok: false, error: error.message, data: [], meta };
  }
}

function addSource(sources, result, label = '') {
  if (result?.ok && Array.isArray(result.data) && result.data.length) {
    sources.push({ tabela: result.table, motivo: label || result.meta?.motivo || 'consulta segura do banco', linhas: result.data });
  }
}

function sourceSummary(sources = []) {
  return sources.map((source) => ({
    tabela: source.tabela,
    rotulo: sourcePublicLabel(source.tabela),
    motivo: source.motivo,
    quantidade: (source.linhas || []).length,
  }));
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

function consolidatedPpuRows(sources = []) {
  const effective = tableRows(sources, 'v_sisha_ppu_disponibilidade_efetiva');
  if (effective.length) return effective;
  const consolidated = tableRows(sources, 'v_sisha_ppu_disponibilidade');
  return consolidated.length ? consolidated : tableRows(sources, 'estoque_ppu');
}

function consolidatedCeimspaRows(sources = []) {
  const consolidated = tableRows(sources, 'v_sisha_ceimspa_disponibilidade');
  return consolidated.length ? consolidated : tableRows(sources, 'estoque_ceimspa');
}

function buildReceiptAnswer(question, sources, receiptCandidates = []) {
  const recibos = tableRows(sources, 'recebimentos');
  const itens = tableRows(sources, 'recebimento_itens');
  const ppu = consolidatedPpuRows(sources);
  const ceimspa = consolidatedCeimspaRows(sources);

  if (!recibos.length && !itens.length && !ppu.length && !ceimspa.length) {
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
      const incorporated = safeNumber(item.quantidade_inventariada || (item.inventariado_ppu ? item.quantidade : 0));
      const countsByReceipt = item.contabiliza_pelo_recibo !== false && incorporated < safeNumber(item.quantidade);
      if (countsByReceipt) {
        parts.push('controlado temporariamente pelo recibo');
      } else if (incorporated > 0 && item.destino_estoque) {
        parts.push(`já incorporado ao estoque oficial do ${normalizeUpper(item.destino_estoque)}`);
      }
      lines.push(parts.join(' — '));
    });
  }

  if (ppu.length) {
    if (itens.length) lines.push('');
    lines.push('Também localizei reflexo na disponibilidade do PPU:');
    ppu.slice(0, 12).forEach((item) => {
      const sourceLabel = item.origem_saldo === 'RECIBO_PENDENTE'
        ? `Recibo ${item.numero_recibo || ref} — saldo temporário`
        : 'Inventário oficial do PPU';
      lines.push(`- ${sourceLabel}: PN ${item.pn || 'não informado'} — ${item.nomenclatura || 'sem nomenclatura'} — qtd ${safeNumber(item.quantidade)} — local ${item.localizacao || 'não informado'}${item.sn ? ` — SN ${item.sn}` : ''}.`);
    });
  }

  if (ceimspa.length) {
    if (itens.length || ppu.length) lines.push('');
    lines.push('Também localizei reflexo na disponibilidade do CeIMSPA:');
    ceimspa.slice(0, 12).forEach((item) => {
      const sourceLabel = 'Estoque oficial do CeIMSPA';
      lines.push(`- ${sourceLabel}: PN ${item.pn || 'não confirmado'} — ${item.nomenclatura || 'sem nomenclatura'} — qtd ${safeNumber(item.quantidade)}${item.uf ? ` — local/UF ${item.uf}` : ''}.`);
    });
  }

  lines.push('');
  lines.push('Fonte usada: tabelas operacionais de recebimento, saldos temporários controlados por recibo e inventários oficiais consolidados do PPU/CeIMSPA. Se o recibo foi apenas analisado como documento e ainda não confirmado, ele pode aparecer no RAG/documentos, mas não como entrada operacional consolidada.');
  return lines.join('\n');
}

function buildAvailabilityAnswer(question, sources, pns = []) {
  const ppu = consolidatedPpuRows(sources);
  const ceimspa = consolidatedCeimspaRows(sources);
  const pds = tableRows(sources, 'compras_pds');
  const wos = tableRows(sources, 'work_orders');
  const spares = tableRows(sources, 'leonardo_spares');
  const foc = tableRows(sources, 'leonardo_foc_spares');
  const repairs = tableRows(sources, 'leonardo_repairs');
  const price = tableRows(sources, 'price_list');
  const rfq = tableRows(sources, 'rfq_cotacoes');
  const priceRef = tableRows(sources, 'v_sisha_preco_referencia');
  const receitas = tableRows(sources, 'receita_itens');
  const historico = tableRows(sources, 'historico_movimentacao');
  const manual = [...tableRows(sources, 'dicionario_mestre'), ...tableRows(sources, 'dicionario_manual')];
  const manualWtp = tableRows(sources, 'v_sisha_manual_pn_aplicacao');
  const receiptItems = tableRows(sources, 'recebimento_itens');
  const pnRelations = tableRows(sources, 'sisha_pn_relacoes');
  const receipts = tableRows(sources, 'recebimentos');
  const equipamentos = tableRows(sources, 'equipamentos_serializados').filter((row) => row?.ativo !== false);
  const eventosEquipamento = tableRows(sources, 'equipamento_eventos');
  const masterOs = tableRows(sources, 'os_master_evidencias').filter((row) => row?.invalidado !== true);

  const anyRows = [ppu, ceimspa, pds, wos, spares, foc, repairs, price, rfq, priceRef, receitas, historico, manual, manualWtp, receiptItems, pnRelations, equipamentos, eventosEquipamento, masterOs].some((rows) => rows.length);
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
  if (manualWtp.length) {
    lines.push(`Aplicação em WTP/Manual Técnico: ${manualWtp.length} referência(s) indexada(s). Presença no manual não significa estoque.`);
    manualWtp.slice(0, 8).forEach((row) => {
      lines.push(`- ${row.manual_codigo || 'Manual'}${row.revisao ? ` • Rev ${row.revisao}` : ''}: PN ${row.pn || alvo}${row.nomenclatura ? ` — ${row.nomenclatura}` : ''}${row.fig ? ` • FIG ${row.fig}` : ''}${row.item ? ` • ITEM ${row.item}` : ''}${row.page_ref ? ` • ${row.page_ref}` : ''}.`);
    });
  }
  if (equipamentos.length) {
    lines.push(`Livro de Equipamentos: ${equipamentos.length} equipamento(s) serializado(s) ativo(s) desse PN.`);
    equipamentos.slice(0, 12).forEach((row) => lines.push(`- SN ${row.sn || 'não informado'}${row.nomenclatura ? ` • ${compactText(row.nomenclatura, 70)}` : ''}${row.local_atual || row.anv_atual ? ` • local atual ${row.local_atual || row.anv_atual}` : ''}${row.status_atual ? ` • status ${row.status_atual}` : ''}.`));
  }
  if (eventosEquipamento.length) lines.push(`Livro de Eventos PN+SN: ${eventosEquipamento.length} evento(s) relacionado(s) aos equipamentos encontrados.`);
  if (masterOs.length) {
    const fechadas = masterOs.filter((row) => normalizeUpper(row.status_evidencia || row.status) === 'FECHADA').length;
    const abertas = masterOs.filter((row) => normalizeUpper(row.status_evidencia || row.status) === 'ABERTA').length;
    const canceladas = masterOs.filter((row) => normalizeUpper(row.status_evidencia || row.status) === 'CANCELADA').length;
    lines.push(`Master OS: ${masterOs.length} evidência(s) explícita(s) para o PN — ${fechadas} fechada(s), ${abertas} aberta(s), ${canceladas} cancelada(s).`);
  }
  if (pnRelations.length) {
    const technical = pnRelations.filter((row) => ['CIETP', 'DOCUMENTO'].includes(String(row.origem || '').toUpperCase()));
    const evolution = pnRelations.filter((row) => String(row.origem || '').toUpperCase() === 'RFQ');
    if (technical.length) {
      lines.push(`PN alternativos/equivalentes: ${technical.length} relação(ões) confirmada(s) pelas fontes técnicas/documentais.`);
      technical.slice(0, 8).forEach((row) => lines.push(`- ${row.pn_relacionado} • ${row.tipo_relacao || 'ALTERNATIVO'} • fonte ${row.fonte || row.origem || 'SISHA'}.`));
    }
    if (evolution.length) {
      lines.push('Evolução/fornecimento por RFQ:');
      evolution.slice(0, 8).forEach((row) => {
        lines.push(`- ${row.pn_antigo} → ${row.pn_atual_fornecimento} • ${row.fonte || 'RFQ'}. A validade comercial da cotação não apaga esta relação documental; o PN antigo não é marcado automaticamente como proibido para uso.`);
      });
    }
  }
  lines.push(`Disponibilidade consolidada do PPU: ${sumRows(ppu, ['quantidade'])} unidade(s) encontrada(s).`);
  if (ppu.length) {
    ppu.slice(0, 8).forEach((row) => {
      const sourceLabel = row.origem_saldo === 'RECIBO_PENDENTE'
        ? `Recibo ${row.numero_recibo || 'sem referência'} — saldo temporário`
        : 'PPU oficial';
      lines.push(`- ${sourceLabel}: qtd ${safeNumber(row.quantidade)} em ${row.localizacao || 'local não informado'}${row.sn ? ` • SN ${row.sn}` : ''}.`);
    });
  }
  if (receiptItems.length) {
    const receiptMap = new Map(receipts.map((receipt) => [receipt.id, receipt.numero_recibo]));
    const incorporatedQty = receiptItems
      .reduce((sum, item) => sum + safeNumber(item.quantidade_inventariada || (item.inventariado_ppu ? item.quantidade : 0)), 0);
    const exceptionQty = receiptItems
      .filter((item) => item.condicao_item && item.condicao_item !== 'RECEBIDO_DISPONIVEL')
      .reduce((sum, item) => sum + safeNumber(item.quantidade), 0);
    lines.push(`Histórico em recibos: ${receiptItems.length} linha(s); ${incorporatedQty} unidade(s) já incorporada(s) ao estoque oficial selecionado e ${exceptionQty} unidade(s) em exceção (quarentena, defeito, falta ou divergência).`);
    receiptItems.slice(0, 6).forEach((item) => {
      const receiptNumber = receiptMap.get(item.recebimento_id) || item.numero_recibo || 'não identificado';
      const destination = item.destino_estoque ? normalizeUpper(item.destino_estoque) : null;
      const incorporated = safeNumber(item.quantidade_inventariada || (item.inventariado_ppu ? item.quantidade : 0));
      const total = safeNumber(item.quantidade);
      const countsByReceipt = item.contabiliza_pelo_recibo !== false && incorporated < total;
      const status = incorporated >= total && total > 0 && destination
        ? `já incluído no estoque oficial do ${destination}; o recibo permanece apenas para rastreabilidade`
        : incorporated > 0 && destination
          ? `parcialmente incluído no ${destination}; saldo temporário controlado pelo recibo: ${Math.max(0, total - incorporated)}`
          : countsByReceipt && item.condicao_item === 'RECEBIDO_DISPONIVEL'
            ? `saldo temporário controlado pelo recibo em ${item.localizacao_ppu || 'local não informado'}`
            : `condição ${item.condicao_item || 'não informada'}`;
      lines.push(`- Recibo ${receiptNumber}: qtd ${total}${item.sn ? ` • SN ${item.sn}` : ''} • ${status}.`);
    });
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
  if (priceRef.length) {
    priceRef.slice(0, 8).forEach((row) => {
      const value = safeNumber(row.valor_unitario_gbp);
      lines.push(`Preço de referência SISHA: PN ${row.pn || alvo} — £ ${value.toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} GBP — fonte ${row.fonte_preco || 'não informada'}${row.documento_fonte ? ` (${row.documento_fonte})` : ''}.`);
    });
  }
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
  const masterOs = tableRows(sources, 'v_sisha_os_historico_atual');
  const rowsFound = ordens.length + pds.length + wos.length + suplementosOc.length + suplementosWo.length + adminDocs.length + masterOs.length;

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
  if (masterOs.length) {
    lines.push('', 'OS históricas (Master OS):');
    masterOs.slice(0, 20).forEach((row) => lines.push(`- OS ${row.os_numero_normalizado || row.os_numero}${row.os_ano ? `/${row.os_ano}` : ''}: ${row.status || 'sem status'} • ${row.dominio_descricao || row.fonte_dominio || 'domínio não informado'}${row.movimento_tipo ? ` • movimento ${row.movimento_tipo}` : ''}${row.movimento_estado ? ` (${row.movimento_estado})` : ''}${row.data_abertura ? ` • saída ${formatDate(row.data_abertura)}` : ''}${row.data_fechamento ? ` • entrada ${formatDate(row.data_fechamento)}` : ''}${row.cronologia_consistente === false ? ' • ALERTA: entrada anterior à saída na fonte' : ''}${row.descricao ? ` • ${compactText(row.descricao, 140)}` : ''}.`));
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


function eventSourceLabel(event = {}) {
  const origin = normalizeUpper(event.origem_evento || event.source_type || event.tipo_evento || '');
  if (origin.includes('MASTER')) return 'Master OS';
  if (origin.includes('STC')) return 'STC';
  if (origin.includes('PIM')) return 'PIM/OS';
  if (origin.includes('WO')) return 'WO';
  if (origin.includes('RECIB')) return 'Recibo';
  if (origin.includes('PPU')) return 'PPU';
  return event.origem_evento || event.source_type || event.tipo_evento || 'Livro de Eventos';
}

function buildDossierAnswer(question = '', sources = [], pns = []) {
  const alvo = pns.length ? pns.join(', ') : 'item informado';
  const equipamentos = tableRows(sources, 'equipamentos_serializados').filter((row) => row?.ativo !== false);
  const eventos = tableRows(sources, 'equipamento_eventos');
  const master = tableRows(sources, 'os_master_evidencias').filter((row) => row?.invalidado !== true);
  const ppu = consolidatedPpuRows(sources);
  const receiptItems = tableRows(sources, 'recebimento_itens');
  const receipts = tableRows(sources, 'recebimentos');
  const pims = tableRows(sources, 'pim_demandas');
  const wos = tableRows(sources, 'work_orders');
  const pds = tableRows(sources, 'compras_pds');
  const spares = tableRows(sources, 'leonardo_spares');
  const repairs = tableRows(sources, 'leonardo_repairs');
  const sb = tableRows(sources, 'service_bulletin_items');
  const manual = [...tableRows(sources, 'dicionario_mestre'), ...tableRows(sources, 'dicionario_manual'), ...tableRows(sources, 'v_sisha_manual_pn_aplicacao')];

  const lines = [];
  lines.push(`Cruzei as fontes operacionais disponíveis para ${alvo}.`);

  if (equipamentos.length) {
    lines.push('', `No Livro de Equipamentos encontrei ${equipamentos.length} equipamento(s) serializado(s) ativo(s) desse PN:`);
    equipamentos.slice(0, 20).forEach((row) => {
      const details = [`SN ${row.sn || 'não informado'}`];
      if (row.nomenclatura) details.push(compactText(row.nomenclatura, 70));
      if (row.local_atual || row.anv_atual) details.push(`local atual ${row.local_atual || row.anv_atual}`);
      if (row.status_atual) details.push(`status ${row.status_atual}`);
      lines.push(`- ${details.join(' • ')}`);
    });
  } else {
    lines.push('', 'Não encontrei equipamento serializado ativo desse PN no Livro de Equipamentos. Isso não impede que o PN exista em estoque agregado, documento ou processo sem SN.');
  }

  if (eventos.length) {
    const byOrigin = new Map();
    eventos.forEach((event) => {
      const label = eventSourceLabel(event);
      byOrigin.set(label, (byOrigin.get(label) || 0) + 1);
    });
    lines.push('', `A trilha física possui ${eventos.length} evento(s) relacionado(s) aos equipamentos encontrados (${[...byOrigin.entries()].map(([k, v]) => `${k}: ${v}`).join(' • ')}).`);
    eventos.slice(0, 12).forEach((event) => {
      const date = formatDate(event.data_evento || event.data || event.created_at);
      const sn = event.sn ? ` • SN ${event.sn}` : '';
      const move = [event.local_origem, event.local_destino].filter(Boolean).join(' → ');
      lines.push(`- ${date} • ${eventSourceLabel(event)} • ${event.tipo_evento || 'evento'}${sn}${move ? ` • ${move}` : ''}${event.documento ? ` • ${event.documento}` : ''}.`);
    });
  }

  if (master.length) {
    const statuses = { ABERTA: 0, FECHADA: 0, CANCELADA: 0 };
    master.forEach((row) => { const st = normalizeUpper(row.status_evidencia || row.status); if (statuses[st] !== undefined) statuses[st] += 1; });
    lines.push('', `Master OS da Divisão de Planejamento: ${master.length} evidência(s) ligada(s) explicitamente ao PN (${statuses.FECHADA} fechada(s), ${statuses.ABERTA} aberta(s), ${statuses.CANCELADA} cancelada(s)).`);
    master.slice(0, 12).forEach((row) => {
      const os = row.os_numero_normalizado || row.os_numero || 'sem número';
      const state = row.status_evidencia || row.status || 'sem status';
      const move = row.movimento_tipo ? ` • ${row.movimento_tipo}${row.movimento_estado ? `/${row.movimento_estado}` : ''}` : '';
      lines.push(`- OS ${os}${row.os_ano ? `/${row.os_ano}` : ''} • ${state}${move}${row.destino ? ` • destino ${row.destino}` : ''}${row.descricao ? ` • ${compactText(row.descricao, 110)}` : ''}.`);
    });
    lines.push('OS aberta representa intenção/escrituração e OS cancelada preserva histórico sem movimentar. Movimentação física só é confirmada por OS fechada quando identidade e destino foram inequívocos.');
  }

  const ppuQty = sumRows(ppu, ['quantidade']);
  lines.push('', `PPU: ${ppuQty} unidade(s) na disponibilidade efetiva consultada.`);
  if (receiptItems.length) {
    const totalRecebido = sumRows(receiptItems, ['quantidade']);
    const comSn = receiptItems.filter((item) => item.sn).length;
    lines.push(`Recibos: ${receiptItems.length} linha(s), ${totalRecebido} unidade(s) documentada(s); ${comSn} linha(s) trazem SN explícito.`);
    if (receiptItems.some((item) => !item.sn)) lines.push('Recibo sem SN comprova quantidade/PN, mas não é associado automaticamente a um serial específico.');
  }
  if (receipts.length) lines.push(`Cabeçalhos de recebimento relacionados: ${receipts.length}.`);
  if (pims.length) lines.push(`PIM/OS: ${pims.length} registro(s) relacionado(s).`);
  if (wos.length) lines.push(`WO: ${wos.length} registro(s) relacionado(s).`);
  if (pds.length) lines.push(`PD/OC: ${pds.length} PD(s) relacionado(s).`);
  if (spares.length || repairs.length) lines.push(`Order Book Leonardo: ${spares.length} spare(s) e ${repairs.length} repair/warranty relacionado(s).`);
  if (sb.length) lines.push(`Service Bulletin: ${sb.length} item(ns) relacionado(s).`);
  if (manual.length) lines.push(`Manual/Dicionário técnico: ${manual.length} referência(s) encontrada(s) para identificação/aplicação.`);

  lines.push('', 'Para localização atual eu priorizo o Livro de Equipamentos e o Livro de Eventos. Documentos históricos entram na trilha, mas uma evidência antiga nunca deve regredir uma localização física mais nova.');
  return lines.join('\n');
}

async function runDossierTool(question, sources, modules) {
  if (!isDossierQuestion(question)) return null;
  const explicit = extractExplicitPnCandidates(question);
  const pns = (explicit.length ? explicit : unique(extractCandidateTokens(question).map(normalizePn))).slice(0, 8);
  if (!pns.length) return null;

  modules.consulta_pn = true;
  modules.equipamentos = true;
  modules.recebimentos = true;
  modules.documentos_logisticos = true;
  modules.master_os = true;
  modules.historico_equipamento = true;

  const tasks = [
    safeSelect('equipamentos_serializados', 'id,pn,sn,nomenclatura,status_atual,condicao_atual,local_atual,anv_atual,ativo', (q) => q.in('pn', pns).neq('ativo', false).order('pn').order('sn'), { motivo: 'Livro de Equipamentos por PN exato', limit: 250 }),
    safeEffectivePpuSelect(pns, { motivo: 'Disponibilidade efetiva do PPU por PN', limit: 200 }),
    safeSelect('recebimento_itens', '*', (q) => q.in('pn', pns).neq('ativo', false), { motivo: 'Recibos por PN', limit: 250 }),
    safeSelect('pim_demandas', '*', (q) => q.in('pn', pns), { motivo: 'PIM/OS por PN', limit: 200 }),
    safeSelect('work_orders', '*', (q) => q.in('pn', pns), { motivo: 'WO por PN', limit: 200 }),
    safeSelect('work_orders', '*', (q) => q.in('pn_saida', pns), { motivo: 'WO por PN de saída', limit: 200 }),
    safeSelect('compras_pds', '*', (q) => q.in('pn', pns), { motivo: 'PD/OC por PN', limit: 250 }),
    safeSelect('leonardo_spares', '*', (q) => q.in('pn', pns), { motivo: 'Order Book Spares por PN', limit: 250 }),
    safeSelect('leonardo_repairs', '*', (q) => q.in('pn', pns), { motivo: 'Order Book Repairs/Warranty por PN', limit: 250 }),
    safeSelect('service_bulletin_items', '*', (q) => q.in('pn', pns), { motivo: 'Service Bulletin por PN', limit: 150 }),
    safeSelect('dicionario_mestre', '*', (q) => q.in('pn', pns), { motivo: 'Dicionário Mestre por PN', limit: 120 }),
    safeSelect('dicionario_manual', '*', (q) => q.in('pn', pns), { motivo: 'Dicionário do Manual por PN', limit: 120 }),
    safeSelect('v_sisha_manual_pn_aplicacao', '*', (q) => q.in('pn', pns), { motivo: 'Manual técnico por PN', limit: 160 }),
  ];

  pns.forEach((pn) => {
    tasks.push(safeSelect(
      'os_master_evidencias',
      'id,os_numero,os_numero_normalizado,os_ano,dominio_tipo,dominio_codigo,dominio_descricao,data_abertura,situacao,destino,descricao,data_fechamento,responsavel,tipo_inspecao,pane,status_evidencia,cronologia_consistente,movimento_tipo,movimento_estado,source_file_name,source_sheet,source_row,invalidado,source_payload',
      (q) => q.eq('invalidado', false).contains('source_payload', { movimento: { pns_explicitos: [pn] } }).order('data_abertura', { ascending: false }),
      { motivo: `Master OS por PN explícito ${pn}`, limit: 250 }
    ));
  });

  const settled = await Promise.all(tasks);
  settled.forEach((result) => addSource(sources, result));

  const equipmentIds = unique(tableRows(sources, 'equipamentos_serializados').map((row) => row.id).filter(Boolean));
  const receiptIds = unique(tableRows(sources, 'recebimento_itens').map((row) => row.recebimento_id).filter(Boolean));
  const cross = [];
  if (equipmentIds.length) cross.push(safeSelect('equipamento_eventos', '*', (q) => q.in('equipamento_id', equipmentIds).order('data_evento', { ascending: false }), { motivo: 'Livro de Eventos dos PN+SN encontrados', limit: 500 }));
  if (receiptIds.length) cross.push(safeSelect('recebimentos', '*', (q) => q.in('id', receiptIds), { motivo: 'Cabeçalhos dos Recibos encontrados', limit: 250 }));
  const crossResults = await Promise.all(cross);
  crossResults.forEach((result) => addSource(sources, result));

  return { answer: buildDossierAnswer(question, sources, pns), intent: 'DOSSIER_MULTI_FONTE', tokens: pns };
}

function isEquipmentRegistryQuestion(question = '') {
  const q = normalizeUpper(question);
  return /\b(EQUIPAMENTO|EQUIPAMENTOS|EQUIPAMENTO SERIALIZADO|EQUIPAMENTOS SERIALIZADOS|LIVRO DE EQUIPAMENTOS)\b/.test(q);
}

function buildEquipmentRegistryAnswer({ total = 0, archived = 0, rows = [], tokens = [], isCountQuestion = false } = {}) {
  const active = Math.max(0, Number(total || 0) - Number(archived || 0));
  const activeRows = (rows || []).filter((row) => row?.ativo !== false);
  const matchingRows = tokens.length
    ? activeRows.filter((row) => {
        const haystack = normalizeUpper([row?.pn, row?.sn, row?.nomenclatura].filter(Boolean).join(' '));
        return tokens.some((token) => haystack.includes(normalizeUpper(token)));
      })
    : activeRows;

  if (tokens.length && matchingRows.length === 0) {
    return `Consultei o Livro de Equipamentos do SISHA, que possui ${active} equipamento${active === 1 ? '' : 's'} ativo${active === 1 ? '' : 's'}, mas não encontrei PN, SN ou nomenclatura correspondente a ${tokens.join(', ')}.`;
  }

  const lines = [];
  if (isCountQuestion || !tokens.length) {
    lines.push(`O SISHA possui ${active} equipamento${active === 1 ? '' : 's'} ativo${active === 1 ? '' : 's'} cadastrado${active === 1 ? '' : 's'} no Livro de Equipamentos.`);
    if (archived > 0) lines.push(`Existem também ${archived} equipamento${archived === 1 ? '' : 's'} arquivado${archived === 1 ? '' : 's'}, preservado${archived === 1 ? '' : 's'} no histórico.`);
  } else {
    lines.push(`Encontrei ${matchingRows.length} equipamento${matchingRows.length === 1 ? '' : 's'} correspondente${matchingRows.length === 1 ? '' : 's'} no Livro de Equipamentos.`);
  }

  const listRows = (tokens.length ? matchingRows : activeRows).slice(0, 10);
  if (listRows.length > 0 && (tokens.length || active <= 10)) {
    lines.push('');
    lines.push(active <= 10 && !tokens.length ? 'Equipamentos ativos cadastrados:' : 'Equipamentos encontrados:');
    listRows.forEach((row) => {
      const details = [`PN ${row.pn || 'não informado'}`, `SN ${row.sn || 'não informado'}`];
      if (row.nomenclatura) details.push(compactText(row.nomenclatura, 90));
      if (row.status_atual) details.push(`status ${row.status_atual}`);
      if (row.local_atual || row.anv_atual) details.push(`local ${row.local_atual || row.anv_atual}`);
      lines.push(`- ${details.join(' • ')}`);
    });
  }

  lines.push('');
  lines.push('Fonte: Livro de Equipamentos PN+SN do SISHA. Esta ferramenta é somente leitura.');
  return lines.join('\n');
}

async function runEquipmentRegistryTool(question, sources, modules) {
  if (!isEquipmentRegistryQuestion(question)) return null;

  modules.equipamentos = true;
  const q = normalizeUpper(question);
  const isCountQuestion = /\b(QUANTOS|QUANTAS|TOTAL|QUANTIDADE|NUMERO|NUMERO DE|NÚMERO|NÚMERO DE)\b/.test(q);
  const explicit = extractExplicitPnCandidates(question);
  const tokens = unique([...(explicit || []), ...extractCandidateTokens(question).map(normalizePn)]).slice(0, 12);

  const [totalResult, archivedResult] = await Promise.all([
    safeCount('equipamentos_serializados', null, { motivo: 'Total do Livro de Equipamentos' }),
    safeCount('equipamentos_serializados', (query) => query.eq('ativo', false), { motivo: 'Equipamentos arquivados' }),
  ]);

  if (!totalResult.ok) {
    return {
      answer: 'Não consegui consultar o Livro de Equipamentos neste momento. A leitura do cadastro PN+SN retornou erro e, por segurança, não vou estimar a quantidade.',
      intent: 'CONSULTA_EQUIPAMENTOS',
      tokens,
    };
  }

  const rowResults = [];
  if (tokens.length) {
    rowResults.push(await safeSelect(
      'equipamentos_serializados',
      'id,pn,sn,nomenclatura,status_atual,condicao_atual,local_atual,anv_atual,ativo',
      (query) => query.in('pn', tokens).order('pn', { ascending: true }).order('sn', { ascending: true }),
      { motivo: 'Livro de Equipamentos filtrado por PN exato', limit: 250 }
    ));
    rowResults.push(await safeSelect(
      'equipamentos_serializados',
      'id,pn,sn,nomenclatura,status_atual,condicao_atual,local_atual,anv_atual,ativo',
      (query) => query.in('sn', tokens).order('pn', { ascending: true }).order('sn', { ascending: true }),
      { motivo: 'Livro de Equipamentos filtrado por SN exato', limit: 250 }
    ));
  } else {
    rowResults.push(await safeSelect(
      'equipamentos_serializados',
      'id,pn,sn,nomenclatura,status_atual,condicao_atual,local_atual,anv_atual,ativo',
      (query) => query.order('pn', { ascending: true }).order('sn', { ascending: true }),
      { motivo: 'Amostra do Cadastro PN+SN do Livro de Equipamentos', limit: 50 }
    ));
  }

  rowResults.forEach((result) => addSource(sources, result));
  const rows = tableRows(sources, 'equipamentos_serializados');
  const total = totalResult.count;
  const archived = archivedResult.ok ? archivedResult.count : 0;

  return {
    answer: buildEquipmentRegistryAnswer({ total, archived, rows, tokens, isCountQuestion }),
    intent: 'CONSULTA_EQUIPAMENTOS',
    tokens,
  };
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
      tasks.push(safeSelect('v_sisha_ppu_disponibilidade', '*', (q) => q.ilike('numero_recibo', `%${clean}%`), { motivo: `Saldo PPU vinculado ao recibo ${clean}`, limit: 30 }));
      tasks.push(safeSelect('v_sisha_ceimspa_disponibilidade', '*', (q) => q.ilike('numero_recibo', `%${clean}%`), { motivo: `Saldo CeIMSPA vinculado ao recibo ${clean}`, limit: 30 }));
    });
  } else {
    tasks.push(safeSelect('recebimentos', '*', (q) => q.order('created_at', { ascending: false }), { motivo: 'Últimos recebimentos', limit: 10 }));
  }

  const headers = await Promise.all(tasks);
  headers.forEach((result) => addSource(sources, result));

  const recebimentoIds = unique(tableRows(sources, 'recebimentos').map((row) => row.id).filter(Boolean));
  if (recebimentoIds.length) {
    const [itens, ppuBalances, ceimspaBalances] = await Promise.all([
      safeSelect('recebimento_itens', '*', (q) => q.in('recebimento_id', recebimentoIds), { motivo: 'Itens vinculados ao recebimento', limit: 200 }),
      safeSelect('v_sisha_ppu_disponibilidade', '*', (q) => q.in('recebimento_id', recebimentoIds), { motivo: 'Saldo temporário do recibo no PPU', limit: 200 }),
      safeSelect('v_sisha_ceimspa_disponibilidade', '*', (q) => q.in('recebimento_id', recebimentoIds), { motivo: 'Saldo temporário do recibo no CeIMSPA', limit: 200 }),
    ]);
    addSource(sources, itens);
    addSource(sources, ppuBalances);
    addSource(sources, ceimspaBalances);
  } else if (receiptCandidates.length) {
    receiptCandidates.forEach(async () => {});
  }

  return { answer: buildReceiptAnswer(question, sources, receiptCandidates), intent: 'CONSULTA_RECIBO', tokens: receiptCandidates };
}

async function runDocumentTool(question, sources, modules) {
  const docs = extractDocNumbers(question);
  const q = normalizeUpper(question);
  if (!docs.length && !/\b(OC|ODC|ODA|PD|SEPD|WO|OS|PIM|ER|TQS|SUPLEMENTACAO|SUPLEMENTAÇÃO)\b/.test(q)) return null;

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
    tasks.push(safeSelect('v_sisha_os_historico_atual', '*', (query) => query.in('os_numero_normalizado', cleanDocs.map((doc) => String(doc || '').toUpperCase().replace(/\s+/g, ''))), { motivo: 'Master OS por número/ano canônico', limit: 50 }));
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
  const wantsPn = pns.length > 0 && /\b(TEMOS|EXISTE|ESTOQUE|SALDO|PN|P\/N|ITEM|QUANTIDADE|DISPONIVEL|DISPONÍVEL|COMPRAR|OFERTA|LEONARDO|RECEITA|USADO|USADA|HISTORICO|HISTÓRICO|PIM|OS|COTACAO|COTAÇÃO|PRECO|PREÇO|ALTERNATIVO|ALTERNATIVOS|EQUIVALENTE|EQUIVALENTES|EVOLUCAO|EVOLUÇÃO|SUPERSEDED|SUPERCEDED)\b/.test(q);
  if (!wantsPn) return null;

  modules.consulta_pn = true;
  const tasks = [
    safeSelect('dicionario_mestre', '*', (query) => query.in('pn', pns), { motivo: 'Dicionário mestre por PN', limit: 50 }),
    safeSelect('dicionario_manual', '*', (query) => query.in('pn', pns), { motivo: 'Dicionário manual por PN', limit: 50 }),
    safeSelect('v_sisha_manual_pn_aplicacao', '*', (query) => query.in('pn', pns), { motivo: 'Aplicação WTP/CMM/Manual Técnico por PN', limit: 100 }),
    safeEffectivePpuSelect(pns, { motivo: 'Disponibilidade efetiva do PPU com custódia externa reconciliada', limit: 100 }),
    safeSelect('v_sisha_ceimspa_disponibilidade', '*', (query) => query.in('pn', pns), { motivo: 'Disponibilidade consolidada do CeIMSPA por PN', limit: 100 }),
    safeSelect('recebimento_itens', '*', (query) => query.in('pn', pns).neq('ativo', false), { motivo: 'Histórico de recibos por PN', limit: 100 }),
    safeSelect('compras_pds', '*', (query) => query.in('pn', pns), { motivo: 'PD/OC por PN', limit: 100 }),
    safeSelect('work_orders', '*', (query) => query.in('pn', pns), { motivo: 'WO por PN', limit: 80 }),
    safeSelect('leonardo_spares', '*', (query) => query.in('pn', pns), { motivo: 'Order Book Spares por PN', limit: 100 }),
    safeSelect('leonardo_foc_spares', '*', (query) => query.in('pn', pns), { motivo: 'FOC Spares por PN', limit: 100 }),
    safeSelect('leonardo_repairs', '*', (query) => query.in('pn', pns), { motivo: 'Repair/Warranty por PN', limit: 100 }),
    safeSelect('v_sisha_preco_referencia', '*', (query) => query.in('pn', pns), { motivo: 'Preço de referência consolidado por PN', limit: 50 }),
    safeSelect('price_list', '*', (query) => query.in('pn', pns), { motivo: 'Price List por PN', limit: 50 }),
    safeSelect('rfq_cotacoes', '*', (query) => query.in('pn', pns), { motivo: 'RFQ/cotações por PN', limit: 50 }),
    safeSelect('receita_itens', '*', (query) => query.in('pn', pns), { motivo: 'Receitas por PN', limit: 100 }),
    safeSelect('receita_itens', '*', (query) => query.in('pn_alt', pns), { motivo: 'Receitas por PN alternativo', limit: 100 }),
    safeSelect('historico_movimentacao', '*', (query) => query.in('pn', pns), { motivo: 'Histórico de movimentação por PN', limit: 100 }),
    safeSelect('pim_demandas', '*', (query) => query.in('pn', pns), { motivo: 'PIM/OS por PN', limit: 80 }),
    safeSelect('service_bulletin_items', '*', (query) => query.in('pn', pns), { motivo: 'SB por PN', limit: 80 }),
    safeSelect('equipamentos_serializados', 'id,pn,sn,nomenclatura,status_atual,condicao_atual,local_atual,anv_atual,ativo', (query) => query.in('pn', pns).neq('ativo', false).order('pn').order('sn'), { motivo: 'Livro de Equipamentos por PN', limit: 250 }),
  ];

  pns.forEach((pn) => {
    tasks.push(safeSelect('os_master_evidencias', 'id,os_numero,os_numero_normalizado,os_ano,data_abertura,destino,descricao,data_fechamento,status_evidencia,movimento_tipo,movimento_estado,invalidado,source_payload', (query) => query.eq('invalidado', false).contains('source_payload', { movimento: { pns_explicitos: [pn] } }).order('data_abertura', { ascending: false }), { motivo: `Master OS por PN explícito ${pn}`, limit: 120 }));
  });

  // PI/CeIMSPA: se o dicionário tiver PI, consulta por PI também.
  const settled = await Promise.all(tasks);
  settled.forEach((result) => addSource(sources, result));
  const relationGroups = await Promise.all(pns.map((pn) => resolvePnRelations(pn).catch(() => null)));
  const relationRows = relationGroups.filter(Boolean).flatMap((group) => group.todos || []);
  if (relationRows.length) sources.push({ tabela: 'sisha_pn_relacoes', motivo: 'Relações consolidadas de PN (CIETP + documento + evolução RFQ)', linhas: relationRows });
  const receiptIds = unique(tableRows(sources, 'recebimento_itens').map((row) => row.recebimento_id).filter(Boolean));
  if (receiptIds.length) {
    const receiptHeaders = await safeSelect('recebimentos', '*', (query) => query.in('id', receiptIds), { motivo: 'Cabeçalhos dos recibos encontrados por PN', limit: 100 });
    addSource(sources, receiptHeaders);
  }
  const equipmentIds = unique(tableRows(sources, 'equipamentos_serializados').map((row) => row.id).filter(Boolean));
  if (equipmentIds.length) {
    const events = await safeSelect('equipamento_eventos', '*', (query) => query.in('equipamento_id', equipmentIds).order('data_evento', { ascending: false }), { motivo: 'Livro de Eventos dos equipamentos encontrados por PN', limit: 400 });
    addSource(sources, events);
  }

  const pis = unique([...tableRows(sources, 'dicionario_mestre'), ...tableRows(sources, 'dicionario_manual')].map((row) => row.pi || row.nsn_pi).filter(Boolean));
  if (pis.length) {
    const ceimspa = await safeSelect('v_sisha_ceimspa_disponibilidade', '*', (query) => query.in('pi', pis), { motivo: 'Disponibilidade consolidada do CeIMSPA por PI extraído do manual', limit: 100 });
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
    equipamentos: false,
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
  if (isDossierQuestion(question)) {
    result = await runDossierTool(question, sources, modules);
  }
  if (!result && isEquipmentRegistryQuestion(question)) {
    result = await runEquipmentRegistryTool(question, sources, modules);
  }
  if (!result && /\b(RECIBO|RECEBIMENTO|ENTRARAM|ENTRADA|ENTREGUE|ENTREGA)\b/.test(q)) {
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
