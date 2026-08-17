const supabase = require('../config/supabaseClient');
const { registrarAuditoria } = require('../utils/auditLogger');
const {
  normalizeDestination,
  normalizeSituation,
} = require('../services/ppuLocationPolicyService');

function normalizeText(value) {
  return String(value || '').trim();
}

function normalizeLocation(value) {
  const text = normalizeText(value).toUpperCase().replace(/\s+/g, ' ');
  return text || null;
}

function mergeConfigurationRows(viewRows = [], configuredRows = []) {
  const configMap = new Map();
  (configuredRows || []).forEach((row) => {
    const normalized = normalizeLocation(row.localizacao_normalizada || row.localizacao_exibicao);
    if (normalized) configMap.set(normalized, row);
  });

  return (viewRows || []).map((row) => {
    const normalized = normalizeLocation(row.localizacao_normalizada || row.localizacao_exibicao);
    const configured = normalized ? configMap.get(normalized) : null;
    const contabilizaPpu = configured ? configured.contabiliza_ppu !== false : row.contabiliza_ppu !== false;
    return {
      ...row,
      ...(configured || {}),
      localizacao_normalizada: normalized,
      localizacao_exibicao: configured?.localizacao_exibicao || row.localizacao_exibicao || normalized,
      contabiliza_ppu: contabilizaPpu,
      ativo: configured ? configured.ativo !== false : row.ativo !== false,
      destino_contabilizacao: normalizeDestination(configured?.destino_contabilizacao, contabilizaPpu),
      situacao_operacional: normalizeSituation(configured?.situacao_operacional, contabilizaPpu),
      observacao: configured?.observacao || row.observacao || null,
      linhas: Number(row.linhas || 0),
      quantidade_total: Number(row.quantidade_total || 0),
    };
  });
}

exports.listar = async (_req, res) => {
  try {
    const [viewResult, configResult] = await Promise.all([
      supabase
        .from('v_sisha_ppu_localizacoes_configuracao')
        .select('*')
        .order('localizacao_exibicao', { ascending: true }),
      supabase
        .from('ppu_localizacoes_config')
        .select('localizacao_normalizada,localizacao_exibicao,contabiliza_ppu,ativo,observacao,destino_contabilizacao,situacao_operacional'),
    ]);
    if (viewResult.error) throw viewResult.error;
    if (configResult.error) throw configResult.error;

    const rows = mergeConfigurationRows(viewResult.data || [], configResult.data || []);
    return res.status(200).json({ status: 'success', data: rows });
  } catch (error) {
    console.error('[SISHA][localizações] listar:', error);
    return res.status(500).json({ status: 'error', message: error.message || 'Falha ao listar localizações do PPU.' });
  }
};

