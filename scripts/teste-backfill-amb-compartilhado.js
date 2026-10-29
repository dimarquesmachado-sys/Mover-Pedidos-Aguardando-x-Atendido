'use strict';
/* 29/10 — passo 3b-2 do backfill único: a AMB passa a rodar o backfill COMPARTILHADO (girassol-backup-offline/gbo-app.js)
   com as fontes dela, e a cópia de 690 linhas sai. Prova de que a AMB grava O MESMO: o backfillVendas de ANTES da AMB
   (fixture: o texto original, com as dependências como parâmetros) e o compartilhado com o contexto da AMB rodam LADO A
   LADO nos mesmos dados — Bling (ML, Shopee, TikTok, um cancelado), Shopee escrow, TikTok financeiro, ML direto (venda que
   o Bling não tem) e a caça da Magalu — e as LINHAS GRAVADAS no histórico têm que ser iguais. E: a AMB delega com o
   contexto dela; o andamento dela é o objeto dela no compartilhado; o canário e o reparo de outra empresa não travam. */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const raiz = path.join(__dirname, '..');
const dirGir = fs.mkdtempSync(path.join(os.tmpdir(), 'gir-')), dirTk = fs.mkdtempSync(path.join(os.tmpdir(), 'tk-')), dirAmb = fs.mkdtempSync(path.join(os.tmpdir(), 'amb-'));
process.env.GIRABKP_CACHE_DIR = dirGir; process.env.TIKTOK_CACHE_DIR = dirTk;
fs.writeFileSync(path.join(dirTk, '_tiktok_financeiro_amb.json'), JSON.stringify({ pedidos: { '585000111': { tarifa: 7.5, frete_liquido: 4 } } }));
fs.writeFileSync(path.join(dirAmb, '_custos.json'), JSON.stringify({ X1: { custo: 20 }, S1: { custo: 10 }, T1: { custo: 12 }, MLSKU: { custo: 30 } }));
fs.writeFileSync(path.join(dirAmb, '_config-fiscal.json'), JSON.stringify({ aliquotas: { '2026-10': 9 } }));
const fakeFetch = async (url) => {
  const u = String(url);
  const r = (b) => ({ ok: true, status: 200, json: async () => b, text: async () => JSON.stringify(b) });
  if (/api\.mercadolibre\.com\/users\/me/.test(u)) return r({ id: 999 });
  if (/api\.mercadolibre\.com\/orders\/search/.test(u)) return r({ paging: { total: 1 }, results: (/offset=0/.test(u) || !/offset=/.test(u)) ? [
    { id: 2000077, status: 'paid', date_created: '2026-10-05T10:00:00.000-03:00', total_amount: 150, order_items: [{ quantity: 1, unit_price: 150, item: { seller_sku: 'MLSKU', title: 'só no ML' } }] }] : [] });
  return { ok: false, status: 404, json: async () => ({}), text: async () => '{}' };
};
require.cache[require.resolve('node-fetch')] = { id: 'node-fetch', filename: 'node-fetch', loaded: true, exports: fakeFetch };

