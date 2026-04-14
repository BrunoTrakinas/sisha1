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
        const p2 = supabase.from('dicionario_mestre').select('pn, nomenclatura, nsn').or(`pn.ilike.%${query}%,nsn.ilike.%${query}%,nomenclatura.ilike.%${query}%`).limit(50);
        const p3 = supabase.from('estoque_ppu').select('pn, nomenclatura, nsn_pi').or(`pn.ilike.%${query}%,nomenclatura.ilike.%${query}%`).limit(50);
        const p4 = supabase.from('lisde').select('pn, nomenclatura').or(`pn.ilike.%${query}%,nomenclatura.ilike.%${query}%`).limit(50);
        const p5 = supabase.from('price_list').select('pn, nomenclatura, nsn').or(`pn.ilike.%${query}%,nsn.ilike.%${query}%,nomenclatura.ilike.%${query}%`).limit(20);
        const p6 = supabase.from('estoque_ceimspa').select('pi, nomenclatura').or(`pi.ilike.%${query}%,nomenclatura.ilike.%${query}%`).limit(50);
        const p7 = supabase.from('rfq_cotacoes').select('pn, nomenclatura, nsn').or(`pn.ilike.%${query}%,nsn.ilike.%${query}%,nomenclatura.ilike.%${query}%`).limit(20);
        const p8 = supabase.from('pn_alternativos_documento').select('pn, pi, pn_alt, fonte').or(`pn.ilike.%${query}%,pi.ilike.%${query}%,pn_alt.ilike.%${query}%`).limit(100);
        const p9 = supabase.from('service_bulletin_items').select('sb_numero, pn, nsn, nomenclatura').or(`pn.ilike.%${query}%`).limit(80);
        const p10 = supabase.from('service_bulletins').select('sb_numero, titulo').or(`sb_numero.ilike.%${query}%,titulo.ilike.%${query}%`).limit(30);

        const results = await Promise.allSettled([p1, p2, p3, p4, p5, p6, p7, p8, p9, p10]);
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
        if (arrayPns.length === 0) return res.status(200).json({ status: 'success', data: [] });

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

        const batchResults = await Promise.allSettled([q1, q2, q3, q4, q5, q6, q7, q8, q9, q10]);
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
            item.odc = odcData.filter((p) => normalizeUpper(p.pn) === pnUpper);
            item.foc = focData.filter((p) => normalizeUpper(p.pn) === pnUpper);
            item.repairs = repData.filter((p) => normalizeUpper(p.pn) === pnUpper);
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
                const irmaos = allAlternativosRaw.filter((a) => a.dmc === entry.dmc && a.item_num === entry.item_num && normalizeUpper(a.pn) !== pnUpper);
                irmaos.forEach((irmao) => {
                    const altPn = normalizeUpper(irmao.pn);
                    const altQty = ppuAltData.filter((p) => normalizeUpper(p.pn) === altPn).reduce((acc, p) => acc + (Number(p.quantidade) || 0), 0);
                    const existente = altsUnicosMap.get(altPn) || {};
                    altsUnicosMap.set(altPn, {
                        pn: altPn,
                        nsn: irmao.nsn,
                        ppu_qtd: altQty,
                        fonte: mergeSourceLabels(existente.fonte, ['MANUAL TÉCNICO']),
                        origem: 'manual',
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
                });
            });

            item.alternativos = Array.from(altsUnicosMap.values()).sort((a, b) => a.pn.localeCompare(b.pn));
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
