'use strict';
/* Teste do porteiro de ritmo do Bling — relógio injetado, sem esperas reais.
   Rodar: node scripts/teste-bling-ritmo.js */
const assert = require('assert');
const fs = require('fs');
const br = require('../bling-ritmo');
const { permissao, aviso429, avisoOk, estado, _agoraRef, _contas, ARQ } = br._interno;

let agora = 1000000000000;
_agoraRef.fn = () => agora;
_contas.clear();
try { fs.unlinkSync(ARQ); } catch (e) {}

// ritmo: janela de 2s com tetos INTEIROS exatos — operacao 5/2s (2.5/s), nunca 6
for (let i = 0; i < 5; i++) assert.ok(permissao('girassol', 'operacao').ok, 'operacao ' + (i + 1) + '/5 na janela');
const r6 = permissao('girassol', 'operacao');
assert.ok(!r6.ok && r6.esperar_ms > 0, 'a 6ª na janela é barrada ⇒ 2.5/s REAIS, sem arredondar pra cima');

// reserva: fundo é 1/2s (0.5/s real) e NUNCA come a reserva
agora += 3000;
assert.ok(permissao('girassol', 'fundo').ok, 'fundo cabe: 1 por janela');
const rf = permissao('girassol', 'fundo');
assert.ok(!rf.ok, 'a 2ª do fundo na janela é barrada — 0.5/s real, não 1/s');
assert.ok(permissao('girassol', 'operacao').ok, 'a operação segue passando onde o fundo parou');

// contas independentes (a cota é por CNPJ)
assert.ok(permissao('amb', 'fundo').ok, 'balde da amb não vê as fichas da girassol');

// cota diária: fundo barra em 100k, operação segue até 110k (reserva do fim do dia)
{
  const c = br._interno._contas.get('girassol');
  c.usadasDia = 100000; c.dia = new Date(agora).toISOString().slice(0, 10);
  agora += 3000;
  const rd = permissao('girassol', 'fundo');
  assert.ok(!rd.ok && /cota diária/.test(rd.motivo), 'fundo barrado na cota diária: ' + JSON.stringify(rd));
  assert.ok(permissao('girassol', 'operacao').ok, 'a operação ainda passa — reserva diária do fim do dia');
  c.usadasDia = 0;
}

// 429: pausa global escalonada + Retry-After com precedência + ok libera
agora += 2000;
const p1 = aviso429('girassol');
assert.strictEqual(p1.pausa_s, 15, '1º 429 ⇒ degrau 15s');
let neg = permissao('girassol', 'operacao');
assert.ok(!neg.ok && neg.pausa_s > 0, 'pausa barra até a operação — recuo é de TODOS');
agora += 16000;
const p2 = aviso429('girassol');
assert.strictEqual(p2.pausa_s, 30, '2º 429 ⇒ 30s (escada)');
const p3 = aviso429('girassol', '90');
assert.strictEqual(p3.pausa_s, 90, 'Retry-After do Bling tem precedência');
const p4 = aviso429('girassol');
assert.ok(p4.pausa_s >= 89, 'aviso posterior NUNCA encurta a pausa ativa (ficou ' + p4.pausa_s + 's)');
const okIgnorado = avisoOk('girassol');
assert.ok(okIgnorado.ignorado, 'sucesso ATRASADO com pausa ativa é ignorado — não cancela o recuo');
agora += (p4.pausa_s + 1) * 1000; // o degrau da escada pode ter passado do Retry-After — avanço dinâmico
avisoOk('girassol');
assert.ok(permissao('girassol', 'operacao').ok, 'sucesso APÓS a pausa vencer libera e zera a escada');
assert.strictEqual(estado('girassol').degrau, 0);

// persistência: pausa sobrevive a "restart" (reload do estado do arquivo)
aviso429('good', '120');
_contas.clear();
br._interno._carregar();
const eg = estado('good');
assert.ok(eg.pausa_s > 100, 'pausa recarregada do disco após restart: ' + eg.pausa_s + 's');

console.log('OK: porteiro — ritmo por conta, reserva da operação, escada de 429, Retry-After, liberação e persistência');
