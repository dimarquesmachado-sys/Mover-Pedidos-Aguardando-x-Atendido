# Histórico — o contexto do backfill montado à mão

Em 16/11/2026 (`docs/NORTE-2026-11.md`, item C — `montarCheckout(empresa)`, passo 9) o contexto do backfill da AMB e da GOOD
virou a peça `lib/checkout/backfill-empresa` (o motor único, rodado por `lib/checkout/backfill-rodar`, com o que é da empresa),
e a cópia das situações de cancelamento da AMB saiu (a peça `lib/checkout/situacoes-cancelamento` ganhou o env de contorno
por convenção). O texto abaixo é o que ficava em cada arquivo, guardado como estava.

## `amb-checkout-offline/index.js`

```js
/* 29/10 (passo 3b-2 do backfill único): o backfill da AMB é o COMPARTILHADO (o motor lib/checkout/backfill-motor, o mesmo
   da Girassol e da GOOD, com o andamento por empresa; 15/11: montado por lib/checkout/backfill-rodar, sem passar pela
   pasta da Girassol) — rodando com as fontes DELA no contexto. Era uma cópia de 690
   linhas que tinha divergido: faltavam aqui os desfechos (adiado/ja_rodando/abortado/transitório), a trava de segurança
   dos 60%, a espera longa no 429; e o que só havia aqui (vendas direto do ML com o token da empresa, a reserva da
   alíquota, o diagnóstico da UF, a caça da Magalu) entrou no compartilhado antes (3b-1 e #766). O andamento continua
   sendo o `_backfill` deste arquivo (passado no contexto) — todo o resto da AMB lê o mesmo objeto. */
function _ctxBackfillAmb() {
  return {
    estadoBackfill: _backfill,
    garantirSitCancel: (bg) => garantirSitCancel(bg),   /* o cache e o env AMBBKP_SIT_CANCELADO da AMB */
    ehFlex,   /* o classificador Flex da AMB (cache-dir 'amb' + SHOPEE_LOGISTICA_FLEX_EMPRESAS) */
    blingGet, readJson, CACHE_DIR, supaReq, supaCount,
    DEFAULT_ALIQ_BK, aliqReserva: 14.1,
    custoVigenteEm, mapasBilling: _mapasBilling,
    garantirTokenML: () => require('../ambtotal/mlTokenManager').garantirTokenML(),
    escrowEmLote, escrowDoPedido, LOJA_MKT,
    magaluFreteSkuLer: (typeof magaluFreteSkuLer === 'function') ? magaluFreteSkuLer : null,
    creditosFlex: (d1, d2) => _mlBilling.aplicarCreditosFlexNaFila(d1, d2),
    magaluLinhas: (d1, d2, e2, j2) => _cacaMgAmb.magaluLinhas(d1, d2, e2, j2),
    cacaMagaluRodando: () => _cacaMgAmb.estado().rodando,
    canarioRodando: () => !!(typeof _canario !== 'undefined' && _canario && _canario.rodando),
    reparoAtivo: () => !!_reparoAtivo,
  };
}
async function backfillVendas(de, ate) {   /* a assinatura de antes (de, ate, empresa): a empresa aqui é sempre a AMB */
  /* 15/11 (norte C: zero `require` cruzado): o motor único montado SEM empresa padrão (lib/checkout/backfill-rodar) — o
     contexto da AMB traz tudo; o que faltar é recusado com nome, nunca cai na Girassol */
  return require('../lib/checkout/backfill-rodar').backfillVendas(de, ate, 'amb', _ctxBackfillAmb());
}


let _sitCancel = { ids: [], nomes: [], ts: 0, erro: null };

async function garantirSitCancel(bg) {
  if (_sitCancel.ids.length && (Date.now() - _sitCancel.ts) < 12 * 3600 * 1000) return _sitCancel;
  try {
    const rm = await bg('/situacoes/modulos');
    const mods = (rm.ok && rm.data && rm.data.data) || [];
    const modVenda = mods.find(m => /venda/i.test(String(m.nome || m.descricao || ''))) || mods[0];
    if (modVenda && modVenda.id) {
      const rs = await bg('/situacoes/modulos/' + modVenda.id);
      const sits = (rs.ok && rs.data && rs.data.data) || [];
      const canc = sits.filter(x => /cancel/i.test(String(x.nome || x.descricao || '')));
      if (canc.length) {
        _sitCancel = { ids: canc.map(x => Number(x.id)).filter(Boolean), nomes: canc.map(x => x.nome), ts: Date.now(), erro: null };
        console.log('[CANCEL] situações de cancelamento no Bling: ' + _sitCancel.nomes.join(', ') + ' (ids ' + _sitCancel.ids.join(',') + ')');
        return _sitCancel;
      }
      _sitCancel.erro = 'nenhuma situação com "cancel" no nome (módulo ' + (modVenda.nome || modVenda.id) + ')';
    } else _sitCancel.erro = 'não achei o módulo de vendas';
  } catch (e) { _sitCancel.erro = String(e.message || e); }
  // fallback: permite fixar na mão por env, se um dia a descoberta falhar
  if (!_sitCancel.ids.length && process.env.AMBBKP_SIT_CANCELADO) {
    _sitCancel.ids = String(process.env.AMBBKP_SIT_CANCELADO).split(',').map(x => Number(x.trim())).filter(Boolean);
    _sitCancel.nomes = ['(definido em AMBBKP_SIT_CANCELADO)'];
  }
  _sitCancel.ts = Date.now();
  if (_sitCancel.erro) console.log('[CANCEL] ⚠️ ' + _sitCancel.erro);
  return _sitCancel;
}
```

