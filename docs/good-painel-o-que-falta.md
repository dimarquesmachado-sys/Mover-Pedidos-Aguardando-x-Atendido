# Painel da GOOD — o que está pronto, o que falta e por quê

Medido em 05/10/2026, rodando as rotas, não lendo o código.

## Migrar a AMB pra peça: medido o que falta em CADA peça (05/10)

Tentei migrar a previsão da AMB pra peça compartilhada. **Parei duas vezes, nas duas por medição**
— e isso é o aprendizado que vale pro resto da migração:

1. **colunas:** a AMB mostra 8 (`p180` e `p365` inclusive), a peça mostrava 6. Trocar tiraria
   informação de compra de longo prazo. **Já corrigido** — a peça tem as 8;
2. **funções que a tela embutida tem e a peça não:**
   - busca dentro da lista (`qPrev` na AMB), por SKU **e** por nome do produto;
   - **download de planilha** com 12 colunas (`baixarPrevisao`);
   - base padrão de **180 dias** (a peça nasceu com 90) e base **livre** de 15 a 730 dias
     (`prevDiasLivre`); a peça só oferece 5 valores fixos (30/60/90/180/365);
   - colunas de detalhe `media_dia`, `un30` e `un_30_60` (média por dia e tendência 30 vs 30
     anteriores), que a peça não exibe.

**Regra que sai disto, e vale pras outras 8 peças:** antes de trocar a tela embutida pela peça,
listar o que a embutida FAZ e conferir item a item. Uma migração que entrega menos é regressão com
nome de melhoria — e sai num PR chamado "unificar", que é onde ninguém procura regressão.

### O que falta na peça da previsão, pra fechar a migração da AMB

Medido em 05/10, tentando a troca de verdade e REVERTENDO quando a revisão mostrou perda. Três
itens, todos "entregar menos" se a troca seguisse:

- [x] **detalhe por linha**: a peça agora mostra `media_dia` ("4,5/dia") abaixo das unidades e
      `un30` vs `un_30_60` abaixo da tendência (só quando há base de 60 dias). Coberto no teste;
- [x] **planilha em `.xls`, não `.csv`**: a peça gera SpreadsheetML (números como número, colunas
      ajustadas, cabeçalho congelado), como o `baixarPlanilha()` da AMB. Texto vai como String, então
      "=CMD" não vira fórmula;
- [x] **CSS do celular**: os seletores de colunas secundárias na GOOD apontam para `#pvTab`. ⚠️ Na AMB
      eles continuam em `#tPrev` (a tela embutida ainda existe) — **quem migrar a AMB tem de
      reapontar para `#pvTab` no mesmo commit**;
- [ ] **carregar o script na AMB**: ⚠️ o apontamento do Codex (P1) de que o `<script src>` não estava
      na tela da AMB **procedia** no commit da troca — só a GOOD carrega `previsao-vendas.js`. E um
      `<script>` estático não serve: o painel da AMB nasce por `innerHTML` em `montar()`, então a
      peça rodaria antes de `#previsaoVendasAqui` existir e sairia sem fazer nada. Na migração, injetar
      por `document.createElement('script')` DEPOIS do innerHTML de `montar()`.

Os três primeiros ficaram prontos na peça; a troca da AMB só pode voltar com o quarto item.

## ⚠️ A GOOD não está atrás das outras — está NA FRENTE em arquitetura

Medido em 05/10, e isto inverte a leitura natural deste documento:

| | linhas de TELA | seções | em peça compartilhada |
|---|---|---|---|
| AMB | 4.258 | ~25 | **0** |
| Girassol | 4.192 | ~24 | **0** |
| **GOOD** | **1.182** | **12** | **9** |

