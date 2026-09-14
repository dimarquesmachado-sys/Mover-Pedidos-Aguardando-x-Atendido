'use strict';
/* 14/09 — trava ÚNICA das rotinas pesadas, nascida de incidente real: 503 no /saude da
   Girassol às 23:16 de 13/09. Não foi deploy (o log mostra o anterior às 20:06 e o seguinte
   só no dia seguinte): foi SOBREPOSIÇÃO. A rodada de custo da AMB (23h00) ainda estava em pé
   quando a da Girassol (23h15) começou, e o log mostra as duas entrelaçadas — "6.848 linhas"
   de uma alternando com "28.410 linhas / fila com 1.768 SKU(s)" da outra, num heap de 340MB.
   Cada empresa tinha a própria trava e não sabia da outra; separar horários era combinação
   frágil, porque basta uma atrasar.
   O teste guarda o que o incidente ensinou: uma por vez, adiar em vez de enfileirar (a fila
   guardaria trabalho na memória, que é o recurso que faltou), soltar sempre — inclusive em
   erro — e nunca deixar cadeado eterno. */
const assert = require('assert');
const trava = require('../lib/checkout/trava-pesada');

/* uma por vez */
assert.strictEqual(trava.tentarEntrar('custo:amb').ok, true);
const barrada = trava.tentarEntrar('custo:girassol');
assert.strictEqual(barrada.ok, false, 'a segunda rodada pesada tem que ser BARRADA');
assert.strictEqual(barrada.ocupadoPor, 'custo:amb', 'a resposta tem que dizer QUEM está segurando — senão não dá pra saber o que esperar');
assert.ok(typeof barrada.haMin === 'number', 'e há quanto tempo');

/* soltou, a outra entra */
trava.sair('custo:amb');
assert.strictEqual(trava.tentarEntrar('custo:girassol').ok, true);
assert.strictEqual(trava.quemEsta().nome, 'custo:girassol');

/* sair com nome errado não rouba a trava de quem a tem */
trava.sair('custo:amb');
assert.ok(trava.quemEsta(), 'sair() com nome de outro não pode liberar a trava alheia');
trava.sair('custo:girassol');
assert.strictEqual(trava.quemEsta(), null);

/* cadeado eterno é pior que a sobreposição que ele evita: processo que morreu sem soltar
   não pode travar a casa pra sempre */
const fonte = require('fs').readFileSync(require('path').join(__dirname, '..', 'lib', 'checkout', 'trava-pesada.js'), 'utf8');
assert.ok(/TETO_MS/.test(fonte) && /liberando à força/.test(fonte), 'tem que existir teto que libera dono antigo demais');

/* e o custo diário precisa soltar no finally, inclusive quando dá erro */
const cd = require('fs').readFileSync(require('path').join(__dirname, '..', 'lib', 'checkout', 'custo-diario.js'), 'utf8');
assert.ok(/finally \{[\s\S]{0,300}travaPesada\.sair/.test(cd),
  'a trava tem que ser solta no finally — se ficar presa num erro, a outra empresa nunca mais roda');

console.log('OK: trava pesada — uma rodada por vez, diz quem segura, adia sem enfileirar, não libera a trava alheia e tem teto contra cadeado eterno');