## `good-checkout-offline/index.js`

```js
/* 14/10 (parecer do Codex, 6.1): o contexto do backfill da GOOD num lugar so (periodo e ano tinham
   duas copias). Alem de Bling/cache/Supabase/aliquotas, leva as dependencias FINANCEIRAS da GOOD —
   custo na data da venda, token do ML, loja->canal, contador do Supabase — e declara SEM (null) as
   que a GOOD ainda nao produz: billing do ML, escrow da Shopee e banco de frete do Magalu. Sem elas o
   backfill fica com o que o Bling da GOOD trouxe, em vez de cair nas fontes da Girassol (era o que
   acontecia: linha empresa='good' com custo/comissao/frete da Girassol). Ligar cada uma = trocar o
   null pela fonte da GOOD quando ela existir. */
function _ctxBackfillGood() {
  const supa = require('../lib/supabase').para('good');
  return {
    blingGet, readJson, CACHE_DIR,
    ehFlex,   /* Codex #770: o classificador Flex da GOOD (SHOPEE_LOGISTICA_FLEX_EMPRESAS=good vale pra ela, não pra Girassol) */
    /* 29/10: a caça de vendas da Magalu DA GOOD entra na reconstrução (sem ela, o backfill apagaria o que a caça recuperou),
       e o backfill não começa com a caça gravando */
    magaluLinhas: (d1, d2, e2, j2) => _cacaMgGood.magaluLinhas(d1, d2, e2, j2),
    cacaMagaluRodando: () => _cacaMgGood.estado().rodando,
    canarioRodando: () => _canGood.estado.rodando,   /* 23/10 (Codex #731): TODO backfill da GOOD (manual, diário, plano, ano) respeita o canário dela */
    reparoAtivo: () => !!_reparoAtivoGood,   /* 16/11: e a trava do sku-repara dela (como a Girassol e a AMB) */
    supaReq: (empresa, metodo, pq, body) => supa.req(empresa, metodo, pq, body),
    supaCount: (empresa, filtro) => supa.count(empresa, filtro),
    DEFAULT_ALIQ_BK: DEFAULT_ALIQ_BK_GOOD,
    custoVigenteEm: (sku, data) => custoVigenteEm(sku, data),   /* 16/11: pela peça do custo (lib/checkout/custo-empresa) */
    garantirTokenML: () => require('../good/mlTokenManager').garantirTokenML(),
    LOJA_MKT,
    /* 19/10 (Codex #720): o faturamento do ML existe na GOOD (lib/checkout/ml-billing) — o backfill usa a comissão e o
       frete oficiais dele, e redistribui os créditos do Flex no período depois da troca */
    mapasBilling: () => _mlBillingGood.mapasBilling(),
    creditosFlex: (de, ate) => _mlBillingGood.aplicarCreditosFlexNaFila(de, ate),
    /* 27/10: o REPASSE REAL da Shopee (escrow) pela peça da GOOD (loja 'good' no serviço) — a venda da Shopee passa a sair
       com a comissão e as taxas do repasse, como na Girassol e na AMB, e não com a estimativa do Bling (lazy: a peça
       nasce mais abaixo neste arquivo) */
    escrowEmLote: (...a) => escrowEmLoteShopeeGood(...a), escrowDoPedido: (...a) => escrowDoPedidoShopeeGood(...a),
    /* 24/10: a previsão do frete da Magalu (média do frete REAL do SKU, banco da GOOD) quando o Bling não traz o frete —
       igual à Girassol e à AMB; o real substitui quando o pedido liquida */
    magaluFreteSkuLer: (...a) => magaluFreteSkuLer(...a),
  };
}
```

