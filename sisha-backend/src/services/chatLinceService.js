const supabase = require('../config/supabaseClient');

const CHAT_LINCE_NAME = 'Chat Lince';
const DEFAULT_MODEL = process.env.OPENROUTER_MODEL || process.env.CHAT_LINCE_MODEL || 'openrouter/auto';
const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';

const ANV_CODES = ['4001', '4003', '4004', '4005', '4010', '4012'];
const OFFICE_CODES = ['HV', 'MV', 'SV', 'VN', 'PA', 'MT'];

const CHAT_LINCE_STOP_TERMS = new Set([
  'OLA', 'OLÁ', 'BOM', 'BOA', 'DIA', 'TARDE', 'NOITE', 'TUDO', 'BEM', 'OI', 'SALVE',
  'POR', 'FAVOR', 'PRECISO', 'QUERO', 'SABER', 'CONSULTAR', 'CONSULTA', 'ITEM', 'ITENS',
  'ALGUMA', 'ALGUM', 'COISA', 'PROCESSO', 'COMPRA', 'COMPRAS', 'TENHO', 'TEMOS', 'EXISTE',
  'QUAL', 'QUAIS', 'ONDE', 'COMO', 'PARA', 'SOBRE', 'CHAMADO', 'CHAMADA', 'DÚVIDA', 'DUVIDA',
  'SISHA', 'CHAT', 'LINCE', 'BANCO', 'DADOS', 'SISTEMA'
]);

