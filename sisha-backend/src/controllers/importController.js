// src/controllers/importController.js
const xlsx = require('xlsx');
const crypto = require('crypto');
const supabase = require('../config/supabaseClient');
const pdfParse = require('pdf-parse'); // <-- Motor de PDF adicionado no topo
const { findHeaderRow, buildIndexMap, normalizePn } = require('../utils/importAliases');
const { setAuditSummary, recordAuditIssue } = require('../utils/importAudit');
const { registrarAuditoria } = require('../utils/auditLogger');
const { reconcileOrderBookPds } = require('../services/orderBookReconciliationService');
const { syncOrderBookEquipmentTrace } = require('../services/orderBookEquipmentService');
const { saveReceipt } = require('../services/receiptService');
const { parseReceiptDocument } = require('../services/receiptDocumentParser');
const { parseRfqDocument } = require('../services/rfqParserService');
const { createRfqImportJob, getRfqImportJob, listRfqImportJobs, reprocessRfqImportJob, discardRfqImportJob, markRfqImportJobSaved } = require('../services/rfqImportJobService');
const { markRequestsAnswered } = require('../services/quoteRequestService');
const { parseAvailabilityWorkbookBuffer, importAvailabilityAtomic } = require('../services/aircraftAvailabilityService');
const { parsePpuInventoryRows } = require('../services/ppuInventoryParserService');
const { parseRunningLogWorkbook, importRunningLogAtomic } = require('../services/aircraftRunningLogService');
const { parseCriticalEquipmentWorkbook, parsePpuOutputMovementWorkbook, parseMasterOsWorkbook } = require('../services/rawOperationalDocumentParserService');
const { importPpuInventoryEquipmentSnapshot, importCriticalEquipmentControl, importPpuOutputHistory } = require('../services/rawOperationalDocumentImportService');
const { importMasterOsHistory } = require('../services/masterOsImportService');
const { parsePpuExternalCustodyWorkbook } = require('../services/ppuExternalCustodyParserService');
const { importExternalCustodySnapshot, saveReconciliationDecision } = require('../services/ppuExternalCustodyService');
const { getExternalCustodyReconciliation } = require('../services/ppuEffectiveAvailabilityService');

const cleanCurrency = (val) => val ? parseFloat(String(val).replace(/[^0-9.,]/g, '').replace(',', '.')) || 0 : 0;
const safeString = (val) => val ? String(val).trim() : null;

const isGenericReceiptNumber = (value) => {
    const normalized = String(value || '').trim().toUpperCase();
    return !normalized || ['N/A', 'NA', 'SEM NÚMERO', 'SEM NUMERO', 'S/N'].includes(normalized);
};

const buildReceiptReference = ({ numero, file, tipo = 'RECIBO', data = null }) => {
    if (!isGenericReceiptNumber(numero)) return String(numero).trim();

    const content = file?.buffer || Buffer.from(`${file?.originalname || 'arquivo'}|${file?.size || 0}`);
    const digest = crypto.createHash('sha256').update(content).digest('hex').slice(0, 12).toUpperCase();
    const safeType = String(tipo || 'RECIBO').toUpperCase().replace(/[^A-Z0-9]+/g, '-').replace(/^-|-$/g, '') || 'RECIBO';
    const safeDate = String(formatDbDate(data) || 'SEM-DATA').replace(/[^0-9A-Z-]+/gi, '-');
    return `SEM-NUMERO-${safeType}-${safeDate}-${digest}`.slice(0, 120);
};

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


const rawPayloadFromRow = (headers = [], row = []) => {
    const payload = {};
    headers.forEach((header, index) => {
        const key = String(header || '').trim() || `COL_${index + 1}`;
        if (!key) return;
        const value = row[index];
        if (value !== undefined && value !== null && String(value).trim() !== '') {
            payload[key] = value;
        }
    });
    return payload;
};

const safeCell = (row = [], index = -1) => (index >= 0 ? row[index] : null);

const ORDER_BOOK_MONTHS = {
    january: 1, february: 2, march: 3, april: 4, may: 5, june: 6,
    july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
};

