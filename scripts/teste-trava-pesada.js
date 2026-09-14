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

/* cadeado eterno é pior que a sobreposição que ele evita: dono sem sinal de vida
   não pode travar a casa pra sempre */
const fonte = require('fs').readFileSync(require('path').join(__dirname, '..', 'lib', 'checkout', 'trava-pesada.js'), 'utf8');
assert.ok(/TETO_MS/.test(fonte) && /liberando à força/.test(fonte), 'tem que existir teto que libera dono antigo demais');

/* Codex P1 (#422): o teto media desde o INÍCIO — uma rodada legítima e longa (fila grande:
   a 1,2s/SKU, ~4.500 SKUs já passam de 90 min) tinha a própria trava tomada por baixo dela
   enquanto ainda rodava, e a outra empresa entrava — a sobreposição que a trava existe pra
   evitar. Simula com o relógio: dono renovando o sinal de vida sobrevive além dos 90 min
   corridos desde que ENTROU; dono que para de renovar é liberado 90 min depois do ÚLTIMO
   sinal, não do início. */
{
  const RealDate = Date;
  let agoraFake = 1000000000000; // qualquer T0
  global.Date = class extends RealDate { static now() { return agoraFake; } };
  try {
    assert.strictEqual(trava.tentarEntrar('custo:amb').ok, true);
    agoraFake += 80 * 60000; // +80min: ainda dentro do teto
    trava.renovar(); // rodada viva avisa que segue em pé
    agoraFake += 85 * 60000; // +165min desde o início, mas só 85min desde o sinal
    assert.strictEqual(trava.tentarEntrar('custo:girassol').ok, false,
      'renovar() tem que manter a trava viva além dos 90min corridos desde o INÍCIO');
    agoraFake += 91 * 60000; // +91min sem NENHUM sinal novo
    assert.strictEqual(trava.tentarEntrar('custo:girassol').ok, true,
      'sem sinal de vida por 90min, mesmo tendo renovado antes, a trava tem que soltar');
  } finally {
    global.Date = RealDate;
    trava.sair('custo:girassol');
    trava.sair('custo:amb');
  }
  assert.strictEqual(trava.quemEsta(), null, 'ambiente do teste tem que sair limpo pros próximos testes');
}

/* e o custo diário precisa soltar no finally, inclusive quando dá erro */
const cd = require('fs').readFileSync(require('path').join(__dirname, '..', 'lib', 'checkout', 'custo-diario.js'), 'utf8');
assert.ok(/finally \{[\s\S]{0,300}travaPesada\.sair/.test(cd),
  'a trava tem que ser solta no finally — se ficar presa num erro, a outra empresa nunca mais roda');

console.log('OK: trava pesada — uma rodada por vez, diz quem segura, adia sem enfileirar, não libera a trava alheia e tem teto contra cadeado eterno');
