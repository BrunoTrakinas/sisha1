-- SISHA1V2 — HF PPU — Inventário cru e classificação operacional de localizações
-- Separação entre localização física e destino de contabilização logística.
-- Não altera estoque, não move itens e não infere condição operacional pelo nome da LOC.

begin;

do $check$
begin
  if to_regclass('public.ppu_localizacoes_config') is null then
    raise exception 'HF PPU: tabela public.ppu_localizacoes_config ausente.';
  end if;
end
$check$;

alter table public.ppu_localizacoes_config
  add column if not exists destino_contabilizacao text,
  add column if not exists situacao_operacional text;

update public.ppu_localizacoes_config
set destino_contabilizacao = case
      when contabiliza_ppu is not false then 'PPU'
      else coalesce(nullif(upper(btrim(destino_contabilizacao)), ''), 'FORA_LINHA')
    end,
    situacao_operacional = case
      when contabiliza_ppu is not false then 'DISPONIVEL'
      else coalesce(nullif(upper(btrim(situacao_operacional)), ''), 'A_CONFIRMAR')
    end
where destino_contabilizacao is null
   or situacao_operacional is null
   or (contabiliza_ppu is not false and (destino_contabilizacao <> 'PPU' or situacao_operacional <> 'DISPONIVEL'));

alter table public.ppu_localizacoes_config
  alter column destino_contabilizacao set default 'PPU',
  alter column destino_contabilizacao set not null,
  alter column situacao_operacional set default 'DISPONIVEL',
  alter column situacao_operacional set not null;

do $constraints$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.ppu_localizacoes_config'::regclass
      and conname = 'ppu_localizacoes_config_destino_contabilizacao_chk'
  ) then
    alter table public.ppu_localizacoes_config
      add constraint ppu_localizacoes_config_destino_contabilizacao_chk
      check (destino_contabilizacao in ('PPU', 'CEIMSPA', 'FORA_LINHA'));
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.ppu_localizacoes_config'::regclass
      and conname = 'ppu_localizacoes_config_situacao_operacional_chk'
  ) then
    alter table public.ppu_localizacoes_config
      add constraint ppu_localizacoes_config_situacao_operacional_chk
      check (situacao_operacional in (
        'DISPONIVEL', 'A_CONFIRMAR', 'AGUARDANDO_REPARO', 'EM_REPARO', 'EM_WO',
        'CONDENADO_LIXO', 'ARMAZENADO_EXTERNAMENTE', 'QUARENTENA', 'OUTRO'
      ));
  end if;


  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.ppu_localizacoes_config'::regclass
      and conname = 'ppu_localizacoes_config_coerencia_destino_chk'
  ) then
    alter table public.ppu_localizacoes_config
      add constraint ppu_localizacoes_config_coerencia_destino_chk
      check (
        (contabiliza_ppu is not false and destino_contabilizacao = 'PPU' and situacao_operacional = 'DISPONIVEL')
        or
        (contabiliza_ppu is false and destino_contabilizacao in ('CEIMSPA', 'FORA_LINHA') and situacao_operacional <> 'DISPONIVEL')
      );
  end if;
end
$constraints$;

commit;
