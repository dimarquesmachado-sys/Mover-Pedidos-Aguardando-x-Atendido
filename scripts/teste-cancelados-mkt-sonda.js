'use strict';
/* 29/10 — SONDA dos pedidos cancelados no marketplace ANTES da postagem (lib/checkout/rotas-cancelados-mkt), TikTok.
   A regra do Diego manda: só pedido NÃO POSTADO — na fila do galpão sem conferência E cancelado no TikTok sem nenhum
   sinal de envio. Prova, com a rota de verdade e um TikTok de mentira:
   · cancelado sem sinal de envio → cancelado_antes_postagem; com coleta/entrega/item em trânsito → cancelado_depois_de_postado
     (é do Devoluções); ativo → só conta; pedido já CONFERIDO pelo checkout nem é olhado; outro marketplace fica de fora;
   · TikTok que falha → "nao_sei" pra todos (nunca "ativo", nunca veredito);
   · só admin (404 sem a chave); só leitura (não grava nada); as três empresas montam a sonda com a conta delas. */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const raiz = path.join(__dirname, '..');
const S = require('../lib/checkout/rotas-cancelados-mkt');

(async () => {
  // 1) o veredito de um pedido
  const v = S.classificarTikTok;
  assert.strictEqual(v({ id: '1', status: 'CANCELLED', line_items: [{ display_status: 'CANCELLED' }] }).veredito, 'cancelado_antes_postagem');
  assert.strictEqual(v({ id: '2', status: 'CANCELLED', collection_time: 1761600000 }).veredito, 'cancelado_depois_de_postado');
  assert.strictEqual(v({ id: '3', status: 'CANCELLED', line_items: [{ display_status: 'IN_TRANSIT' }] }).veredito, 'cancelado_depois_de_postado');
  assert.strictEqual(v({ id: '4', status: 'AWAITING_SHIPMENT' }).veredito, 'ativo');
  /* Codex #763: cada campo do item conta por si — o display_status "CANCELLED" não esconde o package_status "SHIPPED" */
  assert.strictEqual(v({ id: '6', status: 'CANCELLED', line_items: [{ display_status: 'CANCELLED', package_status: 'SHIPPED' }] }).veredito, 'cancelado_depois_de_postado', 'o status do pacote ficou escondido pelo do item');
  /* na dúvida é sinal: pronto pra envio e rastreio gerado (do pedido ou do item) tiram da lista de "nunca saiu" */
  for (const o of [{ rts_time: 1761600000 }, { tracking_number: 'BR123' }, { line_items: [{ tracking_number: 'BR9' }] }, { line_items: [{ rts_time: 1761600000 }] }]) {
    assert.strictEqual(v(Object.assign({ id: '7', status: 'CANCELLED' }, o)).veredito, 'cancelado_depois_de_postado', 'sinal de envio ignorado: ' + JSON.stringify(o));
  }
  assert.strictEqual(v(null).veredito, 'nao_sei');
  assert.strictEqual(v({ id: '5' }).veredito, 'nao_sei', 'pedido sem status não pode virar veredito');

  // 2) a rota de verdade
  process.env.ADMIN_KEY = 'adm-canc';
  const man = {
    10: { numero: 1001, marketplace: 'tiktok', numero_loja: '586826825515370453', cliente: 'JAMES', nf_numero: '129691', nf_emissao: '2026-10-27 20:39:00' },
    11: { numero: 1002, marketplace: 'tiktok', numero_loja: '600000000000000002', nf_numero: '129700' },
    12: { numero: 1003, marketplace: 'tiktok', numero_loja: '600000000000000003' },
    13: { numero: 1004, marketplace: 'tiktok', numero_loja: '600000000000000004' },   /* conferido: o checkout já despachou */
    14: { numero: 1005, marketplace: 'tiktok', numero_loja: null },
    15: { numero: 1006, marketplace: 'shopee', numero_loja: 'X1' },
  };
  const conf = { 13: { conferido_em: '2026-10-28T10:00:00Z' } };
  let chamadas = [];
  const tkOk = { lerToken: () => ({ access_token: 'x' }), chamar: async (p, q, o, conta) => {
    chamadas.push({ p, ids: q.ids, metodo: o.metodo, conta });
    return { ok: true, http: 200, corpo: { code: 0, data: { orders: [
      { id: '586826825515370453', status: 'CANCELLED', cancellation_initiator: 'BUYER', line_items: [{ display_status: 'CANCELLED' }] },
      { id: '600000000000000002', status: 'CANCELLED', collection_time: 1761700000 },
      { id: '600000000000000003', status: 'AWAITING_SHIPMENT' },
    ] } } };
  } };
  const mk = (tk) => S.criar({ prefixo: '/good-checkout-offline', empresa: 'good', tiktokConta: 'good', manifest: () => man, lerConferidos: () => conf,
    json: (res, c, b) => { res.c = c; res.b = b; }, validarSessao: () => null, ehAdmin: () => false, tiktokOAuth: () => tk });
  const pedir = async (rot, q) => { const res = { c: 0, b: null }; const t = await rot({ headers: {} }, res, new URL('http://h/good-checkout-offline/cancelados-antes-postagem' + q), 'GET'); return { t, c: res.c, b: res.b }; };
  const antes = JSON.stringify(man) + JSON.stringify(conf);

  const sem = await pedir(mk(tkOk), '');
  assert.strictEqual(sem.c, 404, 'a sonda abriu sem a chave de admin');
  const r = await pedir(mk(tkOk), '?k=adm-canc');
  assert.ok(r.t && r.c === 200 && r.b.ok === true && r.b.so_leitura === true, 'a sonda não respondeu: ' + JSON.stringify(r.b).slice(0, 200));
  const t = r.b.tiktok;
  assert.deepStrictEqual(t.contagem, { cancelado_antes_postagem: 1, cancelado_depois_de_postado: 1, ativo: 1, nao_sei: 1 }, 'contagem errada: ' + JSON.stringify(t.contagem));
  assert.strictEqual(t.ja_conferidos_ignorados, 1, 'o pedido já conferido pelo checkout entrou na sonda');
  assert.ok(chamadas.length === 1 && chamadas[0].p === '/order/202309/orders' && chamadas[0].metodo === 'GET' && chamadas[0].conta === 'good' && !String(chamadas[0].ids).includes('600000000000000004') && !String(chamadas[0].ids).includes('X1'),
    'a sonda perguntou errado ao TikTok (rota, conta, ou incluiu conferido/outro marketplace): ' + JSON.stringify(chamadas));
  const caso = t.pedidos.find((p) => p.numero_loja === '586826825515370453');
  assert.ok(caso && caso.veredito === 'cancelado_antes_postagem' && caso.campos.cancellation_initiator === 'BUYER' && caso.nf_numero === '129691' && typeof caso.horas_desde_nf === 'number', 'o caso do print não saiu com a evidência: ' + JSON.stringify(caso));
  assert.ok(t.pedidos.find((p) => p.numero_loja === '600000000000000002').veredito === 'cancelado_depois_de_postado', 'cancelado com coleta tinha que ir pro Devoluções');
  assert.ok(!t.pedidos.some((p) => p.numero_loja === '600000000000000003'), 'pedido ativo não precisa sair na lista (só na contagem)');
  assert.ok(Array.isArray(t.chaves_do_pedido) && t.chaves_do_pedido.includes('status'), 'os campos crus do TikTok não vieram (pra calibrar)');
  assert.strictEqual(JSON.stringify(man) + JSON.stringify(conf), antes, 'a sonda mexeu na fila (tinha que ser só leitura)');

  // 3) TikTok que falha: tudo "não sei" — nunca "ativo"
  const tkFalha = { lerToken: () => ({}), chamar: async () => ({ ok: false, http: 500, corpo: { code: 1, message: 'erro' } }) };
  const rf = await pedir(mk(tkFalha), '?k=adm-canc');
  assert.ok(rf.b.ok === false && rf.b.tiktok.erro && rf.b.tiktok.contagem.ativo === 0 && rf.b.tiktok.contagem.nao_sei === 4 && rf.b.tiktok.contagem.cancelado_antes_postagem === 0,
    'falha do TikTok virou veredito: ' + JSON.stringify(rf.b.tiktok.contagem));

  // 4) as três empresas montam a sonda com a conta delas
  for (const [arq, pref, conta] of [['girassol-backup-offline/gbo-app.js', '/girassol-backup-offline', 'girassol'], ['amb-checkout-offline/index.js', '/amb-checkout-offline', 'amb'], ['good-checkout-offline/index.js', '/good-checkout-offline', 'good']]) {
    const s = fs.readFileSync(path.join(raiz, arq), 'utf8');
    assert.ok(s.includes("require('../lib/checkout/rotas-cancelados-mkt').criar({ prefixo: '" + pref + "'") && s.includes("tiktokConta: '" + conta + "'") && s.includes('if (await _rotasCancMkt(req, res, urlObj, method)) return true;'),
      arq + ': não monta a sonda com a conta dela');
  }
  console.log('ok — sonda dos cancelados antes da postagem (TikTok): só não postado vira veredito; falha é "não sei"; só admin; só leitura; nas três');
  process.exit(0);
})().catch((e) => { console.error('FALHOU:', e.message); process.exit(1); });
