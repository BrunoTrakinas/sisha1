import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  ArrowRightLeft,
  Boxes,
  Download,
  Edit3,
  Eye,
  FileText,
  History,
  MapPin,
  Plus,
  RefreshCcw,
  Save,
  Search,
  Settings2,
  ShieldCheck,
  Trash2,
  X,
} from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { API_BASE_URL, apiFetch, buildAuthHeaders } from '../lib/api';
import MaintenanceProgramModal from '../components/MaintenanceProgramModal';
import EquipmentOperationsModal from '../components/EquipmentOperationsModal';
import ReliabilityAnalysisModal from '../components/ReliabilityAnalysisModal';

const inputClass = 'w-full px-3 py-2.5 rounded-xl border-2 border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-900 dark:text-white font-bold outline-none focus:border-blue-500';
const labelClass = 'block text-[10px] font-black uppercase tracking-wider text-slate-500 dark:text-slate-400 mb-1';

const categoryOptions = [
  ['PPU', 'PPU'],
  ['OFICINA', 'Oficina do Esquadrão'],
  ['RECEX', 'RECEX'],
  ['GANM', 'GANM'],
  ['WO_EXTERIOR', 'WO / Reparo exterior'],
  ['REPARO_EXTERNO', 'Reparo externo / Leonardo'],
  ['STC', 'STC'],
  ['GARANTIA', 'Garantia / Fabricante'],
  ['AERONAVE', 'Aeronave'],
  ['TRANSITO', 'Em trânsito'],
  ['DESFAZIMENTO', 'Desfazimento'],
  ['DESCONHECIDO', 'Desconhecido'],
];

const conditionOptions = [
  ['PRONTO_USO', 'Pronto para uso'],
  ['AVARIADO', 'Avariado'],
  ['POSSIVEL_PANE', 'Possível pane'],
  ['EM_REPARO', 'Em reparo'],
  ['AGUARDANDO_REPARO', 'Aguardando reparo'],
  ['QUARENTENA', 'Quarentena'],
  ['AGUARDANDO_DESFAZIMENTO', 'Aguardando desfazimento'],
  ['INSTALADO', 'Instalado'],
  ['DESCONHECIDA', 'Desconhecida'],
];

const eventTypeOptions = [
  ['AJUSTE_MANUAL', 'Ajuste manual / conferência física'],
  ['ENTRADA_PPU', 'Entrada no PPU'],
  ['SAIDA_PPU', 'Saída do PPU'],
  ['INSTALACAO_ANV', 'Instalação em aeronave'],
  ['REMOCAO_ANV', 'Remoção de aeronave'],
  ['ENVIO_RECEX', 'Envio ao RECEX'],
  ['ENVIO_GANM', 'Envio ao GANM'],
  ['ENVIO_WO', 'Envio por WO'],
  ['RETORNO_WO', 'Retorno de WO'],
  ['ENVIO_STC', 'Envio por STC'],
  ['RETORNO_STC', 'Retorno de STC'],
  ['ENVIO_GARANTIA', 'Envio em garantia'],
  ['RETORNO_GARANTIA', 'Retorno de garantia'],
  ['DESFAZIMENTO', 'Destinação para desfazimento'],
  ['OUTRO', 'Outro evento'],
];

const confidenceOptions = [
  ['CONFIRMADA', 'Confirmada'],
  ['ALTA', 'Alta confiança'],
  ['PROVAVEL', 'Provável'],
  ['CONFLITANTE', 'Conflitante'],
  ['DESCONHECIDA', 'Desconhecida'],
];

function normalizeUpper(value) {
  return String(value || '').trim().toUpperCase();
}

function padDatePart(value) {
  return String(value).padStart(2, '0');
}

function toLocalDateInput(value = new Date()) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return `${date.getFullYear()}-${padDatePart(date.getMonth() + 1)}-${padDatePart(date.getDate())}`;
}

function toLocalDateTimeInput(value = new Date()) {
  if (typeof value === 'string') {
    const text = value.trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return `${text}T00:00`;
    if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(text)) return text;
  }
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return `${toLocalDateInput(date)}T${padDatePart(date.getHours())}:${padDatePart(date.getMinutes())}`;
}

function localDateTimeToIso(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  const date = new Date(text);
  return Number.isNaN(date.getTime()) ? text : date.toISOString();
}

function formatDate(value, withTime = false) {
  if (!value) return '—';
  const text = String(value).trim();
  const dateOnly = text.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  const date = dateOnly
    ? new Date(Number(dateOnly[1]), Number(dateOnly[2]) - 1, Number(dateOnly[3]))
    : new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return withTime ? date.toLocaleString('pt-BR') : date.toLocaleDateString('pt-BR');
}

function formatEquipmentEventEffectiveDate(event) {
  if (
    event?.tipo_evento === 'INVENTARIO_EQUIPAMENTOS' &&
    event?.payload?.data_snapshot
  ) {
    return `${formatDate(event.payload.data_snapshot)} • horário efetivo não informado`;
  }
  return formatDate(event?.data_evento, true);
}

function formatMoneyReference(value, currency = 'USD') {
  const amount = Number(value || 0);
  if (!Number.isFinite(amount)) return `${currency || 'USD'} 0,00`;
  try {
    return new Intl.NumberFormat('pt-BR', { style: 'currency', currency: currency || 'USD' }).format(amount);
  } catch {
    return `${currency || 'USD'} ${amount.toLocaleString('pt-BR', { minimumFractionDigits: 2 })}`;
  }
}

function categoryLabel(value) {
  return categoryOptions.find(([key]) => key === value)?.[1] || value || 'Não informado';
}

function conditionLabel(value) {
  return conditionOptions.find(([key]) => key === value)?.[1] || value || 'Não informada';
}


const eventUiLabels = {
  CADASTRO_INICIAL: 'Cadastro inicial',
  INVENTARIO_EQUIPAMENTOS: 'Inventário de localização',
  CONTROLE_CRITICO_LOCALIZACAO: 'Controle de Equipamentos Críticos',
  CORRECAO_CADASTRAL: 'Correção de cadastro',
  ATUALIZACAO_CADASTRAL: 'Atualização de cadastro',
  AJUSTE_MANUAL: 'Conferência / movimentação manual',
  ENTRADA_PPU: 'Entrada no PPU',
  SAIDA_PPU: 'Saída do PPU',
  INSTALACAO_ANV: 'Instalação em aeronave',
  REMOCAO_ANV: 'Remoção de aeronave',
  TRANSFERENCIA_OS_PIM: 'Transferência por OS / PIM',
  MOVIMENTACAO_OS_PIM: 'Movimentação por OS / PIM',
  ENVIO_RECEX: 'Envio ao RECEX',
  ENVIO_GANM: 'Envio ao GANM',
  ENVIO_WO: 'Envio para reparo por WO',
  RETORNO_WO: 'Retorno de reparo por WO',
  ENVIO_STC: 'Envio por STC',
  RETORNO_STC: 'Retorno por STC',
  ENVIO_GARANTIA: 'Envio em garantia',
  RETORNO_GARANTIA: 'Retorno de garantia',
  RECEBIMENTO: 'Recebimento de material',
  RECONCILIACAO_LOCALIZACAO: 'Confirmação de localização',
  CONFLITO_LOCALIZACAO: 'Divergência de localização',
  EVIDENCIA_LOCALIZACAO: 'Evidência de localização',
  EVIDENCIA_HISTORICA_LOCALIZACAO: 'Histórico de localização',
  DESFAZIMENTO: 'Destinação para desfazimento',
};

const sourceUiLabels = {
  INVENTARIO_EQUIPAMENTOS: 'Inventário de localização',
  INVENTARIO_PPU: 'Inventário do PPU',
  PPU: 'Inventário do PPU',
  PPU_INVENTARIO: 'Inventário do PPU',
  CONTROLE_CRITICOS: 'Controle de Equipamentos Críticos',
  CONTROLE_CRITICO: 'Controle de Equipamentos Críticos',
  MASTER_OS: 'Master OS — Divisão de Planejamento',
  OS_PIM: 'OS / PIM',
  OS: 'Ordem de Serviço (OS)',
  OSR: 'Ordem de Serviço de Reparo (OSR)',
  PIM: 'PIM',
  WO: 'Ordem de reparo (WO)',
  STC: 'Movimentação por STC',
  RECIBO: 'Recibo de Material',
  ORDER_BOOK: 'Order Book Leonardo',
  RECONCILIACAO: 'Conferência de localização',
  MANUAL: 'Registro manual',
  CADASTRO_MANUAL: 'Relação de Equipamentos',
  CADASTRO_MESTRE: 'Relação de Equipamentos',
  BACKEND_AUDITORIA_PAIOL: 'Auditoria de localização do PPU',
  SAIDA_PPU: 'Registro de saída do PPU',
  CONTROLE_INSPECAO: 'Controle de Inspeção',
  PRICE_LIST: 'Price List Leonardo',
  RFQ: 'Cotações / RFQ',
  CORRECAO_CADASTRAL: 'Correção de cadastro',
};

const statusUiLabels = {
  CADASTRADO: 'Cadastrado',
  INSTALADO: 'Instalado',
  REMOVIDO: 'Removido',
  MOVIMENTADO: 'Movimentado',
  REMOCAO_DESTINO_A_CONFIRMAR: 'Removido — destino a confirmar',
  EM_REPARO: 'Em reparo',
  AGUARDANDO_REPARO: 'Aguardando reparo',
  PRONTO_USO: 'Pronto para uso',
  DESCONHECIDO: 'Não determinado',
};

const statusOptions = Object.entries(statusUiLabels);

function humanizeCode(value) {
  const raw = String(value || '').trim();
  if (!raw) return 'Não informado';
  return raw.replace(/_/g, ' ').toLocaleLowerCase('pt-BR').replace(/(^|\s)([a-záàâãéêíóôõúç])/g, (_, prefix, letter) => `${prefix}${letter.toLocaleUpperCase('pt-BR')}`);
}

function eventTypeLabel(value) {
  const key = normalizeUpper(value);
  return eventUiLabels[key] || eventTypeOptions.find(([code]) => code === key)?.[1] || humanizeCode(value);
}

function documentTypeLabel(value) {
  const key = normalizeUpper(value);
  return sourceUiLabels[key] || (key ? humanizeCode(key) : 'Documento');
}

function statusLabel(value) {
  const key = normalizeUpper(value);
  return statusUiLabels[key] || (key ? humanizeCode(key) : 'Não informado');
}

function confidenceLabel(value) {
  return confidenceOptions.find(([key]) => key === normalizeUpper(value))?.[1] || humanizeCode(value || 'DESCONHECIDA');
}

function humanizeDocumentReference(value, documentType = '') {
  const raw = String(value || '').trim();
  if (!raw) return '';
  const normalized = normalizeUpper(raw).replace(/[^A-Z0-9]+/g, ' ');
  const compact = normalized.replace(/ /g, '');
  if (/INVENTARIO.*PPU|PPU.*INVENTARIO|INVENTARIOGERALPPU/.test(normalized) || /INVENTARIO.*PPU|PPU.*INVENTARIO|INVENTARIOGERALPPU/.test(compact)) return 'Inventário do PPU';
  if (/CONTROLE.*CRITIC/.test(normalized)) return 'Controle de Equipamentos Críticos';
  if (/MASTER.*OS/.test(normalized)) return 'Master OS — Divisão de Planejamento';
  if (/ORDER.*BOOK/.test(normalized)) return 'Order Book Leonardo';
  if (/RECIBO/.test(normalized)) return 'Recibo de Material';
  if (/CADASTRO.*MESTRE/.test(normalized)) return 'Relação de Equipamentos';
  if (/AUDITORIA.*PAIOL/.test(normalized)) return 'Auditoria de localização do PPU';
  if (/SAIDA.*PPU/.test(normalized)) return 'Registro de saída do PPU';
  if (/CONTROLE.*INSPECAO/.test(normalized)) return 'Controle de Inspeção';
  if (/PRICE.*LIST/.test(normalized)) return 'Price List Leonardo';
  if (/RFQ|COTAC/.test(normalized)) return 'Cotações / RFQ';
  const typeLabel = documentType ? documentTypeLabel(documentType) : '';
  if (/\.(xlsx?|xls|csv|ods|zip)$/i.test(raw) && typeLabel && typeLabel !== 'Documento') return typeLabel;
  return raw;
}

function sourceLabel(value) {
  const raw = String(value || '').trim();
  if (!raw) return 'Fonte não informada';
  const key = normalizeUpper(raw);
  if (sourceUiLabels[key]) return sourceUiLabels[key];
  if (!raw.includes('_') && !/\.(xlsx?|xls|csv|ods|zip|pdf|docx?)$/i.test(raw)) return raw;
  return humanizeDocumentReference(raw) || humanizeCode(raw);
}

function documentEvidenceLabel(documentType, document) {
  const friendlyDocument = humanizeDocumentReference(document, documentType);
  const friendlyType = documentType ? documentTypeLabel(documentType) : '';
  if (friendlyDocument && friendlyType && friendlyDocument !== friendlyType) return `${friendlyType} • ${friendlyDocument}`;
  return friendlyDocument || friendlyType || 'Documento não informado';
}

function emptyEquipmentForm() {
  return {
    pn: '',
    sn: '',
    nomenclatura: '',
    horas_acumuladas: 0,
    origem_entrada: '',
    documento_entrada: '',
    data_entrada: '',
    garantia_inicio: '',
    garantia_vencimento: '',
    garantia_documento: '',
    garantia_observacao: '',
    garantia_alerta_ativo: true,
    categoria_local_atual: 'DESCONHECIDO',
    local_atual: '',
    anv_atual: '',
    status_atual: 'CADASTRADO',
    condicao_atual: 'DESCONHECIDA',
    motivo_inicial: 'Cadastro inicial do equipamento no SISHA.',
    observacao_inicial: '',
  };
}

function equipmentToForm(item = {}) {
  return {
    pn: item.pn || '',
    sn: item.sn || '',
    nomenclatura: item.nomenclatura || '',
    horas_acumuladas: item.horas_acumuladas ?? 0,
    origem_entrada: item.origem_entrada || '',
    documento_entrada: item.documento_entrada || '',
    data_entrada: item.data_entrada ? String(item.data_entrada).slice(0, 10) : '',
    garantia_inicio: item.garantia_inicio ? String(item.garantia_inicio).slice(0, 10) : '',
    garantia_vencimento: item.garantia_vencimento ? String(item.garantia_vencimento).slice(0, 10) : '',
    garantia_documento: item.garantia_documento || '',
    garantia_observacao: item.garantia_observacao || '',
    garantia_alerta_ativo: item.garantia_alerta_ativo !== false,
    categoria_local_atual: item.categoria_local_atual || 'DESCONHECIDO',
    local_atual: item.local_atual || '',
    anv_atual: item.anv_atual || '',
    status_atual: item.status_atual || 'DESCONHECIDO',
    condicao_atual: item.condicao_atual || 'DESCONHECIDA',
    confianca_localizacao: item.confianca_localizacao || 'DESCONHECIDA',
    motivo_edicao: '',
    documento_correcao: '',
    observacao_edicao: '',
  };
}

function emptyEventForm(item = {}) {
  return {
    tipo_evento: 'AJUSTE_MANUAL',
    data_evento: toLocalDateTimeInput(),
    categoria_destino: item.categoria_local_atual || 'DESCONHECIDO',
    local_destino: item.local_atual || '',
    anv_destino: item.anv_atual || '',
    status_resultante: item.status_atual || 'CADASTRADO',
    condicao_resultante: item.condicao_atual || 'DESCONHECIDA',
    documento_tipo: '',
    documento: '',
    pim: '',
    os: '',
    confianca: 'CONFIRMADA',
    motivo: '',
    observacao: '',
  };
}

function emptyStcForm(card = null) {
  if (card) {
    return {
      card_key: card.card_key || '',
      equipment_id: card.equipment_id || '',
      numero_stc: card.numero_stc || '',
      pn: card.pn || '',
      sn: card.sn || '',
      status: card.status || 'REGISTRADA',
      motivo_stc: card.motivo_stc || 'MOVIMENTACAO',
      descricao: card.descricao || '',
      categoria_origem: card.categoria_origem_informada || '',
      local_origem: card.origem_informada || '',
      anv_origem: card.anv_origem_informada || '',
      categoria_destino: card.categoria_destino || 'DESCONHECIDO',
      local_destino: card.local_destino || '',
      anv_destino: card.anv_destino || '',
      empresa_destino: card.empresa_destino || '',
      data_envio: card.data_envio ? toLocalDateTimeInput(card.data_envio) : '',
      categoria_retorno: card.categoria_retorno || 'DESCONHECIDO',
      local_retorno: card.local_retorno || '',
      anv_retorno: card.anv_retorno || '',
      data_retorno: card.data_retorno ? toLocalDateTimeInput(card.data_retorno) : '',
      condicao_retorno: card.condicao_retorno || 'DESCONHECIDA',
      documento_referencia: card.documento_referencia || '',
      observacao: card.observacao || '',
    };
  }
  return {
    card_key: '', equipment_id: '', numero_stc: '', pn: '', sn: '', status: 'REGISTRADA', motivo_stc: 'MOVIMENTACAO', descricao: '',
    categoria_origem: '', local_origem: '', anv_origem: '', categoria_destino: 'DESCONHECIDO', local_destino: '', anv_destino: '', empresa_destino: '', data_envio: '',
    categoria_retorno: 'DESCONHECIDO', local_retorno: '', anv_retorno: '', data_retorno: '', condicao_retorno: 'DESCONHECIDA', documento_referencia: '', observacao: '',
  };
}

function stcStatusTone(status) {
  const key = normalizeUpper(status);
  if (key === 'RETORNADA') return 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300';
  if (key === 'ENVIADA') return 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300';
  if (key === 'CANCELADA') return 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300';
  return 'bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300';
}


function emptyOsPimForm(card = null) {
  if (card) {
    return {
      card_key: card.card_key || '', equipment_id: card.equipment_id || '', tipo_movimento: card.tipo_movimento || 'INSTALACAO',
      os: card.os || '', osr: card.osr || '', pim: card.pim || '', pn: card.pn || '', sn: card.sn || '',
      data_evento: card.data_evento ? toLocalDateTimeInput(card.data_evento) : toLocalDateTimeInput(),
      aeronave: card.aeronave || '', categoria_origem: card.categoria_origem || '', local_origem: card.local_origem || '', anv_origem: card.anv_origem || '',
      categoria_destino: card.categoria_destino || 'DESCONHECIDO', local_destino: card.local_destino || '', anv_destino: card.anv_destino || '',
      condicao_resultante: card.condicao_resultante || 'DESCONHECIDA', motivo_movimento: card.motivo_movimento || '', documento_referencia: card.documento || '',
      observacao: card.observacao || '', staging_id: card.staging_id || '', documento_chat_lince_id: card.documento_chat_lince_id || '',
    };
  }
  return {
    card_key: '', equipment_id: '', tipo_movimento: 'INSTALACAO', os: '', osr: '', pim: '', pn: '', sn: '',
    data_evento: toLocalDateTimeInput(), aeronave: '', categoria_origem: '', local_origem: '', anv_origem: '',
    categoria_destino: 'DESCONHECIDO', local_destino: '', anv_destino: '', condicao_resultante: 'DESCONHECIDA', motivo_movimento: '',
    documento_referencia: '', observacao: '', staging_id: '', documento_chat_lince_id: '',
  };
}

