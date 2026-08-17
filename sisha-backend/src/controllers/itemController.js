const supabase = require('../config/supabaseClient');
const { normalizePn } = require('../utils/importAliases');
const { registrarAuditoria } = require('../utils/auditLogger');
const { resolvePnRelations } = require('../services/pnRelationsService');

function normalizarIdentificador(valor = '') {
    return String(valor).trim().toUpperCase();
}

function prepararLocalizacao(localizacao = '') {
    return String(localizacao || '').trim().toUpperCase();
}

// Administração segura das bases operacionais PPU e CeIMSPA.
// Essas rotas ficam atrás de /api/items, que já exige perfil ADMIN no servidor.
function numeroNaoNegativo(value, fallback = 0) {
    const raw = String(value ?? '').trim().replace(',', '.');
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? Math.max(0, parsed) : fallback;
}

function textoOuNulo(value, max = 500) {
    const text = String(value ?? '').trim();
    return text ? text.slice(0, max) : null;
}

function dataOuNulo(value) {
    const text = String(value ?? '').trim();
    return text || null;
}

function filtrarBuscaAdministrativa(rows = [], q = '', fields = []) {
    const termo = normalizarIdentificador(q);
    if (!termo) return rows;
    return rows.filter((row) => fields.some((field) => normalizarIdentificador(row?.[field]).includes(termo)));
}

exports.listarPpuAdministrativo = async (req, res) => {
    try {
        const { data, error } = await supabase
            .from('estoque_ppu')
            .select('id,pn,nsn_pi,nomenclatura,quantidade,localizacao,sn,data_chegada,data_garantia')
            .order('pn', { ascending: true })
            .limit(20000);
        if (error) throw error;
        const rows = filtrarBuscaAdministrativa(data || [], req.query.q || '', ['pn', 'nsn_pi', 'nomenclatura', 'localizacao', 'sn']);
        return res.status(200).json({ status: 'success', data: rows, meta: { total: rows.length } });
    } catch (error) {
        console.error('ERRO AO LISTAR PPU PARA ADMINISTRAÇÃO:', error);
        return res.status(500).json({ status: 'error', message: 'Falha ao carregar o estoque PPU.' });
    }
};

exports.criarPpuAdministrativo = async (req, res) => {
    try {
        const pn = normalizarIdentificador(req.body.pn);
        if (!pn) return res.status(400).json({ status: 'error', message: 'PN é obrigatório.' });
        const payload = {
            pn,
            nsn_pi: textoOuNulo(req.body.nsn_pi, 120) || 'N/A',
            nomenclatura: textoOuNulo(req.body.nomenclatura, 500) || 'N/A',
            quantidade: numeroNaoNegativo(req.body.quantidade),
            localizacao: prepararLocalizacao(req.body.localizacao) || 'NÃO DEFINIDO',
            sn: textoOuNulo(req.body.sn, 160),
            data_chegada: dataOuNulo(req.body.data_chegada),
            data_garantia: dataOuNulo(req.body.data_garantia),
        };
        const { data, error } = await supabase.from('estoque_ppu').insert(payload).select('*').single();
        if (error) throw error;
        await registrarAuditoria({
            req,
            action: 'PPU_REGISTRO_CRIADO_ADMIN',
            entity: 'ESTOQUE_PPU',
            entityId: data.id,
            summary: `Registro PPU ${pn} criado administrativamente.`,
            details: payload,
            level: 'INFO',
            visibility: 'GOD',
        });
        return res.status(201).json({ status: 'success', message: 'Registro PPU criado.', data });
    } catch (error) {
        console.error('ERRO AO CRIAR PPU:', error);
        return res.status(500).json({ status: 'error', message: error.message || 'Falha ao criar registro PPU.' });
    }
};

