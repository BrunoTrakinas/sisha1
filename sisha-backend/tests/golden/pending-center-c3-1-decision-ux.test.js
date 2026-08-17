const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const pendingModal = fs.readFileSync(path.join(ROOT, 'sisha-frontend', 'src', 'components', 'PendingCenterModal.jsx'), 'utf8');

test('C3.1: Central passa a abrir pela decisão humana e não pelo payload técnico', () => {
  assert.match(pendingModal, /O que precisa ser decidido\?/);
  assert.match(pendingModal, /O que deseja fazer\?/);
  assert.match(pendingModal, /Onde este equipamento está atualmente\?/);
});

test('C3.1: conflito de localização é explicado em português claro', () => {
  assert.match(pendingModal, /O mesmo equipamento aparece em duas localizações incompatíveis/);
  assert.match(pendingModal, /cadastro vigente informa/);
  assert.match(pendingModal, /nova evidência indica/);
  assert.match(pendingModal, /bloqueou a alteração automática/);
});

test('C3.1: localização atual e candidata viram ações semânticas', () => {
  assert.match(pendingModal, /MANTER \{currentLocation\.toUpperCase\(\)\}/);
  assert.match(pendingModal, /CONFIRMAR \{candidateLocation\.toUpperCase\(\)\}/);
  assert.match(pendingModal, /resolveEquipmentConflict\('CURRENT'\)/);
  assert.match(pendingModal, /resolveEquipmentConflict\('CANDIDATE'\)/);
});

test('C3.1: evidências completas e JSON ficam recolhidos por padrão', () => {
  assert.match(pendingModal, /function TechnicalDetails/);
  assert.match(pendingModal, /<details className=/);
  assert.match(pendingModal, /Ver evidências completas/);
  assert.match(pendingModal, /Detalhes técnicos preservados/);
  assert.match(pendingModal, /Ajustes técnicos avançados/);
});

test('C3.1: documento mostra correção simples antes do JSON avançado', () => {
  assert.match(pendingModal, /APROVAR INTERPRETAÇÃO/);
  assert.match(pendingModal, /CORRIGIR INTERPRETAÇÃO/);
  assert.match(pendingModal, /setCorrectionOpen\(true\)/);
  assert.match(pendingModal, /A evidência original permanece intacta/);
});

test('C3.1: força da evidência é qualitativa e não percentual cru', () => {
  assert.match(pendingModal, /function evidenceStrength/);
  assert.match(pendingModal, /força: \{candidateStrength\}/);
  assert.doesNotMatch(pendingModal, /Confiança: \{Math\.round/);
});

test('C3.1: filtros deixam de exigir rolagem horizontal', () => {
  assert.match(pendingModal, /mt-3 flex flex-wrap gap-2 pb-2/);
  assert.doesNotMatch(pendingModal, /mt-3 flex gap-2 overflow-x-auto pb-2/);
});

test('C3.1: domínios especializados preservam os serviços donos mesmo com UX orientada à decisão', () => {
  assert.match(pendingModal, /REVISAR NO MÓDULO DE RECIBOS/);
  assert.match(pendingModal, /\/import\/rfq\/salvar/);
  assert.match(pendingModal, /mesmo endpoint comercial/);
});