function stagingToOsPimForm(row = {}) {
  const payload = row.payload && typeof row.payload === 'object' ? row.payload : {};
  const rawType = normalizeUpper(row.tipo_evento || payload.tipo_evento);
  const tipo = /INSTAL/.test(rawType) ? 'INSTALACAO' : /REMOV|RETIR/.test(rawType) ? 'REMOCAO' : /TRANSFER/.test(rawType) ? 'TRANSFERENCIA' : 'MOVIMENTACAO';
  return {
    ...emptyOsPimForm(),
    tipo_movimento: tipo,
    os: row.os_numero || payload.os_numero || payload.os || '',
    pim: row.pim || payload.pim || '',
    pn: row.pn || payload.pn || '',
    sn: row.sn || payload.sn || '',
    aeronave: row.aeronave || payload.aeronave || '',
    data_evento: (row.data_evento || payload.data_evento) ? toLocalDateTimeInput(row.data_evento || payload.data_evento) : toLocalDateTimeInput(),
    local_origem: row.local_origem || payload.local_origem || '',
    local_destino: row.local_destino || payload.local_destino || '',
    motivo_movimento: payload.motivo || payload.descricao || 'Movimentação extraída pelo Chat Lince e revisada pelo Admin.',
    observacao: payload.observacao || `Sugestão do Chat Lince ${row.id || ''}`,
    staging_id: row.id || '',
    documento_chat_lince_id: row.documento_id || '',
  };
}

function osPimTone(status) {
  const key = normalizeUpper(status);
  if (key === 'CANCELADA') return 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300';
  if (key === 'CONFLITO') return 'bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300';
  return 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300';
}

function warrantyTone(item) {
  if (!item.garantia_vencimento || item.garantia_alerta_ativo === false) return 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300';
  const days = Number(item.dias_garantia_restantes);
  if (Number.isFinite(days) && days < 0) return 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300';
  if (Number.isFinite(days) && days <= 60) return 'bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300';
  return 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300';
}

function confidenceTone(value) {
  const key = normalizeUpper(value);
  if (key === 'CONFIRMADA') return 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300';
  if (key === 'CONFLITANTE') return 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300';
  if (key === 'PROVAVEL' || key === 'ALTA') return 'bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300';
  return 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300';
}

function emptyOperationalFilters() {
  return {
    location_category: '',
    location: '',
    condition: '',
    status: '',
    reason: '',
    source: '',
    repair_state: '',
    priority: '',
    critical: '',
    emergency: '',
    conflict: '',
    ppu: '',
    min_days: '',
  };
}

function priorityTone(value) {
  const key = normalizeUpper(value);
  if (key === 'CRITICA') return 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300';
  if (key === 'ALTA') return 'bg-orange-100 text-orange-800 dark:bg-orange-900/30 dark:text-orange-300';
  if (key === 'MEDIA') return 'bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300';
  if (key === 'INDETERMINADA') return 'bg-slate-200 text-slate-700 dark:bg-slate-700 dark:text-slate-200';
  return 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300';
}

function repairStateLabel(value) {
  const key = normalizeUpper(value);
  if (key === 'AGUARDANDO_ENVIO_AVALIACAO') return 'Aguardando envio / avaliação';
  if (key === 'EM_REPARO') return 'Em reparo';
  if (key === 'RETORNADO') return 'Retornado';
  if (key === 'INDETERMINADA') return 'Indeterminada';
  return 'Sem indicação de reparo';
}


function inventoryRowIssues(rows = []) {
  const counts = new Map();
  rows.forEach((row) => {
    const key = `${normalizeUpper(row.pn)}::${normalizeUpper(row.sn).replace(/\s+/g, '')}`;
    if (row.pn && row.sn) counts.set(key, (counts.get(key) || 0) + 1);
  });
  return rows.map((row) => {
    const issues = [];
    const pn = normalizeUpper(row.pn);
    const sn = normalizeUpper(row.sn).replace(/\s+/g, '');
    if (!pn) issues.push('PN');
    if (!sn) issues.push('SN');
    if (!String(row.localizacao || '').trim()) issues.push('Localização');
    if (pn && sn && (counts.get(`${pn}::${sn}`) || 0) > 1) issues.push('PN + SN duplicado');
    return issues;
  });
}

function masterRowIssues(rows = []) {
  const counts = new Map();
  rows.forEach((row) => {
    const key = `${normalizeUpper(row.pn)}::${normalizeUpper(row.sn).replace(/\s+/g, '')}`;
    if (row.pn && row.sn) counts.set(key, (counts.get(key) || 0) + 1);
  });
  return rows.map((row) => {
    const issues = [];
    const pn = normalizeUpper(row.pn);
    const sn = normalizeUpper(row.sn).replace(/\s+/g, '');
    if (!pn) issues.push('PN');
    if (!sn) issues.push('SN');
    if (pn && sn && (counts.get(`${pn}::${sn}`) || 0) > 1) issues.push('PN + SN duplicado');
    return issues;
  });
}

function reconciliationTone(status) {
  if (status === 'CONCILIADO') return 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300';
  if (status === 'FALTAM_SNS') return 'bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300';
  return 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300';
}

