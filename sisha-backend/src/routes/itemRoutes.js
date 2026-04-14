const express = require('express');
const router = express.Router();
const itemController = require('../controllers/itemController');

router.get('/ppu/buscar/:termo', itemController.buscarPpuParaManutencao);
router.put('/ppu/id/:id', itemController.atualizarPpuPorId);
router.delete('/ppu/id/:id', itemController.excluirPpuPorId);

module.exports = router;