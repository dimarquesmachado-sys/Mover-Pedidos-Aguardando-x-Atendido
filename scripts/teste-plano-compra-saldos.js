'use strict';
/* 25/11 — PLANO DE COMPRA: O SALDO LIDO EM LOTE. O dono: "pegar alguma forma o estoque mais rápido imediato, espelhando
   do Bling, tem como, consome cota fazendo isso?". Antes: uma chamada por produto, guardada 12 h.

   O que se prova (o código de produção):
   A. a peça (lib/checkout/plano-compra-saldos): o cadastro (id, nome, imagem) uma vez por SKU, valendo 30 dias; o saldo
      relido em lote (40 por chamada) quando a leitura tem mais de 5 minutos; falha do Bling não vira "produto não existe"
      nem saldo zero; saldo com mais de 12 h não é usado; a entrada antiga do cache segue valendo pelas 12 h dela;
   B. a ROTA /plano-compra na fábrica de verdade (três empresas): as chamadas que faz, a hora da leitura na resposta;
   C. a TELA: "saldos do Bling lidos às HH:MM" e o aviso de leitura que falhou. */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const S = require('../lib/checkout/plano-compra-saldos');
const { criarRotasPainel } = require('../lib/checkout/fabrica-rotas-painel');
const { scriptDoPlano } = require('../lib/checkout/painel-plano-compra');

process.exitCode = 1;
let terminou = false;
process.on('exit', () => { if (!terminou) { console.log('FALHOU: o teste não chegou ao fim (promessa presa)'); process.exitCode = 1; } });

