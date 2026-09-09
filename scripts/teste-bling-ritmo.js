'use strict';
/* Teste do porteiro de ritmo do Bling — relógio injetado, sem esperas reais.
   Rodar: node scripts/teste-bling-ritmo.js */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
/* Codex #356 r2: o teste apagava o ARQ REAL quando BLING_RITMO_DIR//data apontavam pro
   disco do deploy — isolado num tmpdir próprio ANTES do require. */
process.env.BLING_RITMO_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'bling-ritmo-teste-'));
const br = require('../bling-ritmo');
const { permissao, aviso429, avisoOk, estado, _agoraRef, _contas, ARQ } = br._interno;

let agora = 1000000000000;
_agoraRef.fn = () => agora;
_contas.clear();
try { fs.unlinkSync(ARQ); } catch (e) {}

// regra DUPLA: nunca >3 no MESMO segundo (limite instantâneo do Bling), nunca >5 em 2s
for (let i = 0; i < 3; i++) assert.ok(permissao('girassol', 'operacao').ok, 'operacao ' + (i + 1) + '/3 no segundo');
const rBurst = permissao('girassol', 'operacao');
assert.ok(!rBurst.ok, 'a 4ª no MESMO segundo é barrada — burst nunca passa do 3/s do Bling');
agora += 1100;
assert.ok(permissao('girassol', 'operacao').ok, '4ª na janela (2º segundo)');
assert.ok(permissao('girassol', 'operacao').ok, '5ª na janela');
const r6 = permissao('girassol', 'operacao');
assert.ok(!r6.ok && r6.esperar_ms > 0, 'a 6ª em 2s é barrada ⇒ média 2.5/s de verdade');

// fundo: cota PRÓPRIA de 1/2s — e operação no meio NÃO estrangula o fundo
agora += 3000;
assert.ok(permissao('girassol', 'operacao').ok, 'uma operação passa');
assert.ok(permissao('girassol', 'fundo').ok, 'o fundo AINDA cabe — cota separada, não estrangulado pela operação');
const rf = permissao('girassol', 'fundo');
assert.ok(!rf.ok, 'a 2ª do fundo na janela é barrada — 0.5/s real');
assert.ok(permissao('girassol', 'operacao').ok, 'a operação segue passando onde o fundo parou');

// contas independentes (a cota é por CNPJ)
assert.ok(permissao('amb', 'fundo').ok, 'balde da amb não vê as fichas da girassol');

// r6: alias e canônico compartilham o MESMO balde (senão seriam 6/s no mesmo CNPJ)
{
  const { contaCanonica } = br._interno;
  assert.strictEqual(contaCanonica('amb'), 'ambtotal');
  assert.strictEqual(contaCanonica('ambtotal'), 'ambtotal');
  assert.strictEqual(contaCanonica('AMB '), 'ambtotal', 'normaliza caixa e espaço');
  assert.strictEqual(contaCanonica('xpto'), null);
}

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
const pInf = aviso429('girassol', 'Infinity');
assert.ok(pInf.pausa_s <= 3600, 'Retry-After não-finito não trava a conta pra sempre (caiu na escada/teto: ' + pInf.pausa_s + 's)');
const p3 = aviso429('girassol', '90');
assert.strictEqual(p3.pausa_s, 90, 'Retry-After do Bling tem precedência');
const p4 = aviso429('girassol');
assert.ok(p4.pausa_s >= 89, 'aviso posterior NUNCA encurta a pausa ativa (ficou ' + p4.pausa_s + 's)');
const okIgnorado = avisoOk('girassol');
assert.ok(okIgnorado.ignorado, 'sem ficha o aviso-ok é sempre ignorado (ficha obrigatória): ' + okIgnorado.motivo);
agora += (p4.pausa_s + 1) * 1000; // o degrau da escada pode ter passado do Retry-After — avanço dinâmico
const pNova = permissao('girassol', 'operacao');
assert.ok(pNova.ok && pNova.ficha && pNova.ficha.includes('-'), 'permissão sai com ficha prefixada pelo boot (única entre restarts)');
const okFichaVelha = avisoOk('girassol', 'processoantigo-1');
assert.ok(okFichaVelha.ignorado, 'ficha de outro processo/desconhecida não zera a escada');
avisoOk('girassol', pNova.ficha);
assert.ok(!estado('girassol').pausa_s, 'sucesso de permissão pós-429 libera de verdade');
assert.strictEqual(estado('girassol').degrau, 0);

// persistência: pausa sobrevive a "restart" (reload do estado do arquivo)
aviso429('good', '120');
_contas.clear();
br._interno._carregar();
const eg = estado('good');
assert.ok(eg.pausa_s > 100, 'pausa recarregada do disco após restart: ' + eg.pausa_s + 's');
// r5: resfriamento de boot — conta carregada SEM pausa ganha ao menos uma janela (2s)
aviso429('amb', '5'); avisoOk('amb', 'x'); // amb persiste com pausa curta que expira já
agora += 10000;
_contas.clear();
br._interno._carregar();
const ea = estado('amb');
assert.ok(ea.pausa_s >= 1 && ea.pausa_s <= 3, 'resfriamento de boot de uma janela pós-restart: ' + ea.pausa_s + 's');

console.log('OK: porteiro — ritmo por conta, reserva da operação, escada de 429, Retry-After, liberação e persistência');
