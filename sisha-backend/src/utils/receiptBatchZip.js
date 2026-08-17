const crypto = require('crypto');
const zlib = require('zlib');
const path = require('path');

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;
const MAX_ENTRIES = 150;
const MAX_FILE_SIZE = 25 * 1024 * 1024;
const MAX_TOTAL_UNCOMPRESSED = 120 * 1024 * 1024;
const MAX_COMPRESSION_RATIO = 250;
const ALLOWED_EXTENSIONS = new Set([
  '.pdf', '.xlsx', '.xls', '.csv', '.ods', '.txt', '.doc', '.docx', '.odt',
  '.jpg', '.jpeg', '.png', '.webp',
]);

function mimeForExtension(extension) {
  const map = {
    '.pdf': 'application/pdf',
    '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    '.xls': 'application/vnd.ms-excel',
    '.csv': 'text/csv',
    '.ods': 'application/vnd.oasis.opendocument.spreadsheet',
    '.txt': 'text/plain',
    '.doc': 'application/msword',
    '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    '.odt': 'application/vnd.oasis.opendocument.text',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png': 'image/png',
    '.webp': 'image/webp',
  };
  return map[extension] || 'application/octet-stream';
}

function findEocd(buffer) {
  const minOffset = Math.max(0, buffer.length - 0xffff - 22);
  for (let offset = buffer.length - 22; offset >= minOffset; offset -= 1) {
    if (buffer.readUInt32LE(offset) === EOCD_SIGNATURE) return offset;
  }
  return -1;
}

function safeEntryName(rawName) {
  const normalized = String(rawName || '').replace(/\\/g, '/');
  const baseName = path.posix.basename(normalized).trim();
  if (!baseName || baseName === '.' || baseName === '..') return null;
  if (normalized.includes('__MACOSX/') || baseName.startsWith('._')) return null;
  return baseName;
}

function unpackReceiptZip(buffer, options = {}) {
  const outputMode = options.outputMode === 'buffer' ? 'buffer' : 'base64';
  if (!Buffer.isBuffer(buffer) || buffer.length < 22) {
    throw new Error('Arquivo ZIP inválido ou vazio.');
  }

  const eocdOffset = findEocd(buffer);
  if (eocdOffset < 0) throw new Error('Não foi possível localizar o diretório central do ZIP.');

  const diskNumber = buffer.readUInt16LE(eocdOffset + 4);
  const centralDisk = buffer.readUInt16LE(eocdOffset + 6);
  if (diskNumber !== 0 || centralDisk !== 0) {
    throw new Error('ZIP dividido em múltiplos volumes não é suportado.');
  }

  const totalEntries = buffer.readUInt16LE(eocdOffset + 10);
  const centralSize = buffer.readUInt32LE(eocdOffset + 12);
  const centralOffset = buffer.readUInt32LE(eocdOffset + 16);

  if (totalEntries > MAX_ENTRIES) {
    throw new Error(`O ZIP possui ${totalEntries} arquivos. O limite por lote é ${MAX_ENTRIES}.`);
  }
  if (centralOffset + centralSize > buffer.length) {
    throw new Error('Diretório central do ZIP está corrompido.');
  }

  const files = [];
  const ignored = [];
  let cursor = centralOffset;
  let totalUncompressed = 0;

  for (let index = 0; index < totalEntries; index += 1) {
    if (cursor + 46 > buffer.length || buffer.readUInt32LE(cursor) !== CENTRAL_SIGNATURE) {
      throw new Error('Estrutura do ZIP inválida durante leitura dos arquivos.');
    }

    const flags = buffer.readUInt16LE(cursor + 8);
    const method = buffer.readUInt16LE(cursor + 10);
    const compressedSize = buffer.readUInt32LE(cursor + 20);
    const uncompressedSize = buffer.readUInt32LE(cursor + 24);
    const nameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const commentLength = buffer.readUInt16LE(cursor + 32);
    const localOffset = buffer.readUInt32LE(cursor + 42);
    const nameStart = cursor + 46;
    const nameEnd = nameStart + nameLength;

    if (nameEnd > buffer.length) throw new Error('Nome de arquivo inválido no ZIP.');
    const rawName = buffer.subarray(nameStart, nameEnd).toString('utf8');
    cursor = nameEnd + extraLength + commentLength;

    if (rawName.endsWith('/')) continue;
    const fileName = safeEntryName(rawName);
    if (!fileName) continue;

    const extension = path.extname(fileName).toLowerCase();
    if (!ALLOWED_EXTENSIONS.has(extension)) {
      ignored.push({ name: fileName, reason: 'FORMATO_NAO_SUPORTADO' });
      continue;
    }
    if (flags & 0x0001) {
      ignored.push({ name: fileName, reason: 'ARQUIVO_CRIPTOGRAFADO' });
      continue;
    }
    if (![0, 8].includes(method)) {
      ignored.push({ name: fileName, reason: `COMPRESSAO_NAO_SUPORTADA_${method}` });
      continue;
    }
    if (uncompressedSize > MAX_FILE_SIZE) {
      ignored.push({ name: fileName, reason: 'ARQUIVO_MUITO_GRANDE' });
      continue;
    }
    if (compressedSize > 0 && uncompressedSize / compressedSize > MAX_COMPRESSION_RATIO) {
      ignored.push({ name: fileName, reason: 'TAXA_DE_COMPRESSAO_SUSPEITA' });
      continue;
    }

    totalUncompressed += uncompressedSize;
    if (totalUncompressed > MAX_TOTAL_UNCOMPRESSED) {
      throw new Error('O conteúdo descompactado do ZIP ultrapassa o limite seguro de 120 MB.');
    }

    if (localOffset + 30 > buffer.length || buffer.readUInt32LE(localOffset) !== LOCAL_SIGNATURE) {
      throw new Error(`Cabeçalho local inválido para ${fileName}.`);
    }
    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const dataEnd = dataStart + compressedSize;
    if (dataEnd > buffer.length) throw new Error(`Conteúdo truncado no ZIP para ${fileName}.`);

    const compressed = buffer.subarray(dataStart, dataEnd);
    let content;
    if (method === 0) content = Buffer.from(compressed);
    else content = zlib.inflateRawSync(compressed, { maxOutputLength: MAX_FILE_SIZE });

    if (uncompressedSize !== content.length) {
      throw new Error(`Tamanho descompactado divergente para ${fileName}.`);
    }

    files.push({
      name: fileName,
      size: content.length,
      mime: mimeForExtension(extension),
      sha256: crypto.createHash('sha256').update(content).digest('hex'),
      ...(outputMode === 'buffer' ? { content } : { base64: content.toString('base64') }),
    });
  }

  if (!files.length) {
    throw new Error('O ZIP não contém recibos em formatos suportados.');
  }

  return { files, ignored };
}

module.exports = {
  unpackReceiptZip,
  ALLOWED_EXTENSIONS,
};
