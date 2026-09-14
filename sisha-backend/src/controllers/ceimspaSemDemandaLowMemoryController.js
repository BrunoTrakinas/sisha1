const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const supabase = require('../config/supabaseClient');
const { setAuditSummary } = require('../utils/importAudit');
const { registrarAuditoria } = require('../utils/auditLogger');
const { parseCeimspaSemDemandaLegacyXls } = require('../services/ceimspaSemDemandaLegacyXlsService');

const memoryMb = () => {
  const m = process.memoryUsage();
  const mb = (value) => Math.round((Number(value || 0) / 1024 / 1024) * 10) / 10;
  return { rss: mb(m.rss), heapUsed: mb(m.heapUsed), heapTotal: mb(m.heapTotal), external: mb(m.external) };
};

async function ensureTempFile(req) {
  if (req.file?.path) return req.file.path;
  if (!req.file?.buffer) return null;

  const dir = path.join(os.tmpdir(), 'sisha-ceimspa-sem-demanda');
  await fs.promises.mkdir(dir, { recursive: true });
  const ext = ['.xls', '.xlsx'].includes(path.extname(req.file.originalname || '').toLowerCase())
    ? path.extname(req.file.originalname || '').toLowerCase()
    : '.upload';
  const tempPath = path.join(dir, `${Date.now()}-${crypto.randomBytes(12).toString('hex')}${ext}`);
  await fs.promises.writeFile(tempPath, req.file.buffer);
  req.file.buffer = null;
  return tempPath;
}

