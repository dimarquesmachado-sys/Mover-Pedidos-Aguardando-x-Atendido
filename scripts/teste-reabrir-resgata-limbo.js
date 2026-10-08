/* 06/10 — O REABRIR TEM DE RESGATAR O PEDIDO EM LIMBO. Caso real: 5477 da AMBTotal.

   A versão anterior apagava o pedido da fila ANTES de confirmar no Bling. Quando o Bling recusava,
   o pedido ficava FORA da fila e ainda DESPACHADO — e reabrir respondia "não está na fila de
   finalizados" e não fazia nada. O dono ficava sem saída pelo sistema, dependendo de mexer no
   Bling à mão.

   Agora, não achando na fila, a rota procura o pedido NO BLING pelo número e, se ele estiver em
   DESPACHADOS ou VERIFICADO, devolve pra ATENDIDO.

   ⚠️ E recusa quando há MAIS DE UM candidato: número repete entre anos/lojas, e escolher um seria
   mexer no pedido errado — que é pior que não resolver.

   Marcador estável [RESGATE]. */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const raiz = path.join(__dirname, '..');
const EMPRESAS = [
  ['AMB', 'amb-checkout-offline/index.js'],
  ['GOOD', 'good-checkout-offline/index.js'],
  ['Girassol', 'girassol-backup-offline/gbo-app.js'],
];

const problemas = [];
for (const [emp, arq] of EMPRESAS) {
  const s = fs.readFileSync(path.join(raiz, arq), 'utf8');
  const i = s.indexOf('RESGATE DO PEDIDO EM LIMBO');
  if (i < 0) {
    problemas.push(emp + ': não tem o resgate — pedido fora da fila e ainda pós-checkout fica sem ' +
      'saída pelo sistema, e o dono precisa mexer no Bling à mão');
    continue;
  }
  const bloco = s.slice(i, i + 6500);

  if (!/pedidos\/vendas\?numero=/.test(bloco)) {
    problemas.push(emp + ': o resgate não procura o pedido no Bling pelo número');
  }
  if (!/SIT_DESPACHADOS/.test(bloco) || !/SIT_VERIFICADO/.test(bloco)) {
    problemas.push(emp + ': o resgate não limita às situações pós-checkout — mexeria em pedido ' +
      'que nunca passou pelo checkout');
  }
  /* ⚠️ o ponto que evita estrago: com 2+ candidatos, RECUSA */
  if (!/candidatos\.length > 1/.test(bloco)) {
    problemas.push(emp + ': o resgate não trata número REPETIDO — escolheria um pedido e poderia ' +
      'mexer no errado, que é pior que não resolver');
  }
  if (!/candidatos\.length === 1/.test(bloco)) {
    problemas.push(emp + ': o resgate não exige candidato ÚNICO antes de mover');
  }
  /* Codex #645: envelope do blingGet, número exato, fallback por ID e janela do ciclo */
  if (!/r\.data\.data/.test(bloco)) problemas.push(emp + ': o resgate não desembrulha r.data.data');
  if (!/String\(x\.numero\) === String\(arg\)/.test(bloco)) problemas.push(emp + ': o resgate não confere o número exato');
  if (!/pedidos\/vendas\/\$\{encodeURIComponent\(arg\)\}/.test(bloco)) problemas.push(emp + ': o resgate não tem o fallback por ID do Bling');
  if (!/JANELA_DIAS/.test(bloco)) problemas.push(emp + ': o resgate não trata pedido fora da janela do ciclo');
  /* e não pode dizer que deu certo se o Bling recusou */
  const iMv = bloco.indexOf('moverSituacao');
  const trechoPos = bloco.slice(iMv, iMv + 700);
  if (!/ok:\s*false/.test(trechoPos)) {
    problemas.push(emp + ': o resgate não avisa quando o Bling recusa');
  }
}

assert.deepStrictEqual(problemas, [],
  '[RESGATE] problemas no resgate do pedido em limbo:\n  ' + problemas.join('\n  '));

console.log('OK: as 3 empresas resgatam o pedido em limbo e recusam numero repetido');
