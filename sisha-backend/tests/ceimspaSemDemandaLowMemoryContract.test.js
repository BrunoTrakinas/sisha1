const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const controller = fs.readFileSync(path.join(root, 'src/controllers/ceimspaSemDemandaLowMemoryController.js'), 'utf8');
const routes = fs.readFileSync(path.join(root, 'src/routes/importRoutes.js'), 'utf8');

test('Sem Demanda possui endpoint dedicado em disco e fallback no upload atual', () => {
  assert.match(routes, /upload\/ceimspa-sem-demanda/);
  assert.match(routes, /multer\.diskStorage/);
  assert.match(routes, /tipoArquivo[^\n]+ceimspa_sem_demanda/);
  assert.match(routes, /importCeimspaSemDemandaLowMemory/);
});

test('controlador low-memory libera buffer e lê workbook dense linha a linha', () => {
  assert.match(controller, /req\.file\.buffer = null/);
  assert.match(controller, /xlsx\.readFile\(tempPath/);
  assert.match(controller, /dense:\s*true/);
  assert.match(controller, /parseCeimspaSemDemandaWorksheet/);
  assert.doesNotMatch(controller, /sheet_to_json/);
  assert.match(controller, /chunkSize = 250/);
  assert.match(controller, /LOW_MEMORY_SUCCESS/);
});
