const express = require('express');
const router = express.Router();
const historyController = require('../controllers/historyController');

router.get('/movimentacoes', historyController.buscarHistoricoMovimentacao);

module.exports = router;
