const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  classifyCommercialDocument,
  parseLeonardoQuotation,
} = require('../../src/services/commercialDocumentDeterministicService');

const ROOT = path.join(__dirname, '..', '..');
const fixture = (name) => fs.readFileSync(path.join(__dirname, 'fixtures', 'commercial', name), 'utf8');
const q1 = fixture('leonardo-20568441.txt');
const q2 = fixture('leonardo-20570270.txt');

function byItem(result, num) {
  return result.items.find((row) => Number(row.item_num) === Number(num));
}

test('C2.2: fixture real 20568441 é reconhecida como Leonardo Quotation sem depender de IA', () => {
  assert.equal(classifyCommercialDocument(q1, '20568441.pdf'), 'LEONARDO_QUOTATION');
});

test('C2.2: Quotation real preserva exatamente 23 itens e numeração 1..23', () => {
  const result = parseLeonardoQuotation(q1, '20568441.pdf');
  assert.equal(result.items.length, 23);
  assert.deepEqual(result.items.map((x) => x.item_num), Array.from({ length: 23 }, (_, i) => i + 1));
  assert.equal(result.metadados.expected_item_count, 23);
  assert.equal(result.metadados.parsed_item_count, 23);
});

test('C2.2: item 1 mantém PN, NSN, 53 semanas, qtd 50, estoque 50 e £285.93', () => {
  const item = byItem(parseLeonardoQuotation(q1), 1);
  assert.equal(item.pn, 'WG0069-0092-049');
  assert.equal(item.material_reference, '6150-99-614-1741');
  assert.equal(item.nsn, '6150-99-614-1741');
  assert.equal(item.lead_time_original, '53 WEEK(S)');
  assert.equal(item.lead_time, 371);
  assert.equal(item.qtd_solicitada, 50);
  assert.equal(item.estoque_pronto, 50);
  assert.equal(item.valor_unitario, 285.93);
  assert.equal(item.valor_total_item, 14296.5);
});

test('C2.2: item 2 não mistura preço, lead time ou dados de outro item', () => {
  const item = byItem(parseLeonardoQuotation(q1), 2);
  assert.equal(item.pn, 'WG1373-0201-101');
  assert.equal(item.nomenclatura, 'M16 ADAPTOR');
  assert.equal(item.material_reference, '4730-99-717-4927');
  assert.equal(item.lead_time_original, '29 WEEK(S)');
  assert.equal(item.lead_time, 203);
  assert.equal(item.qtd_solicitada, 36);
  assert.equal(item.estoque_pronto, 4);
  assert.equal(item.valor_unitario, 985.98);
  assert.equal(item.valor_total_item, 35495.28);
});

test('C2.2: preços com separador de milhar não sofrem queda de fator 1000', () => {
  const result = parseLeonardoQuotation(q1);
  assert.equal(byItem(result, 11).valor_unitario, 1372.24);
  assert.equal(byItem(result, 12).valor_unitario, 4051.20);
  assert.equal(byItem(result, 13).valor_unitario, 1985.09);
  assert.equal(byItem(result, 14).valor_unitario, 2126.72);
});

test('C2.2: Under Investigation pode coexistir com preço e permanece separado da situação financeira', () => {
  const item = byItem(parseLeonardoQuotation(q1), 12);
  assert.equal(item.price_status, 'UNDER_INVESTIGATION');
  assert.equal(item.valor_unitario, 4051.20);
  assert.equal(item.valor_total_item, 16204.80);
});

test('C2.2: referência compacta do item 21 é preservada e NSN normalizado não é rotulado como documental', () => {
  const item = byItem(parseLeonardoQuotation(q1), 21);
  assert.equal(item.material_reference, '3120-999748864');
  assert.equal(item.nsn, '3120-99-974-8864');
  assert.equal(item.material_reference_status, 'NSN_NORMALIZADO');
  assert.equal(item.lead_time_original, '37 WEEK(S)');
  assert.equal(item.lead_time, 259);
  assert.equal(item.valor_unitario, 1436.90);
});

test('C2.2: item 19 preserva placeholder e correção documental de formato sem virar alternativo', () => {
  const item = byItem(parseLeonardoQuotation(q1), 19);
  assert.equal(item.material_reference, '8888-88-888-8888');
  assert.equal(item.nsn, '');
  assert.equal(item.material_reference_status, 'PLACEHOLDER');
  assert.equal(item.pn, 'JMP/PRA/4933/4');
  assert.equal(item.pn_original_solicitado, 'JMP/PR/A/4933/4');
  assert.equal(item.correcao_pn_tipo, 'FORMAT_CORRECTION');
  assert.equal(item.tipo_relacao_pn, undefined);
});

