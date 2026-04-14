// src/controllers/statsController.js
const supabase = require('../config/supabaseClient');

const PAGE_SIZE = 1000;
const LOW_STOCK_CANDIDATES = ['estoque_minimo', 'qtd_minima', 'quantidade_minima', 'minimo', 'estoque_seguranca'];
const POLICY_PN_CANDIDATES = ['pn', 'part_number'];
const ODC_QTY_CANDIDATES = ['quantidade', 'qtd', 'qtd_pendente', 'qtd_solicitada', 'qty'];
const ODC_PD_CANDIDATES = ['pd', 'documento_referencia'];

const normalizeKey = (value) => String(value || '').trim().toUpperCase();

function formatGBP(value) {
    return new Intl.NumberFormat('en-GB', {
        style: 'currency',
        currency: 'GBP',
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
    }).format(Number(value || 0));
}

function firstExistingKey(obj = {}, candidates = []) {
    return candidates.find((key) => Object.prototype.hasOwnProperty.call(obj, key));
}

async function fetchAllRows(table, columns = '*', pageSize = PAGE_SIZE) {
    let allRows = [];
    let from = 0;

    while (true) {
        const to = from + pageSize - 1;
        const { data, error } = await supabase
            .from(table)
            .select(columns)
            .range(from, to);

        if (error) throw error;
        if (!data || data.length === 0) break;

        allRows = allRows.concat(data);

        if (data.length < pageSize) break;
        from += pageSize;
    }

    return allRows;
}

async function fetchOdcRows() {
    try {
        return await fetchAllRows('odc_requests', '*');
    } catch (error) {
        console.warn('[SISHA-1][stats] odc_requests indisponível. Tentando legado pd_odc.', error.message);
        try {
            return await fetchAllRows('pd_odc', '*');
        } catch (legacyError) {
            console.warn('[SISHA-1][stats] pd_odc também indisponível.', legacyError.message);
            return [];
        }
    }
}

async function fetchValuationRows() {
    try {
        return await fetchAllRows('v_estoque_ppu_valorizado', '*');
    } catch (error) {
        console.warn('[SISHA-1][stats] view v_estoque_ppu_valorizado indisponível.', error.message);
        return [];
    }
}

async function getDashboardStatsViaRpc() {
    const { data, error } = await supabase.rpc('rpc_dashboard_stats');

    if (error) {
        throw error;
    }

    const row = Array.isArray(data) ? data[0] : data;

    const valorEstoqueGBP = Number(
        row?.valor_total_estoque_gbp ??
        row?.valor_total_estoque ??
        row?.valor_total_estoque_estimado ??
        0
    );

    return {
        totalPPU: Number(row?.total_ppu || 0),
        totalPPU_PNs: Number(row?.total_ppu_pns || 0),
        totalODA: Number(row?.total_oda || 0),
        totalODA_PDs: Number(row?.total_oda_pds || 0),
        totalODC: Number(row?.total_odc || 0),
        totalODC_PDs: Number(row?.total_odc_pds || 0),
        valorEstoqueGBP,
        valorEstoqueFormatado: formatGBP(valorEstoqueGBP),
        pnsPrecificados: Number(row?.pns_precificados || 0),
        moeda: 'GBP',
    };
}

