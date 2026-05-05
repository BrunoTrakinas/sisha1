const supabase = require('../config/supabaseClient');

function normalizarIdentificador(valor = '') {
    return String(valor).trim().toUpperCase();
}

function prepararLocalizacao(localizacao = '') {
    return String(localizacao || '').trim().toUpperCase();
}

// Busca EXATA para o Painel de Manutenção do PPU.
// Aceita PN completo ou SN completo e retorna TODOS os registros compatíveis.
exports.buscarPpuParaManutencao = async (req, res) => {
    try {
        const termo = normalizarIdentificador(req.params.termo);

        if (!termo) {
            return res.status(400).json({
                status: 'error',
                message: 'Informe um PN ou SN completo.'
            });
        }

        const colunas = 'id, pn, nomenclatura, quantidade, localizacao, sn, data_chegada, data_garantia';

        const [porPn, porSn] = await Promise.all([
            supabase
                .from('estoque_ppu')
                .select(colunas)
                .eq('pn', termo)
                .order('id', { ascending: true }),

            supabase
                .from('estoque_ppu')
                .select(colunas)
                .eq('sn', termo)
                .order('id', { ascending: true })
        ]);

        if (porPn.error) throw porPn.error;
        if (porSn.error) throw porSn.error;

        const mapa = new Map();

        [...(porPn.data || []), ...(porSn.data || [])].forEach((item) => {
            mapa.set(item.id, item);
        });

        const registros = Array.from(mapa.values());

        if (registros.length === 0) {
            return res.status(404).json({
                status: 'error',
                message: 'Nenhum registro exato encontrado. Use PN completo ou SN completo.'
            });
        }

        return res.status(200).json({
            status: 'success',
            data: registros,
            message:
                registros.length === 1
                    ? '1 registro exato encontrado.'
                    : `${registros.length} registros exatos encontrados. Selecione o correto para manutenção.`
        });
    } catch (error) {
        console.error('ERRO AO BUSCAR PPU PARA MANUTENÇÃO:', error);
        return res.status(500).json({
            status: 'error',
            message: 'Falha ao consultar o PPU para manutenção.'
        });
    }
};

// Manutenção segura por ID físico da linha.
exports.atualizarPpuPorId = async (req, res) => {
    try {
        const { id } = req.params;
        const { quantidade, localizacao } = req.body;

        const payload = {
            quantidade: Number(quantidade) || 0,
            localizacao: prepararLocalizacao(localizacao)
        };

        const { error } = await supabase
            .from('estoque_ppu')
            .update(payload)
            .eq('id', id);

        if (error) throw error;

        return res.status(200).json({
            status: 'success',
            message: `Registro ${id} reconfigurado com sucesso!`
        });
    } catch (error) {
        console.error('ERRO AO EDITAR PPU POR ID:', error);
        return res.status(500).json({
            status: 'error',
            message: 'Falha ao atualizar o registro físico do PPU.'
        });
    }
};

exports.excluirPpuPorId = async (req, res) => {
    try {
        const { id } = req.params;

        const { error } = await supabase
            .from('estoque_ppu')
            .delete()
            .eq('id', id);

        if (error) throw error;

        return res.status(200).json({
            status: 'success',
            message: `Registro ${id} abatido do sistema com sucesso.`
        });
    } catch (error) {
        console.error('ERRO AO EXCLUIR PPU POR ID:', error);
        return res.status(500).json({
            status: 'error',
            message: 'Falha ao abater o registro do PPU.'
        });
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
