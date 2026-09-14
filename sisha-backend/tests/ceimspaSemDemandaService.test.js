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

const { parseCeimspaSemDemandaWorksheet } = require('../src/services/ceimspaSemDemandaService');

function makeXlsxUtils() {
  const colName = (c) => {
    let n = c + 1;
    let out = '';
    while (n > 0) {
      const r = (n - 1) % 26;
      out = String.fromCharCode(65 + r) + out;
      n = Math.floor((n - 1) / 26);
    }
    return out;
  };
  const colIndex = (letters) => {
    let n = 0;
    for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
    return n - 1;
  };
  return {
    encode_cell: ({ r, c }) => `${colName(c)}${r + 1}`,
    decode_range: (ref) => {
      const [a, b] = ref.split(':');
      const parse = (addr) => {
        const m = addr.match(/^([A-Z]+)(\d+)$/i);
        return { c: colIndex(m[1].toUpperCase()), r: Number(m[2]) - 1 };
      };
      return { s: parse(a), e: parse(b || a) };
    },
  };
}

test('Sem Demanda lê worksheet dense linha a linha sem sheet_to_json', () => {
  const utils = makeXlsxUtils();
  const values = [
    ['PI', 'NOME_PORT', 'REF', 'RNVC', 'OM', 'MEIO', 'NOME', 'QTDE_APL', 'QTDE_DOT', 'CAM', 'QTDE_EXISTENTE', 'QTDE_DISPONIVEL'],
    ['000000123', 'ITEM', 'ABC', '', '', '', '', 1, 1, '', 40, 40],
    ['000000123', 'ITEM', 'DEF', '', '', '', '', 1, 1, '', 40, 40],
  ];
  const sheet = {
    '!ref': 'A1:L3',
    '!data': values.map((row) => row.map((value) => ({ v: value, w: String(value ?? '') }))),
  };
  const parsed = parseCeimspaSemDemandaWorksheet(sheet, { utils }, { fileName: 'sem_demanda.xls' });
  assert.equal(parsed.sourceRows, 2);
  assert.equal(parsed.validRows, 2);
  assert.equal(parsed.rows.length, 1);
  assert.equal(parsed.rows[0].quantidade, 40);
  assert.deepEqual(parsed.rows[0].referencias.map((r) => r.ref).sort(), ['ABC', 'DEF']);
});

test('Sem Demanda lê worksheet sparse preservando PI/REF visível', () => {
  const utils = makeXlsxUtils();
  const sheet = { '!ref': 'A1:D3' };
  const rows = [
    ['PI', 'REF', 'QTDE_EXISTENTE', 'QTDE_DISPONIVEL'],
    ['000043448', '10134161', 4, 4],
    ['000043448', '11784858-1', 4, 4],
  ];
  rows.forEach((row, r) => row.forEach((value, c) => {
    sheet[utils.encode_cell({ r, c })] = { v: value, w: String(value) };
  }));
  const parsed = parseCeimspaSemDemandaWorksheet(sheet, { utils });
  assert.equal(parsed.rows.length, 1);
  assert.equal(parsed.rows[0].pi, '000043448');
  assert.equal(parsed.rows[0].quantidade, 4);
  assert.deepEqual(parsed.rows[0].referencias.map((r) => r.ref), ['10134161', '11784858-1']);
});
