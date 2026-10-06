# Painel da GOOD — o que está pronto, o que falta e por quê

Medido em 05/10/2026, rodando as rotas, não lendo o código.

## O que já abre (9 seções, provadas por teste)

As seis seções em peça compartilhada — plano de compra, ferramentas de custo, devoluções do ML,
manutenção do histórico, financeiro do ML e ficha do produto — mais as nativas. O
`teste-painel-good-ponta-a-ponta.js` exige que cada uma seja servida, compile e tenha espaço na
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
- `/magalu-cancelados` e `/tiktok-custo-devolucoes` respondem "indisponível" por falta do cache.

## Medido depois: as duas cópias NÃO divergiram no cálculo

A primeira leitura deu 45% de semelhança e eu quase tratei o porte como uma reconciliação de
regras de negócio. Medindo de novo **sem os comentários**, que é o que importa:

- AMB: 368 linhas de código · Girassol: 372
- semelhança real: **87,4%**
- diferenças que tocam VALOR (valor, total, frete, taxa, comissão, líquido): **3 linhas**, e as
  três são o caminho do gerenciador de token do ML (`../ambtotal/mlTokenManager`) — detalhe de
  qual empresa, não de como se conta.

**Conclusão: a lógica de contar a venda do dia é a mesma nas duas.** O que parecia decisão de
negócio era comentário acumulado. Isso tira o maior risco do porte: não há duas verdades pra
escolher.

## Por que ainda não é um porte de uma tacada

`vendasSync` tem **520 linhas na AMB e 529 na Girassol**, e as duas DIVERGIRAM: 45% de semelhança
no texto. Olhando a lógica, porém, são **93 chamadas em comum** e pouca diferença real — o grosso
da divergência é comentário acumulado. A AMB tem tratamento de bipagem e histórico que a Girassol
não tem; a Girassol tem conserto de registro obsoleto que a AMB não tem.

Portar exige, nesta ordem:

1. nascer como **peça única em `/lib`** com a empresa como parâmetro (o token do ML entra como
   parâmetro — são as 3 únicas linhas que diferem), senão a quarta empresa herda a mesma dívida;
2. provar contra as DUAS cópias atuais antes de trocar qualquer uma: a peça tem que devolver o
   mesmo que a AMB devolve hoje e o mesmo que a Girassol devolve hoje;
3. rodar **fora do horário do galpão**: `vendasSync` consulta o Bling e a cota é da conta — com o
   galpão operando, a bipagem da Expedição perde primeiro.

## O caminho mais barato até lá

Antes do porte, a reconciliação das duas cópias vale por si: hoje AMB e Girassol podem estar
contando a venda do dia de formas diferentes, e ninguém mediu o efeito disso nos números que o
dono usa pra decidir preço. Essa medição não gasta cota e responde uma pergunta que já existe.
