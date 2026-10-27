'use strict';
/* 14/10 — prova COMPLETA do item 6.1 do parecer do Codex (o critério dele: "comparar dados gravados, não
   apenas URLs ou campo empresa"). Roda o backfillVendas DE PRODUÇÃO (girassol-backup-offline/gbo-app.js),
   com o contexto da GOOD, sobre três vendas GOOD (ML, TikTok, Magalu) de R$ 100 com custo GOOD R$ 20,
   comissão R$ 10 e frete R$ 5 no Bling da GOOD — e SENTINELAS da Girassol com valores diferentes:
   linha do tempo de custo da Girassol = R$ 71, arquivo financeiro do TikTok da Girassol, token do ML da
   Girassol. Exige: as linhas gravadas levam os valores da GOOD; nenhum arquivo do cache da Girassol é
   lido; o token do ML da Girassol nunca é pedido; nenhuma chamada sai pro serviço da Shopee da Girassol. */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const raiz = path.join(__dirname, '..');

const dirGir = fs.mkdtempSync(path.join(os.tmpdir(), 'gir-')), dirTk = fs.mkdtempSync(path.join(os.tmpdir(), 'tk-')), dirGood = fs.mkdtempSync(path.join(os.tmpdir(), 'good-'));
process.env.SHOPEE_SYNC_KEY = 'CHAVE-SENTINELA'; process.env.GIRABKP_CACHE_DIR = dirGir; process.env.TIKTOK_CACHE_DIR = dirTk;
fs.writeFileSync(path.join(dirGir, '_magalu_frete_sku.json'), JSON.stringify({ X1: { media: 99 } }));
fs.writeFileSync(path.join(dirGir, '_custos-vigencia.json'), JSON.stringify({ X1: [{ de: '2026-01-01', ate: null, custo: 71 }] }));
fs.writeFileSync(path.join(dirTk, '_tiktok_financeiro_girassol.json'), JSON.stringify({ pedidos: { '577000000000000001': { comissao: 40, frete: 3 } } }));
fs.writeFileSync(path.join(dirGood, '_custos-vigencia.json'), JSON.stringify({ X1: [{ de: '2026-01-01', ate: null, custo: 20 }] }));

const urls = [];
require.cache[require.resolve('node-fetch')] = { id: 'node-fetch', filename: 'node-fetch', loaded: true,
  exports: async (u) => { urls.push(String(u)); return { ok: false, status: 404, json: async () => ({}), text: async () => '{}' }; } };
let tokenGir = 0;
const arqTkGir = require.resolve(path.join(raiz, 'girassol', 'mlTokenManager'));
require.cache[arqTkGir] = { id: arqTkGir, filename: arqTkGir, loaded: true, exports: { garantirTokenML: async () => { tokenGir++; return 'TOKEN-GIRASSOL'; } } };

const lidos = [];
const _rfs = fs.readFileSync, _ex = fs.existsSync, _st = fs.statSync;
fs.readFileSync = function (f, ...r) { lidos.push(String(f)); return _rfs.call(fs, f, ...r); };
fs.existsSync = function (f) { lidos.push(String(f)); return _ex.call(fs, f); };
fs.statSync = function (f, ...r) { lidos.push(String(f)); return _st.call(fs, f, ...r); };

