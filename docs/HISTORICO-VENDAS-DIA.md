# Histórico — a venda do dia nos arquivos de entrada

Em 16/11/2026 (`docs/NORTE-2026-11.md`, item C — `montarCheckout(empresa)`, passo 8) a venda do dia de cada checkout (estado,
canal pelo número, pesca do ML, frete da Magalu, fase direta, venda do dia e a pesca das tarifas do ML nos conferidos) virou a
peça `lib/checkout/vendas-dia-empresa`; o serviço da Shopee da fase direta passou pra configuração da empresa
(`lib/checkout/config-empresa`, `faseDireta`). O texto abaixo é o que ficava em cada arquivo de entrada, guardado como estava.

## `girassol-backup-offline/gbo-app.js`

```js
// ═══ VENDAS-SYNC (background): TODAS as vendas do Bling por data, em QUALQUER situação —
// independe de bipagem. Roda a cada 5 min + boot + botão. Cancelada vem com a situação marcada.
const _vsy = _estadoRotinas.vendas;  /* 01/10: idem */
/* 15/11 (norte C): o canal pelo número do pedido na loja é a peça lib/checkout/inferir-canal (a GOOD já usava; a cópia daqui saiu) */
const _inferCanal = require('../lib/checkout/inferir-canal').inferirCanal;
// ─── FRETE MAGALU (coparticipação) — tabela + cubagem + banco por SKU ─────────
/* 11/09: estas 209 linhas eram idênticas byte a byte aqui e na outra empresa — primeira
   fatia da desduplicação dos checkouts. Foram pra lib/checkout/magalu-frete.js, que não
   conhece empresa: recebe a pasta de cache e o acesso ao Bling por injeção e devolve as
   MESMAS funções, com os mesmos nomes, pra esta troca ser invisível pro resto do arquivo. */
const _magaluFrete = require('../lib/checkout/magalu-frete').criar({
  CACHE_DIR, readJson, writeJson, blingGet,
  /* 11/09: referência PREGUIÇOSA de propósito. A fatia 2 transformou resolverProdutoPorSku
     de `function` (içada) em `const` vindo da lib — e esta fábrica roda ANTES dessa linha,
     então passar o valor direto dava "Cannot access before initialization" no boot. O boot
     real do CI pegou isso na hora; sintaxe e lint passavam. */
  resolverProdutoPorSku: (...a) => resolverProdutoPorSku(...a),
});
const { magaluNivelColuna, magaluFreteTabela, magaluFreteSkuLer, magaluFreteSkuGravar,
        magaluDimSku, magaluFretePrevistoSku, magaluFreteProvisorio, MAGALU_FRETE_TABELA } = _magaluFrete;

// ─── PESCA os dados REAIS de um pedido direto na API do ML (fonte primária) ──────
// Dado o numero_loja, devolve { fee (comissão real via sale_fee), frete, venda (hora),
// credito, credito_fonte, logistica, pack, order, costs_ok } ou null se o ML não respondeu.
// Trata carrinho (pack), Flex (self_service: frete não é custo, é o motoboy; estorno = líquido)
// e compensações. Reusada pela pesca dos bipados (mlSyncFees) e pela fase ml_real (não-bipados).
/* 01/09: a pesca do ML saiu daqui pra lib/ml-pesca.js — eram TRÊS cópias e já tinham
   divergido (a da AMB tinha o conserto do crédito Flex de 25/08 que faltava aqui). A lib usa
   a versão mais nova; a função só depende dos próprios parâmetros. Dívida nº 3 do doc. */
const { pescarDadosML } = require('../lib/ml-pesca');
```

