'use strict';
/* 14/09 — F1/F2 (mover pedidos), última peça fiscal. Medido por CONJUNTO de linhas, porque o
   diff posicional mentia por causa de ordem: AMB e GOOD eram IDÊNTICAS, zero diferença.
   A Girassol ficou de fora com motivo registrado — ela usa outra ESTRATÉGIA de retentativa
   (marca o pedido como feito no sucesso e precisa de `destravado` pra reabrir quando o Bling
   desfaz; as outras não marcam, então não têm o que destravar). Não é dívida: unificar seria
   escolher uma estratégia pra todas, decisão de operação sem sintoma que a justifique.
   O teste guarda: contrato igual nas três, tetos por empresa (ritmo de operação) e as
   proteções que foram portadas ontem seguem valendo em todas. */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { criarFluxosPedidos } = require('../lib/fiscal/fluxos-pedidos');

assert.throws(() => criarFluxosPedidos({}), /falta rotulo/);
assert.throws(() => criarFluxosPedidos({ rotulo: 'X', pecas: {}, envMaxPedidosF1: 'A', envMaxPedidosF2: 'B', envF1RemoveMax: 'C', envF1RemoveEsperaMin: 'D' }),
  /falta a peça/, 'peça faltando derruba na fábrica, não no primeiro cron');

const CONTRATO = ['rotinaExpediente', 'rotinaManha', 'rotinaVirada'];
for (const emp of ['ambtotal', 'good', 'girassol']) {
  assert.deepStrictEqual(Object.keys(require('../' + emp + '/fluxos.js')).sort(), CONTRATO,
    emp + ': o contrato do F1/F2 mudou — o módulo fiscal monta as rotinas por este nome');
}

/* as gêmeas delegam; a Girassol mantém a implementação própria (estratégia diferente) */
const fonte = (p) => fs.readFileSync(path.join(__dirname, '..', p, 'fluxos.js'), 'utf8');
for (const emp of ['ambtotal', 'good']) {
  assert.ok(/criarFluxosPedidos\(/.test(fonte(emp)), emp + ': a fachada tem que delegar pra lib');
  assert.ok(!/async function rotinaExpediente/.test(fonte(emp)), emp + ': lógica voltou pra pasta — a divergência volta por aí');
}
const gir = fonte('girassol');
assert.ok(/destravado/.test(gir), 'a Girassol usa `destravado` — se sumir, o pedido desfeito pelo Bling não volta a ser movido');

/* tetos por empresa: ritmo de operação, não regra */
for (const campo of ['envMaxPedidosF1', 'envF1RemoveMax']) {
  const vals = ['ambtotal', 'good'].map(p => (new RegExp(campo + ": '([^']+)'").exec(fonte(p)) || [])[1]);
  assert.ok(vals.every(Boolean), 'toda fachada declara ' + campo + ': ' + vals.join(', '));
  assert.strictEqual(new Set(vals).size, 2, campo + ' tem que ser por empresa: ' + vals.join(', '));
}

/* as proteções portadas ontem continuam nas TRÊS (é o que a unificação mais arrisca perder) */
const libF = fs.readFileSync(path.join(__dirname, '..', 'lib', 'fiscal', 'fluxos-pedidos.js'), 'utf8');
for (const marca of ['DESFEITO PELO BLING', 'ACEITOU MAS N', '_movidosPorNos']) {
  assert.ok(libF.includes(marca), 'a lib perdeu a proteção: ' + marca);
  assert.ok(gir.includes(marca), 'a Girassol perdeu a proteção: ' + marca);
}

console.log('OK: F1/F2 — gêmeas na lib com contrato intacto, Girassol preservada com a estratégia dela, tetos por empresa e as proteções do F1 nas três');
