# Situações do Bling, por empresa — ids que o dono já passou

**Por que este arquivo existe.** Em 06/10 eu precisei do id de "Em digitação" pra resgatar o
pedido 5477 e disse que não tinha. O dono respondeu: *"olha na memoria. eu ja passei id transição
antes d todas empresas"* — e tinha passado mesmo, em conversas de junho e julho. Perder isso custa
uma ida e volta cada vez. Fica aqui.

## AMBTotal

| situação | id |
|---|---|
| AGUARDANDO | 745122 |
| AGUARDANDO ETIQUETA | 766530 |
| Atendido | 9 |
| Cancelado | 12 |
| Checkout parcial | 126724 |
| DESPACHADOS | 745123 |
| Em aberto | 6 |
| Em andamento | 15 |
| Em devolução | 745619 |
| **Em digitação** | **21** |
| Pagamento aprovado | 745618 |
| Venda Agenciada | 18 |
| Verificado | 24 |

✅ **Divergência resolvida.** Eu tinha registrado que uma lista da AMB (21/07) não trazia "Em
digitação" nem "Verificado". Era lista parcial, digitada na hora: o print de 21/08 confirma os
padrão completos (6, 9, 12, 15, 18, 21, 24) junto dos criados. Os dois existem na AMB.

## GOOD Import

| situação | id |
|---|---|
| AGUARDANDO | 353459 |
| Atendido | 9 |
| Cancelado | 12 |
| Checkout parcial | 126724 |
| DESPACHADOS | 749990 |
| Em aberto | 6 |
| Em andamento | 15 |
| **Em digitação** | **21** |
| Venda Agenciada | 18 |
| Verificado | 24 |

⚠️ O dono copiou `74990` (5 dígitos) da tela, mas os pedidos reais mostram `749990` (6). Vale o
que aparece nos pedidos.

## Magazine Girassol

| situação | id |
|---|---|
| AGUARDANDO | 7259 |
| Atendido | 9 |
| Cancelado | 12 |
| DESPACHADOS | 743515 |
| Em aberto | 6 |
| Em andamento | 15 |
| **Em digitação** | **21** |
| Venda Agenciada | 18 |
| Verificado | 24 |

## A regra que organiza tudo isto

Os ids **baixos** (6, 9, 12, 15, 18, 21, 24) são os **padrão do Bling** e repetem nas TRÊS contas.
Os **altos** são situações que o dono **criou**, e são diferentes em cada empresa:

| situação | GOOD | Girassol | AMB |
|---|---|---|---|
| AGUARDANDO | 353459 | 7259 | 745122 |
| DESPACHADOS | 749990 | 743515 | 745123 |

Por isso **"Em digitação" é 21 nas três** — é padrão. E por isso AGUARDANDO e DESPACHADOS **nunca**
podem ser cravados no código: já provaram ser diferentes em cada conta.

A AMB tem situações que as outras não têm: **Em devolução** (745619), **Pagamento aprovado**
(745618) e **Aguardando etiqueta** (766530).

## Transições: o que o Bling aceita

O Bling tem um **Gerenciador de Transições** por conta, e ele RECUSA salto que não esteja
declarado. Caso real, pedido 5477 da AMBTotal:

```
DESPACHADOS - Atendido: Não há transições definidas para esta entidade   (HTTP 400)
```

O caminho de **ida** do checkout é `ATENDIDO → VERIFICADO → DESPACHADOS`. A **volta** não é o
inverso automático: o dono indicou que o degrau é **Em digitação**.

Por isso o resgate do pedido em limbo tenta, nesta ordem, até o Bling aceitar:

1. direto para ATENDIDO (funciona pra quem está em VERIFICADO);
2. os ids que a conta declarar em `<PREFIXO>_SIT_DEGRAUS` (lista separada por vírgula) — o que o
   administrador configurou vence o palpite; senão um degrau padrão que aceita a ida mas não a
   volta tiraria o pedido de DESPACHADOS antes do caminho configurado rodar;
3. **Em digitação (21)** → ATENDIDO;
4. o VERIFICADO da empresa → ATENDIDO.

O mesmo caminho vale pro pedido que ainda está no histórico, e um pedido parado num degrau
(configurado, 21 ou VERIFICADO) pode ser resgatado de novo.

Se nenhum servir, a resposta diz **quais tentou** e ensina a declarar o id certo — em vez de
dizer só "o Bling não aceitou".
