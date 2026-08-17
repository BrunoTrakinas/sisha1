const supabase = require('../config/supabaseClient');
const { getSupabaseAdmin } = require('../config/supabaseAdminClient');
const { signInWithPassword } = require('./supabaseAuthService');
const { bindAuthorizedUserIdentity } = require('./authIdentityBindingService');
const {
  ALLOWED_PD_STATUSES,
  buildPlanGuard,
  validatePlanEnvelope,
  validateCurrentTargets,
} = require('./chatLinceActionPolicyService');

const ALLOWED_ROLES = new Set(['admin', 'dono']);
const BLOCKED_WORDS = ['authorized_users', 'senha', 'password', 'token', 'jwt', 'login', 'perfil', 'role', 'admin', 'dono'];

function normalizeUpper(value = '') {
  return String(value || '').trim().toUpperCase();
}

function normalizePassword(value = '') {
  return String(value || '').trim();
}

function normalizeEmail(value = '') {
  return String(value || '').trim().toLowerCase();
}

function cleanDoc(value = '') {
  return normalizeUpper(value).replace(/[.,;:]+$/g, '');
}

function isSensitiveCommand(text = '') {
  const q = normalizeUpper(text);
  return BLOCKED_WORDS.some((word) => q.includes(normalizeUpper(word)));
}

function extractPdNumbers(text = '') {
  const raw = String(text || '').toUpperCase();
  const matches = raw.match(/\b(?:PD|SEPD)\s*[A-Z0-9\-\/]*\d[A-Z0-9\-\/]*/g) || [];
  const normalized = matches.map((m) => cleanDoc(m.replace(/\s+/g, '')));
  const longMatches = raw.match(/\bPD\d{4,}[A-Z0-9\-\/]*\b/g) || [];
  longMatches.forEach((m) => normalized.push(cleanDoc(m)));
  return Array.from(new Set(normalized)).filter((v) => v.length >= 5).slice(0, 50);
}

function detectStatusChange(text = '') {
  const q = normalizeUpper(text);
  const statusMatches = q.match(/\b(ELB|TRI|ANS|COT|PRO|LPC|ODC|ODA|EMB|REC|FAT|CAN)\b/g) || [];
  let fromStatus = null;
  let toStatus = null;

  const explicit = q.match(/\bDE\s+(ELB|TRI|ANS|COT|PRO|LPC|ODC|ODA|EMB|REC|FAT|CAN)\s+(?:PARA|PRA|P\/)\s+(ELB|TRI|ANS|COT|PRO|LPC|ODC|ODA|EMB|REC|FAT|CAN)\b/);
  if (explicit) {
    fromStatus = explicit[1];
    toStatus = explicit[2];
  } else if (statusMatches.length >= 2) {
    fromStatus = statusMatches[0];
    toStatus = statusMatches[1];
  } else if (statusMatches.length === 1 && /\b(ALTER|ATUALIZ|MUDE|MUDAR|TROQUE|TROCAR|COLOQUE|COLOCAR)\b/.test(q)) {
    toStatus = statusMatches[0];
  }

  return { fromStatus, toStatus };
}

function detectActionIntent(text = '') {
  const q = normalizeUpper(text);
  if (!/\b(ALTER|ATUALIZ|MUDE|MUDAR|TROQUE|TROCAR|COLOQUE|COLOCAR|CORRIJ|CORRIGIR)\b/.test(q)) return null;
  if (!/\b(PD|SEPD)\b/.test(q)) return null;
  if (isSensitiveCommand(text)) return { type: 'BLOQUEADA', reason: 'Comando toca em área sensível não logística.' };

  const pds = extractPdNumbers(text);
  const { fromStatus, toStatus } = detectStatusChange(text);
  if (!pds.length || !toStatus) return null;
  if (!ALLOWED_PD_STATUSES.has(toStatus)) return { type: 'BLOQUEADA', reason: 'Status de destino não permitido.' };

  return { type: 'ALTERAR_STATUS_PD', pds, fromStatus, toStatus };
}

