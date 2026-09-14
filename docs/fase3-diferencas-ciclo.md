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

| função | AMB | GOOD | Girassol |
|---|:-:|:-:|:-:|
| `detalheParaReconciliacao` (404 = apagado no Bling) | ✅ | ✅ | ❌ *(resolve de outro jeito — ver abaixo)* |
| `ESPERA_FULL_MS` (espera antes de tirar Full de ATENDIDO) | ✅ | ✅ | ❌ |
| `unsFullEfetivas` | ✅ | ❌ | ❌ |
| demais funções | iguais nas três | | |

## O que cada diferença é

### 1. `detalheParaReconciliacao` — **não é falta**

A AMB e a GOOD usam um invólucro que devolve `{naoExiste:true}` quando o Bling responde 404,
para a reconciliação distinguir "apagado" de "falhou ao consultar" — a confusão entre os dois
foi o bug que apagava a pasta do pedido (e a etiqueta anexada) quando a lista vinha
incompleta.

A Girassol resolve o **mesmo problema** por outro caminho: trata o 404 direto no laço, com a
marca `sumiu` (linhas 87-91). Objetivo idêntico, implementação diferente. Unificar aqui é
escolher uma das duas — decisão de operação, não de refatoração.

### 2. `ESPERA_FULL_MS` — **candidato a porte, precisa de decisão**

A AMB e a GOOD têm uma espera configurável antes de tirar da lista um pedido Full sem NF. A
regra do dono, registrada em agosto, é que **Full sem NF sai de ATENDIDO na hora** (espera
padrão zero), então hoje o efeito prático é nenhum — mas a alavanca existe nas duas e não na
Girassol.

**Pergunta para o dono:** a Girassol vende no Full e precisaria dessa alavanca, ou o fluxo
dela não passa por esse caso?

### 3. `unsFullEfetivas` — **só na AMB, provavelmente específico**

Trata as unidades de negócio do Full. A AMB é a empresa com operação Full mais ampla; pode
ser especialização legítima. Precisa de leitura antes de qualquer decisão.

## Recomendação

Não extrair o `ciclo.js` inteiro ainda. O caminho com melhor retorno e menor risco:

1. **decidir o item 2** (a alavanca do Full na Girassol) — é o único com pergunta objetiva;
2. extrair os **trechos idênticos nas três** em fatias pequenas, como foi feito com
   `comum`, `produtos`, `etiquetas` e `email-docs`;
3. deixar reconciliação e Full por último, quando a decisão do item 2 existir.

Enquanto isso, o `ciclo.js` **não entra na lista de espelhos** — ele não é cópia, e fingir que
é só criaria exceções, que foi exatamente o mecanismo que escondeu o CNPJ trocado na DANFE
por meses (ver `docs/fase2-diferencas-girassol.md`).
