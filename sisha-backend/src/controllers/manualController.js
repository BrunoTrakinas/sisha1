// src/controllers/manualController.js
const supabase = require('../config/supabaseClient');

// 1. Registar Ação (Missão Bravo - Já estava a funcionar)
exports.registrarAcaoTatica = async (req, res) => {
    try {
        const { tipoAcao, identificador, valor, msg, sn } = req.body;
        if (!identificador) return res.status(400).json({ status: 'error', message: 'Identificador obrigatório.' });

        const { error } = await supabase.from('cadastros_manuais').insert([{
            tipo_registro: tipoAcao, identificador_unico: identificador.toUpperCase(),
            valor_monetario: valor ? parseFloat(valor) : 0, msg_referencia: msg || null,
            sn: sn ? sn.toUpperCase() : null, ativo: true
        }]);

        if (error) throw error;
        return res.status(200).json({ status: 'success', message: `Ação ${tipoAcao} injetada na rede!` });
    } catch (error) { return res.status(500).json({ status: 'error', message: 'Falha crítica ao gravar.' }); }
};

// 2. Buscar Ação Tática Específica (Para preencher o Modal)
exports.buscarAcaoTatica = async (req, res) => {
    try {
        const { id } = req.params;
        const { data, error } = await supabase.from('cadastros_manuais')
            .select('*').eq('identificador_unico', id.toUpperCase()).single();
        
        if (error || !data) return res.status(404).json({ status: 'error', message: 'Alvo tático não encontrado.' });
        return res.status(200).json({ status: 'success', data });
    } catch (error) { return res.status(500).json({ status: 'error', message: 'Erro no radar de busca.' }); }
};

// 3. Atualizar Ação Tática
exports.atualizarAcaoTatica = async (req, res) => {
    try {
        const { id } = req.params;
        const { valor_monetario, msg_referencia, sn } = req.body;
        
        const { error } = await supabase.from('cadastros_manuais')
            .update({ valor_monetario: parseFloat(valor_monetario), msg_referencia, sn })
            .eq('identificador_unico', id.toUpperCase());

        if (error) throw error;
        return res.status(200).json({ status: 'success', message: `Registo ${id} reconfigurado.` });
    } catch (error) { return res.status(500).json({ status: 'error', message: 'Falha ao atualizar.' }); }
};

// 4. Excluir Ação Tática
exports.excluirAcaoTatica = async (req, res) => {
    try {
        const { id } = req.params;
        const { error } = await supabase.from('cadastros_manuais').delete().eq('identificador_unico', id.toUpperCase());
        if (error) throw error;
        return res.status(200).json({ status: 'success', message: `Registo ${id} abatido com sucesso.` });
    } catch (error) { return res.status(500).json({ status: 'error', message: 'Falha ao abater.' }); }
};