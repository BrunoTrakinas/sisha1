const { parseOsDomain, KNOWN_AIRCRAFT_CODES, WORKSHOP_MAP } = require('./osDomainService');
const crypto = require('crypto');

function clean(value) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return text || null;
}
function upper(value) { return String(clean(value) || '').toUpperCase(); }
function normalizePn(value) { return upper(value).replace(/\s+/g, '') || null; }
function normalizeSn(value) {
  const valueUpper = upper(value);
  if (!valueUpper || ['-', 'N/A', 'NA', 'S/N', 'N/AA'].includes(valueUpper)) return null;
  if (/EXCLUIR|DUPLICAD/.test(valueUpper)) return null;
  return valueUpper.replace(/^\*+/, '').replace(/\s+/g, '') || null;
}
function excelDateToIso(value) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString().slice(0, 10);
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return new Date(Math.round((value - 25569) * 86400 * 1000)).toISOString().slice(0, 10);
  }
  const text = clean(value);
  if (!text) return null;
  const iso = text.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const br = text.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4}|\d{2})(?:$|\D)/);
  if (br) {
    const year = br[3].length === 2 ? `20${br[3]}` : br[3];
    return `${year}-${br[2].padStart(2,'0')}-${br[1].padStart(2,'0')}`;
  }
  const dt = new Date(text);
  return Number.isNaN(dt.getTime()) ? null : dt.toISOString().slice(0,10);
}
function hashBuffer(buffer) { return crypto.createHash('sha256').update(buffer).digest('hex'); }
function asRows(XLSX, workbook, sheetName) {
  return XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { header: 1, defval: '', raw: true });
}
function normalizedHeaders(row = []) { return row.map((v) => upper(v).replace(/[^A-Z0-9]+/g, ' ').trim()); }
function findIndex(headers, aliases) {
  const candidates = Array.isArray(aliases) ? aliases : [aliases];
  return headers.findIndex((h) => candidates.some((a) => h === upper(a).replace(/[^A-Z0-9]+/g, ' ').trim()));
}
function sheetObservedDate(rows = [], limit = 30) {
  for (let r = 0; r < Math.min(rows.length, limit); r += 1) {
    const row = rows[r] || [];
    const line = upper(row.join(' '));
    if (!/ULTIMA ATUALIZACAO|ÚLTIMA ATUALIZAÇÃO|ATUALIZADO EM|DATA DE ATUALIZACAO|DATA DE ATUALIZAÇÃO/.test(line)) continue;
    for (const cell of row) {
      if (cell instanceof Date || (typeof cell === 'number' && Number.isFinite(cell) && cell > 0)) {
        const parsed = excelDateToIso(cell);
        if (parsed) return parsed;
      }
      const raw = String(cell ?? '').trim();
      const br = raw.match(/(\d{1,2}\/\d{1,2}\/(?:\d{4}|\d{2}))(?:$|\D)/);
      if (br) return excelDateToIso(br[1]);
      const iso = raw.match(/(20\d{2}-\d{1,2}-\d{1,2})/);
      if (iso) return excelDateToIso(iso[1]);
    }
  }
  return null;
}
function locationCategory(local) {
  const text = upper(local);
  const aircraft = text.match(/(?:^|N[-\s]*)(4001|4003|4004|4005|4010|4012)(?:$|\b)/);
  if (aircraft) return { categoria: 'AERONAVE', aeronave: aircraft[1] };
  if (text.includes('CEIMSPA')) return { categoria: 'CEIMSPA', aeronave: null };
  if (text.includes('RECEX')) return { categoria: 'RECEX', aeronave: null };
  if (/GRFLINX|EXTERIOR|LEONARDO|TERCEIR/.test(text)) return { categoria: 'EXTERNO', aeronave: null };
  if (/BANCADA|OFICINA|GERENCIA|GERÊNCIA|DAA/.test(text)) return { categoria: 'OFICINA', aeronave: null };
  return { categoria: 'OUTRO', aeronave: null };
}
function situationCondition(situation) {
  const text = upper(situation);
  if (/AGUARDANDO REPARO|\bWO\b|REPARO/.test(text)) return 'AGUARDANDO_REPARO';
  if (/PRONTO USO|PRONTO PARA USO|SERVICEABLE/.test(text)) return 'PRONTO_USO';
  if (/PADRAO DA BANCADA|PADRÃO DA BANCADA|BANCADA/.test(text)) return 'BANCADA';
  if (/CONDEN|LIXO|IRREPAR/.test(text)) return 'CONDENADO';
  if (/EXTERIOR/.test(text)) return 'EXTERNO';
  return 'A_CONFIRMAR';
}