async function getDashboardStatsViaFallback() {
    const [ppuData, odaData, odcData, valuationData] = await Promise.all([
        fetchAllRows('estoque_ppu', 'pn, quantidade'),
        fetchAllRows('leonardo_spares', 'qtd_pendente, documento_referencia'),
        fetchOdcRows(),
        fetchValuationRows(),
    ]);

    const totalPPU = ppuData.reduce((acc, item) => acc + (Number(item.quantidade) || 0), 0);
    const totalPPU_PNs = new Set(ppuData.map(item => normalizeKey(item.pn)).filter(Boolean)).size;

    const totalODA = odaData.reduce((acc, item) => acc + (Number(item.qtd_pendente) || 0), 0);
    const totalODA_PDs = new Set(odaData.map(item => normalizeKey(item.documento_referencia)).filter(Boolean)).size;

    let totalODC = 0;
    let totalODC_PDs = 0;
    if (odcData.length > 0) {
        const qtyKey = firstExistingKey(odcData[0], ODC_QTY_CANDIDATES);
        const pdKey = firstExistingKey(odcData[0], ODC_PD_CANDIDATES);
        totalODC = odcData.reduce((acc, item) => acc + (Number(item[qtyKey]) || 0), 0);
        totalODC_PDs = new Set(odcData.map(item => normalizeKey(item[pdKey])).filter(Boolean)).size;
    }

    const valorEstoqueGBP = valuationData.reduce((acc, item) => acc + (Number(item.valor_total_estimado) || 0), 0);
    const pnsPrecificados = valuationData.filter(item => item.valor_unitario_referencia != null).length;

    return {
        totalPPU,
        totalPPU_PNs,
        totalODA,
        totalODA_PDs,
        totalODC,
        totalODC_PDs,
        valorEstoqueGBP,
        valorEstoqueFormatado: formatGBP(valorEstoqueGBP),
        pnsPrecificados,
        moeda: 'GBP',
    };
}

async function computeLowStockAlerts(limit = 8) {
    try {
        const policyRows = await fetchAllRows('politica_estoque', '*');
        if (!policyRows.length) return [];

        const ppuRows = await fetchAllRows('estoque_ppu', 'pn, quantidade, localizacao');
        const ppuMap = new Map();
        ppuRows.forEach((row) => {
            const pn = normalizeKey(row.pn);
            if (!pn) return;
            if (!ppuMap.has(pn)) ppuMap.set(pn, { qtd: 0, locais: new Set() });
            const ref = ppuMap.get(pn);
            ref.qtd += Number(row.quantidade) || 0;
            if (row.localizacao) ref.locais.add(row.localizacao);
        });

        const alerts = [];
        for (const row of policyRows) {
            const pnKey = firstExistingKey(row, POLICY_PN_CANDIDATES);
            const minKey = firstExistingKey(row, LOW_STOCK_CANDIDATES);
            if (!pnKey || !minKey) continue;

            const pn = normalizeKey(row[pnKey]);
            const minimo = Number(row[minKey]) || 0;
            if (!pn || minimo <= 0) continue;

            const estoque = ppuMap.get(pn);
            const saldo = estoque ? estoque.qtd : 0;
            if (saldo <= minimo) {
                alerts.push({
                    tipo: 'ESTOQUE_BAIXO',
                    severidade: saldo <= 0 ? 'ALTA' : 'MEDIA',
                    pn,
                    titulo: 'Estoque abaixo da política',
                    detalhe: `Saldo ${saldo} / mínimo ${minimo}`,
                    local: estoque ? Array.from(estoque.locais).join(' | ') || 'PPU' : 'PPU',
                    saldo,
                    minimo,
                });
            }
        }

        return alerts
            .sort((a, b) => (a.saldo - a.minimo) - (b.saldo - b.minimo))
            .slice(0, limit);
    } catch (error) {
        console.warn('[SISHA-1][stats] Falha ao calcular estoque baixo:', error.message);
        return [];
    }
}

async function computeSbAlerts(limit = 6) {
    try {
        const sbRows = await fetchAllRows('service_bulletins', 'sb_numero, titulo, tipo_sb, status_acao');
        return sbRows
            .filter((row) => ['SEM_ACAO', 'ABERTA', 'PENDENTE'].includes(normalizeKey(row.status_acao)))
            .slice(0, limit)
            .map((row) => ({
                tipo: 'SB_SEM_ACAO',
                severidade: normalizeKey(row.tipo_sb) === 'MANDATORIA' ? 'ALTA' : 'MEDIA',
                pn: row.sb_numero,
                titulo: row.titulo || 'Service Bulletin sem ação',
                detalhe: `${row.sb_numero} • ${row.tipo_sb || 'N/A'}`,
                local: 'SB',
                saldo: null,
                minimo: null,
            }));
    } catch (error) {
        console.warn('[SISHA-1][stats] Falha ao calcular alertas SB:', error.message);
        return [];
    }
}

