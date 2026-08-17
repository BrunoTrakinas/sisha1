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
    const error = new Error('Importação durável de recibos exige o R2 privado já configurado no backend.');
    error.code = 'RECEIPT_BATCH_R2_NOT_CONFIGURED';
    throw error;
  }
}

function sanitizeFileName(value = 'arquivo') {
  return String(value || 'arquivo')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 120) || 'arquivo';
}

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function buildArchiveKey({ hash, fileName }) {
  const day = new Date().toISOString().slice(0, 10);
  return `sisha/receipt-imports/${day}/${hash.slice(0, 16)}-${sanitizeFileName(fileName)}`;
}

function buildDirectObjectKey({ hash, fileName }) {
  const day = new Date().toISOString().slice(0, 10);
  return `sisha/receipt-imports/${day}/files/${hash.slice(0, 16)}-${sanitizeFileName(fileName)}`;
}

async function storeArchive({ buffer, fileName, contentType = 'application/zip' }) {
  assertConfigured();
  const hash = sha256(buffer);
  const key = buildArchiveKey({ hash, fileName });
  const result = await putPrivateObject({ key, buffer, contentType });
  return { ...result, sha256: hash, key, bucket: config().bucket };
}

async function storeDirectFile({ buffer, fileName, contentType = 'application/octet-stream' }) {
  assertConfigured();
  const hash = sha256(buffer);
  const key = buildDirectObjectKey({ hash, fileName });
  const result = await putPrivateObject({ key, buffer, contentType });
  return { ...result, sha256: hash, key, bucket: config().bucket };
}

async function loadObject(key) {
  assertConfigured();
  return getPrivateObject({ key });
}

module.exports = {
  assertConfigured,
  sha256,
  storeArchive,
  storeDirectFile,
  loadObject,
  deletePrivateObject,
};