test('C2.2: descrições ausentes nos itens 20, 22 e 23 ficam explicitamente ausentes e não são inventadas', () => {
  const result = parseLeonardoQuotation(q1);
  [20, 22, 23].forEach((num) => {
    const item = byItem(result, num);
    assert.equal(item.nomenclatura, '');
    assert.equal(item.source_description_status, 'SOURCE_MISSING');
  });
  assert.equal(result.metadados.quality_status, 'REVIEW');
  assert.ok(result.metadados.quality_warnings.some((w) => /Item 20: descrição/i.test(w)));
});

test('C2.2: data de impressão e ressalva de estoque são separadas da data/validade comercial', () => {
  const result = parseLeonardoQuotation(q1);
  assert.equal(result.metadados.quotation_date, '07/04/2026');
  assert.equal(result.metadados.quotation_printed_date, '12/05/2026');
  assert.equal(result.metadados.validity, '07/04/2026 a 28/02/2027');
  assert.match(result.metadados.stock_availability_note, /não garante disponibilidade/i);
  assert.equal(result.metadados.condicao, '');
});

test('C2.2: totais da cotação real fecham e permanecem em GBP sem conversão', () => {
  const result = parseLeonardoQuotation(q1);
  assert.equal(result.metadados.items_total, 95646.42);
  assert.equal(result.metadados.packing_delivery_percent, 3.5);
  assert.equal(result.metadados.packing_delivery_value, 3347.62);
  assert.equal(result.metadados.final_amount, 98994.04);
  assert.equal(result.metadados.moeda, 'GBP');
});

test('C2.2: segunda Quotation real mantém 4/4 itens e PN numérico 203728', () => {
  const result = parseLeonardoQuotation(q2, '20570270.pdf');
  assert.equal(result.items.length, 4);
  assert.equal(byItem(result, 1).pn, '203728');
  assert.equal(byItem(result, 1).valor_unitario, 1901.69);
  assert.equal(byItem(result, 2).lead_time_original, '54 WEEK(S)');
  assert.equal(byItem(result, 3).material_reference_status, 'PLACEHOLDER');
});

test('C2.2: Fidelity Gate invalida análise antiga, impede merge IA em Leonardo e bloqueia gravação BLOCKED', () => {
  const parser = fs.readFileSync(path.join(ROOT, 'src', 'services', 'rfqParserService.js'), 'utf8');
  const jobs = fs.readFileSync(path.join(ROOT, 'src', 'services', 'rfqImportJobService.js'), 'utf8');
  const controller = fs.readFileSync(path.join(ROOT, 'src', 'controllers', 'importController.js'), 'utf8');
  const frontend = fs.readFileSync(path.join(ROOT, '..', 'sisha-frontend', 'src', 'components', 'RfqImporter.jsx'), 'utf8');
  const migration = fs.readFileSync(path.join(ROOT, 'sql', 'migrations', '20260815_C2_2_001_commercial_fidelity_gate.sql'), 'utf8');

  assert.match(parser, /uma Quotation Leonardo reconhecível nunca pode cair no merge genérico com IA/i);
  assert.match(parser, /DETERMINISTICO_BLOQUEADO/);
  const backendVersion = jobs.match(/ANALYSIS_VERSION = '([^']+)'/)?.[1];
  const frontendVersion = frontend.match(/CURRENT_ANALYSIS_VERSION = '([^']+)'/)?.[1];
  assert.ok(backendVersion, 'analysis version do backend deve existir');
  assert.equal(frontendVersion, backendVersion, 'frontend e backend devem recusar a mesma versão antiga');
  assert.match(backendVersion, /^C2\.[2-9]/);
  assert.match(controller, /qualityStatus === 'BLOCKED'/);
  assert.match(controller, /Quotation Leonardo não pode ser gravada a partir do fallback genérico de IA/);
  assert.match(frontend, /Fidelity Gate bloqueou esta leitura/);
  assert.match(frontend, /CURRENT_ANALYSIS_VERSION/);
  assert.match(migration, /lead_time_original text/);
  assert.match(migration, /quotation_printed_date date/);
});
