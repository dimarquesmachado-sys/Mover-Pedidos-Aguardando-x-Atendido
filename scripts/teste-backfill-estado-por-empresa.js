'use strict';
/* 29/10 — passo 3a do backfill único: o ANDAMENTO do backfill é POR EMPRESA. Era um só pro servidor inteiro: a GOOD (que
   roda pela função da Girassol, girassol-backup-offline/gbo-app.js) dividia o andamento com a Girassol — o backfill de uma
   travava o da outra ('ja_rodando'), a madrugada da GOOD esperava a da Girassol, e o status de uma mostrava a outra.
   Prova, com o backfillVendas DE PRODUÇÃO no contexto da GOOD (Bling e Supabase de mentira):
   · a rodada da GOOD fica no andamento DA GOOD; o da Girassol não se mexe;
   · com a vaga da GOOD ocupada, o backfill da GOOD diz 'ja_rodando' — e a vaga da Girassol segue livre (e vice-versa);
   · o andamento é um objeto estável por empresa (quem guardou a referência vê a rodada);
   · a GOOD pede a vaga, o ocupado e o andamento DELA em todos os pontos. */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const raiz = path.join(__dirname, '..');
const dirGir = fs.mkdtempSync(path.join(os.tmpdir(), 'gir-')), dirTk = fs.mkdtempSync(path.join(os.tmpdir(), 'tk-')), dirGood = fs.mkdtempSync(path.join(os.tmpdir(), 'goo-'));
process.env.GIRABKP_CACHE_DIR = dirGir; process.env.TIKTOK_CACHE_DIR = dirTk;
require.cache[require.resolve('node-fetch')] = { id: 'node-fetch', filename: 'node-fetch', loaded: true, exports: async () => ({ ok: false, status: 404, json: async () => ({}), text: async () => '{}' }) };

(async () => {
  const _log = console.log; console.log = () => {};
  let falhou = null;
  try {
    const gbo = require(path.join(raiz, 'girassol-backup-offline', 'gbo-app.js'));
    const readJson = (f, pad) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return pad; } };
    const blingGet = async (p) => {
      if (/^\/pedidos\/vendas\?/.test(p)) return { ok: true, status: 200, data: { data: /pagina=1(&|$)/.test(p) ? [{ id: 1, numero: 5001, numeroLoja: '2000012345678901', data: '2026-10-05', situacao: { id: 9 }, loja: { id: 701 } }] : [] } };
      if (/^\/pedidos\/vendas\/1$/.test(p)) return { ok: true, status: 200, data: { data: { id: 1, numero: 5001, numeroPedidoLoja: '2000012345678901', data: '2026-10-05', loja: { id: 701 },
        itens: [{ codigo: 'X1', descricao: 'p', quantidade: 1, valor: 100 }], total: 100, taxas: { taxaComissao: 10, custoFrete: 5 }, contato: { endereco: { uf: 'SP' } } } } };
      return { ok: true, status: 200, data: { data: [] } };
    };
    const ctx = { blingGet, readJson, CACHE_DIR: dirGood,
      supaReq: async (emp, met) => ({ ok: true, status: met === 'POST' ? 201 : 200, body: '[]' }), supaCount: async () => null, DEFAULT_ALIQ_BK: { '2026-10': 10 },
      custoVigenteEm: () => 20, garantirTokenML: null, LOJA_MKT: { '701': 'ml' }, mapasBilling: null, escrowEmLote: null, escrowDoPedido: null, magaluFreteSkuLer: () => ({}) };
    const girAntes = gbo.backfillEstado();
    // 1) a rodada da GOOD fica no andamento DA GOOD
    const r = await gbo.backfillVendas('2026-10-05', '2026-10-05', 'good', ctx);
    assert.ok(r && r.desfecho !== 'abortado' && r.desfecho !== 'erro', 'o backfill da GOOD não rodou: ' + JSON.stringify(r && { d: r.desfecho, m: r.msg }));
    const good = gbo.backfillEstado('good'), gir = gbo.backfillEstado();
    assert.ok(good.empresa === 'good' && good.de === '2026-10-05' && /concluido/.test(String(good.fase)), 'a rodada da GOOD não ficou no andamento dela: ' + JSON.stringify(good).slice(0, 160));
    assert.deepStrictEqual(gir, girAntes, 'a rodada da GOOD mexeu no andamento da GIRASSOL');
    // 2) as vagas são independentes
    assert.ok(gbo.reservarVagaBackfill('teste-good', 'good') === true, 'a vaga da GOOD não abriu');
    const rj = await gbo.backfillVendas('2026-10-05', '2026-10-05', 'good', ctx);
    assert.strictEqual(rj.desfecho, 'ja_rodando', 'com a vaga da GOOD tomada, o backfill dela tinha que dizer ja_rodando');
    assert.ok(gbo.backfillOcupado('good') === true && gbo.backfillOcupado() === false, 'a vaga da GOOD ocupou a da Girassol (ou não ocupou a dela)');
    assert.ok(gbo.reservarVagaBackfill('teste-gir') === true, 'a vaga da Girassol ficou presa pela da GOOD');
    gbo.liberarVagaBackfill('good'); gbo.liberarVagaBackfill();
    assert.ok(gbo.backfillOcupado('good') === false && gbo.backfillOcupado() === false, 'liberar não soltou as vagas');
  } catch (e) { falhou = e; }
  finally { console.log = _log; }
  if (falhou) { console.error('FALHOU:', falhou.message); process.exit(1); }
  // 3) o andamento é um objeto estável (reiniciado no lugar) e a GOOD pede o DELA em todos os pontos
  const g = fs.readFileSync(path.join(raiz, 'girassol-backup-offline', 'gbo-app.js'), 'utf8');
  assert.ok(g.includes("  const _backfill = (ctx && ctx.estado && typeof ctx.estado === 'object') ? ctx.estado : _estadoBackfill(empresa);") && g.includes("  _reiniciarEstadoBackfill(_backfill, { rodando:true, empresa, de, ate,") && !/\n\s*_backfill = \{/.test(g), 'o andamento não é por empresa / ainda é trocado de objeto');
  const d = fs.readFileSync(path.join(raiz, 'good-checkout-offline', 'index.js'), 'utf8');
  assert.ok(!/backfillOcupado\(\)|backfillEstado\(\)[^ ]|reservarVagaBackfill\(m\)|liberarVagaBackfill\(\)/.test(d.replace(/`backfillEstado\(\)`/g, '')), 'a GOOD ainda pede a vaga/andamento da Girassol em algum ponto');
  console.log('ok — andamento do backfill por empresa: a GOOD não mexe no da Girassol, vagas independentes, objeto estável');
  process.exit(0);
})();
