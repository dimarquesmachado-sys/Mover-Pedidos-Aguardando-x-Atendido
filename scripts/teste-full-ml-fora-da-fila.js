'use strict';
/* 15/10 — venda FULL do ML que o Bling gravou como loja comum (AMB, 13-15/10: loja MLivre, unidade Matriz)
   caía na fila do galpão como "sem etiqueta". Prova: (1) nos três ciclo.js, antes de pedir a etiqueta ao
   ML, o tipo do envio é consultado e "fulfillment" marca o pedido (full_ml) sem pedir etiqueta; o campo vai
   pro manifesto e o resumo do topo não conta como problema; (2) a /lista DE PRODUÇÃO das três empresas
   tira o Full da fila de sem etiqueta e devolve à parte; (3) o painel mostra o aviso. */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const raiz = path.join(__dirname, '..');
for (const [emp, ciclo, painel] of [['AMB', 'amb-checkout-offline/ciclo.js', 'amb-checkout-offline/painel.html'], ['GOOD', 'good-checkout-offline/ciclo.js', 'good-checkout-offline/painel.html'], ['Girassol', 'girassol-backup-offline/ciclo.js', 'girassol-backup-offline/painel.html']]) {
  const src = require('./_fonte-ciclo').ler(raiz, ciclo);   /* 30/10: o ciclo como a empresa o roda (peça única) */
  const iShip = src.indexOf('const shipmentId = await getShipmentInfo(tokenML, ped.numeroLoja);');
  const iLog = src.indexOf("https://api.mercadolibre.com/shipments/${shipmentId}`", iShip);
  const iFul = src.indexOf("if (_logiML === 'fulfillment') {", iShip);
  const iLab = src.indexOf('https://api.mercadolibre.com/shipment_labels', iShip);
  assert.ok(iShip > 0 && iLog > iShip && iFul > iLog && iLab > iFul, emp + ': o tipo do envio tem que ser consultado ANTES de pedir a etiqueta');
  assert.ok(/\} else \{\s*\n(\s*if \(_stOk\) _aguardaDispML = false;[^\n]*\n)?\s*const r = await fetch\(`https:\/\/api\.mercadolibre\.com\/shipment_labels/.test(src.slice(iFul)), emp + ': com Full a etiqueta não pode ser pedida');
  assert.ok(/full_ml: !!_fullML,/.test(src) && /full_ml: !!snap\.full_ml,/.test(src), emp + ': full_ml não vai pro manifesto');
  // Codex #698: Full confirmado antes não é perguntado de novo, e consulta que falha não o devolve à fila
  assert.ok(/const _fullAntes = \(\(\) => \{ try \{ const ps = JSON\.parse\(fs\.readFileSync\(path\.join\(dir, 'pedido\.json'\)/.test(src), emp + ': não lê o Full da rodada anterior');
  // Codex #698 r2: o Full anterior vale ANTES de qualquer chamada ao ML (token/envio que falhem não o derrubam) e o fallback nem roda
  const iFA = src.indexOf('let _fullML = _fullAntes;'), iTok = src.indexOf('await garantirTokenML()', src.indexOf('// FALLBACK ML'));
  assert.ok(iFA > 0 && iTok > iFA, emp + ': o Full anterior tem que valer antes da primeira chamada ao ML');
  assert.ok(/if \(!temEtiqueta && mkt === 'ml' && ped\.numeroLoja && !_fullAntes\) \{/.test(src), emp + ': com Full já confirmado o fallback do ML não pode rodar');
  assert.ok(/semEtiqueta: ids\.filter\(i => !man\[i\]\.tem_etiqueta && !man\[i\]\.full_ml( && !man\[i\]\.aguardando_disp)?\)\.length/.test(src), emp + ': o resumo do topo ainda conta o Full como sem etiqueta');
  const pn = require('./_fonte-painel').ler(raiz, painel);   /* 27/10: o painel servido (peça única) */
  assert.ok(/function _avisoFullML\(d\)/.test(pn) && /\+ _avisoFullML\(d\)( \+ _avisoDispML\(d\))?;/.test(pn), emp + ': o painel não mostra o aviso do Full');
}
(async () => {
  process.env.ADMIN_KEY = 'chave-teste';
  require.cache[require.resolve('node-fetch')] = { id: 'node-fetch', filename: 'node-fetch', loaded: true, exports: async () => { throw new Error('sem rede'); } };
  for (const [emp, arq, pref, envDir] of [['AMB', 'amb-checkout-offline/index.js', '/amb-checkout-offline', 'AMBBKP_CACHE_DIR'],
                                           ['GOOD', 'good-checkout-offline/index.js', '/good-checkout-offline', 'GOODBKP_CACHE_DIR'],
                                           ['Girassol', 'girassol-backup-offline/gbo-app.js', '/girassol-backup-offline', 'GIRABKP_CACHE_DIR']]) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'full-' + emp + '-')); process.env[envDir] = dir;
    const base = { cliente: 'X', nf_emissao: '2026-10-15', nf_id: 1, marketplace: 'ml', tem_etiqueta: false };
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({
      '777': Object.assign({ numero: 5689, nf_numero: '009740', etq_motivo: 'o ML ainda não liberou a etiqueta' }, base),
      '888': Object.assign({ numero: 5692, nf_numero: '004905', full_ml: true, etq_motivo: 'venda FULL no Mercado Livre' }, base) }));
    const mod = require(path.join(raiz, arq));
    const h = mod.routes(async () => ({}));
    const u = new URL('http://x' + pref + '/lista?k=chave-teste');
    const res = { _s: 0, _b: '', writeHead(st) { this._s = st; }, setHeader() {}, end(b) { this._b = String(b || ''); } };
    await h({ method: 'GET', url: u.pathname + u.search, headers: {} }, res, u);
    const o = JSON.parse(res._b);
    assert.deepStrictEqual(o.sem_etiqueta_pedidos.map(x => String(x.numero)), ['5689'], emp + ': o Full continua na fila de sem etiqueta');
    assert.strictEqual(o.sem_etiqueta, 1, emp + ': a contagem de sem etiqueta ainda inclui o Full');
    assert.deepStrictEqual((o.full_ml_pedidos || []).map(x => String(x.numero)), ['5692'], emp + ': o Full não veio à parte pro aviso');
    // Codex #698: a /status conta igual à lista
    const u2 = new URL('http://x' + pref + '/status?k=chave-teste');
    const res2 = { _s: 0, _b: '', writeHead(st) { this._s = st; }, setHeader() {}, end(b) { this._b = String(b || ''); } };
    await h({ method: 'GET', url: u2.pathname + u2.search, headers: {} }, res2, u2);
    const o2 = JSON.parse(res2._b);
    assert.strictEqual(o2.semEtiqueta, 1, emp + ': a /status ainda conta o Full como sem etiqueta (' + o2.semEtiqueta + ')');
  }
  console.log('ok — venda Full do ML gravada no Bling como loja comum sai da fila do galpão e aparece num aviso, nas três empresas');
  process.exit(0);
})().catch(e => { console.error('FALHOU:', e.message); process.exit(1); });
