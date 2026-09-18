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

**30 rotas existem nas três.** E o que importa é o corpo delas, não o caminho:

| grupo | quantas | o que fazer |
|---|---:|---|
| **corpo idêntico** (normalizando o nome da empresa) | ~~18~~ **19** | vão para um registrador comum |
| **quase idêntico** (≤6 linhas de diferença) | ~~6~~ **7** | ler a diferença: se for config, vira parâmetro |
| divergente | ~~21~~ ~~6~~ **3** | classificar antes (duas correções de medição em 17/09 — ver a seção no fim) |

As idênticas: `/backfill-detalhes`, `/backfill-nf`, `/backfill-valores`, `/buscar-produto`,
`/indexar-catalogo`, `/indexar-status`, `/liberar`, `/localizacoes-log`, `/ml-sync-fees`,
`/nf-anexar`, `/reservar`, `/run`, `/salvar-localizacao`, `/separacao`,
`/separacao-por-pedido`, `/shopee-sessao`, `/sincronizar`, `/status` e mais uma.

As quase-idênticas, com a distância: `/backfill-nf-auto` (4), `/ciclo-agora` (4),
`/conferido` (3), `/ir-shopee` (2), `/lista` (2), `/ml-fee` (4), `/etiqueta-anexar` (4).

## Feito até agora

