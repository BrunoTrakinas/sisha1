const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const controller = fs.readFileSync(path.join(root, 'src/controllers/ceimspaSemDemandaLowMemoryController.js'), 'utf8');
const routes = fs.readFileSync(path.join(root, 'src/routes/importRoutes.js'), 'utf8');
const legacyReader = fs.readFileSync(path.join(root, 'src/services/ceimspaSemDemandaLegacyXlsReader.js'), 'utf8');

test('Sem Demanda possui endpoint dedicado em disco e fallback no upload atual', () => {
  assert.match(routes, /upload\/ceimspa-sem-demanda/);
  assert.match(routes, /multer\.diskStorage/);
  assert.match(routes, /tipoArquivo[^\n]+ceimspa_sem_demanda/);
  assert.match(routes, /importCeimspaSemDemandaLowMemory/);
});

test('XLS legado usa leitor BIFF incremental e não passa pelo SheetJS', () => {
  assert.match(controller, /extension === '\.xls'/);
  assert.match(controller, /parseCeimspaSemDemandaLegacyXls\(tempPath/);
  assert.match(controller, /LEGACY_XLS_BIFF_INCREMENTAL/);
  assert.match(legacyReader, /parseOleWorkbook/);
  assert.match(legacyReader, /parseLegacyXlsRows/);
  assert.doesNotMatch(legacyReader, /require\(['"]xlsx['"]\)/);
});

test('XLSX mantém caminho dense existente e importação continua em lotes', () => {
  assert.match(controller, /const xlsx = require\('xlsx'\)/);
  assert.match(controller, /xlsx\.readFile\(tempPath/);
  assert.match(controller, /dense:\s*true/);
  assert.match(controller, /parseCeimspaSemDemandaWorksheet/);
  assert.doesNotMatch(controller, /sheet_to_json/);
  assert.match(controller, /chunkSize = 250/);
  assert.match(controller, /LOW_MEMORY_PARSED/);
  assert.match(controller, /LOW_MEMORY_SUCCESS/);
});
