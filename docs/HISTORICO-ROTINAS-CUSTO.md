# Histórico — as rotinas de custo nos arquivos de entrada

Em 16/11/2026 (`docs/NORTE-2026-11.md`, item C — `montarCheckout(empresa)`, passo 6) as rotinas de custo de cada checkout
(estado e anotação da falha, sync de custo, sync travado com re-tentativa, custo diário das 23 h e fila de recálculo) viraram
a peça `lib/checkout/rotinas-custo-empresa`. O texto abaixo é o que ficava em cada arquivo de entrada, guardado como estava
(a história de cada decisão; o código equivalente está na peça e nas peças que ela monta).

## `girassol-backup-offline/gbo-app.js`

```js
// ═══ CUSTO-SYNC (background): resolve custo/preço de TODOS os SKUs vendidos, devagar (anti-429),
// e grava em cache PERMANENTE em disco (_custos.json, validade 7d). O sku-info lê daqui — instantâneo.
const _cst = _estadoRotinas.custo;   /* 01/10: estado por empresa, de lib/checkout/estado-rotinas */
/* 13/09 — A FALHA AGORA SE IDENTIFICA. Toda rodada do custo-sync fechava com "falhas: 1" e
   nada mais: sem SKU nem motivo, não dava pra saber se era um produto irrelevante ou
   justamente um que decide margem — o dono perguntou por isso mais de uma vez e a resposta
   honesta era "não sei". Guarda as últimas 10, com hora, e o ?status=1 mostra. */
/* 15/11 (norte C): a anotação da falha do sync de custo é a peça (lib/checkout/estado-rotinas.anotarFalhaCusto) sobre o `_cst` DESTA empresa */
const _anotarFalhaCusto = (sku, motivo) => require('../lib/checkout/estado-rotinas').anotarFalhaCusto(_cst, sku, motivo);

/* ── CUSTO DIÁRIO INCREMENTAL (09/09, v3 pós-Codex) ──────────────────────────────
   Module-level de propósito: a rota ?status=1 vive em função irmã (o Codex pegou o
   ReferenceError da v2). Data em FUSO LOCAL (às 23h de São Paulo o toISOString já
   virou o dia UTC seguinte — o scan olharia um dia vazio). O dia só é dado por
   FEITO ao concluir com êxito (persistido no cache: restart não repete, sync
   concorrente não engole o tick — os dois P1 do agendamento) e página falhada
   deixa o dia ABERTO pro próximo tick re-tentar, nunca parcial silencioso. */
const CUSTO_FILE_DIARIO = path.join(CACHE_DIR, '_custos.json');   /* o mesmo caminho que o custoSync monta local */
/* 14/09 — Codex P1: a trava só protegia quem passava pelo custoDiario. A tartaruga pós-boot
   (240s), a manutenção de 6 em 6h (agendador.js) e o disparo manual do operador chamam
   custoSync DIRETO, sem nunca ver a trava — as duas empresas voltavam a rodar juntas por
   esses caminhos. custoSyncTravado (definida logo após custoSync) cobre essas três portas;
   custoDiario continua chamando o custoSync CRU, porque ele já segura a trava por fora, pelo
   corpo inteiro do seu próprio run — travar de novo aqui dentro seria a rotina brigando com
   ela mesma pela própria trava. */
const travaPesada = require('../lib/checkout/trava-pesada');
/* 11/09 — fatia 5: o CUSTO DIÁRIO (164 linhas idênticas nas duas empresas) foi pra
   lib/checkout/custo-diario.js. Por ser a rotina que decide a margem do dia seguinte, ela
   só saiu daqui COM TESTE ESCRITO ANTES (scripts/teste-custo-diario.js — 6 promessas lidas
   no próprio código). O estado do custo-sync entra por FUNÇÃO (o host recria o objeto a
   cada varredura) e a vigência retroativa da madrugada por acessor. */
/* 13/11: a fila de recálculo de custo desta empresa (a mesma do "lançar custo" — uma por empresa no processo) */
const _filaRecalculoCusto = () => require('../lib/checkout/custo-recalculo').daEmpresa({ empresa: 'girassol', reaplicar: (de, ate, emp, opts) => reaplicarCusto(de, ate, emp, opts), hoje: () => _custoDiarioMod._diaLocalHoje() });
const _custoDiarioMod = require('../lib/checkout/custo-diario').criar({
  empresa: 'girassol',                                 /* identifica quem segura a trava pesada */
  CUSTO_FILE: CUSTO_FILE_DIARIO,
  readJson,
  /* 01/11 (auditoria do Codex, achado F11): gravação SEGURA (temporário + troca), como a GOOD — o writeFileSync direto
     truncava o arquivo de custos antes de escrever; uma falha no meio (disco cheio, deploy) o deixava ilegível */
  escrever: (p, o) => require('../lib/escrita-atomica').gravarAtomico(p, JSON.stringify(o)),
  estadoSync: () => _cst,
  custoSync: (...a) => custoSync(...a),
  blingGet: (...a) => blingGet(...a),
  registrarCustoVigente: (...a) => registrarCustoVigente(...a),
  lerVigenciaDe: () => _vigenciaDeRef.valor,
  gravarVigenciaDe: (v) => { _vigenciaDeRef.valor = v; },
  /* 13/11: custo que mudou no Bling recalcula as vendas JÁ GRAVADAS desde o dia da mudança — pela mesma fila do "lançar
     custo" (uma por empresa no processo) */
  lerVigencias: () => lerVigencias(),
  pedirRecalculo: (sku, dia) => _filaRecalculoCusto().pedir(sku, dia),
  /* o que a fila fez por último com o SKU — a rotina só dá a mudança por aplicada quando o recálculo terminou bem */
  estadoRecalculo: (sku) => _filaRecalculoCusto().estado(sku),
});
const custoDiario = (...a) => _custoDiarioMod.custoDiario(...a);
const _cstDiario = _custoDiarioMod._cstDiario;
const _diaFechadoDoDisco = _custoDiarioMod._diaFechadoDoDisco;
```

