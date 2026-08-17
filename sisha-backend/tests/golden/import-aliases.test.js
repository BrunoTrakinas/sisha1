const test = require('node:test');
const assert = require('node:assert/strict');

const {
  normalizeHeader,
  normalizePn,
  findColumnIndex,
  buildIndexMap,
  findHeaderRow,
} = require('../../src/utils/importAliases');

test('GOLDEN importacao: normalizacao remove acento/pontuacao sem alterar semantica', () => {
  assert.equal(normalizeHeader('  Número_da Peça (PN)  '), 'numero da peca pn');
  assert.equal(normalizeHeader('Localização'), 'localizacao');
});

test('GOLDEN PN: espacos nao fazem parte da identidade do PN', () => {
  assert.equal(normalizePn('  123 abc 45 '), '123ABC45');
});

test('GOLDEN importacao: aliases oficiais localizam PN, nomenclatura e quantidade', () => {
  const headers = ['Incoming Part Desc', 'Part Number', 'Required Qty', 'Localização'];
  const idx = buildIndexMap(headers, {
    pn: 'pn',
    nomenclatura: 'nomenclatura',
    qtd: 'qtd',
    localizacao: 'localizacao',
  });

  assert.equal(idx.pn, 1);
  assert.equal(idx.nomenclatura, 0);
  assert.equal(idx.qtd, 2);
  assert.equal(idx.localizacao, 3);
});

test('GOLDEN importacao: cabecalho pode existir apos linhas de titulo', () => {
  const rows = [
    ['RELATORIO SISHA'],
    ['gerado em 13/08/2026'],
    ['Descrição', 'Part No.', 'Quantidade'],
    ['BOMBA', 'PN-001', 1],
  ];

  assert.equal(findHeaderRow(rows, ['nomenclatura', 'pn', 'qtd']), 2);
});

test('GOLDEN importacao: coluna inexistente retorna -1 e nao inventa indice', () => {
  assert.equal(findColumnIndex(['PN', 'SN'], 'price'), -1);
});

test('GOLDEN Order Book: coluna In Delivery é trânsito e usa o alias de in_shipment', () => {
  assert.equal(findColumnIndex(['PD', 'In Delivery', 'Delivered'], 'in_shipment'), 1);
  assert.equal(findColumnIndex(['PD', 'In Delivery', 'Delivered'], 'delivered'), 2);
});
