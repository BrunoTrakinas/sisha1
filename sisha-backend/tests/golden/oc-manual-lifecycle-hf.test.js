const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const backend = (rel) => fs.readFileSync(path.join(__dirname, '..', '..', rel), 'utf8');
const frontend = (rel) => fs.readFileSync(path.join(__dirname, '..', '..', '..', 'sisha-frontend', rel), 'utf8');

test('HF OC: visão geral separa ODA de FAT/EMB', () => {
  const controller = backend('src/controllers/purchaseController.js');
  const page = frontend('src/pages/OrdensCompras.jsx');
  assert.match(controller, /return 'fat_emb'/);
  assert.match(controller, /fat_emb: 0/);
  assert.match(page, /title="ODA"/);
  assert.match(page, /title="FAT \/ EMB"/);
  assert.doesNotMatch(page, /title="ODA \/ FAT \/ EMB"/);
});

test('HF OC: transição manual usa endpoint dedicado e afeta PDs vinculados', () => {
  const controller = backend('src/controllers/purchaseController.js');
  const routes = backend('src/routes/purchaseRoutes.js');
  const page = frontend('src/pages/OrdensCompras.jsx');
  assert.match(routes, /\/ordens\/:id\/status/);
  assert.match(controller, /exports\.transicionarStatusOrdem/);
  assert.match(controller, /OC_MANUAL_PROMOVIDA_ODA/);
  assert.match(controller, /status: 'ODA', status_grupo: 'ODA'/);
  assert.match(controller, /OC_MANUAL_CANCELADA/);
  assert.match(page, /ALTERAR SITUAÇÃO/);
});

test('HF OC: cancelamento falha fechado diante de FAT, EMB, REC ou recebimento', () => {
  const controller = backend('src/controllers/purchaseController.js');
  assert.match(controller, /PD_ADVANCED_BLOCK_CANCEL = new Set\(\['FAT', 'EMB', 'REC'\]\)/);
  assert.match(controller, /delivered > 0/);
  assert.match(controller, /Cancelamento bloqueado/);
});

test('HF OC: estágios avançados não regridem durante avanço para ODA', () => {
  const controller = backend('src/controllers/purchaseController.js');
  assert.match(controller, /PD_MANUAL_ADVANCE_FROM = new Set\(\['ODC', 'ATIVO', 'ODA_RESSALVA'\]\)/);
  assert.match(controller, /pds_preservados/);
});
