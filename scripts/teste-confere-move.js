'use strict';
/* Passo 2.9, 3º achado (13/09): "o Bling aceitou mas não aplicou".
   A Girassol relê o pedido depois de mover e só considera feito se a situação MUDOU de
   verdade. AMB e GOOD confiavam no 200 OK da API — e o Bling responde 200 sem aplicar de
   vez em quando. Resultado: pedido dormindo em ATENDIDO, invisível, sem ninguém saber.
   O teste guarda a cadeia, porque a meia-porta é a pior: reler, tratar os TRÊS desfechos
   (aplicou / não deu pra conferir / aceitou e não aplicou) e mostrar no resumo. */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

/* 14/09: o F1/F2 das gêmeas saiu das pastas e virou lib/fiscal/fluxos-pedidos.js (elas eram
   idênticas). A Girassol segue com implementação própria, por usar outra estratégia de
   retentativa. A garantia deste teste não mudou — ela vale pras TRÊS —, só mudou onde cada
   uma guarda o código: a lib responde pelas gêmeas, a pasta responde pela Girassol. */
const FONTES = [
  ['AMB/GOOD (lib)', path.join(__dirname, '..', 'lib', 'fiscal', 'fluxos-pedidos.js')],
  ['girassol', path.join(__dirname, '..', 'girassol', 'fluxos.js')],
];
for (const [emp, caminho] of FONTES) {
  const s = fs.readFileSync(caminho, 'utf8');

  assert.ok(/getPedidoDetalhe\(token, p\.id\)[\s\S]{0,200}conferiu/.test(s),
    emp + ': tem que RELER o pedido depois de mover — sem isso, o 200 do Bling é promessa, não fato');
  assert.ok(/conferiu === SITUACAO_AGUARDANDO/.test(s), emp + ': falta o desfecho "aplicou"');
  assert.ok(/conferiu === null/.test(s), emp + ': falta o desfecho "não deu pra conferir" (não pode virar sucesso nem falha)');
  assert.ok(/ACEITOU MAS N[ÃA]O APLICOU/.test(s), emp + ': falta o desfecho "aceitou e não aplicou"');
  assert.ok(/naoAplicados\+\+/.test(s), emp + ': o caso tem que ser contado');
  /* o texto do resumo difere entre as empresas (a Girassol usa 'BLING NÃO APLICOU' desde
     30/07; o porte usou 'ACEITOS E NÃO APLICADOS'). O que precisa existir é o NÚMERO no
     resumo — impor a minha frase seria trocar a delas por gosto, não por motivo. */
  assert.ok(new RegExp('=\\\$\\{naoAplicados\\}').test(s), emp + ': o resumo do F1 tem que mostrar o contador');

  /* o fôlego antes de reler: sem ele, a leitura pega o estado velho e acusa falso positivo */
  assert.ok(/setTimeout\(r, 1200\)/.test(s), emp + ': falta o fôlego antes de reler (leitura imediata acusa falso positivo)');
}

console.log('OK: conferência pós-move nas TRÊS — relê, trata os três desfechos, conta e mostra no resumo');
