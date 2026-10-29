'use strict';
/* 29/10 — TOP PRODUTOS DE PERÍODO LONGO (lib/checkout/historico.js + a tela única, as três empresas).
   A lista de SKUs que o servidor mandava era o top 300 por MARGEM: com mais SKUs que isso no período, o produto de muito
   faturamento e margem ruim sumia do ranking por faturamento, e a curva ABC e o "% do faturamento" eram calculados pelo
   cliente só sobre o pedaço que chegou. Prova:
   · SERVIDOR (o /historico-longo DE PRODUÇÃO, pela fachada da GOOD, com um Supabase de mentira): 400 SKUs, um deles com
     faturamento enorme e margem negativa — ele VEM na lista, com a curva certa calculada sobre os 400; skus_total = 400;
     toda linha da lista tem curva;
   · TELA (o trecho de produção recortado): no período longo usa a curva do servidor e a base dos % é o total do período;
     no curto, a curva é calculada ANTES da busca (buscar um SKU pequeno não o transforma em "A"). */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
let roteiro = [];
const fakeFetch = async () => { const r = roteiro.length ? roteiro.shift() : []; return { ok: true, status: 200, json: async () => r, text: async () => JSON.stringify(r) }; };
require.cache[require.resolve('node-fetch')] = { id: 'node-fetch', filename: 'node-fetch', loaded: true, exports: fakeFetch };
process.env.ADMIN_KEY = 'chave-teste';

