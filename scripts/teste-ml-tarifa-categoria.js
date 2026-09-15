'use strict';
/* 15/09 — a classificação da tarifa do ML virou lib. Ela é pequena (46 linhas) e pura, mas o
   valor não é o tamanho: cada regra dentro dela nasceu de DINHEIRO que apareceu ou sumiu de
   um card do dono. O caso mais caro está no corpo — o ML manda "Anulación del cargo por
   campaña de publicidad" em espanhol, e o padrão em português não pegava: eram R$ 849 de
   estorno de ads na AMB, dinheiro A FAVOR do dono, que não aparecia em card nenhum.
   Este teste existe pra travar esses casos. Regra de classificação que volta a quebrar não
   dá erro — ela só some com o dinheiro do card, em silêncio, e ninguém liga uma coisa à
   outra meses depois. */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { _mlbCategoria } = require('../lib/checkout/ml-tarifa-categoria');

/* os dois achados que motivaram as regras — em espanhol, como o ML manda */
assert.strictEqual(_mlbCategoria('Anulación del cargo por campaña de publicidad'), 'credito',
  'estorno de ads em ESPANHOL tem que virar crédito — foram R$ 849 a favor do dono sumindo de card');
assert.strictEqual(_mlbCategoria('Cargo por venta con afiliados'), 'comissao',
  'afiliados é custo por venda — entra como comissão');

/* o básico não pode regredir */
assert.strictEqual(_mlbCategoria('Tarifa de venda'), 'comissao');
assert.ok(_mlbCategoria(''), 'texto vazio tem que cair numa categoria, nunca undefined');
assert.ok(_mlbCategoria(null), 'null não pode explodir — o ML às vezes manda campo ausente');

/* as empresas usam a MESMA classificação: divergir aqui faria o mesmo lançamento
   virar custo numa empresa e crédito na outra */
for (const arq of ['amb-checkout-offline/index.js', 'girassol-backup-offline/gbo-app.js']) {
  const s = fs.readFileSync(path.join(__dirname, '..', arq), 'utf8');
  assert.ok(/require\('\.\.\/lib\/checkout\/ml-tarifa-categoria'\)/.test(s), arq + ': tem que usar a lib');
  assert.ok(!/^function _mlbCategoria/m.test(s), arq + ': voltou a ter cópia própria da classificação');
}

/* e a lib não pode depender de nada — é o que a torna segura de mover */
const lib = fs.readFileSync(path.join(__dirname, '..', 'lib', 'checkout', 'ml-tarifa-categoria.js'), 'utf8');
assert.ok(!/require\(/.test(lib.replace(/\/\*[\s\S]*?\*\//g, '')), 'a lib ganhou dependência — ela precisa continuar pura');

console.log('OK: categoria da tarifa do ML — estorno em espanhol vira crédito, afiliados vira comissão, e as empresas usam a MESMA classificação');
