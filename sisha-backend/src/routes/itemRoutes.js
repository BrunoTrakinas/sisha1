const express = require('express');
const router = express.Router();
const itemController = require('../controllers/itemController');

router.get('/ppu', itemController.listarPpuAdministrativo);
router.post('/ppu', itemController.criarPpuAdministrativo);
router.get('/ceimspa', itemController.listarCeimspaAdministrativo);
router.post('/ceimspa', itemController.criarCeimspaAdministrativo);
router.put('/ceimspa/id/:id', itemController.atualizarCeimspaPorId);
router.delete('/ceimspa/id/:id', itemController.excluirCeimspaPorId);

router.get('/ppu/buscar/:termo', itemController.buscarPpuParaManutencao);
router.put('/ppu/id/:id', itemController.atualizarPpuPorId);
router.delete('/ppu/id/:id', itemController.excluirPpuPorId);


router.get('/alternativos', itemController.listarPnAlternativos);
router.get('/alternativos/resolver/:pn', itemController.resolverPnRelacoes);
router.post('/alternativos', itemController.criarPnAlternativo);
router.post('/alternativos/lote', itemController.criarPnAlternativosLote);
router.put('/alternativos/:id', itemController.atualizarPnAlternativo);
router.delete('/alternativos/:id', itemController.desativarPnAlternativo);

router.get('/apelidos', itemController.listarApelidos);
router.post('/apelidos', itemController.criarApelido);
router.delete('/apelidos/:id', itemController.excluirApelido);

module.exports = router;