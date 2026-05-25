const supabase = require('../config/supabaseClient');

const ALLOWED_ROLES = new Set(['admin', 'dono']);
const ALLOWED_PD_STATUSES = new Set(['ELB', 'TRI', 'ANS', 'COT', 'PRO', 'LPC', 'ODC', 'ODA', 'EMB', 'REC', 'FAT', 'CAN']);
const BLOCKED_WORDS = ['authorized_users', 'senha', 'password', 'token', 'jwt', 'login', 'perfil', 'role', 'admin', 'dono'];

function normalizeUpper(value = '') {
  return String(value || '').trim().toUpperCase();
}

function normalizePassword(value = '') {
  return String(value || '').trim();
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

  return {
    type: 'ALTERAR_STATUS_PD',
    pds,
    fromStatus,
    toStatus,
  };
}

async function verifyPassword(user = {}, password = '') {
  const senha = normalizePassword(password);
  if (!senha) return { ok: false, reason: 'Informe a senha para autorizar.' };

  const email = String(user?.email || '').trim().toLowerCase();
  if (!email) return { ok: false, reason: 'Usuário sem email autenticado.' };

  const { data, error } = await supabase
    .from('authorized_users')
    .select('id,email,senha,role,active')
    .eq('email', email)
    .maybeSingle();

  if (error) return { ok: false, reason: error.message };
  if (!data || data.active === false) return { ok: false, reason: 'Usuário não autorizado ou inativo.' };
  if (normalizePassword(data.senha) !== senha) return { ok: false, reason: 'Senha de autorização incorreta.' };
  if (!ALLOWED_ROLES.has(String(data.role || '').toLowerCase())) return { ok: false, reason: 'Somente Admin ou Dono pode executar alterações pelo Chat Lince.' };

  return { ok: true, user: data };
}

function formatPlanResponse(plan = {}) {
  const linhas = (plan?.plan_payload?.itens || []).map((item) => {
    const atual = item.status_atual || item.status_grupo_atual || 'não informado';
    return `- ${item.numero_pd}: ${atual} → ${plan.plan_payload?.novo_status}`;
  });
  const naoEncontrados = plan?.plan_payload?.nao_encontrados || [];
  const partes = [
    'Entendi. Eu posso preparar essa alteração, mas não vou mexer no banco sem sua confirmação.',
    '',
    'Plano de alteração:',
    ...linhas,
  ];
  if (naoEncontrados.length) {
    partes.push('', `Não encontrei estes PDs: ${naoEncontrados.join(', ')}.`);
  }
  partes.push('', 'Impacto: os PDs alterados passam a ser considerados pelo SISHA conforme o novo status no Radar Logístico, Gerador de Necessidades e consultas de compra.');
  partes.push('A OC vinculada não será alterada automaticamente nesta versão; somente os PDs listados no plano.');
  partes.push('', 'Para executar, confirme no campo de senha mascarado que apareceu abaixo do chat.');
  return partes.join('\n');
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
    return {
      blocked: true,
      resposta: 'Entendi o pedido de alteração, mas somente Admin ou Dono pode executar mudanças no banco pelo Chat Lince.',
    };
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
    if (!row) {
      naoEncontrados.push(pd);
      return;
    }
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
      valido_para_execucao: !detected.fromStatus || statusAtual === detected.fromStatus,
      ressalva: detected.fromStatus && statusAtual !== detected.fromStatus ? `Status atual é ${statusAtual || 'não informado'}, diferente de ${detected.fromStatus}.` : null,
    });
  });

  const payload = {
    tipo: detected.type,
    pds: detected.pds,
    status_origem_informado: detected.fromStatus || null,
    novo_status: detected.toStatus,
    itens,
    nao_encontrados: naoEncontrados,
    regra_segura: 'Plano criado pelo Chat Lince. Execução só após senha mascarada, perfil Admin/Dono e auditoria.',
  };

  const { data: plan, error: insertError } = await supabase
    .from('chat_lince_action_plans')
    .insert({
      action_type: detected.type,
      status: 'PENDENTE_CONFIRMACAO',
      pergunta_original: String(pergunta || '').slice(0, 5000),
      requested_by_email: user?.email || null,
      requested_by_role: user?.role || null,
      plan_payload: payload,
      affected_before: itens,
      expires_at: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
    })
    .select('*')
    .single();

  if (insertError) throw insertError;

  return {
    id: plan.id,
    action_type: plan.action_type,
    status: plan.status,
    plan_payload: payload,
    resposta: formatPlanResponse(plan),
  };
}

async function executeActionPlan({ actionId, senha, user }) {
  const auth = await verifyPassword(user, senha);
  if (!auth.ok) return { ok: false, statusCode: 401, message: auth.reason };

  const { data: plan, error } = await supabase
    .from('chat_lince_action_plans')
    .select('*')
    .eq('id', actionId)
    .maybeSingle();

  if (error) throw error;
  if (!plan) return { ok: false, statusCode: 404, message: 'Plano de ação não encontrado.' };
  if (plan.status !== 'PENDENTE_CONFIRMACAO') return { ok: false, statusCode: 409, message: `Plano não está pendente. Status atual: ${plan.status}.` };
  if (new Date(plan.expires_at).getTime() < Date.now()) {
    await supabase.from('chat_lince_action_plans').update({ status: 'EXPIRADO' }).eq('id', actionId);
    return { ok: false, statusCode: 409, message: 'Plano expirou. Peça ao Chat Lince para montar um novo plano.' };
  }

  const payload = plan.plan_payload || {};
  if (payload.tipo !== 'ALTERAR_STATUS_PD') return { ok: false, statusCode: 400, message: 'Tipo de ação ainda não habilitado para execução.' };

  const itens = (payload.itens || []).filter((item) => item.valido_para_execucao !== false && item.id);
  if (!itens.length) return { ok: false, statusCode: 400, message: 'Nenhum PD válido para execução.' };

  const ids = itens.map((item) => item.id);
  const novoStatus = normalizeUpper(payload.novo_status);
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

  const executionResult = {
    executado_em: new Date().toISOString(),
    executado_por: user?.email || null,
    novo_status: novoStatus,
    pds_atualizados: updated || [],
    pds_ignorados: (payload.itens || []).filter((item) => item.valido_para_execucao === false || !item.id),
    observacao: 'Execução feita pelo Agente Executor do Chat Lince após confirmação por senha em campo mascarado.',
  };

  await supabase
    .from('chat_lince_action_plans')
    .update({
      status: 'EXECUTADO',
      confirmed_by_email: user?.email || null,
      confirmed_at: new Date().toISOString(),
      executed_at: new Date().toISOString(),
      execution_result: executionResult,
    })
    .eq('id', actionId);

  return { ok: true, message: `${(updated || []).length} PD(s) atualizado(s) para ${novoStatus}.`, data: executionResult };
}

module.exports = {
  detectActionIntent,
  buildActionPlan,
  executeActionPlan,
};