```js
/* 11/11 (plano multiloja, Fase 3 item 5): a sincronização de custo virou PEÇA ÚNICA (lib/checkout/custo-sync.js) — era
   igual, linha a linha, na Girassol e na AMB (236 linhas em cada; só o nome da empresa mudava). O que é DESTA empresa vai
   por acessores, lidos a cada rodada (sem depender da ordem deste arquivo). */
const _custoSyncPeca = require('../lib/checkout/custo-sync').criar({
  empresa: 'girassol',
  get CACHE_DIR() { return CACHE_DIR; },
  get CONFERIDOS_FILE() { return CONFERIDOS_FILE; },
  get _anotarFalhaCusto() { return _anotarFalhaCusto; },
  get _cst() { return _cst; },
  get _custoComp() { return _custoComp; },
  get _histCache() { return _histCache; },
  get _limparSkuInfo() { return _limparSkuInfo; },
  get blingGet() { return blingGet; },
  get readJson() { return readJson; },
  get registrarCustoVigente() { return registrarCustoVigente; },
  get resolverDeParaSku() { return resolverDeParaSku; },
  get resolverProdutoPorSku() { return resolverProdutoPorSku; },
  get supaCfg() { return supaCfg; },
  get travaPesada() { return travaPesada; },
  get writeJson() { return writeJson; },
});
async function custoSync(fresh) { return _custoSyncPeca(fresh); }
```

```js
/* 14/09 — Codex P1: cobre as portas que chamam custoSync DIRETO (tartaruga pós-boot, manutenção
   de 6h, disparo manual) com a trava do processo. Adia sem enfileirar, igual ao custoDiario —
   e não é opcional: sem isto, a rodada de custo daqui podia sobrepor a rodada pesada da OUTRA
   empresa (ou o custoDiario desta mesma), recriando o 503 de 13/09. */
/* 13/11 (plano multiloja, Fase 3 item 5): a sincronização de custo "travada" virou PEÇA ÚNICA
   (lib/checkout/custo-sync-travado.js), a mesma das três — pega a trava do processo, roda, solta. 14/11: o gatilho do
   histórico passou a valer aqui também (ver `aoPublicarSkusSemCusto`, na montagem do histórico): quem chama com
   `retentar` não é descartado se a trava estiver ocupada, e a rodada que termina com SKU sem custo é refeita. As rotinas
   de sempre (tartaruga, 6 h, disparo manual) seguem chamando SEM `retentar`, como antes. */
const _custoTravadoPeca = require('../lib/checkout/custo-sync-travado').criar({
  empresa: 'girassol',
  travaPesada,
  custoSync: (fresh) => custoSync(fresh),
  get _cst() { return _cst; },
  get _histCache() { return _histCache; },
});
function custoRetryPendente() { return _custoTravadoPeca.custoRetryPendente(); }
async function custoSyncTravado(fresh, retentar) { return _custoTravadoPeca.custoSyncTravado(fresh, retentar); }
```