const extractOrderBookSnapshotDate = (rawRows = []) => {
    const text = rawRows.slice(0, 12).flat().map(v => String(v || '').trim()).filter(Boolean).join(' ');
    const match = text.match(/\b(January|February|March|April|May|June|July|August|September|October|November|December)\s+(20\d{2})\b/i);
    if (!match) return null;
    const month = ORDER_BOOK_MONTHS[String(match[1]).toLowerCase()];
    const year = Number(match[2]);
    if (!month || !year) return null;
    const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
    return `${year}-${String(month).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;
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
        const originalNameLower = String(req.file?.originalname || '').toLowerCase();
        const isPdfFile = originalNameLower.endsWith('.pdf') || req.file?.mimetype === 'application/pdf';
        const isLegacyDocFile = originalNameLower.endsWith('.doc');
        let workbook = null;
        const getWorkbook = () => {
            if (!workbook) {
                workbook = xlsx.read(req.file.buffer, { type: 'buffer' });
                setAuditSummary(req, {
                    detalhes: {
                        planilha: {
                            abas_encontradas: Array.isArray(workbook.SheetNames) ? workbook.SheetNames.length : 0,
                            nomes_abas: Array.isArray(workbook.SheetNames) ? workbook.SheetNames.slice(0, 60) : [],
                        },
                    },
                });
            }
            return workbook;
        };

        const receiptUsesLegacyDoc = ['recibo_material', 'recibo_pd'].includes(tipoArquivo) && isLegacyDocFile;
        if (!(tipoArquivo === 'sb' && isPdfFile) && !receiptUsesLegacyDoc) {
            workbook = getWorkbook();
        }

        // ---------------------------------------------------
        // ROTA 1: INVENTÁRIO PPU
        // ---------------------------------------------------
        if (tipoArquivo === 'inventario_ppu') {
            const sheetName = workbook.SheetNames[0];
            const sheet = workbook.Sheets[sheetName];
            const rawRows = xlsx.utils.sheet_to_json(sheet, { header: 1, defval: '' });
            const parsed = parsePpuInventoryRows(rawRows);
            const estoqueAtualizado = (parsed.items || []).map((item) => ({
                pn: item.pn,
                nsn_pi: item.nsn_pi || 'N/A',
                nomenclatura: item.nomenclatura || 'N/A',
                quantidade: Number(item.quantidade || 0),
                localizacao: item.localizacao || 'NÃO DEFINIDO',
                sn: item.sn || null,
            }));

            (parsed.issues || []).slice(0, 500).forEach((issue) => {
                recordAuditIssue(req, {
                    linha_numero: issue.row,
                    campo: issue.field || 'linha',
                    valor_original: issue.value,
                    motivo: issue.reason || 'Linha não importada no inventário PPU.',
                });
            });

            if (estoqueAtualizado.length > 0) {
                // Sentinelas geradas pelo parser representam ambiguidade documental, não uma LOC
                // operacional disponível. São excluídas do PPU sem inferir reparo/lixo/CEIMSPA.
                const technicalReviewLocations = ['NÃO DEFINIDO', 'CONFLITO DE LOCALIZAÇÃO']
                    .filter((location) => estoqueAtualizado.some((item) => item.localizacao === location));

                if (technicalReviewLocations.length > 0) {
                    const { data: existingPolicies, error: existingPolicyError } = await supabase
                        .from('ppu_localizacoes_config')
                        .select('localizacao_normalizada')
                        .in('localizacao_normalizada', technicalReviewLocations);
                    if (existingPolicyError) throw existingPolicyError;

                    const existing = new Set((existingPolicies || []).map((row) => String(row.localizacao_normalizada || '').trim().toUpperCase()));
                    const missingTechnicalPolicies = technicalReviewLocations.filter((location) => !existing.has(location));
                    if (missingTechnicalPolicies.length > 0) {
                        const now = new Date().toISOString();
                        const { error: policyError } = await supabase
                            .from('ppu_localizacoes_config')
                            .insert(missingTechnicalPolicies.map((location) => ({
                                localizacao_normalizada: location,
                                localizacao_exibicao: location,
                                contabiliza_ppu: false,
                                ativo: true,
                                destino_contabilizacao: 'FORA_LINHA',
                                situacao_operacional: 'A_CONFIRMAR',
                                observacao: location === 'CONFLITO DE LOCALIZAÇÃO'
                                    ? 'PN+SN aparece em mais de uma localização no relatório oficial. Revisão Admin/Dono obrigatória.'
                                    : 'Relatório oficial não informou localização física. Revisão Admin/Dono obrigatória.',
                                updated_by_email: req.user?.email || null,
                                updated_at: now,
                            })));
                        if (policyError) throw policyError;
                    }
                }

                const { error: deleteError } = await supabase
                    .from('estoque_ppu')
                    .delete()
                    .neq('pn', 'LIMPEZA');

                if (deleteError) throw deleteError;

                const chunkSize = 1000;
                for (let i = 0; i < estoqueAtualizado.length; i += chunkSize) {
                    const lote = estoqueAtualizado.slice(i, i + chunkSize);
                    const { error: insertError } = await supabase.from('estoque_ppu').insert(lote);
                    if (insertError) throw insertError;
                }

                const equipamentos = (parsed.items || []).filter((item) => item.source_section === 'EQUIPAMENTOS');
                const sobressalentes = (parsed.items || []).filter((item) => item.source_section === 'SOBRESSALENTES');
                const equipamentosSerializados = equipamentos.filter((item) => item.sn);
                const equipamentosComSn = equipamentosSerializados.length;
                const qtdTotal = estoqueAtualizado.reduce((acc, item) => acc + Number(item.quantidade || 0), 0);

                let ledgerSync = null;
                if (equipamentosSerializados.length > 0) {
                    ledgerSync = await importPpuInventoryEquipmentSnapshot({ items: equipamentosSerializados }, {
                        buffer: req.file.buffer,
                        fileName: req.file.originalname || 'InventarioPPUGeralLoc.xls',
                        user: req.user || {},
                    });
                }

                return respondSuccess(`Inventário PPU atualizado com ${estoqueAtualizado.length} linha(s)!`, {}, {
                    tabelaAlvo: 'estoque_ppu',
                    linhasLidas: rawRows.length,
                    linhasImportadas: estoqueAtualizado.length,
                    linhasIgnoradas: (parsed.issues || []).filter((issue) => issue.field === 'pn').length,
                    detalhes: {
                        formato_detectado: parsed.format,
                        equipamentos: equipamentos.length,
                        equipamentos_com_sn: equipamentosComSn,
                        sobressalentes: sobressalentes.length,
                        quantidade_total: Number(qtdTotal.toFixed(6)),
                        localizacoes_detectadas: (parsed.locations || []).length,
                        aviso_localizacao: 'Novas localizações entram no painel de Localizações do PPU. Classificação operacional permanece decisão Admin/Dono.',
                        livro_equipamentos: ledgerSync ? {
                            inseridos: ledgerSync.created_identities || 0,
                            existentes: ledgerSync.existing_identities || 0,
                            conflitos_localizacao: ledgerSync.conflicts || 0,
                            eventos_localizacao: ledgerSync.events || 0,
                            localizacao_igual: ledgerSync.same || 0,
                            ignorados_sem_localizacao_segura: ledgerSync.ignored || 0,
                        } : null,
                        completude: {
                            linhas_fisicas_primeira_aba: rawRows.length,
                            linhas_operacionais_reconhecidas: estoqueAtualizado.length,
                            pendencias_parser: (parsed.issues || []).length,
                            parser_concluido: true,
                        },
                    },
                });
            }

            return respondError(400, 'Falha ao ler o inventário PPU. O SISHA aceita o relatório bruto “Inventário Geral do PPU por Localização” ou o formato tabular legado com PN e QTD.', {
                tabelaAlvo: 'estoque_ppu',
                linhasLidas: rawRows.length,
                linhasIgnoradas: (parsed.issues || []).length,
                detalhes: { formato_detectado: parsed.format },
            });
        }

        // ---------------------------------------------------
        // CUSTÓDIA EXTERNA PPU — CAIXAS NO CEIMSPA
        // ---------------------------------------------------
        else if (tipoArquivo === 'custodia_externa_ppu') {
            const parsed = parsePpuExternalCustodyWorkbook(xlsx, getWorkbook());
            if (!parsed.boxes.length) return respondError(400, 'Nenhuma aba FECHADA CX-XXX foi reconhecida no Backend_Auditoria_Paiol.', {
                tabelaAlvo: 'ppu_custodia_externa_importacoes/itens',
                linhasIgnoradas: parsed.issues.length,
            });

            const imported = await importExternalCustodySnapshot(parsed, {
                buffer: req.file.buffer,
                fileName: req.file.originalname || 'Backend_Auditoria_Paiol.xlsx',
                user: req.user || {},
            });
            const reconciliation = await getExternalCustodyReconciliation().catch(() => ({ summary: {}, rows: [] }));
            (parsed.issues || []).slice(0, 500).forEach((issue) => recordAuditIssue(req, {
                linha_numero: issue.row || null,
                campo: issue.field || 'linha',
                valor_original: issue.sheet || issue.value || null,
                motivo: issue.reason,
            }));

            const pendingReadText = parsed.issues.length
                ? ` Atenção: ${parsed.issues.length} linha(s) bloqueada(s) na leitura; consulte as pendências antes de considerar a carga completa.`
                : '';
            return respondSuccess(`Custódia externa PPU atualizada: ${parsed.summary.boxes_with_items} caixa(s) com material, ${parsed.summary.item_rows} linha(s) válidas, ${parsed.summary.total_quantity} un declaradas.${pendingReadText}`, {
                data: {
                    importacao: imported,
                    reconciliacao: reconciliation.summary || {},
                    pendencias_leitura: (parsed.issues || []).slice(0, 100),
                },
            }, {
                tabelaAlvo: 'ppu_custodia_externa_importacoes/itens',
                linhasLidas: parsed.summary.item_rows,
                linhasImportadas: parsed.summary.item_rows,
                linhasIgnoradas: parsed.issues.length,
                detalhes: {
                    ...parsed.summary,
                    import_id: imported.import_id || null,
                    arquivo_reutilizado: Boolean(imported.reused),
                    reconciliacao: reconciliation.summary || {},
                    regra_custodia: 'Local físico CEIMSPA; custódia e contabilização permanecem PPU.',
                },
            });
        }

        // ---------------------------------------------------
        // FONTES OPERACIONAIS BRUTAS — EQUIPAMENTOS CRÍTICOS
        // ---------------------------------------------------
        else if (tipoArquivo === 'controle_equipamentos_criticos') {
            const parsed = parseCriticalEquipmentWorkbook(xlsx, getWorkbook());
            if (!parsed.items.length) return respondError(400, 'Nenhuma linha PN+SN reconhecida no Controle de Equipamentos Críticos.', {
                tabelaAlvo: 'equipamentos_serializados/equipamento_eventos',
                linhasIgnoradas: parsed.issues.length,
            });
            const result = await importCriticalEquipmentControl(parsed, {
                buffer: req.file.buffer,
                fileName: req.file.originalname || 'Controle de Equipamentos Criticos.ods',
                user: req.user || {},
            });
            (parsed.issues || []).slice(0, 500).forEach((issue) => recordAuditIssue(req, {
                linha_numero: issue.row || null,
                campo: 'PN/SN/LOCAL',
                valor_original: issue.sheet || null,
                motivo: issue.reason,
            }));
            return respondSuccess(`Controle de Equipamentos Críticos processado: ${parsed.items.length} PN+SN; ${result.conflicts} conflito(s) de localização aguardando Admin/Dono.`, { data: result }, {
                tabelaAlvo: 'equipamentos_serializados/equipamento_eventos',
                linhasLidas: parsed.items.length + parsed.issues.length,
                linhasImportadas: parsed.items.length,
                linhasIgnoradas: parsed.issues.length,
                detalhes: {
                    ...parsed.summary,
                    ...result,
                    completude: {
                        linhas_reconhecidas: parsed.items.length,
                        linhas_pendentes: parsed.issues.length,
                        abas_com_tabela_reconhecida: parsed.summary?.sheets || 0,
                        parser_concluido: true,
                    },
                    regra_conflito: 'Sem data operacional inequívoca, fonte especializada não sobrescreve Inventário PPU; cria reconciliação.',
                },
            });
        }

        // ---------------------------------------------------
        // FONTES OPERACIONAIS BRUTAS — SAÍDA/MOVIMENTAÇÃO PPU
        // ---------------------------------------------------
        else if (tipoArquivo === 'saida_movimentacao_ppu') {
            const parsed = parsePpuOutputMovementWorkbook(xlsx, getWorkbook());
            if (!parsed.items.length) return respondError(400, 'Nenhuma movimentação PN+SN válida foi reconhecida no relatório de Saída do PPU.', {
                tabelaAlvo: 'equipamento_eventos',
                linhasIgnoradas: parsed.issues.length,
            });
            const result = await importPpuOutputHistory(parsed, {
                buffer: req.file.buffer,
                fileName: req.file.originalname || 'SaidaMovimentacaoPorPeriodo.xls',
                user: req.user || {},
            });
            (parsed.issues || []).slice(0, 500).forEach((issue) => recordAuditIssue(req, {
                linha_numero: issue.row || null,
                campo: 'PN/SN/DATA',
                valor_original: null,
                motivo: issue.reason,
            }));
            return respondSuccess(`Saída histórica do PPU processada: ${result.events} evento(s) PN+SN preservado(s).`, { data: result }, {
                tabelaAlvo: 'equipamento_eventos',
                linhasLidas: parsed.items.length + parsed.issues.length,
                linhasImportadas: result.events,
                linhasIgnoradas: parsed.issues.length,
                detalhes: { ...parsed.summary, ...result, regra_estado_atual: 'Histórico não redefine localização atual por inferência.' },
            });
        }

        // ---------------------------------------------------
        // MASTER OS — FONTE OFICIAL DA DIVISÃO DE PLANEJAMENTO
        // ---------------------------------------------------
        else if (tipoArquivo === 'master_os') {
            const parsed = parseMasterOsWorkbook(xlsx, getWorkbook());
            if (!parsed.items.length) return respondError(400, 'Nenhuma OS histórica canônica foi reconhecida no Master OS.', {
                tabelaAlvo: 'os_master_evidencias/equipamento_eventos',
                linhasLidas: parsed.issues.length,
                linhasIgnoradas: parsed.issues.length,
                detalhes: { ...parsed.summary, parser_concluido: true },
            });

            const result = await importMasterOsHistory(parsed, {
                buffer: req.file.buffer,
                fileName: req.file.originalname || 'Master OS.xlsx',
                user: req.user || {},
            });

            (parsed.issues || []).slice(0, 500).forEach((issue) => recordAuditIssue(req, {
                linha_numero: issue.row || null,
                campo: 'OS/ANO/DOMINIO/MOVIMENTO',
                valor_original: issue.os || issue.sheet || null,
                motivo: issue.reason,
            }));

            const blockedIssues = Number(parsed.summary.blocking_issues || 0);
            const warningIssues = Number(parsed.summary.warnings || 0);
            const orchestration = result.orquestracao_equipamentos || {};
            const movements = Number(orchestration.movimentos_confirmados || 0)
                + Number(orchestration.confirmacoes_mesma_localizacao || 0)
                + Number(orchestration.historicos_sem_regressao || 0);
            const pendings = Number(orchestration.pendencias_identidade || 0)
                + Number(orchestration.pendencias_destino || 0)
                + Number(orchestration.pendencias_ambiguidade || 0)
                + Number(orchestration.conflitos_intervalo_a2 || 0);

            const pendingText = (blockedIssues || warningIssues || pendings)
                ? ` ${blockedIssues} linha(s) bloqueada(s), ${warningIssues} alerta(s) documental(is) e ${pendings} pendência(s) de orquestração foram preservados para revisão.`
                : '';

            return respondSuccess(
                `MASTER OS processado: ${parsed.items.length} OS canônica(s); ${movements} movimentação(ões) física(s) confirmada(s)/histórica(s) a partir de OS FECHADA(S); ${Number(orchestration.intencoes_registradas || 0)} intenção(ões) de OS ABERTA e ${Number(orchestration.cancelamentos_registrados || 0)} cancelamento(s) preservado(s).${pendingText}`,
                { data: result },
                {
                    tabelaAlvo: 'os_master_evidencias/equipamento_eventos/v_sisha_os_historico_atual',
                    linhasLidas: parsed.items.length + blockedIssues,
                    linhasImportadas: parsed.items.length,
                    linhasIgnoradas: blockedIssues,
                    detalhes: {
                        ...parsed.summary,
                        ...result,
                        completude: {
                            abas_encontradas: parsed.summary.sheets_total,
                            abas_operacionais_reconhecidas: parsed.summary.sheets_recognized,
                            abas_derivadas_ou_ignoradas: parsed.summary.sheets_ignored,
                            os_canonicas_processadas: parsed.items.length,
                            pendencias_bloqueadas: blockedIssues,
                            alertas_auditaveis: warningIssues,
                            parser_concluido: true,
                        },
                        regra_master_os: {
                            fonte: 'Divisão de Planejamento — fonte oficial de abertura, acompanhamento, fechamento e cancelamento de OS.',
                            aberta: 'Registra intenção/escrituração. Não altera localização física.',
                            cancelada: 'Preserva a intenção e o cancelamento. Não altera localização física.',
                            fechada: 'Confirma localização/movimentação quando ação, equipamento PN+SN e destino forem inequívocos. Se já houver A2 mais detalhado, o Master corrobora/fecha o intervalo compatível sem inventar posição, contador ou motivo de falha.',
                            temporal: 'Evidência fechada mais antiga que a localização física já comprovada entra apenas como histórico; nunca faz o item regredir.',
                        },
                        regra_orquestracao: 'Master OS, PPU, PIM, STC, WO, PD e Recibos convergem no histórico do SISHA. Nenhuma fonte apaga trilha anterior; conflito/ambiguidade falha fechado.',
                        regra_bd_master: 'BD_MASTER, CORRETIVAS e PREVENTIVAS são derivadas e não são importadas para evitar duplicidade; o SISHA lê as abas operacionais.',
                    },
                },
            );
        }

        // ---------------------------------------------------
        // CONTROLE DE INSPEÇÃO — usa o mesmo ledger A1.1
        // ---------------------------------------------------
        else if (tipoArquivo === 'controle_inspecao') {
            const parsed = parseAvailabilityWorkbookBuffer(req.file.buffer, req.file.originalname || 'CONTROLE INSPEÇÃO.xlsx');
            const result = await importAvailabilityAtomic(parsed, {
                buffer: req.file.buffer,
                fileName: req.file.originalname || 'CONTROLE INSPEÇÃO.xlsx',
                user: req.user || {},
                requestId: req.requestId || req.auditContext?.requestId || null,
            });
            return respondSuccess(`Controle de Inspeção processado: ${parsed.summary.aircraft_count} aeronave(s) e ${parsed.summary.indicators} indicador(es) técnicos.`, { data: result, warnings: parsed.warnings || [] }, {
                tabelaAlvo: 'aircraft_availability_snapshots/aircraft_maintenance_indicators',
                linhasImportadas: parsed.summary.aircraft_count,
                detalhes: { source_sha256: result.source_sha256, indicadores: parsed.summary.indicators, warnings: parsed.warnings || [] },
            });
        }

        // ---------------------------------------------------
        // A1.2 — LIVRO DOS MOTORES / RUNNING LOG
        // ---------------------------------------------------
        else if (tipoArquivo === 'livro_motores') {
            const parsed = parseRunningLogWorkbook(getWorkbook(), req.file.originalname || 'LIVRO DOS MOTORES.xlsx');
            if (!parsed.snapshots.length) return respondError(400, 'Nenhum snapshot com data observacional confiável foi reconhecido no LIVRO DOS MOTORES.', {
                tabelaAlvo: 'aircraft_running_log_snapshots',
                linhasIgnoradas: parsed.issues.length,
            });
            const result = await importRunningLogAtomic(parsed, {
                buffer: req.file.buffer,
                fileName: req.file.originalname || 'LIVRO DOS MOTORES.xlsx',
                user: req.user || {},
                requestId: req.requestId || req.auditContext?.requestId || null,
            });
            (parsed.issues || []).slice(0, 500).forEach((issue) => recordAuditIssue(req, {
                linha_numero: issue.row || null,
                campo: 'DATA/HORAS/CICLOS',
                valor_original: issue.aircraft_code || issue.source_sheet || null,
                motivo: issue.reason,
            }));
            return respondSuccess(`LIVRO DOS MOTORES processado: ${parsed.summary.snapshots} snapshot(s) de ${parsed.summary.aircraft_count} aeronave(s).`, { data: result }, {
                tabelaAlvo: 'aircraft_running_log_snapshots',
                linhasImportadas: parsed.summary.snapshots,
                linhasIgnoradas: parsed.issues.length,
                detalhes: {
                    source_sha256: result.source_sha256,
                    regra: 'Horas/ciclos permanecem evidência histórica. Não alteram PN/SN ou TBO sem vínculo Admin/Dono.',
                },
            });
        }

        // ---------------------------------------------------
        // ROTA 2: ORDER BOOK DA LEONARDO
        // ---------------------------------------------------
        else if (tipoArquivo === 'order_book') {
            let allSpares = [], allFoc = [], allRepairs = [], allAdminDocs = [];
            const orderBookTraceRows = [];
            const orderBookDeliveryRows = [];
            // Evidência quantitativa efêmera de TODOS os PDs do Order Book.
            // Diferente de leonardo_spares (snapshot operacional pendente), esta coleção
            // também preserva linhas já 100% entregues para evoluir o PD canônico.
            const orderBookPdEvidenceRows = [];
            let pnsToRegister = new Map();

            for (const sheetName of workbook.SheetNames) {
                const sheet = workbook.Sheets[sheetName];
                const rawRows = xlsx.utils.sheet_to_json(sheet, { header: 1, defval: '' });
                const nameLower = sheetName.toLowerCase();
                const orderBookSnapshotDate = extractOrderBookSnapshotDate(rawRows);
                
                // SPARES
                if (nameLower.includes('spare') && !nameLower.includes('foc')) {
                    let hIdx = findHeaderRow(rawRows, ['pn', 'qtd']);
                    if (hIdx !== -1) {
                        const headers = rawRows[hIdx];
                        const idx = buildIndexMap(headers, {
                            pd: 'pd',
                            oc: 'oc',
                            custPoItem: ['cust po item', 'customer po item'],
                            pn: 'pn',
                            desc: 'nomenclatura',
                            salesOrder: ['sales order'],
                            salesOrderItem: ['s/o item', 'sales order item'],
                            soLoad: ['so load'],
                            val: 'price',
                            total: ['total'],
                            req: 'qtd',
                            date: 'delivery',
                            categoria: 'categoria',
                            onDelivery: 'on_delivery',
                            inShipment: 'in_shipment',
                            delivered: 'delivered',
                            notDelivered: 'not_delivered',
                        });
                        
                        rawRows.slice(hIdx + 1).forEach((r, offset) => {
                            const pn = normalizePn(safeString(safeCell(r, idx.pn)));
                            const pdRef = safeString(safeCell(r, idx.pd)) || 'N/A';
                            const ocRef = safeString(safeCell(r, idx.oc)) || 'N/A';
                            const categoryInfo = safeString(safeCell(r, idx.categoria));
                            const qtdComprada = cleanCurrency(safeCell(r, idx.req));
                            const qtdEntregue = cleanCurrency(safeCell(r, idx.delivered));
                            const qtdEmRota = cleanCurrency(safeCell(r, idx.inShipment));
                            const qtdAguardandoColeta = cleanCurrency(safeCell(r, idx.onDelivery));
                            const saldoPendente = (idx.notDelivered !== -1 && safeCell(r, idx.notDelivered) !== '')
                                ? cleanCurrency(safeCell(r, idx.notDelivered))
                                : Math.max(0, qtdComprada - qtdEntregue);
                            const validSpareRow = pn && pn.toLowerCase() !== 'part number' && (!categoryInfo || !categoryInfo.includes('5-'));

                            if (validSpareRow && pdRef !== 'N/A') {
                                // Não persiste como estoque ODA quando o saldo é zero, mas continua
                                // sendo evidência positiva do ciclo do PD (inclusive entrega parcial/total).
                                orderBookPdEvidenceRows.push({
                                    source_sheet: sheetName,
                                    source_row: hIdx + 2 + offset,
                                    snapshot_date: orderBookSnapshotDate,
                                    documento_referencia: pdRef,
                                    oc_referencia: ocRef,
                                    pn,
                                    cust_po_item: safeString(safeCell(r, idx.custPoItem)),
                                    sales_order: safeString(safeCell(r, idx.salesOrder)),
                                    sales_order_item: safeString(safeCell(r, idx.salesOrderItem)),
                                    status_categoria: categoryInfo || 'N/A',
                                    qtd_comprada: qtdComprada,
                                    qtd_pendente: saldoPendente,
                                    qtd_aguardando_coleta: qtdAguardandoColeta,
                                    qtd_em_rota: qtdEmRota,
                                    qtd_entregue: qtdEntregue,
                                });
                            }

                            if (validSpareRow && saldoPendente > 0) {
                                pnsToRegister.set(pn, safeString(safeCell(r, idx.desc)) || 'N/A');
                                allSpares.push({
                                    pn,
                                    documento_referencia: pdRef,
                                    oc_referencia: ocRef,
                                    cust_po_item: safeString(safeCell(r, idx.custPoItem)),
                                    sales_order: safeString(safeCell(r, idx.salesOrder)),
                                    sales_order_item: safeString(safeCell(r, idx.salesOrderItem)),
                                    so_load: safeString(safeCell(r, idx.soLoad)),
                                    descricao: pnsToRegister.get(pn),
                                    qtd_pendente: saldoPendente,
                                    valor_unitario: cleanCurrency(safeCell(r, idx.val)),
                                    valor_total: cleanCurrency(safeCell(r, idx.total)),
                                    data_previsao_lh: formatExcelDate(safeCell(r, idx.date)),
                                    status_categoria: categoryInfo || 'N/A',
                                    qtd_aguardando_coleta: qtdAguardandoColeta,
                                    qtd_em_rota: qtdEmRota,
                                    qtd_entregue: qtdEntregue,
                                    raw_payload: rawPayloadFromRow(headers, r),
                                    data_importacao: new Date().toISOString(),
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
                        const idx = buildIndexMap(headers, { pn: 'pn', desc: 'nomenclatura', doc: 'oc', custPoItem: ['cust po item', 'customer po item'], salesOrder: ['sales order'], salesOrderItem: ['s/o item', 'sales order item'], qty: 'qtd', date: 'delivery', comments: ['lh comments', 'comments'] });
                        rawRows.slice(hIdx + 1).forEach(r => {
                            const pn = normalizePn(safeString(safeCell(r, idx.pn))); const qty = cleanCurrency(safeCell(r, idx.qty));
                            if (pn && qty > 0 && pn.toLowerCase() !== 'part number') {
                                pnsToRegister.set(pn, safeString(safeCell(r, idx.desc)) || 'N/A');
                                allFoc.push({
                                    pn,
                                    descricao: pnsToRegister.get(pn),
                                    documento_referencia: safeString(safeCell(r, idx.doc)),
                                    cust_po_item: safeString(safeCell(r, idx.custPoItem)),
                                    sales_order: safeString(safeCell(r, idx.salesOrder)),
                                    sales_order_item: safeString(safeCell(r, idx.salesOrderItem)),
                                    qtd_pendente: qty,
                                    data_previsao_lh: formatExcelDate(safeCell(r, idx.date)),
                                    lh_comments: safeString(safeCell(r, idx.comments)),
                                    raw_payload: rawPayloadFromRow(headers, r),
                                });
                            }
                        });
                    }
                }

                // REPAIRS
                else if (nameLower.includes('repair') && !nameLower.includes('warranty')) {
                    let hIdx = findHeaderRow(rawRows, ['incoming_part', 'serial_number']);
                    if (hIdx !== -1) {
                        const headers = rawRows[hIdx];
                        const idx = buildIndexMap(headers, {
                            doc: ['cust po ref', 'customer po ref', 'event report number', 'number'],
                            notification: ['notification'],
                            receptionDate: ['reception date', 'date received'],
                            pn: 'incoming_part',
                            pn_out: 'outgoing_part',
                            sn: 'serial_number',
                            desc: 'nomenclatura',
                            vendorFc: ['vendor fc', 'forecast date', 'f/c date @ lh'],
                            deliveryNumber: ['delivery', 'delivery number'],
                            poNumber: ['po number', 'po'],
                            status: 'lh_comments',
                            bnComments: ['bn comments'],
                        });
                        rawRows.slice(hIdx + 1).forEach((r, offset) => {
                            const pn = normalizePn(safeString(safeCell(r, idx.pn))); const sn = safeString(safeCell(r, idx.sn));
                            if (pn && pn.toLowerCase() !== 'incoming part') {
                                pnsToRegister.set(pn, safeString(safeCell(r, idx.desc)) || 'N/A');
                                const repairRow = {
                                    pn,
                                    sn,
                                    descricao: pnsToRegister.get(pn),
                                    tipo: 'PAID',
                                    documento_referencia: safeString(safeCell(r, idx.doc)),
                                    notification: safeString(safeCell(r, idx.notification)),
                                    reception_date: formatExcelDate(safeCell(r, idx.receptionDate)),
                                    po_number: safeString(safeCell(r, idx.poNumber)),
                                    delivery_number: safeString(safeCell(r, idx.deliveryNumber)),
                                    lh_updates: safeString(safeCell(r, idx.status)),
                                    bn_comments: safeString(safeCell(r, idx.bnComments)),
                                    status: safeString(safeCell(r, idx.status)) || 'Sem status LH',
                                    data_previsao: formatExcelDate(safeCell(r, idx.vendorFc)),
                                    pn_saida: safeString(safeCell(r, idx.pn_out)),
                                    raw_payload: rawPayloadFromRow(headers, r),
                                };
                                allRepairs.push(repairRow);
                                orderBookTraceRows.push({
                                    trace_type: 'REPAIR', source_sheet: sheetName, source_row: hIdx + 2 + offset,
                                    snapshot_date: orderBookSnapshotDate, ...repairRow,
                                    reception_date: formatDbDate(safeCell(r, idx.receptionDate)),
                                    forecast_date: formatDbDate(safeCell(r, idx.vendorFc)),
                                });
                            }
                        });
                    }
                }

                // WARRANTY REPAIRS
                else if (nameLower.includes('warranty')) {
                    let hIdx = findHeaderRow(rawRows, ['part_required', 'serial_number']);
                    if (hIdx !== -1) {
                        const headers = rawRows[hIdx];
                        const idx = buildIndexMap(headers, {
                            doc: ['event report number', 'number'],
                            ac: ['tail number', 'aircraft', 'a/c'],
                            eventTitle: ['event report title', 'title', 'symptom'],
                            dateReceived: ['date received', 'reception date'],
                            approvedBy: ['approved by'],
                            pn: 'part_required',
                            partDelivered: ['part delivered'],
                            desc: 'nomenclatura',
                            sn: 'serial_number',
                            notification: ['notification'],
                            po: ['po', 'po number'],
                            forecast: ['forecast date @ lh', 'forecast date', 'f/c date @ lh'],
                            deliveryNumber: ['delivery number', 'delivery'],
                            status: ['lh updates', 'status'],
                            bnComments: ['bn comments'],
                        });
                        rawRows.slice(hIdx + 1).forEach((r, offset) => {
                            const pn = normalizePn(safeString(safeCell(r, idx.pn))); const sn = safeString(safeCell(r, idx.sn));
                            if (pn && pn.toLowerCase() !== 'part required') {
                                pnsToRegister.set(pn, safeString(safeCell(r, idx.desc)) || 'N/A');
                                const warrantyRow = {
                                    pn,
                                    sn,
                                    descricao: pnsToRegister.get(pn),
                                    tipo: 'WARRANTY',
                                    documento_referencia: safeString(safeCell(r, idx.doc)),
                                    aeronave: safeString(safeCell(r, idx.ac)),
                                    event_report_title: safeString(safeCell(r, idx.eventTitle)),
                                    date_received: formatExcelDate(safeCell(r, idx.dateReceived)),
                                    approved_by: safeString(safeCell(r, idx.approvedBy)),
                                    part_delivered: safeString(safeCell(r, idx.partDelivered)),
                                    notification: safeString(safeCell(r, idx.notification)),
                                    po_number: safeString(safeCell(r, idx.po)),
                                    forecast_date_lh: formatExcelDate(safeCell(r, idx.forecast)),
                                    delivery_number: safeString(safeCell(r, idx.deliveryNumber)),
                                    lh_updates: safeString(safeCell(r, idx.status)),
                                    bn_comments: safeString(safeCell(r, idx.bnComments)),
                                    status: safeString(safeCell(r, idx.status)) || 'Sem status LH',
                                    data_previsao: formatExcelDate(safeCell(r, idx.forecast)),
                                    raw_payload: rawPayloadFromRow(headers, r),
                                };
                                allRepairs.push(warrantyRow);
                                orderBookTraceRows.push({
                                    trace_type: 'WARRANTY', source_sheet: sheetName, source_row: hIdx + 2 + offset,
                                    snapshot_date: orderBookSnapshotDate, ...warrantyRow,
                                    date_received: formatDbDate(safeCell(r, idx.dateReceived)),
                                    forecast_date: formatDbDate(safeCell(r, idx.forecast)),
                                });
                            }
                        });
                    }
                }

                // DELIVERED / DELIVERIES — não possuem SN, mas corroboram a data física de entrega por Delivery Number.
                else if (nameLower === 'delivered' || nameLower === 'deliveries') {
                    let hIdx = rawRows.findIndex(r => r.map(x => String(x || '').toLowerCase().trim()).includes('delivery') && r.map(x => String(x || '').toLowerCase().trim()).includes('material'));
                    if (hIdx !== -1) {
                        const headers = rawRows[hIdx];
                        const h = headers.map(x => String(x || '').toLowerCase().trim());
                        const idx = {
                            delivery: h.indexOf('delivery'), pgi: h.indexOf('pgi date'), material: h.indexOf('material'), desc: h.indexOf('mat desc'),
                            custPo: h.indexOf('cust po ref'), shipment: h.indexOf('shipment'), caseNo: h.indexOf('case no'), awb: h.indexOf('awb/bol'),
                        };
                        rawRows.slice(hIdx + 1).forEach((r, offset) => {
                            const deliveryNumber = safeString(safeCell(r, idx.delivery));
                            if (!deliveryNumber) return;
                            orderBookDeliveryRows.push({
                                source_sheet: sheetName, source_row: hIdx + 2 + offset, delivery_number: deliveryNumber,
                                delivery_date: formatDbDate(safeCell(r, idx.pgi)), material: normalizePn(safeString(safeCell(r, idx.material))),
                                descricao: safeString(safeCell(r, idx.desc)), cust_po_ref: safeString(safeCell(r, idx.custPo)),
                                shipment: safeString(safeCell(r, idx.shipment)), case_no: safeString(safeCell(r, idx.caseNo)), awb_bol: safeString(safeCell(r, idx.awb)),
                                raw_payload: rawPayloadFromRow(headers, r),
                            });
                        });
                    }
                }

                // PROGS — histórico de reparo/upgrade com PN + SN.
                else if (nameLower === 'progs') {
                    let hIdx = rawRows.findIndex(r => { const h = r.map(x => String(x || '').toLowerCase().trim()); return h.includes('pt no in') && h.includes('serial no in'); });
                    if (hIdx !== -1) {
                        const headers = rawRows[hIdx];
                        const h = headers.map(x => String(x || '').toLowerCase().trim());
                        rawRows.slice(hIdx + 1).forEach((r, offset) => {
                            const pn = normalizePn(safeString(r[h.indexOf('pt no in')]));
                            const sn = safeString(r[h.indexOf('serial no in')]);
                            if (!pn) return;
                            orderBookTraceRows.push({
                                trace_type: 'PROGS', source_sheet: sheetName, source_row: hIdx + 2 + offset, snapshot_date: orderBookSnapshotDate,
                                documento_referencia: safeString(r[h.indexOf('cust po ref')]), notification: safeString(r[h.indexOf('notification')]),
                                reception_date: formatDbDate(r[h.indexOf('reception date')]), pn, pn_saida: safeString(r[h.indexOf('pt no out')]),
                                descricao: safeString(r[h.indexOf('description')]), sn, po_number: safeString(r[h.indexOf('po no')]),
                                forecast_date: formatDbDate(r[h.indexOf('po forecast')]), gate_description: safeString(r[h.indexOf('gate description')]),
                                vendor_name: safeString(r[h.indexOf('vendor name')]), gate: safeString(r[h.indexOf('gate')]), raw_payload: rawPayloadFromRow(headers, r),
                            });
                        });
                    }
                }

                // ADMIN DOCS + EVIDÊNCIAS ER/TQS. A tabela administrativa continua snapshot;
                // os campos ricos usados na rastreabilidade entram no Livro antes de o próximo Order Book substituir este arquivo.
                else if (['rfq\'s', 'tqs', 'er'].includes(nameLower)) {
                    const tipoDoc = nameLower === 'rfq\'s' ? 'RFQ' : nameLower === 'tqs' ? 'TQS' : 'ER';
                    let hIdx = rawRows.findIndex(r => { const rowStr = r.join('|').toLowerCase(); return rowStr.includes('quote number') || rowStr.includes('lh ref') || rowStr.includes('symptom'); });
                    if (hIdx !== -1) {
                        const headers = rawRows[hIdx];
                        const h = headers.map(x => String(x).toLowerCase().trim());
                        rawRows.slice(hIdx + 1).forEach((r, offset) => {
                            let doc='', assunto='', status='';
                            if (tipoDoc === 'RFQ') { doc = r[h.indexOf('quote number')]; assunto = r[h.indexOf('part number')]; }
                            else if (tipoDoc === 'TQS') { doc = r[h.indexOf('lh ref')]; assunto = r[h.indexOf('description')]; status = r[h.indexOf('status')]; }
                            else if (tipoDoc === 'ER') { doc = r[h.indexOf('number')]; assunto = r[h.indexOf('p/n')]; status = r[h.indexOf('status')]; }
                            if (safeString(doc)) allAdminDocs.push({ tipo_doc: tipoDoc, numero_doc: safeString(doc), assunto_pn: safeString(assunto), status: safeString(status) });

                            if (tipoDoc === 'ER' && safeString(doc)) {
                                orderBookTraceRows.push({
                                    trace_type: 'ER', source_sheet: sheetName, source_row: hIdx + 2 + offset, snapshot_date: orderBookSnapshotDate,
                                    documento_referencia: safeString(doc), symptom: safeString(r[h.indexOf('symptom')]), aeronave: safeString(r[h.indexOf('a/c')]),
                                    event_date: formatDbDate(r[h.indexOf('date')]), warranty_claim: safeString(r[h.indexOf('warranty claim')]),
                                    aog: safeString(r[h.indexOf('aog')]), pn: normalizePn(safeString(r[h.indexOf('p/n')])),
                                    descricao: safeString(r[h.indexOf('p/n description')]), sn: safeString(r[h.indexOf('s/n')]),
                                    lh_action: safeString(r[h.indexOf('lhuk action')]), status: safeString(status), raw_payload: rawPayloadFromRow(headers, r),
                                });
                            } else if (tipoDoc === 'TQS' && safeString(doc)) {
                                orderBookTraceRows.push({
                                    trace_type: 'TQS', source_sheet: sheetName, source_row: hIdx + 2 + offset, snapshot_date: orderBookSnapshotDate,
                                    documento_referencia: safeString(doc), crm_no: safeString(r[h.indexOf('crm no.')]), aeronave: safeString(r[h.indexOf('a/c')]),
                                    descricao: safeString(r[h.indexOf('description')]), status: safeString(status), customer_ref: safeString(r[h.indexOf('customer ref')]),
                                    comments: safeString(r[h.indexOf('comments')]), raw_payload: rawPayloadFromRow(headers, r),
                                });
                            }
                        });
                    }
                }
            } 

            if (allSpares.length === 0 && orderBookPdEvidenceRows.length === 0) {
                return respondError(400, 'O arquivo não produziu nenhuma linha válida de Spares nem evidência quantitativa de PD. A base atual foi preservada para evitar apagamento acidental.', {
                    tabelaAlvo: 'leonardo_spares',
                    detalhes: { sheets: workbook.SheetNames, foc: allFoc.length, repairs: allRepairs.length, admin_docs: allAdminDocs.length },
                });
            }

            // AUTOCADASTRO COM ERROS VERIFICADOS
            const uniquePns = Array.from(pnsToRegister.keys()).filter(Boolean);
            if (uniquePns.length > 0) {
                const existingPns = [];
                for (let i = 0; i < uniquePns.length; i += 200) {
                    const chunk = uniquePns.slice(i, i + 200);
                    const { data: existingItems, error: existingError } = await supabase.from('items').select('pn').in('pn', chunk);
                    if (existingError) throw existingError;
                    existingPns.push(...(existingItems || []).map(item => item.pn));
                }
                const existingSet = new Set(existingPns.map(normalizePn));
                const missingPns = uniquePns.filter(pn => !existingSet.has(normalizePn(pn))).map(pn => ({ pn, nomenclatura: pnsToRegister.get(pn), nsn: `PND-${pn}` }));
                for (let i = 0; i < missingPns.length; i += 500) {
                    const { error: insertItemError } = await supabase.from('items').insert(missingPns.slice(i, i + 500));
                    if (insertItemError) throw insertItemError;
                }
            }

            const replaceSnapshot = async (table, rows) => {
                const { error: deleteError } = await supabase.from(table).delete().not('id', 'is', null);
                if (deleteError) throw deleteError;
                for (let i = 0; i < rows.length; i += 500) {
                    const { error: insertError } = await supabase.from(table).insert(rows.slice(i, i + 500));
                    if (insertError) throw insertError;
                }
            };

            // Substitui inclusive fontes vazias para não deixar dados antigos “fantasmas”.
            await replaceSnapshot('leonardo_spares', allSpares);
            await replaceSnapshot('leonardo_foc_spares', allFoc);
            await replaceSnapshot('leonardo_repairs', allRepairs);
            await replaceSnapshot('leonardo_admin_docs', allAdminDocs);

            const referenciasOficiais = [...new Set([...allSpares.map(i => i.oc_referencia), ...allRepairs.map(i => i.documento_referencia)].filter(Boolean))];
            for (let i = 0; i < referenciasOficiais.length; i += 200) {
                const { error: manualError } = await supabase.from('cadastros_manuais').update({ ativo: false }).in('identificador_unico', referenciasOficiais.slice(i, i + 200));
                if (manualError) throw manualError;
            }

            // Corrige a duplicidade lógica: o mesmo PD deixa de contar como ODC quando aparece como ODA no Order Book.
            const reconciliacaoPds = await reconcileOrderBookPds(orderBookPdEvidenceRows.length ? orderBookPdEvidenceRows : allSpares, req.user);

            // 2B.8 — antes que o próximo snapshot substitua o Order Book atual, PN+SN vira evidência imutável no Livro.
            // A rastreabilidade é fail-soft: nunca desfaz uma importação operacional válida por causa de uma linha histórica ruim.
            let livroEquipamentos = null;
            try {
                livroEquipamentos = await syncOrderBookEquipmentTrace({ traceRows: orderBookTraceRows, deliveryRows: orderBookDeliveryRows }, req.user);
            } catch (traceError) {
                console.warn('[SISHA][2B.8] Falha não bloqueante ao sincronizar Order Book com Livro de Equipamentos:', traceError.message || traceError);
                livroEquipamentos = { status: 'ERRO_NAO_BLOQUEANTE', message: traceError.message || 'Falha ao sincronizar o Livro de Equipamentos.' };
            }

            const traceMsg = livroEquipamentos?.eventos_criados_ou_historicos != null
                ? ` Livro: ${livroEquipamentos.eventos_criados_ou_historicos} evento(s)/histórico(s), ${livroEquipamentos.conflitos_localizacao || 0} conflito(s) para reconciliação.`
                : '';
            return respondSuccess(`Order Book atualizado e PDs reconciliados com sucesso!${traceMsg}`, {
                reconciliacao_pds: reconciliacaoPds,
                livro_equipamentos: livroEquipamentos,
            }, {
                tabelaAlvo: 'leonardo_spares',
                linhasImportadas: allSpares.length + allFoc.length + allRepairs.length + allAdminDocs.length,
                detalhes: {
                    spares: allSpares.length, foc: allFoc.length, repairs: allRepairs.length, admin_docs: allAdminDocs.length,
                    trace_rows: orderBookTraceRows.length, delivery_evidence: orderBookDeliveryRows.length, pd_quantity_evidence: orderBookPdEvidenceRows.length,
                    reconciliacao_pds: reconciliacaoPds, livro_equipamentos: livroEquipamentos,
                },
            });
        }

        // ---------------------------------------------------
        // ROTA 3: RECIBOS DE GARANTIA / MATERIAL
        // ---------------------------------------------------
        else if (tipoArquivo === 'recibo_material' || tipoArquivo === 'recibo_auto') {
            const requestedType = tipoArquivo === 'recibo_auto' ? 'recibo_auto' : 'recibo_material';
            const parsed = parseReceiptDocument({
                file: req.file,
                requestedType,
                workbook,
            });
            return respondSuccess(
                `Recibo ${parsed.recibo_ref} lido e classificado como ${parsed.tipo_recebimento || 'MATERIAL'}. Revise todos os campos e complete as informações operacionais antes de salvar.`,
                parsed,
                {
                    tabelaAlvo: 'recebimentos',
                    linhasLidas: parsed.data_triagem.length,
                    linhasImportadas: parsed.data_triagem.length,
                    detalhes: {
                        modo: tipoArquivo === 'recibo_auto' ? 'triagem_recibo_auto' : 'triagem_recibo_material',
                        recibo_ref: parsed.recibo_ref,
                        tipo_recebimento: parsed.tipo_recebimento,
                        avisos: parsed.avisos_triagem,
                    },
                },
            );
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
            const parsed = parseReceiptDocument({
                file: req.file,
                requestedType: 'recibo_pd',
                workbook,
            });
            return respondSuccess(
                `Recibo ${parsed.recibo_ref} lido. Revise PD, PN, quantidade e complete SN, local e observações antes de salvar.`,
                parsed,
                {
                    tabelaAlvo: 'recebimentos',
                    linhasLidas: parsed.data_triagem.length,
                    linhasImportadas: parsed.data_triagem.length,
                    detalhes: {
                        modo: 'triagem_recibo_pd',
                        recibo_ref: parsed.recibo_ref,
                        avisos: parsed.avisos_triagem,
                    },
                },
            );
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
                    detalhes: { modo: 'pn_alternativos', preserva_origens_manuais_rfq: true }
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

            // 28.11: o arquivo técnico continua sendo uma fotografia completa da fonte DOCUMENTO,
            // mas NÃO pode apagar relações MANUAIS nem relações adicionadas por RFQ.
            // Segurança: primeiro grava a nova fotografia. Só depois desativa fotografias DOCUMENTO antigas.
            // Assim, uma falha de insert nunca deixa a biblioteca documental inteira inativa.
            const importBatchId = require('crypto').randomUUID();
            const payloadDocumental = payload.map((row) => ({
                ...row,
                tipo_relacao: 'ALTERNATIVO',
                origem_tipo: 'DOCUMENTO',
                ativo: true,
                import_batch_id: importBatchId,
                created_by_email: req.user?.email || null,
                updated_by_email: req.user?.email || null,
                updated_at: new Date().toISOString(),
            }));

            const chunkSize = 1000;
            for (let i = 0; i < payloadDocumental.length; i += chunkSize) {
                const lote = payloadDocumental.slice(i, i + chunkSize);
                const { error: insertError } = await supabase
                    .from('pn_alternativos_documento')
                    .insert(lote);
                if (insertError) throw insertError;
            }

            const auditUpdate = {
                ativo: false,
                updated_at: new Date().toISOString(),
                updated_by_email: req.user?.email || null,
            };

            // Fotografia legada sem import_batch_id.
            const { error: deactivateLegacyError } = await supabase
                .from('pn_alternativos_documento')
                .update(auditUpdate)
                .eq('origem_tipo', 'DOCUMENTO')
                .eq('ativo', true)
                .is('import_batch_id', null);

            if (deactivateLegacyError) throw deactivateLegacyError;

            // Fotografias DOCUMENTO de lotes anteriores. O lote recém-importado permanece ativo.
            const { error: deactivateOldBatchError } = await supabase
                .from('pn_alternativos_documento')
                .update(auditUpdate)
                .eq('origem_tipo', 'DOCUMENTO')
                .eq('ativo', true)
                .not('import_batch_id', 'is', null)
                .neq('import_batch_id', importBatchId);

            if (deactivateOldBatchError) throw deactivateOldBatchError;

            return respondSuccess(`Biblioteca documental de PN Alternativos atualizada com ${payloadDocumental.length} relações técnicas. Inserções manuais/RFQ foram preservadas.`, {}, {
                tabelaAlvo: 'pn_alternativos_documento',
                linhasLidas: Math.max(rawRows.length - (hIdx + 1), 0),
                linhasImportadas: payloadDocumental.length,
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
                    pi: ['pi', 'nsn', 'nsn/pi'],
                    pn: ['pn', 'p/n', 'part number', 'part no', 'partnumber'],
                    nome: ['nomenclatura', 'descricao', 'descrição', 'description'],
                    qtd: ['qtd', 'qty', 'qte', 'qtde', 'quantidade', 'quantity'],
                    sj: 'sj',
                    uf: 'uf'
                });

                linhasNormalizadas.slice(hIdx + 1).forEach(r => {
                    if (idx.pi !== -1 && r[idx.pi]) {
                        const piLimpo = limparEPadronizarPI(r[idx.pi]);
                        if (piLimpo) {
                            const pnCeimspa = idx.pn !== -1 ? normalizePn(safeString(r[idx.pn])) : null;
                            ceimspaData.push({
                                pi: piLimpo,
                                pn: pnCeimspa || null,
                                pn_confirmado: Boolean(pnCeimspa),
                                fonte_identificacao: pnCeimspa ? 'ARQUIVO_CEIMSPA' : 'CEIMSPA_SEM_PN',
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
        // ---------------------------------------------------
        // MAPA DE DISPONIBILIDADE / INSPEÇÕES DA FROTA (A1.1)
        // ---------------------------------------------------
        else if (tipoArquivo === 'disponibilidade_anv') {
            const parsed = parseAvailabilityWorkbookBuffer(req.file.buffer, req.file.originalname || 'DISPONIBILIDADE.xlsx');
            const result = await importAvailabilityAtomic(parsed, {
                buffer: req.file.buffer,
                fileName: req.file.originalname || 'DISPONIBILIDADE.xlsx',
                user: req.user || {},
                requestId: req.requestId || req.auditContext?.requestId || null,
            });

            return respondSuccess(
                `Mapa de Disponibilidade processado: ${parsed.summary.aircraft_count} aeronave(s), ${parsed.summary.unavailable} indisponível(is) e ${parsed.summary.indicators} indicador(es) técnicos preservados.`,
                {
                    data: {
                        ...result,
                        aircraft: parsed.snapshots.map((item) => ({
                            aircraft_code: item.aircraft_code,
                            status: item.status,
                            reason: item.reason,
                            aircraft_hours: item.aircraft_hours,
                            source_observed_at: item.source_observed_at,
                            engine_1_sn: item.engine_1_sn,
                            engine_2_sn: item.engine_2_sn,
                            indicators: item.indicators.length,
                            indicator_errors: item.quality.errors,
                        })),
                    },
                    warnings: parsed.warnings || [],
                },
                {
                    tabelaAlvo: 'aircraft_availability_snapshots',
                    linhasImportadas: parsed.summary.aircraft_count,
                    detalhes: {
                        source_sha256: result.source_sha256,
                        indicadores: parsed.summary.indicators,
                        indisponiveis: parsed.summary.unavailable,
                        warnings: parsed.warnings || [],
                    },
                },
            );
        }

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

        const {
            recibo_ref,
            data_entrega,
            is_foc,
            tipo_recebimento,
            documento_referencia,
            fornecedor,
            origem_material,
            recebido_por_nome,
            conferido_por_nome,
            metodo_importacao,
            arquivo_nome,
            arquivo_hash,
            chat_lince_documento_id,
            observacao,
            avisos_triagem,
            dados_originais,
            itens,
        } = req.body;

        if (isGenericReceiptNumber(recibo_ref)) {
            return respondError(400, 'O recibo não possui uma referência única válida.', { tabelaAlvo: 'recebimentos', detalhes: { modo: 'confirmar_triagem' } });
        }
        if (!Array.isArray(itens) || itens.length === 0) {
            return respondError(400, 'Nenhum item para processar.', { tabelaAlvo: 'recebimentos', detalhes: { modo: 'confirmar_triagem' } });
        }

        const dataChegadaISO = formatDbDate(data_entrega);

        const receiptItems = itens.map((item, index) => ({
            id: item.id || undefined,
            sequencia_item: item.sequencia_item || index + 1,
            pn: normalizePn(item.pn),
            nsn_pi: item.nsn_pi || null,
            nomenclatura: item.nomenclatura || null,
            quantidade: Math.max(0, Number(item.quantidade) || 0),
            sn: item.sn || item.sns_finais || '',
            localizacao_ppu: item.localizacao_ppu || null,
            destino_estoque: String(item.destino_estoque || 'PPU').trim().toUpperCase() === 'CEIMSPA' ? 'CEIMSPA' : 'PPU',
            condicao_item: item.condicao_item || 'RECEBIDO_DISPONIVEL',
            observacao_item: item.observacao_item || null,
            inventariado_ppu: Boolean(item.inventariado_ppu),
            quantidade_inventariada: Math.max(0, Number(item.quantidade_inventariada) || 0),
            data_garantia: item.data_garantia || null,
            valor_unitario: item.valor_unitario ?? null,
            valor_total_documento: item.valor_total_documento ?? null,
            moeda: item.moeda || null,
            documento_referencia: item.documento_referencia || documento_referencia || null,
            delivery_note: item.delivery_note || null,
            invoice_no: item.invoice_no || null,
            di: item.di || null,
            batch_no: item.batch_no || null,
            coc_no: item.coc_no || null,
            status_documento: item.status_documento || null,
            dados_originais: item.dados_originais || {},
        })).filter((item) => item.pn && item.quantidade > 0);

        if (!receiptItems.length) {
            return respondError(400, 'Nenhum item válido permaneceu após a triagem.', { tabelaAlvo: 'recebimentos', detalhes: { modo: 'confirmar_triagem' } });
        }

        const receipt = await saveReceipt({
            header: {
                numeroRecibo: recibo_ref,
                tipoRecebimento: tipo_recebimento || (is_foc ? 'MATERIAL_FOC' : 'MATERIAL'),
                dataRecebimento: dataChegadaISO,
                documentoReferencia: documento_referencia || null,
                fornecedor: fornecedor || null,
                origemMaterial: origem_material || null,
                recebidoPorNome: recebido_por_nome || null,
                conferidoPorNome: conferido_por_nome || null,
                metodoImportacao: metodo_importacao || 'DOCUMENTO',
                arquivoNome: arquivo_nome || null,
                arquivoHash: arquivo_hash || null,
                chatLinceDocumentoId: chat_lince_documento_id || null,
                isFoc: Boolean(is_foc),
                observacao: observacao || 'Triagem confirmada após revisão humana.',
                avisosTriagem: Array.isArray(avisos_triagem) ? avisos_triagem : [],
                dadosOriginais: dados_originais && typeof dados_originais === 'object' ? dados_originais : {},
            },
            items: receiptItems,
            actor: req.user,
        });

        return respondSuccess(`Recibo ${recibo_ref} salvo. O saldo temporário considera somente itens disponíveis e ainda não inventariados.`, {
            recebimento_id: receipt.id,
            data: receipt,
        }, { tabelaAlvo: 'recebimentos', linhasImportadas: receiptItems.length, detalhes: { modo: 'confirmar_triagem', recibo_ref, is_foc: !!is_foc, recebimento_id: receipt.id } });
    } catch (error) {
        console.error('ERRO NO FINALIZADOR DE TRIAGEM:', error);
        setAuditSummary(req, { status: 'ERRO', mensagem: error.message || 'Erro crítico ao gravar os dados.', tabelaAlvo: 'recebimentos', detalhes: { modo: 'confirmar_triagem', erro: error.message || String(error) } });
        const statusCode = ['RECEIPT_REFERENCE_REQUIRED', 'RECEIPT_ITEMS_REQUIRED', 'RECEIPT_SERIAL_QUANTITY_MISMATCH', 'RECEIPT_SERIAL_INVENTORY_MISMATCH'].includes(error.code) ? 400 : 500;
        return res.status(statusCode).json({ status: 'error', message: error.message || 'Erro crítico ao gravar os dados.' });
    }
};

// =======================================================
// C2.1 — PROCESSAMENTO PERSISTENTE DE COTAÇÕES / RFQ
// O upload retorna 202; worker conclui em background e a revisão pode ser reaberta após reload.
// =======================================================
exports.createRfqPersistentJob = async (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ status: 'error', message: 'Nenhum ficheiro enviado.' });
        const job = await createRfqImportJob({
            file: req.file,
            actor: req.user,
            requestId: req.requestId || req.auditContext?.requestId || null,
        });
        setAuditSummary(req, {
            status: 'SUCESSO',
            mensagem: job.reused_analysis ? 'Análise comercial idêntica reutilizada.' : 'Documento comercial enfileirado para processamento persistente.',
            tabelaAlvo: 'rfq_import_jobs',
            linhasImportadas: 0,
            detalhes: { modo: 'rfq_job_criar', job_id: job.id, arquivo: job.file_name, reused_analysis: Boolean(job.reused_analysis) },
        });
        return res.status(job.reused_analysis ? 200 : 202).json({
            status: 'success',
            message: job.reused_analysis
                ? 'Este documento já havia sido analisado nesta versão. A revisão foi reaberta sem novo processamento.'
                : 'Documento recebido. O backend continuará processando mesmo se você fechar ou atualizar a página.',
            data: job,
        });
    } catch (error) {
        console.error('[SISHA][rfq] criar job persistente:', error);
        const statusCode = /R2|Selecione|documento|Cotação|RFQ/i.test(error.message || '') ? 400 : 500;
        setAuditSummary(req, { status: 'ERRO', mensagem: error.message || 'Falha ao criar processamento persistente.', tabelaAlvo: 'rfq_import_jobs', detalhes: { modo: 'rfq_job_criar' } });
        return res.status(statusCode).json({ status: 'error', message: error.message || 'Falha ao criar processamento persistente.' });
    }
};

exports.listRfqPersistentJobs = async (req, res) => {
    try {
        const jobs = await listRfqImportJobs(req.query.limit || 20);
        return res.status(200).json({ status: 'success', data: jobs });
    } catch (error) {
        console.error('[SISHA][rfq] listar jobs:', error);
        return res.status(500).json({ status: 'error', message: error.message || 'Falha ao listar processamentos comerciais.' });
    }
};

exports.getRfqPersistentJob = async (req, res) => {
    try {
        const job = await getRfqImportJob(req.params.jobId);
        return res.status(200).json({ status: 'success', data: job });
    } catch (error) {
        console.error('[SISHA][rfq] obter job:', error);
        return res.status(404).json({ status: 'error', message: error.message || 'Processamento não encontrado.' });
    }
};


exports.reprocessRfqPersistentJob = async (req, res) => {
    try {
        const job = await reprocessRfqImportJob({
            jobId: req.params.jobId,
            actor: req.user,
            requestId: req.requestId || req.auditContext?.requestId || null,
        });
        const reused = Boolean(job.reused_inflight);
        setAuditSummary(req, {
            status: 'SUCESSO',
            mensagem: reused ? 'Reprocessamento comercial atual já estava em andamento.' : 'Reprocessamento comercial criado com o leitor atual.',
            tabelaAlvo: 'rfq_import_jobs',
            linhasImportadas: 0,
            detalhes: { modo: 'rfq_job_reprocessar', origem_job_id: req.params.jobId, novo_job_id: job.id, reused_inflight: reused, analysis_version: job.analysis_version },
        });
        return res.status(reused ? 200 : 202).json({
            status: 'success',
            message: reused
                ? 'Este documento já está sendo reprocessado com o leitor atual.'
                : 'Reprocessamento iniciado com o leitor atual. O arquivo original privado foi reutilizado sem novo upload.',
            data: job,
        });
    } catch (error) {
        console.error('[SISHA][rfq] reprocessar job:', error);
        const statusCode = ['RFQ_JOB_ALREADY_SAVED', 'RFQ_JOB_SOURCE_UNAVAILABLE'].includes(error.code) ? 409 : 500;
        setAuditSummary(req, { status: 'ERRO', mensagem: error.message || 'Falha ao reprocessar documento comercial.', tabelaAlvo: 'rfq_import_jobs', detalhes: { modo: 'rfq_job_reprocessar', origem_job_id: req.params.jobId } });
        return res.status(statusCode).json({ status: 'error', message: error.message || 'Falha ao reprocessar documento comercial.' });
    }
};

exports.discardRfqPersistentJob = async (req, res) => {
    try {
        const job = await discardRfqImportJob({
            jobId: req.params.jobId,
            actor: req.user,
            reason: req.body?.motivo,
        });
        setAuditSummary(req, {
            status: 'SUCESSO',
            mensagem: 'Pendência comercial excluída da Central com histórico preservado.',
            tabelaAlvo: 'rfq_import_jobs',
            linhasImportadas: 0,
            detalhes: { modo: 'rfq_job_descartar', job_id: job.id, quality_status: job.quality_status, exclusao_fisica: false },
        });
        return res.status(200).json({
            status: 'success',
            message: 'Pendência excluída da Central. O arquivo e o processamento original permanecem preservados para auditoria e não serão usados como referência comercial.',
            data: job,
        });
    } catch (error) {
        console.error('[SISHA][rfq] descartar job:', error);
        const statusCode = ['RFQ_DISCARD_REASON_REQUIRED'].includes(error.code) ? 400 : ['RFQ_JOB_ALREADY_SAVED', 'RFQ_JOB_NOT_DISCARDABLE'].includes(error.code) ? 409 : 500;
        setAuditSummary(req, { status: 'ERRO', mensagem: error.message || 'Falha ao excluir pendência comercial.', tabelaAlvo: 'rfq_import_jobs', detalhes: { modo: 'rfq_job_descartar', job_id: req.params.jobId, exclusao_fisica: false } });
        return res.status(statusCode).json({ status: 'error', message: error.message || 'Falha ao excluir pendência comercial.' });
    }
};

// =======================================================
// NOVA ROTA: LEITURA UNIVERSAL DE COTAÇÕES / RFQ (PDF, XLSX, XLS)
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

        if (!req.file) {
            return respondError(400, 'Nenhum ficheiro enviado.', {
                tabelaAlvo: 'rfq_cotacoes',
                detalhes: { modo: 'rfq_leitura' },
            });
        }

        const parsed = await parseRfqDocument(req.file);
        const items = Array.isArray(parsed?.items) ? parsed.items : [];
        const relations = items.filter((item) => item.pn_relacionado && item.tipo_relacao_pn).length;

        return respondSuccess(
            `Cotação lida. ${items.length} item(ns) extraído(s) para revisão${relations ? ` e ${relations} relação(ões) de PN identificada(s)` : ''}.`,
            parsed,
            {
                tabelaAlvo: 'rfq_cotacoes',
                linhasImportadas: items.length,
                detalhes: {
                    modo: 'rfq_leitura',
                    quotation_number: parsed?.metadados?.quotation_number || null,
                    arquivo: req.file.originalname || null,
                    metodo_leitura: parsed?.metadados?.metodo_leitura || null,
                    relacoes_pn: relations,
                },
            }
        );
    } catch (error) {
        console.error('Erro RFQ:', error);
        const statusCode = error?.statusCode || 500;
        setAuditSummary(req, {
            status: 'ERRO',
            mensagem: error?.message || 'Falha no processamento da cotação.',
            tabelaAlvo: 'rfq_cotacoes',
            detalhes: { modo: 'rfq_leitura', erro: error?.message || String(error) },
        });
        return res.status(statusCode).json({
            status: 'error',
            message: error?.message || 'Falha no processamento da cotação.',
        });
    }
};

// =======================================================
// ROTA FINAL: GRAVAR COTAÇÃO/RFQ VALIDADA NO BANCO
// Serve tanto para documento importado quanto para inserção manual em lote.
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

        const { metadados = {}, items = [] } = req.body || {};
        if (!Array.isArray(items) || items.length === 0) {
            return respondError(400, 'Nenhum item para gravar.', { tabelaAlvo: 'rfq_cotacoes', detalhes: { modo: 'rfq_salvar' } });
        }

        const normalizeTextPn = (value) => String(value || '').trim().toUpperCase();
        const allowedRelations = new Set(['ALTERNATIVO', 'EQUIVALENTE', 'SUPERSEDED_BY', 'SUPERSEDES']);
        const allowedTypes = new Set(['MATERIAL', 'REPARO', 'OVERHAUL', 'SERVICO', 'OUTRO']);
        const quotationNumber = String(metadados.quotation_number || '').trim() || `MANUAL-${Date.now()}`;
        const tipoCotacaoRaw = String(metadados.tipo_cotacao || 'MATERIAL').trim().toUpperCase();
        const tipoCotacao = allowedTypes.has(tipoCotacaoRaw) ? tipoCotacaoRaw : 'OUTRO';
        const origemRegistro = String(metadados.origem_registro || (metadados.metodo_leitura ? 'IMPORTADO' : 'MANUAL')).trim().toUpperCase() === 'MANUAL' ? 'MANUAL' : 'IMPORTADO';
        const fornecedor = String(metadados.fornecedor || 'LEONARDO').trim() || 'LEONARDO';
        const validity = String(metadados.validity || '').trim();
        const documentoTipo = String(metadados.documento_tipo || 'GENERIC_COMMERCIAL_DOCUMENT').trim().toUpperCase();
        const contractReference = String(metadados.contract_reference || '').trim() || null;
        const paymentTerms = String(metadados.payment_terms || '').trim().slice(0, 2000) || null;
        const deliveryTerms = String(metadados.delivery_terms || '').trim().slice(0, 2000) || null;
        const itemsTotal = Number(metadados.items_total) || 0;
        const packingDeliveryPercent = Number(metadados.packing_delivery_percent) || 0;
        const packingDeliveryValue = Number(metadados.packing_delivery_value) || 0;
        const finalAmount = Number(metadados.final_amount) || 0;
        const qualityStatus = String(metadados.quality_status || 'REVIEW').trim().toUpperCase();
        const quotationPrintedDate = formatDbDate(metadados.quotation_printed_date);
        const stockContextNote = String(metadados.stock_availability_note || '').trim().slice(0, 2000) || null;
        const analysisMethod = String(metadados.metodo_leitura || '').trim();
        const importJobId = String(metadados.import_job_id || '').trim();

        if (qualityStatus === 'BLOCKED') {
            return respondError(400, 'Documento bloqueado pelo Fidelity Gate: reprocese/corrija a estrutura antes de gravar.', { tabelaAlvo: 'rfq_cotacoes', detalhes: { modo: 'rfq_salvar', quality_status: qualityStatus } });
        }
        if (documentoTipo === 'LEONARDO_QUOTATION' && /CHAT_LINCE_TEXTO/i.test(analysisMethod)) {
            return respondError(400, 'Quotation Leonardo não pode ser gravada a partir do fallback genérico de IA. Reprocesse com o parser determinístico C2.2.', { tabelaAlvo: 'rfq_cotacoes', detalhes: { modo: 'rfq_salvar', metodo_leitura: analysisMethod } });
        }

        if (tipoCotacao === 'MATERIAL' && !validity) {
            return respondError(400, 'Informe a validade da cotação de material. Ela define se o preço ainda pode ser usado como referência atual.', { tabelaAlvo: 'rfq_cotacoes', detalhes: { modo: 'rfq_salvar' } });
        }

        if (origemRegistro === 'IMPORTADO' && importJobId) {
            let importJob;
            try {
                importJob = await getRfqImportJob(importJobId);
            } catch (jobError) {
                return respondError(404, 'Processamento persistente da cotação não foi encontrado.', { tabelaAlvo: 'rfq_import_jobs', detalhes: { modo: 'rfq_salvar', job_id: importJobId } });
            }

            if (importJob.status === 'SAVED') {
                const { data: existingRows, error: existingError } = await supabase
                    .from('rfq_cotacoes')
                    .select('*')
                    .eq('rfq_import_job_id', importJobId)
                    .order('rfq_import_row_key', { ascending: true });
                if (existingError) throw existingError;
                return respondSuccess(
                    `Documento comercial ${quotationNumber} já havia sido gravado. Nenhuma linha foi duplicada.`,
                    { data: existingRows || [], moeda: 'GBP', tipo_cotacao: tipoCotacao, already_saved: true, import_job_id: importJobId },
                    { tabelaAlvo: 'rfq_cotacoes', linhasImportadas: 0, detalhes: { modo: 'rfq_salvar_idempotente', quotation_number: quotationNumber, job_id: importJobId, already_saved: true } }
                );
            }

            if (importJob.status !== 'REVIEW_READY') {
                return respondError(409, `Este processamento está em ${importJob.status || 'estado desconhecido'} e não pode ser gravado agora.`, { tabelaAlvo: 'rfq_import_jobs', detalhes: { modo: 'rfq_salvar', job_id: importJobId, job_status: importJob.status || null } });
            }
        }

        const insercoes = items.map((item, itemIndex) => {
            const pn = normalizeTextPn(item.pn);
            if (!pn) return null;
            const relationType = String(item.tipo_relacao_pn || '').trim().toUpperCase();
            const itemTypeRaw = String(item.tipo_cotacao || tipoCotacao || 'MATERIAL').trim().toUpperCase();
            const itemType = allowedTypes.has(itemTypeRaw) ? itemTypeRaw : tipoCotacao;
            const matchMode = String(item.match_mode || 'EXACT').trim().toUpperCase() === 'PATTERN' ? 'PATTERN' : 'EXACT';
            return {
                cotacao_numero: quotationNumber,
                data_cotacao: String(metadados.quotation_date || '').trim() || null,
                validade: validity || 'N/I',
                referencia_pedido: String(metadados.reference || '').trim() || null,
                condicao: String(metadados.condicao || '').trim() || null,
                fornecedor,
                tipo_cotacao: itemType,
                documento_tipo: documentoTipo,
                contrato_referencia: contractReference,
                termos_pagamento: paymentTerms,
                termos_entrega: deliveryTerms,
                quotation_printed_date: quotationPrintedDate,
                stock_context_note: stockContextNote,
                items_total: itemsTotal,
                packing_delivery_percent: packingDeliveryPercent,
                packing_delivery_value: packingDeliveryValue,
                final_amount: finalAmount,
                pn,
                nsn: String(item.nsn || '').trim() || null,
                material_reference: String(item.material_reference || '').trim() || null,
                material_reference_status: String(item.material_reference_status || '').trim().toUpperCase() || null,
                nomenclatura: String(item.nomenclatura || '').trim() || null,
                sn: String(item.sn || '').trim() || null,
                wo_referencia: String(item.wo_referencia || '').trim() || null,
                document_item_number: Number(item.item_num) || null,
                qtd_solicitada: Number(item.qtd_solicitada) || 0,
                lead_time_dias: Number(item.lead_time) || 0,
                lead_time_original: String(item.lead_time_original || '').trim().slice(0, 100) || null,
                estoque_pronto: Number(item.estoque_pronto) || 0,
                valor_unitario: Number(item.valor_unitario) || 0,
                valor_total_item: Number(item.valor_total_item) || 0,
                preco_base: Number(item.preco_base) || 0,
                desconto_percentual: Number(item.desconto_percentual) || 0,
                price_status: String(item.price_status || (Number(item.valor_unitario) > 0 ? 'PRICED' : 'UNPRICED')).trim().toUpperCase(),
                one_time_only: Boolean(item.one_time_only),
                limite_quantidade: Number(item.limite_quantidade) || 0,
                prazo_condicao: formatDbDate(item.prazo_condicao),
                match_mode: matchMode,
                pn_original_solicitado: normalizeTextPn(item.pn_original_solicitado) || null,
                correcao_pn_tipo: String(item.correcao_pn_tipo || '').trim().toUpperCase() || null,
                source_page: Number(item.source_page) || null,
                source_excerpt: String(item.source_excerpt || '').trim().slice(0, 4000) || null,
                source_description_status: String(item.source_description_status || '').trim().toUpperCase() || null,
                condicao_item: String(item.condicao_item || '').trim().slice(0, 500) || null,
                moeda: 'GBP',
                observacoes: String(item.observacoes || metadados.observacoes || '').trim().slice(0, 4000) || null,
                pn_relacionado: normalizeTextPn(item.pn_relacionado) || null,
                tipo_relacao_pn: allowedRelations.has(relationType) ? relationType : null,
                relacao_pn_texto: String(item.relacao_pn_texto || '').trim().slice(0, 1000) || null,
                arquivo_nome: String(metadados.arquivo_nome || '').trim() || null,
                metodo_leitura: analysisMethod || null,
                origem_registro: origemRegistro,
                ativo: true,
                created_by_email: req.user?.email || null,
                updated_by_email: req.user?.email || null,
                updated_at: new Date().toISOString(),
                data_insercao: new Date().toISOString(),
                rfq_import_job_id: origemRegistro === 'IMPORTADO' && importJobId ? importJobId : null,
                rfq_import_row_key: origemRegistro === 'IMPORTADO' && importJobId ? `ROW:${String(itemIndex + 1).padStart(4, '0')}` : null,
            };
        }).filter(Boolean);

        if (!insercoes.length) {
            return respondError(400, 'Nenhum PN válido foi informado para a cotação.', { tabelaAlvo: 'rfq_cotacoes', detalhes: { modo: 'rfq_salvar' } });
        }

        let saved = [];
        let alreadySaved = false;
        const insertResult = await supabase.from('rfq_cotacoes').insert(insercoes).select('*');
        if (insertResult.error) {
            // A UNIQUE C2.4 é a segunda barreira contra duplo clique/race.
            // Se outra requisição já gravou este mesmo job, tratamos como sucesso idempotente.
            if (importJobId && String(insertResult.error.code || '') === '23505') {
                const { data: existingRows, error: existingError } = await supabase
                    .from('rfq_cotacoes')
                    .select('*')
                    .eq('rfq_import_job_id', importJobId)
                    .order('rfq_import_row_key', { ascending: true });
                if (existingError) throw existingError;
                if (!existingRows?.length) throw insertResult.error;
                saved = existingRows;
                alreadySaved = true;
                try { await markRfqImportJobSaved(importJobId); } catch (_) { /* auto-cura best effort */ }
            } else {
                throw insertResult.error;
            }
        } else {
            saved = insertResult.data || [];
        }

        if (alreadySaved) {
            return respondSuccess(
                `Documento comercial ${quotationNumber} já havia sido gravado. Nenhuma linha foi duplicada.`,
                { data: saved, moeda: 'GBP', tipo_cotacao: tipoCotacao, already_saved: true, import_job_id: importJobId },
                { tabelaAlvo: 'rfq_cotacoes', linhasImportadas: 0, detalhes: { modo: 'rfq_salvar_idempotente', quotation_number: quotationNumber, job_id: importJobId, already_saved: true } }
            );
        }

        // A partir daqui o documento comercial principal já está persistido.
        // Marcar SAVED vem antes de enriquecimentos auxiliares para que uma falha secundária
        // nunca induza o usuário a clicar novamente e duplicar a cotação.
        const postSaveWarnings = [];
        if (importJobId) {
            try {
                await markRfqImportJobSaved(importJobId);
            } catch (jobError) {
                postSaveWarnings.push(`Documento gravado; status do processamento será reconciliado na próxima abertura (${jobError.message || 'falha ao marcar SAVED'}).`);
                console.warn('[SISHA][rfq] Documento gravado; falha ao marcar job SAVED:', jobError.message || jobError);
            }
        }

        // ALTERNATIVO/EQUIVALENTE explícito pode alimentar a biblioteca documental existente.
        // É enriquecimento posterior e não invalida a gravação principal do documento comercial.
        let alternativasNovas = 0;
        const candidatos = insercoes.filter((row) => row.pn_relacionado && row.pn_relacionado !== row.pn && ['ALTERNATIVO', 'EQUIVALENTE'].includes(row.tipo_relacao_pn));
        for (const row of candidatos) {
            try {
                const [directRes, reverseRes] = await Promise.all([
                    supabase.from('pn_alternativos_documento').select('id').eq('ativo', true).eq('pn', row.pn).eq('pn_alt', row.pn_relacionado).limit(1),
                    supabase.from('pn_alternativos_documento').select('id').eq('ativo', true).eq('pn', row.pn_relacionado).eq('pn_alt', row.pn).limit(1),
                ]);
                if (directRes.error) throw directRes.error;
                if (reverseRes.error) throw reverseRes.error;
                if (directRes.data?.length || reverseRes.data?.length) continue;
                const { error: altError } = await supabase.from('pn_alternativos_documento').insert({ pn: row.pn, pn_alt: row.pn_relacionado, fonte: `RFQ ${quotationNumber}`, tipo_relacao: row.tipo_relacao_pn, origem_tipo: 'RFQ', ativo: true, created_by_email: req.user?.email || null, updated_by_email: req.user?.email || null, updated_at: new Date().toISOString() });
                if (altError) throw altError;
                alternativasNovas += 1;
            } catch (altError) {
                postSaveWarnings.push(`Documento gravado; relação documental ${row.pn} ↔ ${row.pn_relacionado} ficou pendente de enriquecimento.`);
                console.warn('[SISHA][rfq] Falha em enriquecimento de PN após gravação principal:', altError.message || altError);
            }
        }

        if (insercoes.some((row) => row.tipo_cotacao === 'MATERIAL')) {
            const pricedPns = insercoes
                .filter((row) => row.tipo_cotacao === 'MATERIAL' && row.match_mode === 'EXACT' && row.one_time_only !== true && Number(row.valor_unitario) > 0)
                .map((row) => row.pn);
            try {
                await markRequestsAnswered({ pns: pricedPns, quotationNumber });
            } catch (requestError) {
                postSaveWarnings.push('Documento gravado; atualização automática dos pedidos de cotação ficou pendente.');
                console.warn('[SISHA][rfq] Falha ao marcar solicitações respondidas após gravação principal:', requestError.message || requestError);
            }
        }

        return respondSuccess(
            `${insercoes.length} item(ns) da Cotação ${quotationNumber} gravado(s) uma única vez.`,
            {
                data: saved || [], moeda: 'GBP', tipo_cotacao: tipoCotacao,
                already_saved: false,
                import_job_id: importJobId || null,
                post_save_warnings: postSaveWarnings,
                alternativas_documentais_adicionadas: alternativasNovas,
                evolucoes_fornecimento_preservadas: insercoes.filter((row) => ['SUPERSEDED_BY', 'SUPERSEDES'].includes(row.tipo_relacao_pn)).length,
            },
            { tabelaAlvo: 'rfq_cotacoes', linhasImportadas: insercoes.length, detalhes: { modo: origemRegistro === 'MANUAL' ? 'rfq_manual_criar' : 'rfq_salvar_unico', quotation_number: quotationNumber, fornecedor, tipo_cotacao: tipoCotacao, job_id: importJobId || null } }
        );
    } catch (error) {
        console.error('ERRO AO SALVAR RFQ:', error);
        setAuditSummary(req, { status: 'ERRO', mensagem: 'Erro crítico ao gravar a Cotação no banco de dados.', tabelaAlvo: 'rfq_cotacoes', detalhes: { modo: 'rfq_salvar', erro: error.message || String(error) } });
        return res.status(500).json({ status: 'error', message: error.message || 'Erro crítico ao gravar a Cotação no banco de dados.' });
    }
};

// =======================================================
// MANUTENÇÃO MANUAL DE COTAÇÕES — ADMIN/DONO
// =======================================================
exports.listRfqCotacoes = async (req, res) => {
    try {
        const q = String(req.query.q || '').trim();
        const includeInactive = String(req.query.include_inactive || '').toLowerCase() === 'true';
        let query = supabase.from('rfq_cotacoes').select('*').order('data_insercao', { ascending: false }).limit(300);
        if (!includeInactive) query = query.eq('ativo', true);
        if (q) {
            const safe = q.replace(/[,%()]/g, ' ').trim();
            if (safe) query = query.or(`pn.ilike.%${safe}%,pn_relacionado.ilike.%${safe}%,pn_original_solicitado.ilike.%${safe}%,material_reference.ilike.%${safe}%,cotacao_numero.ilike.%${safe}%,contrato_referencia.ilike.%${safe}%,documento_tipo.ilike.%${safe}%,fornecedor.ilike.%${safe}%,wo_referencia.ilike.%${safe}%,sn.ilike.%${safe}%,nomenclatura.ilike.%${safe}%`);
        }
        const { data, error } = await query;
        if (error) throw error;
        return res.status(200).json({ status: 'success', data: data || [] });
    } catch (error) {
        return res.status(500).json({ status: 'error', message: error.message || 'Falha ao consultar cotações.' });
    }
};

exports.updateRfqCotacao = async (req, res) => {
    try {
        const id = String(req.params.id || '').trim();
        if (!id) return res.status(400).json({ status: 'error', message: 'ID da cotação não informado.' });
        const body = req.body || {};
        const allowedRelations = new Set(['ALTERNATIVO', 'EQUIVALENTE', 'SUPERSEDED_BY', 'SUPERSEDES']);
        const allowedTypes = new Set(['MATERIAL', 'REPARO', 'OVERHAUL', 'SERVICO', 'OUTRO']);
        const type = String(body.tipo_cotacao || 'MATERIAL').trim().toUpperCase();
        const relation = String(body.tipo_relacao_pn || '').trim().toUpperCase();
        const payload = {
            cotacao_numero: String(body.cotacao_numero || '').trim() || `MANUAL-${Date.now()}`,
            data_cotacao: String(body.data_cotacao || '').trim() || null,
            validade: String(body.validade || '').trim() || 'N/I',
            referencia_pedido: String(body.referencia_pedido || '').trim() || null,
            condicao: String(body.condicao || 'New').trim() || 'New',
            fornecedor: String(body.fornecedor || 'LEONARDO').trim() || 'LEONARDO',
            tipo_cotacao: allowedTypes.has(type) ? type : 'OUTRO',
            documento_tipo: String(body.documento_tipo || 'GENERIC_COMMERCIAL_DOCUMENT').trim().toUpperCase(),
            contrato_referencia: String(body.contrato_referencia || '').trim() || null,
            termos_pagamento: String(body.termos_pagamento || '').trim().slice(0, 2000) || null,
            termos_entrega: String(body.termos_entrega || '').trim().slice(0, 2000) || null,
            items_total: Number(body.items_total) || 0,
            packing_delivery_percent: Number(body.packing_delivery_percent) || 0,
            packing_delivery_value: Number(body.packing_delivery_value) || 0,
            final_amount: Number(body.final_amount) || 0,
            pn: String(body.pn || '').trim().toUpperCase(),
            nsn: String(body.nsn || '').trim() || null,
            material_reference: String(body.material_reference || '').trim() || null,
            material_reference_status: String(body.material_reference_status || '').trim().toUpperCase() || null,
            nomenclatura: String(body.nomenclatura || '').trim() || null,
            sn: String(body.sn || '').trim() || null,
            wo_referencia: String(body.wo_referencia || '').trim() || null,
            qtd_solicitada: Number(body.qtd_solicitada) || 0,
            lead_time_dias: Number(body.lead_time_dias) || 0,
            estoque_pronto: Number(body.estoque_pronto) || 0,
            valor_unitario: Number(body.valor_unitario) || 0,
            valor_total_item: Number(body.valor_total_item) || 0,
            preco_base: Number(body.preco_base) || 0,
            desconto_percentual: Number(body.desconto_percentual) || 0,
            price_status: String(body.price_status || (Number(body.valor_unitario) > 0 ? 'PRICED' : 'UNPRICED')).trim().toUpperCase(),
            one_time_only: Boolean(body.one_time_only),
            limite_quantidade: Number(body.limite_quantidade) || 0,
            prazo_condicao: formatDbDate(body.prazo_condicao),
            match_mode: String(body.match_mode || 'EXACT').trim().toUpperCase() === 'PATTERN' ? 'PATTERN' : 'EXACT',
            pn_original_solicitado: String(body.pn_original_solicitado || '').trim().toUpperCase() || null,
            correcao_pn_tipo: String(body.correcao_pn_tipo || '').trim().toUpperCase() || null,
            source_page: Number(body.source_page) || null,
            source_excerpt: String(body.source_excerpt || '').trim().slice(0, 4000) || null,
            condicao_item: String(body.condicao_item || '').trim().slice(0, 500) || null,
            moeda: 'GBP',
            observacoes: String(body.observacoes || '').trim().slice(0, 4000) || null,
            pn_relacionado: String(body.pn_relacionado || '').trim().toUpperCase() || null,
            tipo_relacao_pn: allowedRelations.has(relation) ? relation : null,
            relacao_pn_texto: String(body.relacao_pn_texto || '').trim().slice(0, 1000) || null,
            ativo: body.ativo !== false,
            updated_by_email: req.user?.email || null,
            updated_at: new Date().toISOString(),
        };
        if (!payload.pn) return res.status(400).json({ status: 'error', message: 'PN é obrigatório.' });
        if (payload.tipo_cotacao === 'MATERIAL' && !String(body.validade || '').trim()) return res.status(400).json({ status: 'error', message: 'Validade é obrigatória para cotação de material.' });

        const { data, error } = await supabase.from('rfq_cotacoes').update(payload).eq('id', id).select('*').single();
        if (error) throw error;
        setAuditSummary(req, { status: 'SUCESSO', mensagem: `Cotação ${payload.cotacao_numero} atualizada manualmente.`, tabelaAlvo: 'rfq_cotacoes', linhasImportadas: 1, detalhes: { modo: 'rfq_manual_editar', id } });
        return res.status(200).json({ status: 'success', message: 'Cotação atualizada.', data });
    } catch (error) {
        setAuditSummary(req, { status: 'ERRO', mensagem: error.message || 'Falha ao atualizar cotação.', tabelaAlvo: 'rfq_cotacoes', detalhes: { modo: 'rfq_manual_editar' } });
        return res.status(500).json({ status: 'error', message: error.message || 'Falha ao atualizar cotação.' });
    }
};

exports.deactivateRfqCotacao = async (req, res) => {
    try {
        const id = String(req.params.id || '').trim();
        const { data, error } = await supabase.from('rfq_cotacoes').update({ ativo: false, updated_by_email: req.user?.email || null, updated_at: new Date().toISOString() }).eq('id', id).select('id,cotacao_numero,pn').single();
        if (error) throw error;
        setAuditSummary(req, { status: 'SUCESSO', mensagem: `Cotação ${data?.cotacao_numero || id} desativada logicamente.`, tabelaAlvo: 'rfq_cotacoes', linhasImportadas: 1, detalhes: { modo: 'rfq_manual_desativar', id } });
        return res.status(200).json({ status: 'success', message: 'Cotação desativada sem apagar o histórico.', data });
    } catch (error) {
        setAuditSummary(req, { status: 'ERRO', mensagem: error.message || 'Falha ao desativar cotação.', tabelaAlvo: 'rfq_cotacoes', detalhes: { modo: 'rfq_manual_desativar' } });
        return res.status(500).json({ status: 'error', message: error.message || 'Falha ao desativar cotação.' });
    }
};

exports.listImportLogs = async (req, res) => {
    try {
        const { data, error } = await supabase
            .from('import_logs')
            .select('id, tipo_arquivo, nome_arquivo, status, tabela_alvo, linhas_lidas, linhas_importadas, linhas_ignoradas, mensagem, detalhes, uploaded_by_email, uploaded_by_role, created_at, finished_at')
            .order('created_at', { ascending: false })
            .limit(20);

        if (error) throw error;

        return res.status(200).json({ status: 'success', data: data || [] });
    } catch (error) {
        return res.status(500).json({ status: 'error', message: 'Falha ao consultar logs de importação.' });
    }
};


exports.getPpuExternalCustodyReconciliation = async (req, res) => {
    try {
        const data = await getExternalCustodyReconciliation();
        return res.status(200).json({ status: 'success', data });
    } catch (error) {
        return res.status(500).json({ status: 'error', message: error?.message || 'Falha ao carregar reconciliação da custódia externa PPU.' });
    }
};

exports.decidePpuExternalCustodyReconciliation = async (req, res) => {
    try {
        const result = await saveReconciliationDecision({
            importId: req.body?.import_id,
            groupKey: req.body?.group_key,
            decision: req.body?.decision,
            reason: req.body?.reason,
            user: req.user || {},
        });
        await registrarAuditoria({
            req,
            action: 'PPU_CUSTODIA_EXTERNA_DECISAO',
            entity: 'PPU_CUSTODIA_EXTERNA',
            entityId: req.body?.group_key || null,
            summary: `Reconciliação ${req.body?.decision || 'N/A'} para custódia externa PPU`,
            details: { import_id: req.body?.import_id || null, group_key: req.body?.group_key || null, decision: req.body?.decision || null, reason: req.body?.reason || null },
            required: true,
        });
        const data = await getExternalCustodyReconciliation();
        return res.status(200).json({ status: 'success', message: 'Decisão registrada com auditoria.', data, result });
    } catch (error) {
        return res.status(400).json({ status: 'error', message: error?.message || 'Falha ao registrar decisão de reconciliação.' });
    }
};
