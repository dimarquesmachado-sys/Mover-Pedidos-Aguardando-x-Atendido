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

create or replace function public.trocar_periodo_historico(
  p_empresa text, p_de date, p_ate date, p_lote text, p_esperadas integer
) returns json
language plpgsql
set search_path = public
as $$
declare
  v_rasc integer; v_outra integer; v_apagadas integer; v_inseridas integer;
  v_cols text; v_col text; v_perde integer;
begin
  -- Codex #694: a troca segura uma TRAVA pelo lote enquanto roda — o backfill pergunta (troca_historico_status)
  -- se ela ainda esta em andamento quando a resposta se perde, em vez de adivinhar pelo tempo
  perform pg_advisory_xact_lock(hashtext('vh_troca:' || p_lote));
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
  select string_agg(quote_ident(c.column_name), ', ' order by c.ordinal_position) into v_cols
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
  execute format('insert into public.vendas_historico (%s) select %s from public.vendas_historico_rascunho where lote = $1', v_cols, v_cols)
    using p_lote;
  get diagnostics v_inseridas = row_count;

  delete from vendas_historico_rascunho where lote = p_lote;

  return json_build_object('ok', true, 'apagadas', v_apagadas, 'inseridas', v_inseridas);
end;
$$;

-- Codex #694: a resposta da troca se perdeu — ela ainda esta rodando? Pega a MESMA trava sem esperar:
-- conseguiu = a troca nao esta em andamento (ja terminou ou nunca comecou); ai o rascunho diz o resto:
-- 0 linhas = a troca CONFIRMOU; ainda la = a troca NAO aconteceu (o historico nao foi tocado).
create or replace function public.troca_historico_status(p_lote text) returns json
language plpgsql
set search_path = public
as $$
declare v_livre boolean; v_resto integer;
begin
  v_livre := pg_try_advisory_xact_lock(hashtext('vh_troca:' || p_lote));
  select count(*) into v_resto from vendas_historico_rascunho where lote = p_lote;
  return json_build_object('rodando', not v_livre, 'rascunho', v_resto);
end;
$$;
revoke execute on function public.troca_historico_status(text) from public, anon, authenticated;
grant execute on function public.troca_historico_status(text) to service_role;

-- so o servico chama a troca
revoke execute on function public.trocar_periodo_historico(text, date, date, text, integer) from public, anon, authenticated;
grant execute on function public.trocar_periodo_historico(text, date, date, text, integer) to service_role;

-- o PostgREST (a API do Supabase) passa a enxergar a tabela e a funcao novas
notify pgrst, 'reload schema';

-- conferencia: as duas linhas abaixo devem aparecer
select 'tabela' as o_que, to_regclass('public.vendas_historico_rascunho')::text as existe
union all
select 'funcao', to_regprocedure('public.trocar_periodo_historico(text,date,date,text,integer)')::text
union all
select 'status', to_regprocedure('public.troca_historico_status(text)')::text;
