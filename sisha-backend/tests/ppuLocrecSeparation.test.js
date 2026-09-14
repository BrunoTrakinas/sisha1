const test = require('node:test');
const assert = require('node:assert/strict');
const effective = require('../src/services/ppuEffectiveAvailabilityService');

const official = (overrides = {}) => ({ pn: 'ABC', nomenclatura: 'ITEM', quantidade: 3, localizacao: 'A-2', origem_saldo: 'PPU_OFICIAL', ...overrides });
const custody = (overrides = {}) => ({ import_id: 'imp', group_key: 'g1', pn: 'ABC', box_code: 'CX-020', original_location: 'A-2', original_location_normalized: 'A-2', quantity: 2, ...overrides });
const receipt = (overrides = {}) => ({ pn: 'ABC', nomenclatura: 'ITEM', quantidade: 4, localizacao: 'HANGAR', origem_saldo: 'RECIBO_PENDENTE', numero_recibo: '123/2026', recebimento_id: 'r1', recebimento_item_id: 'ri1', ...overrides });
const locrec = (overrides = {}) => ({ numero_recibo: '123/2026', pn: 'ABC', qtd_documental: 4, qtd_auditada_aplicada: 4, loc_escolhida: 'BRAVO-2', destino_indicado: 'PPU', source_row: 2, ...overrides });

test('Backend: movimenta parte do PPU para caixa sem criar saldo e retira da disponibilidade operacional', () => {
  const out = effective.buildEffectivePpuAvailability([official()], [custody()], []);
  assert.equal(out.summary.effective_qty, 3);
  assert.equal(out.summary.operational_qty, 1);
  assert.equal(out.summary.custody_qty, 2);
  const box = out.rows.find((row) => row.origem_saldo === 'PPU_CUSTODIA_EXTERNA');
  assert.equal(box.quantidade_controlada, 2);
  assert.equal(effective.operationalQuantity(box), 0);
  assert.equal(out.rows.find((row) => row.localizacao === 'A-2').quantidade, 1);
});

test('LOCREC: localiza Recibo sem participar da movimentação Backend', () => {
  const projected = effective.applyLocrecReceiptLocations([receipt()], [locrec()]);
  assert.equal(projected.length, 1);
  assert.equal(projected[0].quantidade, 4);
  assert.equal(projected[0].localizacao, 'BRAVO-2');
  assert.equal(projected[0].locrec_consultivo, true);
});

test('LOCREC: Recibo sem direcionamento fica no HANGAR', () => {
  const projected = effective.applyLocrecReceiptLocations([receipt({ localizacao: 'ANTIGA' })], []);
  assert.equal(projected.length, 1);
  assert.equal(projected[0].localizacao, 'HANGAR');
  assert.equal(projected[0].quantidade, 4);
});

test('Radar lógico: PPU antigo 3, Backend move 2 e Recibo acrescenta 4 = disponível 5, controlado 7', () => {
  const receiptProjected = effective.applyLocrecReceiptLocations([receipt()], [locrec()]);
  const out = effective.buildEffectivePpuAvailability([official(), ...receiptProjected], [custody()], []);
  const operational = out.rows.reduce((sum, row) => sum + effective.operationalQuantity(row), 0);
  const controlled = out.rows.reduce((sum, row) => sum + Number((row.quantidade_controlada ?? row.quantidade) || 0), 0);
  assert.equal(operational, 5); // 1 na A-2 + 4 do Recibo/BRAVO-2
  assert.equal(controlled, 7);  // 1 A-2 + 2 caixa + 4 Recibo
  assert.equal(out.rows.some((row) => row.localizacao === 'CX-020 — CEIMSPA' && row.quantidade === 2), true);
  assert.equal(out.rows.some((row) => row.localizacao === 'BRAVO-2' && row.numero_recibo === '123/2026' && row.quantidade === 4), true);
});

test('LOCREC parcial: parte processada + restante no HANGAR preservam a quantidade do Recibo', () => {
  const projected = effective.applyLocrecReceiptLocations([receipt()], [locrec({ qtd_auditada_aplicada: 2 })]);
  assert.equal(projected.reduce((sum, row) => sum + row.quantidade, 0), 4);
  assert.equal(projected.find((row) => row.localizacao === 'BRAVO-2').quantidade, 2);
  assert.equal(projected.find((row) => row.localizacao === 'HANGAR').quantidade, 2);
});
