// src/routes/importRoutes.js
const express = require('express');
const router = express.Router();
const multer = require('multer');
const importController = require('../controllers/importController');
const { createImportAudit } = require('../middlewares/importAuditMiddleware');
const { requireRole } = require('../middlewares/authMiddleware');

// Configuração do multer para ler o arquivo em memória (Buffer)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 35 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const allowed = /\.(xlsx?|xls|csv|ods|pdf|txt|doc)$/i.test(file.originalname || '');
    cb(allowed ? null : new Error('Formato de documento não permitido.'), allowed);
  },
});

// ==========================================
// CENTRAL DE ROTEAMENTO DE ARQUIVOS
// ==========================================

router.post('/upload', requireRole(['admin']), upload.single('file'), createImportAudit('upload'), importController.importData);
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
router.get('/custodia-externa-ppu/reconciliacao', requireRole(['admin']), importController.getPpuExternalCustodyReconciliation);
router.post('/custodia-externa-ppu/reconciliacao', requireRole(['admin']), createImportAudit('ppu_custodia_externa_decisao'), importController.decidePpuExternalCustodyReconciliation);

module.exports = router;
