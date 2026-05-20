import React, { useEffect, useState } from 'react';
import { Eye, EyeOff } from 'lucide-react';
import RfqImporter from '../components/RfqImporter';
import NeedsFoundationPanel from '../components/NeedsFoundationPanel';
import { useAuth } from '../context/AuthContext';
import { apiFetch, buildAuthHeaders } from '../lib/api';

const formatarGBP = (valor) => {
    const numero = Number(valor);
    if (!Number.isFinite(numero)) return '—';
    return new Intl.NumberFormat('en-GB', {
        style: 'currency',
        currency: 'GBP',
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
    }).format(numero);
};

export default function Cadastro() {
    const { token, user } = useAuth();
    const isDono = Boolean(user?.isDono) || user?.role === 'dono' || Boolean(user?.isGod) || String(user?.email || '').trim().toLowerCase() === 'bruno.martins@marinha.mil.br';
    const isAdmin = user?.role === 'admin';
    const podeGerenciarUsuarios = isDono || isAdmin;
    const [file, setFile] = useState(null);
    const [tipoArquivo, setTipoArquivo] = useState('order_book');
    const [uploadCarregando, setUploadCarregando] = useState(false);
    const [uploadMsg, setUploadMsg] = useState(null);
    const [modalCeimspaConfirm, setModalCeimspaConfirm] = useState(false);
    const [ceimspaOverwrite, setCeimspaOverwrite] = useState(false);
    const [modalTriagem, setModalTriagem] = useState(false);
    const [dadosTriagem, setDadosTriagem] = useState([]);
    const [infoRecibo, setInfoRecibo] = useState({ ref: '', data: '', isFoc: false });

    const [tipoAcao, setTipoAcao] = useState('OC_SUPLEMENTO');
    const [identificador, setIdentificador] = useState('');
    const [valorManual, setValorManual] = useState('');
    const [msgRef, setMsgRef] = useState('');
    const [snManual, setSnManual] = useState('');
    const [manualCarregando, setManualCarregando] = useState(false);
    const [manualMsg, setManualMsg] = useState(null);

    const [email, setEmail] = useState('');
    const [senha, setSenha] = useState('');
    const [roleCadastro, setRoleCadastro] = useState('operador');
    const [mostrarSenhaCadastro, setMostrarSenhaCadastro] = useState(false);
    const [membroCarregando, setMembroCarregando] = useState(false);
    const [membroMsg, setMembroMsg] = useState(null);

    const [usuariosAutorizados, setUsuariosAutorizados] = useState([]);
    const [usuariosCarregando, setUsuariosCarregando] = useState(false);
    const [editandoUsuarioId, setEditandoUsuarioId] = useState(null);
    const [usuarioEdit, setUsuarioEdit] = useState({ email: '', role: 'operador', active: true, senha: '' });
    const [mostrarSenhaEdicao, setMostrarSenhaEdicao] = useState(false);

    const [modalAdmin, setModalAdmin] = useState(false);
    const [alvoAdmin, setAlvoAdmin] = useState('ppu');
    const [idBuscaAdmin, setIdBuscaAdmin] = useState('');
    const [dadosEdicao, setDadosEdicao] = useState(null);
    const [resultadosPpuAdmin, setResultadosPpuAdmin] = useState([]);
    const [adminMsg, setAdminMsg] = useState(null);
    const [adminCarregando, setAdminCarregando] = useState(false);
    const [resultadosAdminGenericos, setResultadosAdminGenericos] = useState([]);

    const handleFileChange = (e) => {
        if (e.target.files[0]) {
            setFile(e.target.files[0]);
            if (e.target.files[0].name.toLowerCase().includes('ceimspa')) {
                setTipoArquivo('ceimspa');
                setModalCeimspaConfirm(true);
            }
        }
    };

    const handleUpload = async (e) => {
        e.preventDefault();
        if (!file) return;
        setUploadCarregando(true);
        setUploadMsg(null);

        const formData = new FormData();
        formData.append('file', file);
        formData.append('tipoArquivo', tipoArquivo);
        if (tipoArquivo === 'ceimspa') {
            formData.append('overwrite', ceimspaOverwrite ? 'true' : 'false');
        }

        try {
            const response = await apiFetch(
                '/import/upload',
                { method: 'POST', headers: buildAuthHeaders(token), body: formData },
                token
            );
            const data = await response.json();

            if (data.status === 'success') {
                if (data.data_triagem) {
                    setInfoRecibo({
                        ref: data.recibo_ref || '',
                        data: data.data_entrega_ref || '',
                        isFoc: data.is_foc
                    });

                    const itensFormatados = data.data_triagem.map(item => {
    const quantidade = Number(item.quantidade_recebida ?? item.quantidade ?? 0);
    const valorUnitario = item.valor_unitario == null || item.valor_unitario === ''
        ? null
        : Number(item.valor_unitario);

    const valorTotal = item.valor_total == null || item.valor_total === ''
        ? (Number.isFinite(valorUnitario) ? Number((valorUnitario * quantidade).toFixed(2)) : null)
        : Number(item.valor_total);

    return {
        ...item,
        quantidade,
        quantidade_recebida: quantidade,
        valor_unitario: Number.isFinite(valorUnitario) ? valorUnitario : null,
        valor_total: Number.isFinite(valorTotal) ? valorTotal : null,
        moeda: item.moeda || 'GBP',
        sns_finais: item.sns_pre_carregados ? item.sns_pre_carregados.join(', ') : '',
        localizacao_ppu: item.localizacao_ppu || 'DOCA RECEBIMENTO'
    };
});

                    setDadosTriagem(itensFormatados);
                    setModalTriagem(true);
                } else {
                    setUploadMsg({ tipo: 'success', texto: data.message });
                }
            } else {
                setUploadMsg({ tipo: 'error', texto: data.message });
            }
        } catch {
            setUploadMsg({ tipo: 'error', texto: 'Falha de comunicação com o Servidor.' });
        } finally {
            setUploadCarregando(false);
            setFile(null);
        }
    };

    const handleConfirmarTriagem = async () => {
        setUploadCarregando(true);

        const payloadFinal = {
            recibo_ref: infoRecibo.ref,
            data_entrega: infoRecibo.data,
            is_foc: infoRecibo.isFoc,
            itens: dadosTriagem
        };

        try {
            const response = await apiFetch(
                '/import/confirmar_triagem',
                {
                    method: 'POST',
                    headers: buildAuthHeaders(token, { 'Content-Type': 'application/json' }),
                    body: JSON.stringify(payloadFinal)
                },
                token
            );

            const result = await response.json();

            if (result.status === 'success') {
                setUploadMsg({ tipo: 'success', texto: result.message });
                setModalTriagem(false);
            } else {
                setUploadMsg({ tipo: 'error', texto: result.message });
            }
        } catch {
            setUploadMsg({ tipo: 'error', texto: 'Falha de conexão.' });
        } finally {
            setUploadCarregando(false);
        }
    };

    const atualizarSnDaTriagem = (index, campo, novoValor) => {
        const novosDados = [...dadosTriagem];
        novosDados[index][campo] = novoValor;
        setDadosTriagem(novosDados);
    };

    const handleAcaoTatica = async (e) => {
        e.preventDefault();
        if (!identificador) return;

        setManualCarregando(true);
        setManualMsg(null);

        const payload = {
            tipoAcao,
            identificador,
            valor: valorManual,
            msg: msgRef,
            sn: snManual
        };

        try {
            const response = await apiFetch(
                '/manual/registrar',
                {
                    method: 'POST',
                    headers: buildAuthHeaders(token, { 'Content-Type': 'application/json' }),
                    body: JSON.stringify(payload)
                },
                token
            );

            const result = await response.json();

            if (result.status === 'success') {
                setManualMsg({ tipo: 'success', texto: result.message });
                setIdentificador('');
                setValorManual('');
                setMsgRef('');
                setSnManual('');
            } else {
                setManualMsg({ tipo: 'error', texto: result.message });
            }
        } catch {
            setManualMsg({ tipo: 'error', texto: 'Erro de ligação.' });
        } finally {
            setManualCarregando(false);
        }
    };

    const handleCadastroMembro = async (e) => {
        e.preventDefault();
        if (!isDono || !senha || !email) return;

        setMembroCarregando(true);
        setMembroMsg(null);

        try {
            const response = await apiFetch(
                '/auth/users',
                {
                    method: 'POST',
                    headers: buildAuthHeaders(token, { 'Content-Type': 'application/json' }),
                    body: JSON.stringify({
                        email,
                        senha,
                        role: roleCadastro
                    })
                },
                token
            );

            const result = await response.json();

            if (result.status === 'success') {
                setMembroMsg({ tipo: 'success', texto: result.message });
                setEmail('');
                setSenha('');
                setRoleCadastro('operador');
                setMostrarSenhaCadastro(false);
            } else {
                setMembroMsg({ tipo: 'error', texto: result.message || 'Falha ao cadastrar militar.' });
            }
        } catch {
            setMembroMsg({ tipo: 'error', texto: 'Erro de ligação com o servidor.' });
        } finally {
            setMembroCarregando(false);
        }
    };


    const carregarUsuariosAutorizados = async () => {
        if (!podeGerenciarUsuarios) return;
        setUsuariosCarregando(true);
        try {
            const response = await apiFetch('/auth/users', {}, token);
            const result = await response.json();
            if (result.status === 'success') {
                setUsuariosAutorizados(result.data || []);
            } else {
                setMembroMsg({ tipo: 'error', texto: result.message || 'Falha ao listar usuários.' });
            }
        } catch {
            setMembroMsg({ tipo: 'error', texto: 'Erro de ligação ao listar usuários.' });
        } finally {
            setUsuariosCarregando(false);
        }
    };

    useEffect(() => {
        if (podeGerenciarUsuarios && token) carregarUsuariosAutorizados();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [podeGerenciarUsuarios, token]);

    const iniciarEdicaoUsuario = (usuario) => {
        setEditandoUsuarioId(usuario.id);
        setUsuarioEdit({
            email: usuario.email || '',
            role: usuario.role || 'operador',
            active: usuario.active !== false,
            senha: '',
        });
    };

    const cancelarEdicaoUsuario = () => {
        setEditandoUsuarioId(null);
        setUsuarioEdit({ email: '', role: 'operador', active: true, senha: '' });
        setMostrarSenhaEdicao(false);
    };

    const handleAtualizarUsuario = async (usuarioId) => {
        if (!podeGerenciarUsuarios) return;
        setMembroCarregando(true);
        setMembroMsg(null);
        try {
            const payload = {
                email: usuarioEdit.email,
                active: usuarioEdit.active,
            };
            if (isDono) payload.role = usuarioEdit.role;
            if (usuarioEdit.senha) payload.senha = usuarioEdit.senha;

            const response = await apiFetch(
                `/auth/users/${usuarioId}`,
                {
                    method: 'PUT',
                    headers: buildAuthHeaders(token, { 'Content-Type': 'application/json' }),
                    body: JSON.stringify(payload),
                },
                token
            );
            const result = await response.json();
            if (result.status === 'success') {
                setMembroMsg({ tipo: 'success', texto: result.message });
                cancelarEdicaoUsuario();
                carregarUsuariosAutorizados();
            } else {
                setMembroMsg({ tipo: 'error', texto: result.message || 'Falha ao atualizar usuário.' });
            }
        } catch {
            setMembroMsg({ tipo: 'error', texto: 'Erro de ligação ao atualizar usuário.' });
        } finally {
            setMembroCarregando(false);
        }
    };

    const handleExcluirUsuario = async (usuario) => {
        if (!isDono) return;
        const emailAlvo = usuario?.email || 'este usuário';
        if (!window.confirm(`Confirmar exclusão do acesso de ${emailAlvo}?`)) return;
        setMembroCarregando(true);
        setMembroMsg(null);
        try {
            const response = await apiFetch(
                `/auth/users/${usuario.id}`,
                { method: 'DELETE' },
                token
            );
            const result = await response.json();
            if (result.status === 'success') {
                setMembroMsg({ tipo: 'success', texto: result.message });
                carregarUsuariosAutorizados();
            } else {
                setMembroMsg({ tipo: 'error', texto: result.message || 'Falha ao excluir usuário.' });
            }
        } catch {
            setMembroMsg({ tipo: 'error', texto: 'Erro de ligação ao excluir usuário.' });
        } finally {
            setMembroCarregando(false);
        }
    };

    const prepararRegistroPpuParaEdicao = (registro) => ({
        id: registro.id,
        id_referencia: registro.pn || '',
        nomenclatura: registro.nomenclatura || '',
        quantidade: registro.quantidade || 0,
        localizacao: registro.localizacao || '',
        sn: registro.sn || '',
    });

    const buscarParaManutencao = async () => {
        if (!idBuscaAdmin.trim()) return;

        setAdminCarregando(true);
        setAdminMsg(null);
        setDadosEdicao(null);
        setResultadosPpuAdmin([]);
        setResultadosAdminGenericos([]);

        try {
            const termo = idBuscaAdmin.trim();
            const fontesEmPreparacao = ['compras_info', 'recibo', 'order_book', 'ceimspa', 'lisde', 'price_list', 'sb', 'pim', 'os', 'recex'];
            if (fontesEmPreparacao.includes(alvoAdmin)) {
                setAdminMsg({
                    tipo: 'info',
                    texto: 'Fonte mapeada para fluxo próprio. Para OC/PD/WO use a página Ordens de Compras; para as demais fontes, a edição específica será ativada após validarmos campos travados, auditoria e modelo documental.'
                });
                return;
            }

            const endpoint =
                alvoAdmin === 'ppu'
                    ? `/items/ppu/buscar/${encodeURIComponent(termo)}`
                    : alvoAdmin === 'acao_tatica'
                        ? `/manual/buscar/${encodeURIComponent(termo)}`
                        : alvoAdmin === 'oc'
                            ? `/purchases/ordens?q=${encodeURIComponent(termo)}`
                            : alvoAdmin === 'wo'
                                ? `/purchases/work-orders?q=${encodeURIComponent(termo)}`
                                : alvoAdmin === 'apelidos'
                                    ? `/items/apelidos?q=${encodeURIComponent(termo)}`
                                    : null;

            if (!endpoint) {
                setAdminMsg({ tipo: 'error', texto: 'Fonte ainda não conectada.' });
                return;
            }

            const response = await apiFetch(endpoint, {}, token);
            const json = await response.json();

            if (json.status === 'success') {
                if (alvoAdmin === 'ppu') {
                    const registros = Array.isArray(json.data) ? json.data : [];

                    if (registros.length === 0) {
                        setAdminMsg({
                            tipo: 'error',
                            texto: 'Nenhum registro exato encontrado. Use PN completo ou SN completo.'
                        });
                    } else if (registros.length === 1) {
                        setDadosEdicao(prepararRegistroPpuParaEdicao(registros[0]));
                        setResultadosPpuAdmin(registros);
                        setAdminMsg({ tipo: 'success', texto: 'Registro exato localizado.' });
                    } else {
                        setResultadosPpuAdmin(registros);
                        setAdminMsg({
                            tipo: 'success',
                            texto: json.message || 'Foram encontrados vários registros exatos. Selecione o correto.'
                        });
                    }
                } else if (alvoAdmin === 'acao_tatica' && json.data) {
                    setDadosEdicao({
                        id_referencia: json.data.identificador_unico || '',
                        valor_monetario: json.data.valor_monetario || '',
                        msg_referencia: json.data.msg_referencia || '',
                        sn: json.data.sn || ''
                    });
                } else if (['oc', 'wo', 'apelidos'].includes(alvoAdmin)) {
                    const registros = Array.isArray(json.data) ? json.data : [];
                    setResultadosAdminGenericos(registros);
                    setAdminMsg({
                        tipo: registros.length ? 'success' : 'error',
                        texto: registros.length
                            ? `${registros.length} registro(s) localizado(s). Para edição completa de OC/WO, use a página Ordens de Compras.`
                            : 'Nenhum registro localizado para o termo informado.'
                    });
                } else {
                    setAdminMsg({ tipo: 'error', texto: 'Alvo não localizado no sistema.' });
                }
            } else {
                setAdminMsg({ tipo: 'error', texto: json.message || 'Alvo não localizado.' });
            }
        } catch {
            setAdminMsg({ tipo: 'error', texto: 'Falha na comunicação com a base.' });
        } finally {
            setAdminCarregando(false);
        }
    };

    const salvarEdicaoManutencao = async () => {
        setAdminCarregando(true);
        setAdminMsg(null);

        try {
            if (alvoAdmin !== 'ppu') {
                setAdminMsg({ tipo: 'info', texto: 'Esta fonte já está pesquisável aqui, mas a edição completa deve ser feita no módulo específico para preservar regras e auditoria.' });
                return;
            }

            const endpoint =
                `/items/ppu/id/${encodeURIComponent(dadosEdicao.id)}`;

            const payload =
                { quantidade: dadosEdicao.quantidade, localizacao: dadosEdicao.localizacao };

            const response = await apiFetch(
                endpoint,
                {
                    method: 'PUT',
                    headers: buildAuthHeaders(token, { 'Content-Type': 'application/json' }),
                    body: JSON.stringify(payload)
                },
                token
            );

            const result = await response.json();

            if (result.status === 'success') {
                setAdminMsg({ tipo: 'success', texto: result.message });
            } else {
                setAdminMsg({ tipo: 'error', texto: result.message });
            }
        } catch {
            setAdminMsg({ tipo: 'error', texto: 'Erro crítico ao gravar.' });
        } finally {
            setAdminCarregando(false);
        }
    };

    const excluirManutencao = async () => {
        const confirmar = window.confirm(
            `ATENÇÃO COMANDO: Confirmar a EXCLUSÃO de ${dadosEdicao.id_referencia}? Esta ação é irreversível.`
        );
        if (!confirmar) return;

        setAdminCarregando(true);
        setAdminMsg(null);

        try {
            if (alvoAdmin !== 'ppu') {
                setAdminMsg({ tipo: 'info', texto: 'Esta fonte já está pesquisável aqui, mas a edição completa deve ser feita no módulo específico para preservar regras e auditoria.' });
                return;
            }

            const endpoint =
                `/items/ppu/id/${encodeURIComponent(dadosEdicao.id)}`;

            const response = await apiFetch(endpoint, { method: 'DELETE' }, token);
            const result = await response.json();

            if (result.status === 'success') {
                setAdminMsg({ tipo: 'success', texto: result.message });
                setDadosEdicao(null);
                setResultadosPpuAdmin([]);
                setIdBuscaAdmin('');
            } else {
                setAdminMsg({ tipo: 'error', texto: result.message });
            }
        } catch {
            setAdminMsg({ tipo: 'error', texto: 'Erro crítico ao excluir.' });
        } finally {
            setAdminCarregando(false);
        }
    };

    return (
        <div className="space-y-8">
            <section className="bg-white rounded-3xl p-8 shadow-sm border border-slate-200">
                <h2 className="text-xl font-black text-slate-800 mb-4 uppercase">Central de Inserção</h2>
                <form onSubmit={handleUpload} className="space-y-4">
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                        <select
                            value={tipoArquivo}
                            onChange={(e) => setTipoArquivo(e.target.value)}
                            className="w-full p-3 bg-white border-2 border-slate-200 rounded-xl font-bold text-slate-900"
                        >
                            <option value="order_book">Order Book</option>
                            <option value="price_list">Price List</option>
                            <option value="inventario_ppu">Inventário PPU</option>
                            <option value="ceimspa">Estoque CeIMSPA</option>
                            <option value="lisde">LISDE</option>
                            <option value="manual_legado">Manual</option>
                            <option value="pn_alternativos">PN Alternativos</option>
                            <option value="recibo_material">Recibo Material / Garantia</option>
                            <option value="recibo_pd">Recibo de PD</option>
                            <option value="qnna">QNNA</option>
                            <option value="sb">SB</option>
                            <option value="receitas">Receitas</option>
                            <option value="pim">PIM</option>
                            <option value="politica_estoque_tarefas">Política de Estoque</option>
                        </select>

                        <input
                            type="file"
                            onChange={handleFileChange}
                            className="w-full p-3 bg-white border-2 border-slate-200 rounded-xl font-bold text-slate-900 file:text-slate-900"
                        />
                    </div>

                    <div className="flex justify-end">
                        <button
                            type="submit"
                            disabled={!file || uploadCarregando}
                            className="bg-blue-600 text-white px-8 py-3 rounded-xl font-black hover:bg-blue-700 disabled:opacity-50"
                        >
                            {uploadCarregando ? 'ENVIANDO...' : 'ENVIAR ARQUIVO'}
                        </button>
                    </div>

                    {uploadMsg && (
                        <p className={`font-bold ${uploadMsg.tipo === 'success' ? 'text-green-600' : 'text-red-600'}`}>
                            {uploadMsg.texto}
                        </p>
                    )}

                    {tipoArquivo === 'ceimspa' && (
                        <div className="rounded-2xl border border-purple-200 bg-purple-50 p-4 text-sm font-bold text-purple-900">
                            Modo CeIMSPA: {ceimspaOverwrite ? 'substituição total da base atual' : 'adição/suplemento sem limpar a base atual'}.
                            <button
                                type="button"
                                onClick={() => setModalCeimspaConfirm(true)}
                                className="ml-2 underline font-black"
                            >
                                Alterar modo
                            </button>
                        </div>
                    )}
                </form>
            </section>

            <section className="bg-white rounded-3xl p-8 shadow-sm border border-slate-200">
                <h2 className="text-xl font-black text-slate-800 mb-4 uppercase">Registro Operacional Complementar</h2>
                <div className="rounded-2xl border border-blue-100 bg-blue-50 p-5 space-y-3">
                    <p className="text-sm font-bold text-slate-800">
                        Fluxo reorganizado: OC, PD, WO, suplementações, vínculo de SN, resultado técnico e observações operacionais agora ficam no módulo
                        <span className="font-black"> Ordens de Compras / WO</span>.
                    </p>
                    <p className="text-sm text-slate-700">
                        Esta separação evita duplicidade de lançamento, reduz risco de divergência e mantém cada dado no módulo correto. Use a Central de Inserção para leitura/importação de documentos e a Manutenção Administrativa para correções pontuais de bases que ainda não possuem página própria.
                    </p>
                    <div className="flex flex-wrap gap-3 pt-2">
                        <a href="/compras" className="inline-flex items-center justify-center rounded-xl bg-blue-600 px-5 py-3 text-sm font-black text-white hover:bg-blue-700">
                            IR PARA ORDENS DE COMPRAS / WO
                        </a>
                        <button
                            type="button"
                            onClick={() => setModalAdmin(true)}
                            className="inline-flex items-center justify-center rounded-xl bg-slate-900 px-5 py-3 text-sm font-black text-white hover:bg-slate-800"
                        >
                            ABRIR MANUTENÇÃO ADMINISTRATIVA
                        </button>
                    </div>
                </div>
            </section>

            {podeGerenciarUsuarios ? (
                <section className="bg-white rounded-3xl p-8 shadow-sm border border-slate-200">
                    <div className="flex items-start justify-between gap-4 mb-6">
                        <div>
                            <h2 className="text-xl font-black text-slate-800 mb-1 flex items-center gap-2 uppercase">
                                Gestão de Usuários
                            </h2>
                            <p className="text-sm text-slate-700">
                                Dono visualiza e edita todos os usuários. Admin visualiza apenas a própria conta e usuários Operador, podendo alterar e-mail, senha e status, sem criar usuário nem promover permissões.
                            </p>
                        </div>
                        <span className="rounded-full bg-purple-100 px-4 py-2 text-xs font-black text-purple-700 uppercase">{isDono ? 'DONO' : 'ADMIN'}</span>
                    </div>

                    {isDono ? (
                    <form onSubmit={handleCadastroMembro} className="space-y-4 mb-8">
                        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                            <input
                                type="email"
                                value={email}
                                onChange={(e) => setEmail(e.target.value)}
                                placeholder="Email Militar"
                                className="w-full p-3 bg-white border-2 border-slate-200 rounded-xl font-bold text-slate-900 placeholder:text-slate-500"
                            />

                            <div className="relative">
                                <input
                                    type={mostrarSenhaCadastro ? 'text' : 'password'}
                                    value={senha}
                                    onChange={(e) => setSenha(e.target.value)}
                                    placeholder="Senha"
                                    className="w-full p-3 pr-12 bg-white border-2 border-slate-200 rounded-xl font-bold text-slate-900 placeholder:text-slate-500"
                                />
                                <button
                                    type="button"
                                    onClick={() => setMostrarSenhaCadastro(prev => !prev)}
                                    className="absolute inset-y-0 right-0 px-3 text-slate-500 hover:text-slate-800"
                                    aria-label={mostrarSenhaCadastro ? 'Ocultar senha' : 'Mostrar senha'}
                                >
                                    {mostrarSenhaCadastro ? <EyeOff size={18} /> : <Eye size={18} />}
                                </button>
                            </div>

                            <select
                                value={roleCadastro}
                                onChange={(e) => setRoleCadastro(e.target.value)}
                                className="w-full p-3 bg-white border-2 border-slate-200 rounded-xl font-bold text-slate-900"
                            >
                                <option value="operador">Operador</option>
                                <option value="admin">Admin</option>
                                <option value="dono">Dono</option>
                            </select>
                        </div>

                        <div className="flex flex-wrap justify-end gap-3">
                            <button
                                type="button"
                                onClick={carregarUsuariosAutorizados}
                                disabled={usuariosCarregando}
                                className="bg-slate-900 text-white px-6 py-3 rounded-xl font-black hover:bg-slate-800 disabled:opacity-50"
                            >
                                ATUALIZAR LISTA
                            </button>
                            <button
                                type="submit"
                                disabled={membroCarregando || !senha || !email}
                                className="bg-indigo-600 text-white px-8 py-3 rounded-xl font-black hover:bg-indigo-700 disabled:opacity-50"
                            >
                                CADASTRAR MILITAR
                            </button>
                        </div>
                    </form>
                    ) : (
                        <div className="mb-8 rounded-2xl border border-blue-100 bg-blue-50 p-5 text-sm font-bold text-blue-900">
                            Como Admin, você pode editar sua própria conta e os usuários Operador listados abaixo. Criação de usuários e promoção/rebaixamento de permissões ficam restritas ao Dono.
                        </div>
                    )}

                    {membroMsg && (
                        <p className={`font-bold mb-4 ${membroMsg.tipo === 'success' ? 'text-green-600' : 'text-red-600'}`}>
                            {membroMsg.texto}
                        </p>
                    )}

                    <div className="overflow-auto border border-slate-200 rounded-2xl">
                        <table className="min-w-full text-sm">
                            <thead className="bg-slate-100 text-slate-700 uppercase text-xs">
                                <tr>
                                    <th className="p-3 text-left">Email</th>
                                    <th className="p-3 text-left">Perfil</th>
                                    <th className="p-3 text-left">Ativo</th>
                                    <th className="p-3 text-left">Nova senha</th>
                                    <th className="p-3 text-right">Ações</th>
                                </tr>
                            </thead>
                            <tbody className="text-slate-900">
                                {usuariosAutorizados.map((usuario) => {
                                    const isEditing = editandoUsuarioId === usuario.id;
                                    const isDonoLinha = String(usuario.role || '').trim().toLowerCase() === 'dono';
                                    return (
                                        <tr key={usuario.id} className="border-t border-slate-200">
                                            <td className="p-3 font-bold">
                                                {isEditing ? (
                                                    <input
                                                        value={usuarioEdit.email}
                                                        onChange={(e) => setUsuarioEdit(prev => ({ ...prev, email: e.target.value }))}
                                                        className="w-full p-2 bg-white border-2 border-slate-200 rounded-xl font-bold text-slate-900"
                                                    />
                                                ) : usuario.email}
                                            </td>
                                            <td className="p-3">
                                                {isEditing && isDono ? (
                                                    <select
                                                        value={usuarioEdit.role}
                                                        onChange={(e) => setUsuarioEdit(prev => ({ ...prev, role: e.target.value }))}
                                                        className="w-full p-2 bg-white border-2 border-slate-200 rounded-xl font-bold text-slate-900"
                                                    >
                                                        <option value="operador">Operador</option>
                                                        <option value="admin">Admin</option>
                                                        <option value="dono">Dono</option>
                                                    </select>
                                                ) : (
                                                    <span className="font-black uppercase">{usuario.role}</span>
                                                )}
                                            </td>
                                            <td className="p-3">
                                                {isEditing ? (
                                                    <select
                                                        value={usuarioEdit.active ? 'sim' : 'nao'}
                                                        onChange={(e) => setUsuarioEdit(prev => ({ ...prev, active: e.target.value === 'sim' }))}
                                                        className="w-full p-2 bg-white border-2 border-slate-200 rounded-xl font-bold text-slate-900"
                                                    >
                                                        <option value="sim">Sim</option>
                                                        <option value="nao">Não</option>
                                                    </select>
                                                ) : (
                                                    <span className={`font-black ${usuario.active === false ? 'text-red-600' : 'text-green-600'}`}>
                                                        {usuario.active === false ? 'NÃO' : 'SIM'}
                                                    </span>
                                                )}
                                            </td>
                                            <td className="p-3">
                                                {isEditing ? (
                                                    <div className="relative">
                                                        <input
                                                            type={mostrarSenhaEdicao ? 'text' : 'password'}
                                                            value={usuarioEdit.senha}
                                                            onChange={(e) => setUsuarioEdit(prev => ({ ...prev, senha: e.target.value }))}
                                                            placeholder="Deixe vazio para manter"
                                                            className="w-full p-2 pr-11 bg-white border-2 border-slate-200 rounded-xl font-bold text-slate-900 placeholder:text-slate-500"
                                                        />
                                                        <button
                                                            type="button"
                                                            onClick={() => setMostrarSenhaEdicao(prev => !prev)}
                                                            className="absolute inset-y-0 right-0 px-3 text-slate-500 hover:text-slate-800"
                                                            aria-label={mostrarSenhaEdicao ? 'Ocultar senha' : 'Mostrar senha'}
                                                        >
                                                            {mostrarSenhaEdicao ? <EyeOff size={18} /> : <Eye size={18} />}
                                                        </button>
                                                    </div>
                                                ) : '—'}
                                            </td>
                                            <td className="p-3">
                                                <div className="flex justify-end gap-2">
                                                    {isEditing ? (
                                                        <>
                                                            <button
                                                                type="button"
                                                                onClick={() => handleAtualizarUsuario(usuario.id)}
                                                                className="px-4 py-2 rounded-xl bg-blue-600 text-white font-black hover:bg-blue-700"
                                                            >
                                                                SALVAR
                                                            </button>
                                                            <button
                                                                type="button"
                                                                onClick={cancelarEdicaoUsuario}
                                                                className="px-4 py-2 rounded-xl bg-slate-200 text-slate-900 font-black hover:bg-slate-300"
                                                            >
                                                                CANCELAR
                                                            </button>
                                                        </>
                                                    ) : (
                                                        <>
                                                            <button
                                                                type="button"
                                                                onClick={() => iniciarEdicaoUsuario(usuario)}
                                                                className="px-4 py-2 rounded-xl bg-amber-500 text-white font-black hover:bg-amber-600"
                                                            >
                                                                EDITAR
                                                            </button>
                                                            {isDono && (
                                                                <button
                                                                    type="button"
                                                                    onClick={() => handleExcluirUsuario(usuario)}
                                                                    className={`px-4 py-2 rounded-xl text-white font-black ${isDonoLinha ? 'bg-red-700 hover:bg-red-800' : 'bg-red-600 hover:bg-red-700'}`}
                                                                >
                                                                    EXCLUIR
                                                                </button>
                                                            )}
                                                        </>
                                                    )}
                                                </div>
                                            </td>
                                        </tr>
                                    );
                                })}
                                {usuariosAutorizados.length === 0 && (
                                    <tr>
                                        <td colSpan="5" className="p-4 text-center font-bold text-slate-500">Nenhum usuário listado.</td>
                                    </tr>
                                )}
                            </tbody>
                        </table>
                    </div>
                </section>
            ) : (
                <section className="bg-white rounded-3xl p-8 shadow-sm border border-slate-200">
                    <h2 className="text-xl font-black text-slate-800 mb-2 uppercase">Gestão de Usuários</h2>
                    <div className="rounded-2xl border border-amber-200 bg-amber-50 p-5 text-sm font-bold text-amber-900">
                        A gestão de usuários é restrita aos perfis Admin e Dono. Operador deve solicitar alteração de senha a um Admin ou ao Dono.
                    </div>
                </section>
            )}

            <section className="bg-white rounded-3xl p-8 shadow-sm border border-slate-200">
                <div className="flex items-center justify-between mb-4">
                    <div>
                        <h2 className="text-xl font-black text-slate-800 uppercase">Manutenção Administrativa de Dados</h2>
                        <p className="text-sm text-slate-700">Correção segura por ADMIN: pesquise a base, revise o registro e altere/exclua somente pelo fluxo auditável.</p>
                    </div>

                    <button
                        onClick={() => setModalAdmin(true)}
                        className="bg-slate-900 text-white px-6 py-3 rounded-xl font-black hover:bg-slate-800"
                    >
                        ABRIR PAINEL
                    </button>
                </div>
            </section>

            <NeedsFoundationPanel token={token} />

            <RfqImporter />

            {modalCeimspaConfirm && (
                <div className="fixed inset-0 bg-black/70 flex items-center justify-center p-4 z-50">
                    <div className="bg-white rounded-3xl p-8 max-w-lg w-full shadow-2xl space-y-4">
                        <h3 className="text-xl font-black text-slate-900 uppercase">Confirmação CeIMSPA</h3>
                        <p className="text-slate-900">
                            Escolha como o SISHA deve tratar a importação do estoque CeIMSPA.
                        </p>
                        <p className="text-sm font-bold text-amber-700 bg-amber-50 border border-amber-200 rounded-2xl p-3">
                            Use “Substituir base” quando o arquivo for a base completa atualizada. Use “Adicionar suplemento” apenas para carregar novos itens sem apagar a base existente.
                        </p>

                        <div className="flex flex-col sm:flex-row justify-end gap-3">
                            <button
                                onClick={() => {
                                    setFile(null);
                                    setModalCeimspaConfirm(false);
                                }}
                                className="px-6 py-3 rounded-xl bg-slate-200 text-slate-900 font-black"
                            >
                                Cancelar
                            </button>

                            <button
                                onClick={() => {
                                    setCeimspaOverwrite(false);
                                    setModalCeimspaConfirm(false);
                                }}
                                className="px-6 py-3 rounded-xl bg-blue-600 text-white font-black"
                            >
                                Adicionar suplemento
                            </button>

                            <button
                                onClick={() => {
                                    setCeimspaOverwrite(true);
                                    setModalCeimspaConfirm(false);
                                }}
                                className="px-6 py-3 rounded-xl bg-purple-700 text-white font-black"
                            >
                                Substituir base
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {modalTriagem && (
                <div className="fixed inset-0 bg-black/70 flex items-center justify-center p-4 z-50">
                    <div className="bg-white rounded-3xl p-8 w-full max-w-6xl shadow-2xl space-y-6 max-h-[90vh] overflow-auto">
                        <div>
                            <h3 className="text-xl font-black text-slate-900 uppercase">Triagem do Recibo</h3>
                            <p className="text-slate-900">Revise SNs e localização antes da confirmação final.</p>
                        </div>

                        <div className="overflow-auto border border-slate-200 rounded-2xl">
    <table className="min-w-full text-sm">
        <thead className="bg-slate-100 text-slate-800 uppercase text-xs">
            <tr>
                <th className="p-3 text-left">PN</th>
                <th className="p-3 text-left">Qtd</th>
                <th className="p-3 text-left">Preço Unitário £</th>
                <th className="p-3 text-left">Total £</th>
                <th className="p-3 text-left">SNs Finais</th>
                <th className="p-3 text-left">Localização PPU</th>
            </tr>
        </thead>
        <tbody className="text-slate-900">
            {dadosTriagem.map((item, index) => (
                <tr
                    key={`${item.pn}-${index}`}
                    className="border-t border-slate-200 text-slate-900"
                >
                    <td className="p-3 font-bold text-slate-900">{item.pn}</td>
                    <td className="p-3 text-slate-900">
                        {item.quantidade_recebida ?? item.quantidade ?? 0}
                    </td>
                    <td className="p-3 text-slate-900">
                        {formatarGBP(item.valor_unitario)}
                    </td>
                    <td className="p-3 text-slate-900">
                        {formatarGBP(item.valor_total)}
                    </td>
                    <td className="p-3">
                        <input
                            type="text"
                            value={item.sns_finais || ''}
                            onChange={(e) => atualizarSnDaTriagem(index, 'sns_finais', e.target.value)}
                            className="w-full p-2 border border-slate-300 rounded-lg text-slate-900 placeholder:text-slate-500"
                        />
                    </td>
                    <td className="p-3">
                        <input
                            type="text"
                            value={item.localizacao_ppu || ''}
                            onChange={(e) => atualizarSnDaTriagem(index, 'localizacao_ppu', e.target.value)}
                            className="w-full p-2 border border-slate-300 rounded-lg text-slate-900 placeholder:text-slate-500"
                        />
                    </td>
                </tr>
            ))}
        </tbody>
    </table>
</div>

                        <div className="flex justify-end gap-3">
                            <button
                                onClick={() => setModalTriagem(false)}
                                className="px-6 py-3 rounded-xl bg-slate-200 text-slate-900 font-black"
                            >
                                Cancelar
                            </button>

                            <button
                                onClick={handleConfirmarTriagem}
                                className="px-6 py-3 rounded-xl bg-blue-600 text-white font-black"
                            >
                                Confirmar Triagem
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {modalAdmin && (
                <div className="fixed inset-0 bg-black/70 flex items-center justify-center p-4 z-50">
                    <div className="bg-white rounded-3xl p-8 w-full max-w-4xl shadow-2xl space-y-6 max-h-[90vh] overflow-auto">
                        <div className="flex items-center justify-between">
                            <div>
                                <h3 className="text-xl font-black text-slate-900 uppercase">Manutenção Administrativa de Dados</h3>
                                <p className="text-slate-900">Selecione a base, pesquise por identificador e revise os dados antes de editar ou excluir.</p>
                            </div>

                            <button
                                onClick={() => setModalAdmin(false)}
                                className="px-4 py-2 rounded-xl bg-slate-200 text-slate-900 font-black"
                            >
                                Fechar
                            </button>
                        </div>

                        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                            <select
                                value={alvoAdmin}
                                onChange={(e) => {
                                    setAlvoAdmin(e.target.value);
                                    setDadosEdicao(null);
                                    setResultadosPpuAdmin([]);
                                    setResultadosAdminGenericos([]);
                                    setAdminMsg(null);
                                }}
                                className="w-full p-3 bg-white border-2 border-slate-200 rounded-xl font-bold text-slate-900"
                            >
                                <optgroup label="Fontes editáveis agora">
                                    <option value="ppu">PPU / Inventário</option>
                                </optgroup>
                                <optgroup label="Fontes consultáveis nesta versão">
                                    <option value="apelidos">Apelidos Operacionais</option>
                                </optgroup>
                                <optgroup label="Fontes com módulo próprio">
                                    <option value="compras_info">OC / PD / WO — editar na página Ordens de Compras</option>
                                </optgroup>
                                <optgroup label="Fontes mapeadas para próxima evolução">
                                    <option value="recibo">Recibos</option>
                                    <option value="order_book">Order Book</option>
                                    <option value="ceimspa">CeIMSPA</option>
                                    <option value="lisde">LISDE</option>
                                    <option value="price_list">Price List / RFQ</option>
                                    <option value="pim">PIM</option>
                                    <option value="os">OS</option>
                                    <option value="recex">RECEX</option>
                                    <option value="sb">Service Bulletin</option>
                                </optgroup>
                            </select>

                            <input
                                type="text"
                                value={idBuscaAdmin}
                                onChange={(e) => setIdBuscaAdmin(e.target.value)}
                                placeholder={
                                    alvoAdmin === 'ppu'
                                        ? 'Digite PN ou SN completo'
                                        : alvoAdmin === 'oc'
                                            ? 'OC, PD/SEPD, PN, status ou mensagem'
                                            : alvoAdmin === 'wo'
                                                ? 'WO, PN, SN, empresa, status ou documento'
                                                : alvoAdmin === 'apelidos'
                                                    ? 'Apelido, PN ou descrição'
                                                    : 'Digite o identificador completo'
                                }
                                className="w-full p-3 bg-white border-2 border-slate-200 rounded-xl font-bold text-slate-900 placeholder:text-slate-500"
                            />

                            <button
                                onClick={buscarParaManutencao}
                                disabled={adminCarregando || !idBuscaAdmin.trim()}
                                className="bg-slate-900 text-white px-6 py-3 rounded-xl font-black hover:bg-slate-800 disabled:opacity-50"
                            >
                                {adminCarregando ? 'BUSCANDO...' : 'BUSCAR'}
                            </button>
                        </div>

                        {alvoAdmin === 'ppu' && (
                            <p className="text-xs font-bold uppercase tracking-wide text-slate-700">
                                Busca EXATA: use o PN completo ou o SN completo. O painel não faz mais busca parcial por segurança.
                            </p>
                        )}

                        {['oc', 'wo', 'apelidos'].includes(alvoAdmin) && (
                            <div className="bg-blue-50 border border-blue-200 rounded-2xl p-4 text-sm text-blue-900 font-bold">
                                Esta fonte já está integrada à consulta administrativa. A edição operacional completa de OC/WO permanece no módulo Ordens de Compras para manter regras de CAN, suplementação, PD e WO no lugar correto.
                            </div>
                        )}

                        {resultadosAdminGenericos.length > 0 && (
                            <div className="space-y-4 border border-slate-200 rounded-2xl p-6">
                                <h4 className="text-lg font-black text-slate-900 uppercase">Resultado Administrativo</h4>
                                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                                    {resultadosAdminGenericos.map((registro, index) => (
                                        <div key={registro.id || `${alvoAdmin}-${index}`} className="border border-slate-200 rounded-2xl p-4 bg-slate-50">
                                            {alvoAdmin === 'oc' && (
                                                <>
                                                    <p className="text-xs font-black text-slate-500 uppercase">OC / Ordem de Compra</p>
                                                    <h5 className="text-lg font-black text-slate-900">{registro.numero_oc || 'N/A'}</h5>
                                                    <p className="text-sm text-slate-800"><b>Status:</b> {registro.status || 'N/A'} • <b>Fonte:</b> {registro.fonte || registro.source || 'SISHA'}</p>
                                                    <p className="text-sm text-slate-800"><b>PDs:</b> {(registro.compras_pds || []).length}</p>
                                                    <p className="text-xs text-slate-700 mt-2">Edição/cancelamento/suplementação: página Ordens de Compras.</p>
                                                </>
                                            )}
                                            {alvoAdmin === 'wo' && (
                                                <>
                                                    <p className="text-xs font-black text-slate-500 uppercase">WO / Reparo</p>
                                                    <h5 className="text-lg font-black text-slate-900">{registro.numero_wo || registro.documento_referencia || 'N/A'}</h5>
                                                    <p className="text-sm text-slate-800"><b>PN:</b> {registro.pn || 'N/A'} • <b>SN:</b> {registro.sn || 'N/A'}</p>
                                                    <p className="text-sm text-slate-800"><b>Status:</b> {registro.status || 'N/A'} • <b>Fonte:</b> {registro.fonte || registro.source || 'SISHA'}</p>
                                                    <p className="text-xs text-slate-700 mt-2">Edição/suplementação: página Ordens de Compras.</p>
                                                </>
                                            )}
                                            {alvoAdmin === 'apelidos' && (
                                                <>
                                                    <p className="text-xs font-black text-slate-500 uppercase">Apelido Operacional</p>
                                                    <h5 className="text-lg font-black text-slate-900">{registro.apelido || 'N/A'}</h5>
                                                    <p className="text-sm text-slate-800"><b>PN:</b> {registro.pn || 'N/A'}</p>
                                                    <p className="text-sm text-slate-800"><b>Descrição:</b> {registro.descricao_oficial || 'N/A'}</p>
                                                </>
                                            )}
                                        </div>
                                    ))}
                                </div>
                            </div>
                        )}

                        {alvoAdmin === 'ppu' && resultadosPpuAdmin.length > 1 && (
                            <div className="space-y-4 border border-slate-200 rounded-2xl p-6">
                                <h4 className="text-lg font-black text-slate-900 uppercase">Registros Encontrados</h4>

                                <div className="overflow-auto border border-slate-200 rounded-2xl">
                                    <table className="min-w-full text-sm">
                                        <thead className="bg-slate-100 text-slate-800 uppercase text-xs">
                                            <tr>
                                                <th className="p-3 text-left">ID</th>
                                                <th className="p-3 text-left">PN</th>
                                                <th className="p-3 text-left">SN</th>
                                                <th className="p-3 text-left">Localização</th>
                                                <th className="p-3 text-left">Quantidade</th>
                                                <th className="p-3 text-left">Ação</th>
                                            </tr>
                                        </thead>
                                        <tbody className="text-slate-900">
                                            {resultadosPpuAdmin.map((registro) => (
                                                <tr
                                                    key={registro.id}
                                                    className="border-t border-slate-200 text-slate-900"
                                                >
                                                    <td className="p-3 font-bold text-slate-900">{registro.id}</td>
                                                    <td className="p-3 font-bold text-slate-900">{registro.pn || 'N/A'}</td>
                                                    <td className="p-3 text-slate-900">{registro.sn || 'N/A'}</td>
                                                    <td className="p-3 text-slate-900">{registro.localizacao || 'N/A'}</td>
                                                    <td className="p-3 text-slate-900">{registro.quantidade ?? 0}</td>
                                                    <td className="p-3">
                                                        <button
                                                            onClick={() => setDadosEdicao(prepararRegistroPpuParaEdicao(registro))}
                                                            className="px-4 py-2 rounded-xl bg-blue-600 text-white font-black hover:bg-blue-700"
                                                        >
                                                            SELECIONAR
                                                        </button>
                                                    </td>
                                                </tr>
                                            ))}
                                        </tbody>
                                    </table>
                                </div>
                            </div>
                        )}

                        {dadosEdicao && (
                            <div className="space-y-4 border border-slate-200 rounded-2xl p-6">
                                <h4 className="text-lg font-black text-slate-900 uppercase">Editar Registro</h4>

                                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                                    <input
                                        type="text"
                                        value={dadosEdicao.id_referencia || ''}
                                        readOnly
                                        className="w-full p-3 bg-slate-100 border-2 border-slate-200 rounded-xl font-bold text-slate-900"
                                    />

                                    <input
                                        type="text"
                                        value={dadosEdicao.nomenclatura || ''}
                                        readOnly
                                        className="w-full p-3 bg-slate-100 border-2 border-slate-200 rounded-xl font-bold text-slate-900"
                                    />

                                    {alvoAdmin === 'ppu' ? (
                                        <>
                                            <input
                                                type="text"
                                                value={dadosEdicao.id || ''}
                                                readOnly
                                                className="w-full p-3 bg-slate-100 border-2 border-slate-200 rounded-xl font-bold text-slate-900"
                                            />

                                            <input
                                                type="text"
                                                value={dadosEdicao.sn || ''}
                                                readOnly
                                                className="w-full p-3 bg-slate-100 border-2 border-slate-200 rounded-xl font-bold text-slate-900"
                                            />

                                            <input
                                                type="number"
                                                value={dadosEdicao.quantidade || ''}
                                                onChange={(e) =>
                                                    setDadosEdicao(prev => ({ ...prev, quantidade: e.target.value }))
                                                }
                                                className="w-full p-3 bg-white border-2 border-slate-200 rounded-xl font-bold text-slate-900"
                                            />

                                            <input
                                                type="text"
                                                value={dadosEdicao.localizacao || ''}
                                                onChange={(e) =>
                                                    setDadosEdicao(prev => ({ ...prev, localizacao: e.target.value }))
                                                }
                                                className="w-full p-3 bg-white border-2 border-slate-200 rounded-xl font-bold text-slate-900 placeholder:text-slate-500"
                                            />
                                        </>
                                    ) : (
                                        <>
                                            <input
                                                type="text"
                                                value={dadosEdicao.valor_monetario || ''}
                                                onChange={(e) =>
                                                    setDadosEdicao(prev => ({ ...prev, valor_monetario: e.target.value }))
                                                }
                                                className="w-full p-3 bg-white border-2 border-slate-200 rounded-xl font-bold text-slate-900"
                                            />

                                            <input
                                                type="text"
                                                value={dadosEdicao.msg_referencia || ''}
                                                onChange={(e) =>
                                                    setDadosEdicao(prev => ({ ...prev, msg_referencia: e.target.value }))
                                                }
                                                className="w-full p-3 bg-white border-2 border-slate-200 rounded-xl font-bold text-slate-900"
                                            />

                                            <input
                                                type="text"
                                                value={dadosEdicao.sn || ''}
                                                onChange={(e) =>
                                                    setDadosEdicao(prev => ({ ...prev, sn: e.target.value }))
                                                }
                                                className="w-full p-3 bg-white border-2 border-slate-200 rounded-xl font-bold text-slate-900 md:col-span-2"
                                            />
                                        </>
                                    )}
                                </div>

                                <div className="flex justify-end gap-3">
                                    <button
                                        onClick={excluirManutencao}
                                        disabled={adminCarregando}
                                        className="px-6 py-3 rounded-xl bg-red-600 text-white font-black hover:bg-red-700 disabled:opacity-50"
                                    >
                                        EXCLUIR
                                    </button>

                                    <button
                                        onClick={salvarEdicaoManutencao}
                                        disabled={adminCarregando}
                                        className="px-6 py-3 rounded-xl bg-emerald-600 text-white font-black hover:bg-emerald-700 disabled:opacity-50"
                                    >
                                        SALVAR
                                    </button>
                                </div>
                            </div>
                        )}

                        {adminMsg && (
                            <p className={`font-bold ${adminMsg.tipo === 'success' ? 'text-green-600' : adminMsg.tipo === 'info' ? 'text-blue-600' : 'text-red-600'}`}>
                                {adminMsg.texto}
                            </p>
                        )}
                    </div>
                </div>
            )}
        </div>
    );
}