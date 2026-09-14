const fs = require('fs');

const FREESECT = 0xFFFFFFFF;
const ENDOFCHAIN = 0xFFFFFFFE;
const DIFSECT = 0xFFFFFFFC;
const FATSECT = 0xFFFFFFFD;

function inputError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function sectorSlice(file, sectorSize, sid) {
  const start = (Number(sid) + 1) * sectorSize;
  if (!Number.isInteger(sid) || sid < 0 || start >= file.length) {
    throw inputError('CEIMSPA_SEM_DEMANDA_XLS_SECTOR_INVALID', `Setor XLS inválido: ${sid}.`);
  }
  return file.subarray(start, Math.min(start + sectorSize, file.length));
}

function chainFromFat(startSid, fat, max = 1000000) {
  const out = [];
  const seen = new Set();
  let sid = startSid >>> 0;
  while (sid !== ENDOFCHAIN && sid !== FREESECT) {
    if (sid >= fat.length || sid === FATSECT || sid === DIFSECT || seen.has(sid) || out.length >= max) {
      throw inputError('CEIMSPA_SEM_DEMANDA_XLS_CHAIN_INVALID', 'Cadeia de setores inválida no XLS legado.');
    }
    seen.add(sid);
    out.push(sid);
    sid = fat[sid] >>> 0;
  }
  return out;
}

function parseOleWorkbook(file) {
  const signature = Buffer.from([0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1]);
  if (file.length < 512 || !file.subarray(0, 8).equals(signature)) {
    throw inputError('CEIMSPA_SEM_DEMANDA_XLS_NOT_OLE', 'O arquivo .xls não é um Excel 97-2003 OLE válido.');
  }

  const sectorSize = 1 << file.readUInt16LE(30);
  const numFatSectors = file.readUInt32LE(44);
  const firstDirSector = file.readUInt32LE(48);
  const miniStreamCutoff = file.readUInt32LE(56);
  const firstDifatSector = file.readUInt32LE(68);
  const numDifatSectors = file.readUInt32LE(72);
  if (sectorSize !== 512 && sectorSize !== 4096) {
    throw inputError('CEIMSPA_SEM_DEMANDA_XLS_SECTOR_SIZE', `Tamanho de setor OLE não suportado: ${sectorSize}.`);
  }

  const difat = [];
  for (let i = 0; i < 109; i += 1) {
    const sid = file.readUInt32LE(76 + (i * 4));
    if (sid !== FREESECT) difat.push(sid);
  }
  let difatSid = firstDifatSector >>> 0;
  for (let n = 0; n < numDifatSectors && difatSid !== ENDOFCHAIN; n += 1) {
    const sector = sectorSlice(file, sectorSize, difatSid);
    if (sector.length < sectorSize) throw inputError('CEIMSPA_SEM_DEMANDA_XLS_DIFAT_TRUNCATED', 'DIFAT truncada no XLS legado.');
    const entries = (sectorSize / 4) - 1;
    for (let i = 0; i < entries; i += 1) {
      const sid = sector.readUInt32LE(i * 4);
      if (sid !== FREESECT) difat.push(sid);
    }
    difatSid = sector.readUInt32LE(sectorSize - 4) >>> 0;
  }

  const fatSectorIds = difat.filter((sid) => sid !== FREESECT && sid !== ENDOFCHAIN).slice(0, numFatSectors);
  if (fatSectorIds.length !== numFatSectors) {
    throw inputError('CEIMSPA_SEM_DEMANDA_XLS_FAT_MISSING', 'Tabela FAT incompleta no XLS legado.');
  }
  const fat = [];
  for (const sid of fatSectorIds) {
    const sector = sectorSlice(file, sectorSize, sid);
    if (sector.length < sectorSize) throw inputError('CEIMSPA_SEM_DEMANDA_XLS_FAT_TRUNCATED', 'Setor FAT truncado no XLS legado.');
    for (let off = 0; off < sector.length; off += 4) fat.push(sector.readUInt32LE(off) >>> 0);
  }

  const dirChain = chainFromFat(firstDirSector, fat);
  const dirBuffer = Buffer.concat(dirChain.map((sid) => sectorSlice(file, sectorSize, sid)));
  let workbookEntry = null;
  for (let off = 0; off + 128 <= dirBuffer.length; off += 128) {
    const entry = dirBuffer.subarray(off, off + 128);
    const nameBytes = entry.readUInt16LE(64);
    if (nameBytes < 2) continue;
    const name = entry.subarray(0, Math.min(nameBytes - 2, 64)).toString('utf16le');
    if (entry[66] === 2 && (name === 'Workbook' || name === 'Book')) {
      const sizeLow = entry.readUInt32LE(120);
      const sizeHigh = entry.readUInt32LE(124);
      workbookEntry = {
        startSid: entry.readUInt32LE(116) >>> 0,
        size: sizeLow + (sizeHigh * 0x100000000),
      };
      break;
    }
  }
  if (!workbookEntry) throw inputError('CEIMSPA_SEM_DEMANDA_XLS_WORKBOOK_MISSING', 'Stream Workbook não encontrado no XLS legado.');
  if (workbookEntry.size < miniStreamCutoff) {
    throw inputError('CEIMSPA_SEM_DEMANDA_XLS_MINISTREAM_UNSUPPORTED', 'Workbook XLS em mini-stream não suportado para Sem Demanda.');
  }
  const wbChain = chainFromFat(workbookEntry.startSid, fat);
  return Buffer.concat(wbChain.map((sid) => sectorSlice(file, sectorSize, sid))).subarray(0, workbookEntry.size);
}

