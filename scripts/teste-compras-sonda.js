'use strict';
/* 24/11 — COMPRAS: A SONDA DO PEDIDO DE COMPRA NO BLING. Antes de ler o "a caminho" e de lançar o pedido do fornecedor,
   saber se o app de cada empresa no Bling tem a permissão de Pedidos de Compra.

   O que se prova (o código de produção):
   A. a peça (lib/checkout/compras-bling-sonda): cada resposta do Bling vira 'sim', 'nao' (só a recusa 403) ou 'nao_sei'
      (token, limite, rede, erro, resposta torta) — "não sei" nunca vira "não tem"; pergunta uma página de um registro;
      nunca devolve dado de pedido nem de fornecedor;
   B. a ROTA /compras-sonda, na fábrica de verdade, nas três empresas: só admin (senão 404, sem chamar o Bling); a
      resposta é o veredito da empresa certa e nada mais. */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { sondarCompras, CAMINHO, PRAZO_MS } = require('../lib/checkout/compras-bling-sonda');
const { criarRotasPainel } = require('../lib/checkout/fabrica-rotas-painel');

process.exitCode = 1;
let terminou = false;
process.on('exit', () => { if (!terminou) { console.log('FALHOU: o teste não chegou ao fim (promessa presa)'); process.exitCode = 1; } });

