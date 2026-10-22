'use strict';
/* 20/10 — rota das FOTOS dos produtos do painel (/produto-fotos) virou PEÇA ÚNICA (lib/checkout/rotas-painel-produto-fotos).
   Era cópia na AMB e na fábrica (GOOD); a Girassol não tinha — e a tela única mostra a foto de cada produto no ranking.
   Prova: as três montam a peça (sem cópia sobrando); com a peça de produção e peças de mentira: sem login responde 401
   (inclusive o ?diag=, que nas cópias respondia sem sessão); com login, devolve a foto do cadastro do SKU; peça faltando
   vira aviso honesto (não erro). */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const raiz = path.join(__dirname, '..');
const { criarRotaProdutoFotos } = require('../lib/checkout/rotas-painel-produto-fotos');
/* a AMB é atendida pela FÁBRICA do painel (que monta a mesma peça com as peças dela) — sem rota própria nem cópia */
{ const sA = fs.readFileSync(path.join(raiz, 'amb-checkout-offline', 'index.js'), 'utf8');
  const mR = sA.match(/rotasProprias: \[[^\]]*\]/);
  assert.ok(mR && !/'produto-fotos'/.test(mR[0]), 'a AMB ainda reserva produto-fotos pra si (a fábrica cederia a vez)');
  assert.ok(!/p === '\/amb-checkout-offline\/produto-fotos'/.test(sA), 'sobrou a cópia da rota das fotos na AMB'); }

for (const [arq, padrao] of [
  ['girassol-backup-offline/gbo-app.js', /criarRotaProdutoFotos\(\{ PREFIXO: '\/girassol-backup-offline'/],
  ['lib/checkout/fabrica-rotas-painel.js', /require\('\.\/rotas-painel-produto-fotos'\)\.criarRotaProdutoFotos\(\{ PREFIXO,/],
]) {
  const s = fs.readFileSync(path.join(raiz, arq), 'utf8');
  assert.ok(padrao.test(s), arq + ': não monta a peça da rota das fotos');
  assert.ok(!/p === '\/amb-checkout-offline\/produto-fotos'/.test(s) && !/p === \(PREFIXO \+ '\/produto-fotos'\)/.test(s), arq + ': sobrou cópia da rota das fotos');
}

(async () => {
  const resp = () => ({ code: 0, body: null });
  const json = (r, code, body) => { r.code = code; r.body = body; };
  const disco = {};
  const deps = { CACHE_DIR: '/c', primeiraImagem: (p) => (p && p.img) || null,
    blingGet: async (u) => ({ ok: true, status: 200, data: { data: /codigo=A/.test(u) ? [{ id: 1, codigo: 'A', img: 'http://foto/a.jpg' }] : [] } }),
    readJson: (p, d) => (p in disco ? JSON.parse(JSON.stringify(disco[p])) : d), writeJson: (p, v) => { disco[p] = JSON.parse(JSON.stringify(v)); } };
  let sessao = null;
  const rota = criarRotaProdutoFotos({ PREFIXO: '/x', json, validarSessao: () => sessao, deps: () => deps });
  const chama = async (qs) => { const r = resp(); const u = new URL('http://h/x/produto-fotos' + qs); const t = await rota({ headers: {} }, r, u, 'GET', '/x/produto-fotos'); return { t, r }; };

  // sem login: 401 — inclusive o diagnóstico (nas cópias antigas ele respondia sem sessão)
  for (const qs of ['?skus=A', '?diag=A']) {
    const { t, r } = await chama(qs);
    assert.ok(t === true && r.code === 401, 'sem login, ' + qs + ' respondeu ' + r.code);
  }
  // com login: a foto do cadastro do SKU
  sessao = { usuario: 'diego', admin: true };
  const { t, r } = await chama('?skus=A');
  assert.ok(t === true && r.code === 200 && r.body && r.body.ok && r.body.fotos && r.body.fotos.A === 'http://foto/a.jpg', 'com login, não veio a foto: ' + JSON.stringify(r.body));
  // rota de outro caminho: não é dela
  assert.strictEqual(await rota({ headers: {} }, resp(), new URL('http://h/x/outra'), 'GET', '/x/outra'), false);
  // peça faltando: aviso honesto, não erro
  const rota2 = criarRotaProdutoFotos({ PREFIXO: '/x', json, validarSessao: () => sessao, deps: () => Object.assign({}, deps, { blingGet: null }) });
  const r2 = resp(); await rota2({ headers: {} }, r2, new URL('http://h/x/produto-fotos?skus=A'), 'GET', '/x/produto-fotos');
  assert.ok(r2.code === 200 && r2.body && r2.body.ok === false && /blingGet/.test(JSON.stringify(r2.body)), 'peça faltando não virou aviso: ' + JSON.stringify(r2.body));
  console.log('ok — rota das fotos: peça única nas três (a Girassol ganha), login antes de tudo (inclusive o diagnóstico), foto do cadastro, peça faltando vira aviso');
  process.exit(0);
})().catch(e => { console.error('FALHOU:', e.message); process.exit(1); });
