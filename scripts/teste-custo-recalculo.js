'use strict';
/* 12/11 — LANÇAR (OU APAGAR) CUSTO JÁ RECALCULA AS VENDAS DAQUELE SKU.
   Caso real do dono (AMB, SKU KC3): lançou o custo certo desde 01/09 e as vendas do período continuaram com o custo errado
   no dashboard — "achei que já fosse rodar automático". Só a faixa era gravada; as vendas já gravadas guardam o custo da
   hora em que entraram, e o recálculo era uma rota à parte que ninguém chamava.
   Prova:
   1) a peça do recálculo (lib/checkout/custo-recalculo): pede por SKU e data, chama a reaplicação com `{ sku }` até HOJE;
      pedidos do mesmo SKU se juntam na MENOR data; um de cada vez (nunca duas reaplicações juntas); se outra reaplicação
      estiver rodando, espera e tenta de novo — e, se não liberar, diz isso; guarda o resultado por SKU;
   2) a reaplicação com `opts.sku` (lib/vendas-ops): lê do banco SÓ aquele SKU no período, grava o custo da faixa vigente
      NA DATA de cada venda (× quantidade) e ajusta a margem; linha que já está certa não é tocada; com outra rodando,
      devolve `ocupado` (sem gravar nada);
   3) a ligação: nas rotas comuns, lançar e apagar pedem o recálculo DEPOIS de gravar a faixa, a consulta devolve o
      andamento, e as TRÊS empresas entregam a peça (a GOOD ganhou a dela);
   4) a tela mostra o andamento e o resultado. */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const raiz = path.join(__dirname, '..');
const lerSrc = (f) => fs.readFileSync(path.join(raiz, f), 'utf8');
const { criar } = require('../lib/checkout/custo-recalculo');
const dorme = (ms) => new Promise((ok) => setTimeout(ok, ms));

