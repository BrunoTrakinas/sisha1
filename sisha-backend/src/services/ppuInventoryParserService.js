function text(value) {
  return String(value ?? '').trim();
}

function normalized(value) {
  return text(value)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizePn(value) {
  return text(value).toUpperCase().replace(/\s+/g, '');
}

function normalizeSn(value) {
  const raw = text(value).toUpperCase();
  if (!raw) return null;
  const compact = raw.replace(/\s+/g, '');
  if (['N/A', 'NA', 'S/N', 'SN', '-', '---', 'NULL'].includes(compact)) return null;
  if (/^X+$/.test(compact) || compact.startsWith('EXCLUIR')) return null;
  return raw;
}

function normalizeLocation(value) {
  const raw = text(value).replace(/\s+/g, ' ');
  if (!raw || ['NULL', 'N/A', 'NA', '-'].includes(raw.toUpperCase())) return 'NÃO DEFINIDO';
  return raw;
}

function parseQuantity(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? Math.max(0, value) : 0;
  let raw = text(value).replace(/\s+/g, '');
  if (!raw) return 0;
  raw = raw.replace(/[^0-9,.-]/g, '');
  if (!raw) return 0;
  if (raw.includes(',') && raw.includes('.')) {
    if (raw.lastIndexOf(',') > raw.lastIndexOf('.')) raw = raw.replace(/\./g, '').replace(',', '.');
    else raw = raw.replace(/,/g, '');
  } else if (raw.includes(',')) {
    raw = raw.replace(',', '.');
  }
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? Math.max(0, parsed) : 0;
}

function firstNonEmpty(row = []) {
  return row.find((cell) => text(cell)) ?? '';
}

function isSectionMarker(value, marker) {
  return normalized(value) === marker;
}

function extractLocation(row = []) {
  const candidate = row.find((cell) => normalized(cell).startsWith('LOCALIZACAO '));
  if (candidate === undefined) return null;
  const raw = text(candidate);
  const colon = raw.indexOf(':');
  const location = colon >= 0 ? raw.slice(colon + 1) : raw.replace(/^LOCALIZA(?:ÇÃO|CAO)\s*/i, '');
  return normalizeLocation(location);
}

function exactHeaderIndex(row = [], names = []) {
  const allowed = new Set(names.map((name) => normalized(name)));
  return row.findIndex((cell) => allowed.has(normalized(cell)));
}

function chooseLastHeaderIndex(row = [], names = []) {
  const allowed = new Set(names.map((name) => normalized(name)));
  let found = -1;
  row.forEach((cell, index) => {
    if (allowed.has(normalized(cell))) found = index;
  });
  return found;
}

function nativeHeader(section, row = []) {
  const pn = exactHeaderIndex(row, ['PN', 'P/N', 'PART NUMBER', 'PART NO']);
  const qtd = exactHeaderIndex(row, ['QNTD', 'QTD', 'QTY', 'QTDE', 'QTE', 'QUANTIDADE', 'QUANTITY']);
  if (pn < 0 || qtd < 0) return null;

  const base = {
    pn,
    qtd,
    nomenclatura: exactHeaderIndex(row, ['NOMENCLATURA', 'DESCRIPTION', 'DESCRICAO']),
    pi: exactHeaderIndex(row, ['PI', 'NSN', 'NSN PI', 'NSN-PI']),
    sn: exactHeaderIndex(row, ['SN', 'S/N', 'SERIAL NUMBER']),
    lote: chooseLastHeaderIndex(row, ['LOTE', 'LOT']),
    preco: exactHeaderIndex(row, ['PRECO US$', 'PRECO USD', 'PRICE US$', 'PRICE USD']),
    sjb: exactHeaderIndex(row, ['SJB']),
    validade: exactHeaderIndex(row, ['VALIDADE', 'VALIDITY', 'EXPIRY']),
  };

  if (section === 'EQUIPAMENTOS' && base.sn < 0) return null;
  return base;
}

function invalidPn(pn, nomenclatura) {
  const compact = normalizePn(pn);
  const name = normalized(nomenclatura);
  if (!compact) return true;
  if (['PN', 'P/N', 'PARTNUMBER', 'PARTNO', 'DUPLICADO', 'NULL'].includes(compact)) return true;
  if (compact.startsWith('EXCLUIR')) return true;
  if (name.includes('DUPLICADO') && (name.includes('NAO APLICAVEL') || name.includes('NAO UTILIZAR'))) return true;
  return false;
}

function parseNative(rows = []) {
  const items = [];
  const issues = [];
  const locations = new Set();
  let section = null;
  let location = null;
  let header = null;

  rows.forEach((row = [], index) => {
    const rowNumber = index + 1;
    const first = firstNonEmpty(row);

    if (isSectionMarker(first, 'EQUIPAMENTOS')) {
      section = 'EQUIPAMENTOS';
      header = null;
      return;
    }
    if (isSectionMarker(first, 'SOBRESSALENTES')) {
      section = 'SOBRESSALENTES';
      header = null;
      return;
    }

    const locationMarker = extractLocation(row);
    if (locationMarker !== null) {
      location = locationMarker;
      locations.add(location);
      return;
    }

    if (!section) return;
    const maybeHeader = nativeHeader(section, row);
    if (maybeHeader) {
      header = maybeHeader;
      return;
    }
    if (!header) return;

    const pnRaw = row[header.pn];
    const nomenclatura = header.nomenclatura >= 0 ? text(row[header.nomenclatura]) : '';
    const pn = normalizePn(pnRaw);
    if (invalidPn(pn, nomenclatura)) {
      if (text(pnRaw) || nomenclatura) {
        issues.push({ row: rowNumber, field: 'pn', value: text(pnRaw), reason: 'Marcador inválido/duplicado do relatório; linha não importada.' });
      }
      return;
    }

    const quantidade = parseQuantity(row[header.qtd]);
    const snRaw = header.sn >= 0 ? text(row[header.sn]) : '';
    const sn = section === 'EQUIPAMENTOS' ? normalizeSn(snRaw) : null;
    if (section === 'EQUIPAMENTOS' && snRaw && !sn) {
      issues.push({ row: rowNumber, field: 'sn', value: snRaw, reason: 'SN marcador/placeholder não usado como identidade serial.' });
    }
    if (section === 'EQUIPAMENTOS' && sn && quantidade > 1) {
      issues.push({
        row: rowNumber,
        field: 'quantidade',
        value: quantidade,
        reason: 'Equipamento possui QNTD maior que 1, mas somente um SN. A quantidade documental é preservada, sem fabricar SN adicional; a divergência deve ser revisada.',
      });
    }

    const localizacao = normalizeLocation(location);
    if (localizacao === 'NÃO DEFINIDO') {
      issues.push({ row: rowNumber, field: 'localizacao', value: location, reason: 'Item sem localização física definida no relatório original.' });
    }

    items.push({
      pn,
      nsn_pi: header.pi >= 0 ? text(row[header.pi]) || 'N/A' : 'N/A',
      nomenclatura: nomenclatura || 'N/A',
      quantidade,
      localizacao,
      sn,
      source_section: section,
      source_row: rowNumber,
      source_extra: {
        lote: header.lote >= 0 ? text(row[header.lote]) || null : null,
        preco_usd: header.preco >= 0 ? parseQuantity(row[header.preco]) : null,
        sjb: header.sjb >= 0 ? text(row[header.sjb]) || null : null,
        validade: header.validade >= 0 ? text(row[header.validade]) || null : null,
      },
    });
  });

  // O relatório oficial pode conter o mesmo PN+SN em mais de uma LOC. Como SN é
  // identidade física única, não somamos duplicidades nem escolhemos uma LOC no escuro.
  // Também não fabricamos uma segunda unidade quando QNTD > 1 com apenas um SN.
  const serializedMap = new Map();
  items.forEach((item) => {
    if (item.source_section !== 'EQUIPAMENTOS' || !item.sn) return;
    const key = `${item.pn}|${String(item.sn).trim().toUpperCase()}`;
    if (!serializedMap.has(key)) serializedMap.set(key, []);
    serializedMap.get(key).push(item);
  });

  const normalizedItems = [];
  const emittedSerials = new Set();
  items.forEach((item) => {
    if (item.source_section !== 'EQUIPAMENTOS' || !item.sn) {
      normalizedItems.push(item);
      return;
    }

    const key = `${item.pn}|${String(item.sn).trim().toUpperCase()}`;
    if (emittedSerials.has(key)) return;
    emittedSerials.add(key);

    const group = serializedMap.get(key) || [item];
    const first = group[0];
    const distinctLocations = [...new Set(group.map((row) => normalizeLocation(row.localizacao)))];
    if (group.length > 1) {
      const conflict = distinctLocations.length > 1;
      issues.push({
        row: group.map((row) => row.source_row).join(','),
        field: 'sn',
        value: key,
        reason: conflict
          ? `PN+SN repetido em localizações conflitantes (${distinctLocations.join(' | ')}). Mantida uma única unidade em CONFLITO DE LOCALIZAÇÃO para revisão humana.`
          : 'PN+SN duplicado no relatório. Mantida uma única unidade para não duplicar estoque.',
      });
      normalizedItems.push({
        ...first,
        quantidade: Math.max(...group.map((row) => Number(row.quantidade || 0))),
        localizacao: conflict ? 'CONFLITO DE LOCALIZAÇÃO' : first.localizacao,
        source_extra: {
          ...first.source_extra,
          duplicate_serial_source_rows: group.map((row) => row.source_row),
          duplicate_serial_locations: distinctLocations,
          duplicate_serial_raw_quantities: group.map((row) => row.quantidade),
        },
      });
      if (conflict) locations.add('CONFLITO DE LOCALIZAÇÃO');
      return;
    }

    normalizedItems.push({
      ...first,
      quantidade: first.quantidade,
      source_extra: {
        ...first.source_extra,
        raw_qntd: first.quantidade,
      },
    });
  });

  return {
    format: 'MARINHA_PPU_GERAL_POR_LOCALIZACAO',
    items: normalizedItems,
    issues,
    locations: Array.from(locations),
  };
}

function aliasIndex(headers = [], aliases = []) {
  const allowed = aliases.map((alias) => normalized(alias));
  return headers.findIndex((cell) => {
    const candidate = normalized(cell);
    return allowed.includes(candidate);
  });
}

function findLegacyHeader(rows = []) {
  for (let i = 0; i < Math.min(rows.length, 100); i += 1) {
    const pn = aliasIndex(rows[i], ['PN', 'P/N', 'PART NUMBER', 'PART NO']);
    const qtd = aliasIndex(rows[i], ['QNTD', 'QTD', 'QTY', 'QTDE', 'QTE', 'QUANTIDADE', 'QUANTITY']);
    if (pn >= 0 && qtd >= 0) return i;
  }
  return -1;
}

function parseLegacy(rows = []) {
  const headerRow = findLegacyHeader(rows);
  if (headerRow < 0) return { format: 'DESCONHECIDO', items: [], issues: [], locations: [] };

  const headers = rows[headerRow];
  const idx = {
    pn: aliasIndex(headers, ['PN', 'P/N', 'PART NUMBER', 'PART NO']),
    qtd: aliasIndex(headers, ['QNTD', 'QTD', 'QTY', 'QTDE', 'QTE', 'QUANTIDADE', 'QUANTITY']),
    loc: aliasIndex(headers, ['LOCALIZACAO', 'LOCALIZAÇÃO', 'LOCAL', 'LOC', 'LOCATION']),
    pi: aliasIndex(headers, ['PI', 'NSN', 'NSN PI', 'NSN-PI']),
    desc: aliasIndex(headers, ['NOMENCLATURA', 'DESCRIPTION', 'DESCRICAO']),
    sn: aliasIndex(headers, ['SN', 'S/N', 'SERIAL NUMBER']),
  };

  const items = [];
  const issues = [];
  const locations = new Set();
  rows.slice(headerRow + 1).forEach((row = [], offset) => {
    const rowNumber = headerRow + offset + 2;
    const pnRaw = row[idx.pn];
    const nomenclatura = idx.desc >= 0 ? text(row[idx.desc]) : '';
    const pn = normalizePn(pnRaw);
    if (invalidPn(pn, nomenclatura)) {
      if (row.some((cell) => text(cell))) issues.push({ row: rowNumber, field: 'pn', value: text(pnRaw), reason: 'Linha sem PN válido.' });
      return;
    }
    const localizacao = idx.loc >= 0 ? normalizeLocation(row[idx.loc]) : 'NÃO DEFINIDO';
    locations.add(localizacao);
    items.push({
      pn,
      nsn_pi: idx.pi >= 0 ? text(row[idx.pi]) || 'N/A' : 'N/A',
      nomenclatura: nomenclatura || 'N/A',
      quantidade: parseQuantity(row[idx.qtd]),
      localizacao,
      sn: idx.sn >= 0 ? normalizeSn(row[idx.sn]) : null,
      source_section: idx.sn >= 0 ? 'LEGADO_COM_SN' : 'LEGADO_AGREGADO',
      source_row: rowNumber,
      source_extra: {},
    });
  });
  return { format: 'PPU_LEGADO_TABULAR', items, issues, locations: Array.from(locations) };
}

function parsePpuInventoryRows(rows = []) {
  const native = rows.some((row) => row.some((cell) => isSectionMarker(cell, 'EQUIPAMENTOS')))
    && rows.some((row) => row.some((cell) => isSectionMarker(cell, 'SOBRESSALENTES')))
    && rows.some((row) => extractLocation(row) !== null);
  return native ? parseNative(rows) : parseLegacy(rows);
}

module.exports = {
  parsePpuInventoryRows,
  parseQuantity,
  normalizeLocation,
  normalizeSn,
};