// Busca EXATA preservada para compatibilidade com o fluxo administrativo antigo.
exports.buscarPpuParaManutencao = async (req, res) => {
    try {
        const termo = normalizarIdentificador(req.params.termo);
        if (!termo) return res.status(400).json({ status: 'error', message: 'Informe um PN ou SN completo.' });
        const colunas = 'id, pn, nsn_pi, nomenclatura, quantidade, localizacao, sn, data_chegada, data_garantia';
        const [porPn, porSn] = await Promise.all([
            supabase.from('estoque_ppu').select(colunas).eq('pn', termo).order('id', { ascending: true }),
            supabase.from('estoque_ppu').select(colunas).eq('sn', termo).order('id', { ascending: true }),
        ]);
        if (porPn.error) throw porPn.error;
        if (porSn.error) throw porSn.error;
        const mapa = new Map();
        [...(porPn.data || []), ...(porSn.data || [])].forEach((item) => mapa.set(item.id, item));
        const registros = Array.from(mapa.values());
        if (!registros.length) return res.status(404).json({ status: 'error', message: 'Nenhum registro exato encontrado. Use PN completo ou SN completo.' });
        return res.status(200).json({ status: 'success', data: registros, message: `${registros.length} registro(s) exato(s) encontrado(s).` });
    } catch (error) {
        console.error('ERRO AO BUSCAR PPU PARA MANUTENÇÃO:', error);
        return res.status(500).json({ status: 'error', message: 'Falha ao consultar o PPU para manutenção.' });
    }
};

exports.atualizarPpuPorId = async (req, res) => {
    try {
        const { id } = req.params;
        const { data: atual, error: readError } = await supabase.from('estoque_ppu').select('*').eq('id', id).single();
        if (readError) throw readError;
        const payload = {};
        if (req.body.pn !== undefined) payload.pn = normalizarIdentificador(req.body.pn);
        if (req.body.nsn_pi !== undefined) payload.nsn_pi = textoOuNulo(req.body.nsn_pi, 120) || 'N/A';
        if (req.body.nomenclatura !== undefined) payload.nomenclatura = textoOuNulo(req.body.nomenclatura, 500) || 'N/A';
        if (req.body.quantidade !== undefined) payload.quantidade = numeroNaoNegativo(req.body.quantidade);
        if (req.body.localizacao !== undefined) payload.localizacao = prepararLocalizacao(req.body.localizacao) || 'NÃO DEFINIDO';
        if (req.body.sn !== undefined) payload.sn = textoOuNulo(req.body.sn, 160);
        if (req.body.data_chegada !== undefined) payload.data_chegada = dataOuNulo(req.body.data_chegada);
        if (req.body.data_garantia !== undefined) payload.data_garantia = dataOuNulo(req.body.data_garantia);
        if (payload.pn === '') return res.status(400).json({ status: 'error', message: 'PN não pode ficar vazio.' });
        const { data, error } = await supabase.from('estoque_ppu').update(payload).eq('id', id).select('*').single();
        if (error) throw error;
        await registrarAuditoria({
            req,
            action: 'PPU_REGISTRO_EDITADO_ADMIN',
            entity: 'ESTOQUE_PPU',
            entityId: id,
            summary: `Registro PPU ${id} editado administrativamente.`,
            details: { antes: atual, depois: data },
            level: 'INFO',
            visibility: 'GOD',
        });
        return res.status(200).json({ status: 'success', message: `Registro ${id} atualizado.`, data });
    } catch (error) {
        console.error('ERRO AO EDITAR PPU POR ID:', error);
        return res.status(500).json({ status: 'error', message: error.message || 'Falha ao atualizar o registro físico do PPU.' });
    }
};

exports.excluirPpuPorId = async (req, res) => {
    try {
        const { id } = req.params;
        const { data: atual } = await supabase.from('estoque_ppu').select('*').eq('id', id).maybeSingle();
        const { error } = await supabase.from('estoque_ppu').delete().eq('id', id);
        if (error) throw error;
        await registrarAuditoria({
            req,
            action: 'PPU_REGISTRO_EXCLUIDO_ADMIN',
            entity: 'ESTOQUE_PPU',
            entityId: id,
            summary: `Registro PPU ${id} removido da fotografia operacional atual.`,
            details: { registro: atual || null, motivo: req.body?.motivo || null },
            level: 'WARN',
            visibility: 'GOD',
        });
        return res.status(200).json({ status: 'success', message: `Registro ${id} removido do PPU atual.` });
    } catch (error) {
        console.error('ERRO AO EXCLUIR PPU POR ID:', error);
        return res.status(500).json({ status: 'error', message: error.message || 'Falha ao remover o registro do PPU.' });
    }
};

exports.listarCeimspaAdministrativo = async (req, res) => {
    try {
        const { data, error } = await supabase
            .from('estoque_ceimspa')
            .select('id,pi,pn,pn_confirmado,fonte_identificacao,nomenclatura,quantidade,sj,uf')
            .order('pi', { ascending: true })
            .limit(20000);
        if (error) throw error;
        const rows = filtrarBuscaAdministrativa(data || [], req.query.q || '', ['pi', 'pn', 'nomenclatura', 'sj', 'uf']);
        return res.status(200).json({ status: 'success', data: rows, meta: { total: rows.length } });
    } catch (error) {
        console.error('ERRO AO LISTAR CEIMSPA:', error);
        return res.status(500).json({ status: 'error', message: 'Falha ao carregar a base CeIMSPA.' });
    }
};

