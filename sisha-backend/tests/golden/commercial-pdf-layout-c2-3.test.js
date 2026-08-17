const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  reconstructPdfLayoutFromItems,
  renderPdfPageWithLayout,
  looksLikeLeonardoQuotationHeader,
} = require('../../src/services/pdfLayoutTextService');
const {
  classifyCommercialDocument,
  parseLeonardoQuotation,
} = require('../../src/services/commercialDocumentDeterministicService');

const ROOT = path.join(__dirname, '..', '..');

function token(str, x, y) {
  return { str, transform: [1, 0, 0, 1, x, y] };
}

test('C2.3: reconstrução PDF ordena por linha visual Y e depois por coluna X', () => {
  // Ordem interna propositalmente por coluna, reproduzindo o comportamento visto no smoke.
  const items = [
    token('1', 10, 500), token('2', 10, 400),
    token('WG0069-0092-049', 90, 500), token('WG1373-0201-101', 90, 400),
    token('BONDING LEAD ASSY', 260, 500), token('M16 ADAPTOR', 260, 400),
  ];
  const text = reconstructPdfLayoutFromItems(items);
  assert.match(text, /^1 WG0069-0092-049 BONDING LEAD ASSY\n2 WG1373-0201-101 M16 ADAPTOR$/);
});

test('C2.3: renderer preserva fronteira de página para o parser comercial', async () => {
  const page = {
    getTextContent: async () => ({ items: [token('Quotation', 20, 700), token('1', 20, 600), token('PN-001', 100, 600)] }),
  };
  const text = await renderPdfPageWithLayout(page);
  assert.match(text, /Quotation\n1 PN-001\n\f$/);
});

test('C2.3: cabeçalho Leonardo é reconhecido mesmo quando a tabela ainda está em ordem interna ruim', () => {
  const raw = `Leonardo UK Ltd\nQuotation\nNumber/Date\n20568441 / 07.04.2026\nReference no./Date\nQ2026-HA-004 / 07.04.2026\n1\n2\n3\nWG0069-0092-049`;
  assert.equal(looksLikeLeonardoQuotationHeader(raw, '20568441.pdf'), true);
});

test('C2.3: texto reconstruído em layout volta a produzir itens por linha sem cruzar PN e preço', () => {
  const layout = `Leonardo UK Ltd\nQuotation\nNumber/Date\n20568441 / 07.04.2026\nReference no./Date\nQ2026-HA-004 / 07.04.2026\nValidity period\n07.04.2026 to 28.02.2027\nTerms of payment Within 30 days without deduction\nTerms of delivery DAP Brazilian Navy Bonded Store\nItem Material Description\nReference Lead Time\nQty Price Value\n1 WG0069-0092-049 BONDING LEAD ASSY\n6150-99-614-1741 53\nAvailable Stock Quantity 50.00\n50.000 N 285.93 14,296.50\n2 WG1373-0201-101 M16 ADAPTOR\n4730-99-717-4927 29\nAvailable Stock Quantity 4.00\n36.000 N 985.98 35,495.28\nItems total 49,791.78\nPacking & Delivery 0.000 % 49,791.78 0.00\nFinal amount 49,791.78\n`;
  assert.equal(classifyCommercialDocument(layout, '20568441.pdf'), 'LEONARDO_QUOTATION');
  const parsed = parseLeonardoQuotation(layout, '20568441.pdf');
  assert.equal(parsed.items.length, 2);
  assert.equal(parsed.items[0].pn, 'WG0069-0092-049');
  assert.equal(parsed.items[0].qtd_solicitada, 50);
  assert.equal(parsed.items[0].valor_unitario, 285.93);
  assert.equal(parsed.items[1].pn, 'WG1373-0201-101');
  assert.equal(parsed.items[1].valor_unitario, 985.98);
});

test('C2.3: runtime usa pagerender por coordenadas antes de interpretar Quotation Leonardo', () => {
  const parser = fs.readFileSync(path.join(ROOT, 'src', 'services', 'rfqParserService.js'), 'utf8');
  assert.match(parser, /pagerender:\s*renderPdfPageWithLayout/);
  assert.match(parser, /PDF_LAYOUT_COORDENADAS/);
  assert.match(parser, /looksLikeLeonardoQuotationHeader/);
});

test('C2.3: se reconstrução visual falhar, cabeçalho Leonardo continua fail-closed e nunca vira genérico', () => {
  const parser = fs.readFileSync(path.join(ROOT, 'src', 'services', 'rfqParserService.js'), 'utf8');
  assert.match(parser, /looksLikeLeonardoQuotation\(text, fileName\) \|\| looksLikeLeonardoQuotationHeader\(text, fileName\)/);
  assert.match(parser, /DETERMINISTICO_BLOQUEADO/);
});

test('C2.3+: versão atual continua invalidando cache antigo e permanece sincronizada entre backend/frontend', () => {
  const jobs = fs.readFileSync(path.join(ROOT, 'src', 'services', 'rfqImportJobService.js'), 'utf8');
  const frontend = fs.readFileSync(path.join(ROOT, '..', 'sisha-frontend', 'src', 'components', 'RfqImporter.jsx'), 'utf8');

  const backendVersion = jobs.match(/const ANALYSIS_VERSION = '([^']+)'/)?.[1] || null;
  const frontendVersion = frontend.match(/const CURRENT_ANALYSIS_VERSION = '([^']+)'/)?.[1] || null;

  assert.ok(backendVersion, 'Backend deve declarar ANALYSIS_VERSION.');
  assert.ok(frontendVersion, 'Frontend deve declarar CURRENT_ANALYSIS_VERSION.');
  assert.equal(frontendVersion, backendVersion, 'Backend e frontend devem invalidar/reabrir exatamente a mesma versão de análise.');
  assert.notEqual(backendVersion, 'C2.6-SCANNED-REPAIR-LIVE-FALLBACK-1', 'A versão C2.6 não pode voltar após a evolução do pipeline.');
});
