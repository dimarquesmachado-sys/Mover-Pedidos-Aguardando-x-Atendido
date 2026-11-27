'use strict';
/* 26/11 — A SONDA DOS CANCELADOS ANTES DA POSTAGEM, MERCADO LIVRE (lib/checkout/rotas-cancelados-mkt, ?mkt=ml).
   O dono pediu o aviso pras "vendas MLivre canceladas ou outros marketplaces", com a regra: "só pode ser de pedidos AINDA
   NÃO POSTADOS". O TikTok foi calibrado com um caso real antes de qualquer ação; o ML começa do mesmo jeito: SÓ LEITURA,
   com os campos crus, pra ver o que o Mercado Livre responde num cancelado de verdade.

   O que se prova (o código de produção):
   A. o veredito do ML: só "cancelled" entra; envio enviado/entregue/não entregue ou com data de envio/entrega/retorno é
      "depois de postado"; etiqueta pronta e rastreio NÃO são envio; cancelado com envio que não pôde ser lido é "não sei";
   B. a rota: só admin; só a fila do ML sem conferência; o envio só é lido de quem está cancelado; falha, limite e teto
      viram "não sei" (nunca "ativo"); sem nome de cliente; não mexe na fila; a sonda do TikTok segue igual;
   C. a cabeça comum passa o token do ML da empresa. */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const raiz = path.join(__dirname, '..');
process.env.ADMIN_KEY = 'adm-ml';
const M = require('../lib/checkout/rotas-cancelados-mkt');

