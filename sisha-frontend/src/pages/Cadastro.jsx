import React, { useState } from 'react';
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
    const { token } = useAuth();
    const [file, setFile] = useState(null);
    const [tipoArquivo, setTipoArquivo] = useState('order_book');
    const [uploadCarregando, setUploadCarregando] = useState(false);
    const [uploadMsg, setUploadMsg] = useState(null);
    const [modalCeimspaConfirm, setModalCeimspaConfirm] = useState(false);
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
    const [isAdmin, setIsAdmin] = useState('nao');
    const [membroCarregando, setMembroCarregando] = useState(false);
    const [membroMsg, setMembroMsg] = useState(null);

    const [modalAdmin, setModalAdmin] = useState(false);
    const [alvoAdmin, setAlvoAdmin] = useState('ppu');
    const [idBuscaAdmin, setIdBuscaAdmin] = useState('');
    const [dadosEdicao, setDadosEdicao] = useState(null);
    const [resultadosPpuAdmin, setResultadosPpuAdmin] = useState([]);
    const [adminMsg, setAdminMsg] = useState(null);
    const [adminCarregando, setAdminCarregando] = useState(false);

    const handleFileChange = (e) => {
        if (e.target.files[0]) {
            setFile(e.target.files[0]);
            if (e.target.files[0].name.toLowerCase().includes('ceimspa')) {
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
        if (!senha || !email) return;

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
                        role: isAdmin === 'sim' ? 'admin' : 'operador'
                    })
                },
                token
            );

            const result = await response.json();

            if (result.status === 'success') {
                setMembroMsg({ tipo: 'success', texto: result.message });
                setEmail('');
                setSenha('');
                setIsAdmin('nao');
            } else {
                setMembroMsg({ tipo: 'error', texto: result.message || 'Falha ao cadastrar militar.' });
            }
        } catch {
            setMembroMsg({ tipo: 'error', texto: 'Erro de ligação com o servidor.' });
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

        try {
            const termo = idBuscaAdmin.trim();
            const endpoint =
                alvoAdmin === 'ppu'
                    ? `/items/ppu/buscar/${encodeURIComponent(termo)}`
                    : `/manual/buscar/${encodeURIComponent(termo)}`;

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
            const endpoint =
                alvoAdmin === 'ppu'
                    ? `/items/ppu/id/${encodeURIComponent(dadosEdicao.id)}`
                    : `/manual/${encodeURIComponent(dadosEdicao.id_referencia)}`;

            const payload =
                alvoAdmin === 'ppu'
                    ? { quantidade: dadosEdicao.quantidade, localizacao: dadosEdicao.localizacao }
                    : {
                          valor_monetario: dadosEdicao.valor_monetario,
                          msg_referencia: dadosEdicao.msg_referencia,
                          sn: dadosEdicao.sn
                      };

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
            const endpoint =
                alvoAdmin === 'ppu'
                    ? `/items/ppu/id/${encodeURIComponent(dadosEdicao.id)}`
                    : `/manual/${encodeURIComponent(dadosEdicao.id_referencia)}`;

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
                </form>
            </section>

            <section className="bg-white rounded-3xl p-8 shadow-sm border border-slate-200">
                <h2 className="text-xl font-black text-slate-800 mb-4 uppercase">Ação Tática Local</h2>
                <form onSubmit={handleAcaoTatica} className="space-y-4">
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                        <select
                            value={tipoAcao}
                            onChange={(e) => setTipoAcao(e.target.value)}
                            className="w-full p-3 bg-white border-2 border-slate-200 rounded-xl font-bold text-slate-900"
                        >
                            <option value="OC_SUPLEMENTO">OC_SUPLEMENTO</option>
                            <option value="SN_VINCULO">SN_VINCULO</option>
                            <option value="MSG_REFERENCIA">MSG_REFERENCIA</option>
                        </select>

                        <input
                            type="text"
                            value={identificador}
                            onChange={(e) => setIdentificador(e.target.value)}
                            placeholder="Identificador"
                            className="w-full p-3 bg-white border-2 border-slate-200 rounded-xl font-bold text-slate-900 placeholder:text-slate-500"
                        />

                        <input
                            type="text"
                            value={valorManual}
                            onChange={(e) => setValorManual(e.target.value)}
                            placeholder="Valor"
                            className="w-full p-3 bg-white border-2 border-slate-200 rounded-xl font-bold text-slate-900 placeholder:text-slate-500"
                        />

                        <input
                            type="text"
                            value={msgRef}
                            onChange={(e) => setMsgRef(e.target.value)}
                            placeholder="Mensagem de Referência"
                            className="w-full p-3 bg-white border-2 border-slate-200 rounded-xl font-bold text-slate-900 placeholder:text-slate-500"
                        />

                        <input
                            type="text"
                            value={snManual}
                            onChange={(e) => setSnManual(e.target.value)}
                            placeholder="SN"
                            className="w-full p-3 bg-white border-2 border-slate-200 rounded-xl font-bold text-slate-900 placeholder:text-slate-500"
                        />
                    </div>

                    <div className="flex justify-end">
                        <button
                            type="submit"
                            disabled={manualCarregando || !identificador}
                            className="bg-emerald-600 text-white px-8 py-3 rounded-xl font-black hover:bg-emerald-700 disabled:opacity-50"
                        >
                            {manualCarregando ? 'REGISTRANDO...' : 'REGISTRAR AÇÃO'}
                        </button>
                    </div>

                    {manualMsg && (
                        <p className={`font-bold ${manualMsg.tipo === 'success' ? 'text-green-600' : 'text-red-600'}`}>
                            {manualMsg.texto}
                        </p>
                    )}
                </form>
            </section>

            <section className="bg-white rounded-3xl p-8 shadow-sm border border-slate-200">
                <h2 className="text-xl font-black text-slate-800 mb-1 flex items-center gap-2 uppercase">
                    Gestão de Tripulação
                </h2>
                <p className="text-sm text-slate-700 mb-6">Cadastre email, senha e privilégio do militar autorizado.</p>

                <form onSubmit={handleCadastroMembro} className="space-y-4">
                    <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                        <input
                            type="email"
                            value={email}
                            onChange={(e) => setEmail(e.target.value)}
                            placeholder="Email Militar"
                            className="w-full p-3 bg-white border-2 border-slate-200 rounded-xl font-bold text-slate-900 placeholder:text-slate-500"
                        />

                        <input
                            type="password"
                            value={senha}
                            onChange={(e) => setSenha(e.target.value)}
                            placeholder="Senha"
                            className="w-full p-3 bg-white border-2 border-slate-200 rounded-xl font-bold text-slate-900 placeholder:text-slate-500"
                        />

                        <select
                            value={isAdmin}
                            onChange={(e) => setIsAdmin(e.target.value)}
                            className="w-full p-3 bg-white border-2 border-slate-200 rounded-xl font-bold text-slate-900"
                        >
                            <option value="nao">Operador</option>
                            <option value="sim">Admin</option>
                        </select>
                    </div>

                    <div className="flex justify-end">
                        <button
                            type="submit"
                            disabled={membroCarregando || !senha || !email}
                            className="bg-indigo-600 text-white px-8 py-3 rounded-xl font-black hover:bg-indigo-700 disabled:opacity-50"
                        >
                            CADASTRAR MILITAR
                        </button>
                    </div>

                    {membroMsg && (
                        <p className={`font-bold ${membroMsg.tipo === 'success' ? 'text-green-600' : 'text-red-600'}`}>
                            {membroMsg.texto}
                        </p>
                    )}
                </form>
            </section>

            <section className="bg-white rounded-3xl p-8 shadow-sm border border-slate-200">
                <div className="flex items-center justify-between mb-4">
                    <div>
                        <h2 className="text-xl font-black text-slate-800 uppercase">Painel de Manutenção</h2>
                        <p className="text-sm text-slate-700">Busca, edição e exclusão administrativa.</p>
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
                            Foi detectado um arquivo possivelmente do CeIMSPA. Confirma a continuidade?
                        </p>

                        <div className="flex justify-end gap-3">
                            <button
                                onClick={() => setModalCeimspaConfirm(false)}
                                className="px-6 py-3 rounded-xl bg-slate-200 text-slate-900 font-black"
                            >
                                Cancelar
                            </button>

                            <button
                                onClick={() => setModalCeimspaConfirm(false)}
                                className="px-6 py-3 rounded-xl bg-blue-600 text-white font-black"
                            >
                                Confirmar
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
                                <h3 className="text-xl font-black text-slate-900 uppercase">Painel de Manutenção</h3>
                                <p className="text-slate-900">Edição administrativa dos registros.</p>
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
                                onChange={(e) => setAlvoAdmin(e.target.value)}
                                className="w-full p-3 bg-white border-2 border-slate-200 rounded-xl font-bold text-slate-900"
                            >
                                <option value="ppu">PPU</option>
                                <option value="acao_tatica">Ação Tática</option>
                            </select>

                            <input
                                type="text"
                                value={idBuscaAdmin}
                                onChange={(e) => setIdBuscaAdmin(e.target.value)}
                                placeholder={
                                    alvoAdmin === 'ppu'
                                        ? 'Digite PN ou SN completo'
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
                            <p className={`font-bold ${adminMsg.tipo === 'success' ? 'text-green-600' : 'text-red-600'}`}>
                                {adminMsg.texto}
                            </p>
                        )}
                    </div>
                </div>
            )}
        </div>
    );
}