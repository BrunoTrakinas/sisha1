const FIELD_ALIASES = {
  pn: ['pn', 'part number', 'part nuber', 'part no', 'part no.', 'partnumber', 'ref', 'referencia', 'referência'],
  nsn: ['nsn', 'nato ref', 'nato reference', 'nato stock number'],
  pi: ['pi'],
  nomenclatura: ['nomenclatura', 'description', 'descrição', 'descricao', 'nome portugues', 'nome_portugues', 'incoming part desc'],
  qtd: ['qtd', 'qty', 'qtde', 'quantidade', 'quantity', 'reqd qty', 'required qty', 'required'],
  localizacao: ['localizacao', 'localização', 'location'],
  sj: ['sj', 'simbolo jurisdicao', 'simbolo_jurisdicao'],
  uf: ['uf', 'ufcodido', 'ufcodigo'],
  dmc: ['dmc'],
  item: ['item', 'item num', 'item_num'],
  sub_item: ['sub item', 'sub_item', 'subitem'],
  techname: ['techname', 'application', 'aplicacao', 'aplicação'],
  lead_time: ['lead time', 'lead time days', 'lead time weeks'],
  moq: ['moq'],
  price: ['price', 'unit value', 'valor unitario', 'valor_unitario'],
  start_date: ['start date', 'data inicio', 'data início'],
  end_date: ['end date', 'data fim'],
  pd: ['pd'],
  oc: ['cust po ref', 'oc', 'customer po ref'],
  categoria: ['category', 'categoria'],
  on_delivery: ['on delivery'],
  in_shipment: ['in shipment'],
  delivered: ['delivered'],
  not_delivered: ['not delivered'],
  serial_number: ['s/n', 'serial number', 'sn'],
  delivery: ['delivery', 'f/c date @ lh', 'data entrega'],
  lh_comments: ['lh comments'],
  part_required: ['part required'],
  outgoing_part: ['outgoing part'],
  incoming_part: ['incoming part'],
  tipo_doc: ['type', 'tipo doc', 'tipo documento'],
  numero_doc: ['number', 'numero', 'número'],
  assunto: ['subject', 'assunto'],
  status: ['status'],
  data: ['date', 'data'],
  pn_alt: ['pn_alt', 'pn alt', 'pn alternativo', 'alternate pn', 'alternate part number'],
  fonte: ['fonte', 'source', 'documento', 'reference document'],
};

function normalizeHeader(value) {
  return String(value ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[._/\\()-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function normalizePn(value) {
  return String(value ?? '')
    .toUpperCase()
    .replace(/\s+/g, '')
    .trim();
}

function normalizeHeaders(headers = []) {
  return headers.map(normalizeHeader);
}

function aliasesFor(fieldOrAliases) {
  if (Array.isArray(fieldOrAliases)) return fieldOrAliases.map(normalizeHeader);
  const aliases = FIELD_ALIASES[fieldOrAliases] || [fieldOrAliases];
  return aliases.map(normalizeHeader);
}

function findColumnIndex(headers = [], fieldOrAliases) {
  const normalizedHeaders = normalizeHeaders(headers);
  const aliases = aliasesFor(fieldOrAliases);
  for (const alias of aliases) {
    const exactIndex = normalizedHeaders.indexOf(alias);
    if (exactIndex !== -1) return exactIndex;
  }
  for (const alias of aliases) {
    const containsIndex = normalizedHeaders.findIndex((header) => header.includes(alias));
    if (containsIndex !== -1) return containsIndex;
  }
  return -1;
}

function buildIndexMap(headers = [], schema = {}) {
  return Object.fromEntries(
    Object.entries(schema).map(([key, fieldOrAliases]) => [key, findColumnIndex(headers, fieldOrAliases)])
  );
}

function rowContainsAliases(row = [], requiredFields = []) {
  const normalizedRow = normalizeHeaders(row);
  return requiredFields.every((fieldOrAliases) => {
    const aliases = aliasesFor(fieldOrAliases);
    return aliases.some((alias) => normalizedRow.some((cell) => cell === alias || cell.includes(alias)));
  });
}

function findHeaderRow(rawRows = [], requiredFields = []) {
  return rawRows.findIndex((row) => rowContainsAliases(row, requiredFields));
}

function pickValue(row = [], headers = [], fieldOrAliases, fallback = null) {
  const index = findColumnIndex(headers, fieldOrAliases);
  if (index === -1) return fallback;
  return row[index] ?? fallback;
}

module.exports = {
  FIELD_ALIASES,
  normalizeHeader,
  normalizeHeaders,
  normalizePn,
  aliasesFor,
  findColumnIndex,
  buildIndexMap,
  rowContainsAliases,
  findHeaderRow,
  pickValue,
};
