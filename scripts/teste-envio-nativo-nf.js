'use strict';

/* 16/09 — o id de canal do ML deixou de ter padrão no código: empresa sem a env julgava os
   pedidos dela pelo canal de OUTRA, em silêncio. Este teste montava o módulo fiscal sem
   definir a env e passava APOIADO nesse padrão — ou seja, ele provava menos do que parecia.
   Definir aqui explicita a dependência que o código sempre teve. */
for (const n of ['ME_LOJA_IDS', 'AMB_ME_LOJA_IDS', 'GOOD_ME_LOJA_IDS', 'QUARTA_ME_LOJA_IDS', 'NOVA_ME_LOJA_IDS', 'X_ME_LOJA_IDS', 'TESTE_ME_LOJA_IDS']) {
  if (!process.env[n]) process.env[n] = '111222333';
}
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

/* 14/09: o F3 saiu das três pastas e virou lib/fiscal/nfe-ml-fluxo.js (as gêmeas eram
   idênticas; a Girassol diferia só em env e rótulo). A garantia deste teste não mudou — a
   cadeia nativo → reserva —, mas agora é conferida UMA vez na lib, e cada empresa é
   conferida por ainda expor a função nativa e por delegar. */
{
  const fluxo = fs.readFileSync(path.join(__dirname, '..', 'lib', 'fiscal', 'nfe-ml-fluxo.js'), 'utf8');
  const i = fluxo.indexOf('async function enviarNFeUnica');
  assert.ok(i > 0, 'não achei o reenvio manual na lib');
  const trecho = fluxo.slice(i, i + 2500);
  const posNativo = trecho.indexOf('enviarNFeParaLojaVirtual');
  const posPush = trecho.indexOf('enviarNFeParaML');
  assert.ok(posNativo > 0 && posPush > 0 && posNativo < posPush,
    'o nativo tem que vir ANTES do push, e o push seguir existindo como reserva');
  assert.ok(/TOKEN_EXPIRADO|code === 401/.test(trecho),
    'token expirado precisa subir, não virar fallback — senão o push roda com token morto');
}

for (const emp of ['ambtotal', 'good', 'girassol']) {
  const api = require('../' + emp + '/blingApi.js');
  assert.strictEqual(typeof api.enviarNFeParaLojaVirtual, 'function', emp + ': falta enviarNFeParaLojaVirtual');

  const fachada = fs.readFileSync(path.join(__dirname, '..', emp, 'nfeMlFluxo.js'), 'utf8');
  assert.ok(/criarFluxoNFeML\(/.test(fachada), emp + ': a fachada do F3 tem que delegar pra lib');
  assert.ok(!/async function rotinaNFeML/.test(fachada), emp + ': lógica do F3 voltou pra pasta — a divergência volta por aí');
  const mod = require('../' + emp + '/nfeMlFluxo.js');
  assert.deepStrictEqual(Object.keys(mod).sort(), ['enviarNFeUnica', 'rotinaNFeML'], emp + ': contrato do F3 mudou');

}

console.log('OK: envio nativo nas TRÊS — função exportada, tentada antes do push, push mantido como reserva e token expirado subindo');