exports.atualizar = async (req, res) => {
  try {
    const rows = Array.isArray(req.body?.localizacoes) ? req.body.localizacoes : [];
    if (!rows.length) {
      return res.status(400).json({ status: 'error', message: 'Nenhuma localização foi enviada.' });
    }

    const payload = rows.map((row) => {
      const normalized = normalizeLocation(row.localizacao_normalizada || row.localizacao_exibicao);
      if (!normalized) return null;
      const contabilizaPpu = row.contabiliza_ppu !== false;
      return {
        localizacao_normalizada: normalized,
        localizacao_exibicao: normalizeText(row.localizacao_exibicao) || normalized,
        contabiliza_ppu: contabilizaPpu,
        ativo: row.ativo !== false,
        destino_contabilizacao: normalizeDestination(row.destino_contabilizacao, contabilizaPpu),
        situacao_operacional: normalizeSituation(row.situacao_operacional, contabilizaPpu),
        observacao: normalizeText(row.observacao) || null,
        updated_by_email: req.user?.email || null,
        updated_at: new Date().toISOString(),
      };
    }).filter(Boolean);

    if (!payload.length) {
      return res.status(400).json({ status: 'error', message: 'Nenhuma localização válida foi enviada.' });
    }

    const { data: beforeRows, error: beforeError } = await supabase
      .from('ppu_localizacoes_config')
      .select('localizacao_normalizada,localizacao_exibicao,contabiliza_ppu,ativo,observacao,destino_contabilizacao,situacao_operacional');
    if (beforeError) throw beforeError;

    const beforeMap = new Map((beforeRows || []).map((row) => [normalizeLocation(row.localizacao_normalizada || row.localizacao_exibicao), row]));
    const changes = payload.filter((row) => {
      const before = beforeMap.get(row.localizacao_normalizada);
      if (!before) {
        return row.contabiliza_ppu === false
          || row.destino_contabilizacao !== 'PPU'
          || row.situacao_operacional !== 'DISPONIVEL'
          || Boolean(row.observacao);
      }
      return Boolean(
        normalizeText(before.localizacao_exibicao) !== normalizeText(row.localizacao_exibicao)
        || (before.contabiliza_ppu !== false) !== row.contabiliza_ppu
        || (before.ativo !== false) !== row.ativo
        || normalizeDestination(before.destino_contabilizacao, before.contabiliza_ppu !== false) !== row.destino_contabilizacao
        || normalizeSituation(before.situacao_operacional, before.contabiliza_ppu !== false) !== row.situacao_operacional
        || normalizeText(before.observacao) !== normalizeText(row.observacao)
      );
    });

    for (let index = 0; index < changes.length; index += 500) {
      const { error } = await supabase
        .from('ppu_localizacoes_config')
        .upsert(changes.slice(index, index + 500), { onConflict: 'localizacao_normalizada' });
      if (error) throw error;
    }

    if (changes.length > 0) {
      const auditChanges = changes.slice(0, 200).map((after) => {
        const before = beforeMap.get(after.localizacao_normalizada) || null;
        return {
          localizacao: after.localizacao_exibicao,
          antes: before ? {
            contabiliza_ppu: before.contabiliza_ppu !== false,
            destino_contabilizacao: normalizeDestination(before.destino_contabilizacao, before.contabiliza_ppu !== false),
            situacao_operacional: normalizeSituation(before.situacao_operacional, before.contabiliza_ppu !== false),
            observacao: before.observacao || null,
          } : null,
          depois: {
            contabiliza_ppu: after.contabiliza_ppu,
            destino_contabilizacao: after.destino_contabilizacao,
            situacao_operacional: after.situacao_operacional,
            observacao: after.observacao || null,
          },
        };
      });

      await registrarAuditoria({
        req,
        action: 'PPU_LOCALIZACOES_CONFIG_ATUALIZADA',
        entity: 'PPU_LOCALIZACOES_CONFIG',
        entityId: 'CONFIGURACAO_GERAL',
        summary: `${req.user?.email || 'Usuário'} atualizou ${changes.length} localização(ões) do PPU.`,
        details: {
          total_recebido: payload.length,
          total_alterado: changes.length,
          alteracoes: auditChanges,
          alteracoes_omitidas_no_log: Math.max(0, changes.length - auditChanges.length),
        },
        level: 'INFO',
        visibility: 'GOD',
      });
    }

    const [viewResult, configResult] = await Promise.all([
      supabase
        .from('v_sisha_ppu_localizacoes_configuracao')
        .select('*')
        .order('localizacao_exibicao', { ascending: true }),
      supabase
        .from('ppu_localizacoes_config')
        .select('localizacao_normalizada,localizacao_exibicao,contabiliza_ppu,ativo,observacao,destino_contabilizacao,situacao_operacional'),
    ]);
    if (viewResult.error) throw viewResult.error;
    if (configResult.error) throw configResult.error;

    return res.status(200).json({
      status: 'success',
      message: changes.length > 0 ? 'Classificação das localizações atualizada. O PPU, o Radar e o rastreio usarão a nova política nas próximas consultas.' : 'Nenhuma alteração de classificação foi necessária.',
      data: mergeConfigurationRows(viewResult.data || [], configResult.data || []),
    });
  } catch (error) {
    console.error('[SISHA][localizações] atualizar:', error);
    return res.status(500).json({ status: 'error', message: error.message || 'Falha ao atualizar localizações do PPU.' });
  }
};
