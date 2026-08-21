import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { AlertTriangle, MapPin, Save, Search, X } from 'lucide-react';
import RfqImporter from '../components/RfqImporter';
import NeedsFoundationPanel from '../components/NeedsFoundationPanel';
import PnAlternativosAdmin from '../components/PnAlternativosAdmin';
import ManualTecnicoImportModal from '../components/ManualTecnicoImportModal';
import ManuaisTecnicosAdmin from '../components/ManuaisTecnicosAdmin';
import DataAdminManager from '../components/DataAdminManager';
import AircraftOperationalStateAdmin from '../components/AircraftOperationalStateAdmin';
import PendingCenterModal from '../components/PendingCenterModal';
import Recebimentos from './Recebimentos';
import { useAuth } from '../context/AuthContext';
import { apiFetch, buildAuthHeaders } from '../lib/api';


const orientacoesUploadPorTipo = {
    order_book: {
        titulo: 'Order Book Leonardo',
        obrigatorias: ['Arquivo original da Leonardo com abas reconhecíveis'],
        recomendadas: ['Spares', 'FOC Spares', 'Repairs', 'Warranty Repairs', "RFQ's", 'TQS', 'ER'],
        comportamento: 'Atualiza as bases Leonardo/Order Book e substitui o snapshot anterior. Para equipamentos com PN+SN, as evidências de ER, Repair, Warranty, Progs e entregas são preservadas no Livro de Eventos antes da substituição.',
        observacao: 'Mantenha os nomes das abas e cabeçalhos originais sempre que possível. Spares/FOC/RFQ continuam fontes logísticas; Repairs, Warranty Repairs, ER e Progs alimentam rastreabilidade quando houver PN+SN; Delivered/Deliveries corroboram datas de entrega. TQS sem PN+SN permanece evidência técnica e não recebe vínculo serial automático.',
    },
    price_list: {
        titulo: 'Price List Oficial',
        obrigatorias: ['PN / P/N / PART NUMBER / PART NO', 'PRICE / UNIT VALUE / VALOR UNITARIO'],
        recomendadas: ['NOMENCLATURA / DESCRIPTION / DESCRIÇÃO', 'NSN / NATO STOCK NUMBER', 'LEAD TIME', 'MOQ', 'START DATE', 'END DATE'],
        comportamento: 'Substitui a Price List atual pela nova base carregada.',
        observacao: 'Use a planilha oficial. Valores em GBP devem permanecer na coluna de preço/unit value original para evitar distorção na valorização.',
    },
    inventario_ppu: {
        titulo: 'InventarioPPUGeralLoc — Inventário Geral PPU por Localização',
        obrigatorias: ['Arquivo oficial InventarioPPUGeralLoc (.xls) extraído diretamente do sistema da Marinha'],
        recomendadas: ['EQUIPAMENTOS: NOMENCLATURA, PN, SN, PI, QNTD', 'SOBRESSALENTES: NOMENCLATURA, PN, PI, QNTD', 'Linhas LOCALIZAÇÃO : ... preservadas como posição física'],
        comportamento: 'Fonte oficial única do inventário PPU: substitui a fotografia atual do PPU, separa Equipamentos de Sobressalentes, herda a LOCALIZAÇÃO de cada bloco e sincroniza os Equipamentos identificados por PN + SN com o Livro de Equipamentos.',
        observacao: 'Envie o InventarioPPUGeralLoc sem filtro nem alteração manual. QNTD é a quantidade de estoque; DOTAÇÃO não é saldo. Equipamentos com SN são preservados individualmente e sobressalentes permanecem por quantidade. O importador genérico PN + SN continua disponível somente na página Equipamentos para uso excepcional.',
    },
    custodia_externa_ppu: {
        titulo: 'Backend_Auditoria_Paiol — Caixas CEIMSPA sob custódia PPU',
        obrigatorias: ['Abas FECHADA CX-001 ... FECHADA CX-XXX', 'Data/Hora', 'PN', 'NSN', 'Nomenclatura', 'Qtd', 'SN', 'Localizacao', 'Auditor_Nome', 'Auditor_NIP'],
        recomendadas: ['Envie o arquivo completo produzido pelo APP, sem juntar as abas manualmente', 'Mantenha a LOC original na coluna Localizacao'],
        comportamento: 'Cria um snapshot idempotente da custódia externa. O material continua contabilizado no PPU, mas a localização exibida passa a ser CX-XXX — CEIMSPA. O InventarioPPUGeralLoc permanece intacto e continua sendo a fotografia oficial.',
        observacao: 'O SISHA reconcilia PN + localização original. Quantidade que exceder a evidência do inventário fica bloqueada até decisão Admin/Dono. Quando o inventário oficial já trouxer a própria caixa, a movimentação é tratada como absorvida e não é aplicada duas vezes.',
    },
    controle_equipamentos_criticos: {
        titulo: 'Controle de Equipamentos Criticos da Aeronave',
        obrigatorias: ['Arquivo ODS/XLSX original com PART NUMBER, SERIAL NUMBER, SITUAÇÃO e LOCAL nas tabelas detalhadas'],
        recomendadas: ['Use o arquivo bruto sem filtrar nem reorganizar as abas'],
        comportamento: 'Registra PN+SN e a evidência especializada de situação/localização no Livro de Equipamentos. Se divergir de outra localização vigente, abre reconciliação Admin/Dono em vez de sobrescrever.',
        observacao: 'O quadro resumido por aeronave é apenas apoio; o SISHA usa as tabelas detalhadas PN+SN. Sem data operacional inequívoca, Controle Crítico não ganha prioridade cega sobre o Inventário Geral.',
    },
    saida_movimentacao_ppu: {
        titulo: 'SaidaMovimentacaoPorPeriodo',
        obrigatorias: ['NUMERO PEDIDO', 'DATA PEDIDO', 'PART NUMER', 'SERIAL NUMER', 'NUMERO OS'],
        recomendadas: ['DATA PRONTO', 'RECEBEDOR'],
        comportamento: 'Importa o relatório bruto como histórico PN+SN no Livro de Eventos, preservando PIM/OS/data/recebedor.',
        observacao: 'É evidência histórica: não inventa destino físico e não substitui a localização atual do equipamento.',
    },
    master_os: {
        titulo: 'MASTER OS — Histórico e Orquestração de Ordens de Serviço',
        obrigatorias: ['Arquivo Master OS original (.xlsx)', 'Abas operacionais com NÚMERO, SAÍDA e DISCREPÂNCIA'],
        recomendadas: ['SIT', 'DESTINO', 'ENTRADA', 'RESPONSAVEL', 'INSPEÇÃO', 'PANE', 'HORA/A', 'HORA/F', 'HORAS/T'],
        comportamento: 'Importa cada OS/ano como evidência histórica append-only e cruza OS fechadas com o Livro de Equipamentos. OS aberta registra intenção sem mover; OS cancelada preserva o cancelamento sem mover; OS fechada pode confirmar instalação/remoção quando ação, PN+SN e destino forem inequívocos.',
        observacao: 'BD_MASTER, CORRETIVAS e PREVENTIVAS são visões derivadas e não são importadas. Movimentação ambígua, identidade incompleta ou destino duvidoso falha fechado. Uma evidência antiga nunca substitui uma localização física mais recente já comprovada por PPU/PIM/STC/WO/Recibo.',
    },
    controle_inspecao: {
        titulo: 'CONTROLE INSPEÇÃO',
        obrigatorias: ['Abas de aeronave 4001/4003/4004/4005/4010/4012'],
        recomendadas: ['Horas da aeronave', 'Motores', 'Inspeções horárias/calendáricas', 'TBO', 'HOIST/CARGO HOOK quando presentes'],
        comportamento: 'Usa o ledger A1.1 de snapshots/indicadores técnicos, preservando horas, datas, ciclos, TBO e erros de fórmula como evidência.',
        observacao: 'Não substitui confirmação administrativa da situação da frota e não converte #N/A/#REF! em zero.',
    },
    livro_motores: {
        titulo: 'LIVRO DOS MOTORES',
        obrigatorias: ['Arquivo original LIVRO DOS MOTORES.xlsx com abas por aeronave'],
        recomendadas: ['AIRCRAFT TOTAL HOURS', 'Landings', 'Rotor Stop Start', 'No.1 Engine', 'No.2 Engine', 'Starts', 'Power Turbine', 'Gas Generator'],
        comportamento: 'Importa histórico de utilização por aeronave: horas, pousos, rotor stop/start e horas/starts/ciclos dos motores. Não altera TBO nem PN/SN por inferência.',
        observacao: 'A1.2: os valores servem como evidência histórica para planejamento e futura confiabilidade. Um indicador TBO só vira necessidade programada depois de vínculo Admin/Dono com PN ou PN+SN.',
    },
    inventario_equipamentos: {
        titulo: 'Inventário de Equipamentos Serializados',
        obrigatorias: ['PN / P/N / PART NUMBER / PART NO', 'SN / S/N / SERIAL NUMBER', 'LOCAL / LOC / LOCALIZACAO / LOCALIZAÇÃO / LOCATION'],
        recomendadas: ['NOMENCLATURA / DESCRIPTION / DESCRIÇÃO', 'CATEGORIA / TIPO LOCAL', 'GARANTIA / VENCIMENTO GARANTIA', 'OBSERVACAO / OBS / COMMENTS'],
        comportamento: 'Lê o inventário e abre a conferência na página Equipamentos. Cada linha identifica uma unidade por PN + SN; não soma quantidade ao PPU.',
        observacao: 'Use uma linha por equipamento. Exemplo: se o PPU possui 5 unidades e este arquivo identifica 5 SN no mesmo PN/local, o total permanece 5 e os cinco SN passam a explicar essas cinco unidades.',
    },
    ceimspa: {
        titulo: 'Estoque CeIMSPA',
        obrigatorias: ['PI / NSN / NSN-PI'],
        recomendadas: ['PN / P/N / PART NUMBER / PART NO', 'NOMENCLATURA / DESCRIPTION / DESCRIÇÃO', 'QTD / QTY / QTDE / QTE / QUANTIDADE', 'SJ', 'UF'],
        comportamento: 'Pode funcionar como suplemento ou substituição total, conforme o modo selecionado abaixo.',
        observacao: 'O CeIMSPA indica possibilidade de disponibilidade. Quando não houver PN confirmado, o sistema deve tratar como item com PN não confirmado e exigir conferência com o CeIMSPA.',
    },
    historico_movimentacao: {
        titulo: 'Histórico de Movimentação',
        obrigatorias: ['PN / P/N / PART NUMBER', 'DATA / DATE / DATA MOVIMENTACAO / DATA SAIDA', 'QTD / QTY / QTDE / QUANTIDADE', 'OS / ORDEM DE SERVICO'],
        recomendadas: ['NOMENCLATURA / DESCRIPTION / DESCRIÇÃO', 'ANV / AERONAVE / AIRCRAFT', 'OBSERVACAO / COMMENTS'],
        comportamento: 'Importa movimentações e ignora duplicidades iguais do mesmo PN/Data/QTD/OS.',
        observacao: 'Use para alimentar consumo histórico, consulta por PN e futuras análises de MTBF/MTTR.',
    },
    disponibilidade_anv: {
        titulo: 'Mapa de Disponibilidade / Inspeções da Frota',
        obrigatorias: ['Abas por aeronave com código de 4 dígitos', 'Situação D/I no cabeçalho', 'Horas da ANV'],
        recomendadas: ['Data da atualização', 'Motivo da indisponibilidade', 'Última FRV', 'Motores/SN', 'Horas/ciclos restantes', 'Vencimentos calendáricos e TBO'],
        comportamento: 'Preserva um snapshot histórico por aeronave e seus indicadores técnicos. A situação I passa a servir como evidência para a regra aditiva das demandas MT no Gerador.',
        observacao: 'Erros de fórmula como #N/A/#VALOR! não viram zero: permanecem como evidência não utilizável. Reimportar o mesmo arquivo não duplica o snapshot.',
    },
    lisde: {
        titulo: 'LISDE',
        obrigatorias: ['PN', 'QTD'],
        recomendadas: ['Nomenclatura/Description'],
        comportamento: 'Substitui a base LISDE atual pela lista carregada.',
        observacao: 'A LISDE não é estoque. Ela serve como referência de item autorizado/disponível em lista oficial.',
    },
    manual_legado: {
        titulo: 'Manual / Dicionário Mestre (CIETP)',
        obrigatorias: ['DMC', 'PN / P/N / PART NUMBER / PART NO'],
        recomendadas: ['ITEM / ITEM NUM', 'SUB ITEM / SUBITEM', 'NSN / PI', 'NOMENCLATURA / DESCRIPTION / DESCRIÇÃO', 'TECHNAME / APPLICATION / APLICAÇÃO'],
        comportamento: 'Substitui a base atual do Manual/Dicionário Mestre.',
        observacao: 'Use somente arquivo completo e atualizado. O sistema calcula PI a partir do NSN quando possível.',
    },
    manual_tecnico: {
        titulo: 'WTP / Manual Técnico de Manutenção',
        obrigatorias: ['PDF original do WTP/CMM/Manual Técnico'],
        recomendadas: ['Código do manual no arquivo/nome', 'Detailed Parts List / IPL', 'Fault Isolation', 'Special Tools / Consumables', 'Revisão e ATA/DMC'],
        comportamento: 'Lê PDF digital ou digitalizado/Xerox, abre triagem humana e só depois armazena o original no R2 privado e indexa PN, FIG, ITEM, Description, fault isolation, ferramentas e consumíveis. Não cria estoque.',
        observacao: 'O CIETP/Dicionário Mestre permanece separado. Uma nova revisão da mesma WTP não apaga a anterior: o PDF antigo permanece no R2 e a revisão anterior fica SUPERADA para histórico.',
    },
    pn_alternativos: {
        titulo: 'PN Alternativos',
        obrigatorias: ['PN / P/N / PART NUMBER', 'PN_ALT / PN ALT / PN ALTERNATIVO / ALTERNATE PN'],
        recomendadas: ['PI / NSN', 'FONTE / SOURCE / DOCUMENTO'],
        comportamento: 'Atualiza a biblioteca documental sem apagar relações manuais ou relações originadas em RFQ.',
        observacao: 'Não use PN igual ao PN_Alt. CIETP continua usando DMC + ITEM; relações manuais/RFQ são preservadas quando a biblioteca documental é reimportada.',
    },
    qnna: {
        titulo: 'QNNA / Quadro de Necessidades',
        obrigatorias: ['PN / P/N / PART NUMBER', 'QTD / QTY / QTDE / QUANTIDADE'],
        recomendadas: ['NSN / PI', 'NOMENCLATURA / DESCRIPTION', 'JUSTIFICATIVA', 'STATUS', 'DEMANDA / REFERENCIA'],
        comportamento: 'Atualiza os registros do QNNA conforme a referência do arquivo carregado.',
        observacao: 'Use para registrar necessidades planejadas sem confundir com estoque real ou compra já aprovada.',
    },
    sb: {
        titulo: 'Service Bulletin',
        obrigatorias: ['PDF original da SB ou planilha com PN'],
        recomendadas: ['PN / P/N / PART NUMBER', 'NSN / PI', 'NOMENCLATURA / DESCRIPTION', 'QTD / QTY / QUANTIDADE', 'CAPITULO / DMC', 'ITEM', 'APLICABILIDADE'],
        comportamento: 'Cadastra a SB e seus itens vinculados, preservando número, tipo, título e observações quando extraídos.',
        observacao: 'Para PDF, o sistema tenta extrair automaticamente o número da SB, tipo, título e peças citadas.',
    },
    receitas: {
        titulo: 'Receitas / Inspeções',
        obrigatorias: ['PN', 'QTD'],
        recomendadas: ['Receita/Inspeção', 'Nomenclatura', 'PN_Alt', 'Qtd por ciclo', 'Tarefa/Observação'],
        comportamento: 'Use para vincular itens às receitas/inspeções e enriquecer a consulta em lote/exportação.',
        observacao: 'Se o upload retornar formato não reconhecido, o importador desta base ainda precisa ser ativado no backend atual.',
    },
    pim: {
        titulo: 'PIM Pendentes — snapshot atual',
        obrigatorias: ['PIM', 'PN', 'QTD', 'OS'],
        recomendadas: ['Data', 'NSN/PI', 'Nomenclatura', 'Observação'],
        comportamento: 'O novo arquivo passa a ser o snapshot PIM atual do Gerador. O snapshot de arquivo anterior é preservado como histórico e deixa de participar do cálculo; registros manuais não são apagados.',
        observacao: 'A OS define a origem. São reconhecidas aeronaves e oficinas, inclusive MTVN, MTMV, MTSV, MTHV, MTAP, MTPA e MTAR. Linhas incompletas falham fechadas e ficam registradas na auditoria.',
    },
    politica_estoque_tarefas: {
        titulo: 'Política de Estoque',
        obrigatorias: ['PN', 'parâmetro de política ou tarefa vinculada'],
        recomendadas: ['Nomenclatura', 'Qtd mínima', 'Qtd máxima', 'Ponto de reposição', 'Tarefa/Inspeção', 'Periodicidade'],
        comportamento: 'Use para alimentar parâmetros de ressuprimento e comparação com estoque/necessidades.',
        observacao: 'A política deve apoiar decisão logística; não deve substituir consumo real, receitas e histórico de movimentação.',
    },
};

