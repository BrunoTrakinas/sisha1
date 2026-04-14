// src/routes/manualRoutes.js
const express = require('express');
const router = express.Router();
const manualController = require('../controllers/manualController');

router.post('/registrar', manualController.registrarAcaoTatica);
router.get('/buscar/:id', manualController.buscarAcaoTatica);
router.put('/:id', manualController.atualizarAcaoTatica);
router.delete('/:id', manualController.excluirAcaoTatica);

module.exports = router;