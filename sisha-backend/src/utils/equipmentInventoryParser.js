const crypto = require('crypto');
const XLSX = require('xlsx');
const { parseZipEntries } = require('./officeDocumentText');
const {
  normalizeHeader,
  normalizePn,
  findHeaderRow,
  buildIndexMap,
} = require('./importAliases');

const MAX_ROWS = 12000;

const SN_ALIASES = [
  'sn', 's/n', 'serial number', 'serial no', 'serial no.', 'serial',
  'n/s', 'numero de serie', 'número de série', 'numero serie', 'nro serie',
];

const LOCATION_ALIASES = [
  'localizacao', 'localização', 'local', 'loc', 'location', 'posicao', 'posição',
  'endereco', 'endereço', 'shelf', 'bin',
];

const CATEGORY_ALIASES = [
  'categoria', 'categoria local', 'tipo local', 'local type', 'location type',
];

const WARRANTY_ALIASES = [
  'garantia', 'data garantia', 'garantia vencimento', 'vencimento garantia',
  'warranty', 'warranty date', 'warranty expiration',
];

const OBS_ALIASES = ['observacao', 'observação', 'obs', 'comments', 'comentario', 'comentário'];

function cleanText(value) {
  const text = String(value ?? '').replace(/\u00a0/g, ' ').trim();
  return text || null;
}

function normalizeSn(value) {
  const text = cleanText(value);
  return text ? text.toUpperCase().replace(/\s+/g, '').trim() : null;
}

function normalizeCategory(value) {
  const raw = normalizeHeader(value || '');
  if (!raw) return 'PPU';
  if (raw.includes('rec')) return 'RECEX';
  if (raw.includes('ganm')) return 'GANM';
  if (raw.includes('oficina')) return 'OFICINA';
  if (raw.includes('wo')) return 'WO_EXTERIOR';
  if (raw.includes('stc')) return 'STC';
  if (raw.includes('garantia') || raw.includes('warranty')) return 'GARANTIA';
  if (raw.includes('aeronave') || raw.includes('aircraft') || raw.includes('anv')) return 'AERONAVE';
  if (raw.includes('transito') || raw.includes('trânsito')) return 'TRANSITO';
  if (raw.includes('desfaz')) return 'DESFAZIMENTO';
  if (raw.includes('ppu') || raw.includes('estoque')) return 'PPU';
  return String(value || 'PPU').trim().toUpperCase();
}

function parseDate(value) {
  if (value == null || value === '') return null;
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString().slice(0, 10);
  if (typeof value === 'number') {
    const parsed = XLSX.SSF.parse_date_code(value);
    if (parsed?.y && parsed?.m && parsed?.d) {
      return `${String(parsed.y).padStart(4, '0')}-${String(parsed.m).padStart(2, '0')}-${String(parsed.d).padStart(2, '0')}`;
    }
  }
  const text = cleanText(value);
  if (!text) return null;
  const br = text.match(/^(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{2,4})$/);
  if (br) {
    const year = br[3].length === 2 ? `20${br[3]}` : br[3];
    return `${year}-${br[2].padStart(2, '0')}-${br[1].padStart(2, '0')}`;
  }
  const iso = new Date(text);
  return Number.isNaN(iso.getTime()) ? null : iso.toISOString().slice(0, 10);
}

function rowHasContent(row = []) {
  return row.some((value) => String(value ?? '').trim() !== '');
}

function scoreSheet(rawRows = []) {
  const headerIndex = findHeaderRow(rawRows, ['pn', SN_ALIASES, LOCATION_ALIASES]);
  if (headerIndex === -1) return { headerIndex: -1, score: -1 };
  const headers = rawRows[headerIndex];
  const idx = buildIndexMap(headers, {
    pn: 'pn',
    sn: SN_ALIASES,
    localizacao: LOCATION_ALIASES,
  });
  let valid = 0;
  for (const row of rawRows.slice(headerIndex + 1, headerIndex + 501)) {
    if (!rowHasContent(row)) continue;
    if (normalizePn(row[idx.pn]) && normalizeSn(row[idx.sn]) && cleanText(row[idx.localizacao])) valid += 1;
  }
  return { headerIndex, score: valid };
}

function scoreMasterSheet(rawRows = []) {
  const headerIndex = findHeaderRow(rawRows, ['pn', SN_ALIASES]);
  if (headerIndex === -1) return { headerIndex: -1, score: -1 };
  const headers = rawRows[headerIndex];
  const idx = buildIndexMap(headers, { pn: 'pn', sn: SN_ALIASES });
  let valid = 0;
  for (const row of rawRows.slice(headerIndex + 1, headerIndex + 1001)) {
    if (!rowHasContent(row)) continue;
    if (normalizePn(row[idx.pn]) && normalizeSn(row[idx.sn])) valid += 1;
  }
  return { headerIndex, score: valid };
}

