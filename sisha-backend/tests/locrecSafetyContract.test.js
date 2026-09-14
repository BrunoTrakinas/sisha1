const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('LOCREC consultivo não grava estoque/recebimentos nem cria rota de decisão operacional', () => {
  const serviceFiles = [
    'src/services/locrecParserService.js',
    'src/services/locrecSnapshotService.js',
    'src/services/locrecReconciliationService.js',
  ].map((file) => fs.readFileSync(path.join(__dirname, '..', file), 'utf8')).join('\n');

  for (const forbidden of [
    ".from('estoque_ppu').insert",
    ".from('estoque_ppu').update",
    ".from('estoque_ceimspa').insert",
    ".from('estoque_ceimspa').update",
    ".from('recebimento_itens').insert",
    ".from('recebimento_itens').update",
    ".from('recebimentos').insert",
    ".from('recebimentos').update",
  ]) {
    assert.equal(serviceFiles.includes(forbidden), false, `Contrato consultivo violado por ${forbidden}`);
  }
});

test('migration LOCREC cria somente camada própria e não altera estoques/recibos', () => {
  const sql = fs.readFileSync(path.join(__dirname, '..', 'sql/migrations/20260911_LOCREC_001_consultivo_snapshot.sql'), 'utf8').toLowerCase();
  assert.match(sql, /create table if not exists public\.locrec_importacoes/);
  assert.match(sql, /create table if not exists public\.locrec_itens/);
  for (const forbidden of [
    'alter table public.estoque_ppu',
    'alter table public.estoque_ceimspa',
    'alter table public.recebimentos',
    'alter table public.recebimento_itens',
    'update public.estoque_ppu',
    'update public.estoque_ceimspa',
    'update public.recebimentos',
    'update public.recebimento_itens',
  ]) {
    assert.equal(sql.includes(forbidden), false, `Migration consultiva violou isolamento: ${forbidden}`);
  }
});

test('LOCREC e Backend permanecem trilhas independentes', () => {
  const root = path.join(__dirname, '..');
  const locrec = fs.readFileSync(path.join(root, 'src/services/locrecReconciliationService.js'), 'utf8');
  const search = fs.readFileSync(path.join(root, 'src/controllers/searchController.js'), 'utf8');
  assert.doesNotMatch(locrec, /ppu_custodia_externa/i);
  assert.doesNotMatch(locrec, /backend_evidence_scope/i);
  assert.doesNotMatch(search, /PPU_LOCAL_RECLASSIFICADO_CEIMSPA/);
  assert.match(search, /ppu_custodia_qtd/);
  assert.match(search, /ppu_total_controlado_qtd/);
});

test('disponibilidade operacional exclui custódia Backend sem apagar contabilidade PPU', () => {
  const service = fs.readFileSync(path.join(__dirname, '..', 'src/services/ppuEffectiveAvailabilityService.js'), 'utf8');
  assert.match(service, /quantidade_controlada/);
  assert.match(service, /quantidade_disponivel:\s*0/);
  assert.match(service, /disponivel_operacional:\s*false/);
  assert.match(service, /applyLocrecReceiptLocations/);
});
