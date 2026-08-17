function safeNumber(value, fallback = 0) {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
}

function cleanText(value) {
  return value == null ? '' : String(value).replace(/\r?\n/g, ' ').trim();
}

/**
 * Reconstrói a ordem visual de uma página PDF a partir das coordenadas do pdf.js.
 * O pdf-parse padrão percorre a ordem interna dos objetos do PDF; em tabelas Leonardo
 * isso pode virar ordem por coluna (1,2,3... antes dos PNs). Aqui agrupamos por Y e
 * ordenamos por X, produzindo linhas visuais antes de qualquer interpretação comercial.
 */
function reconstructPdfLayoutFromItems(items = [], { yTolerance = 2.5 } = {}) {
  const tokens = (Array.isArray(items) ? items : [])
    .map((item) => ({
      text: cleanText(item?.str),
      x: safeNumber(item?.transform?.[4]),
      y: safeNumber(item?.transform?.[5]),
    }))
    .filter((item) => item.text)
    .sort((a, b) => (Math.abs(b.y - a.y) > yTolerance ? b.y - a.y : a.x - b.x));

  const rows = [];
  for (const token of tokens) {
    let row = rows.find((candidate) => Math.abs(candidate.y - token.y) <= yTolerance);
    if (!row) {
      row = { y: token.y, tokens: [] };
      rows.push(row);
    }
    row.tokens.push(token);
  }

  rows.sort((a, b) => b.y - a.y);
  return rows
    .map((row) => row.tokens
      .sort((a, b) => a.x - b.x)
      .map((token) => token.text)
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim())
    .filter(Boolean)
    .join('\n');
}

async function renderPdfPageWithLayout(pageData) {
  const textContent = await pageData.getTextContent({
    normalizeWhitespace: false,
    disableCombineTextItems: false,
  });
  // \f garante que o parser comercial preserve a fronteira de página.
  return `${reconstructPdfLayoutFromItems(textContent?.items || [])}\n\f`;
}

function looksLikeLeonardoQuotationHeader(text = '', fileName = '') {
  const source = `${fileName}\n${text}`.toUpperCase();
  return /\bLEONARDO\s+UK\s+LTD\b/.test(source)
    && /\bQUOTATION\b/.test(source)
    && /(NUMBER\/DATE|DOC\.\s*NO\.\/DATE)/.test(source)
    && /REFERENCE\s+NO\.\/DATE/.test(source);
}

module.exports = {
  reconstructPdfLayoutFromItems,
  renderPdfPageWithLayout,
  looksLikeLeonardoQuotationHeader,
};
