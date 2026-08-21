const test = require('node:test');
const assert = require('node:assert/strict');

const {
  ACTIVE_AIRCRAFT_CODES,
  parseOsDomain,
} = require('../../src/services/osDomainService');

test('OS numérica preserva os 4 primeiros dígitos como aeronave ativa', () => {
  const parsed = parseOsDomain('40050192');
  assert.equal(parsed.tipo, 'ANV');
  assert.equal(parsed.codigo, '4005');
  assert.equal(parsed.historica, false);
  assert.ok(ACTIVE_AIRCRAFT_CODES.includes(parsed.codigo));
});

test('OS históricas 4006/4009 continuam reconhecíveis sem virarem frota ativa', () => {
  const parsed = parseOsDomain('40061234');
  assert.equal(parsed.tipo, 'ANV');
  assert.equal(parsed.codigo, '4006');
  assert.equal(parsed.historica, true);
  assert.equal(ACTIVE_AIRCRAFT_CODES.includes(parsed.codigo), false);
});

test('prefixos convencionais continuam apontando para a oficina correta', () => {
  assert.equal(parseOsDomain('VN1234').codigo, 'VN');
  assert.equal(parseOsDomain('SV1234').codigo, 'SV');
  assert.equal(parseOsDomain('MV1234').codigo, 'MV');
  assert.equal(parseOsDomain('HV1234').codigo, 'HV');
  assert.equal(parseOsDomain('PA1234').codigo, 'PA');
});

test('família MT reconhece todos os novos prefixos antes da MT genérica', () => {
  const expected = ['MTVN', 'MTMV', 'MTHV', 'MTAP', 'MTSV', 'MTPA', 'MTAR', 'MTVA', 'MT'];
  expected.forEach((prefix) => {
    const parsed = parseOsDomain(`${prefix}0001`);
    assert.equal(parsed.tipo, 'OFICINA', prefix);
    assert.equal(parsed.codigo, prefix, prefix);
    assert.equal(parsed.familia, 'MT', prefix);
    assert.equal(parsed.demanda_material_mt, true, prefix);
  });
  assert.notEqual(parseOsDomain('MTVN0001').codigo, 'MT');
  assert.notEqual(parseOsDomain('MTMV0001').codigo, 'MT');
});
