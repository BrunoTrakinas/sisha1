const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const dossier = require('../../src/services/equipmentDossierService');
const backend = (rel) => fs.readFileSync(path.join(__dirname, '..', '..', rel), 'utf8');
const frontend = (rel) => fs.readFileSync(path.join(__dirname, '..', '..', '..', 'sisha-frontend', rel), 'utf8');

test('HF Equipamentos Inteligente: OS de remoção informa aeronave sem inventar destino', () => {
  const summary = dossier.buildLatestMovementSummary([{ id: 1, tipo_evento: 'REMOCAO_ANV', data_evento: '2026-08-01T12:00:00Z', os: '40050235', anv: '4005', categoria_destino: 'DESCONHECIDO', documento_tipo: 'OS', documento: 'OS 40050235/2026', motivo: 'Remoção', invalidado: false }]);
  assert.equal(summary.tipo, 'REMOCAO');
  assert.equal(summary.aeronave, '4005');
  assert.equal(summary.destino_conhecido, false);
  assert.equal(summary.estado, 'REMOVIDO_DA_AERONAVE_DESTINO_A_CONFIRMAR');
  assert.match(summary.leitura, /aeronave 4005/);
});

test('HF Equipamentos Inteligente: instalação com aeronave é explicitada', () => {
  const summary = dossier.buildLatestMovementSummary([{ tipo_evento: 'INSTALACAO_ANV', data_evento: '2026-08-01T12:00:00Z', anv_destino: '4003', local_destino: 'AERONAVE 4003', categoria_destino: 'AERONAVE', invalidado: false }]);
  assert.equal(summary.estado, 'INSTALADO_EM_AERONAVE');
  assert.equal(summary.aeronave, '4003');
});

test('HF Equipamentos Inteligente: nomenclatura por PN prioriza cadastro e resolve Manual/WTP somente quando necessário', () => {
  const service = backend('src/services/equipmentService.js');
  assert.match(service, /resolveNomenclaturesByPn/);
  assert.match(service, /dicionario_mestre/);
  assert.match(service, /v_sisha_manual_pn_aplicacao/);
  assert.match(service, /syncNomenclatureByPn/);
  assert.match(service, /onlyMissing/);
});

test('HF Equipamentos Inteligente: edição/inserção de nome sincroniza todos os SN do mesmo PN', () => {
  const service = backend('src/services/equipmentService.js');
  assert.match(service, /payload\.nomenclatura\) await syncNomenclatureByPn\(payload\.pn, payload\.nomenclatura, user\)/);
  assert.match(service, /Object\.prototype\.hasOwnProperty\.call\(input, 'nomenclatura'\)/);
});

test('HF Equipamentos Inteligente: UI mostra leitura operacional e oferece enriquecimento seguro', () => {
  const page = frontend('src/pages/Equipamentos.jsx');
  assert.match(page, /Completar nomes pelo Manual Técnico/);
  assert.match(page, /Leitura operacional da última movimentação/);
  assert.match(page, /não inventa o destino/);
  assert.match(page, /nomenclatura_resolvida/);
});
