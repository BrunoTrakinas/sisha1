// src/routes/importRoutes.js
const express = require('express');
const router = express.Router();
const multer = require('multer');
const importController = require('../controllers/importController');
const { createImportAudit } = require('../middlewares/importAuditMiddleware');

// Configuração do multer para ler o arquivo em memória (Buffer)
const upload = multer({ storage: multer.memoryStorage() });

// ==========================================
// CENTRAL DE ROTEAMENTO DE ARQUIVOS
// ==========================================

router.post('/upload', upload.single('file'), createImportAudit('upload'), importController.importData);
router.post('/confirmar_triagem', createImportAudit('confirmar_triagem'), importController.confirmarTriagemRecibo);
router.post('/leonardo', upload.single('file'), createImportAudit('leonardo_legacy'), importController.importData);
router.post('/rfq', upload.single('file'), createImportAudit('rfq_leitura'), importController.uploadRfqPdf);
router.post('/rfq/salvar', createImportAudit('rfq_salvar'), importController.salvarRfqDefinitivo);
router.get('/logs', importController.listImportLogs);

module.exports = router;
