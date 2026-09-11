const test = require('node:test');
const assert = require('node:assert/strict');
const { parseCeimspaSemDemandaRows } = require('../src/services/ceimspaSemDemandaService');

test('Sem Demanda contabiliza uma única quantidade por PI mesmo com vários PNs/REFs', () => {
  const parsed = parseCeimspaSemDemandaRows([
    ['PI', 'NOME_PORT', 'REF', 'RNVC', 'OM', 'MEIO', 'NOME', 'QTDE_APL', 'QTDE_DOT', 'CAM', 'QTDE_EXISTENTE', 'QTDE_DISPONIVEL'],
    ['123', 'ITEM TESTE', 'ABC', '', '', '', '', 1, 1, '', 40, 40],
    ['123', 'ITEM TESTE', 'DEF', '', '', '', '', 1, 1, '', 40, 40],
  ]);
  assert.equal(parsed.rows.length, 1);
  assert.equal(parsed.rows[0].pi, '000000123');
  assert.equal(parsed.rows[0].quantidade, 40);
  assert.deepEqual(parsed.rows[0].referencias.map((r) => r.ref).sort(), ['ABC', 'DEF']);
});

test('Sem Demanda não duplica a mesma referência contextual', () => {
  const parsed = parseCeimspaSemDemandaRows([
    ['PI', 'REF', 'RNVC', 'QTDE_EXISTENTE', 'QTDE_DISPONIVEL'],
    ['987654321', 'PN-1', 'R1', 5, 4],
    ['987654321', 'PN-1', 'R1', 5, 4],
  ]);
  assert.equal(parsed.rows[0].referencias.length, 1);
  assert.equal(parsed.rows[0].quantidade, 4);
});

test('Sem Demanda falha fechado quando o mesmo PI apresenta saldos divergentes', () => {
  assert.throws(() => parseCeimspaSemDemandaRows([
    ['PI', 'REF', 'QTDE_EXISTENTE', 'QTDE_DISPONIVEL'],
    ['123', 'ABC', 40, 40],
    ['123', 'DEF', 40, 39],
  ]), /quantidades divergentes/i);
});
