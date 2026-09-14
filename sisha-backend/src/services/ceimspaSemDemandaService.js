function normalizeHeader(value = '') {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .toUpperCase()
    .replace(/\s+/g, '_');
}

function normalizePi(value = '') {
  const raw = String(value ?? '').replace(/["']/g, '').trim();
  if (!raw) return null;
  const digits = raw.replace(/\D/g, '');
  if (!digits) return raw.toUpperCase();
  if (digits.length >= 13) return digits.slice(-9);
  return digits.padStart(9, '0');
}

function normalizeRef(value = '') {
  return String(value ?? '').replace(/["']/g, '').trim().toUpperCase() || null;
}

function parseNumber(value) {
  if (value === null || value === undefined || value === '') return 0;
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  const text = String(value).trim().replace(/\./g, '').replace(',', '.');
  const parsed = Number(text);
  if (!Number.isFinite(parsed)) {
    const error = new Error(`Quantidade inválida no arquivo Sem Demanda: ${value}`);
    error.code = 'CEIMSPA_SEM_DEMANDA_INVALID_QUANTITY';
    throw error;
  }
  return parsed;
}

function normalizeRows(rawRows = []) {
  return (rawRows || []).map((row) => {
    if (!Array.isArray(row)) return [];
    if (row.length === 1 && typeof row[0] === 'string') {
      if (row[0].includes('\t')) return row[0].split('\t');
      if (row[0].includes(';')) return row[0].split(';');
    }
    return row;
  });
}

function findHeaderIndex(rows = []) {
  return rows.findIndex((row) => {
    const headers = row.map(normalizeHeader);
    return headers.includes('PI') && headers.includes('REF') && headers.includes('QTDE_DISPONIVEL');
  });
}

function buildIndex(headers = []) {
  const map = new Map(headers.map((header, index) => [normalizeHeader(header), index]));
  const first = (...names) => {
    for (const name of names) {
      const index = map.get(normalizeHeader(name));
      if (Number.isInteger(index)) return index;
    }
    return -1;
  };
  return {
    pi: first('PI'),
    nomePort: first('NOME_PORT'),
    nomeCol: first('NOME_COL'),
    ref: first('REF'),
    rnvc: first('RNVC'),
    om: first('OM'),
    meio: first('MEIO'),
    nome: first('NOME'),
    qtdApl: first('QTDE_APL'),
    qtdDot: first('QTDE_DOT'),
    cam: first('CAM'),
    qtdExistente: first('QTDE_EXISTENTE'),
    qtdDisponivel: first('QTDE_DISPONIVEL'),
  };
}

function cell(row, index) {
  return index >= 0 ? row[index] : null;
}

function processRow(grouped, row, idx, sourceRow) {
  const pi = normalizePi(cell(row, idx.pi));
  const ref = normalizeRef(cell(row, idx.ref));
  if (!pi || !ref) return false;

  const quantidadeDisponivel = parseNumber(cell(row, idx.qtdDisponivel));
  const quantidadeExistente = parseNumber(cell(row, idx.qtdExistente));

  if (!grouped.has(pi)) {
    grouped.set(pi, {
      pi,
      quantidade: quantidadeDisponivel,
      quantidade_existente: quantidadeExistente,
      nomenclatura: String(cell(row, idx.nomePort) || cell(row, idx.nomeCol) || cell(row, idx.nome) || '').trim() || null,
      referencias: new Map(),
      firstRow: sourceRow,
    });
  }

  const group = grouped.get(pi);
  if (Math.abs(group.quantidade - quantidadeDisponivel) > 1e-9 || Math.abs(group.quantidade_existente - quantidadeExistente) > 1e-9) {
    const error = new Error(`O PI ${pi} possui quantidades divergentes no arquivo Sem Demanda. O SISHA não somará saldos ambíguos.`);
    error.code = 'CEIMSPA_SEM_DEMANDA_PI_QUANTITY_CONFLICT';
    error.pi = pi;
    throw error;
  }

  const refKey = [ref, cell(row, idx.rnvc), cell(row, idx.om), cell(row, idx.meio), cell(row, idx.cam)]
    .map((value) => String(value || '').trim().toUpperCase())
    .join('|');

  if (!group.referencias.has(refKey)) {
    group.referencias.set(refKey, {
      ref,
      rnvc: String(cell(row, idx.rnvc) || '').trim() || null,
      om: String(cell(row, idx.om) || '').trim() || null,
      meio: String(cell(row, idx.meio) || '').trim() || null,
      nome: String(cell(row, idx.nome) || '').trim() || null,
      cam: String(cell(row, idx.cam) || '').trim() || null,
      qtde_apl: parseNumber(cell(row, idx.qtdApl)),
      qtde_dot: parseNumber(cell(row, idx.qtdDot)),
    });
  }

  return true;
}

function finalizeGrouped(grouped, options = {}) {
  const arquivoFonte = String(options.fileName || '').trim() || null;
  return Array.from(grouped.values()).map((group) => {
    const referencias = Array.from(group.referencias.values());
    return {
      pi: group.pi,
      pn: null,
      pn_confirmado: false,
      fonte_identificacao: 'CEIMSPA_SEM_DEMANDA',
      nomenclatura: group.nomenclatura,
      quantidade: group.quantidade,
      quantidade_existente: group.quantidade_existente,
      sj: 'SEM DEMANDA',
      uf: null,
      referencias,
      referencias_text: referencias.map((item) => item.ref).filter(Boolean).join(' | '),
      arquivo_fonte: arquivoFonte,
    };
  });
}

function parseCeimspaSemDemandaRows(rawRows = [], options = {}) {
  const rows = normalizeRows(rawRows);
  const headerIndex = findHeaderIndex(rows);
  if (headerIndex < 0) {
    const error = new Error('Cabeçalhos PI, REF e QTDE_DISPONIVEL não encontrados no arquivo Sem Demanda.');
    error.code = 'CEIMSPA_SEM_DEMANDA_HEADERS_NOT_FOUND';
    throw error;
  }

  const idx = buildIndex(rows[headerIndex]);
  const grouped = new Map();
  let validRows = 0;

  for (let i = headerIndex + 1; i < rows.length; i += 1) {
    if (processRow(grouped, rows[i], idx, i + 1)) validRows += 1;
  }

  return {
    headerIndex,
    sourceRows: Math.max(rows.length - (headerIndex + 1), 0),
    validRows,
    rows: finalizeGrouped(grouped, options),
  };
}

function worksheetCell(sheet, xlsxLib, rowIndex, colIndex) {
  let cellObject = null;

  // SheetJS em modo dense:true armazena as células em !data.
  if (Array.isArray(sheet?.['!data'])) {
    cellObject = sheet['!data'][rowIndex]?.[colIndex] || null;
  } else {
    const address = xlsxLib.utils.encode_cell({ r: rowIndex, c: colIndex });
    cellObject = sheet?.[address] || null;
  }

  if (!cellObject) return '';

  // Para identificadores (PI/REF), o texto visível protege zeros à esquerda e
  // reduz os casos de coerção indesejada do Excel. Para quantidades, parseNumber
  // aceita o valor textual normalmente.
  if (cellObject.w !== undefined && cellObject.w !== null && String(cellObject.w).trim() !== '') {
    return cellObject.w;
  }
  if (cellObject.v === undefined || cellObject.v === null) return '';
  return cellObject.v;
}

function worksheetRow(sheet, xlsxLib, rowIndex, startCol, endCol) {
  const row = [];
  for (let colIndex = startCol; colIndex <= endCol; colIndex += 1) {
    row.push(worksheetCell(sheet, xlsxLib, rowIndex, colIndex));
  }
  return row;
}

function parseCeimspaSemDemandaWorksheet(sheet, xlsxLib, options = {}) {
  if (!sheet || !xlsxLib?.utils?.decode_range || !xlsxLib?.utils?.encode_cell) {
    const error = new Error('Planilha Sem Demanda inválida ou leitor XLS indisponível.');
    error.code = 'CEIMSPA_SEM_DEMANDA_INVALID_WORKSHEET';
    throw error;
  }

  const ref = String(sheet['!ref'] || '').trim();
  if (!ref) {
    const error = new Error('A planilha Sem Demanda está vazia.');
    error.code = 'CEIMSPA_SEM_DEMANDA_EMPTY_WORKSHEET';
    throw error;
  }

  const range = xlsxLib.utils.decode_range(ref);
  const headerSearchEnd = Math.min(range.e.r, range.s.r + 100);
  let headerRowIndex = -1;
  let headers = null;

  for (let rowIndex = range.s.r; rowIndex <= headerSearchEnd; rowIndex += 1) {
    const candidate = worksheetRow(sheet, xlsxLib, rowIndex, range.s.c, range.e.c);
    const normalized = candidate.map(normalizeHeader);
    if (normalized.includes('PI') && normalized.includes('REF') && normalized.includes('QTDE_DISPONIVEL')) {
      headerRowIndex = rowIndex;
      headers = candidate;
      break;
    }
  }

  if (headerRowIndex < 0 || !headers) {
    const error = new Error('Cabeçalhos PI, REF e QTDE_DISPONIVEL não encontrados no arquivo Sem Demanda.');
    error.code = 'CEIMSPA_SEM_DEMANDA_HEADERS_NOT_FOUND';
    throw error;
  }

  const idx = buildIndex(headers);
  const grouped = new Map();
  let validRows = 0;

  // Diferente de sheet_to_json(), esta leitura mantém apenas UMA linha temporária
  // na memória e o agrupador final por PI.
  for (let rowIndex = headerRowIndex + 1; rowIndex <= range.e.r; rowIndex += 1) {
    const row = worksheetRow(sheet, xlsxLib, rowIndex, range.s.c, range.e.c);
    if (processRow(grouped, row, idx, rowIndex + 1)) validRows += 1;
  }

  return {
    headerIndex: headerRowIndex,
    sourceRows: Math.max(range.e.r - headerRowIndex, 0),
    validRows,
    rows: finalizeGrouped(grouped, options),
  };
}

module.exports = {
  normalizePi,
  parseNumber,
  parseCeimspaSemDemandaRows,
  parseCeimspaSemDemandaWorksheet,
};
