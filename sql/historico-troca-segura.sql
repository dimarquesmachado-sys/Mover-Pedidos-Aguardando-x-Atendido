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

create or replace function public.trocar_periodo_historico(
  p_empresa text, p_de date, p_ate date, p_lote text, p_esperadas integer
) returns json
language plpgsql
set search_path = public
as $$
declare
  v_rasc integer; v_outra integer; v_apagadas integer; v_inseridas integer;
begin
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

  insert into vendas_historico (empresa, numero_pedido, numero_loja, canal, data_venda, sku, descricao,
    quantidade, valor_produto, valor_nota, custo, comissao, frete_vendedor, imposto, margem,
    atualizado_em, credito_ml, uf)
  select empresa, numero_pedido, numero_loja, canal, data_venda, sku, descricao,
    quantidade, valor_produto, valor_nota, custo, comissao, frete_vendedor, imposto, margem,
    atualizado_em, credito_ml, uf
  from vendas_historico_rascunho where lote = p_lote;
  get diagnostics v_inseridas = row_count;

  delete from vendas_historico_rascunho where lote = p_lote;

  return json_build_object('ok', true, 'apagadas', v_apagadas, 'inseridas', v_inseridas);
end;
$$;

-- o PostgREST (a API do Supabase) passa a enxergar a tabela e a funcao novas
notify pgrst, 'reload schema';

-- conferencia: as duas linhas abaixo devem aparecer
select 'tabela' as o_que, to_regclass('public.vendas_historico_rascunho')::text as existe
union all
select 'funcao', to_regprocedure('public.trocar_periodo_historico(text,date,date,text,integer)')::text;
