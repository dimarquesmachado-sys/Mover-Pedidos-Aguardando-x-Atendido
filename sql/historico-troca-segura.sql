-- =====================================================================================================
-- TROCA SEGURA DO PERIODO DO HISTORICO (14/10/2026 — parecer do Codex, item 6.3)
-- Rode UMA VEZ no SQL Editor de CADA projeto Supabase que guarda `vendas_historico` (se as 3 empresas
-- usam o mesmo projeto, uma vez so). Pode rodar de novo sem estragar nada (if not exists / or replace).
--
-- O backfill grava a versao nova do periodo no RASCUNHO e depois chama `trocar_periodo_historico`, que
-- numa transacao so: confere a quantidade, apaga o periodo antigo, copia o novo e limpa o rascunho.
-- Se qualquer passo falha, o Postgres desfaz tudo e o historico fica como estava — nunca pela metade.
-- =====================================================================================================

create table if not exists public.vendas_historico_rascunho (
  lote            text        not null,
  criado_em       timestamptz not null default now(),
  empresa         text        not null,
  numero_pedido   text,
  numero_loja     text,
  canal           text,
  data_venda      date,
  sku             text,
  descricao       text,
  quantidade      numeric,
  valor_produto   numeric,
  valor_nota      numeric,
  custo           numeric,
  comissao        numeric,
  frete_vendedor  numeric,
  imposto         numeric,
  margem          numeric,
  atualizado_em   timestamptz,
  credito_ml      numeric,
  uf              text
);
create index if not exists idx_vhr_lote      on public.vendas_historico_rascunho (lote);
create index if not exists idx_vhr_emp_criado on public.vendas_historico_rascunho (empresa, criado_em);

-- Codex #694: o rascunho guarda dado financeiro — so o servico (service_role) le e escreve. RLS ligado e sem
-- politica = a chave publica nao enxerga nada; o service_role passa por cima do RLS. Grants explicitos pra
-- projetos com a exposicao automatica desligada.
alter table public.vendas_historico_rascunho enable row level security;
revoke all on table public.vendas_historico_rascunho from anon, authenticated;
grant select, insert, delete on table public.vendas_historico_rascunho to service_role;

-- Codex #694: REGISTRO de cada troca confirmada, gravado na MESMA transacao da troca. E a prova de que ela
-- aconteceu (inclusive num periodo sem venda, em que o rascunho ja nasce vazio) — e o historico das trocas.
create table if not exists public.vendas_historico_trocas (
  lote       text        primary key,
  empresa    text        not null,
  de         date        not null,
  ate        date        not null,
  apagadas   integer,
  inseridas  integer,
  cancelada  boolean     not null default false,
  em         timestamptz not null default now()
);
-- (projeto que ja rodou a versao anterior do script)
alter table public.vendas_historico_trocas add column if not exists cancelada boolean not null default false;
alter table public.vendas_historico_trocas enable row level security;
revoke all on table public.vendas_historico_trocas from anon, authenticated;
grant select, insert on table public.vendas_historico_trocas to service_role;

create or replace function public.trocar_periodo_historico(
  p_empresa text, p_de date, p_ate date, p_lote text, p_esperadas integer
) returns json
language plpgsql
set search_path = public
as $$
declare
  v_rasc integer; v_outra integer; v_apagadas integer; v_inseridas integer;
  v_cols text; v_sel text; v_col text; v_perde integer;
