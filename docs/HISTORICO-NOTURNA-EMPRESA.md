# Histórico — o contexto da madrugada montado à mão

Em 17/11/2026 (`docs/NORTE-2026-11.md`, item C — `montarCheckout(empresa)`, passo 12) o contexto da madrugada das três virou a
peça: `require('lib/checkout/noturna-empresa').criar({ empresa, pecas, historico? })` monta o que cada arquivo escrevia à mão
(o prefixo e o token do ML saem do contrato da empresa; o resto das peças dela). Os embrulhos de uma linha da Girassol e da AMB
(`girassol-backup-offline/noturna.js`, `amb-checkout-offline/amb-noturna.js` — só punham a empresa e o prefixo) saíram. O que
mudou de comportamento:

- **GOOD**: a etapa da poda do bucket aparece dizendo que roda na madrugada da Girassol (como a AMB já mostrava); a correção da
  tarifa do TikTok deixa de ter a trava própria — a madrugada já pula essa etapa com o backfill da GOOD em curso (lê o
  andamento dela logo antes de chamar), então a trava de dentro nunca era alcançada pela madrugada.
- **Girassol e AMB**: nada (as mesmas peças, pelo mesmo caminho).

O texto abaixo é o que ficava em cada arquivo, guardado como estava.

## `girassol-backup-offline/noturna.js` (o embrulho)

```js
'use strict';
// noturna.js -- a rotina da madrugada: a MADRUGADA ÚNICA lib/checkout/noturna-empresa (26/10/2026: era cópia na
// Girassol e na AMB, com as etapas em ordens diferentes). Aqui só a empresa e o prefixo das rotas; as peças vêm do contexto.
const { criarNoturna: _criar } = require('../lib/checkout/noturna-empresa');
function criarNoturna(ctx) { return _criar(Object.assign({}, ctx, { empresa: 'girassol', prefixo: '/girassol-backup-offline' })); }
module.exports = { criarNoturna };
```

## `amb-checkout-offline/amb-noturna.js` (o embrulho)

```js
'use strict';
// amb-noturna.js -- a rotina da madrugada: a MADRUGADA ÚNICA lib/checkout/noturna-empresa (26/10/2026: era cópia na
// Girassol e na AMB, com as etapas em ordens diferentes). Aqui só a empresa e o prefixo das rotas; as peças vêm do contexto.
const { criarNoturna: _criar } = require('../lib/checkout/noturna-empresa');
function criarNoturna(ctx) { return _criar(Object.assign({}, ctx, { empresa: 'amb', prefixo: '/amb-checkout-offline' })); }
module.exports = { criarNoturna };
```

## `girassol-backup-offline/gbo-app.js`

```js
// ─── 05/08: rotina noturna — encadeia billing, backfill, pesca, cancelados, poda e canário ───
const { criarNoturna } = require('./noturna');
// 14/08: ads vem da lib compartilhada; o wrapper injeta o ctx da empresa (mesmo padrão
// dos outros coletores) pra rotina noturna poder chamar sem saber de detalhe nenhum.
const _adsLib = require('../lib/shopee-ads');
const coletarAds = dias => _adsLib.coletarAds({ CACHE_DIR, readJson, writeJson, path, pedirAoSync }, dias);
// (…)
const _consertarDoCanario = (...a) => _canEmp.consertar(...a);
// (…)
const _noturna = criarNoturna({
  /* 14/11: a foto diária da reputação do Mercado Livre (lib/checkout/reputacao-ml) precisa do token do ML DESTA empresa */
  garantirTokenML: () => require('../girassol/mlTokenManager').garantirTokenML(),
  /* 15/11: a foto diária da saúde da conta na Shopee (lib/checkout/saude-shopee) precisa do pedido à Shopee DESTA empresa */
  pedirAoSync: (...a) => pedirAoSync(...a),
  mlBillingSync, backfillVendas, backfillEstado, mlSyncFees, varrerCancelados,
  /* 14/10: resgate do historico (pedido que nasce hoje com data de venda antiga — boleto/Pix tardio). 16/11 (montarCheckout,
     passo 11): o contexto dele é o da peça da empresa (lib/checkout/backfill-empresa), o mesmo da AMB e da GOOD */
  resgatarHistorico: (plano) => _bfEmp.resgatarHistorico(plano),
  // 11/08 (herdado da AMB): o canário PRECISA do contexto — sem ele rotasCanario(undefined)
  // explodia no destructure, o catch engolia, e a etapa noturna dizia "conferido" sem ter
  // conferido NADA. Estava mudo aqui desde que a noturna existe.
  /* 06/09: depois de conferir, o canário CONSERTA o que dá — pouca venda fora do Bling volta
     sozinha; muita falta vira aviso na tela, porque aí é integração e precisa de você. */
  canarioCron: () => canarioCron({ VERSAO, validarSessao }),   /* 26/10: o canário das INTEGRAÇÕES não devolve resultado — o conserto saiu daqui */
  cacheDir: CACHE_DIR,   /* 27/10: os dias da Shopee sem repasse (lib/checkout/repasse-pendente) */
  consertarDoCanario: (r) => _consertarDoCanario(r),   /* 26/10: a noturna passa o resultado da conferência marketplace × Bling (como a AMB) */
  podarExpedicao,
  // 06/08: a Shopee tambem passa a se manter sozinha — devolucoes (por SKU e motivo) e
  // carteira (ads, ajustes, reembolsos), as duas em janelas de 15 dias, guardando no disco.
  coletarDevolucoes: (d) => coletarDevolucoes(d || 45, pedirAoSync),
  conferirMarketplaces,   // 16/08: canário marketplace × Bling na rotina
  completarTarifaTikTok,   // 18/08: corrige a tarifa das vendas que já liquidaram
  coletarFinanceiroTikTok,   // 16/08: mantém o cache do TikTok fresco (tarifa real + hora da venda)
  coletarAds,   // 14/08: ads da Shopee também se mantém sozinho
  coletarCarteira:   (d) => coletarCarteira(d || 30, pedirAoSync),
  VERSAO, validarSessao, ehAdmin, json
});
```

