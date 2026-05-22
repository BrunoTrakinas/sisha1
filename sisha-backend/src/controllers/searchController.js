// src/controllers/searchController.js
const supabase = require('../config/supabaseClient');

function addUndirectedEdge(graph, a, b) {
    if (!a || !b || a === b) return;
    if (!graph.has(a)) graph.set(a, new Set());
    if (!graph.has(b)) graph.set(b, new Set());
    graph.get(a).add(b);
    graph.get(b).add(a);
}

function collectConnectedAlternatives(graph, start) {
    if (!start || !graph.has(start)) return [];
    const visited = new Set([start]);
    const queue = [start];

    while (queue.length > 0) {
        const current = queue.shift();
        const neighbours = graph.get(current) || new Set();
        neighbours.forEach((next) => {
            if (!visited.has(next)) {
                visited.add(next);
                queue.push(next);
            }
        });
    }

    visited.delete(start);
    return Array.from(visited);
}

function mergeSourceLabels(...parts) {
    const labels = new Set();
    parts.flat().forEach((part) => {
        if (!part) return;
        if (Array.isArray(part)) {
            part.forEach((sub) => mergeSourceLabels(sub).forEach((label) => labels.add(label)));
            return;
        }
        String(part)
            .split('|')
            .map((s) => s.trim())
            .filter(Boolean)
            .forEach((label) => labels.add(label));
    });
    return Array.from(labels);
}

function normalizeUpper(value) {
    return String(value || '').trim().toUpperCase();
}

function looksLikePn(value = '') {
    const pn = normalizeUpper(value);
    return pn.length >= 5 && /[0-9]/.test(pn) && !pn.includes(' ');
}

function getSubItemPriority(value) {
    const text = normalizeUpper(value);
    if (!text) return 999;

    const letterMatch = text.match(/([A-Z])\s*$/);
    if (letterMatch) {
        return letterMatch[1].charCodeAt(0) - 64; // A=1, B=2, C=3...
    }

    const numericMatch = text.match(/(\d+)\s*$/);
    if (numericMatch) {
        return Number(numericMatch[1]);
    }

    return 999;
}

function compareManualAlternativeRows(a = {}, b = {}) {
    const priorityDiff = getSubItemPriority(a.sub_item) - getSubItemPriority(b.sub_item);
    if (priorityDiff !== 0) return priorityDiff;

    const subDiff = normalizeUpper(a.sub_item).localeCompare(normalizeUpper(b.sub_item));
    if (subDiff !== 0) return subDiff;

    return normalizeUpper(a.pn).localeCompare(normalizeUpper(b.pn));
}

function compareAlternativeCards(a = {}, b = {}) {
    const aManual = String(a.origem || '').includes('manual');
    const bManual = String(b.origem || '').includes('manual');

    if (aManual || bManual) {
        const priorityDiff = (a.prioridade_manual ?? 999) - (b.prioridade_manual ?? 999);
        if (priorityDiff !== 0) return priorityDiff;
    }

    const sourceDiff = String(a.origem || '').localeCompare(String(b.origem || ''));
    if (sourceDiff !== 0) return sourceDiff;

    return normalizeUpper(a.pn).localeCompare(normalizeUpper(b.pn));
}

function isNsnReal(nsn) {
    return nsn && String(nsn) !== 'N/A' && !String(nsn).includes('PND');
}

function ensureSourceBag(map, pn) {
    if (!map[pn]) map[pn] = new Set();
    return map[pn];
}

function registerSource(sourceMap, pn, label) {
    if (!pn || !label) return;
    ensureSourceBag(sourceMap, pn).add(label);
}

const GENERIC_NAME_PATTERNS = [
    /^N\/?A$/i,
    /^CADASTRADO VIA DOCUMENTO$/i,
    /^AGUARDANDO CADASTRO$/i,
    /^SEM NOMENCLATURA$/i,
    /^ITEM SEM DESCRI(?:C|Ç)(?:A|Ã)O$/i,
    /^DESCRI(?:C|Ç)(?:A|Ã)O N(?:A|Ã)O INFORMADA$/i,
];

const NAME_SOURCE_PRIORITY = {
    DICIONARIO_MESTRE: 100,
    PRICE_LIST: 90,
    SERVICE_BULLETIN: 85,
    RFQ_COTACOES: 80,
    ORDER_BOOK: 78,
    ORDER_BOOK_FOC: 76,
    ORDER_BOOK_REPAIR: 75,
    ORDER_BOOK_ADMIN_DOC: 72,
    ESTOQUE_PPU: 70,
    LISDE: 60,
    CEIMSPA_VIA_DICIONARIO: 55,
    ITEMS: 40,
    PN_ALTERNATIVOS_DOCUMENTO: 30,
};

function isMeaningfulName(name) {
    const value = String(name || '').trim();
    if (!value) return false;
    return !GENERIC_NAME_PATTERNS.some((pattern) => pattern.test(value));
}

function getNameScore(name, label) {
    if (!isMeaningfulName(name)) return -1000;
    const base = NAME_SOURCE_PRIORITY[label] ?? 10;
    return base + Math.min(String(name).trim().length, 40) / 100;
}

function setBestName(baseNomes, nomeFonte, pn, nome, label) {
    if (!pn || !label) return;
    const nextScore = getNameScore(nome, label);
    if (nextScore < 0) return;
    const currentName = baseNomes[pn];
    const currentLabel = nomeFonte[pn];
    const currentScore = getNameScore(currentName, currentLabel);
    if (nextScore > currentScore) {
        baseNomes[pn] = String(nome).trim();
        nomeFonte[pn] = label;
    }
}