- ✅ **catálogo** (PR #480): `/buscar-produto`, `/indexar-catalogo` e `/indexar-status` →
  `lib/checkout/rotas-catalogo.js`. Escolhidas por coesão, não por tamanho: buscar produto usa
  o índice de EAN que as outras duas constroem e acompanham.

- ✅ **separação e localização** (PR #482): `/salvar-localizacao`, `/localizacoes-log`,
  `/separacao`, `/separacao-por-pedido`, `/reservar` e `/liberar` →
  `lib/checkout/rotas-separacao.js`. Primeira fatia escolhida já com o critério dos **dois
  lados**: corpo idêntico **e** todas depois do portão de sessão nas três empresas.

- ✅ **backfill do histórico** (PR #486): `/backfill-detalhes`, `/backfill-nf` e
  `/backfill-valores` → `lib/checkout/rotas-backfill.js`. Aqui o lint pegou o que a varredura
  de dependências não vê: `_bf` e `_bfd` não são valores, são **estado vivo** — objetos de
  status que as rotas leem e escrevem durante o backfill. Entram por REFERÊNCIA e por empresa;
  copiá-los faria a rota reportar um progresso que não é o do backfill de verdade.

- ✅ **NF anexada e sessão dos marketplaces** (PR #487): `/nf-anexar`, `/shopee-sessao` e
  `/ml-sync-fees` → `lib/checkout/rotas-nf-anexar.js`. O `nf-anexar` era a maior das idênticas
  (80 linhas) e a única com diferença real: o **id da empresa** no aviso ao Devoluções —
  configuração, não regra, virou parâmetro. Mais um estado vivo (`_mls`) por referência.

- ✅ **conferência e ciclo** (PR #489): `/conferido`, `/run` e `/sincronizar` →
  `lib/checkout/rotas-conferido.js`. O `SIT_VERIFICADO` entra **injetado**: ele é o destino do
  pedido conferido e depende da **Expedição** — uma lib não decide o fluxo físico de uma
  empresa que ela não conhece.

## Classificação das quase-idênticas (17/09)

| rota | linhas | difer | o que é a diferença |
|---|---:|---:|---|
| `ir-shopee` | 84 | 2 | **config** — nome da env do cookie na mensagem de erro |
| `lista` | 37 | 2 | **capacidade** — a Girassol expõe diagnóstico do ciclo que as outras não |
| `ml-fee` | 26 | 6 | **capacidade** — a GOOD aceitava só sessão; AMB e Girassol aceitam chave ✅ portado |
| `ciclo-agora` | 12 | 4 | **a mesma** (auth por chave) ✅ portado |
| `backfill-nf-auto` | 8 | 4 | **a mesma** (auth por chave) ✅ portado |

**As três últimas diferenças eram a MESMA coisa:** a AMB e a Girassol aceitam chave de admin ou
sessão nas rotas administrativas; a GOOD aceitava só sessão — em **seis** rotas. Rotina
automática, cron externo e diagnóstico por URL não têm sessão de navegador, então essas rotas
eram inalcançáveis por chave só nela, com um 403 que parece permissão negada e é desenho
faltando. Portado (#492) e travado em teste.

⚠️ **Da `lista`, só metade dava pra portar.** `paginasRefeitas` o `ciclo.js` das três produz e
foi portado; **`reconciliacao` só a Girassol calcula** — expor onde ninguém preenche é devolver
null pra sempre, que é pior que não ter, porque a tela mostra o diagnóstico vazio e parece que
está tudo bem. Portar o CÁLCULO da reconciliação para a AMB e a GOOD fica como item próprio: é
o único lugar que diz POR QUE a limpeza foi pulada, e sem ele as duas mostram o sintoma
(pedido despachado preso como "sem etiqueta", 13/08) sem a causa.

**18 das 19 rotas idênticas já estão em lib — falta a `/status`**, reclassificada em 17/09 (era
tida como divergente por um erro de medição). Faltam as 7 quase-idênticas (≤6 linhas de
diferença, cada uma exigindo classificar se é config, capacidade ou regra) e as **3** divergentes
(o número passou por duas correções de medição no mesmo dia — ver a seção no fim),
que são o próximo `ciclo.js`.

## O critério mudou depois da primeira fatia (P1 do Codex no #480)

A medição acima compara o **corpo** das rotas entre as empresas. Isso não basta, e a primeira
extração provou: ao mover as três rotas de catálogo, a delegação foi parar no topo do handle
e `/buscar-produto` e `/indexar-status` passaram a responder **sem autenticação** — antes da
extração esses corpos ficavam **abaixo do portão de sessão** do módulo.

**Corpo idêntico não garante contexto idêntico.** O que roda antes da rota é parte do que ela
faz, e mover código muda isso em silêncio: nada quebra, nada loga, a rota responde 200 — só
que para qualquer um.

Então o critério para as próximas fatias tem dois lados:

1. **o corpo é igual entre as empresas?** (a tabela acima responde)
2. **a rota fica depois da mesma guarda nas três?** — e a delegação precisa entrar
   exatamente naquele ponto, nunca antes.

Nas rotas do checkout, o portão central é o que responde
`Sessão necessária. Faça login.`; há exceções declaradas ali mesmo (rotas públicas e as de
`/run`, `/setup`, `/robo`, `/forcar` e `/debug`, que têm auth própria). Uma rota que hoje está
**fora** do portão e outra que está **dentro** não podem ir para o mesmo registrador sem que
essa diferença vire parâmetro explícito.

`scripts/teste-rotas-catalogo.js` trava a posição da delegação nos três arquivos. Cada
registrador novo precisa do mesmo travamento — a regra sozinha não segurou: ela já estava
escrita neste documento quando foi quebrada.

## ⚠️ A medição estava inflada — corrigida em 17/09

O número de "21 divergentes" saiu de uma regex que casava com **qualquer menção** à rota, não
só com a declaração dela. A GOOD tem uma **lista de exceções do portão de sessão** que cita
várias rotas por nome:

```js
p === '/good-checkout-offline/backfill-status' ||
p === '/good-checkout-offline/shopee-sessao-cookies' ||   // auth própria por ADMIN_KEY
...
```

Minha medição pegava esse bloco como se fosse o corpo da rota. Resultado: a
`/backfill-status`, de 6 linhas, aparecia com 25 de diferença — e, se eu tivesse "extraído"
aquilo, teria levado **a trava central de sessão** junto.

**Números reais, medindo só a declaração** (`if (… p === … ) {` com fechamento na mesma
indentação):

| | contagem |
|---|---:|
| rotas comuns às três | 24 |
| **divergentes (>6 linhas)** | **6** |

### 17/09 — a conta caiu de novo: são TRÊS, não seis

A medição de 493 contava a declaração certa, mas delimitava o CORPO por indentação. Onde a
rota tem bloco aninhado fechando na mesma coluna, ela engolia o que vinha depois — na GOOD, a
`/status` (20 linhas) aparecia com 59 de diferença porque o extrator levava junto a `/saude`
inteira, que as três têm.

Contando CHAVES (o jeito que o `teste-medicao-rotas.js` já usa desde o conserto do Codex):

| rota | linhas | difer | |
|---|---:|---:|---|
| `status` | 20 | **0** | idêntica |
| `etiqueta-anexar` | 50 | **4** | quase idêntica |
| `saude` | 30 | **0** | idêntica (era "2" — ver abaixo) |
| `config-fiscal` | 45 | 49 | divergente |
| `sku-info` | 94 | 24 | divergente |
| `custo-sync` | 33 | 21 | divergente |

A `/saude` aparecia com 2 de diferença por um terceiro erro de medição, menor e do mesmo tipo:
o normalizador trocava `AMBBKP` por marcador com `\b` nas duas pontas, então **`AMBBKP_SYNC_ON`
ficava intacto** — o nome da env dentro de uma string de aviso parecia divergência de código.
Eu ia até dar uma folga à Girassol achando que era o app de Expedição dela. Não era.

**Três correções de medição no mesmo dia, e as três pra menos.** A lição que fica escrita: para
delimitar bloco em JavaScript, contar chaves — indentação é convenção, não estrutura, e um
medidor frouxo infla o trabalho e esconde o risco (na primeira correção, ele teria feito mover
a trava de sessão).

A lição vale além desta fase: **medição frouxa infla o trabalho e esconde o risco**. Aqui ela
teria feito alguém mover a guarda de autenticação achando que era uma rota de status.

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
