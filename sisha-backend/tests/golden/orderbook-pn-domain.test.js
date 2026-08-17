const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const fs = require('node:fs');
const path = require('node:path');

const readRepo = (relative) => fs.readFileSync(path.join(__dirname, '../..', relative), 'utf8');
const readFrontend = (relative) => fs.readFileSync(path.join(__dirname, '../../..', 'sisha-frontend', relative), 'utf8');

const originalLoad = Module._load;
Module._load = function mockedLoad(request, parent, isMain) {
  if (request === '../config/supabaseClient') return {};
  return originalLoad.call(this, request, parent, isMain);
};

const {
  buildOrderBookIndex,
  findOrderBookMatch,
  buildOrderBookPdEvidence,
  listOrderBookPdGaps,
  resolvePdLifecycleStatus,
} = require('../../src/services/orderBookReconciliationService');

const {
  normalizeKey,
  getSubItemPriority,
  compareRelations,
  normalizeRfqEvolution,
} = require('../../src/services/pnRelationsService');

Module._load = originalLoad;

test('GOLDEN Order Book: PD+PN forte ignora pontuacao/espacos de comparacao', () => {
  const index = buildOrderBookIndex([{
    documento_referencia: 'PD 123-45/2026',
    pn: 'ABC-123',
    oc_referencia: 'P2026-001/02',
  }]);

  const match = findOrderBookMatch({
    numero_pd: 'PD123452026',
    pn: 'ABC123',
  }, index);

  assert.ok(match);
  assert.equal(match.numeroOc, 'P2026-001');
  assert.equal(match.numeroOcOriginal, 'P2026-001/02');
});

test('GOLDEN Order Book: fallback por PD so ocorre quando o PD e inequivoco', () => {
  const unique = buildOrderBookIndex([{
    documento_referencia: 'PD-777',
    pn: 'PN-A',
    oc_referencia: 'OC-1',
  }]);
  assert.ok(findOrderBookMatch({ numero_pd: 'PD777', pn: 'PN-DIFERENTE' }, unique));

  const ambiguous = buildOrderBookIndex([
    { documento_referencia: 'PD-888', pn: 'PN-A', oc_referencia: 'OC-1' },
    { documento_referencia: 'PD-888', pn: 'PN-B', oc_referencia: 'OC-2' },
  ]);
  assert.equal(
    findOrderBookMatch({ numero_pd: 'PD888', pn: 'PN-X' }, ambiguous),
    null
  );
});

test('GOLDEN Order Book: linhas sem PD real nao entram no indice', () => {
  const index = buildOrderBookIndex([
    { documento_referencia: '', pn: 'PN-A', oc_referencia: 'OC-1' },
    { documento_referencia: 'N/A', pn: 'PN-B', oc_referencia: 'OC-2' },
  ]);
  assert.equal(index.byPd.size, 0);
  assert.equal(index.strong.size, 0);
});

test('GOLDEN PN: normalizacao elimina espacos da identidade do PN', () => {
  assert.equal(normalizeKey('  AB 12 34  '), 'AB1234');
});

test('GOLDEN PN: prioridade tecnica 00A vem antes de 00B e 00C', () => {
  assert.equal(getSubItemPriority('00A'), 1);
  assert.equal(getSubItemPriority('00B'), 2);
  assert.equal(getSubItemPriority('00C'), 3);

  const rows = [
    { origem: 'CIETP', prioridade: getSubItemPriority('00C'), pn_relacionado: 'PN-C' },
    { origem: 'CIETP', prioridade: getSubItemPriority('00A'), pn_relacionado: 'PN-A' },
    { origem: 'CIETP', prioridade: getSubItemPriority('00B'), pn_relacionado: 'PN-B' },
  ].sort(compareRelations);

  assert.deepEqual(rows.map((row) => row.pn_relacionado), ['PN-A', 'PN-B', 'PN-C']);
});

test('GOLDEN PN: evolucao RFQ e direcional e preserva antigo/atual', () => {
  assert.deepEqual(
    normalizeRfqEvolution({
      pn: 'PN-NOVO',
      pn_relacionado: 'PN-ANTIGO',
      tipo_relacao_pn: 'SUPERSEDES',
    }),
    { pn_antigo: 'PN-ANTIGO', pn_atual: 'PN-NOVO' }
  );

  assert.deepEqual(
    normalizeRfqEvolution({
      pn: 'PN-ANTIGO',
      pn_relacionado: 'PN-NOVO',
      tipo_relacao_pn: 'SUPERSEDED_BY',
    }),
    { pn_antigo: 'PN-ANTIGO', pn_atual: 'PN-NOVO' }
  );
});


