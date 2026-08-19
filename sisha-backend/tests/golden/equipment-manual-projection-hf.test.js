const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '../..');
const service = fs.readFileSync(path.join(root, 'src/services/equipmentService.js'), 'utf8');
const controller = fs.readFileSync(path.join(root, 'src/controllers/equipmentController.js'), 'utf8');
const migration = fs.readFileSync(path.join(root, 'sql/migrations/20260818_HF_EQUIPMENT_MANUAL_PROJECTION_001.sql'), 'utf8');
const frontend = fs.readFileSync(path.join(root, '../sisha-frontend/src/pages/Equipamentos.jsx'), 'utf8');

test('HF Equipamentos: Registrar movimentação grava Livro e projeta localização atual', () => {
  assert.match(controller, /addProjectedEvent\(req\.params\.id, req\.body \|\| \{\}, req\.user \|\| \{\}\)/);
  assert.match(service, /sisha_record_equipment_event_and_project_atomic/);
  assert.match(service, /project_current_state:\s*true/);
});

test('HF Equipamentos: edição de localização projeta estado sem apagar histórico', () => {
  assert.match(service, /sisha_update_equipment_and_project_atomic/);
  assert.match(service, /project_current_state:\s*stateChanged/);
  assert.match(service, /tipo_evento:\s*identityChanged \? 'CORRECAO_CADASTRAL' : \(stateChanged \? 'AJUSTE_MANUAL'/);
});

test('HF Equipamentos: projeção é temporal e ignora conflito, histórico-only e evento invalidado', () => {
  assert.match(migration, /coalesce\(e\.invalidado, false\) = false/);
  assert.match(migration, /CONFLITO_LOCALIZACAO/);
  assert.match(migration, /historical_only/);
  assert.match(migration, /order by e\.data_evento desc nulls last, e\.id desc/);
});

test('HF Equipamentos: invalidação recompõe posição anterior válida', () => {
  assert.match(service, /sisha_invalidate_equipment_event_and_project_atomic/);
  assert.match(migration, /sisha_invalidate_equipment_event_and_project_atomic/);
  assert.match(migration, /sisha_project_equipment_current_state\(p_equipment_id, p_user_email\)/);
});

test('HF Equipamentos: reconciliação confirmada também atualiza projeção corrente', () => {
  assert.match(service, /sisha_resolve_location_conflict_and_project_atomic/);
  assert.match(service, /project_current_state:\s*true/);
  assert.match(migration, /sisha_resolve_location_conflict_and_project_atomic/);
});

test('HF Equipamentos: novas RPCs permanecem service-role only', () => {
  for (const signature of [
    'sisha_project_equipment_current_state(bigint, text)',
    'sisha_create_equipment_and_project_atomic(jsonb, jsonb, text)',
    'sisha_record_equipment_event_and_project_atomic(bigint, jsonb, text)',
    'sisha_update_equipment_and_project_atomic(bigint, jsonb, jsonb, text)',
    'sisha_invalidate_equipment_event_and_project_atomic(bigint, bigint, text, text)',
    'sisha_resolve_location_conflict_and_project_atomic(bigint, bigint, jsonb, text, text, text)',
  ]) {
    assert.ok(migration.includes(`revoke all on function public.${signature} from public, anon, authenticated;`));
    assert.ok(migration.includes(`grant execute on function public.${signature} to service_role;`));
  }
});

test('HF Equipamentos: UI traduz fontes e arquivos conhecidos sem alterar o dado bruto', () => {
  assert.match(frontend, /Inventário do PPU/);
  assert.match(frontend, /Controle de Equipamentos Críticos/);
  assert.match(frontend, /Master OS — Divisão de Planejamento/);
  assert.match(frontend, /Order Book Leonardo/);
  assert.match(frontend, /humanizeDocumentReference/);
  assert.match(frontend, /INVENTARIOGERALPPU/);
  assert.match(frontend, /title=\{inventoryDraft\.arquivo_nome \|\| ''\}/);
});

test('HF Equipamentos: controles principais deixam de expor jargão técnico desnecessário', () => {
  assert.match(frontend, /Pesquisa avançada/);
  assert.match(frontend, /Pendências do Chat Lince/);
  assert.match(frontend, /Substituir a fotografia atual do inventário/);
  assert.match(frontend, /Movimentações por STC/);
  assert.match(frontend, /Movimentações por OS \/ PIM/);
  assert.match(frontend, /Registrar movimentação/);
  assert.doesNotMatch(frontend, />Staging Chat Lince/);
  assert.doesNotMatch(frontend, /Substituir o snapshot serializado/);
});

test('HF Equipamentos: situação usa opções humanizadas na pesquisa, edição e movimentação', () => {
  assert.match(frontend, /const statusOptions = Object\.entries\(statusUiLabels\)/);
  assert.match(frontend, /Situação após a movimentação/);
  assert.match(frontend, /value=\{equipmentForm\.status_atual\}.*?statusOptions\.map/s);
  assert.match(frontend, /value=\{eventForm\.status_resultante\}.*?statusOptions\.map/s);
  assert.doesNotMatch(frontend, /Status começa com/);
});
