const zlib = require('zlib');

const MAX_ARCHIVE_BYTES = 25 * 1024 * 1024;
const MAX_ENTRY_UNCOMPRESSED = 12 * 1024 * 1024;
const MAX_TOTAL_UNCOMPRESSED = 40 * 1024 * 1024;
const MAX_MEDIA_IMAGES = 8;

function publicError(message) {
  const error = new Error(message);
  error.statusCode = 400;
  error.publicMessage = message;
  return error;
}

function decodeXmlEntities(value) {
  return String(value || '')
    .replace(/&#x([0-9a-f]+);/gi, (_match, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#([0-9]+);/g, (_match, dec) => String.fromCodePoint(parseInt(dec, 10)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function findEndOfCentralDirectory(buffer) {
  const signature = 0x06054b50;
  const minOffset = Math.max(0, buffer.length - 0xFFFF - 22);
  for (let offset = buffer.length - 22; offset >= minOffset; offset -= 1) {
    if (buffer.readUInt32LE(offset) === signature) return offset;
  }
  return -1;
}

function parseZipEntries(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 22) throw publicError('Documento Office vazio ou inválido.');
  if (buffer.length > MAX_ARCHIVE_BYTES) throw publicError('Documento Office excede o limite seguro de 25 MB.');

  const eocd = findEndOfCentralDirectory(buffer);
  if (eocd < 0) throw publicError('Estrutura ZIP do documento Office não reconhecida.');

  const entryCount = buffer.readUInt16LE(eocd + 10);
  const centralSize = buffer.readUInt32LE(eocd + 12);
  const centralOffset = buffer.readUInt32LE(eocd + 16);
  if (entryCount > 4000 || centralOffset + centralSize > buffer.length) {
    throw publicError('Estrutura interna do documento Office é inválida ou excessiva.');
  }

  const entries = new Map();
  let offset = centralOffset;
  let totalUncompressed = 0;

  for (let index = 0; index < entryCount; index += 1) {
    if (offset + 46 > buffer.length || buffer.readUInt32LE(offset) !== 0x02014b50) {
      throw publicError('Diretório interno do documento Office está corrompido.');
    }

    const flags = buffer.readUInt16LE(offset + 8);
    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const uncompressedSize = buffer.readUInt32LE(offset + 24);
    const fileNameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const nameStart = offset + 46;
    const nameEnd = nameStart + fileNameLength;
    if (nameEnd > buffer.length) throw publicError('Nome de entrada inválido no documento Office.');

    const fileName = buffer.subarray(nameStart, nameEnd).toString((flags & 0x800) ? 'utf8' : 'utf8');
    totalUncompressed += uncompressedSize;
    if (uncompressedSize > MAX_ENTRY_UNCOMPRESSED || totalUncompressed > MAX_TOTAL_UNCOMPRESSED) {
      throw publicError('Documento Office descompactado excede o limite seguro.');
    }

    entries.set(fileName, { fileName, method, compressedSize, uncompressedSize, localOffset });
    offset = nameEnd + extraLength + commentLength;
  }

  function readEntry(name) {
    const entry = entries.get(name);
    if (!entry) return null;
    const local = entry.localOffset;
    if (local + 30 > buffer.length || buffer.readUInt32LE(local) !== 0x04034b50) {
      throw publicError(`Entrada interna inválida: ${name}.`);
    }
    const localNameLength = buffer.readUInt16LE(local + 26);
    const localExtraLength = buffer.readUInt16LE(local + 28);
    const dataStart = local + 30 + localNameLength + localExtraLength;
    const dataEnd = dataStart + entry.compressedSize;
    if (dataEnd > buffer.length) throw publicError(`Entrada interna truncada: ${name}.`);
    const compressed = buffer.subarray(dataStart, dataEnd);
    let output;
    if (entry.method === 0) output = Buffer.from(compressed);
    else if (entry.method === 8) output = zlib.inflateRawSync(compressed);
    else throw publicError(`Método de compressão não suportado no documento Office (${entry.method}).`);
    if (output.length > MAX_ENTRY_UNCOMPRESSED) throw publicError(`Entrada interna muito grande: ${name}.`);
    return output;
  }

  return { entries, readEntry };
}

