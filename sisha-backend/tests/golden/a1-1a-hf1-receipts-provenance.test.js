const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');

const originalLoad = Module._load;
Module._load = function mockedLoad(request, parent, isMain) {
  if (request === 'xlsx') return {};
  return originalLoad.call(this, request, parent, isMain);
};
const { receiptTypeSignals } = require('../../src/services/receiptDocumentParser');
Module._load = originalLoad;

const root = path.resolve(__dirname, '../../..');
const frontend = path.join(root, 'sisha-frontend');

test('A1.1A HF1: recibo automático classifica PD pelo conteúdo/modelo sem depender do nome do arquivo', () => {
  const result = receiptTypeSignals('documento-generico.xlsx', 'RECIBO DE ENTREGA', 'recibo_auto', true);
  assert.equal(result.type, 'PD');
});

test('A1.1A HF1: recibo automático classifica garantia pelo conteúdo', () => {
  const result = receiptTypeSignals('documento-generico.xlsx', 'WARRANTY SPARES - RECEIPT', 'recibo_auto', false);
  assert.equal(result.type, 'GARANTIA');
});

test('A1.1A HF1: Atualizar Sistema possui uma única entrada canônica de recibos e reutiliza a triagem existente', () => {
  const source = fs.readFileSync(path.join(frontend, 'src/pages/Cadastro.jsx'), 'utf8');
  const receiptsEntry = source.match(/<button[\s\S]{0,1200}?setRecibosImportOpen[\s\S]{0,1200}?>\s*RECIBOS\s*<\/button>/);
  assert.ok(receiptsEntry, 'entrada RECIBOS deve abrir a triagem inline em Atualizar Sistema');
  assert.doesNotMatch(receiptsEntry[0], /navigate\('\/recebimentos'\)/);
  assert.match(source, /import Recebimentos from '\.\/Recebimentos'/);
  assert.match(source, /<Recebimentos importOnly \/>/);
  assert.doesNotMatch(source, /<option value="recibo_material">Recibo Material \/ Garantia<\/option>/);
  assert.doesNotMatch(source, /<option value="recibo_pd">Recibo de PD<\/option>/);
});

test('A1.1A HF1: lote canônico usa classificação automática e preserva revisão humana', () => {
  const source = fs.readFileSync(path.join(frontend, 'src/pages/Recebimentos.jsx'), 'utf8');
  assert.match(source, /\/receipts\/batch\/jobs/);
  assert.match(source, /misturar Recibos de Material, Garantia e PD/);
  assert.match(source, /não grava nada antes da sua confirmação/);
  const triage = fs.readFileSync(path.join(root, 'sisha-backend/src/services/receiptBatchTriageService.js'), 'utf8');
  assert.match(triage, /requestedType: 'recibo_auto'/);
});

test('A1.1A HF1: card da frota exibe autor, role e data da confirmação sem apagar fonte bruta', () => {
  const source = fs.readFileSync(path.join(frontend, 'src/components/AircraftOperationalStateAdmin.jsx'), 'utf8');
  assert.match(source, /Fonte bruta:/);
  assert.match(source, /Confirmação administrativa:/);
  assert.match(source, /row\.confirmed_by/);
  assert.match(source, /row\.confirmed_role/);
  assert.match(source, /row\.confirmed_at/);
});


test('A1.1A C3.4 HF2: GARANTIA + FOC é preservado como informação compatível, não conflito de tipo', () => {
  const result = receiptTypeSignals(
    'RECIBO-055-2026-MAT-GARANTIA.doc',
    'THIS ITEM IS FREE OF CHARGE - FOC',
    'recibo_auto',
    false,
  );
  assert.equal(result.type, 'GARANTIA');
  assert.equal(result.isFoc, true);
  assert.ok(result.warnings.some((warning) => /GARANTIA[\s\S]*FOC/i.test(warning)));
});
