const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..', '..');
const originalLoad = Module._load;
Module._load = function mockedLoad(request, parent, isMain) {
  if (request === '../config/supabaseClient') return {};
  return originalLoad.call(this, request, parent, isMain);
};

const {
  buildManualFamilyKey,
  isSameManualAlternativeFamily,
} = require('../../src/services/pnRelationsService');

Module._load = originalLoad;

const searchController = fs.readFileSync(path.join(root, 'src/controllers/searchController.js'), 'utf8');
const needsController = fs.readFileSync(path.join(root, 'src/controllers/needsController.js'), 'utf8');

test('HF Radar alternativos: DMC sem ITEM nunca forma família automática', () => {
  assert.equal(buildManualFamilyKey({ dmc: '39-10-00', item_num: null }), null);
  assert.equal(buildManualFamilyKey({ dmc: '39-10-00', item_num: '' }), null);
  assert.equal(buildManualFamilyKey({ dmc: '', item_num: '120' }), null);
});


test('HF Radar alternativos: regressão do caso TIE BAR não aceita coincidência por DMC com ITEM ausente', () => {
  const tieBar = { pn: 'WG0039-0056-043', dmc: 'DMC-X', item_num: null };
  const falso1 = { pn: 'WG0039-0098-101', dmc: 'DMC-X', item_num: null };
  const falso2 = { pn: 'WG1339-0004-041', dmc: 'DMC-X', item_num: null };
  assert.equal(isSameManualAlternativeFamily(tieBar, falso1), false);
  assert.equal(isSameManualAlternativeFamily(tieBar, falso2), false);
});

test('HF Radar alternativos: família CIETP exige mesmo DMC + mesmo ITEM', () => {
  const base = { dmc: ' 39-10-00 ', item_num: ' 120 ' };
  assert.equal(buildManualFamilyKey(base), '39-10-00|120');
  assert.equal(isSameManualAlternativeFamily(base, { dmc: '39-10-00', item_num: '120' }), true);
  assert.equal(isSameManualAlternativeFamily(base, { dmc: '39-10-00', item_num: '121' }), false);
  assert.equal(isSameManualAlternativeFamily(base, { dmc: '39-20-00', item_num: '120' }), false);
});

test('HF Radar alternativos: subitem ordena prioridade, mas não substitui DMC + ITEM', () => {
  assert.equal(
    isSameManualAlternativeFamily(
      { dmc: '39-10-00', item_num: '120', sub_item: '00A' },
      { dmc: '39-10-00', item_num: '120', sub_item: '00C' },
    ),
    true,
  );
  assert.equal(
    isSameManualAlternativeFamily(
      { dmc: '39-10-00', item_num: null, sub_item: '00A' },
      { dmc: '39-10-00', item_num: null, sub_item: '00B' },
    ),
    false,
  );
});

test('HF Radar alternativos: montagem do card usa gate canônico e não o comparador permissivo antigo', () => {
  assert.match(searchController, /const familyKey = buildManualFamilyKey\(entry\);/);
  assert.match(searchController, /if \(!familyKey\) return;/);
  assert.match(searchController, /isSameManualAlternativeFamily\(a, entry\)/);
  assert.doesNotMatch(searchController, /a\.dmc === entry\.dmc && a\.item_num === entry\.item_num/);
});

test('HF Radar alternativos: relação documental é direta, sem fechamento transitivo A↔B↔C', () => {
  assert.match(searchController, /function collectDirectAlternatives\(graph, start\)/);
  assert.match(searchController, /const alternativosDocumento = collectDirectAlternatives\(altGraph, pnUpper\)/);
  assert.doesNotMatch(searchController, /function collectConnectedAlternatives\(/);
  assert.match(searchController, /\(a === pnUpper && b === pnAlt\) \|\| \(a === pnAlt && b === pnUpper\)/);
});

test('HF Radar alternativos: Gerador de Necessidades usa a mesma chave de família CIETP', () => {
  assert.match(needsController, /resolvePnRelations, buildManualFamilyKey/);
  assert.match(needsController, /const familyKey = buildManualFamilyKey\(row\);/);
  assert.match(needsController, /if \(!familyKey \|\| !pn\) return;/);
});