async function verifyPassword(user = {}, password = '') {
  const senha = normalizePassword(password);
  if (!senha) return { ok: false, reason: 'Informe a senha para autorizar.' };

  const email = normalizeEmail(user?.email);
  if (!email) return { ok: false, reason: 'Usuario sem email autenticado.' };

  const { data, error } = await getSupabaseAdmin()
    .from('authorized_users')
    .select('id,email,role,active,auth_user_id,auth_bound_at')
    .eq('email', email)
    .maybeSingle();

  if (error) return { ok: false, reason: error.message };
  if (!data || data.active === false) return { ok: false, reason: 'Usuario nao autorizado ou inativo.' };
  if (!ALLOWED_ROLES.has(String(data.role || '').toLowerCase())) return { ok: false, reason: 'Somente Admin ou Dono pode executar alteracoes pelo Chat Lince.' };

  try {
    const auth = await signInWithPassword(email, senha);
    await bindAuthorizedUserIdentity({
      authorizedUserId: data.id,
      authUserId: auth.user.id,
      authEmail: auth.user.email,
    });
    if (data.auth_user_id && String(data.auth_user_id) !== String(auth.user.id)) {
      return { ok: false, reason: 'A identidade Supabase autenticada diverge do vínculo autorizado no SISHA.' };
    }
    return { ok: true, user: data, auth_provider: 'supabase', auth_user_id: auth.user.id };
  } catch (error) {
    if (String(error?.code || '').startsWith('AUTH_IDENTITY_')) {
      return { ok: false, reason: 'A identidade Supabase nao corresponde ao cadastro autorizado no SISHA.' };
    }
    return { ok: false, reason: 'Senha de autorizacao incorreta ou acesso Supabase ainda nao ativado.' };
  }
}

function formatPlanResponse(plan = {}) {
  const linhas = (plan?.plan_payload?.itens || []).map((item) => {
    const atual = item.status_atual || item.status_grupo_atual || 'não informado';
    return `- ${item.numero_pd}: ${atual} → ${plan.plan_payload?.novo_status}`;
  });
  return [
    'Entendi. Eu posso preparar essa alteração, mas não vou mexer no banco sem sua confirmação.',
    '',
    'Plano de alteração:',
    ...linhas,
    '',
    'Impacto: os PDs alterados passam a ser considerados pelo SISHA conforme o novo status no Radar Logístico, Gerador de Necessidades e consultas de compra.',
    'A OC vinculada não será alterada automaticamente nesta versão; somente os PDs listados no plano.',
    '',
    'Proteção H6C: se qualquer PD mudar depois deste preview, a execução inteira será recusada e um novo plano será necessário.',
    'Para executar, confirme no campo de senha mascarado que apareceu abaixo do chat.',
  ].join('\n');
}

async function loadCurrentTargets(ids = []) {
  const { data, error } = await supabase
    .from('compras_pds')
    .select('id,numero_pd,numero_oc,ordem_id,pn,nomenclatura,quantidade,status,status_grupo,status_item,ativo,updated_at')
    .in('id', ids);
  if (error) throw error;
  return data || [];
}

