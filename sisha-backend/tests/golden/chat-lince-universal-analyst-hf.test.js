const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createXlsxBuffer, createPdfBuffer } = require('../../src/services/chatLinceReportService');
const { isSerialsByPnQuestion } = require('../../src/services/chatLinceUniversalAnalystService');

const projectRoot = path.resolve(__dirname, '..', '..', '..');
const routes = fs.readFileSync(path.join(projectRoot, 'sisha-backend', 'src', 'routes', 'chatLinceRoutes.js'), 'utf8');
const controller = fs.readFileSync(path.join(projectRoot, 'sisha-backend', 'src', 'controllers', 'chatLinceController.js'), 'utf8');
const frontend = fs.readFileSync(path.join(projectRoot, 'sisha-frontend', 'src', 'pages', 'ChatLince.jsx'), 'utf8');

const sample = {
  title: 'SN cadastrados - PN 123',
  question: 'Quais SN temos do PN 123?',
  summary: '2 equipamentos encontrados.',
  columns: ['PN', 'SN', 'Local'],
  rows: [
    { PN: '123', SN: 'A1', Local: 'PPU' },
    { PN: '123', SN: 'A2', Local: 'RECEX' },
  ],
  sources: [{ tabela: 'equipamentos_serializados', motivo: 'Livro de Equipamentos', linhas: 2 }],
};

test('HF Chat Lince: reconhece consulta natural de SN por PN', () => {
  assert.equal(isSerialsByPnQuestion('Quais SN temos do PN 123?'), true);
  assert.equal(isSerialsByPnQuestion('Liste os seriais do P/N ABC-123'), true);
});

test('HF Chat Lince: relatório Excel usa workbook com Resumo, Resultado e Fontes', () => {
  const source = fs.readFileSync(path.join(projectRoot, 'sisha-backend', 'src', 'services', 'chatLinceReportService.js'), 'utf8');
  assert.match(source, /book_append_sheet\(workbook, summarySheet, 'Resumo'\)/);
  assert.match(source, /book_append_sheet\(workbook, resultSheet, 'Resultado'\)/);
  assert.match(source, /book_append_sheet\(workbook, sourceSheet, 'Fontes'\)/);
  assert.match(source, /bookType: 'xlsx'/);
});

test('HF Chat Lince: relatório PDF é PDF válido e contém estrutura mínima', () => {
  const buffer = createPdfBuffer(sample);
  assert.equal(buffer.subarray(0, 5).toString('latin1'), '%PDF-');
  assert.match(buffer.toString('latin1'), /\/Type \/Catalog/);
  assert.match(buffer.toString('latin1'), /xref/);
});

test('HF Chat Lince: exportação e auditoria são somente leitura e acessíveis após requireAuth global', () => {
  assert.match(routes, /router\.post\('\/analista\/exportar', guardChatLinceConsult/);
  assert.match(routes, /router\.post\('\/analista\/auditar', guardChatLinceDocumentAnalysis, upload\.single\('file'\)/);
  assert.doesNotMatch(routes, /analista\/auditar'\s*,\s*requireRole/);
  assert.match(controller, /CHAT_LINCE_AUDITORIA_COMPARATIVA/);
  assert.match(controller, /compareRecordsWithSisha/);
  assert.doesNotMatch(controller, /analista.*DELETE/i);
});

test('HF Chat Lince: frontend oferece Excel/PDF e auditoria comparativa sem liberar SQL', () => {
  assert.match(frontend, /Exportar última análise:/);
  assert.match(frontend, />\s*Auditoria comparativa\s*</i);
  assert.match(frontend, /SOMENTE LEITURA|sem alterar o banco/i);
  assert.match(frontend, /exportarUltimaConsulta\('xlsx'\)/);
  assert.match(frontend, /exportarUltimaConsulta\('pdf'\)/);
  assert.match(frontend, /exportarAuditoria\('xlsx'\)/);
  assert.match(frontend, /exportarAuditoria\('pdf'\)/);
});