class SegmentReader {
  constructor(segments) {
    this.segments = segments;
    this.segmentIndex = 0;
    this.offset = 0;
  }
  _advanceEmpty() {
    while (this.segmentIndex < this.segments.length && this.offset >= this.segments[this.segmentIndex].length) {
      this.segmentIndex += 1;
      this.offset = 0;
    }
  }
  atBoundary() {
    return this.segmentIndex < this.segments.length && this.offset >= this.segments[this.segmentIndex].length;
  }
  advanceBoundary() {
    if (this.atBoundary()) {
      this.segmentIndex += 1;
      this.offset = 0;
    }
  }
  read(n) {
    const chunks = [];
    let remaining = n;
    while (remaining > 0) {
      this._advanceEmpty();
      if (this.segmentIndex >= this.segments.length) throw inputError('CEIMSPA_SEM_DEMANDA_XLS_SST_EOF', 'SST truncada no XLS legado.');
      const seg = this.segments[this.segmentIndex];
      const take = Math.min(remaining, seg.length - this.offset);
      chunks.push(seg.subarray(this.offset, this.offset + take));
      this.offset += take;
      remaining -= take;
    }
    return chunks.length === 1 ? chunks[0] : Buffer.concat(chunks);
  }
  u8() { return this.read(1)[0]; }
  u16() { return this.read(2).readUInt16LE(0); }
  u32() { return this.read(4).readUInt32LE(0); }
}

function scanGlobals(workbook) {
  let pos = 0;
  let sheetOffset = -1;
  let sstSegments = null;
  let collectingSst = false;
  while (pos + 4 <= workbook.length) {
    const id = workbook.readUInt16LE(pos);
    const length = workbook.readUInt16LE(pos + 2);
    const start = pos + 4;
    const end = start + length;
    if (end > workbook.length) throw inputError('CEIMSPA_SEM_DEMANDA_XLS_BIFF_TRUNCATED', 'Registro BIFF truncado no XLS legado.');

    if (id === 0x0085 && sheetOffset < 0 && length >= 4) sheetOffset = workbook.readUInt32LE(start);
    if (id === 0x00FC) {
      sstSegments = [workbook.subarray(start, end)];
      collectingSst = true;
    } else if (id === 0x003C && collectingSst) {
      sstSegments.push(workbook.subarray(start, end));
    } else if (collectingSst) {
      collectingSst = false;
    }

    pos = end;
    if (sheetOffset >= 0 && pos >= sheetOffset) break;
  }
  if (sheetOffset < 0) throw inputError('CEIMSPA_SEM_DEMANDA_XLS_SHEET_MISSING', 'Primeira planilha não encontrada no XLS legado.');
  return { sheetOffset, sstSegments: sstSegments || [] };
}

