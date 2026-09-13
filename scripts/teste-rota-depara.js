'use strict';
/* Fatia 8 (13/09): a rota do de-para de SKU. O CRUD é o de menos — o que precisa de guarda
   são as travas aprendidas em revisão, que existiam em duas cópias e agora vivem numa só:
   apagar tem que remover TODAS as grafias (um par gravado "Pm1" sobrevivia a um apagar
   "pm1" e a rota ainda respondia ok, então parecia apagado e não estava), e declarar um par
   tem que recusar ciclo, senão a resolução entra em loop. */
const assert = require('assert');
const path = require('path');
const { criarRotaDeParaSku } = require('../lib/checkout/rota-depara-sku');

process.env.ADMIN_KEY = 'CHAVE';
let mapa = {};
const rota = criarRotaDeParaSku({
  prefixo: '/x', path, CACHE_DIR: '/tmp', json: (res, st, obj) => { res._st = st; res._body = obj; },
  readJson: (p, d) => d, validarSessao: () => null, ehAdmin: () => false,
  lerDeParaSku: () => mapa, gravarDeParaSku: (m) => { mapa = m; },
  resolverDeParaSku: (s) => (mapa[s] ? mapa[s].para : null), sugerirDeParaSku: () => [],
});
const chamar = async (qs, method = 'GET', body = null) => {
  const req = { headers: {}, on: (ev, fn) => { if (ev === 'data' && body) fn(Buffer.from(JSON.stringify(body))); if (ev === 'end') fn(); } };
  const res = {};
  const url = new URL('https://x/x/sku-depara-manual' + qs);
  await rota(req, res, url, method, '/x/sku-depara-manual');
  return res;
};

(async () => {
  assert.throws(() => criarRotaDeParaSku({}), /falta /);

  // sem chave: 404 (não revela que a rota existe)
  let r = await chamar('?de=A&para=B');
  assert.strictEqual(r._st, 404, 'sem chave tem que ser 404');

  // declara o par
  r = await chamar('?de=VELHO&para=NOVO&k=CHAVE');
  assert.strictEqual(r._body.ok, true);
  assert.strictEqual(mapa.VELHO.para, 'NOVO');

  // par igual é recusado
  r = await chamar('?de=X&para=x&k=CHAVE');
  assert.strictEqual(r._body.ok, false, 'de e para iguais não podem ser aceitos');

  // CICLO: NOVO → VELHO fecharia o laço
  r = await chamar('?de=NOVO&para=VELHO&k=CHAVE');
  assert.strictEqual(r._body.ok, false, 'ciclo tem que ser recusado');
  assert.ok(/ciclo/i.test(String(r._body.erro)));

  // apagar remove TODAS as grafias (a trava que a revisão #185/#186 trouxe)
  mapa = { 'Pm1': { para: 'Z' }, 'PM1': { para: 'Z' }, 'outro': { para: 'W' } };
  r = await chamar('?k=CHAVE', 'POST', { apagar: 'pm1' });
  assert.strictEqual(r._body.ok, true);
  assert.deepStrictEqual(Object.keys(mapa), ['outro'], 'as duas grafias tinham que sair: ' + JSON.stringify(mapa));

  console.log('OK: rota do de-para — 404 sem chave, declara, recusa par igual e ciclo, e apagar remove TODAS as grafias');
})().catch(e => { console.error('FALHOU:', e.message); process.exit(1); });
