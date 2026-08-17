const test = require('node:test');
const assert = require('node:assert/strict');
const { parsePpuInventoryRows } = require('../../src/services/ppuInventoryParserService');
const {
  normalizeDestination,
  normalizeSituation,
  enrichRows,
} = require('../../src/services/ppuLocationPolicy');

test('PPU bruto Marinha: separa Equipamentos e Sobressalentes e herda LOCALIZAÇÃO', () => {
  const rows = [
    ['EQUIPAMENTOS'],
    ['NOMENCLATURA', 'PN', '', '', '', '', '', 'SN', 'PI', '', '', 'QNTD'],
    ['LOCALIZAÇÃO : BANCADA HV'],
    ['HARPOON', 'WG1344-7001-053', '', '', '', '', '', '511-012', '991604009', '', '', 1],
    ['SOBRESSALENTES'],
    ['NOMENCLATURA', '', 'PN', '', '', '', 'Lote', '', '', 'PI', 'DOTAÇÃO', '', 'QNTD'],
    ['LOCALIZAÇÃO : ALFA - 1'],
    ['GASKET', '', 'WG1382-6847-103', '', '', '', '---', '', '', '997211289', 0, '', 23],
  ];

  const result = parsePpuInventoryRows(rows);
  assert.equal(result.format, 'MARINHA_PPU_GERAL_POR_LOCALIZACAO');
  assert.equal(result.items.length, 2);
  assert.equal(result.items[0].pn, 'WG1344-7001-053');
  assert.equal(result.items[0].sn, '511-012');
  assert.equal(result.items[0].quantidade, 1);
  assert.equal(result.items[0].localizacao, 'BANCADA HV');
  assert.equal(result.items[0].source_section, 'EQUIPAMENTOS');
  assert.equal(result.items[1].pn, 'WG1382-6847-103');
  assert.equal(result.items[1].sn, null);
  assert.equal(result.items[1].quantidade, 23);
  assert.equal(result.items[1].localizacao, 'ALFA - 1');
  assert.equal(result.items[1].source_section, 'SOBRESSALENTES');
});

test('PPU bruto Marinha: usa QNTD e não confunde DOTAÇÃO com estoque', () => {
  const rows = [
    ['EQUIPAMENTOS'], ['SOBRESSALENTES'],
    ['NOMENCLATURA', '', 'PN', '', '', '', 'Lote', '', '', 'PI', 'DOTAÇÃO', '', 'QNTD'],
    ['LOCALIZAÇÃO : DELTA-1'],
    ['PEÇA', '', 'PN-001', '', '', '', '', '', '', '123', 2, '', 19],
  ];
  const result = parsePpuInventoryRows(rows);
  assert.equal(result.items[0].quantidade, 19);
});

test('PPU bruto Marinha: não transforma marcador EXCLUIR/DUPLICADO em estoque', () => {
  const rows = [
    ['EQUIPAMENTOS'],
    ['NOMENCLATURA', 'PN', '', '', '', '', '', 'SN', 'PI', '', '', 'QNTD'],
    ['LOCALIZAÇÃO : BANCADA HV'],
    ['PN DUPLICADO NAO UTILIZAR', 'EXCLUIRWG0001', '', '', '', '', '', 'EXCLUIR01', 'XXX', '', '', 1],
  ];
  const result = parsePpuInventoryRows(rows);
  assert.equal(result.items.length, 0);
  assert.equal(result.issues.length > 0, true);
});

test('Política LOC: localização excluída não volta ao PPU por ausência de destino', () => {
  assert.equal(normalizeDestination(null, false), 'FORA_LINHA');
  assert.equal(normalizeSituation(null, false), 'A_CONFIRMAR');
  assert.equal(normalizeDestination('CEIMSPA', false), 'CEIMSPA');
});

test('Política LOC: local novo permanece PPU por compatibilidade e local configurado é enriquecido', () => {
  const map = new Map([
    ['RD-01', { contabiliza_ppu: false, destino_contabilizacao: 'CEIMSPA', situacao_operacional: 'ARMAZENADO_EXTERNAMENTE', observacao: 'Sem espaço no PPU' }],
  ]);
  const rows = enrichRows([
    { id: 1, pn: 'PN1', quantidade: 1, localizacao: 'RD-01' },
    { id: 2, pn: 'PN2', quantidade: 1, localizacao: 'ALFA-1' },
  ], map);
  assert.equal(rows[0].contabiliza_ppu, false);
  assert.equal(rows[0].destino_contabilizacao, 'CEIMSPA');
  assert.equal(rows[1].contabiliza_ppu, true);
  assert.equal(rows[1].destino_contabilizacao, 'PPU');
});


