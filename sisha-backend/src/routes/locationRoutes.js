const express = require('express');
const locationController = require('../controllers/locationController');
const { requireRole } = require('../middlewares/authMiddleware');

const router = express.Router();

router.get('/', requireRole(['admin']), locationController.listar);
router.put('/', requireRole(['admin']), locationController.atualizar);

module.exports = router;