function parseCriticalEquipmentWorkbook(XLSX, workbook) {
  const items = [];
  const issues = [];
  for (const sheetName of workbook.SheetNames || []) {
    const rows = asRows(XLSX, workbook, sheetName);
    const observedDate = sheetObservedDate(rows);
    let headerRow = -1;
    let idx = null;
    for (let r = 0; r < rows.length; r += 1) {
      const headers = normalizedHeaders(rows[r]);
      const pn = findIndex(headers, ['PART NUMBER', 'PN', 'P N']);
      const sn = findIndex(headers, ['SERIAL NUMBER', 'SN', 'S N']);
      const sit = findIndex(headers, ['SITUACAO', 'SITUAÇÃO']);
      const loc = findIndex(headers, ['LOCAL', 'LOCALIZACAO', 'LOCALIZAÇÃO']);
      if (pn >= 0 && sn >= 0 && sit >= 0 && loc >= 0) {
        headerRow = r; idx = { pn, sn, sit, loc }; break;
      }
    }
    if (headerRow < 0) continue;
    let blanks = 0;
    for (let r = headerRow + 1; r < rows.length; r += 1) {
      const row = rows[r] || [];
      const pn = normalizePn(row[idx.pn]);
      const sn = normalizeSn(row[idx.sn]);
      const situation = clean(row[idx.sit]);
      const local = clean(row[idx.loc]);
      if (!pn && !sn && !situation && !local) { blanks += 1; if (blanks >= 4) break; continue; }
      blanks = 0;
      if (!pn || !sn) {
        if (pn || sn || situation || local) issues.push({ sheet: sheetName, row: r + 1, reason: 'PN+SN incompleto; linha preservada apenas como pendência de revisão.' });
        continue;
      }
      const cat = locationCategory(local);
      items.push({
        pn, sn, situation: situation || 'A_CONFIRMAR', local: local || null,
        categoria: cat.categoria, aeronave: cat.aeronave,
        condicao: situationCondition(situation), source_sheet: sheetName, source_row: r + 1,
        source_observed_at: observedDate,
      });
    }
  }
  const seen = new Set();
  const deduped = [];
  for (const item of items) {
    const key = `${item.pn}::${item.sn}::${upper(item.local)}::${upper(item.situation)}`;
    if (seen.has(key)) continue;
    seen.add(key); deduped.push(item);
  }
  return { type: 'CONTROLE_EQUIPAMENTOS_CRITICOS', items: deduped, issues, summary: { items: deduped.length, sheets: new Set(deduped.map(i=>i.source_sheet)).size, issues: issues.length } };
}

