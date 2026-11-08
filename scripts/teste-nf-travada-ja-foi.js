'use strict';
/* 08/11 — NF TRAVADA DE PEDIDO QUE JÁ FOI EMBORA. Caso real (NF 130031, Girassol): o pedido saiu do galpão e o aviso
   vermelho continuou no checkout. Prova (lib/nf-travadas, a função de produção, com o ML de mentira):
   · envio "shipped"/"delivered"/"not_delivered"/"cancelled" → a NF travada do pedido SAI do aviso;
   · envio ainda "ready_to_ship" → FICA, e o pedido só é perguntado de novo depois de 30 min;
   · o ML sem resposta certa (erro, 429, timeout) → FICA e é perguntado de novo na próxima rodada ("não sei" ≠ "já foi");
   · o número do envio guardado na travada é o usado na pergunta;
   · e o ciclo do checkout chama a conferência com o token do ML da empresa (a pergunta é feita no ciclo, não à mão). */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const trav = require('../lib/nf-travadas');

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trav-'));
  const erro = '{"error":"wrong_receiver_zipcode","message":"zipcode must be the same"}';
  trav.registrar(dir, { nfeId: 130031, numero: '130031', pedidoML: '2000019330050780', shipment: '44001', erro });
  trav.registrar(dir, { nfeId: 2, numero: '2', pedidoML: 'B-PRONTO', shipment: null, erro });
  trav.registrar(dir, { nfeId: 3, numero: '3', pedidoML: 'C-SEM-RESPOSTA', shipment: null, erro });
  trav.registrar(dir, { nfeId: 4, numero: '4', pedidoML: 'D-CANCELADO', shipment: null, erro });
  assert.strictEqual(trav.lista(dir).length, 4);

  const perguntas = [];
  const ml = async (ped, ship) => {
    perguntas.push([ped, ship]);
    if (ped === '2000019330050780') return { status: 'delivered' };
    if (ped === 'B-PRONTO') return { status: 'ready_to_ship' };
    if (ped === 'D-CANCELADO') return { status: 'cancelled' };
    throw new Error('HTTP 429');
  };
  const t0 = Date.parse('2026-11-08T10:00:00Z');
  const r1 = await trav.conferirEnvios(dir, ml, { agora: t0 });
  const ficaram = trav.lista(dir).map((t) => t.pedido_ml).sort();
  assert.deepStrictEqual(ficaram, ['B-PRONTO', 'C-SEM-RESPOSTA'], 'o que já foi embora (entregue, cancelado) tinha que sair; o resto ficar: ' + ficaram);
  assert.strictEqual(r1.resolvidas, 2);
  assert.ok(perguntas.some(([p, s]) => p === '2000019330050780' && s === '44001'), 'o envio guardado na travada tinha que ser o usado na pergunta');
  const b = trav.lista(dir).find((t) => t.pedido_ml === 'B-PRONTO');
  assert.ok(b.envio_status === 'ready_to_ship' && b.envio_conferido_em, 'a conferência sem saída tinha que ficar anotada');

  /* 10 min depois: B (conferido, ainda não saiu) não é perguntado; C (sem resposta) é perguntado de novo */
  perguntas.length = 0;
  await trav.conferirEnvios(dir, ml, { agora: t0 + 10 * 60 * 1000 });
  assert.ok(!perguntas.some(([p]) => p === 'B-PRONTO'), 'B já foi conferido há 10 min — não podia perguntar de novo antes de 30 min');
  assert.ok(perguntas.some(([p]) => p === 'C-SEM-RESPOSTA'), 'C ficou sem resposta — tinha que perguntar de novo');
  /* 31 min depois, B saiu: some do aviso */
  const ml2 = async (ped) => (ped === 'B-PRONTO' ? { status: 'shipped' } : (() => { throw new Error('timeout'); })());
  await trav.conferirEnvios(dir, ml2, { agora: t0 + 31 * 60 * 1000 });
  assert.deepStrictEqual(trav.lista(dir).map((t) => t.pedido_ml), ['C-SEM-RESPOSTA'], 'B enviado tinha que sair; C (sem resposta) continua');

  /* Codex #810: o token do ML renovando TRAVADO não segura o ciclo — a pergunta tem prazo (a renovação não é cancelada,
     só deixa de ser esperada) e a rodada inteira também; a travada sem resposta fica pra próxima */
  {
    let renovou = false;
    const nunca = new Promise((ok) => setTimeout(() => { renovou = true; ok('token'); }, 400));   /* a renovação demora */
    const t1 = Date.now();
    await assert.rejects(trav.comPrazo(nunca, 50, 'o ML não respondeu em 20s'), /não respondeu/, 'a espera com prazo tinha que desistir no prazo');
    assert.ok(Date.now() - t1 < 300 && !renovou, 'desistiu no prazo — e a renovação NÃO foi cancelada, só deixou de ser esperada');
    await new Promise((s2) => setTimeout(s2, 450));
    assert.ok(renovou, 'a renovação seguiu sozinha até o fim');
    const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'trav2-'));
    for (const p of ['P1', 'P2', 'P3', 'P4']) trav.registrar(dir2, { nfeId: p, numero: p, pedidoML: p, erro });
    const perg = [];
    const lento = (ped) => trav.comPrazo(new Promise(() => {}), 40, 'sem resposta').catch((e) => { perg.push(ped); throw e; });
    const t2 = Date.now();
    await trav.conferirEnvios(dir2, lento, { prazoTotalMs: 90 });
    assert.ok(Date.now() - t2 < 400, 'a rodada inteira tinha que respeitar o teto');
    assert.ok(perg.length >= 1 && perg.length < 4, 'com o teto da rodada, os pedidos que faltam ficam pra próxima (perguntou ' + perg.length + ')');
    assert.strictEqual(trav.lista(dir2).length, 4, 'sem resposta, nenhuma travada sai');
    fs.rmSync(dir2, { recursive: true, force: true });
  }
  const _ciclo = fs.readFileSync(path.join(__dirname, '..', 'lib', 'checkout', 'ciclo-empresa.js'), 'utf8');
  assert.ok(/_trv\.conferirEnvios\(CACHE_DIR, \(pedML, shipGuardado\) => _trv\.comPrazo\(\(async \(\) => \{[\s\S]{0,1200}\}\)\(\), 20000, [^)]*\), \{ prazoTotalMs: 60000 \}\)/.test(_ciclo),
    'no ciclo, a pergunta inteira (token + envio + status) tem que estar dentro do prazo, e a rodada com teto');
  /* o ciclo do checkout faz a conferência, com o token e o envio do ML da empresa */
  const ciclo = fs.readFileSync(path.join(__dirname, '..', 'lib', 'checkout', 'ciclo-empresa.js'), 'utf8');
  assert.ok(/_trv\.conferirEnvios\(CACHE_DIR,/.test(ciclo) && /o\.mlTokenManager\(\)[\s\S]{0,200}garantirTokenML\(\)[\s\S]{0,200}getShipmentInfo\(tok, pedML\)[\s\S]{0,300}api\.mercadolibre\.com\/shipments\//.test(ciclo),
    'o ciclo do checkout não chama a conferência dos envios com o token do ML da empresa');

  fs.rmSync(dir, { recursive: true, force: true });
  console.log('ok — NF travada de pedido que já foi embora sai do aviso (entregue/enviado/cancelado); o que não saiu fica e espera 30 min; sem resposta certa fica e pergunta de novo');
})().catch((e) => { console.error('FALHOU:', e.message); process.exit(1); });
