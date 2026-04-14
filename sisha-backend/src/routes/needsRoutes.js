const express = require('express');
const { requireRole } = require('../middlewares/authMiddleware');
const controller = require('../controllers/needsController');

const router = express.Router();
const adminOnly = requireRole(['admin']);

router.get('/generator/options', controller.getGeneratorOptions);
router.post('/generator/preview', controller.previewGenerator);
router.post('/generator/export/xlsx', controller.exportGeneratorXlsx);

router.get('/cost/options', controller.getOperationalCostOptions);
router.post('/cost/preview', controller.previewOperationalCost);

router.get('/sb/list', adminOnly, controller.listServiceBulletins);
router.get('/sb/:sbNumero', adminOnly, controller.getServiceBulletinDetail);
router.put('/sb/:sbNumero', adminOnly, controller.updateServiceBulletin);
router.delete('/sb/:sbNumero', adminOnly, controller.deleteServiceBulletin);

router.get('/snapshot', adminOnly, controller.getFoundationSnapshot);

router.get('/receitas', adminOnly, controller.listReceitas);
router.get('/receitas/:inspecao', adminOnly, controller.getReceitaItens);
router.post('/receitas/item', adminOnly, controller.upsertReceitaItem);
router.put('/receitas/item/:id', adminOnly, controller.upsertReceitaItem);
router.delete('/receitas/item/:id', adminOnly, controller.deleteReceitaItem);

router.get('/pims', adminOnly, controller.listPims);
router.post('/pims', adminOnly, controller.upsertPim);
router.put('/pims/:id', adminOnly, controller.upsertPim);
router.delete('/pims/:id', adminOnly, controller.deletePim);

router.get('/politicas', adminOnly, controller.listPoliticas);
router.post('/politicas', adminOnly, controller.upsertPolitica);
router.put('/politicas/:id', adminOnly, controller.upsertPolitica);
router.delete('/politicas/:id', adminOnly, controller.deletePolitica);

module.exports = router;
