const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  SOURCE_CLASSES,
  sourcePublicLabel,
  describeEvidenceSource,
  describeRagRowProvenance,
  buildEvidenceProfile,
  evaluateClaimReadiness,
  evidenceRulesForPrompt,
} = require('../../src/services/chatLinceEvidenceTrustService');

const backendRoot = path.resolve(__dirname, '../..');
function read(relativePath) {
  return fs.readFileSync(path.join(backendRoot, relativePath), 'utf8');
}

test('GOLDEN H6B: PPU vivo pode confirmar estado operacional dentro do SISHA', () => {
  const d = describeEvidenceSource({ tabela: 'v_sisha_ppu_disponibilidade', linhas: [{}] });
  assert.equal(d.source_class, SOURCE_CLASSES.LIVE_OPERATIONAL);
  assert.equal(d.trust_score, 100);
  assert.equal(d.can_confirm_current_state, true);
  assert.equal(d.requires_primary_validation, false);
});

test('GOLDEN H6B: CeIMSPA continua referencia que exige confirmacao externa', () => {
  const d = describeEvidenceSource({ tabela: 'v_sisha_ceimspa_disponibilidade', linhas: [{}] });
  assert.equal(d.source_class, SOURCE_CLASSES.EXTERNAL_OPERATIONAL_REFERENCE);
  assert.equal(d.can_confirm_current_state, false);
  assert.equal(d.requires_primary_validation, true);
  assert.match(d.scope, /CeIMSPA/i);
});

test('GOLDEN H6B: manual tecnico confirma aplicacao, nao estoque atual', () => {
  const d = describeEvidenceSource({ tabela: 'v_sisha_manual_pn_aplicacao', linhas: [{}] });
  assert.equal(d.source_class, SOURCE_CLASSES.TECHNICAL_PRIMARY);
  assert.equal(d.can_confirm_current_state, false);
  assert.match(d.scope, /não comprova estoque atual/i);
});

test('GOLDEN H6B: documento analisado e evidencia documental de baixa precedencia operacional', () => {
  const d = describeEvidenceSource({ tabela: 'chat_lince_documentos', linhas: [{}] });
  assert.equal(d.source_class, SOURCE_CLASSES.DOCUMENTARY_ANALYSIS);
  assert.equal(d.can_confirm_current_state, false);
  assert.equal(d.requires_primary_validation, true);
});

test('GOLDEN H6B: RAG documental cru nunca confirma estado atual', () => {
  const p = describeRagRowProvenance({
    document_key: 'doc-1',
    documento: { nome_arquivo: 'relatorio.pdf', origem_tabela: 'chat_lince_documentos', status: 'ANALISADO' },
    metadata: {},
  });
  assert.equal(p.source_class, SOURCE_CLASSES.RAG_DERIVED);
  assert.equal(p.structured_source_snapshot, false);
  assert.equal(p.can_confirm_current_state, false);
  assert.equal(p.requires_primary_validation, true);
  assert.match(p.public_label, /relatorio\.pdf/i);
});

test('GOLDEN H6B: RAG derivado de fonte estruturada continua sendo snapshot', () => {
  const p = describeRagRowProvenance({
    document_key: 'compras_pds:1',
    documento: { origem_tabela: 'compras_pds' },
    metadata: { fonte_logistica_estruturada: true, origem_tabela: 'compras_pds' },
  });
  assert.equal(p.structured_source_snapshot, true);
  assert.equal(p.can_confirm_current_state, false);
  assert.ok(p.trust_score > 30);
  assert.match(p.scope, /snapshot/i);
});

test('GOLDEN H6B: perfil somente RAG/documento e marcado documentary_only', () => {
  const profile = buildEvidenceProfile([
    { tabela: 'chat_lince_documentos', linhas: [{}] },
    { tabela: 'chat_lince_rag_chunks', linhas: [{ metadata: {}, documento: {} }] },
  ]);
  assert.equal(profile.documentary_only, true);
  assert.equal(profile.current_state_confirmers, 0);
  assert.equal(profile.has_rag, true);
});

