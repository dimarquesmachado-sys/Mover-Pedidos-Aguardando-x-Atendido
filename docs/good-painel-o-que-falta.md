# Painel da GOOD — o que está pronto, o que falta e por quê

Medido em 05/10/2026, rodando as rotas, não lendo o código.

## O que já abre (9 seções; 6 provadas por teste)

São nove seções. Seis vêm em peça compartilhada — plano de compra, ferramentas de custo,
devoluções do ML, manutenção do histórico, financeiro do ML e ficha do produto — e **só essas
seis** são cobertas pelo `teste-painel-good-ponta-a-ponta.js` (ele descobre os
`/good-checkout-offline/js/...` na tela e imprime `OK: as 6 secoes`). As três nativas **não têm
asserção** nesse teste: uma delas pode sumir sem ele ficar vermelho. O teste exige que cada uma
das seis seja servida, compile e tenha espaço na
tela, nas três pontas que já quebraram ao longo do trabalho (script na tela, liberação na guarda,
fábrica servindo).

## O que falta, e a causa é UMA só

A GOOD **não grava `_vendas_dia.json`**. A AMB e a Girassol gravam; é esse arquivo que alimenta a
varredura de cancelados, o canário de marketplaces e as telas que cruzam venda do dia com o Bling.

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

Elas já funcionam quando as coletas próprias rodaram, e só respondem "indisponível" quando esses
caches faltam — remédio diferente (rodar as coletas), não o porte. Por isso a causa única vale
para a venda do dia, não para essas duas rotas.

## Medido depois: as duas cópias NÃO divergiram no cálculo

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

`vendasSync` tem **520 linhas na AMB e 529 na Girassol**, e as duas DIVERGIRAM: 45% de semelhança
no texto. Olhando a lógica, porém, são **93 chamadas em comum** e pouca diferença real — o grosso
da divergência é comentário acumulado. A AMB tem tratamento de bipagem e histórico que a Girassol
não tem; a Girassol tem conserto de registro obsoleto que a AMB não tem.

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
- **não é divisível por canal**: o corpo não separa ML/Shopee/Magalu/TikTok em blocos.

Virar peça compartilhada é **refatoração**, não porte. E a prova de equivalência exigiria rodar
contra o Bling nas duas lojas, que é cota da conta.

**Por isso não há PR de peça.** Escrever 400 linhas que não dá pra provar aqui seria entregar
risco disfarçado de progresso.

### A sequência que tira o risco por partes

1. **sem cota:** envolver os pontos de acoplamento num `ctx` explícito, ainda DENTRO do módulo da
   AMB — não muda comportamento e deixa a função pronta pra sair;
2. **sem cota:** repetir na Girassol e comparar os dois `ctx`. Se baterem, a assinatura da peça foi
   encontrada pelos FATOS, não por chute;
3. **com janela, fora do galpão:** extrair pra `/lib`, rodar nas duas lojas e comparar o
   `_vendas_dia.json` gerado com o atual, campo a campo;
4. só então ligar na GOOD.

## O caminho mais barato até lá

Antes do porte, a reconciliação das duas cópias vale por si: hoje AMB e Girassol podem estar
contando a venda do dia de formas diferentes, e ninguém mediu o efeito disso nos números que o
dono usa pra decidir preço. Essa medição não gasta cota e responde uma pergunta que já existe.
