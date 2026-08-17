import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Bot, FileSearch, Send, Upload, CheckCircle2, XCircle, LoaderCircle, Database, ShieldCheck, Compass, Layers, ClipboardCheck, RefreshCw, Download, Sparkles, RotateCcw, Copy, Check, ChevronDown } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { apiFetch, buildAuthHeaders } from '../lib/api';

const tiposDocumento = [
  ['DOCUMENTO_OPERACIONAL', 'Documento operacional'],
  ['order_book', 'Order Book / OC / ODC / ODA'],
  ['price_list', 'Price List / RFQ'],
  ['inventario_ppu', 'Inventário PPU'],
  ['ceimspa', 'Estoque CeIMSPA'],
  ['lisde', 'LISDE'],
  ['recibo_material', 'Recibo Material / Garantia'],
  ['recibo_pd', 'Recibo de PD'],
  ['qnna', 'QNNA'],
  ['sb', 'Service Bulletin'],
  ['receitas', 'Receitas'],
  ['pim', 'PIM'],
  ['politica_estoque_tarefas', 'Política de Estoque'],
  ['custo_operacional', 'Custo Operacional'],
  ['gerador_necessidades', 'Gerador de Necessidades'],
  ['os_instalacao_remocao', 'OS Instalação / Remoção'],
  ['wo_repair', 'WO / Repair / Warranty'],
];

const safeList = (value) => Array.isArray(value) ? value : [];

function JsonCard({ title, value }) {
  if (value == null) return null;
  return (
    <div className="rounded-2xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950/40 p-4">
      <p className="text-[10px] font-black uppercase tracking-[0.2em] text-slate-400 mb-2">{title}</p>
      <pre className="text-xs font-semibold text-slate-700 dark:text-slate-200 whitespace-pre-wrap break-words leading-relaxed">
        {typeof value === 'string' ? value : JSON.stringify(value, null, 2)}
      </pre>
    </div>
  );
}

function MessageBubble({ message }) {
  const mine = message.role === 'user';
  const [copied, setCopied] = useState(false);

  const copyMessage = async () => {
    try {
      await navigator.clipboard.writeText(String(message.content || ''));
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1400);
    } catch {
      setCopied(false);
    }
  };

  if (mine) {
    return (
      <div className="flex justify-end py-2">
        <div className="max-w-[88%] lg:max-w-[78%] rounded-[24px] rounded-br-md bg-blue-600 px-5 py-3.5 text-white shadow-sm">
          <div className="whitespace-pre-wrap break-words text-[15px] font-semibold leading-7">{message.content}</div>
        </div>
      </div>
    );
  }

  return (
    <div className="group flex items-start gap-3 py-3">
      <div className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-blue-600 text-white shadow-sm">
        <Sparkles size={17} />
      </div>
      <div className="min-w-0 flex-1">
        <div className="mb-1.5 flex items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <span className="text-xs font-black uppercase tracking-[0.14em] text-slate-700 dark:text-slate-200">Lince</span>
            <span className="rounded-full bg-emerald-50 px-2 py-0.5 text-[9px] font-black uppercase tracking-wider text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300">SISHA</span>
          </div>
          <button
            type="button"
            onClick={copyMessage}
            className="inline-flex items-center gap-1 rounded-lg px-2 py-1 text-[10px] font-black text-slate-400 opacity-0 transition hover:bg-slate-100 hover:text-slate-700 group-hover:opacity-100 dark:hover:bg-slate-800 dark:hover:text-slate-200"
            title="Copiar resposta"
          >
            {copied ? <Check size={13} /> : <Copy size={13} />} {copied ? 'COPIADO' : 'COPIAR'}
          </button>
        </div>
        <div className="whitespace-pre-wrap break-words text-[15px] font-semibold leading-7 text-slate-800 dark:text-slate-100">
          {message.content}
        </div>
      </div>
    </div>
  );
}

function DestinationSelect({ value, onChange, options = [], disabled = false }) {
  const normalized = safeList(options);
  if (normalized.length === 0) return null;
  return (
    <div className="rounded-2xl border border-blue-100 dark:border-blue-900 bg-white dark:bg-slate-900 p-4">
      <p className="text-[10px] font-black uppercase tracking-[0.2em] text-slate-400 mb-2">Tabela de destino confirmada pelo Admin</p>
      <select
        value={value || normalized[0]?.tabela || ''}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
        className="w-full p-3 rounded-xl border-2 border-blue-100 dark:border-blue-900 bg-blue-50 dark:bg-blue-950/20 text-slate-900 dark:text-white font-black"
      >
        {normalized.map((item) => (
          <option key={item.tabela} value={item.tabela}>{item.tabela}</option>
        ))}
      </select>
      <div className="mt-3 space-y-2">
        {normalized.map((item) => (
          <p key={`${item.tabela}-desc`} className="text-xs font-semibold text-slate-600 dark:text-slate-300">
            <span className="font-black text-blue-700 dark:text-blue-300">{item.tabela}:</span> {item.finalidade || 'Destino possível.'}
          </p>
        ))}
      </div>
    </div>
  );
}

