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
| ferramentas-custo | amb | /sku-depara-manual, /custos-manuais | **medida, NÃO migrar ainda** (06/10, corrigida após revisão — minha 1ª medição estava errada em dois pontos). A peça **JÁ TEM** o link `✏️ custos manuais` para `/custos-manuais`, cuja tela salva e apaga custo — eu tinha escrito que ela só tinha o de-para. ⚠️ **Falta mesmo:** (1) a **sugestão de de-para** (`?sugerir=<sku>` prefixa o melhor candidato e lista os demais) — sem ela o dono digita o SKU novo à mão; (2) o **resumo de custo acima da tabela**: custo atual do Bling, custo manual e o **custo que vale hoje**, os três separados — some justamente quando o histórico é curto, que é quando mais se olha; (3) o **card "vendeu sem custo"**, que lista sozinho os SKUs que venderam sem custo com unidades, pedidos e receita — é o que diz ONDE agir. ⚠️ **Na migração:** injetar DEPOIS do `montar()` (o `#app` nasce por `innerHTML`); `<script src>` estático roda antes do espaço existir e a seção some calada. |
| ferramentas-custo | girassol | /sku-depara-manual, /custos-manuais | **medida, NÃO migrar ainda** (06/10, corrigida após revisão — minha 1ª medição estava errada em dois pontos). A peça **JÁ TEM** o link `✏️ custos manuais` para `/custos-manuais`, cuja tela salva e apaga custo — eu tinha escrito que ela só tinha o de-para. ⚠️ **Falta mesmo:** (1) a **sugestão de de-para** (`?sugerir=<sku>` prefixa o melhor candidato e lista os demais) — sem ela o dono digita o SKU novo à mão; (2) o **resumo de custo acima da tabela**: custo atual do Bling, custo manual e o **custo que vale hoje**, os três separados — some justamente quando o histórico é curto, que é quando mais se olha; (3) o **card "vendeu sem custo"**, que lista sozinho os SKUs que venderam sem custo com unidades, pedidos e receita — é o que diz ONDE agir. ⚠️ **Na migração:** injetar DEPOIS do `montar()` (o `#app` nasce por `innerHTML`); `<script src>` estático roda antes do espaço existir e a seção some calada. |
| ficha-produto | amb | /custo-historico | **SEM TELA EMBUTIDA — nada a conferir** (09/10). Medido: a ficha de produto existe **só na GOOD**, e já pela peça (`dashboard.html` carrega `/js/ficha-produto.js`). AMB e Girassol **não têm** nada equivalente embutido, então aqui não há risco de entregar menos: ligar a peça nelas é GANHO, não migração. ⚠️ **Na hora de ligar:** injetar depois do `montar()` — o `#app` dessas duas nasce por `innerHTML`, e `<script src>` estático roda antes do espaço existir (a GOOD usa `<script src>` porque a tela dela é servida pronta, não montada por JS). |
| ficha-produto | girassol | /custo-historico | **SEM TELA EMBUTIDA — nada a conferir** (09/10). Medido: a ficha de produto existe **só na GOOD**, e já pela peça (`dashboard.html` carrega `/js/ficha-produto.js`). AMB e Girassol **não têm** nada equivalente embutido, então aqui não há risco de entregar menos: ligar a peça nelas é GANHO, não migração. ⚠️ **Na hora de ligar:** injetar depois do `montar()` — o `#app` dessas duas nasce por `innerHTML`, e `<script src>` estático roda antes do espaço existir (a GOOD usa `<script src>` porque a tela dela é servida pronta, não montada por JS). |
| manutencao | amb | /custo-sync, /reaplicar-status | **não conferida** — listar o que a embutida faz ANTES de trocar |
| manutencao | girassol | /custo-sync, /reaplicar-status | **não conferida** — listar o que a embutida faz ANTES de trocar |
| ml-financeiro | amb | /ml-billing-resumo, /ml-fatura-cartao | **não conferida** — listar o que a embutida faz ANTES de trocar |
| ml-financeiro | girassol | /ml-billing-resumo, /ml-fatura-cartao | **não conferida** — listar o que a embutida faz ANTES de trocar |
| nf-local | amb | /backfill-nf | **não conferida** — listar o que a embutida faz ANTES de trocar |
| nf-local | girassol | /backfill-nf | **não conferida** — listar o que a embutida faz ANTES de trocar |
| plano-compra | amb | /plano-compra | **CONFERIDA · PRONTA** (06/10). A peça tem agora tudo que a embutida tem: **Foto** (`img`, `loading=lazy`), **Curva**, **Ritmo/dia** (`md` com 3 casas + seta de tendência), **Precisa**, o **aviso de ruptura** (vermelho quando acaba antes de a reposição chegar) e a **planilha de 14 colunas** (`.xls` SpreadsheetML, números como número) na mesma ordem e nomes de `baixarPlano()`; também o **horizonte + período de medição**, a **linha inteira em vermelho** na ruptura, o **recálculo ao mudar reposição/cobertura/segurança/curva**, o filtro **sem acento** e a **curva padrão da empresa** (A na AMB/Girassol, A+B na GOOD — a fábrica passa). ⚠️ Nesta tela a peça é INJETADA depois do `innerHTML` do `montar()` (`#planoCompraAqui` nasce lá; `<script src>` estático rodaria antes e a seção sumiria calada) — o teste `POS_MONTAR` agora cobre `plano-compra`. ⚠️ O CSS do celular não se aplica: `#tProd` é o Top Produtos; o plano desenha em `#tCompra`, sem regra de esconder coluna. |
| plano-compra | girassol | /plano-compra | **CONFERIDA · PRONTA** (06/10). A peça tem agora tudo que a embutida tem: **Foto** (`img`, `loading=lazy`), **Curva**, **Ritmo/dia** (`md` com 3 casas + seta de tendência), **Precisa**, o **aviso de ruptura** (vermelho quando acaba antes de a reposição chegar) e a **planilha de 14 colunas** (`.xls` SpreadsheetML, números como número) na mesma ordem e nomes de `baixarPlano()`; também o **horizonte + período de medição**, a **linha inteira em vermelho** na ruptura, o **recálculo ao mudar reposição/cobertura/segurança/curva**, o filtro **sem acento** e a **curva padrão da empresa** (A na AMB/Girassol, A+B na GOOD — a fábrica passa). ⚠️ Nesta tela a peça é INJETADA depois do `innerHTML` do `montar()` (`#planoCompraAqui` nasce lá; `<script src>` estático rodaria antes e a seção sumiria calada) — o teste `POS_MONTAR` agora cobre `plano-compra`. ⚠️ O CSS do celular não se aplica: `#tProd` é o Top Produtos; o plano desenha em `#tCompra`, sem regra de esconder coluna. |
| previsao-vendas | amb | /previsao-vendas | **CONFERIDA · PRONTA** (05/10). A peça tem os 8 recursos da embutida, o detalhe por linha (media_dia, un30 × un_30_60), a planilha em `.xls` (SpreadsheetML) e o CSS do celular mirando `#pvTab` com as mesmas colunas. Base padrão 180 para a AMB. ⚠️ Nesta tela a peça é INJETADA depois do `innerHTML` do `montar()` — `<script src>` estático rodaria antes do espaço existir e a seção sumiria calada. |
| previsao-vendas | girassol | /previsao-vendas | **CONFERIDA · PRONTA** (05/10), junto com a AMB — mesma tela embutida, mesmos recursos. Trocada. ⚠️ Peça INJETADA depois do `innerHTML` do `montar()`, como na AMB. |
| projecao-mes | amb | /historico-longo | **medida, NÃO migrar** (09/10). ⚠️ São COISAS DIFERENTES com o mesmo nome: a peça mostra um **resumo do mês** (como o mês deve fechar pelo ritmo até agora, com botão de atualizar); a embutida da AMB/Girassol é uma **tabela POR SKU**, com linha por produto (unidades vendidas, faturamento, margem, dias restantes) e **ordenação clicando na coluna**. Trocar uma pela outra tiraria o detalhe por produto — que é o que responde "o que puxar esta semana". **Antes de migrar:** a peça precisa da tabela por SKU e da ordenação, ou as duas seções convivem (resumo em cima, tabela embaixo), que é o desenho mais provável. |
| projecao-mes | girassol | /historico-longo | **medida, NÃO migrar** (09/10). ⚠️ São COISAS DIFERENTES com o mesmo nome: a peça mostra um **resumo do mês** (como o mês deve fechar pelo ritmo até agora, com botão de atualizar); a embutida da AMB/Girassol é uma **tabela POR SKU**, com linha por produto (unidades vendidas, faturamento, margem, dias restantes) e **ordenação clicando na coluna**. Trocar uma pela outra tiraria o detalhe por produto — que é o que responde "o que puxar esta semana". **Antes de migrar:** a peça precisa da tabela por SKU e da ordenação, ou as duas seções convivem (resumo em cima, tabela embaixo), que é o desenho mais provável. |

Todas as peças que consomem rota de tela embutida têm linha aqui; peça nova que ganhar rota em
comum faz o teste falhar até ganhar a sua.
