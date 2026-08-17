const supabase = require('../config/supabaseClient');
const equipmentService = require('./equipmentService');
const { hashBuffer } = require('./rawOperationalDocumentParserService');

function key(pn, sn) { return `${String(pn||'').toUpperCase()}::${String(sn||'').toUpperCase().replace(/\s+/g,'')}`; }
function chunks(list,size=300){ const out=[]; for(let i=0;i<list.length;i+=size) out.push(list.slice(i,i+size)); return out; }

async function ensureIdentities(rows, {fileName, user, origin='FONTE_OPERACIONAL'}={}) {
  // PN+SN é a identidade patrimonial canônica. Dois importadores podem processar
  // fontes diferentes ao mesmo tempo (ex.: Inventário PPU + Controle Crítico),
  // portanto o fluxo precisa ser idempotente também sob concorrência.
  const unique = new Map();
  for (const row of rows || []) {
    if (!row?.pn || !row?.sn) continue;
    const normalized = {
      ...row,
      pn: String(row.pn).trim().toUpperCase(),
      sn: String(row.sn).trim().toUpperCase().replace(/\s+/g, ''),
    };
    unique.set(key(normalized.pn, normalized.sn), normalized);
  }

  const pns=[...new Set([...unique.values()].map(r=>r.pn))];
  const loadExisting = async () => {
    const existing=[];
    const pageSize=1000;
    for (const part of chunks(pns,300)) {
      if (!part.length) continue;
      for(let offset=0;;offset+=pageSize){
        const {data,error}=await supabase
          .from('equipamentos_serializados')
          .select('*')
          .in('pn',part)
          .order('id',{ascending:true})
          .range(offset,offset+pageSize-1);
        if(error) throw error;
        const rows=data||[];
        existing.push(...rows);
        if(rows.length<pageSize) break;
      }
    }
    return existing;
  };

  const existingBefore = await loadExisting();
  const initialKeys = new Set(existingBefore.map(e=>key(e.pn,e.sn)));
  let byKey=new Map(existingBefore.map(e=>[key(e.pn,e.sn),e]));
  const missing=[...unique.values()].filter(r=>!byKey.has(key(r.pn,r.sn)));
  let created=0;

  for (const part of chunks(missing,250)) {
    const payload=part.map(r=>({
      pn:r.pn, sn:r.sn, nomenclatura:r.nomenclatura||null,
      status_atual:'DESCONHECIDO', condicao_atual:'DESCONHECIDA', categoria_local_atual:'DESCONHECIDO', confianca_localizacao:'DESCONHECIDA',
      origem_entrada:origin, documento_entrada:fileName||origin, data_entrada:r.data||null,
      atualizado_por:user?.email||null, ativo:true,
    }));

    // ignoreDuplicates evita que uma corrida entre dois uploads do mesmo PN+SN
    // derrube o motor com PostgreSQL 23505. Nunca sobrescrevemos o cadastro já
    // existente: a nova fonte segue para Livro de Eventos/reconciliação.
    const {data,error}=await supabase
      .from('equipamentos_serializados')
      .upsert(payload,{onConflict:'pn,sn',ignoreDuplicates:true})
      .select('*');
    if(error) throw error;
    created += (data||[]).filter(e=>!initialKeys.has(key(e.pn,e.sn))).length;
  }

  // Releitura obrigatória fecha a janela de corrida: se outra importação venceu o
  // INSERT, usamos a mesma identidade que ela criou e continuamos o arquivo.
  const existingAfter = await loadExisting();
  byKey=new Map(existingAfter.map(e=>[key(e.pn,e.sn),e]));
  const unresolved=[...unique.values()].filter(r=>!byKey.has(key(r.pn,r.sn)));
  if(unresolved.length){
    const sample=unresolved.slice(0,5).map(r=>`${r.pn}/${r.sn}`).join(', ');
    throw new Error(`Não foi possível reconciliar ${unresolved.length} identidade(s) PN+SN após a gravação idempotente: ${sample}.`);
  }

  return {byKey, created, existing:Math.max(0, unique.size-created)};
}

async function importPpuInventoryEquipmentSnapshot(parsed,{buffer,fileName,user}={}){
  const fileHash=hashBuffer(buffer);
  const rows=(parsed.items||[]).filter((row)=>row?.pn&&row?.sn);
  const ensured=await ensureIdentities(rows,{fileName,user,origin:'INVENTARIO_PPU'});
  let events=0,conflicts=0,same=0,historical=0,ignored=0;
  const snapshotTime=new Date().toISOString();
  for(const row of rows){
    const equipment=ensured.byKey.get(key(row.pn,row.sn));
    if(!equipment){ignored++;continue;}
    const local=String(row.localizacao||'').trim();
    if(!local || ['NÃO DEFINIDO','NAO DEFINIDO','CONFLITO DE LOCALIZAÇÃO','CONFLITO DE LOCALIZACAO'].includes(local.toUpperCase())){ignored++;continue;}
    const result=await equipmentService.registerLocationEvidence(equipment.id,{
      tipo_evento:'INVENTARIO_PPU_LOCALIZACAO', data_evento:snapshotTime,
      categoria_destino:'PPU', local_destino:local, anv_destino:null,
      status_resultante:equipment.status_atual||'DESCONHECIDO',
      condicao_resultante:equipment.condicao_atual||'DESCONHECIDA', confianca:'ALTA',
      motivo:'Inventário Geral do PPU por Localização registra a posição física observada do PN+SN. Divergência com estado vigente exige reconciliação.',
      payload:{source_section:row.source_section||'EQUIPAMENTOS',source_row:row.source_row||null,temporal_precision:'IMPORT_TIME_ONLY'},
    },{
      source_type:'INVENTARIO_PPU', origin_event:'INVENTARIO_PPU',
      source_key:`PPU:${fileHash}:${row.source_row||''}:${row.pn}:${row.sn}`,
      documento:fileName, arquivo:fileName, file_hash:fileHash, linha:row.source_row||null,
      observacao:'Relatório oficial bruto do PPU; não resolve conflitos de localização sem Admin/Dono.',
    },user,{automatico:true,confirmedTransition:false});
    if(result.action==='CONFLICT') conflicts++; else if(result.action==='SAME_LOCATION') same++; else if(result.action==='HISTORICAL_EVENT') historical++; else if(result.action==='IGNORED_NO_LOCATION') ignored++; else events++;
  }
  return {source_sha256:fileHash,created_identities:ensured.created,existing_identities:ensured.existing,events,conflicts,same,historical,ignored};
}

