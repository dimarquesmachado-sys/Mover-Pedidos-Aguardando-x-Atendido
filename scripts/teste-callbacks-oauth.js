'use strict';
/* Passo 2.9, 1º achado (13/09): a Girassol não tinha a rota de CALLBACK do Bling.
   AMB e GOOD já tinham: o navegador volta da autorização com o `code` na URL e o token é
   gerado sozinho. Na Girassol, quem autorizava precisava copiar o código da barra de
   endereços e postar à mão em /setup — no meio de uma situação que já é urgente (token
   caiu, nota parada, alguém esperando).
   O teste guarda a TRINCA de cada empresa (Bling, Bling NF e ML), porque a falta some
   silenciosamente: só se descobre no dia em que o token cai, que é o pior dia possível. */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

/* 14/09: as rotas saíram dos index.js das empresas e passaram a nascer da fábrica
   (lib/fiscal/criar-modulo.js). A garantia deste teste não mudou — todas as empresas
   precisam dos três callbacks —, mas o endereço sim: a fábrica é conferida UMA vez, e cada
   empresa é conferida pelo PREFIXO que ela declara, que é o que monta a URL final. */
{
  const fab = fs.readFileSync(path.join(__dirname, '..', 'lib', 'fiscal', 'criar-modulo.js'), 'utf8');
  for (const sufixo of ['/callback', '/callback-nf', '/callback-ml', '/setup']) {
    assert.ok(fab.includes("(prefixo + '" + sufixo + "')"),
      'a fábrica precisa registrar ' + sufixo + ' — sem o callback, quem reautoriza copia o código da URL à mão');
  }
}

for (const [emp, prefixo] of [['ambtotal', '/amb'], ['good', '/good'], ['girassol', '']]) {
  const s = fs.readFileSync(path.join(__dirname, '..', emp, 'index.js'), 'utf8');
  assert.ok(new RegExp("prefixo: '" + prefixo + "'").test(s),
    emp + ': o prefixo declarado tem que ser "' + prefixo + '" — é ele que monta a URL de todas as rotas da empresa');
  const m = require('../' + emp);
  assert.strictEqual(typeof m.routes, 'function', emp + ': precisa expor routes');
}

console.log('OK: as TRÊS empresas com os três callbacks (Bling, Bling NF e ML) e o setup manual preservado');
