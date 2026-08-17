const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

const originalLoad = Module._load;
const fakeXlsx = {
  read(buffer) {
    return JSON.parse(buffer.toString('utf8'));
  },
  utils: {
    sheet_to_json(sheet) {
      return sheet;
    },
  },
  SSF: {
    parse_date_code() {
      return null;
    },
  },
};

Module._load = function mockedLoad(request, parent, isMain) {
  if (request === 'xlsx') return fakeXlsx;
  return originalLoad.call(this, request, parent, isMain);
};

const {
  parseEquipmentInventory,
  parseEquipmentMaster,
} = require('../../src/utils/equipmentInventoryParser');

Module._load = originalLoad;

function workbookBuffer(rowsBySheet) {
  const SheetNames = Object.keys(rowsBySheet);
  return Buffer.from(JSON.stringify({
    SheetNames,
    Sheets: rowsBySheet,
  }), 'utf8');
}

test('GOLDEN Equipamentos: inventario normaliza PN+SN e preserva localizacao/categoria/data', () => {
  const buffer = workbookBuffer({
    Inventario: [
      ['INVENTARIO SERIALIZADO'],
      ['Part Number', 'Serial Number', 'Localização', 'Categoria', 'Nomenclatura', 'Garantia'],
      [' 123 ABC 45 ', ' sn 001 ', 'ANV 4003', 'Aeronave', 'BOMBA DE TESTE', '13/08/2027'],
    ],
  });

  const parsed = parseEquipmentInventory(buffer, 'inventario.xlsx');
  assert.equal(parsed.total_linhas, 1);
  assert.equal(parsed.linhas_validas, 1);
  assert.equal(parsed.rows[0].pn, '123ABC45');
  assert.equal(parsed.rows[0].sn, 'SN001');
  assert.equal(parsed.rows[0].localizacao, 'ANV 4003');
  assert.equal(parsed.rows[0].categoria_destino, 'AERONAVE');
  assert.equal(parsed.rows[0].garantia_vencimento, '2027-08-13');
});

test('GOLDEN Equipamentos: inventario exige localizacao e nao descarta a linha invalida', () => {
  const buffer = workbookBuffer({
    Inventario: [
      ['PN', 'SN', 'LOCALIZAÇÃO'],
      ['PN-001', 'SN-001', ''],
      ['PN-002', 'SN-002', 'PPU A1'],
    ],
  });

  const parsed = parseEquipmentInventory(buffer, 'inventario.xlsx');
  assert.equal(parsed.total_linhas, 2);
  assert.equal(parsed.linhas_validas, 1);
  assert.equal(parsed.linhas_invalidas, 1);
  assert.equal(parsed.rows[0].valido, false);
  assert.ok(parsed.rows[0].problemas.includes('Localização ausente'));
});

test('GOLDEN Equipamentos: inventario rejeita PN+SN duplicado no mesmo arquivo', () => {
  const buffer = workbookBuffer({
    Inventario: [
      ['PN', 'SN', 'LOCAL'],
      ['PN-001', 'SN-001', 'PPU'],
      ['PN-001', 'SN-001', 'ANV 4003'],
    ],
  });

  const parsed = parseEquipmentInventory(buffer, 'inventario.xlsx');
  assert.equal(parsed.linhas_validas, 1);
  assert.equal(parsed.linhas_invalidas, 1);
  assert.match(parsed.rows[1].problemas.join(' | '), /PN \+ SN duplicado/i);
});

test('GOLDEN Equipamentos: Cadastro Mestre aceita PN+SN sem localizacao', () => {
  const buffer = workbookBuffer({
    Cadastro: [
      ['PN', 'S/N', 'Nomenclatura'],
      ['PN-MASTER-1', 'SER-001', 'EQUIPAMENTO SEM POSICAO'],
    ],
  });

  const parsed = parseEquipmentMaster(buffer, 'cadastro_mestre.xlsx');
  assert.equal(parsed.total_linhas, 1);
  assert.equal(parsed.linhas_validas, 1);
  assert.equal(parsed.rows[0].localizacao, '');
  assert.equal(parsed.rows[0].categoria_destino, 'DESCONHECIDO');
});

test('GOLDEN Equipamentos: Cadastro Mestre aceita extensao ODS e detecta duplicidade PN+SN', () => {
  const buffer = workbookBuffer({
    Cadastro: [
      ['PN', 'Serial Number', 'Localização'],
      ['PN-ODS-1', 'SER-ODS-1', 'PPU'],
      ['PN-ODS-1', 'SER-ODS-1', 'PPU'],
    ],
  });

  const parsed = parseEquipmentMaster(buffer, 'cadastro_mestre.ods');
  assert.equal(parsed.total_linhas, 2);
  assert.equal(parsed.linhas_validas, 1);
  assert.equal(parsed.linhas_invalidas, 1);
  assert.match(parsed.rows[1].problemas.join(' | '), /duplicado/i);
});