## `amb-checkout-offline/index.js`

```js
// ─── 05/08: rotina noturna — encadeia billing, backfill, pesca, cancelados, poda e canário ───
const { criarNoturna } = require('./amb-noturna');
// 14/08: ads vem da lib compartilhada; o wrapper injeta o ctx da empresa (mesmo padrão
// dos outros coletores) pra rotina noturna poder chamar sem saber de detalhe nenhum.
const _adsLib = require('../lib/shopee-ads');
const coletarAds = dias => _adsLib.coletarAds({ CACHE_DIR, readJson, writeJson, path, pedirAoSync }, dias);
// (…)
const _noturna = criarNoturna({
  /* 14/11: a foto diária da reputação do Mercado Livre (lib/checkout/reputacao-ml) precisa do token do ML DESTA empresa */
  garantirTokenML: () => require('../ambtotal/mlTokenManager').garantirTokenML(),
  /* 15/11: a foto diária da saúde da conta na Shopee (lib/checkout/saude-shopee) precisa do pedido à Shopee DESTA empresa */
  pedirAoSync: (...a) => pedirAoSync(...a),
  // 10/08 (Codex P2): o canário PRECISA do contexto — sem ele, rotasCanario(undefined)
  // explodia no destructure, o catch engolia, e a etapa noturna dizia "conferido"
  // sem ter conferido NADA. (A Girassol tem o mesmo defeito — consertar lá também.)
  mlBillingSync, backfillVendas, backfillEstado, mlSyncFees, varrerCancelados,
  /* 14/10: resgate do historico (pedido que nasce hoje com data de venda antiga — boleto/Pix tardio). 16/11 (montarCheckout,
     passo 11): o contexto dele é o da peça da empresa (lib/checkout/backfill-empresa), o mesmo da Girassol e da GOOD */
  resgatarHistorico: (plano) => _bfEmp.resgatarHistorico(plano),
  canarioCron: () => canarioCron({ VERSAO, validarSessao }),
      // AMB: a poda do bucket de expedição roda UMA vez, na noturna da Girassol (bucket é compartilhado)
      podarExpedicao: async () => ({ ok: true, pulado: 'poda do bucket roda na noturna da Girassol' }),
  // 06/08: a Shopee tambem passa a se manter sozinha — devolucoes (por SKU e motivo) e
  // carteira (ads, ajustes, reembolsos), as duas em janelas de 15 dias, guardando no disco.
  coletarDevolucoes: (d) => coletarDevolucoes(d || 45, pedirAoSync),
  conferirMarketplaces,   // 17/08: canário marketplace × Bling também na AMB
  consertarDoCanario: (r) => _canEmp.consertar(r),   // 23/10 (Codex #731): a noturna registra o resultado (o aviso do painel lê o histórico)
  completarTarifaTikTok,   // 18/08: corrige a tarifa das vendas que já liquidaram
  coletarFinanceiroTikTok,   // Codex #123 (P1): sem passar aqui, a etapa de coleta da noturna era PULADA na AMB e o cache nunca se atualizava sozinho
  cacheDir: CACHE_DIR,   /* 27/10: os dias da Shopee sem repasse (lib/checkout/repasse-pendente) */
  coletarAds,   // 14/08: ads da Shopee também se mantém sozinho
  coletarCarteira:   (d) => coletarCarteira(d || 30, pedirAoSync),
  VERSAO, validarSessao, ehAdmin, json
});
```

## `good-checkout-offline/index.js`

