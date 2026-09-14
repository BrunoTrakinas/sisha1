const test = require('node:test');
const assert = require('node:assert/strict');
const {
  parsePanPublicationText,
  parsePanMaterialRows,
} = require('../src/services/technicalPublicationPanService');

const representativePanText = `
PRODUCT ADVISORY NOTICE
Ref: LX/PAN/229 Issue: 3 Date: 24th July 2024
Lynx Fuel Booster Pumps
Pt No. 203666 / 203837
ADVISORY NOTICE
A 350 hr interim servicing periodicity is recommended.
SOLUTION
The current vendor TBO of 4000 flight hours is retained.
As an assembled Booster Pump servicing kit Pt No. PAN2229KIT or as individual components:
20 22296AG030010CG SCREW, CF M3X10 3
30 E27611E030EBUL WASHER 1
50 22296AG040010CG SCREW, CF M4X10 3
60 E27611E040EBUL WASHER 3
70 SR131-21B6 O-RING (AJ63-13) 1
90 B8Q1QC030007ACG SCREW,F90 M3X7 3
140 203798 MOTOR, ASSY, WITH 1
CABLE
LENGTH 1,2 M
150 SR127-21B6 O-RING (H152067) 1
160 G131121 SCREW ORDER 3
OVERLGTH MPN
E27113B25M007EBUL
170 E27611B050EBUL WASHER 3
180 5TA10CC NUT,SELF-LOCKING H 1
190 SR129-21B6 O-RING (AJ63-86) 1
210 22296AG030006CG SCREW, CF M3X6 2
280 206596 RING, FRICTION 1
290 203393 WASHER,SPRING 2
300 203336 WASHER 2
360 R10-21B6 O-RING(AJ63-56) 1
440 R12-21B6 O-RING (AJ63-87) 1
* (SAFRAN AEROTECHNICS COMPONENT MAINTENANCE MANUAL - 203666 203837 WTP113E-014)
APPLICABILITY
Mk's 140, 130, 120, 110, 100, 64, 88A, 21B, 95A, and 99A/U.
CUSTOMER ACTION
Implement interim servicing at 350 hrs is an option
ADDITIONAL INFORMATION
WTP113E-014 must be complied with while carrying out servicing.
`;

test('PAN é reconhecido como publicação técnica e preserva identidade documental', () => {
  const parsed = parsePanPublicationText(representativePanText, 'LX PAN 229.pdf');
  assert.ok(parsed);
  assert.equal(parsed.documentType, 'PAN');
  assert.equal(parsed.sbNumero, 'LX/PAN/229');
  assert.equal(parsed.tipoSb, 'OPCIONAL');
  assert.equal(parsed.dataPublicacao, '2024-07-24');
  assert.match(parsed.titulo, /Lynx Fuel Booster Pumps/i);
  assert.deepEqual(parsed.metadata.affectedPns, ['203666', '203837']);
  assert.equal(parsed.metadata.periodicityHours, 350);
  assert.equal(parsed.metadata.tboHours, 4000);
  assert.equal(parsed.metadata.manual, 'WTP113E-014');
});

test('PAN extrai os 18 materiais da tabela sem transformar o kit alternativo em demanda adicional', () => {
  const rows = parsePanMaterialRows(representativePanText);
  assert.equal(rows.length, 18);
  assert.deepEqual(rows[0], {
    itemNo: '20',
    pn: '22296AG030010CG',
    qtd: 3,
    nomenclatura: 'SCREW, CF M3X10',
  });
  assert.equal(rows.find((row) => row.pn === '203798')?.qtd, 1);
  assert.equal(rows.find((row) => row.pn === '206596')?.qtd, 1);
  assert.equal(rows.some((row) => row.pn === 'PAN2229KIT'), false);
});

test('itens PAN são vinculados à referência, CMM e aplicabilidade', () => {
  const parsed = parsePanPublicationText(representativePanText, 'LX PAN 229.pdf');
  assert.equal(parsed.itensSb.length, 20);
  assert.equal(parsed.itensSb.filter((item) => item.item_num === 'APLICABILIDADE').length, 2);
  assert.equal(parsed.itensSb.filter((item) => item.item_num !== 'APLICABILIDADE').length, 18);
  assert.ok(parsed.itensSb.every((item) => item.sb_numero === 'LX/PAN/229'));
  assert.ok(parsed.itensSb.every((item) => item.capitulo === 'WTP113E-014'));
  assert.match(parsed.itensSb[0].aplicabilidade, /140/);
  assert.equal(parsed.itensSb.find((item) => item.pn === '22296AG030006CG')?.qtd, 2);
});
