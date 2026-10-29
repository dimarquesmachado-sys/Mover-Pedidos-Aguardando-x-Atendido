'use strict';
/* 27/10 — o painel do galpão virou a peça única lib/checkout/painel (o modelo + a painel-marca.js de cada empresa); a
   pasta da empresa que já migrou NÃO tem mais painel.html. Os testes que conferem o TEXTO do painel de uma empresa leem
   por aqui: se a pasta tem painel-marca.js, devolve o painel RENDERIZADO (o que o servidor entrega); senão, o arquivo.
   Usa a peça e a marca da RAIZ recebida (a prova dos testes roda numa cópia da árvore). */
const fs = require('fs');
const path = require('path');
function ler(raiz, rel) {
  const r = String(rel || '').replace(/\\/g, '/');
  /* 27/10: a tela da CONTAGEM também virou peça única (lib/checkout/painel/contagem + a marca da empresa) */
  const mc = /^(?:\.\/)?([^/]+)\/contagem\.html$/.exec(r);
  if (mc) {
    const marcaC = path.join(raiz, mc[1], 'painel-marca.js');
    if (!fs.existsSync(path.join(raiz, r)) && fs.existsSync(marcaC)) {
      return require(path.join(raiz, 'lib', 'checkout', 'painel', 'contagem.js')).renderizar(require(marcaC));
    }
  }
  const m = /^(?:\.\/)?([^/]+)\/painel\.html$/.exec(r);
  if (m) {
    const marca = path.join(raiz, m[1], 'painel-marca.js');
    if (!fs.existsSync(path.join(raiz, r)) && fs.existsSync(marca)) {
      return require(path.join(raiz, 'lib', 'checkout', 'painel', 'painel-galpao.js')).renderizar(require(marca));
    }
  }
  return fs.readFileSync(path.join(raiz, r), 'utf8');
}
module.exports = { ler };