(async () => {
  /* ═══ A. a peça ═══ */
  const caminhos = [], args = [];
  const com = (r) => sondarCompras(async (c, n, sinal) => { caminhos.push(c); args.push([n, sinal]); if (r instanceof Error) throw r; return r; });
  const PEDIDO = { id: 9, numero: 7, fornecedor: { id: 3, nome: 'Fornecedor Exemplo' }, total: 1234 };
  const cas = [
    [{ ok: true, status: 200, data: { data: [PEDIDO] } }, 'sim', 200, null],
    [{ ok: true, status: 200, data: { data: [] } }, 'sim', 200, null],
    [{ ok: false, status: 403, data: { error: { type: 'FORBIDDEN', message: 'texto livre que não sai', description: 'x' } } }, 'nao', 403, 'FORBIDDEN'],
    [{ ok: false, status: 403, data: { error: { type: 'tipo com espaço e <tag>' } } }, 'nao', 403, null],
    [{ ok: false, status: 403, data: null }, 'nao', 403, null],
    [{ ok: false, status: 401, data: { error: { type: 'invalid_token' } }, erro: 'token: x' }, 'nao_sei', 401, 'invalid_token'],
    [{ ok: false, status: 429, data: null, limite: true, rede: false }, 'nao_sei', 429, null],
    [{ ok: false, status: 429, data: null, limite: false, rede: true }, 'nao_sei', 429, null],
    [{ ok: false, status: 500, data: { error: { type: 'SERVER' } } }, 'nao_sei', 500, 'SERVER'],
    [{ ok: false, status: 404, data: null }, 'nao_sei', 404, null],
    [{ ok: true, status: 200, data: { data: { id: 1 } } }, 'nao_sei', 200, null],
    [{ ok: true, status: 200, data: null }, 'nao_sei', 200, null],
    [{ ok: true, status: 201, data: { data: [] } }, 'nao_sei', 201, null],
    [{ ok: false, status: 0, data: null, erro: 'abortado' }, 'nao_sei', 0, null],
    [null, 'nao_sei', null, null],
    ['texto', 'nao_sei', null, null],
    [new Error('caiu'), 'nao_sei', null, null],
  ];
  for (const [r, perm, st, tipo] of cas) {
    const v = await com(r);
    assert.deepStrictEqual([v.permissao, v.status, v.tipo_erro], [perm, st, tipo], JSON.stringify(r) + ' → ' + JSON.stringify(v));
    assert.deepStrictEqual(Object.keys(v).sort(), ['motivo', 'permissao', 'status', 'tipo_erro'], 'só o veredito sai');
    assert.ok(typeof v.motivo === 'string' && v.motivo.length > 5 && !/Fornecedor Exemplo|texto livre|1234/.test(JSON.stringify(v)), 'nada do pedido, do fornecedor ou do texto do Bling: ' + JSON.stringify(v));
  }
  assert.ok(/permissão de Pedidos de Compra/.test((await com({ ok: false, status: 403 })).motivo), 'o "não" diz o que fazer');
  assert.ok(/limite/.test((await com({ ok: false, status: 429, limite: true, rede: true })).motivo) && /rede/.test((await com({ ok: false, status: 429, limite: false, rede: true })).motivo), '429 de limite × de rede');
  assert.ok(caminhos.every((c) => c === '/pedidos/compras?pagina=1&limite=1') && CAMINHO === caminhos[0], 'uma página, um registro: ' + caminhos[0]);
  assert.ok(args.every(([n, sinal]) => n === 1 && sinal && typeof sinal.aborted === 'boolean' && sinal.aborted === false), 'uma tentativa, com o sinal de cancelar (e não cancelado quando o Bling respondeu)');
  /* Codex #974: o Bling que não termina a resposta — a sonda volta no prazo, com 'nao_sei', e CANCELA a requisição */
  {
    let sinal = null; const t0 = Date.now();
    const v = await sondarCompras((c, n, s) => { sinal = s; return new Promise(() => {}); }, { prazoMs: 60 });
    assert.deepStrictEqual([v.permissao, v.status, v.tipo_erro, /não respondeu em 0 s/.test(v.motivo), sinal.aborted], ['nao_sei', null, null, true, true], JSON.stringify(v));
    assert.ok(Date.now() - t0 < 2000, 'voltou no prazo');
    /* o blingGet de produção, cancelado, devolve status 0 'abortado' — também 'nao_sei' */
    const v2 = await sondarCompras((c, n, s) => new Promise((ok) => { s.addEventListener('abort', () => ok({ ok: false, status: 0, data: null, erro: 'abortado' })); }), { prazoMs: 30 });
    assert.strictEqual(v2.permissao, 'nao_sei');
    /* blingGet que lança na hora (não-async) também não derruba */
    assert.strictEqual((await sondarCompras(() => { throw new Error('x'); })).permissao, 'nao_sei');
    assert.strictEqual(PRAZO_MS, 15000, 'o prazo de produção');
  }
  assert.deepStrictEqual(await sondarCompras(undefined), { permissao: 'nao_sei', status: null, tipo_erro: null, motivo: 'sem acesso ao Bling nesta empresa' });

  /* ═══ B. a rota, na fábrica de verdade ═══ */
  process.env.ADMIN_KEY = 'k';
  for (const [empresa, prefixo] of [['girassol', '/girassol-backup-offline'], ['amb', '/amb-checkout-offline'], ['good', '/good-checkout-offline']]) {
    let resp = null, admin = true, chave = 'k';
    const bling = [];
    let resposta = { ok: true, status: 200, data: { data: [PEDIDO] } };
    const pecas = { json: (res, code, body) => { resp = { code, body }; }, lerChaveAdmin: () => chave, validarSessao: () => (admin ? { usuario: 'diego' } : null), readJson: (a, pad) => pad, writeJson: () => {},
      CACHE_DIR: '/tmp/_compras_sonda_' + empresa, fsx: fs, pathx: path, ehAdmin: () => admin, readBody: async () => ({}), estadoRotinas: { custo: {}, vendas: {} }, travaPesada: { quemEsta: () => null }, _urlStatus: () => '', _inferCanal: () => 'outro',
      LOJA_MKT: {}, CONFERIDOS_FILE: '/tmp/_c.json', primeiraImagem: () => null, supaCfg: () => null, blingGet: async (c) => { bling.push(empresa + ' ' + c); return resposta; } };
    const rot = criarRotasPainel({ empresa, prefixo, nomeEmpresa: empresa.toUpperCase(), pecas });
    const pedir = async (metodo) => { resp = null; bling.length = 0; const u = new URL('http://h' + prefixo + '/compras-sonda'); const t = await rot({ method: metodo || 'GET', headers: {} }, {}, prefixo + '/compras-sonda', metodo || 'GET', u); return [t, resp]; };
    let [t, r] = await pedir();
    assert.deepStrictEqual([t, r.code, r.body, bling], [true, 200, { ok: true, empresa, permissao: 'sim', status: 200, tipo_erro: null, motivo: 'o Bling respondeu a lista de pedidos de compra' }, [empresa + ' /pedidos/compras?pagina=1&limite=1']], empresa + ': ' + JSON.stringify(r));
    resposta = { ok: false, status: 403, data: { error: { type: 'FORBIDDEN' } } };
    [t, r] = await pedir();
    assert.deepStrictEqual([r.body.empresa, r.body.permissao, r.body.tipo_erro], [empresa, 'nao', 'FORBIDDEN']);
    /* sem chave e sem sessão de admin: 404, e o Bling nem é chamado */
    chave = 'errada'; admin = false;
    [t, r] = await pedir();
    assert.deepStrictEqual([t, r.code, r.body, bling.length], [true, 404, { error: 'not found' }, 0], empresa + ': quem não é admin não vê a sonda');
    /* a sessão de admin basta */
    chave = null; admin = true; resposta = { ok: false, status: 429, limite: true };
    [t, r] = await pedir();
    assert.deepStrictEqual([r.code, r.body.permissao], [200, 'nao_sei']);
    /* outro método não é a sonda */
    [t, r] = await pedir('POST');
    assert.ok(!(r && r.body && r.body.permissao) && bling.length === 0, empresa + ': POST não sonda');
  }
  delete process.env.ADMIN_KEY;
  terminou = true; process.exitCode = 0;
  console.log('ok — Compras, a sonda do Pedido de Compra no Bling: 200 com lista = tem permissão; 403 = falta marcar a permissão; token, limite, rede, erro ou resposta torta = não sei (nunca "não tem"); uma página de um registro; só o veredito sai (nada de pedido nem de fornecedor); a rota é só de admin, nas três empresas');
})().catch((e) => { console.log('FALHOU: ' + (e && e.stack || e)); terminou = true; process.exitCode = 1; });