(async () => {
  /* ═══ A. o veredito ═══ */
  const v = M.classificarML;
  const CANC = (extra) => Object.assign({ id: 1, status: 'cancelled', shipping: { id: 77 } }, extra || {});
  assert.deepStrictEqual(v(null), { veredito: 'nao_sei', via: 'ml_sem_o_pedido', sinais: [], etiqueta: [] });
  assert.deepStrictEqual(v({ id: 1 }), { veredito: 'nao_sei', via: 'ml_sem_status', sinais: [], etiqueta: [] });
  for (const st of ['paid', 'confirmed', 'payment_required', 'PAID']) assert.deepStrictEqual(v({ id: 1, status: st, shipping: { id: 7 } }, { status: 'shipped' }), { veredito: 'ativo', via: 'ml_status_' + st.toLowerCase(), sinais: [], etiqueta: [] });
  /* cancelado sem envio criado (nunca houve o que postar) */
  for (const sh of [undefined, null, {}, { id: null }]) assert.deepStrictEqual(v({ id: 1, status: 'cancelled', shipping: sh }), { veredito: 'cancelado_antes_postagem', via: 'ml_cancelado_sem_envio_criado', sinais: [], etiqueta: [] });
  /* cancelado COM envio, e o envio não veio: não sei */
  for (const [env, falhou] of [[null, false], [undefined, true], [{ status: 'cancelled' }, true], ['x', false]]) assert.deepStrictEqual(v(CANC(), env, falhou), { veredito: 'nao_sei', via: 'ml_cancelado_sem_ler_o_envio', sinais: [], etiqueta: [] }, JSON.stringify([env, falhou]));
  assert.deepStrictEqual(v(CANC(), {}), { veredito: 'nao_sei', via: 'ml_envio_sem_status', sinais: [], etiqueta: [] });
  /* cancelado, envio cancelado/pendente/em preparo, sem nenhum sinal */
  for (const se of ['cancelled', 'pending', 'handling', 'CANCELLED']) assert.deepStrictEqual(v(CANC(), { status: se }), { veredito: 'cancelado_antes_postagem', via: 'ml_cancelado_sem_sinal_de_envio', sinais: [], etiqueta: [] }, se);
  /* etiqueta não é envio — e fica anotada */
  assert.deepStrictEqual(v(CANC(), { status: 'ready_to_ship', tracking_number: 'BR1', status_history: { date_ready_to_ship: '2026-11-26T10:00:00Z', date_cancelled: '2026-11-26T10:05:00Z' } }),
    { veredito: 'cancelado_antes_postagem', via: 'ml_cancelado_com_etiqueta_gerada_sem_envio', sinais: [], etiqueta: ['pronto_pra_envio', 'data_pronto_pra_envio', 'rastreio'] });
  for (const [env, marca] of [[{ status: 'cancelled', tracking_number: 'X' }, 'rastreio'], [{ status: 'cancelled', status_history: { date_ready_to_ship: 'd' } }, 'data_pronto_pra_envio'], [{ status: 'ready_to_ship' }, 'pronto_pra_envio']]) {
    assert.deepStrictEqual(v(CANC(), env), { veredito: 'cancelado_antes_postagem', via: 'ml_cancelado_com_etiqueta_gerada_sem_envio', sinais: [], etiqueta: [marca] });
  }
  /* sinal de envio: cada um, sozinho, tira da lista */
  for (const [env, sinal] of [[{ status: 'shipped' }, 'envio_shipped'], [{ status: 'delivered' }, 'envio_delivered'], [{ status: 'not_delivered' }, 'envio_not_delivered'], [{ status: 'SHIPPED' }, 'envio_shipped'],
    [{ status: 'cancelled', status_history: { date_shipped: 'd' } }, 'date_shipped'], [{ status: 'cancelled', status_history: { date_delivered: 'd' } }, 'date_delivered'],
    [{ status: 'cancelled', status_history: { date_not_delivered: 'd' } }, 'date_not_delivered'], [{ status: 'cancelled', status_history: { date_returned: 'd' } }, 'date_returned'], [{ status: 'cancelled', status_history: { date_first_visit: 'd' } }, 'date_first_visit']]) {
    const r = v(CANC(), env);
    assert.deepStrictEqual([r.veredito, r.via, r.sinais], ['cancelado_depois_de_postado', 'ml_cancelado_com_sinal_de_envio', [sinal]], JSON.stringify(env));
  }
  assert.deepStrictEqual(v(CANC(), { status: 'shipped', tracking_number: 'X', status_history: { date_shipped: 'd', date_ready_to_ship: 'd' } }),
    { veredito: 'cancelado_depois_de_postado', via: 'ml_cancelado_com_sinal_de_envio', sinais: ['envio_shipped', 'date_shipped'], etiqueta: ['data_pronto_pra_envio', 'rastreio'] });
  assert.strictEqual(v(CANC(), { status: 'cancelled', status_history: 'torto' }).veredito, 'cancelado_antes_postagem', 'histórico torto não derruba');

  /* ═══ B. a rota ═══ */
  const man = {
    1: { numero: 101, marketplace: 'ml', numero_loja: '2000000000000001', cliente: 'FULANO DE TAL', nf_numero: '500', nf_emissao: '2026-11-26 09:00:00', tem_etiqueta: false },   /* cancelado, etiqueta sem envio */
    2: { numero: 102, marketplace: 'ML', numero_loja: 2000000000000002, cliente: 'BELTRANO', nf_numero: '501' },                                                              /* cancelado e ENVIADO */
    3: { numero: 103, marketplace: 'ml', numero_loja: '2000000000000003', cliente: 'CICLANO' },                                                                               /* ativo */
    4: { numero: 104, marketplace: 'ml', numero_loja: '2000000000000004' },                                                                                                   /* já conferido */
    5: { numero: 105, marketplace: 'tiktok', numero_loja: '2000000000000005' },                                                                                               /* outro marketplace */
    6: { numero: 106, marketplace: 'ml', numero_loja: null },                                                                                                                 /* sem número */
    7: { numero: 107, marketplace: 'ml', numero_loja: '2000000000000007' },                                                                                                   /* o ML não acha (404) */
    8: { numero: 108, marketplace: 'ml', numero_loja: '2000000000000008' },                                                                                                   /* cancelado, envio não lê */
    9: { numero: 109, marketplace: 'ml', numero_loja: '2000000000000009' },                                                                                                   /* cancelado sem envio criado */
  };
  const conf = { 4: { conferido_em: 'x' } };
  const antes = JSON.stringify(man) + JSON.stringify(conf);
  const PED = {
    2000000000000001: { id: 2000000000000001, status: 'cancelled', status_detail: null, tags: ['not_delivered'], date_created: 'dc', date_closed: 'dx', pack_id: 9, shipping: { id: 801 }, buyer: { nickname: 'COMPRADOR' },
      cancel_detail: { group: 'buyer', code: 'x1', description: 'desistiu', requested_by: 'buyer', date: 'dd', application_id: 1 } },
    2000000000000002: { id: 2000000000000002, status: 'cancelled', shipping: { id: 802 } },
    2000000000000003: { id: 2000000000000003, status: 'paid', shipping: { id: 803 } },
    2000000000000008: { id: 2000000000000008, status: 'cancelled', shipping: { id: 808 } },
    2000000000000009: { id: 2000000000000009, status: 'cancelled', shipping: {} },
  };
  const ENV = { 801: { id: 801, status: 'cancelled', substatus: null, logistic_type: 'cross_docking', mode: 'me2', tracking_number: 'BR1', status_history: { date_ready_to_ship: 'r', date_cancelled: 'c' }, receiver_address: { receiver_name: 'FULANO DE TAL' } },
    802: { id: 802, status: 'shipped', status_history: { date_shipped: 's' } } };
  const mk = (op) => {
    op = op || {};
    const idas = [];
    const rota = M.criar({ prefixo: '/x', empresa: 'emp', tiktokConta: 'c', json: (res, st, b) => { res.s = st; res.b = b; },
      validarSessao: (c) => (c === 'adm' ? { admin: true } : (c === 'est' ? { admin: false } : null)), ehAdmin: (s) => !!s.admin, manifest: () => op.man || man, lerConferidos: () => conf,
      tiktokOAuth: () => ({ lerToken: () => ({}), chamar: async () => { idas.push('TIKTOK'); return { ok: true, http: 200, corpo: { code: 0, data: { orders: [] } } }; } }),
      garantirTokenML: op.semToken ? undefined : async () => { if (op.tokenEstoura) throw new Error('x'); return op.token === undefined ? 'tok-ml' : op.token; },
      fetch: async (u, o) => {
        idas.push([u.replace('https://api.mercadolibre.com', ''), o.headers.Authorization, o.headers['x-format-new'] || null, o.timeout]);
        if (op.aoBuscar) { const r = op.aoBuscar(u, idas.length); if (r === 'ESTOURA') throw new Error('rede'); if (r) return r; }
        const mp = /\/packs\/(\d+)$/.exec(u); if (mp && (op.packs || {})[mp[1]]) return { ok: true, status: 200, json: async () => (op.packs || {})[mp[1]] };
        const mo = /\/orders\/(\d+)$/.exec(u), me = /\/shipments\/(\d+)$/.exec(u);
        const d = mo ? PED[mo[1]] : (me ? ENV[me[1]] : null);
        return d ? { ok: true, status: 200, json: async () => d } : { ok: false, status: 404, json: async () => ({}) };
      } });
    return { idas, pedir: async (qs, cookie) => { const u = new URL('http://h/x/cancelados-antes-postagem' + qs); const res = {}; const t = await rota({ headers: { cookie: cookie || '' } }, res, u, 'GET'); return Object.assign(res, { t }); } };
  };
  let a = mk();
  for (const [qs, ck] of [['?mkt=ml', ''], ['?mkt=ml&k=errada', ''], ['?mkt=ml', 'est']]) { const r = await a.pedir(qs, ck); assert.deepStrictEqual([r.s, r.b.error, a.idas.length], [404, 'not found', 0], 'só admin: ' + qs); }
  let r = await a.pedir('?mkt=ml', 'adm');
  assert.deepStrictEqual([r.s, r.b.ok, r.b.empresa, r.b.so_leitura, r.b.tiktok, /ainda não calibrada/.test(r.b.aviso)], [200, true, 'emp', true, undefined, true]);
  assert.deepStrictEqual([r.b.ml.na_fila, r.b.ml.ja_conferidos_ignorados, r.b.ml.consultados, r.b.ml.fora_do_teto, r.b.ml.erro, r.b.ml.contagem], [7, 1, 6, 0, null, { cancelado_antes_postagem: 2, cancelado_depois_de_postado: 1, ativo: 1, nao_sei: 3 }]);
  /* o que foi perguntado ao ML: um pedido por vez, com o token; o envio só de quem está cancelado e tem envio */
  assert.deepStrictEqual(a.idas, [['/orders/2000000000000001', 'Bearer tok-ml', null, 15000], ['/shipments/801', 'Bearer tok-ml', 'true', 15000], ['/orders/2000000000000002', 'Bearer tok-ml', null, 15000], ['/shipments/802', 'Bearer tok-ml', 'true', 15000],
    ['/orders/2000000000000003', 'Bearer tok-ml', null, 15000], ['/orders/2000000000000007', 'Bearer tok-ml', null, 15000], ['/packs/2000000000000007', 'Bearer tok-ml', null, 15000], ['/orders/2000000000000008', 'Bearer tok-ml', null, 15000], ['/shipments/808', 'Bearer tok-ml', 'true', 15000], ['/orders/2000000000000009', 'Bearer tok-ml', null, 15000]]);
  const porNum = Object.fromEntries(r.b.ml.pedidos.map((p) => [p.numero, p]));
  assert.deepStrictEqual(Object.keys(porNum), ['101', '102', '106', '107', '108', '109'], 'o ativo não vem na lista; o conferido e o de outro marketplace nem entram');
  assert.deepStrictEqual(porNum[101], { id: '1', numero: 101, numero_loja: '2000000000000001', nf_numero: '500', nf_emissao: '2026-11-26 09:00:00', tem_etiqueta: false, horas_desde_nf: porNum[101].horas_desde_nf,
    veredito: 'cancelado_antes_postagem', via: 'ml_cancelado_com_etiqueta_gerada_sem_envio', sinais: [], etiqueta: ['data_pronto_pra_envio', 'rastreio'],
    pedido: { status: 'cancelled', status_detail: null, tags: ['not_delivered'], date_created: 'dc', date_closed: 'dx', pack_id: 9, tem_envio: true, cancel_detail: { group: 'buyer', code: 'x1', description: 'desistiu', requested_by: 'buyer', date: 'dd' } },
    envio: { status: 'cancelled', logistic_type: 'cross_docking', mode: 'me2', tem_rastreio: true, status_history: { date_ready_to_ship: 'r', date_cancelled: 'c' } } });
  assert.deepStrictEqual([porNum[102].veredito, porNum[102].sinais, porNum[106].via, porNum[107].via, porNum[108].via, porNum[108].envio, porNum[109].via, porNum[109].pedido.tem_envio],
    ['cancelado_depois_de_postado', ['envio_shipped', 'date_shipped'], 'pedido_sem_numero_no_ml', 'ml_nao_devolveu_o_pedido_(http_404)', 'ml_cancelado_sem_ler_o_envio', null, 'ml_cancelado_sem_envio_criado', false]);
  assert.ok(!/FULANO|BELTRANO|CICLANO|COMPRADOR|cliente|receiver|nickname|BR1/.test(JSON.stringify(r.b)), 'a sonda do ML não leva dado de gente nem o rastreio');
  assert.strictEqual(JSON.stringify(man) + JSON.stringify(conf), antes, 'a sonda mexeu na fila');
  /* a sonda do TikTok (sem ?mkt) segue a mesma, e não chama o ML */
  a = mk(); r = await a.pedir('', 'adm'); assert.deepStrictEqual([!!r.b.tiktok, r.b.ml, a.idas.filter((x) => x !== 'TIKTOK').length], [true, undefined, 0]);
  a = mk(); r = await a.pedir('?mkt=outro', 'adm'); assert.ok(r.b.tiktok && !r.b.ml);
  /* falhas: nunca "ativo" */
  for (const [op, erro] of [[{ semToken: true }, 'esta empresa não passa o token do Mercado Livre pra sonda'], [{ token: '' }, 'sem token do Mercado Livre'], [{ token: null }, 'sem token do Mercado Livre'], [{ tokenEstoura: true }, 'sem token do Mercado Livre']]) {
    a = mk(op); r = await a.pedir('?mkt=ml', 'adm');
    assert.deepStrictEqual([r.b.ok, r.b.ml.erro, r.b.ml.contagem, a.idas.length, r.b.ml.pedidos.every((p) => p.veredito === 'nao_sei' && (p.via === 'ml_falhou' || p.via === 'pedido_sem_numero_no_ml'))], [false, erro, { cancelado_antes_postagem: 0, cancelado_depois_de_postado: 0, ativo: 0, nao_sei: 7 }, 0, true], JSON.stringify(op));
  }
  /* limite/autorização no meio: para de bater; o que já veio vale, o resto é "não sei" */
  for (const st of [429, 401, 403]) {
    a = mk({ aoBuscar: (u, n) => (n === 3 ? { ok: false, status: st, json: async () => ({}) } : null) }); r = await a.pedir('?mkt=ml', 'adm');
    assert.deepStrictEqual([r.b.ok, r.b.ml.erro, a.idas.length, r.b.ml.contagem], [false, 'o Mercado Livre respondeu ' + st, 3, { cancelado_antes_postagem: 1, cancelado_depois_de_postado: 0, ativo: 0, nao_sei: 6 }], 'http ' + st);
  }
  /* rede que cai num pedido: aquele é "não sei", os outros seguem; rede que cai no envio: "não sei" */
  a = mk({ aoBuscar: (u) => (/orders\/2000000000000002$|shipments\/801$/.test(u) ? 'ESTOURA' : null) }); r = await a.pedir('?mkt=ml', 'adm');
  { const pn = Object.fromEntries(r.b.ml.pedidos.map((p) => [p.numero, p.via])); assert.deepStrictEqual([r.b.ok, pn[101], pn[102], pn[109]], [true, 'ml_cancelado_sem_ler_o_envio', 'ml_nao_devolveu_o_pedido_(http_0)', 'ml_cancelado_sem_envio_criado']); }
  /* resposta que não é objeto: "não sei" */
  a = mk({ aoBuscar: (u) => (/orders\/2000000000000001$/.test(u) ? { ok: true, status: 200, json: async () => 'texto solto' } : null) }); r = await a.pedir('?mkt=ml', 'adm');
  assert.strictEqual(r.b.ml.pedidos.find((p) => p.numero === 101).veredito, 'nao_sei');
  /* o teto: 150 pedidos por consulta; o resto é dito e fica "não sei" */
  const grande = {}; for (let i = 11; i <= 170; i++) grande[i] = { numero: i, marketplace: 'ml', numero_loja: String(3000000000000000 + i) };
  a = mk({ man: grande }); r = await a.pedir('?mkt=ml', 'adm');
  assert.deepStrictEqual([r.b.ml.na_fila, r.b.ml.consultados, r.b.ml.fora_do_teto, a.idas.filter((x) => /^\/orders\//.test(x[0])).length, r.b.ml.pedidos.filter((p) => p.via === 'ml_nao_consultado_(teto)').length, r.b.ml.contagem.ativo], [160, 150, 10, 150, 10, 0]);
  /* PACK (carrinho): o número do Bling é o do pack (404 no pedido) — abre /packs e lê as vendas; só é "não postado" se TODAS forem */
  Object.assign(PED, { 4001: { id: 4001, status: 'cancelled', shipping: { id: 9001 } }, 4002: { id: 4002, status: 'cancelled', shipping: { id: 9002 } }, 4003: { id: 4003, status: 'cancelled', shipping: { id: 9003 } },
    4004: { id: 4004, status: 'paid', shipping: { id: 9004 } } });
  Object.assign(ENV, { 9001: { id: 9001, status: 'cancelled' }, 9002: { id: 9002, status: 'cancelled' }, 9003: { id: 9003, status: 'delivered' } });
  const packs = { 5001: { orders: [{ id: 4001 }, { id: 4002 }] }, 5002: { orders: [{ id: 4001 }, { id: 4003 }] }, 5003: { orders: [{ id: 4001 }, { id: 4004 }] }, 5004: { orders: [{ id: 4001 }, { id: 4999 }] }, 5005: { orders: [] } };
  const manPk = {}; [5001, 5002, 5003, 5004, 5005, 5006].forEach((n, i) => { manPk[i + 21] = { numero: 200 + i, marketplace: 'ml', numero_loja: String(n) }; });
  a = mk({ man: manPk, packs }); r = await a.pedir('?mkt=ml', 'adm');
  {
    const pn = Object.fromEntries(r.b.ml.pedidos.map((p) => [p.numero, p]));
    assert.deepStrictEqual([r.b.ok, pn[200].veredito, pn[200].via,pn[201].veredito, pn[202] === undefined, r.b.ml.contagem.ativo, pn[203].veredito, pn[203].via, pn[204].via, pn[205].via],
      [true, 'cancelado_antes_postagem', 'ml_pack_2_vendas_ml_cancelado_sem_sinal_de_envio', 'cancelado_depois_de_postado', true, 1, 'nao_sei', 'ml_pack_2_vendas_ml_pack_venda_sem_resposta_(http_404)', 'ml_nao_devolveu_o_pedido_(http_404)', 'ml_nao_devolveu_o_pedido_(http_404)'], 'pack');
    /* Codex #994: o cru que vem junto é o da venda que DECIDIU o veredito, e cada venda do pack aparece com o dela */
    assert.deepStrictEqual([pn[201].sinais, pn[201].envio.status, pn[201].pedido.pack_id], [['envio_delivered'], 'delivered', '5002'], 'o envio mostrado é o entregue (2ª venda), não o da 1ª cancelada');
    assert.deepStrictEqual(pn[201].vendas_do_pack, [
      { veredito: 'cancelado_antes_postagem', via: 'ml_cancelado_sem_sinal_de_envio', sinais: [], etiqueta: [], pedido_status: 'cancelled', envio_status: 'cancelled', envio_lido: true },
      { veredito: 'cancelado_depois_de_postado', via: 'ml_cancelado_com_sinal_de_envio', sinais: ['envio_delivered'], etiqueta: [], pedido_status: 'cancelled', envio_status: 'delivered', envio_lido: true }]);
    assert.deepStrictEqual([pn[200].vendas_do_pack.map((x) => x.veredito), pn[200].envio.status, pn[203].pedido, pn[203].envio, pn[203].vendas_do_pack.map((x) => [x.veredito, x.pedido_status, x.envio_lido])],
      [['cancelado_antes_postagem', 'cancelado_antes_postagem'], 'cancelled', null, null, [['cancelado_antes_postagem', 'cancelled', true], ['nao_sei', null, false]]], 'no "não sei", a venda mostrada é a que não respondeu');
    assert.ok(!('vendas_do_pack' in pn[204]), 'pedido avulso não leva a lista do pack');
  }
  /* pack em que a 2ª venda está cancelada mas o envio dela não leu: "não sei", e é ELA que aparece */
  a = mk({ man: { 21: { numero: 200, marketplace: 'ml', numero_loja: '5001' } }, packs, aoBuscar: (u) => (/shipments\/9002$/.test(u) ? { ok: false, status: 500, json: async () => ({}) } : null) }); r = await a.pedir('?mkt=ml', 'adm');
  {
    const p0 = r.b.ml.pedidos[0];
    assert.deepStrictEqual([p0.veredito, p0.via, p0.envio, p0.pedido.tem_envio, p0.vendas_do_pack.map((x) => [x.via, x.envio_lido])], ['nao_sei', 'ml_pack_2_vendas_ml_cancelado_sem_ler_o_envio', null, true, [['ml_cancelado_sem_sinal_de_envio', true], ['ml_cancelado_sem_ler_o_envio', false]]]);
  }
  /* limite/autorização no ENVIO (e no pack): para o lote inteiro, igual ao pedido */
  for (const st of [429, 401, 403]) {
    a = mk({ aoBuscar: (u) => (/shipments\/801$/.test(u) ? { ok: false, status: st, json: async () => ({}) } : null) }); r = await a.pedir('?mkt=ml', 'adm');
    assert.deepStrictEqual([r.b.ok, r.b.ml.erro, a.idas.length, r.b.ml.contagem.nao_sei, r.b.ml.pedidos.find((p) => p.numero === 101).via], [false, 'o Mercado Livre respondeu ' + st, 2, 7, 'ml_cancelado_sem_ler_o_envio'], 'envio ' + st);
    a = mk({ man: manPk, packs, aoBuscar: (u) => (/orders\/4002$/.test(u) ? { ok: false, status: st, json: async () => ({}) } : null) }); r = await a.pedir('?mkt=ml', 'adm');
    assert.deepStrictEqual([r.b.ok, r.b.ml.erro, a.idas.some((x) => /5002/.test(x[0]))], [false, 'o Mercado Livre respondeu ' + st, false], 'pack ' + st);
    /* o limite na PRÓPRIA leitura do pack (/packs/{id}): para ali — nenhuma venda dele é lida, o pack seguinte nem é tentado */
    a = mk({ man: manPk, packs, aoBuscar: (u) => (/packs\/5001$/.test(u) ? { ok: false, status: st, json: async () => ({}) } : null) }); r = await a.pedir('?mkt=ml', 'adm');
    assert.deepStrictEqual([r.b.ok, r.b.ml.erro, a.idas.map((x) => x[0]), r.b.ml.contagem.nao_sei === r.b.ml.na_fila], [false, 'o Mercado Livre respondeu ' + st, ['/orders/5001', '/packs/5001'], true], 'leitura do pack ' + st);
  }
  /* fila do ML vazia: ninguém é chamado */
  a = mk({ man: { 5: man[5] } }); r = await a.pedir('?mkt=ml', 'adm'); assert.deepStrictEqual([r.b.ok, r.b.ml.na_fila, r.b.ml.pedidos, a.idas.length], [true, 0, [], 0]);

  /* ═══ 27/11 — ?venda=: consulta vendas pelo número, estejam ou não na fila (calibrar com a cancelada que o Bling já tirou da fila) ═══ */
  a = mk(); r = await a.pedir('?mkt=ml&venda=2000000000000009,2000000000000003,%202000000000000001,2000000000000009', 'adm');
  assert.deepStrictEqual([r.s, r.b.ok, r.b.ml.vendas_pedidas, r.b.ml.na_fila, r.b.ml.consultados, r.b.ml.contagem], [200, true, ['2000000000000009', '2000000000000003', '2000000000000001'], 7, 3, { cancelado_antes_postagem: 2, cancelado_depois_de_postado: 0, ativo: 1, nao_sei: 0 }]);
  assert.deepStrictEqual(r.b.ml.pedidos.map((p) => [p.numero_loja, p.numero, p.veredito, p.na_fila, p.pedido.status]), [['2000000000000009', 109, 'cancelado_antes_postagem', true, 'cancelled'], ['2000000000000003', 103, 'ativo', true, 'paid'], ['2000000000000001', 101, 'cancelado_antes_postagem', true, 'cancelled']], 'só as pedidas, na ordem pedida, sem repetir; a ativa também aparece');
  assert.deepStrictEqual(a.idas.map((x) => x[0]), ['/orders/2000000000000009', '/orders/2000000000000003', '/orders/2000000000000001', '/shipments/801'], 'só as vendas pedidas são consultadas (a fila não é varrida)');
  /* venda que NÃO está na fila do galpão (o Bling já cancelou o pedido): consulta do mesmo jeito, sem dado nosso */
  PED[2000000000000055] = { id: 2000000000000055, status: 'cancelled', shipping: { id: 855 }, buyer: { nickname: 'COMPRADOR' } }; ENV[855] = { id: 855, status: 'cancelled', tracking_number: 'BR9', status_history: { date_cancelled: 'c' } };
  a = mk(); r = await a.pedir('?mkt=ml&venda=2000000000000055', 'adm');
  assert.deepStrictEqual([r.b.ml.pedidos.length, r.b.ml.pedidos[0].id, r.b.ml.pedidos[0].numero, r.b.ml.pedidos[0].na_fila, r.b.ml.pedidos[0].veredito, r.b.ml.pedidos[0].via, r.b.ml.pedidos[0].envio.status, r.b.ml.pedidos[0].nf_numero], [1, null, null, false, 'cancelado_antes_postagem', 'ml_cancelado_com_etiqueta_gerada_sem_envio', 'cancelled', null]);
  assert.ok(!/COMPRADOR|BR9/.test(JSON.stringify(r.b)), 'a consulta por venda também não leva dado de gente nem rastreio');
  /* venda que o ML não acha: "não sei", com o http */
  a = mk(); r = await a.pedir('?mkt=ml&venda=2999999999999999', 'adm'); assert.deepStrictEqual([r.b.ml.pedidos[0].veredito, r.b.ml.pedidos[0].na_fila, a.idas.map((x) => x[0])], ['nao_sei', false, ['/orders/2999999999999999', '/packs/2999999999999999']]);
  /* sem ?venda: a fila, como antes (a ativa não aparece, sem `na_fila` por pedido) */
  a = mk(); r = await a.pedir('?mkt=ml', 'adm'); assert.deepStrictEqual([r.b.ml.vendas_pedidas, r.b.ml.pedidos.some((p) => p.veredito === 'ativo' || 'na_fila' in p)], [undefined, false]);
  /* número torto, demais, ou sem ser admin */
  for (const ruim of ['abc', '12345', '2000000000000001;drop', '2000000000000001,x', '1'.repeat(21), Array.from({ length: 11 }, (_, i) => String(2000000000000100 + i)).join(',')]) { a = mk(); r = await a.pedir('?mkt=ml&venda=' + encodeURIComponent(ruim), 'adm'); assert.deepStrictEqual([r.s, r.b.ok, /use \?mkt=ml&venda=/.test(r.b.erro), a.idas.length], [400, false, true, 0], 'venda ' + ruim); }
  a = mk(); r = await a.pedir('?mkt=ml&venda=' + Array.from({ length: 10 }, (_, i) => String(2000000000000100 + i)).join(','), 'adm'); assert.strictEqual(r.b.ml.pedidos.length, 10, 'dez cabem');
  a = mk(); r = await a.pedir('?mkt=ml&venda=2000000000000001', 'est'); assert.deepStrictEqual([r.s, a.idas.length], [404, 0]);
  /* Codex #998: a venda pedida está na fila sob o número do PACK (é o que o Bling guardou) — `na_fila` tem que dizer sim */
  PED[2000000000000061] = { id: 2000000000000061, status: 'cancelled', pack_id: 2000000000007001, shipping: {} };
  PED[2000000000000062] = { id: 2000000000000062, status: 'paid', pack_id: null, shipping: { id: 862 } };
  PED[2000000000000063] = { id: 2000000000000063, status: 'paid', pack_id: 2000000000007009, shipping: { id: 863 } };
  {
    const manP = { 31: { numero: 300, marketplace: 'ml', numero_loja: '2000000000007001', nf_numero: '700', tem_etiqueta: true }, 32: { numero: 301, marketplace: 'ml', numero_loja: '2000000000000062', nf_numero: '701' }, 33: { numero: 302, marketplace: 'ml', numero_loja: null } };
    const pk = { 2000000000007002: { orders: [{ id: 2000000000000099 }, { id: 2000000000000062 }] } };
    a = mk({ man: manP, packs: pk }); r = await a.pedir('?mkt=ml&venda=2000000000000061,2000000000007002,2000000000000063,2000000000000055', 'adm');
    assert.deepStrictEqual(r.b.ml.pedidos.map((p) => [p.numero_loja, p.na_fila, p.na_fila_como, p.id, p.numero, p.nf_numero, p.veredito]), [
      ['2000000000000061', true, '2000000000007001', '31', 300, '700', 'cancelado_antes_postagem'],   /* a fila guarda o pack; pediram a venda */
      ['2000000000007002', true, '2000000000000062', '32', 301, '701', 'nao_sei'],                    /* a fila guarda a venda; pediram o pack (a outra venda dele não respondeu) */
      ['2000000000000063', false, undefined, null, null, null, 'ativo'],                               /* o pack dela não está na fila */
      ['2000000000000055', false, undefined, null, null, null, 'cancelado_antes_postagem']]);          /* sem pack: não casa com o pedido sem número da fila */
    assert.strictEqual(r.b.ml.pedidos[0].tem_etiqueta, true);
    /* pedida pelo número que a fila guarda: sem `na_fila_como` */
    a = mk({ man: manP, packs: pk }); r = await a.pedir('?mkt=ml&venda=2000000000000062', 'adm'); assert.deepStrictEqual([r.b.ml.pedidos[0].na_fila, 'na_fila_como' in r.b.ml.pedidos[0], r.b.ml.pedidos[0].numero], [true, false, 301]);
  }
  delete PED[2000000000000061]; delete PED[2000000000000062]; delete PED[2000000000000063];
  delete PED[2000000000000055]; delete ENV[855];

  /* ═══ C. a cabeça comum passa o token do ML da empresa ═══ */
  const cab = fs.readFileSync(path.join(raiz, 'lib', 'checkout', 'cabeca-routes.js'), 'utf8');
  assert.ok(cab.includes("garantirTokenML: cfg.mlTokenManager ? () => require(path.join(RAIZ, cfg.mlTokenManager)).garantirTokenML() : null }));"), 'a cabeça não passa o token do ML à sonda');
  const { configCheckout } = require('../lib/checkout/config-empresa');
  for (const emp of ['girassol', 'amb', 'good']) { const c = configCheckout(emp); assert.ok(c.mlTokenManager && typeof require(path.join(raiz, c.mlTokenManager)).garantirTokenML === 'function', emp + ': o gerenciador do token do ML não tem garantirTokenML'); }
  console.log('ok — sonda dos cancelados antes da postagem (Mercado Livre): só leitura; cancelado com envio enviado/entregue é do Devoluções; etiqueta não é envio; falha, limite e teto são "não sei"; sem dado de gente; só admin');
  process.exit(0);
})().catch((e) => { console.error('FALHOU:', e && e.stack || e); process.exit(1); });
