const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const backend = path.resolve(__dirname, '../..');
const {
  parseLegacyDocTextReceipt,
  parseLegacyDocTable,
} = require('../../src/services/receiptDocumentParser');

function fixture(name) {
  return fs.readFileSync(path.join(backend, 'tests/fixtures', name), 'utf8');
}

test('A1.1A HF4: recibo 086/2025 legado gera exatamente 3 PNs da coluna PART NUMBER', () => {
  const result = parseLegacyDocTextReceipt({
    content: fixture('receipt-086-2025-legacy-hf4.txt'),
    fileName: 'RECIBO-086-2025-MAT-GARANTIA(2).doc',
    fileBuffer: Buffer.from('fixture-086'),
    requestedType: 'recibo_auto',
  });
  assert.equal(result.recibo_ref, '086/2025');
  assert.equal(result.data_entrega_ref, '2025-12-10');
  assert.equal(result.tipo_recebimento, 'GARANTIA');
  assert.equal(result.data_triagem.length, 3);
  assert.deepEqual(result.data_triagem.map((item) => item.pn), [
    'WG1480-8081-041', 'Z-B7YN', '3203134-317',
  ]);
  assert.equal(result.data_triagem[0].sn, '400553534');
  assert.equal(result.data_triagem[2].sn, '3421250');
  assert.equal(result.data_triagem[0].delivery_note, '82629911');
  assert.equal(result.data_triagem[0].invoice_no, '201045652');
  assert.equal(result.data_triagem[0].di, '25/2690769-0');
  const pns = result.data_triagem.map((item) => item.pn);
  ['0862025', '400553534', '82629911', '201045652'].forEach((falsePn) => assert.equal(pns.includes(falsePn), false));
});

test('A1.1A HF4: DOC com PD preserva PD como referência e PN em coluna própria', () => {
  const result = parseLegacyDocTextReceipt({
    content: fixture('receipt-pd-legacy-hf4.txt'),
    fileName: 'RECIBO-014-2025-MAT-PD - 71200.DOC',
    fileBuffer: Buffer.from('fixture-pd'),
    requestedType: 'recibo_auto',
  });
  assert.equal(result.tipo_recebimento, 'PD');
  assert.equal(result.data_triagem.length, 2);
  assert.equal(result.data_triagem[0].documento_referencia, 'PD71200-2023-04549');
  assert.equal(result.data_triagem[0].pn, 'QA0435');
  assert.equal(result.data_triagem[0].quantidade, 3);
});

test('A1.1A HF4: DOC batch/BS preserva batch e extrai múltiplos SN sem tratá-los como PN', () => {
  const result = parseLegacyDocTextReceipt({
    content: fixture('receipt-batch-legacy-hf4.txt'),
    fileName: 'RECIBO-021-2026-MAT Dispose ( Expiring BS stock 2025).doc',
    fileBuffer: Buffer.from('fixture-batch'),
    requestedType: 'recibo_auto',
  });
  assert.equal(result.data_triagem.length, 3);
  assert.equal(result.data_triagem[0].pn, '0-20F4');
  assert.equal(result.data_triagem[0].batch_no, '3168390');
  const bearings = result.data_triagem.filter((item) => item.pn === 'WSMB0077-111');
  assert.equal(bearings.length, 2);
  assert.deepEqual(bearings.map((item) => item.sn), ['00908', '00910']);
  assert.deepEqual(bearings.map((item) => item.quantidade), [1, 1]);
  assert.ok(bearings.every((item) => item.batch_no === '4029053'));
});


test('A1.1A HF4: DOC CoC/BS mantém CoC e Batch fora da coluna PN', () => {
  const result = parseLegacyDocTextReceipt({
    content: fixture('receipt-coc-legacy-hf4.txt'),
    fileName: 'RECIBO-045-2026-MAT-GARANTIA - BS.doc',
    fileBuffer: Buffer.from('fixture-coc'),
    requestedType: 'recibo_auto',
  });
  assert.equal(result.data_triagem.length, 1);
  assert.equal(result.data_triagem[0].pn, '100-035-0074');
  assert.equal(result.data_triagem[0].coc_no, '8436068');
  assert.equal(result.data_triagem[0].batch_no, '2669346');
  assert.equal(result.data_triagem[0].delivery_note, '8207713');
});

