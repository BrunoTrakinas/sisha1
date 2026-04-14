// src/routes/statsRoutes.js
const express = require('express');
const router = express.Router();
const statsController = require('../controllers/statsController');

router.get('/dashboard', statsController.getDashboardStats);
router.get('/radar', statsController.getRadarCriticidade);
router.get('/operations', statsController.getRecentOperations);

module.exports = router;
