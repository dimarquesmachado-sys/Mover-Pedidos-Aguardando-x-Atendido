'use strict';
/* 29/10 — passo 3b-2 do backfill único: a AMB passa a rodar o backfill COMPARTILHADO (girassol-backup-offline/gbo-app.js)
   com as fontes DELA no contexto; sai a cópia de 690 linhas. Prova de equivalência: o backfill de ANTES da AMB (fixture com
   o texto original) e o compartilhado no contexto da AMB rodam nos MESMOS dados — Bling, ML, Shopee (escrow), TikTok
   (arquivo financeiro), Magalu (caça e banco de frete), Olist e um cancelado — e gravam as MESMAS linhas no histórico.
   Mais: o andamento é o objeto da AMB (o resto do arquivo dela lê o mesmo), e as travas são as dela. */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const raiz = path.join(__dirname, '..');
const dirGir = fs.mkdtempSync(path.join(os.tmpdir(), 'gir-')), dirTk = fs.mkdtempSync(path.join(os.tmpdir(), 'tk-')), dirAmb = fs.mkdtempSync(path.join(os.tmpdir(), 'amb-'));
process.env.GIRABKP_CACHE_DIR = dirGir; process.env.TIKTOK_CACHE_DIR = dirTk;
fs.writeFileSync(path.join(dirAmb, '_custos.json'), JSON.stringify({ A1: { custo: 20 }, A2: { custo: 5 }, S1: { custo: 12 }, T1: { custo: 9 }, M1: { custo: 30 }, O1: { custo: 7 }, MLX: { custo: 40 } }));
fs.writeFileSync(path.join(dirAmb, '_config-fiscal.json'), JSON.stringify({ aliquotas: { '2026-10': 9.5 }, taxas: { magalu: 16 } }));
fs.writeFileSync(path.join(dirTk, '_tiktok_financeiro_amb.json'), JSON.stringify({ pedidos: { 'TK777': { tarifa: 6.4, frete_liquido: -3.2 } } }));
const fetchStub = async (url) => {
  const u = String(url);
  const r = (b) => ({ ok: true, status: 200, json: async () => b, text: async () => JSON.stringify(b) });
  if (/api\.mercadolibre\.com\/users\/me/.test(u)) return r({ id: 3148025116 });
  if (/api\.mercadolibre\.com\/orders\/search/.test(u)) return r({ paging: { total: 1 }, results: /offset=0/.test(u) || !/offset=/.test(u) ? [
    { id: 2000099, status: 'paid', date_created: '2026-10-05T11:00:00.000-03:00', total_amount: 80, order_items: [{ quantity: 1, unit_price: 80, item: { seller_sku: 'MLX', title: 'só no ML' } }] }] : [] });
  return { ok: false, status: 404, json: async () => ({}), text: async () => '{}' };
};
require.cache[require.resolve('node-fetch')] = { id: 'node-fetch', filename: 'node-fetch', loaded: true, exports: fetchStub };

/* o Bling da AMB de mentira: 7 pedidos (ML com taxa, ML sem taxa → faturamento, Shopee → escrow, TikTok → arquivo,
   Magalu sem frete → banco, Olist → configuração, e um CANCELADO) */