(async () => {
  /* ── 1) a peça ── */
  assert.throws(() => criar({}), /falta reaplicar/);
  let chamadas = [], juntas = 0, maxJuntas = 0;
  const reap = async (de, ate, emp, opts) => { juntas++; maxJuntas = Math.max(maxJuntas, juntas); chamadas.push([de, ate, emp, opts && opts.sku]); await dorme(15); juntas--; return { rodando: false, linhas: 12, atualizadas: 9, erros: 0, msg: 'concluído' }; };
  let R = criar({ reaplicar: reap, empresa: 'amb', hoje: () => '2026-11-12' });
  let e = R.pedir('KC3', '2026-09-01');
  assert.ok(e.rodando && e.rodando.de === '2026-09-01' && e.rodando.ate === '2026-11-12', 'pediu: já está rodando, da data lançada até HOJE: ' + JSON.stringify(e));
  await R.terminar();
  assert.deepStrictEqual(chamadas, [['2026-09-01', '2026-11-12', 'amb', 'KC3']], 'a reaplicação é chamada com o SKU e o período certos');
  e = R.estado('KC3');
  assert.ok(e.ultimo && e.ultimo.ok === true && e.ultimo.atualizadas === 9 && e.ultimo.linhas === 12 && !e.rodando && !e.na_fila, JSON.stringify(e));
  /* apagar e lançar em seguida (mesmo SKU) + outro SKU: um de cada vez, e o mesmo SKU se junta na MENOR data */
  chamadas = []; maxJuntas = 0;
  R.pedir('AAA', '2026-10-01'); R.pedir('KC3', '2026-09-15'); R.pedir('KC3', '2026-09-01'); R.pedir('KC3', '2026-10-20');
  assert.strictEqual(R.estado('KC3').na_fila, '2026-09-01', 'pedidos do mesmo SKU se juntam na menor data');
  await R.terminar();
  assert.ok(maxJuntas === 1 && chamadas.length === 2 && chamadas[0][3] === 'AAA' && chamadas[1][0] === '2026-09-01' && chamadas[1][3] === 'KC3', 'um de cada vez, e o KC3 uma vez só desde 01/09: ' + JSON.stringify([maxJuntas, chamadas]));
  assert.strictEqual(R.pedir('KC3', 'ontem').na_fila, null, 'data inválida não entra na fila');
  /* outra reaplicação rodando: espera e tenta de novo */
  let n = 0;
  R = criar({ reaplicar: async () => (++n < 3 ? { rodando: true, ocupado: true } : { rodando: false, linhas: 4, atualizadas: 4, erros: 0, msg: 'concluído' }), empresa: 'amb', hoje: () => '2026-11-12', esperaMs: 5 });
  R.pedir('KC3', '2026-09-01'); await R.terminar();
  assert.ok(n === 3 && R.estado('KC3').ultimo.ok === true, 'com outra reaplicação rodando, tinha que esperar e tentar de novo: ' + n);
  R = criar({ reaplicar: async () => ({ rodando: true, ocupado: true }), empresa: 'amb', hoje: () => '2026-11-12', esperaMs: 1, tentativasMax: 3 });
  R.pedir('KC3', '2026-09-01'); await R.terminar();
  assert.ok(R.estado('KC3').ultimo.ok === false && /não liberou/.test(R.estado('KC3').ultimo.msg), 'se a outra nunca libera, o resultado diz isso (não finge que recalculou)');
  R = criar({ reaplicar: async () => { throw new Error('banco fora'); }, empresa: 'amb', hoje: () => '2026-11-12' });
  R.pedir('KC3', '2026-09-01'); await R.terminar();
  assert.ok(R.estado('KC3').ultimo.ok === false && /banco fora/.test(R.estado('KC3').ultimo.msg));
  R = criar({ reaplicar: async () => ({ rodando: false, linhas: 0, atualizadas: 0, erros: 0, msg: 'Supabase não configurado' }), empresa: 'amb', hoje: () => '2026-11-12' });
  R.pedir('KC3', '2026-09-01'); await R.terminar();
  assert.strictEqual(R.estado('KC3').ultimo.ok, false, 'reaplicação que não rodou (banco não configurado) não é "recalculado"');

  /* ── 2) a reaplicação por SKU, com o banco de mentira ── */
  process.env.SUPABASE_URL_VENDAS_TREC = 'https://banco.teste'; process.env.SUPABASE_KEY_VENDAS_TREC = 'k';
  const ops = require('../lib/vendas-ops');
  const linhasBanco = [
    { id: 1, sku: 'KC3', quantidade: 1, custo: 85.26, margem: 10, data_venda: '2026-08-20', numero_pedido: 'a' },   /* antes da faixa: fica fora do período pedido */
    { id: 2, sku: 'KC3', quantidade: 1, custo: 85.26, margem: 10, data_venda: '2026-09-03', numero_pedido: 'b' },
    { id: 3, sku: 'KC3', quantidade: 2, custo: 170.52, margem: 20, data_venda: '2026-10-10', numero_pedido: 'c' },
    { id: 4, sku: 'KC3', quantidade: 1, custo: 73.46, margem: 21.8, data_venda: '2026-11-01', numero_pedido: 'd' }, /* já está certo */
    { id: 5, sku: 'OUTRO', quantidade: 1, custo: 5, margem: 1, data_venda: '2026-09-05', numero_pedido: 'e' },
  ];
  const pedidos = [], gravacoes = [];
  const fetchAntes = global.fetch;
  global.fetch = async (url, opt) => {
    const u = new URL(url);
    if (opt && opt.method === 'PATCH') { const corpoP = JSON.parse(opt.body); gravacoes.push([u.searchParams.get('id'), corpoP]); const alvoP = linhasBanco.find((l) => 'eq.' + l.id === u.searchParams.get('id')); if (alvoP) Object.assign(alvoP, corpoP);   /* o banco de mentira GRAVA: a rodada seguinte já acha a linha certa */
      return { ok: true, json: async () => ({}) }; }
    pedidos.push(u.search);
    const fs0 = u.searchParams.get('sku') || ''; const ehIlike = /^ilike\./.test(fs0);
    const padrao = fs0.replace(/^(eq|ilike)\./, '');
    /* o banco de mentira entende o ilike como o Postgres: % e _ são curingas, \\ escapa, e a caixa não importa */
    const casa = (v) => { if (!fs0) return true; if (!ehIlike) return v === padrao; const re = new RegExp('^' + padrao.replace(/\\(.)|([%_])|([.*+?^${}()|[\]\\])/g, (m, esc, cur, esp) => (esc ? esc.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') : (cur === '%' ? '.*' : (cur === '_' ? '.' : '\\' + esp)))) + '$', 'i'); return re.test(v); };
    const sku = padrao; const de = u.searchParams.getAll('data_venda').find((x) => x.startsWith('gte.')).slice(4), ate = u.searchParams.getAll('data_venda').find((x) => x.startsWith('lte.')).slice(4);
    const off = Number(u.searchParams.get('offset') || 0);
    return { ok: true, json: async () => (off ? [] : linhasBanco.filter((l) => casa(l.sku) && l.data_venda >= de && l.data_venda <= ate)) };
  };
  const ctx = { CACHE_DIR: '/tmp', path, readJson: () => ({ KC3: { custo: 85.26 }, OUTRO: { custo: 9 } }), custoVigenteEm: (sku, dia) => (String(sku).toUpperCase() === 'KC3' && dia >= '2026-09-01' ? 73.46 : null) /* como a de verdade: a caixa não importa */, histCache: { x: 1 } };
  let r = await ops.reaplicarCusto(ctx, '2026-09-01', '2026-11-12', 'trec', { sku: 'KC3' });
  assert.ok(pedidos.length >= 1 && pedidos.every((q) => /sku=ilike\.KC3/.test(q) && /data_venda=gte\.2026-09-01/.test(q) && /data_venda=lte\.2026-11-12/.test(q)), 'a leitura tem que pedir SÓ o SKU e o período: ' + pedidos[0]);
  assert.deepStrictEqual(gravacoes.sort((a, b) => a[0] - b[0]), [['eq.2', { custo: 73.46, margem: 21.8 }], ['eq.3', { custo: 146.92, margem: 43.6 }]], 'cada venda do SKU no período ganha o custo da faixa × quantidade, e a margem sobe o que o custo desceu; a que já estava certa e a de outro SKU não são tocadas: ' + JSON.stringify(gravacoes));
  assert.ok(r.rodando === false && r.atualizadas === 2 && r.linhas === 3 && r.sku === 'KC3' && /conclu/.test(r.msg) && Object.keys(ctx.histCache).length === 0, 'o resultado conta as linhas e o cache do dashboard é limpo: ' + JSON.stringify({ a: r.atualizadas, l: r.linhas, m: r.msg }));
  /* Codex #850: a CAIXA do SKU pode diferir entre a linha do tempo do custo e o histórico de vendas ("kc3" × "KC3") — as
     vendas têm que ser achadas do mesmo jeito; e SKU com _ ou % é tratado como TEXTO (o "_" não vira curinga e pega o vizinho) */
  linhasBanco.push({ id: 6, sku: 'kc3', quantidade: 1, custo: 85.26, margem: 10, data_venda: '2026-09-20', numero_pedido: 'f' },
                   { id: 7, sku: 'AB_1', quantidade: 1, custo: 9, margem: 1, data_venda: '2026-09-21', numero_pedido: 'g' },
                   { id: 8, sku: 'ABX1', quantidade: 1, custo: 9, margem: 1, data_venda: '2026-09-22', numero_pedido: 'h' });
  gravacoes.length = 0;
  r = await ops.reaplicarCusto(ctx, '2026-09-01', '2026-11-12', 'trec', { sku: 'Kc3' });
  assert.deepStrictEqual(gravacoes.map((g) => g[0]).sort(), ['eq.6'], 'a venda gravada como "kc3" tinha que ser recalculada pedindo "Kc3" (as outras já estavam certas): ' + JSON.stringify(gravacoes));
  assert.strictEqual(r.linhas, 4, 'conta as linhas do SKU nas duas grafias');
  gravacoes.length = 0; pedidos.length = 0;
  const ctx2 = Object.assign({}, ctx, { custoVigenteEm: () => 5, histCache: {} });
  r = await ops.reaplicarCusto(ctx2, '2026-09-01', '2026-11-12', 'trec', { sku: 'AB_1' });
  assert.ok(gravacoes.length === 1 && gravacoes[0][0] === 'eq.7' && r.linhas === 1 && /sku=ilike\.AB%5C_1/.test(pedidos[0]), 'o "_" do SKU é texto: só o AB_1, nunca o ABX1: ' + JSON.stringify([gravacoes, pedidos[0]]));
  /* outra reaplicação rodando: quem pediu por SKU recebe "ocupado" e nada é gravado */
  let soltar; const antesG = gravacoes.length; const fetchLento = global.fetch;
  global.fetch = async (url, opt) => { if (!(opt && opt.method)) await new Promise((ok) => { soltar = ok; }); return fetchLento(url, opt); };
  const geral = ops.reaplicarCusto(ctx, '2026-09-01', '2026-09-02', 'trec', { simular: true });
  await dorme(10);
  const r2 = await ops.reaplicarCusto(ctx, '2026-09-01', '2026-11-12', 'trec', { sku: 'KC3' });
  assert.ok(r2.ocupado === true && gravacoes.length === antesG, 'com outra reaplicação em andamento, a por SKU tem que voltar "ocupado" sem gravar: ' + JSON.stringify(r2).slice(0, 120));
  soltar(); await geral;
  /* sem `sku`, a reaplicação geral segue como era (sem filtro de SKU) */
  pedidos.length = 0; global.fetch = fetchLento;
  await ops.reaplicarCusto(ctx, '2026-09-01', '2026-09-02', 'trec', { simular: true });
  assert.ok(pedidos.length && pedidos.every((q) => !/sku=eq\./.test(q)), 'a reaplicação geral não pode ganhar filtro de SKU');
  global.fetch = fetchAntes;

  /* ── 3) a ligação ── */
  const rc = lerSrc('lib/checkout/rotas-comuns.js');
  const rota = rc.slice(rc.indexOf("if (p === PREFIXO + '/custo-historico') {"), rc.indexOf("PREFIXO + '/reaplicar-status'"));
  const iGravaL = rota.lastIndexOf('gravarVigencias(todas);'), iPedeL = rota.indexOf('recalcCusto().pedir(sku, de)', iGravaL);
  assert.ok(iGravaL > 0 && iPedeL > iGravaL && /recalculo: recL/.test(rota), 'LANÇAR: pede o recálculo DEPOIS de gravar a faixa e devolve o andamento');
  const apagar = rota.slice(rota.indexOf('if (b.apagar) {'), rota.indexOf('const custo = Number('));
  assert.ok(apagar.indexOf('gravarVigencias(todas);') < apagar.indexOf('recalcCusto().pedir(sku, de)') && /\(antes - lista\.length\) > 0 \? recalcCusto\(\)\.pedir\(sku, de\)/.test(apagar), 'APAGAR: pede o recálculo depois de gravar, e só se alguma faixa saiu');
  assert.ok(/recalculo: recalcCusto\(\)\.estado\(sku\)/.test(rota), 'a CONSULTA devolve o andamento do recálculo');
  assert.ok(/criar\(\{ reaplicar: \(de, ate, emp, opts\) => reaplicarCusto\(de, ate, emp, opts\), empresa: EMPRESA, hoje: _hojeISO \}\)/.test(rc), 'a peça é montada com a reaplicação e a EMPRESA de quem montou as rotas');
  assert.ok(JSON.parse(rc.match(/const PECAS = (\[[^\]]*\]);/)[1]).indexOf('reaplicarCusto') !== -1, 'reaplicarCusto é peça obrigatória das rotas comuns');
  for (const arq of ['girassol-backup-offline/gbo-app.js', 'amb-checkout-offline/index.js', 'good-checkout-offline/index.js']) {
    const s = lerSrc(arq); const i = s.indexOf("require('../lib/checkout/rotas-comuns').criarRotasComuns({");
    assert.ok(i > 0 && /\n\s+reaplicarCusto,/.test(s.slice(i, i + 6000)), arq + ': não entrega reaplicarCusto às rotas comuns');
    assert.ok(/const reaplicarCusto\s+= \(de, ate, empresa, opts\)\s+=> /.test(s), arq + ': não define reaplicarCusto');
  }
  /* ── 4) a tela ── */
  const tela = Object.values(require('../lib/checkout/painel-ferramentas-custo')).find((v) => typeof v === 'function')('/x');
  new Function(tela);
  assert.ok(/recalculando as vendas deste SKU desde/.test(tela) && /vendas recalculadas desde/.test(tela) && /verHistoricoCusto\('quieto'\)/.test(tela) && /j\.recalculo/.test(tela), 'a tela tem que mostrar o andamento e o resultado do recálculo');
  console.log('ok — lançar/apagar custo recalcula as vendas daquele SKU da data até hoje (só ele, um de cada vez), nas três empresas, e a tela mostra o andamento');
  process.exit(0);
})().catch((e) => { console.error('FALHOU:', e && e.message); process.exit(1); });
