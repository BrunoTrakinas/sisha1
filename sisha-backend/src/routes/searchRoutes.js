// src/routes/searchRoutes.js
const express = require('express');
const searchController = require('../controllers/searchController');

const router = express.Router();

// Cria a rota GET: http://localhost:3000/api/search
router.get('/', searchController.searchItems);

module.exports = router;