const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  ACTION_POLICY_VERSION,
  buildPlanGuard,
  validatePlanEnvelope,
  compareTargetState,
  validateCurrentTargets,
} = require('../../src/services/chatLinceActionPolicyService');

const backendRoot = path.resolve(__dirname, '../..');
function read(relativePath) {
  return fs.readFileSync(path.join(backendRoot, relativePath), 'utf8');
}

function item(overrides = {}) {
  return {
    id: 'pd-id-1',
    numero_pd: 'PD-001',
    numero_oc: 'OC-001',
    ordem_id: 'ordem-1',
    pn: 'PN-001',
    status_atual: 'ODC',
    status_grupo_atual: 'ODC',
    status_item_atual: 'ODC',
    ativo: true,
    updated_at: '2026-08-13T20:00:00.000Z',
    valido_para_execucao: true,
    ...overrides,
  };
}

function planFixture(overrides = {}) {
  const user = { email: 'admin@example.mil', role: 'admin' };
  const detected = { type: 'ALTERAR_STATUS_PD', fromStatus: 'ODC', toStatus: 'ODA' };
  const items = [item()];
  const guard = buildPlanGuard({ detected, user, items });
  return {
    id: 'plan-1',
    action_type: 'ALTERAR_STATUS_PD',
    status: 'PENDENTE_CONFIRMACAO',
    requested_by_email: user.email,
    requested_by_role: user.role,
    expires_at: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
    plan_payload: {
      tipo: 'ALTERAR_STATUS_PD',
      novo_status: 'ODA',
      status_origem_informado: 'ODC',
      itens: items,
      guard,
    },
    ...overrides,
  };
}

test('GOLDEN H6C: guard do plano e versionado e vinculado ao solicitante', () => {
  const plan = planFixture();
  assert.equal(plan.plan_payload.guard.version, ACTION_POLICY_VERSION);
  assert.equal(plan.plan_payload.guard.requested_by_email, 'admin@example.mil');
  assert.equal(plan.plan_payload.guard.action_type, 'ALTERAR_STATUS_PD');
  assert.equal(plan.plan_payload.guard.new_status, 'ODA');
});

test('GOLDEN H6C: mesmo usuario criador pode confirmar envelope valido', () => {
  const result = validatePlanEnvelope(planFixture(), { email: 'admin@example.mil', role: 'admin' });
  assert.equal(result.ok, true);
  assert.equal(result.targets.length, 1);
});

test('GOLDEN H6C: outro Admin nao pode executar plano alheio', () => {
  const result = validatePlanEnvelope(planFixture(), { email: 'outro@example.mil', role: 'admin' });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'ACTION_REQUESTER_MISMATCH');
});

test('GOLDEN H6C: Operador nunca executa plano mesmo conhecendo o ID', () => {
  const result = validatePlanEnvelope(planFixture(), { email: 'admin@example.mil', role: 'operador' });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'ACTION_ROLE_NOT_ALLOWED');
});

test('GOLDEN H6C: plano expirado falha fechado', () => {
  const result = validatePlanEnvelope(planFixture({ expires_at: '2020-01-01T00:00:00.000Z' }), { email: 'admin@example.mil', role: 'admin' });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'ACTION_PLAN_EXPIRED');
});

test('GOLDEN H6C: plano ja executado nao pode ser repetido', () => {
  const result = validatePlanEnvelope(planFixture({ status: 'EXECUTADO' }), { email: 'admin@example.mil', role: 'admin' });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'ACTION_PLAN_NOT_PENDING');
});

test('GOLDEN H6C: adulterar status destino apos preview invalida guard', () => {
  const plan = planFixture();
  plan.plan_payload.novo_status = 'REC';
  const result = validatePlanEnvelope(plan, { email: 'admin@example.mil', role: 'admin' });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'ACTION_GUARD_STATUS_MISMATCH');
});

test('GOLDEN H6C: adulterar alvo apos preview invalida guard', () => {
  const plan = planFixture();
  plan.plan_payload.itens[0].id = 'pd-id-trocado';
  const result = validatePlanEnvelope(plan, { email: 'admin@example.mil', role: 'admin' });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'ACTION_GUARD_TARGET_MISMATCH');
});

test('GOLDEN H6C: target duplicado e recusado', () => {
  const plan = planFixture();
  const clone = { ...plan.plan_payload.itens[0] };
  plan.plan_payload.itens.push(clone);
  plan.plan_payload.guard = buildPlanGuard({
    detected: { type: 'ALTERAR_STATUS_PD', fromStatus: 'ODC', toStatus: 'ODA' },
    user: { email: 'admin@example.mil', role: 'admin' },
    items: plan.plan_payload.itens,
  });
  const result = validatePlanEnvelope(plan, { email: 'admin@example.mil', role: 'admin' });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'ACTION_DUPLICATE_TARGET');
});

