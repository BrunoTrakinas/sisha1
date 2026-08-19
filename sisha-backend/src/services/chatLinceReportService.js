function clean(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'object') {
    try { return JSON.stringify(value); } catch (_) { return String(value); }
  }
  return String(value);
}

function safeRows(report = {}) {
  return Array.isArray(report.rows) ? report.rows : [];
}

function columnsFor(report = {}) {
  const declared = Array.isArray(report.columns) ? report.columns.filter(Boolean) : [];
  if (declared.length) return declared;
  const keys = [];
  safeRows(report).forEach((row) => Object.keys(row || {}).forEach((key) => {
    if (!keys.includes(key)) keys.push(key);
  }));
  return keys;
}

function sourceRows(report = {}) {
  return (Array.isArray(report.sources) ? report.sources : []).map((source) => ({
    Fonte: source.tabela || source.fonte || source.nome || 'Fonte SISHA',
    Motivo: source.motivo || source.finalidade || '',
    Linhas: source.linhas ?? source.quantidade ?? '',
  }));
}

function createXlsxBuffer(report = {}) {
  const xlsx = require('xlsx');
  const workbook = xlsx.utils.book_new();
  const columns = columnsFor(report);
  const rows = safeRows(report).map((row) => {
    const out = {};
    columns.forEach((column) => { out[column] = row?.[column] ?? ''; });
    return out;
  });
  const summary = [
    ['Relatório', report.title || 'Análise Chat Lince'],
    ['Pergunta', report.question || ''],
    ['Resumo', report.summary || ''],
    ['Gerado em', new Date().toISOString()],
    ['Registros', rows.length],
    ['Regra', report.rule || 'Consulta somente leitura; conclusões dependem das evidências disponíveis no SISHA.'],
  ];
  const summarySheet = xlsx.utils.aoa_to_sheet(summary);
  summarySheet['!cols'] = [{ wch: 20 }, { wch: 110 }];
  xlsx.utils.book_append_sheet(workbook, summarySheet, 'Resumo');

  const resultSheet = rows.length
    ? xlsx.utils.json_to_sheet(rows, { header: columns })
    : xlsx.utils.aoa_to_sheet([['Resultado'], [report.answer || report.summary || 'Sem linhas estruturadas.']]);
  resultSheet['!cols'] = (columns.length ? columns : ['Resultado']).map((column) => ({ wch: Math.min(42, Math.max(12, clean(column).length + 3)) }));
  xlsx.utils.book_append_sheet(workbook, resultSheet, 'Resultado');

  const sources = sourceRows(report);
  if (sources.length) {
    const sourceSheet = xlsx.utils.json_to_sheet(sources);
    sourceSheet['!cols'] = [{ wch: 34 }, { wch: 70 }, { wch: 12 }];
    xlsx.utils.book_append_sheet(workbook, sourceSheet, 'Fontes');
  }

  return xlsx.write(workbook, { type: 'buffer', bookType: 'xlsx', compression: true });
}

function wrapLine(text, max = 92) {
  const words = clean(text).replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);
  if (!words.length) return [''];
  const lines = [];
  let line = '';
  for (const word of words) {
    if (!line) line = word;
    else if (`${line} ${word}`.length <= max) line += ` ${word}`;
    else { lines.push(line); line = word; }
  }
  if (line) lines.push(line);
  return lines;
}

function pdfText(value) {
  return clean(value)
    .replace(/[–—]/g, '-')
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/[^\x09\x0A\x0D\x20-\xFF]/g, '?')
    .replace(/\\/g, '\\\\')
    .replace(/\(/g, '\\(')
    .replace(/\)/g, '\\)');
}

