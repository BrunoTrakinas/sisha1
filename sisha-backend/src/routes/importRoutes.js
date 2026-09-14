// src/routes/importRoutes.js
const express = require('express');
const router = express.Router();
const multer = require('multer');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const importController = require('../controllers/importController');
const { importCeimspaSemDemandaLowMemory } = require('../controllers/ceimspaSemDemandaLowMemoryController');
const { createImportAudit } = require('../middlewares/importAuditMiddleware');
const { requireRole } = require('../middlewares/authMiddleware');

// Fluxo legado: mantido para os demais documentos já homologados.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 35 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const allowed = /\.(xlsx?|xls|csv|ods|pdf|txt|doc)$/i.test(file.originalname || '');
    cb(allowed ? null : new Error('Formato de documento não permitido.'), allowed);
  },
});

// CeIMSPA Sem Demanda: usa /tmp para não manter o arquivo inteiro no heap do Node.
// O controller remove o arquivo temporário no finally, inclusive em erro.
const semDemandTempDir = path.join(os.tmpdir(), 'sisha-ceimspa-sem-demanda');
fs.mkdirSync(semDemandTempDir, { recursive: true });

const semDemandUpload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, semDemandTempDir),
    filename: (_req, file, cb) => {
      const ext = ['.xls', '.xlsx'].includes(path.extname(file.originalname || '').toLowerCase())
        ? path.extname(file.originalname || '').toLowerCase()
        : '.upload';
      cb(null, `${Date.now()}-${crypto.randomBytes(12).toString('hex')}${ext}`);
    },
  }),
  limits: { fileSize: 35 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const allowed = /\.(xlsx?|xls)$/i.test(file.originalname || '');
    cb(allowed ? null : new Error('CeIMSPA Sem Demanda aceita somente XLS/XLSX.'), allowed);
  },
});

// ==========================================
// CENTRAL DE ROTEAMENTO DE ARQUIVOS
// ==========================================

router.post('/upload', requireRole(['admin']), upload.single('file'), createImportAudit('upload'), (req, res, next) => {
  if (String(req.body?.tipoArquivo || '').trim() === 'ceimspa_sem_demanda') {
    return importCeimspaSemDemandaLowMemory(req, res);
  }
  return importController.importData(req, res, next);
});
router.post('/upload/ceimspa-sem-demanda', requireRole(['admin']), semDemandUpload.single('file'), createImportAudit('ceimspa_sem_demanda_low_memory'), importCeimspaSemDemandaLowMemory);
router.post('/confirmar_triagem', requireRole(['admin']), createImportAudit('confirmar_triagem'), importController.confirmarTriagemRecibo);
router.post('/leonardo', requireRole(['admin']), upload.single('file'), createImportAudit('leonardo_legacy'), importController.importData);
router.post('/rfq/jobs', requireRole(['admin']), upload.single('file'), createImportAudit('rfq_job_criar'), importController.createRfqPersistentJob);
router.get('/rfq/jobs', requireRole(['admin']), importController.listRfqPersistentJobs);
router.get('/rfq/jobs/:jobId', requireRole(['admin']), importController.getRfqPersistentJob);
router.post('/rfq/jobs/:jobId/reprocess', requireRole(['admin']), createImportAudit('rfq_job_reprocessar'), importController.reprocessRfqPersistentJob);
router.post('/rfq/jobs/:jobId/discard', requireRole(['admin']), createImportAudit('rfq_job_descartar'), importController.discardRfqPersistentJob);
router.post('/rfq', requireRole(['admin']), upload.single('file'), createImportAudit('rfq_leitura'), importController.uploadRfqPdf);
router.post('/rfq/salvar', requireRole(['admin']), createImportAudit('rfq_salvar'), importController.salvarRfqDefinitivo);
router.get('/rfq/cotacoes', requireRole(['admin']), importController.listRfqCotacoes);
router.put('/rfq/cotacoes/:id', requireRole(['admin']), createImportAudit('rfq_manual_editar'), importController.updateRfqCotacao);
router.delete('/rfq/cotacoes/:id', requireRole(['admin']), createImportAudit('rfq_manual_desativar'), importController.deactivateRfqCotacao);
router.get('/logs', requireRole(['admin']), importController.listImportLogs);
router.get('/locrec/reconciliacao', requireRole(['admin']), importController.getLocrecReconciliation);
router.get('/custodia-externa-ppu/reconciliacao', requireRole(['admin']), importController.getPpuExternalCustodyReconciliation);
router.post('/custodia-externa-ppu/reconciliacao', requireRole(['admin']), createImportAudit('ppu_custodia_externa_decisao'), importController.decidePpuExternalCustodyReconciliation);

module.exports = router;
