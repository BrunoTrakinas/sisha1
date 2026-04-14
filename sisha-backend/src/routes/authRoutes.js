const express = require('express');
const router = express.Router();
const authController = require('../controllers/authController');
const { requireAuth, requireRole } = require('../middlewares/authMiddleware');

router.post('/login', authController.login);
router.get('/me', requireAuth, authController.me);
router.get('/users', requireAuth, requireRole(['admin']), authController.listAuthorizedUsers);
router.post('/users', requireAuth, requireRole(['admin']), authController.createAuthorizedUser);
router.delete('/users/:id', requireAuth, requireRole(['admin']), authController.deleteAuthorizedUser);

module.exports = router;
