\set ON_ERROR_STOP on
-- All records below are synthetic. This test database is never a deployed SISHA instance.
do $$ begin
  if current_database() <> 'sisha_r6_fixture' then raise exception 'Fixture only'; end if;
end $$;
create role anon nologin;
create role authenticated nologin;
create role service_role nologin bypassrls;
create table public.estoque_ppu(id serial primary key,pn text not null,nsn_pi text,nomenclatura text,quantidade numeric default 0,localizacao text,data_atualizacao timestamptz default now(),sn text,data_chegada date,data_garantia date,check(pn <> 'FIXTURE-FAIL-LATE'));
create table public.ppu_localizacoes_config(id bigserial primary key,localizacao_normalizada text unique not null,localizacao_exibicao text not null,observacao text,updated_by_email text,created_at timestamptz not null default now(),updated_at timestamptz not null default now(),ativo boolean not null default true,contabiliza_ppu boolean not null default true,destino_contabilizacao text not null default 'PPU',situacao_operacional text not null default 'DISPONIVEL',check ((contabiliza_ppu and destino_contabilizacao='PPU' and situacao_operacional='DISPONIVEL') or (not contabiliza_ppu and destino_contabilizacao in ('CEIMSPA','FORA_LINHA') and situacao_operacional<>'DISPONIVEL')));
create table public.import_logs(id uuid primary key default gen_random_uuid(),tipo_arquivo text not null,nome_arquivo text,status text default 'PROCESSANDO',detalhes jsonb default '{}',uploaded_by_email text,tabela_alvo text,linhas_importadas integer default 0,mensagem text,finished_at timestamptz);
create table public.recebimentos(id bigint primary key,numero_recibo text not null,ativo boolean default true,data_recebimento date);
create table public.equipamentos_serializados(id bigint primary key,pn text not null,sn text not null,ativo boolean default true);
create table public.recebimento_itens(id bigint primary key,recebimento_id bigint references public.recebimentos(id),pn text not null,sn text,quantidade numeric not null check(quantidade>=0),quantidade_inventariada numeric not null default 0 check(quantidade_inventariada>=0 and quantidade_inventariada<=quantidade),ativo boolean default true,tipo_item text default 'SOBRESSALENTE',condicao_item text default 'RECEBIDO_DISPONIVEL',validade_status text default 'NAO_INFORMADA',destino_previsto text,destino_estoque text,contabiliza_pelo_recibo boolean not null default true,inventariado_ppu boolean not null default false,inventariado_em timestamptz,inventariado_por_email text,equipamento_id bigint references public.equipamentos_serializados(id),localizacao_ppu text,check(quantidade_inventariada<=0 or destino_estoque in ('PPU','CEIMSPA')));
create table public.recebimento_eventos(id bigserial primary key,recebimento_id bigint references public.recebimentos(id),recebimento_item_id bigint references public.recebimento_itens(id),tipo_evento text not null,detalhe jsonb default '{}',created_by_email text,created_at timestamptz default now());
create table public.locrec_importacoes(id uuid primary key default gen_random_uuid(),status text default 'ACTIVE');
create table public.locrec_itens(id bigserial primary key,import_id uuid references public.locrec_importacoes(id),numero_recibo text,pn text,qtd_documental numeric,qtd_auditada_aplicada numeric,loc_escolhida text,destino_indicado text,data_auditoria text);
create view public.v_sisha_locrec_atual as select i.* from public.locrec_itens i join public.locrec_importacoes r on r.id=i.import_id where r.status='ACTIVE';
create function public.sisha_normalize_location(value text) returns text language sql immutable as $$ select nullif(regexp_replace(upper(btrim(coalesce(value,''))),'[[:space:]]+',' ','g'),''); $$;
create function public.sisha_sync_receipt_accounting() returns trigger language plpgsql as $$
begin
 new.quantidade := greatest(coalesce(new.quantidade,0),0);
 new.quantidade_inventariada := greatest(coalesce(new.quantidade_inventariada,0),0);
 new.contabiliza_pelo_recibo := coalesce(new.contabiliza_pelo_recibo,true);
 if new.contabiliza_pelo_recibo is false then new.quantidade_inventariada := new.quantidade;
 elsif new.quantidade_inventariada>new.quantidade then new.quantidade_inventariada:=new.quantidade; end if;
 if new.quantidade>0 and new.quantidade_inventariada>=new.quantidade then new.contabiliza_pelo_recibo:=false; end if;
 if new.quantidade_inventariada<=0 then new.destino_estoque:=null;
 elsif new.destino_estoque is not null then new.destino_estoque:=upper(btrim(new.destino_estoque)); end if;
 new.inventariado_ppu:=(new.contabiliza_pelo_recibo is false and new.quantidade>0);
 if new.inventariado_ppu and new.inventariado_em is null then new.inventariado_em:=now(); end if;
 return new;
end $$;
create trigger trg_recebimento_itens_accounting before insert or update of quantidade,quantidade_inventariada,contabiliza_pelo_recibo,destino_estoque,inventariado_ppu on public.recebimento_itens for each row execute function public.sisha_sync_receipt_accounting();
grant usage on schema public to service_role,anon,authenticated;
grant select,insert,update,delete on all tables in schema public to service_role;
grant usage,select on all sequences in schema public to service_role;

insert into public.estoque_ppu(pn,quantidade,localizacao) values ('FIXTURE-PN',1,'A-1');
insert into public.ppu_localizacoes_config(localizacao_normalizada,localizacao_exibicao) values ('A-1','A-1'),('Z','Z');
insert into public.recebimentos values(1,'FIXTURE-1',true,'2025-01-01');
insert into public.recebimento_itens(id,recebimento_id,pn,quantidade,localizacao_ppu) values(1,1,'FIXTURE-PN',4,'HANGAR');
insert into public.import_logs(id,tipo_arquivo,nome_arquivo,detalhes,uploaded_by_email)
select ('00000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,'inventario_ppu','fixture-'||n||'.ods',
jsonb_build_object('arquivo',jsonb_build_object('sha256',repeat(c,64))),'fixture@example.invalid'
from (values(1,'a'),(2,'a'),(3,'b'),(4,'c'),(5,'d'),(6,'e'),(7,'f')) t(n,c);
