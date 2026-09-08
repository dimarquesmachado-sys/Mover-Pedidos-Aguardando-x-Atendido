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

// ritmo básico: operacao passa até o teto (2.5/s ⇒ 2 fichas inteiras + fração)
assert.ok(permissao('girassol', 'operacao').ok);
assert.ok(permissao('girassol', 'operacao').ok);
const r3 = permissao('girassol', 'operacao');
assert.ok(r3.ok, '2.5/s: a 3ª ainda cabe (< 2.5 usa contagem de fichas vivas)');
const r4 = permissao('girassol', 'operacao');
assert.ok(!r4.ok && r4.esperar_ms > 0, 'estourou o teto ⇒ esperar_ms, nunca silêncio');

// reserva: fundo só usa a sobra (0.5/s) — com 1 ficha viva, fundo já bate no teto dele
agora += 2000;
assert.ok(permissao('girassol', 'fundo').ok, 'fundo cabe na sobra quando o segundo está limpo');
const rf = permissao('girassol', 'fundo');
assert.ok(!rf.ok, 'fundo NÃO come a reserva da operação');
assert.ok(permissao('girassol', 'operacao').ok, 'a operação segue passando onde o fundo parou');

// contas independentes (a cota é por CNPJ)
assert.ok(permissao('amb', 'fundo').ok, 'balde da amb não vê as fichas da girassol');

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
avisoOk('girassol');
assert.ok(permissao('girassol', 'operacao').ok, 'um sucesso real libera e zera a escada');
assert.strictEqual(estado('girassol').degrau, 0);

// persistência: pausa sobrevive a "restart" (reload do estado do arquivo)
aviso429('good', '120');
_contas.clear();
br._interno._carregar();
const eg = estado('good');
assert.ok(eg.pausa_s > 100, 'pausa recarregada do disco após restart: ' + eg.pausa_s + 's');

console.log('OK: porteiro — ritmo por conta, reserva da operação, escada de 429, Retry-After, liberação e persistência');