function xmlToReadableText(xml, format) {
  let value = String(xml || '');
  if (format === 'docx') {
    value = value
      .replace(/<w:tab\b[^>]*\/>/gi, '\t')
      .replace(/<w:br\b[^>]*\/>/gi, '\n')
      .replace(/<\/w:tc>/gi, '\t')
      .replace(/<\/w:tr>/gi, '\n')
      .replace(/<\/w:p>/gi, '\n');
  } else {
    value = value
      .replace(/<text:tab\b[^>]*\/>/gi, '\t')
      .replace(/<text:line-break\b[^>]*\/>/gi, '\n')
      .replace(/<\/table:table-cell>/gi, '\t')
      .replace(/<\/table:table-row>/gi, '\n')
      .replace(/<\/(?:text:p|text:h)>/gi, '\n');
  }

  value = decodeXmlEntities(value.replace(/<[^>]+>/g, ' '));
  return value
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}


function docxTableCellText(cellXml) {
  const source = String(cellXml || '');
  const tokenPattern = /<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>|<w:tab\b[^>]*\/>|<w:br\b[^>]*\/>|<\/w:p>/gi;
  const parts = [];
  let match;
  while ((match = tokenPattern.exec(source))) {
    const token = match[0];
    if (/^<w:t/i.test(token)) parts.push(decodeXmlEntities(match[1] || ''));
    else if (/^<w:tab/i.test(token)) parts.push('\t');
    else parts.push('\n');
  }
  return parts.join('')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n+/g, ' ')
    .trim();
}

function extractDocxTableRows(xml) {
  const source = String(xml || '');
  const rows = [];
  const rowMatches = source.match(/<w:tr\b[\s\S]*?<\/w:tr>/gi) || [];
  for (const rowXml of rowMatches) {
    const cells = [];
    const cellMatches = rowXml.match(/<w:tc\b[\s\S]*?<\/w:tc>/gi) || [];
    for (const cellXml of cellMatches) cells.push(docxTableCellText(cellXml));
    if (cells.some(Boolean)) rows.push(cells);
  }
  return rows;
}

function mimeFromName(name) {
  const lower = String(name || '').toLowerCase();
  if (lower.endsWith('.png')) return 'image/png';
  if (lower.endsWith('.webp')) return 'image/webp';
  if (lower.endsWith('.gif')) return 'image/gif';
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg';
  return null;
}

function extractImages(zip, prefixes) {
  const images = [];
  for (const [name] of zip.entries) {
    if (images.length >= MAX_MEDIA_IMAGES) break;
    if (!prefixes.some((prefix) => name.startsWith(prefix))) continue;
    const mime = mimeFromName(name);
    if (!mime) continue;
    const data = zip.readEntry(name);
    if (!data || data.length < 8 * 1024 || data.length > 8 * 1024 * 1024) continue;
    images.push({ mime, base64: data.toString('base64'), bytes: data.length, name });
  }
  return images;
}

function extractOfficeDocument(fileBuffer, fileName = '') {
  const lower = String(fileName || '').toLowerCase();
  const zip = parseZipEntries(fileBuffer);

  if (lower.endsWith('.docx')) {
    const main = zip.readEntry('word/document.xml');
    if (!main) throw publicError('DOCX sem word/document.xml; arquivo inválido ou incompatível.');
    const text = xmlToReadableText(main.toString('utf8'), 'docx');
    return {
      format: 'DOCX',
      text,
      tableRows: extractDocxTableRows(main.toString('utf8')),
      images: extractImages(zip, ['word/media/']),
    };
  }

  if (lower.endsWith('.odt')) {
    const main = zip.readEntry('content.xml');
    if (!main) throw publicError('ODT sem content.xml; arquivo inválido ou incompatível.');
    const text = xmlToReadableText(main.toString('utf8'), 'odt');
    return {
      format: 'ODT',
      text,
      images: extractImages(zip, ['Pictures/']),
    };
  }

  throw publicError('Formato Office compactado não reconhecido.');
}

module.exports = {
  extractOfficeDocument,
  parseZipEntries,
  xmlToReadableText,
  extractDocxTableRows,
  docxTableCellText,
};
