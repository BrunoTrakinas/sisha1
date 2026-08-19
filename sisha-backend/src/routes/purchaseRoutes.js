const express = require('express');
const multer = require('multer');
const router = express.Router();
const purchaseController = require('../controllers/purchaseController');
const { requireRole } = require('../middlewares/authMiddleware');

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const allowed = /\.(xlsx?|csv|ods)$/i.test(file.originalname || '');
    cb(allowed ? null : new Error('Formato não permitido. Use XLS, XLSX, CSV ou ODS.'), allowed);
  },
});

router.get('/ordens', purchaseController.listarOrdens);
router.get('/ordens/:id/export', purchaseController.exportarOrdem);
router.post('/ordens', requireRole(['admin']), purchaseController.criarOrdem);
router.put('/ordens/:id', requireRole(['admin']), purchaseController.atualizarOrdem);
router.put('/ordens/:id/status', requireRole(['admin']), purchaseController.transicionarStatusOrdem);
router.delete('/ordens/:id', requireRole(['admin']), purchaseController.excluirOrdem);
router.post('/ordens/:id/suplementacoes', requireRole(['admin']), purchaseController.adicionarSuplementacaoOrdem);
router.put('/ordens/:id/suplementacoes/:suplementacaoId', requireRole(['admin']), purchaseController.retificarSuplementacaoOrdem);
router.put('/ordens/:id/suplementacao-config', requireRole(['admin']), purchaseController.atualizarControleSuplementacaoOrdem);
router.post('/ordens/import', requireRole(['admin']), upload.single('file'), purchaseController.importarOrdens);
router.post('/ordens/:id/pds/import', requireRole(['admin']), upload.single('file'), purchaseController.importarPdsDaOrdem);
router.post('/pds-pipeline/import', requireRole(['admin']), upload.single('file'), purchaseController.importarPipelinePds);

router.get('/pds', purchaseController.listarPds);
router.get('/pds/orderbook-gaps', purchaseController.listarPdsOrderBookSemOrigem);
router.post('/pds/reconcile-existing-lifecycle', requireRole(['admin']), purchaseController.reconciliarCicloPdsExistentes);
router.get('/pds/export', purchaseController.exportarPds);
router.post('/pds', requireRole(['admin']), purchaseController.criarPd);
router.put('/pds/:id', requireRole(['admin']), purchaseController.atualizarPd);
router.delete('/pds/:id', requireRole(['admin']), purchaseController.excluirPd);


router.get('/work-orders', purchaseController.listarWorkOrders);
router.get('/work-orders/:id/export', purchaseController.exportarWorkOrder);
router.post('/work-orders', requireRole(['admin']), purchaseController.criarWorkOrder);
router.post('/work-orders/sync-equipment-ledger', requireRole(['admin']), purchaseController.sincronizarWorkOrdersComEquipamentos);
router.put('/work-orders/:id', requireRole(['admin']), purchaseController.atualizarWorkOrder);
router.delete('/work-orders/:id', requireRole(['admin']), purchaseController.excluirWorkOrder);
router.post('/work-orders/:id/suplementacoes', requireRole(['admin']), purchaseController.adicionarSuplementacaoWorkOrder);
router.put('/work-orders/:id/suplementacoes/:suplementacaoId', requireRole(['admin']), purchaseController.retificarSuplementacaoWorkOrder);
router.put('/work-orders/:id/suplementacao-config', requireRole(['admin']), purchaseController.atualizarControleSuplementacaoWorkOrder);
router.post('/work-orders/import', requireRole(['admin']), upload.single('file'), purchaseController.importarWorkOrders);

module.exports = router;
