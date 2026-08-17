const express = require('express');
const multer = require('multer');
const controller = require('../controllers/manualTechnicalController');
const { requireRole } = require('../middlewares/authMiddleware');

const router = express.Router();
const WTP_MAX_FILE_MB = Math.max(5, Math.min(Number(process.env.WTP_MAX_FILE_MB || 50), 90));
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: WTP_MAX_FILE_MB * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const allowed = /\.pdf$/i.test(file.originalname || '') || String(file.mimetype || '').includes('pdf');
    cb(allowed ? null : new Error('Nesta fase, WTP/Manual Técnico aceita PDF. Use o Manual/Dicionário atual para CIETP estruturado.'), allowed);
  },
});

router.get('/', controller.listManuals);
router.get('/storage/readiness', requireRole(['admin']), controller.storageReadiness);
router.get('/search/pn/:pn', controller.searchByPn);
router.get('/:id', controller.getManual);
router.get('/:id/original', requireRole(['admin']), controller.downloadOriginal);
router.post('/preview', requireRole(['admin']), upload.single('file'), controller.previewManual);
router.post('/import', requireRole(['admin']), upload.single('file'), controller.importManual);
router.post('/:id/reindex-rag', requireRole(['admin']), controller.reindexManualRag);
router.post('/manual', requireRole(['admin']), controller.createManualMetadata);
router.post('/batch', requireRole(['admin']), controller.createManualMetadataBatch);
router.put('/:id', requireRole(['admin']), controller.updateManual);
router.delete('/:id', requireRole(['admin']), controller.deactivateManual);

module.exports = router;