test('PD lifecycle: número do PD é a identidade canônica e Order Book sem origem vira aviso', () => {
  const spares = [
    { documento_referencia: 'PD91100-2026-00001', pn: 'PN-A', oc_referencia: 'P2026-4001', status_categoria: 'EM TRANSPORTE' },
    { documento_referencia: 'PD91100-2026-00002', pn: 'PN-B', oc_referencia: 'P2026-4002', status_categoria: 'AGUARDANDO' },
  ];
  const pds = [{ numero_pd: 'PD91100-2026-00001', pn: 'PN-A', ativo: true }];
  const result = listOrderBookPdGaps(spares, pds);
  assert.equal(result.gaps.length, 1);
  assert.equal(result.gaps[0].numero_pd, 'PD91100-2026-00002');
});


test('PD lifecycle retroativo: Recibo total leva o mesmo PD para REC', () => {
  assert.equal(resolvePdLifecycleStatus({ currentStatus: 'ODA', ordered: 10, delivered: 10, orderBookPresent: true }), 'REC');
});

test('PD lifecycle retroativo: entrega parcial promove ODC para ODA sem criar estado paralelo', () => {
  assert.equal(resolvePdLifecycleStatus({ currentStatus: 'ODC', ordered: 10, delivered: 4, orderBookPresent: false }), 'ODA');
});

test('PD lifecycle retroativo: Order Book promove ODC existente para ODA mesmo sem Recibo', () => {
  assert.equal(resolvePdLifecycleStatus({ currentStatus: 'ODC', ordered: 10, delivered: 0, orderBookPresent: true }), 'ODA');
});

test('PD lifecycle histórico: ausência em snapshot novo nunca regride REC já comprovado', () => {
  assert.equal(resolvePdLifecycleStatus({ currentStatus: 'REC', ordered: 10, delivered: 0, orderBookPresent: false }), 'REC');
  assert.equal(resolvePdLifecycleStatus({ currentStatus: 'ODA', ordered: 10, delivered: 0, orderBookPresent: false, historicalRecEvidence: true }), 'REC');
});

test('PD lifecycle histórico: somente correção explícita pode regredir REC', () => {
  assert.equal(resolvePdLifecycleStatus({ currentStatus: 'REC', ordered: 10, delivered: 7, historicalOdaEvidence: true, allowRegression: true }), 'ODA');
  assert.equal(resolvePdLifecycleStatus({ currentStatus: 'REC', ordered: 10, delivered: 0, historicalOdaEvidence: false, allowRegression: true }), 'ODC');
});

test('PD lifecycle Order Book: delivered parcial conta como entrega e in delivery não', () => {
  const evidence = buildOrderBookPdEvidence([
    { documento_referencia: 'PD91100-2026-00001', pn: 'PN-A', oc_referencia: 'P2026-1', qtd_comprada: 10, qtd_em_rota: 6, qtd_entregue: 4, qtd_pendente: 6, cust_po_item: '1' },
  ]).get('PD91100202600001');
  assert.ok(evidence);
  assert.equal(evidence.qtd_comprada, 10);
  assert.equal(evidence.qtd_em_rota, 6);
  assert.equal(evidence.qtd_entregue, 4);
  assert.equal(resolvePdLifecycleStatus({ currentStatus: 'ODC', ordered: evidence.qtd_comprada, delivered: evidence.qtd_entregue, orderBookPresent: true }), 'ODA');
});

test('PD lifecycle Order Book: delivered integral promove para REC mesmo com saldo zero no snapshot operacional', () => {
  const evidence = buildOrderBookPdEvidence([
    { documento_referencia: 'PD91100-2026-00001', pn: 'PN-A', oc_referencia: 'P2026-1', qtd_comprada: 10, qtd_em_rota: 0, qtd_entregue: 10, qtd_pendente: 0, cust_po_item: '1' },
  ]).get('PD91100202600001');
  assert.equal(resolvePdLifecycleStatus({ currentStatus: 'ODA', ordered: evidence.qtd_comprada, delivered: evidence.qtd_entregue, orderBookPresent: true }), 'REC');
});


test('PD lifecycle visão geral: cards usam estágio corrente em vez de Com OC', () => {
  const controller = readRepo('src/controllers/purchaseController.js');
  const frontend = readFrontend('src/pages/OrdensCompras.jsx');
  assert.match(controller, /function classifyPdPipelineStage\(pd = \{\}\)/);
  assert.match(controller, /if \(st === 'REC' \|\| \(ordered > 0 && delivered >= ordered\)\) return 'entregue'/);
  assert.match(controller, /if \(delivered > 0\) return 'entrega_parcial'/);
  assert.match(controller, /if \(st === 'ODA' \|\| st === 'ODA_RESSALVA' \|\| st === 'FAT' \|\| st === 'EMB'\) return 'oda'/);
  assert.doesNotMatch(frontend, /pdPipeline\.com_oc/);
  assert.match(frontend, /title="ODC"/);
  assert.match(frontend, /title="ODA \/ FAT \/ EMB"/);
  assert.match(frontend, /title="ENTREGA PARCIAL"/);
  assert.match(frontend, /title="ENTREGUE"/);
});

