const { getLogisticsIntelligence } = require('../services/logisticsIntelligenceService');

function numberParam(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

exports.analyzePn = async (req, res) => {
  try {
    const pn = String(req.query?.pn || '').trim();
    if (!pn) return res.status(400).json({ status: 'error', message: 'Informe o PN para a análise A4.' });
    const horizonDays = numberParam(req.query?.horizon_days, 90);
    const expectedFlightHours = numberParam(req.query?.expected_flight_hours, 0);
    const expectedCycles = numberParam(req.query?.expected_cycles, 0);
    if (horizonDays < 7 || horizonDays > 365) return res.status(400).json({ status: 'error', message: 'Horizonte deve estar entre 7 e 365 dias.' });
    if (expectedFlightHours < 0 || expectedFlightHours > 100000) return res.status(400).json({ status: 'error', message: 'Horas previstas inválidas.' });
    if (expectedCycles < 0 || expectedCycles > 1000000) return res.status(400).json({ status: 'error', message: 'Ciclos previstos inválidos.' });

    const data = await getLogisticsIntelligence({
      pn,
      horizon_days: horizonDays,
      expected_flight_hours: expectedFlightHours,
      expected_cycles: expectedCycles,
    });
    return res.status(200).json({ status: 'success', data });
  } catch (error) {
    return res.status(500).json({ status: 'error', message: error?.message || 'Falha ao executar Inteligência Logística A4.' });
  }
};