const MIN = 60000, H = 3600000;
(async () => {
  /* ═══ A. a peça ═══ */
  {
    assert.deepStrictEqual([S.SALDO_FRESCO_MS, S.SALDO_MAXIMO_MS, S.CADASTRO_MS, S.POR_LOTE, S.MAX_SKUS], [5 * MIN, 12 * H, 30 * 24 * H, 40, 260]);
    assert.deepStrictEqual([{ saldoVirtualTotal: 7, saldoFisicoTotal: 9 }, { saldoFisicoTotal: 9 }, { saldoVirtualTotal: 0 }, { saldoVirtualTotal: -2 }, { saldoVirtualTotal: '12' }, { saldoVirtualTotal: 'x' }, { saldoVirtualTotal: '' }, {}, null].map(S.saldoDe), [7, 9, 0, -2, 12, null, null, null, null]);
    let t = 1e12; const idas = [];
    const PROD = { A1: { id: 11, nome: 'Abajur', img: 'a.jpg', estoque: { saldoVirtualTotal: 3 } }, B2: { id: 22, nome: 'Bola', img: null }, C3: { id: 33, nome: 'Cubo', img: 'c.jpg' } };
    const BL = { saldos: { 11: 5, 22: 0, 33: -4 }, falhaLote: false, falhaCad: false, det: { 22: { id: 22, img: 'b-det.jpg', estoque: { saldoFisicoTotal: 8 } } } };
    const bg = async (c) => {
      idas.push(c);
      if (c.startsWith('/produtos?codigo=')) { if (BL.falhaCad) return { ok: false, status: 429, data: { data: [] } }; const p = PROD[decodeURIComponent(/codigo=([^&]*)/.exec(c)[1])]; return { ok: true, status: 200, data: { data: p ? [p] : [] } }; }
      if (c.startsWith('/produtos/')) { const d = BL.det[c.split('/').pop()]; return d ? { ok: true, data: { data: d } } : { ok: false }; }
      if (c.startsWith('/estoques/saldos?')) { if (BL.falhaLote === 'throw') throw new Error('rede'); if (BL.falhaLote) return { ok: false, status: 429 };
        const ids = [...c.matchAll(/idsProdutos\[\]=(\d+)/g)].map((m) => m[1]); return { ok: true, data: { data: ids.filter((i) => BL.saldos[i] !== undefined).map((i) => ({ produto: { id: Number(i) }, saldoVirtualTotal: BL.saldos[i] })) } }; }
      return { ok: false };
    };
    const rodar = async (skus, cache) => { idas.length = 0; const alvo = skus.map((sku) => ({ sku, desc: 'desc ' + sku })); const r = await S.saldosDoPlano({ alvo, cache, blingGet: bg, primeiraImagem: (p) => p.img || null, agora: () => t, dormir: async () => {} }); return { r, alvo, idas: idas.slice() }; };
    const cache = {};
    /* a 1ª vez: o cadastro de cada SKU (o detalhe só de quem veio sem imagem) e UM lote de saldo */
    let x = await rodar(['A1', 'B2', 'C3', 'Z9'], cache);
    assert.deepStrictEqual(x.idas, ['/produtos?codigo=A1&criterio=5&limite=1', '/produtos?codigo=B2&criterio=5&limite=1', '/produtos/22', '/produtos?codigo=C3&criterio=5&limite=1', '/produtos?codigo=Z9&criterio=5&limite=1', '/estoques/saldos?idsProdutos[]=11&idsProdutos[]=22&idsProdutos[]=33'],
      'todo mundo com id vai no lote (o saldo da lista é só reserva); Z9 não existe');
    assert.deepStrictEqual(x.alvo.map((i) => [i.sku, i.saldo, i.img, i.nome]), [['A1', 5, 'a.jpg', 'Abajur'], ['B2', 0, 'b-det.jpg', 'Bola'], ['C3', -4, 'c.jpg', 'Cubo'], ['Z9', null, null, 'desc Z9']], 'o lote manda no saldo (A1: 5 do lote, não o 3 da lista; B2: 0, não o 8 do detalhe)');
    assert.deepStrictEqual([x.r, cache.A1, cache.Z9], [{ cadastros: 4, lotes: 1, falhas: 0, saldo_lido_em: new Date(t).toISOString() }, { id: 11, img: 'a.jpg', nome: 'Abajur', ts_cad: t, saldo: 5, ts: t }, { id: null, img: null, nome: null, ts_cad: t, saldo: null, ts: t }]);
    /* dentro de 5 minutos: NENHUMA chamada */
    t += 5 * MIN - 1; x = await rodar(['A1', 'B2', 'C3', 'Z9'], cache);
    assert.deepStrictEqual([x.idas, x.r.cadastros, x.r.lotes, x.alvo.map((i) => i.saldo)], [[], 0, 0, [5, 0, -4, null]]);
    /* passou de 5 minutos: só o lote (uma chamada pra todos), sem refazer cadastro; o saldo novo aparece */
    t += 1; BL.saldos = { 11: 50, 22: 60, 33: 70 }; x = await rodar(['A1', 'B2', 'C3', 'Z9'], cache);
    assert.deepStrictEqual([x.idas, x.alvo.map((i) => i.saldo), x.r.saldo_lido_em], [['/estoques/saldos?idsProdutos[]=11&idsProdutos[]=22&idsProdutos[]=33'], [50, 60, 70, null], new Date(t).toISOString()]);
    /* o lote FALHA (recusa ou exceção): o saldo anterior segue valendo, e a resposta diz que falhou e de quando é */
    const tBom = t; t += 6 * MIN; BL.saldos = { 11: 1, 22: 1, 33: 1 };
    for (const modo of [true, 'throw']) { BL.falhaLote = modo; x = await rodar(['A1', 'B2', 'C3'], cache); assert.deepStrictEqual([x.alvo.map((i) => i.saldo), x.r.lotes, x.r.falhas, x.r.saldo_lido_em], [[50, 60, 70], 1, 1, new Date(tBom).toISOString()], String(modo)); }
    /* ...mas saldo com mais de 12 h não é número: fica sem saldo */
    t = tBom + 12 * H - 1; x = await rodar(['A1'], cache); assert.strictEqual(x.alvo[0].saldo, 50, 'um instante antes das 12 h ainda vale');
    t = tBom + 12 * H; x = await rodar(['A1'], cache); assert.deepStrictEqual([x.alvo[0].saldo, x.r.saldo_lido_em], [null, null], 'às 12 h, sem leitura nova, não é mais usado');
    BL.falhaLote = false;
    /* produto que o lote não devolve (ou devolve sem número) fica com o que tinha */
    t += MIN; BL.saldos = { 11: 9, 33: 'x' }; x = await rodar(['A1', 'B2', 'C3'], cache);
    assert.deepStrictEqual(x.alvo.map((i) => i.saldo), [9, null, null], 'B2 e C3 não vieram: o saldo de 12 h atrás não volta');
    /* a resposta mais antiga entre os usados é a que a tela pode afirmar */
    BL.saldos = { 11: 9, 22: 4, 33: 6 }; t += 6 * MIN; x = await rodar(['B2', 'C3'], cache); const tBC = t;
    t += 6 * MIN; BL.saldos = { 11: 10 }; x = await rodar(['A1', 'B2', 'C3'], cache);
    assert.deepStrictEqual([x.alvo.map((i) => i.saldo), x.r.saldo_lido_em], [[10, 4, 6], new Date(tBC).toISOString()]);
    /* o Bling RECUSA o cadastro (429): não é "produto não existe" — nada é guardado e tenta de novo no próximo cálculo */
    BL.falhaCad = true; const c2 = {}; x = await rodar(['A1'], c2);
    assert.deepStrictEqual([x.alvo[0].saldo, c2, x.r.falhas, x.idas.length], [null, {}, 1, 1]);
    BL.falhaCad = false; BL.saldos = { 11: 10 }; x = await rodar(['A1'], c2); assert.deepStrictEqual([x.alvo[0].saldo, x.idas.length], [10, 2], 'respondeu: cadastra e lê no lote');
    /* cadastro novo + lote que falha: vale a RESERVA (o saldo que veio na lista) */
    BL.falhaLote = true; const c2b = {}; x = await rodar(['A1', 'C3'], c2b); BL.falhaLote = false;
    assert.deepStrictEqual([x.alvo.map((i) => i.saldo), x.r.falhas], [[3, null], 1], 'A1 tinha saldo na lista (reserva); C3 não tinha: sem saldo');
    /* recadastro (30 dias) do MESMO produto, com a leitura de saldo recente: ela não se perde nem pro lote que falha, nem pra reserva da lista */
    { const t0 = t, s0 = BL.saldos; const c5 = {}; BL.saldos = { 11: 77 }; await rodar(['A1'], c5);
      t += 30 * 24 * H + MIN; c5.A1.ts = t - 2 * MIN; BL.saldos = { 11: 88 }; BL.falhaLote = true;
      x = await rodar(['A1'], c5); BL.falhaLote = false;
      assert.deepStrictEqual([x.alvo[0].saldo, c5.A1.ts_cad, c5.A1.ts], [77, t, t - 2 * MIN], 'recadastrou, lote falhou: segue o 77 de 2 min atrás (não o 3 da lista, nem sem saldo)');
      t += 6 * MIN; x = await rodar(['A1'], c5); assert.strictEqual(x.alvo[0].saldo, 88, 'passou de 5 min: o lote renova'); t = t0; BL.saldos = s0; }
    /* produto que não existe: guardado 12 h (não pergunta a cada cálculo); depois pergunta de novo */
    const c3 = {}; x = await rodar(['Z9'], c3); x = await rodar(['Z9'], c3); assert.strictEqual(x.idas.length, 0);
    t += 12 * H; x = await rodar(['Z9'], c3); assert.strictEqual(x.idas.length, 1);
    /* o detalhe (imagem) falhou: não é "sem imagem" — o cadastro vale só 12 h e a imagem é tentada de novo */
    { const c6 = {}; const d22 = BL.det[22]; delete BL.det[22]; x = await rodar(['B2'], c6);
      assert.deepStrictEqual([c6.B2.img, c6.B2.ts_cad], [null, t - 30 * 24 * H + 12 * H]);
      t += 12 * H - 1; x = await rodar(['B2'], c6); assert.ok(!x.idas.some((c) => c.startsWith('/produtos?')), 'antes das 12 h não repete');
      t += 1; BL.det[22] = d22; x = await rodar(['B2'], c6); assert.deepStrictEqual([x.idas.slice(0, 2), c6.B2.img], [['/produtos?codigo=B2&criterio=5&limite=1', '/produtos/22'], 'b-det.jpg']);
      t += 12 * H; x = await rodar(['B2'], c6); assert.ok(!x.idas.some((c) => c.startsWith('/produtos?')), 'imagem achada: cadastro de 30 dias'); }
    /* o cadastro vence em 30 dias (nome/imagem podem ter mudado) */
    const c4 = {}; await rodar(['C3'], c4); t += 30 * 24 * H - 1; x = await rodar(['C3'], c4); assert.ok(!x.idas.some((c) => c.startsWith('/produtos?')));
    t += 1; x = await rodar(['C3'], c4); assert.ok(x.idas[0].startsWith('/produtos?codigo=C3'));
    /* a entrada ANTIGA do cache (sem id) vale pelas 12 h dela, sem chamada; depois ganha id e entra no lote */
    const c5 = { A1: { saldo: 77, img: 'velha.jpg', nome: 'Velho', ts: t } };
    x = await rodar(['A1'], c5); assert.deepStrictEqual([x.idas, x.alvo[0].saldo, x.alvo[0].img, x.alvo[0].nome], [[], 77, 'velha.jpg', 'Velho']);
    t += 12 * H; x = await rodar(['A1'], c5); assert.deepStrictEqual([x.idas, x.alvo[0].saldo, c5.A1.id], [['/produtos?codigo=A1&criterio=5&limite=1', '/estoques/saldos?idsProdutos[]=11'], 10, 11]);
    /* o lote devolve número torto pra um e não devolve o outro: os dois ficam com o saldo que tinham (ainda dentro das 12 h) */
    { const c9 = {}; BL.saldos[11] = 1; BL.saldos[33] = 2; await rodar(['A1', 'C3'], c9); t += 6 * MIN; BL.saldos[11] = 'x'; delete BL.saldos[33];
      x = await rodar(['A1', 'C3'], c9); assert.deepStrictEqual([x.alvo.map((i) => i.saldo), x.r.falhas], [[1, 2], 2], 'saldo torto ou ausente no lote que respondeu conta como leitura que falhou'); BL.saldos[11] = 10; BL.saldos[33] = -4; }
    /* ...mas o saldo guardado só é preservado se for do MESMO produto e mais novo que a reserva: se o SKU passou a apontar
       pra outro id, ou se a leitura guardada é mais velha que a reserva da lista, vale a reserva (lote falhando) */
    { const t0 = t; BL.falhaLote = true;
      const cId = { A1: { id: 999, img: 'x', nome: 'x', ts_cad: t - 31 * 24 * H, saldo: 77, ts: t - 2 * MIN } };
      x = await rodar(['A1'], cId); assert.deepStrictEqual([x.alvo[0].saldo, cId.A1.id], [3, 11], 'trocou de id: o 77 era de outro produto');
      const cVelho = { A1: { id: 11, img: 'x', nome: 'x', ts_cad: t - 31 * 24 * H, saldo: 77, ts: t - 20 * MIN } };
      x = await rodar(['A1'], cVelho); assert.strictEqual(x.alvo[0].saldo, 3, 'a leitura guardada (20 min) é mais velha que a reserva: vale a reserva');
      BL.falhaLote = false; t = t0; }
    /* 95 produtos = 3 lotes (40, 40, 15); o teto é 260 SKUs */
    for (let n = 0; n < 300; n++) { PROD['P' + n] = { id: 1000 + n, nome: 'p', img: 'i' }; BL.saldos[1000 + n] = n; }
    const c6 = {}; x = await rodar(Array.from({ length: 95 }, (_, n) => 'P' + n), c6);
    const lotes = x.idas.filter((c) => c.startsWith('/estoques/saldos?')).map((c) => c.split('idsProdutos').length - 1);
    assert.deepStrictEqual([lotes, x.r.lotes, x.alvo[94].saldo, x.r.cadastros], [[40, 40, 15], 3, 94, 95]);
    const c7 = {}; x = await rodar(Array.from({ length: 300 }, (_, n) => 'P' + n), c7); assert.deepStrictEqual([x.r.cadastros, x.alvo[259].saldo, x.alvo[260].saldo], [260, 259, undefined]);
    /* SKU com caracteres especiais vai codificado; exceção no cadastro não derruba os outros */
    PROD['PT 06/Ç'] = { id: 5, nome: 'x', img: 'i', estoque: { saldoVirtualTotal: 1 } };
    x = await rodar(['PT 06/Ç'], {}); assert.strictEqual(x.idas[0], '/produtos?codigo=PT%2006%2F%C3%87&criterio=5&limite=1');
    const r8 = await S.saldosDoPlano({ alvo: [{ sku: 'A1', desc: 'd' }, { sku: 'C3', desc: 'd' }], cache: {}, blingGet: async (c) => { if (c.includes('codigo=A1')) throw new Error('x'); return bg(c); }, primeiraImagem: (p) => p.img, agora: () => t, dormir: async () => {} });
    assert.deepStrictEqual([r8.cadastros, r8.falhas], [1, 1]);
  }

  /* ═══ B. a rota ═══ */
  process.env.ADMIN_KEY = 'k';
  const fetchDeVerdade = global.fetch, agoraDeVerdade = Date.now;
  try {
    for (const [empresa, prefixo] of [['girassol', '/girassol-backup-offline'], ['amb', '/amb-checkout-offline'], ['good', '/good-checkout-offline']]) {
      const dv = (n) => new Date(agoraDeVerdade() - n * 86400000).toISOString().slice(0, 10);
      const VENDAS = [['A1', 150, 100], ['B2', 90, 45], ['C3', 18, 20]].map(([sku, quantidade, ha], n) => ({ id: (n + 1) * 7, sku, descricao: sku, quantidade, valor_produto: quantidade * 10, margem: quantidade * 2, data_venda: dv(ha) }));
      global.fetch = async (url) => { const u = new URL(url); if (u.searchParams.get('sku')) return { ok: true, status: 200, json: async () => [] }; const depois = Number(String(u.searchParams.get('id')).replace(/^gt\./, '')); return { ok: true, status: 200, json: async () => VENDAS.filter((v) => v.id > depois) }; };
      let resp = null; const bling = []; let gravado = null; const cacheProd = {};
      const SAL = { 11: 5, 22: 0, 33: 9 };
      const pecas = { json: (res, code, body) => { resp = { code, body }; }, lerChaveAdmin: () => 'k', validarSessao: () => ({ usuario: 'diego' }), readJson: (arq, pad) => (/_prod_compra\.json$/.test(arq) ? cacheProd : pad), writeJson: (arq, v) => { if (/_prod_compra\.json$/.test(arq)) gravado = JSON.parse(JSON.stringify(v)); },
        CACHE_DIR: '/tmp/_plano_saldos_' + empresa, fsx: fs, pathx: path, ehAdmin: () => true, readBody: async () => ({}), estadoRotinas: { custo: {}, vendas: {} }, travaPesada: { quemEsta: () => null }, _urlStatus: () => '', _inferCanal: () => 'outro',
        LOJA_MKT: {}, CONFERIDOS_FILE: '/tmp/_c.json', primeiraImagem: (p) => p.img || null, supaCfg: (emp) => ({ url: 'https://supa.' + emp + '/', key: 'chave-' + emp }),
        blingGet: async (c) => { if (c.startsWith('/pedidos/compras')) return { ok: true, status: 200, data: { data: [] } }; bling.push(c.replace(/\?.*/, '?') + (c.includes('codigo=') ? /codigo=([^&]*)/.exec(c)[1] : ''));
          if (c.startsWith('/produtos?codigo=')) { const k = /codigo=([^&]*)/.exec(c)[1]; const id = { A1: 11, B2: 22, C3: 33 }[k]; return { ok: true, status: 200, data: { data: id ? [{ id, nome: 'N ' + k, img: k + '.jpg' }] : [] } }; }
          if (c.startsWith('/estoques/saldos?')) return SAL.falha ? { ok: false, status: 429 } : { ok: true, data: { data: [...c.matchAll(/idsProdutos\[\]=(\d+)/g)].map((m) => ({ produto: { id: Number(m[1]) }, saldoVirtualTotal: SAL[m[1]] })) } };
          return { ok: false }; } };
      const rot = criarRotasPainel({ empresa, prefixo, nomeEmpresa: empresa.toUpperCase(), pecas });
      const pedir = async (qs) => { resp = null; bling.length = 0; const u = new URL('http://h' + prefixo + '/plano-compra?k=k&curva=todas' + (qs || '')); assert.strictEqual(await rot({ method: 'GET', headers: {} }, {}, prefixo + '/plano-compra', 'GET', u), true); assert.ok(resp && resp.code === 200 && resp.body.ok, JSON.stringify(resp).slice(0, 300)); return resp.body; };
      const sal = (r) => r.itens.map((i) => [i.sku, i.saldo, i.img, i.nome]).sort();
      /* 1º cálculo: um cadastro por SKU e UM lote de saldo — e o cache é gravado com o id */
      const r1 = await pedir();
      assert.deepStrictEqual([bling.slice().sort(), sal(r1), r1.skus_sem_saldo, r1.saldos_com_falha], [['/estoques/saldos?', '/produtos?A1', '/produtos?B2', '/produtos?C3'], [['A1', 5, 'A1.jpg', 'N A1'], ['B2', 0, 'B2.jpg', 'N B2'], ['C3', 9, 'C3.jpg', 'N C3']], 0, 0], empresa + ': ' + JSON.stringify(bling));
      assert.ok(Math.abs(Date.parse(r1.saldo_lido_em) - Date.now()) < 5000 && gravado && gravado.A1.id === 11 && gravado.A1.saldo === 5, empresa + ': ' + r1.saldo_lido_em);
      /* 2º cálculo em seguida (trocar o período): nenhuma chamada de produto/saldo */
      await pedir('&base=90'); assert.deepStrictEqual(bling, [], empresa + ': dentro de 5 min, sem chamada');
      /* 6 minutos depois: UMA chamada (o lote), e o saldo novo já aparece */
      Date.now = () => agoraDeVerdade() + 6 * MIN; SAL[11] = 500;
      const r3 = await pedir();
      assert.deepStrictEqual([bling, sal(r3)[0], Math.abs(Date.parse(r3.saldo_lido_em) - Date.now()) < 5000], [['/estoques/saldos?'], ['A1', 500, 'A1.jpg', 'N A1'], true], empresa + ': o saldo é relido em lote');
      /* o lote falha: o saldo anterior fica, e a resposta DIZ que a leitura falhou e de quando é o saldo */
      const tLido = Date.parse(r3.saldo_lido_em); Date.now = () => agoraDeVerdade() + 12 * MIN; SAL.falha = true; SAL[11] = 1;
      const r4 = await pedir();
      assert.deepStrictEqual([sal(r4)[0][1], r4.saldos_com_falha, Date.parse(r4.saldo_lido_em)], [500, 1, tLido], empresa + ': ' + JSON.stringify([r4.saldos_com_falha, r4.saldo_lido_em]));
      SAL.falha = false; Date.now = agoraDeVerdade;
    }
  } finally { global.fetch = fetchDeVerdade; Date.now = agoraDeVerdade; delete process.env.ADMIN_KEY; }

  /* ═══ C. a tela ═══ */
  {
    const cena = async (extra) => {
      const els = {}; const novo = (id) => ({ id, innerHTML: '', textContent: '', value: '', disabled: false, style: {}, _ev: {}, addEventListener(e, f) { this._ev[e] = f; }, click() { return this._ev.click && this._ev.click(); } });
      els.planoCompraAqui = novo('planoCompraAqui'); let solta = null; els._solta = () => solta();
      const doc = { getElementById: (id) => els[id] || (els[id] = novo(id)), createElement: () => ({ click() {} }) };
      new Function('document', 'window', 'fetch', 'URL', 'Blob', 'setTimeout', scriptDoPlano('/emp'))(doc, {},
        async () => { await new Promise((r) => { solta = r; }); return { json: async () => Object.assign({ ok: true, lead: 4, cob: 5, horizonte_dias: 274, skus: 1, totais: { investir: 1, risco: 1, skus_a_comprar: 1 }, itens: [{ sku: 'A1', nome: 'Abajur', curva: 'A', un: 1, md: 1, saldo: 1, acaba_em: 1, precisa: 1, comprar: 1, mc_un: 1, risco: 1 }] }, extra) }; },
        { createObjectURL: () => 'blob:x', revokeObjectURL: () => {} }, function () {}, (f) => setImmediate(f));
      els.pcCalc.click(); for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
      const durante = els.pcInfo.textContent; els._solta(); for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));
      return { info: els.pcInfo.textContent, durante };
    };
    const hojeMeioDia = new Date(new Date().toLocaleDateString('sv-SE', { timeZone: 'America/Sao_Paulo' }) + 'T15:07:00Z').toISOString();   /* 12:07 em São Paulo */
    const c1 = await cena({ saldo_lido_em: hojeMeioDia, saldos_com_falha: 0 });
    assert.ok(/ · saldos do Bling lidos às 12:07( ·|$)/.test(c1.info) && !/falharam/.test(c1.info), c1.info);
    assert.strictEqual(c1.durante, '⏳ calculando… lendo os saldos no Bling (produto novo no plano leva um pouco mais na primeira vez)');
    const c2 = await cena({ saldo_lido_em: '2026-01-05T15:07:00Z', saldos_com_falha: 2 });
    assert.ok(/ · saldos do Bling lidos às 12:07 de 05\/01\/2026 · ⚠️ 2 leitura\(s\) de saldo falharam \(calcule de novo daqui a pouco\)/.test(c2.info), 'leitura de outro dia leva a data: ' + c2.info);
    for (const v of [null, undefined, '', 'torto']) { const c = await cena({ saldo_lido_em: v }); assert.ok(!/saldos do Bling lidos/.test(c.info), JSON.stringify(v) + ' → ' + c.info); }
  }

  terminou = true; process.exitCode = 0;
  console.log('ok — Plano de Compra, o saldo em lote: o cadastro (id, nome, imagem) uma vez por SKU (30 dias); o saldo relido em lote de 40 quando a leitura tem mais de 5 min (260 produtos = 7 chamadas); falha do Bling não vira "não existe" nem zero; saldo com mais de 12 h não é usado; a entrada antiga do cache segue valendo; a rota diz de quando é o saldo e a tela mostra a hora — nas três empresas');
})().catch((e) => { console.log('FALHOU: ' + (e && e.stack || e)); terminou = true; process.exitCode = 1; });