function parseMasterWorkbook(buffer, originalName = 'cadastro_mestre.xlsx') {
  const workbook = XLSX.read(buffer, { type: 'buffer', cellDates: true, dense: false });
  if (!workbook.SheetNames.length) throw new Error(`${originalName}: o arquivo não possui abas legíveis.`);

  const parsedRows = [];
  const warnings = [];
  const sheets = [];

  for (const sheetName of workbook.SheetNames) {
    const sheet = workbook.Sheets[sheetName];
    const rawRows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '', raw: true });
    const scored = scoreMasterSheet(rawRows);
    if (scored.headerIndex === -1 || scored.score <= 0) continue;

    const headers = rawRows[scored.headerIndex];
    const idx = buildIndexMap(headers, {
      pn: 'pn',
      sn: SN_ALIASES,
      localizacao: LOCATION_ALIASES,
      nomenclatura: 'nomenclatura',
      categoria: CATEGORY_ALIASES,
      garantia: WARRANTY_ALIASES,
      observacao: OBS_ALIASES,
    });

    let useful = 0;
    for (let i = scored.headerIndex + 1; i < rawRows.length; i += 1) {
      const raw = rawRows[i];
      if (!rowHasContent(raw)) continue;
      if (parsedRows.length >= MAX_ROWS) {
        warnings.push(`A leitura foi limitada às primeiras ${MAX_ROWS} linhas úteis do conjunto de arquivos.`);
        break;
      }
      const pn = normalizePn(raw[idx.pn]);
      const sn = normalizeSn(raw[idx.sn]);
      if (!pn && !sn) continue;
      const localizacao = idx.localizacao >= 0 ? cleanText(raw[idx.localizacao]) : null;
      const issues = [];
      if (!pn) issues.push('PN ausente');
      if (!sn) issues.push('SN ausente');
      if (sn && /[,;\n]/.test(sn)) issues.push('Mais de um SN na mesma célula; use uma linha por equipamento');
      parsedRows.push({
        linha_origem: i + 1,
        arquivo_origem: originalName,
        aba_origem: sheetName,
        pn,
        sn,
        localizacao: localizacao || '',
        nomenclatura: idx.nomenclatura >= 0 ? cleanText(raw[idx.nomenclatura]) || '' : '',
        categoria_destino: idx.categoria >= 0 ? normalizeCategory(raw[idx.categoria]) : (localizacao ? 'DESCONHECIDO' : 'DESCONHECIDO'),
        garantia_vencimento: idx.garantia >= 0 ? parseDate(raw[idx.garantia]) : null,
        observacao: idx.observacao >= 0 ? cleanText(raw[idx.observacao]) || '' : '',
        valido: issues.length === 0,
        problemas: issues,
      });
      useful += 1;
    }
    if (useful) sheets.push({ arquivo: originalName, aba: sheetName, linhas: useful, cabecalho_linha: scored.headerIndex + 1 });
    if (parsedRows.length >= MAX_ROWS) break;
  }

  if (!parsedRows.length) {
    throw new Error(`${originalName}: não encontrei uma tabela com PN e SN. A localização é opcional no Cadastro Mestre.`);
  }
  return { rows: parsedRows, warnings, sheets };
}

function isSupportedMasterEntry(name = '') {
  return /\.(xlsx?|xls|csv|ods)$/i.test(String(name || '')) && !String(name || '').endsWith('/');
}

function parseEquipmentMaster(buffer, originalName = 'cadastro_mestre_equipamentos') {
  const lower = String(originalName || '').toLowerCase();
  const allRows = [];
  const warnings = [];
  const sources = [];

  if (lower.endsWith('.zip')) {
    const zip = parseZipEntries(buffer);
    const entries = [...zip.entries.keys()].filter(isSupportedMasterEntry).slice(0, 50);
    if (!entries.length) throw new Error('O ZIP não contém XLSX, XLS, CSV ou ODS com o cadastro de equipamentos.');
    for (const entryName of entries) {
      const entryBuffer = zip.readEntry(entryName);
      if (!entryBuffer?.length) continue;
      try {
        const parsed = parseMasterWorkbook(entryBuffer, entryName);
        allRows.push(...parsed.rows);
        warnings.push(...parsed.warnings);
        sources.push(...parsed.sheets);
      } catch (error) {
        warnings.push(`${entryName}: ${error.message || error}`);
      }
      if (allRows.length >= MAX_ROWS) break;
    }
  } else {
    const parsed = parseMasterWorkbook(buffer, originalName);
    allRows.push(...parsed.rows);
    warnings.push(...parsed.warnings);
    sources.push(...parsed.sheets);
  }

  if (!allRows.length) throw new Error('Nenhum equipamento PN + SN foi identificado no Cadastro Mestre.');

  const seen = new Map();
  for (const row of allRows) {
    if (!row.pn || !row.sn) continue;
    const key = `${row.pn}::${row.sn}`;
    if (seen.has(key)) {
      row.valido = false;
      row.problemas = [...(row.problemas || []), `PN + SN duplicado; primeira ocorrência em ${seen.get(key)}`];
    } else {
      seen.set(key, `${row.arquivo_origem} / ${row.aba_origem} / linha ${row.linha_origem}`);
    }
  }

  const hash = crypto.createHash('sha256').update(buffer).digest('hex');
  const validCount = allRows.filter((row) => row.valido).length;
  return {
    arquivo_nome: originalName,
    arquivo_hash: hash,
    total_linhas: allRows.length,
    linhas_validas: validCount,
    linhas_invalidas: allRows.length - validCount,
    fontes: sources,
    warnings,
    rows: allRows,
  };
}

