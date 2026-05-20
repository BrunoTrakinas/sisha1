const express = require('express');
const router = express.Router();
const authController = require('../controllers/authController');
const { requireAuth, requireRole, requireDono } = require('../middlewares/authMiddleware');

router.post('/login', authController.login);
router.post('/logout', requireAuth, authController.logout);
router.post('/presence/ping', requireAuth, authController.presencePing);
router.get('/online', requireAuth, requireDono, authController.onlineUsers);
router.get('/me', requireAuth, authController.me);
router.get('/users', requireAuth, requireRole(['admin', 'dono']), authController.listAuthorizedUsers);
router.post('/users', requireAuth, requireDono, authController.createAuthorizedUser);
router.put('/users/:id', requireAuth, requireRole(['admin', 'dono']), authController.updateAuthorizedUser);
router.delete('/users/:id', requireAuth, requireDono, authController.deleteAuthorizedUser);

module.exports = router;
