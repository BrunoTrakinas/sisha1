const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  parseCriticalEquipmentWorkbook,
  parsePpuOutputMovementWorkbook,
  locationCategory,
  situationCondition,
  parseMasterOsWorkbook,
  parseMasterOsMovementEvidence,
} = require('../../src/services/rawOperationalDocumentParserService');

const XLSX = { utils: { sheet_to_json: (sheet) => sheet.__rows || [] } };

test('Fonte bruta: Controle Crítico usa tabela detalhada PN+SN/Situação/Local e ignora quadro-resumo', () => {
  const wb = { SheetNames:['SET RADAR'], Sheets:{'SET RADAR':{__rows:[
    ['AERONAVE','4001','4003'],
    ['EQUIPAMENTO','SERIAL NUMBER','SERIAL NUMBER'],
    ['ÚLTIMA ATUALIZAÇÃO: 21/05/2026'],
    ['PART NUMBER','SERIAL NUMBER','SITUAÇÃO','','LOCAL'],
    ['3990-75191 MOD','117','PRONTO USO','','4003'],
    ['3990-75191 MOD','108','AGUARDANDO REPARO','','RECEX VN – B5'],
  ]}}};
  const out=parseCriticalEquipmentWorkbook(XLSX,wb);
  assert.equal(out.items.length,2);
  assert.deepEqual(out.items.map(i=>[i.pn,i.sn,i.local]),[
    ['3990-75191MOD','117','4003'],['3990-75191MOD','108','RECEX VN – B5']
  ]);
  assert.equal(out.items[0].source_observed_at,'2026-05-21');
});

test('Fonte bruta: classificação de local não transforma RECEX/Bancada em PPU',()=>{
  assert.deepEqual(locationCategory('4003'),{categoria:'AERONAVE',aeronave:'4003'});
  assert.equal(locationCategory('RECEX VN – B5').categoria,'RECEX');
  assert.equal(locationCategory('BANCADA HV').categoria,'OFICINA');
  assert.equal(situationCondition('AGUARDANDO REPARO'),'AGUARDANDO_REPARO');
});

test('Fonte bruta: Saída PPU preserva PN+SN/PIM/OS/data sem inventar destino',()=>{
  const wb={SheetNames:['Report'],Sheets:{Report:{__rows:[
    ['Relatório de Movimentação'],
    ['NUMERO PEDIDO','DATA PEDIDO','','','PART NUMER','SERIAL NUMER','NUMERO OS','','','RECEBEDOR'],
    ['4381','2021-03-18','','','49-001-14','580','40030015','','','SG X'],
  ]}}};
  const out=parsePpuOutputMovementWorkbook(XLSX,wb);
  assert.equal(out.items.length,1);
  assert.equal(out.items[0].pn,'49-001-14');
  assert.equal(out.items[0].sn,'580');
  assert.equal(out.items[0].os,'40030015');
});

test('Importador: Controle Crítico usa reconciliação e nunca sobrescreve localização silenciosamente',()=>{
  const src=fs.readFileSync(path.join(__dirname,'../../src/services/rawOperationalDocumentImportService.js'),'utf8');
  assert.match(src,/registerLocationEvidence/);
  assert.match(src,/confirmedTransition:false/);
  assert.match(src,/CONFLICT/);
});

test('Importador: Saída PPU é histórica e não define local_destino',()=>{
  const src=fs.readFileSync(path.join(__dirname,'../../src/services/rawOperationalDocumentImportService.js'),'utf8');
  assert.match(src,/SAIDA_PPU_HISTORICA/);
  assert.match(src,/historical_only:true/);
  assert.match(src,/local_destino:null/);
});

test('Inventário Geral PPU também alimenta identidade PN+SN do Livro sem inventar serial',()=>{
  const src=fs.readFileSync(path.join(__dirname,'../../src/controllers/importController.js'),'utf8');
  assert.match(src,/equipamentosSerializados/);
  assert.match(src,/importPpuInventoryEquipmentSnapshot/);
  assert.match(src,/conflitos_localizacao/);
  const importer=fs.readFileSync(path.join(__dirname,'../../src/services/rawOperationalDocumentImportService.js'),'utf8');
  assert.match(importer,/source_type:'INVENTARIO_PPU'/);
  assert.match(importer,/confirmedTransition:false/);
});