function parseEquipmentInventory(buffer, originalName = 'inventario_equipamentos.xlsx') {
  const workbook = XLSX.read(buffer, { type: 'buffer', cellDates: true, dense: false });
  if (!workbook.SheetNames.length) throw new Error('O arquivo não possui abas legíveis.');

  let chosen = null;
  for (const sheetName of workbook.SheetNames) {
    const sheet = workbook.Sheets[sheetName];
    const rawRows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '', raw: true });
    const score = scoreSheet(rawRows);
    if (!chosen || score.score > chosen.score) chosen = { sheetName, rawRows, ...score };
  }

  if (!chosen || chosen.headerIndex === -1) {
    throw new Error('Cabeçalho do inventário de equipamentos não identificado. São obrigatórios PN, SN e LOCALIZAÇÃO/LOC.');
  }

  const headers = chosen.rawRows[chosen.headerIndex];
  const idx = buildIndexMap(headers, {
    pn: 'pn',
    sn: SN_ALIASES,
    localizacao: LOCATION_ALIASES,
    nomenclatura: 'nomenclatura',
    categoria: CATEGORY_ALIASES,
    garantia: WARRANTY_ALIASES,
    observacao: OBS_ALIASES,
  });

  const rows = [];
  const seen = new Map();
  const warnings = [];
  let ignored = 0;

  for (let i = chosen.headerIndex + 1; i < chosen.rawRows.length; i += 1) {
    const raw = chosen.rawRows[i];
    if (!rowHasContent(raw)) continue;
    if (rows.length >= MAX_ROWS) {
      warnings.push(`A leitura foi limitada às primeiras ${MAX_ROWS} linhas úteis.`);
      break;
    }

    const pn = normalizePn(raw[idx.pn]);
    const sn = normalizeSn(raw[idx.sn]);
    const localizacao = cleanText(raw[idx.localizacao]);
    const issues = [];
    if (!pn) issues.push('PN ausente');
    if (!sn) issues.push('SN ausente');
    if (!localizacao) issues.push('Localização ausente');
    if (sn && /[,;\n]/.test(sn)) issues.push('Mais de um SN na mesma célula; use uma linha por equipamento');

    if (!pn && !sn && !localizacao) {
      ignored += 1;
      continue;
    }

    const key = pn && sn ? `${pn}::${sn}` : null;
    if (key && seen.has(key)) {
      issues.push(`PN + SN duplicado no arquivo; primeira ocorrência na linha ${seen.get(key)}`);
    } else if (key) {
      seen.set(key, i + 1);
    }

    rows.push({
      linha_origem: i + 1,
      pn,
      sn,
      localizacao: localizacao || '',
      nomenclatura: idx.nomenclatura >= 0 ? cleanText(raw[idx.nomenclatura]) || '' : '',
      categoria_destino: idx.categoria >= 0 ? normalizeCategory(raw[idx.categoria]) : 'PPU',
      garantia_vencimento: idx.garantia >= 0 ? parseDate(raw[idx.garantia]) : null,
      observacao: idx.observacao >= 0 ? cleanText(raw[idx.observacao]) || '' : '',
      valido: issues.length === 0,
      problemas: issues,
    });
  }

  const validCount = rows.filter((row) => row.valido).length;
  const hash = crypto.createHash('sha256').update(buffer).digest('hex');
  return {
    arquivo_nome: originalName,
    arquivo_hash: hash,
    aba: chosen.sheetName,
    cabecalho_linha: chosen.headerIndex + 1,
    total_linhas: rows.length,
    linhas_validas: validCount,
    linhas_invalidas: rows.length - validCount,
    linhas_ignoradas: ignored,
    warnings,
    rows,
  };
}

module.exports = {
  parseEquipmentInventory,
  parseEquipmentMaster,
  SN_ALIASES,
  LOCATION_ALIASES,
};
