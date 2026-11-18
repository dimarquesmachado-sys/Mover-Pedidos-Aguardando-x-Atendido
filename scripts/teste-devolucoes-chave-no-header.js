#!/usr/bin/env node
'use strict';
/* b43 — a chamada ao serviço de Devoluções (/api/magalu/reversas-por-pedido, rota /magalu/cruzar-cancelados) manda a
   DEVOLUCOES_KEY no HEADER x-admin-key e NUNCA na URL (`?k=` vaza em log/histórico/referer; o Devoluções vai parar de
   aceitar querystring — V-03 de lá). Exercita a rota de produção com fetch falso e um cache de cancelados temporário. */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'magalu-chave-'));
process.env.MAGALU_DATA_DIR = dir;
process.env.DEVOLUCOES_URL = 'http://devolucoes.teste';
process.env.DEVOLUCOES_KEY = 'segredo-da-devolucoes-que-nao-pode-ir-na-url';
process.env.ADMIN_KEY = process.env.ADMIN_KEY || 'chave-adm';
fs.writeFileSync(path.join(dir, 'cancelados-amb.json'), JSON.stringify({ pedidos: {
  A1: { code: 'PED-1', tem_nf: true, seller: 'ambtotal', classe: 'normal' },
  A2: { code: 'PED-2', tem_nf: true, seller: 'ambtotal', classe: 'normal' },
} }));

const chamadas = [];
global.fetch = async (url, opts) => {
  chamadas.push({ url: String(url), headers: (opts && opts.headers) || {} });
  if (/reversas-por-pedido/.test(String(url))) return { ok: true, status: 200, json: async () => ({ ok: true, reversas: {} }) };
  return { ok: true, status: 200, json: async () => ({}), text: async () => '' };
};

(async () => {
  const mo = require('../magalu-oauth');
  const saida = { codigo: 0, corpo: '' };
  const res = { setHeader() {}, writeHead(c) { saida.codigo = c; }, end(b) { saida.corpo = String(b || ''); } };
  const req = { method: 'GET', headers: { 'x-admin-key': process.env.ADMIN_KEY }, url: '/magalu/cruzar-cancelados?empresa=amb' };
  const urlObj = new URL('http://x' + req.url);
  await mo.tratar(req, res, urlObj);
  const rev = chamadas.filter((c) => /reversas-por-pedido/.test(c.url));
  assert.ok(rev.length >= 1, 'a rota de produção chamou o Devoluções (' + saida.codigo + ' ' + saida.corpo.slice(0, 160) + ')');
  for (const c of rev) {
    assert.ok(!/[?&]k=/.test(c.url), 'a chave FOI pra URL: ' + c.url);
    assert.ok(!c.url.includes(process.env.DEVOLUCOES_KEY), 'o segredo apareceu na URL');
    assert.strictEqual(c.headers['x-admin-key'], process.env.DEVOLUCOES_KEY, 'a chave nao foi no header x-admin-key');
    assert.ok(/codes=PED-1%2CPED-2/.test(c.url), 'os codes continuam na querystring: ' + c.url);
  }
  console.log('ok — cruzar-cancelados chama o Devoluções com a chave no header x-admin-key, nunca na URL (' + rev.length + ' chamada(s))');
  fs.rmSync(dir, { recursive: true, force: true });
  process.exit(0);
})().catch((e) => { console.error('FALHOU:', e && e.stack || e); process.exit(1); });
