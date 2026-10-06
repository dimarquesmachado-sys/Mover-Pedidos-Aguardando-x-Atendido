# Paridade das peças do painel × telas embutidas

**Por que este arquivo existe.** Em 05/10 migrei a previsão da AMB para a peça compartilhada
DEPOIS de conferir paridade item a item — e ainda assim passaram **três perdas**: o detalhe por
linha (`media_dia`, `un30` × `un_30_60`), a planilha que virou `.csv` em vez do `.xls` que a
embutida gera, e o CSS do celular, que esconde colunas secundárias apontando para o id da tabela
antiga.

Minha conferência olhou recursos de alto nível — "tem busca? tem planilha?" — e não os detalhes de
cada linha, nem o FORMATO do arquivo, nem o CSS. **Paridade é "o que o dono vê e faz continua
igual?", não "a função existe?".**

A regra do dono, dita no mesmo dia:

> não tem q diminuir a AMB não. Vendo ela, ou qqer outra, se ver q tem mais funções, tem mais
> recursos, ela q tem que ser espelho pras outras

**Migração que entrega menos é regressão com nome de melhoria** — e sai num PR chamado "unificar",
que é onde ninguém procura regressão.

## Como usar

O teste `teste-peca-nao-entrega-menos.js` descobre sozinho todo par peça×empresa em que a tela
embutida consome a MESMA rota da peça, e falha se:

1. o par não estiver nesta tabela; ou
2. a empresa já incluir o `<script>` da peça sem a linha dizer **conferida**.

Antes de marcar uma linha como conferida, olhar **nesta ordem** — foi nesta ordem que as três
perdas escaparam:

1. **colunas e campos por linha** — inclusive os detalhes pequenos sob o valor principal;
2. **formato dos arquivos gerados** — `.xls` ≠ `.csv`: muda separador decimal e formatação no Excel;
3. **CSS que depende de id** — a folha de estilo da tela esconde colunas no celular apontando para
   o id da tabela ANTIGA; a peça desenha em outro id;
4. **atalhos e controles** — e conferir se não são duplicata (os "chips" da AMB oferecem as mesmas
   opções do seletor e são escondidos no celular: não são recurso a copiar);
5. **padrões por empresa** — base de cálculo, janelas, ordenação. Nivelar por cima vale pra
   RECURSO, não pra apagar uma escolha que a loja já fazia (a base da GOOD foi de 90 pra 180 em
   silêncio assim).

## Pares medidos

| peça | empresa | rota em comum | conferência |
|---|---|---|---|
| devolucoes-ml | amb | /ml-devolucoes | **não conferida** — listar o que a embutida faz ANTES de trocar |
| devolucoes-ml | girassol | /ml-devolucoes | **não conferida** — listar o que a embutida faz ANTES de trocar |
| ml-financeiro | amb | /ml-billing-resumo, /ml-fatura-cartao | **não conferida** — listar o que a embutida faz ANTES de trocar |
| ml-financeiro | girassol | /ml-billing-resumo, /ml-fatura-cartao | **não conferida** — listar o que a embutida faz ANTES de trocar |
| nf-local | amb | /backfill-nf | **não conferida** — listar o que a embutida faz ANTES de trocar |
| nf-local | girassol | /backfill-nf | **não conferida** — listar o que a embutida faz ANTES de trocar |
| plano-compra | amb | /plano-compra | **não conferida** — listar o que a embutida faz ANTES de trocar |
| plano-compra | girassol | /plano-compra | **não conferida** — listar o que a embutida faz ANTES de trocar |
| previsao-vendas | amb | /previsao-vendas | CONFERIDA item a item em 05/10 (8 recursos). A peça já tem busca, planilha 12 colunas, base livre 15-730, media_dia/un30/un_30_60, recalcular e colunas 6m/1ano. **Falta** antes de trocar: planilha em `.xls` (a embutida usa `baixarPlanilha()`, SpreadsheetML) e o CSS do celular, que esconde colunas por `#tPrev` e precisa mirar `#pvTab` |
| previsao-vendas | girassol | /previsao-vendas | CONFERIDA item a item em 05/10 (8 recursos). A peça já tem busca, planilha 12 colunas, base livre 15-730, media_dia/un30/un_30_60, recalcular e colunas 6m/1ano. **Falta** antes de trocar: planilha em `.xls` (a embutida usa `baixarPlanilha()`, SpreadsheetML) e o CSS do celular, que esconde colunas por `#tPrev` e precisa mirar `#pvTab` |
| projecao-mes | amb | /historico-longo | **não conferida** — listar o que a embutida faz ANTES de trocar |
| projecao-mes | girassol | /historico-longo | **não conferida** — listar o que a embutida faz ANTES de trocar |

Peças sem linha aqui (`ferramentas-custo`, `ficha-produto`, `manutencao`) não têm equivalente
embutido consumindo a mesma rota: nasceram na GOOD e não há tela antiga pra perder recurso.
