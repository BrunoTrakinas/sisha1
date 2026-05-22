const express = require('express');
const multer = require('multer');
const router = express.Router();
const purchaseController = require('../controllers/purchaseController');

const upload = multer({ storage: multer.memoryStorage() });

router.get('/ordens', purchaseController.listarOrdens);
router.get('/ordens/:id/export', purchaseController.exportarOrdem);
router.post('/ordens', purchaseController.criarOrdem);
router.put('/ordens/:id', purchaseController.atualizarOrdem);
router.delete('/ordens/:id', purchaseController.excluirOrdem);
router.post('/ordens/:id/suplementacoes', purchaseController.adicionarSuplementacaoOrdem);
router.post('/ordens/import', upload.single('file'), purchaseController.importarOrdens);
router.post('/ordens/:id/pds/import', upload.single('file'), purchaseController.importarPdsDaOrdem);
router.post('/pds-pipeline/import', upload.single('file'), purchaseController.importarPipelinePds);

router.get('/work-orders', purchaseController.listarWorkOrders);
router.get('/work-orders/:id/export', purchaseController.exportarWorkOrder);
router.post('/work-orders', purchaseController.criarWorkOrder);
router.put('/work-orders/:id', purchaseController.atualizarWorkOrder);
router.delete('/work-orders/:id', purchaseController.excluirWorkOrder);
router.post('/work-orders/:id/suplementacoes', purchaseController.adicionarSuplementacaoWorkOrder);
router.post('/work-orders/import', upload.single('file'), purchaseController.importarWorkOrders);

module.exports = router;
