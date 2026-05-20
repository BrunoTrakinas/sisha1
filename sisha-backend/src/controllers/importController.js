// src/controllers/importController.js
const xlsx = require('xlsx');
const supabase = require('../config/supabaseClient');
const pdfParse = require('pdf-parse'); // <-- Motor de PDF adicionado no topo
const { findHeaderRow, buildIndexMap, normalizePn } = require('../utils/importAliases');
const { setAuditSummary, recordAuditIssue } = require('../utils/importAudit');
const { registrarAuditoria } = require('../utils/auditLogger');

const cleanCurrency = (val) => val ? parseFloat(String(val).replace(/[^0-9.,]/g, '').replace(',', '.')) || 0 : 0;
const safeString = (val) => val ? String(val).trim() : null;

// TRADUTOR DE DATAS DO EXCEL
const formatExcelDate = (val) => {
    if (!val) return null;
    if (isNaN(val)) return String(val).trim(); 
    const dataExcel = new Date(Math.round((val - 25569) * 86400 * 1000));
    return dataExcel.toLocaleDateString('pt-BR', { timeZone: 'UTC' });
};


const formatDbDate = (value) => {
    if (value === null || value === undefined || value === '') return null;

    if (value instanceof Date && !Number.isNaN(value.getTime())) {
        return value.toISOString().slice(0, 10);
    }

    if (typeof value === 'number' && Number.isFinite(value)) {
        const dataExcel = new Date(Math.round((value - 25569) * 86400 * 1000));
        return dataExcel.toISOString().slice(0, 10);
    }

    const raw = String(value || '').trim();
    if (!raw) return null;

    const iso = raw.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/);
    if (iso) {
        const [, y, m, d] = iso;
        return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    }

    const br = raw.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{2}|\d{4})$/);
    if (br) {
        let [, d, m, y] = br;
        if (y.length === 2) y = Number(y) > 50 ? `19${y}` : `20${y}`;
        return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    }

    const parsed = new Date(raw);
    if (!Number.isNaN(parsed.getTime())) return parsed.toISOString().slice(0, 10);

    return null;
};


const uniqueBy = (rows = [], keyFn) => {
    const map = new Map();
    rows.forEach((row) => {
        const key = keyFn(row);
        if (!key || map.has(key)) return;
        map.set(key, row);
    });
    return Array.from(map.values());
};

const parseSbQuantityToken = (token) => {
    const text = String(token || '').trim().toUpperCase();
    if (!text || text === 'AR' || text.includes('AS REQUIRED')) return 0;
    const match = text.match(/\d+(?:\.\d+)?/);
    return match ? Number(match[0]) || 0 : 0;
};

const SB_DOC_CODE_PATTERNS = [
    /^LX\d{3}-\d{2}-\d{4}$/i,
    /^CTS800-4N-\d{2}-\d{2}-\d{4}$/i,
    /^WA\d{3,}$/i,
    /^(?:\d{2}-){3,}\d{2,}[A-Z0-9-]*$/i,
    /^[A-Z]{0,4}\d{0,4}\/\d{3}-\d{6}$/i,
];

const shouldIgnoreSbPn = (value) => {
    const pn = normalizePn(value);
    if (!pn || pn.length < 5) return true;
    if (!/\d/.test(pn)) return true;
    if (pn.includes('/')) return true;
    if (SB_DOC_CODE_PATTERNS.some((pattern) => pattern.test(pn))) return true;
    if (/^\d+$/.test(pn)) return true;
    if (/^(?:FIG|TABLE|PAGE|TASK|ITEM|NOTE)$/i.test(pn)) return true;
    return false;
};

const cleanSbPnToken = (value) => normalizePn(value).replace(/[-]$/, '').replace(/([A-Z0-9-]+-\d{2,3})[ABC]$/, '$1');