## `girassol-backup-offline/gbo-app.js` (16/11, montarCheckout passo 10)

A Girassol deixou de montar o motor com os padrões dela e passou a rodar pela mesma peça. O que saiu do arquivo:

```js
const _estadoBackfill = _ESTADO.estado;
const _reiniciarEstadoBackfill = _ESTADO.reiniciar;

// ─── 04/08: CASCATA DA COMISSAO no backfill ──────────────────────────────────────────────────
// O ramo do Bling gravava SO `det.taxas.taxaComissao`. Quando o Bling nao importava a taxa, ia
// ZERO pro Supabase e a margem daquele pedido saia inflada — 2.956 pedidos de jan-jul, ~R$ 117
// mil de comissao que nunca foi descontada. Rodar o backfill de novo NAO resolvia: relia o mesmo
// zero (e pior: o DELETE do periodo apagava o que a pescaria tinha consertado).
// Agora, quando a taxa do Bling vier zero num pedido do ML, a ordem e:
//   1) faturamento oficial do ML (_ml_billing.json) — o que o ML DE FATO debitou
//   2) sale_fee da API de vendas — existe desde o instante da venda
//   3) o que veio do Bling (zero)
// Os outros dois caminhos de escrita (vendasSync e mlSyncFees) ja faziam isso; faltava aqui.
// 05/08: alem da comissao, devolve o FRETE. E o PARCELAMENTO entra na comissao —
// a documentacao do proprio ML descreve as tarifas de uma venda como intermediacao
// (comissao) + processamento do pagamento (Mercado Pago) + parcelamento/antecipacao
// quando aplicavel. Sao os tres custos DA VENDA, entao pertencem ao pedido, nao ao mes.
// Sem isso eram R$ 84.671,54 no ano que a margem simplesmente nao via.
/* 04/09 — o mapa agora vem de lib/ml-billing-mapa.js, que lê o billing em STREAM e guarda
   um índice pequeno em disco. O jeito antigo dava JSON.parse no _ml_billing.json inteiro —
   96.293 tarifas, 26 MB de heap POR CHAMADA, em 7 pontos do arquivo. Foi isso que estourou
   os 512 MB do Render e derrubou o serviço 5 vezes entre 03 e 04/09 (status 134), inclusive
   com o backfill tendo varrido só 14 pedidos. Agora: 8 MB na primeira montagem, 3 ms nas
   seguintes. Continua síncrono pra quem chama — o await fica aqui dentro. */
async function _mapasBilling() { return _mlBilling.mapasBilling(); }   /* 19/10: a regra mora na peça lib/checkout/ml-billing */
// 1 chamada por venda (o pescarDadosML faz 3-4 e so o sale_fee interessa aqui)
const _feeMLLeve = require('../lib/checkout/ml-fee-leve').feeMLLeve;   /* 15/11 (norte C): a mesma função da AMB virou peça */
// 06/08: por padrao a cascata da Shopee so entra quando o Bling nao trouxe a taxa
// (mesma regra do ML). Com SHOPEE_ESCROW_TODOS=1 ela passa a valer pra TODO pedido
// de Shopee — o escrow e mais confiavel que a taxa do Bling, mas custa 1 chamada
// por pedido, entao a decisao fica explicita e reversivel por env var.
const SHOPEE_TODOS = String(process.env.SHOPEE_ESCROW_TODOS || '') === '1';


/* 13/11 (plano multiloja, Fase 3 item 5): o MOTOR do histórico de vendas saiu deste arquivo pra peça
   lib/checkout/backfill-motor.js — o corpo é o mesmo, byte a byte. Aqui fica só a montagem: o que o motor usava DESTE
   arquivo (os padrões de quando quem chama não traz `ctx` — ou seja, a própria Girassol) vai por acessores, lidos a cada
   rodada. A AMB e a GOOD seguem chamando o `backfillVendas` daqui com o contexto delas, como sempre. */
const _backfillMotorPeca = require('../lib/checkout/backfill-motor').criar({
  /* o token do ML que vale quando quem chama não traz o dele (ou seja, a Girassol) — o `require` fica dentro da chamada, como era */
  garantirTokenML: () => require('../girassol/mlTokenManager').garantirTokenML(),
  get CACHE_DIR() { return CACHE_DIR; },
  get DEFAULT_ALIQ_BK() { return DEFAULT_ALIQ_BK; },
  get LOJA_MKT() { return LOJA_MKT; },
  get SHOPEE_TODOS() { return SHOPEE_TODOS; },
  get _cacaMgGir() { return _cacaMgGir; },
  get _canario() { return _canario; },
  get _estadoBackfill() { return _estadoBackfill; },
  get _feeMLLeve() { return _feeMLLeve; },
  get _inferCanal() { return _inferCanal; },
  get _mapasBilling() { return _mapasBilling; },
  get _mlBilling() { return _mlBilling; },
  get _reiniciarEstadoBackfill() { return _reiniciarEstadoBackfill; },
  get _reparoAtivo() { return _reparoAtivo; },
  get blingGet() { return blingGet; },
  get contasDoEscrow() { return contasDoEscrow; },
  get custoVigenteEm() { return custoVigenteEm; },
  get ehFlex() { return ehFlex; },
  get escrowDoPedido() { return escrowDoPedido; },
  get escrowEmLote() { return escrowEmLote; },
  get garantirSitCancel() { return garantirSitCancel; },
  get magaluFreteSkuLer() { return magaluFreteSkuLer; },
  get readJson() { return readJson; },
  get servicoDoPedido() { return servicoDoPedido; },
  get supaCount() { return supaCount; },
  get supaReq() { return supaReq; },
});
async function backfillVendas(de, ate, empresa, ctx){ return _backfillMotorPeca(de, ate, empresa, ctx); }
```

