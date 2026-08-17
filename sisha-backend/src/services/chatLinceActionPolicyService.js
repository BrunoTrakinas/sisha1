const ACTION_POLICY_VERSION = 1;
const ALLOWED_ACTION_TYPES = new Set(['ALTERAR_STATUS_PD']);
const ALLOWED_PD_STATUSES = new Set(['ELB', 'TRI', 'ANS', 'COT', 'PRO', 'LPC', 'ODC', 'ODA', 'EMB', 'REC', 'FAT', 'CAN']);
const ALLOWED_ROLES = new Set(['admin', 'dono']);

function normalizeUpper(value = '') {
  return String(value || '').trim().toUpperCase();
}

function normalizeEmail(value = '') {
  return String(value || '').trim().toLowerCase();
}

function normalizeScalar(value) {
  if (value === undefined) return null;
  if (value === null) return null;
  if (typeof value === 'boolean') return value;
  return String(value).trim();
}

function currentStatusOf(row = {}) {
  return normalizeUpper(row.status_grupo || row.status || row.status_item || '');
}

function snapshotTarget(row = {}) {
  return {
    id: normalizeScalar(row.id),
    numero_pd: normalizeUpper(row.numero_pd),
    numero_oc: normalizeScalar(row.numero_oc),
    ordem_id: normalizeScalar(row.ordem_id),
    pn: normalizeUpper(row.pn),
    status: normalizeUpper(row.status),
    status_grupo: normalizeUpper(row.status_grupo),
    status_item: normalizeUpper(row.status_item),
    ativo: row.ativo !== false,
    updated_at: normalizeScalar(row.updated_at),
  };
}

function stableTargetKey(row = {}) {
  return `${normalizeScalar(row.id) || ''}::${normalizeUpper(row.numero_pd)}`;
}

function sortSnapshots(rows = []) {
  return (rows || [])
    .map(snapshotTarget)
    .sort((a, b) => stableTargetKey(a).localeCompare(stableTargetKey(b)));
}

function buildPlanGuard({ detected = {}, user = {}, items = [] } = {}) {
  const executable = (items || []).filter((item) => item?.valido_para_execucao !== false && item?.id);
  return {
    version: ACTION_POLICY_VERSION,
    action_type: normalizeUpper(detected.type),
    requested_by_email: normalizeEmail(user.email),
    requested_by_role: String(user.role || '').trim().toLowerCase(),
    new_status: normalizeUpper(detected.toStatus),
    source_status: normalizeUpper(detected.fromStatus) || null,
    targets: sortSnapshots(executable),
  };
}

function sameArray(a = [], b = []) {
  return JSON.stringify(a) === JSON.stringify(b);
}