A AMB e a Girassol têm TUDO embutido no próprio HTML: cada melhoria de painel precisa ser feita
duas vezes, e já divergiu na prática (a falha de página travava só a GOOD porque o conserto do PR
#132 nunca chegou lá — ver histórico).

A GOOD tem 9 das 12 seções em `/lib`, com a empresa como parâmetro. Hoje só o
`good-checkout-offline/dashboard.html` carrega essas nove peças; AMB e Girassol ainda usam as
implementações embutidas e não carregam nenhuma. Portanto a melhoria feita uma vez só passa a
servir AMB, Girassol e uma quarta empresa **depois** que cada uma migrar para as peças.

**Consequência para o plano:** o caminho não é "trazer o resto da AMB pra GOOD". É o contrário —
as seções da AMB e da Girassol é que deveriam migrar para peças, uma a uma, usando as da GOOD como
modelo. O que falta na GOOD (abaixo) é, em sua maior parte, dado que ela não coleta (`_vendas_dia.json`).
Há também tela que ela não tem e que não depende desse dado: as seções de devoluções do TikTok e
de cancelamentos do Magalu, que AMB/Girassol embutem no dashboard (a GOOD já tem as rotas
`/tiktok-custo-devolucoes` e `/magalu-cancelados`, que respondem quando as coletas próprias
existem). Elas entram no plano — ver passos 5 e 6 abaixo.

## O que já abre (12 seções; 9 provadas por teste)

Medido em 06/10 rodando o teste: são **NOVE peças compartilhadas**, não seis — entraram depois
`previsão de vendas`, `completar pedidos pela nota` e `como o mês deve fechar`. A lista completa:
plano de compra, ferramentas de custo, devoluções do ML, manutenção do histórico, financeiro do
ML, ficha do produto, previsão de vendas, completar pedidos pela nota e como o mês deve fechar.

Essas nove são cobertas pelo `teste-painel-good-ponta-a-ponta.js` (ele descobre os
`/good-checkout-offline/js/...` na tela e hoje imprime `OK: as 9 secoes`). Mais as três nativas
(Buscar Pedido e Lucro, Análise de Vendas e Alíquotas do Simples; o Top 15 produtos é um bloco
desenhado dentro de Análise de Vendas, não uma seção à parte), dão doze. As três nativas **não têm
asserção** nesse teste: uma delas pode sumir sem ele ficar vermelho. O teste exige que cada uma
das nove seja servida, compile e tenha espaço na
tela, nas três pontas que já quebraram ao longo do trabalho (script na tela, liberação na guarda,
fábrica servindo).

## O que falta: a venda do dia tem UMA causa (as demais rotas, não)

A GOOD **não grava `_vendas_dia.json`**. A AMB e a Girassol gravam; é esse arquivo que alimenta
`/status-mkt`, `/vendas-sync` e as telas que cruzam venda do dia com o Bling. (A varredura de
cancelados e o canário de marketplaces têm dependências próprias — ver mais abaixo.)

Medição que mostra o tamanho da diferença:

| | linhas | arquivos de cache | o que grava |
|---|---|---|---|
| AMB | 8.090 | 2 | `_custos.json`, `_vendas_dia.json` |
| Girassol | 6.472 | 2 | `_custos.json`, `_vendas_dia.json` |
| **GOOD** | 4.054 | **1** | `_custos.json` |

Quem alimenta o arquivo é a função `vendasSync`, que a GOOD não tem. Sem ela:

- `/status-mkt` varre **zero** pedidos e responderia "nenhum cancelamento" sempre — foi por isso
  que o PR #614 foi fechado: a seção daria uma falsa segurança, e número errado é pior que número
  ausente;
- `/vendas-sync` recusa com "esta empresa ainda não expõe `vendasSync`";

Só `/status-mkt` e `/vendas-sync` dependem diretamente do `_vendas_dia.json`. As outras duas rotas
têm **caches próprios e independentes**, que o porte do `vendasSync` NÃO popula:

- `/tiktok-custo-devolucoes` (via `responderCusto`) lê `_tiktok_devolucoes_good.json` e
  `_tiktok_financeiro_good.json`;
- `/magalu-cancelados` lê `/data/magalu/cancelados-good.json`.

Outras duas rotas também NÃO dependem só do `_vendas_dia.json`: `/canario-marketplaces` é
guardada por `conferirMarketplaces` e `/varrer-cancelados` por `varrerCancelados`, e a GOOD não
injeta nenhuma das duas em `good-checkout-offline/index.js`. Elas consultam Bling/marketplaces e
Supabase; portar o `vendasSync` não as liga — cada uma é um porte à parte, a medir separado.

As rotas de TikTok e Magalu acima já funcionam quando as coletas próprias rodaram, e só respondem "indisponível" quando esses
caches faltam — remédio diferente (rodar as coletas), não o porte. Por isso a causa única vale
para a venda do dia, não para essas duas rotas.

## Medido depois: a contagem é a mesma, mas a fase `ml_real` diverge

A primeira leitura deu 45% de semelhança e eu quase tratei o porte como uma reconciliação de
regras de negócio. Medindo de novo **sem os comentários**, que é o que importa:

- AMB: 368 linhas de código · Girassol: 372
- semelhança real: **87,4%**
- diferenças que tocam VALOR (valor, total, frete, taxa, comissão, líquido): **3 linhas**, e as
  três são o caminho do gerenciador de token do ML (`../ambtotal/mlTokenManager`) — detalhe de
  qual empresa, não de como se conta.

**Conclusão: a contagem da venda do dia é a mesma nas duas** — mas a medição por palavra-chave
não pega a fase `ml_real` do crédito do ML, que difere (ver abaixo). O que parecia decisão de
negócio era em boa parte comentário acumulado; o resto é essa fase, que precisa ser reconciliada.

## Por que ainda não é um porte de uma tacada

`vendasSync` tem **520 linhas na AMB e 529 na Girassol**. O texto bruto tem só 45% de semelhança,
mas sem comentários são 87,4% (93 chamadas em comum). A AMB tem tratamento de bipagem e histórico
que a Girassol não tem; a Girassol tem conserto de registro obsoleto que a AMB não tem — e a fase
`ml_real` difere (abaixo).

Portar exige, nesta ordem:

1. nascer como **peça única em `/lib`** com a empresa como parâmetro, senão a quarta empresa herda
   a mesma dívida. O token do ML entra como parâmetro (são as 3 únicas linhas que diferem pelas
   palavras medidas), mas ⚠️ essa medição NÃO enxerga a fase `ml_real`, que difere de verdade e
   mexe em `credito_ml` (campo financeiro lido pelo histórico/margem) — a peça tem que
   reconciliar isso, não só parametrizar o token:
   - Girassol reprocessa enquanto `ml_real < ML_REAL_V`, apaga `credito_ml`/`credito_fonte`
     obsoletos quando a resposta vem sem crédito, e só avança o marcador se custos **e** envio
     deram certo;
   - AMB filtra por `!ml_real`, nunca limpa crédito obsoleto ali e sempre grava `ml_real = 1`;
2. provar contra as DUAS cópias atuais antes de trocar qualquer uma: a peça tem que devolver o
   mesmo que a AMB devolve hoje e o mesmo que a Girassol devolve hoje;
3. rodar **fora do horário do galpão**: `vendasSync` consulta o Bling e a cota é da conta — com o
   galpão operando, a bipagem da Expedição perde primeiro.

## Medido o tamanho real da extração (05/10, antes de tentar)

Fui escrever a peça — escrever não gasta cota, só rodar gasta. Medi o acoplamento primeiro, e o
número mudou a decisão:

- **368 linhas de código** (sem comentários);
- **236 identificadores vindos do escopo do módulo**: envs da AMB (`AMBBKP_SHOPEE_SYNC_*`,
  `AMBBKP_MAGALU_EMPRESA`), caches (`CACHE_DIR`, `TIKTOK_CACHE_DIR`, `CONFERIDOS_FILE`),
  auxiliares (`blingGet`, `buscarDevolucoesML`, `_faseDireta`, `_inferCanal`) e dezenas de campos
  de resposta de marketplace;
- **tem fases por canal, mas com contexto compartilhado**: o corpo já se divide em `ml_real`,
  devoluções do ML, Shopee, Magalu e TikTok, e a ingestão direta de ML/Shopee/Magalu já foi
  extraída em `lib/checkout/fase-direta.js` (usada pela AMB). Dá pra extrair por fase, em
  incrementos; o que falta é parametrizar o contexto de cache/envs que as fases dividem.

Virar peça compartilhada é **refatoração**, não porte. E a prova de equivalência exigiria rodar
contra o Bling nas duas lojas, que é cota da conta.

**Por isso não há PR de peça.** Escrever 400 linhas que não dá pra provar aqui seria entregar
risco disfarçado de progresso.

### A sequência que tira o risco por partes

1. **sem cota:** envolver os pontos de acoplamento num `ctx` explícito, ainda DENTRO do módulo da
   AMB — não muda comportamento e deixa a função pronta pra sair;
2. **sem cota:** repetir na Girassol e comparar os dois `ctx`. Se baterem, a assinatura da peça foi
   encontrada pelos FATOS, não por chute;
3. **com janela, fora do galpão:** extrair pra `/lib` (fase a fase, começando pelas que já têm
   fronteira) e comparar com o atual **de forma determinística**: reexecutar as DUAS
   implementações sobre as MESMAS respostas de API capturadas, com relógio fixo — ou normalizar
   `atualizado_em` e demais campos voláteis. Rodar cada uma ao vivo e comparar arquivos não
   serve: o relógio e os marketplaces mudam entre as execuções;
4. ligar `vendasSync` na GOOD (destrava `/status-mkt` e `/vendas-sync`);
5. **front:** o `dashboard.html` da GOOD não tem chamadas nem controles para `/status-mkt`,
   `/vendas-sync`, `/magalu-cancelados` nem `/tiktok-custo-devolucoes` (AMB e Girassol têm), e as
   peças compartilhadas não os suprem. Portar a tela e cobrir no teste ponta a ponta, senão o
   backend fica pronto e o painel continua sem mostrar nada;
6. separadamente: `conferirMarketplaces` e `varrerCancelados`, e rodar as coletas de Magalu e
   TikTok.

## O caminho mais barato até lá

Antes do porte, a reconciliação das duas cópias vale por si: hoje AMB e Girassol podem estar
contando a venda do dia de formas diferentes, e ninguém mediu o efeito disso nos números que o
dono usa pra decidir preço. Essa medição não gasta cota e responde uma pergunta que já existe.