```js
/* 17/10 — A VENDA DO DIA VIROU PEÇA ÚNICA (lib/checkout/vendas-dia.js). Ela nasceu DESTA função (a versão da
   Girassol era a mais completa: fase direta protegida e versão do custo real do ML); aqui fica só o que é da
   Girassol. A AMB e a GOOD passam a usar a mesma peça — a GOOD, que não tinha venda do dia, ganha o "Hoje"
   completo. As peças do módulo (Bling, cache, fase direta...) são entregues NA HORA DA CHAMADA (deps). */
let _vendasDiaGir = null;
async function vendasSync() {
  /* 19/10 (Fase 3): a configuração desta empresa (envs, loja Shopee, Magalu, TikTok, token do ML) vem da peça única
     lib/checkout/config-empresa — aqui só as peças do módulo (deps) */
  if (!_vendasDiaGir) _vendasDiaGir = require('../lib/checkout/vendas-dia').criarVendasSyncDaEmpresa('girassol', {
    deps: () => ({ CACHE_DIR, CONFERIDOS_FILE, LOJA_MKT, _faseDireta, _inferCanal, _vsy, blingGet, buscarDevolucoesML, json, magaluFreteProvisorio, magaluFreteSkuGravar, nfDoPedido, path, pescarDadosML, readJson, writeJson }),
    fetch,
  });
  return _vendasDiaGir();
}
```

```js
const _faseDireta = require('../lib/checkout/fase-direta').criarFaseDireta({
  empresa: 'girassol',
  mlTokenManager: () => require('../girassol/mlTokenManager'),
  shopeeKey: process.env.GBO_SHOPEE_SYNC_KEY || process.env.SHOPEE_SYNC_KEY || '',
  shopeeUrlEnv: process.env.GBO_SHOPEE_SYNC_URL || process.env.SHOPEE_SYNC_URL || 'https://girassol-shopee-sync-organizar-envio.onrender.com',
  shopeeLoja: process.env.GBO_SHOPEE_SYNC_LOJA || 'girassol',   // Codex P1: a URL do serviço Shopee usa a LOJA configurada, não o nome da empresa
  adminKey: process.env.ADMIN_KEY || '',
  porta: process.env.PORT || 3000,
  fetch,   // Codex P2: o MESMO node-fetch (com suporte a `timeout`) que o resto do arquivo usa
  log: console.log,
});
```

```js
// ═══ PESCA POSTERIOR (ML): busca tarifa REAL (sale_fee) e frete do vendedor nos pedidos ML
// recentes e grava no conferido (tarifa_ml / frete_ml). Roda no cron diário e sob demanda.
// Re-checa os finalizados dos últimos 3 dias mesmo se já têm tarifa (o ML pode ajustar depois).
/* 13/11 (plano multiloja, Fase 3 item 5): a pesca das tarifas do ML virou PEÇA ÚNICA (lib/checkout/ml-sync-fees.js) — o corpo
   era o mesmo na Girassol e na AMB. O que é DESTA empresa: o token do ML dela, a versão do marcador de custos que ela
   grava nos pedidos (a de `ML_COSTS_V`, hoje 2) e o estado da pesca (`_mls`, que as rotas de status leem). */
const _mlSyncFeesPeca = require('../lib/checkout/ml-sync-fees').criar({
  empresa: 'girassol',
  versaoCustos: ML_COSTS_V,
  garantirTokenML: () => require('../girassol/mlTokenManager').garantirTokenML(),
  get _mls() { return _mls; },
  set _mls(v) { _mls = v; },
  get CONFERIDOS_FILE() { return CONFERIDOS_FILE; },
  get readJson() { return readJson; },
  get writeJson() { return writeJson; },
});
async function mlSyncFees(dias) { return _mlSyncFeesPeca(dias); }
```

```js
// Codex PR#48: versão do cálculo do crédito ML. Subir este número faz o vendasSync
// repescar as vendas do dia já cacheadas — necessário quando a REGRA muda (v2 = gross_amount).
// ML_REAL_V (versão do custo real do ML) mora agora na peça lib/checkout/vendas-dia.js (17/10)
// Codex PR#48: idem pros BIPADOS — o predicado do mlSyncFees pulava venda antiga que já
// tinha ml_costs_v3, então a regra nova (gross_amount) nunca chegava nela.
const ML_COSTS_V = 2;
```

## `amb-checkout-offline/index.js`

