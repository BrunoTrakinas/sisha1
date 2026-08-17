require('dotenv').config();
const { assertRuntimeReadiness } = require('./src/config/runtimeReadiness');
const { assertChatLinceSecurityReadiness } = require('./src/services/chatLinceSecurityReadinessService');
const express = require('express');
const cors = require('cors');
const { requireAuth, requireRole } = require('./src/middlewares/authMiddleware');
const { requestContextMiddleware } = require('./src/middlewares/requestContextMiddleware');
const { startReceiptImportWorker } = require('./src/services/receiptImportJobService');
const { startRfqImportWorker } = require('./src/services/rfqImportJobService');

assertRuntimeReadiness();
assertChatLinceSecurityReadiness();

const app = express();
const PORT = process.env.PORT || 3000;

const allowedOrigins = String(process.env.CORS_ORIGINS || '')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);

app.use(cors({
  origin(origin, callback) {
    // Ferramentas server-to-server e health checks normalmente não enviam Origin.
    if (!origin) return callback(null, true);
    // Compatibilidade: enquanto CORS_ORIGINS não estiver configurado, preserva o comportamento atual.
    // Em produção, configure a lista para fechar o acesso de forma controlada.
    if (allowedOrigins.length === 0) return callback(null, true);
    if (allowedOrigins.includes(origin)) return callback(null, true);
    if (process.env.NODE_ENV !== 'production' && /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(origin)) {
      return callback(null, true);
    }
    return callback(new Error('Origem CORS não autorizada. Configure CORS_ORIGINS no backend.'));
  },
  credentials: true,
  exposedHeaders: ['Content-Disposition'],
}));
app.use(express.json({ limit: '2mb' }));
app.use(requestContextMiddleware);

const authRoutes = require('./src/routes/authRoutes');
const importRoutes = require('./src/routes/importRoutes');
const statsRoutes = require('./src/routes/statsRoutes');
const searchRoutes = require('./src/routes/searchRoutes');
const manualRoutes = require('./src/routes/manualRoutes');
const itemRoutes = require('./src/routes/itemRoutes');
const needsRoutes = require('./src/routes/needsRoutes');
const purchaseRoutes = require('./src/routes/purchaseRoutes');
const chatLinceRoutes = require('./src/routes/chatLinceRoutes');
const historyRoutes = require('./src/routes/historyRoutes');
const receiptRoutes = require('./src/routes/receiptRoutes');
const locationRoutes = require('./src/routes/locationRoutes');
const equipmentRoutes = require('./src/routes/equipmentRoutes');
const manualTechnicalRoutes = require('./src/routes/manualTechnicalRoutes');

app.use('/api/auth', authRoutes);
app.use('/api/import', requireAuth, requireRole(['admin']), importRoutes);
app.use('/api/stats', requireAuth, statsRoutes);
app.use('/api/search', requireAuth, searchRoutes);
app.use('/api/manual', requireAuth, requireRole(['admin']), manualRoutes);
app.use('/api/items', requireAuth, requireRole(['admin']), itemRoutes);
app.use('/api/needs', requireAuth, needsRoutes);
app.use('/api/purchases', requireAuth, purchaseRoutes);
app.use('/api/chat-lince', requireAuth, chatLinceRoutes);
app.use('/api/history', requireAuth, historyRoutes);
app.use('/api/receipts', requireAuth, receiptRoutes);
app.use('/api/locations', requireAuth, locationRoutes);
app.use('/api/equipments', requireAuth, equipmentRoutes);
app.use('/api/manuals', requireAuth, manualTechnicalRoutes);

app.use((error, _req, res, next) => {
  if (!error) return next();
  if (error.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ status: 'error', message: 'Arquivo excede o limite permitido.' });
  if (error.message && /formato|documento/i.test(error.message)) return res.status(400).json({ status: 'error', message: error.message });
  console.error('[SISHA] Erro não tratado:', error);
  return res.status(500).json({ status: 'error', message: 'Falha interna ao processar a solicitação.' });
});

app.get('/api/health', (req, res) => {
  res.status(200).json({ status: 'success', message: 'Servidor SISHA-1 Operacional!' });
});

app.listen(PORT, () => {
  console.log(`[SISHA-1 MOTOR] Rodando na porta ${PORT}`);
  startReceiptImportWorker();
  startRfqImportWorker();
});
