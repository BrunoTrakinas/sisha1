const test = require('node:test');
const assert = require('node:assert/strict');
const {
  parseLocrecRows,
  extractBoxCode,
  classifyLocation,
} = require('../src/services/locrecParserService');

test('LOCREC: reconhece estoque, caixa e CEIMSPA sem criar inferência indevida', () => {
  const rows = [
    ['Recibo', 'PD', 'PN', 'Qtd', 'QTD Auditada', 'LOC Escolhida', 'Nip', 'Data', 'Restante'],
    ['058/2025', 'DOAÇÃO', 'ABC', 10, 10, 'ALFA - 9', '00038318', '01/09/2026', 0],
    ['058/2025', 'DOAÇÃO', 'DEF', 8, 8, 'CAIXA 65', '00038318', '01/09/2026', 0],
    ['058/2025', 'DOAÇÃO', 'GHI', 2, 2, 'CEIMSPA-caixa63', '00038318', '01/09/2026', 0],
    ['058/2025', 'DOAÇÃO', 'JKL', 5, '', '', '', '', ''],
  ];
  const parsed = parseLocrecRows(rows);
  assert.equal(parsed.items.length, 4);
  assert.equal(parsed.items[0].destino_indicado, 'PPU');
  assert.equal(parsed.items[1].destino_indicado, 'CAIXA');
  assert.equal(parsed.items[1].box_code, 'CX-065');
  assert.equal(parsed.items[2].destino_indicado, 'CEIMSPA');
  assert.equal(parsed.items[2].box_code, 'CX-063');
  assert.equal(parsed.items[3].destino_indicado, 'PENDENTE');
});

test('LOCREC: QTD Auditada excedente é preservada como evidência mas aplicada no máximo até Qtd', () => {
  const rows = [
    ['Recibo', 'PN', 'Qtd', 'QTD Auditada', 'LOC Escolhida'],
    ['100/2026', 'ABC', 8, 12, 'ALFA-1'],
  ];
  const parsed = parseLocrecRows(rows);
  assert.equal(parsed.items[0].qtd_auditada_original, 12);
  assert.equal(parsed.items[0].qtd_auditada_aplicada, 8);
  assert.equal(parsed.items[0].restante_calculado, 0);
});

test('LOCREC: caixa genérica não vira CEIMSPA sem evidência explícita', () => {
  assert.equal(classifyLocation('CAIXA 61'), 'CAIXA');
  assert.equal(classifyLocation('CX-061'), 'CAIXA');
  assert.equal(classifyLocation('CAIXA #61 CEIMSPA'), 'CEIMSPA');
  assert.equal(extractBoxCode('CAIXA #61 CEIMSPA'), 'CX-061');
});