exports.criarCeimspaAdministrativo = async (req, res) => {
    try {
        const pi = textoOuNulo(req.body.pi, 120);
        if (!pi) return res.status(400).json({ status: 'error', message: 'PI/NSN é obrigatório para CeIMSPA.' });
        const pn = normalizePn(req.body.pn);
        const payload = {
            pi,
            pn: pn || null,
            pn_confirmado: Boolean(pn),
            fonte_identificacao: pn ? 'MANUTENCAO_ADMIN' : 'CEIMSPA_SEM_PN',
            nomenclatura: textoOuNulo(req.body.nomenclatura, 500) || 'N/A',
            quantidade: numeroNaoNegativo(req.body.quantidade),
            sj: textoOuNulo(req.body.sj, 120) || 'N/A',
            uf: textoOuNulo(req.body.uf, 120) || 'N/A',
        };
        const { data, error } = await supabase.from('estoque_ceimspa').insert(payload).select('*').single();
        if (error) throw error;
        await registrarAuditoria({ req, action: 'CEIMSPA_REGISTRO_CRIADO_ADMIN', entity: 'ESTOQUE_CEIMSPA', entityId: data.id, summary: `Registro CeIMSPA ${pi} criado administrativamente.`, details: payload, level: 'INFO', visibility: 'GOD' });
        return res.status(201).json({ status: 'success', message: 'Registro CeIMSPA criado.', data });
    } catch (error) {
        console.error('ERRO AO CRIAR CEIMSPA:', error);
        return res.status(500).json({ status: 'error', message: error.message || 'Falha ao criar registro CeIMSPA.' });
    }
};

exports.atualizarCeimspaPorId = async (req, res) => {
    try {
        const { id } = req.params;
        const { data: atual, error: readError } = await supabase.from('estoque_ceimspa').select('*').eq('id', id).single();
        if (readError) throw readError;
        const payload = {};
        if (req.body.pi !== undefined) payload.pi = textoOuNulo(req.body.pi, 120);
        if (req.body.pn !== undefined) {
            const pn = normalizePn(req.body.pn);
            payload.pn = pn || null;
            payload.pn_confirmado = Boolean(pn);
            payload.fonte_identificacao = pn ? 'MANUTENCAO_ADMIN' : 'CEIMSPA_SEM_PN';
        }
        if (req.body.nomenclatura !== undefined) payload.nomenclatura = textoOuNulo(req.body.nomenclatura, 500) || 'N/A';
        if (req.body.quantidade !== undefined) payload.quantidade = numeroNaoNegativo(req.body.quantidade);
        if (req.body.sj !== undefined) payload.sj = textoOuNulo(req.body.sj, 120) || 'N/A';
        if (req.body.uf !== undefined) payload.uf = textoOuNulo(req.body.uf, 120) || 'N/A';
        if (payload.pi === null) return res.status(400).json({ status: 'error', message: 'PI/NSN não pode ficar vazio.' });
        const { data, error } = await supabase.from('estoque_ceimspa').update(payload).eq('id', id).select('*').single();
        if (error) throw error;
        await registrarAuditoria({ req, action: 'CEIMSPA_REGISTRO_EDITADO_ADMIN', entity: 'ESTOQUE_CEIMSPA', entityId: id, summary: `Registro CeIMSPA ${id} editado administrativamente.`, details: { antes: atual, depois: data }, level: 'INFO', visibility: 'GOD' });
        return res.status(200).json({ status: 'success', message: 'Registro CeIMSPA atualizado.', data });
    } catch (error) {
        console.error('ERRO AO EDITAR CEIMSPA:', error);
        return res.status(500).json({ status: 'error', message: error.message || 'Falha ao atualizar CeIMSPA.' });
    }
};

