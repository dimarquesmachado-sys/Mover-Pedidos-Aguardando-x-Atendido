'use strict';
/* 26/10 — o módulo da SHOPEE (repasse/escrow, devoluções, carteira, Ads, conciliação, resumo, tarifa por SKU) virou PEÇA
   ÚNICA (lib/checkout/shopee-empresa): era gbo-shopee.js (Girassol) e amb-shopee.js (AMB) — o mesmo módulo, com a AMB
   na frente (o gasto de Shopee Ads no resumo). Prova, com o serviço da Shopee de mentira e a pasta de cache temporária:
   · a AMB faz EXATAMENTE o que fazia (fixture): as mesmas chamadas ao serviço e as mesmas respostas no escrow, no
     pedido ao serviço, no escrow em lote, na tarifa por SKU, no resumo e nas rotas (status, resumo, tarifa-por-sku);
   · a Girassol também — e GANHA o gasto de Ads no resumo (tudo o que respondia antes segue igual; só acrescenta);
   · cada empresa com o serviço, a chave e a loja DELA, no prefixo dela. */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const raiz = path.join(__dirname, '..');

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shp-'));
  const readJson = (a, d) => { try { return JSON.parse(fs.readFileSync(a, 'utf8')); } catch (e) { return d; } };
  const writeJson = (a, v) => fs.writeFileSync(a, JSON.stringify(v));
  const base = { json: (res, c, b) => { res.c = c; res.b = b; }, ehAdmin: () => false, CONFERIDOS_FILE: path.join(dir, 'conf.json'), CACHE_DIR: dir, readJson, writeJson };
  writeJson(path.join(dir, '_shopee_devolucoes.json'), { devolucoes: { R1: { order_sn: 'SN1', valor: 30, criado_em: '2026-10-10T00:00:00Z', motivo: 'DEFEITO', sku: 'A' } } });
  writeJson(path.join(dir, '_shopee_carteira.json'), { transacoes: { T1: { tipo: 'SPM_DEDUCT', valor: -12.5, quando: '2026-10-11T00:00:00Z' }, T2: { tipo: 'ADJUSTMENT_ADD', valor: 5, quando: '2026-10-12T00:00:00Z' } } });
  writeJson(path.join(dir, '_shopee_ads.json'), { atualizado: '2026-10-20T00:00:00Z', por_dia: { '2026-10-11': { gasto: 9.9 } } });
  writeJson(path.join(dir, '_vendas_dia.json'), { vendas: [{ canal: 'shopee', numero_loja: 'SN1', data: '2026-10-11', ads_escrow: 2 }] });
  let log = [];
  const fakeFetch = async (url) => {
    log.push(String(url).replace(/k=[^&]+/, 'k=*'));
    const r = (st, b) => ({ status: st, ok: st >= 200 && st < 300, json: async () => b, text: async () => JSON.stringify(b) });
    if (/\/interno\/escrow\//.test(url)) return r(200, { ok: true, order_sn: 'SN1', escrow: { order_income: { escrow_amount: 80, commission_fee: 10, service_fee: 5, items: [{ model_sku: 'A', discounted_price: 100 }] } } });
    if (/\/interno\/escrow-lote/.test(url) || /\/interno\/escrows/.test(url)) return r(200, { ok: true, itens: [{ order_sn: 'SN1', ok: true, escrow: { order_income: { escrow_amount: 80 } } }] });
    if (/\/interno\/tarifas/.test(url) || /\/interno\/pedidos/.test(url)) return r(200, { ok: true, pedidos: [{ order_sn: 'SN1', itens: [{ sku: 'A', preco: 100, comissao: 10 }] }] });
    return r(200, { ok: true, eco: String(url).split('?')[0] });
  };
  process.env.ADMIN_KEY = 'adm-s';
  const rodar = async (mod, pref) => {
    const out = {};
    const pega = async (nome, fn) => { log = []; let v; try { v = await fn(); } catch (e) { v = 'ERRO ' + e.message; } out[nome] = { v, log: log.slice() }; };
    await pega('escrow', () => mod.escrowDoPedido('SN1'));
    await pega('pedir', () => mod.pedirAoSync('pedidos-do-dia', { horas: 24 }));
    await pega('lote', () => mod.escrowEmLote(['SN1', 'SN2']));
    await pega('tarifas', () => mod.tarifasPorSku(undefined, 30, 50));
    await pega('resumo', () => mod.resumoShopee('2026-10-01', '2026-10-31'));
    for (const r of ['status', 'resumo?de=2026-10-01&ate=2026-10-31', 'tarifa-por-sku?dias=30']) {
      await pega('rota ' + r, async () => { const res = { c: 0, b: null }; const t = await mod.rotasShopee({ validarSessao: () => null })({ method: 'GET', headers: {} }, res, new URL('http://h' + pref + '/shopee/' + r + (r.includes('?') ? '&' : '?') + 'k=adm-s')); return { t, c: res.c, b: res.b }; });
    }
    return out;
  };
  const carregarAntigo = (pasta, fixture) => {
    const rb = require.resolve(path.join(raiz, pasta, 'base.js')), rf = require.resolve('node-fetch');
    const salvo = { [rb]: require.cache[rb], [rf]: require.cache[rf] };
    require.cache[rb] = { id: rb, filename: rb, loaded: true, exports: base };
    require.cache[rf] = { id: rf, filename: rf, loaded: true, exports: fakeFetch };
    const arq = path.join(raiz, pasta, '_shopee_antigo_teste.js');
    fs.writeFileSync(arq, fs.readFileSync(path.join(__dirname, 'fixtures', fixture), 'utf8'));
    try { return require(arq); } finally { try { fs.unlinkSync(arq); } catch (e) {} for (const [k, v] of Object.entries(salvo)) { if (v) require.cache[k] = v; else delete require.cache[k]; } }
  };
  const { criarShopeeDaEmpresa } = require('../lib/checkout/shopee-empresa');
  const limpo = (x) => JSON.parse(JSON.stringify(x, (k, v) => (['ms', 'duracao_ms', 'rodou_em', 'gerado_em', 'agora'].includes(k) ? undefined : v)));
  // AMB: igual ao de antes
  process.env.AMBBKP_SHOPEE_SYNC_KEY = 'k-amb'; delete process.env.AMBBKP_SHOPEE_SYNC_LOJA; delete process.env.AMBBKP_SHOPEE_SYNC_URL;
  const velhoA = carregarAntigo('amb-checkout-offline', 'shopee-amb-antes.js');
  const novoA = criarShopeeDaEmpresa({ base, prefixo: '/amb-checkout-offline', shopee: () => ({ url: process.env.AMBBKP_SHOPEE_SYNC_URL || 'https://girassol-shopee-sync-organizar-envio.onrender.com', key: process.env.AMBBKP_SHOPEE_SYNC_KEY || process.env.SHOPEE_SYNC_KEY || '', loja: process.env.AMBBKP_SHOPEE_SYNC_LOJA || 'amb' }), adsMaxDias: 180, fetch: fakeFetch });
  const oa = limpo(await rodar(novoA, '/amb-checkout-offline')), va = limpo(await rodar(velhoA, '/amb-checkout-offline'));
  for (const k of Object.keys(va)) assert.deepStrictEqual(oa[k], va[k], 'AMB: ' + k + ' mudou em relação ao código de antes');
  assert.ok(oa.escrow.log.some((u) => u.includes('/amb/interno/escrow/SN1')), 'AMB: o escrow não foi na loja dela');
  assert.ok(oa['rota status'].v.c === 200, 'AMB: a rota de status não respondeu pro admin');
  // Girassol: igual ao de antes, a não ser o que GANHA no resumo (o gasto de Ads)
  process.env.SHOPEE_SYNC_KEY = 'k-gir'; delete process.env.SHOPEE_SYNC_LOJA; delete process.env.SHOPEE_SYNC_URL;
  const velhoG = carregarAntigo('girassol-backup-offline', 'shopee-girassol-antes.js');
  const novoG = criarShopeeDaEmpresa({ base, prefixo: '/girassol-backup-offline', shopee: () => ({ url: process.env.SHOPEE_SYNC_URL || 'https://girassol-shopee-sync-organizar-envio.onrender.com', key: process.env.SHOPEE_SYNC_KEY || '', loja: process.env.SHOPEE_SYNC_LOJA || 'girassol' }), adsMaxDias: 365, fetch: fakeFetch });
  const og = limpo(await rodar(novoG, '/girassol-backup-offline')), vg = limpo(await rodar(velhoG, '/girassol-backup-offline'));
  const contem = (sup, sub, onde) => { if (sub && typeof sub === 'object' && !Array.isArray(sub)) { for (const k of Object.keys(sub)) contem(sup && sup[k], sub[k], onde + '.' + k); } else assert.deepStrictEqual(sup, sub, 'Girassol: ' + onde + ' mudou'); };
  for (const k of Object.keys(vg)) contem(og[k], vg[k], k);
  assert.ok(og.resumo.v && og.resumo.v.carteira && 'ads_consumo_nao_somado' in og.resumo.v.carteira, 'Girassol: o resumo não ganhou o gasto de Ads');
  assert.ok(og.escrow.log.some((u) => u.includes('/girassol/interno/escrow/SN1')), 'Girassol: o escrow não foi na loja dela');
  fs.rmSync(dir, { recursive: true, force: true });
  // as duas pela peça, com as variáveis que sempre leram
  const gs = fs.readFileSync(path.join(raiz, 'girassol-backup-offline', 'gbo-shopee.js'), 'utf8'), as = fs.readFileSync(path.join(raiz, 'amb-checkout-offline', 'amb-shopee.js'), 'utf8');
  assert.ok(/criarShopeeDaEmpresa\(\{/.test(gs) && gs.includes("prefixo: '/girassol-backup-offline'") && gs.includes("loja: process.env.SHOPEE_SYNC_LOJA || 'girassol'"), 'Girassol: não é a peça com o que é dela');
  assert.ok(/criarShopeeDaEmpresa\(\{/.test(as) && as.includes("prefixo: '/amb-checkout-offline'") && as.includes("loja: process.env.AMBBKP_SHOPEE_SYNC_LOJA || 'amb'"), 'AMB: não é a peça com o que é dela');
  console.log('ok — Shopee em peça única: a AMB faz o mesmo de antes; a Girassol também, e ganha o gasto de Ads no resumo');
  process.exit(0);
})().catch((e) => { console.error('FALHOU:', e.message); process.exit(1); });