const splitSbLines = (text) => String(text || '')
    .replace(/\r/g, '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

const extractSbSummarySnippet = (text) => {
    const normalized = String(text || '').replace(/\r/g, '').replace(/\s+/g, ' ').trim();
    const patterns = [
        /2\.2\s*Problem and effect\s*([\s\S]{20,400}?)(?:2\.3\s*Solution|3\s*Description|4\s*Compliance|$)/ig,
        /2\.3\s*Solution\s*([\s\S]{20,400}?)(?:3\s*Description|4\s*Compliance|$)/ig,
        /D\.\s*Description\s*([\s\S]{20,320}?)(?:E\.|3\.|$)/ig,
        /Description\s*([\s\S]{20,320}?)(?:2\s*Compliance|3\s*Applicability|4\s*Related data|$)/ig,
    ];
    for (const pattern of patterns) {
        const matches = [...normalized.matchAll(pattern)];
        for (const match of matches.reverse()) {
            const snippet = String(match?.[1] || '').replace(/\s+/g, ' ').trim();
            if (snippet && !/\.{10,}/.test(snippet)) return snippet.slice(0, 500);
        }
    }
    return null;
};

const findLastPatternMatch = (text, pattern) => {
    const regex = new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`);
    let last = null;
    let match;
    while ((match = regex.exec(text)) !== null) {
        last = match;
        if (match.index === regex.lastIndex) regex.lastIndex += 1;
    }
    return last;
};

const extractSbSection = (flatText, startPattern, endPatterns = []) => {
    if (!flatText) return '';
    const startMatch = findLastPatternMatch(flatText, startPattern);
    if (!startMatch || startMatch.index == null) return '';
    const start = startMatch.index;
    let end = flatText.length;
    const tail = flatText.slice(start + startMatch[0].length);
    for (const pattern of endPatterns) {
        const candidate = tail.match(pattern);
        if (candidate?.index != null) end = Math.min(end, start + startMatch[0].length + candidate.index);
    }
    return flatText.slice(start, end);
};

const parseSbStructuredTableRows = (sectionText, role = 'NOVO') => {
    if (!sectionText) return [];
    const compact = String(sectionText || '').replace(/\r/g, '').replace(/\n+/g, '\n');
    const regex = /(\d{1,3})\s*([A-Z0-9][A-Z0-9-]{3,})\s*(?:[A-Z-]+\s*)?((?:AS\s+REQUIRED|AR|\d+(?:\.\d+)?(?:\s*EACH)?))\s*As\s*per\s*contract\s*([\s\S]*?)(?=(?:\n?\s*\d{1,3}\s*[A-Z0-9][A-Z0-9-]{3,})|Code Key|Table 3|3\s*Interchangeability|3Interchangeability|4\s*Parts disposition|4Parts disposition|$)/gi;
    const rows = [];
    let match;
    while ((match = regex.exec(compact)) !== null) {
        const itemNo = String(match[1] || '').trim();
        const pn = cleanSbPnToken(match[2]);
        if (shouldIgnoreSbPn(pn)) continue;
        rows.push({
            itemNo,
            pn,
            qtd: parseSbQuantityToken(match[3]),
            nomenclatura: String(match[4] || '').replace(/\s+/g, ' ').trim() || null,
            role,
        });
    }
    return rows;
};

const parseSbSparesRows = (sectionText) => {
    if (!sectionText) return [];
    const compact = String(sectionText || '').replace(/\r/g, '').replace(/\n+/g, '\n');
    const regex = /([A-Z0-9 ,().\/\-]{4,}?)\s+Pt\.\s*No\s*:\s*([A-Z0-9][A-Z0-9-]{3,})\s+(?:NSCM:[^\n]*\s+)?((?:AS\s+REQUIRED|AR|\d+(?:\.\d+)?))(?=\s+[A-Z][A-Z0-9 ,().\/\-]{3,}?\s+Pt\.\s*No\s*:|Safety conditions|Procedure|4\s*Final Operations|$)/gi;
    const rows = [];
    let match;
    while ((match = regex.exec(compact)) !== null) {
        const pn = cleanSbPnToken(match[2]);
        if (shouldIgnoreSbPn(pn)) continue;
        rows.push({
            itemNo: null,
            pn,
            qtd: parseSbQuantityToken(match[3]),
            nomenclatura: String(match[1] || '').replace(/\s+/g, ' ').trim() || null,
            role: 'SPARE',
        });
    }
    return rows;
};

const extractSbNonOrderItemNumbers = (flat) => {
    const matches = [...String(flat || '').matchAll(/Item\s+(\d+)\s+is\s+made\s+by\s+part\s+marking[^.]*not\s+necessary\s+to\s+order/gi)];
    return new Set(matches.map((match) => String(match[1] || '').trim()).filter(Boolean));
};

const extractSbLegacyPnSummary = (oldRows = []) => {
    if (!oldRows.length) return null;
    return `PNs antigos/redundantes: ${oldRows.map((item) => item.pn).join(' | ')}.`;
};

const parseSbPdfBuffer = async (buffer, originalName = 'Service Bulletin.pdf') => {
    const parsed = await pdfParse(buffer);
    const rawText = String(parsed.text || '').replace(/\r/g, '');
    const flat = rawText.replace(/[ \t]+/g, ' ').replace(/\n{2,}/g, '\n').trim();
    const lines = splitSbLines(rawText);

    const sbNumeroMatch = flat.match(/\b(LX\d{3}-\d{2}-\d{4}|CTS800-4N-\d{2}-\d{2}-\d{4})\b/i)
        || String(originalName || '').match(/(LX\d{3}-\d{2}-\d{4}|CTS800-4N-\d{2}-\d{2}-\d{4})/i);
    const sbNumero = sbNumeroMatch ? sbNumeroMatch[1].toUpperCase() : `SB-${String(originalName).replace(/\.[^.]+$/, '').toUpperCase()}`;

    let tipoSb = 'N/A';
    if (/\bALERT\b/i.test(flat)) tipoSb = 'ALERTA';
    else if (/MANDATORY|MANDATÓRIA|MANDATORIA/i.test(flat)) tipoSb = 'MANDATORIA';
    else if (/OPTIONAL|OPCIONAL/i.test(flat)) tipoSb = 'OPCIONAL';

    let titulo = originalName;
    const categoryIndex = lines.findIndex((line) => /^(OPTIONAL|ALERT|MANDATORY)$/i.test(line));
    if (categoryIndex !== -1) {
        const candidate = lines.slice(categoryIndex + 1).find((line) => {
            const upper = line.toUpperCase();
            return line.length > 12
                && !upper.includes('ITAR NUMBER')
                && !upper.includes('LX100 TECHNICAL COMMUNICATIONS MANAGER')
                && !upper.includes('REVISION')
                && !upper.includes('EFFECTIVITY')
                && !upper.includes('PAGE ');
        });
        if (candidate) titulo = candidate;
    }
    const descMatch = flat.match(/(?:OPTIONAL|ALERT|MANDATORY)\s+([^\n]{10,180})/i);
    if (descMatch?.[1] && (!titulo || titulo === originalName)) titulo = descMatch[1].trim();

    const dateMatch = flat.match(/(20\d{2}-\d{2}-\d{2})/);
    const dataPublicacao = dateMatch ? dateMatch[1] : null;

    const materialHeaderPattern = new RegExp(`${sbNumero}\s*-\s*Material Information|${sbNumero}\s*-\s*Material information`, 'i');
    const materialSection = extractSbSection(flat, materialHeaderPattern, [/3\s*Interchangeability/i, /3Interchangeability/i, /4\s*Parts disposition/i, /4Parts disposition/i]);
    const newStart = materialSection.search(/Table\s*2\s*New parts/i);
    const newEnd = materialSection.search(/Code Key|Table\s*3\s*(?:Former|Redundant) parts|3\s*Interchangeability|3Interchangeability|4\s*Parts disposition|4Parts disposition/i);
    const oldStart = materialSection.search(/Table\s*3\s*(?:Former|Redundant) parts/i);
    const newPartsSection = materialSection && newStart >= 0
        ? materialSection.slice(newStart, newEnd >= 0 ? newEnd : undefined)
        : extractSbSection(flat, /Table\s*2\s*New parts/i, [/Code Key/i, /Table\s*3\s*(?:Former|Redundant) parts/i, /3\s*Interchangeability/i, /4\s*Parts disposition/i]);
    const oldPartsSection = materialSection && oldStart >= 0
        ? materialSection.slice(oldStart)
        : extractSbSection(flat, /Table\s*3\s*(?:Former|Redundant) parts/i, [/3\s*Interchangeability/i, /4\s*Parts disposition/i]);
    const sparesSection = extractSbSection(flat, /Table\s*6\s*Spares/i, [/Safety conditions/i, /Procedure/i, /4\s*Final Operations/i]);

    const nonOrderItemNumbers = extractSbNonOrderItemNumbers(flat);
    const tableNew = parseSbStructuredTableRows(newPartsSection, 'NOVO').map((row) => ({
        ...row,
        role: nonOrderItemNumbers.has(String(row.itemNo || '')) ? 'CONFIGURACAO' : row.role,
        qtd: nonOrderItemNumbers.has(String(row.itemNo || '')) ? 0 : row.qtd,
    }));
    const tableOld = parseSbStructuredTableRows(oldPartsSection, 'ANTIGO');
    const spares = parseSbSparesRows(sparesSection);

    const itensSb = uniqueBy([
        ...tableNew,
        ...spares.filter((row) => !tableNew.some((item) => item.pn === row.pn)),
        ...tableOld,
    ].map((item) => ({
        sb_numero: sbNumero,
        pn: item.pn,
        nsn: null,
        nomenclatura: item.nomenclatura,
        qtd: item.qtd,
        capitulo: null,
        item_num: item.role,
        aplicabilidade: null,
    })), (item) => `${item.pn}|${item.item_num || ''}`);

    const observacao = [extractSbSummarySnippet(flat), extractSbLegacyPnSummary(tableOld)].filter(Boolean).join(' ');

    return {
        sbNumero,
        titulo,
        tipoSb,
        dataPublicacao,
        observacao: observacao || null,
        itensSb,
    };
};

exports.importData = async (req, res) => {
    try {
        const respondSuccess = (message, extra = {}, audit = {}) => {
            setAuditSummary(req, { status: 'SUCESSO', mensagem: message, ...audit });
            return res.status(200).json({ status: 'success', message, ...extra });
        };

        const respondError = (statusCode, message, audit = {}) => {
            setAuditSummary(req, { status: 'ERRO', mensagem: message, ...audit });
            return res.status(statusCode).json({ status: 'error', message });
        };

        if (!req.file) return respondError(400, 'Nenhum arquivo enviado.');

        const tipoArquivo = req.body.tipoArquivo || 'order_book'; 
        const isPdfFile = String(req.file?.originalname || '').toLowerCase().endsWith('.pdf') || req.file?.mimetype === 'application/pdf';
        let workbook = null;
        const getWorkbook = () => {
            if (!workbook) {
                workbook = xlsx.read(req.file.buffer, { type: 'buffer' });
            }
            return workbook;
        };

        if (!(tipoArquivo === 'sb' && isPdfFile)) {
            workbook = getWorkbook();
        }

        // ---------------------------------------------------
        // ROTA 1: INVENTÁRIO PPU
        // ---------------------------------------------------
        if (tipoArquivo === 'inventario_ppu') {
            const sheetName = workbook.SheetNames[0]; 
            const sheet = workbook.Sheets[sheetName];
            const rawRows = xlsx.utils.sheet_to_json(sheet, { header: 1, defval: '' });
            
            let hIdx = findHeaderRow(rawRows, ['pn', 'qtd']);
            
            if (hIdx !== -1) {
                const headers = rawRows[hIdx];
                const idx = buildIndexMap(headers, {
                    loc: 'localizacao',
                    pi: 'pi',
                    nsn: 'nsn',
                    pn: 'pn',
                    desc: 'nomenclatura',
                    qtd: 'qtd',
                });

                let estoqueAtualizado = [];
                let linhasIgnoradas = 0;

                rawRows.slice(hIdx + 1).forEach((r, rawIndex) => {
                    const pn = normalizePn(safeString(r[idx.pn]));
                    const qtd = cleanCurrency(r[idx.qtd]);
                    
                    if (pn && pn.toLowerCase() !== 'pn') {
                        const nsnReal = (idx.nsn !== -1 && safeString(r[idx.nsn])) ? safeString(r[idx.nsn]) : safeString(r[idx.pi]);
                        const locReal = idx.loc !== -1 ? safeString(r[idx.loc]) : null;

                        estoqueAtualizado.push({
                            pn,
                            nsn_pi: nsnReal || 'N/A', 
                            nomenclatura: safeString(r[idx.desc]) || 'N/A',
                            quantidade: qtd, 
                            localizacao: locReal || 'NÃO DEFINIDO'
                        });
                    } else if (r.some(cell => String(cell || '').trim() !== '')) {
                        linhasIgnoradas += 1;
                        recordAuditIssue(req, {
                            linha_numero: hIdx + 2 + rawIndex,
                            campo: 'pn',
                            valor_original: r[idx.pn],
                            motivo: 'Linha ignorada no inventário PPU por ausência de PN válido.',
                        });
                    }
                });

                if (estoqueAtualizado.length > 0) {
                    const { error: deleteError } = await supabase
                        .from('estoque_ppu')
                        .delete()
                        .neq('pn', 'LIMPEZA');

                    if (deleteError) {
                        throw deleteError;
                    }

                    const chunkSize = 1000;
                    for (let i = 0; i < estoqueAtualizado.length; i += chunkSize) {
                        const lote = estoqueAtualizado.slice(i, i + chunkSize);
                        const { error: insertError } = await supabase.from('estoque_ppu').insert(lote);

                        if (insertError) {
                            throw insertError;
                        }
                    }

                    return respondSuccess(`Inventário PPU atualizado com ${estoqueAtualizado.length} itens!`, {}, {
                        tabelaAlvo: 'estoque_ppu',
                        linhasLidas: Math.max(rawRows.length - (hIdx + 1), 0),
                        linhasImportadas: estoqueAtualizado.length,
                        linhasIgnoradas,
                        detalhes: { cabecalho_encontrado_na_linha: hIdx + 1 },
                    });
                }
            }
            return respondError(400, 'Falha ao ler o cabeçalho do PPU.', { tabelaAlvo: 'estoque_ppu' });
        }

        // ---------------------------------------------------
        // ROTA 2: ORDER BOOK DA LEONARDO
        // ---------------------------------------------------
        else if (tipoArquivo === 'order_book') {
            let allSpares = [], allFoc = [], allRepairs = [], allAdminDocs = [];
            let pnsToRegister = new Map();

            for (const sheetName of workbook.SheetNames) {
                const sheet = workbook.Sheets[sheetName];
                const rawRows = xlsx.utils.sheet_to_json(sheet, { header: 1, defval: '' });
                const nameLower = sheetName.toLowerCase();
                
                // SPARES
                if (nameLower.includes('spare') && !nameLower.includes('foc')) {
                    let hIdx = findHeaderRow(rawRows, ['pn', 'qtd']);
                    if (hIdx !== -1) {
                        const headers = rawRows[hIdx];
                        const idx = buildIndexMap(headers, {
                            pd: 'pd',
                            oc: 'oc',
                            pn: 'pn',
                            desc: 'nomenclatura',
                            val: 'price',
                            req: 'qtd',
                            date: 'delivery',
                            categoria: 'categoria',
                            onDelivery: 'on_delivery',
                            inShipment: 'in_shipment',
                            delivered: 'delivered',
                            notDelivered: 'not_delivered',
                        });
                        
                        rawRows.slice(hIdx + 1).forEach(r => {
                            const pn = normalizePn(safeString(r[idx.pn])); 
                            const categoryInfo = safeString(r[idx.categoria]);
                            let saldoPendente = (idx.notDelivered !== -1 && r[idx.notDelivered] !== '') ? cleanCurrency(r[idx.notDelivered]) : cleanCurrency(r[idx.req]);

                            if (pn && saldoPendente > 0 && pn.toLowerCase() !== 'part number' && (!categoryInfo || !categoryInfo.includes('5-'))) {
                                pnsToRegister.set(pn, safeString(r[idx.desc]) || 'N/A');
                                allSpares.push({ 
                                    pn, documento_referencia: safeString(r[idx.pd]) || 'N/A', oc_referencia: safeString(r[idx.oc]) || 'N/A', 
                                    descricao: pnsToRegister.get(pn), qtd_pendente: saldoPendente, valor_unitario: cleanCurrency(r[idx.val]), 
                                    data_previsao_lh: formatExcelDate(r[idx.date]), status_categoria: categoryInfo || 'N/A',
                                    qtd_aguardando_coleta: cleanCurrency(r[idx.onDelivery]), qtd_em_rota: cleanCurrency(r[idx.inShipment]),
                                    qtd_entregue: cleanCurrency(r[idx.delivered])
                                });
                            }
                        });
                    }
                }
                
                // FOC SPARES
                else if (nameLower.includes('foc')) {
                    let hIdx = findHeaderRow(rawRows, ['pn', 'qtd']);
                    if (hIdx !== -1) {
                        const headers = rawRows[hIdx];
                        const idx = buildIndexMap(headers, { pn: 'pn', desc: 'nomenclatura', doc: 'oc', qty: 'qtd', date: 'delivery' });
                        rawRows.slice(hIdx + 1).forEach(r => {
                            const pn = normalizePn(safeString(r[idx.pn])); const qty = cleanCurrency(r[idx.qty]);
                            if (pn && qty > 0 && pn.toLowerCase() !== 'part number') {
                                pnsToRegister.set(pn, safeString(r[idx.desc]) || 'N/A');
                                allFoc.push({ pn, descricao: pnsToRegister.get(pn), documento_referencia: safeString(r[idx.doc]), qtd_pendente: qty, data_previsao_lh: formatExcelDate(r[idx.date]) });
                            }
                        });
                    }
                }

                // REPAIRS
                else if (nameLower.includes('repair') && !nameLower.includes('warranty')) {
                    let hIdx = findHeaderRow(rawRows, ['incoming_part', 'serial_number']);
                    if (hIdx !== -1) {
                        const headers = rawRows[hIdx];
                        const idx = buildIndexMap(headers, { pn: 'incoming_part', pn_out: 'outgoing_part', sn: 'serial_number', desc: 'nomenclatura', doc: 'oc', status: 'lh_comments', date: 'delivery' });
                        rawRows.slice(hIdx + 1).forEach(r => {
                            const pn = normalizePn(safeString(r[idx.pn])); const sn = safeString(r[idx.sn]);
                            if (pn && sn && pn.toLowerCase() !== 'incoming part') {
                                pnsToRegister.set(pn, safeString(r[idx.desc]) || 'N/A');
                                allRepairs.push({ pn, sn, descricao: pnsToRegister.get(pn), tipo: 'PAID', documento_referencia: safeString(r[idx.doc]), status: safeString(r[idx.status]), data_previsao: formatExcelDate(r[idx.date]), pn_saida: safeString(r[idx.pn_out]) });
                            }
                        });
                    }
                }

                // WARRANTY REPAIRS
                else if (nameLower.includes('warranty')) {
                    let hIdx = findHeaderRow(rawRows, ['part_required', 'serial_number']);
                    if (hIdx !== -1) {
                        const headers = rawRows[hIdx];
                        const idx = buildIndexMap(headers, { pn: 'part_required', sn: 'serial_number', desc: 'nomenclatura', doc: ['event report number', 'number'], ac: ['tail number', 'aircraft'], status: ['lh updates', 'status'], date: ['delivery number', 'delivery'] });
                        rawRows.slice(hIdx + 1).forEach(r => {
                            const pn = normalizePn(safeString(r[idx.pn])); const sn = safeString(r[idx.sn]);
                            if (pn && sn && pn.toLowerCase() !== 'part required') {
                                pnsToRegister.set(pn, safeString(r[idx.desc]) || 'N/A');
                                allRepairs.push({ pn, sn, descricao: pnsToRegister.get(pn), tipo: 'WARRANTY', documento_referencia: safeString(r[idx.doc]), status: safeString(r[idx.status]), data_previsao: formatExcelDate(r[idx.date]), aeronave: safeString(r[idx.ac]) });
                            }
                        });
                    }
                }

                // ADMIN DOCS
                else if (['rfq\'s', 'tqs', 'er'].includes(nameLower)) {
                    const tipoDoc = nameLower === 'rfq\'s' ? 'RFQ' : nameLower === 'tqs' ? 'TQS' : 'ER';
                    let hIdx = rawRows.findIndex(r => { const rowStr = r.join('|').toLowerCase(); return rowStr.includes('quote number') || rowStr.includes('lh ref') || rowStr.includes('symptom'); });
                    if (hIdx !== -1) {
                        const h = rawRows[hIdx].map(x => String(x).toLowerCase().trim());
                        rawRows.slice(hIdx + 1).forEach(r => {
                            let doc='', assunto='', status='';
                            if (tipoDoc === 'RFQ') { doc = r[h.indexOf('quote number')]; assunto = r[h.indexOf('part number')]; }
                            else if (tipoDoc === 'TQS') { doc = r[h.indexOf('lh ref')]; assunto = r[h.indexOf('description')]; status = r[h.indexOf('status')]; }
                            else if (tipoDoc === 'ER') { doc = r[h.indexOf('number')]; assunto = r[h.indexOf('p/n')]; status = r[h.indexOf('status')]; }
                            if (safeString(doc)) allAdminDocs.push({ tipo_doc: tipoDoc, numero_doc: safeString(doc), assunto_pn: safeString(assunto), status: safeString(status) });
                        });
                    }
                }
            } 

            // AUTOCADASTRO
            const uniquePns = Array.from(pnsToRegister.keys()).filter(Boolean);
            if (uniquePns.length > 0) {
                const { data: existingItems } = await supabase.from('items').select('pn').in('pn', uniquePns);
                const existingPns = (existingItems || []).map(i => i.pn);
                const missingPns = uniquePns.filter(pn => !existingPns.includes(pn)).map(pn => ({ pn: pn, nomenclatura: pnsToRegister.get(pn), nsn: `PND-${pn}` }));
                if (missingPns.length > 0) await supabase.from('items').insert(missingPns);
            }

            // SALVAMENTO BLINDADO
            if (allSpares.length > 0) { await supabase.from('leonardo_spares').delete().neq('pn', 'LIMPEZA'); await supabase.from('leonardo_spares').insert(allSpares); }
            if (allFoc.length > 0) { await supabase.from('leonardo_foc_spares').delete().neq('pn', 'LIMPEZA'); await supabase.from('leonardo_foc_spares').insert(allFoc); }
            if (allRepairs.length > 0) { await supabase.from('leonardo_repairs').delete().neq('pn', 'LIMPEZA'); await supabase.from('leonardo_repairs').insert(allRepairs); }
            if (allAdminDocs.length > 0) { await supabase.from('leonardo_admin_docs').delete().neq('tipo_doc', 'LIMPEZA'); await supabase.from('leonardo_admin_docs').insert(allAdminDocs); }
            
            const todosPnsOficiais = [...new Set([...allSpares.map(i => i.oc_referencia), ...allRepairs.map(i => i.documento_referencia)])];
            await supabase.from('cadastros_manuais').update({ ativo: false }).in('identificador_unico', todosPnsOficiais);
            
            return respondSuccess(`Order Book atualizado com sucesso!`, {}, { tabelaAlvo: 'leonardo_spares', linhasImportadas: allSpares.length + allFoc.length + allRepairs.length + allAdminDocs.length, detalhes: { spares: allSpares.length, foc: allFoc.length, repairs: allRepairs.length, admin_docs: allAdminDocs.length } });
        }

        // ---------------------------------------------------
        // ROTA 3: RECIBOS DE GARANTIA / MATERIAL
        // ---------------------------------------------------
        else if (tipoArquivo === 'recibo_material') {
            const sheetName = workbook.SheetNames[0]; 
            const sheet = workbook.Sheets[sheetName];
            const rawRows = xlsx.utils.sheet_to_json(sheet, { header: 1, defval: '' });
            
            let numRecibo = 'N/A';
            let dataEntrega = ''; 
            let isFOC = false;

            rawRows.forEach(r => {
                const rowText = r.join(' ').toUpperCase();
                if (rowText.includes('RECIBO DE ENTREGA') && rowText.includes('NÚMERO')) {
                    const match = rowText.match(/NÚMERO\s+([\d\/]+)/);
                    if (match) numRecibo = match[1];
                }
                if (rowText.includes('DATA DE ENTREGA') || rowText.includes('DATA ENTREGA')) {
                    const match = rowText.match(/ENTREGA[:\s]*([\d]{2}\/[\d]{2}\/[\d]{4})/);
                    if (match) dataEntrega = match[1];
                }
                if (rowText.includes('- FOC')) {
                    isFOC = true;
                }
            });

            let hIdx = findHeaderRow(rawRows, ['pn']);
            
            if (hIdx !== -1) {
                const headers = rawRows[hIdx];
                const idx = buildIndexMap(headers, { 
                    pn: 'pn', 
                    desc: 'nomenclatura', 
                    qtd: 'qtd'
                });

                let itensParaTriagem = [];

                rawRows.slice(hIdx + 1).forEach((r, index) => {
                    const pn = normalizePn(safeString(r[idx.pn]));
                    const desc = safeString(r[idx.desc]) || '';
                    const qty = cleanCurrency(r[idx.qtd]);

                    if (pn && !['pn', 'part number', 'part nuber'].includes(pn.toLowerCase()) && qty > 0) {
                        let snsExtraidos = [];
                        if (desc.toUpperCase().includes('S/N')) {
                            const snPart = desc.toUpperCase().split('S/N')[1].split('-')[0].trim();
                            snsExtraidos = snPart.split(/,|\s+E\s+/).map(s => s.trim()).filter(Boolean);
                        }

                        itensParaTriagem.push({
                            id_temp: index, pn: pn, nomenclatura: desc, quantidade: qty, sns_pre_carregados: snsExtraidos
                        });
                    }
                });

                return respondSuccess(`Recibo ${numRecibo} processado! ${itensParaTriagem.length} itens aguardando Triagem.`, {
                    recibo_ref: numRecibo, data_entrega_ref: dataEntrega, is_foc: isFOC, data_triagem: itensParaTriagem
                }, { tabelaAlvo: 'estoque_ppu', linhasLidas: Math.max(rawRows.length - (hIdx + 1), 0), linhasImportadas: itensParaTriagem.length, detalhes: { modo: 'triagem_recibo_material', recibo_ref: numRecibo, is_foc: isFOC } });
            } else {
                return respondError(400, 'Cabeçalho de PN não encontrado no recibo.', { tabelaAlvo: 'estoque_ppu', detalhes: { modo: 'triagem_recibo_material' } });
            }
        }

        // ---------------------------------------------------
        // ROTA 4: LISDE (Lista de Equipamentos e Sobressalentes)
        // ---------------------------------------------------
        else if (tipoArquivo === 'lisde') {
            const sheetName = workbook.SheetNames[0];
            const sheet = workbook.Sheets[sheetName];
            const rawRows = xlsx.utils.sheet_to_json(sheet, { header: 1, defval: '' });

            // Identifica a linha de cabeçalho
            let hIdx = findHeaderRow(rawRows, ['pn', 'qtd']);

            if (hIdx !== -1) {
                const headers = rawRows[hIdx];
                const idx = buildIndexMap(headers, {
                    pn: 'pn',
                    desc: 'nomenclatura',
                    qtd: 'qtd'
                });

                let lisdeData = [];

                rawRows.slice(hIdx + 1).forEach(r => {
                    const pn = normalizePn(safeString(r[idx.pn]));
                    const qtd = cleanCurrency(r[idx.qtd]);

                    // Só grava se tiver PN válido e quantidade maior que zero
                    if (pn && pn.toLowerCase() !== 'pn' && qtd > 0) {
                        lisdeData.push({
                            pn: normalizePn(pn),
                            nomenclatura: idx.desc !== -1 ? safeString(r[idx.desc]) : 'N/A',
                            qtd_autorizada: qtd,
                            observacao: 'Disponível na lista oficial'
                        });
                    }
                });

                if (lisdeData.length > 0) {
                    // Tática de Substituição: Limpa a lista antiga antes de injetar a nova
                    await supabase.from('lisde').delete().neq('pn', 'LIMPEZA');

                    // Insere os dados em lotes de 1000 para não sobrecarregar a rede
                    const chunkSize = 1000;
                    for (let i = 0; i < lisdeData.length; i += chunkSize) {
                        await supabase.from('lisde').insert(lisdeData.slice(i, i + chunkSize));
                    }

                    return respondSuccess(`Base LISDE atualizada! ${lisdeData.length} itens autorizados gravados com sucesso.`, {}, { tabelaAlvo: 'lisde', linhasLidas: Math.max(rawRows.length - (hIdx + 1), 0), linhasImportadas: lisdeData.length });
                } else {
                    return respondError(400, 'Cabeçalhos encontrados, mas nenhum dado válido pôde ser extraído da LISDE.', { tabelaAlvo: 'lisde' });
                }
            }
            return respondError(400, 'Cabeçalhos da LISDE (PN, QTD) não identificados no arquivo.', { tabelaAlvo: 'lisde' });
        }

        // ---------------------------------------------------
        // ROTA 5: PRICE LIST OFICIAL (Blindada com Datas Nível Máximo)
        // ---------------------------------------------------
        else if (tipoArquivo === 'price_list') {
            console.log("A iniciar processamento da Price List Oficial...");
            
            try {
                const sheetName = workbook.SheetNames[0];
                const sheet = workbook.Sheets[sheetName];
                // raw: false faz com que o Excel tente ler o texto formatado original se possível
                const rawRows = xlsx.utils.sheet_to_json(sheet, { header: 1, defval: '', raw: false });

                let hIdx = findHeaderRow(rawRows, ['pn', 'price']);

                if (hIdx !== -1) {
                    const headers = rawRows[hIdx];
                    const idx = buildIndexMap(headers, {
                        pn: 'pn',
                        desc: 'nomenclatura',
                        nsn: 'nsn',
                        lead: 'lead_time',
                        moq: 'moq',
                        price: 'price',
                        start: 'start_date',
                        end: 'end_date'
                    });

                    let plData = [];

                    // O TRADUTOR BLINDADO DE DATAS
                    const formatValidade = (start, end) => {
                        const fData = (d) => {
                            if (!d) return '';
                            let strD = String(d).trim();
                            
                            // 1. Se o Excel mandou o código numérico puro (ex: "45720")
                            if (/^\d+$/.test(strD) && Number(strD) > 20000) {
                                const dataExcel = new Date(Math.round((Number(strD) - 25569) * 86400 * 1000));
                                return dataExcel.toLocaleDateString('pt-BR', { timeZone: 'UTC' });
                            }
                            
                            // 2. Se o Excel mandou YYYY-MM-DD
                            if (strD.includes('-')) {
                                const pts = strD.split('-');
                                if (pts.length === 3 && pts[0].length === 4) {
                                    return `${pts[2]}/${pts[1]}/${pts[0]}`; // Vira DD/MM/YYYY
                                }
                            }
                            
                            // 3. Se já estiver no formato correto
                            return strD;
                        };

                        const s = fData(start); 
                        const e = fData(end);
                        
                        if (s && e) return `${s} a ${e}`;
                        if (s) return `A partir de ${s}`;
                        return 'Atual';
                    };

                    rawRows.slice(hIdx + 1).forEach((r) => {
                        const pn = r[idx.pn] ? String(r[idx.pn]).trim().toUpperCase() : '';
                        
                        let rawPrice = r[idx.price];
                        let price = typeof rawPrice === 'number' ? rawPrice : parseFloat(String(rawPrice).replace(/[^0-9.]/g, ''));

                        if (pn && pn !== 'PART NUMBER' && price > 0) {
                            let nsnRaw = r[idx.nsn] ? String(r[idx.nsn]).trim() : null;
                            if (nsnRaw === '-' || nsnRaw === '') nsnRaw = null;

                            const moqVal = parseInt(r[idx.moq]) || 1;
                            const rawLead = r[idx.lead] ? String(r[idx.lead]).replace(/[^0-9]/g, '') : '0';
                            const leadVal = parseInt(rawLead) || 0;

                            plData.push({
                                pn: pn,
                                nomenclatura: idx.desc !== -1 && r[idx.desc] ? String(r[idx.desc]).trim() : 'N/A',
                                nsn: nsnRaw,
                                valor_unitario: price,
                                moq: moqVal,
                                lead_time: leadVal,
                                validade: formatValidade(r[idx.start], r[idx.end])
                            });
                        }
                    });

                    if (plData.length > 0) {
                        // Limpa os dados velhos (os que têm os números errados)
                        await supabase.from('price_list').delete().neq('pn', 'LIMPEZA');

                        // Insere os dados novos
                        const chunkSize = 1000;
                        for (let i = 0; i < plData.length; i += chunkSize) {
                            const { error } = await supabase.from('price_list').insert(plData.slice(i, i + chunkSize));
                            if (error) throw error;
                        }

                        return respondSuccess(`Price List Oficial atualizada! ${plData.length} itens gravados com sucesso.`, {}, { tabelaAlvo: 'price_list', linhasLidas: Math.max(rawRows.length - (hIdx + 1), 0), linhasImportadas: plData.length });
                    } else {
                        return respondError(400, 'Nenhum dado válido extraído.', { tabelaAlvo: 'price_list' });
                    }
                }
                return respondError(400, 'Cabeçalhos da Price List não encontrados.', { tabelaAlvo: 'price_list' });
                
            } catch (error) {
                return respondError(500, 'Falha ao processar a Price List: ' + (error.message || error), { tabelaAlvo: 'price_list' });
            }
        }

        // ---------------------------------------------------
        // ROTA 5.1: RECIBO DE PD 
        // ---------------------------------------------------
        else if (tipoArquivo === 'recibo_pd') {
            const sheetName = workbook.SheetNames[0]; 
            const sheet = workbook.Sheets[sheetName];
            const rawRows = xlsx.utils.sheet_to_json(sheet, { header: 1, defval: '' });

            let numRecibo = 'N/A';
            let dataEntrega = new Date().toLocaleDateString('pt-BR');
            
            rawRows.forEach(r => {
                const rowText = r.join(' ').toUpperCase();
                if (rowText.includes('RECIBO DE ENTREGA') && rowText.includes('NÚMERO')) {
                    const match = rowText.match(/NÚMERO\s+([\d\/]+)/);
                    if (match) numRecibo = match[1];
                }
                if (rowText.includes('DATA DE ENTREGA')) {
                    const match = rowText.match(/DATA DE ENTREGA[:\s]*([\d]{2}\/[\d]{2}\/[\d]{4})/);
                    if (match) dataEntrega = match[1];
                }
            });

            let hIdx = findHeaderRow(rawRows, ['pd', 'qtd']);
            
            if (hIdx !== -1) {
                const headers = rawRows[hIdx];
                const idx = buildIndexMap(headers, { pd: 'pd', pn: 'pn', desc: 'nomenclatura', qty: 'qtd' });

                let itensRecebidos = [];

                rawRows.slice(hIdx + 1).forEach((r, rawIndex) => {
                    const pd = safeString(r[idx.pd]);
                    const qty = cleanCurrency(r[idx.qty]);

                    if (pd && pd.toLowerCase() !== 'pd' && qty > 0) {
                        itensRecebidos.push({ pd, pn: normalizePn(safeString(r[idx.pn])), qty, desc: safeString(r[idx.desc]) });
                    } else if (r.some(cell => String(cell || '').trim() !== '')) {
                        recordAuditIssue(req, {
                            linha_numero: hIdx + 2 + rawIndex,
                            campo: 'pd/qtd',
                            valor_original: `${r[idx.pd] || ''} | ${r[idx.qty] || ''}`,
                            motivo: 'Linha ignorada no recibo PD por ausência de PD ou quantidade válida.',
                        });
                    }
                });

                for (let item of itensRecebidos) {
                    await supabase.from('estoque_ppu').insert({
                        pn: item.pn, nomenclatura: item.desc, quantidade: item.qty, 
                        localizacao: `TRIAGEM: Recibo ${numRecibo}`, data_chegada: dataEntrega
                    });

                    const { data: odaAtual } = await supabase.from('leonardo_spares').select('*').eq('documento_referencia', item.pd).eq('pn', item.pn).maybeSingle();
                    
                    if (odaAtual) {
                        let novoPendente = Math.max(0, odaAtual.qtd_pendente - item.qty);
                        let novoEmRota = Math.max(0, (odaAtual.qtd_em_rota || 0) - item.qty);
                        let novoEntregue = (odaAtual.qtd_entregue || 0) + item.qty;

                        await supabase.from('leonardo_spares')
                            .update({ 
                                qtd_pendente: novoPendente, qtd_em_rota: novoEmRota, qtd_entregue: novoEntregue,
                                status_categoria: `✅ RECEBIDO (${numRecibo} em ${dataEntrega})` 
                            })
                            .eq('id', odaAtual.id);
                    }
                }
                return respondSuccess(`Recibo ${numRecibo} processado! PNs inseridos no PPU e baixados do Order Book.`, {}, { tabelaAlvo: 'estoque_ppu', linhasLidas: Math.max(rawRows.length - (hIdx + 1), 0), linhasImportadas: itensRecebidos.length, detalhes: { modo: 'recibo_pd', recibo_ref: numRecibo } });
            } else {
                return respondError(400, 'Cabeçalho PD e QTY não encontrado.', { tabelaAlvo: 'estoque_ppu', detalhes: { modo: 'recibo_pd' } });
            }
        }
        
        // ---------------------------------------------------
        // ROTA 6: MANUAL DO SISTEMA LEGADO (DICIONÁRIO MESTRE)
        // ---------------------------------------------------

        // ---------------------------------------------------
        // ROTA 5.2: DOCUMENTO TÉCNICO DE PN ALTERNATIVOS
        // ---------------------------------------------------
        else if (tipoArquivo === 'pn_alternativos') {
            const sheetName = workbook.SheetNames[0];
            const sheet = workbook.Sheets[sheetName];
            const rawRows = xlsx.utils.sheet_to_json(sheet, { header: 1, defval: '' });

            const hIdx = findHeaderRow(rawRows, ['pn', 'pn_alt']);
            if (hIdx === -1) {
                return respondError(400, 'Cabeçalhos PN e PN_Alt não encontrados no documento de alternativos.', {
                    tabelaAlvo: 'pn_alternativos_documento',
                    detalhes: { modo: 'pn_alternativos' }
                });
            }

            const headers = rawRows[hIdx];
            const idx = buildIndexMap(headers, {
                pn: 'pn',
                pi: ['pi', 'nsn'],
                pnAlt: ['pn_alt', 'pn alt', 'pn alternativo', 'alternate pn'],
                fonte: 'fonte',
            });

            let linhasIgnoradas = 0;
            const registros = [];

            rawRows.slice(hIdx + 1).forEach((r, rawIndex) => {
                const pn = normalizePn(safeString(r[idx.pn]));
                const pnAlt = normalizePn(safeString(r[idx.pnAlt]));
                const pi = idx.pi !== -1 ? safeString(r[idx.pi]) : null;
                const fonte = (idx.fonte !== -1 ? safeString(r[idx.fonte]) : null) || 'DOCUMENTO TÉCNICO PN ALTERNATIVOS';

                if (pn && pnAlt && pn !== pnAlt && pn.toLowerCase() !== 'pn') {
                    registros.push({ pn, pi, pn_alt: pnAlt, fonte });
                } else if (r.some(cell => String(cell || '').trim() !== '')) {
                    linhasIgnoradas += 1;
                    recordAuditIssue(req, {
                        linha_numero: hIdx + 2 + rawIndex,
                        campo: 'pn/pn_alt',
                        valor_original: `${r[idx.pn] || ''} | ${r[idx.pnAlt] || ''}`,
                        motivo: 'Linha ignorada no documento de alternativos por ausência de PN/PN_Alt válido ou relação reflexiva.'
                    });
                }
            });

            if (registros.length === 0) {
                return respondError(400, 'Nenhuma relação válida de PN alternativo foi identificada.', {
                    tabelaAlvo: 'pn_alternativos_documento',
                    linhasIgnoradas,
                    detalhes: { modo: 'pn_alternativos' }
                });
            }

            const dedup = new Map();
            registros.forEach((registro) => {
                const chave = `${registro.pn}|${registro.pn_alt}|${registro.fonte}`;
                if (!dedup.has(chave)) dedup.set(chave, registro);
            });
            const payload = Array.from(dedup.values());

            const { error: deleteError } = await supabase
                .from('pn_alternativos_documento')
                .delete()
                .neq('pn', 'LIMPEZA');

            if (deleteError) throw deleteError;

            const chunkSize = 1000;
            for (let i = 0; i < payload.length; i += chunkSize) {
                const lote = payload.slice(i, i + chunkSize);
                const { error: insertError } = await supabase
                    .from('pn_alternativos_documento')
                    .insert(lote);
                if (insertError) throw insertError;
            }

            return respondSuccess(`Biblioteca de PN Alternativos atualizada com ${payload.length} relações técnicas.`, {}, {
                tabelaAlvo: 'pn_alternativos_documento',
                linhasLidas: Math.max(rawRows.length - (hIdx + 1), 0),
                linhasImportadas: payload.length,
                linhasIgnoradas,
                detalhes: { modo: 'pn_alternativos' }
            });
        }

        else if (tipoArquivo === 'manual_legado') {
            const sheetName = workbook.SheetNames[0]; 
            const sheet = workbook.Sheets[sheetName];
            const rawRows = xlsx.utils.sheet_to_json(sheet, { header: 1, defval: '' });

            let hIdx = findHeaderRow(rawRows, ['dmc', 'pn']);
            
            if (hIdx !== -1) {
                const headers = rawRows[hIdx];
                const idx = buildIndexMap(headers, { 
                    dmc: 'dmc', item: 'item', sub: 'sub_item', 
                    pn: 'pn', nsn: 'nsn', desc: 'nomenclatura', 
                    techname: 'techname' 
                });

                let dicionarioData = [];

                rawRows.slice(hIdx + 1).forEach(r => {
                    const pn = normalizePn(safeString(r[idx.pn]));
                    if (pn && pn.toLowerCase() !== 'pn') {
                        const nsnRaw = safeString(r[idx.nsn]) || '';
                        const apenasNumeros = nsnRaw.replace(/\D/g, '');
                        const piCalc = apenasNumeros.length >= 13 ? apenasNumeros.substring(4) : apenasNumeros;

                        dicionarioData.push({
                            pn: normalizePn(pn),
                            dmc: safeString(r[idx.dmc]),
                            item_num: safeString(r[idx.item]),
                            sub_item: safeString(r[idx.sub]),
                            nsn: nsnRaw,
                            pi: piCalc,
                            nomenclatura: safeString(r[idx.desc]),
                            techname: safeString(r[idx.techname])
                        });
                    }
                });

                if (dicionarioData.length > 0) {
                    await supabase.from('dicionario_mestre').delete().neq('pn', 'LIMPEZA');
                    const chunkSize = 1000;
                    for (let i = 0; i < dicionarioData.length; i += chunkSize) {
                        await supabase.from('dicionario_mestre').insert(dicionarioData.slice(i, i + chunkSize));
                    }
                    return respondSuccess(`Pedra de Roseta ativada! ${dicionarioData.length} registos mestre carregados com sucesso.`, {}, { tabelaAlvo: 'dicionario_mestre', linhasLidas: Math.max(rawRows.length - (hIdx + 1), 0), linhasImportadas: dicionarioData.length });
                }
            } else {
                return respondError(400, 'Cabeçalhos DMC e PN não encontrados na planilha.', { tabelaAlvo: 'dicionario_mestre' });
            }
        }

        // ---------------------------------------------------
        // ROTA 7: ESTOQUE CEIMSPA (TABULAÇÕES E ZEROS BLINDADOS)
        // ---------------------------------------------------
        else if (tipoArquivo === 'ceimspa') {
            const sheetName = workbook.SheetNames[0];
            const sheet = workbook.Sheets[sheetName];
            const rawRows = xlsx.utils.sheet_to_json(sheet, { header: 1, defval: '' });

            const deveSobrescrever = req.body.overwrite === 'true';

            const limparEPadronizarPI = (val) => {
                let s = String(val).replace(/['"]/g, "").trim();
                if (!s || s.toLowerCase() === 'pi' || s.toLowerCase() === 'nsn') return null;
                if (s.length < 9 && /^\d+$/.test(s)) s = s.padStart(9, '0');
                return s;
            };

            const linhasNormalizadas = rawRows.map(r => {
                if (r.length === 1 && typeof r[0] === 'string') {
                    if (r[0].includes('\t')) return r[0].split('\t').map(x => String(x).replace(/['"]/g, "").trim());
                    if (r[0].includes(';')) return r[0].split(';').map(x => String(x).replace(/['"]/g, "").trim());
                }
                return r.map(x => String(x).replace(/['"]/g, "").trim());
            });

            let ceimspaData = [];
            
            let hIdx = findHeaderRow(linhasNormalizadas, [['pi', 'nsn']]);

            if (hIdx !== -1) {
                const headers = linhasNormalizadas[hIdx];
                const idx = buildIndexMap(headers, {
                    pi: ['pi', 'nsn'],
                    nome: 'nomenclatura',
                    qtd: 'qtd',
                    sj: 'sj',
                    uf: 'uf'
                });

                linhasNormalizadas.slice(hIdx + 1).forEach(r => {
                    if (idx.pi !== -1 && r[idx.pi]) {
                        const piLimpo = limparEPadronizarPI(r[idx.pi]);
                        if (piLimpo) {
                            ceimspaData.push({
                                pi: piLimpo,
                                nomenclatura: idx.nome !== -1 ? safeString(r[idx.nome]) : 'N/A',
                                quantidade: idx.qtd !== -1 ? cleanCurrency(r[idx.qtd]) : 0,
                                sj: idx.sj !== -1 ? safeString(r[idx.sj]) : 'N/A',
                                uf: idx.uf !== -1 ? safeString(r[idx.uf]) : 'N/A'
                            });
                        }
                    }
                });

                if (ceimspaData.length > 0) {
                    if (deveSobrescrever) {
                        await supabase.from('estoque_ceimspa').delete().not('id', 'is', null);
                    }
                    
                    const chunkSize = 1000;
                    for (let i = 0; i < ceimspaData.length; i += chunkSize) {
                        await supabase.from('estoque_ceimspa').insert(ceimspaData.slice(i, i + chunkSize));
                    }
                    
                    const msgFinal = deveSobrescrever 
                        ? `Base CEIMSPA Reiniciada! ${ceimspaData.length} itens gravados com sucesso.` 
                        : `Suplemento CEIMSPA: ${ceimspaData.length} novos itens adicionados ao cofre.`;

                    await registrarAuditoria({
                        req,
                        action: deveSobrescrever ? 'CEIMSPA_SOBRESCRITO' : 'CEIMSPA_SUPLEMENTADO',
                        entity: 'ESTOQUE_CEIMSPA',
                        entityId: req.file?.originalname || 'ceimspa',
                        summary: `${req.user?.email || 'Usuário'} ${deveSobrescrever ? 'substituiu' : 'suplementou'} a base CeIMSPA com ${ceimspaData.length} itens.`,
                        details: {
                            overwrite: deveSobrescrever,
                            linhas_lidas: Math.max(linhasNormalizadas.length - (hIdx + 1), 0),
                            linhas_importadas: ceimspaData.length,
                            arquivo: req.file?.originalname || null,
                        },
                        level: deveSobrescrever ? 'WARN' : 'INFO',
                        visibility: 'GOD',
                    });

                    return respondSuccess(msgFinal, {}, { tabelaAlvo: 'estoque_ceimspa', linhasLidas: Math.max(linhasNormalizadas.length - (hIdx + 1), 0), linhasImportadas: ceimspaData.length, detalhes: { overwrite: deveSobrescrever } });
                } else {
                    return respondError(400, 'Cabeçalhos encontrados, mas os dados das linhas não puderam ser extraídos. Verifique o formato.', { tabelaAlvo: 'estoque_ceimspa' });
                }
            }
            return respondError(400, 'Cabeçalhos do CEIMSPA (PI ou NSN) não identificados no arquivo.', { tabelaAlvo: 'estoque_ceimspa' });
        }
        


        // ---------------------------------------------------
        // ROTA 8: HISTÓRICO DE MOVIMENTAÇÃO (PN, DATA, QTD, OS)
        // ---------------------------------------------------
        else if (tipoArquivo === 'historico_movimentacao') {
            const sheetName = workbook.SheetNames[0];
            const sheet = workbook.Sheets[sheetName];
            const rawRows = xlsx.utils.sheet_to_json(sheet, { header: 1, defval: '' });

            const hIdx = findHeaderRow(rawRows, ['pn', 'data', 'qtd', 'os']);
            if (hIdx === -1) {
                return respondError(400, 'Cabeçalhos obrigatórios não encontrados. O Histórico de Movimentação precisa das colunas: PN, Data, QTD e OS.', {
                    tabelaAlvo: 'historico_movimentacao',
                    detalhes: { colunas_obrigatorias: ['PN', 'Data', 'QTD', 'OS'] },
                });
            }

            const headers = rawRows[hIdx];
            const idx = buildIndexMap(headers, {
                pn: 'pn',
                data: 'data',
                qtd: 'qtd',
                os: 'os',
            });

            const registros = [];
            let linhasIgnoradas = 0;
            const arquivoFonte = req.file?.originalname || 'historico_movimentacao';

            rawRows.slice(hIdx + 1).forEach((row, rawIndex) => {
                const linhaNumero = hIdx + 2 + rawIndex;
                const linhaTemConteudo = row.some((cell) => String(cell || '').trim() !== '');
                if (!linhaTemConteudo) return;

                const pn = normalizePn(safeString(row[idx.pn]));
                const dataMovimentacao = formatDbDate(row[idx.data]);
                const quantidade = cleanCurrency(row[idx.qtd]);
                const os = safeString(row[idx.os]);

                if (!pn || !dataMovimentacao || !os) {
                    linhasIgnoradas += 1;
                    recordAuditIssue(req, {
                        linha_numero: linhaNumero,
                        campo: 'PN/Data/OS',
                        valor_original: JSON.stringify({ pn: row[idx.pn], data: row[idx.data], os: row[idx.os] }),
                        motivo: 'Linha ignorada no histórico por ausência de PN, Data válida ou OS.',
                    });
                    return;
                }

                registros.push({
                    pn,
                    data_movimentacao: dataMovimentacao,
                    quantidade,
                    os,
                    fonte_arquivo: arquivoFonte,
                    created_by_email: req.user?.email || null,
                    created_by_role: req.user?.role || null,
                    payload: {
                        linha_origem: linhaNumero,
                    },
                });
            });

            if (!registros.length) {
                return respondError(400, 'Nenhuma linha válida encontrada no Histórico de Movimentação.', {
                    tabelaAlvo: 'historico_movimentacao',
                    linhasLidas: Math.max(rawRows.length - (hIdx + 1), 0),
                    linhasIgnoradas,
                });
            }

            let importadas = 0;
            const chunkSize = 1000;
            for (let i = 0; i < registros.length; i += chunkSize) {
                const lote = registros.slice(i, i + chunkSize);
                const { data, error } = await supabase
                    .from('historico_movimentacao')
                    .upsert(lote, {
                        onConflict: 'pn,data_movimentacao,quantidade,os',
                        ignoreDuplicates: true,
                    })
                    .select('id');

                if (error) throw error;
                importadas += Array.isArray(data) ? data.length : lote.length;
            }

            await registrarAuditoria({
                req,
                action: 'HISTORICO_MOVIMENTACAO_IMPORTADO',
                entity: 'HISTORICO_MOVIMENTACAO',
                entityId: arquivoFonte,
                summary: `${req.user?.email || 'Usuário'} importou Histórico de Movimentação com ${importadas} registros novos/atualizados.`,
                details: {
                    arquivo: arquivoFonte,
                    linhas_lidas: Math.max(rawRows.length - (hIdx + 1), 0),
                    linhas_validas: registros.length,
                    linhas_importadas: importadas,
                    linhas_ignoradas: linhasIgnoradas,
                    duplicadas_ignoradas: Math.max(registros.length - importadas, 0),
                    colunas_obrigatorias: ['PN', 'Data', 'QTD', 'OS'],
                },
                level: 'INFO',
                visibility: 'GOD',
            });

            return respondSuccess(`Histórico de Movimentação importado: ${importadas} registro(s) novo(s). ${Math.max(registros.length - importadas, 0)} duplicado(s) ignorado(s).`, {}, {
                tabelaAlvo: 'historico_movimentacao',
                linhasLidas: Math.max(rawRows.length - (hIdx + 1), 0),
                linhasImportadas: importadas,
                linhasIgnoradas,
                detalhes: {
                    linhas_validas: registros.length,
                    duplicadas_ignoradas: Math.max(registros.length - importadas, 0),
                    modo: 'upsert_sem_duplicar',
                },
            });
        }

        // ---------------------------------------------------
        // ROTA 8: QNNA (Quadro de Necessidades)
        // ---------------------------------------------------
        else if (tipoArquivo === 'qnna') {
            const sheetName = workbook.SheetNames[0];
            const sheet = workbook.Sheets[sheetName];
            const rawRows = xlsx.utils.sheet_to_json(sheet, { header: 1, defval: '' });
            const qnnaRef = (req.file?.originalname || 'QNNA').replace(/\.[^.]+$/, '');

            let hIdx = findHeaderRow(rawRows, ['pn', 'qtd']);
            if (hIdx !== -1) {
                const headers = rawRows[hIdx];
                const idx = buildIndexMap(headers, {
                    pn: ['pn', 'part number', 'part nuber'],
                    nsn: 'nsn',
                    desc: ['nomenclatura', 'description'],
                    qtd: ['qtd', 'qty', 'quantidade'],
                    justificativa: ['justificativa', 'observacao', 'observação', 'motivo'],
                    status: ['status', 'situacao', 'situação'],
                    ref: ['demanda', 'demanda_ref', 'referencia', 'referência', 'item'],
                });

                let registros = [];
                let linhasIgnoradas = 0;

                rawRows.slice(hIdx + 1).forEach((r, rawIndex) => {
                    const pn = normalizePn(safeString(r[idx.pn]));
                    const qtd = cleanCurrency(r[idx.qtd]);

                    if (pn && qtd > 0) {
                        registros.push({
                            qnna_referencia: qnnaRef,
                            mes_referencia: qnnaRef,
                            demanda_ref: idx.ref !== -1 ? safeString(r[idx.ref]) : null,
                            pn,
                            nsn: idx.nsn !== -1 ? safeString(r[idx.nsn]) : null,
                            nomenclatura: idx.desc !== -1 ? safeString(r[idx.desc]) : 'N/A',
                            qtd,
                            justificativa: idx.justificativa !== -1 ? safeString(r[idx.justificativa]) : null,
                            status_item: idx.status !== -1 ? safeString(r[idx.status]) || 'ABERTO' : 'ABERTO',
                            origem: 'QNNA',
                        });
                    } else if (r.some(cell => String(cell || '').trim() !== '')) {
                        linhasIgnoradas += 1;
                        recordAuditIssue(req, {
                            linha_numero: hIdx + 2 + rawIndex,
                            campo: 'pn/qtd',
                            valor_original: `${r[idx.pn] || ''} | ${r[idx.qtd] || ''}`,
                            motivo: 'Linha ignorada no QNNA por ausência de PN válido ou quantidade nula.',
                        });
                    }
                });

                if (registros.length > 0) {
                    await supabase.from('qnna_registros').delete().eq('qnna_referencia', qnnaRef);
                    const chunkSize = 1000;
                    for (let i = 0; i < registros.length; i += chunkSize) {
                        const { error } = await supabase.from('qnna_registros').insert(registros.slice(i, i + chunkSize));
                        if (error) throw error;
                    }
                    return respondSuccess(`QNNA ${qnnaRef} atualizado com ${registros.length} registros.`, {}, {
                        tabelaAlvo: 'qnna_registros',
                        linhasLidas: Math.max(rawRows.length - (hIdx + 1), 0),
                        linhasImportadas: registros.length,
                        linhasIgnoradas,
                        detalhes: { qnna_referencia: qnnaRef },
                    });
                }
            }
            return respondError(400, 'Cabeçalhos do QNNA (PN, QTD) não identificados no arquivo.', { tabelaAlvo: 'qnna_registros' });
        }

        // ---------------------------------------------------
        // ROTA 9: SERVICE BULLETIN (SB)
        // ---------------------------------------------------
        else if (tipoArquivo === 'sb') {
            let sbNumero = 'SB-N/A';
            let titulo = req.file?.originalname || 'Service Bulletin';
            let tipoSb = 'N/A';
            let dataPublicacao = null;
            let observacao = null;
            let itensSb = [];

            if (isPdfFile) {
                const parsedSb = await parseSbPdfBuffer(req.file.buffer, req.file?.originalname || 'Service Bulletin.pdf');
                sbNumero = parsedSb.sbNumero;
                titulo = parsedSb.titulo || titulo;
                tipoSb = parsedSb.tipoSb || tipoSb;
                dataPublicacao = parsedSb.dataPublicacao || null;
                observacao = parsedSb.observacao || null;
                itensSb = parsedSb.itensSb || [];
            } else {
                const sheetName = workbook.SheetNames[0];
                const sheet = workbook.Sheets[sheetName];
                const rawRows = xlsx.utils.sheet_to_json(sheet, { header: 1, defval: '' });
                const textoCab = rawRows.slice(0, 10).map(r => r.join(' ')).join(' ').toUpperCase();
                const sbMatch = textoCab.match(/(?:SERVICE BULLETIN|\bSB\b)\s*(?:NO\.?|NUMBER|Nº|#)?\s*[:\-]?\s*([A-Z0-9\-\/]+)/i);
                if (sbMatch) sbNumero = sbMatch[1].replace(/^SB[-\s]*/i, '').toUpperCase();
                if (/ALERT|ALERTA/i.test(textoCab)) tipoSb = 'ALERTA';
                else if (/MANDATORY|MANDATORIA/i.test(textoCab)) tipoSb = 'MANDATORIA';
                else if (/OPTIONAL|OPCIONAL/i.test(textoCab)) tipoSb = 'OPCIONAL';

                const hIdx = findHeaderRow(rawRows, ['pn']);
                if (hIdx !== -1) {
                    const headers = rawRows[hIdx];
                    const idx = buildIndexMap(headers, {
                        pn: ['pn', 'part number', 'part nuber'],
                        nsn: 'nsn',
                        desc: ['nomenclatura', 'description'],
                        qtd: ['qtd', 'qty'],
                        cap: ['capitulo', 'chapter', 'dmc'],
                        item: ['item', 'item num', 'item_num'],
                        apl: ['aplicabilidade', 'applicability', 'aircraft'],
                    });

                    itensSb = rawRows.slice(hIdx + 1).map((r) => {
                        const pn = normalizePn(safeString(r[idx.pn]));
                        if (!pn) return null;
                        return {
                            sb_numero: sbNumero,
                            pn,
                            nsn: idx.nsn !== -1 ? safeString(r[idx.nsn]) : null,
                            nomenclatura: idx.desc !== -1 ? safeString(r[idx.desc]) : null,
                            qtd: idx.qtd !== -1 ? cleanCurrency(r[idx.qtd]) : 0,
                            capitulo: idx.cap !== -1 ? safeString(r[idx.cap]) : null,
                            item_num: idx.item !== -1 ? safeString(r[idx.item]) : null,
                            aplicabilidade: idx.apl !== -1 ? safeString(r[idx.apl]) : null,
                        };
                    }).filter(Boolean);
                }
            }

            const headerPayload = {
                sb_numero: sbNumero,
                titulo,
                tipo_sb: tipoSb,
                status_acao: 'SEM_ACAO',
                data_publicacao: dataPublicacao,
                observacao,
                fonte_documento: req.file?.originalname || null,
                updated_at: new Date().toISOString(),
            };

            const { error: headerError } = await supabase
                .from('service_bulletins')
                .upsert(headerPayload, { onConflict: 'sb_numero' });
            if (headerError) throw headerError;

            await supabase.from('service_bulletin_items').delete().eq('sb_numero', sbNumero);
            if (itensSb.length > 0) {
                const chunkSize = 500;
                for (let i = 0; i < itensSb.length; i += chunkSize) {
                    const { error } = await supabase.from('service_bulletin_items').insert(itensSb.slice(i, i + chunkSize));
                    if (error) throw error;
                }
            }

            return respondSuccess(`SB ${sbNumero} processada com ${itensSb.length} itens vinculados.`, {}, {
                tabelaAlvo: 'service_bulletins',
                linhasImportadas: itensSb.length,
                detalhes: { sb_numero: sbNumero, tipo_sb: tipoSb, pdf: isPdfFile },
            });
        }

        // ---------------------------------------------------
        // ROTA FINAL (FALLBACK)
        // ---------------------------------------------------
        else {
            return respondError(400, `O formato não foi reconhecido pelo radar.`, { detalhes: { tipoArquivo } });
        }

    } catch (error) { 
        console.error("ERRO NO MOTOR DE IMPORTAÇÃO:", error);
        setAuditSummary(req, { status: 'ERRO', mensagem: 'Erro crítico ao processar o arquivo no servidor.', detalhes: { erro: error.message || String(error) } });
        return res.status(500).json({ status: 'error', message: 'Erro crítico ao processar o arquivo no servidor.' }); 
    }
};

// =======================================================
// O FINALIZADOR: GRAVAÇÃO DA TRIAGEM (GARANTIA E SN)
// =======================================================
exports.confirmarTriagemRecibo = async (req, res) => {
    try {
        const respondSuccess = (message, extra = {}, audit = {}) => {
            setAuditSummary(req, { status: 'SUCESSO', mensagem: message, ...audit });
            return res.status(200).json({ status: 'success', message, ...extra });
        };

        const respondError = (statusCode, message, audit = {}) => {
            setAuditSummary(req, { status: 'ERRO', mensagem: message, ...audit });
            return res.status(statusCode).json({ status: 'error', message });
        };

        const { recibo_ref, data_entrega, is_foc, itens } = req.body;

        if (!itens || itens.length === 0) {
            return respondError(400, 'Nenhum item para processar.', { tabelaAlvo: 'estoque_ppu', detalhes: { modo: 'confirmar_triagem' } });
        }

        let dataChegadaISO = null;
        let dataGarantiaISO = null;
        
        if (data_entrega && data_entrega.includes('/')) {
            const [dia, mes, ano] = data_entrega.split('/');
            if (dia && mes && ano) {
                const dataObj = new Date(`${ano}-${mes}-${dia}T12:00:00Z`);
                dataChegadaISO = dataObj.toISOString().split('T')[0];
                dataObj.setFullYear(dataObj.getFullYear() + 2);
                dataGarantiaISO = dataObj.toISOString().split('T')[0];
            }
        }

        let insercoesPPU = [];

        for (let item of itens) {
            const qtyOriginal = Number(item.quantidade) || 0;
            let listaSns = [];
            if (item.sns_finais && item.sns_finais.trim() !== '') {
                listaSns = item.sns_finais.split(',').map(s => s.trim()).filter(Boolean);
            }

            const qtyComSn = listaSns.length;
            const qtySemSn = Math.max(0, qtyOriginal - qtyComSn);

            for (let sn of listaSns) {
                insercoesPPU.push({
                    pn: item.pn, nomenclatura: item.nomenclatura, quantidade: 1, 
                    sn: sn, localizacao: item.localizacao_ppu || `RECEBIMENTO: ${recibo_ref}`, 
                    data_chegada: dataChegadaISO, data_garantia: dataGarantiaISO
                });
            }

            if (qtySemSn > 0) {
                insercoesPPU.push({
                    pn: item.pn, nomenclatura: item.nomenclatura, quantidade: qtySemSn, 
                    sn: 'N/A', localizacao: item.localizacao_ppu || `RECEBIMENTO: ${recibo_ref}`, 
                    data_chegada: dataChegadaISO, data_garantia: null
                });
            }

            if (is_foc) {
                const { data: focAtual } = await supabase.from('leonardo_foc_spares').select('*').eq('pn', item.pn).limit(1).single();
                if (focAtual) {
                    let novoPendente = Math.max(0, focAtual.qtd_pendente - qtyOriginal);
                    await supabase.from('leonardo_foc_spares').update({ 
                        qtd_pendente: novoPendente, data_previsao_lh: `✅ ENTREGUE (${recibo_ref})` 
                    }).eq('id', focAtual.id);
                }
            }
        }

        if (insercoesPPU.length > 0) {
            await supabase.from('estoque_ppu').insert(insercoesPPU);
        }

        return respondSuccess(`Vitória! ${insercoesPPU.length} registos cravados no PPU.`, {}, { tabelaAlvo: 'estoque_ppu', linhasImportadas: insercoesPPU.length, detalhes: { modo: 'confirmar_triagem', recibo_ref, is_foc: !!is_foc } });

    } catch (error) {
        console.error("ERRO NO FINALIZADOR DE TRIAGEM:", error);
        setAuditSummary(req, { status: 'ERRO', mensagem: 'Erro crítico ao gravar os dados.', tabelaAlvo: 'estoque_ppu', detalhes: { modo: 'confirmar_triagem', erro: error.message || String(error) } });
        return res.status(500).json({ status: 'error', message: 'Erro crítico ao gravar os dados.' });
    }
};

// =======================================================
// NOVA ROTA: LEITURA DE COTAÇÕES RFQ (VIA EXCEL) - BALA DE PRATA
// =======================================================
exports.uploadRfqPdf = async (req, res) => {
    try {
        const respondSuccess = (message, extra = {}, audit = {}) => {
            setAuditSummary(req, { status: 'SUCESSO', mensagem: message, ...audit });
            return res.status(200).json({ status: 'success', message, ...extra });
        };

        const respondError = (statusCode, message, audit = {}) => {
            setAuditSummary(req, { status: 'ERRO', mensagem: message, ...audit });
            return res.status(statusCode).json({ status: 'error', message });
        };

        if (!req.file) return respondError(400, 'Nenhum ficheiro enviado.', { tabelaAlvo: 'rfq_cotacoes', detalhes: { modo: 'rfq_leitura' } });

        const workbook = xlsx.read(req.file.buffer, { type: 'buffer' });
        
        let textoEstruturado = '';
        for (const sheetName of workbook.SheetNames) {
            const sheet = workbook.Sheets[sheetName];
            const rawRows = xlsx.utils.sheet_to_json(sheet, { header: 1, defval: '' });
            rawRows.forEach(r => {
                const linhaLimpa = r.map(c => String(c).replace(/\r?\n/g, ' ').trim()).filter(c => c !== '').join(' | ');
                if (linhaLimpa) textoEstruturado += linhaLimpa + ' ';
            });
        }

        const textoFlat = textoEstruturado.replace(/\s+/g, ' ');

        const quoteMatch = textoFlat.match(/Number\/Date\s*\|?\s*([A-Z0-9-]+)\s*\/\s*([\d.]+)/i);
        const refMatch = textoFlat.match(/Reference no\.\/Date\s*\|?\s*([^/]+)\s*\//i);
        const valMatch = textoFlat.match(/Validity period\s*\|?\s*([\d.]+\s*to\s*[\d.]+)/i);

        const metadados = {
            quotation_number: quoteMatch ? quoteMatch[1].trim() : 'N/A',
            quotation_date: quoteMatch ? quoteMatch[2].trim() : 'N/A',
            reference: refMatch ? refMatch[1].trim() : 'N/A',
            validity: valMatch ? valMatch[1].trim().replace('to', 'a') : 'N/A',
            condicao: 'New'
        };

        let itemsExtraidos = [];
        const qtyRegex = /(\d+(?:[.,]\d{3})?)\s*N\b/g;
        const matches = [...textoFlat.matchAll(qtyRegex)];

        for (let i = 0; i < matches.length; i++) {
            let start = i === 0 ? 0 : matches[i-1].index + matches[i-1][0].length;
            let end = matches[i].index;
            let middleText = textoFlat.substring(start, end);

            if (i === 0) {
                const cabecalhoFim = Math.max(middleText.lastIndexOf('Value'), middleText.lastIndexOf('V_a_lu_e_'), middleText.lastIndexOf('Price'));
                if (cabecalhoFim !== -1) middleText = middleText.substring(cabecalhoFim + 9);
            }

            // NOVA BALA DE PRATA: Extrair a Quantidade Solicitada da nossa âncora
            const qtdString = matches[i][1].replace(/\./g, '').replace(',', '.'); // Ex: "1.000" vira 1000
            const qtdSolicitada = parseFloat(qtdString) || 0;

            let precoUnitario = 0;
            let textAfter = textoFlat.substring(end + matches[i][0].length, end + matches[i][0].length + 50);
            const priceMatch = textAfter.match(/^\s*\|?\s*([\d,]+\.\d{2})/);
            if (priceMatch) {
                precoUnitario = parseFloat(priceMatch[1].replace(/,/g, ''));
            } else {
                const fallbackMatch = middleText.match(/([\d,]+\.\d{2})\s*\|?\s*$/);
                if (fallbackMatch) precoUnitario = parseFloat(fallbackMatch[1].replace(/,/g, ''));
            }

            const nsnMatch = middleText.match(/\b\d{4}-\d{2}-\d{3}-\d{4}\b/);
            const nsn = nsnMatch ? nsnMatch[0] : '';

            let textNoNsn = middleText.replace(/\b\d{4}-\d{2}-\d{3}-\d{4}\b/g, ' ').replace(/\b\d{2}\.\d{2}\.\d{4}\b/g, ' ');
            const pnMatches = [...textNoNsn.matchAll(/\b([A-Z0-9-./]{4,})\b/g)].map(m => m[1]);
            const palavrasIgnoradas = ['MATERIAL', 'NUMBER', 'DATE', 'VALIDITY', 'PERIOD', 'LEAD', 'TIME', 'STOCK', 'QUANTITY', 'AVAILABLE', 'PRICE', 'VALUE', 'TOTAL', 'AMOUNT', 'PAGE', 'ITEM', 'DESCRIPTION', 'REFERENCE', 'UNDER', 'INVESTIGATION', 'AWAITING', 'EACH', 'DAYS', 'WEEKS'];
            
            let pn = '';
            for (let p of pnMatches) {
                const pUpper = p.toUpperCase();
                if (/\d/.test(pUpper) && !/^\d+$/.test(pUpper) && !palavrasIgnoradas.includes(pUpper)) {
                    pn = pUpper; break;
                }
            }

            const stockMatch = middleText.match(/Quantity\s+(\d+(?:\.\d+)?)/i);
            const estoque = stockMatch ? parseFloat(stockMatch[1]) : 0;

            let cleanText = middleText.replace(/\b\d{1,3}(?:,\d{3})*\.\d{2}\b/g, ' ').replace(/\b[A-Z0-9-./]{4,}\b/ig, ' ').replace(/Quantity\s+\d+(?:\.\d+)?/ig, ' '); 
            const intMatches = [...cleanText.matchAll(/\b(\d{1,3})\b/g)].map(m => parseInt(m[1]));
            let leadSemanas = intMatches.length > 0 ? Math.max(...intMatches) : 0;
            if (leadSemanas < 10 && leadSemanas <= i + 2) leadSemanas = 0;
            const leadDias = leadSemanas > 0 ? leadSemanas * 7 : 0;

            let descricaoLimpada = middleText.replace(pn, '').replace(nsn, '').replace(/\b\d{1,3}(?:,\d{3})*\.\d{2}\b/g, '').replace(/Available Stock Quantity\s+\d+(?:\.\d+)?/ig, '').replace(/\b\d{1,3}\b/g, '').replace(/\|/g, '').replace(/Under Investigation/ig, '').replace(/Awaiting Price/ig, '').replace(/\s+/g, ' ').trim();

            if (pn !== '' || precoUnitario > 0) {
                itemsExtraidos.push({
                    item_num: i + 1,
                    pn: pn,
                    nsn: nsn,
                    nomenclatura: descricaoLimpada.toUpperCase() || '',
                    qtd_solicitada: qtdSolicitada, // <-- DADO NOVO INJETADO
                    lead_time: leadDias,
                    estoque_pronto: estoque,
                    valor_unitario: precoUnitario
                });
            }
        }

        return respondSuccess(`Excel lido! ${itemsExtraidos.length} peças extraídas.`, {
            metadados: metadados,
            items: itemsExtraidos
        }, { tabelaAlvo: 'rfq_cotacoes', linhasImportadas: itemsExtraidos.length, detalhes: { modo: 'rfq_leitura', quotation_number: metadados.quotation_number } });
    } catch (error) {
        console.error("Erro RFQ:", error);
        setAuditSummary(req, { status: 'ERRO', mensagem: 'Falha no processamento.', tabelaAlvo: 'rfq_cotacoes', detalhes: { modo: 'rfq_leitura', erro: error.message || String(error) } });
        return res.status(500).json({ status: 'error', message: 'Falha no processamento.' });
    }
};
// =======================================================
// ROTA FINAL: GRAVAR COTAÇÃO RFQ VALIDADA NO BANCO
// =======================================================
exports.salvarRfqDefinitivo = async (req, res) => {
    try {
        const respondSuccess = (message, extra = {}, audit = {}) => {
            setAuditSummary(req, { status: 'SUCESSO', mensagem: message, ...audit });
            return res.status(200).json({ status: 'success', message, ...extra });
        };

        const respondError = (statusCode, message, audit = {}) => {
            setAuditSummary(req, { status: 'ERRO', mensagem: message, ...audit });
            return res.status(statusCode).json({ status: 'error', message });
        };

        const { metadados, items } = req.body;

        if (!items || items.length === 0) {
            return respondError(400, 'Nenhum item para gravar.', { tabelaAlvo: 'rfq_cotacoes', detalhes: { modo: 'rfq_salvar' } });
        }

        // Mapear os dados do Frontend para as colunas do Supabase
        const insercoes = items.map(item => ({
            cotacao_numero: metadados.quotation_number,
            data_cotacao: metadados.quotation_date,
            validade: metadados.validity,
            referencia_pedido: metadados.reference,
            pn: item.pn,
            nsn: item.nsn,
            nomenclatura: item.nomenclatura,
            qtd_solicitada: item.qtd_solicitada || 0,
            lead_time_dias: item.lead_time || 0,
            estoque_pronto: item.estoque_pronto || 0,
            valor_unitario: item.valor_unitario || 0,
            data_insercao: new Date().toISOString()
        }));

        // Injeta no Cofre (Certifique-se de criar esta tabela no Supabase com estas colunas!)
        const { error } = await supabase.from('rfq_cotacoes').insert(insercoes);

        if (error) throw error;

        return respondSuccess(`Vitória! ${insercoes.length} itens da Cotação ${metadados.quotation_number} cravados no cofre.`, {}, { tabelaAlvo: 'rfq_cotacoes', linhasImportadas: insercoes.length, detalhes: { modo: 'rfq_salvar', quotation_number: metadados.quotation_number } });

    } catch (error) {
        console.error("ERRO AO SALVAR RFQ:", error);
        setAuditSummary(req, { status: 'ERRO', mensagem: 'Erro crítico ao gravar a Cotação no banco de dados.', tabelaAlvo: 'rfq_cotacoes', detalhes: { modo: 'rfq_salvar', erro: error.message || String(error) } });
        return res.status(500).json({ status: 'error', message: 'Erro crítico ao gravar a Cotação no banco de dados.' });
    }
};

exports.listImportLogs = async (req, res) => {
    try {
        const { data, error } = await supabase
            .from('import_logs')
            .select('id, tipo_arquivo, nome_arquivo, status, tabela_alvo, linhas_lidas, linhas_importadas, linhas_ignoradas, mensagem, uploaded_by_email, uploaded_by_role, created_at, finished_at')
            .order('created_at', { ascending: false })
            .limit(20);

        if (error) throw error;

        return res.status(200).json({ status: 'success', data: data || [] });
    } catch (error) {
        return res.status(500).json({ status: 'error', message: 'Falha ao consultar logs de importação.' });
    }
};
