'use strict';
/* 14/10 — parecer do Codex (6.2): página do Supabase que falhava virava "fim da lista" — HTTP de erro
   dava break, corpo ilegível virava [], e o período saía ok:true com zero (ou só as páginas que
   vieram), indo pro cache. Exercita o HANDLER DE PRODUÇÃO (lib/checkout/historico.js montado pelas
   fachadas das três empresas) com um Supabase de mentira. */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

let roteiro = [];   // respostas em ordem: número = HTTP, 'lixo' = corpo ilegível, array = linhas
const chamadas = [];
const fakeFetch = async (url) => {
  chamadas.push(url);
  const r = roteiro.length ? roteiro.shift() : [];
  if (typeof r === 'number') return { ok: r < 400, status: r, json: async () => ({ message: 'erro' }), text: async () => 'erro' };
  if (r === 'lixo') return { ok: true, status: 200, json: async () => { throw new SyntaxError('Unexpected token <'); }, text: async () => '<html>' };
  return { ok: true, status: 200, json: async () => r, text: async () => JSON.stringify(r) };
};
require.cache[require.resolve('node-fetch')] = { id: 'node-fetch', filename: 'node-fetch', loaded: true, exports: fakeFetch };
process.env.ADMIN_KEY = 'chave-teste';

const linha = (i) => ({ numero_pedido: String(1000 + i), numero_loja: 'X' + i, canal: 'ml', data_venda: '2026-10-05', sku: 'SKU' + (i % 7), descricao: 'p', quantidade: 1, valor_produto: 100, valor_nota: 100, custo: 20, comissao: 10, frete_vendedor: 5, imposto: 10, margem: 55, uf: 'SP' });

(async () => {
  for (const [pasta, arq] of [['good-checkout-offline', 'historico-good'], ['amb-checkout-offline', 'amb-historico'], ['girassol-backup-offline', 'historico']]) {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hist-'));
    const histCache = {};
    let resp = null;
    const json = (res, st, obj) => { resp = { st, obj }; };
    const h = require('../' + pasta + '/' + arq).rotasHistorico({ validarSessao: () => null, supaCfg: () => ({ url: 'https://supa.test', key: 'k' }), histCache, CACHE_DIR: tmp, json });
    const pref = '/' + pasta;
    const chama = async (rota, qs) => { resp = null; const u = new URL('http://x' + pref + rota + '?k=chave-teste&' + qs); await h({ method: 'GET', headers: {} }, {}, u); return resp; };
    const semCache = () => Object.keys(histCache).length === 0;

    // historico-longo: 1ª página 503 / ilegível / formato errado / 1000 linhas e depois 503
    for (const [nome, rot] of [['503 na 1ª', [503]], ['ilegível', ['lixo']], ['objeto em vez de lista', [{ x: 1 }]], ['1000 linhas e 503', [Array.from({ length: 1000 }, (_, i) => linha(i)), 503]]]) {
      roteiro = rot.slice(); for (const k of Object.keys(histCache)) delete histCache[k];
      const r = await chama('/historico-longo', 'de=2026-10-01&ate=2026-10-13');
      assert.ok(r, pasta + ' longo ' + nome + ': sem resposta');
      assert.strictEqual(r.obj.ok, false, pasta + ' longo ' + nome + ': falha virou ok:true (' + JSON.stringify(r.obj).slice(0, 120) + ')');
      assert.ok(/INCOMPLETA/.test(r.obj.erro), pasta + ' longo ' + nome + ': motivo não diz que a leitura ficou incompleta');
      assert.ok(semCache(), pasta + ' longo ' + nome + ': resultado incompleto foi pro cache');
    }
    // previsão de vendas
    roteiro = [503];
    let r = await chama('/previsao-vendas', 'base=90');
    assert.strictEqual(r.obj.ok, false, pasta + ' previsão: 503 virou ok'); assert.ok(semCache(), pasta + ' previsão: cacheou falha');
    // historico-linhas: índice e busca
    roteiro = [503];
    r = await chama('/historico-linhas', 'de=2026-10-01&ate=2026-10-13&pagina=1');
    assert.strictEqual(r.obj.ok, false, pasta + ' linhas: índice 503 virou ok'); assert.ok(semCache(), pasta + ' linhas: índice parcial cacheado');
    roteiro = [[linha(1)], 503];
    r = await chama('/historico-linhas', 'de=2026-10-01&ate=2026-10-13&pagina=1&q=SKU1');
    assert.strictEqual(r.obj.ok, false, pasta + ' linhas: busca com classe falhando virou ok'); assert.ok(semCache(), pasta + ' linhas: busca parcial cacheada');
    roteiro = [[linha(1)], 'lixo'];   // índice ok (1 pedido), página da lista ilegível
    r = await chama('/historico-linhas', 'de=2026-10-01&ate=2026-10-13&pagina=1');
    assert.strictEqual(r.obj.ok, false, pasta + ' linhas: página ilegível virou lista vazia ok');
    // buscar-lucro: corpo ilegível não é "nada encontrado"
    roteiro = ['lixo', 'lixo', 'lixo'];
    r = await chama('/buscar-lucro', 'q=12345');
    assert.strictEqual(r.obj.ok, false, pasta + ' buscar-lucro: corpo ilegível virou "nada"');
    // controle positivo: leitura completa responde ok e é cacheada
    roteiro = [[linha(1), linha(2)]];
    for (const k of Object.keys(histCache)) delete histCache[k];
    r = await chama('/historico-longo', 'de=2026-10-01&ate=2026-10-13');
    assert.strictEqual(r.obj.ok, true, pasta + ' longo completo: ' + JSON.stringify(r.obj).slice(0, 200));
    assert.strictEqual(r.obj.totais.pedidos, 2, pasta + ' longo completo: contou errado');
  }
  console.log('ok — página que falha (HTTP, ilegível, formato, no meio) vira ok:false sem cache nas três empresas; leitura completa segue ok');
})().catch(e => { console.error('FALHOU:', e.message); process.exit(1); });
