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
2. a empresa já incluir o `<script>` da peça sem a linha estar **PRONTA**: conferida, sem nenhum
   "Falta" pendente e com a palavra `PRONTA` escrita. **CONFERIDA não basta** — conferir é achar o
   que falta; só PRONTA diz que foi consertado;
3. a peça de previsão entrar por `<script src>` estático (ver o item 3 da linha dela).

O inventário vale pela UNIÃO do que o teste acha nas telas (rotas chamadas por `MOD` ou `BASE`,
inclusive as declaradas em tabela, como `rota:` da manutenção) com as linhas desta tabela — assim o
par não some da checagem quando a migração tira a rota da tela embutida.

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
| ferramentas-custo | amb | /sku-depara-manual, /custos-manuais | **não conferida** — listar o que a embutida faz ANTES de trocar |
| ferramentas-custo | girassol | /sku-depara-manual, /custos-manuais | **não conferida** — listar o que a embutida faz ANTES de trocar |
| ficha-produto | amb | /custo-historico | **não conferida** — listar o que a embutida faz ANTES de trocar |
| ficha-produto | girassol | /custo-historico | **não conferida** — listar o que a embutida faz ANTES de trocar |
| manutencao | amb | /custo-sync, /reaplicar-status | **não conferida** — listar o que a embutida faz ANTES de trocar |
| manutencao | girassol | /custo-sync, /reaplicar-status | **não conferida** — listar o que a embutida faz ANTES de trocar |
| ml-financeiro | amb | /ml-billing-resumo, /ml-fatura-cartao | **não conferida** — listar o que a embutida faz ANTES de trocar |
| ml-financeiro | girassol | /ml-billing-resumo, /ml-fatura-cartao | **não conferida** — listar o que a embutida faz ANTES de trocar |
| nf-local | amb | /backfill-nf | **não conferida** — listar o que a embutida faz ANTES de trocar |
| nf-local | girassol | /backfill-nf | **não conferida** — listar o que a embutida faz ANTES de trocar |
| plano-compra | amb | /plano-compra | **não conferida** — listar o que a embutida faz ANTES de trocar |
| plano-compra | girassol | /plano-compra | **não conferida** — listar o que a embutida faz ANTES de trocar |
| previsao-vendas | amb | /previsao-vendas | CONFERIDA item a item em 05/10 (8 recursos). A peça já tem busca, planilha 12 colunas, base livre 15-730, media_dia/un30/un_30_60, recalcular e colunas 6m/1ano. **Falta** antes de trocar: (1) planilha em `.xls` (a embutida usa `baixarPlanilha()`, SpreadsheetML); (2) o CSS do celular, que esconde colunas por `#tPrev` e precisa mirar `#pvTab`; (3) carregar o script por `document.createElement("script")` DEPOIS do innerHTML do `montar()` — `#previsaoVendasAqui` só existe depois dele e a peça sai sem fazer nada se o alvo faltar (`<script src>` estático é barrado pelo teste). Só vira **PRONTA** quando os três estiverem feitos |
| previsao-vendas | girassol | /previsao-vendas | CONFERIDA item a item em 05/10 (8 recursos). A peça já tem busca, planilha 12 colunas, base livre 15-730, media_dia/un30/un_30_60, recalcular e colunas 6m/1ano. **Falta** antes de trocar: (1) planilha em `.xls` (a embutida usa `baixarPlanilha()`, SpreadsheetML); (2) o CSS do celular, que esconde colunas por `#tPrev` e precisa mirar `#pvTab`; (3) carregar o script por `document.createElement("script")` DEPOIS do innerHTML do `montar()` — `#previsaoVendasAqui` só existe depois dele e a peça sai sem fazer nada se o alvo faltar (`<script src>` estático é barrado pelo teste). Só vira **PRONTA** quando os três estiverem feitos |
| projecao-mes | amb | /historico-longo | **não conferida** — listar o que a embutida faz ANTES de trocar |
| projecao-mes | girassol | /historico-longo | **não conferida** — listar o que a embutida faz ANTES de trocar |

Todas as peças que consomem rota de tela embutida têm linha aqui; peça nova que ganhar rota em
comum faz o teste falhar até ganhar a sua.