test('GOLDEN H6C: mudanca de updated_at invalida snapshot', () => {
  const expected = planFixture().plan_payload.guard.targets;
  const current = [{ ...expected[0], updated_at: '2026-08-13T20:01:00.000Z' }];
  const result = validateCurrentTargets(expected, current);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'ACTION_TARGET_STATE_CHANGED');
  assert.ok(result.conflicts[0].changed.includes('updated_at'));
});

test('GOLDEN H6C: mudanca de status invalida snapshot', () => {
  const expected = planFixture().plan_payload.guard.targets;
  const current = [{ ...expected[0], status: 'ODA', status_grupo: 'ODA', status_item: 'ODA' }];
  const result = validateCurrentTargets(expected, current);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'ACTION_TARGET_STATE_CHANGED');
});

test('GOLDEN H6C: desaparecimento de um PD invalida o conjunto inteiro', () => {
  const p = planFixture();
  const extra = item({ id: 'pd-id-2', numero_pd: 'PD-002' });
  p.plan_payload.itens.push(extra);
  p.plan_payload.guard = buildPlanGuard({
    detected: { type: 'ALTERAR_STATUS_PD', fromStatus: 'ODC', toStatus: 'ODA' },
    user: { email: 'admin@example.mil', role: 'admin' },
    items: p.plan_payload.itens,
  });
  const result = validateCurrentTargets(p.plan_payload.guard.targets, [p.plan_payload.guard.targets[0]]);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'ACTION_TARGET_SET_CHANGED');
});

test('GOLDEN H6C: snapshot identico permanece executavel', () => {
  const expected = planFixture().plan_payload.guard.targets;
  const result = validateCurrentTargets(expected, JSON.parse(JSON.stringify(expected)));
  assert.equal(result.ok, true);
});

test('GOLDEN H6C: comparador detecta mudanca de ativo sem confundir status', () => {
  const expected = planFixture().plan_payload.guard.targets[0];
  const current = { ...expected, ativo: false };
  const result = compareTargetState(expected, current);
  assert.equal(result.same, false);
  assert.deepEqual(result.changed, ['ativo']);
});

test('GOLDEN H6C: buildActionPlan bloqueia plano parcial por PD ausente ou status divergente', () => {
  const source = read('src/services/chatLinceActionService.js');
  assert.match(source, /Não vou criar um plano parcialmente executável/);
  assert.match(source, /naoEncontrados\.length \|\| invalidos\.length/);
});

test('GOLDEN H6C: executor revalida estado antes e depois da senha', () => {
  const source = read('src/services/chatLinceActionService.js');
  const first = source.indexOf('const beforeAuthRows = await loadCurrentTargets(ids)');
  const auth = source.indexOf('const auth = await verifyPassword(user, senha)');
  const second = source.indexOf('const afterAuthRows = await loadCurrentTargets(ids)');
  const update = source.indexOf(".from('compras_pds')", second);
  assert.ok(first >= 0 && auth > first && second > auth && update > second);
});

test('GOLDEN H6C: executor verifica resultado antes de declarar sucesso', () => {
  const source = read('src/services/chatLinceActionService.js');
  assert.match(source, /ACTION_EXECUTION_VERIFICATION_FAILED/);
  assert.match(source, /updatedRows\.length === ids\.length/);
  assert.match(source, /status_grupo\) === novoStatus/);
  assert.match(source, /Não repita a ação/);
});

test('GOLDEN H6C: falha ao persistir resultado nao vira falso sucesso', () => {
  const source = read('src/services/chatLinceActionService.js');
  assert.match(source, /ACTION_PLAN_RESULT_PERSISTENCE_FAILED/);
  assert.match(source, /mutationCommitted:\s*true/);
  assert.match(source, /Não repita a ação; consulte a auditoria/);
});

test('GOLDEN H6C: auditoria registra codigo e se mutacao chegou a ocorrer', () => {
  const source = read('src/controllers/chatLinceController.js');
  assert.match(source, /code:\s*result\.code \|\| null/);
  assert.match(source, /mutation_committed:\s*Boolean\(result\.mutationCommitted\)/);
  assert.match(source, /code:\s*result\.code \|\| 'CHAT_LINCE_ACTION_DENIED'/);
});