test('GOLDEN H6B: perfil com PPU vivo deixa de ser documental-only', () => {
  const profile = buildEvidenceProfile([
    { tabela: 'chat_lince_rag_chunks', linhas: [{ metadata: {}, documento: {} }] },
    { tabela: 'v_sisha_ppu_disponibilidade', linhas: [{}] },
  ]);
  assert.equal(profile.documentary_only, false);
  assert.equal(profile.current_state_confirmers, 1);
  assert.equal(profile.has_live_operational, true);
});

test('GOLDEN H6B: claim de estado atual falha fechado com evidência apenas documental', () => {
  const ready = evaluateClaimReadiness([
    { tabela: 'chat_lince_documentos', linhas: [{}] },
  ], 'CURRENT_OPERATIONAL_STATE');
  assert.equal(ready.ready, false);
  assert.equal(ready.blocker, 'LIVE_OPERATIONAL_SOURCE_REQUIRED');
});

test('GOLDEN H6B: claim de estado atual fica pronto com fonte operacional viva', () => {
  const ready = evaluateClaimReadiness([
    { tabela: 'equipamentos_serializados', linhas: [{}] },
  ], 'CURRENT_OPERATIONAL_STATE');
  assert.equal(ready.ready, true);
  assert.equal(ready.blocker, null);
});

test('GOLDEN H6B: claim de aplicacao tecnica exige fonte tecnica primaria', () => {
  const no = evaluateClaimReadiness([{ tabela: 'chat_lince_documentos', linhas: [{}] }], 'TECHNICAL_APPLICABILITY');
  assert.equal(no.ready, false);
  assert.equal(no.blocker, 'TECHNICAL_PRIMARY_SOURCE_REQUIRED');

  const yes = evaluateClaimReadiness([{ tabela: 'dicionario_mestre', linhas: [{}] }], 'TECHNICAL_APPLICABILITY');
  assert.equal(yes.ready, true);
});

test('GOLDEN H6B: regras de prompt declaram precedencia e conflito de fontes', () => {
  const text = evidenceRulesForPrompt(buildEvidenceProfile([]));
  assert.match(text, /Estado operacional atual/i);
  assert.match(text, /RAG derivado/i);
  assert.match(text, /conflitarem/i);
  assert.match(text, /CeIMSPA/i);
});

test('GOLDEN H6B: labels publicos escondem nomenclatura interna do usuario', () => {
  assert.equal(sourcePublicLabel('compras_pds'), 'Pedidos ao Depósito (PD)');
  assert.equal(sourcePublicLabel('leonardo_repairs'), 'Order Book Leonardo — Repairs/Warranty');
});

test('GOLDEN H6B: busca RAG anexa proveniencia a cada trecho', () => {
  const source = read('src/services/chatLinceRagService.js');
  assert.match(source, /describeRagRowProvenance/);
  assert.match(source, /proveniencia:\s*describeRagRowProvenance\(enriched\)/);
});