```js
// ═══ VENDAS-SYNC (background): TODAS as vendas do Bling por data, em QUALQUER situação —
// independe de bipagem. Roda a cada 5 min + boot + botão. Cancelada vem com a situação marcada.
const _vsy = _estadoRotinas.vendas;  /* 01/10: idem */
/* 15/11 (norte C): o canal pelo número do pedido na loja é a peça lib/checkout/inferir-canal (a GOOD já usava; a cópia daqui saiu) */
const _inferCanal = require('../lib/checkout/inferir-canal').inferirCanal;
// ─── FRETE MAGALU (coparticipação) — tabela + cubagem + banco por SKU ─────────
/* 11/09: estas 209 linhas eram idênticas byte a byte aqui e na outra empresa — primeira
   fatia da desduplicação dos checkouts. Foram pra lib/checkout/magalu-frete.js, que não
   conhece empresa: recebe a pasta de cache e o acesso ao Bling por injeção e devolve as
   MESMAS funções, com os mesmos nomes, pra esta troca ser invisível pro resto do arquivo. */
const _magaluFrete = require('../lib/checkout/magalu-frete').criar({
  CACHE_DIR, readJson, writeJson, blingGet,
  /* 11/09: referência PREGUIÇOSA de propósito. A fatia 2 transformou resolverProdutoPorSku
     de `function` (içada) em `const` vindo da lib — e esta fábrica roda ANTES dessa linha,
     então passar o valor direto dava "Cannot access before initialization" no boot. O boot
     real do CI pegou isso na hora; sintaxe e lint passavam. */
  resolverProdutoPorSku: (...a) => resolverProdutoPorSku(...a),
});
const { magaluNivelColuna, magaluFreteTabela, magaluFreteSkuLer, magaluFreteSkuGravar,
        magaluDimSku, magaluFretePrevistoSku, magaluFreteProvisorio, MAGALU_FRETE_TABELA } = _magaluFrete;

// ─── PESCA os dados REAIS de um pedido direto na API do ML (fonte primária) ──────
// Dado o numero_loja, devolve { fee (comissão real via sale_fee), frete, venda (hora),
// credito, credito_fonte, logistica, pack, order, costs_ok } ou null se o ML não respondeu.
// Trata carrinho (pack), Flex (self_service: frete não é custo, é o motoboy; estorno = líquido)
// e compensações. Reusada pela pesca dos bipados (mlSyncFees) e pela fase ml_real (não-bipados).
/* 01/09: a pesca do ML saiu daqui pra lib/ml-pesca.js — eram TRÊS cópias e já tinham
   divergido (a da AMB tinha o conserto do crédito Flex de 25/08 que faltava aqui). A lib usa
   a versão mais nova; a função só depende dos próprios parâmetros. Dívida nº 3 do doc. */
const { pescarDadosML } = require('../lib/ml-pesca');
```

```js
/* 17/10 — A VENDA DO DIA É A PEÇA ÚNICA (lib/checkout/vendas-dia.js), nascida da versão da Girassol. A AMB entrega só
   o que é dela. Ganha as duas melhorias que só a Girassol tinha: a fase direta protegida (uma falha nela não derruba a
   rodada) e a versão do custo real do ML (ML_REAL_V = 2 — registro pescado sem a classificação do envio é repescado). */
let _vendasDiaAmb = null;
async function vendasSync() {
  /* 19/10 (Fase 3): a configuração desta empresa (envs, loja Shopee, Magalu, TikTok, token do ML) vem da peça única
     lib/checkout/config-empresa — aqui só as peças do módulo (deps) */
  if (!_vendasDiaAmb) _vendasDiaAmb = require('../lib/checkout/vendas-dia').criarVendasSyncDaEmpresa('amb', {
    deps: () => ({ CACHE_DIR, CONFERIDOS_FILE, LOJA_MKT, _faseDireta, _inferCanal, _vsy, blingGet, buscarDevolucoesML, json, magaluFreteProvisorio, magaluFreteSkuGravar, nfDoPedido, path, pescarDadosML, readJson, writeJson }),
    fetch,
  });
  return _vendasDiaAmb();
}
```