async function computeWarrantyAlerts(limit = 6) {
    try {
        const rows = await fetchAllRows('estoque_ppu', 'pn, sn, data_garantia, localizacao');
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        const inSixtyDays = new Date(today);
        inSixtyDays.setDate(today.getDate() + 60);

        return rows
            .filter((row) => row.sn && row.sn !== 'N/A' && row.data_garantia)
            .map((row) => {
                const dt = new Date(row.data_garantia);
                return { row, dt };
            })
            .filter(({ dt }) => !Number.isNaN(dt.getTime()) && dt <= inSixtyDays)
            .sort((a, b) => a.dt - b.dt)
            .slice(0, limit)
            .map(({ row, dt }) => ({
                tipo: 'GARANTIA_PROXIMA',
                severidade: dt < today ? 'ALTA' : 'MEDIA',
                pn: row.pn,
                titulo: 'Garantia próxima do fim',
                detalhe: `${row.sn} • ${dt.toLocaleDateString('pt-BR')}`,
                local: row.localizacao || 'PPU',
                saldo: null,
                minimo: null,
            }));
    } catch (error) {
        console.warn('[SISHA-1][stats] Falha ao calcular alertas de garantia:', error.message);
        return [];
    }
}

exports.getDashboardStats = async (req, res) => {
    try {
        let stats;

        try {
            stats = await getDashboardStatsViaRpc();
        } catch (rpcError) {
            console.warn('[SISHA-1][stats] RPC rpc_dashboard_stats indisponível. Usando fallback.', rpcError.message);
            stats = await getDashboardStatsViaFallback();
        }

        return res.status(200).json({
            status: 'success',
            data: {
                totalPPU: stats.totalPPU,
                totalPPU_PNs: stats.totalPPU_PNs,
                totalODA: stats.totalODA,
                totalODA_PDs: stats.totalODA_PDs,
                totalODC: stats.totalODC,
                totalODC_PDs: stats.totalODC_PDs,
                orcamento: stats.valorEstoqueFormatado,
                valorEstoqueGBP: stats.valorEstoqueGBP,
                pnsPrecificados: stats.pnsPrecificados,
                moeda: stats.moeda,
            }
        });
    } catch (error) {
        console.error('Erro no motor de estatísticas:', error);
        return res.status(500).json({ status: 'error', message: 'Erro ao buscar dados do radar.' });
    }
};

exports.getRadarCriticidade = async (req, res) => {
    try {
        const [stockAlerts, sbAlerts, warrantyAlerts] = await Promise.all([
            computeLowStockAlerts(8),
            computeSbAlerts(6),
            computeWarrantyAlerts(6),
        ]);

        const data = [...sbAlerts, ...stockAlerts, ...warrantyAlerts]
            .sort((a, b) => {
                const sevRank = { ALTA: 0, MEDIA: 1, BAIXA: 2 };
                return (sevRank[a.severidade] ?? 9) - (sevRank[b.severidade] ?? 9);
            })
            .slice(0, 12);

        return res.status(200).json({ status: 'success', data });
    } catch (error) {
        console.error('Erro ao montar radar de criticidade:', error);
        return res.status(500).json({ status: 'error', message: 'Erro ao buscar radar de criticidade.' });
    }
};

exports.getRecentOperations = async (req, res) => {
    try {
        const { data, error } = await supabase
            .from('import_logs')
            .select('tipo_arquivo, nome_arquivo, status, mensagem, uploaded_by_email, uploaded_by_role, created_at, finished_at')
            .order('created_at', { ascending: false })
            .limit(8);

        if (error) throw error;

        return res.status(200).json({ status: 'success', data: data || [] });
    } catch (error) {
        console.error('Erro ao consultar operações recentes:', error);
        return res.status(500).json({ status: 'error', message: 'Erro ao consultar operações recentes.' });
    }
};