function parsePpuOutputMovementWorkbook(XLSX, workbook) {
  const sheetName = (workbook.SheetNames || [])[0];
  const rows = sheetName ? asRows(XLSX, workbook, sheetName) : [];
  let headerRow = -1; let idx = null;
  for (let r = 0; r < Math.min(rows.length, 80); r += 1) {
    const headers = normalizedHeaders(rows[r]);
    const pim = findIndex(headers, ['NUMERO PEDIDO', 'NÚMERO PEDIDO']);
    const date = findIndex(headers, ['DATA PEDIDO']);
    const pn = findIndex(headers, ['PART NUMER', 'PART NUMBER', 'PN']);
    const sn = findIndex(headers, ['SERIAL NUMER', 'SERIAL NUMBER', 'SN']);
    const os = findIndex(headers, ['NUMERO OS', 'NÚMERO OS', 'OS']);
    const readyDate = findIndex(headers, ['DATA PRONTO']);
    const receiver = findIndex(headers, ['RECEBEDOR']);
    if (pim >= 0 && date >= 0 && pn >= 0 && sn >= 0 && os >= 0) { headerRow = r; idx = {pim,date,pn,sn,os,readyDate,receiver}; break; }
  }
  if (headerRow < 0) return { type:'SAIDA_MOVIMENTACAO_PPU', items:[], issues:[{reason:'Cabeçalho do relatório de Saída do PPU não reconhecido.'}], summary:{items:0,issues:1} };
  const items=[]; const issues=[];
  for (let r=headerRow+1;r<rows.length;r+=1) {
    const row=rows[r]||[];
    const pn=normalizePn(row[idx.pn]); const sn=normalizeSn(row[idx.sn]); const date=excelDateToIso(row[idx.date]);
    const pim=clean(row[idx.pim]); const os=clean(row[idx.os]); const readyDate=idx.readyDate>=0?excelDateToIso(row[idx.readyDate]):null; const receiver=idx.receiver>=0?clean(row[idx.receiver]):null;
    if (!pn && !sn && !pim && !os) continue;
    if (!pn || !sn || !date) { issues.push({row:r+1,reason:'Linha sem PN+SN+data suficientes para histórico serializado.'}); continue; }
    items.push({pn,sn,data:date,data_pronto:readyDate,pim,os,receiver,source_row:r+1});
  }
  return { type:'SAIDA_MOVIMENTACAO_PPU', items, issues, summary:{items:items.length,issues:issues.length} };
}


const MASTER_OS_DERIVED_SHEETS = new Set(['BD_MASTER', 'CORRETIVAS', 'PREVENTIVAS']);

function normalizeOsNumber(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return String(Math.trunc(value));
  const text = upper(value).replace(/\s+/g, '');
  return text ? text.replace(/\.0$/, '') : null;
}

function masterOsDate(value) {
  const parsed = excelDateToIso(value);
  if (parsed) return parsed;
  const text = String(value ?? '').trim();
  const compact = text.match(/^(\d{2})(\d{2})\/(\d{4})$/);
  if (compact) {
    const [, dd, mm, yyyy] = compact;
    const day = Number(dd); const month = Number(mm);
    if (day >= 1 && day <= 31 && month >= 1 && month <= 12) return `${yyyy}-${mm}-${dd}`;
  }
  return null;
}

function findMasterOsHeader(rows = []) {
  for (let r = 0; r < Math.min(rows.length, 30); r += 1) {
    const headers = normalizedHeaders(rows[r]);
    const numero = findIndex(headers, ['NUMERO', 'NÚMERO']);
    const saida = findIndex(headers, ['SAIDA', 'SAÍDA']);
    const discrepancia = findIndex(headers, ['DISCREPANCIA', 'DISCREPÂNCIA']);
    if (numero >= 0 && saida >= 0 && discrepancia >= 0) {
      return {
        row: r,
        indexes: {
          numero,
          saida,
          sit: findIndex(headers, ['SIT']),
          destino: findIndex(headers, ['DESTINO']),
          discrepancia,
          entrada: findIndex(headers, ['ENTRADA']),
          responsavel: findIndex(headers, ['RESPONSAVEL', 'RESPONSÁVEL']),
          inspecao: findIndex(headers, ['INSPECAO', 'INSPEÇÃO']),
          pane: findIndex(headers, ['PANE']),
          hora_a: findIndex(headers, ['HORA A', 'HORA/A']),
          hora_f: findIndex(headers, ['HORA F', 'HORA/F']),
          horas_t: findIndex(headers, ['HORAS T', 'HORAS/T']),
          hv: findIndex(headers, ['HV']),
        },
      };
    }
  }
  return null;
}

function masterOsSheetMatchesDomain(sheetName, domain) {
  const sheet = upper(sheetName).replace(/\s+/g, '');
  if (KNOWN_AIRCRAFT_CODES.includes(sheet)) return domain?.tipo === 'ANV' && domain?.codigo === sheet;
  if (Object.prototype.hasOwnProperty.call(WORKSHOP_MAP, sheet)) return domain?.tipo === 'OFICINA' && domain?.codigo === sheet;
  return true;
}


