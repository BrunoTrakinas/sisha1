const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const backend = path.resolve(__dirname, '../..');
const {
  parseLegacyDocTextReceipt,
  parseLegacyDocTable,
  legacyDocSchemaFromHeader,
} = require('../../src/services/receiptDocumentParser');

function fixture(name) {
  return fs.readFileSync(path.join(backend, 'tests/fixtures', name), 'utf8');
}

test('A1.1A HF6: recibo 083/2025 reconhece CoC/BS mesmo com aspas/pontuação corrompidas e preserva PN real', () => {
  const result = parseLegacyDocTextReceipt({
    content: fixture('receipt-083-2025-legacy-hf6.txt'),
    fileName: 'RECIBO-083-2025-MAT-GARANTIA - BS(5).doc',
    fileBuffer: Buffer.from('fixture-083-hf6'),
    requestedType: 'recibo_auto',
  });
  assert.equal(result.recibo_ref, '083/2025');
  assert.equal(result.data_entrega_ref, '2025-11-26');
  assert.equal(result.metodo_importacao, 'DOCUMENTO_ESTRUTURAL_DOC_COC_BATCH');
  assert.equal(result.data_triagem.length, 1);
  const item = result.data_triagem[0];
  assert.equal(item.pn, 'AS41910-09');
  assert.equal(item.nomenclatura, 'SEAL');
  assert.equal(item.dados_originais.PROGRAMA_LOGISTICO_EXTRAIDO_DESCRICAO, 'Brazil Expiring BS 5 years Stock');
  assert.equal(item.quantidade, 10);
  assert.equal(item.coc_no, '82828894');
  assert.equal(item.batch_no, '3864528');
  assert.equal(item.delivery_note, '8010769');
  assert.equal(item.invoice_no, '200650744');
  assert.equal(item.di, '19/1542284-3');
  assert.equal(item.valor_unitario, 20.37);
  assert.equal(item.valor_total_documento, 203.70);
  assert.notEqual(item.pn, '82828894');
  assert.notEqual(item.nomenclatura, '3864528');
});

test('A1.1A HF6: Batch sem assinatura CoC/BS ou Delivery BS falha fechado e nunca cai em STANDARD', () => {
  const header = 'PART NUMBER DESCRIPTION Batch No. QTY INVOICE No. UNIT PRICE TOTAL DI';
  assert.equal(legacyDocSchemaFromHeader(header), null);
});

test('A1.1A HF6: schema lock não desliza células para transformar CoC/Batch em PN', () => {
  const content = [
    'RECIBO DE ENTREGA DE MATERIAL NÚMERO 083/2025.',
    'PART NUMBER\tDESCRIPTION\tCoC. "BS"\tBatch No.\tCoC. O.\tQTY\tINVOICE No.\tUN. PRICE £\tTOTAL P. £\tDI',
    // linha propositalmente incompleta: antes o resync podia deslizar até 82828894
    'AS41910-09\tSEAL\t82828894\t3864528\t8010769\t10\t200650744\t20,37\t203,70',
    '82828894\t3864528\t8010769\t10\t200650744\t20,37\t203,70\t19/1542284-3\tLIXO\tLIXO',
    'RECEBIDO POR:',
    'DATA: 26/11/2025.',
  ].join('\n');
  const table = parseLegacyDocTable(content);
  assert.equal(table.schema.key, 'COC_BATCH');
  assert.equal(table.rows.length, 0);
  assert.match(table.warning || '', /não corresponde ao schema|interrompido/i);
});

test('A1.1A HF6: COC_BATCH exige âncoras CoC BS, Batch e CoC O na mesma linha', () => {
  const content = [
    'RECIBO DE ENTREGA DE MATERIAL NÚMERO 083/2025.',
    'PART NUMBER\tDESCRIPTION\tCoC. "BS"\tBatch No.\tCoC. O.\tQTY\tINVOICE No.\tUN. PRICE £\tTOTAL P. £\tDI',
    'AS41910-09\tSEAL\t\t3864528\t8010769\t10\t200650744\t20,37\t203,70\t19/1542284-3',
    'RECEBIDO POR:',
    'DATA: 26/11/2025.',
  ].join('\n');
  const table = parseLegacyDocTable(content);
  assert.equal(table.schema.key, 'COC_BATCH');
  assert.equal(table.rows.length, 0);
});

test('A1.1A HF6+: análise versionada reprocessa somente recibos ainda não salvos', () => {
  const triage = fs.readFileSync(path.join(backend, 'src/services/receiptBatchTriageService.js'), 'utf8');
  const worker = fs.readFileSync(path.join(backend, 'src/services/receiptImportJobService.js'), 'utf8');
  assert.match(triage, /ANALYSIS_VERSION = 'A1\.1A-HF\d+-V\d+'/);
  assert.match(worker, /String\(item\.analysis_version \|\| ''\) !== ANALYSIS_VERSION/);
  assert.match(worker, /\['QUEUED', 'PROCESSING', 'REVIEW_READY'\]/);
  assert.doesNotMatch(worker, /\.in\('status', \[[^\]]*'SAVED'/);
});
