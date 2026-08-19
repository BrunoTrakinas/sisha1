
function clean(value) { return String(value ?? '').trim(); }
function upper(value) { return clean(value).toUpperCase(); }
function normalizeKey(value) { return upper(value).normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^A-Z0-9]/g, ''); }
function normalizePn(value) { return upper(value).replace(/\s+/g, ''); }
function normalizeSn(value) { return upper(value).replace(/\s+/g, ''); }
function unique(values) { return [...new Set((values || []).filter(Boolean))]; }

const PN_KEYS = new Set(['PN', 'PARTNUMBER', 'PARTNUMER', 'PARTNO', 'PARTN', 'P/N'].map(normalizeKey));
const SN_KEYS = new Set(['SN', 'SERIALNUMBER', 'SERIALNUMER', 'SERIALNO', 'S/N'].map(normalizeKey));
const PI_KEYS = new Set(['PI', 'NSN', 'NSNPI', 'NATOSTOCKNUMBER'].map(normalizeKey));
const NAME_KEYS = new Set(['NOMENCLATURA', 'DESCRIPTION', 'DESCRICAO', 'ITEM', 'NOME'].map(normalizeKey));

function pickField(row = {}, aliases = new Set()) {
  for (const [key, value] of Object.entries(row || {})) {
    if (aliases.has(normalizeKey(key)) && clean(value)) return clean(value);
  }
  return '';
}

function spreadsheetRecords(file) {
  if (!file?.buffer) return [];
  const xlsx = require('xlsx');
  const workbook = xlsx.read(file.buffer, { type: 'buffer', raw: false, cellDates: false });
  const records = [];
  workbook.SheetNames.forEach((sheetName) => {
    const sheet = workbook.Sheets[sheetName];
    const rows = xlsx.utils.sheet_to_json(sheet, { defval: '', raw: false });
    rows.forEach((row, index) => {
      const pn = normalizePn(pickField(row, PN_KEYS));
      const sn = normalizeSn(pickField(row, SN_KEYS));
      const pi = clean(pickField(row, PI_KEYS));
      const nomenclatura = clean(pickField(row, NAME_KEYS));
      if (!pn && !sn && !pi) return;
      records.push({ pn, sn, pi, nomenclatura, aba: sheetName, linha: index + 2 });
    });
  });
  return records;
}

function analysisRecords(analysis = {}) {
  const candidates = [
    ...(Array.isArray(analysis.registros_sugeridos) ? analysis.registros_sugeridos : []),
    ...(Array.isArray(analysis.itens) ? analysis.itens : []),
    ...(Array.isArray(analysis?.entidades?.itens) ? analysis.entidades.itens : []),
  ];
  return candidates.map((row, index) => ({
    pn: normalizePn(row?.pn || row?.part_number || row?.partNumber),
    sn: normalizeSn(row?.sn || row?.serial_number || row?.serialNumber),
    pi: clean(row?.pi || row?.nsn || row?.nsn_pi),
    nomenclatura: clean(row?.nomenclatura || row?.descricao || row?.description),
    aba: 'Documento',
    linha: index + 1,
  })).filter((row) => row.pn || row.sn || row.pi);
}

function quantityFromPpuRow(row = {}) {
  for (const key of ['quantidade_efetiva', 'quantidade_disponivel', 'quantidade', 'qtd', 'saldo']) {
    const value = Number(row?.[key]);
    if (Number.isFinite(value)) return value;
  }
  return 0;
}

async function equipmentRowsByPns(pns = []) {
  const supabase = require('../config/supabaseClient');
  const safe = unique(pns.map(normalizePn)).slice(0, 1000);
  if (!safe.length) return [];
  const rows = [];
  for (let i = 0; i < safe.length; i += 100) {
    const chunk = safe.slice(i, i + 100);
    const { data, error } = await supabase
      .from('equipamentos_serializados')
      .select('id,pn,sn,nomenclatura,status_atual,condicao_atual,categoria_local_atual,local_atual,anv_atual,ativo')
      .in('pn', chunk)
      .neq('ativo', false)
      .order('pn')
      .order('sn');
    if (error) throw error;
    rows.push(...(data || []));
  }
  return rows;
}

function priorityRank(priority = '') {
  return { CRITICA: 5, ALTA: 4, MEDIA: 3, NORMAL: 2, INDETERMINADA: 1 }[upper(priority).normalize('NFD').replace(/[\u0300-\u036f]/g, '')] || 0;
}

function wantsOnlyPpu(question = '') {
  const q = upper(question).normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  return /\b(SOMENTE|APENAS|SO)\b/.test(q) && /\bPPU\b/.test(q);
}

function wantsRepairPriority(question = '') {
  const q = upper(question).normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  return /PRIORIDAD/.test(q) && /REPAR/.test(q);
}