## `amb-checkout-offline/index.js`

```js
// ═══ CUSTO-SYNC (background): resolve custo/preço de TODOS os SKUs vendidos, devagar (anti-429),
// e grava em cache PERMANENTE em disco (_custos.json, validade 7d). O sku-info lê daqui — instantâneo.
const _cst = _estadoRotinas.custo;   /* 01/10: estado por empresa, de lib/checkout/estado-rotinas */
/* 13/09 — A FALHA AGORA SE IDENTIFICA. Toda rodada do custo-sync fechava com "falhas: 1" e
   nada mais: sem SKU nem motivo, não dava pra saber se era um produto irrelevante ou
   justamente um que decide margem — o dono perguntou por isso mais de uma vez e a resposta
   honesta era "não sei". Guarda as últimas 10, com hora, e o ?status=1 mostra. */
/* 15/11 (norte C): a anotação da falha do sync de custo é a peça (lib/checkout/estado-rotinas.anotarFalhaCusto) sobre o `_cst` DESTA empresa */
const _anotarFalhaCusto = (sku, motivo) => require('../lib/checkout/estado-rotinas').anotarFalhaCusto(_cst, sku, motivo);

/* ── CUSTO DIÁRIO INCREMENTAL (09/09, v3 pós-Codex) ──────────────────────────────
   Module-level de propósito: a rota ?status=1 vive em função irmã (o Codex pegou o
   ReferenceError da v2). Data em FUSO LOCAL (às 23h de São Paulo o toISOString já
   virou o dia UTC seguinte — o scan olharia um dia vazio). O dia só é dado por
   FEITO ao concluir com êxito (persistido no cache: restart não repete, sync
   concorrente não engole o tick — os dois P1 do agendamento) e página falhada
   deixa o dia ABERTO pro próximo tick re-tentar, nunca parcial silencioso. */
const CUSTO_FILE_DIARIO = path.join(CACHE_DIR, '_custos.json');   /* o mesmo caminho que o custoSync monta local */
/* 14/09 — Codex P1: a trava só protegia quem passava pelo custoDiario. A tartaruga pós-boot
   (240s), a manutenção de 6 em 6h (agendador.js) e o disparo manual do operador chamam
   custoSync DIRETO, sem nunca ver a trava — as duas empresas voltavam a rodar juntas por
   esses caminhos. custoSyncTravado (definida logo após custoSync) cobre essas três portas;
   custoDiario continua chamando o custoSync CRU, porque ele já segura a trava por fora, pelo
   corpo inteiro do seu próprio run — travar de novo aqui dentro seria a rotina brigando com
   ela mesma pela própria trava. */
const travaPesada = require('../lib/checkout/trava-pesada');
/* 11/09 — fatia 5: o CUSTO DIÁRIO (164 linhas idênticas nas duas empresas) foi pra
   lib/checkout/custo-diario.js. Por ser a rotina que decide a margem do dia seguinte, ela
   só saiu daqui COM TESTE ESCRITO ANTES (scripts/teste-custo-diario.js — 6 promessas lidas
   no próprio código). O estado do custo-sync entra por FUNÇÃO (o host recria o objeto a
   cada varredura) e a vigência retroativa da madrugada por acessor. */
/* 13/11: a fila de recálculo de custo desta empresa (a mesma do "lançar custo" — uma por empresa no processo) */
const _filaRecalculoCusto = () => require('../lib/checkout/custo-recalculo').daEmpresa({ empresa: 'amb', reaplicar: (de, ate, emp, opts) => reaplicarCusto(de, ate, emp, opts), hoje: () => _custoDiarioMod._diaLocalHoje() });
const _custoDiarioMod = require('../lib/checkout/custo-diario').criar({
  empresa: 'amb',                                 /* identifica quem segura a trava pesada */
  CUSTO_FILE: CUSTO_FILE_DIARIO,
  readJson,
  /* 01/11 (auditoria do Codex, achado F11): gravação SEGURA (temporário + troca), como a GOOD — o writeFileSync direto
     truncava o arquivo de custos antes de escrever; uma falha no meio (disco cheio, deploy) o deixava ilegível */
  escrever: (p, o) => require('../lib/escrita-atomica').gravarAtomico(p, JSON.stringify(o)),
  estadoSync: () => _cst,
  custoSync: (...a) => custoSync(...a),
  blingGet: (...a) => blingGet(...a),
  registrarCustoVigente: (...a) => registrarCustoVigente(...a),
  lerVigenciaDe: () => _vigenciaDeRef.valor,
  gravarVigenciaDe: (v) => { _vigenciaDeRef.valor = v; },
  /* 13/11: custo que mudou no Bling recalcula as vendas JÁ GRAVADAS desde o dia da mudança — pela mesma fila do "lançar
     custo" (uma por empresa no processo) */
  lerVigencias: () => lerVigencias(),
  pedirRecalculo: (sku, dia) => _filaRecalculoCusto().pedir(sku, dia),
  /* o que a fila fez por último com o SKU — a rotina só dá a mudança por aplicada quando o recálculo terminou bem */
  estadoRecalculo: (sku) => _filaRecalculoCusto().estado(sku),
});
const custoDiario = (...a) => _custoDiarioMod.custoDiario(...a);
const _cstDiario = _custoDiarioMod._cstDiario;
const _diaFechadoDoDisco = _custoDiarioMod._diaFechadoDoDisco;
```