exports.excluirCeimspaPorId = async (req, res) => {
    try {
        const { id } = req.params;
        const { data: atual } = await supabase.from('estoque_ceimspa').select('*').eq('id', id).maybeSingle();
        const { error } = await supabase.from('estoque_ceimspa').delete().eq('id', id);
        if (error) throw error;
        await registrarAuditoria({ req, action: 'CEIMSPA_REGISTRO_EXCLUIDO_ADMIN', entity: 'ESTOQUE_CEIMSPA', entityId: id, summary: `Registro CeIMSPA ${id} removido da base operacional atual.`, details: { registro: atual || null, motivo: req.body?.motivo || null }, level: 'WARN', visibility: 'GOD' });
        return res.status(200).json({ status: 'success', message: 'Registro CeIMSPA removido.' });
    } catch (error) {
        console.error('ERRO AO EXCLUIR CEIMSPA:', error);
        return res.status(500).json({ status: 'error', message: error.message || 'Falha ao remover CeIMSPA.' });
    }
};

// Cadastro de apelidos operacionais: HMU, MGB, Servo, etc.
exports.listarApelidos = async (req, res) => {
    try {
        const termo = normalizarIdentificador(req.query.q || '');
        let query = supabase
            .from('item_apelidos')
            .select('*')
            .eq('ativo', true)
            .order('apelido', { ascending: true })
            .limit(200);

        const { data, error } = await query;
        if (error) throw error;

        const filtrados = termo
            ? (data || []).filter((row) =>
                normalizarIdentificador(row.pn).includes(termo) ||
                normalizarIdentificador(row.apelido).includes(termo) ||
                normalizarIdentificador(row.descricao_oficial).includes(termo)
              )
            : (data || []);

        return res.status(200).json({ status: 'success', data: filtrados });
    } catch (error) {
        console.error('ERRO AO LISTAR APELIDOS:', error);
        return res.status(500).json({ status: 'error', message: 'Falha ao consultar apelidos operacionais.' });
    }
};

exports.criarApelido = async (req, res) => {
    try {
        const pn = normalizarIdentificador(req.body.pn);
        const apelido = normalizarIdentificador(req.body.apelido);
        if (!pn || !apelido) {
            return res.status(400).json({ status: 'error', message: 'PN e apelido são obrigatórios.' });
        }

        const { data, error } = await supabase
            .from('item_apelidos')
            .insert({
                pn,
                apelido,
                descricao_oficial: req.body.descricao_oficial || null,
                observacao: req.body.observacao || null,
                ativo: true,
            })
            .select('*')
            .single();

        if (error) throw error;
        return res.status(201).json({ status: 'success', message: 'Apelido operacional cadastrado.', data });
    } catch (error) {
        console.error('ERRO AO CRIAR APELIDO:', error);
        return res.status(500).json({ status: 'error', message: 'Falha ao cadastrar apelido operacional.' });
    }
};

exports.excluirApelido = async (req, res) => {
    try {
        const { id } = req.params;
        const { error } = await supabase
            .from('item_apelidos')
            .update({ ativo: false })
            .eq('id', id);

        if (error) throw error;
        return res.status(200).json({ status: 'success', message: 'Apelido operacional desativado.' });
    } catch (error) {
        console.error('ERRO AO EXCLUIR APELIDO:', error);
        return res.status(500).json({ status: 'error', message: 'Falha ao desativar apelido operacional.' });
    }
};


function limparTexto(value, max = 500) {
    const text = String(value || '').trim();
    return text ? text.slice(0, max) : null;
}

function payloadAlternativo(body = {}, user = {}) {
    const pn = normalizePn(body.pn);
    const pnAlt = normalizePn(body.pn_alt);
    const tipo = String(body.tipo_relacao || 'ALTERNATIVO').trim().toUpperCase();
    const tiposPermitidos = new Set(['ALTERNATIVO', 'EQUIVALENTE']);
    return {
        pn,
        pi: limparTexto(body.pi, 80),
        pn_alt: pnAlt,
        fonte: limparTexto(body.fonte, 300) || 'INSERÇÃO MANUAL SISHA',
        tipo_relacao: tiposPermitidos.has(tipo) ? tipo : 'ALTERNATIVO',
        origem_tipo: 'MANUAL',
        observacao: limparTexto(body.observacao, 1500),
        ativo: body.ativo !== false,
        updated_at: new Date().toISOString(),
        updated_by_email: user?.email || null,
    };
}

