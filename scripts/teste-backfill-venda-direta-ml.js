'use strict';
/* 14/11 — A VENDA QUE SÓ EXISTE NO MERCADO LIVRE NÃO GANHA MAIS MARGEM CHEIA (lib/checkout/venda-direta-ml.js, no motor).

   O CASO (AMB, sexta 13/11): as vendas diretas do ML do dia — o Full, que nunca vira pedido no Bling — estavam na base com
   comissão 0 e frete 0, porque o motor só olhava a FATURA do ML e ela chega aos pedaços, dias depois. Um carrinho CM1 de
   R$ 249,00 aparecia com margem R$ 121,51; a de verdade (a da tela) era R$ 51,08. O chat leu a base e disse "a margem
   não piorou".

   O que se prova, com o `backfillVendas` de PRODUÇÃO (Bling, ML e banco de mentira) e a pesca de PRODUÇÃO (lib/ml-pesca.js):
   A. as peças: a tarifa que vem na venda, o que é "recente", e a cascata inteira (cada fonte).
   B. no motor: o CM1 do caso sai com comissão R$ 21,08, frete R$ 49,35 e margem R$ 51,08 — o número da tela; a fatura
      continua mandando quando existe (e a metade que falta vem do ML); Flex e venda sem envio não inventam frete; o ML
      que não responde o envio fica em zero como era, mas CONTADO; venda antiga não sai consultando envio. */
const assert = require('assert');
const fs = require('fs');
require('./_gbo-com-motor').instalar();
const os = require('os');
const path = require('path');
const raiz = path.join(__dirname, '..');

let _chegouAoFim = false;
process.on('exit', (code) => { if (!_chegouAoFim && code === 0) { console.error('FALHOU: o teste acabou SEM chegar ao fim (alguma espera nunca terminou)'); process.exitCode = 1; } });

const dirGir = fs.mkdtempSync(path.join(os.tmpdir(), 'gir-')), dirTk = fs.mkdtempSync(path.join(os.tmpdir(), 'tk-')), dirGood = fs.mkdtempSync(path.join(os.tmpdir(), 'goo-'));
process.env.GIRABKP_CACHE_DIR = dirGir; process.env.TIKTOK_CACHE_DIR = dirTk;
fs.writeFileSync(path.join(dirGood, '_custos.json'), JSON.stringify({ CM1: { custo: 102.59 } }));

const V = require('../lib/checkout/venda-direta-ml');
/* as datas são contadas a partir de HOJE (a regra do "recente" olha o relógio de verdade) */
const hojeSP = new Date().toLocaleString('sv-SE', { timeZone: 'America/Sao_Paulo' }).slice(0, 10);
const rel = (n) => { const d = new Date(hojeSP + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() - n); return d.toISOString().slice(0, 10); };

/* ── o ML de mentira ── a LISTA de vendas chega pelo node-fetch (o motor); a PESCA usa o fetch global (lib/ml-pesca.js) */
const ml = { vendas: [], envios: {}, pescas: [] };
const resp = (b, st) => ({ ok: !st || st < 300, status: st || 200, json: async () => b, text: async () => JSON.stringify(b) });
require.cache[require.resolve('node-fetch')] = { id: 'node-fetch', filename: 'node-fetch', loaded: true, exports: async (url) => {
  const u = String(url);
  if (/api\.mercadolibre\.com\/users\/me/.test(u)) return resp({ id: 999 });
  if (/api\.mercadolibre\.com\/orders\/search/.test(u)) {
    const q = new URL(u).searchParams;
    const de = Date.parse(q.get('order.date_created.from')), ate = Date.parse(q.get('order.date_created.to')), off = Number(q.get('offset') || 0);
    const todas = ml.vendas.filter((v) => { const t = Date.parse(v.date_created); return t >= de && t <= ate; });
    return resp({ paging: { total: todas.length }, results: todas.slice(off, off + 50) });
  }
  return resp({}, 404);
} };
global.fetch = async (url) => {
  const u = String(url);
  let m = /api\.mercadolibre\.com\/orders\/(\d+)$/.exec(u);
  if (m) { ml.pescas.push('venda ' + m[1]); const v = ml.vendas.find((x) => String(x.id) === m[1]); return v ? resp(v) : resp({}, 404); }
  m = /api\.mercadolibre\.com\/shipments\/(\d+)\/costs$/.exec(u);
  if (m) { ml.pescas.push('custos ' + m[1]); const e = ml.envios[m[1]]; return (!e || e.custosFora) ? resp({}, 500) : resp(e.custos); }
  m = /api\.mercadolibre\.com\/shipments\/(\d+)$/.exec(u);
  if (m) { ml.pescas.push('envio ' + m[1]); const e = ml.envios[m[1]]; return (!e || e.envioFora) ? resp({}, 500) : resp(e.envio); }
  return resp({}, 404);
};
const venda = (oid, dia, o) => Object.assign({ id: oid, status: 'paid', date_created: dia + 'T12:00:00.000-03:00', total_amount: 249,
  order_items: [{ quantity: 1, unit_price: 249, sale_fee: (o && 'tarifa' in o) ? o.tarifa : 21.08, item: { seller_sku: 'CM1', title: 'Carrinho de ferramentas CM1' } }] }, (o && o.envio) ? { shipping: { id: o.envio } } : {});

