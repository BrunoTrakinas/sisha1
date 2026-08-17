const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const commercial = require('../../src/services/commercialDocumentDeterministicService');

const QUOTATION = `
Leonardo UK Ltd
Quotation
Number/Date
20570270 / 27.04.2026
Reference no./Date
Q2026 - HA-006 / 27.04.2026
Contract Reference.
71000/2024-014/00
Validity period
27.04.2026 to 28.02.2027
Currency £ Pounds sterling
We deliver according to the following conditions:
Terms of payment Within 30 days without deduction
Terms of delivery DAP Brazilian Navy Bonded Store
Item Material Description
Reference Lead Time
Qty Price Value
1 203728 DIFFUSER, ASSY
Under Investigation
2.000 N 1,901.69 3,803.38
2 203698 IMPELLER
2915-14-377-8502 54
Available Stock Quantity 2.00
2.000 N 1,132.55 2,265.10
3 203840 BODY, PUMP
8888-88-888-8888 52
Available Stock Quantity 2.00
2.000 N 4,952.10 9,904.20
4 SR127-21B6 O-RING
8888-88-888-8888 29
Available Stock Quantity 2.00
2.000 N 13.45 26.90
Items total 15,999.58
Packing & Delivery 3.500 % 15,999.58 559.99
Final amount 16,559.57
`;

const QUOTATION_CORRECTION = `
Leonardo UK Ltd
Quotation
Number/Date
20568441 / 07.04.2026
Reference no./Date
Q2026-HA-004 / 07.04.2026
Contract Reference.
71000/2024-014/00
Validity period
07.04.2026 to 28.02.2027
Terms of payment Within 30 days without deduction
Terms of delivery DAP Brazilian Navy Bonded Store
Item Material Description
Reference Lead Time
Qty Price Value
1 JMP/PRA/4933/4 VALVE, PRESSURE RELIEF
8888-88-888-8888
Awaiting Price
1.000 N TBA TBA
Your original request was P/N JMP/PR/A/4933/4. Please order the correct format P/N JMP/PRA/4933/4.
Items total 0.00
Packing & Delivery 3.500 % 0.00 0.00
Final amount 0.00
`;

const PRICE_LETTER = `
Leonardo UK Ltd
LHUK Ref.: LHUK/BN/BONDEDSTORE/08052026
Date: 8th May 2026
Reference: (a) Contract No. 71000/2024-014/00 ("the Contract")
WORLDWIDE PRICE LIST (WWPL)
formal notification of a 'one-time' only price for the purchase of quantity one (1) multi-functional valve.
A Purchase Order (PO) for quantity one (1) multi-function valve assembly, reference Part Number LH11264-02, (Nato Stock reference, 4810-01-534-3485) is to be received by the Company no later than 1st June 2026; and
A five percent (5%) reduction from the recently issued BN 2026 Price List will be applied to Part No. LH11264-02, thus reducing the price from £88,997.42 to a price of £84,547.55, for this purchase order only.
`;

const REPAIR_LETTER = `
Leonardo UK Ltd
Subject: Future Support and Fixed Price Repairs – Lynx M21B.
Contract No. 71000/2020-022/00
Date: 24th May 2024
Attachment 1 – Fixed Price Repair / Overhaul Listing – validity, 31st March 2025.
Component Description | Part Number | Fixed Price Repair (GBP) | Fixed Price Overhaul (GBP)
Main Servo Jack | 30495-211 | 73,978.00 | 147,242.00
Fuel Booster Pump | 2030H08 | 37,207.00 | 41,065.00
Multi-Function Valve | LH11264-02 | 44,034.00 |
Gearbox Change Unit | WG1468-0002-*** | 562,598.00 | 1,037,984.00
`;

test('C2: classificador reconhece Quotation Leonardo sem depender do nome do arquivo', () => {
  assert.equal(commercial.classifyCommercialDocument(QUOTATION, 'arquivo.pdf'), 'LEONARDO_QUOTATION');
});