exports.listarPnAlternativos = async (req, res) => {
    try {
        const termo = String(req.query.q || '').trim();
        const incluirInativos = String(req.query.include_inactive || '').toLowerCase() === 'true';
        let query = supabase
            .from('pn_alternativos_documento')
            .select('id,pn,pi,pn_alt,fonte,tipo_relacao,origem_tipo,observacao,ativo,created_at,updated_at,created_by_email,updated_by_email')
            .order('updated_at', { ascending: false })
            .limit(300);
        if (!incluirInativos) query = query.eq('ativo', true);
        if (termo) {
            const safe = termo.replace(/[,%()]/g, ' ').trim();
            if (safe) query = query.or(`pn.ilike.%${safe}%,pn_alt.ilike.%${safe}%,pi.ilike.%${safe}%,fonte.ilike.%${safe}%`);
        }
        const { data, error } = await query;
        if (error) throw error;
        return res.status(200).json({ status: 'success', data: data || [] });
    } catch (error) {
        console.error('ERRO AO LISTAR PN ALTERNATIVOS:', error);
        return res.status(500).json({ status: 'error', message: error.message || 'Falha ao consultar PN alternativos.' });
    }
};

exports.criarPnAlternativo = async (req, res) => {
    try {
        const payload = payloadAlternativo(req.body, req.user);
        if (!payload.pn || !payload.pn_alt) {
            return res.status(400).json({ status: 'error', message: 'PN e PN alternativo são obrigatórios.' });
        }
        if (payload.pn === payload.pn_alt) {
            return res.status(400).json({ status: 'error', message: 'PN e PN alternativo não podem ser iguais.' });
        }

        const [direct, reverse] = await Promise.all([
            supabase.from('pn_alternativos_documento').select('id,ativo').eq('pn', payload.pn).eq('pn_alt', payload.pn_alt).eq('fonte', payload.fonte).limit(1),
            supabase.from('pn_alternativos_documento').select('id,ativo').eq('pn', payload.pn_alt).eq('pn_alt', payload.pn).eq('fonte', payload.fonte).limit(1),
        ]);
        if (direct.error) throw direct.error;
        if (reverse.error) throw reverse.error;
        const existente = direct.data?.[0] || reverse.data?.[0];
        if (existente?.ativo) {
            return res.status(409).json({ status: 'error', message: 'Esta relação já está ativa com a mesma fonte.' });
        }
        if (existente?.id) {
            const { data, error } = await supabase
                .from('pn_alternativos_documento')
                .update({ ...payload, ativo: true })
                .eq('id', existente.id)
                .select('*')
                .single();
            if (error) throw error;
            await registrarAuditoria({ req, action: 'PN_ALTERNATIVO_REATIVADO', entity: 'PN_ALTERNATIVO', entityId: existente.id, summary: `${payload.pn} ↔ ${payload.pn_alt}`, details: payload });
            return res.status(200).json({ status: 'success', message: 'Relação reativada.', data });
        }

        const { data, error } = await supabase
            .from('pn_alternativos_documento')
            .insert({ ...payload, created_by_email: req.user?.email || null })
            .select('*')
            .single();
        if (error) throw error;
        await registrarAuditoria({ req, action: 'PN_ALTERNATIVO_CRIADO', entity: 'PN_ALTERNATIVO', entityId: data.id, summary: `${payload.pn} ↔ ${payload.pn_alt}`, details: payload });
        return res.status(201).json({ status: 'success', message: 'PN alternativo cadastrado.', data });
    } catch (error) {
        console.error('ERRO AO CRIAR PN ALTERNATIVO:', error);
        return res.status(500).json({ status: 'error', message: error.message || 'Falha ao cadastrar PN alternativo.' });
    }
};

exports.atualizarPnAlternativo = async (req, res) => {
    try {
        const id = String(req.params.id || '').trim();
        const payload = payloadAlternativo(req.body, req.user);
        if (!id || !payload.pn || !payload.pn_alt || payload.pn === payload.pn_alt) {
            return res.status(400).json({ status: 'error', message: 'Informe uma relação válida de PN alternativo.' });
        }
        const { data: anterior, error: previousError } = await supabase.from('pn_alternativos_documento').select('*').eq('id', id).maybeSingle();
        if (previousError) throw previousError;
        if (!anterior) return res.status(404).json({ status: 'error', message: 'Relação não encontrada.' });

        const { data, error } = await supabase.from('pn_alternativos_documento').update(payload).eq('id', id).select('*').single();
        if (error) throw error;
        await registrarAuditoria({ req, action: 'PN_ALTERNATIVO_EDITADO', entity: 'PN_ALTERNATIVO', entityId: id, summary: `${payload.pn} ↔ ${payload.pn_alt}`, details: { anterior, novo: data } });
        return res.status(200).json({ status: 'success', message: 'Relação atualizada.', data });
    } catch (error) {
        console.error('ERRO AO EDITAR PN ALTERNATIVO:', error);
        return res.status(500).json({ status: 'error', message: error.message || 'Falha ao atualizar PN alternativo.' });
    }
};