```js
const _faseDireta = require('../lib/checkout/fase-direta').criarFaseDireta({
  empresa: 'amb',
  mlTokenManager: () => require('../ambtotal/mlTokenManager'),
  shopeeKey: process.env.AMBBKP_SHOPEE_SYNC_KEY || process.env.SHOPEE_SYNC_KEY || '',
  shopeeUrlEnv: process.env.AMBBKP_SHOPEE_SYNC_URL || process.env.SHOPEE_SYNC_URL || 'https://girassol-shopee-sync-organizar-envio.onrender.com',
  shopeeLoja: process.env.AMBBKP_SHOPEE_SYNC_LOJA || 'amb',   // Codex P1: a URL do serviço Shopee usa a LOJA configurada, não o nome da empresa
  adminKey: process.env.ADMIN_KEY || '',
  porta: process.env.PORT || 3000,
  fetch,   // Codex P2: o MESMO node-fetch (com suporte a `timeout`) que o resto do arquivo usa
  log: console.log,
});
```

```js
// ═══ PESCA POSTERIOR (ML): busca tarifa REAL (sale_fee) e frete do vendedor nos pedidos ML
// recentes e grava no conferido (tarifa_ml / frete_ml). Roda no cron diário e sob demanda.
// Re-checa os finalizados dos últimos 3 dias mesmo se já têm tarifa (o ML pode ajustar depois).
/* 13/11 (plano multiloja, Fase 3 item 5): a pesca das tarifas do ML virou PEÇA ÚNICA (lib/checkout/ml-sync-fees.js) — o corpo
   era o mesmo na Girassol e na AMB. O que é DESTA empresa: o token do ML dela, a versão do marcador de custos que ela
   grava nos pedidos (1 — a marca simples: só relê quem não tem) e o estado da pesca (`_mls`, que as rotas de status leem). */
const _mlSyncFeesPeca = require('../lib/checkout/ml-sync-fees').criar({
  empresa: 'amb',
  versaoCustos: 1,
  garantirTokenML: () => require('../ambtotal/mlTokenManager').garantirTokenML(),
  get _mls() { return _mls; },
  set _mls(v) { _mls = v; },
  get CONFERIDOS_FILE() { return CONFERIDOS_FILE; },
  get readJson() { return readJson; },
  get writeJson() { return writeJson; },
});
async function mlSyncFees(dias) { return _mlSyncFeesPeca(dias); }
```

## `good-checkout-offline/index.js`