function chooseBestName(candidates = [], fallbackName = 'N/A', fallbackSource = null) {
    let best = { nome: fallbackName, origem: fallbackSource, score: getNameScore(fallbackName, fallbackSource) };
    candidates.forEach((candidate) => {
        if (!candidate) return;
        const nome = String(candidate.nome || '').trim();
        const origem = candidate.origem || null;
        const score = getNameScore(nome, origem);
        if (score > best.score) {
            best = { nome, origem, score };
        }
    });
    if (best.score < 0) return { nome: fallbackName || 'N/A', origem: fallbackSource || null };
    return { nome: best.nome, origem: best.origem };
}

function setNsnIfHigherPriority(baseNsns, nsnFonte, pn, nsn, label) {
    if (!pn || !isNsnReal(nsn)) return;
    if (!isNsnReal(baseNsns[pn])) {
        baseNsns[pn] = nsn;
        nsnFonte[pn] = label;
    }
}

function buildSbRelatedMap(sbItemRows = []) {
    const bySb = new Map();
    (sbItemRows || []).forEach((row) => {
        const sbNumero = normalizeUpper(row.sb_numero);
        const pn = normalizeUpper(row.pn);
        if (!sbNumero || !pn) return;
        if (!bySb.has(sbNumero)) bySb.set(sbNumero, new Set());
        bySb.get(sbNumero).add(pn);
    });
    return bySb;
}

function buildCeimspaUnconfirmedResults(ceimspaRows = [], query = '') {
    const grouped = new Map();

    (ceimspaRows || []).forEach((row) => {
        const pi = normalizeUpper(row.pi);
        if (!pi) return;
        if (!grouped.has(pi)) {
            grouped.set(pi, {
                pi,
                nomenclatura: row.nomenclatura || 'Item localizado no CeIMSPA sem PN confirmado',
                quantidade: 0,
                detalhes: [],
            });
        }

        const current = grouped.get(pi);
        current.quantidade += Number(row.quantidade || 0);
        current.detalhes.push(row);
        if (isMeaningfulName(row.nomenclatura) && !isMeaningfulName(current.nomenclatura)) {
            current.nomenclatura = row.nomenclatura;
        }
    });

    return Array.from(grouped.values()).map((entry) => ({
        pn: 'PN NÃO CONFIRMADO',
        nomenclatura: entry.nomenclatura || 'Item localizado no CeIMSPA sem PN confirmado',
        nsn: entry.pi || query || 'PI localizado no CeIMSPA',
        origem_identificacao: ['CEIMSPA_SEM_PN_CONFIRMADO'],
        origem_nomenclatura: 'ESTOQUE_CEIMSPA',
        origem_nsn: 'ESTOQUE_CEIMSPA',
        aviso_operacional: 'PI localizado no CeIMSPA, porém sem PN confirmado no Manual/Dicionário. Confirmar com o CeIMSPA antes de assumir disponibilidade.',
        oda: [],
        odc: [],
        foc: [],
        repairs: [],
        lisde: [],
        price_list: [],
        ppu_qtd: 0,
        ppu_locais: 'N/A',
        data_garantia: null,
        dicionario: [],
        alternativos: [],
        tem_mapa_manual: false,
        fontes_alternativos: [],
        ceimspa_detalhes: entry.detalhes,
        ceimspa_qtd: entry.quantidade,
        sb_referencias: [],
    }));
}