function cenario() {
  const gravadas = [];
  const pedidos = [
    { id: 1, numero: 6001, nl: '2000012345678901', loja: 206017293, sit: 9, itens: [{ codigo: 'X1', descricao: 'ml', quantidade: 1, valor: 100 }], taxas: { taxaComissao: 12, custoFrete: 8 } },
    { id: 2, numero: 6002, nl: '2510AB12CD', loja: 206017368, sit: 9, itens: [{ codigo: 'S1', descricao: 'shopee', quantidade: 2, valor: 40 }], taxas: { taxaComissao: 0, custoFrete: 0 } },
    { id: 3, numero: 6003, nl: '585000111', loja: 206027680, sit: 9, itens: [{ codigo: 'T1', descricao: 'tiktok', quantidade: 1, valor: 60 }], taxas: { taxaComissao: 0, custoFrete: 0 } },
    { id: 4, numero: 6004, nl: '2000099999999999', loja: 206017293, sit: 12, itens: [{ codigo: 'X1', descricao: 'cancelado', quantidade: 1, valor: 100 }], taxas: {} },
  ];
  const blingGet = async (p) => {
    if (/^\/situacoes\/modulos$/.test(p)) return { ok: true, status: 200, data: { data: [{ id: 98310, nome: 'Vendas' }] } };
    if (/^\/situacoes\/modulos\/98310/.test(p)) return { ok: true, status: 200, data: { data: [{ id: 12, nome: 'Cancelado' }, { id: 9, nome: 'Atendido' }] } };
    if (/^\/pedidos\/vendas\?/.test(p)) return { ok: true, status: 200, data: { data: /pagina=1(&|$)/.test(p) ? pedidos.map((x) => ({ id: x.id, numero: x.numero, numeroLoja: x.nl, data: '2026-10-05', situacao: { id: x.sit }, loja: { id: x.loja } })) : [] } };
    const m = /^\/pedidos\/vendas\/(\d+)$/.exec(p);
    if (m) { const x = pedidos.find((y) => String(y.id) === m[1]);
      return { ok: true, status: 200, data: { data: { id: x.id, numero: x.numero, numeroPedidoLoja: x.nl, data: '2026-10-05', loja: { id: x.loja }, itens: x.itens,
        total: x.itens.reduce((a, i) => a + i.valor * i.quantidade, 0), taxas: x.taxas, contato: { endereco: { uf: 'SP' } }, transporte: { etiqueta: { uf: 'SP' } } } } }; }
    return { ok: true, status: 200, data: { data: [] } };
  };
  const supaReq = async (emp, met, q, body) => { if (met === 'POST' && Array.isArray(body)) gravadas.push(...body); return { ok: true, status: met === 'POST' ? 201 : 200, body: '[]' }; };
  const escrowEmLote = async (sns) => { const o = {}; for (const sn of sns) o[sn] = { ok: true, escrow: { order_income: { commission_fee: 9, service_fee: 2, actual_shipping_fee: 5, shopee_shipping_rebate: 0, buyer_paid_shipping_fee: 0, escrow_amount: 64 } } }; return { ok: true, porSn: o }; };
  const escrowDoPedido = async () => ({ ok: true, escrow: { order_income: { commission_fee: 9, service_fee: 2, actual_shipping_fee: 5, shopee_shipping_rebate: 0, buyer_paid_shipping_fee: 0, escrow_amount: 64 } } });
  const linhaMg = { empresa: 'amb', numero_pedido: 'MG-M9', numero_loja: 'M9', canal: 'magalu', data_venda: '2026-10-05', sku: 'X1', quantidade: 1, valor_produto: 77, valor_nota: 77, custo: 20, comissao: 7, frete_vendedor: 3, imposto: 6.93, margem: 40.07 };
  const comum = {
    blingGet, readJson: (f, pad) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return pad; } }, CACHE_DIR: dirAmb, supaReq,
    DEFAULT_ALIQ_BK: { '2026-09': 8 }, custoVigenteEm: () => null, LOJA_MKT: { '206017293': 'ml', '206017368': 'shopee', '206027680': 'tiktok' },
    escrowEmLote, escrowDoPedido, magaluFreteSkuLer: () => ({}),
    magaluLinhas: async (de, ate, emp, ja) => ({ linhas: [linhaMg], pedidos: 1, na_magalu: 1, parcial: false, erro: null }),
    mapas: async () => ({ com: {}, fre: {} }),
  };
  return { gravadas, comum };
}
/* o `lote` é o carimbo de CADA rodada (empresa:período:instante:aleatório) — muda a toda rodada, por desenho; o resto tem que ser igual */
const ordena = (l) => l.map((x) => JSON.stringify(Object.keys(x).filter((k) => k !== 'lote').sort().reduce((o, k) => { o[k] = x[k]; return o; }, {}))).sort();