async function compareRecordsWithSisha(records = [], question = '') {
  const { loadEffectivePpuRowsByPns } = require('./ppuEffectiveAvailabilityService');
  const { buildOperationalRow } = require('./equipmentOperationalSearchService');
  const normalized = records.slice(0, 5000).map((row) => ({ ...row, pn: normalizePn(row.pn), sn: normalizeSn(row.sn) }));
  const pns = unique(normalized.map((row) => row.pn));
  const equipmentRows = await equipmentRowsByPns(pns);
  let ppuRows = [];
  let ppuKnown = true;
  try {
    ppuRows = await loadEffectivePpuRowsByPns(pns);
  } catch (_) {
    ppuKnown = false;
  }
  const supabase = require('../config/supabaseClient');
  const equipmentIds = unique(equipmentRows.map((row) => row.id).filter(Boolean));
  const eventRows = [];
  for (let i = 0; i < equipmentIds.length; i += 100) {
    const { data, error } = await supabase
      .from('equipamento_eventos')
      .select('*')
      .in('equipamento_id', equipmentIds.slice(i, i + 100))
      .order('data_evento', { ascending: false })
      .order('id', { ascending: false });
    if (error) throw error;
    eventRows.push(...(data || []));
  }
  const eventsById = new Map();
  eventRows.forEach((event) => {
    const key = String(event.equipamento_id);
    if (!eventsById.has(key)) eventsById.set(key, []);
    eventsById.get(key).push(event);
  });

  const equipmentByPn = new Map();
  equipmentRows.forEach((row) => {
    const key = normalizePn(row.pn);
    if (!equipmentByPn.has(key)) equipmentByPn.set(key, []);
    equipmentByPn.get(key).push(row);
  });
  const ppuByPn = new Map();
  ppuRows.forEach((row) => {
    const key = normalizePn(row.pn);
    if (!ppuByPn.has(key)) ppuByPn.set(key, []);
    ppuByPn.get(key).push(row);
  });
  const operationalByKey = new Map();
  const operationalByPn = new Map();
  equipmentRows.forEach((equipment) => {
    const pn = normalizePn(equipment.pn);
    const ppuForPn = ppuByPn.get(pn) || [];
    const operationalRow = buildOperationalRow(
      equipment,
      eventsById.get(String(equipment.id)) || [],
      ppuForPn,
      new Date(),
      { ppuKnown },
    );
    const sn = normalizeSn(operationalRow.sn);
    operationalByKey.set(`${pn}::${sn}`, operationalRow);
    if (!operationalByPn.has(pn)) operationalByPn.set(pn, []);
    operationalByPn.get(pn).push(operationalRow);
  });

  let rows = normalized.map((input) => {
    const equipments = equipmentByPn.get(input.pn) || [];
    const exactEquipment = input.sn ? equipments.find((row) => normalizeSn(row.sn) === input.sn) : null;
    const ppu = ppuByPn.get(input.pn) || [];
    const ppuQty = ppu.reduce((sum, row) => sum + Math.max(0, quantityFromPpuRow(row)), 0);
    const ops = input.sn
      ? [operationalByKey.get(`${input.pn}::${input.sn}`)].filter(Boolean)
      : (operationalByPn.get(input.pn) || []);
    const highestPriority = [...ops].sort((a, b) => priorityRank(b.prioridade_reparo) - priorityRank(a.prioridade_reparo))[0] || null;
    const serials = equipments.map((row) => clean(row.sn)).filter(Boolean);
    return {
      PN: input.pn || '',
      SN_Informado: input.sn || '',
      PI_NSN: input.pi || '',
      Nomenclatura_Documento: input.nomenclatura || '',
      Aba: input.aba || '',
      Linha: input.linha || '',
      Encontrado_no_SISHA: Boolean(equipments.length || ppu.length) ? 'SIM' : 'NÃO',
      SNs_no_SISHA: serials.join(', '),
      Quantidade_PPU_Efetiva: ppuKnown ? ppuQty : '',
      Tem_no_PPU: ppuKnown ? (ppuQty > 0 ? 'SIM' : 'NÃO') : 'INDETERMINADO',
      Local_Atual: exactEquipment?.local_atual || highestPriority?.local_atual || '',
      Condicao: exactEquipment?.condicao_atual || highestPriority?.condicao_atual || '',
      Aeronave: exactEquipment?.anv_atual || highestPriority?.anv_atual || '',
      Prioridade_Reparo: highestPriority?.prioridade_reparo || 'INDETERMINADA',
      Candidato_Reparo_Emergencial: highestPriority?.candidato_reparo_emergencial ? 'SIM' : 'NÃO',
      Justificativa: Array.isArray(highestPriority?.razoes_prioridade) ? highestPriority.razoes_prioridade.join(' | ') : '',
      Conflito: highestPriority?.conflito_pendente ? 'SIM' : 'NÃO',
    };
  });

  if (wantsOnlyPpu(question)) rows = rows.filter((row) => row.Tem_no_PPU === 'SIM');
  if (wantsRepairPriority(question)) rows.sort((a, b) => priorityRank(b.Prioridade_Reparo) - priorityRank(a.Prioridade_Reparo));

  const inPpu = rows.filter((row) => row.Tem_no_PPU === 'SIM').length;
  const emergencies = rows.filter((row) => row.Candidato_Reparo_Emergencial === 'SIM').length;
  const unknown = rows.filter((row) => row.Encontrado_no_SISHA === 'NÃO').length;
  return {
    title: wantsRepairPriority(question) ? 'Prioridade de reparo - Documento x SISHA' : wantsOnlyPpu(question) ? 'Itens do documento encontrados no PPU' : 'Auditoria comparativa Documento x SISHA',
    question,
    summary: `Foram analisados ${normalized.length} registro(s) do documento. Resultado retornado: ${rows.length}. Com PPU efetivo: ${inPpu}. Candidatos a reparo emergencial: ${emergencies}. Não encontrados: ${unknown}.${ppuKnown ? '' : ' A disponibilidade do PPU ficou indeterminada por falha de leitura e não foi assumida como zero.'}`,
    columns: rows.length ? Object.keys(rows[0]) : ['PN', 'Resultado'],
    rows,
    sources: [
      { tabela: 'Documento anexado', motivo: 'PN/SN/PI extraídos da relação enviada pelo usuário', linhas: normalized.length },
      { tabela: 'equipamentos_serializados', motivo: 'Livro de Equipamentos PN+SN', linhas: equipmentRows.length },
      { tabela: 'v_sisha_ppu_disponibilidade_efetiva', motivo: 'Disponibilidade efetiva do PPU com reconciliação de custódia', linhas: ppuRows.length },
      { tabela: 'Pesquisa Operacional de Equipamentos', motivo: 'Condição, localização, conflitos e prioridade de reparo fail-closed', linhas: equipmentRows.length },
    ],
    rule: 'Fail-closed: prioridade emergencial exige criticidade explícita compatível + PPU efetivo zero conhecido + evidência de reparo + ainda não em reparo + sem conflito. Falha de leitura do PPU nunca vira saldo zero.',
    fileBase: wantsRepairPriority(question) ? 'SISHA_Prioridade_Reparo' : wantsOnlyPpu(question) ? 'SISHA_Itens_no_PPU' : 'SISHA_Auditoria_Comparativa',
  };
}

