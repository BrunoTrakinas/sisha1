const crypto = require('crypto');

function env(name, fallback = '') {
  return String(process.env[name] || fallback || '').trim();
}

function config() {
  const endpoint = env('R2_ENDPOINT') || env('CLOUDFLARE_R2_ENDPOINT');
  const accessKeyId = env('R2_ACCESS_KEY_ID') || env('CLOUDFLARE_R2_ACCESS_KEY_ID');
  const secretAccessKey = env('R2_SECRET_ACCESS_KEY') || env('CLOUDFLARE_R2_SECRET_ACCESS_KEY');
  const bucket = env('R2_MANUALS_BUCKET') || env('R2_BUCKET') || env('CLOUDFLARE_R2_BUCKET') || env('CLOUDFLARE_R2_BUCKET_NAME');
  return { endpoint: endpoint.replace(/\/$/, ''), accessKeyId, secretAccessKey, bucket };
}

function isConfigured() {
  const cfg = config();
  return Boolean(cfg.endpoint && cfg.accessKeyId && cfg.secretAccessKey && cfg.bucket);
}

function publicConfig() {
  const cfg = config();
  let endpointHost = '';
  try { endpointHost = cfg.endpoint ? new URL(cfg.endpoint).host : ''; } catch (_) { endpointHost = ''; }
  const maskedAccessKey = cfg.accessKeyId
    ? `${cfg.accessKeyId.slice(0, 4)}...${cfg.accessKeyId.slice(-4)}`
    : null;
  return {
    configured: isConfigured(),
    endpoint_host: endpointHost || null,
    bucket: cfg.bucket || null,
    access_key_masked: maskedAccessKey,
  };
}

function hmac(key, value, encoding) {
  return crypto.createHmac('sha256', key).update(value, 'utf8').digest(encoding);
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function encodePath(path) {
  return String(path || '')
    .split('/')
    .filter((part) => part !== '')
    .map((part) => encodeURIComponent(part).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`))
    .join('/');
}

function buildSignedRequest({
  method,
  key = null,
  body = Buffer.alloc(0),
  contentType = 'application/octet-stream',
  bucketOnly = false,
}) {
  const cfg = config();
  if (!isConfigured()) throw new Error('R2 privado de manuais não configurado no backend.');

  const endpointUrl = new URL(cfg.endpoint);
  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const dateStamp = amzDate.slice(0, 8);
  const region = 'auto';
  const service = 's3';
  const payloadHash = sha256(body);
  const canonicalUri = bucketOnly
    ? `/${encodePath(cfg.bucket)}`
    : `/${encodePath(cfg.bucket)}/${encodePath(key)}`;
  const host = endpointUrl.host;
  const includeContentType = method === 'PUT';
  const signedHeaders = includeContentType
    ? 'content-type;host;x-amz-content-sha256;x-amz-date'
    : 'host;x-amz-content-sha256;x-amz-date';
  const canonicalHeaders = includeContentType
    ? `content-type:${contentType}\nhost:${host}\nx-amz-content-sha256:${payloadHash}\nx-amz-date:${amzDate}\n`
    : `host:${host}\nx-amz-content-sha256:${payloadHash}\nx-amz-date:${amzDate}\n`;
  const canonicalRequest = [method, canonicalUri, '', canonicalHeaders, signedHeaders, payloadHash].join('\n');
  const algorithm = 'AWS4-HMAC-SHA256';
  const credentialScope = `${dateStamp}/${region}/${service}/aws4_request`;
  const stringToSign = [algorithm, amzDate, credentialScope, sha256(Buffer.from(canonicalRequest, 'utf8'))].join('\n');

  const kDate = hmac(Buffer.from(`AWS4${cfg.secretAccessKey}`, 'utf8'), dateStamp);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, service);
  const kSigning = hmac(kService, 'aws4_request');
  const signature = crypto.createHmac('sha256', kSigning).update(stringToSign, 'utf8').digest('hex');
  const authorization = `${algorithm} Credential=${cfg.accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

  const headers = {
    host,
    'x-amz-content-sha256': payloadHash,
    'x-amz-date': amzDate,
    Authorization: authorization,
  };
  if (includeContentType) headers['content-type'] = contentType;

  return {
    url: `${endpointUrl.protocol}//${host}${canonicalUri}`,
    headers,
    bucket: cfg.bucket,
  };
}

async function putPrivateObject({ key, buffer, contentType = 'application/pdf' }) {
  const body = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer || '');
  const signed = buildSignedRequest({ method: 'PUT', key, body, contentType });
  const response = await fetch(signed.url, { method: 'PUT', headers: signed.headers, body });
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`Falha ao armazenar manual no R2 privado (${response.status}). ${text.slice(0, 300)}`);
  }
  return {
    bucket: signed.bucket,
    key,
    status: 'R2_PRIVATE',
    etag: response.headers.get('etag') || null,
    uploaded_at: new Date().toISOString(),
  };
}

async function getPrivateObject({ key }) {
  const signed = buildSignedRequest({ method: 'GET', key, body: Buffer.alloc(0) });
  const response = await fetch(signed.url, { method: 'GET', headers: signed.headers });
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`Falha ao recuperar manual do R2 privado (${response.status}). ${text.slice(0, 300)}`);
  }
  return {
    buffer: Buffer.from(await response.arrayBuffer()),
    contentType: response.headers.get('content-type') || 'application/pdf',
    etag: response.headers.get('etag') || null,
  };
}

async function deletePrivateObject({ key }) {
  if (!key) return { ok: true, skipped: true };
  const signed = buildSignedRequest({ method: 'DELETE', key, body: Buffer.alloc(0) });
  const response = await fetch(signed.url, { method: 'DELETE', headers: signed.headers });
  if (!response.ok && response.status !== 404) {
    const text = await response.text().catch(() => '');
    throw new Error(`Falha ao remover objeto incompleto do R2 (${response.status}). ${text.slice(0, 300)}`);
  }
  return { ok: true, status: response.status };
}

async function checkReadiness() {
  const visible = publicConfig();
  if (!visible.configured) {
    return {
      ...visible,
      head_bucket_ok: false,
      message: 'Credenciais R2 de manuais ainda não configuradas no backend.',
    };
  }

  try {
    const signed = buildSignedRequest({ method: 'HEAD', bucketOnly: true, body: Buffer.alloc(0) });
    const response = await fetch(signed.url, { method: 'HEAD', headers: signed.headers });
    if (!response.ok) {
      return {
        ...visible,
        head_bucket_ok: false,
        http_status: response.status,
        message: `R2 configurado, mas o bucket não respondeu ao HeadBucket com sucesso (HTTP ${response.status}).`,
      };
    }
    return {
      ...visible,
      head_bucket_ok: true,
      http_status: response.status,
      message: 'R2 privado configurado e bucket acessível pelo backend.',
    };
  } catch (error) {
    return {
      ...visible,
      head_bucket_ok: false,
      message: error.message || 'Falha ao validar o bucket R2.',
    };
  }
}

module.exports = {
  isConfigured,
  config,
  publicConfig,
  putPrivateObject,
  getPrivateObject,
  deletePrivateObject,
  checkReadiness,
};