```js
const coletarAdsShopeeGood = (dias) => require('../lib/shopee-ads').coletarAds({ CACHE_DIR, readJson, writeJson, path, pedirAoSync: pedirAoSyncShopeeGood }, dias);
// (…)
// ─── MADRUGADA ÚNICA (27/10) — a MESMA rotina da Girassol e da AMB (lib/checkout/noturna-empresa) ───────────────
/* Antes a GOOD tinha tarefas soltas na subida do servidor (uma por PR); agora as mesmas etapas das outras, na mesma ordem,
   ligadas conforme o que ela tem. Sem o módulo da Shopee (devoluções, carteira, Ads), sem o resgate do histórico (vai com
   a unificação do backfill) e sem a poda do bucket (é o mesmo bucket, as outras podam): essas etapas não aparecem. O
   backfill dos últimos dias é a rotina diária da GOOD (respeita GOOD_DIARIO_HISTORICO=0 e as travas dela). */
function _backfillGoodOcupado() {
  let gOc = false;
  try { gOc = !!require('../lib/checkout/backfill-estado').ocupado('good'); } catch (e) {}   /* 29/10 (3a): o DA GOOD; 15/11: pela peça */
  return !!((_bfGood && _bfGood.estado === 'rodando') || (_diarioGood && _diarioGood.estado === 'rodando') || gOc);
}
const _noturnaGood = require('../lib/checkout/noturna-empresa').criarNoturna({
  empresa: 'good', prefixo: '/good-checkout-offline',
  /* 14/11: a foto diária da reputação do Mercado Livre (lib/checkout/reputacao-ml) precisa do token do ML DESTA empresa */
  garantirTokenML: () => require('../good/mlTokenManager').garantirTokenML(),
  /* 15/11: a foto diária da saúde da conta na Shopee (lib/checkout/saude-shopee) precisa do pedido à Shopee DESTA empresa */
  pedirAoSync: (...a) => pedirAoSyncShopeeGood(...a),
  mlBillingSync: (...a) => mlBillingSync(...a),
  backfillVendas: async () => {
    const r = await rodarDiarioHistoricoGood('noturna');
    if (r && r.estado === 'desligado') return { ok: false, msg: 'GOOD_DIARIO_HISTORICO=0 (a rotina diária do histórico está desligada)' };
    /* a rotina devolve estado 'ok' ou 'parou' (com `motivo`), nunca 'erro' e sem `ok`: só 'ok' vale como feito */
    if (!r || r.estado !== 'ok') return Object.assign({}, r || {}, { ok: false, msg: (r && (r.motivo || r.msg)) || ('rotina diária terminou como "' + ((r && r.estado) || 'sem resposta') + '"') });
    return Object.assign({}, r, { ok: true });
  },
  backfillEstado: () => {
    return { rodando: _backfillGoodOcupado(), de: (_bfGood && _bfGood.de) || null, ate: (_bfGood && _bfGood.ate) || null };
  },
  mlSyncFees: (...a) => mlSyncFees(...a),
  varrerCancelados: (dias) => varrerCancelados(dias),
  coletarFinanceiroTikTok: (...a) => coletarFinanceiroTikTokGood(...a),
  /* a correção da tarifa PATCHa linhas do histórico pelo id, e o backfill as substitui: com qualquer backfill da GOOD
     rodando (mês, plano do ano, rotina diária ou a vaga compartilhada) a etapa acusa em vez de correr por cima dele */
  completarTarifaTikTok: async (...a) => {
    if (_backfillGoodOcupado()) return { ok: false, erro: 'backfill da GOOD em curso — a correção da tarifa fica pra próxima madrugada' };
    return completarTarifaTikTokGood(...a);
  },
  conferirMarketplaces: (dias) => _canGood.conferir(dias, [], {}),
  consertarDoCanario: (r) => _canGood.consertar(r),
  canarioCron: () => canarioCronIntegracoes({ VERSAO, validarSessao }),
  /* 27/10: a Shopee da GOOD — as mesmas etapas da AMB (devoluções 45 dias, carteira 30, Ads 35) */
  coletarDevolucoes: (d) => coletarDevolucoesShopeeGood(d || 45, pedirAoSyncShopeeGood),
  coletarCarteira: (d) => coletarCarteiraShopeeGood(d || 30, pedirAoSyncShopeeGood),
  coletarAds: (d) => coletarAdsShopeeGood(d),
  /* 27/10: os dias da Shopee sem repasse — o backfill de UM dia da GOOD, com o estado e a trava dela (como a fatia do plano) */
  cacheDir: CACHE_DIR,
  backfillDia: async (dia) => {
    if (_backfillGoodOcupado()) return { ok: false, msg: 'backfill da GOOD em curso' };
    _bfGood = { estado: 'rodando', de: dia, ate: dia, pelo: 'repasse da Shopee pendente', iniciado: new Date().toISOString() };
    let x;
    try { x = await require('../lib/checkout/contexto-fundo').emFundo('good', () => _bfEmp.backfillVendas(dia, dia)); }
    catch (e) { _bfGood = { estado: 'parou', de: dia, ate: dia, motivo: String(e.message || e) }; throw e; }
    _bfGood = { estado: (x && x.ok !== false && x.desfecho !== 'com_erros') ? 'ok' : 'parou', de: dia, ate: dia, desfecho: x && x.desfecho, pelo: 'repasse da Shopee pendente' };
    return x;
  },
  VERSAO, validarSessao, ehAdmin, json,
});
```
