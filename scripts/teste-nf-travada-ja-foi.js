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

  /* o ciclo do checkout faz a conferência, com o token e o envio do ML da empresa */
  const ciclo = fs.readFileSync(path.join(__dirname, '..', 'lib', 'checkout', 'ciclo-empresa.js'), 'utf8');
  assert.ok(/require\('\.\.\/nf-travadas'\)\.conferirEnvios\(CACHE_DIR,/.test(ciclo) && /o\.mlTokenManager\(\)[\s\S]{0,200}garantirTokenML\(\)[\s\S]{0,200}getShipmentInfo\(tok, pedML\)[\s\S]{0,300}api\.mercadolibre\.com\/shipments\//.test(ciclo),
    'o ciclo do checkout não chama a conferência dos envios com o token do ML da empresa');

  fs.rmSync(dir, { recursive: true, force: true });
  console.log('ok — NF travada de pedido que já foi embora sai do aviso (entregue/enviado/cancelado); o que não saiu fica e espera 30 min; sem resposta certa fica e pergunta de novo');
})().catch((e) => { console.error('FALHOU:', e.message); process.exit(1); });