async function importCeimspaSemDemandaLowMemory(req, res) {
  let tempPath = null;
  let workbook = null;

  try {
    tempPath = await ensureTempFile(req);
    if (!tempPath) {
      setAuditSummary(req, { status: 'ERRO', mensagem: 'Arquivo Sem Demanda temporário não recebido.' });
      return res.status(400).json({ status: 'error', message: 'Nenhum arquivo Sem Demanda foi recebido.' });
    }

    console.info('[SISHA][ceimspa-sem-demanda] LOW_MEMORY_START', {
      arquivo: req.file?.originalname || null,
      bytes: Number(req.file?.size || 0),
      memoria_mb: memoryMb(),
    });

    const extension = path.extname(req.file?.originalname || tempPath).toLowerCase();
    let parsed;
    let memoryMode;

    if (extension === '.xls') {
      parsed = parseCeimspaSemDemandaLegacyXls(tempPath, {
        fileName: req.file?.originalname || null,
      });
      memoryMode = 'LEGACY_XLS_BIFF_INCREMENTAL';
    } else {
      // XLSX permanece no leitor homologado. O problema reproduzido em produção é
      // específico do XLS/BIFF legado, que não passa mais pelo SheetJS.
      const xlsx = require('xlsx');
      const { parseCeimspaSemDemandaWorksheet } = require('../services/ceimspaSemDemandaService');
      workbook = xlsx.readFile(tempPath, {
        dense: true,
        cellStyles: false,
        cellNF: false,
        cellHTML: false,
      });
      const sheetName = workbook.SheetNames?.[0];
      const sheet = sheetName ? workbook.Sheets?.[sheetName] : null;
      parsed = parseCeimspaSemDemandaWorksheet(sheet, xlsx, {
        fileName: req.file?.originalname || null,
      });
      memoryMode = 'XLSX_DENSE_WORKBOOK_ROW_ITERATION';
    }

    const ceimspaData = parsed.rows || [];
    console.info('[SISHA][ceimspa-sem-demanda] LOW_MEMORY_PARSED', {
      modo: memoryMode,
      linhas: parsed.sourceRows || 0,
      pis: ceimspaData.length,
      memoria_mb: memoryMb(),
    });

    if (!ceimspaData.length) {
      setAuditSummary(req, {
        status: 'ERRO',
        mensagem: 'Nenhum PI válido foi encontrado no arquivo CeIMSPA Sem Demanda.',
        tabelaAlvo: 'estoque_ceimspa',
        linhasLidas: parsed.sourceRows || 0,
      });
      return res.status(400).json({ status: 'error', message: 'Nenhum PI válido foi encontrado no arquivo CeIMSPA Sem Demanda.' });
    }

    workbook = null;

    const { error: deleteError } = await supabase
      .from('estoque_ceimspa')
      .delete()
      .eq('fonte_identificacao', 'CEIMSPA_SEM_DEMANDA');
    if (deleteError) throw deleteError;

    const chunkSize = 250;
    for (let i = 0; i < ceimspaData.length; i += chunkSize) {
      const { error: insertError } = await supabase
        .from('estoque_ceimspa')
        .insert(ceimspaData.slice(i, i + chunkSize));
      if (insertError) throw insertError;
    }

    await registrarAuditoria({
      req,
      action: 'CEIMSPA_SEM_DEMANDA_SUBSTITUIDO',
      entity: 'ESTOQUE_CEIMSPA',
      entityId: req.file?.originalname || 'ceimspa_sem_demanda',
      summary: `${req.user?.email || 'Usuário'} atualizou o snapshot CeIMSPA Sem Demanda com ${ceimspaData.length} PI(s) únicos em modo de baixa memória.`,
      details: {
        linhas_lidas: parsed.sourceRows || 0,
        linhas_validas: parsed.validRows || 0,
        pis_importados: ceimspaData.length,
        arquivo: req.file?.originalname || null,
        bytes_upload: Number(req.file?.size || 0),
        modo_memoria: memoryMode,
        regra_saldo: 'PI_UNICO_SALDO_COMPARTILHADO_ENTRE_REFERENCIAS',
      },
      level: 'INFO',
      visibility: 'GOD',
    });

    setAuditSummary(req, {
      status: 'SUCESSO',
      mensagem: `CeIMSPA Sem Demanda atualizado: ${ceimspaData.length} PI(s) únicos.`,
      tabelaAlvo: 'estoque_ceimspa',
      linhasLidas: parsed.sourceRows || 0,
      linhasImportadas: ceimspaData.length,
      detalhes: { modo_memoria: memoryMode, linhas_validas: parsed.validRows || 0 },
    });

    console.info('[SISHA][ceimspa-sem-demanda] LOW_MEMORY_SUCCESS', {
      modo: memoryMode,
      pis: ceimspaData.length,
      linhas: parsed.sourceRows || 0,
      memoria_mb: memoryMb(),
    });

    return res.status(200).json({
      status: 'success',
      message: `CeIMSPA Sem Demanda atualizado: ${ceimspaData.length} PI(s) únicos. PNs/REFs do mesmo PI compartilham o mesmo saldo e não são somados entre si.`,
      data: {
        pis_importados: ceimspaData.length,
        linhas_lidas: parsed.sourceRows || 0,
        linhas_validas: parsed.validRows || 0,
        modo_memoria: memoryMode,
      },
    });
  } catch (error) {
    const knownInputError = String(error?.code || '').startsWith('CEIMSPA_SEM_DEMANDA_');
    console.error('[SISHA][ceimspa-sem-demanda] LOW_MEMORY_ERROR', {
      code: error?.code || null,
      message: error?.message || String(error),
      memoria_mb: memoryMb(),
    });
    setAuditSummary(req, {
      status: 'ERRO',
      mensagem: error?.message || 'Falha ao importar CeIMSPA Sem Demanda.',
      tabelaAlvo: 'estoque_ceimspa',
      detalhes: { modo_memoria: 'LOW_MEMORY_IMPORT' },
    });
    return res.status(knownInputError ? 400 : 500).json({
      status: 'error',
      message: error?.message || 'Falha ao importar CeIMSPA Sem Demanda.',
    });
  } finally {
    workbook = null;
    if (tempPath) await fs.promises.unlink(tempPath).catch(() => null);
  }
}

module.exports = { importCeimspaSemDemandaLowMemory };
