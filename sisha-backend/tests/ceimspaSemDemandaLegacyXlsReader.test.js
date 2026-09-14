const test = require('node:test');
const assert = require('node:assert/strict');
const { decodeRk } = require('../src/services/ceimspaSemDemandaLegacyXlsReader');

test('leitor XLS legado decodifica RK inteiro sem criar quantidade fictícia', () => {
  const rk40 = ((40 << 2) | 0x02) >>> 0;
  assert.equal(decodeRk(rk40), 40);
});

test('leitor XLS legado respeita flag divide-by-100 do RK', () => {
  const rk123 = ((12300 << 2) | 0x03) >>> 0;
  assert.equal(decodeRk(rk123), 123);
});
