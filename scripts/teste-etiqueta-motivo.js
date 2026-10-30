'use strict';
/* 15/10 — o card de "sem etiqueta" mostra POR QUÊ. Prova: (1) a tradução do motivo do ML, de produção
   (recortada de cada ciclo.js), nos casos que importam; (2) nas três empresas, cada falha de fallback
   (ML e Shopee) grava o motivo, o motivo vai pro pedido (manifesto) e pra lista do painel, e o card usa. */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const raiz = path.join(__dirname, '..');
for (const [emp, ciclo, painel] of [['amb', 'amb-checkout-offline/ciclo.js', 'amb-checkout-offline/painel.html'],
                                    ['good', 'good-checkout-offline/ciclo.js', 'good-checkout-offline/painel.html'],
                                    ['girassol', 'girassol-backup-offline/ciclo.js', 'girassol-backup-offline/painel.html']]) {
  const src = require('./_fonte-ciclo').ler(raiz, ciclo);   /* 30/10: o ciclo como a empresa o roda (peça única) */
  const i = src.indexOf('function _motivoEtqML('); assert.ok(i > 0, emp + ': sem a tradução do motivo');
  const i0 = src.indexOf('function _semSegredo(');   /* a tradução usa o limpador — recorta os dois */
  const fn = new Function(src.slice(i0 >= 0 && i0 < i ? i0 : i, src.indexOf('\n}\n', i) + 2) + '\nreturn _motivoEtqML;')();
  assert.ok(/espera a nota fiscal/.test(fn(400, 'ready_to_ship/invoice_pending', '')), emp + ': invoice_pending');
  assert.ok(/cancelado/.test(fn(400, 'cancelled/x', '')), emp + ': cancelado');
  assert.ok(/já despachado/.test(fn(400, 'shipped/in_transit', '')), emp + ': despachado');
  assert.ok(/recusou o token/.test(fn(401, '', '')), emp + ': token');
  assert.ok(/HTTP 500/.test(fn(500, '', 'x')), emp + ': genérico');
  // Codex #697 (P1): o motivo nunca leva segredo — a URL da Shopee carrega ?k=SHOPEE_SYNC_KEY
  const j = src.indexOf('function _semSegredo('); assert.ok(j > 0, emp + ': sem o limpador de segredo');
  const limpa = new Function(src.slice(j, src.indexOf('\n}\n', j) + 2) + '\nreturn _semSegredo;')();
  const sujo = 'request to https://girassol-shopee-sync.onrender.com/amb/interno/etiqueta?rapido=1&k=SEGREDO123&order_sn=X failed, reason: timeout';
  assert.ok(!/SEGREDO123/.test(limpa(sujo)) && /girassol-shopee-sync\.onrender\.com\/amb\/interno\/etiqueta/.test(limpa(sujo)), emp + ': a chave vazou no motivo: ' + limpa(sujo));
  assert.ok(!/abc/.test(limpa('erro token=abc')), emp + ': token solto vazou');
  for (const re of [/_motivoEtq = 'ML: ' \+ _semSegredo\(/, /_motivoEtq = 'Shopee: ' \+ _semSegredo\(/, /_semSegredo\(detSh\)/])
    assert.ok(re.test(src), emp + ': motivo gravado sem passar pelo limpador: ' + re);
  // cada saída de falha grava o motivo
  for (const re of [/resposta sem ZPL[^\n]*_motivoEtq = /, /shipment_labels HTTP[^\n]*\n\s*_motivoEtq = _motivoEtqML\(/, /fallback ML \$\{ped\.numero\}: \$\{String\(e\.message[^\n]*_motivoEtq = 'ML: '/,
                    /resposta sem etiqueta reconhecível[^\n]*_motivoEtq = /, /fallback Shopee \$\{ped\.numero\}: HTTP[^\n]*\n\s*_motivoEtq = /, /fallback Shopee \$\{ped\.numero\}: \$\{String\(e\.message[^\n]*_motivoEtq = 'Shopee: '/])
    assert.ok(re.test(src), emp + ': saída de falha sem motivo: ' + re);
  assert.ok(/etq_motivo: \(temEtiqueta \|\| etiquetaMM\) \? null : \(_motivoEtq \|\| null\)/.test(src), emp + ': motivo não vai pro pedido');
  assert.ok(/tem_etiqueta: snap\.tem_etiqueta, etq_motivo: snap\.etq_motivo \|\| null,/.test(src), emp + ': motivo não vai pra lista do painel');
  assert.ok(/p\.etq_motivo\?esc\(p\.etq_motivo\)/.test(require('./_fonte-painel').ler(raiz, painel)), emp + ': o card não mostra o motivo');
}
console.log('ok — card sem etiqueta mostra o motivo da última tentativa (ML e Shopee), nas três empresas');

/* Codex #697: o motivo tem que chegar NA RESPOSTA da /lista (a projeção dos sem etiqueta era fixa e
   deixava o campo de fora — o card caía sempre no texto genérico). Monta os três módulos de verdade,
   com um manifesto de mentira, e lê a resposta. */
(async () => {
  const os = require('os');
  process.env.ADMIN_KEY = 'chave-teste';
  require.cache[require.resolve('node-fetch')] = { id: 'node-fetch', filename: 'node-fetch', loaded: true, exports: async () => { throw new Error('sem rede'); } };
  for (const [emp, arq, pref, envDir] of [['AMB', 'amb-checkout-offline/index.js', '/amb-checkout-offline', 'AMBBKP_CACHE_DIR'],
                                           ['GOOD', 'good-checkout-offline/index.js', '/good-checkout-offline', 'GOODBKP_CACHE_DIR'],
                                           ['Girassol', 'girassol-backup-offline/gbo-app.js', '/girassol-backup-offline', 'GIRABKP_CACHE_DIR']]) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lista-' + emp + '-')); process.env[envDir] = dir;
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ '777': { numero: 5692, cliente: 'X', nf_numero: '004905', nf_emissao: '2026-10-15', nf_id: 1, marketplace: 'ml', tem_etiqueta: false, etq_motivo: 'o ML ainda espera a nota fiscal deste pedido' } }));
    const mod = require(path.join(raiz, arq));
    const h = mod.routes(async () => ({}));
    const u = new URL('http://x' + pref + '/lista?k=chave-teste');
    const res = { _s: 0, _b: '', writeHead(st) { this._s = st; }, setHeader() {}, end(b) { this._b = String(b || ''); } };
    await h({ method: 'GET', url: u.pathname + u.search, headers: {} }, res, u);
    let o = null; try { o = JSON.parse(res._b); } catch (e) {}
    assert.ok(o && Array.isArray(o.sem_etiqueta_pedidos), emp + ': /lista não respondeu (' + res._s + ' ' + res._b.slice(0, 100) + ')');
    const p = o.sem_etiqueta_pedidos.find(x => String(x.numero) === '5692');
    assert.ok(p, emp + ': o pedido sem etiqueta não veio na lista');
    assert.strictEqual(p.etq_motivo, 'o ML ainda espera a nota fiscal deste pedido', emp + ': o motivo não chega na resposta da /lista');
  }
  console.log('ok — o motivo chega na resposta da /lista nas três empresas');
  process.exit(0);
})().catch(e => { console.error('FALHOU:', e.message); process.exit(1); });