test('A1.1A HF4: DOC legado sem tabela reconhecível fica REVIEW estrutural e não fabrica itens', () => {
  const result = parseLegacyDocTextReceipt({
    content: 'RECIBO DE ENTREGA DE MATERIAL NÚMERO 099/2026.\nDATA: 01/08/2026.\nContrato 12345. SN 777777 Delivery 888888 Invoice 999999',
    fileName: 'RECIBO-099-2026.doc',
    fileBuffer: Buffer.from('fixture-review'),
    requestedType: 'recibo_auto',
  });
  assert.equal(result.metodo_importacao, 'DOCUMENTO_ESTRUTURAL_DOC_REVIEW');
  assert.equal(result.data_triagem.length, 0);
  assert.match(result.avisos_triagem.join(' '), /não pôde ser reconstruída|revisão/i);
});

test('A1.1A HF4: parser identifica os quatro esquemas legados sem depender do nome do arquivo', () => {
  assert.equal(parseLegacyDocTable(fixture('receipt-086-2025-legacy-hf4.txt')).schema.key, 'STANDARD');
  assert.equal(parseLegacyDocTable(fixture('receipt-pd-legacy-hf4.txt')).schema.key, 'PD_STANDARD');
  assert.equal(parseLegacyDocTable(fixture('receipt-batch-legacy-hf4.txt')).schema.key, 'DELIVERY_BATCH');
  assert.equal(parseLegacyDocTable(fixture('receipt-coc-legacy-hf4.txt')).schema.key, 'COC_BATCH');
});


test('A1.1A HF4: cabeçalho Word com marcadores numéricos não perde a coluna PD', () => {
  const content = [
    'RECIBO DE ENTREGA DE MATERIAL NÚMERO 034/2026.',
    '1 PD\t2 PART NUMBER\tDESCRIPTION\tDELIVERY O.\t2 QTY\tINVOICE No.\t1 UNIT PRICE £\t2 TOTAL P. £\t3 DI',
    'PD91100-2024-00237\tLJ2\tTUBE, INNER - NOSE\t82700001\t1\t201000001\t100,00\t100,00\t26/0300000-1',
    'RECEBIDO POR:',
    'DATA: 01/03/2026.',
  ].join('\n');
  const table = parseLegacyDocTable(content);
  assert.equal(table.schema.key, 'PD_STANDARD');
  assert.equal(table.rows.length, 1);
  assert.equal(table.rows[0].pd, 'PD91100-2024-00237');
  assert.equal(table.rows[0].pn, 'LJ2');
});

test('A1.1A HF4+: IA não é fallback para DOC legado e análise versionada força reprocessamento seguro', () => {
  const triage = fs.readFileSync(path.join(backend, 'src/services/receiptBatchTriageService.js'), 'utf8');
  const worker = fs.readFileSync(path.join(backend, 'src/services/receiptImportJobService.js'), 'utf8');
  assert.match(triage, /ANALYSIS_VERSION = 'A1\.1A-HF\d+-V\d+'/);
  assert.match(triage, /STRUCTURAL_AI_FALLBACK_EXTENSIONS = new Set\(\['\.docx'\]\)/);
  assert.doesNotMatch(triage, /AI_EXTENSIONS\.has\(extension\) \|\| extension === '\.doc'/);
  assert.match(worker, /\['QUEUED', 'PROCESSING', 'REVIEW_READY'\]/);
  assert.match(worker, /status: 'QUEUED'/);
  assert.match(worker, /\.in\('status', \['READY', 'REVIEW', 'CONFLICT', 'ERROR'\]\)/);
  assert.doesNotMatch(worker, /\.in\('status', \[[^\]]*'SAVED'/);
});
