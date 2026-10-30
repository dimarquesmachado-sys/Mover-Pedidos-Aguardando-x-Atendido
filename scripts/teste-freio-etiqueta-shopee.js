'use strict';
/* 19/10 — freio da etiqueta Shopee (lib/checkout/freio-etiqueta-shopee), o mesmo nas três empresas. O dono: "quase 1
   hora pra testar de novo... não pode demorar tudo isso" (a AMB esperava 1 h fixa depois de 3 falhas; GOOD e Girassol
   não tinham freio nenhum e repetiam a mesma chamada falha a cada ciclo). Prova: a escada 0,0,5,10,20,30,30 min com o
   relógio falso; o ok() limpa o pedido; o zerar() limpa tudo; os três ciclos usam a peça (consultam antes, registram
   falha/ok, exportam zerarFreioShopee) e o botão "Bling agora" das três zera o freio. */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const raiz = path.join(__dirname, '..');
const { criarFreio, esperaMs } = require('../lib/checkout/freio-etiqueta-shopee');

let t = 1000000; const fr = criarFreio(() => t);
const minutosDeEspera = () => { const e = fr.estado('p'); return e ? e.faltaMin : 0; };
const esperas = [];
for (let n = 1; n <= 7; n++) { fr.falhou('p', 'HTTP 401'); esperas.push(minutosDeEspera()); }
assert.deepStrictEqual(esperas, [0, 0, 5, 10, 20, 30, 30], 'a escada de espera mudou: ' + esperas.join(','));
assert.strictEqual(fr.estado('p').ultimo, 'HTTP 401');
t += 31 * 60000; assert.strictEqual(fr.estado('p'), null, 'passada a espera, tinha que liberar a tentativa');
fr.ok('p'); fr.falhou('p'); assert.strictEqual(fr.estado('p'), null, 'depois do ok, a contagem tinha que recomeçar');
fr.falhou('a'); fr.falhou('a'); fr.falhou('a'); fr.falhou('b'); fr.falhou('b'); fr.falhou('b');
assert.ok(fr.estado('a') && fr.estado('b'));
assert.strictEqual(fr.zerar(), 3); assert.strictEqual(fr.estado('a'), null, 'o zerar (botão Bling agora) não liberou');
assert.ok(esperaMs(3) <= 5 * 60000 && esperaMs(99) <= 30 * 60000, 'nenhuma espera pode passar de 30 min');

for (const [emp, ciclo, idx] of [['AMB', 'amb-checkout-offline/ciclo.js', 'amb-checkout-offline/index.js'], ['GOOD', 'good-checkout-offline/ciclo.js', 'good-checkout-offline/index.js'], ['Girassol', 'girassol-backup-offline/ciclo.js', 'girassol-backup-offline/gbo-app.js']]) {
  const c = require('./_fonte-ciclo').ler(raiz, ciclo);   /* 30/10: o ciclo como a empresa o roda (peça única) */
  assert.ok(/const _freioSh = require\('\.\.\/lib\/checkout\/freio-etiqueta-shopee'\)\.criarFreio\(\);/.test(c), emp + ': o ciclo não usa o freio da lib');
  assert.ok(/_freioSh\.estado\(_shKey\)/.test(c) && /_freioSh\.falhou\(_shKey, _motivoEtq\)/.test(c) && /_freioSh\.ok\(_shKey\)/.test(c), emp + ': o ciclo não consulta/registra o freio');
  assert.ok(/module\.exports = \{ zerarFreioShopee: \(\) => _freioSh\.zerar\(\),/.test(c), emp + ': o ciclo não exporta o zerar');
  assert.ok(!/3600000\)/.test(c.slice(c.indexOf('FALLBACK SHOPEE') > 0 ? c.indexOf('FALLBACK SHOPEE') : 0, (c.indexOf('MADEIRA MADEIRA') > 0 ? c.indexOf('MADEIRA MADEIRA') : c.length))), emp + ': sobrou espera de 1 hora no bloco da Shopee');
  const i = fs.readFileSync(path.join(raiz, idx), 'utf8');
  assert.ok(/_ultimoCicloAgora = agora;\n[^\n]*\n\s*try \{ const _zf = require\('\.\/ciclo'\)\.zerarFreioShopee;/.test(i), emp + ': o botão Bling agora não zera o freio');
  assert.ok(/Codex PR#717[\s\S]*?_r\.pulado\) return;[\s\S]*?setTimeout\(r, 10000\)/.test(i), emp + ': o Bling agora não reenfileira quando o ciclo já roda (pulado)');
  /* e o zerar exportado de verdade (módulo de produção) */
  const mod = require(path.join(raiz, ciclo));
  assert.strictEqual(typeof mod.zerarFreioShopee, 'function', emp + ': zerarFreioShopee não exportado');
  assert.strictEqual(mod.zerarFreioShopee(), 0);
}
console.log('ok — freio da etiqueta Shopee: 5→10→20→30 min (era 1 h na AMB e nada nas outras), o Bling agora zera, igual nas três');
process.exit(0);