async function buildActionPlan({ pergunta, user }) {
  const detected = detectActionIntent(pergunta);
  if (!detected) return null;

  if (detected.type === 'BLOQUEADA') {
    return {
      blocked: true,
      resposta: `Não posso executar esse tipo de pedido pelo Chat Lince. Motivo: ${detected.reason} O agente executor só atua em ferramentas logísticas autorizadas, com confirmação e auditoria.`,
    };
  }

  if (!ALLOWED_ROLES.has(String(user?.role || '').toLowerCase())) {
    return { blocked: true, resposta: 'Entendi o pedido de alteração, mas somente Admin ou Dono pode executar mudanças no banco pelo Chat Lince.' };
  }

  const { data: rows, error } = await supabase
    .from('compras_pds')
    .select('id,numero_pd,numero_oc,ordem_id,pn,nomenclatura,quantidade,status,status_grupo,status_item,ativo,updated_at')
    .in('numero_pd', detected.pds);
  if (error) throw error;

  const foundByPd = new Map((rows || []).map((row) => [normalizeUpper(row.numero_pd), row]));
  const itens = [];
  const naoEncontrados = [];
  detected.pds.forEach((pd) => {
    const row = foundByPd.get(normalizeUpper(pd));
    if (!row) { naoEncontrados.push(pd); return; }
    const statusAtual = normalizeUpper(row.status_grupo || row.status || '');
    itens.push({
      id: row.id,
      numero_pd: row.numero_pd,
      numero_oc: row.numero_oc,
      ordem_id: row.ordem_id,
      pn: row.pn,
      nomenclatura: row.nomenclatura,
      quantidade: row.quantidade,
      status_atual: row.status,
      status_grupo_atual: row.status_grupo,
      status_item_atual: row.status_item,
      ativo: row.ativo,
      updated_at: row.updated_at,
      valido_para_execucao: !detected.fromStatus || statusAtual === detected.fromStatus,
      ressalva: detected.fromStatus && statusAtual !== detected.fromStatus ? `Status atual é ${statusAtual || 'não informado'}, diferente de ${detected.fromStatus}.` : null,
    });
  });

  const invalidos = itens.filter((item) => item.valido_para_execucao === false);
  if (naoEncontrados.length || invalidos.length || itens.length !== detected.pds.length) {
    const motivos = [];
    if (naoEncontrados.length) motivos.push(`PD(s) não encontrado(s): ${naoEncontrados.join(', ')}`);
    if (invalidos.length) motivos.push(`PD(s) com estado diferente do solicitado: ${invalidos.map((item) => item.numero_pd).join(', ')}`);
    return {
      blocked: true,
      resposta: `Não vou criar um plano parcialmente executável. ${motivos.join('. ')}. Corrija a seleção ou peça um novo preview.`,
    };
  }

  const guard = buildPlanGuard({ detected, user, items: itens });
  const payload = {
    tipo: detected.type,
    pds: detected.pds,
    status_origem_informado: detected.fromStatus || null,
    novo_status: detected.toStatus,
    itens,
    nao_encontrados: [],
    guard,
    regra_segura: 'Plano H6C: mesmo solicitante, revalidação do estado antes/depois da senha, perfil Admin/Dono e auditoria.',
  };

  const { data: plan, error: insertError } = await supabase
    .from('chat_lince_action_plans')
    .insert({
      action_type: detected.type,
      status: 'PENDENTE_CONFIRMACAO',
      pergunta_original: String(pergunta || '').slice(0, 5000),
      requested_by_email: normalizeEmail(user?.email) || null,
      requested_by_role: String(user?.role || '').toLowerCase() || null,
      plan_payload: payload,
      affected_before: itens,
      expires_at: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
    })
    .select('*')
    .single();
  if (insertError) throw insertError;

  return { id: plan.id, action_type: plan.action_type, status: plan.status, plan_payload: payload, resposta: formatPlanResponse({ ...plan, plan_payload: payload }) };
}

