const test = require('node:test');
const assert = require('node:assert/strict');

const Module = require('module');
const originalLoad = Module._load;
Module._load = function patched(request, parent, isMain) {
  if (request.endsWith('/config/supabaseClient') || request === '../config/supabaseClient') return {};
  return originalLoad.call(this, request, parent, isMain);
};
const { reconcileLocrecEvidence } = require('../src/services/locrecReconciliationService');
Module._load = originalLoad;

function receipt(no, pn, qty) {
  return { id: `r-${no}`, numero_recibo: no, recebimento_itens: [{ id: `i-${pn}`, pn, quantidade: qty, ativo: true }] };
}
function locrec(no, pn, qty, audited, loc, destiny) {
  return { numero_recibo: no, pn, qtd_documental: qty, qtd_auditada_aplicada: audited, loc_escolhida: loc, destino_indicado: destiny, source_row: 2 };
}

test('LOCREC: Recibo é a origem e localização PPU processada vem somente do LOCREC', () => {
  const out = reconcileLocrecEvidence({
    locrecRows: [locrec('058/2025', 'ABC', 10, 10, 'ALFA - 9', 'PPU')],
    receipts: [receipt('058/2025', 'ABC', 10)],
  });
  assert.equal(out.rows[0].status, 'PROCESSADO_ESTOQUE_PPU');
  assert.equal(out.rows[0].qtd_recibo, 10);
  assert.equal(out.rows[0].localizacao_consolidada, 'ALFA - 9');
  assert.equal(out.rows[0].localizacao_fonte, 'LOCREC');
});

test('LOCREC: caixa genérica é localização do Recibo e não depende do Backend', () => {
  const out = reconcileLocrecEvidence({
    locrecRows: [locrec('058/2025', 'ABC', 10, 10, 'CAIXA 65', 'CAIXA')],
    receipts: [receipt('058/2025', 'ABC', 10)],
  });
  assert.equal(out.rows[0].status, 'PROCESSADO_CAIXA');
  assert.deepEqual(out.rows[0].locations, ['CAIXA 65']);
  assert.equal('backend_evidence_scope' in out.rows[0], false);
});

test('LOCREC: Recibo é autoridade de quantidade e divergência não é escondida', () => {
  const out = reconcileLocrecEvidence({
    locrecRows: [locrec('058/2025', 'ABC', 12, 12, 'ALFA-9', 'PPU')],
    receipts: [receipt('058/2025', 'ABC', 10)],
  });
  assert.equal(out.rows[0].status, 'DIVERGENCIA_QUANTIDADE');
  assert.equal(out.rows[0].qtd_auditada, 10);
  assert.equal(out.rows[0].quantity_mismatch, true);
});

test('LOCREC: linha sem Recibo correspondente é evidência e não cria material', () => {
  const out = reconcileLocrecEvidence({ locrecRows: [locrec('999/2026', 'ABC', 2, 2, 'ALFA-9', 'PPU')], receipts: [] });
  assert.equal(out.rows[0].status, 'LOCREC_SEM_RECIBO');
  assert.equal(out.rows[0].receipt_found, false);
});

test('LOCREC: Recibo sem direcionamento permanece no HANGAR', () => {
  const out = reconcileLocrecEvidence({
    locrecRows: [locrec('058/2025', 'ABC', 10, 0, null, 'PENDENTE')],
    receipts: [receipt('058/2025', 'ABC', 10)],
  });
  assert.equal(out.rows[0].status, 'AGUARDANDO_PROCESSAMENTO');
  assert.equal(out.rows[0].localizacao_consolidada, 'HANGAR');
  assert.equal(out.rows[0].localizacao_fonte, 'RECIBO_DEFAULT_HANGAR');
});

test('LOCREC: Recibo ausente do arquivo atual também permanece no HANGAR', () => {
  const out = reconcileLocrecEvidence({ locrecRows: [], receipts: [receipt('100/2026', 'XYZ', 5)] });
  assert.equal(out.rows.length, 1);
  assert.equal(out.rows[0].status, 'AGUARDANDO_PROCESSAMENTO');
  assert.equal(out.rows[0].localizacao_consolidada, 'HANGAR');
  assert.equal(out.rows[0].qtd_pendente, 5);
});

test('LOCREC: processamento parcial preserva saldo restante no HANGAR', () => {
  const out = reconcileLocrecEvidence({
    locrecRows: [locrec('101/2026', 'XYZ', 5, 3, 'BRAVO-2', 'PPU')],
    receipts: [receipt('101/2026', 'XYZ', 5)],
  });
  assert.equal(out.rows[0].status, 'PROCESSAMENTO_PARCIAL');
  assert.equal(out.rows[0].qtd_auditada, 3);
  assert.equal(out.rows[0].qtd_pendente, 2);
  assert.deepEqual(out.rows[0].locations, ['BRAVO-2', 'HANGAR']);
});