function validatePlanEnvelope(plan = {}, user = {}) {
  const payload = plan?.plan_payload || {};
  const guard = payload?.guard || {};
  const callerEmail = normalizeEmail(user.email);
  const callerRole = String(user.role || '').trim().toLowerCase();
  const requestedEmail = normalizeEmail(plan.requested_by_email);
  const requestedRole = String(plan.requested_by_role || '').trim().toLowerCase();
  const actionType = normalizeUpper(plan.action_type);
  const payloadType = normalizeUpper(payload.tipo);
  const newStatus = normalizeUpper(payload.novo_status);

  if (!ALLOWED_ROLES.has(callerRole)) {
    return { ok: false, code: 'ACTION_ROLE_NOT_ALLOWED', message: 'Somente Admin ou Dono pode executar alterações pelo Chat Lince.' };
  }
  if (!callerEmail || callerEmail !== requestedEmail) {
    return { ok: false, code: 'ACTION_REQUESTER_MISMATCH', message: 'Este plano só pode ser confirmado pelo mesmo usuário que o criou.' };
  }
  if (!ALLOWED_ROLES.has(requestedRole)) {
    return { ok: false, code: 'ACTION_REQUEST_ROLE_INVALID', message: 'O plano foi criado por um perfil que não possui permissão de execução.' };
  }
  if (plan.status !== 'PENDENTE_CONFIRMACAO') {
    return { ok: false, code: 'ACTION_PLAN_NOT_PENDING', message: `Plano não está pendente. Status atual: ${plan.status || 'não informado'}.` };
  }
  const expiresAt = new Date(plan.expires_at).getTime();
  if (!Number.isFinite(expiresAt) || expiresAt < Date.now()) {
    return { ok: false, code: 'ACTION_PLAN_EXPIRED', message: 'Plano expirou. Peça ao Chat Lince para montar um novo plano.' };
  }
  if (!ALLOWED_ACTION_TYPES.has(actionType) || actionType !== payloadType) {
    return { ok: false, code: 'ACTION_TYPE_NOT_ALLOWED', message: 'Tipo de ação não autorizado pelo executor do Chat Lince.' };
  }
  if (!ALLOWED_PD_STATUSES.has(newStatus)) {
    return { ok: false, code: 'ACTION_TARGET_STATUS_INVALID', message: 'Status de destino não permitido.' };
  }
  if (guard.version !== ACTION_POLICY_VERSION) {
    return { ok: false, code: 'ACTION_GUARD_VERSION_INVALID', message: 'Plano antigo ou sem proteção H6C. Gere um novo plano.' };
  }
  if (normalizeUpper(guard.action_type) !== actionType) {
    return { ok: false, code: 'ACTION_GUARD_TYPE_MISMATCH', message: 'Integridade do tipo de ação não confere.' };
  }
  if (normalizeEmail(guard.requested_by_email) !== requestedEmail) {
    return { ok: false, code: 'ACTION_GUARD_REQUESTER_MISMATCH', message: 'Integridade do solicitante do plano não confere.' };
  }
  if (normalizeUpper(guard.new_status) !== newStatus) {
    return { ok: false, code: 'ACTION_GUARD_STATUS_MISMATCH', message: 'Integridade do status de destino não confere.' };
  }

  const executableItems = (payload.itens || []).filter((item) => item?.valido_para_execucao !== false && item?.id);
  if (!executableItems.length) {
    return { ok: false, code: 'ACTION_NO_VALID_TARGETS', message: 'Nenhum PD válido para execução.' };
  }

  const expectedTargets = sortSnapshots(executableItems);
  const guardedTargets = sortSnapshots(guard.targets || []);
  if (!sameArray(expectedTargets, guardedTargets)) {
    return { ok: false, code: 'ACTION_GUARD_TARGET_MISMATCH', message: 'Os alvos do plano foram alterados após o preview.' };
  }

  const ids = expectedTargets.map((item) => item.id);
  const pds = expectedTargets.map((item) => item.numero_pd);
  if (new Set(ids).size !== ids.length || new Set(pds).size !== pds.length) {
    return { ok: false, code: 'ACTION_DUPLICATE_TARGET', message: 'O plano contém alvos duplicados e foi bloqueado.' };
  }

  return { ok: true, actionType, newStatus, targets: expectedTargets };
}

function compareTargetState(expected = {}, current = {}) {
  const a = snapshotTarget(expected);
  const b = snapshotTarget(current);
  const fields = ['id', 'numero_pd', 'numero_oc', 'ordem_id', 'pn', 'status', 'status_grupo', 'status_item', 'ativo', 'updated_at'];
  const changed = fields.filter((field) => a[field] !== b[field]);
  return {
    same: changed.length === 0,
    changed,
    expected: a,
    current: b,
  };
}

function validateCurrentTargets(expectedTargets = [], currentRows = []) {
  const expected = sortSnapshots(expectedTargets);
  const current = sortSnapshots(currentRows);

  if (expected.length !== current.length) {
    return {
      ok: false,
      code: 'ACTION_TARGET_SET_CHANGED',
      message: 'A quantidade de PDs mudou desde o preview. Gere um novo plano.',
      conflicts: [{ type: 'COUNT', expected: expected.length, current: current.length }],
    };
  }

  const currentByKey = new Map(current.map((row) => [stableTargetKey(row), row]));
  const conflicts = [];
  for (const item of expected) {
    const key = stableTargetKey(item);
    const now = currentByKey.get(key);
    if (!now) {
      conflicts.push({ type: 'MISSING', target: item });
      continue;
    }
    const comparison = compareTargetState(item, now);
    if (!comparison.same) conflicts.push({ type: 'CHANGED', ...comparison });
  }

  if (conflicts.length) {
    return {
      ok: false,
      code: 'ACTION_TARGET_STATE_CHANGED',
      message: 'Um ou mais PDs mudaram desde o preview. Nenhuma alteração foi executada; gere um novo plano.',
      conflicts,
    };
  }

  return { ok: true, targets: current };
}

module.exports = {
  ACTION_POLICY_VERSION,
  ALLOWED_ACTION_TYPES,
  ALLOWED_PD_STATUSES,
  ALLOWED_ROLES,
  currentStatusOf,
  snapshotTarget,
  buildPlanGuard,
  validatePlanEnvelope,
  compareTargetState,
  validateCurrentTargets,
};
