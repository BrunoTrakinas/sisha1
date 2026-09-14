const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const execFileAsync = promisify(execFile);
const TESSERACT_CMD = String(process.env.SISHA_TESSERACT_CMD || 'tesseract').trim() || 'tesseract';
const PDFTOPPM_CMD = String(process.env.SISHA_PDFTOPPM_CMD || 'pdftoppm').trim() || 'pdftoppm';
const TIMEOUT_MS = Math.max(15000, Number(process.env.SISHA_LOCAL_OCR_TIMEOUT_MS || 45000));
const MAX_PAGES = Math.min(20, Math.max(1, Number(process.env.SISHA_TECHPUB_OCR_MAX_PAGES || 12)));

async function checkTechnicalPublicationOcrReadiness() {
  try {
    await execFileAsync(TESSERACT_CMD, ['--version'], { timeout: 5000, maxBuffer: 1024 * 1024 });
    await execFileAsync(PDFTOPPM_CMD, ['-v'], { timeout: 5000, maxBuffer: 1024 * 1024 });
    return { ready: true, tesseract: TESSERACT_CMD, pdftoppm: PDFTOPPM_CMD };
  } catch (error) {
    return { ready: false, reason: error?.code || error?.message || 'OCR_LOCAL_INDISPONIVEL' };
  }
}

function pageNumberFromPath(filePath = '') {
  const match = String(filePath).match(/-(\d+)\.png$/i);
  return match ? Number(match[1]) : Number.MAX_SAFE_INTEGER;
}

async function extractTechnicalPublicationTextWithAi(buffer, options = {}) {
  // Lazy require evita carregar o cliente de IA quando OCR local resolve o documento.
  const { extractTextFromPdfWithAi } = require('./chatLinceService');
  const ai = await extractTextFromPdfWithAi({
    buffer,
    fileName: options.fileName || 'publicacao-tecnica.pdf',
    tipoDocumento: 'PUBLICACAO_TECNICA_SB_PAN',
    prompt: [
      'Transcreva fielmente esta publicação técnica aeronáutica (Service Bulletin ou Product Advisory Notice).',
      'Preserve referência documental, issue/revisão, data, título, P/N afetados, periodicidade/TBO, aplicabilidade, Customer Action e referências de manual.',
      'Quando houver tabela de materiais, preserve cada linha em formato: ITEM | PART NUMBER | NOMENCLATURE | QTY.',
      'Não invente PN, quantidade ou aplicabilidade. Conteúdo ilegível deve ser marcado [REVISAR].',
      'Não faça recomendação técnica; apenas extraia o que está visível no documento.',
    ].join('\n'),
  });
  if (!ai?.ok || !String(ai.text || '').trim()) {
    const error = new Error(`Leitura visual por IA indisponível (${ai?.reason || 'sem detalhe'}).`);
    error.code = 'TECHPUB_AI_OCR_UNAVAILABLE';
    throw error;
  }
  return {
    text: String(ai.text || '').replace(/\r/g, '').trim(),
    method: `CHAT_LINCE_PDF_VISUAL_TECHPUB:${ai.model || 'IA'}:${ai.engine || 'file-parser'}`,
    pages: null,
  };
}

async function extractTechnicalPublicationTextWithLocalOcr(buffer, options = {}) {
  if (!Buffer.isBuffer(buffer) || !buffer.length) {
    const error = new Error('PDF vazio para OCR de publicação técnica.');
    error.code = 'TECHPUB_OCR_EMPTY_PDF';
    throw error;
  }

  const readiness = await checkTechnicalPublicationOcrReadiness();
  if (!readiness.ready) {
    return extractTechnicalPublicationTextWithAi(buffer, options);
  }

  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sisha-techpub-ocr-'));
  const pdfPath = path.join(tmpDir, 'document.pdf');
  const prefix = path.join(tmpDir, 'page');
  const maxPages = Math.min(MAX_PAGES, Math.max(1, Number(options.maxPages || MAX_PAGES)));

  try {
    await fs.writeFile(pdfPath, buffer);
    await execFileAsync(PDFTOPPM_CMD, [
      '-f', '1', '-l', String(maxPages), '-png', '-r', '180', pdfPath, prefix,
    ], { timeout: TIMEOUT_MS * 2, maxBuffer: 4 * 1024 * 1024 });

    const images = (await fs.readdir(tmpDir))
      .filter((name) => /^page-\d+\.png$/i.test(name))
      .map((name) => path.join(tmpDir, name))
      .sort((a, b) => pageNumberFromPath(a) - pageNumberFromPath(b));

    if (!images.length) {
      const error = new Error('Poppler não gerou páginas para OCR da publicação técnica.');
      error.code = 'TECHPUB_OCR_NO_PAGES';
      throw error;
    }

    const pageTexts = [];
    for (const imagePath of images) {
      const { stdout } = await execFileAsync(TESSERACT_CMD, [
        imagePath, 'stdout', '-l', 'eng', '--psm', '3',
      ], { timeout: TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 });
      pageTexts.push(String(stdout || '').replace(/\r/g, '').trim());
    }

    return {
      text: pageTexts.filter(Boolean).join('\n\n'),
      method: 'OCR_LOCAL_TESSERACT_POPPLER_TECHPUB',
      pages: pageTexts.length,
    };
  } catch (localError) {
    try {
      return await extractTechnicalPublicationTextWithAi(buffer, options);
    } catch (aiError) {
      const error = new Error(`Falha na leitura da publicação técnica. OCR local: ${localError?.message || localError}. Leitura visual: ${aiError?.message || aiError}.`);
      error.code = 'TECHPUB_OCR_ALL_READERS_FAILED';
      throw error;
    }
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}

module.exports = {
  checkTechnicalPublicationOcrReadiness,
  extractTechnicalPublicationTextWithLocalOcr,
  extractTechnicalPublicationTextWithAi,
};
