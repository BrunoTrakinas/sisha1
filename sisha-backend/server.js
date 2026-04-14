require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { requireAuth, requireRole } = require('./src/middlewares/authMiddleware');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

const authRoutes = require('./src/routes/authRoutes');
const importRoutes = require('./src/routes/importRoutes');
const statsRoutes = require('./src/routes/statsRoutes');
const searchRoutes = require('./src/routes/searchRoutes');
const manualRoutes = require('./src/routes/manualRoutes');
const itemRoutes = require('./src/routes/itemRoutes');
const needsRoutes = require('./src/routes/needsRoutes');

app.use('/api/auth', authRoutes);
app.use('/api/import', requireAuth, requireRole(['admin']), importRoutes);
app.use('/api/stats', requireAuth, statsRoutes);
app.use('/api/search', requireAuth, searchRoutes);
app.use('/api/manual', requireAuth, requireRole(['admin']), manualRoutes);
app.use('/api/items', requireAuth, requireRole(['admin']), itemRoutes);
app.use('/api/needs', requireAuth, needsRoutes);

app.get('/api/health', (req, res) => {
  res.status(200).json({ status: 'success', message: 'Servidor SISHA-1 Operacional!' });
});

app.listen(PORT, () => {
  console.log(`[SISHA-1 MOTOR] Rodando na porta ${PORT}`);
});
