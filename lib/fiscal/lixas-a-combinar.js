'use strict';

/* 19/10 — "este pedido tem lixa A-COMBINAR?" (Codex #712). O pedido com lixa A-COMBINAR NÃO pode ganhar nota antes de o
   módulo das lixas acertar o grão com o cliente. O marcador nem sempre é prefixo (há "100-lisa-225mm-A-COMBINAR",
   "100-6furos-225mm-ACOMBINAR" e até SKU sem o marcador, "100-AE-8F-180mm-KIT97") — a fonte da verdade é o CATÁLOGO das
   lixas (lixas-combinar/lixas-catalogo.json, chaveado pelo SKU). Também vale o marcador em qualquer posição. O SKU do item
   pode vir em item.codigo ou item.produto.codigo. Catálogo ilegível = "não sei" ⇒ devolve null (quem chama não gera nota). */

const fs = require('fs');
const path = require('path');

const ARQ = path.join(__dirname, '..', '..', 'lixas-combinar', 'lixas-catalogo.json');
let _cache = null, _cacheTs = 0;
function catalogo() {
  const agora = Date.now();
  if (_cache && agora - _cacheTs < 60000) return _cache;
  try { const j = JSON.parse(fs.readFileSync(ARQ, 'utf8')); _cache = (j && j.catalogo && typeof j.catalogo === 'object') ? j.catalogo : null; }
  catch (e) { _cache = null; }
  _cacheTs = agora;
  return _cache;
}
const skuDoItem = (it) => String((it && (it.codigo || (it.produto && it.produto.codigo))) || '').trim();
/* true = tem lixa A-COMBINAR · false = não tem · null = não deu pra saber (catálogo ilegível) */
function temLixaACombinar(itens) {
  const lista = Array.isArray(itens) ? itens : [];
  if (lista.some(it => /A-?COMBINAR/i.test(skuDoItem(it)))) return true;
  const cat = catalogo();
  if (!cat) return null;
  return lista.some(it => Object.prototype.hasOwnProperty.call(cat, skuDoItem(it)));
}

module.exports = { temLixaACombinar, skuDoItem, ARQ };
