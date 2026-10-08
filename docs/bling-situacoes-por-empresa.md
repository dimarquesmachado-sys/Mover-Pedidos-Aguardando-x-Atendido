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

⚠️ **Divergência registrada, não resolvida.** O dono mandou a lista da AMB duas vezes, e na
segunda (21/07) **não apareciam** "Em digitação" nem "Verificado". Na primeira (27/06) os dois
estavam. Não sei qual é a atual — pode ter sido lista digitada de cabeça, ou situação criada/
removida no meio. **Por isso o resgate TENTA os degraus em sequência em vez de confiar num id:**
se o 21 não existir na conta, o Bling recusa e ele passa pro próximo.

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
| DESPACHADOS | 743515 |
| Verificado | 24 |

Os ids padrão do Bling (6, 9, 12, 15, 18, 21, 24) valem nas três contas; o que muda são as
situações **criadas** por empresa (AGUARDANDO, DESPACHADOS, Checkout parcial…).

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
2. **Em digitação (21)** → ATENDIDO;
3. o VERIFICADO da empresa → ATENDIDO;
4. os ids que a conta declarar em `<PREFIXO>_SIT_DEGRAUS` (lista separada por vírgula).

Se nenhum servir, a resposta diz **quais tentou** e ensina a declarar o id certo — em vez de
dizer só "o Bling não aceitou".
