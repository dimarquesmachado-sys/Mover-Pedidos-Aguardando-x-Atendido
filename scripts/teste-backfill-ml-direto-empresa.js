'use strict';
/* 29/10 — passo 3b-1 do backfill único: o backfill compartilhado ganha o que só a AMB tinha (e a GOOD não):
   · as VENDAS DIRETO DO ML (o que o ML vendeu e o Bling ainda não tem — no Full da AMB, por exemplo, entra no Bling a NF
     e não o pedido) valem pra QUALQUER empresa com o token do ML dela (era só a Girassol; a AMB tinha o mesmo bloco);
     a linha sai com a empresa DELA e a alíquota da tabela DELA;
   · a alíquota de RESERVA (mês sem apurada nem tabela) é da empresa (a AMB usava 14,1; sem dizer, 15);
   · o diagnóstico da UF (com/sem estado e o 1º exemplo sem). Prova com o backfillVendas DE PRODUÇÃO no contexto da GOOD. */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const raiz = path.join(__dirname, '..');
const dirGir = fs.mkdtempSync(path.join(os.tmpdir(), 'gir-')), dirTk = fs.mkdtempSync(path.join(os.tmpdir(), 'tk-')), dirGood = fs.mkdtempSync(path.join(os.tmpdir(), 'goo-'));
process.env.GIRABKP_CACHE_DIR = dirGir; process.env.TIKTOK_CACHE_DIR = dirTk;
fs.writeFileSync(path.join(dirGood, '_custos.json'), JSON.stringify({ X1: { custo: 20 }, MLSKU: { custo: 30 } }));
const chamadasML = [];
require.cache[require.resolve('node-fetch')] = { id: 'node-fetch', filename: 'node-fetch', loaded: true, exports: async (url) => {
  const u = String(url);
  const r = (b) => ({ ok: true, status: 200, json: async () => b, text: async () => JSON.stringify(b) });
  if (/api\.mercadolibre\.com\/users\/me/.test(u)) { chamadasML.push('me'); return r({ id: 999 }); }
  if (/api\.mercadolibre\.com\/orders\/search/.test(u)) { chamadasML.push('search'); return r({ paging: { total: 1 }, results: /offset=0|&offset=0/.test(u) || !/offset=/.test(u) ? [
    { id: 2000077, status: 'paid', date_created: '2026-10-05T10:00:00.000-03:00', total_amount: 150, order_items: [{ quantity: 1, unit_price: 150, item: { seller_sku: 'MLSKU', title: 'produto só no ML' } }] }] : [] }); }
  return { ok: false, status: 404, json: async () => ({}), text: async () => '{}' };
} };

(async () => {
  const _log = console.log; console.log = () => {};
  let falhou = null;
  try {
    const gbo = require(path.join(raiz, 'girassol-backup-offline', 'gbo-app.js'));
    const readJson = (f, pad) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return pad; } };
    const blingGet = async (p) => {
      if (/^\/pedidos\/vendas\?/.test(p)) return { ok: true, status: 200, data: { data: /pagina=1(&|$)/.test(p) ? [{ id: 1, numero: 5001, numeroLoja: '2000012345678901', data: '2026-10-05', situacao: { id: 9 }, loja: { id: 701 } }] : [] } };
      if (/^\/pedidos\/vendas\/1$/.test(p)) return { ok: true, status: 200, data: { data: { id: 1, numero: 5001, numeroPedidoLoja: '2000012345678901', data: '2026-10-05', loja: { id: 701 },
        itens: [{ codigo: 'X1', descricao: 'p', quantidade: 1, valor: 100 }], total: 100, taxas: { taxaComissao: 10, custoFrete: 5 }, contato: { endereco: {} } } } };
      return { ok: true, status: 200, data: { data: [] } };
    };
    const gravadas = [];
    const ctx = { blingGet, readJson, CACHE_DIR: dirGood,
      supaReq: async (emp, met, q, body) => { if (met === 'POST' && Array.isArray(body)) gravadas.push(...body); return { ok: true, status: met === 'POST' ? 201 : 200, body: '[]' }; },
      supaCount: async () => null, DEFAULT_ALIQ_BK: { '2026-10': 8 }, aliqReserva: 14.1,
      custoVigenteEm: () => 20, garantirTokenML: async () => 'tk-good', LOJA_MKT: { '701': 'ml' }, mapasBilling: null, escrowEmLote: null, escrowDoPedido: null, magaluFreteSkuLer: () => ({}) };
    const r = await gbo.backfillVendas('2026-10-05', '2026-10-05', 'good', ctx);
    assert.ok(r && r.desfecho !== 'abortado' && r.desfecho !== 'erro', 'o backfill não rodou: ' + JSON.stringify(r && { d: r.desfecho, m: r.msg }));
    const doMl = gravadas.find((l) => l.numero_loja === '2000077');
    assert.ok(doMl && doMl.empresa === 'good' && doMl.canal === 'ml' && Number(doMl.valor_produto) === 150, 'a venda que só o ML tem não entrou (ou entrou com outra empresa): ' + JSON.stringify(doMl));
    assert.strictEqual(Number(doMl.imposto), 12, 'a linha do ML não usou a alíquota DA EMPRESA (8% de 150)');
    assert.ok(chamadasML.includes('me') && chamadasML.includes('search'), 'não perguntou ao ML com o token da empresa');
    assert.ok(r.do_marketplace && r.do_marketplace.vendas === 1, 'o resultado não diz o que veio direto do ML: ' + JSON.stringify(r.do_marketplace));
    assert.ok(r.uf && r.uf.sem === 1 && r.uf.com === 0 && r.uf.exemplo_sem && r.uf.exemplo_sem.pedido === 5001, 'o diagnóstico da UF não veio: ' + JSON.stringify(r.uf));
    // sem token: pula (nada muda)
    gravadas.length = 0; chamadasML.length = 0;
    const r2 = await gbo.backfillVendas('2026-10-05', '2026-10-05', 'good', Object.assign({}, ctx, { garantirTokenML: null }));
    assert.ok(r2 && !gravadas.some((l) => l.numero_loja === '2000077') && !chamadasML.length, 'sem token, o backfill foi ao ML');
    // a alíquota de reserva é da empresa: mês fora da tabela usa 14,1 (não os 15 da Girassol)
    gravadas.length = 0;
    const r3 = await gbo.backfillVendas('2026-10-05', '2026-10-05', 'good', Object.assign({}, ctx, { DEFAULT_ALIQ_BK: {}, garantirTokenML: null }));
    const lb = gravadas.find((l) => l.numero_loja === '2000012345678901');
    assert.ok(r3 && lb && Math.abs(Number(lb.imposto) - 14.1) < 0.011, 'a alíquota de reserva não é a da empresa (14,1% de 100): ' + JSON.stringify(lb && lb.imposto));
  } catch (e) { falhou = e; }
  finally { console.log = _log; }
  if (falhou) { console.error('FALHOU:', falhou.message); process.exit(1); }
  const g = fs.readFileSync(path.join(raiz, 'girassol-backup-offline', 'gbo-app.js'), 'utf8');
  assert.ok(g.includes("      if (_D.garantirTokenML) {") && !g.includes("      if (empresa === 'girassol') {\n        const { garantirTokenML } = require('../girassol/mlTokenManager');"), 'as vendas direto do ML ainda são só da Girassol');
  console.log('ok — backfill compartilhado: vendas direto do ML pra qualquer empresa com token (empresa e alíquota dela), reserva da empresa, diagnóstico da UF');
  process.exit(0);
})();
