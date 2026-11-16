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