export default function ChatLince() {
  const { token, user } = useAuth();
  const navigate = useNavigate();
  const isAdmin = ['admin', 'dono'].includes(user?.role);
  const fileInputRef = useRef(null);
  const composerRef = useRef(null);
  const conversationEndRef = useRef(null);

  const [pergunta, setPergunta] = useState('');
  const [contextoAberto, setContextoAberto] = useState(true);
  const [mensagens, setMensagens] = useState([
    {
      role: 'assistant',
      content: 'Olá! Sou o Chat Lince. Posso consultar PN, SN, OC, PD, WO, Política de Estoque, Custo Operacional, Gerador de Necessidades e também buscar no manual onde um item é aplicado, usado ou instalado. Quando eu não encontrar resposta, abro uma pendência para análise do PPU/Admin.',
    },
  ]);
  const [consultando, setConsultando] = useState(false);
  const [fontes, setFontes] = useState([]);
  const [modulos, setModulos] = useState(null);
  const [trilhaSn, setTrilhaSn] = useState([]);
  const [aplicacoesManual, setAplicacoesManual] = useState([]);
  const [apelidoPendente, setApelidoPendente] = useState(null);
  const [ultimoItemContexto, setUltimoItemContexto] = useState(null);

  const [tipoDocumento, setTipoDocumento] = useState('DOCUMENTO_OPERACIONAL');
  const [arquivo, setArquivo] = useState(null);
  const [analisando, setAnalisando] = useState(false);
  const [analise, setAnalise] = useState(null);
  const [documentoId, setDocumentoId] = useState(null);
  const [destinoAdmin, setDestinoAdmin] = useState('');
  const [docMsg, setDocMsg] = useState(null);
  const [observacaoAdmin, setObservacaoAdmin] = useState('');
  const [acaoPendente, setAcaoPendente] = useState(null);
  const [senhaAcao, setSenhaAcao] = useState('');
  const [executandoAcao, setExecutandoAcao] = useState(false);
  const [acaoMsg, setAcaoMsg] = useState(null);
  const [reindexandoRag, setReindexandoRag] = useState(false);
  const [ragMsg, setRagMsg] = useState(null);

  useEffect(() => {
    conversationEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [mensagens, consultando]);

  const resizeComposer = (element = composerRef.current) => {
    if (!element) return;
    element.style.height = 'auto';
    element.style.height = `${Math.min(element.scrollHeight, 180)}px`;
  };

  const limparComposer = () => {
    setPergunta('');
    window.requestAnimationFrame(() => {
      if (composerRef.current) composerRef.current.style.height = '52px';
    });
  };

  const novaConversa = () => {
    setMensagens([{
      role: 'assistant',
      content: 'Olá! Sou o Lince. Posso cruzar PN, SN, Master OS, Livro de Equipamentos, PPU, Recibos, PIM, STC, WO, PD/OC, Order Book e manuais técnicos. Diga o que você precisa descobrir e eu separo fato confirmado, intenção e pendência.',
    }]);
    setFontes([]);
    setModulos(null);
    setTrilhaSn([]);
    setAplicacoesManual([]);
    setApelidoPendente(null);
    setUltimoItemContexto(null);
    setAcaoPendente(null);
    limparComposer();
  };

  const onComposerKeyDown = (event) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      event.currentTarget.form?.requestSubmit();
    }
  };

  const registrosSugeridos = useMemo(() => safeList(analise?.registros_sugeridos), [analise]);
  const riscos = useMemo(() => safeList(analise?.riscos), [analise]);
  const passos = useMemo(() => safeList(analise?.proximos_passos), [analise]);
  const destinosPossiveis = useMemo(() => safeList(analise?.destinos_possiveis), [analise]);
  const acoesConsultivas = useMemo(() => safeList(analise?.acoes_consultivas), [analise]);
  const osEventos = useMemo(() => safeList(analise?.os_eventos_sugeridos), [analise]);
  const snTrilhaSugerida = useMemo(() => safeList(analise?.sn_trilha_sugerida), [analise]);
  const isReceiptAnalysis = useMemo(() => {
    const marker = `${tipoDocumento} ${analise?.classificacao || ''} ${analise?.destino_sugerido || ''}`.toUpperCase();
    return marker.includes('RECIBO') || ['recibo_material', 'recibo_pd'].includes(tipoDocumento);
  }, [analise, tipoDocumento]);

  const reindexarRag = async () => {
    if (!isAdmin || !token || reindexandoRag) return;
    setReindexandoRag(true);
    setRagMsg(null);
    try {
      const response = await apiFetch(
        '/chat-lince/rag/reindexar',
        {
          method: 'POST',
          headers: buildAuthHeaders(token, { 'Content-Type': 'application/json' }),
          body: JSON.stringify({ limit: 1000, limitPerSource: 1000, includeStructuredSources: true, includeChatDocuments: true }),
        },
        token
      );
      const result = await response.json();
      if (result.status === 'success') {
        const data = result.data || {};
        const docs = data.documentos_chat || {};
        const fontes = data.fontes_logisticas || {};
        setRagMsg({
          tipo: 'success',
          texto: `RAG reindexado: ${data.indexed || 0}/${data.processed || 0} registro(s), ${data.chunks || 0} trecho(s). Documentos: ${docs.indexed || 0}/${docs.processed || 0}. Fontes logísticas: ${fontes.indexed || 0}/${fontes.processed || 0}.`,
        });
      } else {
        setRagMsg({ tipo: 'error', texto: result.message || 'Falha ao reindexar documentos.' });
      }
    } catch {
      setRagMsg({ tipo: 'error', texto: 'Falha de comunicação ao reindexar o RAG.' });
    } finally {
      setReindexandoRag(false);
    }
  };

  const normalizarTexto = (value = '') => String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase();

  const temIntencaoProcesso = (value = '') => /\b(WO|WORK\s*ORDER|REPAIR|REPARO|RECEX|PROCESSO|COMPRA|AQUISICAO|AQUISICAO|ADQUIRIDO|PD|SEPD|OC|ODC|ODA|COTACAO|PEDIDO|SUPLEMENTACAO|EMBARCADO|EMBARCADA|ABERTO|ABERTA|ANDAMENTO|LINHA\s+DE\s+VOO|DISPONIBILIDADE|INDISPONIBILIDADE)\b/.test(normalizarTexto(value));

  const temIdentificadorExplicito = (value = '') => {
    const normalized = normalizarTexto(value);
    return /\b(PN|P\/N|SN|S\/N|OC|ODC|ODA|PD|SEPD|WO|OS|PIM|SB)\b/.test(normalized)
      || /\b[A-Z]{1,6}[/-]?\d[A-Z0-9./-]{2,}\b/.test(normalized)
      || /\b\d{4,}[A-Z0-9./-]*\b/.test(normalized);
  };

  const montarPerguntaBackend = (texto, contexto = ultimoItemContexto) => {
    if (!contexto?.pn) return texto;
    if (!temIntencaoProcesso(texto) || temIdentificadorExplicito(texto)) return texto;

    const descricao = contexto.descricao_oficial || contexto.termo_encontrado || contexto.termo_usuario || contexto.sugestao_apelido || 'item confirmado anteriormente';
    const apelido = contexto.sugestao_apelido || contexto.termo_usuario || '';
    return `${texto}\n\nContexto conversacional confirmado pelo usuário: a pergunta se refere ao PN ${contexto.pn}, ${descricao}${apelido ? `, também chamado operacionalmente de ${apelido}` : ''}. Pesquise processos de compra, PD/SEPD, OC/ODC/ODA, WO, Repair/Order Book, reparo, status em aberto, embarcado, adquirido ou qualquer caminho logístico que ajude a colocar o item na linha de voo. Não trate este bloco como fala nova do usuário; use apenas para manter o contexto.`;
  };

  const aplicarResultadoConsulta = (result, textoOriginal = '') => {
    const correlacoes = result.data?.contexto?.correlacoes_sugeridas || [];
    const melhorCorrelacao = correlacoes[0] || null;
    let respostaFinal = result.data?.resposta || 'Sem resposta.';
    const acao = result.data?.contexto?.acao_pendente || null;
    if (acao?.id) {
      setAcaoPendente(acao);
      setSenhaAcao('');
      setAcaoMsg(null);
    } else {
      setAcaoPendente(null);
      setSenhaAcao('');
      setAcaoMsg(null);
    }

    if (melhorCorrelacao?.pn) {
      const pendente = { ...melhorCorrelacao, pergunta_original: textoOriginal };
      setApelidoPendente(pendente);
      setUltimoItemContexto(pendente);
      const avisoApelido = isAdmin
        ? `\n\nConfirma que “${String(melhorCorrelacao.sugestao_apelido || melhorCorrelacao.termo_usuario || '').toLowerCase()}” é o mesmo item que “${melhorCorrelacao.descricao_oficial || melhorCorrelacao.termo_encontrado}”? Se sim, responda “sim” que eu cadastro como apelido operacional do PN ${melhorCorrelacao.pn}.`
        : '\n\nIdentifiquei uma possível equivalência de nomenclatura, mas cadastro de apelido operacional precisa ser confirmado por Admin/Dono.';
      if (!/cadastro como apelido|apelido operacional|confirma/i.test(respostaFinal)) respostaFinal += avisoApelido;
    } else {
      setApelidoPendente(null);
      const tokens = result.data?.contexto?.tokens || [];
      if (tokens.length === 1 && temIntencaoProcesso(textoOriginal)) {
        setUltimoItemContexto((prev) => prev || { pn: tokens[0], descricao_oficial: 'item consultado anteriormente' });
      }
    }

    setMensagens((prev) => [...prev, { role: 'assistant', content: respostaFinal }]);
    setFontes(result.data?.contexto?.fontes || []);
    setModulos(result.data?.contexto?.modulos || null);
    setTrilhaSn(result.data?.contexto?.trilha_sn || []);
    setAplicacoesManual(result.data?.contexto?.aplicacoes_manual || []);
  };

  const confirmarApelidoPendente = async () => {
    if (!apelidoPendente) return false;
    const sugestaoAtual = apelidoPendente;

    if (!isAdmin) {
      setMensagens((prev) => [...prev, {
        role: 'assistant',
        content: 'Entendi a confirmação, mas cadastro de apelido operacional precisa ser feito por Admin ou Dono. Vou manter essa correlação como referência para análise do PPU/Admin.',
      }]);
      setUltimoItemContexto(sugestaoAtual);
      setApelidoPendente(null);
      return true;
    }

    try {
      const response = await apiFetch(
        '/chat-lince/apelidos/confirmar',
        {
          method: 'POST',
          headers: buildAuthHeaders(token, { 'Content-Type': 'application/json' }),
          body: JSON.stringify(sugestaoAtual),
        },
        token
      );
      const result = await response.json();
      if (result.status === 'success') {
        setUltimoItemContexto(sugestaoAtual);
        setMensagens((prev) => [...prev, {
          role: 'assistant',
          content: `Perfeito. Cadastrei “${sugestaoAtual.sugestao_apelido || sugestaoAtual.termo_usuario}” como apelido operacional do PN ${sugestaoAtual.pn}. Agora vou retomar a sua pergunta original e verificar compra, PD/OC, WO ou Repair desse item.`,
        }]);

        const perguntaOriginal = sugestaoAtual.pergunta_original || `Existe processo de compra, WO ou Repair em aberto para o PN ${sugestaoAtual.pn}?`;
        const perguntaRetomada = montarPerguntaBackend(perguntaOriginal, sugestaoAtual);
        const consulta = await apiFetch(
          '/chat-lince/perguntar',
          {
            method: 'POST',
            headers: buildAuthHeaders(token, { 'Content-Type': 'application/json' }),
            body: JSON.stringify({ pergunta: perguntaRetomada }),
          },
          token
        );
        const consultaResult = await consulta.json();
        if (consultaResult.status === 'success') {
          aplicarResultadoConsulta(consultaResult, perguntaOriginal);
        } else {
          setMensagens((prev) => [...prev, { role: 'assistant', content: consultaResult.message || 'Apelido cadastrado, mas não consegui retomar a consulta original.' }]);
        }
      } else {
        setMensagens((prev) => [...prev, { role: 'assistant', content: result.message || 'Não consegui cadastrar o apelido operacional.' }]);
      }
    } catch {
      setMensagens((prev) => [...prev, { role: 'assistant', content: 'Falha de comunicação ao cadastrar o apelido operacional.' }]);
    } finally {
      setApelidoPendente(null);
    }

    return true;
  };

  const enviarPergunta = async (e) => {
    e.preventDefault();
    const texto = pergunta.trim();
    if (!texto || consultando) return;

    const respostaConfirmacao = texto.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim();
    if (apelidoPendente && /^(sim|s|confirmo|confirma|isso|e isso|é isso|pode cadastrar|pode sim)$/.test(respostaConfirmacao)) {
      limparComposer();
      setMensagens((prev) => [...prev, { role: 'user', content: texto }]);
      setConsultando(true);
      await confirmarApelidoPendente();
      setConsultando(false);
      return;
    }

    const perguntaBackend = montarPerguntaBackend(texto);

    limparComposer();
    setConsultando(true);
    setMensagens((prev) => [...prev, { role: 'user', content: texto }]);

    try {
      const response = await apiFetch(
        '/chat-lince/perguntar',
        {
          method: 'POST',
          headers: buildAuthHeaders(token, { 'Content-Type': 'application/json' }),
          body: JSON.stringify({ pergunta: perguntaBackend }),
        },
        token
      );
      const result = await response.json();
      if (result.status === 'success') {
        aplicarResultadoConsulta(result, texto);
      } else {
        setMensagens((prev) => [...prev, { role: 'assistant', content: result.message || 'Falha ao consultar o Chat Lince.' }]);
      }
    } catch {
      setMensagens((prev) => [...prev, { role: 'assistant', content: 'Falha de comunicação com o servidor.' }]);
    } finally {
      setConsultando(false);
    }
  };

  const confirmarAcaoExecutor = async (e) => {
    e.preventDefault();
    if (!acaoPendente?.id || !senhaAcao.trim() || executandoAcao) return;
    setExecutandoAcao(true);
    setAcaoMsg(null);
    try {
      const response = await apiFetch(
        `/chat-lince/acoes/${acaoPendente.id}/confirmar`,
        {
          method: 'POST',
          headers: buildAuthHeaders(token, { 'Content-Type': 'application/json' }),
          body: JSON.stringify({ senha: senhaAcao }),
        },
        token
      );
      const result = await response.json();
      if (result.status === 'success') {
        setMensagens((prev) => [...prev, { role: 'assistant', content: `${result.message || 'Alteração executada com sucesso.'}\n\nOperação registrada no log de auditoria do SISHA.` }]);
        setAcaoPendente(null);
        setSenhaAcao('');
        setAcaoMsg({ tipo: 'success', texto: result.message || 'Ação executada.' });
      } else {
        setAcaoMsg({ tipo: 'error', texto: result.message || 'Senha não confirmada ou ação não executada.' });
      }
    } catch {
      setAcaoMsg({ tipo: 'error', texto: 'Falha de comunicação ao confirmar a ação.' });
    } finally {
      setExecutandoAcao(false);
    }
  };

  const analisarDocumento = async (e) => {
    e.preventDefault();
    if (!arquivo || !isAdmin) return;
    setAnalisando(true);
    setDocMsg(null);
    setAnalise(null);
    setDocumentoId(null);
    setDestinoAdmin('');

    const formData = new FormData();
    formData.append('file', arquivo);
    formData.append('tipoDocumento', tipoDocumento);

    try {
      const response = await apiFetch(
        '/chat-lince/documentos/analisar',
        { method: 'POST', headers: buildAuthHeaders(token), body: formData },
        token
      );
      const result = await response.json();
      if (result.status === 'success' || result.status === 'partial_success') {
        const novaAnalise = result.data?.analise
          ? { ...result.data.analise, _arquivo_nome: arquivo?.name || result.data?.documento?.nome_arquivo || '' }
          : null;
        setAnalise(novaAnalise);
        setDestinoAdmin(novaAnalise?.destino_sugerido || safeList(novaAnalise?.destinos_possiveis)[0]?.tabela || 'chat_lince_documentos');
        setDocumentoId(result.data?.documento_id || null);
        setDocMsg({ tipo: result.status === 'success' ? 'success' : 'warn', texto: result.message });
        setArquivo(null);
        if (fileInputRef.current) fileInputRef.current.value = '';
      } else {
        setDocMsg({ tipo: 'error', texto: result.message || 'Falha ao analisar documento.' });
      }
    } catch {
      setDocMsg({ tipo: 'error', texto: 'Falha de comunicação com o servidor.' });
    } finally {
      setAnalisando(false);
    }
  };

  const enviarReciboParaTriagem = () => {
    if (!analise || !isAdmin) return;
    const extracted = analise?.entidades?.recibo || analise?.recibo_extraido || {};
    const candidateItems = safeList(extracted.itens).length
      ? safeList(extracted.itens)
      : registrosSugeridos.map((registro) => registro?.payload || registro?.campos || registro).filter(Boolean);

    const itens = candidateItems.map((item, index) => ({
      sequencia_item: item.sequencia_item || index + 1,
      pn: item.pn || item.part_number || item.identificador || '',
      nsn_pi: item.nsn_pi || item.nsn || item.pi || '',
      nomenclatura: item.nomenclatura || item.descricao || item.description || '',
      quantidade: Number(item.quantidade ?? item.qtd ?? item.qty ?? 1) || 1,
      sn: item.sn || item.serial_number || '',
      localizacao_ppu: item.localizacao_ppu || item.local || '',
      condicao_item: item.condicao_item || 'RECEBIDO_DISPONIVEL',
      observacao_item: item.observacao_item || item.observacao || '',
      inventariado_ppu: false,
      data_garantia: item.data_garantia || '',
      valor_unitario: item.valor_unitario ?? item.preco_unitario ?? '',
      documento_referencia: item.documento_referencia || item.pd || extracted.documento_referencia || '',
      dados_originais: item,
    })).filter((item) => String(item.pn || '').trim());

    if (!itens.length) {
      setDocMsg({ tipo: 'error', texto: 'A IA não estruturou nenhum item com PN. Revise o documento ou use a importação própria de recibos.' });
      return;
    }

    const draft = {
      numero_recibo: extracted.numero_recibo || extracted.numero || extracted.recibo_ref || '',
      tipo_recebimento: extracted.tipo_recebimento || (tipoDocumento === 'recibo_pd' ? 'PD' : 'MATERIAL'),
      data_recebimento: extracted.data_recebimento || extracted.data_entrega || '',
      documento_referencia: extracted.documento_referencia || '',
      fornecedor: extracted.fornecedor || '',
      origem_material: extracted.origem_material || '',
      recebido_por_nome: extracted.recebido_por_nome || extracted.recebido_por || '',
      conferido_por_nome: extracted.conferido_por_nome || extracted.conferido_por || '',
      metodo_importacao: 'IA_CHAT_LINCE',
      arquivo_nome: analise?._arquivo_nome || '',
      chat_lince_documento_id: documentoId,
      is_foc: Boolean(extracted.is_foc),
      observacao: extracted.observacao || 'Rascunho extraído pelo Chat Lince. Revisão humana obrigatória.',
      dados_originais: { classificacao: analise.classificacao, entidades: analise.entidades },
      itens,
    };

    window.sessionStorage.setItem('sisha_receipt_draft', JSON.stringify(draft));
    navigate('/recebimentos');
  };

  const decidirDocumento = async (acao, id = documentoId, destinoOverride = '') => {
    if (!id || !isAdmin) return;
    setDocMsg(null);
    try {
      const response = await apiFetch(
        `/chat-lince/documentos/${id}/${acao}`,
        {
          method: 'POST',
          headers: buildAuthHeaders(token, { 'Content-Type': 'application/json' }),
          body: JSON.stringify({ observacaoAdmin, destinoAdmin: destinoOverride || destinoAdmin }),
        },
        token
      );
      const result = await response.json();
      if (result.status === 'success') {
        setDocMsg({ tipo: 'success', texto: result.message });
        setObservacaoAdmin('');
      } else {
        setDocMsg({ tipo: 'error', texto: result.message || 'Falha na decisão documental.' });
      }
    } catch {
      setDocMsg({ tipo: 'error', texto: 'Falha de comunicação com o servidor.' });
    }
  };


  const exportarNormalizado = async (id = documentoId) => {
    if (!id || !isAdmin) return;
    setDocMsg(null);
    try {
      const response = await apiFetch(
        `/chat-lince/documentos/${id}/exportar-normalizado`,
        { method: 'GET', headers: buildAuthHeaders(token) },
        token
      );
      if (!response.ok) {
        const errorBody = await response.json().catch(() => ({}));
        throw new Error(errorBody.message || 'Falha ao exportar documento normalizado.');
      }
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `SISHA_IA_Normalizado_${id}.xlsx`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
      setDocMsg({ tipo: 'success', texto: 'Arquivo normalizado exportado para conferência/importação assistida.' });
    } catch (error) {
      setDocMsg({ tipo: 'error', texto: error.message || 'Falha ao exportar documento normalizado.' });
    }
  };


  return (
    <div className="space-y-8 animate-fade-in">
      <section className="overflow-hidden rounded-3xl border border-slate-200 bg-white shadow-sm dark:border-slate-700 dark:bg-slate-900">
        <div className="flex flex-col gap-4 border-b border-slate-200 px-5 py-4 dark:border-slate-700 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex min-w-0 items-center gap-3">
            <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-blue-600 text-white shadow-sm">
              <Bot size={22} />
            </div>
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <h1 className="text-xl font-black tracking-tight text-slate-900 dark:text-white">Chat Lince</h1>
                <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2.5 py-1 text-[9px] font-black uppercase tracking-wider text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300">
                  <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" /> ONLINE
                </span>
              </div>
              <p className="mt-0.5 truncate text-xs font-semibold text-slate-500 dark:text-slate-400">
                Assistente logístico do SISHA • cruza fontes, preserva evidências e não grava sem confirmação
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={novaConversa}
              className="inline-flex items-center gap-2 rounded-xl border border-slate-200 px-3 py-2 text-xs font-black text-slate-600 transition hover:bg-slate-50 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
            >
              <RotateCcw size={15} /> NOVA CONVERSA
            </button>
            <button
              type="button"
              onClick={() => setContextoAberto((old) => !old)}
              className="inline-flex items-center gap-2 rounded-xl border border-slate-200 px-3 py-2 text-xs font-black text-slate-600 transition hover:bg-slate-50 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
            >
              <Database size={15} /> FONTES <ChevronDown size={14} className={`transition ${contextoAberto ? 'rotate-180' : ''}`} />
            </button>
          </div>
        </div>

        <div className={`grid min-h-[610px] ${contextoAberto ? 'xl:grid-cols-[minmax(0,1fr)_320px]' : 'grid-cols-1'}`}>
          <div className="flex min-w-0 flex-col bg-white dark:bg-slate-900">
            <div className="h-[520px] overflow-y-auto px-5 py-5 sm:px-8 lg:px-12">
              <div className="mx-auto w-full max-w-4xl">
                {mensagens.map((message, index) => <MessageBubble key={`${message.role}-${index}`} message={message} />)}

                {mensagens.length === 1 && !consultando && (
                  <div className="mt-5 grid gap-2 sm:grid-cols-3">
                    {[
                      'Faça um dossiê completo do PN 528-027-01.',
                      'Onde está este SN e qual a última evidência?',
                      'Cruze PD, Order Book e Recibos deste PN.',
                    ].map((suggestion) => (
                      <button
                        key={suggestion}
                        type="button"
                        onClick={() => { setPergunta(suggestion); window.requestAnimationFrame(() => resizeComposer()); composerRef.current?.focus(); }}
                        className="rounded-2xl border border-slate-200 p-3 text-left text-xs font-bold leading-5 text-slate-600 transition hover:border-blue-300 hover:bg-blue-50/40 hover:text-blue-700 dark:border-slate-700 dark:text-slate-300 dark:hover:border-blue-800 dark:hover:bg-blue-950/20 dark:hover:text-blue-300"
                      >
                        {suggestion}
                      </button>
                    ))}
                  </div>
                )}

                {consultando && (
                  <div className="flex items-center gap-3 py-5 text-sm font-bold text-slate-500 dark:text-slate-400">
                    <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-blue-50 text-blue-600 dark:bg-blue-950/30">
                      <LoaderCircle size={18} className="animate-spin" />
                    </div>
                    <span>Lince está cruzando as fontes do SISHA e validando as evidências...</span>
                  </div>
                )}
                <div ref={conversationEndRef} />
              </div>
            </div>

            {acaoPendente && isAdmin && (
              <form onSubmit={confirmarAcaoExecutor} className="mx-5 mb-3 rounded-2xl border border-amber-200 bg-amber-50 p-4 dark:border-amber-900 dark:bg-amber-950/20 sm:mx-8 lg:mx-12">
                <div className="flex items-start gap-3">
                  <ShieldCheck size={20} className="mt-0.5 shrink-0 text-amber-600" />
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-black text-amber-800 dark:text-amber-200">Ação preparada — confirmação obrigatória</p>
                    <p className="mt-1 text-xs font-semibold text-amber-700 dark:text-amber-300">A senha valida a ação no backend e nunca entra na conversa.</p>
                  </div>
                </div>
                {acaoMsg && <p className={`mt-3 text-sm font-black ${acaoMsg.tipo === 'success' ? 'text-green-700' : 'text-red-700'}`}>{acaoMsg.texto}</p>}
                <div className="mt-3 flex flex-col gap-2 sm:flex-row">
                  <input
                    type="password"
                    value={senhaAcao}
                    onChange={(e) => setSenhaAcao(e.target.value)}
                    placeholder="Senha para autorizar"
                    className="min-w-0 flex-1 rounded-xl border border-amber-300 bg-white px-4 py-3 text-sm font-bold text-slate-900 outline-none focus:border-amber-500 focus:ring-4 focus:ring-amber-500/10 dark:border-amber-800 dark:bg-slate-950 dark:text-white"
                  />
                  <button disabled={executandoAcao || !senhaAcao.trim()} className="inline-flex items-center justify-center gap-2 rounded-xl bg-amber-600 px-5 py-3 text-xs font-black text-white hover:bg-amber-700 disabled:opacity-50">
                    {executandoAcao ? <LoaderCircle size={16} className="animate-spin" /> : <ShieldCheck size={16} />} CONFIRMAR
                  </button>
                  <button type="button" onClick={() => { setAcaoPendente(null); setSenhaAcao(''); setAcaoMsg(null); }} className="rounded-xl bg-slate-200 px-5 py-3 text-xs font-black text-slate-700 hover:bg-slate-300 dark:bg-slate-800 dark:text-slate-200 dark:hover:bg-slate-700">
                    CANCELAR
                  </button>
                </div>
              </form>
            )}

            <div className="border-t border-slate-200 bg-white px-4 py-4 dark:border-slate-700 dark:bg-slate-900 sm:px-8 lg:px-12">
              <form onSubmit={enviarPergunta} className="mx-auto max-w-4xl">
                <div className="rounded-[24px] border border-slate-300 bg-white p-2 shadow-sm transition focus-within:border-blue-400 focus-within:ring-4 focus-within:ring-blue-500/10 dark:border-slate-700 dark:bg-slate-950">
                  <textarea
                    ref={composerRef}
                    rows={1}
                    value={pergunta}
                    onChange={(e) => { setPergunta(e.target.value); resizeComposer(e.target); }}
                    onKeyDown={onComposerKeyDown}
                    placeholder="Pergunte sobre PN, SN, localização, Master OS, PIM, STC, WO, PD/OC, Recibos ou manuais..."
                    className="block h-[52px] max-h-[180px] min-h-[52px] w-full resize-none overflow-y-auto whitespace-pre-wrap break-words border-0 bg-transparent px-3 py-3 text-[15px] font-semibold leading-6 text-slate-900 outline-none placeholder:text-slate-400 dark:text-white"
                  />
                  <div className="flex items-center justify-between gap-3 px-2 pb-1">
                    <span className="text-[10px] font-bold text-slate-400">Enter envia • Shift+Enter quebra linha</span>
                    <button
                      disabled={consultando || !pergunta.trim()}
                      className="inline-flex h-10 w-10 items-center justify-center rounded-xl bg-blue-600 text-white transition hover:bg-blue-700 disabled:cursor-not-allowed disabled:bg-slate-300 dark:disabled:bg-slate-700"
                      title="Enviar"
                    >
                      {consultando ? <LoaderCircle size={17} className="animate-spin" /> : <Send size={17} />}
                    </button>
                  </div>
                </div>
                <p className="mt-2 text-center text-[10px] font-semibold text-slate-400">O Lince diferencia evidência confirmada, intenção documental e pendência. Decisões ambíguas continuam fail-closed.</p>
              </form>
            </div>
          </div>

          {contextoAberto && (
            <aside className="border-t border-slate-200 bg-slate-50/80 p-4 dark:border-slate-700 dark:bg-slate-950/35 xl:border-l xl:border-t-0">
              <div className="mb-4 flex items-center justify-between gap-2">
                <div>
                  <p className="text-xs font-black text-slate-900 dark:text-white">Fontes desta resposta</p>
                  <p className="mt-0.5 text-[10px] font-semibold text-slate-500">Mostra o que realmente foi consultado.</p>
                </div>
                <Database size={17} className="text-blue-600" />
              </div>

              {modulos && Object.entries(modulos).filter(([, value]) => Boolean(value)).length > 0 && (
                <div className="mb-4 flex flex-wrap gap-1.5">
                  {Object.entries(modulos).filter(([, value]) => Boolean(value)).map(([key]) => (
                    <span key={key} className="rounded-full border border-emerald-200 bg-emerald-50 px-2.5 py-1 text-[9px] font-black uppercase tracking-wide text-emerald-700 dark:border-emerald-900 dark:bg-emerald-950/30 dark:text-emerald-300">
                      {key.replaceAll('_', ' ')}
                    </span>
                  ))}
                </div>
              )}

              <div className="max-h-[430px] space-y-2 overflow-y-auto pr-1">
                {fontes.length > 0 ? fontes.map((fonte, index) => (
                  <div key={`${fonte.tabela}-${index}`} className="rounded-xl border border-slate-200 bg-white p-3 dark:border-slate-700 dark:bg-slate-900">
                    <div className="flex items-start justify-between gap-3">
                      <p className="text-xs font-black leading-5 text-slate-800 dark:text-slate-100">{fonte.rotulo || fonte.tabela}</p>
                      <span className="shrink-0 rounded-full bg-blue-50 px-2 py-0.5 text-[9px] font-black text-blue-700 dark:bg-blue-950/30 dark:text-blue-300">{fonte.quantidade}</span>
                    </div>
                    {fonte.motivo && <p className="mt-1 text-[10px] font-semibold leading-4 text-slate-500 dark:text-slate-400">{fonte.motivo}</p>}
                  </div>
                )) : (
                  <div className="rounded-xl border border-dashed border-slate-300 p-4 text-center text-xs font-semibold text-slate-400 dark:border-slate-700">As fontes utilizadas aparecem aqui depois da consulta.</div>
                )}
              </div>

              {trilhaSn.length > 0 && <div className="mt-4"><JsonCard title="Trilha SN / localização" value={trilhaSn} /></div>}
              {aplicacoesManual.length > 0 && <div className="mt-4"><JsonCard title="Aplicação no manual" value={aplicacoesManual} /></div>}

              {isAdmin && (
                <details className="mt-4 rounded-xl border border-slate-200 bg-white p-3 dark:border-slate-700 dark:bg-slate-900">
                  <summary className="cursor-pointer text-[10px] font-black uppercase tracking-wider text-slate-500">Ferramentas administrativas / RAG</summary>
                  <p className="mt-2 text-[10px] font-semibold leading-4 text-slate-500">Reindexa a base documental e as fontes estruturadas sem alterar o estado operacional.</p>
                  {ragMsg && <p className={`mt-2 text-[10px] font-black ${ragMsg.tipo === 'success' ? 'text-green-700 dark:text-green-300' : 'text-red-700 dark:text-red-300'}`}>{ragMsg.texto}</p>}
                  <button type="button" onClick={reindexarRag} disabled={reindexandoRag} className="mt-3 inline-flex w-full items-center justify-center gap-2 rounded-xl bg-slate-900 px-3 py-2.5 text-[10px] font-black text-white hover:bg-slate-800 disabled:opacity-50 dark:bg-slate-700 dark:hover:bg-slate-600">
                    {reindexandoRag ? <LoaderCircle size={14} className="animate-spin" /> : <RefreshCw size={14} />} REINDEXAR BASE
                  </button>
                </details>
              )}
            </aside>
          )}
        </div>
      </section>

      <section className="bg-white dark:bg-slate-800 rounded-3xl p-6 sm:p-8 shadow-sm border border-slate-200 dark:border-slate-700">
        <div className="flex flex-col lg:flex-row lg:items-start lg:justify-between gap-4 mb-6">
          <div>
            <h2 className="text-xl sm:text-2xl font-black text-slate-900 dark:text-white uppercase flex items-center gap-3">
              <FileSearch className="text-emerald-600" /> Documental
            </h2>
            <p className="text-sm text-slate-600 dark:text-slate-300 mt-2 font-semibold">
              O Chat Lince lê o arquivo, sugere classificação, normaliza os registros e os mantém em staging auditável. A importação operacional só ocorre após revisão humana pelo fluxo específico do documento.
            </p>
          </div>
          {!isAdmin && (
            <span className="rounded-full bg-amber-50 dark:bg-amber-900/30 px-4 py-2 text-xs font-black text-amber-700 dark:text-amber-300 uppercase">
              Análise documental restrita a Admin
            </span>
          )}
        </div>

        <form onSubmit={analisarDocumento} className="grid grid-cols-1 lg:grid-cols-4 gap-4 mb-6">
          <select
            value={tipoDocumento}
            onChange={(e) => setTipoDocumento(e.target.value)}
            disabled={!isAdmin}
            className="w-full p-4 bg-white dark:bg-slate-950 border-2 border-slate-200 dark:border-slate-700 rounded-2xl font-bold text-slate-900 dark:text-white"
          >
            {tiposDocumento.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>

          <input
            ref={fileInputRef}
            type="file"
            accept=".pdf,.xlsx,.xls,.csv,.ods,.txt"
            disabled={!isAdmin}
            onChange={(e) => setArquivo(e.target.files?.[0] || null)}
            className="lg:col-span-2 w-full p-4 bg-white dark:bg-slate-950 border-2 border-slate-200 dark:border-slate-700 rounded-2xl font-bold text-slate-900 dark:text-white file:text-slate-900 dark:file:text-white"
          />

          <button disabled={!arquivo || analisando || !isAdmin} className="px-6 py-4 rounded-2xl bg-emerald-600 text-white font-black hover:bg-emerald-700 disabled:opacity-50 flex items-center justify-center gap-2">
            {analisando ? <LoaderCircle size={18} className="animate-spin" /> : <Upload size={18} />} ANALISAR
          </button>
        </form>

        {docMsg && (
          <p className={`font-black mb-6 ${docMsg.tipo === 'success' ? 'text-green-600' : docMsg.tipo === 'warn' ? 'text-amber-600' : 'text-red-600'}`}>
            {docMsg.texto}
          </p>
        )}

        {analise && (
          <div className="space-y-5 rounded-3xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950/30 p-5">
            <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
              <div className="rounded-2xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 p-4">
                <p className="text-[10px] font-black uppercase tracking-[0.2em] text-slate-400">Classificação</p>
                <p className="text-lg font-black text-slate-900 dark:text-white">{analise.classificacao || 'N/A'}</p>
              </div>
              <div className="rounded-2xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 p-4">
                <p className="text-[10px] font-black uppercase tracking-[0.2em] text-slate-400">Destino sugerido</p>
                <p className="text-lg font-black text-slate-900 dark:text-white break-all">{analise.destino_sugerido || 'staging'}</p>
              </div>
              <div className="rounded-2xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 p-4">
                <p className="text-[10px] font-black uppercase tracking-[0.2em] text-slate-400">Confiança</p>
                <p className="text-lg font-black text-slate-900 dark:text-white">{Math.round(Number(analise.confianca || 0) * 100)}%</p>
              </div>
              <div className="rounded-2xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 p-4">
                <p className="text-[10px] font-black uppercase tracking-[0.2em] text-slate-400">Status</p>
                <p className="text-lg font-black text-slate-900 dark:text-white">{documentoId ? 'Pendente Admin' : 'SQL pendente'}</p>
              </div>
            </div>

            <JsonCard title="Resumo" value={analise.resumo} />
            <JsonCard title="Entidades extraídas" value={analise.entidades} />

            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
              <DestinationSelect value={destinoAdmin} onChange={setDestinoAdmin} options={destinosPossiveis} disabled={!isAdmin} />
              <JsonCard title="Ações consultivas sugeridas" value={acoesConsultivas} />
            </div>

            {(osEventos.length > 0 || snTrilhaSugerida.length > 0) && (
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                <JsonCard title="OS/SN sugeridos para staging" value={osEventos} />
                <JsonCard title="Trilha SN sugerida" value={snTrilhaSugerida} />
              </div>
            )}

            {registrosSugeridos.length > 0 && (
              <div className="rounded-2xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 p-4">
                <p className="text-[10px] font-black uppercase tracking-[0.2em] text-slate-400 mb-3">Registros sugeridos</p>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  {registrosSugeridos.map((registro, index) => (
                    <div key={`${registro.identificador || index}-${index}`} className="rounded-2xl border border-slate-100 dark:border-slate-700 bg-slate-50 dark:bg-slate-950/40 p-4">
                      <p className="font-black text-slate-900 dark:text-white break-all">{registro.identificador || 'Sem identificador'}</p>
                      <p className="text-xs font-bold text-slate-500 uppercase">{registro.tipo_registro || 'Registro'} • {registro.tabela_sugerida || 'staging'} • {registro.acao_sugerida || 'Validar'}</p>
                      <p className="text-xs text-slate-600 dark:text-slate-300 mt-2">{registro.observacao || 'Sem observação.'}</p>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {(riscos.length > 0 || passos.length > 0) && (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <JsonCard title="Riscos" value={riscos} />
                <JsonCard title="Próximos passos" value={passos} />
              </div>
            )}

            {isAdmin && documentoId && (
              <div className="rounded-2xl border border-blue-100 dark:border-blue-900 bg-blue-50 dark:bg-blue-950/20 p-4 space-y-4">
                <textarea
                  value={observacaoAdmin}
                  onChange={(e) => setObservacaoAdmin(e.target.value)}
                  placeholder="Observação do Admin antes de confirmar ou rejeitar..."
                  className="w-full min-h-24 p-4 rounded-2xl border-2 border-blue-100 dark:border-blue-900 bg-white dark:bg-slate-950 text-slate-900 dark:text-white font-semibold placeholder:text-slate-400"
                />
                <div className="flex items-start gap-2 rounded-2xl bg-white/70 dark:bg-slate-950/40 border border-blue-100 dark:border-blue-900 p-3 text-xs font-bold text-slate-600 dark:text-slate-300">
                  <ClipboardCheck size={16} className="text-blue-600 shrink-0 mt-0.5" />
                  <span>Confirmar valida o documento e cria registros normalizados em staging. Nenhuma tabela operacional é alterada automaticamente; os registros podem ser exportados para conferência e importação assistida.</span>
                </div>
                <div className="flex flex-col sm:flex-row justify-end gap-3">
                  {isReceiptAnalysis && (
                    <button type="button" onClick={enviarReciboParaTriagem} className="px-5 py-3 rounded-2xl bg-blue-600 text-white font-black hover:bg-blue-700 flex items-center justify-center gap-2">
                      <ClipboardCheck size={18} /> ABRIR TRIAGEM DO RECIBO
                    </button>
                  )}
                  <button type="button" onClick={() => exportarNormalizado()} className="px-5 py-3 rounded-2xl bg-slate-700 text-white font-black hover:bg-slate-800 flex items-center justify-center gap-2">
                    <Download size={18} /> EXPORTAR NORMALIZADO
                  </button>
                  <button type="button" onClick={() => decidirDocumento('rejeitar')} className="px-5 py-3 rounded-2xl bg-red-600 text-white font-black hover:bg-red-700 flex items-center justify-center gap-2">
                    <XCircle size={18} /> REJEITAR
                  </button>
                  <button type="button" onClick={() => decidirDocumento('confirmar')} className="px-5 py-3 rounded-2xl bg-green-600 text-white font-black hover:bg-green-700 flex items-center justify-center gap-2">
                    <CheckCircle2 size={18} /> CONFIRMAR DESTINO
                  </button>
                </div>
              </div>
            )}
          </div>
        )}
      </section>


      {isAdmin && (
        <div className="rounded-2xl border border-blue-100 dark:border-blue-900 bg-blue-50/60 dark:bg-blue-950/20 px-4 py-3 text-xs font-bold text-blue-800 dark:text-blue-200">
          Pendências administrativas e dúvidas do Help Desk agora são tratadas na Central de Pendências em Atualizar Sistema.
        </div>
      )}
    </div>
  );
}