```js
// ─── VENDA DO DIA (19/10) — a MESMA peça da Girassol e da AMB (lib/checkout/vendas-dia.js) ─────────────────────
/* A GOOD não tinha a venda do dia (parecer de 15/10, item 5.2: "/vendas-sync: falta vendasSync"): o painel só via o
   que já tinha sido bipado. Agora a rotina traz TODAS as vendas do dia direto do Bling e dos marketplaces (ML, Shopee,
   Magalu, TikTok) e grava o _vendas_dia.json, como nas outras duas. Aqui fica só o que é da GOOD; as peças em volta
   vêm das mesmas libs que a AMB usa (fase direta, frete Magalu, pesca do ML, devoluções do ML, canal pelo nº). */
const _vsy = _estadoRotinas.vendas;
const _inferCanal = require('../lib/checkout/inferir-canal').inferirCanal;
const { pescarDadosML } = require('../lib/ml-pesca');
let _reparoAtivoGood = false;   /* a trava do sku-repara (o backfill e a caça da GOOD checam antes de começar — eram `() => false`) */
const _faseDireta = require('../lib/checkout/fase-direta').criarFaseDireta({
  empresa: 'good',
  mlTokenManager: () => require('../good/mlTokenManager'),
  shopeeKey: process.env.GOODBKP_SHOPEE_SYNC_KEY || process.env.SHOPEE_SYNC_KEY || '',
  shopeeUrlEnv: process.env.GOODBKP_SHOPEE_SYNC_URL || process.env.SHOPEE_SYNC_URL || 'https://girassol-shopee-sync-organizar-envio.onrender.com',
  shopeeLoja: process.env.GOODBKP_SHOPEE_SYNC_LOJA || 'good',
  adminKey: process.env.ADMIN_KEY || '',
  porta: process.env.PORT || 3000,
  fetch,
  log: console.log,
});
/* referência preguiçosa (como na AMB): resolverProdutoPorSku é const de outra lib e esta linha pode rodar antes dela */
/* 24/10: + o LEITOR do banco do frete real da Magalu por SKU (o mesmo arquivo que a venda do dia grava) — o backfill da
   GOOD usa pra prever o frete quando o Bling não traz (antes ia zerado e a margem da Magalu saía inflada) */
const { magaluFreteProvisorio, magaluFreteSkuGravar, magaluFreteSkuLer, magaluFretePrevistoSku } = require('../lib/checkout/magalu-frete').criar({
  CACHE_DIR, readJson, writeJson, blingGet, resolverProdutoPorSku: (...a) => resolverProdutoPorSku(...a),
});
let _vendasDiaGood = null;
async function vendasSync() {
  /* 19/10 (Fase 3): a configuração desta empresa (envs, loja Shopee, Magalu, TikTok, token do ML) vem da peça única
     lib/checkout/config-empresa — aqui só as peças do módulo (deps) */
  if (!_vendasDiaGood) _vendasDiaGood = require('../lib/checkout/vendas-dia').criarVendasSyncDaEmpresa('good', {
    deps: () => ({ CACHE_DIR, CONFERIDOS_FILE, LOJA_MKT, _faseDireta, _inferCanal, _vsy, blingGet, buscarDevolucoesML, json, magaluFreteProvisorio, magaluFreteSkuGravar, nfDoPedido, path, pescarDadosML, readJson, writeJson }),
    fetch,
  });
  return _vendasDiaGood();
}
```

```js
// ═══ PESCA POSTERIOR (ML): busca tarifa REAL (sale_fee) e frete do vendedor nos pedidos ML
// recentes e grava no conferido (tarifa_ml / frete_ml). Roda no cron diário e sob demanda.
// Re-checa os finalizados dos últimos 3 dias mesmo se já têm tarifa (o ML pode ajustar depois).
/* 13/11 (plano multiloja, Fase 3 item 5): a pesca das tarifas do ML da GOOD passa a ser a PEÇA ÚNICA
   (lib/checkout/ml-sync-fees.js), a mesma da Girassol e da AMB — saem daqui as 98 linhas da cópia. A cópia era a mesma
   rotina numa versão mais antiga (91 das 97 linhas de código dela existem na peça); entrar na peça é GANHAR o que as outras
   já tinham: os custos novos do ML por envio (o frete do vendedor vindo de /shipments/{id}/costs em vez da conta
   list_cost − cost), a logística do envio (Flex inclusive), o pedido e o pacote do ML gravados no conferido, e o marcador
   de versão (`ml_costs_v3`) que permite repescar tudo quando a regra mudar.
   `versaoCustos: 2` = a lógica atual, a mesma marca da Girassol. Como nenhum conferido da GOOD tem a marca ainda, a 1ª
   rodada depois do deploy repesca os pedidos ML dos últimos 14 dias (só chamadas ao Mercado Livre — nada de Bling). */
const _mlSyncFeesPeca = require('../lib/checkout/ml-sync-fees').criar({
  empresa: 'good',
  versaoCustos: 2,
  garantirTokenML: () => require('../good/mlTokenManager').garantirTokenML(),
  get _mls() { return _mls; },
  set _mls(v) { _mls = v; },
  get CONFERIDOS_FILE() { return CONFERIDOS_FILE; },
  get readJson() { return readJson; },
  get writeJson() { return writeJson; },
});
async function mlSyncFees(dias) { return _mlSyncFeesPeca(dias); }
```