async function executeActionPlan({ actionId, senha, user }) {
  const { data: plan, error } = await supabase
    .from('chat_lince_action_plans')
    .select('*')
    .eq('id', actionId)
    .maybeSingle();
  if (error) throw error;
  if (!plan) return { ok: false, statusCode: 404, code: 'ACTION_PLAN_NOT_FOUND', message: 'Plano de ação não encontrado.' };

  const envelope = validatePlanEnvelope(plan, user);
  if (!envelope.ok) {
    if (envelope.code === 'ACTION_PLAN_EXPIRED') {
      await supabase.from('chat_lince_action_plans').update({ status: 'EXPIRADO' }).eq('id', actionId);
    }
    return { ok: false, statusCode: envelope.code === 'ACTION_REQUESTER_MISMATCH' ? 403 : 409, code: envelope.code, message: envelope.message };
  }

  const ids = envelope.targets.map((target) => target.id);
  const beforeAuthRows = await loadCurrentTargets(ids);
  const beforeAuth = validateCurrentTargets(envelope.targets, beforeAuthRows);
  if (!beforeAuth.ok) {
    return { ok: false, statusCode: 409, code: beforeAuth.code, message: beforeAuth.message, conflicts: beforeAuth.conflicts };
  }

  const auth = await verifyPassword(user, senha);
  if (!auth.ok) return { ok: false, statusCode: 401, code: 'ACTION_REAUTH_FAILED', message: auth.reason };

  // Segunda leitura obrigatória após a reautenticação para reduzir TOCTOU.
  const afterAuthRows = await loadCurrentTargets(ids);
  const afterAuth = validateCurrentTargets(envelope.targets, afterAuthRows);
  if (!afterAuth.ok) {
    return { ok: false, statusCode: 409, code: afterAuth.code, message: afterAuth.message, conflicts: afterAuth.conflicts };
  }

  const novoStatus = envelope.newStatus;
  const updatePayload = {
    status: novoStatus,
    status_grupo: novoStatus,
    status_item: novoStatus,
    ativo: novoStatus !== 'CAN',
    updated_at: new Date().toISOString(),
  };

  const { data: updated, error: updateError } = await supabase
    .from('compras_pds')
    .update(updatePayload)
    .in('id', ids)
    .select('id,numero_pd,numero_oc,pn,status,status_grupo,status_item,ativo,updated_at');
  if (updateError) throw updateError;

  const updatedRows = updated || [];
  const verificationOk = updatedRows.length === ids.length && updatedRows.every((row) => (
    normalizeUpper(row.status) === novoStatus
    && normalizeUpper(row.status_grupo) === novoStatus
    && normalizeUpper(row.status_item) === novoStatus
    && row.ativo === (novoStatus !== 'CAN')
  ));

  if (!verificationOk) {
    await supabase.from('chat_lince_action_plans').update({
      status: 'ERRO_POS_EXECUCAO',
      confirmed_by_email: normalizeEmail(user?.email) || null,
      confirmed_at: new Date().toISOString(),
      executed_at: new Date().toISOString(),
      execution_result: {
        code: 'ACTION_EXECUTION_VERIFICATION_FAILED',
        mutation_committed: updatedRows.length > 0,
        expected_count: ids.length,
        returned_count: updatedRows.length,
        rows: updatedRows,
      },
    }).eq('id', actionId);

    return {
      ok: false,
      statusCode: 500,
      code: 'ACTION_EXECUTION_VERIFICATION_FAILED',
      mutationCommitted: updatedRows.length > 0,
      message: 'A verificação pós-execução não confirmou todos os PDs. Não repita a ação; consulte o log/auditoria e gere um novo diagnóstico.',
    };
  }

  const executionResult = {
    executado_em: new Date().toISOString(),
    executado_por: normalizeEmail(user?.email) || null,
    auth_provider: auth.auth_provider,
    auth_user_id: auth.auth_user_id,
    novo_status: novoStatus,
    pds_atualizados: updatedRows,
    pds_ignorados: [],
    guard_version: plan.plan_payload?.guard?.version || null,
    revalidacao_pre_auth: 'OK',
    revalidacao_pos_auth: 'OK',
    observacao: 'Execução H6C concluída após vínculo ao solicitante, duas revalidações de estado, reautenticação Supabase e verificação pós-update.',
  };

  const { error: planUpdateError } = await supabase
    .from('chat_lince_action_plans')
    .update({
      status: 'EXECUTADO',
      confirmed_by_email: normalizeEmail(user?.email) || null,
      confirmed_at: new Date().toISOString(),
      executed_at: new Date().toISOString(),
      execution_result: executionResult,
    })
    .eq('id', actionId);

  if (planUpdateError) {
    return {
      ok: false,
      statusCode: 500,
      code: 'ACTION_PLAN_RESULT_PERSISTENCE_FAILED',
      mutationCommitted: true,
      message: 'Os PDs foram atualizados, mas o registro final do plano falhou. Não repita a ação; consulte a auditoria.',
      data: executionResult,
    };
  }

  return { ok: true, code: 'ACTION_EXECUTED', message: `${updatedRows.length} PD(s) atualizado(s) para ${novoStatus}.`, data: executionResult };
}

module.exports = {
  detectActionIntent,
  buildActionPlan,
  executeActionPlan,
};