## O resgate do histórico montado à mão (16/11, montarCheckout passo 11)

O contexto do resgate do histórico (`lib/checkout/backfill-resgate`) virou `resgatarHistorico(plano)` da peça
`lib/checkout/backfill-empresa`. A Girassol e a AMB o montavam na madrugada (iguais, menos a caça da Magalu); a GOOD na rotina
diária, com a vaga do registro mas sem esperar o canário, o reparo de SKU e a caça dela (a peça espera — nivelado por cima).

### `girassol-backup-offline/gbo-app.js` (na montagem da madrugada)

```js
  /* 14/10: resgate do historico — pedido que nasce hoje com data de venda antiga (boleto/Pix
     tardio) ficava fora da janela de 3 dias pra sempre. A peca descobre os dias e manda o
     backfill de producao rodar cada um. Regra em lib/checkout/backfill-resgate.js */
  resgatarHistorico: (plano) => require('../lib/checkout/backfill-resgate').resgatar({ empresa: 'girassol', blingGet, supaReq, backfillVendas, backfillEstado,
    /* Codex #683 (P1): as DUAS fontes de cancelado que o backfill usa, senao cancelado vira 'faltando' pra sempre */
    situacoesCanceladas: async () => (await garantirSitCancel(async p => await blingGet(p))).ids,   /* r5: a funcao exige o getter — sem ele devolvia lista vazia */
    canceladosMkt: () => new Set(Object.keys(readJson(path.join(CACHE_DIR, '_cancelados_shopee.json'), {}))),
    /* Codex #683 r2 (P1): a listagem do resgate segura a MESMA vaga do backfill (_backfill.rodando),
       senao um backfill manual iniciado no meio disputaria a cota. Libera antes de cada dia e no finally */
    /* Codex #683 r3 (P1): as OUTRAS travas de cota tambem valem — canario conferindo o Bling e a
       rodada do ano (que entre um mes e outro deixa _backfill.rodando=false por 2,5s) */
    reservar: (msg) => { if (_backfill.rodando || _canario.rodando || _reparoAtivo || _cacaMgGir.estado().rodando) return false;   /* a caca da Magalu (_mgc) so existe na AMB */   /* r4: sku-repara tambem */ _backfill.rodando = true; _backfill.fase = 'resgate'; _backfill.msg = msg || 'resgate'; return true; },
    liberar: () => { if (_backfill.rodando && _backfill.fase === 'resgate') { _backfill.rodando = false; _backfill.fase = 'resgate-liberado'; } },
    cacheDir: CACHE_DIR }, plano), 
```