```js
/* 11/11 (plano multiloja, Fase 3 item 5): a sincronização de custo virou PEÇA ÚNICA (lib/checkout/custo-sync.js) — era
   igual, linha a linha, na Girassol e na AMB (236 linhas em cada; só o nome da empresa mudava). O que é DESTA empresa vai
   por acessores, lidos a cada rodada (sem depender da ordem deste arquivo). */
const _custoSyncPeca = require('../lib/checkout/custo-sync').criar({
  empresa: 'amb',
  get CACHE_DIR() { return CACHE_DIR; },
  get CONFERIDOS_FILE() { return CONFERIDOS_FILE; },
  get _anotarFalhaCusto() { return _anotarFalhaCusto; },
  get _cst() { return _cst; },
  get _custoComp() { return _custoComp; },
  get _histCache() { return _histCache; },
  get _limparSkuInfo() { return _limparSkuInfo; },
  get blingGet() { return blingGet; },
  get readJson() { return readJson; },
  get registrarCustoVigente() { return registrarCustoVigente; },
  get resolverDeParaSku() { return resolverDeParaSku; },
  get resolverProdutoPorSku() { return resolverProdutoPorSku; },
  get supaCfg() { return supaCfg; },
  get travaPesada() { return travaPesada; },
  get writeJson() { return writeJson; },
});
async function custoSync(fresh) { return _custoSyncPeca(fresh); }
```

```js
/* 14/09 — Codex P1: cobre as portas que chamam custoSync DIRETO (tartaruga pós-boot, manutenção
   de 6h, disparo manual) com a trava do processo. Adia sem enfileirar, igual ao custoDiario —
   e não é opcional: sem isto, a rodada de custo daqui podia sobrepor a rodada pesada da OUTRA
   empresa (ou o custoDiario desta mesma), recriando o 503 de 13/09. */
/* 13/11 (plano multiloja, Fase 3 item 5): a sincronização de custo "travada" virou PEÇA ÚNICA
   (lib/checkout/custo-sync-travado.js), a mesma das três — pega a trava do processo, roda, solta. 14/11: o gatilho do
   histórico passou a valer aqui também (ver `aoPublicarSkusSemCusto`, na montagem do histórico): quem chama com
   `retentar` não é descartado se a trava estiver ocupada, e a rodada que termina com SKU sem custo é refeita. As rotinas
   de sempre (tartaruga, 6 h, disparo manual) seguem chamando SEM `retentar`, como antes. */
const _custoTravadoPeca = require('../lib/checkout/custo-sync-travado').criar({
  empresa: 'amb',
  travaPesada,
  custoSync: (fresh) => custoSync(fresh),
  get _cst() { return _cst; },
  get _histCache() { return _histCache; },
});
function custoRetryPendente() { return _custoTravadoPeca.custoRetryPendente(); }
async function custoSyncTravado(fresh, retentar) { return _custoTravadoPeca.custoSyncTravado(fresh, retentar); }
```