test('C2: Quotation preserva PN puramente numérico e não desloca preço para PN', () => {
  const parsed = commercial.parseLeonardoQuotation(QUOTATION, '20570270.pdf');
  assert.equal(parsed.items.length, 4);
  assert.equal(parsed.items[0].pn, '203728');
  assert.equal(parsed.items[0].valor_unitario, 1901.69);
  assert.equal(parsed.items[1].pn, '203698');
});

test('C2: Under Investigation e preço coexistem como dimensões diferentes', () => {
  const parsed = commercial.parseLeonardoQuotation(QUOTATION);
  assert.equal(parsed.items[0].price_status, 'UNDER_INVESTIGATION');
  assert.equal(parsed.items[0].valor_unitario, 1901.69);
});

test('C2: referência 8888-88-888-8888 é preservada como placeholder e nunca vira NSN confiável', () => {
  const parsed = commercial.parseLeonardoQuotation(QUOTATION);
  const row = parsed.items.find((item) => item.pn === '203840');
  assert.equal(row.material_reference, '8888-88-888-8888');
  assert.equal(row.material_reference_status, 'PLACEHOLDER');
  assert.equal(row.nsn, '');
});

test('C2: Quotation extrai contrato, validade, condições e fecha os totais', () => {
  const parsed = commercial.parseLeonardoQuotation(QUOTATION);
  assert.equal(parsed.metadados.quotation_number, '20570270');
  assert.equal(parsed.metadados.reference, 'Q2026 - HA-006');
  assert.equal(parsed.metadados.contract_reference, '71000/2024-014/00');
  assert.equal(parsed.metadados.validity, '27/04/2026 a 28/02/2027');
  assert.equal(parsed.metadados.items_total, 15999.58);
  assert.equal(parsed.metadados.packing_delivery_percent, 3.5);
  assert.equal(parsed.metadados.packing_delivery_value, 559.99);
  assert.equal(parsed.metadados.final_amount, 16559.57);
  assert.equal(parsed.metadados.quality_status, 'REVIEW');
  assert.ok(parsed.metadados.quality_warnings.length >= 1);
});

test('C2: Awaiting Price permanece sem preço e não fabrica valor', () => {
  const parsed = commercial.parseLeonardoQuotation(QUOTATION_CORRECTION);
  assert.equal(parsed.items[0].price_status, 'AWAITING_PRICE');
  assert.equal(parsed.items[0].valor_unitario, 0);
});

test('C2: correção documental de formato do PN não vira alternativo nem supersession', () => {
  const parsed = commercial.parseLeonardoQuotation(QUOTATION_CORRECTION);
  assert.equal(parsed.items[0].pn, 'JMP/PRA/4933/4');
  assert.equal(parsed.items[0].pn_original_solicitado, 'JMP/PR/A/4933/4');
  assert.equal(parsed.items[0].correcao_pn_tipo, 'FORMAT_CORRECTION');
});

test('C2: carta one-time extrai preço-base, desconto, preço especial, quantidade e prazo', () => {
  const parsed = commercial.parseLeonardoPriceLetter(PRICE_LETTER, 'LHUKBNBONDEDSTORE08052026.pdf');
  const item = parsed.items[0];
  assert.equal(parsed.metadados.documento_tipo, 'LEONARDO_PRICE_LETTER');
  assert.equal(item.pn, 'LH11264-02');
  assert.equal(item.nsn, '4810-01-534-3485');
  assert.equal(item.preco_base, 88997.42);
  assert.equal(item.valor_unitario, 84547.55);
  assert.equal(item.desconto_percentual, 5);
  assert.equal(item.one_time_only, true);
  assert.equal(item.limite_quantidade, 1);
  assert.equal(item.prazo_condicao, '01/06/2026');
});

