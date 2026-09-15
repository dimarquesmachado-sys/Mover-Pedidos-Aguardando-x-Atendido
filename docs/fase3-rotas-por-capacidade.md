# Fase 3, passo 4 — rotas em registradores por capacidade (medido em 15/09/2026)

## Por que este documento vem antes do código

O passo 4 é o que faria o **checkout** de uma empresa nova nascer sem pasta, como o fiscal já
nasce. Mas os entrypoints somam mais de 8 mil linhas cada, e as duas vezes em que comecei uma
extração desse tamanho sem medir antes, o resultado foi meia-porta: no `base.js` levei as
funções e deixei os caches; no `historico` quase levei a lógica sem o contexto. Medir primeiro
é o que evita a terceira vez.

## O tamanho real

| checkout | rotas registradas |
|---|---:|
| AMB | 121 |
| Girassol | 98 |
| GOOD | 80 |

**45 rotas existem nas três.** E o que importa é o corpo delas, não o caminho:

| grupo | quantas | o que fazer |
|---|---:|---|
| **corpo idêntico** (normalizando o nome da empresa) | **18** | vão para um registrador comum |
| **quase idêntico** (≤6 linhas de diferença) | **6** | ler a diferença: se for config, vira parâmetro |
| divergente | 21 | classificar antes, como foi feito com o `ciclo.js` |

As idênticas: `/backfill-detalhes`, `/backfill-nf`, `/backfill-valores`, `/buscar-produto`,
`/indexar-catalogo`, `/indexar-status`, `/liberar`, `/localizacoes-log`, `/ml-sync-fees`,
`/nf-anexar`, `/reservar`, `/run`, `/salvar-localizacao`, `/separacao`,
`/separacao-por-pedido`, `/shopee-sessao`, `/sincronizar` e mais uma.

As quase-idênticas, com a distância: `/backfill-nf-auto` (4), `/ciclo-agora` (4),
`/conferido` (3), `/ir-shopee` (2), `/lista` (2), `/ml-fee` (4).

## Como extrair sem repetir os erros de hoje

1. **Um registrador por vez, começando pelas idênticas.** Elas não exigem decisão: o corpo já
   é o mesmo. Cada registrador recebe o contexto do checkout (o que hoje vem do `base`) e
   devolve um `handle` que a empresa pluga.
2. **Prefixo por parâmetro**, como já é no `criar-modulo.js` do fiscal e no `historico`.
3. **Ordem de casamento importa.** A delegação entra no mesmo ponto do handle em que hoje
   está, nunca antes — rota declarada acima pode capturar um caminho que a de baixo espera.
4. **As quase-idênticas só depois**, e cada diferença classificada: configuração vira
   parâmetro, capacidade vira flag, regra real fica onde está e é documentada.
5. **As divergentes não entram nesta fase.** Elas são o próximo `ciclo.js`: medir, classificar,
   perguntar ao dono, e só então decidir.

## O que NÃO se unifica, já sabido

- rotas de **diagnóstico** (`/debug-*`, `/sonda-*`, `/diag-*`): são ~23 e existem porque
  alguém investigou um problema naquela empresa. Portar quando alguém precisar, não antes;
- rotas que dependem de **capacidade** que a empresa não tem (`madeira-madeira`, `tiktok`);
- o que depender de **Expedição** — ver `docs/fase3-diferencas-ciclo.md`.

## Critério de pronto

O checkout de uma empresa nova sobe com rotas e crons a partir do registro e das capacidades,
sem pasta e sem editar JavaScript — o mesmo critério que o fiscal já cumpre via
`lib/fiscal/montar-empresa.js`.