exports.searchItems = async (req, res) => {
    try {
        const { q } = req.query;
        if (!q) return res.status(400).json({ status: 'error', message: 'Termo de busca vazio.' });

        const query = q.toUpperCase().trim();

        let pnsEncontrados = new Set();
        let baseNomes = {};
        let baseNsns = {};
        let origemNomenclaturaBase = {};
        let origemNsnBase = {};
        let fontesEncontradas = {};

        // ---------------------------------------------------------
        // FASE 1: VARREDURA PARALELA (À PROVA DE FALHAS E HIPER-RÁPIDA)
        // ---------------------------------------------------------
        const p1 = supabase.from('items').select('pn, nomenclatura, nsn').or(`pn.ilike.%${query}%,nsn.ilike.%${query}%,nomenclatura.ilike.%${query}%`).limit(50);
        const p2 = supabase.from('dicionario_mestre').select('pn, nomenclatura, nsn, pi').or(`pn.ilike.%${query}%,nsn.ilike.%${query}%,pi.ilike.%${query}%,nomenclatura.ilike.%${query}%`).limit(50);
        const p3 = supabase.from('estoque_ppu').select('pn, nomenclatura, nsn_pi, sn').or(`pn.ilike.%${query}%,nsn_pi.ilike.%${query}%,sn.ilike.%${query}%,nomenclatura.ilike.%${query}%`).limit(50);
        const p4 = supabase.from('lisde').select('pn, nomenclatura').or(`pn.ilike.%${query}%,nomenclatura.ilike.%${query}%`).limit(50);
        const p5 = supabase.from('price_list').select('pn, nomenclatura, nsn').or(`pn.ilike.%${query}%,nsn.ilike.%${query}%,nomenclatura.ilike.%${query}%`).limit(20);
        const p6 = supabase.from('estoque_ceimspa').select('pi, nomenclatura, quantidade, sj, uf').or(`pi.ilike.%${query}%,nomenclatura.ilike.%${query}%`).limit(50);
        const p7 = supabase.from('rfq_cotacoes').select('pn, nomenclatura, nsn').or(`pn.ilike.%${query}%,nsn.ilike.%${query}%,nomenclatura.ilike.%${query}%`).limit(20);
        const p8 = supabase.from('pn_alternativos_documento').select('pn, pi, pn_alt, fonte').or(`pn.ilike.%${query}%,pi.ilike.%${query}%,pn_alt.ilike.%${query}%`).limit(100);
        const p9 = supabase.from('service_bulletin_items').select('sb_numero, pn, nsn, nomenclatura').or(`pn.ilike.%${query}%`).limit(80);
        const p10 = supabase.from('service_bulletins').select('sb_numero, titulo').or(`sb_numero.ilike.%${query}%,titulo.ilike.%${query}%`).limit(30);
        const p11 = supabase.from('item_apelidos').select('pn, apelido, descricao_oficial').eq('ativo', true).or(`pn.ilike.%${query}%,apelido.ilike.%${query}%,descricao_oficial.ilike.%${query}%`).limit(50);
        const p12 = supabase.from('leonardo_spares').select('pn,descricao,documento_referencia,oc_referencia,status_categoria').or(`pn.ilike.%${query}%,descricao.ilike.%${query}%,documento_referencia.ilike.%${query}%,oc_referencia.ilike.%${query}%,status_categoria.ilike.%${query}%`).limit(80);
        const p13 = supabase.from('leonardo_foc_spares').select('pn,descricao,documento_referencia').or(`pn.ilike.%${query}%,descricao.ilike.%${query}%,documento_referencia.ilike.%${query}%`).limit(80);
        const p14 = supabase.from('leonardo_repairs').select('pn,sn,descricao,tipo,documento_referencia,status').or(`pn.ilike.%${query}%,sn.ilike.%${query}%,descricao.ilike.%${query}%,documento_referencia.ilike.%${query}%,status.ilike.%${query}%,tipo.ilike.%${query}%`).limit(120);
        const p15 = supabase.from('leonardo_admin_docs').select('tipo_doc,numero_doc,assunto_pn,status').or(`numero_doc.ilike.%${query}%,assunto_pn.ilike.%${query}%,status.ilike.%${query}%`).limit(80);

        const results = await Promise.allSettled([p1, p2, p3, p4, p5, p6, p7, p8, p9, p10, p11, p12, p13, p14, p15]);
        const getRes = (index) => results[index].status === 'fulfilled' ? results[index].value.data : null;

        const itemsMatch = getRes(0) || [];
        const dicMatch = getRes(1) || [];
        const ppuMatch = getRes(2) || [];
        const lisdeMatch = getRes(3) || [];
        const plMatch = getRes(4) || [];
        const ceimspaMatch = getRes(5) || [];
        const rfqMatch = getRes(6) || [];
        const altDocMatch = getRes(7) || [];
        const sbPnMatch = getRes(8) || [];
        const sbHeaderMatch = getRes(9) || [];
        const apelidosMatch = getRes(10) || [];
        const orderBookMatch = getRes(11) || [];
        const focMatch = getRes(12) || [];
        const repairMatch = getRes(13) || [];
        const adminDocMatch = getRes(14) || [];

        apelidosMatch.forEach((i) => {
            const pn = normalizeUpper(i.pn);
            if (!pn) return;
            pnsEncontrados.add(pn);
            registerSource(fontesEncontradas, pn, 'APELIDO_OPERACIONAL');
            setBestName(baseNomes, origemNomenclaturaBase, pn, i.descricao_oficial, 'ITEMS');
        });

        orderBookMatch.forEach((i) => {
            const pn = normalizeUpper(i.pn);
            if (!pn) return;
            pnsEncontrados.add(pn);
            registerSource(fontesEncontradas, pn, 'ORDER_BOOK');
            setBestName(baseNomes, origemNomenclaturaBase, pn, i.descricao, 'ORDER_BOOK');
        });

        focMatch.forEach((i) => {
            const pn = normalizeUpper(i.pn);
            if (!pn) return;
            pnsEncontrados.add(pn);
            registerSource(fontesEncontradas, pn, 'ORDER_BOOK_FOC');
            setBestName(baseNomes, origemNomenclaturaBase, pn, i.descricao, 'ORDER_BOOK_FOC');
        });

        repairMatch.forEach((i) => {
            const pn = normalizeUpper(i.pn);
            if (!pn) return;
            pnsEncontrados.add(pn);
            registerSource(fontesEncontradas, pn, 'ORDER_BOOK_REPAIR');
            setBestName(baseNomes, origemNomenclaturaBase, pn, i.descricao, 'ORDER_BOOK_REPAIR');
        });

        adminDocMatch.forEach((i) => {
            const pn = normalizeUpper(i.assunto_pn);
            if (!looksLikePn(pn)) return;
            pnsEncontrados.add(pn);
            registerSource(fontesEncontradas, pn, `ORDER_BOOK_${normalizeUpper(i.tipo_doc || 'DOC')}`);
            setBestName(baseNomes, origemNomenclaturaBase, pn, i.assunto_pn, 'ORDER_BOOK_ADMIN_DOC');
        });

        itemsMatch.forEach((i) => {
            const pn = normalizeUpper(i.pn);
            if (!pn) return;
            pnsEncontrados.add(pn);
            registerSource(fontesEncontradas, pn, 'ITEMS');
            setBestName(baseNomes, origemNomenclaturaBase, pn, i.nomenclatura, 'ITEMS');
            if (isNsnReal(i.nsn)) {
                baseNsns[pn] = i.nsn;
                origemNsnBase[pn] = 'ITEMS';
            }
        });

        dicMatch.forEach((i) => {
            const pn = normalizeUpper(i.pn);
            if (!pn) return;
            pnsEncontrados.add(pn);
            registerSource(fontesEncontradas, pn, 'DICIONARIO_MESTRE');
            setBestName(baseNomes, origemNomenclaturaBase, pn, i.nomenclatura, 'DICIONARIO_MESTRE');
            setNsnIfHigherPriority(baseNsns, origemNsnBase, pn, i.nsn, 'DICIONARIO_MESTRE');
        });

        ppuMatch.forEach((i) => {
            const pn = normalizeUpper(i.pn);
            if (!pn) return;
            pnsEncontrados.add(pn);
            registerSource(fontesEncontradas, pn, 'ESTOQUE_PPU');
            setBestName(baseNomes, origemNomenclaturaBase, pn, i.nomenclatura, 'ESTOQUE_PPU');
            setNsnIfHigherPriority(baseNsns, origemNsnBase, pn, i.nsn_pi, 'ESTOQUE_PPU');
            if (normalizeUpper(i.sn) === query) {
                registerSource(fontesEncontradas, pn, 'SN_ESTOQUE_PPU');
            }
        });

        lisdeMatch.forEach((i) => {
            const pn = normalizeUpper(i.pn);
            if (!pn) return;
            pnsEncontrados.add(pn);
            registerSource(fontesEncontradas, pn, 'LISDE');
            setBestName(baseNomes, origemNomenclaturaBase, pn, i.nomenclatura, 'LISDE');
        });

        plMatch.forEach((i) => {
            const pn = normalizeUpper(i.pn);
            if (!pn) return;
            pnsEncontrados.add(pn);
            registerSource(fontesEncontradas, pn, 'PRICE_LIST');
            setBestName(baseNomes, origemNomenclaturaBase, pn, i.nomenclatura, 'PRICE_LIST');
            setNsnIfHigherPriority(baseNsns, origemNsnBase, pn, i.nsn, 'PRICE_LIST');
        });

        rfqMatch.forEach((i) => {
            const pn = normalizeUpper(i.pn);
            if (!pn) return;
            pnsEncontrados.add(pn);
            registerSource(fontesEncontradas, pn, 'RFQ_COTACOES');
            setBestName(baseNomes, origemNomenclaturaBase, pn, i.nomenclatura, 'RFQ_COTACOES');
            setNsnIfHigherPriority(baseNsns, origemNsnBase, pn, i.nsn, 'RFQ_COTACOES');
        });

        altDocMatch.forEach((i) => {
            const pn = normalizeUpper(i.pn);
            const pnAlt = normalizeUpper(i.pn_alt);
            if (pn) {
                pnsEncontrados.add(pn);
                registerSource(fontesEncontradas, pn, 'PN_ALTERNATIVOS_DOCUMENTO');
            }
            if (pnAlt) {
                pnsEncontrados.add(pnAlt);
                registerSource(fontesEncontradas, pnAlt, 'PN_ALTERNATIVOS_DOCUMENTO');
            }
            if (pn && i.pi) setNsnIfHigherPriority(baseNsns, origemNsnBase, pn, i.pi, 'PN_ALTERNATIVOS_DOCUMENTO');
            if (pnAlt && i.pi) setNsnIfHigherPriority(baseNsns, origemNsnBase, pnAlt, i.pi, 'PN_ALTERNATIVOS_DOCUMENTO');
        });

        sbPnMatch.forEach((i) => {
            const pn = normalizeUpper(i.pn);
            if (!pn) return;
            pnsEncontrados.add(pn);
            registerSource(fontesEncontradas, pn, 'SERVICE_BULLETIN');
            setBestName(baseNomes, origemNomenclaturaBase, pn, i.nomenclatura, 'SERVICE_BULLETIN');
            setNsnIfHigherPriority(baseNsns, origemNsnBase, pn, i.nsn, 'SERVICE_BULLETIN');
        });

        if (sbHeaderMatch.length > 0) {
            const sbNumerosConsulta = [...new Set(sbHeaderMatch.map((row) => normalizeUpper(row.sb_numero)).filter(Boolean))];
            if (sbNumerosConsulta.length > 0) {
                try {
                    const { data: sbItensConsulta } = await supabase
                        .from('service_bulletin_items')
                        .select('sb_numero, pn, nsn, nomenclatura')
                        .in('sb_numero', sbNumerosConsulta);

                    (sbItensConsulta || []).forEach((row) => {
                        const pn = normalizeUpper(row.pn);
                        if (!pn) return;
                        pnsEncontrados.add(pn);
                        registerSource(fontesEncontradas, pn, 'SERVICE_BULLETIN');
                        setBestName(baseNomes, origemNomenclaturaBase, pn, row.nomenclatura, 'SERVICE_BULLETIN');
                        setNsnIfHigherPriority(baseNsns, origemNsnBase, pn, row.nsn, 'SERVICE_BULLETIN');
                    });
                } catch (_) {
                    // busca por cabeçalho de SB é complementar; não derruba a consulta
                }
            }
        }

        if (ceimspaMatch.length > 0) {
            const pis = ceimspaMatch.map((c) => c.pi).filter(Boolean);
            if (pis.length > 0) {
                const { data: dicPis } = await supabase.from('dicionario_mestre').select('pn, nomenclatura, nsn').in('pi', pis);
                (dicPis || []).forEach((i) => {
                    const pn = normalizeUpper(i.pn);
                    if (!pn) return;
                    pnsEncontrados.add(pn);
                    registerSource(fontesEncontradas, pn, 'CEIMSPA_VIA_DICIONARIO');
                    setBestName(baseNomes, origemNomenclaturaBase, pn, i.nomenclatura, 'CEIMSPA_VIA_DICIONARIO');
                    setNsnIfHigherPriority(baseNsns, origemNsnBase, pn, i.nsn, 'CEIMSPA_VIA_DICIONARIO');
                });
            }
        }

        const altDocExactMatch = altDocMatch.some((row) => {
            const pn = normalizeUpper(row.pn);
            const pnAlt = normalizeUpper(row.pn_alt);
            const pi = normalizeUpper(row.pi);
            return pn === query || pnAlt === query || pi === query;
        });

        if (altDocExactMatch && pnsEncontrados.has(query)) {
            pnsEncontrados = new Set([query]);
        }

        const arrayPns = Array.from(pnsEncontrados);
        if (arrayPns.length === 0) {
            if (ceimspaMatch.length > 0) {
                return res.status(200).json({
                    status: 'success',
                    data: buildCeimspaUnconfirmedResults(ceimspaMatch, query),
                });
            }
            return res.status(200).json({ status: 'success', data: [] });
        }

        // ---------------------------------------------------------
        // FASE 2: RECOLHA DE DADOS EM LOTE (PARALELA)
        // ---------------------------------------------------------
        const q1 = supabase.from('estoque_ppu').select('*').in('pn', arrayPns);
        const q2 = supabase.from('leonardo_spares').select('*').in('pn', arrayPns);
        const q3 = supabase.from('leonardo_foc_spares').select('*').in('pn', arrayPns);
        const q4 = supabase.from('leonardo_repairs').select('*').in('pn', arrayPns);
        const q5 = supabase.from('dicionario_mestre').select('*').in('pn', arrayPns);
        const q6 = supabase.from('odc_requests').select('*').in('pn', arrayPns);
        const q7 = supabase.from('lisde').select('*').in('pn', arrayPns);
        const q8 = supabase.from('price_list').select('*').in('pn', arrayPns);
        const q9 = supabase.from('rfq_cotacoes').select('*').in('pn', arrayPns);
        const q10 = supabase.from('service_bulletin_items').select('sb_numero, pn, nsn, nomenclatura, qtd, capitulo, item_num, aplicabilidade').in('pn', arrayPns);
        const q11 = supabase.from('compras_pds').select('*').in('pn', arrayPns).eq('ativo', true);
        const q12 = supabase.from('work_orders').select('*').in('pn', arrayPns).eq('ativo', true);
        const q13 = supabase.from('leonardo_admin_docs').select('*').in('assunto_pn', arrayPns);

        const batchResults = await Promise.allSettled([q1, q2, q3, q4, q5, q6, q7, q8, q9, q10, q11, q12, q13]);
        const getBatchRes = (index) => batchResults[index].status === 'fulfilled' ? batchResults[index].value.data : null;

        const ppuData = getBatchRes(0) || [];
        const odaData = getBatchRes(1) || [];
        const focData = getBatchRes(2) || [];
        const repData = getBatchRes(3) || [];
        const dicData = getBatchRes(4) || [];
        let odcData = getBatchRes(5) || [];
        if (!odcData || odcData.length === 0) {
            try {
                const { data: legacyOdc } = await supabase.from('pd_odc').select('*').in('pn', arrayPns);
                odcData = legacyOdc || [];
            } catch (_) {
                odcData = [];
            }
        }
        const lisdeData = getBatchRes(6) || [];
        const plData = getBatchRes(7) || [];
        const rfqDataFull = getBatchRes(8) || [];
        const sbItemData = getBatchRes(9) || [];
        const comprasPdData = getBatchRes(10) || [];
        const workOrdersData = getBatchRes(11) || [];
        const adminDocData = getBatchRes(12) || [];

        let altDocRows = [];
        try {
            const [altByPnRes, altByAltRes] = await Promise.allSettled([
                supabase.from('pn_alternativos_documento').select('pn, pi, pn_alt, fonte').in('pn', arrayPns),
                supabase.from('pn_alternativos_documento').select('pn, pi, pn_alt, fonte').in('pn_alt', arrayPns),
            ]);
            const altByPn = altByPnRes.status === 'fulfilled' ? (altByPnRes.value.data || []) : [];
            const altByAlt = altByAltRes.status === 'fulfilled' ? (altByAltRes.value.data || []) : [];
            const mapaAltDoc = new Map();
            [...altByPn, ...altByAlt].forEach((row) => {
                const chave = `${row.pn}|${row.pn_alt}|${row.fonte || ''}`;
                if (!mapaAltDoc.has(chave)) mapaAltDoc.set(chave, row);
            });
            altDocRows = Array.from(mapaAltDoc.values());
        } catch (_) {
            altDocRows = [];
        }

        const sbNumeros = [...new Set(sbItemData.map((row) => normalizeUpper(row.sb_numero)).filter(Boolean))];
        let sbHeaders = [];
        if (sbNumeros.length > 0) {
            try {
                const { data } = await supabase
                    .from('service_bulletins')
                    .select('sb_numero, titulo, tipo_sb, status_acao, observacao, fonte_documento')
                    .in('sb_numero', sbNumeros);
                sbHeaders = data || [];
            } catch (_) {
                sbHeaders = [];
            }
        }

        let sbRelatedRows = [];
        if (sbNumeros.length > 0) {
            try {
                const { data } = await supabase
                    .from('service_bulletin_items')
                    .select('sb_numero, pn')
                    .in('sb_numero', sbNumeros);
                sbRelatedRows = data || [];
            } catch (_) {
                sbRelatedRows = [];
            }
        }

        // ---------------------------------------------------------
        // FASE 3: INTELIGÊNCIA ALTERNATIVOS, CEIMSPA E SB
        // ---------------------------------------------------------
        const dmcsToSearch = dicData ? [...new Set(dicData.map((d) => d.dmc).filter(Boolean))] : [];
        let allAlternativosRaw = [];
        if (dmcsToSearch.length > 0) {
            const { data: alts } = await supabase.from('dicionario_mestre').select('pn,sub_item,nomenclatura,nsn,dmc,item_num,pi').in('dmc', dmcsToSearch);
            allAlternativosRaw = alts || [];
        }

        const altGraph = new Map();
        const altPiMap = new Map();

        altDocRows.forEach((row) => {
            const origem = normalizeUpper(row.pn);
            const alternativo = normalizeUpper(row.pn_alt);
            if (origem && alternativo && origem !== alternativo) {
                addUndirectedEdge(altGraph, origem, alternativo);
                if (row.pi && !altPiMap.has(origem)) altPiMap.set(origem, row.pi);
            }
        });

        const altPns = [...new Set([
            ...allAlternativosRaw.map((a) => a.pn),
            ...altDocRows.map((a) => a.pn),
            ...altDocRows.map((a) => a.pn_alt),
        ].filter(Boolean))];
        let ppuAltData = [];
        if (altPns.length > 0) {
            const safeAltPns = altPns.slice(0, 150).map((item) => normalizeUpper(item)).filter(Boolean);
            const { data: pAlt } = await supabase.from('estoque_ppu').select('pn, quantidade').in('pn', safeAltPns);
            ppuAltData = pAlt || [];
        }

        const pisToSearch = new Set();
        dicData.forEach((d) => { if (d.pi) pisToSearch.add(d.pi); });
        allAlternativosRaw.forEach((a) => { if (a.pi) pisToSearch.add(a.pi); });

        let allCeimspa = [];
        if (pisToSearch.size > 0) {
            const safePis = Array.from(pisToSearch).slice(0, 100);
            const { data: ceimspa } = await supabase.from('estoque_ceimspa').select('*').in('pi', safePis);
            allCeimspa = ceimspa || [];
        }

        const sbHeaderMap = new Map((sbHeaders || []).map((row) => [normalizeUpper(row.sb_numero), row]));
        const sbRelatedMap = buildSbRelatedMap(sbRelatedRows);

        // ---------------------------------------------------------
        // FASE 4: MONTAGEM FINAL DO CARTÃO
        // ---------------------------------------------------------
        const finalResults = [];
        const dataHoje = new Date();
        dataHoje.setHours(0, 0, 0, 0);

        for (const pn of arrayPns) {
            const pnUpper = normalizeUpper(pn);
            const myDic = dicData.filter((d) => normalizeUpper(d.pn) === pnUpper);
            const myPpu = ppuData.filter((p) => normalizeUpper(p.pn) === pnUpper);
            const myPl = plData.filter((p) => normalizeUpper(p.pn) === pnUpper);
            const myRfq = rfqDataFull.filter((r) => normalizeUpper(r.pn) === pnUpper);
            const mySbItems = sbItemData.filter((row) => normalizeUpper(row.pn) === pnUpper);

            let foundNsn = 'Aguardando Cadastro';
            let origemNsn = origemNsnBase[pnUpper] || null;

            const dicWithNsn = myDic.find((d) => isNsnReal(d.nsn));
            if (dicWithNsn) {
                foundNsn = dicWithNsn.nsn;
                origemNsn = 'DICIONARIO_MESTRE';
            } else {
                const ppuWithNsn = myPpu.find((p) => isNsnReal(p.nsn_pi));
                if (ppuWithNsn) {
                    foundNsn = ppuWithNsn.nsn_pi;
                    origemNsn = 'ESTOQUE_PPU';
                } else {
                    const plWithNsn = myPl.find((p) => isNsnReal(p.nsn));
                    if (plWithNsn) {
                        foundNsn = plWithNsn.nsn;
                        origemNsn = 'PRICE_LIST';
                    } else {
                        const rfqWithNsn = myRfq.find((r) => isNsnReal(r.nsn));
                        if (rfqWithNsn) {
                            foundNsn = rfqWithNsn.nsn;
                            origemNsn = 'RFQ_COTACOES';
                        } else if (isNsnReal(baseNsns[pnUpper])) {
                            foundNsn = baseNsns[pnUpper];
                            origemNsn = origemNsnBase[pnUpper] || 'BASE';
                        }
                    }
                }
            }

            const myLisde = lisdeData.filter((l) => normalizeUpper(l.pn) === pnUpper);
            const nomeEscolhido = chooseBestName([
                { nome: myDic.find((d) => isMeaningfulName(d.nomenclatura))?.nomenclatura, origem: 'DICIONARIO_MESTRE' },
                { nome: myPl.find((p) => isMeaningfulName(p.nomenclatura))?.nomenclatura, origem: 'PRICE_LIST' },
                { nome: mySbItems.find((s) => isMeaningfulName(s.nomenclatura))?.nomenclatura, origem: 'SERVICE_BULLETIN' },
                { nome: myRfq.find((r) => isMeaningfulName(r.nomenclatura))?.nomenclatura, origem: 'RFQ_COTACOES' },
                { nome: myPpu.find((p) => isMeaningfulName(p.nomenclatura))?.nomenclatura, origem: 'ESTOQUE_PPU' },
                { nome: myLisde.find((l) => isMeaningfulName(l.nomenclatura))?.nomenclatura, origem: 'LISDE' },
                { nome: baseNomes[pnUpper], origem: origemNomenclaturaBase[pnUpper] || null },
            ], baseNomes[pnUpper] || 'N/A', origemNomenclaturaBase[pnUpper] || null);

            let item = {
                pn: pnUpper,
                nomenclatura: nomeEscolhido.nome || 'N/A',
                nsn: foundNsn,
                origem_identificacao: fontesEncontradas[pnUpper] ? Array.from(fontesEncontradas[pnUpper]).sort() : [],
                origem_nomenclatura: nomeEscolhido.origem || null,
                origem_nsn: origemNsn || null,
            };

            item.oda = odaData.filter((p) => normalizeUpper(p.pn) === pnUpper);
            const legacyOdc = odcData.filter((p) => normalizeUpper(p.pn) === pnUpper);
            const comprasPdOdc = comprasPdData
                .filter((p) => {
                    const st = normalizeUpper(p.status_grupo || p.status);
                    return normalizeUpper(p.pn) === pnUpper && p.ativo !== false && !['CAN', 'EXCLUIDO', 'REC', 'FAT'].includes(st);
                })
                .map((p) => ({
                    ...p,
                    origem: p.origem_importacao || 'COMPRAS_PDS',
                    pd_referencia: p.numero_pd,
                    qtd_pendente: Number(p.qtd_comprada || p.quantidade || p.qtd_pedida || 0),
                    status_pd: p.status_grupo || p.status,
                    numero_oc: p.numero_oc,
                }));
            item.odc = [...legacyOdc, ...comprasPdOdc];
            item.foc = focData.filter((p) => normalizeUpper(p.pn) === pnUpper);
            const repairsOrderBook = repData.filter((p) => normalizeUpper(p.pn) === pnUpper);
            const repairsWo = workOrdersData
                .filter((p) => normalizeUpper(p.pn) === pnUpper && p.ativo !== false)
                .map((wo) => ({
                    ...wo,
                    origem: 'WORK_ORDER',
                    tipo: `WO/${wo.status || 'PENDENTE'}`,
                    documento_referencia: wo.numero_wo,
                    sn: wo.sn || 'PENDENTE',
                    nomenclatura: wo.nomenclatura || null,
                    fonte_nomenclatura: wo.fonte_nomenclatura || null,
                    status: wo.status,
                    resultado_tecnico: wo.resultado_tecnico || 'PENDENTE',
                    tipo_wo: wo.tipo_wo || null,
                    observacao: wo.observacao || null,
                    data_previsao: wo.data_previsao_entrega || wo.data_previsao,
                }));
            const docsOrderBook = adminDocData
                .filter((doc) => normalizeUpper(doc.assunto_pn) === pnUpper)
                .map((doc) => ({
                    origem: 'ORDER_BOOK_ADMIN_DOC',
                    tipo: doc.tipo_doc || 'DOC',
                    documento_referencia: doc.numero_doc,
                    status: doc.status || 'N/I',
                    sn: 'N/I',
                    pn: pnUpper,
                    observacao: `Documento ${doc.tipo_doc || 'Order Book'} vinculado ao PN ${pnUpper}`,
                }));
            item.repairs = [...repairsOrderBook, ...repairsWo, ...docsOrderBook];
            item.lisde = lisdeData.filter((l) => normalizeUpper(l.pn) === pnUpper);

            let cotacoesValidasParaOPriceList = [];
            myRfq.forEach((cotacao) => {
                if (cotacao.validade) {
                    const partesValidade = cotacao.validade.split(' a ');
                    const dataFimStr = partesValidade.length === 2 ? partesValidade[1].trim() : cotacao.validade.trim();
                    const pData = dataFimStr.split('.');
                    if (pData.length === 3) {
                        const dataFim = new Date(`${pData[2]}-${pData[1]}-${pData[0]}T12:00:00Z`);
                        if (dataFim >= dataHoje) {
                            cotacoesValidasParaOPriceList.push({
                                origem: 'RFQ',
                                valor_unitario: cotacao.valor_unitario,
                                lead_time: cotacao.lead_time_dias,
                                moq: cotacao.qtd_solicitada,
                                validade: cotacao.validade,
                                cotacao_numero: cotacao.cotacao_numero,
                                data_insercao: cotacao.data_insercao,
                            });
                        }
                    }
                }
            });
            cotacoesValidasParaOPriceList.sort((a, b) => new Date(b.data_insercao) - new Date(a.data_insercao));
            item.price_list = [...cotacoesValidasParaOPriceList, ...myPl];

            item.ppu_qtd = myPpu.reduce((acc, p) => acc + (Number(p.quantidade) || 0), 0);
            item.ppu_locais = myPpu.length > 0 ? [...new Set(myPpu.map((p) => p.localizacao))].join(' | ') : 'N/A';

            const garantias = myPpu.map((p) => p.data_garantia).filter(Boolean);
            item.data_garantia = garantias.length > 0 ? garantias.sort().reverse()[0] : null;

            item.dicionario = myDic;

            let altsUnicosMap = new Map();
            item.dicionario.forEach((entry) => {
                // DMC + Item identificam a família técnica.
                // Subitem não bloqueia equivalência; ele ordena preferência de uso (00A original, 00B primeira alternativa...).
                const irmaos = allAlternativosRaw
                    .filter((a) => a.dmc === entry.dmc && a.item_num === entry.item_num && normalizeUpper(a.pn) !== pnUpper)
                    .sort(compareManualAlternativeRows);

                irmaos.forEach((irmao) => {
                    const altPn = normalizeUpper(irmao.pn);
                    const altQty = ppuAltData.filter((p) => normalizeUpper(p.pn) === altPn).reduce((acc, p) => acc + (Number(p.quantidade) || 0), 0);
                    const prioridadeManual = getSubItemPriority(irmao.sub_item);
                    const existente = altsUnicosMap.get(altPn) || {};
                    altsUnicosMap.set(altPn, {
                        pn: altPn,
                        nsn: irmao.nsn,
                        ppu_qtd: altQty,
                        fonte: mergeSourceLabels(existente.fonte, ['MANUAL TÉCNICO']),
                        origem: 'manual',
                        sub_item: irmao.sub_item || existente.sub_item || null,
                        prioridade_manual: Math.min(existente.prioridade_manual ?? 999, prioridadeManual),
                    });
                });
            });

            const alternativosDocumento = collectConnectedAlternatives(altGraph, pnUpper);
            alternativosDocumento.forEach((pnAlt) => {
                const altQty = ppuAltData.filter((p) => normalizeUpper(p.pn) === pnAlt).reduce((acc, p) => acc + (Number(p.quantidade) || 0), 0);
                const nsnAlternativo = isNsnReal(baseNsns[pnAlt])
                    ? baseNsns[pnAlt]
                    : (allAlternativosRaw.find((a) => normalizeUpper(a.pn) === pnAlt)?.nsn || altPiMap.get(pnAlt) || 'N/A');

                const fontesDocumento = altDocRows
                    .filter((row) => {
                        const a = normalizeUpper(row.pn);
                        const b = normalizeUpper(row.pn_alt);
                        return a === pnAlt || b === pnAlt || a === pnUpper || b === pnUpper;
                    })
                    .map((row) => row.fonte)
                    .filter(Boolean);

                const existente = altsUnicosMap.get(pnAlt) || {};
                altsUnicosMap.set(pnAlt, {
                    pn: pnAlt,
                    nsn: nsnAlternativo,
                    ppu_qtd: altQty,
                    fonte: mergeSourceLabels(existente.fonte, fontesDocumento),
                    origem: existente.origem === 'manual' ? 'manual_documento' : 'documento',
                    sub_item: existente.sub_item || null,
                    prioridade_manual: existente.prioridade_manual ?? 999,
                });
            });

            item.alternativos = Array.from(altsUnicosMap.values()).sort(compareAlternativeCards);
            item.tem_mapa_manual = item.dicionario.length > 0;
            item.fontes_alternativos = mergeSourceLabels(item.alternativos.map((alt) => alt.fonte));

            const meusPis = [...new Set(item.dicionario.map((d) => d.pi).filter(Boolean))];
            item.ceimspa_detalhes = allCeimspa.filter((c) => meusPis.includes(c.pi));
            item.ceimspa_qtd = item.ceimspa_detalhes.reduce((acc, c) => acc + (Number(c.quantidade) || 0), 0);

            item.sb_referencias = mySbItems.map((row) => {
                const sbNumero = normalizeUpper(row.sb_numero);
                const header = sbHeaderMap.get(sbNumero) || {};
                const relacionados = Array.from(sbRelatedMap.get(sbNumero) || new Set())
                    .map((relatedPn) => normalizeUpper(relatedPn))
                    .filter((relatedPn) => relatedPn && relatedPn !== pnUpper)
                    .sort();

                return {
                    sb_numero: sbNumero,
                    titulo: header.titulo || header.fonte_documento || sbNumero,
                    tipo_sb: header.tipo_sb || 'N/A',
                    status_acao: header.status_acao || 'SEM_ACAO',
                    observacao: header.observacao || null,
                    item_num: row.item_num || null,
                    capitulo: row.capitulo || null,
                    aplicabilidade: row.aplicabilidade || null,
                    pns_relacionados: relacionados,
                };
            }).sort((a, b) => a.sb_numero.localeCompare(b.sb_numero));

            finalResults.push(item);
        }

        return res.status(200).json({ status: 'success', data: finalResults });

    } catch (error) {
        console.error('ERRO NO RADAR DE BUSCA:', error);
        return res.status(500).json({ status: 'error', message: 'Erro ao processar busca.' });
    }
};
