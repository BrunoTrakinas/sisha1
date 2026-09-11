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

  rows.slice(headerIndex + 1).forEach((row, offset) => {
    const pi = normalizePi(cell(row, idx.pi));
    const ref = normalizeRef(cell(row, idx.ref));
    if (!pi || !ref) return;

    const quantidadeDisponivel = parseNumber(cell(row, idx.qtdDisponivel));
    const quantidadeExistente = parseNumber(cell(row, idx.qtdExistente));

    if (!grouped.has(pi)) {
      grouped.set(pi, {
        pi,
        quantidade: quantidadeDisponivel,
        quantidade_existente: quantidadeExistente,
        nomenclatura: String(cell(row, idx.nomePort) || cell(row, idx.nomeCol) || cell(row, idx.nome) || '').trim() || null,
        referencias: new Map(),
        firstRow: headerIndex + 2 + offset,
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
  });

  const arquivoFonte = String(options.fileName || '').trim() || null;
  return {
    headerIndex,
    rows: Array.from(grouped.values()).map((group) => {
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
    }),
  };
}

module.exports = { normalizePi, parseNumber, parseCeimspaSemDemandaRows };
