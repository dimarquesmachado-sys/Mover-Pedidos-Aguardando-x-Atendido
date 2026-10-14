'use strict';
/* 14/10 — parecer do Codex (6.4): comissão/frete NULOS viravam 0 (`Number(x) || 0`) e a margem nula era
   reconstruída como se o pedido não tivesse pago tarifa nem frete. Roda os três leitores DE PRODUÇÃO
   (agregado, lista e busca de lib/checkout/historico.js, pela fachada da GOOD) com um Supabase de
   mentira e linhas de custo conhecido e margem nula. */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

let roteiro = [];
const fakeFetch = async () => { const r = roteiro.length ? roteiro.shift() : []; return { ok: true, status: 200, json: async () => r, text: async () => JSON.stringify(r) }; };
require.cache[require.resolve('node-fetch')] = { id: 'node-fetch', filename: 'node-fetch', loaded: true, exports: fakeFetch };
process.env.ADMIN_KEY = 'chave-teste';

const linha = (extra) => Object.assign({ numero_pedido: '1001', numero_loja: 'X1', canal: 'ml', data_venda: '2026-10-05', sku: 'S1', descricao: 'p', quantidade: 1,
  valor_produto: 100, valor_nota: 100, custo: 20, comissao: null, frete_vendedor: null, imposto: 10, margem: null, uf: 'SP' }, extra);

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mg-'));
  let resp = null; const json = (res, st, o) => { resp = o; };
  const histCache = {};
  const h = require('../good-checkout-offline/historico-good').rotasHistorico({ validarSessao: () => null, supaCfg: () => ({ url: 'https://supa.test', key: 'k' }), histCache, CACHE_DIR: tmp, json });
  /* cada chamada com cache limpo: o roteiro do Supabase de mentira é posicional */
  const chama = async (rota, qs) => { resp = null; for (const k of Object.keys(histCache)) delete histCache[k]; await h({ method: 'GET', headers: {} }, {}, new URL('http://x/good-checkout-offline' + rota + '?k=chave-teste&' + qs)); return resp; };
  const tres = async (l) => {
    roteiro = [[l]]; const a = await chama('/historico-longo', 'de=2026-10-01&ate=2026-10-13');
    roteiro = [[{ numero_pedido: '1001' }], [l]]; const b = await chama('/historico-linhas', 'de=2026-10-01&ate=2026-10-13&pagina=1');
    roteiro = [[l], [l], [l], [l]]; const c = await chama('/buscar-lucro', 'q=1001');
    return { longo: a.totais, lista: b.pedidos[0], busca: c.pedidos[0] };
  };
  // despesa AUSENTE (null, campo faltando, texto inválido): nenhuma das três reconstrói 70
  for (const [nome, extra] of [['nulos', {}], ['sem os campos', { comissao: undefined, frete_vendedor: undefined }], ['comissão inválida', { comissao: 'abc', frete_vendedor: 0 }], ['só o frete nulo', { comissao: 12, frete_vendedor: null }]]) {
    const r = await tres(linha(extra));
    assert.strictEqual(r.longo.margens_reconstruidas, 0, nome + ': agregado reconstruiu com despesa ausente');
    assert.strictEqual(r.longo.margens_sem_parcela, 1, nome + ': agregado não contou a margem que ficou de fora');
    assert.notStrictEqual(r.longo.margem, 70, nome + ': agregado somou margem inflada');
    assert.notStrictEqual(r.lista.margem, 70, nome + ': lista mostrou margem inflada');
    assert.strictEqual(r.busca.mc, null, nome + ': busca mostrou margem inflada (' + r.busca.mc + ')');
    assert.strictEqual(r.busca.mc_incompleta, true);
  }
  // ZERO gravado é zero legítimo: as três reconstroem (100 − 10 − 0 − 0 − 20 = 70)
  let r = await tres(linha({ comissao: 0, frete_vendedor: 0 }));
  assert.strictEqual(r.longo.margem, 70); assert.strictEqual(r.longo.margens_reconstruidas, 1);
  assert.strictEqual(r.lista.margem, 70); assert.strictEqual(r.busca.mc, 70);
  // crédito de frete (negativo) é valor conhecido: 100 − 10 − 12 − (−5) − 20 = 63
  r = await tres(linha({ comissao: 12, frete_vendedor: -5 }));
  assert.strictEqual(r.longo.margem, 63); assert.strictEqual(r.lista.margem, 63); assert.strictEqual(r.busca.mc, 63);
  // imposto desconhecido (0 e sem alíquota cadastrada pro mês) também não reconstrói — agora na busca também
  r = await tres(linha({ comissao: 12, frete_vendedor: 3, imposto: 0, data_venda: '2031-01-05' }));
  assert.strictEqual(r.busca.mc, null, 'busca reconstruiu com imposto desconhecido');
  console.log('ok — despesa ausente não vira zero na margem (agregado, lista e busca); zero gravado e crédito seguem valendo');
})().catch(e => { console.error('FALHOU:', e.message); process.exit(1); });