function ModalShell({ title, subtitle, onClose, children, footer, wide = false }) {
  return (
    <div className="fixed inset-0 z-[80] bg-black/70 backdrop-blur-sm flex items-center justify-center p-3 sm:p-5">
      <div className={`w-full ${wide ? 'max-w-6xl' : 'max-w-3xl'} max-h-[92vh] bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-3xl shadow-2xl flex flex-col overflow-hidden`}>
        <div className="px-5 py-4 border-b border-slate-200 dark:border-slate-700 flex items-start justify-between gap-4">
          <div>
            <h3 className="font-black uppercase tracking-tight text-slate-900 dark:text-white">{title}</h3>
            {subtitle ? <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">{subtitle}</p> : null}
          </div>
          <button onClick={onClose} className="p-2 rounded-xl bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700" aria-label="Fechar">
            <X size={18} />
          </button>
        </div>
        <div className="flex-1 overflow-auto p-5">{children}</div>
        {footer ? <div className="px-5 py-4 border-t border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950/40">{footer}</div> : null}
      </div>
    </div>
  );
}

export default function Equipamentos() {
  const { user, token } = useAuth();
  const canEdit = ['dono', 'admin'].includes(user?.role);
  const [query, setQuery] = useState('');
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [operationalFilters, setOperationalFilters] = useState(emptyOperationalFilters());
  const [operationalMeta, setOperationalMeta] = useState(null);
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [selected, setSelected] = useState(null);
  const [dossierOpen, setDossierOpen] = useState(false);
  const [equipmentModal, setEquipmentModal] = useState(null);
  const [equipmentForm, setEquipmentForm] = useState(emptyEquipmentForm());
  const [eventModal, setEventModal] = useState(false);
  const [eventForm, setEventForm] = useState(emptyEventForm());
  const [invalidateEvent, setInvalidateEvent] = useState(null);
  const [invalidateReason, setInvalidateReason] = useState('');
  const [saving, setSaving] = useState(false);

  const [inventoryModal, setInventoryModal] = useState(false);
  const [inventoryFile, setInventoryFile] = useState(null);
  const [inventoryDraft, setInventoryDraft] = useState(null);
  const [inventoryMode, setInventoryMode] = useState('merge');
  const [snapshotDate, setSnapshotDate] = useState(toLocalDateInput());
  const [inventoryPage, setInventoryPage] = useState(0);
  const [inventoryLoading, setInventoryLoading] = useState(false);
  const [reconciliationOpen, setReconciliationOpen] = useState(false);
  const [reconciliationRows, setReconciliationRows] = useState([]);
  const [reconciliationMeta, setReconciliationMeta] = useState(null);
  const [reconciliationLoading, setReconciliationLoading] = useState(false);
  const [deleteEquipment, setDeleteEquipment] = useState(null);
  const [maintenanceProgramOpen, setMaintenanceProgramOpen] = useState(false);
  const [equipmentOperationsOpen, setEquipmentOperationsOpen] = useState(false);
  const [reliabilityOpen, setReliabilityOpen] = useState(false);

  const [masterModal, setMasterModal] = useState(false);
  const [masterFile, setMasterFile] = useState(null);
  const [masterDraft, setMasterDraft] = useState(null);
  const [masterDate, setMasterDate] = useState(toLocalDateInput());
  const [masterPage, setMasterPage] = useState(0);
  const [masterLoading, setMasterLoading] = useState(false);

  const [locationConflicts, setLocationConflicts] = useState([]);
  const [conflictsOpen, setConflictsOpen] = useState(false);
  const [conflictsLoading, setConflictsLoading] = useState(false);
  const [conflictReasons, setConflictReasons] = useState({});

  const [stcOpen, setStcOpen] = useState(false);
  const [stcMode, setStcMode] = useState('list');
  const [stcCards, setStcCards] = useState([]);
  const [stcLoading, setStcLoading] = useState(false);
  const [stcForm, setStcForm] = useState(emptyStcForm());

  const [osPimOpen, setOsPimOpen] = useState(false);
  const [osPimMode, setOsPimMode] = useState('list');
  const [osPimCards, setOsPimCards] = useState([]);
  const [osPimStaging, setOsPimStaging] = useState([]);
  const [aircraftConfiguration, setAircraftConfiguration] = useState([]);
  const [osPimLoading, setOsPimLoading] = useState(false);
  const [osPimForm, setOsPimForm] = useState(emptyOsPimForm());


  const load = useCallback(async (term = '') => {
    setLoading(true);
    setError('');
    try {
      const response = await apiFetch(`/equipments?q=${encodeURIComponent(term || '')}`, {}, token);
      const json = await response.json();
      if (!response.ok || json.status !== 'success') throw new Error(json.message || 'Falha ao consultar equipamentos.');
      setItems(json.data || []);
    } catch (err) {
      setError(err.message || 'Falha ao consultar equipamentos.');
    } finally {
      setLoading(false);
    }
  }, [token]);

  const loadOperational = useCallback(async (filters = {}, term = '') => {
    setLoading(true);
    setError('');
    try {
      const params = new URLSearchParams();
      if (String(term || '').trim()) params.set('q', String(term || '').trim());
      Object.entries(filters || {}).forEach(([key, value]) => {
        if (String(value ?? '').trim()) params.set(key, String(value).trim());
      });
      params.set('result_limit', '2000');
      const response = await apiFetch(`/equipments/operational-search?${params.toString()}`, {}, token);
      const json = await response.json();
      if (!response.ok || json.status !== 'success') throw new Error(json.message || 'Falha ao montar pesquisa operacional.');
      setItems(json.data || []);
      setOperationalMeta(json.meta || null);
    } catch (err) {
      setError(err.message || 'Falha ao montar pesquisa operacional.');
    } finally {
      setLoading(false);
    }
  }, [token]);

  const refreshEquipmentList = useCallback(async () => {
    if (advancedOpen) return loadOperational(operationalFilters, query);
    setOperationalMeta(null);
    return load(query);
  }, [advancedOpen, load, loadOperational, operationalFilters, query]);

  const openOperationalSearch = async () => {
    setAdvancedOpen(true);
    await loadOperational(operationalFilters, query);
  };

  const closeOperationalSearch = async () => {
    setAdvancedOpen(false);
    setOperationalMeta(null);
    await load(query);
  };

  const clearOperationalSearch = async () => {
    const clean = emptyOperationalFilters();
    setOperationalFilters(clean);
    setQuery('');
    setAdvancedOpen(true);
    await loadOperational(clean, '');
  };

  const quickOperationalSearch = async (patch) => {
    const clean = { ...emptyOperationalFilters(), ...patch };
    setOperationalFilters(clean);
    setQuery('');
    setAdvancedOpen(true);
    await loadOperational(clean, '');
  };

  const runMainSearch = async () => {
    if (advancedOpen) return loadOperational(operationalFilters, query);
    setOperationalMeta(null);
    return load(query);
  };

  const loadLocationConflicts = useCallback(async () => {
    if (!canEdit) {
      setLocationConflicts([]);
      return;
    }
    setConflictsLoading(true);
    try {
      const response = await apiFetch('/equipments/location-conflicts?limit=500', {}, token);
      const json = await response.json();
      if (!response.ok || json.status !== 'success') throw new Error(json.message || 'Falha ao consultar conflitos.');
      setLocationConflicts(json.data || []);
    } catch (err) {
      setError(err.message || 'Falha ao consultar conflitos de localização.');
    } finally {
      setConflictsLoading(false);
    }
  }, [canEdit, token]);

  const loadStcCards = useCallback(async (term = '') => {
    setStcLoading(true);
    try {
      const response = await apiFetch(`/equipments/stc?q=${encodeURIComponent(term || '')}&limit=500`, {}, token);
      const json = await response.json();
      if (!response.ok || json.status !== 'success') throw new Error(json.message || 'Falha ao consultar STCs.');
      setStcCards(json.data || []);
    } catch (err) {
      setError(err.message || 'Falha ao consultar STCs.');
    } finally {
      setStcLoading(false);
    }
  }, [token]);

  const openStcManager = async () => {
    setStcOpen(true);
    setStcMode('list');
    setStcForm(emptyStcForm());
    await loadStcCards(query);
  };

  const openNewStc = () => {
    setStcForm(emptyStcForm());
    setStcMode('form');
  };

  const openEditStc = (card) => {
    setStcForm(emptyStcForm(card));
    setStcMode('form');
  };

  const saveStc = async () => {
    if (!stcForm.numero_stc.trim() || !stcForm.pn.trim() || !stcForm.sn.trim()) {
      setError('Número da STC, PN e SN são obrigatórios.');
      return;
    }
    setSaving(true);
    setError('');
    try {
      const editing = Boolean(stcForm.card_key);
      const response = await apiFetch(editing ? `/equipments/stc/${encodeURIComponent(stcForm.card_key)}` : '/equipments/stc', {
        method: editing ? 'PUT' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...stcForm,
          data_envio: localDateTimeToIso(stcForm.data_envio),
          data_retorno: localDateTimeToIso(stcForm.data_retorno),
        }),
      }, token);
      const json = await response.json();
      if (!response.ok || json.status !== 'success') throw new Error(json.message || 'Falha ao salvar STC.');
      setNotice(json.message || 'STC salva e vinculada ao Livro do Equipamento.');
      setStcMode('list');
      setStcForm(emptyStcForm());
      await loadStcCards(query);
      await refreshEquipmentList();
      await loadLocationConflicts();
    } catch (err) {
      setError(err.message || 'Falha ao salvar STC.');
    } finally {
      setSaving(false);
    }
  };

  const cancelStc = async (card) => {
    if (!canEdit) return;
    const motivo = window.prompt(`Motivo do cancelamento da STC ${card.numero_stc}:`);
    if (!motivo?.trim()) return;
    setSaving(true);
    setError('');
    try {
      const response = await apiFetch(`/equipments/stc/${encodeURIComponent(card.card_key)}/cancel`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ motivo: motivo.trim() }),
      }, token);
      const json = await response.json();
      if (!response.ok || json.status !== 'success') throw new Error(json.message || 'Falha ao cancelar STC.');
      setNotice('STC cancelada sem apagar o histórico do equipamento.');
      await loadStcCards(query);
      await refreshEquipmentList();
      await loadLocationConflicts();
    } catch (err) {
      setError(err.message || 'Falha ao cancelar STC.');
    } finally {
      setSaving(false);
    }
  };


  const loadOsPimData = useCallback(async (term = '') => {
    setOsPimLoading(true);
    try {
      const [cardsResponse, stagingResponse, aircraftResponse] = await Promise.all([
        apiFetch(`/equipments/os-pim?q=${encodeURIComponent(term || '')}&limit=500`, {}, token),
        canEdit ? apiFetch(`/equipments/os-pim/staging?q=${encodeURIComponent(term || '')}&limit=500`, {}, token) : Promise.resolve(null),
        apiFetch('/equipments/aircraft-configuration', {}, token),
      ]);
      const cardsJson = await cardsResponse.json();
      if (!cardsResponse.ok || cardsJson.status !== 'success') throw new Error(cardsJson.message || 'Falha ao consultar OS/PIM.');
      setOsPimCards(cardsJson.data || []);

      if (stagingResponse) {
        const stagingJson = await stagingResponse.json();
        if (!stagingResponse.ok || stagingJson.status !== 'success') throw new Error(stagingJson.message || 'Falha ao consultar pendências de OS / PIM.');
        setOsPimStaging(stagingJson.data || []);
      } else {
        setOsPimStaging([]);
      }

      const aircraftJson = await aircraftResponse.json();
      if (!aircraftResponse.ok || aircraftJson.status !== 'success') throw new Error(aircraftJson.message || 'Falha ao consultar configuração das aeronaves.');
      setAircraftConfiguration(aircraftJson.data || []);
    } catch (err) {
      setError(err.message || 'Falha ao consultar movimentações OS/PIM.');
    } finally {
      setOsPimLoading(false);
    }
  }, [canEdit, token]);

  const openOsPimManager = async () => {
    setOsPimOpen(true);
    setOsPimMode('list');
    setOsPimForm(emptyOsPimForm());
    await loadOsPimData(query);
  };

  const openNewOsPim = () => {
    setOsPimForm(emptyOsPimForm());
    setOsPimMode('form');
  };

  const openEditOsPim = (card) => {
    setOsPimForm(emptyOsPimForm(card));
    setOsPimMode('form');
  };

  const reviewStagingOsPim = (row) => {
    setOsPimForm(stagingToOsPimForm(row));
    setOsPimMode('form');
  };

  const saveOsPim = async () => {
    if (!osPimForm.pn.trim() || !osPimForm.sn.trim()) {
      setError('PN e SN são obrigatórios para movimentar um equipamento físico.');
      return;
    }
    if (!osPimForm.os.trim() && !osPimForm.osr.trim() && !osPimForm.pim.trim()) {
      setError('Informe ao menos OS, OSR ou PIM.');
      return;
    }
    setSaving(true);
    setError('');
    try {
      const editing = Boolean(osPimForm.card_key);
      const promoting = Boolean(osPimForm.staging_id) && !editing;
      const path = promoting
        ? `/equipments/os-pim/staging/${encodeURIComponent(osPimForm.staging_id)}/promote`
        : editing
          ? `/equipments/os-pim/${encodeURIComponent(osPimForm.card_key)}`
          : '/equipments/os-pim';
      const response = await apiFetch(path, {
        method: promoting ? 'POST' : editing ? 'PUT' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...osPimForm, data_evento: localDateTimeToIso(osPimForm.data_evento) }),
      }, token);
      const json = await response.json();
      if (!response.ok || json.status !== 'success') throw new Error(json.message || 'Falha ao salvar movimentação OS/PIM.');
      setNotice(json.message || 'Movimentação OS/PIM registrada no Livro do Equipamento.');
      setOsPimMode('list');
      setOsPimForm(emptyOsPimForm());
      await loadOsPimData(query);
      await refreshEquipmentList();
      await loadLocationConflicts();
    } catch (err) {
      setError(err.message || 'Falha ao salvar movimentação OS/PIM.');
    } finally {
      setSaving(false);
    }
  };

  const cancelOsPim = async (card) => {
    if (!canEdit) return;
    const motivo = window.prompt(`Motivo do cancelamento de ${card.documento || card.os || card.pim || 'OS/PIM'}:`);
    if (!motivo?.trim()) return;
    setSaving(true);
    setError('');
    try {
      const response = await apiFetch(`/equipments/os-pim/${encodeURIComponent(card.card_key)}/cancel`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ motivo: motivo.trim() }),
      }, token);
      const json = await response.json();
      if (!response.ok || json.status !== 'success') throw new Error(json.message || 'Falha ao cancelar movimentação OS/PIM.');
      setNotice(json.message || 'Movimentação cancelada sem apagar o histórico.');
      await loadOsPimData(query);
      await refreshEquipmentList();
      await loadLocationConflicts();
    } catch (err) {
      setError(err.message || 'Falha ao cancelar movimentação OS/PIM.');
    } finally {
      setSaving(false);
    }
  };

  useEffect(() => { load(''); }, [load]);
  useEffect(() => { loadLocationConflicts(); }, [loadLocationConflicts]);

  useEffect(() => {
    const raw = window.sessionStorage.getItem('sisha_equipment_inventory_draft');
    if (!raw) return;
    try {
      const draft = JSON.parse(raw);
      if (draft?.rows?.length) {
        setInventoryDraft(draft);
        setInventoryFile(null);
        setInventoryPage(0);
        setInventoryModal(true);
      }
    } catch {
      // Draft inválido é simplesmente descartado; nenhuma gravação ocorre.
    } finally {
      window.sessionStorage.removeItem('sisha_equipment_inventory_draft');
    }
  }, []);


  const summary = useMemo(() => {
    const known = items.filter((item) => item.local_atual && normalizeUpper(item.categoria_local_atual) !== 'DESCONHECIDO').length;
    const repair = items.filter((item) => ['GANM', 'WO_EXTERIOR', 'GARANTIA'].includes(normalizeUpper(item.categoria_local_atual))).length;
    const warranty = items.filter((item) => Number.isFinite(Number(item.dias_garantia_restantes)) && Number(item.dias_garantia_restantes) <= 60).length;
    return { total: items.length, known, repair, warranty };
  }, [items]);

  const openDossier = async (item) => {
    setError('');
    try {
      const response = await apiFetch(`/equipments/${item.id}`, {}, token);
      const json = await response.json();
      if (!response.ok || json.status !== 'success') throw new Error(json.message || 'Falha ao abrir dossiê.');
      setSelected(json.data);
      setDossierOpen(true);
    } catch (err) {
      setError(err.message || 'Falha ao abrir dossiê.');
    }
  };

  const refreshSelected = async () => {
    if (!selected?.id) return;
    const response = await apiFetch(`/equipments/${selected.id}`, {}, token);
    const json = await response.json();
    if (response.ok && json.status === 'success') setSelected(json.data);
  };

  const openCreate = () => {
    setEquipmentModal('create');
    setEquipmentForm(emptyEquipmentForm());
  };

  const openEdit = (item) => {
    setEquipmentModal('edit');
    setSelected(item);
    setEquipmentForm(equipmentToForm(item));
  };

  const saveEquipment = async () => {
    if (!equipmentForm.pn.trim() || !equipmentForm.sn.trim()) {
      setError('PN e SN são obrigatórios.');
      return;
    }
    setSaving(true);
    setError('');
    try {
      const isEdit = equipmentModal === 'edit';
      const response = await apiFetch(isEdit ? `/equipments/${selected.id}` : '/equipments', {
        method: isEdit ? 'PUT' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(equipmentForm),
      }, token);
      const json = await response.json();
      if (!response.ok || json.status !== 'success') throw new Error(json.message || 'Falha ao salvar equipamento.');
      setNotice(isEdit ? 'Equipamento atualizado. Alterações de localização também ficam registradas no histórico.' : 'Equipamento cadastrado com sucesso.');
      setEquipmentModal(null);
      await refreshEquipmentList();
      if (dossierOpen && selected?.id) await refreshSelected();
    } catch (err) {
      setError(err.message || 'Falha ao salvar equipamento.');
    } finally {
      setSaving(false);
    }
  };

  const requestDeleteEquipment = (item) => {
    setDeleteEquipment(item);
    setEquipmentModal(null);
  };

  const doDeleteEquipment = async () => {
    if (!deleteEquipment?.id) return;
    setSaving(true);
    setError('');
    try {
      const response = await apiFetch(`/equipments/${deleteEquipment.id}`, { method: 'DELETE' }, token);
      const json = await response.json();
      if (!response.ok || json.status !== 'success') throw new Error(json.message || 'Falha ao excluir/arquivar equipamento.');
      setNotice(json.message || 'Equipamento removido das consultas de rotina.');
      setDeleteEquipment(null);
      setDossierOpen(false);
      setSelected(null);
      await refreshEquipmentList();
      await loadLocationConflicts();
    } catch (err) {
      setError(err.message || 'Falha ao excluir/arquivar equipamento.');
    } finally {
      setSaving(false);
    }
  };

  const previewMaster = async (file = masterFile) => {
    if (!file) {
      setError('Selecione o ZIP ou planilha do Cadastro Mestre.');
      return;
    }
    setMasterLoading(true);
    setError('');
    try {
      const formData = new FormData();
      formData.append('file', file);
      const response = await apiFetch('/equipments/master/preview', { method: 'POST', body: formData }, token);
      const json = await response.json();
      if (!response.ok || json.status !== 'success') throw new Error(json.message || 'Falha ao ler Cadastro Mestre.');
      setMasterDraft(json.data);
      setMasterPage(0);
    } catch (err) {
      setError(err.message || 'Falha ao ler Cadastro Mestre.');
    } finally {
      setMasterLoading(false);
    }
  };

  const updateMasterRow = (index, field, value) => {
    setMasterDraft((current) => {
      if (!current) return current;
      const rows = [...(current.rows || [])];
      rows[index] = { ...rows[index], [field]: value };
      return { ...current, rows };
    });
  };

  const applyMaster = async () => {
    if (!masterDraft?.rows?.length) return;
    const issues = masterRowIssues(masterDraft.rows);
    const invalid = issues.filter((row) => row.length).length;
    if (invalid) {
      setError(`Corrija ${invalid} linha(s) do Cadastro Mestre antes de aplicar.`);
      return;
    }
    setMasterLoading(true);
    setError('');
    try {
      const response = await apiFetch('/equipments/master/apply', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          snapshot_date: masterDate,
          file_name: masterDraft.arquivo_nome || masterFile?.name || 'cadastro_mestre_equipamentos',
          file_hash: masterDraft.arquivo_hash || null,
          rows: masterDraft.rows,
        }),
      }, token);
      const json = await response.json();
      if (!response.ok || json.status !== 'success') throw new Error(json.message || 'Falha ao aplicar Cadastro Mestre.');
      const data = json.data || {};
      setNotice(`${data.processados || 0} PN+SN processados: ${data.criados || 0} novos, ${data.existentes || 0} já conhecidos e ${data.conflitos_localizacao || 0} conflito(s) pendente(s).`);
      setMasterModal(false);
      setMasterDraft(null);
      setMasterFile(null);
      await refreshEquipmentList();
      await loadLocationConflicts();
      if (Number(data.conflitos_localizacao || 0) > 0) setConflictsOpen(true);
    } catch (err) {
      setError(err.message || 'Falha ao aplicar Cadastro Mestre.');
    } finally {
      setMasterLoading(false);
    }
  };

  const resolveConflict = async (conflict, decision) => {
    const reason = String(conflictReasons[conflict.id] || '').trim();
    if (!reason) {
      setError('Informe o motivo da decisão antes de reconciliar a localização.');
      return;
    }
    setSaving(true);
    setError('');
    try {
      const response = await apiFetch(`/equipments/${conflict.equipamento_id}/location-conflicts/${conflict.id}/resolve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ decision, motivo: reason }),
      }, token);
      const json = await response.json();
      if (!response.ok || json.status !== 'success') throw new Error(json.message || 'Falha ao reconciliar localização.');
      setNotice('Localização confirmada. A outra evidência permanece no Livro como informação histórica invalidada.');
      setConflictReasons((current) => ({ ...current, [conflict.id]: '' }));
      await refreshEquipmentList();
      await loadLocationConflicts();
      if (selected?.id === conflict.equipamento_id) await refreshSelected();
    } catch (err) {
      setError(err.message || 'Falha ao reconciliar localização.');
    } finally {
      setSaving(false);
    }
  };

  const openMovement = (item) => {
    setSelected(item);
    setEventForm(emptyEventForm(item));
    setEventModal(true);
  };

  const saveEvent = async () => {
    if (!selected?.id) return;
    if (!eventForm.motivo.trim()) {
      setError('Informe o motivo/descrição da movimentação.');
      return;
    }
    setSaving(true);
    setError('');
    try {
      const response = await apiFetch(`/equipments/${selected.id}/events`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...eventForm, data_evento: localDateTimeToIso(eventForm.data_evento) }),
      }, token);
      const json = await response.json();
      if (!response.ok || json.status !== 'success') throw new Error(json.message || 'Falha ao registrar movimentação.');
      setNotice('Movimentação registrada. A localização atual do equipamento foi atualizada e o histórico foi preservado.');
      setSelected(json.data);
      setEventModal(false);
      await refreshEquipmentList();
    } catch (err) {
      setError(err.message || 'Falha ao registrar movimentação.');
    } finally {
      setSaving(false);
    }
  };

  const doInvalidate = async () => {
    if (!selected?.id || !invalidateEvent?.id || !invalidateReason.trim()) {
      setError('Informe o motivo da invalidação.');
      return;
    }
    setSaving(true);
    setError('');
    try {
      const response = await apiFetch(`/equipments/${selected.id}/events/${invalidateEvent.id}/invalidate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ motivo: invalidateReason }),
      }, token);
      const json = await response.json();
      if (!response.ok || json.status !== 'success') throw new Error(json.message || 'Falha ao invalidar evento.');
      setSelected(json.data);
      setInvalidateEvent(null);
      setInvalidateReason('');
      setNotice('Evento invalidado sem ser apagado. A localização atual foi recomposta.');
      await refreshEquipmentList();
    } catch (err) {
      setError(err.message || 'Falha ao invalidar evento.');
    } finally {
      setSaving(false);
    }
  };


  const previewInventory = async (file = inventoryFile) => {
    if (!file) {
      setError('Selecione o inventário de equipamentos.');
      return;
    }
    setInventoryLoading(true);
    setError('');
    try {
      const formData = new FormData();
      formData.append('file', file);
      const response = await apiFetch('/equipments/inventory/preview', {
        method: 'POST',
        body: formData,
      }, token);
      const json = await response.json();
      if (!response.ok || json.status !== 'success') throw new Error(json.message || 'Falha ao ler inventário de equipamentos.');
      setInventoryDraft(json.data);
      setInventoryPage(0);
    } catch (err) {
      setError(err.message || 'Falha ao ler inventário de equipamentos.');
    } finally {
      setInventoryLoading(false);
    }
  };

  const updateInventoryRow = (index, field, value) => {
    setInventoryDraft((current) => {
      if (!current) return current;
      const rows = [...(current.rows || [])];
      rows[index] = { ...rows[index], [field]: value };
      return { ...current, rows };
    });
  };

  const applyInventory = async () => {
    if (!inventoryDraft?.rows?.length) return;
    const issues = inventoryRowIssues(inventoryDraft.rows);
    const invalid = issues.filter((row) => row.length).length;
    if (invalid) {
      setError(`Corrija ${invalid} linha(s) antes de aplicar o inventário.`);
      return;
    }
    setInventoryLoading(true);
    setError('');
    try {
      const response = await apiFetch('/equipments/inventory/apply', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          mode: inventoryMode,
          snapshot_date: snapshotDate,
          file_name: inventoryDraft.arquivo_nome || inventoryFile?.name || 'inventario_equipamentos',
          file_hash: inventoryDraft.arquivo_hash || null,
          rows: inventoryDraft.rows,
        }),
      }, token);
      const json = await response.json();
      if (!response.ok || json.status !== 'success') throw new Error(json.message || 'Falha ao aplicar inventário.');
      setNotice(`${json.data?.processados || inventoryDraft.rows.length} equipamentos processados. O inventário serializado identificou as unidades; não somou quantidade ao PPU.`);
      setInventoryModal(false);
      setInventoryDraft(null);
      setInventoryFile(null);
      await refreshEquipmentList();
    } catch (err) {
      setError(err.message || 'Falha ao aplicar inventário de equipamentos.');
    } finally {
      setInventoryLoading(false);
    }
  };

  const enrichEquipmentNames = async () => {
    if (!canEdit) return;
    const ok = window.confirm('Completar automaticamente os equipamentos sem nomenclatura usando o PN no Dicionário/Manual Técnico? O SISHA só grava quando encontra correspondência técnica; itens sem fonte segura permanecem sem nome.');
    if (!ok) return;
    try {
      setError('');
      const response = await apiFetch('/equipment/nomenclaturas/enriquecer', {
        method: 'POST',
        headers: buildAuthHeaders(token, { 'Content-Type': 'application/json' }),
        body: JSON.stringify({ dry_run: false }),
      }, token);
      const json = await response.json();
      if (json.status !== 'success') throw new Error(json.message || 'Falha ao completar nomenclaturas.');
      setNotice(json.message);
      if (advancedOpen) await loadOperational(operationalFilters, query); else await load(query);
    } catch (err) {
      setError(err.message || 'Falha ao completar nomenclaturas.');
    }
  };

  const openReconciliation = async () => {
    setReconciliationOpen(true);
    setReconciliationLoading(true);
    setError('');
    try {
      const response = await apiFetch(`/equipments/reconciliation?q=${encodeURIComponent(query || '')}`, {}, token);
      const json = await response.json();
      if (!response.ok || json.status !== 'success') throw new Error(json.message || 'Falha ao reconciliar PPU e SN.');
      setReconciliationRows(json.data || []);
      setReconciliationMeta(json.meta || null);
    } catch (err) {
      setError(err.message || 'Falha ao reconciliar PPU e inventário serializado.');
    } finally {
      setReconciliationLoading(false);
    }
  };

  const exportData = async () => {
    setError('');
    try {
      const params = new URLSearchParams();
      if (String(query || '').trim()) params.set('q', String(query).trim());
      if (advancedOpen) {
        Object.entries(operationalFilters || {}).forEach(([key, value]) => {
          if (String(value ?? '').trim()) params.set(key, String(value).trim());
        });
      }
      const exportPath = advancedOpen ? '/equipments/operational-search/export' : '/equipments/export';
      const response = await fetch(`${API_BASE_URL}${exportPath}?${params.toString()}`, {
        headers: buildAuthHeaders(token),
      });
      if (!response.ok) {
        const json = await response.json().catch(() => ({}));
        throw new Error(json.message || 'Falha ao exportar equipamentos.');
      }
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = advancedOpen ? 'SISHA_Pesquisa_Operacional_Equipamentos.xlsx' : 'SISHA_Rastreabilidade_Equipamentos.xlsx';
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      setError(err.message || 'Falha ao exportar equipamentos.');
    }
  };

  return (
    <div className="space-y-5 animate-fade-in">
      <section className="bg-white dark:bg-slate-800 rounded-3xl border border-slate-200 dark:border-slate-700 shadow-sm p-5">
        <div className="flex flex-col xl:flex-row xl:items-center justify-between gap-4">
          <div>
            <h3 className="text-lg font-black uppercase tracking-tight text-slate-900 dark:text-white">Equipamentos — Consulta e Rastreabilidade</h3>
            <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">
              Consulte onde cada equipamento está, sua condição, origem da informação e histórico de movimentações. A evidência válida mais recente define a posição atual.
            </p>
          </div>
          <div className="flex flex-wrap items-start gap-2">
            <button onClick={exportData} className="inline-flex items-center gap-2 px-4 py-2.5 rounded-xl bg-slate-700 text-white font-black text-sm hover:bg-slate-600">
              <Download size={17} /> Exportar
            </button>

            <button onClick={advancedOpen ? closeOperationalSearch : openOperationalSearch} className={`inline-flex items-center gap-2 px-4 py-2.5 rounded-xl font-black text-sm ${advancedOpen ? 'bg-cyan-700 text-white hover:bg-cyan-800' : 'bg-cyan-50 dark:bg-cyan-950/30 text-cyan-800 dark:text-cyan-300 border border-cyan-200 dark:border-cyan-900 hover:bg-cyan-100 dark:hover:bg-cyan-950/50'}`}>
              <Settings2 size={17} /> {advancedOpen ? 'Pesquisa avançada ativa' : 'Pesquisa avançada'}
            </button>

            {canEdit ? (
              <details className="relative">
                <summary className="list-none cursor-pointer inline-flex items-center gap-2 px-4 py-2.5 rounded-xl bg-blue-600 text-white font-black text-sm hover:bg-blue-700 select-none">
                  <Settings2 size={17} /> Administrar
                </summary>
                <div className="absolute right-0 z-30 mt-2 w-72 rounded-2xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 p-2 shadow-2xl">
                  <p className="px-3 py-2 text-[10px] font-black uppercase tracking-wider text-slate-400">Ações de gestão</p>
                  <button onClick={openCreate} className="w-full px-3 py-2.5 rounded-xl text-left hover:bg-slate-100 dark:hover:bg-slate-800 font-black text-sm flex items-center gap-2">
                    <Plus size={16} /> Novo equipamento
                  </button>
                  <button onClick={() => { setMasterModal(true); setMasterDraft(null); setMasterFile(null); setMasterPage(0); }} className="w-full px-3 py-2.5 rounded-xl text-left hover:bg-slate-100 dark:hover:bg-slate-800 font-black text-sm flex items-center gap-2">
                    <Boxes size={16} /> Importar relação de equipamentos
                  </button>
                  <button onClick={() => { setInventoryModal(true); setInventoryDraft(null); setInventoryFile(null); setInventoryPage(0); }} className="w-full px-3 py-2.5 rounded-xl text-left hover:bg-slate-100 dark:hover:bg-slate-800 font-black text-sm flex items-center gap-2">
                    <FileText size={16} /> Importar inventário de localização
                  </button>
                  <button onClick={openStcManager} className="w-full px-3 py-2.5 rounded-xl text-left hover:bg-slate-100 dark:hover:bg-slate-800 font-black text-sm flex items-center gap-2">
                    <ArrowRightLeft size={16} /> Movimentações por STC
                  </button>
                  <button onClick={openOsPimManager} className="w-full px-3 py-2.5 rounded-xl text-left hover:bg-slate-100 dark:hover:bg-slate-800 font-black text-sm flex items-center gap-2">
                    <History size={16} /> Movimentações por OS / PIM
                  </button>
                  <button onClick={() => setEquipmentOperationsOpen(true)} className="w-full px-3 py-2.5 rounded-xl text-left hover:bg-slate-100 dark:hover:bg-slate-800 font-black text-sm flex items-center gap-2">
                    <ArrowRightLeft size={16} /> Instalar ou remover de aeronave
                  </button>
                  <button onClick={enrichEquipmentNames} className="w-full px-3 py-2.5 rounded-xl text-left hover:bg-slate-100 dark:hover:bg-slate-800 font-black text-sm flex items-center gap-2">
                    <FileText size={16} /> Completar nomes pelo Manual Técnico
                  </button>
                  <button onClick={openReconciliation} className="w-full px-3 py-2.5 rounded-xl text-left hover:bg-slate-100 dark:hover:bg-slate-800 font-black text-sm flex items-center gap-2">
                    <ArrowRightLeft size={16} /> Conferir localização no PPU
                  </button>
                  <button onClick={() => setMaintenanceProgramOpen(true)} className="w-full px-3 py-2.5 rounded-xl text-left hover:bg-slate-100 dark:hover:bg-slate-800 font-black text-sm flex items-center gap-2">
                    <ShieldCheck size={16} /> Controle de TBO / horas / ciclos
                  </button>
                  <button onClick={() => setReliabilityOpen(true)} className="w-full px-3 py-2.5 rounded-xl text-left hover:bg-slate-100 dark:hover:bg-slate-800 font-black text-sm flex items-center gap-2">
                    <ShieldCheck size={16} /> Indicadores de confiabilidade
                  </button>
                  {locationConflicts.length ? (
                    <button onClick={() => setConflictsOpen(true)} className="w-full px-3 py-2.5 rounded-xl text-left hover:bg-red-50 dark:hover:bg-red-900/20 text-red-700 dark:text-red-300 font-black text-sm flex items-center gap-2">
                      <AlertTriangle size={16} /> Conflitos ({locationConflicts.length})
                    </button>
                  ) : null}
                </div>
              </details>
            ) : null}
          </div>
        </div>

        <form onSubmit={(event) => { event.preventDefault(); runMainSearch(); }} className="mt-5 flex flex-col sm:flex-row gap-2">
          <div className="relative flex-1">
            <Search size={18} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Pesquise PN, SN, nomenclatura, aeronave, localização, PIM, OS, WO, STC ou outro documento"
              className={`${inputClass} pl-10`}
            />
          </div>
          <button className="px-5 py-2.5 rounded-xl bg-blue-600 text-white font-black inline-flex items-center justify-center gap-2">
            <Search size={17} /> Buscar
          </button>
          <button type="button" onClick={() => { setQuery(''); if (advancedOpen) loadOperational(operationalFilters, ''); else load(''); }} className="px-4 py-2.5 rounded-xl bg-slate-100 dark:bg-slate-700 font-black text-slate-600 dark:text-slate-200">
            <RefreshCcw size={17} />
          </button>
        </form>

        {advancedOpen ? (
          <div className="mt-4 rounded-2xl border border-cyan-200 dark:border-cyan-900 bg-cyan-50/40 dark:bg-cyan-950/10 p-4">
            <div className="flex flex-col lg:flex-row lg:items-start lg:justify-between gap-3">
              <div>
                <h4 className="font-black uppercase tracking-tight text-cyan-900 dark:text-cyan-200">Pesquisa avançada de equipamentos</h4>
                <p className="mt-1 text-xs font-bold text-cyan-800/80 dark:text-cyan-300/80">Cruza automaticamente Inventário do PPU, Controle de Equipamentos Críticos, Master OS, PIM/OS, WO, Recibos e o histórico do equipamento. Quando a documentação não permite concluir localização, motivo ou prioridade, o SISHA informa que a evidência é insuficiente.</p>
              </div>
              <button type="button" onClick={clearOperationalSearch} className="px-3 py-2 rounded-xl bg-white dark:bg-slate-900 border border-cyan-200 dark:border-cyan-900 text-xs font-black">Limpar filtros</button>
            </div>

            <div className="mt-4 flex flex-wrap gap-2">
              <button type="button" onClick={() => quickOperationalSearch({ location_category: 'RECEX' })} className="px-3 py-2 rounded-xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 text-xs font-black">Materiais no RECEX</button>
              <button type="button" onClick={() => quickOperationalSearch({ repair_state: 'AGUARDANDO_ENVIO_AVALIACAO' })} className="px-3 py-2 rounded-xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 text-xs font-black">Aguardando reparo</button>
              <button type="button" onClick={() => quickOperationalSearch({ emergency: 'true' })} className="px-3 py-2 rounded-xl bg-red-600 text-white text-xs font-black">Candidatos a reparo emergencial</button>
              <button type="button" onClick={() => quickOperationalSearch({ conflict: 'true' })} className="px-3 py-2 rounded-xl bg-amber-500 text-white text-xs font-black">Com inconsistências</button>
            </div>

            <div className="mt-4 grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-3">
              <label><span className={labelClass}>Tipo de local</span><select className={inputClass} value={operationalFilters.location_category} onChange={(e) => setOperationalFilters((v) => ({ ...v, location_category: e.target.value }))}><option value="">Todas</option>{categoryOptions.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
              <label><span className={labelClass}>Local começa com</span><input className={inputClass} value={operationalFilters.location} onChange={(e) => setOperationalFilters((v) => ({ ...v, location: e.target.value }))} placeholder="Ex.: RECEX, CX-001..." /></label>
              <label><span className={labelClass}>Condição</span><select className={inputClass} value={operationalFilters.condition} onChange={(e) => setOperationalFilters((v) => ({ ...v, condition: e.target.value }))}><option value="">Todas</option>{conditionOptions.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
              <label><span className={labelClass}>Situação atual</span><select className={inputClass} value={operationalFilters.status} onChange={(e) => setOperationalFilters((v) => ({ ...v, status: e.target.value }))}><option value="">Todas</option>{statusOptions.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
              <label className="sm:col-span-2"><span className={labelClass}>Motivo / causa contém</span><input className={inputClass} value={operationalFilters.reason} onChange={(e) => setOperationalFilters((v) => ({ ...v, reason: e.target.value }))} placeholder="Ex.: pane, garantia, remoção, transferência..." /></label>
              <label><span className={labelClass}>Fonte obrigatória</span><select className={inputClass} value={operationalFilters.source} onChange={(e) => setOperationalFilters((v) => ({ ...v, source: e.target.value }))}><option value="">Qualquer fonte</option><option value="critico">Controle de Equipamentos Críticos</option><option value="master_os">Master OS</option><option value="os_pim">OS / PIM</option><option value="wo">Ordem de reparo (WO)</option><option value="recibo">Recibo</option><option value="ppu">PPU / Inventário</option><option value="stc">Movimentação por STC</option></select></label>
              <label><span className={labelClass}>Situação do reparo</span><select className={inputClass} value={operationalFilters.repair_state} onChange={(e) => setOperationalFilters((v) => ({ ...v, repair_state: e.target.value }))}><option value="">Todas</option><option value="AGUARDANDO_ENVIO_AVALIACAO">Aguardando envio / avaliação</option><option value="EM_REPARO">Em reparo</option><option value="RETORNADO">Retornado</option><option value="SEM_INDICACAO">Sem indicação</option><option value="INDETERMINADA">Indeterminada</option></select></label>
              <label><span className={labelClass}>Prioridade operacional</span><select className={inputClass} value={operationalFilters.priority} onChange={(e) => setOperationalFilters((v) => ({ ...v, priority: e.target.value }))}><option value="">Todas</option><option value="CRITICA">Crítica</option><option value="ALTA">Alta</option><option value="MEDIA">Média</option><option value="NORMAL">Normal</option><option value="INDETERMINADA">Indeterminada</option></select></label>
              <label><span className={labelClass}>Controle crítico</span><select className={inputClass} value={operationalFilters.critical} onChange={(e) => setOperationalFilters((v) => ({ ...v, critical: e.target.value }))}><option value="">Todos</option><option value="true">Somente críticos</option><option value="false">Não críticos / sem evidência</option></select></label>
              <label><span className={labelClass}>PPU efetivo do PN</span><select className={inputClass} value={operationalFilters.ppu} onChange={(e) => setOperationalFilters((v) => ({ ...v, ppu: e.target.value }))}><option value="">Qualquer saldo</option><option value="ZERO">Saldo zero</option><option value="POSITIVO">Saldo positivo</option><option value="INDETERMINADO">Indeterminado</option></select></label>
              <label><span className={labelClass}>Conflito de evidência</span><select className={inputClass} value={operationalFilters.conflict} onChange={(e) => setOperationalFilters((v) => ({ ...v, conflict: e.target.value }))}><option value="">Todos</option><option value="true">Somente com conflito</option><option value="false">Sem conflito</option></select></label>
              <label><span className={labelClass}>Mínimo de dias no local</span><input type="number" min="0" className={inputClass} value={operationalFilters.min_days} onChange={(e) => setOperationalFilters((v) => ({ ...v, min_days: e.target.value }))} placeholder="Ex.: 30" /></label>
            </div>

            <div className="mt-4 flex flex-wrap justify-end gap-2">
              <button type="button" onClick={closeOperationalSearch} className="px-4 py-2.5 rounded-xl bg-slate-100 dark:bg-slate-800 font-black text-sm">Voltar à pesquisa simples</button>
              <button type="button" onClick={() => loadOperational(operationalFilters, query)} className="px-5 py-2.5 rounded-xl bg-cyan-700 text-white font-black text-sm inline-flex items-center gap-2"><Search size={16} /> Aplicar filtros</button>
            </div>
          </div>
        ) : null}
      </section>

      <section className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        {[
          ['Equipamentos', summary.total, Boxes],
          ['Local conhecido', summary.known, MapPin],
          ['Em reparo / fabricante', summary.repair, ArrowRightLeft],
          ['Garantia ≤ 60 dias', summary.warranty, ShieldCheck],
        ].map(([label, value, Icon]) => (
          <div key={label} className="bg-white dark:bg-slate-800 rounded-2xl border border-slate-200 dark:border-slate-700 p-4 flex items-center gap-3">
            <div className="p-2.5 rounded-xl bg-slate-100 dark:bg-slate-900 text-blue-600 dark:text-blue-400">{React.createElement(Icon, { size: 19 })}</div>
            <div className="min-w-0"><p className="text-[9px] font-black uppercase tracking-wider text-slate-400 truncate">{label}</p><p className="text-xl font-black">{value}</p></div>
          </div>
        ))}
      </section>

      {advancedOpen && operationalMeta ? (
        <section className="grid grid-cols-2 lg:grid-cols-5 gap-3">
          {[
            ['Resultado filtrado', operationalMeta.total ?? items.length],
            ['No RECEX', operationalMeta.recex ?? 0],
            ['Controle crítico', operationalMeta.criticos ?? 0],
            ['Emergência / reparo', operationalMeta.candidatos_emergencia_reparo ?? 0],
            ['Motivo não identificado', operationalMeta.motivo_nao_identificado ?? 0],
          ].map(([label, value]) => <div key={label} className="rounded-2xl border border-cyan-200 dark:border-cyan-900 bg-white dark:bg-slate-800 p-3"><p className="text-[9px] font-black uppercase tracking-wider text-slate-400">{label}</p><p className="mt-1 text-xl font-black">{value}</p></div>)}
          <div className="col-span-2 lg:col-span-5 rounded-xl bg-slate-50 dark:bg-slate-900/50 px-3 py-2 text-[10px] font-bold text-slate-500 dark:text-slate-400">{operationalMeta.regra_prioridade}</div>
        </section>
      ) : null}

      {error ? <div className="rounded-2xl bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-900 px-4 py-3 text-sm font-bold text-red-700 dark:text-red-300">{error}</div> : null}
      {notice ? <div className="rounded-2xl bg-emerald-50 dark:bg-emerald-900/20 border border-emerald-200 dark:border-emerald-900 px-4 py-3 text-sm font-bold text-emerald-700 dark:text-emerald-300">{notice}</div> : null}

      <section className="space-y-3">
        {loading ? <div className="py-12 text-center font-bold text-slate-400">Carregando equipamentos...</div> : null}
        {!loading && !items.length ? <div className="py-12 text-center font-bold text-slate-400">Nenhum equipamento encontrado.</div> : null}
        {items.map((item) => (
          <article key={item.id} className="bg-white dark:bg-slate-800 rounded-2xl border border-slate-200 dark:border-slate-700 shadow-sm p-4">
            <div className="flex flex-col xl:flex-row xl:items-center gap-4 justify-between">
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-black text-slate-900 dark:text-white">{item.pn}</span>
                  <span className="text-xs font-black px-2.5 py-1 rounded-lg bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300">SN {item.sn}</span>
                  <span className={`text-[10px] font-black px-2.5 py-1 rounded-lg ${confidenceTone(item.confianca_localizacao)}`}>{confidenceLabel(item.confianca_localizacao)}</span>
                  {advancedOpen && item.prioridade_operacional ? <span className={`text-[10px] font-black px-2.5 py-1 rounded-lg ${priorityTone(item.prioridade_operacional.nivel)}`}>PRIORIDADE {item.prioridade_operacional.nivel}</span> : null}
                  {advancedOpen && item.prioridade_operacional?.candidato_emergencia_reparo ? <span className="text-[10px] font-black px-2.5 py-1 rounded-lg bg-red-600 text-white">CANDIDATO A REPARO EMERGENCIAL</span> : null}
                </div>
                <p className="text-sm font-bold text-slate-600 dark:text-slate-300 mt-1 truncate">{item.nomenclatura || item.nomenclatura_resolvida || 'Nomenclatura não informada'}</p>
                <div className="mt-3 grid grid-cols-1 md:grid-cols-3 gap-2 text-xs">
                  <div className="rounded-xl bg-slate-50 dark:bg-slate-900/50 px-3 py-2"><span className="font-black text-slate-400 uppercase text-[9px]">Local atual</span><p className="font-black mt-0.5">{categoryLabel(item.categoria_local_atual)}{item.local_atual ? ` • ${item.local_atual}` : ''}</p>{!item.local_atual && item.dossie_resumo?.leitura_operacional ? <p className="mt-1 text-[10px] font-bold text-amber-600 dark:text-amber-300">{item.dossie_resumo.leitura_operacional}</p> : null}</div>
                  <div className="rounded-xl bg-slate-50 dark:bg-slate-900/50 px-3 py-2"><span className="font-black text-slate-400 uppercase text-[9px]">Condição / status</span><p className="font-black mt-0.5">{conditionLabel(item.condicao_atual)} • {statusLabel(item.status_atual)}</p></div>
                  <div className="rounded-xl bg-slate-50 dark:bg-slate-900/50 px-3 py-2"><span className="font-black text-slate-400 uppercase text-[9px]">Aeronave / evidência</span><p className="font-black mt-0.5">{item.anv_atual || item.dossie_resumo?.ultimo_movimento?.aeronave || '—'}{item.ultima_evidencia_documento ? ` • ${humanizeDocumentReference(item.ultima_evidencia_documento, item.ultima_evidencia_tipo)}` : item.dossie_resumo?.ultimo_movimento?.documento ? ` • ${humanizeDocumentReference(item.dossie_resumo.ultimo_movimento.documento, item.dossie_resumo.ultimo_movimento.documento_tipo)}` : ''}</p>{item.dossie_resumo?.ultimo_movimento?.tipo ? <p className="mt-1 text-[10px] font-bold text-slate-400">{eventTypeLabel(`${item.dossie_resumo.ultimo_movimento.tipo}_ANV`)} • {formatDate(item.dossie_resumo.ultimo_movimento.data, true)}</p> : null}</div>
                </div>
                {advancedOpen ? (
                  <div className="mt-2 grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-2 text-xs">
                    <div className="rounded-xl bg-cyan-50 dark:bg-cyan-950/20 px-3 py-2"><span className="font-black text-cyan-700 dark:text-cyan-300 uppercase text-[9px]">Motivo apurado</span><p className="font-black mt-0.5">{item.motivo_atual || 'Motivo não identificado'}</p><p className="mt-1 text-[10px] font-bold text-slate-400">{item.motivo_documento ? humanizeDocumentReference(item.motivo_documento, item.motivo_evento_tipo) : item.motivo_evento_tipo ? eventTypeLabel(item.motivo_evento_tipo) : 'Sem documento causal identificado'}</p></div>
                    <div className="rounded-xl bg-slate-50 dark:bg-slate-900/50 px-3 py-2"><span className="font-black text-slate-400 uppercase text-[9px]">Tempo / reparo</span><p className="font-black mt-0.5">{item.dias_local_atual === null || item.dias_local_atual === undefined ? 'Tempo não determinado' : `${item.dias_local_atual} dia(s) no local`}</p><p className="mt-1 text-[10px] font-bold text-slate-400">{repairStateLabel(item.prioridade_operacional?.situacao_reparo)}</p></div>
                    <div className="rounded-xl bg-slate-50 dark:bg-slate-900/50 px-3 py-2"><span className="font-black text-slate-400 uppercase text-[9px]">PPU / criticidade</span><p className="font-black mt-0.5">PPU efetivo PN: {item.ppu_disponibilidade_conhecida === false ? 'indeterminado' : (item.ppu_quantidade_efetiva_pn ?? 0)}</p><p className="mt-1 text-[10px] font-bold text-slate-400">{item.controle_critico ? 'Controle crítico: SIM' : 'Criticidade explícita: não confirmada'}</p></div>
                    <div className="rounded-xl bg-slate-50 dark:bg-slate-900/50 px-3 py-2"><span className="font-black text-slate-400 uppercase text-[9px]">Fontes cruzadas</span><p className="font-black mt-0.5 line-clamp-2">{(item.fontes_dossie || []).map(sourceLabel).join(' • ') || 'Somente cadastro atual'}</p>{item.conflitos_pendentes > 0 ? <p className="mt-1 text-[10px] font-black text-red-600">{item.conflitos_pendentes} conflito(s) pendente(s)</p> : null}</div>
                  </div>
                ) : null}
              </div>
              <div className="flex flex-wrap gap-2 xl:justify-end">
                {item.garantia_vencimento ? <span className={`px-3 py-2 rounded-xl text-[10px] font-black ${warrantyTone(item)}`}>Garantia {formatDate(item.garantia_vencimento)}</span> : null}
                <button onClick={() => openDossier(item)} className="inline-flex items-center gap-2 px-3 py-2 rounded-xl bg-slate-100 dark:bg-slate-700 font-black text-xs"><Eye size={15} /> Dossiê</button>
                {canEdit ? <button onClick={() => openMovement(item)} className="inline-flex items-center gap-2 px-3 py-2 rounded-xl bg-blue-600 text-white font-black text-xs"><ArrowRightLeft size={15} /> Movimentar</button> : null}
                {canEdit ? <button onClick={() => openEdit(item)} className="inline-flex items-center gap-2 px-3 py-2 rounded-xl bg-slate-900 dark:bg-slate-950 text-white font-black text-xs"><Edit3 size={15} /> Editar</button> : null}
              </div>
            </div>
          </article>
        ))}
      </section>

      {maintenanceProgramOpen ? <MaintenanceProgramModal token={token} onClose={() => setMaintenanceProgramOpen(false)} /> : null}

      {equipmentModal ? (
        <ModalShell
          title={equipmentModal === 'create' ? 'Novo equipamento serializado' : 'Editar cadastro técnico'}
          subtitle={equipmentModal === 'edit' ? 'Todos os campos podem ser corrigidos. Alterações de identidade ou posição geram evento auditável e preservam o histórico.' : 'PN + SN formam a identidade única do equipamento.'}
          onClose={() => setEquipmentModal(null)}
          footer={<div className="flex flex-wrap items-center justify-between gap-2"><div>{equipmentModal === 'edit' ? <button onClick={() => requestDeleteEquipment(selected)} className="px-4 py-2.5 rounded-xl bg-red-50 dark:bg-red-900/20 text-red-700 dark:text-red-300 font-black inline-flex items-center gap-2"><Trash2 size={16} /> Excluir / arquivar</button> : null}</div><div className="flex gap-2"><button onClick={() => setEquipmentModal(null)} className="px-4 py-2.5 rounded-xl bg-slate-200 dark:bg-slate-700 font-black">Cancelar</button><button onClick={saveEquipment} disabled={saving} className="px-5 py-2.5 rounded-xl bg-blue-600 text-white font-black inline-flex items-center gap-2 disabled:opacity-60"><Save size={16} /> Salvar</button></div></div>}
        >
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div><label className={labelClass}>PN *</label><input className={inputClass} value={equipmentForm.pn} onChange={(e) => setEquipmentForm((v) => ({ ...v, pn: e.target.value }))} /></div>
            <div><label className={labelClass}>SN *</label><input className={inputClass} value={equipmentForm.sn} onChange={(e) => setEquipmentForm((v) => ({ ...v, sn: e.target.value }))} /></div>
            <div className="md:col-span-2"><label className={labelClass}>Nomenclatura</label><input className={inputClass} value={equipmentForm.nomenclatura} onChange={(e) => setEquipmentForm((v) => ({ ...v, nomenclatura: e.target.value }))} /></div>
            <div><label className={labelClass}>Horas acumuladas</label><input type="number" step="0.01" className={inputClass} value={equipmentForm.horas_acumuladas} onChange={(e) => setEquipmentForm((v) => ({ ...v, horas_acumuladas: e.target.value }))} /></div>
            <div><label className={labelClass}>Origem da entrada</label><input className={inputClass} value={equipmentForm.origem_entrada} onChange={(e) => setEquipmentForm((v) => ({ ...v, origem_entrada: e.target.value }))} /></div>
            <div><label className={labelClass}>Documento de entrada</label><input className={inputClass} value={equipmentForm.documento_entrada} onChange={(e) => setEquipmentForm((v) => ({ ...v, documento_entrada: e.target.value }))} /></div>
            <div><label className={labelClass}>Data de entrada</label><input type="date" className={inputClass} value={equipmentForm.data_entrada} onChange={(e) => setEquipmentForm((v) => ({ ...v, data_entrada: e.target.value }))} /></div>
            <div><label className={labelClass}>Início da garantia</label><input type="date" className={inputClass} value={equipmentForm.garantia_inicio} onChange={(e) => setEquipmentForm((v) => ({ ...v, garantia_inicio: e.target.value }))} /></div>
            <div><label className={labelClass}>Vencimento da garantia</label><input type="date" className={inputClass} value={equipmentForm.garantia_vencimento} onChange={(e) => setEquipmentForm((v) => ({ ...v, garantia_vencimento: e.target.value }))} /></div>
            <div><label className={labelClass}>Documento da garantia</label><input className={inputClass} value={equipmentForm.garantia_documento} onChange={(e) => setEquipmentForm((v) => ({ ...v, garantia_documento: e.target.value }))} /></div>
            <div className="md:col-span-2"><label className={labelClass}>Observação da garantia</label><textarea className={`${inputClass} min-h-20`} value={equipmentForm.garantia_observacao} onChange={(e) => setEquipmentForm((v) => ({ ...v, garantia_observacao: e.target.value }))} /></div>
            <label className="md:col-span-2 flex items-center gap-3 rounded-xl border border-slate-200 dark:border-slate-700 p-3 font-bold text-sm"><input type="checkbox" checked={equipmentForm.garantia_alerta_ativo} onChange={(e) => setEquipmentForm((v) => ({ ...v, garantia_alerta_ativo: e.target.checked }))} /> Alertar vencimento desta garantia no Radar de Criticidade</label>
          </div>
          {equipmentModal === 'edit' ? (
            <div className="mt-6 pt-5 border-t border-slate-200 dark:border-slate-700">
              <div className="rounded-2xl bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-900 p-4 mb-4 text-xs font-bold text-amber-800 dark:text-amber-300">
                Você pode corrigir todos os campos. Alterações de PN, SN, localização, aeronave, status, condição ou confiança geram um evento de correção no Livro; o histórico anterior não é apagado.
              </div>
              <h4 className="font-black uppercase text-xs tracking-wider mb-3">Situação atual / correção</h4>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div><label className={labelClass}>Tipo de local atual</label><select className={inputClass} value={equipmentForm.categoria_local_atual} onChange={(e) => setEquipmentForm((v) => ({ ...v, categoria_local_atual: e.target.value }))}>{categoryOptions.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></div>
                <div><label className={labelClass}>Local atual</label><input className={inputClass} value={equipmentForm.local_atual} onChange={(e) => setEquipmentForm((v) => ({ ...v, local_atual: e.target.value }))} /></div>
                <div><label className={labelClass}>Aeronave atual</label><input className={inputClass} placeholder="Ex.: 4005" value={equipmentForm.anv_atual} onChange={(e) => setEquipmentForm((v) => ({ ...v, anv_atual: e.target.value }))} /></div>
                <div><label className={labelClass}>Condição atual</label><select className={inputClass} value={equipmentForm.condicao_atual} onChange={(e) => setEquipmentForm((v) => ({ ...v, condicao_atual: e.target.value }))}>{conditionOptions.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></div>
                <div><label className={labelClass}>Situação atual</label><select className={inputClass} value={equipmentForm.status_atual} onChange={(e) => setEquipmentForm((v) => ({ ...v, status_atual: e.target.value }))}>{statusOptions.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></div>
                <div><label className={labelClass}>Grau de confirmação do local</label><select className={inputClass} value={equipmentForm.confianca_localizacao} onChange={(e) => setEquipmentForm((v) => ({ ...v, confianca_localizacao: e.target.value }))}>{confidenceOptions.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></div>
                <div><label className={labelClass}>Documento da correção</label><input className={inputClass} value={equipmentForm.documento_correcao || ''} onChange={(e) => setEquipmentForm((v) => ({ ...v, documento_correcao: e.target.value }))} /></div>
                <div className="md:col-span-2"><label className={labelClass}>Motivo da correção *</label><textarea className={`${inputClass} min-h-20`} value={equipmentForm.motivo_edicao || ''} onChange={(e) => setEquipmentForm((v) => ({ ...v, motivo_edicao: e.target.value }))} placeholder="Obrigatório quando a identidade ou a situação atual for alterada." /></div>
                <div className="md:col-span-2"><label className={labelClass}>Observação da correção</label><textarea className={`${inputClass} min-h-20`} value={equipmentForm.observacao_edicao || ''} onChange={(e) => setEquipmentForm((v) => ({ ...v, observacao_edicao: e.target.value }))} /></div>
              </div>
            </div>
          ) : null}

          {equipmentModal === 'create' ? (
            <div className="mt-6 pt-5 border-t border-slate-200 dark:border-slate-700">
              <h4 className="font-black uppercase text-xs tracking-wider mb-3">Posição inicial — opcional</h4>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div><label className={labelClass}>Categoria</label><select className={inputClass} value={equipmentForm.categoria_local_atual} onChange={(e) => setEquipmentForm((v) => ({ ...v, categoria_local_atual: e.target.value }))}>{categoryOptions.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></div>
                <div><label className={labelClass}>Local</label><input className={inputClass} value={equipmentForm.local_atual} onChange={(e) => setEquipmentForm((v) => ({ ...v, local_atual: e.target.value }))} /></div>
                <div><label className={labelClass}>Aeronave</label><input className={inputClass} value={equipmentForm.anv_atual} onChange={(e) => setEquipmentForm((v) => ({ ...v, anv_atual: e.target.value }))} /></div>
                <div><label className={labelClass}>Condição</label><select className={inputClass} value={equipmentForm.condicao_atual} onChange={(e) => setEquipmentForm((v) => ({ ...v, condicao_atual: e.target.value }))}>{conditionOptions.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></div>
              </div>
            </div>
          ) : null}
        </ModalShell>
      ) : null}

      {eventModal && selected ? (
        <ModalShell
          title="Registrar movimentação"
          subtitle={`${selected.pn} / SN ${selected.sn} • Origem atual: ${categoryLabel(selected.categoria_local_atual)}${selected.local_atual ? ` • ${selected.local_atual}` : ''}`}
          onClose={() => setEventModal(false)}
          footer={<div className="flex justify-end gap-2"><button onClick={() => setEventModal(false)} className="px-4 py-2.5 rounded-xl bg-slate-200 dark:bg-slate-700 font-black">Cancelar</button><button onClick={saveEvent} disabled={saving} className="px-5 py-2.5 rounded-xl bg-blue-600 text-white font-black inline-flex items-center gap-2 disabled:opacity-60"><Save size={16} /> Registrar movimentação</button></div>}
        >
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div><label className={labelClass}>Tipo de movimentação *</label><select className={inputClass} value={eventForm.tipo_evento} onChange={(e) => setEventForm((v) => ({ ...v, tipo_evento: e.target.value }))}>{eventTypeOptions.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></div>
            <div><label className={labelClass}>Data efetiva *</label><input type="datetime-local" className={inputClass} value={eventForm.data_evento} onChange={(e) => setEventForm((v) => ({ ...v, data_evento: e.target.value }))} /></div>
            <div><label className={labelClass}>Tipo de local de destino</label><select className={inputClass} value={eventForm.categoria_destino} onChange={(e) => setEventForm((v) => ({ ...v, categoria_destino: e.target.value }))}>{categoryOptions.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></div>
            <div><label className={labelClass}>Local de destino</label><input className={inputClass} value={eventForm.local_destino} onChange={(e) => setEventForm((v) => ({ ...v, local_destino: e.target.value }))} /></div>
            <div><label className={labelClass}>Aeronave</label><input className={inputClass} placeholder="Ex.: 4003" value={eventForm.anv_destino} onChange={(e) => setEventForm((v) => ({ ...v, anv_destino: e.target.value }))} /></div>
            <div><label className={labelClass}>Condição resultante</label><select className={inputClass} value={eventForm.condicao_resultante} onChange={(e) => setEventForm((v) => ({ ...v, condicao_resultante: e.target.value }))}>{conditionOptions.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></div>
            <div><label className={labelClass}>Situação após a movimentação</label><select className={inputClass} value={eventForm.status_resultante} onChange={(e) => setEventForm((v) => ({ ...v, status_resultante: e.target.value }))}>{statusOptions.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></div>
            <div><label className={labelClass}>Grau de confirmação</label><select className={inputClass} value={eventForm.confianca} onChange={(e) => setEventForm((v) => ({ ...v, confianca: e.target.value }))}>{confidenceOptions.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></div>
            <div><label className={labelClass}>Tipo do documento</label><input className={inputClass} placeholder="OS, PIM, WO, STC, OSR..." value={eventForm.documento_tipo} onChange={(e) => setEventForm((v) => ({ ...v, documento_tipo: e.target.value }))} /></div>
            <div><label className={labelClass}>Número / referência do documento</label><input className={inputClass} value={eventForm.documento} onChange={(e) => setEventForm((v) => ({ ...v, documento: e.target.value }))} /></div>
            <div><label className={labelClass}>PIM</label><input className={inputClass} value={eventForm.pim} onChange={(e) => setEventForm((v) => ({ ...v, pim: e.target.value }))} /></div>
            <div><label className={labelClass}>OS</label><input className={inputClass} value={eventForm.os} onChange={(e) => setEventForm((v) => ({ ...v, os: e.target.value }))} /></div>
            <div className="md:col-span-2"><label className={labelClass}>Motivo da movimentação *</label><textarea className={`${inputClass} min-h-20`} value={eventForm.motivo} onChange={(e) => setEventForm((v) => ({ ...v, motivo: e.target.value }))} /></div>
            <div className="md:col-span-2"><label className={labelClass}>Observação</label><textarea className={`${inputClass} min-h-20`} value={eventForm.observacao} onChange={(e) => setEventForm((v) => ({ ...v, observacao: e.target.value }))} /></div>
          </div>
        </ModalShell>
      ) : null}


      {deleteEquipment ? (
        <ModalShell
          title={`Excluir / arquivar — ${deleteEquipment.pn} / SN ${deleteEquipment.sn}`}
          subtitle="Equipamento sem histórico pode ser excluído. Se já houver eventos ou vínculos, o SISHA arquiva o cadastro e preserva o Livro de Eventos."
          onClose={() => setDeleteEquipment(null)}
          footer={<div className="flex justify-end gap-2"><button onClick={() => setDeleteEquipment(null)} className="px-4 py-2.5 rounded-xl bg-slate-200 dark:bg-slate-700 font-black">Cancelar</button><button onClick={doDeleteEquipment} disabled={saving} className="px-5 py-2.5 rounded-xl bg-red-600 text-white font-black disabled:opacity-50">Confirmar</button></div>}
        >
          <div className="rounded-2xl border border-red-200 bg-red-50 dark:bg-red-900/20 dark:border-red-900 p-4 text-sm font-bold text-red-800 dark:text-red-300">
            Esta ação nunca apaga o histórico de um equipamento que já possui eventos. Cadastros com rastreabilidade serão apenas retirados das consultas de rotina.
          </div>
        </ModalShell>
      ) : null}

      {masterModal ? (
        <ModalShell
          title="Importar relação de equipamentos"
          subtitle="Aceita ZIP, XLSX, XLS, CSV ou ODS. PN + SN são obrigatórios; localização é opcional e nunca será inventada."
          onClose={() => setMasterModal(false)}
          wide
          footer={masterDraft?.rows?.length ? <div className="flex flex-wrap items-center justify-between gap-3"><p className="text-xs font-bold text-slate-500">{masterDraft.rows.length} equipamento(s) identificados • localização desconhecida é válida</p><div className="flex gap-2"><button onClick={() => setMasterDraft(null)} className="px-4 py-2.5 rounded-xl bg-slate-200 dark:bg-slate-700 font-black">Trocar arquivo</button><button onClick={applyMaster} disabled={masterLoading || masterRowIssues(masterDraft.rows).some((issues) => issues.length)} className="px-5 py-2.5 rounded-xl bg-cyan-700 text-white font-black disabled:opacity-50">{masterLoading ? 'APLICANDO...' : 'APLICAR CADASTRO MESTRE'}</button></div></div> : null}
        >
          {!masterDraft ? (
            <div className="space-y-5">
              <div className="rounded-2xl border border-cyan-200 bg-cyan-50 dark:bg-cyan-900/20 dark:border-cyan-900 p-4 text-sm">
                <p className="font-black text-cyan-900 dark:text-cyan-200">Objetivo</p>
                <p className="mt-2 font-bold text-cyan-800 dark:text-cyan-300">Criar o universo conhecido de equipamentos físicos do Esquadrão. Um equipamento pode entrar somente com PN + SN e permanecer com localização NÃO DETERMINADA até surgir evidência confiável.</p>
                <p className="mt-2 text-xs font-bold text-cyan-700 dark:text-cyan-400">ZIP: o SISHA procura planilhas XLSX/XLS/CSV/ODS dentro do arquivo e cruza duplicidades de PN + SN entre elas.</p>
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div><label className={labelClass}>Arquivo / ZIP</label><input type="file" accept=".zip,.xlsx,.xls,.csv,.ods" className={inputClass} onChange={(event) => setMasterFile(event.target.files?.[0] || null)} /></div>
                <div><label className={labelClass}>Data de referência</label><input type="date" className={inputClass} value={masterDate} onChange={(event) => setMasterDate(event.target.value)} /></div>
              </div>
              <button onClick={() => previewMaster()} disabled={!masterFile || masterLoading} className="px-5 py-2.5 rounded-xl bg-cyan-700 text-white font-black disabled:opacity-50">{masterLoading ? 'LENDO...' : 'LER E CONFERIR'}</button>
            </div>
          ) : (
            <div className="space-y-4">
              <div className="grid grid-cols-1 lg:grid-cols-3 gap-3">
                <div className="rounded-2xl bg-slate-50 dark:bg-slate-800 p-4"><span className={labelClass}>Fonte importada</span><p className="font-black text-sm break-all" title={masterDraft.arquivo_nome || ''}>{humanizeDocumentReference(masterDraft.arquivo_nome, 'CADASTRO_MANUAL')}</p></div>
                <div className="rounded-2xl bg-slate-50 dark:bg-slate-800 p-4"><span className={labelClass}>PN + SN válidos</span><p className="font-black text-xl">{masterDraft.linhas_validas || 0}</p></div>
                <div className="rounded-2xl bg-amber-50 dark:bg-amber-900/20 p-4"><span className={labelClass}>Regra de localização</span><p className="font-black text-sm text-amber-700 dark:text-amber-300">Se uma localização divergir do estado atual, vira conflito para confirmação; não sobrescreve silenciosamente.</p></div>
              </div>
              {(masterDraft.warnings || []).length ? <div className="rounded-2xl bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-900 p-3 text-xs font-bold text-amber-800 dark:text-amber-300">{masterDraft.warnings.slice(0, 8).join(' • ')}</div> : null}
              <div className="overflow-auto border border-slate-200 dark:border-slate-700 rounded-2xl max-h-[50vh]">
                <table className="min-w-[1150px] w-full text-xs">
                  <thead className="sticky top-0 bg-slate-100 dark:bg-slate-800 z-10"><tr>{['Fonte','Linha','PN','SN','Localização opcional','Categoria','Nomenclatura','Situação'].map((h) => <th key={h} className="text-left px-3 py-2 font-black uppercase text-[9px] text-slate-500">{h}</th>)}</tr></thead>
                  <tbody>
                    {masterDraft.rows.slice(masterPage * 100, masterPage * 100 + 100).map((row, pageIndex) => {
                      const absoluteIndex = masterPage * 100 + pageIndex;
                      const issues = masterRowIssues(masterDraft.rows)[absoluteIndex] || [];
                      return <tr key={`${row.arquivo_origem}-${row.linha_origem}-${absoluteIndex}`} className="border-t border-slate-100 dark:border-slate-800 align-top">
                        <td className="px-3 py-2 max-w-48 break-all">{humanizeDocumentReference(row.arquivo_origem, 'CADASTRO_MANUAL') || '—'}{row.aba_origem ? ` • aba ${row.aba_origem}` : ''}</td>
                        <td className="px-3 py-2 font-black">{row.linha_origem || absoluteIndex + 1}</td>
                        <td className="px-2 py-2"><input className={`${inputClass} min-w-32`} value={row.pn || ''} onChange={(e) => updateMasterRow(absoluteIndex, 'pn', e.target.value)} /></td>
                        <td className="px-2 py-2"><input className={`${inputClass} min-w-28`} value={row.sn || ''} onChange={(e) => updateMasterRow(absoluteIndex, 'sn', e.target.value)} /></td>
                        <td className="px-2 py-2"><input className={`${inputClass} min-w-40`} value={row.localizacao || ''} onChange={(e) => updateMasterRow(absoluteIndex, 'localizacao', e.target.value)} placeholder="Pode ficar vazio" /></td>
                        <td className="px-2 py-2"><select className={`${inputClass} min-w-36`} value={row.categoria_destino || 'DESCONHECIDO'} onChange={(e) => updateMasterRow(absoluteIndex, 'categoria_destino', e.target.value)}>{categoryOptions.map(([k,l]) => <option key={k} value={k}>{l}</option>)}</select></td>
                        <td className="px-2 py-2"><input className={`${inputClass} min-w-48`} value={row.nomenclatura || ''} onChange={(e) => updateMasterRow(absoluteIndex, 'nomenclatura', e.target.value)} /></td>
                        <td className="px-3 py-2">{issues.length ? <span className="font-black text-red-600">{issues.join(', ')}</span> : <span className="font-black text-emerald-600">OK</span>}</td>
                      </tr>;
                    })}
                  </tbody>
                </table>
              </div>
              {masterDraft.rows.length > 100 ? <div className="flex justify-between items-center text-xs font-bold"><button onClick={() => setMasterPage((p) => Math.max(0, p - 1))} disabled={masterPage === 0} className="px-3 py-2 rounded-lg bg-slate-100 dark:bg-slate-800 disabled:opacity-40">Anterior</button><span>Página {masterPage + 1} de {Math.ceil(masterDraft.rows.length / 100)}</span><button onClick={() => setMasterPage((p) => Math.min(Math.ceil(masterDraft.rows.length / 100) - 1, p + 1))} disabled={masterPage >= Math.ceil(masterDraft.rows.length / 100) - 1} className="px-3 py-2 rounded-lg bg-slate-100 dark:bg-slate-800 disabled:opacity-40">Próxima</button></div> : null}
            </div>
          )}
        </ModalShell>
      ) : null}

      {conflictsOpen ? (
        <ModalShell
          title={`Conflitos de localização${locationConflicts.length ? ` — ${locationConflicts.length}` : ''}`}
          subtitle="Um PN + SN só pode possuir uma localização atual válida. A decisão confirmada vira o estado corrente; a outra evidência permanece no Livro como histórica/invalidada."
          onClose={() => setConflictsOpen(false)}
          wide
        >
          {conflictsLoading ? <div className="py-10 text-center font-bold text-slate-400">Conferindo conflitos...</div> : null}
          {!conflictsLoading && !locationConflicts.length ? <div className="rounded-2xl bg-emerald-50 dark:bg-emerald-900/20 border border-emerald-200 dark:border-emerald-900 p-5 text-sm font-black text-emerald-700 dark:text-emerald-300">Nenhum conflito de localização pendente.</div> : null}
          <div className="space-y-4">
            {locationConflicts.map((conflict) => {
              const equipment = conflict.equipamento || {};
              const current = conflict.estado_atual || {};
              const candidate = conflict.estado_candidato || {};
              const source = conflict.payload?.fonte || {};
              const reason = conflictReasons[conflict.id] || '';
              return <div key={conflict.id} className="rounded-2xl border border-red-200 dark:border-red-900 p-4">
                <div className="flex flex-wrap items-center gap-2"><span className="font-black text-lg">{equipment.pn || conflict.pn}</span><span className="px-2.5 py-1 rounded-lg bg-blue-100 text-blue-700 font-black text-xs">SN {equipment.sn || conflict.sn}</span><span className="px-2.5 py-1 rounded-lg bg-red-100 text-red-700 font-black text-[10px]">CONFLITO</span></div>
                <div className="grid grid-cols-1 lg:grid-cols-2 gap-3 mt-4">
                  <div className="rounded-xl bg-slate-50 dark:bg-slate-800 p-4"><span className={labelClass}>Localização atualmente válida</span><p className="font-black">{categoryLabel(current.categoria_local_atual)}{current.local_atual ? ` • ${current.local_atual}` : ''}{current.anv_atual ? ` • ANV ${current.anv_atual}` : ''}</p></div>
                  <div className="rounded-xl bg-amber-50 dark:bg-amber-900/20 p-4"><span className={labelClass}>Nova evidência</span><p className="font-black">{categoryLabel(candidate.categoria_local_atual)}{candidate.local_atual ? ` • ${candidate.local_atual}` : ''}{candidate.anv_atual ? ` • ANV ${candidate.anv_atual}` : ''}</p><p className="mt-1 text-[10px] font-bold text-amber-700 dark:text-amber-300">{sourceLabel(source.source_type || conflict.documento_tipo || 'FONTE')}{source.documento || conflict.documento ? ` • ${humanizeDocumentReference(source.documento || conflict.documento, source.source_type || conflict.documento_tipo)}` : ''}{source.linha ? ` • linha ${source.linha}` : ''}</p></div>
                </div>
                <div className="mt-3"><label className={labelClass}>Motivo da decisão *</label><textarea className={`${inputClass} min-h-16`} value={reason} onChange={(e) => setConflictReasons((currentReasons) => ({ ...currentReasons, [conflict.id]: e.target.value }))} placeholder="Ex.: conferência física realizada em 08/08/2026." /></div>
                <div className="flex flex-wrap justify-end gap-2 mt-3"><button onClick={() => resolveConflict(conflict, 'CURRENT')} disabled={saving || !reason.trim()} className="px-4 py-2.5 rounded-xl bg-slate-800 text-white font-black disabled:opacity-50">Manter localização atual</button><button onClick={() => resolveConflict(conflict, 'CANDIDATE')} disabled={saving || !reason.trim()} className="px-4 py-2.5 rounded-xl bg-red-600 text-white font-black disabled:opacity-50">Confirmar nova evidência</button></div>
              </div>;
            })}
          </div>
        </ModalShell>
      ) : null}

      {inventoryModal ? (
        <ModalShell
          title="Importar inventário de localização"
          subtitle="O inventário serializado identifica as unidades já contadas no PPU. Nunca soma uma segunda quantidade ao estoque."
          onClose={() => setInventoryModal(false)}
          wide
          footer={inventoryDraft?.rows?.length ? <div className="flex flex-wrap items-center justify-between gap-3"><p className="text-xs font-bold text-slate-500">{inventoryDraft.rows.length} linha(s) na conferência • uma linha por PN + SN</p><div className="flex gap-2"><button onClick={() => setInventoryDraft(null)} className="px-4 py-2.5 rounded-xl bg-slate-200 dark:bg-slate-700 font-black">Trocar arquivo</button><button onClick={applyInventory} disabled={inventoryLoading || inventoryRowIssues(inventoryDraft.rows).some((issues) => issues.length)} className="px-5 py-2.5 rounded-xl bg-purple-600 text-white font-black disabled:opacity-50">{inventoryLoading ? 'APLICANDO...' : 'APLICAR INVENTÁRIO'}</button></div></div> : null}
        >
          {!inventoryDraft ? (
            <div className="space-y-5">
              <div className="rounded-2xl border border-blue-200 bg-blue-50 dark:bg-blue-900/20 dark:border-blue-900 p-4 text-sm">
                <p className="font-black text-blue-900 dark:text-blue-200">Cabeçalhos obrigatórios</p>
                <p className="mt-2 font-bold text-blue-800 dark:text-blue-300">PN / P/N / PART NUMBER • SN / S/N / SERIAL NUMBER • LOCAL / LOC / LOCALIZAÇÃO / LOCATION</p>
                <p className="mt-2 text-xs font-bold text-blue-700 dark:text-blue-400">Opcionais: NOMENCLATURA/DESCRIPTION, CATEGORIA, GARANTIA/VENCIMENTO e OBSERVAÇÃO. Formatos: XLSX, XLS, CSV e ODS.</p>
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div><label className={labelClass}>Arquivo</label><input type="file" accept=".xlsx,.xls,.csv,.ods" className={inputClass} onChange={(event) => setInventoryFile(event.target.files?.[0] || null)} /></div>
                <div><label className={labelClass}>Data efetiva do inventário</label><input type="date" className={inputClass} value={snapshotDate} onChange={(event) => setSnapshotDate(event.target.value)} /></div>
              </div>
              <button onClick={() => previewInventory()} disabled={!inventoryFile || inventoryLoading} className="px-5 py-2.5 rounded-xl bg-purple-600 text-white font-black disabled:opacity-50">{inventoryLoading ? 'LENDO...' : 'LER E CONFERIR'}</button>
            </div>
          ) : (
            <div className="space-y-4">
              <div className="grid grid-cols-1 lg:grid-cols-3 gap-3">
                <div className="rounded-2xl bg-slate-50 dark:bg-slate-800 p-4"><span className={labelClass}>Fonte / aba</span><p className="font-black text-sm" title={inventoryDraft.arquivo_nome || ''}>{humanizeDocumentReference(inventoryDraft.arquivo_nome, 'INVENTARIO_EQUIPAMENTOS')} • {inventoryDraft.aba}</p></div>
                <div className="rounded-2xl bg-slate-50 dark:bg-slate-800 p-4"><span className={labelClass}>Modo de atualização</span><select className={inputClass} value={inventoryMode} onChange={(event) => setInventoryMode(event.target.value)}><option value="merge">Mesclar com o cadastro atual</option><option value="replace">Substituir a fotografia atual do inventário</option></select></div>
                <div className="rounded-2xl bg-emerald-50 dark:bg-emerald-900/20 p-4"><span className={labelClass}>Regra de contagem</span><p className="font-black text-sm text-emerald-700 dark:text-emerald-300">5 PPU + 5 SN correspondentes = 5 equipamentos, nunca 10.</p></div>
              </div>
              <p className="text-xs font-bold text-slate-500">Mesclar não marca equipamentos ausentes. Substituir troca a fotografia do inventário serializado, mas não apaga equipamentos nem histórico; ausências ficam sinalizadas.</p>
              <div className="overflow-auto border border-slate-200 dark:border-slate-700 rounded-2xl max-h-[48vh]">
                <table className="min-w-[1100px] w-full text-xs">
                  <thead className="sticky top-0 bg-slate-100 dark:bg-slate-800 z-10"><tr>{['Linha','PN','SN','Localização','Categoria','Nomenclatura','Garantia','Situação'].map((h) => <th key={h} className="text-left px-3 py-2 font-black uppercase text-[9px] text-slate-500">{h}</th>)}</tr></thead>
                  <tbody>
                    {inventoryDraft.rows.slice(inventoryPage * 100, inventoryPage * 100 + 100).map((row, pageIndex) => {
                      const absoluteIndex = inventoryPage * 100 + pageIndex;
                      const issues = inventoryRowIssues(inventoryDraft.rows)[absoluteIndex] || [];
                      return <tr key={`${row.linha_origem}-${absoluteIndex}`} className="border-t border-slate-100 dark:border-slate-800 align-top">
                        <td className="px-3 py-2 font-black">{row.linha_origem || absoluteIndex + 1}</td>
                        <td className="px-2 py-2"><input className={`${inputClass} min-w-32`} value={row.pn || ''} onChange={(e) => updateInventoryRow(absoluteIndex, 'pn', e.target.value)} /></td>
                        <td className="px-2 py-2"><input className={`${inputClass} min-w-28`} value={row.sn || ''} onChange={(e) => updateInventoryRow(absoluteIndex, 'sn', e.target.value)} /></td>
                        <td className="px-2 py-2"><input className={`${inputClass} min-w-40`} value={row.localizacao || ''} onChange={(e) => updateInventoryRow(absoluteIndex, 'localizacao', e.target.value)} /></td>
                        <td className="px-2 py-2"><select className={`${inputClass} min-w-36`} value={row.categoria_destino || 'PPU'} onChange={(e) => updateInventoryRow(absoluteIndex, 'categoria_destino', e.target.value)}>{categoryOptions.map(([k,l]) => <option key={k} value={k}>{l}</option>)}</select></td>
                        <td className="px-2 py-2"><input className={`${inputClass} min-w-48`} value={row.nomenclatura || ''} onChange={(e) => updateInventoryRow(absoluteIndex, 'nomenclatura', e.target.value)} /></td>
                        <td className="px-2 py-2"><input type="date" className={`${inputClass} min-w-36`} value={row.garantia_vencimento || ''} onChange={(e) => updateInventoryRow(absoluteIndex, 'garantia_vencimento', e.target.value)} /></td>
                        <td className="px-3 py-2">{issues.length ? <span className="font-black text-red-600">{issues.join(', ')}</span> : <span className="font-black text-emerald-600">OK</span>}</td>
                      </tr>;
                    })}
                  </tbody>
                </table>
              </div>
              {inventoryDraft.rows.length > 100 ? <div className="flex justify-between items-center text-xs font-bold"><button onClick={() => setInventoryPage((p) => Math.max(0, p - 1))} disabled={inventoryPage === 0} className="px-3 py-2 rounded-lg bg-slate-100 dark:bg-slate-800 disabled:opacity-40">Anterior</button><span>Página {inventoryPage + 1} de {Math.ceil(inventoryDraft.rows.length / 100)}</span><button onClick={() => setInventoryPage((p) => Math.min(Math.ceil(inventoryDraft.rows.length / 100) - 1, p + 1))} disabled={inventoryPage >= Math.ceil(inventoryDraft.rows.length / 100) - 1} className="px-3 py-2 rounded-lg bg-slate-100 dark:bg-slate-800 disabled:opacity-40">Próxima</button></div> : null}
            </div>
          )}
        </ModalShell>
      ) : null}

      {reconciliationOpen ? (
        <ModalShell title="Conferência PPU × equipamentos serializados" subtitle="A quantidade oficial vem do PPU; os SNs identificam quais unidades compõem essa quantidade." onClose={() => setReconciliationOpen(false)} wide>
          <div className="rounded-2xl border border-emerald-200 bg-emerald-50 dark:bg-emerald-900/20 dark:border-emerald-900 p-4 mb-4 text-sm font-bold text-emerald-800 dark:text-emerald-300">
            Exemplo: PPU = 5 unidades e inventário serializado = 5 SN do mesmo PN/local → total operacional = 5, com os cinco SN identificados. O sistema não soma para 10.
          </div>
          {reconciliationMeta ? <div className="grid grid-cols-2 lg:grid-cols-5 gap-2 mb-4">{[['PPU oficial', reconciliationMeta.ppu], ['SN encontrados', reconciliationMeta.serializados], ['Unidades identificadas', reconciliationMeta.identificados], ['PPU sem SN', reconciliationMeta.semSn], ['SN sem PPU', reconciliationMeta.excedentes]].map(([label,value]) => <div key={label} className="rounded-xl bg-slate-50 dark:bg-slate-800 px-3 py-3"><p className="text-[9px] font-black uppercase text-slate-400">{label}</p><p className="text-lg font-black">{value || 0}</p></div>)}</div> : null}
          {reconciliationLoading ? <div className="py-10 text-center font-bold text-slate-400">Conferindo inventários...</div> : <div className="overflow-auto border border-slate-200 dark:border-slate-700 rounded-2xl max-h-[58vh]"><table className="min-w-[900px] w-full text-xs"><thead className="sticky top-0 bg-slate-100 dark:bg-slate-800"><tr>{['PN','Local','PPU','SN identificados','Sem SN','SN excedentes','SNs','Situação'].map((h) => <th key={h} className="px-3 py-2 text-left font-black uppercase text-[9px] text-slate-500">{h}</th>)}</tr></thead><tbody>{reconciliationRows.map((row, idx) => <tr key={`${row.pn}-${row.localizacao_normalizada}-${idx}`} className="border-t border-slate-100 dark:border-slate-800"><td className="px-3 py-2 font-black">{row.pn}</td><td className="px-3 py-2 font-bold">{row.localizacao_ppu || row.localizacao_serializada || '—'}</td><td className="px-3 py-2 font-black">{row.qtd_ppu}</td><td className="px-3 py-2 font-black">{row.qtd_identificada}</td><td className="px-3 py-2">{row.qtd_ppu_sem_sn}</td><td className="px-3 py-2">{row.qtd_sn_sem_ppu}</td><td className="px-3 py-2 max-w-sm whitespace-normal">{row.sns || '—'}</td><td className="px-3 py-2"><span className={`px-2 py-1 rounded-lg text-[9px] font-black ${reconciliationTone(row.status_reconciliacao)}`}>{row.status_reconciliacao}</span></td></tr>)}</tbody></table></div>}
        </ModalShell>
      ) : null}

      {osPimOpen ? (
        <ModalShell
          title={osPimMode === 'form' ? `${osPimForm.card_key ? 'Editar' : osPimForm.staging_id ? 'Revisar pendência' : 'Nova'} movimentação OS/PIM` : 'OS / OSR / PIM — Equipamentos e Aeronaves'}
          subtitle={osPimMode === 'form' ? 'PN+SN identificam o equipamento físico. Instalação, remoção e transferência alimentam o Livro; conflitos de posição exigem reconciliação humana.' : 'Movimentações dos equipamentos, configuração atual das aeronaves e pendências sugeridas pelo Chat Lince em um único local.'}
          onClose={() => setOsPimOpen(false)}
          footer={osPimMode === 'form' ? <div className="flex justify-between gap-2"><button onClick={() => setOsPimMode(osPimForm.staging_id ? 'staging' : 'list')} className="px-4 py-2.5 rounded-xl bg-slate-200 dark:bg-slate-700 font-black">Voltar</button><button onClick={saveOsPim} disabled={saving} className="px-5 py-2.5 rounded-xl bg-sky-700 text-white font-black disabled:opacity-50 inline-flex items-center gap-2"><Save size={16} /> {osPimForm.staging_id ? 'Revisar e aplicar ao Livro' : 'Salvar movimentação'}</button></div> : null}
        >
          {osPimMode !== 'form' ? (
            <div className="mb-4 flex flex-wrap gap-2">
              <button onClick={() => setOsPimMode('list')} className={`px-3 py-2 rounded-xl text-xs font-black ${osPimMode === 'list' ? 'bg-sky-700 text-white' : 'bg-slate-100 dark:bg-slate-800'}`}>Movimentações ({osPimCards.length})</button>
              <button onClick={() => setOsPimMode('aircraft')} className={`px-3 py-2 rounded-xl text-xs font-black ${osPimMode === 'aircraft' ? 'bg-sky-700 text-white' : 'bg-slate-100 dark:bg-slate-800'}`}>Configuração ANV</button>
              {canEdit ? <button onClick={() => setOsPimMode('staging')} className={`px-3 py-2 rounded-xl text-xs font-black ${osPimMode === 'staging' ? 'bg-amber-600 text-white' : 'bg-slate-100 dark:bg-slate-800'}`}>Pendências do Chat Lince ({osPimStaging.filter((row) => !row?.payload?.aplicado_2b7?.card_key).length})</button> : null}
              {canEdit ? <button onClick={openNewOsPim} className="ml-auto px-3 py-2 rounded-xl bg-emerald-600 text-white text-xs font-black inline-flex items-center gap-2"><Plus size={14} /> Nova movimentação</button> : null}
            </div>
          ) : null}

          {osPimMode === 'list' ? (
            <div className="space-y-3">
              {osPimLoading ? <div className="py-8 text-center font-bold text-slate-400">Consultando OS/PIM...</div> : null}
              {!osPimLoading && osPimCards.length === 0 ? <div className="rounded-2xl border border-dashed border-slate-300 dark:border-slate-700 p-8 text-center font-bold text-slate-400">Nenhuma movimentação OS/PIM vinculada ao Livro.</div> : null}
              {osPimCards.map((card) => (
                <article key={card.card_key} className="rounded-2xl border border-slate-200 dark:border-slate-700 p-4 bg-slate-50 dark:bg-slate-900/40">
                  <div className="flex flex-col lg:flex-row lg:items-start justify-between gap-3">
                    <div>
                      <div className="flex flex-wrap items-center gap-2"><span className="font-black text-lg">{card.os ? `OS ${card.os}` : card.osr ? `OSR ${card.osr}` : `PIM ${card.pim}`}</span><span className={`px-2 py-1 rounded-lg text-[10px] font-black ${osPimTone(card.status)}`}>{card.status}</span><span className="px-2 py-1 rounded-lg text-[10px] font-black bg-sky-100 text-sky-700 dark:bg-sky-900/30 dark:text-sky-300">{card.tipo_movimento}</span></div>
                      <p className="mt-1 text-sm font-black">PN {card.pn} • SN {card.sn}{card.nomenclatura ? ` • ${card.nomenclatura}` : ''}</p>
                      <p className="mt-1 text-xs font-bold text-slate-500">{formatDate(card.data_evento, true)}{card.pim ? ` • PIM ${card.pim}` : ''}{card.aeronave ? ` • ANV ${card.aeronave}` : ''}</p>
                    </div>
                    <div className="flex gap-2">
                      {canEdit && card.status !== 'CANCELADA' ? <button onClick={() => openEditOsPim(card)} className="px-3 py-2 rounded-xl bg-slate-900 text-white text-xs font-black"><Edit3 size={14} className="inline mr-1" />Editar</button> : null}
                      {canEdit && card.status !== 'CANCELADA' ? <button onClick={() => cancelOsPim(card)} className="px-3 py-2 rounded-xl bg-red-600 text-white text-xs font-black"><Trash2 size={14} className="inline mr-1" />Cancelar</button> : null}
                    </div>
                  </div>
                  <div className="mt-3 grid grid-cols-1 md:grid-cols-3 gap-2 text-xs">
                    <div className="rounded-xl bg-white dark:bg-slate-950 px-3 py-2"><span className={labelClass}>Origem</span><p className="font-black">{card.anv_origem || card.local_origem || card.categoria_origem || 'Estado anterior / não informado'}</p></div>
                    <div className="rounded-xl bg-white dark:bg-slate-950 px-3 py-2"><span className={labelClass}>Destino</span><p className="font-black">{card.anv_destino || card.local_destino || card.categoria_destino || 'A confirmar'}</p></div>
                    <div className="rounded-xl bg-white dark:bg-slate-950 px-3 py-2"><span className={labelClass}>Condição</span><p className="font-black">{conditionLabel(card.condicao_resultante)}</p></div>
                  </div>
                </article>
              ))}
            </div>
          ) : null}

          {osPimMode === 'aircraft' ? (
            <div className="space-y-4">
              <div className="rounded-2xl bg-blue-50 dark:bg-blue-950/20 border border-blue-200 dark:border-blue-900 p-4 text-xs font-bold text-blue-800 dark:text-blue-300">Esta configuração é derivada do estado atual de cada PN+SN. Um equipamento só pode aparecer em uma aeronave por vez; divergências ficam em Conflitos até reconciliação.</div>
              {aircraftConfiguration.length === 0 ? <div className="py-8 text-center font-bold text-slate-400">Nenhum equipamento com localização atual AERONAVE.</div> : null}
              {aircraftConfiguration.map((group) => (
                <section key={group.aeronave} className="rounded-2xl border border-slate-200 dark:border-slate-700 overflow-hidden">
                  <div className="px-4 py-3 bg-slate-100 dark:bg-slate-900 flex justify-between"><span className="font-black">N-{group.aeronave}</span><span className="text-xs font-black text-slate-500">{group.total} equipamento(s)</span></div>
                  <div className="divide-y divide-slate-200 dark:divide-slate-800">{(group.equipamentos || []).map((item) => <div key={item.id} className="px-4 py-3 flex flex-wrap justify-between gap-2 text-sm"><span className="font-black">{item.pn} • SN {item.sn}</span><span className="text-xs font-bold text-slate-500">{item.nomenclatura || '—'} • {conditionLabel(item.condicao_atual)}</span></div>)}</div>
                </section>
              ))}
            </div>
          ) : null}

          {osPimMode === 'staging' ? (
            <div className="space-y-3">
              <div className="rounded-2xl bg-amber-50 dark:bg-amber-950/20 border border-amber-200 dark:border-amber-900 p-4 text-xs font-bold text-amber-800 dark:text-amber-300">O Chat Lince apenas sugere os campos. Nenhuma sugestão altera o Livro sem identificar o equipamento e passar por revisão humana. Registros já aplicados permanecem auditáveis.</div>
              {osPimStaging.length === 0 ? <div className="py-8 text-center font-bold text-slate-400">Nenhuma pendência de OS / PIM encontrada.</div> : null}
              {osPimStaging.map((row) => {
                const applied = Boolean(row?.payload?.aplicado_2b7?.card_key);
                return <article key={row.id} className="rounded-2xl border border-slate-200 dark:border-slate-700 p-4">
                  <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-3">
                    <div><p className="font-black">{row.os_numero ? `OS ${row.os_numero}` : 'OS não identificada'} • PN {row.pn || '—'} • SN {row.sn || '—'}</p><p className="text-xs font-bold text-slate-500 mt-1">{row.tipo_evento || 'Evento indefinido'}{row.pim ? ` • PIM ${row.pim}` : ''}{row.aeronave ? ` • ANV ${row.aeronave}` : ''} • confiança {row.confianca ?? '—'}</p><p className="text-[10px] font-black uppercase mt-2 text-slate-400">{row.status || 'PENDENTE'}</p></div>
                    {canEdit && !applied ? <button onClick={() => reviewStagingOsPim(row)} className="px-3 py-2 rounded-xl bg-amber-600 text-white text-xs font-black">Revisar e aplicar</button> : <span className="px-3 py-2 rounded-xl bg-emerald-100 text-emerald-700 text-xs font-black">Aplicado</span>}
                  </div>
                </article>;
              })}
            </div>
          ) : null}

          {osPimMode === 'form' ? (
            <div className="space-y-5">
              {osPimForm.staging_id ? <div className="rounded-2xl bg-amber-50 dark:bg-amber-950/20 border border-amber-200 dark:border-amber-900 p-4 text-xs font-bold text-amber-800 dark:text-amber-300">Revise todos os campos sugeridos pelo Chat Lince. Ao salvar, a movimentação será registrada no Livro; a IA não decide a localização por conta própria.</div> : null}
              <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
                <label><span className={labelClass}>Tipo *</span><select disabled={Boolean(osPimForm.card_key)} className={`${inputClass} disabled:opacity-60`} value={osPimForm.tipo_movimento} onChange={(e) => setOsPimForm((v) => ({ ...v, tipo_movimento: e.target.value }))}><option value="INSTALACAO">Instalação</option><option value="REMOCAO">Remoção</option><option value="TRANSFERENCIA">Transferência</option><option value="MOVIMENTACAO">Outra movimentação</option></select></label>
                <label><span className={labelClass}>OS</span><input disabled={Boolean(osPimForm.card_key)} className={`${inputClass} disabled:opacity-60`} value={osPimForm.os} onChange={(e) => setOsPimForm((v) => ({ ...v, os: e.target.value.toUpperCase() }))} /></label>
                <label><span className={labelClass}>OSR</span><input disabled={Boolean(osPimForm.card_key)} className={`${inputClass} disabled:opacity-60`} value={osPimForm.osr} onChange={(e) => setOsPimForm((v) => ({ ...v, osr: e.target.value.toUpperCase() }))} /></label>
                <label><span className={labelClass}>PIM</span><input disabled={Boolean(osPimForm.card_key)} className={`${inputClass} disabled:opacity-60`} value={osPimForm.pim} onChange={(e) => setOsPimForm((v) => ({ ...v, pim: e.target.value.toUpperCase() }))} /></label>
                <label><span className={labelClass}>PN *</span><input disabled={Boolean(osPimForm.card_key)} className={`${inputClass} disabled:opacity-60`} value={osPimForm.pn} onChange={(e) => setOsPimForm((v) => ({ ...v, pn: e.target.value.toUpperCase() }))} /></label>
                <label><span className={labelClass}>SN *</span><input disabled={Boolean(osPimForm.card_key)} className={`${inputClass} disabled:opacity-60`} value={osPimForm.sn} onChange={(e) => setOsPimForm((v) => ({ ...v, sn: e.target.value.toUpperCase() }))} /></label>
                <label><span className={labelClass}>Data evento *</span><input type="datetime-local" className={inputClass} value={osPimForm.data_evento} onChange={(e) => setOsPimForm((v) => ({ ...v, data_evento: e.target.value }))} /></label>
                <label><span className={labelClass}>Aeronave</span><input className={inputClass} placeholder="4005" value={osPimForm.aeronave} onChange={(e) => setOsPimForm((v) => ({ ...v, aeronave: e.target.value.toUpperCase() }))} /></label>
              </div>

              <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                <section className="rounded-2xl border border-slate-200 dark:border-slate-700 p-4 space-y-3"><h4 className="font-black uppercase text-xs">Origem informada</h4><div className="grid grid-cols-1 md:grid-cols-2 gap-3"><label><span className={labelClass}>Categoria origem</span><select className={inputClass} value={osPimForm.categoria_origem} onChange={(e) => setOsPimForm((v) => ({ ...v, categoria_origem: e.target.value }))}><option value="">Usar posição atual</option>{categoryOptions.map(([value,label]) => <option key={value} value={value}>{label}</option>)}</select></label><label><span className={labelClass}>Local origem</span><input className={inputClass} value={osPimForm.local_origem} onChange={(e) => setOsPimForm((v) => ({ ...v, local_origem: e.target.value }))} /></label><label className="md:col-span-2"><span className={labelClass}>Aeronave origem</span><input className={inputClass} value={osPimForm.anv_origem} onChange={(e) => setOsPimForm((v) => ({ ...v, anv_origem: e.target.value.toUpperCase() }))} /></label></div></section>
                <section className="rounded-2xl border border-slate-200 dark:border-slate-700 p-4 space-y-3"><h4 className="font-black uppercase text-xs">Destino / estado resultante</h4><div className="grid grid-cols-1 md:grid-cols-2 gap-3"><label><span className={labelClass}>Categoria destino</span><select className={inputClass} value={osPimForm.categoria_destino} onChange={(e) => setOsPimForm((v) => ({ ...v, categoria_destino: e.target.value }))}>{categoryOptions.map(([value,label]) => <option key={value} value={value}>{label}</option>)}</select></label><label><span className={labelClass}>Local destino</span><input className={inputClass} value={osPimForm.local_destino} onChange={(e) => setOsPimForm((v) => ({ ...v, local_destino: e.target.value }))} /></label><label><span className={labelClass}>Aeronave destino</span><input className={inputClass} value={osPimForm.anv_destino} onChange={(e) => setOsPimForm((v) => ({ ...v, anv_destino: e.target.value.toUpperCase() }))} /></label><label><span className={labelClass}>Condição</span><select className={inputClass} value={osPimForm.condicao_resultante} onChange={(e) => setOsPimForm((v) => ({ ...v, condicao_resultante: e.target.value }))}>{conditionOptions.map(([value,label]) => <option key={value} value={value}>{label}</option>)}</select></label></div></section>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-3"><label><span className={labelClass}>Documento referência</span><input className={inputClass} value={osPimForm.documento_referencia} onChange={(e) => setOsPimForm((v) => ({ ...v, documento_referencia: e.target.value }))} /></label><label><span className={labelClass}>Motivo / condição da movimentação *</span><input className={inputClass} placeholder="Instalação, pane, possível pane, pronto uso..." value={osPimForm.motivo_movimento} onChange={(e) => setOsPimForm((v) => ({ ...v, motivo_movimento: e.target.value }))} /></label></div>
              <label><span className={labelClass}>Observações</span><textarea className={`${inputClass} min-h-24`} value={osPimForm.observacao} onChange={(e) => setOsPimForm((v) => ({ ...v, observacao: e.target.value }))} /></label>
              <div className="rounded-2xl bg-slate-50 dark:bg-slate-900/50 border border-slate-200 dark:border-slate-700 p-4 text-xs font-bold text-slate-600 dark:text-slate-300">Prefixos de OS 4001, 4003, 4004, 4005, 4010 e 4012 identificam aeronaves. HV/MV/SV/VN/PA/MT identificam oficinas/manutenção. O sistema usa esses prefixos apenas como evidência; PN+SN continuam obrigatórios e conflitos de localização nunca são sobrescritos silenciosamente.</div>
            </div>
          ) : null}
        </ModalShell>
      ) : null}

      {stcOpen ? (
        <ModalShell
          title={stcMode === 'form' ? `${stcForm.card_key ? 'Editar' : 'Nova'} STC` : 'STC — Equipamentos — Consulta e Rastreabilidade'}
          subtitle={stcMode === 'form' ? 'PN+SN identificam o equipamento. A STC alimenta o Livro de Eventos e conflitos de localização nunca são resolvidos silenciosamente.' : 'Cards derivados do Livro de Eventos. Editar uma STC sincroniza os eventos; cancelar invalida a movimentação sem apagar o histórico.'}
          onClose={() => { setStcOpen(false); setStcMode('list'); setStcForm(emptyStcForm()); }}
          wide
          footer={stcMode === 'form' ? <div className="flex justify-between gap-2"><button onClick={() => setStcMode('list')} className="px-4 py-2.5 rounded-xl bg-slate-200 dark:bg-slate-700 font-black">Voltar</button><button onClick={saveStc} disabled={saving} className="px-5 py-2.5 rounded-xl bg-indigo-700 text-white font-black disabled:opacity-50 inline-flex items-center gap-2"><Save size={16} /> Salvar STC</button></div> : null}
        >
          {stcMode === 'list' ? (
            <div className="space-y-4">
              <div className="flex flex-col sm:flex-row gap-2 justify-between">
                <div className="text-xs font-bold text-slate-500 dark:text-slate-400">{stcLoading ? 'Consultando STCs...' : `${stcCards.length} registro(s) localizado(s)`}</div>
                {canEdit ? <button onClick={openNewStc} className="px-4 py-2.5 rounded-xl bg-indigo-700 text-white font-black text-sm inline-flex items-center gap-2"><Plus size={16} /> Nova STC</button> : null}
              </div>
              {stcCards.length === 0 && !stcLoading ? <div className="rounded-2xl border border-dashed border-slate-300 dark:border-slate-700 p-8 text-center font-bold text-slate-400">Nenhuma STC vinculada ao Livro de Equipamentos.</div> : null}
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
                {stcCards.map((card) => (
                  <div key={card.card_key} className="rounded-2xl border border-slate-200 dark:border-slate-700 bg-slate-50/60 dark:bg-slate-950/30 p-4">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2"><span className="font-black text-lg">STC {card.numero_stc}</span><span className={`px-2 py-1 rounded-lg text-[10px] font-black ${stcStatusTone(card.status)}`}>{card.status}</span></div>
                        <p className="font-black text-blue-700 dark:text-blue-300 mt-1">{card.pn} • SN {card.sn}</p>
                        <p className="text-xs font-bold text-slate-500 mt-1">{card.nomenclatura || 'Nomenclatura não informada'}</p>
                      </div>
                      {canEdit && card.status !== 'CANCELADA' ? <button onClick={() => openEditStc(card)} className="p-2 rounded-xl bg-slate-900 text-white" title="Editar STC"><Edit3 size={15} /></button> : null}
                    </div>
                    <div className="mt-3 grid grid-cols-2 gap-2 text-xs">
                      <div><span className={labelClass}>Motivo</span><p className="font-black">{card.motivo_stc || '—'}</p></div>
                      <div><span className={labelClass}>Envio</span><p className="font-black">{formatDate(card.data_envio)}</p></div>
                      <div><span className={labelClass}>Destino</span><p className="font-black">{card.anv_destino || card.local_destino || card.empresa_destino || 'A confirmar'}</p></div>
                      <div><span className={labelClass}>Retorno</span><p className="font-black">{formatDate(card.data_retorno)}</p></div>
                    </div>
                    <div className="mt-3 rounded-xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 px-3 py-2 text-xs"><span className="font-black text-slate-400 uppercase">Local atual do equipamento</span><p className="font-black mt-0.5">{card.equipamento_anv_atual || card.equipamento_local_atual || card.equipamento_categoria_atual || 'Não determinado'}</p></div>
                    {card.observacao || card.descricao ? <p className="mt-2 text-xs text-slate-500 dark:text-slate-400">{card.observacao || card.descricao}</p> : null}
                    {canEdit && card.status !== 'CANCELADA' ? <div className="mt-3 flex justify-end"><button onClick={() => cancelStc(card)} className="px-3 py-2 rounded-xl bg-red-50 dark:bg-red-900/20 text-red-700 dark:text-red-300 font-black text-xs">Cancelar STC</button></div> : null}
                  </div>
                ))}
              </div>
            </div>
          ) : (
            <div className="space-y-5">
              <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                <label><span className={labelClass}>Número STC *</span><input disabled={Boolean(stcForm.card_key)} className={`${inputClass} disabled:opacity-60`} value={stcForm.numero_stc} onChange={(e) => setStcForm((v) => ({ ...v, numero_stc: e.target.value }))} /></label>
                <label><span className={labelClass}>PN *</span><input disabled={Boolean(stcForm.card_key)} className={`${inputClass} disabled:opacity-60`} value={stcForm.pn} onChange={(e) => setStcForm((v) => ({ ...v, pn: e.target.value }))} /></label>
                <label><span className={labelClass}>SN *</span><input disabled={Boolean(stcForm.card_key)} className={`${inputClass} disabled:opacity-60`} value={stcForm.sn} onChange={(e) => setStcForm((v) => ({ ...v, sn: e.target.value }))} /></label>
                <label><span className={labelClass}>Status</span><select className={inputClass} value={stcForm.status} onChange={(e) => setStcForm((v) => ({ ...v, status: e.target.value }))}><option value="REGISTRADA">Registrada</option><option value="ENVIADA">Enviada</option><option value="RETORNADA">Retornada</option></select></label>
                <label><span className={labelClass}>Motivo / tipo</span><select className={inputClass} value={stcForm.motivo_stc} onChange={(e) => setStcForm((v) => ({ ...v, motivo_stc: e.target.value }))}><option value="MOVIMENTACAO">Movimentação</option><option value="REPARO">Reparo</option><option value="GARANTIA">Garantia</option><option value="TRANSFERENCIA">Transferência</option><option value="CESSAO">Cessão</option><option value="EMPRESTIMO">Empréstimo</option><option value="OUTRO">Outro</option></select></label>
                <label><span className={labelClass}>Documento referência</span><input className={inputClass} value={stcForm.documento_referencia} onChange={(e) => setStcForm((v) => ({ ...v, documento_referencia: e.target.value }))} /></label>
              </div>

              <div className="rounded-2xl border border-slate-200 dark:border-slate-700 p-4">
                <h4 className="font-black uppercase text-sm mb-3">Envio / saída</h4>
                <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                  <label><span className={labelClass}>Data envio</span><input type="datetime-local" className={inputClass} value={stcForm.data_envio} onChange={(e) => setStcForm((v) => ({ ...v, data_envio: e.target.value }))} /></label>
                  <label><span className={labelClass}>Categoria origem</span><select className={inputClass} value={stcForm.categoria_origem} onChange={(e) => setStcForm((v) => ({ ...v, categoria_origem: e.target.value }))}><option value="">Usar estado atual</option>{categoryOptions.map(([value,label]) => <option key={value} value={value}>{label}</option>)}</select></label>
                  <label><span className={labelClass}>Local / ANV origem</span><input className={inputClass} value={stcForm.local_origem} onChange={(e) => setStcForm((v) => ({ ...v, local_origem: e.target.value }))} placeholder="PPU, RECEX, N-4005..." /></label>
                  <label><span className={labelClass}>Categoria destino</span><select className={inputClass} value={stcForm.categoria_destino} onChange={(e) => setStcForm((v) => ({ ...v, categoria_destino: e.target.value }))}>{categoryOptions.map(([value,label]) => <option key={value} value={value}>{label}</option>)}</select></label>
                  <label><span className={labelClass}>Local destino</span><input className={inputClass} value={stcForm.local_destino} onChange={(e) => setStcForm((v) => ({ ...v, local_destino: e.target.value }))} /></label>
                  <label><span className={labelClass}>Aeronave destino</span><input className={inputClass} value={stcForm.anv_destino} onChange={(e) => setStcForm((v) => ({ ...v, anv_destino: e.target.value }))} /></label>
                  <label className="md:col-span-3"><span className={labelClass}>Empresa / destinatário</span><input className={inputClass} value={stcForm.empresa_destino} onChange={(e) => setStcForm((v) => ({ ...v, empresa_destino: e.target.value }))} /></label>
                </div>
              </div>

              <div className="rounded-2xl border border-slate-200 dark:border-slate-700 p-4">
                <h4 className="font-black uppercase text-sm mb-3">Retorno</h4>
                <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                  <label><span className={labelClass}>Data retorno</span><input type="datetime-local" className={inputClass} value={stcForm.data_retorno} onChange={(e) => setStcForm((v) => ({ ...v, data_retorno: e.target.value }))} /></label>
                  <label><span className={labelClass}>Categoria retorno</span><select className={inputClass} value={stcForm.categoria_retorno} onChange={(e) => setStcForm((v) => ({ ...v, categoria_retorno: e.target.value }))}>{categoryOptions.map(([value,label]) => <option key={value} value={value}>{label}</option>)}</select></label>
                  <label><span className={labelClass}>Local retorno</span><input className={inputClass} value={stcForm.local_retorno} onChange={(e) => setStcForm((v) => ({ ...v, local_retorno: e.target.value }))} placeholder="Pode ficar vazio para confirmar depois" /></label>
                  <label><span className={labelClass}>Aeronave retorno</span><input className={inputClass} value={stcForm.anv_retorno} onChange={(e) => setStcForm((v) => ({ ...v, anv_retorno: e.target.value }))} /></label>
                  <label><span className={labelClass}>Condição no retorno</span><select className={inputClass} value={stcForm.condicao_retorno} onChange={(e) => setStcForm((v) => ({ ...v, condicao_retorno: e.target.value }))}>{conditionOptions.map(([value,label]) => <option key={value} value={value}>{label}</option>)}</select></label>
                </div>
              </div>
              <label><span className={labelClass}>Descrição</span><textarea className={`${inputClass} min-h-20`} value={stcForm.descricao} onChange={(e) => setStcForm((v) => ({ ...v, descricao: e.target.value }))} /></label>
              <label><span className={labelClass}>Observações</span><textarea className={`${inputClass} min-h-20`} value={stcForm.observacao} onChange={(e) => setStcForm((v) => ({ ...v, observacao: e.target.value }))} /></label>
              <div className="rounded-xl bg-amber-50 dark:bg-amber-900/10 border border-amber-200 dark:border-amber-900/40 p-3 text-xs font-bold text-amber-800 dark:text-amber-300">Se a STC indicar uma localização incompatível com o estado atual do mesmo PN+SN, o SISHA cria conflito para confirmação do Admin/Dono em vez de colocar o equipamento em dois locais.</div>
            </div>
          )}
        </ModalShell>
      ) : null}

      {dossierOpen && selected ? (
        <ModalShell
          title={`Dossiê do equipamento — ${selected.pn} / SN ${selected.sn}`}
          subtitle="Histórico preservado. Eventos incorretos são invalidados, nunca apagados."
          onClose={() => setDossierOpen(false)}
          wide
          footer={<div className="flex flex-wrap justify-end gap-2">{canEdit ? <button onClick={() => openMovement(selected)} className="px-4 py-2.5 rounded-xl bg-blue-600 text-white font-black inline-flex items-center gap-2"><ArrowRightLeft size={16} /> Registrar movimentação</button> : null}{canEdit ? <button onClick={() => openEdit(selected)} className="px-4 py-2.5 rounded-xl bg-slate-900 text-white font-black inline-flex items-center gap-2"><Edit3 size={16} /> Editar cadastro</button> : null}</div>}
        >
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
            <div className="lg:col-span-2 rounded-2xl border border-slate-200 dark:border-slate-700 p-4">
              <div className="flex flex-wrap gap-2 items-center"><span className="font-black text-xl">{selected.pn}</span><span className="px-3 py-1 rounded-lg bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300 font-black">SN {selected.sn}</span></div>
              <p className="mt-1 font-bold text-slate-500">{selected.nomenclatura || selected.nomenclatura_resolvida || 'Nomenclatura não informada'}</p>
              <div className="mt-4 grid grid-cols-1 sm:grid-cols-2 gap-3 text-sm">
                <div><span className={labelClass}>Local atual</span><p className="font-black">{categoryLabel(selected.categoria_local_atual)}{selected.local_atual ? ` • ${selected.local_atual}` : ''}</p></div>
                <div><span className={labelClass}>Aeronave</span><p className="font-black">{selected.anv_atual || '—'}</p></div>
                <div><span className={labelClass}>Condição</span><p className="font-black">{conditionLabel(selected.condicao_atual)}</p></div>
                <div><span className={labelClass}>Status</span><p className="font-black">{statusLabel(selected.status_atual)}</p></div>
                <div><span className={labelClass}>Confiança da localização</span><span className={`inline-flex px-2.5 py-1 rounded-lg text-xs font-black ${confidenceTone(selected.confianca_localizacao)}`}>{confidenceLabel(selected.confianca_localizacao)}</span></div>
                <div><span className={labelClass}>Última evidência</span><p className="font-black">{selected.ultima_evidencia_tipo ? eventTypeLabel(selected.ultima_evidencia_tipo) : '—'}{selected.ultima_evidencia_documento ? ` • ${humanizeDocumentReference(selected.ultima_evidencia_documento, selected.ultima_evidencia_tipo)}` : ''}</p></div>
              </div>
            </div>
            <div className="rounded-2xl border border-slate-200 dark:border-slate-700 p-4">
              <div className="flex items-center gap-2 font-black"><ShieldCheck size={18} /> Garantia</div>
              <div className="mt-3 space-y-2 text-sm">
                <p><span className="text-slate-400 font-bold">Início:</span> <strong>{formatDate(selected.garantia_inicio)}</strong></p>
                <p><span className="text-slate-400 font-bold">Vencimento:</span> <strong>{formatDate(selected.garantia_vencimento)}</strong></p>
                <p><span className="text-slate-400 font-bold">Documento:</span> <strong>{selected.garantia_documento || '—'}</strong></p>
                <p className="text-xs text-slate-500 dark:text-slate-400">{selected.garantia_observacao || 'Sem observações.'}</p>
              </div>
            </div>
          </div>

          {selected.prioridade_operacional ? (
            <div className="mt-5 rounded-2xl border border-cyan-200 dark:border-cyan-900 bg-cyan-50/40 dark:bg-cyan-950/20 p-4">
              <div className="flex flex-col lg:flex-row lg:items-start lg:justify-between gap-3">
                <div><div className="font-black uppercase tracking-tight">Dossiê operacional consolidado</div><p className="mt-1 text-xs font-bold text-cyan-800 dark:text-cyan-300">Motivo, criticidade e prioridade são derivados somente das evidências já registradas; conflito deixa a decisão indeterminada.</p></div>
                <div className="flex flex-wrap gap-2"><span className={`px-3 py-1.5 rounded-xl text-xs font-black ${priorityTone(selected.prioridade_operacional.nivel)}`}>PRIORIDADE {selected.prioridade_operacional.nivel}</span>{selected.prioridade_operacional.candidato_emergencia_reparo ? <span className="px-3 py-1.5 rounded-xl text-xs font-black bg-red-600 text-white">CANDIDATO A REPARO EMERGENCIAL</span> : null}</div>
              </div>
              <div className="mt-4 grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-3 text-sm">
                <div><span className={labelClass}>Motivo atual</span><p className="font-black">{selected.motivo_atual}</p><p className="mt-1 text-[10px] font-bold text-slate-400">{selected.motivo_documento ? humanizeDocumentReference(selected.motivo_documento, selected.motivo_evento_tipo) : selected.motivo_evento_tipo ? eventTypeLabel(selected.motivo_evento_tipo) : 'Sem documento causal identificado'}</p></div>
                <div><span className={labelClass}>Permanência</span><p className="font-black">{selected.dias_local_atual === null || selected.dias_local_atual === undefined ? 'Não determinada' : `${selected.dias_local_atual} dia(s)`}</p><p className="mt-1 text-[10px] font-bold text-slate-400">Desde {formatDate(selected.local_atual_desde, true)}</p></div>
                <div><span className={labelClass}>PPU / criticidade</span><p className="font-black">PPU efetivo PN: {selected.ppu_disponibilidade_conhecida === false ? 'indeterminado' : (selected.ppu_quantidade_efetiva_pn ?? 0)}</p><p className="mt-1 text-[10px] font-bold text-slate-400">{selected.controle_critico ? 'Há evidência no Controle de Equipamentos Críticos' : 'Criticidade explícita não confirmada'}</p></div>
                <div><span className={labelClass}>Situação do reparo</span><p className="font-black">{repairStateLabel(selected.prioridade_operacional.situacao_reparo)}</p><p className="mt-1 text-[10px] font-bold text-slate-400">WO: {selected.wo_documento || selected.wo_estado || 'sem evidência atual'}</p></div>
              </div>
              {(selected.prioridade_operacional.razoes || []).length ? <div className="mt-3 rounded-xl bg-white dark:bg-slate-900 border border-cyan-100 dark:border-cyan-900 p-3 text-xs font-bold text-slate-600 dark:text-slate-300">{selected.prioridade_operacional.razoes.join(' • ')}</div> : null}
              {(selected.fontes_dossie || []).length ? <div className="mt-3 flex flex-wrap gap-1.5">{selected.fontes_dossie.map((source) => <span key={source} className="px-2 py-1 rounded-lg bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 text-[10px] font-black">{sourceLabel(source)}</span>)}</div> : null}
            </div>
          ) : null}

          {selected.dossie_resumo?.ultimo_movimento ? (
            <section className="rounded-2xl border border-amber-200 dark:border-amber-900/50 bg-amber-50/60 dark:bg-amber-950/10 p-4">
              <h4 className="font-black uppercase text-amber-900 dark:text-amber-200">Leitura operacional da última movimentação</h4>
              <p className="mt-2 text-sm font-black text-slate-900 dark:text-white">{selected.dossie_resumo.ultimo_movimento.leitura}</p>
              <div className="mt-3 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-2 text-xs font-bold text-slate-600 dark:text-slate-300">
                <span>Tipo: {selected.dossie_resumo.ultimo_movimento.tipo}</span>
                <span>Aeronave: {selected.dossie_resumo.ultimo_movimento.aeronave || 'Não identificada'}</span>
                <span>Documento: {selected.dossie_resumo.ultimo_movimento.documento ? humanizeDocumentReference(selected.dossie_resumo.ultimo_movimento.documento, selected.dossie_resumo.ultimo_movimento.documento_tipo) : 'Não informado'}</span>
                <span>Data: {formatDate(selected.dossie_resumo.ultimo_movimento.data, true)}</span>
                <span className="sm:col-span-2">Origem: {selected.dossie_resumo.ultimo_movimento.origem || 'Não determinada'}</span>
                <span className="sm:col-span-2">Destino: {selected.dossie_resumo.ultimo_movimento.destino_conhecido ? selected.dossie_resumo.ultimo_movimento.destino : 'A confirmar'}</span>
              </div>
              {!selected.dossie_resumo.ultimo_movimento.destino_conhecido ? <p className="mt-3 text-xs font-bold text-amber-800 dark:text-amber-200">O SISHA confirma a movimentação, mas não inventa o destino quando a OS/PIM/Master OS não o informa.</p> : null}
            </section>
          ) : null}

          {selected.dossie_resumo ? (
            <div className="mt-5 rounded-2xl border border-sky-200 dark:border-sky-900 bg-sky-50/50 dark:bg-sky-950/20 p-4">
              <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-3">
                <div><div className="flex items-center gap-2 font-black"><History size={18} /> Resumo consolidado do ciclo</div><p className="mt-1 text-xs font-bold text-sky-700 dark:text-sky-300">O estado atual vem da evidência válida mais recente; eventos antigos e invalidados permanecem no Livro.</p></div>
                <div className="flex flex-wrap gap-2 text-[10px] font-black uppercase">
                  <span className="px-2.5 py-1 rounded-lg bg-white dark:bg-slate-900 border border-sky-200 dark:border-sky-900">{selected.dossie_resumo.eventos_total || 0} evento(s)</span>
                  <span className="px-2.5 py-1 rounded-lg bg-emerald-50 dark:bg-emerald-950/20 border border-emerald-200 dark:border-emerald-900 text-emerald-700 dark:text-emerald-300">{selected.dossie_resumo.eventos_validos || 0} válido(s)</span>
                  {selected.dossie_resumo.eventos_invalidos > 0 ? <span className="px-2.5 py-1 rounded-lg bg-red-50 dark:bg-red-950/20 border border-red-200 dark:border-red-900 text-red-700 dark:text-red-300">{selected.dossie_resumo.eventos_invalidos} histórico(s)/invalidado(s)</span> : null}
                  {selected.dossie_resumo.conflitos_pendentes > 0 ? <span className="px-2.5 py-1 rounded-lg bg-amber-50 dark:bg-amber-950/20 border border-amber-200 dark:border-amber-900 text-amber-700 dark:text-amber-300">{selected.dossie_resumo.conflitos_pendentes} conflito(s)</span> : null}
                </div>
              </div>
              {selected.dossie_resumo.fontes_historicas?.length > 0 ? <div className="mt-3 flex flex-wrap gap-1.5">{selected.dossie_resumo.fontes_historicas.map((source) => <span key={source} className="px-2 py-1 rounded-lg bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 text-[10px] font-black text-slate-600 dark:text-slate-300">{sourceLabel(source)}</span>)}</div> : null}
            </div>
          ) : null}

          <div className="mt-5">
            <div className="flex items-center gap-2 mb-3"><History size={18} /><h4 className="font-black uppercase tracking-tight">Histórico do equipamento</h4></div>
            <div className="space-y-3">
              {(selected.eventos || []).length === 0 ? <div className="rounded-xl bg-slate-50 dark:bg-slate-800 p-4 text-sm font-bold text-slate-400">Nenhum evento registrado.</div> : null}
              {(selected.eventos || []).map((event) => (
                <div key={event.id} className={`rounded-2xl border p-4 ${event.invalidado ? 'border-red-200 dark:border-red-900 bg-red-50/50 dark:bg-red-900/10 opacity-70' : 'border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950/30'}`}>
                  <div className="flex flex-col lg:flex-row lg:items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2"><span className="font-black">{eventTypeLabel(event.tipo_evento)}</span><span className="text-xs font-bold text-slate-400">{formatEquipmentEventEffectiveDate(event)}</span>{event.invalidado ? <span className="px-2 py-1 rounded-lg bg-red-100 text-red-700 text-[10px] font-black">INVALIDADO</span> : null}{event.automatico ? <span className="px-2 py-1 rounded-lg bg-blue-100 text-blue-700 text-[10px] font-black">AUTOMÁTICO</span> : null}</div>
                      <p className="mt-1 text-sm font-bold"><MapPin size={14} className="inline mr-1" />{event.local_origem || event.categoria_origem || 'Origem não informada'} → {event.local_destino || event.categoria_destino || 'Destino não informado'}</p>
                      <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">{event.motivo || 'Sem motivo informado'}</p>
                      {event.documento || event.pim || event.os ? <p className="mt-2 text-xs font-bold text-blue-600 dark:text-blue-400"><FileText size={13} className="inline mr-1" />{[documentEvidenceLabel(event.documento_tipo, event.documento), event.pim ? `PIM ${event.pim}` : '', event.os ? `OS ${event.os}` : ''].filter(Boolean).join(' • ')}</p> : null}
                      {event.tipo_evento === 'INVENTARIO_EQUIPAMENTOS' && event.created_at ? (
                        <p className="mt-1 text-[11px] font-bold text-slate-400">
                          Registrado no SISHA: {formatDate(event.created_at, true)}
                        </p>
                      ) : null}
                      {event.payload?.custo_reparo?.referencia_orcamentaria ? <div className="mt-2 rounded-xl bg-amber-50 dark:bg-amber-900/10 border border-amber-200 dark:border-amber-900/40 px-3 py-2 text-xs"><p className="font-black text-amber-800 dark:text-amber-300">Referência histórica de reparo • {event.payload.custo_reparo.tipo_wo || 'WO'} • {formatMoneyReference(event.payload.custo_reparo.valor_historico_referencia, event.payload.custo_reparo.moeda || 'USD')}</p><p className="mt-1 font-bold text-amber-700/80 dark:text-amber-300/80">{event.payload.custo_reparo.nota || 'Valor histórico; não representa orçamento vigente automaticamente.'}</p></div> : null}
                      {event.payload?.pn_saida && event.payload.pn_saida !== event.payload.pn_entrada ? <p className="mt-2 text-xs font-black text-violet-700 dark:text-violet-300">PN de entrada {event.payload.pn_entrada} → PN de saída {event.payload.pn_saida}. Relação preservada como evidência da WO; o Cadastro Mestre não é alterado automaticamente.</p> : null}
                      {event.payload?.stc ? <div className="mt-2 rounded-xl bg-indigo-50 dark:bg-indigo-900/10 border border-indigo-200 dark:border-indigo-900/40 px-3 py-2 text-xs"><p className="font-black text-indigo-800 dark:text-indigo-300">STC {event.payload.stc.numero_stc} • {event.payload.stc.motivo_stc || 'MOVIMENTAÇÃO'}</p><p className="mt-1 font-bold text-indigo-700/80 dark:text-indigo-300/80">{event.payload.stc.local_destino || event.payload.stc.anv_destino || event.payload.stc.empresa_destino ? `Destino: ${event.payload.stc.anv_destino || event.payload.stc.local_destino || event.payload.stc.empresa_destino}` : 'Destino não informado'}{event.payload.stc.data_retorno ? ` • Retorno: ${formatDate(event.payload.stc.data_retorno)}` : ''}</p></div> : null}
                      {event.payload?.os_pim ? <div className="mt-2 rounded-xl bg-sky-50 dark:bg-sky-900/10 border border-sky-200 dark:border-sky-900/40 px-3 py-2 text-xs"><p className="font-black text-sky-800 dark:text-sky-300">OS/PIM • {event.payload.os_pim.tipo_movimento || 'MOVIMENTAÇÃO'} • {event.payload.os_pim.os ? `OS ${event.payload.os_pim.os}` : event.payload.os_pim.osr ? `OSR ${event.payload.os_pim.osr}` : event.payload.os_pim.pim ? `PIM ${event.payload.os_pim.pim}` : 'Documento não informado'}</p><p className="mt-1 font-bold text-sky-700/80 dark:text-sky-300/80">{event.payload.os_pim.anv_destino || event.payload.os_pim.local_destino ? `Destino: ${event.payload.os_pim.anv_destino || event.payload.os_pim.local_destino}` : event.payload.os_pim.tipo_movimento === 'REMOCAO' ? 'Destino após remoção a confirmar' : 'Destino não informado'}{event.payload.os_pim.condicao_resultante ? ` • ${conditionLabel(event.payload.os_pim.condicao_resultante)}` : ''}</p></div> : null}
                      {event.payload?.order_book ? <div className="mt-2 rounded-xl bg-emerald-50 dark:bg-emerald-900/10 border border-emerald-200 dark:border-emerald-900/40 px-3 py-2 text-xs"><p className="font-black text-emerald-800 dark:text-emerald-300">Order Book • {event.payload.order_book.source_sheet || 'Leonardo'}{event.payload.order_book.documento_referencia ? ` • ${event.payload.order_book.documento_referencia}` : ''}</p><p className="mt-1 font-bold text-emerald-700/80 dark:text-emerald-300/80">{[event.payload.order_book.notification ? `Notification ${event.payload.order_book.notification}` : '', event.payload.order_book.delivery_number ? `Delivery ${event.payload.order_book.delivery_number}` : '', event.payload.order_book.aeronave ? `ANV ${event.payload.order_book.aeronave}` : '', event.payload.order_book.status || event.payload.order_book.lh_updates || ''].filter(Boolean).join(' • ')}</p>{event.payload.order_book.bn_comments ? <p className="mt-1 text-emerald-700/70 dark:text-emerald-300/70">BN Comments: {event.payload.order_book.bn_comments}</p> : null}{event.payload.order_book.pn_saida && event.payload.order_book.pn_saida !== event.payload.order_book.pn_entrada ? <p className="mt-1 font-black text-violet-700 dark:text-violet-300">PN de entrada {event.payload.order_book.pn_entrada} → PN de saída {event.payload.order_book.pn_saida}. Evidência preservada; Cadastro Mestre não alterado automaticamente.</p> : null}</div> : null}
                      {event.invalidado ? <p className="mt-2 text-xs font-bold text-red-600 dark:text-red-400">Motivo da invalidação: {event.motivo_invalidacao || 'Não informado'}</p> : null}
                    </div>
                    {canEdit && !event.invalidado ? <button onClick={() => { setInvalidateEvent(event); setInvalidateReason(''); }} className="px-3 py-2 rounded-xl bg-red-50 dark:bg-red-900/20 text-red-700 dark:text-red-300 font-black text-xs inline-flex items-center gap-2"><AlertTriangle size={14} /> Invalidar evento</button> : null}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </ModalShell>
      ) : null}

      {equipmentOperationsOpen ? (
        <EquipmentOperationsModal
          token={token}
          onClose={() => setEquipmentOperationsOpen(false)}
          onChanged={() => refreshEquipmentList()}
        />
      ) : null}

      {reliabilityOpen ? (
        <ReliabilityAnalysisModal
          token={token}
          onClose={() => setReliabilityOpen(false)}
        />
      ) : null}

      {invalidateEvent ? (
        <ModalShell
          title="Invalidar evento"
          subtitle="O evento permanecerá no histórico e a localização atual será recalculada usando a evidência válida mais recente."
          onClose={() => setInvalidateEvent(null)}
          footer={<div className="flex justify-end gap-2"><button onClick={() => setInvalidateEvent(null)} className="px-4 py-2.5 rounded-xl bg-slate-200 dark:bg-slate-700 font-black">Cancelar</button><button onClick={doInvalidate} disabled={saving || !invalidateReason.trim()} className="px-5 py-2.5 rounded-xl bg-red-600 text-white font-black disabled:opacity-50">Confirmar invalidação</button></div>}
        >
          <label className={labelClass}>Motivo obrigatório</label>
          <textarea className={`${inputClass} min-h-28`} value={invalidateReason} onChange={(e) => setInvalidateReason(e.target.value)} placeholder="Explique por que este evento não deve definir a rastreabilidade do equipamento." />
        </ModalShell>
      ) : null}
    </div>
  );
}