(async () => {
  const _log = console.log; console.log = () => {};
  let falhou = null;
  try {
    const gbo = require(path.join(raiz, 'girassol-backup-offline', 'gbo-app.js'));
    const gboSrc = fs.readFileSync(path.join(raiz, 'girassol-backup-offline', 'gbo-app.js'), 'utf8');
    const mInf = /function _inferCanal\(nl\) \{[\s\S]*?\n\}/.exec(gboSrc);
    const _inferCanal = new Function(mInf[0] + '; return _inferCanal;')();
    const { servicoDoPedido, ehFlex } = require(path.join(raiz, 'amb-checkout-offline', 'comum'));
    // o de ANTES
    const a = cenario();
    const antigo = require('./fixtures/backfill-amb-antes')({ CACHE_DIR: dirAmb, path, fs, readJson: a.comum.readJson, DEFAULT_ALIQ_BK: a.comum.DEFAULT_ALIQ_BK, blingGet: a.comum.blingGet,
      _canario: { rodando: false }, supaReq: a.comum.supaReq, fetch: fakeFetch, SHOPEE_TODOS: false, servicoDoPedido, ehFlex,
      magaluLinhas: a.comum.magaluLinhas, magaluFreteSkuLer: a.comum.magaluFreteSkuLer, garantirSitCancel: async () => ({ ids: [12] }), _sitCancel: { ids: [12] },
      escrowEmLote: a.comum.escrowEmLote, escrowDoPedido: a.comum.escrowDoPedido, custoVigenteEm: a.comum.custoVigenteEm, contasDoEscrow: require(path.join(raiz, 'amb-checkout-offline', 'amb-shopee')).contasDoEscrow,
      _mlBilling: { aplicarCreditosFlexNaFila: async () => ({}) }, _mapasBilling: a.comum.mapas, _inferCanal, _feeMLLeve: async () => null, LOJA_MKT: a.comum.LOJA_MKT,
      mlTokenManager: () => ({ garantirTokenML: async () => 'tk-amb' }) });
    await antigo.backfillVendas('2026-10-05', '2026-10-05', 'amb');
    // o NOVO: o compartilhado com o contexto da AMB
    const b = cenario();
    const estadoAmb = { rodando: false, fase: 'parado' };
    const ctx = Object.assign({}, b.comum, { estado: estadoAmb, aliqReserva: 14.1, supaCount: null, garantirTokenML: async () => 'tk-amb', mapasBilling: b.comum.mapas,
      creditosFlex: async () => ({}), cacaMagaluRodando: () => false, canarioRodando: () => false, reparoAtivo: () => false });
    const rn = await gbo.backfillVendas('2026-10-05', '2026-10-05', 'amb', ctx);
    assert.ok(rn && rn.desfecho !== 'abortado' && rn.desfecho !== 'erro', 'o compartilhado com a AMB não rodou: ' + JSON.stringify(rn && { d: rn.desfecho, m: rn.msg }));
    assert.ok(a.gravadas.length >= 5, 'o cenário não gravou o suficiente pra comparação provar algo: ' + a.gravadas.length);
    assert.ok(a.gravadas.some((l) => l.canal === 'shopee') && a.gravadas.some((l) => l.canal === 'tiktok') && a.gravadas.some((l) => l.numero_loja === '2000077') && a.gravadas.some((l) => l.canal === 'magalu') && !a.gravadas.some((l) => l.numero_loja === '2000099999999999'),
      'o cenário não passou por todos os caminhos (shopee, tiktok, ML direto, magalu, cancelado fora)');
    assert.deepStrictEqual(ordena(b.gravadas), ordena(a.gravadas), 'a AMB pelo compartilhado NÃO grava o mesmo que gravava');
    /* o andamento é o objeto QUE A AMB ENTREGOU (o dela, reiniciado no lugar) — e o da Girassol não se mexe */
    assert.ok(estadoAmb.empresa === 'amb' && /concluido/.test(String(estadoAmb.fase)) && estadoAmb.uf && estadoAmb.uf.com > 0, 'o andamento da AMB não ficou no objeto dela: ' + JSON.stringify(estadoAmb).slice(0, 160));
    assert.ok(gbo.backfillEstado().fase === 'parado', 'a rodada da AMB mexeu no andamento da Girassol');
    // o canário e o reparo de OUTRA empresa não travam
    const rc = await gbo.backfillVendas('2026-10-05', '2026-10-05', 'amb', Object.assign({}, ctx, { canarioRodando: () => true }));
    assert.strictEqual(rc.desfecho, 'adiado', 'o canário DA AMB tinha que adiar');
  } catch (e) { falhou = e; }
  finally { console.log = _log; }
  if (falhou) { console.error('FALHOU:', falhou.message); process.exit(1); }
  // a AMB delega com o contexto dela, o andamento é o objeto dela, e a cópia saiu
  const s = fs.readFileSync(path.join(raiz, 'amb-checkout-offline', 'index.js'), 'utf8');
  assert.ok(s.includes("return require('../girassol-backup-offline/gbo-app').backfillVendas(de, ate, 'amb', _ctxBackfillAmb());") && s.includes('    estado: _backfill,') && !/^const _x = require\('\.\.\/girassol-backup-offline\/gbo-app'\)/m.test(s), 'a AMB não delega ao compartilhado (ou não entrega o andamento dela)');
  /* a AMB NÃO carrega o arquivo da Girassol na subida (carregar lá muda coisas daqui — pegou 3 testes do checkout) */
  assert.ok(!/^[^\n]*= require\('\.\.\/girassol-backup-offline\/gbo-app'\)/m.test(s.split('\n').filter((l) => !/^\s/.test(l)).join('\n')), 'a AMB carrega o arquivo da Girassol na subida');
  assert.ok(!/_tkPedidosA|_olistCfgA|const aliqBk = mes =>/.test(s), 'sobrou pedaço da cópia antiga do backfill na AMB');
  for (const k of ['aliqReserva: 14.1', "magaluLinhas: (d1, d2, e2, j2) => _cacaMgAmb.magaluLinhas(d1, d2, e2, j2)", "garantirTokenML: () => require('../ambtotal/mlTokenManager').garantirTokenML()", 'canarioRodando: () => !!(_canario && _canario.rodando)', 'reparoAtivo: () => _reparoAtivo']) {
    assert.ok(s.includes(k), 'o contexto da AMB não leva: ' + k);
  }
  console.log('ok — a AMB pelo backfill compartilhado grava EXATAMENTE o que gravava (ML, Shopee, TikTok, ML direto, Magalu, cancelado fora); andamento dela; a cópia saiu');
  process.exit(0);
})();