exports.desativarPnAlternativo = async (req, res) => {
    try {
        const id = String(req.params.id || '').trim();
        const motivo = limparTexto(req.body?.motivo, 1000);
        const updatePayload = {
            ativo: false,
            updated_at: new Date().toISOString(),
            updated_by_email: req.user?.email || null,
        };
        if (motivo) updatePayload.observacao = motivo;
        const { data, error } = await supabase
            .from('pn_alternativos_documento')
            .update(updatePayload)
            .eq('id', id)
            .select('*')
            .single();
        if (error) throw error;
        await registrarAuditoria({ req, action: 'PN_ALTERNATIVO_DESATIVADO', entity: 'PN_ALTERNATIVO', entityId: id, summary: `${data.pn} ↔ ${data.pn_alt}`, details: { motivo } });
        return res.status(200).json({ status: 'success', message: 'Relação desativada sem apagar o histórico.', data });
    } catch (error) {
        console.error('ERRO AO DESATIVAR PN ALTERNATIVO:', error);
        return res.status(500).json({ status: 'error', message: error.message || 'Falha ao desativar PN alternativo.' });
    }
};

exports.criarPnAlternativosLote = async (req, res) => {
    try {
        const linhas = Array.isArray(req.body?.linhas) ? req.body.linhas : [];
        if (!linhas.length) return res.status(400).json({ status: 'error', message: 'Nenhuma linha informada.' });
        if (linhas.length > 500) return res.status(400).json({ status: 'error', message: 'Limite de 500 relações por lote manual.' });

        const validos = [];
        const ignorados = [];
        linhas.forEach((linha, index) => {
            const payload = payloadAlternativo(linha, req.user);
            if (!payload.pn || !payload.pn_alt || payload.pn === payload.pn_alt) {
                ignorados.push({ linha: index + 1, motivo: 'PN/PN_ALT inválido ou relação reflexiva.' });
                return;
            }
            validos.push({ ...payload, created_by_email: req.user?.email || null });
        });
        if (!validos.length) return res.status(400).json({ status: 'error', message: 'Nenhuma relação válida no lote.', ignorados });

        const existentes = await supabase.from('pn_alternativos_documento').select('pn,pn_alt,fonte').eq('ativo', true);
        if (existentes.error) throw existentes.error;
        const chaves = new Set((existentes.data || []).flatMap((row) => [
            `${normalizePn(row.pn)}|${normalizePn(row.pn_alt)}|${String(row.fonte || '').trim().toUpperCase()}`,
            `${normalizePn(row.pn_alt)}|${normalizePn(row.pn)}|${String(row.fonte || '').trim().toUpperCase()}`,
        ]));
        const novos = [];
        validos.forEach((row) => {
            const key = `${row.pn}|${row.pn_alt}|${String(row.fonte || '').trim().toUpperCase()}`;
            if (chaves.has(key)) return;
            chaves.add(key);
            chaves.add(`${row.pn_alt}|${row.pn}|${String(row.fonte || '').trim().toUpperCase()}`);
            novos.push(row);
        });
        if (novos.length) {
            const { error } = await supabase.from('pn_alternativos_documento').insert(novos);
            if (error) throw error;
        }
        await registrarAuditoria({ req, action: 'PN_ALTERNATIVOS_LOTE_MANUAL', entity: 'PN_ALTERNATIVO', summary: `${novos.length} relação(ões) cadastrada(s) em lote.`, details: { recebidas: linhas.length, inseridas: novos.length, ignoradas: ignorados.length, duplicadas: validos.length - novos.length } });
        return res.status(200).json({ status: 'success', message: `${novos.length} relação(ões) inserida(s).`, inseridas: novos.length, duplicadas: validos.length - novos.length, ignorados });
    } catch (error) {
        console.error('ERRO LOTE PN ALTERNATIVOS:', error);
        return res.status(500).json({ status: 'error', message: error.message || 'Falha ao cadastrar lote de PN alternativos.' });
    }
};

exports.resolverPnRelacoes = async (req, res) => {
    try {
        const data = await resolvePnRelations(req.params.pn);
        if (!data.pn) return res.status(400).json({ status: 'error', message: 'PN inválido.' });
        return res.status(200).json({ status: 'success', data });
    } catch (error) {
        console.error('ERRO AO RESOLVER RELAÇÕES DE PN:', error);
        return res.status(500).json({ status: 'error', message: error.message || 'Falha ao resolver relações de PN.' });
    }
};
