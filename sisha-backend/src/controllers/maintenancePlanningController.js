const { loadMaintenanceProgram, confirmMaintenanceBinding } = require('../services/maintenancePlanningService');

function fail(res, error, fallback) {
  console.error('[SISHA][A1.2]', error);
  return res.status(400).json({ status: 'error', message: error.message || fallback });
}

exports.list = async (_req, res) => {
  try {
    const data = await loadMaintenanceProgram();
    return res.json({ status: 'success', data });
  } catch (error) {
    return fail(res, error, 'Falha ao carregar programa TBO/horas/ciclos.');
  }
};

exports.confirmBinding = async (req, res) => {
  try {
    const result = await confirmMaintenanceBinding(req.body || {}, {
      user: req.user || {},
      requestId: req.requestId || req.auditContext?.requestId || null,
    });
    return res.json({ status: 'success', message: 'Vínculo de manutenção confirmado e auditado.', data: result });
  } catch (error) {
    return fail(res, error, 'Falha ao confirmar vínculo de manutenção.');
  }
};
