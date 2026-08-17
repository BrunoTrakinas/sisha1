const express = require('express');
const multer = require('multer');
const equipmentController = require('../controllers/equipmentController');
const { requireRole } = require('../middlewares/authMiddleware');

const router = express.Router();

const uploadInventory = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const allowed = /\.(xlsx?|xls|csv|ods)$/i.test(file.originalname || '');
    cb(allowed ? null : new Error('Inventário de equipamentos aceita XLSX, XLS, CSV ou ODS.'), allowed);
  },
});

const uploadMaster = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const allowed = /\.(zip|xlsx?|xls|csv|ods)$/i.test(file.originalname || '');
    cb(allowed ? null : new Error('Cadastro Mestre aceita ZIP, XLSX, XLS, CSV ou ODS.'), allowed);
  },
});

// Dono, Admin e Operador: consulta, dossiê, reconciliação e exportação.
router.get('/', equipmentController.listar);
router.get('/export', equipmentController.exportar);
router.get('/reconciliation', equipmentController.reconciliacaoPpu);
router.get('/inventory/imports', equipmentController.listarImportacoesInventario);

// Conflitos ficam em rota própria antes de /:id.
router.get('/location-conflicts', requireRole(['admin']), equipmentController.listarConflitosLocalizacao);

// A2: fluxo guiado de instalação/remoção PN+SN. Consultas são read-only;
// mutações permanecem restritas a Admin/Dono pelo mesmo gate administrativo.
router.get('/operations/candidates', equipmentController.listarCandidatosOperacionais);
router.get('/operations/installations', equipmentController.listarInstalacoesOperacionais);
router.get('/operations/pending-tests', equipmentController.listarTestesPendentesA2);
router.post('/operations/install', requireRole(['admin']), equipmentController.instalarEquipamentoA2);
router.post('/operations/remove', requireRole(['admin']), equipmentController.removerEquipamentoA2);
router.post('/operations/test-result', requireRole(['admin']), equipmentController.concluirTesteA2);

// A3: indicadores são consulta autenticada; confirmação de evidência é Admin/Dono.
router.get('/reliability', equipmentController.painelConfiabilidadeA3);
router.post('/reliability/confirm', requireRole(['admin']), equipmentController.confirmarCicloConfiabilidadeA3);

// OS/OSR/PIM: movimentações físicas PN+SN e configuração atual das aeronaves.
router.get('/os-pim', equipmentController.listarOsPim);
router.get('/os-pim/staging', requireRole(['admin']), equipmentController.listarOsPimStaging);
router.post('/os-pim/staging/:stagingId/promote', requireRole(['admin']), equipmentController.promoverOsPimStaging);
router.post('/os-pim', requireRole(['admin']), equipmentController.criarOsPim);
router.put('/os-pim/:cardKey', requireRole(['admin']), equipmentController.atualizarOsPim);
router.post('/os-pim/:cardKey/cancel', requireRole(['admin']), equipmentController.cancelarOsPim);
router.get('/aircraft-configuration', equipmentController.configuracaoAeronaves);

// STC: cards derivados do Livro de Eventos; sem tabela paralela e sem duplicar a identidade PN+SN.
router.get('/stc', equipmentController.listarStc);
router.post('/stc', requireRole(['admin']), equipmentController.criarStc);
router.put('/stc/:cardKey', requireRole(['admin']), equipmentController.atualizarStc);
router.post('/stc/:cardKey/cancel', requireRole(['admin']), equipmentController.cancelarStc);

// Cadastro Mestre PN + SN: localização opcional, inclusive ZIP com planilhas.
router.post('/master/preview', requireRole(['admin']), uploadMaster.single('file'), equipmentController.previewCadastroMestre);
router.post('/master/apply', requireRole(['admin']), equipmentController.aplicarCadastroMestre);

// Apenas Admin e Dono podem importar/alterar o controle patrimonial.
router.post('/inventory/preview', requireRole(['admin']), uploadInventory.single('file'), equipmentController.previewInventario);
router.post('/inventory/apply', requireRole(['admin']), equipmentController.aplicarInventario);
router.post('/', requireRole(['admin']), equipmentController.criar);

// Rotas parametrizadas ficam por último para não capturar /master, /inventory e /reconciliation.
router.get('/:id', equipmentController.obter);
router.put('/:id', requireRole(['admin']), equipmentController.atualizar);
router.delete('/:id', requireRole(['admin']), equipmentController.remover);
router.post('/:id/events', requireRole(['admin']), equipmentController.registrarEvento);
router.post('/:id/events/:eventId/invalidate', requireRole(['admin']), equipmentController.invalidarEvento);
router.post('/:id/location-conflicts/:eventId/resolve', requireRole(['admin']), equipmentController.resolverConflitoLocalizacao);

module.exports = router;
