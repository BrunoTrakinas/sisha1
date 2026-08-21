const express = require('express');
const multer = require('multer');
const { requireRole } = require('../middlewares/authMiddleware');
const controller = require('../controllers/needsController');
const operationalStateController = require('../controllers/aircraftOperationalStateController');
const maintenancePlanningController = require('../controllers/maintenancePlanningController');
const logisticsIntelligenceController = require('../controllers/logisticsIntelligenceController');
const { createImportAudit } = require('../middlewares/importAuditMiddleware');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage() });
const adminOnly = requireRole(['admin', 'dono']);

router.get('/aircraft-availability/current', controller.getAircraftAvailabilityCurrent);
router.get('/aircraft-availability/:aircraft/indicators', controller.getAircraftMaintenanceIndicators);
router.get('/aircraft-operational-state/current', operationalStateController.listCurrent);
router.get('/aircraft-operational-state/:aircraft/history', adminOnly, operationalStateController.history);
router.put('/aircraft-operational-state/:aircraft', adminOnly, operationalStateController.confirm);

router.get('/maintenance-program', maintenancePlanningController.list);
router.put('/maintenance-program/binding', adminOnly, maintenancePlanningController.confirmBinding);

router.get('/generator/options', controller.getGeneratorOptions);
router.post('/generator/preview', controller.previewGenerator);
router.post('/generator/export/xlsx', controller.exportGeneratorXlsx);
router.get('/intelligence/a4', logisticsIntelligenceController.analyzePn);

router.post('/batch-query/preview', upload.single('file'), controller.previewBatchQuery);
router.post('/batch-query/export/xlsx', upload.single('file'), controller.exportBatchQueryXlsx);

router.get('/cost/options', controller.getOperationalCostOptions);
router.post('/cost/preview', controller.previewOperationalCost);

router.post('/quote-request/prepare', controller.prepareQuoteRequest);
router.post('/quote-request/export/xlsx', controller.exportQuoteRequestXlsx);

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
router.post('/pims/import', adminOnly, upload.single('file'), createImportAudit('pim_snapshot'), controller.importPimSnapshot);
router.post('/pims', adminOnly, controller.upsertPim);
router.put('/pims/:id', adminOnly, controller.upsertPim);
router.delete('/pims/:id', adminOnly, controller.deletePim);

router.get('/politicas', adminOnly, controller.listPoliticas);
router.post('/politicas', adminOnly, controller.upsertPolitica);
router.put('/politicas/:id', adminOnly, controller.upsertPolitica);
router.delete('/politicas/:id', adminOnly, controller.deletePolitica);

module.exports = router;
