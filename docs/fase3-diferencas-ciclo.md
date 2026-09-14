# Fase 3 — o que cada checkout faz diferente no `ciclo.js` (medido em 14/09/2026)

## Por que este documento existe

O `ciclo.js` é a peça central do checkout e a **mais divergente** do repositório:

| empresa | linhas |
|---|---:|
| AMB | 1.227 |
| GOOD | 1.112 |
| Girassol | 747 |

Linhas de código diferentes, já normalizando o nome da empresa: **AMB × GOOD = 216**,
**AMB × Girassol = 493**. Extrair isso sem classificar seria apagar comportamento — e a
experiência de 13 e 14/09 mostrou que, nessa faixa de divergência, o que aparece são
**capacidades faltando**, não estilo.

## Classificação por função

*(revisado em 14/09 depois da revisão do Codex no PR #434 — a primeira versão desta tabela
subestimou o tamanho das diferenças; ver `git log -p` deste arquivo pra comparar)*

| função | AMB | GOOD | Girassol |
|---|:-:|:-:|:-:|
| `listarAtendidos` — filtro Full (esconde e classifica vendas Full na fila) | ✅ | ✅ | ❌ |
| `detalheParaReconciliacao` (404 = apagado no Bling → remove do cache) | ✅ | ✅ | ❌ *(falta real — ver item 1)* |
| `cachearPedido` — freio anti-martelo do fallback Shopee (1h após 3 falhas) | ✅ | ❌ | ❌ |
| `cachearPedido` — módulo de etiqueta Madeira Madeira | ❌ *(não vende nesse canal)* | ✅ | ✅ |
| `ESPERA_FULL_MS` (espera antes de tirar Full de ATENDIDO) | ✅ | ✅ | ❌ |
| `unsFullEfetivas` | ✅ | ❌ | ❌ |
| `rodarCiclo` — move Full → DESPACHADOS | ✅ | ✅ *(desligado por padrão, `SIT_DESPACHADOS` não configurado)* | ❌ |
| `indexarCatalogoCompleto`, `sincronizarConferidos`, `detalhePedido`, getters | iguais nas três (só o prefixo de log/env muda) | | |

## O que cada diferença é

### 1. `detalheParaReconciliacao` — **é falta, não equivalência**

A versão original deste documento classificou isso como "resolvido de outro jeito" na
Girassol, citando a marca `sumiu` do 404. O Codex apontou o engano e a leitura confirma: `sumiu`
existe só dentro de `sincronizarConferidos` (linhas 82-106), pra parar de re-tentar o MOVE de um
pedido já conferido — não tem nada a ver com a reconciliação do cache.

A reconciliação de verdade (linhas 480-493) faz outra coisa: consulta o Bling por candidato e só
aceita remover quando `rd.ok` vem true (`det = (rd && rd.ok && rd.data && rd.data.data) || null`).
Um 404 faz `rd.ok` dar false — cai no MESMO ramo de "não deu pra confirmar" (`naoConferidos++`) e
o pedido é **preservado**, igual a uma falha de rede ou um 429. A AMB e a GOOD, ao contrário,
tratam o 404 como confirmação positiva de exclusão (`detalheParaReconciliacao` devolve
`{naoExiste:true}` e o laço pula direto pra remoção — ver `amb-checkout-offline/ciclo.js:960`).

Efeito prático: um pedido apagado no Bling enquanto pendente na Girassol **nunca sai do cache**
por essa via — fica preso até a trava dos 40% falhar em outro lote, o que não é garantido. É
capacidade faltando, candidata a porte, não estilo.

### 2. `listarAtendidos` + `rodarCiclo` — **o filtro/move de Full inteiro falta na Girassol**

A tabela original só listava `ESPERA_FULL_MS` e `unsFullEfetivas` como diferença de Full — dando
a impressão de que era só uma "alavanca" fina faltando. Não é: a Girassol não tem NENHUMA parte
do subsistema de Full. Faltam, juntos:

- o **filtro** em `listarAtendidos` que esconde da fila do estoquista as vendas Full (~220
  linhas: leitura da unidade de negócio, checagem de série da NF, espera confirmada);
- o **move** em `rodarCiclo` que manda o Full confirmado pra `SIT_DESPACHADOS` depois que a
  Shopee/Magalu despacha (bloco `MOVE FULL → DESPACHADOS`, presente na AMB e — desligado por
  padrão — na GOOD).

`ESPERA_FULL_MS` e `unsFullEfetivas` são peças MENORES desse mesmo subsistema, não o subsistema
inteiro.

**Pergunta para o dono (mantida, agora com escopo certo):** a Girassol vende no Full? Se vender,
falta esse bloco inteiro — não um parâmetro. Se não vender, a ausência é esperada e não deve
disfarçar de "igual nas três" no próximo levantamento.

### 3. `unsFullEfetivas` — **só na AMB, provavelmente específico**

Trata as unidades de negócio do Full. A AMB é a empresa com operação Full mais ampla; pode
ser especialização legítima. Precisa de leitura antes de qualquer decisão — mas já é parte do
item 2 acima, não um item isolado.

### 4. `cachearPedido` — duas diferenças que passaram batido

- **Freio anti-martelo da Shopee** (só AMB): depois de 3 falhas seguidas no fallback direto da
  Shopee, espera 1h antes de tentar de novo o mesmo pedido (`_shFalhas`, comentário "30/07 —
  FREIO"). GOOD e Girassol chamam o mesmo fallback sem essa proteção — repetem a chamada (e o
  risco de 429) a cada ciclo, pra sempre, num pedido que não vai resolver.
- **Módulo Madeira Madeira** (GOOD e Girassol têm, AMB não): GOOD e Girassol fazem
  `require('../good-mm-etiquetas')` / `require('../girassol-mm-etiquetas')` fixo. A AMB tenta um
  require dinâmico pelo prefixo da pasta (`'../amb-mm-etiquetas'`), que não existe — o próprio
  comentário no código diz que a AMBTotal não vende nesse canal. Não é falta, é ausência de
  operação; mas inverte o sentido do que a tabela antiga sugeria.

## Recomendação

Não extrair o `ciclo.js` inteiro ainda. O caminho com melhor retorno e menor risco:

1. **decidir o item 2** (o subsistema de Full na Girassol, escopo completo) — é o que tem
   pergunta objetiva pro dono;
2. **decidir o item 1** (o gap de reconciliação no 404) separadamente — é bug latente, não
   escolha de estilo, e não depende da resposta do item 2;
3. extrair os **trechos idênticos nas três** em fatias pequenas, como foi feito com
   `comum`, `produtos`, `etiquetas` e `email-docs`;
4. deixar reconciliação, Full e o freio da Shopee por último, quando as decisões acima existirem.

Enquanto isso, o `ciclo.js` **não entra na lista de espelhos** — ele não é cópia, e fingir que
é só criaria exceções, que foi exatamente o mecanismo que escondeu o CNPJ trocado na DANFE
por meses (ver `docs/fase2-diferencas-girassol.md`).