begin
  -- Codex #694: a troca segura uma TRAVA pelo lote enquanto roda — o backfill pergunta (troca_historico_status)
  -- se ela ainda esta em andamento quando a resposta se perde, em vez de adivinhar pelo tempo
  perform pg_advisory_xact_lock(hashtext('vh_troca:' || p_lote));
  -- Codex #694: duas trocas da MESMA empresa (ex.: um refazer disparado enquanto a anterior ainda roda) entram em
  -- FILA — a segunda so comeca depois que a primeira confirmar, e ai apaga o que a primeira gravou. Sem isso, as
  -- duas apagariam o mesmo periodo e inseririam cada uma o seu rascunho: venda em dobro.
  perform pg_advisory_xact_lock(hashtext('vh_troca_empresa:' || p_empresa));
  select count(*) into v_rasc from vendas_historico_rascunho where lote = p_lote;
  if v_rasc <> p_esperadas then
    raise exception 'rascunho incompleto: % de % linha(s) — nada trocado', v_rasc, p_esperadas;
  end if;
  select count(*) into v_outra from vendas_historico_rascunho where lote = p_lote and empresa <> p_empresa;
  if v_outra > 0 then
    raise exception 'rascunho com % linha(s) de outra empresa — nada trocado', v_outra;
  end if;

  -- o MESMO filtro que o backfill usava no DELETE (empresa + periodo)
  delete from vendas_historico where empresa = p_empresa and data_venda >= p_de and data_venda <= p_ate;
  get diagnostics v_apagadas = row_count;

  -- Codex #694: as colunas vem do historico DESTE projeto (a tabela da Girassol nao tem credito_ml): copia so as
  -- que existem nos dois lados. Coluna do rascunho que o historico nao tem e que veio PREENCHIDA = dado que se
  -- perderia -> recusa a troca (nada muda).
  -- Coluna com VALOR PADRAO no historico (ex.: uma data de atualizacao = now()): o backfill antigo gravava a
  -- linha SEM ela e o banco preenchia; aqui a copia e explicita, entao vazio no rascunho = o padrao da coluna
  -- (coalesce), nunca um vazio que antes nao existia.
  select string_agg(quote_ident(c.column_name), ', ' order by c.ordinal_position),
         string_agg(case when c.column_default is not null
                         then format('coalesce(%I, %s)', c.column_name, c.column_default)
                         else quote_ident(c.column_name) end, ', ' order by c.ordinal_position)
    into v_cols, v_sel
  from information_schema.columns c
  where c.table_schema = 'public' and c.table_name = 'vendas_historico' and c.column_name <> 'id'
    and exists (select 1 from information_schema.columns r where r.table_schema = 'public'
                and r.table_name = 'vendas_historico_rascunho' and r.column_name = c.column_name);
  for v_col in
    select r.column_name from information_schema.columns r
    where r.table_schema = 'public' and r.table_name = 'vendas_historico_rascunho'
      and r.column_name not in ('lote', 'criado_em')
      and not exists (select 1 from information_schema.columns c where c.table_schema = 'public'
                      and c.table_name = 'vendas_historico' and c.column_name = r.column_name)
  loop
    execute format('select count(*) from public.vendas_historico_rascunho where lote = $1 and %I is not null', v_col)
      into v_perde using p_lote;
    if v_perde > 0 then
      raise exception 'a coluna % nao existe no historico deste projeto e veio preenchida em % linha(s) — nada trocado', v_col, v_perde;
    end if;
  end loop;
  execute format('insert into public.vendas_historico (%s) select %s from public.vendas_historico_rascunho where lote = $1', v_cols, v_sel)
    using p_lote;
  get diagnostics v_inseridas = row_count;

  delete from vendas_historico_rascunho where lote = p_lote;

  insert into vendas_historico_trocas (lote, empresa, de, ate, apagadas, inseridas)
    values (p_lote, p_empresa, p_de, p_ate, v_apagadas, v_inseridas);

  return json_build_object('ok', true, 'apagadas', v_apagadas, 'inseridas', v_inseridas);
end;
$$;

-- Codex #694: a resposta da troca se perdeu. RESOLVER, de forma definitiva e sem esperar:
--   'rodando'    a troca esta em andamento (segura a trava do lote) — pergunte de novo depois;
--   'confirmada' a troca confirmou (o registro dela existe);
--   'cancelada'  a troca nao aconteceu e AGORA NAO ACONTECE MAIS: grava o lote como cancelado no registro (a
--                troca atrasada, se chegar depois, bate na chave do registro e o banco desfaz tudo) e limpa o
--                rascunho. So entao o backfill pode dizer que o historico nao foi tocado.
drop function if exists public.troca_historico_status(text);
create or replace function public.resolver_troca_historico(p_lote text, p_empresa text, p_de date, p_ate date) returns json
language plpgsql
set search_path = public
as $$
begin
  if not pg_try_advisory_xact_lock(hashtext('vh_troca:' || p_lote)) then
    return json_build_object('resultado', 'rodando');
  end if;
  if exists (select 1 from vendas_historico_trocas where lote = p_lote and not cancelada) then
    return json_build_object('resultado', 'confirmada');
  end if;
  insert into vendas_historico_trocas (lote, empresa, de, ate, cancelada)
    values (p_lote, p_empresa, p_de, p_ate, true) on conflict (lote) do nothing;
  delete from vendas_historico_rascunho where lote = p_lote;
  return json_build_object('resultado', 'cancelada');
end;
$$;
revoke execute on function public.resolver_troca_historico(text, text, date, date) from public, anon, authenticated;
grant execute on function public.resolver_troca_historico(text, text, date, date) to service_role;

-- so o servico chama a troca
revoke execute on function public.trocar_periodo_historico(text, date, date, text, integer) from public, anon, authenticated;
grant execute on function public.trocar_periodo_historico(text, date, date, text, integer) to service_role;

-- o PostgREST (a API do Supabase) passa a enxergar a tabela e a funcao novas
notify pgrst, 'reload schema';

-- conferencia: as quatro linhas abaixo devem aparecer
select 'tabela' as o_que, to_regclass('public.vendas_historico_rascunho')::text as existe
union all
select 'registro', to_regclass('public.vendas_historico_trocas')::text
union all
select 'funcao', to_regprocedure('public.trocar_periodo_historico(text,date,date,text,integer)')::text
union all
select 'resolver', to_regprocedure('public.resolver_troca_historico(text,text,date,date)')::text;
