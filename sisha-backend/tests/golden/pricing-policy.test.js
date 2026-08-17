const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildReferencePriceRows,
  buildReferencePriceMap,
  resolveRfqValidityEnd,
} = require('../../src/services/pricingService');

const NOW = new Date('2026-08-14T12:00:00Z');

function resolve(input) {
  const rows = buildReferencePriceRows({ ...input, now: NOW });
  return buildReferencePriceMap(rows);
}

test('Price List vigente tem prioridade absoluta sobre cotação e recibo', () => {
  const map = resolve({
    priceListRows: [{ pn: 'PN-1', valor_unitario: 100 }],
    rfqRows: [{ pn: 'PN-1', valor_unitario: 200, ativo: true, tipo_cotacao: 'MATERIAL', data_cotacao: '2026-08-01', validade: '30 dias' }],
    receiptRows: [{ pn: 'PN-1', valor_unitario: 300, recebimento_id: 'R1' }],
    receiptHeaderRows: [{ id: 'R1', numero_recibo: 'REC-1', data_recebimento: '2026-07-01', ativo: true }],
  });
  const price = map.get('PN-1');
  assert.equal(price.valor_unitario, 100);
  assert.equal(price.status_preco, 'OFICIAL_VIGENTE');
  assert.equal(price.estimativa, false);
  assert.equal(price.necessita_cotacao, false);
});

test('cotação válida supera cotação vencida e recibo e não pede nova cotação', () => {
  const map = resolve({
    rfqRows: [
      { pn: 'PN-2', valor_unitario: 210, ativo: true, tipo_cotacao: 'MATERIAL', data_cotacao: '2025-01-01', validade: '30 dias', cotacao_numero: 'OLD' },
      { pn: 'PN-2', valor_unitario: 220, ativo: true, tipo_cotacao: 'MATERIAL', data_cotacao: '2026-08-01', validade: '30 dias', cotacao_numero: 'NEW' },
    ],
    receiptRows: [{ pn: 'PN-2', valor_unitario: 190, recebimento_id: 'R2' }],
    receiptHeaderRows: [{ id: 'R2', numero_recibo: 'REC-2', data_recebimento: '2026-07-01', ativo: true }],
  });
  const price = map.get('PN-2');
  assert.equal(price.valor_unitario, 220);
  assert.equal(price.status_preco, 'COTACAO_VALIDA');
  assert.equal(price.estimativa, false);
  assert.equal(price.necessita_cotacao, false);
});

test('validade textual em dias é resolvida a partir da data da cotação', () => {
  const end = resolveRfqValidityEnd({ data_cotacao: '2026-08-01', validade: '30 dias' });
  assert.equal(end.toISOString().slice(0, 10), '2026-08-31');
});

test('cotação vencida mais recente preenche estimativa e continua elegível a nova cotação', () => {
  const map = resolve({
    rfqRows: [
      { pn: 'PN-3', valor_unitario: 300, ativo: true, tipo_cotacao: 'MATERIAL', data_cotacao: '2024-01-01', validade: '30 dias', cotacao_numero: 'Q1' },
      { pn: 'PN-3', valor_unitario: 330, ativo: true, tipo_cotacao: 'MATERIAL', data_cotacao: '2026-01-01', validade: '30 dias', cotacao_numero: 'Q2' },
    ],
    receiptRows: [{ pn: 'PN-3', valor_unitario: 250, recebimento_id: 'R3' }],
    receiptHeaderRows: [{ id: 'R3', numero_recibo: 'REC-3', data_recebimento: '2026-07-01', ativo: true }],
  });
  const price = map.get('PN-3');
  assert.equal(price.valor_unitario, 330);
  assert.equal(price.status_preco, 'ESTIMATIVA_COTACAO_VENCIDA');
  assert.equal(price.estimativa, true);
  assert.equal(price.necessita_cotacao, true);
});

test('recibo é fallback histórico quando não existe Price List nem cotação utilizável', () => {
  const map = resolve({
    receiptRows: [
      { pn: 'PN-4', valor_unitario: 400, recebimento_id: 'R4A' },
      { pn: 'PN-4', valor_unitario: 440, recebimento_id: 'R4B' },
    ],
    receiptHeaderRows: [
      { id: 'R4A', numero_recibo: 'REC-OLD', data_recebimento: '2025-01-01', ativo: true },
      { id: 'R4B', numero_recibo: 'REC-NEW', data_recebimento: '2026-06-15', ativo: true },
    ],
  });
  const price = map.get('PN-4');
  assert.equal(price.valor_unitario, 440);
  assert.equal(price.status_preco, 'ESTIMATIVA_RECIBO');
  assert.equal(price.estimativa, true);
  assert.equal(price.necessita_cotacao, true);
  assert.match(price.documento_fonte, /REC-NEW/);
});

test('referência não-GBP não é convertida nem rotulada silenciosamente como GBP', () => {
  const map = resolve({
    rfqRows: [{ pn: 'PN-USD', valor_unitario: 999, moeda: 'USD', ativo: true, tipo_cotacao: 'MATERIAL', data_cotacao: '2026-08-01', validade: '30 dias' }],
    receiptRows: [{ pn: 'PN-USD', valor_unitario: 888, moeda: 'USD', recebimento_id: 'R-USD' }],
    receiptHeaderRows: [{ id: 'R-USD', numero_recibo: 'REC-USD', data_recebimento: '2026-08-01', ativo: true }],
  });
  assert.equal(map.has('PN-USD'), false);
});
