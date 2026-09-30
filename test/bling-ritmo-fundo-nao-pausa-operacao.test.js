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

/* isolado ANTES do require: o modulo persiste estado em disco a cada aviso429 */
process.env.BLING_RITMO_DIR = require('fs').mkdtempSync(require('path').join(require('os').tmpdir(), 'bling-ritmo-teste-'));
const { _interno } = require('../bling-ritmo.js');
const { permissao, aviso429, avisoOk, _agoraRef, _contas, _carregar } = _interno;
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

// ── Codex #538: pausa so-do-fundo sobrevive a restart ───────────────
{
  t += 1000000;
  aviso429('c5', 120, 'fundo');
  _contas.clear(); _carregar();
  ok(permissao('c5', 'fundo').pausa_s > 60, '⚠️ pausa do FUNDO persiste no restart (nao vira so o cooldown de boot)');
}

// ── Codex #538: permissao no MESMO ms do 429 conta como posterior ───
{
  t += 1000000;
  aviso429('c6', 0, 'fundo');
  const p = permissao('c6', 'operacao');
  avisoOk('c6', p.ficha);
  ok(_contas.get('c6').degrau === 0, '⚠️ sucesso de permissao emitida no mesmo ms do 429 zera a escada');
  t += 10000;
  const antes = permissao('c6', 'operacao');
  aviso429('c6', 0, 'operacao');
  avisoOk('c6', antes.ficha);
  ok(_contas.get('c6').degrau > 0, '  e permissao emitida ANTES do 429 (mesmo ms) segue ignorada');
}

console.log('');
console.log(falhas === 0 ? '=== TODOS OS CASOS PASSARAM' : '=== ' + falhas + ' FALHA(S)');
process.exit(falhas ? 1 : 0);