test('PPU bruto Marinha: QNTD > 1 em Equipamento preserva quantidade sem fabricar outro SN e gera alerta', () => {
  const rows = [
    ['EQUIPAMENTOS'],
    ['NOMENCLATURA', 'PN', '', '', '', '', '', 'SN', 'PI', '', '', 'QNTD'],
    ['LOCALIZAÇÃO : CAIXA DE MISSÃO VN #1'],
    ['ACTUATOR', 'PN-ACT', '', '', '', '', '', 'SN-001', 'PI-1', '', '', 2],
    ['SOBRESSALENTES'],
  ];
  const result = parsePpuInventoryRows(rows);
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].quantidade, 2);
  assert.equal(result.items[0].sn, 'SN-001');
  assert.equal(result.issues.some((issue) => issue.field === 'quantidade'), true);
});


test('PPU bruto Marinha: PN+SN em duas LOCs não duplica unidade e vira conflito para revisão', () => {
  const rows = [
    ['EQUIPAMENTOS'],
    ['NOMENCLATURA', 'PN', '', '', '', '', '', 'SN', 'PI', '', '', 'QNTD'],
    ['LOCALIZAÇÃO : ALFA - 1'],
    ['CONTROL', 'PN-001', '', '', '', '', '', 'SN-777', 'PI-1', '', '', 1],
    ['LOCALIZAÇÃO : VICTOR - 4'],
    ['CONTROL', 'PN-001', '', '', '', '', '', 'SN-777', 'PI-1', '', '', 1],
    ['SOBRESSALENTES'],
  ];
  const result = parsePpuInventoryRows(rows);
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].quantidade, 1);
  assert.equal(result.items[0].sn, 'SN-777');
  assert.equal(result.items[0].localizacao, 'CONFLITO DE LOCALIZAÇÃO');
  assert.equal(result.issues.some((issue) => String(issue.reason).includes('localizações conflitantes')), true);
});

test('Radar: rastreio excluído é separado do PPU e pode ser redirecionado ao card CEIMSPA', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const source = fs.readFileSync(path.resolve(__dirname, '../../src/controllers/searchController.js'), 'utf8');
  assert.equal(source.includes('loadTrackingRowsByPns'), true);
  assert.equal(source.includes("origem_saldo: 'PPU_LOCAL_RECLASSIFICADO_CEIMSPA'"), true);
  assert.equal(source.includes('item.itens_fora_linha = myPpuExcluded.map'), true);
  assert.equal(source.includes('item.itens_fora_linha_qtd'), true);
});

test('Pesquisa em lote/Gerador: continuam usando disponibilidade filtrada e não somam rastreio PPU excluído', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const needsSource = fs.readFileSync(path.resolve(__dirname, '../../src/controllers/needsController.js'), 'utf8');
  const effectiveSource = fs.readFileSync(path.resolve(__dirname, '../../src/services/ppuEffectiveAvailabilityService.js'), 'utf8');

  // HF PPU 002 centralizou a disponibilidade efetiva em um único serviço.
  // O contrato antigo permanece: a origem oficial continua sendo a view filtrada,
  // e o Gerador/Pesquisa em lote nunca consomem o rastreio PPU excluído.
  assert.equal(needsSource.includes('ppuEffectiveAvailabilityService'), true);
  assert.equal(needsSource.includes('loadAllEffectivePpuRows'), true);
  assert.equal(effectiveSource.includes("from('v_sisha_ppu_disponibilidade')"), true);
  assert.equal(needsSource.includes('loadTrackingRowsByPns'), false);
  assert.equal(needsSource.includes('PPU_LOCAL_RECLASSIFICADO_CEIMSPA'), false);
  assert.equal(effectiveSource.includes('loadTrackingRowsByPns'), false);
  assert.equal(effectiveSource.includes('PPU_LOCAL_RECLASSIFICADO_CEIMSPA'), false);
});

test('Frontend: Radar mantém cards e adiciona somente botão/modal de itens fora da linha', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const source = fs.readFileSync(path.resolve(__dirname, '../../../sisha-frontend/src/pages/ConsultaItens.jsx'), 'utf8');
  assert.equal(source.includes('ITENS FORA DA LINHA DE VOO'), true);
  assert.equal(source.includes('Itens fora da linha de voo'), true);
  assert.equal(source.includes("c.origem_saldo === 'PPU_LOCAL_RECLASSIFICADO_CEIMSPA'"), true);
  // O Radar exibe localização/origem documental; reconciliação PN+SN não é uma localização.
  assert.equal(source.includes('un com SN identificado'), false);
  assert.equal(source.includes('aguardando incorporação ao inventário oficial'), true);
  assert.equal(source.includes('simplifyReceiptLocation'), true);
});

test('Frontend: LOC excluída exige destino e situação sem inferência pelo nome', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const source = fs.readFileSync(path.resolve(__dirname, '../../../sisha-frontend/src/pages/Cadastro.jsx'), 'utf8');
  assert.equal(source.includes('<option value="FORA_LINHA">Fora da linha de voo</option>'), true);
  assert.equal(source.includes('<option value="CEIMSPA">CEIMSPA</option>'), true);
  assert.equal(source.includes('<option value="A_CONFIRMAR">A confirmar</option>'), true);
});
