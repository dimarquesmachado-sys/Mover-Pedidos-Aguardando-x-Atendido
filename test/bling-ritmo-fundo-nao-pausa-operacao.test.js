'use strict';
// ⚠️ FUNDO NÃO PAUSA OPERAÇÃO, e a operação recua CURTO.
//
// 30/09: o dono emitia 30 NFs de devolução na GOOD e levou meia hora. A
// esteira sai a ~14s/nota com a conta livre, mas cada 429 parava a conta 60s
// — 8 pausas em 12 minutos — e os 429 eram do índice de nomes (FUNDO), não
// dela. "A operação sempre perde primeiro", ao pé da letra.
//
// 📌 E a escada (15→30→60→120→300) nunca era usada: o cliente mandava 60 como
// se fosse retry-after do Bling, e o central obedecia.

let falhas = 0;
const ok = (c, o) => { if (!c) falhas++; console.log((c ? 'ok  ' : 'FALHA ') + o); };

const { _interno } = require('../bling-ritmo.js');
const { permissao, aviso429, _agoraRef } = _interno;
let t = 5000000; _agoraRef.fn = () => t;

// ── 429 de FUNDO pausa só o fundo ───────────────────────────────────
{
  aviso429('c1', 0, 'fundo');
  ok(permissao('c1', 'operacao').ok === true,
     '⚠️ 429 do FUNDO nao pausa a OPERACAO (a esteira segue)');
  const pf = permissao('c1', 'fundo');
  ok(pf.ok === false && pf.pausa_s >= 15,
     '  mas pausa o fundo, na escada longa (' + pf.pausa_s + 's)');
}

// ── 429 de OPERAÇÃO pausa os dois, mas curto ────────────────────────
{
  t += 1000000;
  aviso429('c2', 0, 'operacao');
  const po = permissao('c2', 'operacao');
  ok(po.ok === false && po.pausa_s <= 15,
     '⚠️ 429 da OPERACAO pausa a operacao CURTO (' + po.pausa_s + 's, nao 60)');
  ok(permissao('c2', 'fundo').ok === false,
     '  e pausa o fundo tambem (a conta esta saturada de verdade)');
  // a escada curta dobra
  t += 20000; aviso429('c2', 0, 'operacao');
  t += 0; const po2 = permissao('c2', 'operacao');
  ok(po2.pausa_s <= 15, '  e mesmo subindo o degrau, nunca passa de 15s (' + po2.pausa_s + 's)');
}

// ── retry-after do Bling tem precedência, nas duas ──────────────────
{
  t += 1000000;
  const r = aviso429('c3', 45, 'operacao');
  ok(r.pausa_s === 45, '  Retry-After do Bling (45s) vence a escada, tambem na operacao');
}

// ── cliente ANTIGO (sem prioridade): igual a antes ──────────────────
{
  t += 1000000;
  const r = aviso429('c4', 0);
  ok(r.pausa_s === 15 && r.alvo === 'todos',
     '⚠️ sem prioridade (cliente antigo): escada longa e pausa nos dois — nada muda pra quem nao atualizou');
}

console.log('');
console.log(falhas === 0 ? '=== TODOS OS CASOS PASSARAM' : '=== ' + falhas + ' FALHA(S)');
process.exit(falhas ? 1 : 0);