### `amb-checkout-offline/index.js` (na montagem da madrugada)

```js
  /* 14/10: resgate do historico — pedido que nasce hoje com data de venda antiga (boleto/Pix
     tardio) ficava fora da janela de 3 dias pra sempre. A peca descobre os dias e manda o
     backfill de producao rodar cada um. Regra em lib/checkout/backfill-resgate.js */
  resgatarHistorico: (plano) => require('../lib/checkout/backfill-resgate').resgatar({ empresa: 'amb', blingGet, supaReq, backfillVendas, backfillEstado,
    /* Codex #683 (P1): as DUAS fontes de cancelado que o backfill usa, senao cancelado vira 'faltando' pra sempre */
    situacoesCanceladas: async () => (await garantirSitCancel(async p => await blingGet(p))).ids,   /* r5: a funcao exige o getter — sem ele devolvia lista vazia */
    canceladosMkt: () => new Set(Object.keys(readJson(path.join(CACHE_DIR, '_cancelados_shopee.json'), {}))),
    /* Codex #683 r2 (P1): a listagem do resgate segura a MESMA vaga do backfill (_backfill.rodando),
       senao um backfill manual iniciado no meio disputaria a cota. Libera antes de cada dia e no finally */
    /* Codex #683 r3 (P1): as OUTRAS travas de cota tambem valem — canario conferindo o Bling e a
       rodada do ano (que entre um mes e outro deixa _backfill.rodando=false por 2,5s) */
    reservar: (msg) => { if (_backfill.rodando || _canario.rodando || _reparoAtivo || (_cacaMgAmb.estado() && _cacaMgAmb.estado().rodando)) return false;   /* r4: sku-repara tambem */ _backfill.rodando = true; _backfill.fase = 'resgate'; _backfill.msg = msg || 'resgate'; return true; },
    liberar: () => { if (_backfill.rodando && _backfill.fase === 'resgate') { _backfill.rodando = false; _backfill.fase = 'resgate-liberado'; } },
    cacheDir: CACHE_DIR }, plano),
```

### `good-checkout-offline/index.js` (na rotina diária do histórico)

```js
      resgatar: (plano) => resg.resgatar({
        empresa: 'good', blingGet, supaReq: ctx.supaReq,
        backfillVendas: (d1, d2) => _rodar.backfillVendas(d1, d2, 'good', ctx),
        backfillEstado: () => _est.foto('good'),   /* 29/10 (3a): a vaga e o andamento DA GOOD */
        reservar: (m) => _est.reservarVaga(m, 'good'), liberar: () => _est.liberarVaga('good'),
        /* situações de cancelamento DA GOOD (cache por empresa desde o #686; 15/11: na peça) e o tombstone dela */
        situacoesCanceladas: async () => ((await _sit.garantirSitCancel(async p2 => await blingGet(p2), 'good')) || {}).ids || [],
        canceladosMkt: () => new Set(Object.keys(readJson(path.join(CACHE_DIR, '_cancelados_shopee.json'), {}))),
        cacheDir: CACHE_DIR }, plano),
```
