const supabase = require('../config/supabaseClient');
const { normalizePn } = require('../utils/importAliases');
const { registrarAuditoria } = require('../utils/auditLogger');

function formatDate(value) {
  if (!value) return null;
  const dt = new Date(value);
  if (Number.isNaN(dt.getTime())) return value;
  return dt.toISOString().slice(0, 10);
}

async function findNomePn(pn) {
  const consultas = [
    supabase.from('dicionario_mestre').select('nomenclatura, nsn, pi').eq('pn', pn).limit(1),
    supabase.from('price_list').select('nomenclatura, nsn').eq('pn', pn).limit(1),
    supabase.from('estoque_ppu').select('nomenclatura, nsn_pi').eq('pn', pn).limit(1),
  ];

  const results = await Promise.allSettled(consultas);
  for (const result of results) {
    if (result.status !== 'fulfilled') continue;
    const row = result.value?.data?.[0];
    if (row?.nomenclatura) {
      return {
        nomenclatura: row.nomenclatura,
        nsn_pi: row.nsn || row.pi || row.nsn_pi || null,
      };
    }
  }

  return { nomenclatura: 'Nomenclatura não localizada nas bases atuais', nsn_pi: null };
}

exports.buscarHistoricoMovimentacao = async (req, res) => {
  try {
    const termo = String(req.query.pn || req.query.q || '').trim();
    if (!termo) {
      return res.status(400).json({ status: 'error', message: 'Informe um PN para consultar o histórico de movimentação.' });
    }

    const pn = normalizePn(termo);
    const { data, error } = await supabase
      .from('historico_movimentacao')
      .select('id, pn, data_movimentacao, quantidade, os, fonte_arquivo, created_at')
      .eq('pn', pn)
      .order('data_movimentacao', { ascending: false })
      .order('id', { ascending: false })
      .limit(1000);

    if (error) throw error;

    const movimentos = (data || []).map((row) => ({
      id: row.id,
      pn: row.pn,
      data: formatDate(row.data_movimentacao),
      quantidade: Number(row.quantidade || 0),
      os: row.os,
      fonte_arquivo: row.fonte_arquivo || null,
      created_at: row.created_at || null,
    }));

    const totalQuantidade = movimentos.reduce((acc, item) => acc + Number(item.quantidade || 0), 0);
    const datas = movimentos.map((item) => item.data).filter(Boolean).sort();
    const cadastro = await findNomePn(pn);

    await registrarAuditoria({
      req,
      action: 'HISTORICO_MOVIMENTACAO_CONSULTADO',
      entity: 'HISTORICO_MOVIMENTACAO',
      entityId: pn,
      summary: `${req.user?.email || 'Usuário'} consultou histórico de movimentação do PN ${pn}.`,
      details: {
        pn,
        total_registros: movimentos.length,
        quantidade_total: totalQuantidade,
      },
      level: 'INFO',
      visibility: 'GOD',
    });

    return res.json({
      status: 'success',
      data: {
        pn,
        nomenclatura: cadastro.nomenclatura,
        nsn_pi: cadastro.nsn_pi,
        resumo: {
          total_registros: movimentos.length,
          quantidade_total: totalQuantidade,
          data_inicial: datas[0] || null,
          data_final: datas[datas.length - 1] || null,
        },
        movimentos,
      },
    });
  } catch (error) {
    console.error('[historico_movimentacao] erro:', error);
    return res.status(500).json({ status: 'error', message: 'Falha ao consultar histórico de movimentação.' });
  }
};
