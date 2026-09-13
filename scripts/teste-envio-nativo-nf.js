'use strict';
/* 13/09 — PORTE do envio NATIVO Bling → marketplace (decisão do dono: "uma tem, agora ambas
   têm"). Contexto que dá o peso: isto vale no REENVIO MANUAL, que é o caso em que o envio
   automático já falhou. Antes, AMB e GOOD só repetiam ali o mesmo push de XML que não tinha
   funcionado; a Girassol tentava o caminho oficial (o Bling é integrador do ML e faz o
   handshake fiscal que o XML cru não faz) e só depois caía no push.
   O teste guarda a CADEIA inteira, porque meia cadeia é armadilha: a função tem que existir
   e ser exportada nas três, o reenvio tem que tentar o nativo ANTES do push, e o push tem
   que continuar existindo como reserva — se o nativo virar caminho único, uma falha dele
   deixaria a NF sem saída. */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

for (const emp of ['ambtotal', 'good', 'girassol']) {
  const api = require('../' + emp + '/blingApi.js');
  assert.strictEqual(typeof api.enviarNFeParaLojaVirtual, 'function', emp + ': falta enviarNFeParaLojaVirtual');

  const fluxo = fs.readFileSync(path.join(__dirname, '..', emp, 'nfeMlFluxo.js'), 'utf8');
  const i = fluxo.indexOf('async function enviarNFeUnica');
  assert.ok(i > 0, emp + ': não achei o reenvio manual');
  const trecho = fluxo.slice(i, i + 2500);

  const posNativo = trecho.indexOf('enviarNFeParaLojaVirtual');
  const posPush = trecho.indexOf('enviarNFeParaML');
  assert.ok(posNativo > 0, emp + ': o reenvio manual não usa o envio nativo');
  assert.ok(posPush > 0, emp + ': o push direto tem que continuar como RESERVA — sem ele, falha do nativo deixa a NF sem saída');
  assert.ok(posNativo < posPush, emp + ': o nativo tem que vir ANTES do push (é o caminho oficial)');

  assert.ok(/TOKEN_EXPIRADO|code === 401/.test(trecho),
    emp + ': token expirado precisa subir, não virar fallback — senão o push roda com token morto');
}

console.log('OK: envio nativo nas TRÊS — função exportada, tentada antes do push, push mantido como reserva e token expirado subindo');
