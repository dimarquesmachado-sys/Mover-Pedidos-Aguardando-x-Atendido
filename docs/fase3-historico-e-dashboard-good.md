# Fase 3 — o histórico, e o caminho para o dashboard da GOOD (14/09/2026)

## O achado

A **GOOD não tem histórico nenhum**. Só a AMB (`amb-historico.js`, 968 linhas) e a Girassol
(`historico.js`, 1.017 linhas) têm. É por isso que ela não tem dashboard de vendas — e o dono
citou "o dashboard da GOOD" como um dos objetivos da consolidação.

Ou seja: **unificar o histórico não é só tirar duplicação — é o que entrega o dashboard da
GOOD**, porque a peça que falta lá é exatamente a que está duplicada nas outras duas.

## Classificação

| | AMB | Girassol |
|---|---|---|
| rotas | `historico`, `historico-linhas`, `historico-longo`, `buscar-pedido`, `buscar-lucro`, `previsao-vendas` | **as mesmas seis** |
| funções de topo | 1 (`rotasHistorico`) | 1 (`rotasHistorico`) |
| linhas de código diferentes | — | **290** |

As seis rotas são as mesmas. A diferença está no corpo.

### A Girassol já está meio-caminho andado

O `historico.js` dela **já monta as rotas por prefixo parametrizado** (`R('historico')`) e
**já recebe um contexto** (`rotasHistorico(ctx)`), depois de um bug registrado no próprio
arquivo: uma versão anterior deixava outra empresa lendo `CACHE_DIR`, `CONFERIDOS_FILE`, o
admin (`GIRABKP_ADMIN`) e o cliente Bling **da Girassol** — custo, SKU, admin e pedidos da
empresa errada.

Esse desenho é o alvo. A AMB ainda usa caminho fixo.

## Estado (14/09)

- [x] **passos 1 e 2 feitos** (PR #436): o histórico virou `lib/checkout/historico.js`, com
      AMB e Girassol ligadas nele por fachada. A diferença real era de 17 e 39 linhas.
- [ ] **passo 3** — conferir, rota a rota, que os números não mudaram, contra as fotos de
      referência. **Este é o passo que não pode ser pulado.**
- [ ] **passo 4** — ligar a GOOD e entregar o dashboard dela.

## Caminho recomendado

1. **Ampliar o `ctx`** do histórico da Girassol para cobrir o que a AMB usa de diferente
   (é a parte das 290 linhas que é configuração, não regra).
2. **Mover para `lib/checkout/historico.js`** com prefixo e contexto por empresa — o desenho
   que a Girassol já tem.
3. **Ligar a AMB** e conferir, rota a rota, que os números não mudaram (há foto de referência
   em `docs/dashboard-baseline-d186.md` e `docs/baseline-refactor-linha-unica.md`).
4. **Ligar a GOOD** — e aí ela ganha o dashboard, que é o objetivo.

⚠️ O passo 3 é o que exige cuidado: histórico é número que o dono lê para decidir. A regra da
casa vale inteira aqui — **número errado é pior que número ausente**, então a conferência
contra a foto de referência não é opcional.
