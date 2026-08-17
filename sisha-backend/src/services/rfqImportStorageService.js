const crypto = require('crypto');
const {
  isConfigured,
  config,
  putPrivateObject,
  getPrivateObject,
  deletePrivateObject,
} = require('./manualStorageService');

function assertConfigured() {
  if (!isConfigured()) {
    const error = new Error('Processamento persistente de Cotações/RFQ exige o R2 privado já configurado no backend.');
    error.code = 'RFQ_IMPORT_R2_NOT_CONFIGURED';
    throw error;
  }
}

function sanitizeFileName(value = 'documento') {
  return String(value || 'documento')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 120) || 'documento';
}

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function buildObjectKey({ hash, fileName }) {
  const day = new Date().toISOString().slice(0, 10);
  return `sisha/rfq-imports/${day}/${hash.slice(0, 16)}-${sanitizeFileName(fileName)}`;
}

async function storeFile({ buffer, fileName, contentType = 'application/octet-stream' }) {
  assertConfigured();
  const hash = sha256(buffer);
  const key = buildObjectKey({ hash, fileName });
  const result = await putPrivateObject({ key, buffer, contentType });
  return { ...result, sha256: hash, key, bucket: config().bucket };
}

async function loadFile(key) {
  assertConfigured();
  return getPrivateObject({ key });
}

module.exports = {
  assertConfigured,
  sha256,
  storeFile,
  loadFile,
  deletePrivateObject,
};
