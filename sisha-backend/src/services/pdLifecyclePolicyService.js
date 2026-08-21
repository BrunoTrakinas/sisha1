function normalizeStatus(value = '') {
  return String(value || '').trim().toUpperCase();
}

const STATUS_RANK = new Map([
  ['', 0],
  ['ELB', 10],
  ['TRI', 20],
  ['ANS', 25],
  ['COT', 30],
  ['PRO', 32],
  ['LPC', 35],
  ['LIB', 40],
  ['LIBERADA', 40],
  ['LIBERADO', 40],
  ['ATIVO', 45],
  ['ODC', 50],
  ['ODA_RESSALVA', 55],
  ['ODA', 60],
  ['FAT', 70],
  ['EMB', 80],
  ['REC', 90],
]);

function statusRank(value = '') {
  return STATUS_RANK.get(normalizeStatus(value)) ?? 0;
}

function isCancelledStatus(value = '') {
  return ['CAN', 'EXCLUIDO', 'EXCLUÍDO', 'CANCELADO'].includes(normalizeStatus(value));
}

/**
 * Importações são monotônicas: PD/OC/Order Book podem acrescentar evidência e
 * avançar o ciclo, porém nunca rebaixam uma evidência já mais forte.
 * Regressão/correção de status permanece exclusiva de edição Admin/Dono.
 */
function chooseMonotonicImportedStatus(currentStatus = '', incomingStatus = '') {
  const current = normalizeStatus(currentStatus);
  const incoming = normalizeStatus(incomingStatus);
  if (!incoming) return current;
  if (!current) return incoming;

  // Cancelamento existente é terminal. Um arquivo novo também não pode cancelar
  // silenciosamente um PD/OC já ativo: cancelamento/correção regressiva exige
  // ação explícita de Admin/Dono no fluxo manual. Registro novo já cancelado pode
  // ser criado porque não existe estado canônico anterior a preservar.
  if (isCancelledStatus(current)) return current;
  if (isCancelledStatus(incoming)) return current;

  if (statusRank(incoming) < statusRank(current)) return current;
  return incoming;
}

function pendingPurchaseQty(row = {}) {
  const baseCandidates = [row.qtd_comprada, row.quantidade, row.qtd_pedida];
  let base = 0;
  for (const value of baseCandidates) {
    const n = Number(value);
    if (Number.isFinite(n) && n > 0) { base = n; break; }
  }
  const received = Math.max(0, Number(row.qtd_recebida || 0) || 0);
  return Math.max(0, base - received);
}

// Regra logística SISHA: somente ODA representa aquisição ainda a receber.
function isFuturePurchaseCoverageStatus(value = '') {
  return normalizeStatus(value) === 'ODA';
}

// ODC é processo administrativo em andamento; informa prioridade, mas não cobre.
function isOdcProcessStatus(value = '') {
  return normalizeStatus(value) === 'ODC';
}

// No fluxo real do Esquadrão, FAT/EMB/REC são evidências de entrega/recebimento
// já ocorrido e nunca devem ser somadas novamente como estoque futuro.
function isDeliveredHistoricalStatus(value = '') {
  return ['FAT', 'EMB', 'REC'].includes(normalizeStatus(value));
}

module.exports = {
  normalizeStatus,
  statusRank,
  isCancelledStatus,
  chooseMonotonicImportedStatus,
  pendingPurchaseQty,
  isFuturePurchaseCoverageStatus,
  isOdcProcessStatus,
  isDeliveredHistoricalStatus,
};