test('C2: classificador diferencia carta one-time de Quotation', () => {
  assert.equal(commercial.classifyCommercialDocument(PRICE_LETTER, 'carta.pdf'), 'LEONARDO_PRICE_LETTER');
});

test('C2: carta Repair/Overhaul gera duas referências quando a linha possui os dois preços', () => {
  const parsed = commercial.parseLeonardoRepairPriceLetter(REPAIR_LETTER, 'LUKLBNUPGRADE24052024.pdf');
  const rows = parsed.items.filter((item) => item.pn === '2030H08');
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((r) => r.tipo_cotacao).sort(), ['OVERHAUL', 'REPARO']);
  assert.equal(rows.find((r) => r.tipo_cotacao === 'REPARO').valor_unitario, 37207);
  assert.equal(rows.find((r) => r.tipo_cotacao === 'OVERHAUL').valor_unitario, 41065);
});

test('C2: PN com wildcard em carta Repair/Overhaul fica PATTERN e não PN exato', () => {
  const parsed = commercial.parseLeonardoRepairPriceLetter(REPAIR_LETTER);
  const row = parsed.items.find((item) => item.pn === 'WG1468-0002-***');
  assert.equal(row.match_mode, 'PATTERN');
});

test('C2: migration enriquece rfq_cotacoes existente sem criar segunda tabela comercial', () => {
  const sql = fs.readFileSync(path.join(__dirname, '../../sql/migrations/20260815_C2_001_commercial_documents_leonardo.sql'), 'utf8');
  assert.match(sql, /alter\s+table\s+if\s+exists\s+public\.rfq_cotacoes/i);
  assert.match(sql, /documento_tipo/i);
  assert.match(sql, /one_time_only/i);
  assert.match(sql, /match_mode/i);
  assert.doesNotMatch(sql, /create\s+table/i);
});

test('C2: parser de PDF escaneado tenta PDF integral antes do fallback por JPEG', () => {
  const source = fs.readFileSync(path.join(__dirname, '../../src/services/rfqParserService.js'), 'utf8');
  const wholePdf = source.indexOf('extractTextFromPdfWithAi');
  const jpeg = source.indexOf('extractJpegImagesFromPdfBuffer');
  assert.ok(wholePdf >= 0);
  assert.ok(jpeg >= 0);
  assert.ok(wholePdf < jpeg, 'PDF integral deve ser tentado antes de extrair JPEGs');
});

test('C2: gravação aceita tipo por item e preserva evidência comercial avançada', () => {
  const source = fs.readFileSync(path.join(__dirname, '../../src/controllers/importController.js'), 'utf8');
  assert.match(source, /item\.tipo_cotacao\s*\|\|\s*tipoCotacao/);
  assert.match(source, /documento_tipo/);
  assert.match(source, /preco_base/);
  assert.match(source, /pn_original_solicitado/);
  assert.match(source, /source_excerpt/);
  assert.match(source, /row\.one_time_only\s*!==\s*true/);
});

test('C2: motor de preço automático não usa PATTERN nem preço one-time como referência material genérica', () => {
  const source = fs.readFileSync(path.join(__dirname, '../../src/services/pricingService.js'), 'utf8');
  assert.match(source, /match_mode/);
  assert.match(source, /one_time_only/);
  assert.match(source, /PATTERN/);
});

test('C2: frontend mantém a mesma entrada Cotações/RFQ e adiciona revisão editável dos campos Leonardo', () => {
  const root = path.join(__dirname, '../../..');
  const source = fs.readFileSync(path.join(root, 'sisha-frontend/src/components/RfqImporter.jsx'), 'utf8');
  assert.match(source, /Cotações, Cartas e RFQ/);
  assert.match(source, /documento_tipo/);
  assert.match(source, /one_time_only/);
  assert.match(source, /match_mode/);
  assert.match(source, /pn_original_solicitado/);
  assert.match(source, /source_excerpt/);
});
