const express = require('express');
const multer = require('multer');
const receiptController = require('../controllers/receiptController');
const { requireRole } = require('../middlewares/authMiddleware');

const router = express.Router();
const batchUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 },
  fileFilter: (_req, file, callback) => {
    const allowed = /\.zip$/i.test(file.originalname || '');
    callback(allowed ? null : new Error('Envie um arquivo ZIP válido para a importação em lote.'), allowed);
  },
});

const durableBatchUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024, files: 150 },
  fileFilter: (_req, file, callback) => {
    const allowed = /\.(zip|pdf|xlsx|xls|csv|ods|txt|doc|docx|odt|jpg|jpeg|png|webp)$/i.test(file.originalname || '');
    callback(allowed ? null : new Error('Formato não suportado no lote de recibos.'), allowed);
  },
});


router.get('/', receiptController.listar);
router.get('/export', receiptController.exportar);
router.get('/batch/jobs', requireRole(['admin']), receiptController.listarLotesPersistentes);
router.post('/batch/jobs', requireRole(['admin']), durableBatchUpload.array('files', 150), receiptController.criarLotePersistente);
router.get('/batch/jobs/:jobId', requireRole(['admin']), receiptController.obterLotePersistente);
router.post('/batch/jobs/:jobId/items/:itemId/saved', requireRole(['admin']), receiptController.marcarItemLoteSalvo);
router.post('/batch/unpack', requireRole(['admin']), batchUpload.single('archive'), receiptController.descompactarLote);
router.post('/', requireRole(['admin']), receiptController.criar);
router.get('/:id/export', receiptController.exportarUm);
router.get('/:id', receiptController.obter);
router.put('/:id', requireRole(['admin']), receiptController.atualizar);
router.delete('/:id', requireRole(['admin']), receiptController.excluir);

module.exports = router;