function parseSst(segments) {
  if (!segments.length) return [];
  const reader = new SegmentReader(segments);
  reader.u32();
  const unique = reader.u32();
  if (unique > 1000000) throw inputError('CEIMSPA_SEM_DEMANDA_XLS_SST_TOO_LARGE', 'SST XLS acima do limite de segurança.');
  const strings = new Array(unique);
  for (let i = 0; i < unique; i += 1) {
    const charCount = reader.u16();
    const flags = reader.u8();
    let highByte = (flags & 0x01) !== 0;
    const richRuns = (flags & 0x08) !== 0 ? reader.u16() : 0;
    const extBytes = (flags & 0x04) !== 0 ? reader.u32() : 0;
    const pieces = [];
    let remainingChars = charCount;
    while (remainingChars > 0) {
      if (reader.atBoundary()) {
        reader.advanceBoundary();
        highByte = (reader.u8() & 0x01) !== 0;
      }
      if (reader.segmentIndex >= reader.segments.length) throw inputError('CEIMSPA_SEM_DEMANDA_XLS_SST_EOF', 'String SST truncada.');
      const seg = reader.segments[reader.segmentIndex];
      const bytesPerChar = highByte ? 2 : 1;
      const availableChars = Math.floor((seg.length - reader.offset) / bytesPerChar);
      if (availableChars <= 0) {
        reader.offset = seg.length;
        continue;
      }
      const takeChars = Math.min(remainingChars, availableChars);
      pieces.push(reader.read(takeChars * bytesPerChar).toString(highByte ? 'utf16le' : 'latin1'));
      remainingChars -= takeChars;
    }
    if (richRuns) reader.read(richRuns * 4);
    if (extBytes) reader.read(extBytes);
    strings[i] = pieces.join('');
  }
  return strings;
}

function decodeRk(rkUnsigned) {
  const divide100 = (rkUnsigned & 0x01) !== 0;
  const integer = (rkUnsigned & 0x02) !== 0;
  let value;
  if (integer) {
    value = (rkUnsigned | 0) >> 2;
  } else {
    const buffer = Buffer.allocUnsafe(8);
    buffer.writeUInt32LE(0, 0);
    buffer.writeUInt32LE(rkUnsigned & 0xFFFFFFFC, 4);
    value = buffer.readDoubleLE(0);
  }
  return divide100 ? value / 100 : value;
}

function parseLegacyXlsRows(filePath, onRow) {
  const file = fs.readFileSync(filePath);
  const workbook = parseOleWorkbook(file);
  const { sheetOffset, sstSegments } = scanGlobals(workbook);
  const sst = parseSst(sstSegments);
  let currentRow = null;
  let currentCells = [];
  let rowsSeen = 0;

  const flush = () => {
    if (currentRow === null) return;
    onRow(currentRow, currentCells);
    rowsSeen += 1;
    currentCells = [];
  };
  const put = (row, col, value) => {
    if (currentRow === null) currentRow = row;
    if (row !== currentRow) {
      flush();
      currentRow = row;
    }
    if (col <= 64) currentCells[col] = value;
  };

  let pos = sheetOffset;
  while (pos + 4 <= workbook.length) {
    const id = workbook.readUInt16LE(pos);
    const length = workbook.readUInt16LE(pos + 2);
    const start = pos + 4;
    const end = start + length;
    if (end > workbook.length) throw inputError('CEIMSPA_SEM_DEMANDA_XLS_BIFF_TRUNCATED', 'Planilha BIFF truncada.');

    if (id === 0x00FD && length >= 10) {
      put(workbook.readUInt16LE(start), workbook.readUInt16LE(start + 2), sst[workbook.readUInt32LE(start + 6)] ?? '');
    } else if (id === 0x0203 && length >= 14) {
      put(workbook.readUInt16LE(start), workbook.readUInt16LE(start + 2), workbook.readDoubleLE(start + 6));
    } else if (id === 0x027E && length >= 10) {
      put(workbook.readUInt16LE(start), workbook.readUInt16LE(start + 2), decodeRk(workbook.readUInt32LE(start + 6)));
    } else if (id === 0x00BD && length >= 12) {
      const row = workbook.readUInt16LE(start);
      const firstCol = workbook.readUInt16LE(start + 2);
      const lastCol = workbook.readUInt16LE(end - 2);
      let off = start + 4;
      for (let col = firstCol; col <= lastCol && off + 6 <= end - 2; col += 1, off += 6) {
        put(row, col, decodeRk(workbook.readUInt32LE(off + 2)));
      }
    }
    pos = end;
    if (id === 0x000A) break;
  }
  flush();
  return { rowsSeen, sstSize: sst.length };
}

module.exports = { parseLegacyXlsRows, decodeRk };