const LJ = { ml: 206017293, shopee: 206017368, tiktok: 206027680, magalu: 206018666, olist: 203301094 };
const pedidos = [
  { id: 1, numero: 9001, nl: '2000011111111111', lj: LJ.ml, sit: 9, itens: [{ codigo: 'A1', quantidade: 2, valor: 50 }, { codigo: 'A2', quantidade: 1, valor: 30 }], taxas: { taxaComissao: 14, custoFrete: 9 }, uf: 'SP' },
  { id: 2, numero: 9002, nl: '2000022222222222', lj: LJ.ml, sit: 9, itens: [{ codigo: 'A1', quantidade: 1, valor: 60 }], taxas: { taxaComissao: 0, custoFrete: 0 }, uf: 'RJ' },
  { id: 3, numero: 9003, nl: '241005ABCDEF', lj: LJ.shopee, sit: 9, itens: [{ codigo: 'S1', quantidade: 1, valor: 40 }], taxas: {}, uf: 'MG' },
  { id: 4, numero: 9004, nl: 'TK777', lj: LJ.tiktok, sit: 9, itens: [{ codigo: 'T1', quantidade: 1, valor: 35 }], taxas: {}, uf: 'BA' },
  { id: 5, numero: 9005, nl: 'LU-555', lj: LJ.magalu, sit: 9, itens: [{ codigo: 'M1', quantidade: 1, valor: 90 }], taxas: { taxaComissao: 14.4, custoFrete: 0 }, uf: 'PR' },
  { id: 6, numero: 9006, nl: 'ORD123', lj: LJ.olist, sit: 9, itens: [{ codigo: 'O1', quantidade: 1, valor: 25 }], taxas: {}, uf: 'SC' },
  { id: 7, numero: 9007, nl: '2000077777777777', lj: LJ.ml, sit: 12, itens: [{ codigo: 'A1', quantidade: 1, valor: 50 }], taxas: { taxaComissao: 7, custoFrete: 5 }, uf: 'SP' },
];
const blingGet = async (p) => {
  if (/^\/situacoes\/modulos$/.test(p)) return { ok: true, status: 200, data: { data: [{ id: 98310, nome: 'Vendas' }] } };
  if (/^\/situacoes\/modulos\/98310$/.test(p)) return { ok: true, status: 200, data: { data: [{ id: 12, nome: 'Cancelado' }, { id: 9, nome: 'Atendido' }] } };
  if (/^\/pedidos\/vendas\?/.test(p)) return { ok: true, status: 200, data: { data: /pagina=1(&|$)/.test(p) ? pedidos.map((x) => ({ id: x.id, numero: x.numero, numeroLoja: x.nl, data: '2026-10-05', situacao: { id: x.sit }, loja: { id: x.lj } })) : [] } };
  const m = /^\/pedidos\/vendas\/(\d+)$/.exec(p);
  if (m) { const x = pedidos.find((y) => String(y.id) === m[1]);
    return { ok: true, status: 200, data: { data: { id: x.id, numero: x.numero, numeroPedidoLoja: x.nl, numeroLoja: x.nl, data: '2026-10-05', situacao: { id: x.sit }, loja: { id: x.lj },
      itens: x.itens.map((it) => Object.assign({ descricao: 'p ' + it.codigo }, it)), total: x.itens.reduce((a, it) => a + it.valor * it.quantidade, 0),
      taxas: x.taxas, contato: { endereco: { uf: x.uf } }, transporte: {} } } }; }
  return { ok: true, status: 200, data: { data: [] } };
};
const escrowEmLote = async (sns) => { const out = {}; for (const sn of sns) if (sn === '241005ABCDEF') out[sn] = { comissao: 6.8, frete: 4.1, taxa_servico: 1.5, ok: true }; return out; };
const escrowDoPedido = async () => null;
const linhaMg = { empresa: 'amb', numero_pedido: 'MG-ZZ1', numero_loja: 'ZZ1', canal: 'magalu', data_venda: '2026-10-05', sku: 'M1', quantidade: 1, valor_produto: 70, valor_nota: 70, custo: 30, comissao: 11.2, frete_vendedor: 8, imposto: 6.65, margem: 14.15 };
const magaluLinhas = async () => ({ linhas: [Object.assign({}, linhaMg)], pedidos: 1, na_magalu: 2, parcial: false, erro: null });
const mapas = async () => ({ com: { '2000022222222222': 9.6 }, fre: { '2000022222222222': 6.2 } });

function fonteDe(arq, nome) {
  const L = fs.readFileSync(arq, 'utf8').split('\n');
  const i = L.findIndex((l) => new RegExp('^(async )?function ' + nome + '\\(').test(l));
  let j = i + 1; while (!/^\}/.test(L[j])) j++;
  return L.slice(i, j + 1).join('\n');
}

