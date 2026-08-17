const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const read = (...parts) => fs.readFileSync(path.join(ROOT, ...parts), 'utf8');

const cadastro = read('sisha-frontend', 'src', 'pages', 'Cadastro.jsx');
const chatPage = read('sisha-frontend', 'src', 'pages', 'ChatLince.jsx');
const pendingModal = read('sisha-frontend', 'src', 'components', 'PendingCenterModal.jsx');
const chatRoutes = read('sisha-backend', 'src', 'routes', 'chatLinceRoutes.js');
const chatController = read('sisha-backend', 'src', 'controllers', 'chatLinceController.js');
const chatService = read('sisha-backend', 'src', 'services', 'chatLinceService.js');

test('C3: Administração do SISHA ganha botão Pendências sem substituir Localizações do PPU', () => {
  assert.match(cadastro, /<AlertTriangle size=\{17\} \/> PENDÊNCIAS/);
  assert.match(cadastro, /<MapPin size=\{17\} \/> LOCALIZAÇÕES DO PPU/);
  assert.match(cadastro, /<PendingCenterModal/);
});

test('C3: Central agrega fontes existentes sem criar tabela central de verdade', () => {
  assert.match(pendingModal, /\/chat-lince\/documentos\?status=PENDENTE_CONFIRMACAO/);
  assert.match(pendingModal, /\/chat-lince\/helpdesk\?status=ABERTO/);
  assert.match(pendingModal, /\/equipments\/location-conflicts/);
  assert.match(pendingModal, /\/import\/custodia-externa-ppu\/reconciliacao/);
  assert.match(pendingModal, /\/receipts\/batch\/jobs/);
  assert.match(pendingModal, /\/import\/rfq\/jobs/);
  assert.doesNotMatch(pendingModal, /pending_center|central_pendencias|pendencias_central/i);
});

test('C3: Chat Lince deixa de exibir os cards administrativos antigos', () => {
  assert.doesNotMatch(chatPage, />Help Desk do Chat Lince</);
  assert.doesNotMatch(chatPage, />Pendências do Chat Lince</);
  assert.match(chatPage, /Central de Pendências em Atualizar Sistema/);
});

test('C3: card da Central é apenas resumo e abre detalhe antes de qualquer decisão', () => {
  const cardStart = pendingModal.indexOf('function PendingCard');
  const cardEnd = pendingModal.indexOf('export default function PendingCenterModal');
  const card = pendingModal.slice(cardStart, cardEnd);
  assert.match(card, /onClick=\{\(\) => onOpen\(item\)\}/);
  assert.doesNotMatch(card, /REJEITAR|APROVAR|CONFIRMAR CUSTÓDIA|MANTER ESTADO/);
});

test('C3: documento do Chat Lince possui leitura completa Admin/Dono antes de decidir', () => {
  assert.match(chatRoutes, /router\.get\('\/documentos\/:id', requireRole\(\['admin', 'dono'\]\), chatLinceController\.obterDocumento\)/);
  assert.match(chatController, /exports\.obterDocumento/);
  assert.match(chatService, /async function getDocumentAnalysisById\(id\)/);
});

