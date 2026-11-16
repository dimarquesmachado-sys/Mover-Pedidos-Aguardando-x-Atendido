'use strict';
/* 16/11 — APOIO DE TESTE (não é teste: o nome começa com `_`).

   O contexto do backfill da AMB e da GOOD era montado à mão em cada arquivo (`_ctxBackfillAmb`, `_ctxBackfillGood`) e vários
   testes conferiam o TEXTO dele ("o contexto leva a caça DELA", "o token é o DELA"…). Desde o montarCheckout passo 9 o
   contexto é a peça lib/checkout/backfill-empresa, montada no arquivo com as peças da empresa por acessor. O que esses testes
   protegem continua valendo — só mudou de forma: "o arquivo entrega a peça X" + "a peça leva X ao campo Y do contexto".

   `montagem(src)`     — o texto do `require('../lib/checkout/backfill-empresa').criar({ … })` do arquivo da empresa;
   `entrega(src, n, v)` — o arquivo entrega a peça `n` como `v` (por acessor: `get n() { return v; }`);
   `leva(campo, re)`   — a peça põe no campo `campo` do contexto o que casa com `re`;
   `usaPeca(src, emp)` — o arquivo monta a peça com a empresa `emp` e o backfill dele roda por ela. */
const fs = require('fs');
const path = require('path');
const raiz = path.join(__dirname, '..');
const PECA = fs.readFileSync(path.join(raiz, 'lib', 'checkout', 'backfill-empresa.js'), 'utf8');

function montagem(src) {
  const k = src.indexOf("require('../lib/checkout/backfill-empresa').criar({");
  return k > 0 ? src.slice(k, src.indexOf('\n});', k)) : '';
}
function entrega(src, n, v) { return montagem(src).includes('get ' + n + '() { return ' + v + '; }'); }
function leva(campo, re) {
  const i = PECA.indexOf('  function ctx() {'), j = PECA.indexOf('\n  }\n', i);
  const corpo = PECA.slice(i, j);
  const m = new RegExp('\\b' + campo + ': ([^\\n]*?)(?:,\\s*(?:\\w+:|$)|,\\n)').exec(corpo);
  return !!(m && re.test(m[1]));
}
function usaPeca(src, emp) {
  return new RegExp("require\\('\\.\\./lib/checkout/backfill-empresa'\\)\\.criar\\(\\{\\n  empresa: '" + emp + "',").test(src)
    && /const backfillVendas = \(de, ate\) => require\('\.\/backfill-rodar'\)\.backfillVendas\(de, ate, empresa, ctx\(\)\);/.test(PECA);
}

module.exports = { PECA, montagem, entrega, leva, usaPeca };
