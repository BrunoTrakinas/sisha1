const xlsx = require('xlsx');
const pdfParse = require('pdf-parse');
const { extractLegacyDocText } = require('./receiptDocumentParser');
const { extractOfficeDocument } = require('../utils/officeDocumentText');
const { extractTextFromImagesWithAi, compactText } = require('./chatLinceService');

function extractJpegImagesFromPdfBuffer(buffer, maxImages = 8) {
  const images = [];
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) return images;
  const startMarker = Buffer.from([0xff, 0xd8]);
  const endMarker = Buffer.from([0xff, 0xd9]);
  let offset = 0;
  while (images.length < maxImages) {
    const start = buffer.indexOf(startMarker, offset);
    if (start === -1) break;
    const end = buffer.indexOf(endMarker, start + startMarker.length);
    if (end === -1) break;
    const imageBuffer = buffer.subarray(start, end + endMarker.length);
    offset = end + endMarker.length;
    if (imageBuffer.length < 25 * 1024) continue;
    images.push({ mime: 'image/jpeg', base64: imageBuffer.toString('base64'), bytes: imageBuffer.length });
  }
  return images;
}

function publicError(message, statusCode = 400) {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.publicMessage = message;
  return error;
}

async function extractTextFromFile(file, tipoDocumento = '') {
  if (!file?.buffer) throw new Error('Arquivo não enviado.');
  const name = String(file.originalname || '').toLowerCase();
  const mime = String(file.mimetype || '').toLowerCase();

  if (mime.startsWith('image/') || /\.(jpg|jpeg|png|webp)$/i.test(name)) {
    const imageMime = mime.startsWith('image/')
      ? mime
      : name.endsWith('.png') ? 'image/png' : name.endsWith('.webp') ? 'image/webp' : 'image/jpeg';
    const visual = await extractTextFromImagesWithAi({
      images: [{ mime: imageMime, base64: file.buffer.toString('base64'), bytes: file.buffer.length }],
      fileName: file.originalname || 'recibo-imagem',
      tipoDocumento,
    });
    if (!visual.ok) throw publicError(`A leitura visual da imagem não conseguiu concluir: ${visual.reason || 'sem detalhe'}.`);
    return ['[EXTRAÇÃO VISUAL POR IA - IMAGEM]', `Modelo: ${visual.model || 'não informado'}`, '', visual.text].join('\n');
  }

  if (mime.includes('pdf') || name.endsWith('.pdf')) {
    const parsed = await pdfParse(file.buffer).catch(() => ({ text: '' }));
    const parsedText = compactText(parsed.text || '', 50000);
    if (parsedText && parsedText.length >= 30) return parsedText;
    const extractedImages = extractJpegImagesFromPdfBuffer(file.buffer, 8);
    if (!extractedImages.length) throw publicError('O PDF não possui texto selecionável e não foi possível extrair imagens internas para leitura visual.');
    const visual = await extractTextFromImagesWithAi({ images: extractedImages, fileName: file.originalname || 'documento.pdf', tipoDocumento });
    if (!visual.ok) throw publicError(`O PDF parece ser imagem/scan. A extração visual por IA não conseguiu concluir: ${visual.reason || 'sem detalhe'}.`);
    return ['[EXTRAÇÃO VISUAL POR IA - PDF SEM TEXTO PESQUISÁVEL]', `Modelo: ${visual.model || 'não informado'}`, '', visual.text].join('\n');
  }

  if (/\.(docx|odt)$/i.test(name)) {
    const office = extractOfficeDocument(file.buffer, file.originalname || name);
    const officeText = compactText(office.text || '', 50000);
    if (officeText && officeText.length >= 30) return [`[EXTRAÇÃO ESTRUTURAL ${office.format}]`, '', officeText].join('\n');
    if (office.images?.length) {
      const visual = await extractTextFromImagesWithAi({ images: office.images, fileName: file.originalname || `documento.${office.format.toLowerCase()}`, tipoDocumento });
      if (visual.ok) return [`[EXTRAÇÃO VISUAL POR IA - ${office.format} SEM TEXTO SUFICIENTE]`, `Modelo: ${visual.model || 'não informado'}`, '', visual.text].join('\n');
    }
    throw publicError(`${office.format} sem texto legível suficiente.`);
  }

  if (name.endsWith('.doc')) {
    try { return extractLegacyDocText(file.buffer); }
    catch (error) { throw publicError(`Não foi possível ler o DOC legado: ${error.message || 'estrutura incompatível'}.`); }
  }

  if (/\.(xlsx|xls|csv|ods)$/i.test(name) || mime.includes('spreadsheet') || mime.includes('excel') || mime.includes('csv')) {
    const workbook = xlsx.read(file.buffer, { type: 'buffer', cellDates: false, raw: false });
    const maxRowsPerSheet = Math.min(Math.max(Number(process.env.CHAT_LINCE_MAX_ROWS_PER_SHEET || 1200), 100), 5000);
    return workbook.SheetNames.map((sheetName) => {
      const sheet = workbook.Sheets[sheetName];
      const rows = xlsx.utils.sheet_to_json(sheet, { header: 1, defval: '', raw: false });
      const selected = rows.length <= maxRowsPerSheet ? rows : [...rows.slice(0, maxRowsPerSheet - 100), ...rows.slice(-100)];
      const renderedRows = selected.map((row) => row.map((cell) => String(cell || '').trim()).join(' | '));
      const warning = rows.length > selected.length
        ? `\n[ATENÇÃO: aba com ${rows.length} linhas; ${selected.length} linhas representativas foram enviadas à IA. A importação operacional deve usar o arquivo original.]`
        : '';
      return `ABA: ${sheetName} | LINHAS: ${rows.length}\n${renderedRows.join('\n')}${warning}`;
    }).join('\n\n');
  }

  if (/\.(txt|json)$/i.test(name) || mime.startsWith('text/') || mime.includes('json')) {
    return compactText(file.buffer.toString('utf8'), 50000);
  }

  throw publicError('Formato não reconhecido para leitura documental.');
}

module.exports = { extractTextFromFile, extractJpegImagesFromPdfBuffer };