test('C3: correção administrativa preserva o original e fica separada no payload de confirmação', () => {
  assert.match(chatService, /correcoes_admin: possuiCorrecoes \? correcoes : null/);
  assert.match(chatService, /original_preservado: true/);
  assert.match(chatService, /A evidência original permanece imutável/);
  assert.doesNotMatch(chatService, /\.update\(\{[^}]*registros_sugeridos:\s*correcoes/s);
});

test('C3: corrigir e aprovar exige motivo humano', () => {
  assert.match(chatService, /possuiCorrecoes && !String\(observacaoAdmin/);
  assert.match(pendingModal, /Informe o motivo da correção administrativa/);
  assert.match(pendingModal, /CORRIGIR E APROVAR/);
});

test('C3: staging usa estado administrativo corrigido sem reescrever a evidência documental', () => {
  assert.match(chatService, /const documentoEfetivo = possuiCorrecoes \? \{ \.\.\.updated, \.\.\.correcoes \} : updated/);
  assert.match(chatService, /insertAiImportStaging\(documentoEfetivo/);
  assert.match(chatService, /insertOsEventsStaging\(documentoEfetivo/);
});

test('C3: conflito de localização continua usando o resolver do Livro de Equipamentos', () => {
  assert.match(pendingModal, /\/equipments\/\$\{selected\.equipmentId\}\/location-conflicts\/\$\{selected\.id\}\/resolve/);
  assert.match(pendingModal, /decision, motivo: reason\.trim\(\)/);
  assert.match(pendingModal, /MANTER \{currentLocation\.toUpperCase\(\)\}/);
  assert.match(pendingModal, /CONFIRMAR \{candidateLocation\.toUpperCase\(\)\}/);
});

test('C3: divergência de custódia PPU reutiliza reconciliação existente e exige motivo', () => {
  assert.match(pendingModal, /\/import\/custodia-externa-ppu\/reconciliacao/);
  assert.match(pendingModal, /CONFIRMAR_CUSTODIA/);
  assert.match(pendingModal, /IGNORAR_MOVIMENTACAO/);
  assert.match(pendingModal, /MANTER INVENTÁRIO OFICIAL/);
  assert.match(pendingModal, /CONFIRMAR CUSTÓDIA NA CAIXA/);
  assert.match(pendingModal, /if \(!reason\.trim\(\)\) throw new Error\('Informe o motivo da decisão\.'/);
});

test('C3: Recibos continuam sendo decididos no módulo próprio', () => {
  assert.match(pendingModal, /REVISAR NO MÓDULO DE RECIBOS/);
  assert.match(pendingModal, /onOpenReceipts/);
  assert.doesNotMatch(pendingModal, /\/receipts\/batch\/jobs\/\$\{selected\.id\}.*\/saved/s);
});

test('C3: Cotações/RFQ continuam usando o fluxo comercial homologado sem regra paralela', () => {
  assert.match(pendingModal, /\/import\/rfq\/salvar/);
  assert.match(pendingModal, /não cria regra paralela de preço, validade ou idempotência/);
  assert.doesNotMatch(pendingModal, /\/import\/rfq\/central|rfq_salvar_central/i);
});


test('C3.4 HF3: recibo explícito vence Warranty/Leonardo/OS na classificação documental', () => {
  const receiptGate = chatService.indexOf("if (hasStrongReceiptSignature({ tipoDocumento, text, fileName })) return 'RECIBO_MATERIAL'");
  const osGate = chatService.indexOf("return 'OS_INSTALACAO_REMOCAO'");
  const orderBookGate = chatService.indexOf("return 'ORDER_BOOK'");
  assert.ok(receiptGate >= 0 && receiptGate < osGate && receiptGate < orderBookGate);
  assert.match(chatService, /RECIBO_MATERIAL:\s*\[\s*\{ tabela: 'recebimentos'/);
  assert.match(chatService, /strongReceipt \? 'RECIBO_MATERIAL'/);
  assert.match(chatService, /strongReceipt \? 'recebimentos'/);
  assert.match(chatService, /function extractReceiptNumber/);
});

test('C3.4 HF3: Central reconcilia documento genérico com recibo operacional antes de listar pendência', () => {
  assert.match(chatController, /reconcileChatReceiptDocuments/);
  assert.match(chatController, /\.from\('recebimentos'\)/);
  assert.match(chatController, /chat_lince_documento_id/);
  assert.match(chatController, /numero_recibo/);
  assert.match(chatController, /arquivo_nome/);
  assert.match(chatController, /\.filter\(\(row\) => row\.central_resolved !== true\)/);
  assert.match(chatController, /\.limit\(250\)/);
});

test('C3.4 HF3: recibo ainda não gravado recebe uma única ação clara no módulo dono', () => {
  assert.match(pendingModal, /Este arquivo é um Recibo\. A decisão pertence ao módulo de Recibos\./);
  assert.match(pendingModal, /Não escolha ORDER_BOOK, OS ou outra tabela genérica aqui/);
  assert.match(pendingModal, /RECIBO • MÓDULO PRÓPRIO/);
  assert.match(pendingModal, /REVISAR NO MÓDULO DE RECIBOS/);
  assert.match(pendingModal, /Warranty, Leonardo, OS, S\/N ou FOC não transformam um Recibo em Order Book ou OS/);
});

test('C3.4 HF3: interpretação antiga permanece como evidência, mas não define a ação do recibo', () => {
  assert.match(pendingModal, /classificacao_ia_original/);
  assert.match(pendingModal, /destino_ia_original/);
  assert.match(pendingModal, /Interpretação histórica/);
  assert.match(pendingModal, /Roteamento atual/);
  assert.match(pendingModal, /RECIBO_MATERIAL → recebimentos/);
});


test('PD lifecycle: Central alerta PD que apareceu no Order Book sem origem canônica', () => {
  assert.match(pendingModal, /PD_ORDERBOOK_GAP/);
  assert.match(pendingModal, /ORIGEM DO PD AUSENTE/);
  assert.match(pendingModal, /ABRIR ORDENS DE COMPRAS \/ PDs/);
});


test('PD lifecycle retroativo: reconciliação existente é Admin, explícita e idempotente', () => {
  const routes = read('sisha-backend', 'src', 'routes', 'purchaseRoutes.js');
  const controller = read('sisha-backend', 'src', 'controllers', 'purchaseController.js');
  const page = read('sisha-frontend', 'src', 'pages', 'OrdensCompras.jsx');
  assert.match(routes, /pds\/reconcile-existing-lifecycle.*requireRole\(\['admin'\]\)/);
  assert.match(controller, /RECONCILIAR PDS EXISTENTES/);
  assert.match(controller, /reconcileExistingPdLifecycle/);
  assert.match(page, /RECONCILIAR PDs EXISTENTES/);
});