(async () => {
  const _log = console.log; console.log = () => {};
  let falhou = null;
  try {
    const readJson = (f, pad) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return pad; } };
    const DEFAULT_ALIQ_BK = { '2026-09': 9.1 };
    const custoVigenteEm = () => null;
    const comum = require('../amb-checkout-offline/comum');
    const { contasDoEscrow } = require('../lib/shopee-escrow');
    const ambSrc = path.join(raiz, 'amb-checkout-offline', 'index.js');
    /* os ajudantes copiados da AMB (idênticos aos do compartilhado) tirados do arquivo de ANTES */
    const antesSrc = '/tmp/amb_antes_3b2.js';
    const srcAntes = fs.existsSync(antesSrc) ? antesSrc : ambSrc;
    const _inferCanal = new Function(fonteDe(srcAntes, '_inferCanal') + '; return _inferCanal;')();
    const _feeMLLeve = new Function('fetch', fonteDe(srcAntes, '_feeMLLeve') + '; return _feeMLLeve;')(fetchStub);
    const LOJA_MKT = { [LJ.ml]: 'ml', [LJ.shopee]: 'shopee', [LJ.tiktok]: 'tiktok', [LJ.magalu]: 'magalu' };
    const supaPara = (alvo) => async (emp, met, q, body) => { if (met === 'POST' && Array.isArray(body)) alvo.push(...body.map((l) => Object.assign({}, l))); return { ok: true, status: met === 'POST' ? 201 : 200, body: '[]' }; };
    // ── o de ANTES ──
    const linhasAntes = [];
    const criarAntigo = require('./fixtures/backfill-amb-antes');
    const ant = criarAntigo({ fs, path, fetch: fetchStub, CACHE_DIR: dirAmb, readJson, DEFAULT_ALIQ_BK, blingGet, supaReq: supaPara(linhasAntes),
      servicoDoPedido: comum.servicoDoPedido, ehFlex: comum.ehFlex, magaluLinhas, magaluFreteSkuLer: () => ({ M1: { media: 13.3 } }),
      garantirSitCancel: async () => ({ ids: [12] }), _sitCancel: { ids: [12] }, escrowEmLote, escrowDoPedido, custoVigenteEm, contasDoEscrow,
      _mlBilling: { aplicarCreditosFlexNaFila: async () => ({}) }, _mapasBilling: mapas, _inferCanal, _feeMLLeve, LOJA_MKT, SHOPEE_TODOS: false });
    /* o de antes pega o token do ML com require('../ambtotal/mlTokenManager') — no teste, o token de mentira */
    const rTk = require.resolve(path.join(raiz, 'ambtotal', 'mlTokenManager.js'));
    const salvoTk = require.cache[rTk];
    require.cache[rTk] = { id: rTk, filename: rTk, loaded: true, exports: { garantirTokenML: async () => 'tk-amb' } };
    await ant.backfillVendas('2026-10-05', '2026-10-05', 'amb');
    // ── o NOVO: o compartilhado com o contexto da AMB ──
    const linhasNovas = [];
    const gbo = require(path.join(raiz, 'girassol-backup-offline', 'gbo-app.js'));
    const estadoAmb = { rodando: false, empresa: null, de: null, ate: null, pagina: 0, pedidos: 0, itens: 0, gravados: 0, erros: 0, fase: 'parado', inicio: null, fim: null, msg: '' };
    const ctx = { estadoBackfill: estadoAmb, blingGet, readJson, CACHE_DIR: dirAmb, supaReq: supaPara(linhasNovas), supaCount: async () => null,
      DEFAULT_ALIQ_BK, aliqReserva: 14.1, custoVigenteEm, mapasBilling: mapas, garantirTokenML: async () => 'tk-amb',
      escrowEmLote, escrowDoPedido, LOJA_MKT, magaluFreteSkuLer: () => ({ M1: { media: 13.3 } }),
      creditosFlex: async () => ({}), magaluLinhas, cacaMagaluRodando: () => false, canarioRodando: () => false, reparoAtivo: () => false };
    const rNovo = await gbo.backfillVendas('2026-10-05', '2026-10-05', 'amb', ctx);
    if (salvoTk) require.cache[rTk] = salvoTk; else delete require.cache[rTk];
    assert.ok(rNovo && rNovo.desfecho !== 'abortado' && rNovo.desfecho !== 'erro', 'o compartilhado não rodou com a AMB: ' + JSON.stringify(rNovo && { d: rNovo.desfecho, m: rNovo.msg }));
    // ── a comparação: as MESMAS linhas ──
    const chave = (l) => [l.numero_pedido, l.sku, l.canal].join('|');
    const ord = (a) => a.slice().sort((x, y) => chave(x).localeCompare(chave(y)));
    const A = ord(linhasAntes), N = ord(linhasNovas);
    assert.ok(A.length >= 8, 'o cenário não exercitou o bastante (linhas do antigo: ' + A.length + ')');
    assert.deepStrictEqual(N.map(chave), A.map(chave), 'as linhas gravadas não são as mesmas (pedido|sku|canal)');
    for (let i = 0; i < A.length; i++) {
      /* `lote` é a marca da rodada (empresa:de:ate:instante:aleatório) — muda a cada rodada por construção; o resto é igual */
      assert.ok(/^amb:2026-10-05:2026-10-05:/.test(String(N[i].lote || '')), 'a marca da rodada não é da AMB: ' + N[i].lote);
      const dif = Object.keys(Object.assign({}, A[i], N[i])).filter((k) => k !== 'lote' && JSON.stringify(A[i][k]) !== JSON.stringify(N[i][k]));
      assert.deepStrictEqual(dif, [], 'linha ' + chave(A[i]) + ' mudou nos campos: ' + dif.map((k) => k + ' ' + JSON.stringify(A[i][k]) + '→' + JSON.stringify(N[i][k])).join('; '));
    }
    assert.ok(!A.some((l) => l.numero_loja === '2000077777777777'), 'o cancelado entrou (o cenário não testou a regra)');
    /* o pedido 'ORD123' (loja fora da tabela) passa pela inferência do canal pelo número — na AMB não há Olist configurado
       (config-empresa), então os dois classificam igual; o que importa aqui é que os dois façam o MESMO */
    assert.ok(A.some((l) => l.canal === 'shopee') && A.some((l) => l.canal === 'tiktok') && A.some((l) => l.numero_loja === 'ORD123') && A.some((l) => l.numero_loja === 'ZZ1') && A.some((l) => l.numero_loja === '2000099'),
      'o cenário não passou por Shopee/TikTok/Olist/caça da Magalu/vendas direto do ML: ' + JSON.stringify(A.map((l) => l.canal + ':' + l.numero_loja)));
    // ── o andamento é o objeto DA AMB ──
    assert.ok(estadoAmb.empresa === 'amb' && estadoAmb.de === '2026-10-05' && /concluido/.test(String(estadoAmb.fase)) && estadoAmb.pedidos === ant.estado().pedidos, 'o andamento não é o objeto da AMB: ' + JSON.stringify(estadoAmb).slice(0, 160));
    assert.ok(gbo.backfillEstado('amb').empresa === 'amb' && gbo.backfillEstado().empresa !== 'amb', 'o andamento da AMB misturou com o da Girassol');
    // ── as travas são as DA AMB ──
    const rRep = await gbo.backfillVendas('2026-10-05', '2026-10-05', 'amb', Object.assign({}, ctx, { reparoAtivo: () => true }));
    assert.ok(rRep && rRep.desfecho === 'adiado' && /reparo/.test(String(rRep.adiado || rRep.msg)), 'o reparo de SKU da AMB não adiou o backfill dela');
    const rCan = await gbo.backfillVendas('2026-10-05', '2026-10-05', 'amb', Object.assign({}, ctx, { canarioRodando: () => true }));
    assert.ok(rCan && rCan.desfecho === 'adiado' && /canário/.test(String(rCan.msg)), 'o canário da AMB não adiou o backfill dela');
  } catch (e) { falhou = e; }
  finally { console.log = _log; }
  if (falhou) { console.error('FALHOU:', falhou.message); process.exit(1); }
  // ── a AMB usa o compartilhado (a cópia saiu) ──
  const s = fs.readFileSync(path.join(raiz, 'amb-checkout-offline', 'index.js'), 'utf8');
  const iB = s.indexOf('async function backfillVendas(');
  const fnB = s.slice(iB, s.indexOf('\n}\n', iB) + 2);
  assert.ok(/return require\('\.\.\/girassol-backup-offline\/gbo-app'\)\.backfillVendas\(de, ate, 'amb', _ctxBackfillAmb\(\)\);/.test(fnB) && fnB.split('\n').length < 6, 'a AMB não usa o compartilhado (ou sobrou a cópia)');
  assert.ok(/const _backfill = \{ rodando:false/.test(s) && !/\n\s*_backfill = \{/.test(s) && /estadoBackfill: _backfill,/.test(s), 'o andamento da AMB não é um objeto estável passado ao compartilhado');
  /* o contexto DE VERDADE da AMB leva as fontes DELA (o teste acima usou um contexto igual a este) */
  const iC = s.indexOf('function _ctxBackfillAmb() {'), ctxTxt = s.slice(iC, s.indexOf('\n}\n', iC));
  for (const peca of ['blingGet, readJson, CACHE_DIR, supaReq, supaCount,', 'DEFAULT_ALIQ_BK, aliqReserva: 14.1,', 'custoVigenteEm, mapasBilling: _mapasBilling,',
    "garantirTokenML: () => require('../ambtotal/mlTokenManager').garantirTokenML(),", 'escrowEmLote, escrowDoPedido, LOJA_MKT,',
    'creditosFlex: (d1, d2) => _mlBilling.aplicarCreditosFlexNaFila(d1, d2),', 'magaluLinhas: (d1, d2, e2, j2) => _cacaMgAmb.magaluLinhas(d1, d2, e2, j2),',
    'cacaMagaluRodando: () => _cacaMgAmb.estado().rodando,', 'canarioRodando: () =>', 'reparoAtivo: () => !!_reparoAtivo,']) {
    assert.ok(ctxTxt.includes(peca), 'o contexto da AMB não leva: ' + peca);
  }
  console.log('ok — a AMB no backfill compartilhado grava EXATAMENTE as mesmas linhas do de antes (ML, Shopee, TikTok, Magalu, canal inferido, ML direto, caça); andamento e travas dela');
  process.exit(0);
})();