(async () => {
  // ── 1) servidor ──
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'top-'));
  let resp = null; const json = (res, st, o) => { resp = o; };
  const histCache = {};
  const h = require('../good-checkout-offline/historico-good').rotasHistorico({ validarSessao: () => null, supaCfg: () => ({ url: 'https://supa.test', key: 'k' }), histCache, CACHE_DIR: tmp, json });
  const linhas = [];
  for (let i = 0; i < 399; i++) linhas.push({ numero_pedido: String(5000 + i), numero_loja: 'L' + i, canal: 'ml', data_venda: '2026-10-05', sku: 'P' + String(i).padStart(3, '0'), descricao: 'p', quantidade: 1,
    valor_produto: 10, valor_nota: 10, custo: 4, comissao: 1, frete_vendedor: 0, imposto: 0, margem: 5, uf: 'SP' });
  linhas.push({ numero_pedido: '9999', numero_loja: 'LG', canal: 'ml', data_venda: '2026-10-05', sku: 'GRANDE', descricao: 'g', quantidade: 1,
    valor_produto: 50000, valor_nota: 50000, custo: 45000, comissao: 5000, frete_vendedor: 0, imposto: 500, margem: -500, uf: 'SP' });
  /* e um PREJUÍZO pequeno: pouco faturamento, sem custo, 1 unidade — só o critério dos "piores" o traz (a tabela ordenada
     do pior pro melhor tem que mostrá-lo) */
  linhas.push({ numero_pedido: '9998', numero_loja: 'LP', canal: 'ml', data_venda: '2026-10-05', sku: 'PREJUIZO', descricao: 'x', quantidade: 1,
    valor_produto: 5, valor_nota: 5, custo: 0, comissao: 0, frete_vendedor: 0, imposto: 0, margem: -100, uf: 'SP' });
  roteiro = [linhas];
  await h({ method: 'GET', headers: {} }, {}, new URL('http://x/good-checkout-offline/historico-longo?k=chave-teste&de=2026-10-01&ate=2026-10-13'));
  assert.ok(resp && resp.ok && Array.isArray(resp.skus), 'o /historico-longo não respondeu: ' + JSON.stringify(resp).slice(0, 200));
  assert.strictEqual(resp.skus_total, 401, 'skus_total errado: ' + resp.skus_total);
  assert.ok(resp.skus.some((x) => x.sku === 'PREJUIZO'), 'o pior prejuízo ficou FORA da lista (a tabela do pior pro melhor não o mostraria)');
  const g = resp.skus.find((x) => x.sku === 'GRANDE');
  assert.ok(g, 'o SKU de MAIOR faturamento e margem negativa ficou FORA da lista (o corte por margem)');
  assert.ok(resp.skus.every((x) => x.curva === 'A' || x.curva === 'B' || x.curva === 'C'), 'linha da lista sem curva');
  /* a curva do servidor é a do PERÍODO INTEIRO, com a mesma regra da tela (acumula por faturamento; A até 80%, B até 95%):
     confere SKU a SKU contra a conta feita sobre os 400 — se o servidor calculasse só sobre a lista, daria diferente */
  const todos = linhas.map((l) => ({ sku: l.sku, fat: l.valor_produto })).sort((a, b) => b.fat - a.fat);
  const ft = todos.reduce((x, y) => x + y.fat, 0);
  let ac = 0; const esperado = {};
  for (const x of todos) { ac += x.fat; const pc = ac / ft; esperado[x.sku] = x.fat > 0 ? (pc <= 0.80 ? 'A' : (pc <= 0.95 ? 'B' : 'C')) : 'C'; }
  const errados = resp.skus.filter((x) => x.curva !== esperado[x.sku]).map((x) => x.sku + ':' + x.curva + '≠' + esperado[x.sku]);
  assert.deepStrictEqual(errados, [], 'curva ABC não é a do período inteiro: ' + errados.slice(0, 5).join(', '));
  assert.strictEqual(g.curva, esperado.GRANDE, 'a curva do GRANDE não é a do período inteiro');

  /* o mesmo, com o SKU grande no MEIO da margem (nem entre os 300 melhores nem entre os 200 piores), custo zero e 1
     unidade — só o critério de FATURAMENTO o traz: prova que a lista tem o topo por faturamento, não só os extremos */
  { const l2 = [];
    for (let i = 0; i < 700; i++) l2.push({ numero_pedido: String(20000 + i), numero_loja: 'M' + i, canal: 'ml', data_venda: '2026-10-05', sku: 'Q' + String(i).padStart(3, '0'), descricao: 'q', quantidade: 1,
      valor_produto: 10, valor_nota: 10, custo: 2, comissao: 0, frete_vendedor: 0, imposto: 0, margem: i + 1, uf: 'SP' });
    l2.push({ numero_pedido: '29999', numero_loja: 'MG', canal: 'ml', data_venda: '2026-10-05', sku: 'MEIO', descricao: 'm', quantidade: 1,
      valor_produto: 30000, valor_nota: 30000, custo: 0, comissao: 0, frete_vendedor: 0, imposto: 0, margem: 350, uf: 'SP' });
    roteiro = [l2]; for (const k of Object.keys(histCache)) delete histCache[k];
    await h({ method: 'GET', headers: {} }, {}, new URL('http://x/good-checkout-offline/historico-longo?k=chave-teste&de=2026-10-01&ate=2026-10-14'));
    assert.ok(resp && resp.ok && resp.skus_total === 701, 'segundo período não respondeu: ' + JSON.stringify(resp).slice(0, 160));
    assert.ok(resp.skus.some((x) => x.sku === 'MEIO'), 'o SKU de maior faturamento com margem no meio ficou FORA (a lista não leva o topo por faturamento)'); }

  // ── 2) tela (o trecho de produção) ──
  const T = require('./_tela-empresa');
  const html = T.telaDaEmpresa('good');
  const js = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]).join('\n');
  const i0 = js.indexOf('  const _todosProds = usaHist'), i1 = js.indexOf('  _topProds = prods;', i0);
  assert.ok(i0 > 0 && i1 > i0, 'não achei o trecho do TOP Produtos na tela');
  const roda = new Function('usaHist', 'HIST', 'porProd', '_qT', 'casaBusca', 'sortProd', 'cmpNull', js.slice(i0, i1) + '\nreturn { prods, fatTot, mcTot };');
  const casaBusca = (q, sku) => !q || String(sku).toLowerCase().includes(String(q).toLowerCase());
  const cmpNull = (a, b, d) => ((a == null ? -Infinity : a) - (b == null ? -Infinity : b)) * (d === -1 ? -1 : 1);
  // período longo: curva do servidor e base = total do período
  const HIST = { skus: [{ sku: 'GRANDE', desc: 'g', un: 1, fat: 50000, cus: 45000, mar: -500, curva: 'A' }, { sku: 'P001', desc: 'p', un: 1, fat: 10, cus: 4, mar: 5, curva: 'C' }],
    totais: { produtos: 53990, margem: 1495 }, skus_total: 400 };
  const r1 = roda(true, HIST, {}, null, casaBusca, { col: 'fat', dir: -1 }, cmpNull);
  assert.ok(r1.prods.find((p) => p.sku === 'P001').curva === 'C' && r1.prods.find((p) => p.sku === 'GRANDE').curva === 'A', 'a tela recalculou a curva sobre o pedaço em vez de usar a do servidor');
  assert.strictEqual(r1.fatTot, 53990, 'a base do "% do faturamento" não é o total do período');
  assert.strictEqual(r1.mcTot, 1495, 'a base do "% da M.C." não é o total do período');
  // período curto: curva calculada ANTES da busca
  const porProd = { A: { sku: 'A', desc: 'a', fat: 900, mc: 100, qtd: 9 }, B: { sku: 'B', desc: 'b', fat: 90, mc: 10, qtd: 3 }, C: { sku: 'PEQ', desc: 'peq', fat: 10, mc: 1, qtd: 1 } };
  const r2 = roda(false, null, porProd, { value: 'peq' }, casaBusca, { col: 'fat', dir: -1 }, cmpNull);
  assert.ok(r2.prods.length === 1 && r2.prods[0].sku === 'PEQ' && r2.prods[0].curva !== 'A', 'buscar o SKU pequeno o transformou em "A": ' + JSON.stringify(r2.prods));
  assert.strictEqual(r2.fatTot, 1000, 'buscar mudou a base do "% do faturamento"');
  assert.ok(/<caption[^]*o per\\u00edodo tem <b>'\+N\(HIST\.skus_total\)/.test(js) || js.includes("o per\\u00edodo tem <b>'+N(HIST.skus_total)"), 'a tabela não avisa quando mostra só uma parte dos SKUs');
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('ok — TOP Produtos de período longo: o SKU de muito faturamento e margem ruim vem; curva e % sobre o período inteiro; busca não muda a curva');
  process.exit(0);
})().catch((e) => { console.error('FALHOU:', e.message); process.exit(1); });
