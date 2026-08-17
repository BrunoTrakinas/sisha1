const express = require('express');
const multer = require('multer');
const chatLinceController = require('../controllers/chatLinceController');
const { requireRole } = require('../middlewares/authMiddleware');
const {
  guardChatLinceConsult,
  guardChatLinceDocumentAnalysis,
  guardChatLinceRagReindex,
  guardChatLinceActionConfirm,
} = require('../middlewares/chatLinceAbuseMiddleware');

const router = express.Router();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 },
  fileFilter: (_req, file, callback) => {
    const allowed = /\.(pdf|xlsx|xls|csv|ods|txt|json|doc|docx|odt|jpg|jpeg|png|webp)$/i.test(file.originalname || '');
    callback(allowed ? null : new Error('Formato não permitido no Chat Lince.'), allowed);
  },
});

router.post('/perguntar', guardChatLinceConsult, chatLinceController.perguntar);
router.get('/security-readiness', requireRole(['admin', 'dono']), chatLinceController.securityReadiness);
router.post('/rag/reindexar', requireRole(['admin', 'dono']), guardChatLinceRagReindex, chatLinceController.reindexarRag);
router.post('/acoes/:id/confirmar', requireRole(['admin', 'dono']), guardChatLinceActionConfirm, chatLinceController.confirmarAcaoExecutor);
router.post('/documentos/analisar', requireRole(['admin', 'dono']), guardChatLinceDocumentAnalysis, upload.single('file'), chatLinceController.analisarDocumento);
router.get('/documentos', requireRole(['admin', 'dono']), chatLinceController.listarDocumentos);
router.get('/documentos/:id', requireRole(['admin', 'dono']), chatLinceController.obterDocumento);
router.get('/documentos/:id/exportar-normalizado', requireRole(['admin', 'dono']), chatLinceController.exportarDocumentoNormalizado);
router.post('/documentos/:id/confirmar', requireRole(['admin', 'dono']), chatLinceController.confirmarDocumento);
router.post('/documentos/:id/rejeitar', requireRole(['admin', 'dono']), chatLinceController.rejeitarDocumento);
router.post('/apelidos/confirmar', requireRole(['admin', 'dono']), chatLinceController.confirmarApelido);
router.get('/helpdesk', requireRole(['admin', 'dono']), chatLinceController.listarHelpdesk);
router.post('/helpdesk/:id/responder', requireRole(['admin', 'dono']), chatLinceController.responderHelpdesk);

module.exports = router;