test('GOLDEN H6B: prompt do agente recebe perfil e hierarquia de evidencias', () => {
  const source = read('src/services/chatLinceService.js');
  assert.match(source, /perfil_evidencias:\s*evidenceProfile/);
  assert.match(source, /evidenceRulesForPrompt\(agent\?\.plano_execucao\?\.perfil_evidencias/);
  assert.match(source, /Não transforme um trecho de RAG\/documento em fato operacional atual/);
});

test('GOLDEN H6B: contexto enviado ao modelo inclui proveniencia e classificacao', () => {
  const source = read('src/services/chatLinceService.js');
  assert.match(source, /fonte_publica:\s*evidence\.public_label/);
  assert.match(source, /evidencia:\s*evidence/);
  assert.match(source, /compactRow\.proveniencia/);
  assert.match(source, /perfil_evidencias:\s*buildEvidenceProfile/);
});

test('GOLDEN H6B: resposta offline chama RAG de evidencia documental e preserva ressalva', () => {
  const source = read('src/services/chatLinceService.js');
  assert.match(source, /evidências documentais indexadas pelo Chat Lince/);
  assert.match(source, /não confirmam sozinhas o estado operacional atual/);
  assert.match(source, /provenance\.scope/);
});

test('GOLDEN Chat Lince HF: dossiê multi-fonte tem prioridade sobre atalho do Livro de Equipamentos', () => {
  const source = read('src/services/chatLinceDbToolsService.js');
  const dossierIndex = source.indexOf("if (isDossierQuestion(question))");
  const equipmentIndex = source.indexOf("if (!result && isEquipmentRegistryQuestion(question))");
  assert.ok(dossierIndex >= 0);
  assert.ok(equipmentIndex > dossierIndex);
  assert.match(source, /runDossierTool/);
  assert.match(source, /os_master_evidencias/);
  assert.match(source, /equipamento_eventos/);
  assert.match(source, /recebimento_itens/);
  assert.match(source, /pim_demandas/);
  assert.match(source, /work_orders/);
  assert.match(source, /compras_pds/);
});

test('GOLDEN Chat Lince HF: PN explícito no Livro de Equipamentos é filtrado no banco e não procurado em amostra de 50', () => {
  const source = read('src/services/chatLinceDbToolsService.js');
  assert.match(source, /Livro de Equipamentos filtrado por PN exato/);
  assert.match(source, /query\.in\('pn', tokens\)/);
  assert.match(source, /Livro de Equipamentos filtrado por SN exato/);
  assert.match(source, /query\.in\('sn', tokens\)/);
});

test('GOLDEN Chat Lince HF: Master OS ganha rótulo público e não é tratado como nome cru de tabela', () => {
  assert.equal(sourcePublicLabel('os_master_evidencias'), 'Master OS — Divisão de Planejamento');
  assert.equal(sourcePublicLabel('v_sisha_os_historico_atual'), 'Histórico consolidado do Master OS');
  const descriptor = describeEvidenceSource({ tabela: 'os_master_evidencias', linhas: [{}] });
  assert.match(descriptor.scope, /Divisão de Planejamento/i);
  assert.equal(descriptor.requires_primary_validation, false);
});

test('GOLDEN Chat Lince HF: composer é multiline, quebra linha e Enter envia sem ficar linear', () => {
  const frontend = read('../sisha-frontend/src/pages/ChatLince.jsx');
  assert.match(frontend, /<textarea/);
  assert.match(frontend, /onKeyDown=\{onComposerKeyDown\}/);
  assert.match(frontend, /event\.key === 'Enter' && !event\.shiftKey/);
  assert.match(frontend, /Shift\+Enter quebra linha/);
  assert.match(frontend, /whitespace-pre-wrap break-words/);
  assert.match(frontend, /Math\.min\(element\.scrollHeight, 180\)/);
});

test('GOLDEN Chat Lince HF: interface consultiva mostra somente módulos acionados e fontes com rótulo humano', () => {
  const frontend = read('../sisha-frontend/src/pages/ChatLince.jsx');
  const backend = read('src/services/chatLinceDbToolsService.js');
  assert.match(frontend, /Fontes desta resposta/);
  assert.match(frontend, /Object\.entries\(modulos\)\.filter\(\(\[, value\]\) => Boolean\(value\)\)/);
  assert.match(frontend, /fonte\.rotulo \|\| fonte\.tabela/);
  assert.match(backend, /rotulo: sourcePublicLabel\(source\.tabela\)/);
});

test('GOLDEN Chat Lince HF: prompt orienta resposta humana, cruzamento e prioridade para identificador explícito', () => {
  const source = read('src/services/chatLinceService.js');
  assert.match(source, /Priorize PN\/SN\/documento explicitamente escrito pelo usuário/);
  assert.match(source, /Se o usuário pedir dossiê, cruzamento ou rastreio completo/);
  assert.match(source, /fato físico confirmado, intenção\/escrituração/);
  assert.match(source, /não escolha silenciosamente/);
});