function stripAccents(value = '') {
  return String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

function normalizeSearchText(value = '') {
  return stripAccents(value).toUpperCase();
}

const DOCUMENT_DESTINATIONS = {
  ORDER_BOOK: [
    { tabela: 'compras_ordens', finalidade: 'Cabeçalho de OC/ODC/ODA e status da ordem.' },
    { tabela: 'compras_pds', finalidade: 'Linhas de PD/SEPD, PN, quantidade, valores e status.' },
    { tabela: 'work_orders', finalidade: 'WOs de Repair/Warranty quando o Order Book trouxer reparo.' },
    { tabela: 'chat_lince_documentos', finalidade: 'Staging documental seguro antes de gravação operacional.' },
  ],
  PRICE_LIST_RFQ: [
    { tabela: 'price_list', finalidade: 'Preço-base em GBP/USD, PN, NSN e nomenclatura.' },
    { tabela: 'rfq_cotacoes', finalidade: 'Cotações, validade e referência de fornecedor.' },
    { tabela: 'chat_lince_documentos', finalidade: 'Staging documental seguro.' },
  ],
  SERVICE_BULLETIN: [
    { tabela: 'service_bulletins', finalidade: 'Cabeçalho, tipo de SB, aplicabilidade, status e observações.' },
    { tabela: 'service_bulletin_items', finalidade: 'PNs, quantidades e itens aplicáveis ao SB.' },
    { tabela: 'chat_lince_documentos', finalidade: 'Staging documental seguro.' },
  ],
  POLITICA_ESTOQUE_TAREFAS: [
    { tabela: 'politica_estoque_tarefas', finalidade: 'Tarefa, tipo, prioridade e quantidade planejada em 2 anos.' },
    { tabela: 'receita_itens', finalidade: 'Receitas vinculadas às tarefas para Gerador/Custo.' },
    { tabela: 'chat_lince_documentos', finalidade: 'Staging documental seguro.' },
  ],
  CUSTO_OPERACIONAL: [
    { tabela: 'receita_itens', finalidade: 'Itens da receita usados no custo de 1 execução.' },
    { tabela: 'politica_estoque_tarefas', finalidade: 'Fator de projeção logística para custo planejado.' },
    { tabela: 'price_list', finalidade: 'Referência primária de valor em GBP.' },
    { tabela: 'rfq_cotacoes', finalidade: 'Referência secundária de valor quando não houver Price List.' },
    { tabela: 'recebimento_itens', finalidade: 'Referência histórica de recebimento/preço quando disponível.' },
    { tabela: 'chat_lince_documentos', finalidade: 'Staging documental seguro.' },
  ],
  GERADOR_NECESSIDADES: [
    { tabela: 'receita_itens', finalidade: 'Receitas que geram a necessidade-base.' },
    { tabela: 'politica_estoque_tarefas', finalidade: 'Prioridade e quantidade planejada.' },
    { tabela: 'pim_demandas', finalidade: 'Demandas PIM/OS por aeronave ou oficina.' },
    { tabela: 'service_bulletin_items', finalidade: 'Demandas oriundas de SB.' },
    { tabela: 'compras_pds', finalidade: 'PDs/OC em andamento para abater necessidade.' },
    { tabela: 'chat_lince_documentos', finalidade: 'Staging documental seguro.' },
  ],
  OS_INSTALACAO_REMOCAO: [
    { tabela: 'chat_lince_os_eventos_staging', finalidade: 'Staging de eventos OS/SN até o modelo oficial ser fornecido.' },
    { tabela: 'equipamentos_serializados', finalidade: 'Cadastro técnico do PN/SN rastreável.' },
    { tabela: 'equipamento_eventos', finalidade: 'Histórico de instalação, remoção, cessão, pane, RECEX e retorno.' },
    { tabela: 'pim_demandas', finalidade: 'Vínculo de PIM/OS que gerou a demanda.' },
  ],
  PIM: [
    { tabela: 'pim_demandas', finalidade: 'Demanda operacional por PIM, PN, quantidade e OS vinculada.' },
    { tabela: 'gerador_necessidades', finalidade: 'Uso consultivo: compõe o cálculo de necessidade.' },
    { tabela: 'chat_lince_documentos', finalidade: 'Staging documental seguro.' },
  ],
  ESTOQUE_PPU: [
    { tabela: 'estoque_ppu', finalidade: 'Estoque real no PPU, locais e quantidades.' },
    { tabela: 'equipamentos_serializados', finalidade: 'Itens rastreáveis por SN quando aplicável.' },
    { tabela: 'chat_lince_documentos', finalidade: 'Staging documental seguro.' },
  ],
  ESTOQUE_CEIMSPA: [
    { tabela: 'estoque_ceimspa', finalidade: 'Possibilidade no CeIMSPA; exige confirmação externa.' },
    { tabela: 'chat_lince_documentos', finalidade: 'Staging documental seguro.' },
  ],
  LISDE: [
    { tabela: 'lisde', finalidade: 'Redutor de lead time após pagamento; não é estoque.' },
    { tabela: 'chat_lince_documentos', finalidade: 'Staging documental seguro.' },
  ],
  DOCUMENTO_OPERACIONAL: [
    { tabela: 'chat_lince_documentos', finalidade: 'Staging documental seguro para análise e confirmação.' },
    { tabela: 'cadastros_manuais', finalidade: 'Registro manual/auditável após confirmação do Admin.' },
  ],
};

function normalizeUpper(value = '') {
  return String(value || '').trim().toUpperCase();
}

function normalizePn(value = '') {
  return normalizeUpper(value).replace(/[^A-Z0-9]/g, '');
}

function compactText(value = '', max = 12000) {
  return String(value || '')
    .replace(/\r/g, '')
    .replace(/[\t ]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, max);
}

function safeNumber(value) {
  const num = Number(value);
  return Number.isFinite(num) ? num : 0;
}

function unique(values = []) {
  return Array.from(new Set(values.filter(Boolean)));
}

function extractSearchTerms(text = '') {
  const normalized = normalizeSearchText(text);
  const raw = normalized.match(/\b[A-Z0-9][A-Z0-9\-\/]{2,}\b/g) || [];
  const terms = [];
  raw.forEach((term) => {
    const clean = term.replace(/[.,;:]+$/g, '');
    if (!clean || CHAT_LINCE_STOP_TERMS.has(clean)) return;
    if (clean.length < 3 || clean.length > 45) return;
    if (/^\d{1,3}$/.test(clean)) return;
    terms.push(clean);
  });
  return unique(terms).slice(0, 10);
}

function isGreetingOnly(text = '') {
  const normalized = normalizeSearchText(text).replace(/[^A-Z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!normalized) return true;
  const words = normalized.split(' ').filter(Boolean);
  const greetingWords = new Set(['OLA', 'OI', 'BOM', 'BOA', 'DIA', 'TARDE', 'NOITE', 'SALVE', 'OBRIGADO', 'OBRIGADA']);
  const hasGreeting = words.some((word) => greetingWords.has(word));
  const hasOperationalSignal = /(PN|SN|S\/N|OC|ODC|ODA|PD|SEPD|WO|OS|PIM|SB|CUSTO|GERADOR|POLITICA|POLÍTICA|ESTOQUE|PRICE|RFQ|CARTRIDGE|ACTUATOR|SERIAL|MANUAL|APLIC|INSTAL|USADO|USADA)/i.test(text);
  return hasGreeting && words.length <= 5 && !hasOperationalSignal;
}

function wantsHelpdeskRegistration(text = '') {
  const q = normalizeSearchText(text);
  return /\b(ANOTA|ANOTAR|REGISTRA|REGISTRAR|ABRE|ABRIR|CHAMADO|HELP\s*DESK|PPU|DUVIDA|DÚVIDA)\b/.test(q);
}

function buildFriendlyGreeting() {
  return [
    'Olá! Eu sou o Chat Lince.',
    '',
    'Posso consultar PN, SN, OC, PD, WO, Política de Estoque, Custo Operacional, Gerador de Necessidades e também procurar no manual onde um item é aplicado, usado ou instalado.',
    '',
    'Pode me mandar um PN, SN, número de documento ou descrever o item pelo nome. Exemplo: “tem cartridge em algum processo de compra?”',
  ].join('\n');
}

function extractCandidateTokens(text = '') {
  const upper = normalizeUpper(text);
  const ignored = new Set([
    'SISHA', 'CHAT', 'LINCE', 'COMO', 'QUAL', 'QUAIS', 'PORQUE', 'PARA', 'ITEM', 'ITENS',
    'ESTOQUE', 'CONSULTA', 'PRECISO', 'SABER', 'SOBRE', 'AERONAVE', 'MATERIAL', 'ORDER',
    'BOOK', 'SERVICE', 'BULLETIN', 'DOCUMENTO', 'DOCUMENTOS', 'STATUS', 'VALOR', 'TOTAL',
    'LOCAL', 'LOCALIZACAO', 'LOCALIZAÇÃO', 'QUANTIDADE', 'NOMENCLATURA', 'LEONARDO', 'MARINHA', 'BRASIL',
    'POLITICA', 'POLÍTICA', 'CUSTO', 'OPERACIONAL', 'GERADOR', 'NECESSIDADE', 'NECESSIDADES',
  ]);

  const raw = upper.match(/\b[A-Z0-9][A-Z0-9.\-\/]{3,}\b/g) || [];
  const tokens = [];
  raw.forEach((token) => {
    const clean = token.replace(/[.,;:]+$/g, '');
    const comparable = normalizePn(clean);
    if (!clean || ignored.has(clean) || ignored.has(comparable)) return;
    if (comparable.length < 4 || comparable.length > 45) return;
    if (!/[0-9]/.test(comparable)) return;
    if (/^\d{1,3}$/.test(comparable)) return;
    tokens.push(clean);
  });

  return unique(tokens).slice(0, 18);
}

function extractSerialCandidates(text = '') {
  const upper = normalizeUpper(text);
  const serials = [];
  const patterns = [
    /\bS\/?N\s*[:#\-]?\s*([A-Z0-9][A-Z0-9.\-\/]{3,40})\b/g,
    /\bSN\s*[:#\-]?\s*([A-Z0-9][A-Z0-9.\-\/]{3,40})\b/g,
    /\bSERIAL(?:\s+NUMBER)?\s*[:#\-]?\s*([A-Z0-9][A-Z0-9.\-\/]{3,40})\b/g,
    /\bN[ºO]?\s+DE\s+S[ÉE]RIE\s*[:#\-]?\s*([A-Z0-9][A-Z0-9.\-\/]{3,40})\b/g,
  ];
  patterns.forEach((regex) => {
    let match;
    while ((match = regex.exec(upper))) {
      const value = normalizeUpper(match[1]).replace(/[.,;:]+$/g, '');
      if (value && value.length >= 4) serials.push(value);
    }
  });

  if (/\b(SN|S\/N|SERIAL|S[ÉE]RIE)\b/.test(upper)) {
    extractCandidateTokens(upper).forEach((token) => serials.push(normalizeUpper(token)));
  }

  return unique(serials).slice(0, 12);
}

function extractOsCandidates(text = '') {
  const upper = normalizeUpper(text);
  const candidates = [];
  const explicit = upper.match(/\bOS\s*[:#\-]?\s*([A-Z0-9][A-Z0-9.\-\/]{2,40})\b/g) || [];
  explicit.forEach((item) => {
    const value = item.replace(/^OS\s*[:#\-]?\s*/i, '').replace(/[.,;:]+$/g, '');
    if (value) candidates.push(value);
  });

  const knownPrefix = new RegExp(`\\b(?:${[...ANV_CODES, ...OFFICE_CODES].join('|')})[A-Z0-9.\\-\/]{2,40}\\b`, 'g');
  (upper.match(knownPrefix) || []).forEach((item) => candidates.push(item.replace(/[.,;:]+$/g, '')));
  return unique(candidates).slice(0, 15);
}

function extractDocumentIdentifiers(text = '') {
  const upper = normalizeUpper(text);
  const docs = [];
  const regexes = [
    /\b(?:OC|ODC|ODA|PD|SEPD|WO|SB|PIM)\s*[:#\-\/ ]?\s*[A-Z0-9][A-Z0-9.\-\/]{2,40}\b/g,
    /\bLX\d{3}[A-Z0-9.\-\/]*\b/g,
  ];

  regexes.forEach((regex) => {
    (upper.match(regex) || []).forEach((item) => docs.push(item.replace(/[.,;:]+$/g, '').replace(/\s+/g, '')));
  });
  extractOsCandidates(text).forEach((os) => docs.push(`OS${os}`));
  return unique(docs).slice(0, 18);
}

function extractNsns(text = '') {
  return unique(String(text).match(/\b\d{4}-\d{2}-\d{3}-\d{4}\b/g) || []).slice(0, 10);
}

function detectEntities(text = '') {
  const tokens = extractCandidateTokens(text);
  const serials = extractSerialCandidates(text);
  const os = extractOsCandidates(text);
  const identifiers = extractDocumentIdentifiers(text);
  const nsns = extractNsns(text);

  return {
    tokens,
    identificadores_documentais: identifiers,
    os_candidatas: os,
    nsn: nsns,
    pn_candidatos: tokens,
    sn_candidatos: serials,
  };
}

function inferDocumentClass(tipoDocumento = '', text = '', fileName = '') {
  const base = normalizeUpper(`${tipoDocumento} ${fileName} ${text.slice(0, 3000)}`);
  if (/CUSTO OPERACIONAL|CUSTO DE EXECUCAO|CUSTO DE EXECUÇÃO|VALOR PLANEJADO|VALOR EXECUCAO|VALOR EXECUÇÃO/.test(base)) return 'CUSTO_OPERACIONAL';
  if (/GERADOR DE NECESSIDADES|NECESSIDADE TOTAL|SALDO APOS ETAPA|SALDO APÓS ETAPA|COBERTURA PPU|COBERTURA CEIMSPA/.test(base)) return 'GERADOR_NECESSIDADES';
  if (/ORDEM DE SERVI[CÇ]O|\bOS\b|INSTALA[CÇ][AÃ]O|REMO[CÇ][AÃ]O|REMOVAL|INSTALLATION/.test(base)) return 'OS_INSTALACAO_REMOCAO';
  if (/SERVICE BULLETIN|\bSB\b|LX\d{3}-\d{2}-\d{4}|MANDATORY|OPTIONAL|ALERT/.test(base)) return 'SERVICE_BULLETIN';
  if (/ORDER BOOK|SPARES|REPAIRS|WARRANTY|LEONARDO/.test(base)) return 'ORDER_BOOK';
  if (/PRICE LIST|UNIT PRICE|VALIDITY|QUOTATION|RFQ|COTA[CÇ][AÃ]O/.test(base)) return 'PRICE_LIST_RFQ';
  if (/CEIMSPA/.test(base)) return 'ESTOQUE_CEIMSPA';
  if (/\bPPU\b|INVENT[ÁA]RIO|ARMAZ[ÉE]M|LOCALIZA[CÇ][AÃ]O/.test(base)) return 'ESTOQUE_PPU';
  if (/LISDE/.test(base)) return 'LISDE';
  if (/\bPIM\b|PEDIDO INTERNO|PEDIDO DE MATERIAL/.test(base)) return 'PIM';
  if (/POLITICA DE ESTOQUE|POLÍTICA DE ESTOQUE|TAREFA|TASK|QTDE_?2_?ANOS|PRIORIDADE/.test(base)) return 'POLITICA_ESTOQUE_TAREFAS';
  if (/RECIBO|RECEBIMENTO|GARANTIA/.test(base)) return 'RECIBO_MATERIAL';
  if (/QNNA/.test(base)) return 'QNNA';
  return tipoDocumento ? normalizeUpper(tipoDocumento) : 'DOCUMENTO_OPERACIONAL';
}

function destinationOptionsFor(classificacao = '') {
  return DOCUMENT_DESTINATIONS[classificacao] || DOCUMENT_DESTINATIONS.DOCUMENTO_OPERACIONAL;
}

function suggestedDestinationFor(classificacao = '') {
  const options = destinationOptionsFor(classificacao);
  return options[0]?.tabela || 'chat_lince_documentos';
}

function extractOsEventSuggestions(text = '') {
  const lines = compactText(text, 30000).split('\n').map((line) => line.trim()).filter(Boolean);
  const events = [];

  lines.forEach((line) => {
    const upper = normalizeUpper(line);
    const hasOs = /\bOS\b|ORDEM DE SERVI[CÇ]O|INSTALA[CÇ][AÃ]O|REMO[CÇ][AÃ]O|REMOVAL|INSTALLATION/.test(upper);
    const hasTrace = /\b(SN|S\/N|SERIAL|S[ÉE]RIE|PN|PIM|AERONAVE|ANV|4001|4003|4004|4005|4010|4012)\b/.test(upper);
    if (!hasOs || !hasTrace) return;

    const serials = extractSerialCandidates(line);
    const tokens = extractCandidateTokens(line).map(normalizePn);
    const osList = extractOsCandidates(line);
    const pim = (upper.match(/\bPIM\s*[:#\-]?\s*([A-Z0-9.\-\/]{2,40})\b/) || [])[1] || null;
    const aeronave = ANV_CODES.find((code) => upper.includes(code)) || null;
    let tipoEvento = 'INDEFINIDO';
    if (/INSTALA[CÇ][AÃ]O|INSTALADO|INSTALLATION|INSTALLED/.test(upper)) tipoEvento = 'INSTALACAO';
    if (/REMO[CÇ][AÃ]O|REMOVIDO|RETIRADO|REMOVAL|REMOVED|DEVOLU[CÇ][AÃ]O/.test(upper)) tipoEvento = 'REMOCAO';

    events.push({
      os_numero: osList[0] || null,
      tipo_evento: tipoEvento,
      pim,
      pn: tokens[0] || null,
      sn: serials[0] || null,
      aeronave,
      local_origem: null,
      local_destino: null,
      trecho: line.slice(0, 500),
      status_staging: 'AGUARDANDO_MODELO_OFICIAL_OS',
    });
  });

  return events.slice(0, 25);
}

function buildConsultiveActions(classificacao, entities) {
  const actions = [
    'Validar o documento com Admin antes de qualquer gravação operacional.',
    'Conferir PN/SN/OS/PD/OC/WO extraídos contra o documento original.',
  ];

  if (classificacao === 'POLITICA_ESTOQUE_TAREFAS') {
    actions.push('Vincular a política às receitas do Gerador de Necessidades e ao cálculo de Custo Operacional.');
  }
  if (classificacao === 'CUSTO_OPERACIONAL') {
    actions.push('Conferir se todos os PN possuem referência de preço em GBP no Price List/RFQ/recebimentos.');
  }
  if (classificacao === 'GERADOR_NECESSIDADES') {
    actions.push('Recalcular necessidade considerando PPU, CeIMSPA como possibilidade, LISDE como lead time e compras ativas não canceladas.');
  }
  if (classificacao === 'OS_INSTALACAO_REMOCAO' || entities?.sn_candidatos?.length) {
    actions.push('Usar a trilha de SN para responder “onde está o item?”, priorizando último evento validado de instalação/remoção.');
    actions.push('A gravação definitiva de OS/SN deve aguardar o modelo oficial de relatório de instalação/remoção.');
  }

  return actions;
}

function buildHeuristicDocumentAnalysis({ tipoDocumento, text, fileName }) {
  const clean = compactText(text, 10000);
  const entities = detectEntities(clean);
  const classificacao = inferDocumentClass(tipoDocumento, clean, fileName);
  const linhas = clean.split('\n').map((line) => line.trim()).filter(Boolean);
  const resumoBase = linhas.slice(0, 8).join(' ');
  const destinosPossiveis = destinationOptionsFor(classificacao);
  const destinoSugerido = suggestedDestinationFor(classificacao);
  const osEventos = classificacao === 'OS_INSTALACAO_REMOCAO' ? extractOsEventSuggestions(clean) : [];
  const registros = [];

  entities.pn_candidatos.slice(0, 25).forEach((pn) => {
    registros.push({
      tipo_registro: classificacao,
      identificador: normalizePn(pn),
      tabela_sugerida: destinoSugerido,
      tabelas_possiveis: destinosPossiveis.map((item) => item.tabela),
      acao_sugerida: 'VALIDAR_COM_ADMIN',
      observacao: 'PN/identificador encontrado por leitura documental automática.',
    });
  });

  entities.sn_candidatos.slice(0, 12).forEach((sn) => {
    registros.push({
      tipo_registro: 'SN_RASTREAVEL',
      identificador: sn,
      tabela_sugerida: classificacao === 'OS_INSTALACAO_REMOCAO' ? 'chat_lince_os_eventos_staging' : 'equipamentos_serializados',
      tabelas_possiveis: ['equipamentos_serializados', 'equipamento_eventos', 'work_orders', 'chat_lince_os_eventos_staging'],
      acao_sugerida: 'VALIDAR_TRILHA_SN',
      observacao: 'SN detectado; deve ser validado para rastreabilidade de equipamento.',
    });
  });

  entities.identificadores_documentais.slice(0, 15).forEach((doc) => {
    registros.push({
      tipo_registro: classificacao,
      identificador: doc,
      tabela_sugerida: destinoSugerido,
      tabelas_possiveis: destinosPossiveis.map((item) => item.tabela),
      acao_sugerida: 'VALIDAR_COM_ADMIN',
      observacao: 'Documento/ordem detectado no arquivo.',
    });
  });

  osEventos.forEach((event) => {
    registros.push({
      tipo_registro: `OS_${event.tipo_evento}`,
      identificador: event.os_numero || event.sn || event.pn || 'OS_SEM_IDENTIFICADOR',
      tabela_sugerida: 'chat_lince_os_eventos_staging',
      tabelas_possiveis: ['chat_lince_os_eventos_staging', 'equipamento_eventos', 'pim_demandas'],
      acao_sugerida: 'ESTAGIAR_AGUARDANDO_MODELO_OFICIAL',
      observacao: 'Evento de OS/SN sugerido. Não gravar definitivo até receber o modelo oficial de relatório.',
    });
  });

  return {
    origem: process.env.OPENROUTER_API_KEY ? 'HEURISTICA_FALLBACK' : 'HEURISTICA_OFFLINE',
    classificacao,
    destino_sugerido: destinoSugerido,
    destinos_possiveis: destinosPossiveis,
    confianca: registros.length > 0 ? 0.68 : 0.38,
    resumo: resumoBase || 'Documento lido, mas sem texto suficiente para resumo automático.',
    entidades: entities,
    registros_sugeridos: registros.slice(0, 45),
    os_eventos_sugeridos: osEventos,
    sn_trilha_sugerida: entities.sn_candidatos.map((sn) => ({
      sn,
      trilha_recomendada: ['equipamentos_serializados', 'equipamento_eventos', 'work_orders', 'estoque_ppu', 'chat_lince_os_eventos_staging'],
      pergunta_que_o_chat_deve_responder: `Onde está o item de SN ${sn}?`,
    })),
    acoes_consultivas: buildConsultiveActions(classificacao, entities),
    riscos: [
      'Validação humana obrigatória antes de qualquer uso operacional.',
      'A leitura automática pode confundir PN, SN, NSN, PD, OC, OS ou WO em documentos com OCR ruim.',
      'Eventos de OS de instalação/remoção ficam apenas em staging até o modelo oficial ser fornecido.',
    ],
    proximos_passos: [
      'Admin deve conferir classificação, identificadores, destino sugerido e registros extraídos.',
      'Admin deve escolher/confirmar a tabela de destino antes da gravação.',
      'Para OS de instalação/remoção, confirmar somente o staging e aguardar o modelo oficial para gravação definitiva.',
    ],
  };
}

function tryParseJson(text = '') {
  try {
    return JSON.parse(text);
  } catch (_) {
    const match = String(text).match(/\{[\s\S]*\}/);
    if (!match) return null;
    try {
      return JSON.parse(match[0]);
    } catch (_) {
      return null;
    }
  }
}

async function callOpenRouter(messages, { temperature = 0.2, responseFormat = null } = {}) {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) return { ok: false, reason: 'OPENROUTER_API_KEY não configurada.' };
  if (typeof fetch !== 'function') return { ok: false, reason: 'fetch global indisponível nesta versão do Node.js.' };

  try {
    const response = await fetch(OPENROUTER_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': process.env.CHAT_LINCE_SITE_URL || 'http://localhost:5173',
        'X-Title': CHAT_LINCE_NAME,
      },
      body: JSON.stringify({
        model: DEFAULT_MODEL,
        messages,
        temperature,
        ...(responseFormat ? { response_format: responseFormat } : {}),
      }),
    });

    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      return {
        ok: false,
        reason: payload?.error?.message || `OpenRouter retornou HTTP ${response.status}.`,
      };
    }

    const content = payload?.choices?.[0]?.message?.content || '';
    return { ok: true, content, model: payload?.model || DEFAULT_MODEL };
  } catch (error) {
    return { ok: false, reason: error.message || 'Falha ao consultar OpenRouter.' };
  }
}

async function analyzeDocumentWithAi({ tipoDocumento, text, fileName }) {
  const heuristic = buildHeuristicDocumentAnalysis({ tipoDocumento, text, fileName });
  const excerpt = compactText(text, 14000);

  const ai = await callOpenRouter([
    {
      role: 'system',
      content: `Você é o ${CHAT_LINCE_NAME}, agente documental e consultivo do SISHA-1. Extraia dados logísticos de documentos aeronáuticos sem inventar. Responda somente JSON válido.`,
    },
    {
      role: 'user',
      content: `Analise o documento abaixo para pré-validação por Admin.\n\nTipo informado: ${tipoDocumento || 'não informado'}\nArquivo: ${fileName || 'sem nome'}\n\nRegras:\n- Não grave nada sozinho.\n- Identifique PN, SN, NSN, SB, PIM, OS, OC/ODC/ODA, PD/SEPD, WO, quantidades, datas, valores, aeronave e riscos.\n- Classifique também Política de Estoque, Custo Operacional, Gerador de Necessidades e OS de instalação/remoção.\n- Sugira a tabela de destino, mas deixe claro que o Admin confirma.\n- Para OS de instalação/remoção, use staging e não gravação definitiva até o modelo oficial ser fornecido.\n- Use confiança de 0 a 1.\n\nJSON esperado:\n{\n  "classificacao": "...",\n  "destino_sugerido": "...",\n  "destinos_possiveis": [{"tabela":"...","finalidade":"..."}],\n  "confianca": 0.0,\n  "resumo": "...",\n  "entidades": {},\n  "registros_sugeridos": [],\n  "os_eventos_sugeridos": [],\n  "sn_trilha_sugerida": [],\n  "acoes_consultivas": [],\n  "riscos": [],\n  "proximos_passos": []\n}\n\nTEXTO:\n${excerpt}`,
    },
  ], { temperature: 0.1, responseFormat: { type: 'json_object' } });

  if (!ai.ok) {
    return { ...heuristic, aviso_ia: ai.reason };
  }

  const parsed = tryParseJson(ai.content);
  if (!parsed) {
    return { ...heuristic, aviso_ia: 'OpenRouter respondeu fora de JSON; usado fallback heurístico.' };
  }

  const classificacao = parsed.classificacao || heuristic.classificacao;
  const destinos = Array.isArray(parsed.destinos_possiveis) && parsed.destinos_possiveis.length
    ? parsed.destinos_possiveis
    : destinationOptionsFor(classificacao);

  return {
    origem: 'OPENROUTER',
    modelo: ai.model,
    classificacao,
    destino_sugerido: parsed.destino_sugerido || suggestedDestinationFor(classificacao),
    destinos_possiveis: destinos,
    confianca: Number(parsed.confianca ?? heuristic.confianca) || heuristic.confianca,
    resumo: parsed.resumo || heuristic.resumo,
    entidades: parsed.entidades || heuristic.entidades,
    registros_sugeridos: Array.isArray(parsed.registros_sugeridos) ? parsed.registros_sugeridos : heuristic.registros_sugeridos,
    os_eventos_sugeridos: Array.isArray(parsed.os_eventos_sugeridos) ? parsed.os_eventos_sugeridos : heuristic.os_eventos_sugeridos,
    sn_trilha_sugerida: Array.isArray(parsed.sn_trilha_sugerida) ? parsed.sn_trilha_sugerida : heuristic.sn_trilha_sugerida,
    acoes_consultivas: Array.isArray(parsed.acoes_consultivas) ? parsed.acoes_consultivas : heuristic.acoes_consultivas,
    riscos: Array.isArray(parsed.riscos) ? parsed.riscos : heuristic.riscos,
    proximos_passos: Array.isArray(parsed.proximos_passos) ? parsed.proximos_passos : heuristic.proximos_passos,
  };
}

async function safeSelect(table, columns, builderFn, meta = {}) {
  try {
    let query = supabase.from(table).select(columns).limit(meta.limit || 25);
    if (builderFn) query = builderFn(query);
    const { data, error } = await query;
    if (error) return { table, ok: false, error: error.message, data: [], meta };
    return { table, ok: true, data: data || [], meta };
  } catch (error) {
    return { table, ok: false, error: error.message, data: [], meta };
  }
}

function tableRows(sources, table) {
  return sources.filter((source) => source.tabela === table).flatMap((source) => source.linhas || []);
}

function addSource(sources, result, motivo) {
  if (result.ok && result.data.length > 0) {
    sources.push({ tabela: result.table, motivo: motivo || result.meta?.motivo || 'consulta', linhas: result.data });
  }
}

function hasAny(text = '', words = []) {
  const upper = normalizeUpper(text);
  return words.some((word) => upper.includes(normalizeUpper(word)));
}

function wantsOperationalProcess(text = '') {
  const q = normalizeSearchText(text);
  return /\b(WO|WORK\s*ORDER|REPAIR|REPARO|REPARADO|REPARADA|RECEX|PROCESSO|PROCESSOS|COMPRA|COMPRAS|COMPRADO|COMPRADA|AQUISICAO|AQUISIÇÃO|ADQUIRIDO|ADQUIRIDA|PD|SEPD|OC|ODC|ODA|COTACAO|COTAÇÃO|PEDIDO|PEDIDOS|SUPLEMENTACAO|SUPLEMENTAÇÃO|EMBARCADO|EMBARCADA|ABERTO|ABERTA|ANDAMENTO|LINHA\s+DE\s+VOO|DISPONIBILIDADE|INDISPONIBILIDADE)\b/.test(q);
}

function getFirst(row = {}, fields = []) {
  for (const field of fields) {
    const value = row?.[field];
    if (value !== undefined && value !== null && String(value).trim() !== '') return value;
  }
  return null;
}

function rowStatus(row = {}) {
  return normalizeUpper(getFirst(row, ['status', 'status_item', 'status_grupo', 'substatus', 'resultado_tecnico', 'resultado', 'situacao', 'estado']) || '');
}

function isClosedLogisticStatus(status = '') {
  const s = normalizeUpper(status);
  if (!s) return false;
  return /\b(CAN|CANCEL|CANCELADO|CANCELADA|EXCLUIDO|EXCLUÍDO|IRREPARAVEL|IRREPARÁVEL|RECEBIDO|RECEBIDA|REC|FAT|FATURADO|FATURADA|ENTREGUE|ENCERRADO|ENCERRADA|CLOSED|CLOSE)\b/.test(s);
}

function formatProcessRow(row = {}, tabela = '') {
  const pn = getFirst(row, ['pn', 'pn_saida', 'part_number', 'pi', 'PN']) || 'PN não informado';
  const nome = getFirst(row, ['nomenclatura', 'descricao', 'description', 'descricao_oficial', 'observacao', 'tipo']) || null;
  const status = rowStatus(row) || 'status não informado';
  const qtd = getFirst(row, ['quantidade', 'qtd_pedida', 'qtd_comprada', 'qtd_cotada', 'qtd_faturada', 'qtd_recebida']) || null;
  const doc = getFirst(row, ['numero_wo', 'documento_referencia', 'numero_pd', 'numero_oc', 'numero_oc_original', 'id']) || 'referência não informada';
  const sn = getFirst(row, ['sn', 'serial_number_relatorio']) || null;
  const empresa = getFirst(row, ['empresa', 'razao_social', 'fabricante', 'codemp']) || null;
  const data = getFirst(row, ['data_status', 'data_entrega', 'data_previsao', 'created_at', 'updated_at']) || null;
  const aberto = isClosedLogisticStatus(status) ? 'histórico/encerrado' : 'em aberto ou ainda útil para acompanhamento';
  const detalhes = [];
  detalhes.push(`${doc}`);
  detalhes.push(`PN ${pn}`);
  if (nome) detalhes.push(String(nome).slice(0, 90));
  detalhes.push(`status ${status}`);
  if (qtd) detalhes.push(`qtd ${qtd}`);
  if (sn) detalhes.push(`SN ${sn}`);
  if (empresa) detalhes.push(String(empresa).slice(0, 60));
  if (data) detalhes.push(`data ${String(data).slice(0, 10)}`);
  return `- ${tabela}: ${detalhes.join(' • ')} — ${aberto}.`;
}

function buildOperationalProcessAnswer(question = '', context = {}) {
  if (!context?.modules?.processo_aquisicao_reparo) return '';

  const pns = collectPnsFromSources(context.sources || []);
  const compras = tableRows(context.sources || [], 'compras_pds');
  const ordens = tableRows(context.sources || [], 'compras_ordens');
  const wos = tableRows(context.sources || [], 'work_orders');
  const repairs = tableRows(context.sources || [], 'leonardo_repairs');
  const suplementosWo = tableRows(context.sources || [], 'work_order_suplementacoes');
  const rows = [
    ...repairs.map((row) => ({ tabela: 'Order Book/Repair', row })),
    ...wos.map((row) => ({ tabela: 'WO', row })),
    ...compras.map((row) => ({ tabela: 'PD/Processo de compra', row })),
    ...ordens.map((row) => ({ tabela: 'OC/ODC/ODA', row })),
    ...suplementosWo.map((row) => ({ tabela: 'Suplementação de WO', row })),
  ];

  const processRows = rows.filter(({ row }) => {
    if (!pns.length) return true;
    const rowCompact = normalizePn(JSON.stringify(row));
    return pns.some((pn) => rowCompact.includes(normalizePn(pn)));
  });

  const manualOrCadastro = [
    ...tableRows(context.sources || [], 'items'),
    ...tableRows(context.sources || [], 'dicionario_manual'),
    ...tableRows(context.sources || [], 'dicionario_mestre'),
    ...tableRows(context.sources || [], 'item_apelidos'),
  ];

  if (processRows.length === 0) {
    if (manualOrCadastro.length > 0 || pns.length > 0) {
      const pnText = pns.length ? ` para ${pns.map((pn) => `PN ${pn}`).join(', ')}` : '';
      return [
        `Entendi a dúvida: você quer saber se existe algum caminho logístico${pnText} que possa ajudar a colocar o item na linha de voo — compra, PD/OC, WO ou reparo.`,
        '',
        'Achei referência do item no cadastro/manual/apelidos, mas não encontrei processo de compra, PD/OC, WO ou Repair em aberto no contexto consultado.',
        '',
        'Isso não prova que não exista em fonte primária; pode estar com outra nomenclatura, outro PN, lançado fora do SISHA ou ainda não importado. Minha recomendação é validar no PPU/Order Book e, se quiser, abrir pendência pelo Help Desk do Chat Lince.',
      ].join('\n');
    }
    return '';
  }

  const ativos = processRows.filter(({ row }) => !isClosedLogisticStatus(rowStatus(row)));
  const historicos = processRows.length - ativos.length;
  const linhas = processRows.slice(0, 8).map(({ tabela, row }) => formatProcessRow(row, tabela));
  const pnText = pns.length ? ` relacionado a ${pns.map((pn) => `PN ${pn}`).join(', ')}` : '';
  const abertura = ativos.length > 0
    ? `Sim. Encontrei ${ativos.length} registro(s)${pnText} que parecem estar em aberto ou ainda úteis para acompanhamento logístico.`
    : `Encontrei registro(s)${pnText}, mas eles parecem estar mais para histórico/encerrado do que processo aberto.`;

  const parts = [
    abertura,
    '',
    'Eu tratei “processo”, “aquisição”, “compra”, “PD/OC”, “WO” e “reparo” como a mesma intenção logística: verificar se existe alguma solução em andamento para suprir ou recuperar o item.',
    '',
    'O que apareceu no SISHA:',
    ...linhas,
  ];

  if (historicos > 0) parts.push(`Também havia ${historicos} registro(s) com aparência de histórico/encerramento/cancelamento; mantive a ressalva para não confundir com processo aberto.`);
  parts.push('Ressalva: para decisão operacional, valide o status mais recente no Order Book/PPU, principalmente quando aparecer “embarcado”, “faturado”, “recebido” ou status importado de planilha externa.');
  return parts.join('\n');
}

function buildIlikeOr(columns = [], values = []) {
  const clauses = [];
  values.filter(Boolean).slice(0, 6).forEach((value) => {
    const clean = String(value).replace(/[%*,]/g, '').trim();
    if (!clean) return;
    columns.forEach((column) => clauses.push(`${column}.ilike.%${clean}%`));
  });
  return clauses.join(',');
}


const EQUIPMENT_STOP_WORDS = new Set([
  'EXISTE', 'ALGUMA', 'ALGUM', 'ABERTA', 'ABERTO', 'WO', 'OS', 'DE', 'DO', 'DA', 'DAS', 'DOS',
  'EM', 'COM', 'POR', 'PARA', 'UMA', 'UM', 'AS', 'OS', 'O', 'A', 'TEM', 'TENHO', 'QUERIA',
  'SABER', 'CONSULTA', 'CONSULTAR', 'ITEM', 'EQUIPAMENTO', 'BOM', 'BOA', 'NOITE', 'DIA', 'TARDE'
]);

const EQUIPMENT_WORD_FIXES = new Map([
  ['PAUMP', 'PUMP'],
  ['PUMPI', 'PUMP'],
  ['BOMBA', 'PUMP'],
  ['BOOSTERPUMP', 'BOOSTER PUMP'],
  ['FUELPUMP', 'FUEL PUMP'],
]);

function normalizeEquipmentWord(word = '') {
  const raw = normalizeSearchText(word).replace(/[^A-Z0-9]/g, '');
  if (!raw) return '';
  return EQUIPMENT_WORD_FIXES.get(raw) || raw;
}

function extractEquipmentWords(text = '') {
  const normalized = normalizeSearchText(text).replace(/[^A-Z0-9\s]/g, ' ');
  const expanded = normalized.split(/\s+/).flatMap((word) => String(EQUIPMENT_WORD_FIXES.get(word) || word).split(/\s+/));
  return unique(expanded
    .map(normalizeEquipmentWord)
    .filter((word) => word.length >= 3 && !EQUIPMENT_STOP_WORDS.has(word) && !CHAT_LINCE_STOP_TERMS.has(word))
  ).slice(0, 8);
}

function rowPn(row = {}) {
  return row.pn || row.pn_saida || row.part_number || row.pi || row.PN || null;
}

function rowDescription(row = {}) {
  return [
    row.nomenclatura,
    row.descricao,
    row.description,
    row.techname,
    row.descricao_oficial,
    row.apelido,
    row.observacao,
    row.tipo,
    row.status,
  ].filter(Boolean).join(' | ');
}

function rowWords(row = {}) {
  return new Set(extractEquipmentWords(rowDescription(row)));
}

function deriveNameCorrelations(question = '', sources = []) {
  const queryWords = extractEquipmentWords(question);
  if (queryWords.length === 0) return [];

  const sourcePriority = {
    item_apelidos: 5,
    dicionario_manual: 4,
    dicionario_mestre: 4,
    items: 3,
    work_orders: 3,
    leonardo_repairs: 3,
    compras_pds: 2,
    service_bulletin_items: 2,
  };

  const candidates = [];
  sources.filter((source) => sourcePriority[source.tabela]).forEach((source) => {
    (source.linhas || []).forEach((row) => {
      const words = rowWords(row);
      if (words.size === 0) return;
      const matches = queryWords.filter((word) => words.has(word));
      if (matches.length === 0) return;

      const strong = queryWords.length >= 2 && matches.length >= Math.min(2, queryWords.length);
      const confidence = Math.min(0.95, (matches.length / Math.max(queryWords.length, 1)) * 0.75 + (sourcePriority[source.tabela] || 1) * 0.04);
      if (!strong && confidence < 0.45) return;

      candidates.push({
        termo_usuario: queryWords.join(' '),
        termo_encontrado: rowDescription(row).slice(0, 180),
        pn: rowPn(row),
        tabela: source.tabela,
        confianca: Number(confidence.toFixed(2)),
        palavras_batidas: matches,
        sugestao_apelido: queryWords.join(' '),
        descricao_oficial: row.nomenclatura || row.descricao || row.description || row.techname || row.descricao_oficial || null,
        pergunta_confirmacao: `Você está chamando “${queryWords.join(' ').toLowerCase()}” de “${(row.nomenclatura || row.descricao || row.description || row.techname || row.descricao_oficial || 'item encontrado')}”?`,
      });
    });
  });

  const seen = new Set();
  return candidates
    .sort((a, b) => b.confianca - a.confianca)
    .filter((item) => {
      const key = `${item.pn || ''}|${item.termo_encontrado}|${item.tabela}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, 5);
}

function collectPnsFromSources(sources = []) {
  return unique(sources.flatMap((source) => (source.linhas || []).flatMap((row) => [
    row.pn,
    row.PN,
    row.pn_saida,
    row.part_number,
    row.pi,
  ]).map(normalizePn).filter(Boolean))).slice(0, 20);
}

function sourceSummary(sources) {
  return sources.map((source) => ({
    tabela: source.tabela,
    motivo: source.motivo,
    quantidade: source.linhas.length,
  }));
}

function deriveSnLocation(sn, sources) {
  const snNorm = normalizeUpper(sn);
  const candidates = [];
  const wanted = ['equipamento_eventos', 'equipamentos_serializados', 'work_orders', 'estoque_ppu', 'leonardo_repairs', 'chat_lince_os_eventos_staging', 'cadastros_manuais'];

  sources.filter((source) => wanted.includes(source.tabela)).forEach((source) => {
    (source.linhas || []).forEach((row) => {
      const rowText = normalizeUpper(JSON.stringify(row));
      if (!rowText.includes(snNorm)) return;
      candidates.push({ tabela: source.tabela, row });
    });
  });

  if (candidates.length === 0) return null;

  const latest = candidates[0];
  const row = latest.row || {};
  return {
    sn: snNorm,
    melhor_evidencia: latest.tabela,
    pn: row.pn || row.pn_saida || row.part_number || null,
    status: row.status || row.status_grupo || row.resultado || row.resultado_tecnico || row.tipo_evento || null,
    localizacao: row.localizacao || row.local_atual || row.local_destino || row.local_origem || row.aeronave || row.origem || null,
    aeronave: row.aeronave || row.anv || row.origem_codigo || null,
    os: row.os_numero || row.os_vinculada || null,
    wo: row.numero_wo || row.documento_referencia || null,
    observacao: row.observacao || row.observacoes || row.trecho || null,
    ressalva: 'Localização inferida pela melhor evidência encontrada no banco; validar contra OS/evento mais recente.',
  };
}


function deriveManualApplications(sources = []) {
  const manualTables = ['dicionario_manual', 'dicionario_mestre'];
  const applications = [];

  sources.filter((source) => manualTables.includes(source.tabela)).forEach((source) => {
    (source.linhas || []).forEach((row) => {
      const pn = row.pn || row.PN || null;
      const dmc = row.dmc || row.DMC || null;
      const item = row.item_num || row.item || row.ITEM || null;
      const subItem = row.sub_item || row.sub || row.SUB || null;
      const nomenclatura = row.nomenclatura || row.descricao || row.description || row.techname || null;
      const techname = row.techname || row.nome_tecnico || null;
      const aplicacao = row.aplicacao || row.aplicação || row.application || row.instalacao || row.instalação || row.local_instalacao || row.localização || row.localizacao || null;
      const nsn = row.nsn || row.NSN || null;
      const pi = row.pi || row.PI || null;

      if (!pn && !dmc && !nomenclatura && !aplicacao) return;
      applications.push({
        tabela_base: source.tabela,
        pn,
        nsn,
        pi,
        dmc,
        item_num: item,
        sub_item: subItem,
        nomenclatura,
        techname,
        aplicacao_manual: aplicacao,
        leitura_segura: dmc
          ? `Manual/DMC ${dmc}${item ? `, item ${item}` : ''}${subItem ? `, subitem ${subItem}` : ''}.`
          : 'Registro encontrado no dicionário do manual, mas sem DMC informado.',
      });
    });
  });

  const seen = new Set();
  return applications.filter((item) => {
    const key = `${item.tabela_base}|${item.pn}|${item.dmc}|${item.item_num}|${item.sub_item}|${item.nomenclatura}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, 25);
}

function buildManualApplicationText(applications = []) {
  if (!applications.length) return '';
  const lines = ['Aplicação no manual/dicionário técnico:'];
  applications.slice(0, 8).forEach((item) => {
    lines.push(`- ${item.pn ? `PN ${item.pn}` : 'Item'}${item.nomenclatura ? ` — ${item.nomenclatura}` : ''}${item.techname ? ` (${item.techname})` : ''}. ${item.leitura_segura}${item.aplicacao_manual ? ` Aplicação/local informado: ${item.aplicacao_manual}.` : ' O manual localiza o item pelo DMC/item/subitem; se precisar do local físico exato na aeronave, valide no trecho técnico do manual.'}`);
  });
  lines.push('Ressalva: esta resposta usa somente o manual/dicionário técnico carregado no SISHA. Sem registro no manual, eu não afirmo aplicação/instalação.');
  return lines.join('\n');
}

async function fetchConsultContext(question = '') {
  const entities = detectEntities(question);
  const tokens = entities.tokens;
  const normalizedTokens = unique(tokens.map(normalizePn).filter(Boolean)).slice(0, 18);
  const snCandidates = unique(entities.sn_candidatos.map(normalizeUpper)).slice(0, 12);
  const docIdsRaw = entities.identificadores_documentais;
  const docIds = unique(docIdsRaw.map((doc) => normalizeUpper(doc).replace(/^(OC|ODC|ODA|PD|SEPD|WO|SB|PIM|OS)/, '$&')).filter(Boolean));
  const osCandidates = entities.os_candidatas;
  const qUpper = normalizeUpper(question);
  const freeTerms = extractSearchTerms(question);

  const wantsPolicy = hasAny(qUpper, ['POLITICA', 'POLÍTICA', 'TAREFA', 'QTDE 2', 'PRIORIDADE']);
  const wantsCost = hasAny(qUpper, ['CUSTO', 'OPERACIONAL', 'EXECUCAO', 'EXECUÇÃO', 'GBP', 'VALOR']);
  const wantsNeeds = hasAny(qUpper, ['GERADOR', 'NECESSIDADE', 'NECESSIDADES', 'PIM', 'PRONTID', 'COBERTURA', 'SUPLEMENTAR']);
  const wantsProcess = wantsOperationalProcess(question);
  const wantsSnTrace = hasAny(qUpper, ['ONDE ESTÁ', 'ONDE ESTA', 'LOCALIZA', 'SN', 'S/N', 'SERIAL', 'SÉRIE', 'SERIE', 'INSTAL', 'REMO']);
  const wantsManualApplication = hasAny(qUpper, ['MANUAL', 'DICIONARIO', 'DICIONÁRIO', 'APLICA', 'USADO', 'USADA', 'USA', 'INSTALADO', 'INSTALADA', 'INSTALA', 'ONDE É USADO', 'ONDE E USADO']) || wantsProcess || freeTerms.length > 0 || normalizedTokens.length > 0;

  const tasks = [];

  if (normalizedTokens.length > 0) {
    const pnTables = [
      ['items', '*', 'pn'],
      ['dicionario_manual', '*', 'pn'],
      ['dicionario_mestre', '*', 'pn'],
      ['estoque_ppu', '*', 'pn'],
      ['estoque_ceimspa', '*', 'pi'],
      ['lisde', '*', 'pn'],
      ['price_list', '*', 'pn'],
      ['rfq_cotacoes', '*', 'pn'],
      ['compras_pds', '*', 'pn'],
      ['compras_suplementacoes', '*', 'pn'],
      ['service_bulletin_items', '*', 'pn'],
      ['item_apelidos', '*', 'pn'],
      ['pn_alternativos_documento', '*', 'pn'],
      ['pn_alternativos_documento', '*', 'pn_alt'],
      ['pn_equivalencia', '*', 'pn'],
      ['receita_itens', '*', 'pn'],
      ['pim_demandas', '*', 'pn'],
      ['work_orders', '*', 'pn'],
      ['work_orders', '*', 'pn_saida'],
      ['leonardo_spares', '*', 'pn'],
      ['leonardo_repairs', '*', 'pn'],
      ['leonardo_foc_spares', '*', 'pn'],
      ['equipamentos_serializados', '*', 'pn'],
    ];
    pnTables.forEach(([table, cols, column]) => {
      tasks.push(safeSelect(table, cols, (query) => query.in(column, normalizedTokens), { motivo: `PN em ${column}` }));
    });
  }

  if (snCandidates.length > 0 || wantsSnTrace) {
    const serialValues = unique([...snCandidates, ...normalizedTokens]).slice(0, 18);
    const snTables = [
      ['equipamentos_serializados', '*', 'sn'],
      ['equipamento_eventos', '*', 'sn'],
      ['work_orders', '*', 'sn'],
      ['work_orders', '*', 'serial_number_relatorio'],
      ['leonardo_repairs', '*', 'sn'],
      ['estoque_ppu', '*', 'sn'],
      ['cadastros_manuais', '*', 'sn'],
      ['chat_lince_os_eventos_staging', '*', 'sn'],
    ];
    snTables.forEach(([table, cols, column]) => {
      if (serialValues.length > 0) tasks.push(safeSelect(table, cols, (query) => query.in(column, serialValues), { motivo: `SN em ${column}` }));
    });
  }

  if (docIds.length > 0 || osCandidates.length > 0) {
    const docClean = unique([...docIds, ...docIds.map((d) => d.replace(/^(OC|ODC|ODA|PD|SEPD|WO|SB|PIM|OS)/, '')), ...osCandidates]).slice(0, 24);
    const docTables = [
      ['compras_ordens', '*', 'numero_oc'],
      ['compras_ordens', '*', 'numero_oc_original'],
      ['compras_pds', '*', 'numero_pd'],
      ['compras_pds', '*', 'numero_oc'],
      ['work_orders', '*', 'numero_wo'],
      ['work_orders', '*', 'documento_referencia'],
      ['work_order_suplementacoes', '*', 'numero_wo'],
      ['service_bulletins', '*', 'sb_numero'],
      ['pim_demandas', '*', 'pim'],
      ['pim_demandas', '*', 'os_vinculada'],
      ['chat_lince_os_eventos_staging', '*', 'os_numero'],
    ];
    docTables.forEach(([table, cols, column]) => {
      tasks.push(safeSelect(table, cols, (query) => query.in(column, docClean), { motivo: `documento em ${column}` }));
    });
  }


  if (wantsManualApplication) {
    const terms = unique([...freeTerms, ...normalizedTokens, ...tokens]).slice(0, 8);
    const manualClause = buildIlikeOr(['pn', 'nsn', 'pi', 'dmc', 'nomenclatura', 'techname'], terms);
    if (manualClause) {
      tasks.push(safeSelect('dicionario_manual', '*', (query) => query.or(manualClause), { motivo: 'Aplicação/uso/instalação no dicionário do manual', limit: 35 }));
      tasks.push(safeSelect('dicionario_mestre', '*', (query) => query.or(manualClause), { motivo: 'Aplicação/uso/instalação no dicionário mestre do manual', limit: 35 }));
    }

    const itemClause = buildIlikeOr(['pn', 'nsn', 'nomenclatura'], terms);
    if (itemClause) {
      tasks.push(safeSelect('items', '*', (query) => query.or(itemClause), { motivo: 'Cadastro de item por PN/NSN/nomenclatura', limit: 25 }));
      tasks.push(safeSelect('item_apelidos', '*', (query) => query.or(buildIlikeOr(['pn', 'apelido', 'descricao_oficial', 'observacao'], terms)), { motivo: 'Apelidos operacionais por nome informado', limit: 25 }));
      tasks.push(safeSelect('compras_pds', '*', (query) => query.or(buildIlikeOr(['pn', 'nsn', 'nomenclatura', 'fabricante'], terms)), { motivo: 'Processos de compra por nome/nomenclatura', limit: 25 }));
      tasks.push(safeSelect('work_orders', '*', (query) => query.or(buildIlikeOr(['pn', 'pn_saida', 'nsn', 'nomenclatura', 'observacao'], terms)), { motivo: 'WO por nome/nomenclatura/observação', limit: 25 }));
      tasks.push(safeSelect('leonardo_repairs', '*', (query) => query.or(buildIlikeOr(['pn', 'sn', 'descricao', 'documento_referencia', 'status', 'tipo'], terms)), { motivo: 'WO/Repair do Order Book por descrição/nome', limit: 35 }));
      tasks.push(safeSelect('service_bulletin_items', '*', (query) => query.or(buildIlikeOr(['pn', 'nomenclatura'], terms)), { motivo: 'SB por PN/nomenclatura', limit: 25 }));
    }
  }

  if (wantsPolicy || wantsCost || wantsNeeds) {
    const terms = unique([...normalizedTokens, ...tokens, ...docIdsRaw, '']).slice(0, 8);
    const policyOr = buildIlikeOr(['tarefas', 'tipo'], terms);
    tasks.push(safeSelect('politica_estoque_tarefas', '*', (query) => (policyOr ? query.or(policyOr) : query), { motivo: 'Política de Estoque', limit: 30 }));
    tasks.push(safeSelect('receita_itens', '*', (query) => {
      const clause = buildIlikeOr(['inspecao', 'pn', 'nomenclatura', 'pn_alt'], terms);
      return clause ? query.or(clause) : query;
    }, { motivo: 'Receitas para Gerador/Custo', limit: 30 }));
    tasks.push(safeSelect('pim_demandas', '*', (query) => {
      const clause = buildIlikeOr(['pim', 'pn', 'nsn', 'os_vinculada', 'origem_codigo', 'origem_tipo', 'origem_descricao'], terms);
      return clause ? query.or(clause) : query;
    }, { motivo: 'PIM/OS para Gerador de Necessidades', limit: 30 }));
  }

  const settled = await Promise.all(tasks);
  const sources = [];
  settled.forEach((result) => addSource(sources, result));

  const crossTasks = [];
  const pds = tableRows(sources, 'compras_pds');
  const ordemIds = unique(pds.map((row) => row.ordem_id).filter(Boolean));
  const ocNumbers = unique(pds.flatMap((row) => [row.numero_oc, row.numero_oc_original]).filter(Boolean).map(normalizeUpper));
  if (ordemIds.length) crossTasks.push(safeSelect('compras_ordens', '*', (query) => query.in('id', ordemIds), { motivo: 'OC vinculada aos PDs encontrados' }));
  if (ocNumbers.length) crossTasks.push(safeSelect('compras_ordens', '*', (query) => query.in('numero_oc', ocNumbers), { motivo: 'OC vinculada aos PDs encontrados' }));

  const candidatePns = collectPnsFromSources(sources);
  if (candidatePns.length) {
    crossTasks.push(safeSelect('work_orders', '*', (query) => query.in('pn', candidatePns), { motivo: 'WO cruzada pelo PN encontrado no manual/cadastro/apelido', limit: 50 }));
    crossTasks.push(safeSelect('work_orders', '*', (query) => query.in('pn_saida', candidatePns), { motivo: 'WO cruzada por PN de saída encontrado no manual/cadastro/apelido', limit: 50 }));
    crossTasks.push(safeSelect('leonardo_repairs', '*', (query) => query.in('pn', candidatePns), { motivo: 'WO/Repair do Order Book cruzado pelo PN encontrado', limit: 50 }));
    crossTasks.push(safeSelect('compras_pds', '*', (query) => query.in('pn', candidatePns), { motivo: 'PD/OC cruzado pelo PN encontrado no manual/cadastro/apelido', limit: 50 }));
  }

  const equipamentos = tableRows(sources, 'equipamentos_serializados');
  const equipamentoIds = unique(equipamentos.map((row) => row.id).filter(Boolean));
  if (equipamentoIds.length) crossTasks.push(safeSelect('equipamento_eventos', '*', (query) => query.in('equipamento_id', equipamentoIds), { motivo: 'Eventos vinculados ao equipamento/SN' }));

  const woRows = tableRows(sources, 'work_orders');
  const woNumbers = unique(woRows.flatMap((row) => [row.numero_wo, row.documento_referencia]).filter(Boolean).map(normalizeUpper));
  if (woNumbers.length) crossTasks.push(safeSelect('work_order_suplementacoes', '*', (query) => query.in('numero_wo', woNumbers), { motivo: 'Suplementações da WO encontrada' }));

  const crossSettled = await Promise.all(crossTasks);
  crossSettled.forEach((result) => addSource(sources, result));

  const snTrace = unique([...snCandidates, ...(wantsSnTrace ? normalizedTokens : [])])
    .map((sn) => deriveSnLocation(sn, sources))
    .filter(Boolean);
  const manualApplications = deriveManualApplications(sources);
  const correlacoesSugeridas = deriveNameCorrelations(question, sources);

  return {
    tokens,
    normalizedTokens,
    freeTerms,
    snCandidates,
    docIds: unique([...docIds, ...osCandidates]),
    osCandidates,
    modules: {
      politica_estoque: wantsPolicy,
      custo_operacional: wantsCost,
      gerador_necessidades: wantsNeeds,
      processo_aquisicao_reparo: wantsProcess,
      trilha_sn_os: wantsSnTrace || snTrace.length > 0,
      manual_aplicacao: wantsManualApplication || manualApplications.length > 0,
    },
    snTrace,
    manualApplications,
    correlacoesSugeridas,
    sources,
    unavailable: [...settled, ...crossSettled].filter((r) => !r.ok).map((r) => ({ tabela: r.table, motivo: r.meta?.motivo, erro: r.error })),
  };
}

function summarizeRowsForPrompt(context) {
  return JSON.stringify({
    fontes: context.sources.map((source) => ({
      tabela: source.tabela,
      motivo: source.motivo,
      linhas: source.linhas.slice(0, 10),
    })),
    trilha_sn: context.snTrace,
    aplicacoes_manual: context.manualApplications,
    correlacoes_sugeridas: context.correlacoesSugeridas || [],
    modulos_acionados: context.modules,
  }, null, 2).slice(0, 18000);
}

function offlineConsultAnswer(question, context, helpdesk = null) {
  const q = normalizeUpper(question);
  const processAnswer = buildOperationalProcessAnswer(question, context);
  if (processAnswer) return processAnswer;
  const parts = [];

  if (context.sources.length === 0 && context.snTrace.length === 0 && context.manualApplications.length === 0 && (context.correlacoesSugeridas || []).length === 0) {
    parts.push('Analisei o SISHA e não encontrei nenhum registro claro para essa consulta.');
    parts.push('Isso não significa, necessariamente, que o item não exista: ele pode estar com outro PN, outro nome técnico, uma nomenclatura do manual diferente ou ainda não ter sido atualizado no banco.');
    if (helpdesk?.ok) {
      parts.push(`Registrei a dúvida no Help Desk do Chat Lince para análise do PPU. Protocolo: ${helpdesk.data?.protocolo || helpdesk.data?.id}.`);
    } else {
      parts.push('Minha recomendação é validar em fonte primária do PPU/manual e, se necessário, registrar a dúvida para análise humana.');
    }
    return parts.join('\n\n');
  }

  parts.push('Consultei o SISHA e encontrei as seguintes evidências:');
  sourceSummary(context.sources).forEach((source) => {
    parts.push(`- ${source.tabela}: ${source.quantidade} registro(s) — ${source.motivo || 'consulta'}.`);
  });

  const manualText = buildManualApplicationText(context.manualApplications);
  if (manualText) parts.push(`\n${manualText}`);

  if (context.snTrace.length > 0) {
    parts.push('\nTrilha de SN/localização:');
    context.snTrace.forEach((trace) => {
      parts.push(`- SN ${trace.sn}: melhor evidência em ${trace.melhor_evidencia}; PN ${trace.pn || 'não informado'}; status ${trace.status || 'não informado'}; localização/aeronave ${trace.localizacao || trace.aeronave || 'não informada'}; OS/WO ${trace.os || trace.wo || 'não vinculada'}.`);
    });
    parts.push('Ressalva: a localização por SN deve priorizar o último evento validado de instalação/remoção quando o relatório oficial de OS estiver cadastrado.');
  }

  if (q.includes('CEIMSPA')) parts.push('Regra SISHA: item no CeIMSPA é possibilidade; confirme com o CeIMSPA antes de assumir disponibilidade real.');
  if (q.includes('LISDE')) parts.push('Regra SISHA: LISDE não é estoque; ela reduz o lead time efetivo após pagamento, normalmente para cerca de 30 dias.');
  if (q.includes('PRONT') || q.includes('100%')) parts.push('Regra SISHA: prontidão só é SIM quando 100% da necessidade estiver coberta no PPU.');
  if (q.includes('CAN') || q.includes('CANCEL')) parts.push('Regra SISHA: status CAN cancela logicamente OC/PD/SEPD e não entra como compra ativa, saldo, radar ou necessidade útil.');
  if (context.modules.politica_estoque) parts.push('Política de Estoque: quando houver tarefa/receita vinculada, ela alimenta o Gerador de Necessidades e o Custo Operacional.');
  if (context.modules.custo_operacional) parts.push('Custo Operacional: usa receita x preço unitário e projeção por política; sem preço, o PN entra como pendência de cotação.');
  if (context.modules.gerador_necessidades) parts.push('Gerador de Necessidades: deve considerar PPU, CeIMSPA como possibilidade, LISDE como lead time e compras ativas não-CAN.');

  return parts.join('\n');
}

function hasConsultEvidence(context) {
  return Boolean(
    context?.sources?.length ||
    context?.snTrace?.length ||
    context?.manualApplications?.length ||
    context?.correlacoesSugeridas?.length
  );
}

async function createHelpdeskTicket({ question, context, user, motivo = 'SEM_RESPOSTA' }) {
  try {
    const protocolo = `CL-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
    const payload = {
      protocolo,
      usuario_email: user?.email || null,
      usuario_role: user?.role || null,
      pergunta_original: String(question || '').slice(0, 5000),
      termo_pesquisado: unique([...(context?.freeTerms || []), ...(context?.normalizedTokens || []), ...(context?.snCandidates || [])]).join(', ').slice(0, 500) || null,
      tipo_detectado: motivo,
      status: 'ABERTO',
      resposta_ia: 'Chat Lince não encontrou resposta suficiente no banco e abriu pendência para análise humana.',
      contexto_consulta: {
        tokens: context?.normalizedTokens || [],
        termos: context?.freeTerms || [],
        sn: context?.snCandidates || [],
        docs: context?.docIds || [],
        os: context?.osCandidates || [],
        fontes: sourceSummary(context?.sources || []),
        aplicacoes_manual: context?.manualApplications || [],
        correlacoes_sugeridas: context?.correlacoesSugeridas || [],
        modulos: context?.modules || {},
      },
      created_by_email: user?.email || null,
    };

    const { data, error } = await supabase
      .from('chat_lince_helpdesk')
      .insert(payload)
      .select('*')
      .single();

    if (error) return { ok: false, error: error.message };
    return { ok: true, data };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

async function answerConsultQuestion(question = '', user = null) {
  if (isGreetingOnly(question)) {
    return {
      resposta: buildFriendlyGreeting(),
      modelo: 'roteador-local',
      aviso_ia: null,
      contexto: { tokens: [], sn: [], identificadores_documentais: [], os: [], modulos: {}, trilha_sn: [], aplicacoes_manual: [], fontes: [], helpdesk: null },
    };
  }

  const context = await fetchConsultContext(question);
  const contextForPrompt = summarizeRowsForPrompt(context);

  let helpdesk = null;
  if (!hasConsultEvidence(context) || wantsHelpdeskRegistration(question)) {
    helpdesk = await createHelpdeskTicket({ question, context, user, motivo: hasConsultEvidence(context) ? 'SOLICITACAO_USUARIO' : 'SEM_RESPOSTA' });
  }

  if (!hasConsultEvidence(context)) {
    return {
      resposta: offlineConsultAnswer(question, context, helpdesk),
      modelo: 'roteador-local',
      aviso_ia: null,
      contexto: {
        tokens: context.normalizedTokens,
        termos: context.freeTerms,
        sn: context.snCandidates,
        identificadores_documentais: context.docIds,
        os: context.osCandidates,
        modulos: context.modules,
        trilha_sn: context.snTrace,
        aplicacoes_manual: context.manualApplications,
        correlacoes_sugeridas: context.correlacoesSugeridas || [],
        fontes: sourceSummary(context.sources),
        helpdesk: helpdesk?.ok ? { id: helpdesk.data?.id, protocolo: helpdesk.data?.protocolo, status: helpdesk.data?.status } : null,
        indisponiveis: context.unavailable,
      },
    };
  }

  const processAnswer = buildOperationalProcessAnswer(question, context);
  if (processAnswer) {
    return {
      resposta: processAnswer,
      modelo: 'roteador-local-processo-logistico',
      aviso_ia: null,
      contexto: {
        tokens: context.normalizedTokens,
        termos: context.freeTerms,
        sn: context.snCandidates,
        identificadores_documentais: context.docIds,
        os: context.osCandidates,
        modulos: context.modules,
        trilha_sn: context.snTrace,
        aplicacoes_manual: context.manualApplications,
        correlacoes_sugeridas: context.correlacoesSugeridas || [],
        fontes: sourceSummary(context.sources),
        helpdesk: helpdesk?.ok ? { id: helpdesk.data?.id, protocolo: helpdesk.data?.protocolo, status: helpdesk.data?.status } : null,
        indisponiveis: context.unavailable,
      },
    };
  }

  const ai = await callOpenRouter([
    {
      role: 'system',
      content: `Você é o ${CHAT_LINCE_NAME}, IA consultora documental e logística do SISHA-1. Responda em português-BR, de forma humana, cordial e objetiva, como um assistente do PPU. Evite parecer relatório robótico: nada de JSON bruto, nada de listar campos internos vazios, nada de tabela desnecessária. Use somente o contexto fornecido. Nunca invente dados. Se o usuário disser processo, aquisição, compra, PD, OC, ODC, ODA, WO ou reparo, entenda como intenção logística de saber se existe caminho de suprimento/recuperação para resolver a indisponibilidade e colocar o item na linha de voo. Se houver dados de WO/Repair do Order Book, considere isso como evidência de WO/repair mesmo que a tabela seja leonardo_repairs. Se o contexto trouxer correlacoes_sugeridas, explique que encontrou uma possível equivalência de nomenclatura, apresente os dados encontrados com ressalva e peça confirmação para cadastrar o termo como apelido operacional. Exemplo: “Encontrei PUMP, FUEL BOOSTER. Você confirma que é o mesmo que booster pump?”. Se o contexto trouxer aplicação no manual/dicionário técnico, explique onde o item aparece, DMC, item/subitem, nomenclatura e ressalva. Se não houver evidência, diga que não encontrou e oriente Help Desk. Regras fixas: CeIMSPA é possibilidade e deve ser confirmado; LISDE não é estoque e reduz LT efetivo; prontidão só é SIM com 100% no PPU; OC/ODC/ODA devem aparecer junto dos PDs; PN sem Price List/RFQ/recebimento precisa cotar; busca PN deve ser exata ou por prefixo, não por contém; CAN cancela logicamente compra ativa, saldo, radar e necessidade útil, preservando histórico. Integre Política de Estoque, Custo Operacional e Gerador de Necessidades quando a pergunta tocar nesses temas. Para pergunta “onde está o SN”, responda pela melhor trilha: equipamento serializado, eventos, WO/Repair/RECEX, PPU e staging de OS; ressalve quando faltar relatório oficial de OS de instalação/remoção.`,
    },
    {
      role: 'user',
      content: `Pergunta do usuário:\n${question}\n\nContexto consultado no banco SISHA:\n${contextForPrompt || '[]'}\n\nIdentificadores detectados: ${JSON.stringify({ pn: context.normalizedTokens, sn: context.snCandidates, docs: context.docIds, os: context.osCandidates })}\n\nMonte uma resposta conversacional, clara e útil. Informe o que encontrou, onde encontrou, aplicação no manual quando existir, impacto em Política/Custo/Gerador quando aplicável, trilha SN/OS quando aplicável, ressalvas e próxima ação recomendada. Não mostre JSON bruto nem tabelas vazias.`,
    },
  ], { temperature: 0.15 });

  const resposta = ai.ok ? ai.content : offlineConsultAnswer(question, context, helpdesk);
  return {
    resposta,
    modelo: ai.ok ? ai.model : 'offline',
    aviso_ia: ai.ok ? null : ai.reason,
    contexto: {
      tokens: context.normalizedTokens,
      termos: context.freeTerms,
      sn: context.snCandidates,
      identificadores_documentais: context.docIds,
      os: context.osCandidates,
      modulos: context.modules,
      trilha_sn: context.snTrace,
      aplicacoes_manual: context.manualApplications,
      correlacoes_sugeridas: context.correlacoesSugeridas || [],
      fontes: sourceSummary(context.sources),
      helpdesk: helpdesk?.ok ? { id: helpdesk.data?.id, protocolo: helpdesk.data?.protocolo, status: helpdesk.data?.status } : null,
      indisponiveis: context.unavailable,
    },
  };
}

async function saveDocumentAnalysis({ file, tipoDocumento, text, analysis, user }) {
  const payload = {
    tipo_documento: tipoDocumento || analysis.classificacao || 'DOCUMENTO_OPERACIONAL',
    nome_arquivo: file?.originalname || 'documento_sem_nome',
    mime_type: file?.mimetype || null,
    tamanho_bytes: file?.size || null,
    texto_extraido: compactText(text, 50000),
    resumo: analysis.resumo || null,
    classificacao: analysis.classificacao || null,
    destino_sugerido: analysis.destino_sugerido || suggestedDestinationFor(analysis.classificacao),
    destinos_possiveis: analysis.destinos_possiveis || destinationOptionsFor(analysis.classificacao),
    confianca: Number(analysis.confianca || 0),
    entidades: analysis.entidades || {},
    registros_sugeridos: analysis.registros_sugeridos || [],
    os_eventos_sugeridos: analysis.os_eventos_sugeridos || [],
    sn_trilha_sugerida: analysis.sn_trilha_sugerida || [],
    acoes_consultivas: analysis.acoes_consultivas || [],
    riscos: analysis.riscos || [],
    status: 'PENDENTE_CONFIRMACAO',
    created_by_email: user?.email || null,
    created_by_role: user?.role || null,
  };

  const { data, error } = await supabase
    .from('chat_lince_documentos')
    .insert(payload)
    .select('*')
    .single();

  if (error) {
    return { ok: false, error: error.message, payload };
  }

  return { ok: true, data };
}

async function insertOsEventsStaging(documento, user, destinoConfirmado) {
  const events = Array.isArray(documento.os_eventos_sugeridos) ? documento.os_eventos_sugeridos : [];
  if (events.length === 0) return { inserted: 0, error: null };

  const rows = events.slice(0, 50).map((event) => ({
    documento_id: documento.id,
    os_numero: event.os_numero || event.os || null,
    tipo_evento: event.tipo_evento || 'INDEFINIDO',
    pim: event.pim || null,
    pn: event.pn ? normalizePn(event.pn) : null,
    sn: event.sn ? normalizeUpper(event.sn) : null,
    aeronave: event.aeronave || null,
    local_origem: event.local_origem || null,
    local_destino: event.local_destino || null,
    data_evento: event.data_evento || null,
    confianca: safeNumber(documento.confianca),
    payload: event,
    destino_confirmado: destinoConfirmado,
    status: 'PENDENTE_MODELO_OFICIAL',
    created_by_email: user?.email || null,
  }));

  const { data, error } = await supabase
    .from('chat_lince_os_eventos_staging')
    .insert(rows)
    .select('id');

  if (error) return { inserted: 0, error: error.message };
  return { inserted: data?.length || rows.length, error: null };
}

async function confirmDocumentAnalysis({ id, user, observacaoAdmin = '', destinoAdmin = '' }) {
  const { data: documento, error: fetchError } = await supabase
    .from('chat_lince_documentos')
    .select('*')
    .eq('id', id)
    .single();

  if (fetchError || !documento) {
    throw new Error(fetchError?.message || 'Documento não encontrado.');
  }

  if (documento.status === 'CONFIRMADO') {
    return { documento, manual: null, alreadyConfirmed: true };
  }

  const destinoConfirmado = String(destinoAdmin || documento.destino_sugerido || 'cadastros_manuais').trim();
  const confirmacaoPayload = {
    destino_confirmado: destinoConfirmado,
    confirmado_por: user?.email || null,
    observacao_admin: observacaoAdmin || null,
    regra: 'Sem gravação operacional cega. Dados permanecem auditáveis e podem alimentar tabela operacional somente por fluxo específico validado.',
  };

  const { data: updated, error: updateError } = await supabase
    .from('chat_lince_documentos')
    .update({
      status: 'CONFIRMADO',
      confirmado_por: user?.email || null,
      confirmado_em: new Date().toISOString(),
      observacao_admin: observacaoAdmin || null,
      destino_confirmado: destinoConfirmado,
      confirmacao_payload: confirmacaoPayload,
    })
    .eq('id', id)
    .select('*')
    .single();

  if (updateError) throw updateError;

  const manualPayload = {
    tipo_registro: 'CHAT_LINCE_DOCUMENTAL',
    identificador_unico: String(documento.classificacao || documento.tipo_documento || id).slice(0, 120).toUpperCase(),
    valor_suplementado: 0,
    percentual_atendimento: Number(documento.confianca || 0) * 100,
    observacao: String(documento.resumo || '').slice(0, 2000),
    msg_referencia: `Chat Lince confirmou ${documento.nome_arquivo || id} → destino ${destinoConfirmado}`.slice(0, 500),
    valor_monetario: null,
    sn: Array.isArray(documento.entidades?.sn_candidatos) ? documento.entidades.sn_candidatos[0] || null : null,
    ativo: true,
  };

  const { data: manual, error: manualError } = await supabase
    .from('cadastros_manuais')
    .insert(manualPayload)
    .select('*')
    .single();

  const osStaging = await insertOsEventsStaging(updated, user, destinoConfirmado).catch((error) => ({ inserted: 0, error: error.message }));

  if (manualError) {
    return { documento: updated, manual: null, manualError: manualError.message, osStaging };
  }

  return { documento: updated, manual, osStaging };
}

async function rejectDocumentAnalysis({ id, user, observacaoAdmin = '' }) {
  const { data, error } = await supabase
    .from('chat_lince_documentos')
    .update({
      status: 'REJEITADO',
      confirmado_por: user?.email || null,
      confirmado_em: new Date().toISOString(),
      observacao_admin: observacaoAdmin || 'Rejeitado pelo Admin.',
    })
    .eq('id', id)
    .select('*')
    .single();

  if (error) throw error;
  return data;
}


async function listHelpdeskTickets({ status = 'ABERTO', limit = 50 } = {}) {
  const normalizedStatus = String(status || 'ABERTO').toUpperCase();
  const { data, error } = await supabase
    .from('chat_lince_helpdesk')
    .select('*')
    .eq('status', normalizedStatus)
    .order('created_at', { ascending: false })
    .limit(Math.min(Number(limit) || 50, 100));
  if (error) throw error;
  return data || [];
}

async function answerHelpdeskTicket({ id, respostaAdmin, user, responderPeloChat = true }) {
  const resposta = String(respostaAdmin || '').trim();
  if (!resposta) throw new Error('Informe a resposta do PPU/Admin.');

  const { data, error } = await supabase
    .from('chat_lince_helpdesk')
    .update({
      status: 'RESPONDIDO',
      resposta_admin: resposta,
      respondido_por: user?.email || null,
      respondido_em: new Date().toISOString(),
      responder_pelo_chat: Boolean(responderPeloChat),
    })
    .eq('id', id)
    .select('*')
    .single();

  if (error) throw error;
  return data;
}


async function confirmarApelidoSugerido({ sugestao, user }) {
  const pn = normalizePn(sugestao?.pn);
  const apelido = normalizeUpper(sugestao?.apelido || sugestao?.sugestao_apelido || sugestao?.termo_usuario);
  const descricaoOficial = sugestao?.descricao_oficial || sugestao?.termo_encontrado || null;

  if (!pn || !apelido) {
    throw new Error('PN e apelido são obrigatórios para confirmar a correlação.');
  }

  const payload = {
    pn,
    apelido,
    descricao_oficial: descricaoOficial,
    observacao: `Cadastrado pelo Chat Lince após confirmação humana. Usuário: ${user?.email || 'não informado'}.`,
    ativo: true,
  };

  const existente = await supabase
    .from('item_apelidos')
    .select('*')
    .eq('apelido', apelido)
    .maybeSingle();

  if (existente.error) throw existente.error;

  if (existente.data) {
    const { data, error } = await supabase
      .from('item_apelidos')
      .update({ ...payload })
      .eq('id', existente.data.id)
      .select('*')
      .single();
    if (error) throw error;
    return { data, updated: true };
  }

  const { data, error } = await supabase
    .from('item_apelidos')
    .insert(payload)
    .select('*')
    .single();

  if (error) throw error;
  return { data, updated: false };
}

module.exports = {
  CHAT_LINCE_NAME,
  analyzeDocumentWithAi,
  answerConsultQuestion,
  saveDocumentAnalysis,
  confirmDocumentAnalysis,
  rejectDocumentAnalysis,
  listHelpdeskTickets,
  answerHelpdeskTicket,
  confirmarApelidoSugerido,
  compactText,
};