function reportLines(report = {}) {
  const lines = [];
  lines.push(report.title || 'Relatório Chat Lince');
  lines.push(`Gerado em: ${new Date().toLocaleString('pt-BR')}`);
  if (report.question) {
    lines.push('');
    lines.push('Pergunta:');
    lines.push(...wrapLine(report.question));
  }
  if (report.summary || report.answer) {
    lines.push('');
    lines.push('Resumo:');
    lines.push(...wrapLine(report.summary || report.answer));
  }
  const columns = columnsFor(report);
  const rows = safeRows(report);
  if (rows.length) {
    lines.push('');
    lines.push(`Resultado estruturado (${rows.length} registro(s)):`);
    rows.slice(0, 300).forEach((row, index) => {
      const pieces = columns.slice(0, 10).map((column) => `${column}: ${clean(row?.[column] ?? '')}`).filter((piece) => !piece.endsWith(': '));
      lines.push(...wrapLine(`${index + 1}. ${pieces.join(' | ')}`, 94));
    });
    if (rows.length > 300) lines.push(`... ${rows.length - 300} registro(s) adicionais disponíveis no Excel.`);
  }
  const sources = sourceRows(report);
  if (sources.length) {
    lines.push('');
    lines.push('Fontes consultadas:');
    sources.forEach((source) => lines.push(...wrapLine(`- ${source.Fonte}${source.Motivo ? `: ${source.Motivo}` : ''}`)));
  }
  lines.push('');
  lines.push(...wrapLine('Observação: relatório somente leitura. O SISHA não inventa estado, localização, prioridade ou disponibilidade quando a evidência é insuficiente.'));
  return lines;
}

function createPdfBuffer(report = {}) {
  const lines = reportLines(report);
  const pageLines = 50;
  const pages = [];
  for (let i = 0; i < lines.length; i += pageLines) pages.push(lines.slice(i, i + pageLines));
  if (!pages.length) pages.push(['Relatório Chat Lince']);

  const objects = new Map();
  objects.set(1, Buffer.from('<< /Type /Catalog /Pages 2 0 R >>', 'latin1'));
  const fontObj = 3;
  objects.set(fontObj, Buffer.from('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>', 'latin1'));

  const kids = [];
  pages.forEach((page, index) => {
    const pageObj = 4 + index * 2;
    const contentObj = pageObj + 1;
    kids.push(`${pageObj} 0 R`);
    const contentLines = ['BT', '/F1 10 Tf', '48 800 Td', '14 TL'];
    page.forEach((line, lineIndex) => {
      const prefix = lineIndex === 0 ? '' : 'T* ';
      contentLines.push(`${prefix}(${pdfText(line)}) Tj`);
    });
    contentLines.push('ET');
    const stream = Buffer.from(contentLines.join('\n'), 'latin1');
    objects.set(contentObj, Buffer.concat([
      Buffer.from(`<< /Length ${stream.length} >>\nstream\n`, 'latin1'),
      stream,
      Buffer.from('\nendstream', 'latin1'),
    ]));
    objects.set(pageObj, Buffer.from(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 ${fontObj} 0 R >> >> /Contents ${contentObj} 0 R >>`, 'latin1'));
  });
  objects.set(2, Buffer.from(`<< /Type /Pages /Kids [${kids.join(' ')}] /Count ${pages.length} >>`, 'latin1'));

  const maxObj = Math.max(...objects.keys());
  const chunks = [Buffer.from('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n', 'binary')];
  const offsets = new Array(maxObj + 1).fill(0);
  let offset = chunks[0].length;
  for (let i = 1; i <= maxObj; i += 1) {
    const body = objects.get(i) || Buffer.from('<<>>', 'latin1');
    offsets[i] = offset;
    const obj = Buffer.concat([Buffer.from(`${i} 0 obj\n`, 'latin1'), body, Buffer.from('\nendobj\n', 'latin1')]);
    chunks.push(obj);
    offset += obj.length;
  }
  const xrefOffset = offset;
  const xref = [`xref`, `0 ${maxObj + 1}`, '0000000000 65535 f '];
  for (let i = 1; i <= maxObj; i += 1) xref.push(`${String(offsets[i]).padStart(10, '0')} 00000 n `);
  const trailer = `${xref.join('\n')}\ntrailer\n<< /Size ${maxObj + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  chunks.push(Buffer.from(trailer, 'latin1'));
  return Buffer.concat(chunks);
}

function fileNameFor(report = {}, format = 'xlsx') {
  const base = clean(report.fileBase || report.title || 'Chat_Lince_Analise')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^A-Za-z0-9_-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 80) || 'Chat_Lince_Analise';
  return `${base}.${format === 'pdf' ? 'pdf' : 'xlsx'}`;
}

module.exports = {
  createXlsxBuffer,
  createPdfBuffer,
  fileNameFor,
};