function extractPnFromQuestion(question = '') {
  const matches = [];
  const regex = /\b(?:PN|P\/N|PART\s*NUMBER)\s*[:#-]?\s*([A-Z0-9][A-Z0-9./_-]{1,40})/gi;
  let match;
  while ((match = regex.exec(question))) matches.push(normalizePn(match[1]));
  return unique(matches);
}

function isSerialsByPnQuestion(question = '') {
  const q = upper(question).normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  return /\b(SN|SERIAL|SERIAIS)\b/.test(q) && /\b(PN|P\/N|PART NUMBER)\b/.test(q) && /\b(QUAL|QUAIS|TEMOS|LISTE|MOSTRE|RELACAO|RELACAO)\b/.test(q);
}

async function structuredSerialsByPn(question = '') {
  if (!isSerialsByPnQuestion(question)) return null;
  const pns = extractPnFromQuestion(question);
  if (!pns.length) return null;
  const equipmentRows = await equipmentRowsByPns(pns);
  const rows = equipmentRows.map((row) => ({
    PN: row.pn || '',
    SN: row.sn || '',
    Nomenclatura: row.nomenclatura || '',
    Local_Atual: row.local_atual || '',
    Condicao: row.condicao_atual || '',
    Status: row.status_atual || '',
    Aeronave: row.anv_atual || '',
  }));
  return {
    answer: rows.length
      ? `Encontrei ${rows.length} equipamento(s) ativo(s) para ${pns.map((pn) => `PN ${pn}`).join(', ')}. A relação completa pode ser exportada em Excel ou PDF.`
      : `Não encontrei equipamento serializado ativo para ${pns.map((pn) => `PN ${pn}`).join(', ')}.`,
    structured: {
      title: `SN cadastrados - ${pns.join('_')}`,
      question,
      summary: `${rows.length} equipamento(s) serializado(s) ativo(s) encontrado(s).`,
      columns: ['PN', 'SN', 'Nomenclatura', 'Local_Atual', 'Condicao', 'Status', 'Aeronave'],
      rows,
      sources: [{ tabela: 'equipamentos_serializados', motivo: 'Livro de Equipamentos PN+SN', linhas: rows.length }],
      fileBase: `SISHA_SN_${pns.join('_')}`,
    },
    tokens: pns,
  };
}

module.exports = {
  spreadsheetRecords,
  analysisRecords,
  compareRecordsWithSisha,
  structuredSerialsByPn,
  isSerialsByPnQuestion,
};
