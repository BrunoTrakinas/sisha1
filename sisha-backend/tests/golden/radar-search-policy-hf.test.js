const test = require('node:test');
const assert = require('node:assert/strict');
const {
  normalizeRadarSearchTerm,
  isIdentifierLikeRadarTerm,
  buildRadarOrFilter,
} = require('../../src/services/radarSearchPolicyService');

test('normaliza termo do Radar', () => {
  assert.equal(normalizeRadarSearchTerm('  010-ab  '), '010-AB');
});

test('reconhece identificador logístico com dígitos sem espaços', () => {
  assert.equal(isIdentifierLikeRadarTerm('010'), true);
  assert.equal(isIdentifierLikeRadarTerm('528-027-01'), true);
  assert.equal(isIdentifierLikeRadarTerm('SN/010-A'), true);
  assert.equal(isIdentifierLikeRadarTerm('FUEL PUMP'), false);
  assert.equal(isIdentifierLikeRadarTerm('PUMP 010'), false);
});

test('identificador usa somente prefixo e não busca ocorrência no meio do texto', () => {
  const filter = buildRadarOrFilter('010', {
    prefixFields: ['pn', 'pi', 'sn'],
    textFields: ['nomenclatura'],
  });
  assert.equal(filter, 'pn.ilike.010%,pi.ilike.010%,sn.ilike.010%');
  assert.equal(filter.includes('%010%'), false);
});

test('nome mantém busca textual por trecho e identificadores por prefixo', () => {
  const filter = buildRadarOrFilter('fuel pump', {
    prefixFields: ['pn', 'pi', 'sn'],
    textFields: ['nomenclatura'],
  });
  assert.equal(filter, 'pn.ilike.FUEL PUMP%,pi.ilike.FUEL PUMP%,sn.ilike.FUEL PUMP%,nomenclatura.ilike.%FUEL PUMP%');
});

test('termo textual com número e espaço continua apto a pesquisar nomenclatura', () => {
  const filter = buildRadarOrFilter('pump 010', {
    prefixFields: ['pn'],
    textFields: ['nomenclatura'],
  });
  assert.equal(filter, 'pn.ilike.PUMP 010%,nomenclatura.ilike.%PUMP 010%');
});
