const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

test('C2.7 HF2: backend/frontend avançam juntos e invalidam o job bloqueado anterior', () => {
  const jobs = read('src/services/rfqImportJobService.js');
  const front = fs.readFileSync(path.resolve(ROOT, '../sisha-frontend/src/components/RfqImporter.jsx'), 'utf8');
  const backendVersion = jobs.match(/const ANALYSIS_VERSION = '([^']+)'/)?.[1] || null;
  const frontendVersion = front.match(/const CURRENT_ANALYSIS_VERSION = '([^']+)'/)?.[1] || null;

  assert.equal(backendVersion, 'C2.7-HF2-LOCAL-OCR-RETRY-CACHE-1');
  assert.equal(frontendVersion, backendVersion);
  assert.notEqual(backendVersion, 'C2.7-LOCAL-OCR-EVIDENCE-GATE-1');
});

test('C2.7 HF2: indisponibilidade transitória do OCR local nunca é reutilizada como análise pronta', () => {
  const jobs = read('src/services/rfqImportJobService.js');

  assert.match(jobs, /transientOcrUnavailable/);
  assert.match(jobs, /visualCommercial\?\.unavailable === true/);
  assert.match(jobs, /OCR_LOCAL_INDISPONIVEL_BLOQUEADO/i);
  assert.match(jobs, /TESSERACT_INDISPONIVEL\|PDFTOPPM_INDISPONIVEL/);
  assert.match(jobs, /reusable\?\.result_payload && !transientOcrUnavailable/);
});

test('C2.7 HF2: job bloqueado antigo é preservado; correção não apaga nem reescreve histórico', () => {
  const jobs = read('src/services/rfqImportJobService.js');

  assert.doesNotMatch(jobs, /from\('rfq_import_jobs'\)[\s\S]{0,300}\.delete\(/);
  assert.doesNotMatch(jobs, /update\(.*analysis_version/s);
  assert.match(jobs, /\.insert\(\{/);
});