function normalizeMasterMarkerToken(value, { sn = false } = {}) {
  const raw = String(value ?? '').trim().toUpperCase()
    .replace(/[),.;:]+$/g, '')
    .replace(/^[(*]+/g, '');
  if (!raw) return null;
  if (sn) return normalizeSn(raw);
  return normalizePn(raw);
}

function uniqueMasterTokens(values = [], options = {}) {
  const seen = new Set();
  const out = [];
  for (const value of values) {
    const normalized = normalizeMasterMarkerToken(value, options);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
  }
  return out;
}

function parseMasterOsMovementEvidence(description) {
  const raw = String(description ?? '');
  const normalized = upper(raw);
  const remove = /\b(?:REMOVER|REMO[CÇ][AÃ]O|RETIRAR|RETIRADA|DESINSTALAR|DESINSTALA[CÇ][AÃ]O)\b/.test(normalized);
  const install = /\b(?:INSTALAR|INSTALA[CÇ][AÃ]O|MONTAR|MONTAGEM)\b/.test(normalized);
  const cancelled = /\bCANCELAD[AO]\b/.test(normalized);
  const pns = [];
  const sns = [];

  const pnRegex = /(?:P\s*\/?\s*N|PART\s*NUMBER)\s*[:#-]?\s*([A-Z0-9][A-Z0-9./_-]{1,39})/gi;
  const snRegex = /(?:S\s*\/?\s*N|SERIAL(?:\s+NUMBER)?|SN)\s*[:#-]?\s*([A-Z0-9][A-Z0-9-]*(?:\s+\d{2,})?)/gi;
  let match;
  while ((match = pnRegex.exec(raw)) !== null) pns.push(match[1]);
  while ((match = snRegex.exec(raw)) !== null) sns.push(match[1]);

  const explicitPns = uniqueMasterTokens(pns);
  const explicitSns = uniqueMasterTokens(sns, { sn: true });
  const ambiguousVerb = remove && install;
  const tipo = ambiguousVerb ? 'AMBIGUO' : remove ? 'REMOCAO' : install ? 'INSTALACAO' : null;

  return {
    detectado: Boolean(tipo),
    tipo,
    cancelado_no_texto: cancelled,
    ambiguo: ambiguousVerb,
    pns_explicitos: explicitPns,
    sns_explicitos: explicitSns,
    possui_identidade_explicita: explicitPns.length > 0 || explicitSns.length > 0,
  };
}

function comparableMasterOs(item = {}) {
  return JSON.stringify({
    os: item.os_numero_normalizado,
    ano: item.os_ano,
    data_abertura: item.data_abertura,
    situacao: item.situacao,
    destino: item.destino,
    descricao: item.descricao,
    data_fechamento: item.data_fechamento,
    responsavel: item.responsavel,
    tipo_inspecao: item.tipo_inspecao,
    pane: item.pane,
    status_evidencia: item.status_evidencia,
  });
}

function parseMasterOsWorkbook(XLSX, workbook) {
  const candidates = [];
  const issues = [];
  const recognizedSheets = [];
  const ignoredSheets = [];

  for (const sheetName of workbook.SheetNames || []) {
    const normalizedSheet = upper(sheetName).replace(/\s+/g, '_');
    if (MASTER_OS_DERIVED_SHEETS.has(normalizedSheet)) {
      ignoredSheets.push(sheetName);
      continue;
    }
    const rows = asRows(XLSX, workbook, sheetName);
    const header = findMasterOsHeader(rows);
    if (!header) {
      if (rows.some((row) => (row || []).some((cell) => clean(cell)))) ignoredSheets.push(sheetName);
      continue;
    }
    recognizedSheets.push(sheetName);
    const i = header.indexes;
    for (let r = header.row + 1; r < rows.length; r += 1) {
      const row = rows[r] || [];
      const osNumero = normalizeOsNumber(row[i.numero]);
      const descricao = clean(row[i.discrepancia]);
      const abertura = i.saida >= 0 ? masterOsDate(row[i.saida]) : null;
      const fechamento = i.entrada >= 0 ? masterOsDate(row[i.entrada]) : null;
      // As abas operacionais mantêm fórmulas/modelos pré-preenchidos abaixo da última OS
      // real (ex.: SIT=R, DESTINO=VN, INSPEÇÃO=CORRETIVA, PANE=ECU CODxxx).
      // Esses valores de template não são uma OS nem uma pendência. Só uma linha sem
      // número vira pendência quando há evidência substantiva de uma OS real: data,
      // discrepância ou responsável preenchido.
      const hasSubstantiveEvidence = Boolean(descricao || abertura || fechamento ||
        (i.responsavel >= 0 && clean(row[i.responsavel])));
      const hasSupportingEvidence = [i.sit, i.destino, i.inspecao, i.pane]
        .some((idx) => idx >= 0 && clean(row[idx]));
      if (!osNumero && !hasSubstantiveEvidence) continue;
      if (!osNumero) {
        issues.push({ severity: 'BLOCK', imported: false, sheet: sheetName, row: r + 1, reason: 'OS ausente em linha com evidência operacional substantiva; linha preservada apenas como pendência e não importada.' });
        continue;
      }
      if (!hasSubstantiveEvidence && !hasSupportingEvidence) {
        issues.push({ severity: 'BLOCK', imported: false, sheet: sheetName, row: r + 1, os: osNumero, reason: 'Linha possui somente o número da OS, sem evidência operacional suficiente.' });
        continue;
      }
      const domain = parseOsDomain(osNumero);
      if (!masterOsSheetMatchesDomain(sheetName, domain)) {
        issues.push({
          severity: 'BLOCK', imported: false,
          sheet: sheetName,
          row: r + 1,
          os: osNumero,
          reason: `Prefixo/domínio da OS (${domain?.codigo || domain?.descricao || 'não reconhecido'}) diverge da aba ${sheetName}; importação bloqueada para não atribuir a OS à aeronave/oficina errada.`,
        });
        continue;
      }
      const yearSource = abertura || fechamento;
      if (!yearSource) {
        issues.push({ severity: 'BLOCK', imported: false, sheet: sheetName, row: r + 1, os: osNumero, reason: 'OS sem data de saída/entrada utilizável; ano canônico não pôde ser determinado.' });
        continue;
      }
      const osAno = Number(String(yearSource).slice(0, 4));
      const cronologiaConsistente = !(abertura && fechamento && fechamento < abertura);
      if (!cronologiaConsistente) {
        issues.push({
          severity: 'WARNING', imported: true, sheet: sheetName, row: r + 1, os: osNumero,
          reason: `Data de entrada (${fechamento}) é anterior à data de saída (${abertura}). A evidência original será preservada sem corrigir datas automaticamente.`,
        });
      }
      const movimento = parseMasterOsMovementEvidence(descricao);
      const cancelled = movimento.cancelado_no_texto;
      const status = cancelled ? 'CANCELADA' : fechamento ? 'FECHADA' : 'ABERTA';
      candidates.push({
        os_numero: String(row[i.numero] ?? osNumero).trim(),
        os_numero_normalizado: osNumero,
        os_ano: osAno,
        dominio_tipo: domain?.tipo || 'OUTROS',
        dominio_codigo: domain?.codigo || null,
        dominio_descricao: domain?.descricao || null,
        dominio_historico: Boolean(domain?.historica),
        fonte_dominio: String(sheetName).trim(),
        data_abertura: abertura,
        situacao: i.sit >= 0 ? clean(row[i.sit]) : null,
        destino: i.destino >= 0 ? clean(row[i.destino]) : null,
        descricao,
        data_fechamento: fechamento,
        responsavel: i.responsavel >= 0 ? clean(row[i.responsavel]) : null,
        tipo_inspecao: i.inspecao >= 0 ? clean(row[i.inspecao]) : null,
        pane: i.pane >= 0 ? clean(row[i.pane]) : null,
        hora_abertura: i.hora_a >= 0 ? row[i.hora_a] || null : null,
        hora_fechamento: i.hora_f >= 0 ? row[i.hora_f] || null : null,
        horas_total: i.horas_t >= 0 ? row[i.horas_t] || null : null,
        hv_total: i.hv >= 0 ? row[i.hv] || null : null,
        status_evidencia: status,
        cronologia_consistente: cronologiaConsistente,
        movimento,
        source_sheet: sheetName,
        source_row: r + 1,
      });
    }
  }

  const byIdentity = new Map();
  const conflicts = new Set();
  for (const item of candidates) {
    const identity = `${item.os_numero_normalizado}::${item.os_ano}`;
    const previous = byIdentity.get(identity);
    if (!previous) {
      byIdentity.set(identity, item);
      continue;
    }
    if (comparableMasterOs(previous) === comparableMasterOs(item)) continue;
    conflicts.add(identity);
    issues.push({
      severity: 'BLOCK', imported: false,
      sheet: item.source_sheet,
      row: item.source_row,
      os: item.os_numero_normalizado,
      reason: `A mesma OS/ano aparece com conteúdo conflitante em mais de uma linha/aba (${previous.source_sheet}:${previous.source_row} e ${item.source_sheet}:${item.source_row}). Nenhuma das versões conflitantes foi promovida automaticamente.`,
    });
  }
  conflicts.forEach((identity) => byIdentity.delete(identity));
  const items = [...byIdentity.values()];
  const blockingIssues = issues.filter((issue) => issue.severity !== 'WARNING' && issue.imported !== true).length;
  const warnings = issues.filter((issue) => issue.severity === 'WARNING' || issue.imported === true).length;
  const counts = items.reduce((acc, item) => {
    acc[item.status_evidencia] = (acc[item.status_evidencia] || 0) + 1;
    const type = upper(item.tipo_inspecao) || 'SEM_CLASSIFICACAO';
    acc.inspecoes[type] = (acc.inspecoes[type] || 0) + 1;
    if (item.movimento?.detectado) {
      acc.movimentos_detectados += 1;
      if (item.movimento.tipo === 'REMOCAO') acc.remocoes_detectadas += 1;
      if (item.movimento.tipo === 'INSTALACAO') acc.instalacoes_detectadas += 1;
      if (item.status_evidencia === 'FECHADA') acc.movimentos_fechados += 1;
      if (item.status_evidencia === 'ABERTA') acc.movimentos_abertos += 1;
      if (item.status_evidencia === 'CANCELADA') acc.movimentos_cancelados += 1;
    }
    return acc;
  }, {
    ABERTA: 0, FECHADA: 0, CANCELADA: 0, inspecoes: {},
    movimentos_detectados: 0, remocoes_detectadas: 0, instalacoes_detectadas: 0,
    movimentos_fechados: 0, movimentos_abertos: 0, movimentos_cancelados: 0,
  });

  return {
    type: 'MASTER_OS',
    items,
    issues,
    summary: {
      sheets_total: (workbook.SheetNames || []).length,
      sheets_recognized: recognizedSheets.length,
      sheets_recognized_names: recognizedSheets,
      sheets_ignored: ignoredSheets.length,
      sheets_ignored_names: ignoredSheets,
      rows_importable: items.length,
      issues: issues.length,
      blocking_issues: blockingIssues,
      warnings,
      conflicts: conflicts.size,
      abertas: counts.ABERTA || 0,
      fechadas: counts.FECHADA || 0,
      canceladas: counts.CANCELADA || 0,
      por_inspecao: counts.inspecoes,
      movimentos_detectados: counts.movimentos_detectados,
      remocoes_detectadas: counts.remocoes_detectadas,
      instalacoes_detectadas: counts.instalacoes_detectadas,
      movimentos_fechados: counts.movimentos_fechados,
      movimentos_abertos: counts.movimentos_abertos,
      movimentos_cancelados: counts.movimentos_cancelados,
      derived_sheets_policy: 'BD_MASTER/CORRETIVAS/PREVENTIVAS não são importadas; o SISHA lê as abas operacionais de origem para evitar duplicação/derivação.',
    },
  };
}

module.exports = {
  normalizePn, normalizeSn, excelDateToIso, hashBuffer, sheetObservedDate, locationCategory, situationCondition,
  parseCriticalEquipmentWorkbook, parsePpuOutputMovementWorkbook, parseMasterOsWorkbook, parseMasterOsMovementEvidence, normalizeOsNumber, masterOsDate,
};
