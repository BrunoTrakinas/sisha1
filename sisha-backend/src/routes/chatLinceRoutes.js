const express = require('express');
const multer = require('multer');
const chatLinceController = require('../controllers/chatLinceController');
const { requireRole } = require('../middlewares/authMiddleware');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

router.post('/perguntar', chatLinceController.perguntar);
router.post('/documentos/analisar', requireRole(['admin', 'dono']), upload.single('file'), chatLinceController.analisarDocumento);
router.get('/documentos', requireRole(['admin', 'dono']), chatLinceController.listarDocumentos);
router.post('/documentos/:id/confirmar', requireRole(['admin', 'dono']), chatLinceController.confirmarDocumento);
router.post('/documentos/:id/rejeitar', requireRole(['admin', 'dono']), chatLinceController.rejeitarDocumento);
router.post('/apelidos/confirmar', requireRole(['admin', 'dono']), chatLinceController.confirmarApelido);
router.get('/helpdesk', requireRole(['admin', 'dono']), chatLinceController.listarHelpdesk);
router.post('/helpdesk/:id/responder', requireRole(['admin', 'dono']), chatLinceController.responderHelpdesk);

module.exports = router;
