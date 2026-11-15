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
      que não responde o envio fica em zero como era, mas CONTADO; venda antiga não sai consultando envio.
   C. O FRETE É DO ENVIO (Codex #878, P1): duas vendas do mesmo carrinho dividem UM envio — a pesca devolve o custo
      inteiro pra cada uma, e perguntando venda a venda um envio de R$ 49,35 ia pra base como R$ 98,70. Agora o envio é
      perguntado UMA vez e repartido; se a fatura já cobrou o envio numa das vendas, a irmã não paga de novo (em qualquer
      ordem em que cheguem); vale com as irmãs em páginas diferentes da busca e em JANELAS diferentes da rodada — inclusive
      quando só a venda da janela de DEPOIS tem a fatura (2º apontamento do Codex: a de antes já tinha levado o custo do
      envio, e a fatura entrava por cima: R$ 98,70 de novo). O motor lê todas as janelas antes de gravar. */
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
const venda = (oid, dia, o) => Object.assign({ id: oid, status: 'paid', date_created: dia + 'T12:00:00.000-03:00', total_amount: (o && o.preco) || 249,
  order_items: [{ quantity: 1, unit_price: (o && o.preco) || 249, sale_fee: (o && 'tarifa' in o) ? o.tarifa : 21.08, item: { seller_sku: 'CM1', title: 'Carrinho de ferramentas CM1' } }] },
  (o && o.envio) ? { shipping: { id: o.envio } } : {}, (o && o.carrinho) ? { pack_id: o.carrinho } : {});

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
      /* comissão de UMA venda: fatura → tarifa da venda → não sei */
      const v0 = { id: 77, order_items: [{ quantity: 1, sale_fee: 21.08 }], shipping: { id: 9 } };
      assert.deepStrictEqual([V.comissaoDaVenda(v0, 25.5), V.comissaoDaVenda(v0, undefined), V.comissaoDaVenda(v0, 0), V.comissaoDaVenda({ id: 78, order_items: [{ quantity: 1 }] }, null), V.comissaoDaVenda(v0, '')],
        [{ comissao: 25.5, comFonte: 'fatura' }, { comissao: 21.08, comFonte: 'venda' }, { comissao: 0, comFonte: 'fatura' }, { comissao: null, comFonte: 'nao_sei' }, { comissao: 21.08, comFonte: 'venda' }],
        'comissão zero NA FATURA é o que a fatura diz; sem fatura e sem tarifa na venda é "não sei"');
      assert.deepStrictEqual([V.chaveDoEnvio(v0), V.chaveDoEnvio({ shipping: { id: 0 } }), V.chaveDoEnvio({ shipping: {} }), V.chaveDoEnvio({ shipping: { id: '' } }), V.chaveDoEnvio({}), V.chaveDoEnvio(null)], ['9', '0', null, null, null, null]);

      /* o frete de UM envio (uma venda sozinha é o envio de uma venda só) */
      const pescas = [];
      const fe = (vendas, o) => V.fretesDoEnvio(Object.assign({ hoje: '2026-11-14', vendas: vendas.map((v) => Object.assign({ diaDaVenda: '2026-11-13', valor: 249 }, v)),
        pescar: async (id) => { pescas.push(id); return o && o.reg !== undefined ? o.reg : { frete: 49.35, costs_ok: true }; } }));
      assert.deepStrictEqual(await V.fretesDoEnvio({ vendas: [], pescar: async () => { throw new Error('não era pra perguntar'); } }), []);
      assert.deepStrictEqual(await fe([{ venda: v0, freteDaFatura: 12 }]), [{ frete: 12, freFonte: 'fatura' }]);
      assert.deepStrictEqual(await fe([{ venda: v0, freteDaFatura: 0 }]), [{ frete: 0, freFonte: 'fatura' }], 'frete ZERO na fatura é frete conhecido');
      assert.strictEqual(pescas.length, 0, 'com o frete na fatura não se pergunta nada ao ML');
      assert.deepStrictEqual(await fe([{ venda: v0 }]), [{ frete: 49.35, freFonte: 'envio' }]);
      assert.deepStrictEqual(pescas, ['77']);
      /* venda antiga sem linha na fatura; recente sem envio; envio sem custo; ML sem resposta */
      pescas.length = 0;
      assert.deepStrictEqual([(await fe([{ venda: v0, diaDaVenda: '2026-09-01' }]))[0].freFonte, (await fe([{ venda: { id: 79, order_items: [] } }]))[0].freFonte, pescas.length], ['fatura_sem_frete', 'sem_envio', 0], 'nenhum dos dois consulta o envio');
      assert.deepStrictEqual(await fe([{ venda: v0 }], { reg: { frete: null, costs_ok: true, logistica: 'self_service' } }), [{ frete: 0, freFonte: 'envio_sem_custo' }]);
      for (const reg of [null, {}, { frete: null, ship_ok: true }, { frete: 'x', costs_ok: false }, { frete: NaN }])
        assert.deepStrictEqual(await fe([{ venda: v0 }], { reg }), [{ frete: null, freFonte: 'nao_sei' }], 'o ML não respondeu os custos do envio: NÃO SEI (nunca "zero confirmado") — ' + JSON.stringify(reg));
      assert.deepStrictEqual(await V.fretesDoEnvio({ hoje: '2026-11-14', vendas: [{ venda: v0, diaDaVenda: '2026-11-13', valor: 1 }], pescar: async () => { throw new Error('rede'); } }), [{ frete: null, freFonte: 'nao_sei' }]);
      assert.deepStrictEqual((await fe([{ venda: v0 }], { reg: { frete: 12.345, costs_ok: true } }))[0].frete, 12.35);

      /* ── UM envio, VÁRIAS vendas (Codex #878) ── */
      const a = { id: 81, shipping: { id: 9 } }, b = { id: 82, shipping: { id: 9 } }, c = { id: 83, shipping: { id: 9 } };
      const soma = (r) => Math.round(r.reduce((t, x) => t + x.frete, 0) * 100) / 100;
      pescas.length = 0;
      let r = await fe([{ venda: a, valor: 249 }, { venda: b, valor: 100 }]);
      assert.deepStrictEqual(r, [{ frete: 35.21, freFonte: 'envio' }, { frete: 14.14, freFonte: 'envio' }], 'o envio de R$ 49,35 repartido pelo valor de cada venda (249 e 100)');
      assert.deepStrictEqual([soma(r), pescas], [49.35, ['81']], 'a soma é o custo do envio — UMA vez — e o ML é perguntado UMA vez');
      r = await fe([{ venda: a, valor: 100 }, { venda: b, valor: 100 }, { venda: c, valor: 100 }]);
      assert.deepStrictEqual([r.map((x) => x.frete), soma(r)], [[16.45, 16.45, 16.45], 49.35]);
      r = await fe([{ venda: a, valor: 10 }, { venda: b, valor: 10 }, { venda: c, valor: 10 }], { reg: { frete: 0.1, costs_ok: true } });
      assert.deepStrictEqual([r.map((x) => x.frete), soma(r)], [[0.03, 0.03, 0.04], 0.1], 'a última venda fica com o que sobra do arredondamento: a soma fecha no centavo');
      r = await fe([{ venda: a, valor: 1 }, { venda: b, valor: 1 }, { venda: c, valor: 0 }], { reg: { frete: 0.01, costs_ok: true } });
      assert.ok(soma(r) === 0.01 && r.every((x) => x.frete >= 0), 'dois arredondamentos pra cima não podem deixar parte NEGATIVA: ' + JSON.stringify(r.map((x) => x.frete)));
      r = await fe([{ venda: a, valor: 0 }, { venda: b, valor: null }], { reg: { frete: 10, costs_ok: true } });
      assert.deepStrictEqual(r.map((x) => x.frete), [5, 5], 'sem valor pra repartir, partes iguais');
      /* a fatura já cobrou o envio em UMA das vendas: vale a fatura ali; a irmã não paga de novo — e ninguém pergunta ao ML */
      pescas.length = 0;
      assert.deepStrictEqual(await fe([{ venda: a, freteDaFatura: 31.9 }, { venda: b }]), [{ frete: 31.9, freFonte: 'fatura' }, { frete: 0, freFonte: 'fatura_no_carrinho' }]);
      assert.deepStrictEqual(await fe([{ venda: a }, { venda: b, freteDaFatura: 31.9 }]), [{ frete: 0, freFonte: 'fatura_no_carrinho' }, { frete: 31.9, freFonte: 'fatura' }], 'em qualquer ordem');
      assert.deepStrictEqual(await fe([{ venda: a, freteDaFatura: 20 }, { venda: b, freteDaFatura: 0 }]), [{ frete: 20, freFonte: 'fatura' }, { frete: 0, freFonte: 'fatura' }]);
      assert.strictEqual(pescas.length, 0, 'nenhum desses casos pergunta o envio ao ML');
      /* "recente" é do ENVIO: basta uma venda recente nele pra perguntar (e nenhuma recente: não pergunta) */
      assert.deepStrictEqual((await fe([{ venda: a, diaDaVenda: '2026-09-01' }, { venda: b, diaDaVenda: '2026-11-13' }])).map((x) => x.freFonte), ['envio', 'envio']);
      pescas.length = 0;
      assert.deepStrictEqual([(await fe([{ venda: a, diaDaVenda: '2026-09-01' }, { venda: b, diaDaVenda: '2026-09-02' }])).map((x) => x.freFonte), pescas.length], [['fatura_sem_frete', 'fatura_sem_frete'], 0]);
      /* o ML não respondeu: NÃO SEI pras duas (não é zero confirmado), e Flex é zero conhecido pras duas */
      assert.deepStrictEqual(await fe([{ venda: a }, { venda: b }], { reg: null }), [{ frete: null, freFonte: 'nao_sei' }, { frete: null, freFonte: 'nao_sei' }]);
      assert.deepStrictEqual(await fe([{ venda: a }, { venda: b }], { reg: { frete: null, costs_ok: true } }), [{ frete: 0, freFonte: 'envio_sem_custo' }, { frete: 0, freFonte: 'envio_sem_custo' }]);
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
      const linha = {}, ped = {}; for (const l of base.gravadas) { linha[l.numero_loja] = [Number(l.comissao), Number(l.frete_vendedor), l.margem == null ? null : Number(l.margem), Number(l.imposto), Number(l.custo)]; ped[l.numero_pedido] = { frete: Number(l.frete_vendedor), loja: l.numero_loja, margem: l.margem == null ? null : Number(l.margem), dia: l.data_venda, linha: [l.sku, l.descricao, Number(l.quantidade), Number(l.valor_produto), Number(l.valor_nota), l.canal] }; }
      return { r, linha, ped };
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
    /* a linha gravada leva tudo o que levava (o motor guarda de cada venda só o que a gravação usa) */
    assert.deepStrictEqual([x.ped['ML-2000000000000001'].linha, x.ped['ML-2000000000000001'].dia], [['CM1', 'Carrinho de ferramentas CM1', 1, 249, 249, 'ml'], ONTEM]);
    /* o envio só é perguntado pra quem precisa: nem a que já tem o frete na fatura (3), nem a sem envio (6) */
    assert.deepStrictEqual(ml.pescas.filter((p) => /^venda /.test(p)).map((p) => p.slice(-1)).sort(), ['1', '2', '4', '5']);
    assert.ok(ml.pescas.includes('custos 9001') && ml.pescas.includes('envio 9004') && !ml.pescas.some((p) => / 9003$| 9007$/.test(p)), ml.pescas.join(' | '));

    /* venda ANTIGA (60 dias) sem linha de frete na fatura: zero como sempre foi, e NENHUMA consulta de envio (a rodada do
       ano não sai perguntando o envio de milhares de vendas velhas) */
    x = await rodar(rel(61), rel(59));
    assert.ok(x.r.ok);
    assert.deepStrictEqual(x.linha['2000000000000007'], [21.08, 0, 100.43, 24.9, 102.59], 'a comissão continua vindo da própria venda (é de graça); o frete é o que a fatura fechada diz: nenhum');
    assert.deepStrictEqual([x.r.do_marketplace.comissao, x.r.do_marketplace.frete, ml.pescas.length], [{ venda: 1 }, { fatura_sem_frete: 1 }, 0]);

    /* ═══ C. O FRETE É DO ENVIO (Codex #878) — no motor ═══ */
    const freteDoEnvio = (x, sid) => Math.round(Object.values(x.ped).filter((p) => p._sid === sid).reduce((t, p) => t + p.frete, 0) * 100) / 100;
    const custosPedidos = (sid) => ml.pescas.filter((p) => p === 'custos ' + sid).length;
    const marcar = (x) => { for (const v of ml.vendas) if (x.ped['ML-' + v.id]) x.ped['ML-' + v.id]._sid = v.shipping && v.shipping.id; return x; };
    fs.writeFileSync(path.join(dirGood, '_ml_billing.json'), JSON.stringify({ tarifas: {} }));
    {
      /* C1. o caso do Codex: duas vendas, o MESMO carrinho e o MESMO envio, sem fatura */
      ml.vendas = [venda(2000000000000011, ONTEM, { envio: 9101, carrinho: 2000000000000900 }), venda(2000000000000012, ONTEM, { envio: 9101, carrinho: 2000000000000900, preco: 100 })];
      ml.envios = { 9101: CM1 };
      x = marcar(await rodar(rel(2), ONTEM));
      assert.ok(x.r.ok && x.r.desfecho === 'ok');
      assert.deepStrictEqual([x.ped['ML-2000000000000011'].frete, x.ped['ML-2000000000000012'].frete], [35.21, 14.14], 'o envio de R$ 49,35 repartido entre as duas vendas do carrinho, pelo valor (249 e 100)');
      assert.strictEqual(freteDoEnvio(x, 9101), 49.35, 'o envio entrou UMA vez na base (antes do conserto: R$ 98,70)');
      assert.strictEqual(custosPedidos(9101), 1, 'o custo do envio é perguntado ao ML UMA vez');
      assert.deepStrictEqual([x.ped['ML-2000000000000011'].loja, x.ped['ML-2000000000000012'].loja, x.r.do_marketplace.frete, x.r.do_marketplace.vendas], ['2000000000000900', '2000000000000900', { envio: 2 }, 2]);

      /* C2. a fatura já cobrou o envio em UMA das vendas — nas duas ordens em que a busca pode entregar */
      for (const quemTemFatura of ['2000000000000011', '2000000000000012']) {
        fs.writeFileSync(path.join(dirGood, '_ml_billing.json'), JSON.stringify({ tarifas: { f: { o: quemTemFatura, c: 'frete', v: 31.9 } } }));
        x = marcar(await rodar(rel(2), ONTEM));
        const outra = quemTemFatura === '2000000000000011' ? '2000000000000012' : '2000000000000011';
        assert.deepStrictEqual([x.ped['ML-' + quemTemFatura].frete, x.ped['ML-' + outra].frete, freteDoEnvio(x, 9101)], [31.9, 0, 31.9], 'a fatura cobrou o envio na venda ' + quemTemFatura + ': vale a fatura ali e a irmã não paga de novo');
        assert.deepStrictEqual([x.r.do_marketplace.frete, ml.pescas.length], [{ fatura: 1, fatura_no_carrinho: 1 }, 0], 'com a fatura no carrinho, ninguém pergunta o envio ao ML');
      }
      fs.writeFileSync(path.join(dirGood, '_ml_billing.json'), JSON.stringify({ tarifas: {} }));

      /* C3. as irmãs em PÁGINAS diferentes da busca (50 por página): 49 vendas sem envio antes, e o carrinho cai na virada */
      const recheio = []; for (let i = 0; i < 49; i++) recheio.push(venda(2000000000001000 + i, ONTEM, {}));
      ml.vendas = recheio.concat([venda(2000000000000011, ONTEM, { envio: 9101, carrinho: 2000000000000900 }), venda(2000000000000012, ONTEM, { envio: 9101, carrinho: 2000000000000900, preco: 100 })]);
      x = marcar(await rodar(rel(2), ONTEM));
      assert.deepStrictEqual([x.r.do_marketplace.vendas, freteDoEnvio(x, 9101), custosPedidos(9101), x.r.do_marketplace.frete], [51, 49.35, 1, { sem_envio: 49, envio: 2 }], 'a venda 50 e a 51 estão em páginas diferentes da busca e dividem o envio do mesmo jeito');

      /* C4. as irmãs em JANELAS diferentes da mesma rodada (a busca anda de 5 em 5 dias): dividem o envio do mesmo jeito */
      ml.vendas = [venda(2000000000000021, rel(8), { envio: 9102 }), venda(2000000000000022, rel(2), { envio: 9102, preco: 100 })];
      ml.envios = { 9102: CM1 };
      x = marcar(await rodar(rel(9), ONTEM));
      assert.ok(x.r.do_marketplace.janelas >= 2, 'a rodada tinha que ter mais de uma janela');
      assert.deepStrictEqual([x.ped['ML-2000000000000021'].frete, x.ped['ML-2000000000000022'].frete, freteDoEnvio(x, 9102), custosPedidos(9102), x.r.do_marketplace.frete], [35.21, 14.14, 49.35, 1, { envio: 2 }],
        'as irmãs em janelas diferentes da busca dividem UM envio (perguntado uma vez)');
      assert.deepStrictEqual([x.ped['ML-2000000000000021'].dia, x.ped['ML-2000000000000022'].dia], [rel(8), rel(2)], 'cada venda continua no dia dela');
      /* C4b (2º apontamento do Codex): só a venda da janela de DEPOIS tem a fatura. Antes do conserto a de antes já tinha
         levado o custo do envio (R$ 49,35) e a fatura entrava por cima: R$ 98,70. E o caso espelhado (a fatura na de antes). */
      for (const [quemTemFatura, outra] of [['2000000000000022', '2000000000000021'], ['2000000000000021', '2000000000000022']]) {
        fs.writeFileSync(path.join(dirGood, '_ml_billing.json'), JSON.stringify({ tarifas: { f: { o: quemTemFatura, c: 'frete', v: 49.35 } } }));
        x = marcar(await rodar(rel(9), ONTEM));
        assert.deepStrictEqual([x.ped['ML-' + quemTemFatura].frete, x.ped['ML-' + outra].frete, freteDoEnvio(x, 9102), ml.pescas.length, x.r.do_marketplace.frete], [49.35, 0, 49.35, 0, { fatura: 1, fatura_no_carrinho: 1 }],
          'a fatura está na venda ' + quemTemFatura + ' (outra janela): o envio entra UMA vez, pela fatura, e ninguém pergunta ao ML');
      }
      fs.writeFileSync(path.join(dirGood, '_ml_billing.json'), JSON.stringify({ tarifas: {} }));

      /* C5. envios DIFERENTES continuam cada um com o seu custo (não é o carrinho que agrupa, é o envio) */
      ml.vendas = [venda(2000000000000031, ONTEM, { envio: 9103, carrinho: 2000000000000901 }), venda(2000000000000032, ONTEM, { envio: 9104, carrinho: 2000000000000901 })];
      ml.envios = { 9103: CM1, 9104: { envio: { logistic: { type: 'fulfillment' }, shipping_option: {} }, custos: { senders: [{ cost: 12.5 }] } } };
      x = marcar(await rodar(rel(2), ONTEM));
      assert.deepStrictEqual([x.ped['ML-2000000000000031'].frete, x.ped['ML-2000000000000032'].frete, custosPedidos(9103), custosPedidos(9104)], [49.35, 12.5, 1, 1]);

      /* C6. o que o motor guarda de cada venda é só o que a gravação usa — o SKU que o ML manda no campo antigo
         (seller_custom_field) e a venda SEM item nenhum continuam saindo como saíam */
      const antiga = venda(2000000000000041, ONTEM, {}); antiga.order_items[0].item = { seller_custom_field: 'CM1-ANTIGO', title: 'Item com o SKU no campo antigo' }; antiga.order_items[0].quantity = 2; antiga.total_amount = 498;   /* duas unidades */
      const semItem = venda(2000000000000042, ONTEM, {}); delete semItem.order_items[0].item; semItem.total_amount = 259;   /* o total da venda (com frete do comprador) manda no valor da nota */
      ml.vendas = [antiga, semItem]; ml.envios = {};
      x = marcar(await rodar(rel(2), ONTEM));
      assert.deepStrictEqual([x.ped['ML-2000000000000041'].linha, x.ped['ML-2000000000000042'].linha], [['CM1-ANTIGO', 'Item com o SKU no campo antigo', 2, 498, 498, 'ml'], [null, null, 1, 249, 259, 'ml']]);
      assert.strictEqual(x.linha['2000000000000041'][0], 42.16, 'a tarifa da venda é por unidade: 2 × R$ 21,08');
    }
  } catch (e) { falhou = e; }
  finally { console.log = _log; }
  if (falhou) { console.error('FALHOU:', falhou.stack || falhou.message); process.exit(1); }
  console.log('ok — venda direta do Mercado Livre: sem a fatura, a comissão é a tarifa da própria venda e o frete é o custo do envio (a pesca de produção) — o CM1 do caso sai com a margem da tela (R$ 51,08, não R$ 121,51); a fatura manda quando existe; Flex e venda sem envio não inventam frete; "não sei" segue zero e é contado; venda antiga não consulta envio; e o frete é do ENVIO: vendas do mesmo carrinho dividem um custo só (perguntado uma vez), a irmã de uma venda já cobrada na fatura não paga de novo, em qualquer ordem, página ou janela');
  _chegouAoFim = true;
  process.exit(0);
})();