test('PD lifecycle visão geral: cada PD é classificado em um único card e resumo é calculado ao vivo', () => {
  const controller = readRepo('src/controllers/purchaseController.js');
  assert.match(controller, /select\('status,status_grupo,ordem_id,ativo,quantidade,qtd_pedida,qtd_comprada,qtd_recebida'\)/);
  assert.match(controller, /const bucket = classifyPdPipelineStage\(pd\)/);
  assert.match(controller, /summary\[bucket\] \+= 1/);
  assert.match(controller, /if \(!pd\.ordem_id\) return 'sem_oc'/);
  assert.doesNotMatch(controller, /summary\.com_oc \+= 1/);
});


test('PD lifecycle dashboard: Visão Geral principal usa o ciclo canônico e não PD AGU REC legado', () => {
  const stats = readRepo('src/controllers/statsController.js');
  const app = readFrontend('src/App.jsx');

  assert.match(stats, /qtd_recebida/);
  assert.match(stats, /if \(status === 'REC' \|\| \(ordered > 0 && delivered >= ordered\)\) return 'entregue'/);
  assert.match(stats, /if \(delivered > 0\) return 'entregaParcial'/);
  assert.match(stats, /if \(!row\.ordem_id\) return 'semOc'/);
  assert.match(stats, /\['ODA', 'ODA_RESSALVA'\]\.includes\(status\)/);
  assert.match(stats, /if \(status === 'FAT'\) return 'faturado'/);
  assert.match(stats, /if \(status === 'EMB'\) return 'embarcado'/);

  assert.doesNotMatch(app, />PD AGU REC</);
  assert.match(app, />CICLO DOS PDs</);
  assert.match(app, /\['PARCIAL', pipeline\.entregaParcial/);
  assert.doesNotMatch(app, /\['ENTREGUE', pipeline\.entregue/);
  assert.doesNotMatch(app, /ODA\/FAT\/EMB/);
  assert.match(app, /\['ODA', pipeline\.oda/);
  assert.match(app, /pipeline\.totalAcompanhamento/);
});

test('PD lifecycle dashboard: FAT, EMB e ENTREGUE ficam fora do card e da contagem principal', () => {
  const stats = readRepo('src/controllers/statsController.js');
  const app = readFrontend('src/App.jsx');

  assert.match(stats, /totalAcompanhamento: 0/);
  assert.match(stats, /'entregaParcial'/);
  assert.doesNotMatch(app, /ODA\/FAT\/EMB/);
  assert.doesNotMatch(app, /\['ENTREGUE', pipeline\.entregue/);
  assert.match(app, />PDs em acompanhamento<\/span>/);
});


test('PD lifecycle dashboard: Dashboard e Ordens/PDs tratam LIB/LPC como pré-ODC', () => {
  const stats = readRepo('src/controllers/statsController.js');
  const controller = readRepo('src/controllers/purchaseController.js');

  assert.match(stats, /'COT', 'PRO', 'LPC', 'LIB', 'LIBERADA', 'LIBERADO'/);
  assert.match(controller, /\['COT', 'PRO', 'LPC', 'LIB', 'LIBERADA', 'LIBERADO'/);
});


test('PD lifecycle import: Order Book preserva evidência quantitativa mesmo quando o PD já foi 100% entregue', () => {
  const importController = readRepo('src/controllers/importController.js');
  assert.match(importController, /const orderBookPdEvidenceRows = \[\]/);
  assert.match(importController, /orderBookPdEvidenceRows\.push\(\{/);
  assert.match(importController, /qtd_comprada: qtdComprada/);
  assert.match(importController, /qtd_em_rota: qtdEmRota/);
  assert.match(importController, /qtd_entregue: qtdEntregue/);
  assert.match(importController, /reconcileOrderBookPds\(orderBookPdEvidenceRows\.length \? orderBookPdEvidenceRows : allSpares/);
});

test('PD lifecycle fontes: Recibo e Order Book usam maior acumulado, nunca soma entre fontes', () => {
  const receipt = readRepo('src/services/receiptService.js');
  assert.match(receipt, /const sourceDelivered = Math\.max\(receiptDelivered, independentOrderBookFloor\)/);
  assert.match(receipt, /const afterDelivered = explicitCorrection[\s\S]*\? sourceDelivered[\s\S]*: Math\.max\(beforeDelivered, sourceDelivered\)/);
  assert.match(receipt, /allowRegression: explicitCorrection/);
});

test('PD lifecycle histórico: reconciliação normal é monotônica e registra quantidades do Order Book', () => {
  const service = readRepo('src/services/orderBookReconciliationService.js');
  assert.match(service, /AUSENCIA_POSTERIOR_NAO_REGRIDE/);
  assert.match(service, /qtd_entregue_order_book: orderBookDelivered/);
  assert.match(service, /historicalRecEvidence: history\.preserveRec/);
  assert.match(service, /allowRegression: false/);
  assert.match(service, /regressoes_bloqueadas_por_historico/);
});
