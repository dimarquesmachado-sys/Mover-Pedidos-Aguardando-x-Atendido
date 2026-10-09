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
  /* ⚠️ janela por TAMANHO FIXO corta no meio: `candidatos.length === 1` está a ~3.290 chars do
     início e 3.200 deixava de fora exatamente a asserção central. Ancoro no fim REAL do resgate
     (o `return true` depois do log de RESGATE) — tamanho fixo dá falso positivo, e falso positivo
     ensina a ignorar o vermelho. */
  const fimResgate = s.indexOf('RESGATE:', i);
  const bloco = s.slice(i, fimResgate > i ? fimResgate + 1200 : i + 6000);

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
  if (!/candidatos\.length === 1/.test(bloco) && !/candidatos\[0\]/.test(bloco)) {
    problemas.push(emp + ': o resgate não exige candidato ÚNICO antes de mover');
  }
  /* e não pode dizer que deu certo se o Bling recusou */
  /* ⚠️ o `moverSituacao` do RESGATE é o que vem DEPOIS da escolha do candidato — o primeiro do
     bloco pode ser o do caminho normal. Procuro a partir do candidato escolhido. */
  /* ⚠️ a âncora por NOME DE VARIÁVEL já quebrou duas vezes (o bloco foi reescrito e `achado =
     candidatos` sumiu). Procuro pela ESCALA — a função que move desandando — e, não achando,
     olho o bloco inteiro: o que importa é existir a recusa dita em algum lugar do resgate. */
  /* ⚠️ Codex #651: olhar o ARQUIVO INTEIRO fez este teste virar DECORAÇÃO — há dezenas de
     `ok: false` espalhados, então apagar a resposta de falha do resgate deixaria ele verde.
     Pior que o falso positivo que eu estava evitando.
     A âncora certa não é posição nem nome de variável: é a FUNÇÃO da escala, que é exportada
     justamente pra ser exercitada. Confiro o corpo DELA. */
  const iFn = s.indexOf('async function _moverAtendidoDesandando');
  assert.ok(iFn > 0, '[RESGATE] ' + emp + ': não achei `_moverAtendidoDesandando` — a escala sumiu ou mudou de nome');
  const fimFn = s.indexOf('\n}', iFn);
  const trechoPos = s.slice(iFn, fimFn > iFn ? fimFn : iFn + 4000);
  /* ⚠️ `ok: false` sozinho não prova nada: ele aparece no `return` da função mesmo sem resposta
     nenhuma pro dono. O que importa é a RESPOSTA que chega na tela — e ela tem de trazer o motivo
     e a lista de degraus tentados, que é o que transforma "deu erro" em ação. */
  for (const [oQue, re_] of [
    ['a resposta de falha (`resposta: { ok: false`)', /resposta:\s*\{\s*ok:\s*false/],
    ['o motivo escrito (`erro:`)', /\berro:\s*'/],
    ['a lista de degraus tentados', /\btentados\b/],
  ]) {
    if (!re_.test(trechoPos)) {
      problemas.push(emp + ': a escala não devolve ' + oQue + ' — o dono veria a tela falhar sem ' +
        'saber o que houve nem o que tentar');
    }
  }
}

assert.deepStrictEqual(problemas, [],
  '[RESGATE] problemas no resgate do pedido em limbo:\n  ' + problemas.join('\n  '));

console.log('OK: as 3 empresas resgatam o pedido em limbo e recusam numero repetido');