test('Controle de Inspeção reutiliza A1.1 em vez de criar segunda verdade de disponibilidade',()=>{
  const src=fs.readFileSync(path.join(__dirname,'../../src/controllers/importController.js'),'utf8');
  assert.match(src,/tipoArquivo === 'controle_inspecao'/);
  assert.match(src,/parseAvailabilityWorkbookBuffer/);
  assert.match(src,/aircraft_availability_snapshots\/aircraft_maintenance_indicators/);
});

test('Frontend preserva a Central e usa os nomes originais das fontes brutas',()=>{
  const src=fs.readFileSync(path.join(__dirname,'../../../sisha-frontend/src/pages/Cadastro.jsx'),'utf8');
  assert.match(src,/Controle de Equipamentos Criticos da Aeronave/);
  assert.match(src,/SaidaMovimentacaoPorPeriodo/);
  assert.match(src,/CONTROLE INSPEÇÃO/);
});

test('HF importação: PN+SN concorrente converge para a mesma identidade sem 23505',()=>{
  const raw=fs.readFileSync(path.join(__dirname,'../../src/services/rawOperationalDocumentImportService.js'),'utf8');
  const master=fs.readFileSync(path.join(__dirname,'../../src/services/equipmentService.js'),'utf8');
  const receipt=fs.readFileSync(path.join(__dirname,'../../src/services/receiptService.js'),'utf8');
  assert.match(raw,/upsert\(payload,\{onConflict:'pn,sn',ignoreDuplicates:true\}\)/);
  assert.match(raw,/Releitura obrigatória fecha a janela de corrida/);
  assert.match(master,/upsert\(payload, \{ onConflict: 'pn,sn', ignoreDuplicates: true \}\)/);
  assert.match(receipt,/\{ onConflict: 'pn,sn', ignoreDuplicates: true \}/);
  assert.doesNotMatch(raw,/\.from\('equipamentos_serializados'\)\.insert\(payload\)/);
});

