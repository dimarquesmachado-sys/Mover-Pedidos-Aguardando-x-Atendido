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

for (const [emp, prefixo] of [['ambtotal', '/amb'], ['good', '/good'], ['girassol', '']]) {
  const s = fs.readFileSync(path.join(__dirname, '..', emp, 'index.js'), 'utf8');
  for (const sufixo of ['/callback', '/callback-nf', '/callback-ml']) {
    const rota = prefixo + sufixo;
    assert.ok(s.includes("p === '" + rota + "'"),
      emp + ': falta a rota ' + rota + ' — sem ela, quem reautoriza precisa copiar o código da URL à mão');
  }
  /* e o setup manual continua existindo: é a saída quando o redirect não pode ser usado */
  assert.ok(s.includes("p === '" + prefixo + "/setup'"), emp + ': o setup manual tem que continuar como alternativa');
}

console.log('OK: as TRÊS empresas com os três callbacks (Bling, Bling NF e ML) e o setup manual preservado');