## `good-checkout-offline/index.js`

```js
// ═══ CUSTO-SYNC (background): resolve custo/preço de TODOS os SKUs vendidos, devagar (anti-429),
// e grava em cache PERMANENTE em disco (_custos.json, validade 7d). O sku-info lê daqui — instantâneo.
/* 14/09 — Codex P1 do #422 (AMB/Girassol) vale igual aqui: as três empresas (girassol, amb,
   good — config/empresas.js) sobem no MESMO processo (--max-old-space-size=340, o heap do
   incidente), e a tartaruga pós-boot da GOOD roda no MESMO instante (240s) que a das outras
   duas. Sem a trava, a GOOD ficava de fora da correção — livre pra sobrepor quem quer que
   esteja rodando a rodada pesada da vez, recriando o mesmo 503. custoSyncTravado cobre as
   duas portas desta empresa (tartaruga e disparo manual); a GOOD não tem custo-diário. */
const travaPesada = require('../lib/checkout/trava-pesada');
const _custoComp = require('../lib/custo-composicao');   /* Codex #693: decisão de custo por composição, a mesma da AMB/Girassol */
const _cst = _estadoRotinas.custo;   /* 01/10: estado por empresa, de lib/checkout/estado-rotinas */

/* 17/09 — PORTE: a AMB e a Girassol guardam o MOTIVO de cada falha do sync de custo; a GOOD só
   contava quantas foram. "3 falhas" não diz o que fazer — o SKU e o motivo dizem. Guarda as
   últimas 10, e o ?status=1 mostra. */
/* 15/11 (norte C): a anotação da falha do sync de custo é a peça (lib/checkout/estado-rotinas.anotarFalhaCusto) sobre o `_cst` DESTA empresa */
const _anotarFalhaCusto = (sku, motivo) => require('../lib/checkout/estado-rotinas').anotarFalhaCusto(_cst, sku, motivo);
/* 13/11 (plano multiloja, Fase 3 item 5): a sincronização de custo da GOOD passa a ser a PEÇA ÚNICA
   (lib/checkout/custo-sync.js), a mesma da Girassol e da AMB — saem daqui as 185 linhas da cópia. A união foi por cima:
   o que só a GOOD tinha virou opção da peça e segue valendo AQUI, declarado logo abaixo —
     · `seletor: 'ativo-v1'` — a marca de qual seletor de produto gravou cada custo (custo gravado pelo seletor antigo, que
       podia ler o cadastro EXCLUÍDO, é relido mesmo "fresco" — o conserto de 19/08);
     · `fornecedorEstrito` — do fornecedor só valem precoCusto e precoCompra;
     · `histSkusDoArquivo` — os SKUs do histórico vêm do `_hist_skus.json` (o painel calcula a margem sobre o histórico
       inteiro, não só o que passou pelo checkout — foi assim que os 217 SKUs "sem custo" de setembro se resolveram);
   e a GOOD GANHA o que só as outras tinham: os SKUs das vendas do dia ainda não bipadas, o de-para aplicado em todo SKU (não
   só nos do histórico), o cache do sku-info limpo a cada custo relido, e o cache do histórico limpo no fim da rodada (o
   dashboard recalcula com os custos novos). O que é DESTA empresa vai por acessores, lidos a cada rodada. */
const _custoSyncPeca = require('../lib/checkout/custo-sync').criar({
  empresa: 'good',
  seletor: 'ativo-v1',
  fornecedorEstrito: true,
  histSkusDoArquivo: true,
  get CACHE_DIR() { return CACHE_DIR; },
  get CONFERIDOS_FILE() { return CONFERIDOS_FILE; },
  get _anotarFalhaCusto() { return _anotarFalhaCusto; },
  get _cst() { return _cst; },
  get _custoComp() { return _custoComp; },
  get _histCache() { return _histCacheGood; },
  get _limparSkuInfo() { return (sku) => { try { _produtoAtivo._limparSkuInfo(sku); } catch (e) {} }; },   /* como era aqui: falha ao limpar o outro cache não derruba o custo do SKU */
  get blingGet() { return blingGet; },
  get readJson() { return readJson; },
  get registrarCustoVigente() { return registrarCustoVigente; },
  get resolverDeParaSku() { return resolverDeParaSku; },
  get resolverProdutoPorSku() { return resolverProdutoPorSku; },
  get supaCfg() { return (empresa) => _supaGood.cfg(empresa); },
  get travaPesada() { return travaPesada; },
  get writeJson() { return writeJson; },
});
async function custoSync(fresh) { return _custoSyncPeca(fresh); }

/* ═══ 14/10 — CUSTO DIÁRIO NA GOOD ════════════════════════════════════════════════════════════
   Girassol e AMB têm, desde 10/09, a rotina das 23h que pergunta ao Bling o que mudou de custo no
   dia, recalcula o que depende disso (kits inclusos) e fecha o dia com um carimbo que sobrevive a
   restart — é ela que decide a margem do dia seguinte. A GOOD não tinha (a rota /custo-diario
   respondia "falta custoDiario"). A peça é a MESMA (lib/checkout/custo-diario.js, com teste
   próprio); aqui só as dependências da GOOD. A trava pesada do processo coordena com as outras
   duas empresas (AMB 23h00, Girassol 23h15): adiada, o próximo disparo tenta de novo. */
const CUSTO_FILE_DIARIO = path.join(CACHE_DIR, '_custos.json');   /* o mesmo arquivo que o custoSync monta */
/* 13/11: a fila de recálculo de custo desta empresa (a mesma do "lançar custo" — uma por empresa no processo) */
const _filaRecalculoCusto = () => require('../lib/checkout/custo-recalculo').daEmpresa({ empresa: 'good', reaplicar: (de, ate, emp, opts) => reaplicarCusto(de, ate, emp, opts), hoje: () => _custoDiarioMod._diaLocalHoje() });
const _custoDiarioMod = require('../lib/checkout/custo-diario').criar({
  empresa: 'good',
  CUSTO_FILE: CUSTO_FILE_DIARIO,
  readJson,
  escrever: (p, o) => require('../lib/escrita-atomica').gravarAtomico(p, JSON.stringify(o)),
  estadoSync: () => _cst,
  custoSync: (...a) => custoSync(...a),
  blingGet: (...a) => blingGet(...a),
  registrarCustoVigente: (...a) => registrarCustoVigente(...a),
  lerVigenciaDe: () => _vigenciaDeRef.valor,
  gravarVigenciaDe: (v) => { _vigenciaDeRef.valor = v; },
  /* 13/11: custo que mudou no Bling recalcula as vendas JÁ GRAVADAS desde o dia da mudança — pela mesma fila do "lançar
     custo" (uma por empresa no processo) */
  lerVigencias: () => lerVigencias(),
  pedirRecalculo: (sku, dia) => _filaRecalculoCusto().pedir(sku, dia),
  /* o que a fila fez por último com o SKU — a rotina só dá a mudança por aplicada quando o recálculo terminou bem */
  estadoRecalculo: (sku) => _filaRecalculoCusto().estado(sku),
});
const custoDiario = (...a) => _custoDiarioMod.custoDiario(...a);
const _cstDiario = _custoDiarioMod._cstDiario;
const _diaFechadoDoDisco = _custoDiarioMod._diaFechadoDoDisco;

/* 14/09 — cobre as duas portas que chamam custoSync nesta empresa (tartaruga pós-boot e
   disparo manual) com a trava do processo. Adia sem enfileirar — não é opcional: sem isto,
   a rodada de custo daqui podia sobrepor a rodada pesada de QUALQUER uma das outras duas
   empresas do mesmo processo, recriando o 503 de 13/09. */
/* 13/11 (plano multiloja, Fase 3 item 5): a sincronização de custo "travada" e a re-tentativa viraram PEÇA ÚNICA
   (lib/checkout/custo-sync-travado.js) — o corpo é o que estava aqui. A GOOD segue chamando com `retentar` pelo gatilho do
   histórico (`aoPublicarSkusSemCusto`), como sempre. As duas continuam sendo FUNÇÕES declaradas: este arquivo as usa
   antes desta linha (içamento). */
const _custoTravadoPeca = require('../lib/checkout/custo-sync-travado').criar({
  empresa: 'good',
  travaPesada,
  custoSync: (fresh) => custoSync(fresh),
  get _cst() { return _cst; },
  get _histCache() { return _histCacheGood; },
});
function custoRetryPendente() { return _custoTravadoPeca.custoRetryPendente(); }
async function custoSyncTravado(fresh, retentar) { return _custoTravadoPeca.custoSyncTravado(fresh, retentar); }
```