const blingGet = async () => ({ ok: true, status: 200, data: { data: [] } });   /* o Bling não tem nenhuma destas vendas */
const base = { gravadas: [] };
const supaReq = async (emp, met, q, body) => {
  if (met === 'POST' && Array.isArray(body)) { base.gravadas.push(...body); return { ok: true, status: 201, body: '[]' }; }
  if (met === 'POST' && /rpc\/trocar_periodo_historico/.test(q)) return { ok: true, status: 200, body: JSON.stringify({ apagadas: 0, inseridas: body.p_esperadas }) };
  return { ok: true, status: 200, body: '[]' };
};

(async () => {
  const _log = console.log; console.log = () => {};
  let falhou = null;
  try {
    /* ═══ A. AS PEÇAS ═══ */
    {
      assert.deepStrictEqual([V.tarifaDaVenda({ order_items: [{ quantity: 2, sale_fee: 10.54 }, { quantity: 1, sale_fee: 3.3 }] }), V.tarifaDaVenda({ order_items: [{ quantity: 1 }] }), V.tarifaDaVenda({ order_items: [{ quantity: 1, sale_fee: 0 }] }),
        V.tarifaDaVenda({}), V.tarifaDaVenda(null), V.tarifaDaVenda({ order_items: [{ sale_fee: 5 }] }), V.tarifaDaVenda({ order_items: [{ quantity: 1, sale_fee: 'x' }, { quantity: 1, sale_fee: 7 }] })],
        [24.38, null, null, null, null, 5, 7], 'tarifa × quantidade, somada; venda sem tarifa é "não sei" (null), nunca zero');
      assert.strictEqual(V.DIAS_RECENTE, 45);
      assert.deepStrictEqual([V.recente('2026-10-01', '2026-11-14'), V.recente('2026-09-30', '2026-11-14'), V.recente('2026-09-29', '2026-11-14'), V.recente('2026-11-14', '2026-11-14'), V.recente(null, '2026-11-14'), V.recente('lixo', '2026-11-14')], [true, true, false, true, true, true],
        '44 dias é recente, 45 também, 46 não; sem saber o dia, trata como recente (pergunta ao ML)');
      const pescas = [];
      const cf = (o) => V.comissaoEFrete(Object.assign({ hoje: '2026-11-14', diaDaVenda: '2026-11-13', pescar: async (id) => { pescas.push(id); return o && o.reg !== undefined ? o.reg : { frete: 49.35, costs_ok: true }; } }, o));
      const v0 = { id: 77, order_items: [{ quantity: 1, sale_fee: 21.08 }], shipping: { id: 9 } };
      /* comissão: fatura → tarifa da venda → não sei */
      assert.deepStrictEqual(await cf({ venda: v0, comissaoDaFatura: 25.5, freteDaFatura: 12 }), { comissao: 25.5, comFonte: 'fatura', frete: 12, freFonte: 'fatura' });
      assert.strictEqual(pescas.length, 0, 'com o frete na fatura não se pergunta nada ao ML');
      assert.deepStrictEqual(await cf({ venda: v0 }), { comissao: 21.08, comFonte: 'venda', frete: 49.35, freFonte: 'envio' });
      assert.deepStrictEqual(pescas, ['77']);
      assert.deepStrictEqual(await cf({ venda: { id: 78, order_items: [{ quantity: 1 }] }, freteDaFatura: 0 }), { comissao: null, comFonte: 'nao_sei', frete: 0, freFonte: 'fatura' }, 'frete ZERO na fatura é frete conhecido');
      assert.deepStrictEqual((await cf({ venda: v0, comissaoDaFatura: 0 })).comFonte, 'fatura', 'comissão zero NA FATURA é o que a fatura diz');
      /* frete: venda antiga sem linha na fatura; recente sem envio; envio sem custo; ML sem resposta */
      pescas.length = 0;
      assert.deepStrictEqual([(await cf({ venda: v0, diaDaVenda: '2026-09-01' })).freFonte, (await cf({ venda: { id: 79, order_items: [] } })).freFonte, pescas.length], ['fatura_sem_frete', 'sem_envio', 0], 'nenhum dos dois consulta o envio');
      assert.deepStrictEqual(await cf({ venda: v0, reg: { frete: null, costs_ok: true, logistica: 'self_service' } }), { comissao: 21.08, comFonte: 'venda', frete: 0, freFonte: 'envio_sem_custo' });
      for (const reg of [null, {}, { frete: null, ship_ok: true }, { frete: 'x', costs_ok: false }, { frete: NaN }])
        assert.deepStrictEqual([(await cf({ venda: v0, reg })).frete, (await cf({ venda: v0, reg })).freFonte], [null, 'nao_sei'], 'o ML não respondeu os custos do envio: NÃO SEI (nunca "zero confirmado") — ' + JSON.stringify(reg));
      assert.deepStrictEqual((await V.comissaoEFrete({ venda: v0, hoje: '2026-11-14', diaDaVenda: '2026-11-13', pescar: async () => { throw new Error('rede'); } })).freFonte, 'nao_sei');
      assert.deepStrictEqual((await cf({ venda: v0, reg: { frete: 12.345, costs_ok: true } })).frete, 12.35);
    }

    /* ═══ B. NO MOTOR ═══ */
    const gbo = require(path.join(raiz, 'girassol-backup-offline', 'gbo-app.js'));
    const readJson = (f, pad) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return pad; } };
    const aliq = {}; for (const n of [0, 1, 2, 3, 59, 60, 61, 62]) aliq[rel(n).slice(0, 7)] = 10;
    const ctx = { blingGet, readJson, CACHE_DIR: dirGood, supaReq, supaCount: async () => null, DEFAULT_ALIQ_BK: aliq, aliqReserva: 10,
      custoVigenteEm: () => 102.59, garantirTokenML: async () => 'tk-good', LOJA_MKT: { '701': 'ml' }, mapasBilling: null, escrowEmLote: null, escrowDoPedido: null, magaluFreteSkuLer: () => ({}) };
    const rodar = async (de, ate) => {
      base.gravadas.length = 0; ml.pescas.length = 0;
      const r = await gbo.backfillVendas(de, ate, 'good', ctx);
      const linha = {}; for (const l of base.gravadas) linha[l.numero_loja] = [Number(l.comissao), Number(l.frete_vendedor), l.margem == null ? null : Number(l.margem), Number(l.imposto), Number(l.custo)];
      return { r, linha };
    };
    const ONTEM = rel(1);
    const CM1 = { envio: { logistic: { type: 'fulfillment' }, shipping_option: {} }, custos: { senders: [{ cost: 49.35 }] } };
    ml.vendas = [
      venda(2000000000000001, ONTEM, { envio: 9001 }),                    /* o caso: sem fatura nenhuma */
      venda(2000000000000002, ONTEM, { envio: 9002 }),                    /* a fatura já trouxe a COMISSÃO (com parcelamento), o frete ainda não */
      venda(2000000000000003, ONTEM, { envio: 9003, tarifa: undefined }), /* a fatura já trouxe o FRETE; a venda não informa tarifa */
      venda(2000000000000004, ONTEM, { envio: 9004 }),                    /* Flex: o ML responde os custos e o vendedor não paga envio */
      venda(2000000000000005, ONTEM, { envio: 9005 }),                    /* o ML não responde os custos do envio */
      venda(2000000000000006, ONTEM, {}),                                 /* sem envio */
      venda(2000000000000007, rel(60), { envio: 9007 }),                  /* venda antiga, sem linha de frete na fatura */
    ];
    ml.envios = { 9001: CM1, 9002: CM1, 9003: CM1, 9004: { envio: { logistic: { type: 'self_service' }, shipping_option: {} }, custos: { senders: [{ cost: 0 }], gross_amount: 8.9 } },
      9005: { envio: { logistic: { type: 'fulfillment' }, shipping_option: {} }, custosFora: true }, 9007: CM1 };
    fs.writeFileSync(path.join(dirGood, '_ml_billing.json'), JSON.stringify({ tarifas: {
      a: { o: '2000000000000002', c: 'comissao', v: 21.08 }, b: { o: '2000000000000002', c: 'parcelamento', v: 4.42 },
      c: { o: '2000000000000003', c: 'frete', v: 31.9 } } }));

    let x = await rodar(rel(2), ONTEM);
    assert.ok(x.r && x.r.ok && x.r.desfecho === 'ok', 'a rodada não fechou: ' + JSON.stringify({ d: x.r && x.r.desfecho, m: x.r && x.r.msg, ml: x.r && x.r.msg_ml }));
    /* [comissão, frete, margem, imposto, custo] — R$ 249,00, custo R$ 102,59, imposto 10% */
    assert.deepStrictEqual(x.linha['2000000000000001'], [21.08, 49.35, 51.08, 24.9, 102.59], 'O CASO: comissão R$ 21,08 (a tarifa da venda), frete R$ 49,35 (o envio) e margem R$ 51,08 — a da tela; antes saía 0 / 0 / R$ 121,51');
    assert.deepStrictEqual(x.linha['2000000000000002'], [25.5, 49.35, 46.66, 24.9, 102.59], 'a comissão é a da FATURA (21,08 + 4,42 de parcelamento); o frete que a fatura ainda não trouxe vem do envio');
    assert.deepStrictEqual(x.linha['2000000000000003'], [0, 31.9, 89.61, 24.9, 102.59], 'o frete é o da FATURA; a comissão ninguém sabe: fica zero como era — e é contada como "não sei"');
    assert.deepStrictEqual(x.linha['2000000000000004'], [21.08, 0, 100.43, 24.9, 102.59], 'Flex: o ML respondeu os custos e o vendedor não paga envio — zero conhecido');
    assert.deepStrictEqual(x.linha['2000000000000005'], [21.08, 0, 100.43, 24.9, 102.59], 'o ML não respondeu os custos: zero como era — contado como "não sei"');
    assert.deepStrictEqual(x.linha['2000000000000006'], [21.08, 0, 100.43, 24.9, 102.59]);
    assert.deepStrictEqual(x.r.do_marketplace.comissao, { venda: 4, fatura: 1, nao_sei: 1 });
    assert.deepStrictEqual(x.r.do_marketplace.frete, { envio: 2, fatura: 1, envio_sem_custo: 1, nao_sei: 1, sem_envio: 1 });
    assert.deepStrictEqual([x.r.do_marketplace.vendas, x.r.do_marketplace.linhas], [6, 6]);
    /* o envio só é perguntado pra quem precisa: nem a que já tem o frete na fatura (3), nem a sem envio (6) */
    assert.deepStrictEqual(ml.pescas.filter((p) => /^venda /.test(p)).map((p) => p.slice(-1)).sort(), ['1', '2', '4', '5']);
    assert.ok(ml.pescas.includes('custos 9001') && ml.pescas.includes('envio 9004') && !ml.pescas.some((p) => / 9003$| 9007$/.test(p)), ml.pescas.join(' | '));

    /* venda ANTIGA (60 dias) sem linha de frete na fatura: zero como sempre foi, e NENHUMA consulta de envio (a rodada do
       ano não sai perguntando o envio de milhares de vendas velhas) */
    x = await rodar(rel(61), rel(59));
    assert.ok(x.r.ok);
    assert.deepStrictEqual(x.linha['2000000000000007'], [21.08, 0, 100.43, 24.9, 102.59], 'a comissão continua vindo da própria venda (é de graça); o frete é o que a fatura fechada diz: nenhum');
    assert.deepStrictEqual([x.r.do_marketplace.comissao, x.r.do_marketplace.frete, ml.pescas.length], [{ venda: 1 }, { fatura_sem_frete: 1 }, 0]);
  } catch (e) { falhou = e; }
  finally { console.log = _log; }
  if (falhou) { console.error('FALHOU:', falhou.stack || falhou.message); process.exit(1); }
  console.log('ok — venda direta do Mercado Livre: sem a fatura, a comissão é a tarifa da própria venda e o frete é o custo do envio (a pesca de produção) — o CM1 do caso sai com a margem da tela (R$ 51,08, não R$ 121,51); a fatura manda quando existe; Flex e venda sem envio não inventam frete; "não sei" segue zero e é contado; venda antiga não consulta envio');
  _chegouAoFim = true;
  process.exit(0);
})();