async function importCriticalEquipmentControl(parsed,{buffer,fileName,user}={}){
  const fileHash=hashBuffer(buffer); const ensured=await ensureIdentities(parsed.items,{fileName,user,origin:'CONTROLE_EQUIPAMENTOS_CRITICOS'});
  let events=0,conflicts=0,same=0,historical=0,ignored=0;
  for(const row of parsed.items){
    const equipment=ensured.byKey.get(key(row.pn,row.sn)); if(!equipment){ignored++;continue;}
    const result=await equipmentService.registerLocationEvidence(equipment.id,{
      tipo_evento:'CONTROLE_CRITICO_LOCALIZACAO', data_evento:row.source_observed_at ? `${row.source_observed_at}T12:00:00.000Z` : new Date().toISOString(),
      categoria_destino:row.categoria, local_destino:row.local, anv_destino:row.aeronave,
      status_resultante:row.situation, condicao_resultante:row.condicao, confianca:'MEDIA',
      motivo:'Controle de Equipamentos Críticos indica posição/situação operacional a reconciliar com as demais fontes.',
      payload:{source_observed_at:row.source_observed_at||null,temporal_precision:row.source_observed_at?'SOURCE_DATE':'IMPORT_TIME_ONLY',situacao_original:row.situation},
    },{
      source_type:'CONTROLE_EQUIPAMENTOS_CRITICOS', origin_event:'CONTROLE_CRITICOS',
      source_key:`CRIT:${fileHash}:${row.source_sheet}:${row.source_row}:${row.pn}:${row.sn}`,
      documento:fileName, arquivo:fileName, file_hash:fileHash, linha:row.source_row,
      observacao:`Aba ${row.source_sheet}; situação ${row.situation}.`,
    },user,{automatico:true,confirmedTransition:false});
    if(result.action==='CONFLICT') conflicts++; else if(result.action==='SAME_LOCATION') same++; else if(result.action==='HISTORICAL_EVENT') historical++; else if(result.action==='IGNORED_NO_LOCATION') ignored++; else events++;
  }
  return {source_sha256:fileHash,created_identities:ensured.created,existing_identities:ensured.existing,events,conflicts,same,historical,ignored};
}

async function importPpuOutputHistory(parsed,{buffer,fileName,user}={}){
  const fileHash=hashBuffer(buffer); const ensured=await ensureIdentities(parsed.items,{fileName,user,origin:'MOVIMENTACAO_PPU_HISTORICA'});
  const eventRows=[];
  for(const row of parsed.items){
    const equipment=ensured.byKey.get(key(row.pn,row.sn)); if(!equipment) continue;
    eventRows.push({
      equipamento_id:Number(equipment.id), pn:equipment.pn, sn:equipment.sn,
      tipo_evento:'SAIDA_PPU_HISTORICA', data_evento:`${row.data}T12:00:00.000Z`, pim:row.pim||null, os:row.os||null,
      local_origem:null, local_destino:null, categoria_origem:null, categoria_destino:null,
      status_resultante:equipment.status_atual||'DESCONHECIDO', condicao_resultante:equipment.condicao_atual||'DESCONHECIDA',
      motivo:'Saída histórica registrada no relatório oficial de movimentação do PPU; destino físico não é inferido.',
      documento_tipo:'MOVIMENTACAO_PPU', documento:fileName, observacao:row.receiver?`Recebedor: ${row.receiver}`:null,
      usuario:user?.email||null, origem_evento:'MOVIMENTACAO_PPU_SAIDA',
      origem_registro_id:`SAIDA:${fileHash}:${row.source_row}:${row.pn}:${row.sn}`,
      confianca:'ALTA', automatico:true, invalidado:false,
      payload:{linha_origem:row.source_row,pim:row.pim||null,os:row.os||null,data_pronto:row.data_pronto||null,recebedor:row.receiver||null,historical_only:true},
    });
  }
  let imported=0;
  for(const part of chunks(eventRows,500)){
    const {data,error}=await supabase.from('equipamento_eventos').upsert(part,{onConflict:'origem_evento,origem_registro_id'}).select('id');
    if(error) throw error; imported+=(data||part).length;
  }
  return {source_sha256:fileHash,created_identities:ensured.created,existing_identities:ensured.existing,events:imported};
}

module.exports={ensureIdentities,importPpuInventoryEquipmentSnapshot,importCriticalEquipmentControl,importPpuOutputHistory};
