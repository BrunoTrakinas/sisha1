-- SISHA1 V2 — H4B
-- Snapshot versionado da RPC real sisha_apply_equipment_inventory_import,
-- capturada em modo read-only do banco vivo em 2026-08-13.
-- CREATE OR REPLACE preserva a assinatura/comportamento observado.

CREATE OR REPLACE FUNCTION public.sisha_apply_equipment_inventory_import(p_mode text, p_snapshot_date date, p_file_name text, p_file_hash text, p_user_email text, p_rows jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_mode text := upper(btrim(coalesce(p_mode, 'MERGE')));
  v_import_id bigint;
  v_row jsonb;
  v_equipment_id bigint;
  v_pn text;
  v_sn text;
  v_loc text;
  v_loc_norm text;
  v_category text;
  v_nomenclature text;
  v_obs text;
  v_warranty date;
  v_current_local text;
  v_current_category text;
  v_current_status text;
  v_current_condition text;
  v_count integer := 0;
  v_total integer;
begin
  if v_mode not in ('MERGE', 'REPLACE') then
    raise exception 'Modo inválido: %. Use MERGE ou REPLACE.', v_mode;
  end if;
  if p_snapshot_date is null then
    raise exception 'Data do snapshot é obrigatória.';
  end if;
  if nullif(btrim(coalesce(p_file_name, '')), '') is null then
    raise exception 'Nome do arquivo é obrigatório.';
  end if;
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' then
    raise exception 'As linhas do inventário devem ser enviadas como array JSON.';
  end if;

  v_total := jsonb_array_length(p_rows);
  if v_total < 1 then
    raise exception 'O inventário não possui linhas para aplicar.';
  end if;
  if v_total > 12000 then
    raise exception 'O inventário excede o limite de 12.000 equipamentos por operação.';
  end if;

  insert into public.equipamento_inventario_importacoes (
    modo, data_snapshot, arquivo_nome, arquivo_hash,
    linhas_recebidas, linhas_processadas, created_by_email
  ) values (
    v_mode, p_snapshot_date, btrim(p_file_name), nullif(btrim(coalesce(p_file_hash, '')), ''),
    v_total, 0, p_user_email
  ) returning id into v_import_id;

  if v_mode = 'REPLACE' then
    update public.equipamentos_serializados
       set presente_ultimo_inventario_serializado = false,
           updated_at = now(),
           atualizado_por = p_user_email
     where ultimo_inventario_serializado_importacao_id is not null
       and ativo is distinct from false;
  end if;

  for v_row in select value from jsonb_array_elements(p_rows)
  loop
    v_pn := upper(regexp_replace(btrim(coalesce(v_row->>'pn', '')), '\s+', '', 'g'));
    v_sn := upper(regexp_replace(btrim(coalesce(v_row->>'sn', '')), '\s+', '', 'g'));
    v_loc := nullif(btrim(coalesce(v_row->>'localizacao', '')), '');
    v_loc_norm := public.sisha_normalize_location(v_loc);
    v_category := upper(btrim(coalesce(nullif(v_row->>'categoria_destino', ''), 'PPU')));
    v_nomenclature := nullif(btrim(coalesce(v_row->>'nomenclatura', '')), '');
    v_obs := nullif(btrim(coalesce(v_row->>'observacao', '')), '');
    v_warranty := nullif(v_row->>'garantia_vencimento', '')::date;

    if v_pn = '' or v_sn = '' then
      raise exception 'Linha %: PN e SN são obrigatórios.', coalesce((v_row->>'linha_origem')::integer, v_count + 1);
    end if;
    if v_loc is null then
      raise exception 'Linha %: localização é obrigatória.', coalesce((v_row->>'linha_origem')::integer, v_count + 1);
    end if;

    insert into public.equipamentos_serializados (
      pn, sn, nomenclatura,
      status_atual, condicao_atual, categoria_local_atual, confianca_localizacao,
      garantia_vencimento,
      origem_entrada, documento_entrada, data_entrada,
      ultimo_inventario_serializado_importacao_id,
      ultimo_inventario_serializado_em,
      ultimo_inventario_serializado_arquivo,
      local_inventario_serializado,
      presente_ultimo_inventario_serializado,
      atualizado_por, ativo
    ) values (
      v_pn, v_sn, v_nomenclature,
      'DESCONHECIDO', 'DESCONHECIDA', 'DESCONHECIDO', 'DESCONHECIDA',
      v_warranty,
      'INVENTARIO_SERIALIZADO', btrim(p_file_name), p_snapshot_date,
      v_import_id, p_snapshot_date, btrim(p_file_name), v_loc, true,
      p_user_email, true
    )
    on conflict (pn, sn) do update
      set nomenclatura = coalesce(excluded.nomenclatura, equipamentos_serializados.nomenclatura),
          garantia_vencimento = coalesce(excluded.garantia_vencimento, equipamentos_serializados.garantia_vencimento),
          ultimo_inventario_serializado_importacao_id = v_import_id,
          ultimo_inventario_serializado_em = p_snapshot_date,
          ultimo_inventario_serializado_arquivo = btrim(p_file_name),
          local_inventario_serializado = v_loc,
          presente_ultimo_inventario_serializado = true,
          atualizado_por = p_user_email,
          updated_at = now(),
          ativo = true
    returning id into v_equipment_id;

    insert into public.equipamento_inventario_snapshot_itens (
      importacao_id, equipamento_id, linha_origem, pn, sn, nomenclatura,
      localizacao, localizacao_normalizada, categoria_destino,
      garantia_vencimento, observacao
    ) values (
      v_import_id, v_equipment_id,
      nullif(v_row->>'linha_origem', '')::integer,
      v_pn, v_sn, v_nomenclature,
      v_loc, v_loc_norm, v_category,
      v_warranty, v_obs
    );

    select local_atual, categoria_local_atual, status_atual, condicao_atual
      into v_current_local, v_current_category, v_current_status, v_current_condition
      from public.equipamentos_serializados
     where id = v_equipment_id;

    -- O snapshot é evidência; não escreve diretamente no estado atual.
    -- O trigger da Fase 2B.1 escolhe cronologicamente o evento válido mais recente.
    insert into public.equipamento_eventos (
      equipamento_id, pn, sn, tipo_evento, data_evento,
      local_origem, local_destino,
      categoria_origem, categoria_destino,
      status_resultante, condicao_resultante,
      motivo, documento_tipo, documento, observacao, usuario,
      origem_evento, confianca, automatico, invalidado, payload
    ) values (
      v_equipment_id, v_pn, v_sn, 'INVENTARIO_EQUIPAMENTOS', p_snapshot_date::timestamptz,
      v_current_local, v_loc,
      v_current_category, v_category,
      coalesce(nullif(v_current_status, ''), 'LOCALIZADO'),
      coalesce(nullif(v_current_condition, ''), 'DESCONHECIDA'),
      'Posição informada pelo inventário serializado de equipamentos.',
      'INVENTARIO_EQUIPAMENTOS', btrim(p_file_name), v_obs, p_user_email,
      'INVENTARIO_SERIALIZADO', 'CONFIRMADA', true, false,
      jsonb_build_object(
        'importacao_id', v_import_id,
        'modo', v_mode,
        'data_snapshot', p_snapshot_date,
        'linha_origem', nullif(v_row->>'linha_origem', '')::integer
      )
    );

    v_count := v_count + 1;
  end loop;

  update public.equipamento_inventario_importacoes
     set linhas_processadas = v_count
   where id = v_import_id;

  return jsonb_build_object(
    'importacao_id', v_import_id,
    'modo', v_mode,
    'data_snapshot', p_snapshot_date,
    'arquivo', btrim(p_file_name),
    'processados', v_count
  );
end;
$function$;

insert into public.sisha_schema_migrations(version, description)
values (
  '20260813_H4B_002',
  'H4B: definição real da RPC sisha_apply_equipment_inventory_import capturada do banco vivo.'
)
on conflict (version) do update set description = excluded.description;
