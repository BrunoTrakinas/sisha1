import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Bot, FileSearch, Send, Upload, CheckCircle2, XCircle, LoaderCircle, Database, ShieldCheck, Compass, Layers, ClipboardCheck, MessageSquare } from 'lucide-react';
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
  return (
    <div className={`flex ${mine ? 'justify-end' : 'justify-start'}`}>
      <div className={`max-w-[92%] rounded-3xl px-5 py-4 shadow-sm border ${mine
        ? 'bg-blue-600 text-white border-blue-500'
        : 'bg-white dark:bg-slate-800 text-slate-800 dark:text-slate-100 border-slate-200 dark:border-slate-700'
      }`}>
        <p className="text-sm font-semibold whitespace-pre-wrap leading-relaxed">{message.content}</p>
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
  const isAdmin = ['admin', 'dono'].includes(user?.role);
  const fileInputRef = useRef(null);

  const [pergunta, setPergunta] = useState('');
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
  const [pendentes, setPendentes] = useState([]);
  const [carregandoPendentes, setCarregandoPendentes] = useState(false);
  const [helpdesk, setHelpdesk] = useState([]);
  const [carregandoHelpdesk, setCarregandoHelpdesk] = useState(false);
  const [respostasHelpdesk, setRespostasHelpdesk] = useState({});
  const [helpdeskMsg, setHelpdeskMsg] = useState(null);

  const registrosSugeridos = useMemo(() => safeList(analise?.registros_sugeridos), [analise]);
  const riscos = useMemo(() => safeList(analise?.riscos), [analise]);
  const passos = useMemo(() => safeList(analise?.proximos_passos), [analise]);
  const destinosPossiveis = useMemo(() => safeList(analise?.destinos_possiveis), [analise]);
  const acoesConsultivas = useMemo(() => safeList(analise?.acoes_consultivas), [analise]);
  const osEventos = useMemo(() => safeList(analise?.os_eventos_sugeridos), [analise]);
  const snTrilhaSugerida = useMemo(() => safeList(analise?.sn_trilha_sugerida), [analise]);

  const carregarPendentes = async () => {
    if (!isAdmin || !token) return;
    setCarregandoPendentes(true);
    try {
      const response = await apiFetch('/chat-lince/documentos?status=PENDENTE_CONFIRMACAO', {}, token);
      const result = await response.json();
      if (result.status === 'success') setPendentes(result.data || []);
    } catch {
      // mantém a tela silenciosa para não poluir o fluxo principal
    } finally {
      setCarregandoPendentes(false);
    }
  };


  const carregarHelpdesk = async () => {
    if (!isAdmin || !token) return;
    setCarregandoHelpdesk(true);
    try {
      const response = await apiFetch('/chat-lince/helpdesk?status=ABERTO', {}, token);
      const result = await response.json();
      if (result.status === 'success') setHelpdesk(result.data || []);
    } catch {
      // pendências humanas não devem quebrar o chat
    } finally {
      setCarregandoHelpdesk(false);
    }
  };

  useEffect(() => {
    carregarPendentes();
    carregarHelpdesk();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAdmin, token]);

  const normalizarTexto = (value = '') => String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase();

  const temIntencaoProcesso = (value = '') => /\b(WO|WORK\s*ORDER|REPAIR|REPARO|RECEX|PROCESSO|COMPRA|AQUISICAO|AQUISICAO|ADQUIRIDO|PD|SEPD|OC|ODC|ODA|COTACAO|PEDIDO|SUPLEMENTACAO|EMBARCADO|EMBARCADA|ABERTO|ABERTA|ANDAMENTO|LINHA\s+DE\s+VOO|DISPONIBILIDADE|INDISPONIBILIDADE)\b/.test(normalizarTexto(value));

  const temIdentificadorExplicito = (value = '') => {
    const normalized = normalizarTexto(value);
    return /\b(PN|P\/N|SN|S\/N|OC|ODC|ODA|PD|SEPD|WO|OS|PIM|SB)\b/.test(normalized)
      || /\b[A-Z]{1,6}[\-\/]?\d[A-Z0-9.\-\/]{2,}\b/.test(normalized)
      || /\b\d{4,}[A-Z0-9.\-\/]*\b/.test(normalized);
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
    if (isAdmin) carregarHelpdesk();
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
      setPergunta('');
      setMensagens((prev) => [...prev, { role: 'user', content: texto }]);
      setConsultando(true);
      await confirmarApelidoPendente();
      setConsultando(false);
      return;
    }

    const perguntaBackend = montarPerguntaBackend(texto);

    setPergunta('');
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
        const novaAnalise = result.data?.analise || null;
        setAnalise(novaAnalise);
        setDestinoAdmin(novaAnalise?.destino_sugerido || safeList(novaAnalise?.destinos_possiveis)[0]?.tabela || 'chat_lince_documentos');
        setDocumentoId(result.data?.documento_id || null);
        setDocMsg({ tipo: result.status === 'success' ? 'success' : 'warn', texto: result.message });
        setArquivo(null);
        if (fileInputRef.current) fileInputRef.current.value = '';
        carregarPendentes();
      } else {
        setDocMsg({ tipo: 'error', texto: result.message || 'Falha ao analisar documento.' });
      }
    } catch {
      setDocMsg({ tipo: 'error', texto: 'Falha de comunicação com o servidor.' });
    } finally {
      setAnalisando(false);
    }
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
        carregarPendentes();
      } else {
        setDocMsg({ tipo: 'error', texto: result.message || 'Falha na decisão documental.' });
      }
    } catch {
      setDocMsg({ tipo: 'error', texto: 'Falha de comunicação com o servidor.' });
    }
  };


  const responderHelpdesk = async (id) => {
    const respostaAdmin = String(respostasHelpdesk[id] || '').trim();
    if (!respostaAdmin || !isAdmin) return;
    setHelpdeskMsg(null);
    try {
      const response = await apiFetch(
        `/chat-lince/helpdesk/${id}/responder`,
        {
          method: 'POST',
          headers: buildAuthHeaders(token, { 'Content-Type': 'application/json' }),
          body: JSON.stringify({ respostaAdmin, responderPeloChat: true }),
        },
        token
      );
      const result = await response.json();
      if (result.status === 'success') {
        setHelpdeskMsg({ tipo: 'success', texto: result.message });
        setRespostasHelpdesk((prev) => ({ ...prev, [id]: '' }));
        carregarHelpdesk();
      } else {
        setHelpdeskMsg({ tipo: 'error', texto: result.message || 'Falha ao responder pendência.' });
      }
    } catch {
      setHelpdeskMsg({ tipo: 'error', texto: 'Falha de comunicação com o servidor.' });
    }
  };

  return (
    <div className="space-y-8 animate-fade-in">
      <section className="bg-white dark:bg-slate-800 rounded-3xl p-6 sm:p-8 shadow-sm border border-slate-200 dark:border-slate-700">
        <div className="flex flex-col lg:flex-row lg:items-start lg:justify-between gap-4 mb-6">
          <div>
            <h1 className="text-2xl sm:text-3xl font-black text-slate-900 dark:text-white flex items-center gap-3 uppercase">
              <Bot className="text-blue-600" /> Chat Lince
            </h1>
            <p className="text-sm text-slate-600 dark:text-slate-300 mt-2 font-semibold">
              IA consultiva e documental do SISHA-1. Integrada a PN/SN, WO, OC/PD, Manual/Dicionário, Política de Estoque, Custo Operacional, Gerador de Necessidades e Help Desk PPU.
            </p>
          </div>
          <span className="inline-flex items-center gap-2 rounded-full bg-blue-50 dark:bg-blue-900/30 px-4 py-2 text-xs font-black text-blue-700 dark:text-blue-300 uppercase tracking-widest">
            <ShieldCheck size={14} /> Não grava sem confirmação
          </span>
        </div>

        <div className="grid grid-cols-1 xl:grid-cols-3 gap-6">
          <div className="xl:col-span-2 rounded-3xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950/30 overflow-hidden">
            <div className="p-5 border-b border-slate-200 dark:border-slate-700 bg-white/80 dark:bg-slate-900/60">
              <h2 className="text-xs font-black uppercase tracking-[0.2em] text-slate-500 dark:text-slate-400">Consulta logística Premium</h2>
            </div>

            <div className="h-[430px] overflow-y-auto p-5 space-y-4">
              {mensagens.map((message, index) => <MessageBubble key={`${message.role}-${index}`} message={message} />)}
              {consultando && (
                <div className="flex items-center gap-2 text-sm font-black text-blue-600">
                  <LoaderCircle size={18} className="animate-spin" /> Chat Lince cruzando manual, PN, SN, OC, PD, WO, políticas, custo e necessidades...
                </div>
              )}
            </div>

            <form onSubmit={enviarPergunta} className="p-4 border-t border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 flex flex-col sm:flex-row gap-3">
              <input
                value={pergunta}
                onChange={(e) => setPergunta(e.target.value)}
                placeholder="Ex.: Onde está o SN X? Onde esse cartridge é aplicado no manual? Esse PN tem OC/PD/WO?"
                className="flex-1 p-4 rounded-2xl border-2 border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 text-slate-900 dark:text-white font-bold placeholder:text-slate-400"
              />
              <button disabled={consultando || !pergunta.trim()} className="px-6 py-4 rounded-2xl bg-blue-600 text-white font-black hover:bg-blue-700 disabled:opacity-50 flex items-center justify-center gap-2">
                <Send size={18} /> ENVIAR
              </button>
            </form>
          </div>

          <aside className="rounded-3xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 p-5 space-y-4">
            <div className="flex items-center gap-2 text-slate-900 dark:text-white">
              <Database size={18} className="text-blue-600" />
              <h3 className="font-black uppercase text-sm">Contexto usado</h3>
            </div>

            {modulos && (
              <div className="rounded-2xl bg-blue-50 dark:bg-blue-950/20 border border-blue-100 dark:border-blue-900 p-4">
                <p className="text-[10px] font-black uppercase tracking-[0.2em] text-blue-700 dark:text-blue-300 mb-2">Módulos acionados</p>
                <div className="grid grid-cols-1 gap-2">
                  {Object.entries(modulos).map(([key, value]) => (
                    <div key={key} className="flex items-center justify-between gap-2 text-xs font-black text-slate-700 dark:text-slate-200">
                      <span>{key.replaceAll('_', ' ')}</span>
                      <span className={value ? 'text-green-600' : 'text-slate-400'}>{value ? 'SIM' : 'NÃO'}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {trilhaSn.length > 0 && <JsonCard title="Trilha SN / localização" value={trilhaSn} />}
            {aplicacoesManual.length > 0 && <JsonCard title="Aplicação no manual/dicionário" value={aplicacoesManual} />}

            {fontes.length > 0 ? fontes.map((fonte, index) => (
              <div key={`${fonte.tabela}-${index}`} className="rounded-2xl bg-slate-50 dark:bg-slate-950/50 border border-slate-100 dark:border-slate-700 p-4">
                <p className="font-black text-slate-800 dark:text-slate-100">{fonte.tabela}</p>
                <p className="text-xs font-bold text-slate-500">{fonte.quantidade} registro(s). {fonte.motivo || ''}</p>
              </div>
            )) : (
              <p className="text-sm font-semibold text-slate-500 dark:text-slate-400">As fontes aparecem aqui após cada consulta.</p>
            )}
          </aside>
        </div>
      </section>

      <section className="bg-white dark:bg-slate-800 rounded-3xl p-6 sm:p-8 shadow-sm border border-slate-200 dark:border-slate-700">
        <div className="flex flex-col lg:flex-row lg:items-start lg:justify-between gap-4 mb-6">
          <div>
            <h2 className="text-xl sm:text-2xl font-black text-slate-900 dark:text-white uppercase flex items-center gap-3">
              <FileSearch className="text-emerald-600" /> Documental
            </h2>
            <p className="text-sm text-slate-600 dark:text-slate-300 mt-2 font-semibold">
              O Chat Lince lê o arquivo, sugere classificação, pergunta/mostra a tabela de destino e deixa o resultado em staging para confirmação do Admin.
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
                  <span>Confirmar grava o documento como validado, registra auditoria e mantém OS de instalação/remoção em staging até você enviar o modelo oficial.</span>
                </div>
                <div className="flex flex-col sm:flex-row justify-end gap-3">
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
        <section className="bg-white dark:bg-slate-800 rounded-3xl p-6 sm:p-8 shadow-sm border border-slate-200 dark:border-slate-700">
          <div className="flex items-center justify-between gap-4 mb-6">
            <div>
              <h2 className="text-xl font-black text-slate-900 dark:text-white uppercase flex items-center gap-3">
                <MessageSquare className="text-blue-600" /> Help Desk do Chat Lince
              </h2>
              <p className="text-xs font-semibold text-slate-500 dark:text-slate-400 mt-1">Dúvidas que a IA não respondeu com segurança e enviou para análise humana do PPU/Admin.</p>
            </div>
            <button onClick={carregarHelpdesk} disabled={carregandoHelpdesk} className="px-5 py-3 rounded-2xl bg-blue-600 text-white font-black hover:bg-blue-700 disabled:opacity-50">
              {carregandoHelpdesk ? 'ATUALIZANDO...' : 'ATUALIZAR'}
            </button>
          </div>

          {helpdeskMsg && (
            <p className={`font-black mb-6 ${helpdeskMsg.tipo === 'success' ? 'text-green-600' : 'text-red-600'}`}>{helpdeskMsg.texto}</p>
          )}

          {helpdesk.length > 0 ? (
            <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
              {helpdesk.map((ticket) => (
                <div key={ticket.id} className="rounded-3xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950/30 p-5 space-y-4">
                  <div>
                    <p className="text-[10px] font-black uppercase tracking-[0.2em] text-blue-600 dark:text-blue-300">{ticket.protocolo || ticket.status || 'ABERTO'}</p>
                    <h3 className="font-black text-slate-900 dark:text-white">{ticket.termo_pesquisado || 'Dúvida sem termo detectado'}</h3>
                    <p className="text-xs font-semibold text-slate-500">{ticket.usuario_email || 'Usuário'} • {ticket.created_at ? new Date(ticket.created_at).toLocaleString('pt-BR') : 'sem data'}</p>
                  </div>
                  <div className="rounded-2xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 p-4">
                    <p className="text-[10px] font-black uppercase tracking-[0.2em] text-slate-400 mb-2">Pergunta original</p>
                    <p className="text-sm font-semibold text-slate-700 dark:text-slate-200 whitespace-pre-wrap">{ticket.pergunta_original}</p>
                  </div>
                  <textarea
                    value={respostasHelpdesk[ticket.id] || ''}
                    onChange={(e) => setRespostasHelpdesk((prev) => ({ ...prev, [ticket.id]: e.target.value }))}
                    placeholder="Resposta do PPU/Admin para devolver ao usuário ou registrar como resolvido..."
                    className="w-full min-h-28 p-4 rounded-2xl border-2 border-blue-100 dark:border-blue-900 bg-white dark:bg-slate-950 text-slate-900 dark:text-white font-semibold placeholder:text-slate-400"
                  />
                  <div className="flex justify-end">
                    <button onClick={() => responderHelpdesk(ticket.id)} disabled={!String(respostasHelpdesk[ticket.id] || '').trim()} className="px-5 py-3 rounded-2xl bg-green-600 text-white font-black hover:bg-green-700 disabled:opacity-50">
                      RESPONDER / MARCAR RESOLVIDO
                    </button>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="rounded-2xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950/30 p-5">
              <p className="text-sm font-bold text-slate-600 dark:text-slate-300">Nenhuma dúvida aberta no Help Desk do Chat Lince.</p>
            </div>
          )}
        </section>
      )}

      {isAdmin && (
        <section className="bg-white dark:bg-slate-800 rounded-3xl p-6 sm:p-8 shadow-sm border border-slate-200 dark:border-slate-700">
          <div className="flex items-center justify-between gap-4 mb-6">
            <div>
              <h2 className="text-xl font-black text-slate-900 dark:text-white uppercase">Pendências do Chat Lince</h2>
              <p className="text-xs font-semibold text-slate-500 dark:text-slate-400 mt-1">Documentos analisados aguardando confirmação humana.</p>
            </div>
            <button onClick={carregarPendentes} disabled={carregandoPendentes} className="px-5 py-3 rounded-2xl bg-slate-900 text-white font-black hover:bg-slate-800 disabled:opacity-50">
              {carregandoPendentes ? 'ATUALIZANDO...' : 'ATUALIZAR'}
            </button>
          </div>

          {pendentes.length > 0 ? (
            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
              {pendentes.map((doc) => (
                <div key={doc.id} className="rounded-3xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950/30 p-5 space-y-3">
                  <div>
                    <p className="text-[10px] font-black uppercase tracking-[0.2em] text-slate-400">{doc.classificacao || doc.tipo_documento}</p>
                    <h3 className="font-black text-slate-900 dark:text-white break-words">{doc.nome_arquivo}</h3>
                    <p className="text-xs font-semibold text-slate-500">{doc.created_by_email || 'Sistema'} • {doc.created_at ? new Date(doc.created_at).toLocaleString('pt-BR') : 'sem data'}</p>
                  </div>
                  <div className="flex flex-wrap gap-2 text-[10px] font-black uppercase">
                    <span className="inline-flex items-center gap-1 rounded-full bg-blue-50 dark:bg-blue-950/30 text-blue-700 dark:text-blue-300 px-3 py-1"><Compass size={12} /> {doc.destino_sugerido || 'staging'}</span>
                    <span className="inline-flex items-center gap-1 rounded-full bg-slate-100 dark:bg-slate-900 text-slate-600 dark:text-slate-300 px-3 py-1"><Layers size={12} /> {Math.round(Number(doc.confianca || 0) * 100)}%</span>
                  </div>
                  <p className="text-sm text-slate-700 dark:text-slate-300 line-clamp-4">{doc.resumo || 'Sem resumo.'}</p>
                  <div className="flex gap-2">
                    <button onClick={() => decidirDocumento('rejeitar', doc.id)} className="flex-1 px-4 py-3 rounded-2xl bg-red-600 text-white text-xs font-black hover:bg-red-700">REJEITAR</button>
                    <button onClick={() => decidirDocumento('confirmar', doc.id, doc.destino_sugerido)} className="flex-1 px-4 py-3 rounded-2xl bg-green-600 text-white text-xs font-black hover:bg-green-700">CONFIRMAR</button>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="rounded-2xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950/30 p-5">
              <p className="text-sm font-bold text-slate-600 dark:text-slate-300">Nenhuma pendência documental no momento.</p>
            </div>
          )}
        </section>
      )}
    </div>
  );
}
