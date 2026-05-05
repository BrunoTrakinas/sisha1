const express = require('express');
const router = express.Router();
const itemController = require('../controllers/itemController');

router.get('/ppu/buscar/:termo', itemController.buscarPpuParaManutencao);
router.put('/ppu/id/:id', itemController.atualizarPpuPorId);
router.delete('/ppu/id/:id', itemController.excluirPpuPorId);

router.get('/apelidos', itemController.listarApelidos);
router.post('/apelidos', itemController.criarApelido);
router.delete('/apelidos/:id', itemController.excluirApelido);

module.exports = router;