test('HF importação: conclusão registra hash, tamanho, parser finalizado e pendências sem alegar cobertura inexistente',()=>{
  const audit=fs.readFileSync(path.join(__dirname,'../../src/middlewares/importAuditMiddleware.js'),'utf8');
  const auditUtils=fs.readFileSync(path.join(__dirname,'../../src/utils/importAudit.js'),'utf8');
  assert.match(audit,/createHash\('sha256'\)/);
  assert.match(audit,/SISHA_IMPORT_COMPLETION_V1/);
  assert.match(audit,/arquivo_recebido_integralmente/);
  assert.match(audit,/CONCLUIDO_COM_PENDENCIAS/);
  assert.match(audit,/INTERROMPIDO_SEM_CONFIRMACAO/);
  assert.match(audit,/res\.once\('finish'/);
  assert.match(audit,/res\.once\('close'/);
  assert.match(auditUtils,/detalhes: \{ \.\.\.previousDetails, \.\.\.nextDetails \}/);
});

test('HF importação: Visão Geral mostra certificado e PROCESSANDO antigo não se passa por concluído',()=>{
  const stats=fs.readFileSync(path.join(__dirname,'../../src/controllers/statsController.js'),'utf8');
  const app=fs.readFileSync(path.join(__dirname,'../../../sisha-frontend/src/App.jsx'),'utf8');
  assert.match(stats,/status_exibicao: buildImportDisplayStatus\(op\)/);
  assert.match(stats,/SEM CONFIRMAÇÃO/);
  assert.match(stats,/linhas_lidas, linhas_importadas, linhas_ignoradas/);
  assert.match(stats,/detalhes/);
  assert.match(app,/Ver detalhes da importação/);
  assert.match(app,/SHA-256:/);
  assert.match(app,/processadas\/aplicadas/);
  assert.match(app,/sem confirmação de conclusão/);
});


test('HF importação: releitura PN+SN pagina além do teto de 1000 linhas do PostgREST',()=>{
  const raw=fs.readFileSync(path.join(__dirname,'../../src/services/rawOperationalDocumentImportService.js'),'utf8');
  assert.match(raw,/const pageSize=1000/);
  assert.match(raw,/\.order\('id',\{ascending:true\}\)/);
  assert.match(raw,/\.range\(offset,offset\+pageSize-1\)/);
  assert.match(raw,/if\(rows\.length<pageSize\) break/);
});

test('MASTER OS: lê abas operacionais, ignora BD_MASTER derivada e bloqueia prefixo divergente',()=>{
  const wb={SheetNames:['4003','4001','MV','BD_MASTER','CORRETIVAS'],Sheets:{
    '4003':{__rows:[
      ['ComEsqdHa-1'],[4003],['REGISTRO DE ORDEM DE SERVIÇO'],
      ['NÚMERO','SAÍDA','SIT','DESTINO','DISCREPÂNCIA','ENTRADA','RESPONSAVEL','INSPEÇÃO','PANE'],
      [40030124,46120,'I','SV','BLADE SLEEVE S/N AEE8058 DANIFICADO. SANAR.',46128,'ASS','CORRETIVA','ECU COD90'],
    ]},
    '4001':{__rows:[
      ['ComEsqdHa-1'],[4001],['REGISTRO DE ORDEM DE SERVIÇO'],
      ['NÚMERO','SAÍDA','SIT','DESTINO','DISCREPÂNCIA','ENTRADA','RESPONSAVEL','INSPEÇÃO','PANE'],
      [40100025,46153,'D','VN','OS COM PREFIXO DE OUTRA AERONAVE',46176,'WSK','CORRETIVA','ECU COD114'],
    ]},
    'MV':{__rows:[
      ['ComEsqdHa-1'],['OFICINA MV'],['REGISTRO DE ORDEM DE SERVIÇO'],
      ['NÚMERO','SAÍDA','SIT','DESTINO','DISCREPÂNCIA','ENTRADA','RESPONSAVEL','INSPEÇÃO','PANE'],
      ['MV0046',46122,'D','MV','CUMPRIR PRESERVAÇÃO NA BMRH S/N AEE7541','','','CORRETIVA','ECU COD90'],
    ]},
    'BD_MASTER':{__rows:[['AERONAVE/OFICINA','DATA','OS'],[4003,46120,40030124]]},
    'CORRETIVAS':{__rows:[['derivada']]},
  }};
  const out=parseMasterOsWorkbook(XLSX,wb);
  assert.equal(out.items.length,2);
  assert.deepEqual(out.items.map((item)=>item.os_numero_normalizado).sort(),['40030124','MV0046']);
  assert.equal(out.items.find((item)=>item.os_numero_normalizado==='40030124').status_evidencia,'FECHADA');
  assert.equal(out.items.find((item)=>item.os_numero_normalizado==='MV0046').status_evidencia,'ABERTA');
  assert.ok(out.issues.some((issue)=>String(issue.reason).includes('diverge da aba 4001')));
  assert.ok(out.summary.sheets_ignored_names.includes('BD_MASTER'));
});

test('MASTER OS: integração é append-only, server-only e usa OS fechada como evidência física somente quando inequívoca',()=>{
  const controller=fs.readFileSync(path.join(__dirname,'../../src/controllers/importController.js'),'utf8');
  const service=fs.readFileSync(path.join(__dirname,'../../src/services/masterOsImportService.js'),'utf8');
  const orchestrator=fs.readFileSync(path.join(__dirname,'../../src/services/masterOsEquipmentOrchestratorService.js'),'utf8');
  const migration=fs.readFileSync(path.join(__dirname,'../../sql/migrations/20260816_HF_MASTER_OS_001_historico_os_append_only.sql'),'utf8');
  const frontend=fs.readFileSync(path.join(__dirname,'../../../sisha-frontend/src/pages/Cadastro.jsx'),'utf8');
  const lince=fs.readFileSync(path.join(__dirname,'../../src/services/chatLinceDbToolsService.js'),'utf8');
  assert.match(controller,/tipoArquivo === 'master_os'/);
  assert.match(controller,/OS ABERTA.*Não altera localização física/s);
  assert.match(controller,/OS FECHADA.*Confirma localização\/movimentação/s);
  assert.match(service,/os_master_evidencias/);
  assert.match(service,/orchestrateMasterOsEquipment/);
  assert.match(orchestrator,/sisha_apply_master_os_movement_atomic/);
  assert.match(orchestrator,/MASTER_OS_INTENCAO_/);
  assert.match(orchestrator,/MASTER_OS_CANCELADA/);
  assert.match(orchestrator,/REMOCAO_ANV/);
  assert.match(orchestrator,/INSTALACAO_ANV/);
  assert.match(orchestrator,/HISTORICAL_EVENT/);
  assert.match(migration,/create table if not exists public\.os_master_evidencias/);
  assert.match(migration,/v_sisha_os_historico_atual/);
  assert.match(migration,/case when v\.status_evidencia in \('FECHADA','CANCELADA'\) then 2 else 1 end desc/);
  assert.match(migration,/movimento_estado text not null default 'NAO_APLICAVEL'/);
  assert.match(migration,/enable row level security/);
  assert.match(frontend,/MASTER OS — Histórico e Orquestração de Ordens de Serviço/);
  assert.match(lince,/movimento_estado/);
});

test('MASTER OS: parser separa intenção de movimento e extrai PN+SN somente de marcadores explícitos',()=>{
  const closed=parseMasterOsMovementEvidence('REMOVER SEMI-AUTOMATIC CARGO-RELEASE P/N CA3000 S/N CA992 E ENVIAR PARA OFICINA DE SV.');
  assert.equal(closed.tipo,'REMOCAO');
  assert.deepEqual(closed.pns_explicitos,['CA3000']);
  assert.deepEqual(closed.sns_explicitos,['CA992']);

  const install=parseMasterOsMovementEvidence('INSTALAR MAIN BATTERY DE S/N: 201901460.');
  assert.equal(install.tipo,'INSTALACAO');
  assert.deepEqual(install.pns_explicitos,[]);
  assert.deepEqual(install.sns_explicitos,['201901460']);

  const ambiguous=parseMasterOsMovementEvidence('REMOVER E INSTALAR COMPONENTE S/N ABC123.');
  assert.equal(ambiguous.tipo,'AMBIGUO');
  assert.equal(ambiguous.ambiguo,true);
});

test('MASTER OS: política operacional não move OS aberta/cancelada e exige fechamento + identidade + destino',()=>{
  const orchestrator=fs.readFileSync(path.join(__dirname,'../../src/services/masterOsEquipmentOrchestratorService.js'),'utf8');
  assert.match(orchestrator,/status === 'CANCELADA'.*preserva intenção, nunca movimenta item/s);
  assert.match(orchestrator,/status === 'ABERTA'.*preserva escrituração\/intenção, nunca movimenta item/s);
  assert.match(orchestrator,/status !== 'FECHADA'/);
  assert.match(orchestrator,/PENDENTE_DESTINO_AMBIGUO/);
  assert.match(orchestrator,/Descrição de movimento sem S\/N explícito/);
  assert.match(orchestrator,/identidades_criadas_por_pn_sn_explicito/);
});

test('MASTER OS: fonte fechada converge com o mesmo Livro usado por PPU/PIM/STC/WO/Recibo',()=>{
  const orchestrator=fs.readFileSync(path.join(__dirname,'../../src/services/masterOsEquipmentOrchestratorService.js'),'utf8');
  assert.match(orchestrator,/sisha_apply_master_os_movement_atomic/);
  assert.match(orchestrator,/origem_evento: 'MASTER_OS'/);
  assert.match(orchestrator,/origem_registro_id: sourceKey/);
  assert.match(orchestrator,/Evidência histórica mais antiga|HISTORICAL_EVENT/);
  const controller=fs.readFileSync(path.join(__dirname,'../../src/controllers/importController.js'),'utf8');
  assert.match(controller,/Master OS, PPU, PIM, STC, WO, PD e Recibos convergem no histórico do SISHA/);
});


test('MASTER OS: OS fechada atualiza projeção física de forma ACID sem degradar A2 nem inventar intervalo de instalação',()=>{
  const migration=fs.readFileSync(path.join(__dirname,'../../sql/migrations/20260816_HF_MASTER_OS_001_historico_os_append_only.sql'),'utf8');
  const orchestrator=fs.readFileSync(path.join(__dirname,'../../src/services/masterOsEquipmentOrchestratorService.js'),'utf8');
  assert.match(migration,/create or replace function public\.sisha_apply_master_os_movement_atomic/);
  assert.match(migration,/update public\.equipamentos_serializados[\s\S]*categoria_local_atual = v_dest_category/);
  assert.match(migration,/A2_INTERVAL_CONFLICT/);
  assert.match(migration,/update public\.equipment_operational_intervals[\s\S]*removed_at = v_when/);
  assert.match(migration,/removal_reason = null/);
  assert.match(migration,/latest_valid_location_event_id/);
  assert.match(migration,/HISTORICAL_EVENT/);
  assert.match(orchestrator,/A2_CORROBORATED/);
  assert.match(orchestrator,/PENDENTE_CONFLITO_A2/);
  assert.match(orchestrator,/condição conhecida é preservada/);
});


test('MASTER OS: ignora cauda de template sem número e reconhece cancelamento dentro da descrição',()=>{
  const wb={SheetNames:['4003'],Sheets:{'4003':{__rows:[
    ['ComEsqdHa-1'],[4003],['REGISTRO DE ORDEM DE SERVIÇO'],
    ['NÚMERO','SAÍDA','SIT','DESTINO','DISCREPÂNCIA','ENTRADA','RESPONSAVEL','INSPEÇÃO','PANE'],
    [40030277,46235,'D','SV/VN','REMOVER RESCUE HOIST. (((CANCELADA)))','','','',''],
    ['', '', 'R','VN','', '', '', 'CORRETIVA','ECU COD128'],
    ['', '', 'R','VN','', '', '', 'CORRETIVA','ECU COD129'],
    [40030278,'','','','','','','',''],
  ]}}};
  const out=parseMasterOsWorkbook(XLSX,wb);
  assert.equal(out.items.length,1);
  assert.equal(out.items[0].os_numero_normalizado,'40030277');
  assert.equal(out.items[0].status_evidencia,'CANCELADA');
  assert.equal(out.issues.length,1);
  assert.equal(out.issues[0].os,'40030278');
});


test('MASTER OS: cronologia impossível é preservada como evidência e vira alerta, não correção automática',()=>{
  const wb={SheetNames:['4004'],Sheets:{'4004':{__rows:[
    ['ComEsqdHa-1'],[4004],['REGISTRO DE ORDEM DE SERVIÇO'],
    ['NÚMERO','SAÍDA','SIT','DESTINO','DISCREPÂNCIA','ENTRADA','RESPONSAVEL','INSPEÇÃO','PANE'],
    [40040007,'09/01/2026','D','VN-HV','CUMPRIR INSPEÇÃO CALENDÁRICA','08/01/2026','GUI','PREVENTIVA','ECU COD96'],
  ]}}};
  const out=parseMasterOsWorkbook(XLSX,wb);
  assert.equal(out.items.length,1);
  assert.equal(out.items[0].cronologia_consistente,false);
  assert.equal(out.summary.blocking_issues,0);
  assert.equal(out.summary.warnings,1);
  assert.equal(out.issues[0].imported,true);
  assert.match(out.issues[0].reason,/preservada sem corrigir datas automaticamente/);
});
