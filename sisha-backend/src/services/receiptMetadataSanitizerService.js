const {
  compact,
  analyzeReceiptDescription,
  cleanTechnicalNomenclature,
  extractSerialsFromDescription,
  normalizeSerialField,
} = require('./receiptDescriptionSemanticNormalizerService');

function cleanNomenclature(value = '') {
  return cleanTechnicalNomenclature(value);
}

function extractSerialsFromText(value = '') {
  return extractSerialsFromDescription(value);
}

function sanitizeSerialField(value = '') {
  return normalizeSerialField(value);
}

function sanitizeReceiptItemMetadata(item = {}, index = 0) {
  const beforeNomenclature = compact(item.nomenclatura);
  const beforeSerial = compact(item.sn);
  const semantic = analyzeReceiptDescription(beforeNomenclature);
  const cleanName = semantic.nomenclatura;
  const cleanSerial = sanitizeSerialField(beforeSerial || semantic.serials.join(', '));

  const original = item.dados_originais && typeof item.dados_originais === 'object'
    ? { ...item.dados_originais }
    : {};

  if (beforeNomenclature && cleanName !== beforeNomenclature) {
    original.NOMENCLATURA_ANTES_FIREWALL_FINAL = beforeNomenclature;
  }
  if (beforeSerial && cleanSerial !== beforeSerial) {
    original.SN_ANTES_FIREWALL_FINAL = beforeSerial;
  }
  if (semantic.contract) original.CONTRATO_EXTRAIDO_FIREWALL_FINAL = semantic.contract;
  if (semantic.order) original.ORDEM_COMPRA_EXTRAIDA_FIREWALL_FINAL = semantic.order;
  if (semantic.item) original.ITEM_ORDEM_COMPRA_EXTRAIDO_FIREWALL_FINAL = semantic.item;
  if (semantic.program) original.PROGRAMA_LOGISTICO_EXTRAIDO_FIREWALL_FINAL = semantic.program;
  if (semantic.reference) original.REFERENCIA_EXTRAIDA_FIREWALL_V2 = semantic.reference;
  if (semantic.aircraftContext) original.CONTEXTO_AERONAVE_EXTRAIDO_FIREWALL_V2 = semantic.aircraftContext;
  if (semantic.auxCode) original.CODIGO_AUXILIAR_EXTRAIDO_FIREWALL_V2 = semantic.auxCode;
  if (semantic.isFoc) original.FOC_EXTRAIDO_FIREWALL_V2 = true;
  if (semantic.warranty) original.GARANTIA_EXTRAIDA_FIREWALL_V2 = true;

  return {
    ...item,
    sequencia_item: item.sequencia_item || index + 1,
    nomenclatura: cleanName,
    sn: cleanSerial,
    sn_extraido_documento: Boolean(cleanSerial || item.sn_extraido_documento),
    documento_referencia: item.documento_referencia || semantic.reference || semantic.contract || '',
    dados_originais: original,
  };
}

function sanitizeReceiptFormMetadata(form = {}) {
  if (!form || typeof form !== 'object') return form;
  if (!Array.isArray(form.itens)) return form;
  return {
    ...form,
    itens: form.itens.map((item, index) => sanitizeReceiptItemMetadata(item, index)),
  };
}

module.exports = {
  compact,
  cleanNomenclature,
  extractSerialsFromText,
  sanitizeSerialField,
  sanitizeReceiptItemMetadata,
  sanitizeReceiptFormMetadata,
};