(async () => {
  const gbo = require(path.join(raiz, 'girassol-backup-offline', 'gbo-app.js'));
  const readJson = (f, pad) => { try { return JSON.parse(_rfs.call(fs, f, 'utf8')); } catch (e) { return pad; } };
  const pedidos = [
    { id: 1, numero: 5001, nl: '2000012345678901', loja: 701 },
    { id: 2, numero: 5002, nl: '577000000000000001', loja: 702 },
    { id: 3, numero: 5003, nl: 'LU-123456', loja: 703, semFrete: true },
    { id: 4, numero: 5004, nl: '2610051ABCDEFG', loja: 704, semComissao: true },
  ];
  const blingGet = async (p) => {
    if (/^\/pedidos\/vendas\?/.test(p)) return { ok: true, status: 200, data: { data: /pagina=1(&|$)/.test(p) ? pedidos.map(x => ({ id: x.id, numero: x.numero, numeroLoja: x.nl, data: '2026-10-05', situacao: { id: 9 }, loja: { id: x.loja } })) : [] } };
    const m = /^\/pedidos\/vendas\/(\d+)$/.exec(p);
    if (m) { const x = pedidos.find(y => String(y.id) === m[1]);
      return { ok: true, status: 200, data: { data: { id: x.id, numero: x.numero, numeroPedidoLoja: x.nl, data: '2026-10-05', loja: { id: x.loja },
        itens: [{ codigo: 'X1', descricao: 'produto', quantidade: 1, valor: 100 }], total: 100, taxas: { taxaComissao: x.semComissao ? 0 : 10, custoFrete: x.semFrete ? 0 : 5 }, contato: { endereco: { uf: 'SP' } } } } }; }
    return { ok: true, status: 200, data: { data: [] } };
  };
  const gravadas = [];
  let tokenGood = 0;
  const ctx = {
    blingGet, readJson, CACHE_DIR: dirGood,
    supaReq: async (emp, met, q, body) => { if (met === 'POST' && Array.isArray(body)) gravadas.push(...body); return { ok: true, status: met === 'POST' ? 201 : 200, body: '[]' }; },
    supaCount: async () => null, DEFAULT_ALIQ_BK: { '2026-10': 10, '10': 10 },
    custoVigenteEm: (sku, data) => require('../lib/custo').custoVigenteEm({ CACHE_DIR: dirGood, path, fs, readJson }, sku, data),
    garantirTokenML: async () => { tokenGood++; return 'TOKEN-GOOD'; },
    LOJA_MKT: { '701': 'ml', '702': 'tiktok', '703': 'magalu', '704': 'shopee' },
    mapasBilling: null, escrowEmLote: null, escrowDoPedido: null, magaluFreteSkuLer: () => ({ X1: { media: 8 } }),
  };
  lidos.length = 0; urls.length = 0;
  const r = await gbo.backfillVendas('2026-10-05', '2026-10-05', 'good', ctx);
  assert.ok(r && r.desfecho !== 'abortado' && r.desfecho !== 'erro', 'o backfill não rodou: ' + JSON.stringify(r && { desfecho: r.desfecho, msg: r.msg }));
  assert.strictEqual(gravadas.length, 4,'linhas gravadas: ' + gravadas.length);
  for (const l of gravadas) {
    const tag = l.canal + ' ' + l.numero_pedido;
    assert.strictEqual(l.empresa, 'good', tag + ': empresa');
    assert.strictEqual(Number(l.custo), 20, tag + ': custo gravado ' + l.custo + ' — R$ 71 é a linha do tempo da GIRASSOL');
    /* Shopee sem comissão no Bling é o caso que faria a Girassol consultar o escrow — na GOOD fica 0.
       Magalu sem frete no Bling cai no banco de frete por SKU da GOOD (R$ 8), nunca no da Girassol (R$ 99). */
    const comEsp = l.canal === 'shopee' ? 0 : 10, freEsp = l.canal === 'magalu' ? 8 : 5;
    assert.strictEqual(Number(l.comissao), comEsp, tag + ': comissão gravada ' + l.comissao + ' — esperado ' + comEsp);
    assert.strictEqual(Number(l.frete_vendedor), freEsp, tag + ': frete gravado ' + l.frete_vendedor + ' — esperado ' + freEsp + ' (R$ 99 é o banco de frete da GIRASSOL)');
  }
  assert.deepStrictEqual(gravadas.map(l => l.canal).sort(), ['magalu', 'ml', 'shopee', 'tiktok'], 'canais (o mapa loja→canal tem que ser o da GOOD)');
  assert.strictEqual(tokenGir, 0, 'o token do ML da GIRASSOL foi pedido durante o backfill da GOOD');
  const leuGir = lidos.filter(f => f.startsWith(dirGir) || f.includes('_tiktok_financeiro_girassol'));
  assert.deepStrictEqual(leuGir, [], 'o backfill da GOOD leu arquivo da Girassol: ' + leuGir.join(', '));
  const shopeeGir = urls.filter(u => /\/girassol\//.test(u) || /interno\/escrow|CHAVE-SENTINELA/.test(u));
  assert.deepStrictEqual(shopeeGir, [], 'chamada pro serviço da Girassol: ' + shopeeGir.join(', '));
  /* 27/10 — a GOOD ganhou o repasse REAL da Shopee (escrow, pela peça dela): a mesma rodada, agora com o lote de
     repasse da GOOD, grava a comissão da Shopee DO REPASSE (13,50 — o Bling não trazia) e continua sem nenhuma chamada
     pro serviço da Girassol; e o index da GOOD liga as duas funções do repasse no contexto do backfill dela. */
  /* 27/10 — o repasse FALHANDO (o caso da chave vencida): a venda da Shopee fica com a comissão do Bling e o DIA fica
     anotado na pasta da GOOD pra madrugada refazer (lib/checkout/repasse-pendente); a rodada seguinte, com o repasse
     de volta, tira o dia da lista. */
  { const RP = require('../lib/checkout/repasse-pendente');
    const ctxF = Object.assign({}, ctx, { escrowEmLote: async () => ({}), escrowDoPedido: async () => ({ ok: false }) });
    gravadas.length = 0;
    const rF = await gbo.backfillVendas('2026-10-05', '2026-10-05', 'good', ctxF);
    assert.ok(rF && rF.desfecho !== 'abortado' && rF.desfecho !== 'erro', 'o backfill com o repasse falhando não rodou');
    const pendF = RP.listar(dirGood);
    assert.ok(pendF.length === 1 && pendF[0].dia === '2026-10-05' && pendF[0].pedidos === 1, 'o dia sem repasse não ficou anotado na pasta da GOOD: ' + JSON.stringify(pendF));
    assert.ok(!fs.existsSync(path.join(dirGir, RP.ARQ)), 'anotou o dia sem repasse na pasta da GIRASSOL'); }
  { const pediuLote = [];
    const ctx2 = Object.assign({}, ctx, {
      escrowEmLote: async (sns) => { pediuLote.push(...sns); return { '2610051ABCDEFG': { tarifa: 13.5, sobra: 0, frete_liquido_vendedor: 0 } }; },
      escrowDoPedido: async () => ({ ok: false }) });
    gravadas.length = 0; urls.length = 0;
    const r2 = await gbo.backfillVendas('2026-10-05', '2026-10-05', 'good', ctx2);
    assert.ok(r2 && r2.desfecho !== 'abortado' && r2.desfecho !== 'erro', 'o backfill com repasse não rodou: ' + JSON.stringify(r2 && { desfecho: r2.desfecho, msg: r2.msg }));
    const sh = gravadas.find((l) => l.canal === 'shopee');
    assert.ok(pediuLote.includes('2610051ABCDEFG'), 'o backfill da GOOD não pediu o repasse da venda da Shopee');
    assert.ok(sh && Number(sh.comissao) === 13.5, 'a venda da Shopee da GOOD não saiu com a comissão do REPASSE: ' + (sh && sh.comissao));
    assert.deepStrictEqual(require('../lib/checkout/repasse-pendente').listar(dirGood), [], 'com o repasse de volta, o dia não saiu da lista de pendentes');
    for (const l of gravadas.filter((x) => x.canal !== 'shopee')) assert.strictEqual(Number(l.comissao), 10, l.canal + ': o repasse da Shopee mexeu em outro canal');
    const shopeeGir2 = urls.filter(u => /\/girassol\//.test(u) || /interno\/escrow|CHAVE-SENTINELA/.test(u));
    assert.deepStrictEqual(shopeeGir2, [], 'chamada pro serviço da Girassol com o repasse ligado: ' + shopeeGir2.join(', '));
    const gsrc = _rfs.call(fs, path.join(raiz, 'good-checkout-offline', 'index.js'), 'utf8');
    assert.ok(/escrowEmLote: \(\.\.\.a\) => escrowEmLoteShopeeGood\(\.\.\.a\), escrowDoPedido: \(\.\.\.a\) => escrowDoPedidoShopeeGood\(\.\.\.a\),/.test(gsrc)
      && /escrowEmLote: escrowEmLoteShopeeGood, escrowDoPedido: escrowDoPedidoShopeeGood \} = require\('\.\/good-shopee'\)/.test(gsrc), 'o index da GOOD não liga o repasse DELA no backfill'); }
  console.log('ok — backfill de produção com o contexto da GOOD grava custo/comissão/frete da GOOD; zero leitura, token e chamada da Girassol (' + tokenGood + ' pedido(s) de token da GOOD)');
  process.exit(0);
})().catch(e => { console.error('FALHOU:', e.message); process.exit(1); });
