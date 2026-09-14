const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const importController = fs.readFileSync(path.join(root, 'src/controllers/importController.js'), 'utf8');
const chatLince = fs.readFileSync(path.join(root, 'src/services/chatLinceService.js'), 'utf8');

test('importador de publicação técnica aciona OCR para PDF sem texto e reconhece PAN antes do parser SB legado', () => {
  assert.match(importController, /extractTechnicalPublicationTextWithLocalOcr/);
  assert.match(importController, /rawText\.trim\(\)\.length < 80/);
  assert.match(importController, /parsePanPublicationText\(rawText, originalName\)/);
  assert.match(importController, /documentType:\s*'SB'/);
  assert.match(importController, /tipo_documento:\s*documentType/);
});

test('Chat Lince reconhece Product Advisory Notice e PAN como publicação técnica', () => {
  assert.match(chatLince, /PRODUCT ADVISORY NOTICE/);
  assert.match(chatLince, /LX\\\/PAN/);
  assert.match(chatLince, /PUBLICAÇÃO|publicação técnica SB\/PAN/i);
});
