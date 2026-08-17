const {
  OPERATIONAL_STATES,
  listEffectiveOperationalStates,
  confirmOperationalState,
  listOperationalStateHistory,
} = require('../services/aircraftOperationalStateService');

function fail(res, error, fallback) {
  console.error('[SISHA][A1.1A]', error);
  return res.status(400).json({ status: 'error', message: error.message || fallback });
}

exports.listCurrent = async (req, res) => {
  try {
    const rows = await listEffectiveOperationalStates();
    return res.json({ status: 'success', data: rows, operational_states: OPERATIONAL_STATES });
  } catch (error) {
    return fail(res, error, 'Falha ao carregar estado operacional da frota.');
  }
};

exports.confirm = async (req, res) => {
  try {
    const result = await confirmOperationalState(
      { ...(req.body || {}), aircraft_code: req.params.aircraft },
      { user: req.user || {}, requestId: req.requestId || req.auditContext?.requestId || null },
    );
    return res.json({
      status: 'success',
      message: `Estado operacional da aeronave ${req.params.aircraft} confirmado e auditado.`,
      data: result,
    });
  } catch (error) {
    return fail(res, error, 'Falha ao confirmar estado operacional.');
  }
};

exports.history = async (req, res) => {
  try {
    const rows = await listOperationalStateHistory(req.params.aircraft);
    return res.json({ status: 'success', data: rows });
  } catch (error) {
    return fail(res, error, 'Falha ao carregar histórico de confirmações.');
  }
};
