/* 06/10 — REABRIR NÃO PODE SUMIR COM O PEDIDO. Caso real: pedido 5477 da AMBTotal.

   O dono procurou o pedido no histórico, clicou em reabrir, e ele SUMIU do histórico sem voltar
   pra lista — e no Bling continuou DESPACHADO por 20 minutos.

   A causa estava na ORDEM das operações, igual nas três empresas:

     1. apagava o pedido da fila de conferidos;
     2. gravava o arquivo;
     3. SÓ ENTÃO tentava mover a situação no Bling;
     4. respondia `ok:true` INDEPENDENTE de o passo 3 ter funcionado.

   Se o Bling recusasse — token vencido, 429, rede, ou o pedido já mexido à mão — o pedido ficava
   em LIMBO: fora do histórico (onde o dono acharia pra tentar de novo) e ainda DESPACHADO no
   Bling. E a tela dizia que deu certo.

   Agora move primeiro e só tira da fila se o Bling confirmar; se recusar, o pedido CONTINUA no
   histórico e a resposta diz o que houve.

   ⚠️ Este teste lê a ORDEM no código das três empresas, porque é uma ordem de operações que não dá
   pra exercitar sem Bling de verdade — e a ordem é exatamente o que estava errado.

   Marcador estável [REABRIR]. */
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
  let s;
  try { s = fs.readFileSync(path.join(raiz, arq), 'utf8'); }
  catch (e) { problemas.push(emp + ': não consegui ler ' + arq); continue; }

  /* ⚠️ ancora no HANDLER de reabrir, não no primeiro `const eraSync` do arquivo: há outros, e o
     resgate do pedido em limbo entrou no meio. Ancoragem frouxa dá falso positivo ("mudou de
     forma"), que é o que ensina a ignorar o vermelho. */
  const iRota = s.indexOf('/reabrir/');
  const i = iRota < 0 ? -1 : s.indexOf('const eraSync', iRota);
  if (i < 0) { problemas.push(emp + ': não achei a rota de reabrir (procurei `const eraSync`)'); continue; }
  /* ⚠️ a janela por TAMANHO FIXO já quebrou duas vezes: o resgate do pedido em limbo entrou
     entre a busca na fila e o `const eraSync`, e o teste passou a acusar "mudou de forma" — falso
     positivo, que ensina a ignorar o vermelho. Ancoro no fim REAL do handler. */
  const fimHandler = s.indexOf("rodarCiclo('reabrir')", i);
  const bloco = s.slice(i, fimHandler > i ? fimHandler + 300 : i + 4000);

  const apaga = bloco.indexOf('delete confAtual[id]');
  const move = bloco.indexOf('moverSituacao');

  /* Codex #645: depois do await do Bling o `conf` lido no início está velho — gravá-lo de volta
     descarta o que outro operador finalizou nesse intervalo. Tem de reler a fila antes de gravar. */
  if (apaga >= 0 && !/const confAtual = readJson\(CONFERIDOS_FILE/.test(bloco)) {
    problemas.push(emp + ': grava o `conf` velho (lido antes do await do Bling) — descarta pedidos finalizados nesse intervalo');
  }
  if (apaga < 0 || move < 0) { problemas.push(emp + ': bloco do reabrir mudou de forma — reveja este teste'); continue; }

  if (apaga < move) {
    problemas.push(emp + ': APAGA o pedido da fila ANTES de mover no Bling — se o Bling recusar, ' +
      'o pedido some do histórico e continua DESPACHADO (é o caso do 5477)');
  }

  /* ⚠️ e a recusa precisa ser DITA: responder ok:true com o Bling recusando é o que fez o dono
     achar que tinha dado certo e só descobrir 20 min depois. */
  if (!/removido_da_fila:\s*false/.test(bloco) || !/ok:\s*false/.test(bloco)) {
    problemas.push(emp + ': não responde `ok:false` quando o Bling recusa — a tela diria que deu ' +
      'certo e o pedido ficaria em limbo sem ninguém saber');
  }

  /* o `return true` tem de estar DENTRO do ramo da recusa, senão a execução segue e apaga mesmo assim */
  const recusa = bloco.indexOf('removido_da_fila: false');
  if (recusa > 0 && bloco.indexOf('return true', recusa) > bloco.indexOf('delete confAtual[id]', recusa) && bloco.indexOf('delete confAtual[id]', recusa) > 0) {
    problemas.push(emp + ': o ramo da recusa não interrompe — o pedido seria apagado mesmo com o Bling recusando');
  }
}

assert.deepStrictEqual(problemas, [],
  '[REABRIR] problemas na rota de reabrir:\n  ' + problemas.join('\n  ') +
  '\nRegra: mover no Bling PRIMEIRO; só tirar da fila se confirmou; e dizer quando recusou. ' +
  'Sumir calado é pior que recusar.');

console.log('OK: as 3 empresas movem no Bling antes de tirar da fila, e avisam quando ele recusa');