const formatUploadDate = (value) => {
    if (!value) return 'Data não registrada';
    const dt = new Date(value);
    if (Number.isNaN(dt.getTime())) return String(value);
    return dt.toLocaleString('pt-BR');
};

const importStatusLabel = (status) => {
    const value = String(status || '').toUpperCase();
    if (value === 'SUCESSO' || value === 'CONCLUIDO') return 'Concluído';
    if (value === 'SUCESSO_COM_ALERTAS' || value === 'CONCLUIDO_COM_PENDENCIAS') return 'Concluído com alertas';
    if (value === 'PROCESSANDO') return 'Processando';
    if (value === 'ERRO') return 'Falhou';
    return status || 'Sem status';
};

export default function Cadastro() {
    const navigate = useNavigate();
    const { token, user } = useAuth();
    const isDono = Boolean(user?.isDono) || user?.role === 'dono' || Boolean(user?.isGod);
    const isAdmin = user?.role === 'admin';
    const podeGerenciarUsuarios = isDono || isAdmin;
    const [areaAtiva, setAreaAtiva] = useState('atualizar');
    const [recibosImportOpen, setRecibosImportOpen] = useState(false);

    const areasSistema = [
        { key: 'atualizar', label: 'Atualizar dados', descricao: 'Envie novas versões de documentos e bases do SISHA.' },
        { key: 'administrar', label: 'Administrar dados', descricao: 'Revise e corrija bases operacionais com controle administrativo.' },
        { key: 'usuarios', label: 'Usuários e acessos', descricao: 'Gerencie permissões, credenciais e situação dos usuários.' },
        { key: 'necessidades', label: 'Receitas / PIM / Política', descricao: 'Mantenha cadastros de apoio à necessidade e ao ressuprimento.' },
        { key: 'cotacoes', label: 'Cotações e RFQ', descricao: 'Importe, revise e mantenha cotações comerciais.' },
        { key: 'atualizacoes', label: 'Atualizações', descricao: 'Veja quais documentos foram enviados ao SISHA e quando ocorreu a última atualização registrada.' },
    ];
    const [file, setFile] = useState(null);
    const [tipoArquivo, setTipoArquivo] = useState('order_book');
    const [uploadCarregando, setUploadCarregando] = useState(false);
    const [uploadMsg, setUploadMsg] = useState(null);
    const [importLogs, setImportLogs] = useState([]);
    const [importLogsCarregando, setImportLogsCarregando] = useState(false);
    const [importLogsMsg, setImportLogsMsg] = useState(null);
    const [modalCeimspaConfirm, setModalCeimspaConfirm] = useState(false);
    const [ceimspaOverwrite, setCeimspaOverwrite] = useState(false);
    const [modalLocalizacoes, setModalLocalizacoes] = useState(false);
    const [modalPendencias, setModalPendencias] = useState(false);
    const [localizacoesPpu, setLocalizacoesPpu] = useState([]);
    const [localizacoesBusca, setLocalizacoesBusca] = useState('');
    const [localizacoesCarregando, setLocalizacoesCarregando] = useState(false);
    const [localizacoesMsg, setLocalizacoesMsg] = useState(null);
    const [modalCustodiaExterna, setModalCustodiaExterna] = useState(false);
    const [custodiaExterna, setCustodiaExterna] = useState({ active: null, rows: [], summary: {} });
    const [custodiaCarregando, setCustodiaCarregando] = useState(false);
    const [custodiaMsg, setCustodiaMsg] = useState(null);

    const [email, setEmail] = useState('');
    const [roleCadastro, setRoleCadastro] = useState('operador');
    const [membroCarregando, setMembroCarregando] = useState(false);
    const [membroMsg, setMembroMsg] = useState(null);

    const [usuariosAutorizados, setUsuariosAutorizados] = useState([]);
    const [usuariosCarregando, setUsuariosCarregando] = useState(false);
    const [editandoUsuarioId, setEditandoUsuarioId] = useState(null);
    const [usuarioEdit, setUsuarioEdit] = useState({ email: '', role: 'operador', active: true });

    const [modalAdmin, setModalAdmin] = useState(false);
    const [alvoAdmin, setAlvoAdmin] = useState('ppu');
    const [idBuscaAdmin, setIdBuscaAdmin] = useState('');
    const [dadosEdicao, setDadosEdicao] = useState(null);
    const [resultadosPpuAdmin, setResultadosPpuAdmin] = useState([]);
    const [adminMsg, setAdminMsg] = useState(null);
    const [adminCarregando, setAdminCarregando] = useState(false);
    const [resultadosAdminGenericos, setResultadosAdminGenericos] = useState([]);
    const [manualPreview, setManualPreview] = useState(null);
    const [manualPreviewFile, setManualPreviewFile] = useState(null);

    const orientacaoUpload = orientacoesUploadPorTipo[tipoArquivo];

    const handleFileChange = (e) => {
        if (e.target.files[0]) {
            setFile(e.target.files[0]);
            if (e.target.files[0].name.toLowerCase().includes('ceimspa')) {
                setTipoArquivo('ceimspa');
                setModalCeimspaConfirm(true);
            }
        }
    };

    const carregarAtualizacoes = async (silencioso = false) => {
        if (!token) return;
        if (!silencioso) setImportLogsCarregando(true);
        setImportLogsMsg(null);
        try {
            const response = await apiFetch('/import/logs?limit=300', {}, token);
            const result = await response.json();
            if (!response.ok || result.status !== 'success') throw new Error(result.message || 'Falha ao consultar atualizações.');
            setImportLogs((result.data || []).filter((item) => item?.nome_arquivo));
        } catch (error) {
            setImportLogsMsg(error?.message || 'Falha ao consultar o histórico de atualizações.');
        } finally {
            if (!silencioso) setImportLogsCarregando(false);
        }
    };

    const ultimoUploadTipo = importLogs.find((item) => String(item.tipo_arquivo || '') === String(tipoArquivo || '')) || null;

    const atualizacoesPorTipo = Array.from(importLogs.reduce((map, item) => {
        const key = String(item.tipo_arquivo || 'outros');
        if (!map.has(key)) map.set(key, item);
        return map;
    }, new Map()).values());

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
            if (tipoArquivo === 'manual_tecnico') {
                const response = await apiFetch('/manuals/preview', {
                    method: 'POST',
                    headers: buildAuthHeaders(token),
                    body: formData,
                }, token);
                const data = await response.json();
                if (!response.ok || data.status !== 'success') {
                    throw new Error(data.message || 'Falha ao ler o WTP/Manual Técnico.');
                }
                setManualPreview(data.data || null);
                setManualPreviewFile(file);
                setUploadMsg({ tipo: data.data?.duplicate ? 'error' : 'success', texto: data.message });
                return;
            }

            if (tipoArquivo === 'inventario_equipamentos') {
                const response = await apiFetch('/equipments/inventory/preview', {
                    method: 'POST',
                    headers: buildAuthHeaders(token),
                    body: formData,
                }, token);
                const data = await response.json();
                if (!response.ok || data.status !== 'success') {
                    throw new Error(data.message || 'Falha ao ler o inventário de equipamentos.');
                }
                window.sessionStorage.setItem('sisha_equipment_inventory_draft', JSON.stringify(data.data));
                setUploadMsg({ tipo: 'success', texto: 'Inventário de equipamentos lido. Abrindo a conferência PN + SN.' });
                navigate('/equipamentos');
                return;
            }

            const uploadEndpoint = tipoArquivo === 'pim' ? '/needs/pims/import' : '/import/upload';
            const response = await apiFetch(
                uploadEndpoint,
                { method: 'POST', headers: buildAuthHeaders(token), body: formData },
                token
            );
            const data = await response.json();

            if (data.status === 'success') {
                if (data.data_triagem) {
                    const itensFormatados = data.data_triagem.map((item, index) => ({
                        ...item,
                        sequencia_item: item.sequencia_item || index + 1,
                        quantidade: Number(item.quantidade_recebida ?? item.quantidade ?? 0),
                        sn: item.sn || (item.sns_pre_carregados || []).join(', '),
                        localizacao_ppu: item.localizacao_ppu || '',
                        condicao_item: item.condicao_item || 'RECEBIDO_DISPONIVEL',
                        observacao_item: item.observacao_item || '',
                        inventariado_ppu: Boolean(item.inventariado_ppu),
                    }));

                    window.sessionStorage.setItem('sisha_receipt_draft', JSON.stringify({
                        numero_recibo: data.recibo_ref || '',
                        tipo_recebimento: data.tipo_recebimento || (data.is_foc ? 'MATERIAL_FOC' : 'MATERIAL'),
                        data_recebimento: data.data_entrega_ref || '',
                        documento_referencia: data.documento_referencia || '',
                        fornecedor: '',
                        origem_material: '',
                        recebido_por_nome: '',
                        conferido_por_nome: '',
                        metodo_importacao: data.metodo_importacao || 'DOCUMENTO',
                        arquivo_nome: data.arquivo_nome || file?.name || '',
                        arquivo_hash: data.arquivo_hash || '',
                        is_foc: Boolean(data.is_foc),
                        observacao: 'Documento lido em Atualizar Sistema. Revisão humana obrigatória.',
                        itens: itensFormatados,
                    }));
                    setUploadMsg({ tipo: 'success', texto: 'Recibo lido. Abrindo a tabela completa de triagem.' });
                    navigate('/recebimentos');
                } else {
                    setUploadMsg({ tipo: 'success', texto: data.message });
                    if (tipoArquivo === 'custodia_externa_ppu') carregarCustodiaExterna(false);
                    carregarAtualizacoes(true);
                }
            } else {
                setUploadMsg({ tipo: 'error', texto: data.message });
            }
        } catch (error) {
            setUploadMsg({ tipo: 'error', texto: error?.message || 'Falha de comunicação com o Servidor.' });
        } finally {
            setUploadCarregando(false);
            setFile(null);
        }
    };

    const carregarCustodiaExterna = async (abrir = true) => {
        setCustodiaCarregando(true);
        setCustodiaMsg(null);
        try {
            const response = await apiFetch('/import/custodia-externa-ppu/reconciliacao', {}, token);
            const result = await response.json();
            if (!response.ok || result.status !== 'success') throw new Error(result.message || 'Falha ao carregar reconciliação.');
            setCustodiaExterna(result.data || { active: null, rows: [], summary: {} });
            if (abrir) setModalCustodiaExterna(true);
        } catch (error) {
            setCustodiaMsg({ tipo: 'error', texto: error.message || 'Falha ao carregar reconciliação.' });
            if (abrir) setModalCustodiaExterna(true);
        } finally {
            setCustodiaCarregando(false);
        }
    };

    const decidirCustodiaExterna = async (row, decision) => {
        const rotulo = decision === 'CONFIRMAR_CUSTODIA' ? 'confirmar a quantidade física da caixa' : 'ignorar esta movimentação transitória';
        const reason = window.prompt(`Informe o motivo para ${rotulo}. A decisão ficará auditada.`);
        if (!reason || !reason.trim()) return;
        setCustodiaCarregando(true);
        setCustodiaMsg(null);
        try {
            const response = await apiFetch('/import/custodia-externa-ppu/reconciliacao', {
                method: 'POST',
                headers: buildAuthHeaders(token, { 'Content-Type': 'application/json' }),
                body: JSON.stringify({ import_id: custodiaExterna.active?.id, group_key: row.group_key, decision, reason: reason.trim() }),
            }, token);
            const result = await response.json();
            if (!response.ok || result.status !== 'success') throw new Error(result.message || 'Falha ao registrar decisão.');
            setCustodiaExterna(result.data || { active: null, rows: [], summary: {} });
            setCustodiaMsg({ tipo: 'success', texto: result.message || 'Decisão registrada.' });
        } catch (error) {
            setCustodiaMsg({ tipo: 'error', texto: error.message || 'Falha ao registrar decisão.' });
        } finally {
            setCustodiaCarregando(false);
        }
    };

    const carregarLocalizacoesPpu = async () => {
        setLocalizacoesCarregando(true);
        setLocalizacoesMsg(null);
        try {
            const response = await apiFetch('/locations', {}, token);
            const result = await response.json();
            if (result.status !== 'success') throw new Error(result.message || 'Falha ao carregar localizações.');
            setLocalizacoesPpu(result.data || []);
        } catch (error) {
            setLocalizacoesMsg({ tipo: 'error', texto: error.message || 'Falha ao carregar localizações.' });
        } finally {
            setLocalizacoesCarregando(false);
        }
    };

    const abrirModalLocalizacoes = async () => {
        setModalLocalizacoes(true);
        setLocalizacoesBusca('');
        await carregarLocalizacoesPpu();
    };

    const alternarLocalizacaoPpu = (localizacaoNormalizada, checked) => {
        setLocalizacoesPpu((rows) => rows.map((row) => {
            if (row.localizacao_normalizada !== localizacaoNormalizada) return row;
            if (checked) {
                return { ...row, contabiliza_ppu: true, destino_contabilizacao: 'PPU', situacao_operacional: 'DISPONIVEL' };
            }
            return {
                ...row,
                contabiliza_ppu: false,
                destino_contabilizacao: row.destino_contabilizacao && row.destino_contabilizacao !== 'PPU' ? row.destino_contabilizacao : 'FORA_LINHA',
                situacao_operacional: row.situacao_operacional && row.situacao_operacional !== 'DISPONIVEL' ? row.situacao_operacional : 'A_CONFIRMAR',
            };
        }));
    };

    const atualizarClassificacaoLocalizacao = (localizacaoNormalizada, field, value) => {
        setLocalizacoesPpu((rows) => rows.map((row) => row.localizacao_normalizada === localizacaoNormalizada
            ? { ...row, [field]: value }
            : row));
    };

    const salvarLocalizacoesPpu = async () => {
        setLocalizacoesCarregando(true);
        setLocalizacoesMsg(null);
        try {
            const response = await apiFetch('/locations', {
                method: 'PUT',
                headers: buildAuthHeaders(token, { 'Content-Type': 'application/json' }),
                body: JSON.stringify({
                    localizacoes: localizacoesPpu.map((row) => ({
                        localizacao_normalizada: row.localizacao_normalizada,
                        localizacao_exibicao: row.localizacao_exibicao,
                        contabiliza_ppu: row.contabiliza_ppu !== false,
                        destino_contabilizacao: row.contabiliza_ppu !== false ? 'PPU' : (row.destino_contabilizacao || 'FORA_LINHA'),
                        situacao_operacional: row.contabiliza_ppu !== false ? 'DISPONIVEL' : (row.situacao_operacional || 'A_CONFIRMAR'),
                        ativo: row.ativo !== false,
                        observacao: row.observacao || null,
                    })),
                }),
            }, token);
            const result = await response.json();
            if (result.status !== 'success') throw new Error(result.message || 'Falha ao salvar localizações.');
            setLocalizacoesMsg({ tipo: 'success', texto: result.message });
            await carregarLocalizacoesPpu();
        } catch (error) {
            setLocalizacoesMsg({ tipo: 'error', texto: error.message || 'Falha ao salvar localizações.' });
        } finally {
            setLocalizacoesCarregando(false);
        }
    };

    const localizacoesFiltradas = localizacoesPpu.filter((row) => {
        const termo = localizacoesBusca.trim().toUpperCase();
        if (!termo) return true;
        return String(row.localizacao_exibicao || '').toUpperCase().includes(termo)
            || String(row.localizacao_normalizada || '').toUpperCase().includes(termo);
    });

    const handleCadastroMembro = async (e) => {
        e.preventDefault();
        if (!isDono || !email) return;

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
                        role: roleCadastro
                    })
                },
                token
            );

            const result = await response.json();

            if (result.status === 'success') {
                setMembroMsg({ tipo: 'success', texto: result.message });
                setEmail('');
                setRoleCadastro('operador');
                carregarUsuariosAutorizados();
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
        if (token) carregarAtualizacoes(true);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [token]);

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
        });
    };

    const cancelarEdicaoUsuario = () => {
        setEditandoUsuarioId(null);
        setUsuarioEdit({ email: '', role: 'operador', active: true });
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

    const handleEnviarLinkAcesso = async (usuario) => {
        if (!podeGerenciarUsuarios || !usuario?.id) return;
        setMembroCarregando(true);
        setMembroMsg(null);
        try {
            const response = await apiFetch(
                `/auth/users/${usuario.id}/access-link`,
                {
                    method: 'POST',
                    headers: buildAuthHeaders(token, { 'Content-Type': 'application/json' }),
                },
                token
            );
            const result = await response.json();
            if (result.status === 'success') {
                setMembroMsg({ tipo: 'success', texto: result.message });
            } else {
                setMembroMsg({ tipo: 'error', texto: result.message || 'Falha ao enviar link de acesso.' });
            }
        } catch {
            setMembroMsg({ tipo: 'error', texto: 'Erro de ligação ao enviar link de acesso.' });
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
        <div className="space-y-6">
            <section className="rounded-3xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-5 sm:p-6 shadow-sm">
                <div className="flex flex-col xl:flex-row xl:items-center xl:justify-between gap-5">
                    <div>
                        <p className="text-[10px] font-black uppercase tracking-[0.18em] text-blue-600 dark:text-blue-400">Administração do SISHA</p>
                        <h2 className="mt-1 text-2xl font-black text-slate-900 dark:text-white">O que você deseja atualizar?</h2>
                        <p className="mt-1 text-sm font-bold text-slate-600 dark:text-slate-400">
                            Escolha uma área. O SISHA mostra somente as ferramentas relacionadas à tarefa selecionada.
                        </p>
                    </div>
                    <div className="flex flex-col sm:flex-row gap-2">
                        <button
                            type="button"
                            onClick={() => setModalPendencias(true)}
                            className="inline-flex items-center justify-center gap-2 rounded-xl bg-amber-500 px-5 py-3 text-sm font-black text-slate-950 hover:bg-amber-400 transition-colors"
                        >
                            <AlertTriangle size={17} /> PENDÊNCIAS
                        </button>
                        <button
                            type="button"
                            onClick={abrirModalLocalizacoes}
                            className="inline-flex items-center justify-center gap-2 rounded-xl bg-blue-600 px-5 py-3 text-sm font-black text-white hover:bg-blue-700 transition-colors"
                        >
                            <MapPin size={17} /> LOCALIZAÇÕES DO PPU
                        </button>
                    </div>
                </div>

                <div className="mt-5 flex gap-2 overflow-x-auto pb-1">
                    {areasSistema.map((area) => {
                        const ativa = areaAtiva === area.key;
                        return (
                            <button
                                key={area.key}
                                type="button"
                                onClick={() => setAreaAtiva(area.key)}
                                title={area.descricao}
                                className={`shrink-0 rounded-xl px-4 py-3 text-sm font-black transition-colors ${
                                    ativa
                                        ? 'bg-blue-600 text-white shadow-sm'
                                        : 'bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-200 hover:bg-slate-200 dark:hover:bg-slate-700'
                                }`}
                            >
                                {area.label}
                            </button>
                        );
                    })}
                </div>

                <p className="mt-3 text-xs font-bold text-slate-500 dark:text-slate-400">
                    {areasSistema.find((area) => area.key === areaAtiva)?.descricao}
                </p>
            </section>

            {areaAtiva === 'atualizar' && (
            <section className="bg-white dark:bg-slate-900 rounded-3xl p-8 shadow-sm border border-slate-200 dark:border-slate-800">
                <div className="flex flex-col lg:flex-row lg:items-start lg:justify-between gap-3 mb-4">
                    <div>
                        <h2 className="text-xl font-black text-slate-800 dark:text-white mb-1 uppercase">Atualizar dados</h2>
                        <p className="text-sm font-bold text-slate-600 dark:text-slate-400">Escolha o tipo de informação que deseja atualizar e envie o arquivo correspondente.</p>
                    </div>
                    <button
                        type="button"
                        onClick={() => setRecibosImportOpen((current) => !current)}
                        className={`px-5 py-3 rounded-xl font-black border-2 ${recibosImportOpen ? 'bg-blue-600 border-blue-600 text-white' : 'bg-white dark:bg-slate-950 border-blue-500 text-blue-700 dark:text-blue-300'}`}
                    >
                        RECIBOS
                    </button>
                </div>

                {recibosImportOpen && (
                    <div className="mb-6">
                        <Recebimentos importOnly />
                    </div>
                )}

                <form onSubmit={handleUpload} className="space-y-4">
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                        <select
                            value={tipoArquivo}
                            onChange={(e) => setTipoArquivo(e.target.value)}
                            className="w-full p-3 bg-white dark:bg-slate-950 border-2 border-slate-200 dark:border-slate-700 rounded-xl font-bold text-slate-900 dark:text-slate-100"
                        >
                            <option value="order_book">Order Book</option>
                            <option value="price_list">Price List</option>
                            <option value="inventario_ppu">InventarioPPUGeralLoc — Inventário Geral PPU por Localização</option>
                            <option value="custodia_externa_ppu">Backend_Auditoria_Paiol — Caixas CEIMSPA sob custódia PPU</option>
                            <option value="controle_equipamentos_criticos">Controle de Equipamentos Criticos da Aeronave</option>
                            <option value="saida_movimentacao_ppu">SaidaMovimentacaoPorPeriodo</option>
                            <option value="master_os">MASTER OS — Histórico e Orquestração de Ordens de Serviço</option>
                            <option value="ceimspa">Estoque CeIMSPA</option>
                            <option value="historico_movimentacao">Histórico de Movimentação</option>
                            <option value="disponibilidade_anv">Mapa de Disponibilidade / Inspeções</option>
                            <option value="controle_inspecao">CONTROLE INSPEÇÃO</option>
                            <option value="livro_motores">LIVRO DOS MOTORES</option>
                            <option value="lisde">LISDE</option>
                            <option value="manual_legado">Manual / Dicionário Mestre (CIETP)</option>
                            <option value="manual_tecnico">WTP / Manual Técnico</option>
                            <option value="pn_alternativos">PN Alternativos</option>
                            <option value="qnna">QNNA</option>
                            <option value="sb">SB</option>
                            <option value="receitas" disabled>Receitas — use Chat Lince (importador operacional em preparação)</option>
                            <option value="pim">PIM Pendentes — snapshot atual</option>
                            <option value="politica_estoque_tarefas" disabled>Política de Estoque — use Chat Lince (importador operacional em preparação)</option>
                        </select>

                        <input
                            type="file"
                            onChange={handleFileChange}
                            className="w-full p-3 bg-white dark:bg-slate-950 border-2 border-slate-200 dark:border-slate-700 rounded-xl font-bold text-slate-900 dark:text-slate-100 file:text-slate-900"
                        />
                    </div>

                    <div className="rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950/50 px-4 py-3 text-sm">
                        <p className="font-black text-slate-700 dark:text-slate-200">
                            Última atualização registrada para este tipo
                        </p>
                        {ultimoUploadTipo ? (
                            <p className="mt-1 font-bold text-slate-600 dark:text-slate-400">
                                {formatUploadDate(ultimoUploadTipo.finished_at || ultimoUploadTipo.created_at)} • {ultimoUploadTipo.nome_arquivo} • {importStatusLabel(ultimoUploadTipo.status)}
                            </p>
                        ) : (
                            <p className="mt-1 font-bold text-slate-500 dark:text-slate-400">Ainda sem upload registrado na trilha de atualizações do SISHA.</p>
                        )}
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

                    <div className="rounded-2xl border border-purple-200 dark:border-purple-800 bg-purple-50 dark:bg-purple-950/30 p-4 flex flex-col md:flex-row md:items-center md:justify-between gap-3">
                        <div>
                            <p className="font-black uppercase text-purple-900 dark:text-purple-200">Documento fora do modelo ou importador ainda não ativado?</p>
                            <p className="text-sm font-bold text-purple-800 dark:text-purple-300">Envie pelo Chat Lince para leitura por IA, normalização, validação humana e exportação estruturada. A IA não grava cegamente nas tabelas operacionais.</p>
                        </div>
                        <button
                            type="button"
                            onClick={() => { window.location.href = '/chat-lince'; }}
                            className="shrink-0 rounded-xl bg-slate-700 px-5 py-3 text-sm font-black text-white hover:bg-slate-600"
                        >
                            ABRIR CHAT LINCE
                        </button>
                    </div>

                    {orientacaoUpload && (
                        <div className="rounded-2xl border border-blue-200 dark:border-blue-800 bg-blue-50 dark:bg-blue-950/30 p-4 text-sm text-blue-950 dark:text-blue-100 space-y-3">
                            <div>
                                <p className="font-black uppercase text-blue-900 dark:text-blue-200">{orientacaoUpload.titulo}</p>
                                <p className="font-bold text-blue-800 dark:text-blue-300">Antes de enviar, confira o modelo esperado para este tipo de documento.</p>
                            </div>

                            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                                <div className="rounded-xl bg-white/70 dark:bg-slate-900/70 border border-blue-100 p-3">
                                    <p className="font-black text-blue-900 dark:text-blue-200">Colunas obrigatórias</p>
                                    <p className="font-bold text-slate-800">{orientacaoUpload.obrigatorias.join(', ')}</p>
                                </div>
                                <div className="rounded-xl bg-white/70 dark:bg-slate-900/70 border border-blue-100 p-3">
                                    <p className="font-black text-blue-900 dark:text-blue-200">Colunas recomendadas</p>
                                    <p className="font-bold text-slate-800">{orientacaoUpload.recomendadas.join(', ')}</p>
                                </div>
                            </div>

                            <p className="font-bold text-slate-800">
                                <span className="font-black text-blue-900 dark:text-blue-200">Comportamento: </span>
                                {orientacaoUpload.comportamento}
                            </p>

                            {orientacaoUpload.observacao && (
                                <p className="font-bold text-slate-700 dark:text-slate-300">
                                    <span className="font-black text-blue-900 dark:text-blue-200">Observação: </span>
                                    {orientacaoUpload.observacao}
                                </p>
                            )}

                            {tipoArquivo === 'custodia_externa_ppu' && (
                                <div className="rounded-xl border border-amber-200 dark:border-amber-800 bg-amber-50 dark:bg-amber-950/30 p-3 flex flex-col md:flex-row md:items-center md:justify-between gap-3">
                                    <div className="font-bold text-amber-900 dark:text-amber-200">
                                        Custódia externa continua pertencendo ao PPU. Divergências nunca são contadas automaticamente.
                                    </div>
                                    <button type="button" onClick={() => carregarCustodiaExterna(true)} className="shrink-0 rounded-xl bg-amber-600 px-4 py-2 text-xs font-black text-white hover:bg-amber-700">
                                        REVISAR RECONCILIAÇÃO
                                    </button>
                                </div>
                            )}

                            {tipoArquivo === 'ceimspa' && (
                                <div className="rounded-xl border border-purple-200 dark:border-purple-800 bg-purple-50 dark:bg-purple-950/30 p-3 font-bold text-purple-900 dark:text-purple-200">
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
                        </div>
                    )}
                </form>
            </section>

            )}

            {areaAtiva === 'atualizacoes' && (
                <section className="bg-white dark:bg-slate-900 rounded-3xl p-6 sm:p-8 shadow-sm border border-slate-200 dark:border-slate-800 space-y-6">
                    <div className="flex flex-col md:flex-row md:items-start md:justify-between gap-4">
                        <div>
                            <h2 className="text-xl font-black text-slate-800 dark:text-white uppercase">Atualizações registradas</h2>
                            <p className="mt-1 text-sm font-bold text-slate-600 dark:text-slate-400 max-w-3xl">
                                Consulte a última atualização por tipo de documento e o histórico de arquivos registrados pela trilha de importação do SISHA. A data exibida é a data registrada pelo backend, não a data do arquivo no computador.
                            </p>
                        </div>
                        <button
                            type="button"
                            onClick={() => carregarAtualizacoes(false)}
                            disabled={importLogsCarregando}
                            className="rounded-xl border-2 border-blue-500 px-5 py-3 text-sm font-black text-blue-700 dark:text-blue-300 disabled:opacity-50"
                        >
                            {importLogsCarregando ? 'ATUALIZANDO...' : 'ATUALIZAR LISTA'}
                        </button>
                    </div>

                    {importLogsMsg ? <p className="font-bold text-red-600">{importLogsMsg}</p> : null}

                    <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
                        {atualizacoesPorTipo.length ? atualizacoesPorTipo.map((item) => (
                            <div key={`latest-${item.tipo_arquivo}`} className="rounded-2xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950/40 p-4">
                                <p className="text-[10px] uppercase tracking-[0.15em] font-black text-slate-400">{orientacoesUploadPorTipo[item.tipo_arquivo]?.titulo || item.tipo_arquivo || 'Documento'}</p>
                                <p className="mt-1 font-black text-slate-900 dark:text-slate-100 break-words">{item.nome_arquivo || 'Sem nome registrado'}</p>
                                <p className="mt-2 text-sm font-bold text-slate-600 dark:text-slate-400">{formatUploadDate(item.finished_at || item.created_at)}</p>
                                <p className="mt-1 text-xs font-black text-blue-700 dark:text-blue-300">{importStatusLabel(item.status)}</p>
                            </div>
                        )) : (
                            <p className="text-sm font-bold text-slate-500 dark:text-slate-400">Nenhum arquivo registrado na trilha de importação.</p>
                        )}
                    </div>

                    <div className="rounded-2xl border border-slate-200 dark:border-slate-800 overflow-hidden">
                        <div className="bg-slate-50 dark:bg-slate-800/80 px-4 py-3">
                            <p className="text-xs font-black uppercase tracking-[0.14em] text-slate-600 dark:text-slate-300">Histórico de documentos</p>
                        </div>
                        <div className="overflow-auto max-h-[520px]">
                            <table className="min-w-[900px] w-full text-sm">
                                <thead className="sticky top-0 bg-slate-100 dark:bg-slate-800 text-[10px] uppercase tracking-wider text-slate-500">
                                    <tr>
                                        <th className="p-3 text-left">Documento</th>
                                        <th className="p-3 text-left">Tipo</th>
                                        <th className="p-3 text-left">Atualizado em</th>
                                        <th className="p-3 text-left">Responsável</th>
                                        <th className="p-3 text-left">Linhas</th>
                                        <th className="p-3 text-left">Situação</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {importLogs.map((item) => (
                                        <tr key={item.id} className="border-t border-slate-100 dark:border-slate-800 align-top">
                                            <td className="p-3 font-black text-slate-800 dark:text-slate-200">{item.nome_arquivo || '—'}</td>
                                            <td className="p-3 font-bold text-slate-600 dark:text-slate-400">{orientacoesUploadPorTipo[item.tipo_arquivo]?.titulo || item.tipo_arquivo || '—'}</td>
                                            <td className="p-3 font-bold text-slate-600 dark:text-slate-400">{formatUploadDate(item.finished_at || item.created_at)}</td>
                                            <td className="p-3 text-slate-600 dark:text-slate-400">{item.uploaded_by_email || 'Sistema'}</td>
                                            <td className="p-3 text-slate-600 dark:text-slate-400">{Number(item.linhas_importadas || 0).toLocaleString('pt-BR')} aplicadas • {Number(item.linhas_ignoradas || 0).toLocaleString('pt-BR')} ignoradas</td>
                                            <td className="p-3 font-black text-slate-700 dark:text-slate-300">{importStatusLabel(item.status)}</td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                    </div>
                </section>
            )}

            {areaAtiva === 'usuarios' && (
                <>
            {podeGerenciarUsuarios ? (
                <section className="bg-white dark:bg-slate-900 rounded-3xl p-8 shadow-sm border border-slate-200 dark:border-slate-800">
                    <div className="flex items-start justify-between gap-4 mb-6">
                        <div>
                            <h2 className="text-xl font-black text-slate-800 dark:text-white mb-1 flex items-center gap-2 uppercase">
                                Gestão de Usuários
                            </h2>
                            <p className="text-sm text-slate-700 dark:text-slate-300">
                                Dono visualiza e edita todos os usuários. Admin visualiza apenas a própria conta e usuários Operador, podendo alterar e-mail e status e enviar link seguro de acesso, sem criar usuário nem promover permissões.
                            </p>
                        </div>
                        <span className="rounded-full bg-blue-50 dark:bg-blue-950/30 px-4 py-2 text-xs font-black text-blue-700 dark:text-blue-300 uppercase">{isDono ? 'DONO' : 'ADMIN'}</span>
                    </div>

                    {isDono ? (
                    <form onSubmit={handleCadastroMembro} className="space-y-4 mb-8">
                        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                            <input
                                type="email"
                                value={email}
                                onChange={(e) => setEmail(e.target.value)}
                                placeholder="Email Militar"
                                className="w-full p-3 bg-white dark:bg-slate-950 border-2 border-slate-200 dark:border-slate-700 rounded-xl font-bold text-slate-900 dark:text-slate-100 placeholder:text-slate-500"
                            />

                            <div className="w-full p-3 bg-slate-50 dark:bg-slate-950 border-2 border-slate-200 dark:border-slate-700 rounded-xl font-bold text-slate-600 dark:text-slate-300 text-sm flex items-center">
                                Senha definida pelo próprio usuário via link seguro.
                            </div>

                            <select
                                value={roleCadastro}
                                onChange={(e) => setRoleCadastro(e.target.value)}
                                className="w-full p-3 bg-white dark:bg-slate-950 border-2 border-slate-200 dark:border-slate-700 rounded-xl font-bold text-slate-900 dark:text-slate-100"
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
                                disabled={membroCarregando || !email}
                                className="bg-blue-600 text-white px-8 py-3 rounded-xl font-black hover:bg-blue-700 disabled:opacity-50"
                            >
                                CADASTRAR E ENVIAR LINK
                            </button>
                        </div>
                    </form>
                    ) : (
                        <div className="mb-8 rounded-2xl border border-blue-100 bg-blue-50 dark:bg-blue-950/30 p-5 text-sm font-bold text-blue-900 dark:text-blue-200">
                            Como Admin, você pode editar sua própria conta e os usuários Operador listados abaixo e enviar link seguro de acesso. Criação de usuários e promoção/rebaixamento de permissões ficam restritas ao Dono.
                        </div>
                    )}

                    {membroMsg && (
                        <p className={`font-bold mb-4 ${membroMsg.tipo === 'success' ? 'text-green-600' : 'text-red-600'}`}>
                            {membroMsg.texto}
                        </p>
                    )}

                    <div className="overflow-auto border border-slate-200 rounded-2xl">
                        <table className="min-w-full text-sm">
                            <thead className="bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-300 uppercase text-xs">
                                <tr>
                                    <th className="p-3 text-left">Email</th>
                                    <th className="p-3 text-left">Perfil</th>
                                    <th className="p-3 text-left">Ativo</th>
                                    <th className="p-3 text-left">Acesso</th>
                                    <th className="p-3 text-right">Ações</th>
                                </tr>
                            </thead>
                            <tbody className="text-slate-900 dark:text-slate-100">
                                {usuariosAutorizados.map((usuario) => {
                                    const isEditing = editandoUsuarioId === usuario.id;
                                    const isDonoLinha = String(usuario.role || '').trim().toLowerCase() === 'dono';
                                    return (
                                        <tr key={usuario.id} className="border-t border-slate-200 dark:border-slate-800">
                                            <td className="p-3 font-bold">
                                                {isEditing ? (
                                                    <input
                                                        value={usuarioEdit.email}
                                                        onChange={(e) => setUsuarioEdit(prev => ({ ...prev, email: e.target.value }))}
                                                        className="w-full p-2 bg-white dark:bg-slate-950 border-2 border-slate-200 dark:border-slate-700 rounded-xl font-bold text-slate-900 dark:text-slate-100"
                                                    />
                                                ) : usuario.email}
                                            </td>
                                            <td className="p-3">
                                                {isEditing && isDono ? (
                                                    <select
                                                        value={usuarioEdit.role}
                                                        onChange={(e) => setUsuarioEdit(prev => ({ ...prev, role: e.target.value }))}
                                                        className="w-full p-2 bg-white dark:bg-slate-950 border-2 border-slate-200 dark:border-slate-700 rounded-xl font-bold text-slate-900 dark:text-slate-100"
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
                                                        className="w-full p-2 bg-white dark:bg-slate-950 border-2 border-slate-200 dark:border-slate-700 rounded-xl font-bold text-slate-900 dark:text-slate-100"
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
                                                <button
                                                    type="button"
                                                    onClick={() => handleEnviarLinkAcesso(usuario)}
                                                    disabled={membroCarregando || usuario.active === false}
                                                    className="px-3 py-2 rounded-xl bg-slate-200 dark:bg-slate-700 text-slate-900 dark:text-white font-black hover:bg-slate-300 dark:hover:bg-slate-600 disabled:opacity-50 whitespace-nowrap"
                                                >
                                                    ENVIAR LINK
                                                </button>
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
                                                                className="px-4 py-2 rounded-xl bg-amber-50 dark:bg-amber-950/300 text-white font-black hover:bg-amber-600"
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
                <section className="bg-white dark:bg-slate-900 rounded-3xl p-8 shadow-sm border border-slate-200 dark:border-slate-800">
                    <h2 className="text-xl font-black text-slate-800 dark:text-white mb-2 uppercase">Gestão de Usuários</h2>
                    <div className="rounded-2xl border border-amber-200 dark:border-amber-800 bg-amber-50 dark:bg-amber-950/30 p-5 text-sm font-bold text-amber-900 dark:text-amber-200">
                        A gestão de usuários é restrita aos perfis Admin e Dono. Operador pode usar “Esqueci minha senha” na tela de login ou solicitar novo link de acesso.
                    </div>
                </section>
            )}
                </>
            )}

            {areaAtiva === 'administrar' && (
                <>
                    <AircraftOperationalStateAdmin token={token} />
                    <DataAdminManager token={token} />
                </>
            )}

            {areaAtiva === 'necessidades' && <NeedsFoundationPanel token={token} />}

            {areaAtiva === 'cotacoes' && <RfqImporter />}

            {modalCeimspaConfirm && (
                <div className="fixed inset-0 bg-black/70 flex items-center justify-center p-4 z-50">
                    <div className="bg-white dark:bg-slate-900 rounded-3xl p-8 max-w-lg w-full shadow-2xl space-y-4 border border-slate-200 dark:border-slate-800">
                        <h3 className="text-xl font-black text-slate-900 dark:text-white uppercase">Confirmação CeIMSPA</h3>
                        <p className="text-slate-900 dark:text-slate-100">
                            Escolha como o SISHA deve tratar a importação do estoque CeIMSPA.
                        </p>
                        <p className="text-sm font-bold text-amber-700 bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800 rounded-2xl p-3">
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
                                className="px-6 py-3 rounded-xl bg-slate-700 text-white font-black hover:bg-slate-600"
                            >
                                Adicionar suplemento
                            </button>

                            <button
                                onClick={() => {
                                    setCeimspaOverwrite(true);
                                    setModalCeimspaConfirm(false);
                                }}
                                className="px-6 py-3 rounded-xl bg-blue-600 text-white font-black hover:bg-blue-700"
                            >
                                Substituir base
                            </button>
                        </div>
                    </div>
                </div>
            )}

            <PendingCenterModal
                open={modalPendencias}
                onClose={() => setModalPendencias(false)}
                token={token}
                onOpenReceipts={() => navigate('/recebimentos')}
                onOpenPurchases={() => navigate('/compras')}
                onOpenRfq={() => setAreaAtiva('cotacoes')}
            />

            {modalLocalizacoes && (
                <div className="fixed inset-0 z-50 bg-slate-950/70 backdrop-blur-sm flex items-center justify-center p-4">
                    <div className="w-full max-w-5xl max-h-[88vh] overflow-hidden rounded-3xl bg-white dark:bg-slate-900 shadow-2xl border border-slate-200 dark:border-slate-800 flex flex-col">
                        <div className="p-6 border-b border-slate-200 flex items-start justify-between gap-4">
                            <div>
                                <h3 className="text-xl font-black uppercase text-slate-900 dark:text-slate-100">Localizações contabilizadas no PPU</h3>
                                <p className="text-sm font-bold text-slate-600 dark:text-slate-400 mt-1">A localização física nunca é apagada. Desmarque uma LOC para removê-la do total PPU e classifique onde ela contabiliza e qual é sua situação operacional.</p>
                            </div>
                            <button type="button" onClick={() => setModalLocalizacoes(false)} className="p-2 rounded-xl bg-slate-100 text-slate-700 hover:bg-slate-200" aria-label="Fechar"><X size={20} /></button>
                        </div>

                        <div className="p-6 space-y-4 overflow-hidden flex flex-col">
                            <div className="flex flex-col md:flex-row md:items-center gap-3">
                                <div className="relative flex-1">
                                    <Search size={17} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
                                    <input value={localizacoesBusca} onChange={(event) => setLocalizacoesBusca(event.target.value)} placeholder="Pesquisar localização" className="w-full pl-10 pr-3 py-3 rounded-xl border-2 border-slate-200 font-bold text-slate-900 outline-none focus:border-blue-500" />
                                </div>
                                <div className="rounded-xl bg-slate-100 px-4 py-3 text-xs font-black text-slate-700 dark:text-slate-300">
                                    {localizacoesPpu.filter((row) => row.contabiliza_ppu !== false).length} de {localizacoesPpu.length} contabilizando
                                </div>
                            </div>

                            {localizacoesMsg && <p className={`font-bold ${localizacoesMsg.tipo === 'success' ? 'text-emerald-700' : 'text-red-700'}`}>{localizacoesMsg.texto}</p>}

                            <div className="overflow-auto rounded-2xl border border-slate-200 max-h-[56vh]">
                                <table className="min-w-full text-sm">
                                    <thead className="sticky top-0 bg-slate-100 text-slate-700 uppercase text-[10px] z-10">
                                        <tr><th className="p-3 text-left">PPU</th><th className="p-3 text-left">Localização física</th><th className="p-3 text-left">Contabiliza em</th><th className="p-3 text-left">Situação operacional</th><th className="p-3 text-left">Observação / evidência</th><th className="p-3 text-right">Linhas</th><th className="p-3 text-right">Quantidade atual</th></tr>
                                    </thead>
                                    <tbody>
                                        {localizacoesFiltradas.map((row) => (
                                            <tr key={row.localizacao_normalizada} className="border-t border-slate-200 dark:border-slate-800 align-top">
                                                <td className="p-3"><input type="checkbox" checked={row.contabiliza_ppu !== false} onChange={(event) => alternarLocalizacaoPpu(row.localizacao_normalizada, event.target.checked)} className="h-5 w-5 accent-blue-600" /></td>
                                                <td className="p-3 font-black text-slate-900 dark:text-slate-100 min-w-44">{row.localizacao_exibicao}</td>
                                                <td className="p-3 min-w-44">
                                                    {row.contabiliza_ppu !== false ? <span className="font-black text-blue-700">PPU</span> : (
                                                        <select value={row.destino_contabilizacao || 'FORA_LINHA'} onChange={(event) => atualizarClassificacaoLocalizacao(row.localizacao_normalizada, 'destino_contabilizacao', event.target.value)} className="w-full rounded-lg border border-slate-300 bg-white p-2 font-bold text-slate-900">
                                                            <option value="FORA_LINHA">Fora da linha de voo</option>
                                                            <option value="CEIMSPA">CEIMSPA</option>
                                                        </select>
                                                    )}
                                                </td>
                                                <td className="p-3 min-w-52">
                                                    {row.contabiliza_ppu !== false ? <span className="font-bold text-emerald-700">Disponível</span> : (
                                                        <select value={row.situacao_operacional || 'A_CONFIRMAR'} onChange={(event) => atualizarClassificacaoLocalizacao(row.localizacao_normalizada, 'situacao_operacional', event.target.value)} className="w-full rounded-lg border border-slate-300 bg-white p-2 font-bold text-slate-900">
                                                            <option value="A_CONFIRMAR">A confirmar</option>
                                                            <option value="AGUARDANDO_REPARO">Aguardando reparo</option>
                                                            <option value="EM_REPARO">Em reparo</option>
                                                            <option value="EM_WO">Em WO</option>
                                                            <option value="CONDENADO_LIXO">Condenado / lixo</option>
                                                            <option value="ARMAZENADO_EXTERNAMENTE">Armazenado externamente</option>
                                                            <option value="QUARENTENA">Quarentena</option>
                                                            <option value="OUTRO">Outro</option>
                                                        </select>
                                                    )}
                                                </td>
                                                <td className="p-3 min-w-60"><input value={row.observacao || ''} onChange={(event) => atualizarClassificacaoLocalizacao(row.localizacao_normalizada, 'observacao', event.target.value)} placeholder="Motivo/evidência da classificação" className="w-full rounded-lg border border-slate-300 bg-white p-2 font-bold text-slate-900" /></td>
                                                <td className="p-3 text-right font-bold text-slate-600">{Number(row.linhas || 0).toLocaleString('pt-BR')}</td>
                                                <td className="p-3 text-right font-black text-slate-900 dark:text-slate-100">{Number(row.quantidade_total || 0).toLocaleString('pt-BR', { maximumFractionDigits: 2 })}</td>
                                            </tr>
                                        ))}
                                        {!localizacoesCarregando && localizacoesFiltradas.length === 0 && <tr><td colSpan="7" className="p-8 text-center font-bold text-slate-500">Nenhuma localização encontrada.</td></tr>}
                                    </tbody>
                                </table>
                            </div>
                        </div>

                        <div className="p-5 border-t border-slate-200 flex justify-end gap-3">
                            <button type="button" onClick={() => setModalLocalizacoes(false)} className="px-5 py-3 rounded-xl bg-slate-200 text-slate-900 font-black">FECHAR</button>
                            <button type="button" disabled={localizacoesCarregando} onClick={salvarLocalizacoesPpu} className="px-5 py-3 rounded-xl bg-blue-600 text-white font-black flex items-center gap-2 disabled:opacity-50"><Save size={17} /> {localizacoesCarregando ? 'SALVANDO...' : 'SALVAR SELEÇÃO'}</button>
                        </div>
                    </div>
                </div>
            )}

            {modalAdmin && (
                <div className="fixed inset-0 bg-black/70 flex items-center justify-center p-4 z-50">
                    <div className="bg-white dark:bg-slate-900 rounded-3xl p-8 w-full max-w-4xl shadow-2xl space-y-6 max-h-[90vh] overflow-auto border border-slate-200 dark:border-slate-800">
                        <div className="flex items-center justify-between">
                            <div>
                                <h3 className="text-xl font-black text-slate-900 dark:text-white uppercase">Administrar dados</h3>
                                <p className="text-slate-900 dark:text-slate-100">Selecione a base, pesquise por identificador e revise os dados antes de editar ou excluir.</p>
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
                                className="w-full p-3 bg-white dark:bg-slate-950 border-2 border-slate-200 dark:border-slate-700 rounded-xl font-bold text-slate-900 dark:text-slate-100"
                            >
                                <optgroup label="Fontes editáveis agora">
                                    <option value="ppu">PPU / Inventário</option>
                                    <option value="pn_alternativos_admin">PN Alternativos / Equivalências</option>
                                    <option value="manuais_tecnicos_admin">WTP / Manuais Técnicos</option>
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

                            {!['pn_alternativos_admin', 'manuais_tecnicos_admin'].includes(alvoAdmin) ? (
                                <>
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
                                        className="w-full p-3 bg-white dark:bg-slate-950 border-2 border-slate-200 dark:border-slate-700 rounded-xl font-bold text-slate-900 dark:text-slate-100 placeholder:text-slate-500"
                                    />

                                    <button
                                        onClick={buscarParaManutencao}
                                        disabled={adminCarregando || !idBuscaAdmin.trim()}
                                        className="bg-slate-900 text-white px-6 py-3 rounded-xl font-black hover:bg-slate-800 disabled:opacity-50"
                                    >
                                        {adminCarregando ? 'BUSCANDO...' : 'BUSCAR'}
                                    </button>
                                </>
                            ) : (
                                <div className="md:col-span-2 rounded-xl border border-blue-200 dark:border-blue-800 bg-blue-50 dark:bg-blue-950/30 px-4 py-3 text-sm font-bold text-blue-900 dark:text-blue-200">
                                    {alvoAdmin === 'pn_alternativos_admin'
                                        ? 'Gestão manual e em lote com auditoria; o CIETP continua automático.'
                                        : 'Gestão de WTP/CMM/manuais técnicos: cadastro manual, correção, lote e desativação lógica. O upload do PDF continua em Atualizar dados.'}
                                </div>
                            )}
                        </div>

                        {alvoAdmin === 'pn_alternativos_admin' && (
                            <PnAlternativosAdmin token={token} />
                        )}

                        {alvoAdmin === 'manuais_tecnicos_admin' && (
                            <ManuaisTecnicosAdmin token={token} />
                        )}

                        {alvoAdmin === 'ppu' && (
                            <p className="text-xs font-bold uppercase tracking-wide text-slate-700 dark:text-slate-300">
                                Busca EXATA: use o PN completo ou o SN completo. O painel não faz mais busca parcial por segurança.
                            </p>
                        )}

                        {['oc', 'wo', 'apelidos'].includes(alvoAdmin) && (
                            <div className="bg-blue-50 dark:bg-blue-950/30 border border-blue-200 dark:border-blue-800 rounded-2xl p-4 text-sm text-blue-900 dark:text-blue-200 font-bold">
                                Esta fonte já está integrada à consulta administrativa. A edição operacional completa de OC/WO permanece no módulo Ordens de Compras para manter regras de CAN, suplementação, PD e WO no lugar correto.
                            </div>
                        )}

                        {resultadosAdminGenericos.length > 0 && (
                            <div className="space-y-4 border border-slate-200 rounded-2xl p-6">
                                <h4 className="text-lg font-black text-slate-900 dark:text-white uppercase">Resultado Administrativo</h4>
                                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                                    {resultadosAdminGenericos.map((registro, index) => (
                                        <div key={registro.id || `${alvoAdmin}-${index}`} className="border border-slate-200 rounded-2xl p-4 bg-slate-50">
                                            {alvoAdmin === 'oc' && (
                                                <>
                                                    <p className="text-xs font-black text-slate-500 uppercase">OC / Ordem de Compra</p>
                                                    <h5 className="text-lg font-black text-slate-900 dark:text-slate-100">{registro.numero_oc || 'N/A'}</h5>
                                                    <p className="text-sm text-slate-800"><b>Status:</b> {registro.status || 'N/A'} • <b>Fonte:</b> {registro.fonte || registro.source || 'SISHA'}</p>
                                                    <p className="text-sm text-slate-800"><b>PDs:</b> {(registro.compras_pds || []).length}</p>
                                                    <p className="text-xs text-slate-700 mt-2">Edição/cancelamento/suplementação: página Ordens de Compras.</p>
                                                </>
                                            )}
                                            {alvoAdmin === 'wo' && (
                                                <>
                                                    <p className="text-xs font-black text-slate-500 uppercase">WO / Reparo</p>
                                                    <h5 className="text-lg font-black text-slate-900 dark:text-slate-100">{registro.numero_wo || registro.documento_referencia || 'N/A'}</h5>
                                                    <p className="text-sm text-slate-800"><b>PN:</b> {registro.pn || 'N/A'} • <b>SN:</b> {registro.sn || 'N/A'}</p>
                                                    <p className="text-sm text-slate-800"><b>Status:</b> {registro.status || 'N/A'} • <b>Fonte:</b> {registro.fonte || registro.source || 'SISHA'}</p>
                                                    <p className="text-xs text-slate-700 mt-2">Edição/suplementação: página Ordens de Compras.</p>
                                                </>
                                            )}
                                            {alvoAdmin === 'apelidos' && (
                                                <>
                                                    <p className="text-xs font-black text-slate-500 uppercase">Apelido Operacional</p>
                                                    <h5 className="text-lg font-black text-slate-900 dark:text-slate-100">{registro.apelido || 'N/A'}</h5>
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
                                <h4 className="text-lg font-black text-slate-900 dark:text-white uppercase">Registros Encontrados</h4>

                                <div className="overflow-auto border border-slate-200 rounded-2xl">
                                    <table className="min-w-full text-sm">
                                        <thead className="bg-slate-100 dark:bg-slate-800 text-slate-800 dark:text-slate-200 uppercase text-xs">
                                            <tr>
                                                <th className="p-3 text-left">ID</th>
                                                <th className="p-3 text-left">PN</th>
                                                <th className="p-3 text-left">SN</th>
                                                <th className="p-3 text-left">Localização</th>
                                                <th className="p-3 text-left">Quantidade</th>
                                                <th className="p-3 text-left">Ação</th>
                                            </tr>
                                        </thead>
                                        <tbody className="text-slate-900 dark:text-slate-100">
                                            {resultadosPpuAdmin.map((registro) => (
                                                <tr
                                                    key={registro.id}
                                                    className="border-t border-slate-200 text-slate-900"
                                                >
                                                    <td className="p-3 font-bold text-slate-900 dark:text-slate-100">{registro.id}</td>
                                                    <td className="p-3 font-bold text-slate-900 dark:text-slate-100">{registro.pn || 'N/A'}</td>
                                                    <td className="p-3 text-slate-900 dark:text-slate-100">{registro.sn || 'N/A'}</td>
                                                    <td className="p-3 text-slate-900 dark:text-slate-100">{registro.localizacao || 'N/A'}</td>
                                                    <td className="p-3 text-slate-900 dark:text-slate-100">{registro.quantidade ?? 0}</td>
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
                                <h4 className="text-lg font-black text-slate-900 dark:text-white uppercase">Editar Registro</h4>

                                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                                    <input
                                        type="text"
                                        value={dadosEdicao.id_referencia || ''}
                                        readOnly
                                        className="w-full p-3 bg-slate-100 dark:bg-slate-800 border-2 border-slate-200 dark:border-slate-700 rounded-xl font-bold text-slate-900 dark:text-slate-100"
                                    />

                                    <input
                                        type="text"
                                        value={dadosEdicao.nomenclatura || ''}
                                        readOnly
                                        className="w-full p-3 bg-slate-100 dark:bg-slate-800 border-2 border-slate-200 dark:border-slate-700 rounded-xl font-bold text-slate-900 dark:text-slate-100"
                                    />

                                    {alvoAdmin === 'ppu' ? (
                                        <>
                                            <input
                                                type="text"
                                                value={dadosEdicao.id || ''}
                                                readOnly
                                                className="w-full p-3 bg-slate-100 dark:bg-slate-800 border-2 border-slate-200 dark:border-slate-700 rounded-xl font-bold text-slate-900 dark:text-slate-100"
                                            />

                                            <input
                                                type="text"
                                                value={dadosEdicao.sn || ''}
                                                readOnly
                                                className="w-full p-3 bg-slate-100 dark:bg-slate-800 border-2 border-slate-200 dark:border-slate-700 rounded-xl font-bold text-slate-900 dark:text-slate-100"
                                            />

                                            <input
                                                type="number"
                                                value={dadosEdicao.quantidade || ''}
                                                onChange={(e) =>
                                                    setDadosEdicao(prev => ({ ...prev, quantidade: e.target.value }))
                                                }
                                                className="w-full p-3 bg-white dark:bg-slate-950 border-2 border-slate-200 dark:border-slate-700 rounded-xl font-bold text-slate-900 dark:text-slate-100"
                                            />

                                            <input
                                                type="text"
                                                value={dadosEdicao.localizacao || ''}
                                                onChange={(e) =>
                                                    setDadosEdicao(prev => ({ ...prev, localizacao: e.target.value }))
                                                }
                                                className="w-full p-3 bg-white dark:bg-slate-950 border-2 border-slate-200 dark:border-slate-700 rounded-xl font-bold text-slate-900 dark:text-slate-100 placeholder:text-slate-500"
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
                                                className="w-full p-3 bg-white dark:bg-slate-950 border-2 border-slate-200 dark:border-slate-700 rounded-xl font-bold text-slate-900 dark:text-slate-100"
                                            />

                                            <input
                                                type="text"
                                                value={dadosEdicao.msg_referencia || ''}
                                                onChange={(e) =>
                                                    setDadosEdicao(prev => ({ ...prev, msg_referencia: e.target.value }))
                                                }
                                                className="w-full p-3 bg-white dark:bg-slate-950 border-2 border-slate-200 dark:border-slate-700 rounded-xl font-bold text-slate-900 dark:text-slate-100"
                                            />

                                            <input
                                                type="text"
                                                value={dadosEdicao.sn || ''}
                                                onChange={(e) =>
                                                    setDadosEdicao(prev => ({ ...prev, sn: e.target.value }))
                                                }
                                                className="w-full p-3 bg-white dark:bg-slate-950 border-2 border-slate-200 dark:border-slate-700 rounded-xl font-bold text-slate-900 dark:text-slate-100 md:col-span-2"
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

            {modalCustodiaExterna && (
                <div className="fixed inset-0 z-[120] bg-slate-950/70 p-4 flex items-center justify-center">
                    <div className="w-full max-w-6xl max-h-[88vh] overflow-hidden rounded-3xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 shadow-2xl flex flex-col">
                        <div className="p-5 border-b border-slate-200 dark:border-slate-700 flex items-start justify-between gap-4">
                            <div>
                                <h3 className="text-lg font-black text-slate-900 dark:text-white uppercase">Custódia externa PPU — reconciliação</h3>
                                <p className="text-sm font-bold text-slate-600 dark:text-slate-300">Caixas no CEIMSPA permanecem sob custódia e contabilização do PPU.</p>
                            </div>
                            <button type="button" onClick={() => setModalCustodiaExterna(false)} className="p-2 rounded-xl border border-slate-200 dark:border-slate-700"><X size={18} /></button>
                        </div>
                        <div className="p-5 overflow-auto space-y-4">
                            <div className="grid grid-cols-2 md:grid-cols-5 gap-2 text-xs font-black">
                                <div className="rounded-xl bg-slate-100 dark:bg-slate-800 p-3">Declarado: {custodiaExterna.summary?.custody_declared_qty || 0}</div>
                                <div className="rounded-xl bg-blue-50 dark:bg-blue-950/30 p-3 text-blue-800 dark:text-blue-200">Contado: {custodiaExterna.summary?.custody_counted_qty || 0}</div>
                                <div className="rounded-xl bg-amber-50 dark:bg-amber-950/30 p-3 text-amber-800 dark:text-amber-200">Bloqueado: {custodiaExterna.summary?.blocked_qty || 0}</div>
                                <div className="rounded-xl bg-red-50 dark:bg-red-950/30 p-3 text-red-800 dark:text-red-200">Divergências: {custodiaExterna.summary?.divergence_groups || 0}</div>
                                <div className="rounded-xl bg-emerald-50 dark:bg-emerald-950/30 p-3 text-emerald-800 dark:text-emerald-200">Absorvidos: {custodiaExterna.summary?.absorbed_groups || 0}</div>
                            </div>
                            {custodiaMsg && <p className={`font-bold ${custodiaMsg.tipo === 'success' ? 'text-green-600' : 'text-red-600'}`}>{custodiaMsg.texto}</p>}
                            {custodiaCarregando ? <p className="font-bold text-slate-500">CARREGANDO...</p> : null}
                            {(custodiaExterna.rows || []).filter((row) => row.status === 'DIVERGENCIA').length === 0 ? (
                                <div className="rounded-2xl border border-emerald-200 bg-emerald-50 p-4 font-bold text-emerald-800">Nenhuma divergência pendente.</div>
                            ) : (
                                <div className="space-y-2">
                                    {(custodiaExterna.rows || []).filter((row) => row.status === 'DIVERGENCIA').map((row) => (
                                        <div key={row.group_key} className="rounded-2xl border border-amber-200 bg-amber-50 dark:bg-amber-950/20 p-4">
                                            <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-3">
                                                <div className="text-sm font-bold text-slate-800 dark:text-slate-200">
                                                    <p className="font-black">PN {row.pn} • {row.box_code} — CEIMSPA</p>
                                                    <p>LOC original: {row.original_location} • declarado: {row.declared_qty} • reconciliado: {row.reallocated_qty + row.absorbed_qty} • bloqueado: {row.blocked_qty}</p>
                                                </div>
                                                <div className="flex gap-2">
                                                    <button disabled={custodiaCarregando} type="button" onClick={() => decidirCustodiaExterna(row, 'CONFIRMAR_CUSTODIA')} className="rounded-xl bg-emerald-600 px-4 py-2 text-xs font-black text-white disabled:opacity-50">CONFIRMAR FÍSICO</button>
                                                    <button disabled={custodiaCarregando} type="button" onClick={() => decidirCustodiaExterna(row, 'IGNORAR_MOVIMENTACAO')} className="rounded-xl bg-slate-700 px-4 py-2 text-xs font-black text-white disabled:opacity-50">IGNORAR AJUSTE</button>
                                                </div>
                                            </div>
                                        </div>
                                    ))}
                                </div>
                            )}
                        </div>
                    </div>
                </div>
            )}

            <ManualTecnicoImportModal
                open={Boolean(manualPreview && manualPreviewFile)}
                onClose={() => { setManualPreview(null); setManualPreviewFile(null); }}
                token={token}
                file={manualPreviewFile}
                preview={manualPreview}
                onSaved={(result) => {
                    setUploadMsg({ tipo: result.status === 'success' ? 'success' : 'error', texto: [result.message, ...(result.warnings || [])].filter(Boolean).join(' ') });
                    setManualPreview(null);
                    setManualPreviewFile(null);
                }}
            />
        </div>
    );
}