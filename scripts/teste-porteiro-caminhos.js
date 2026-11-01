'use strict';
/* 01/11 — PORTEIRO POR CAMINHO (auditoria do Codex no SHA 208fdb7d, achado F01). O porteiro de sessão de cada empresa
   pulava a sessão pra caminhos que CONTINHAM "/callback", "debug", "/run"…, contando com o porteiro central do servidor —
   que usava outra regra, mais estreita. /<empresa>/pedido/debugging/123, /pedido/callback/123 e /pedido/runner/123
   passavam pelos dois sem credencial nenhuma, e a rota do pedido devolvia o pedido 123 (pegava o ÚLTIMO pedaço do
   caminho). A correção: os dois porteiros usam a MESMA regra (lib/http/rotas-protegidas), callback só no FIM do caminho,
   e a rota do pedido aceita um único pedaço depois de /pedido/.
   Prova DE VERDADE, como a do Codex: sobe o servidor inteiro (as três empresas), com um pedido 123 de mentira no cache de
   cada uma, e pede os caminhos SEM credencial — nenhum pode devolver o pedido; com a chave de admin o pedido continua
   saindo; a regra única não tranca callback de verdade nem deixa rota de debug sem a chave. */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const raiz = process.env.TESTE_RAIZ || path.join(__dirname, '..');

const { ehRotaCentralAdmin, ehCallbackOAuth } = require(path.join(raiz, 'lib', 'http', 'rotas-protegidas'));
/* a regra, sozinha */
for (const p of ['/x/debug-cobertura', '/x/debug/1', '/x/debug', '/x/run', '/x/run/1', '/x/robo/1', '/x/forcar/1', '/x/setup-loja']) assert.ok(ehRotaCentralAdmin(p), 'tinha que ser rota central de admin: ' + p);
for (const p of ['/x/pedido/debugging/123', '/x/pedido/runner/123', '/x/pedido/123', '/x/painel']) assert.ok(!ehRotaCentralAdmin(p), 'não é rota central de admin (e o porteiro da empresa não pode pular a sessão): ' + p);
for (const p of ['/magalu/callback', '/tiktok/callback', '/auto-mensagens/oauth/callback']) assert.ok(ehCallbackOAuth(p), 'callback de verdade: ' + p);
for (const p of ['/x/pedido/callback/123', '/x/callback/1', '/x/callbacks']) assert.ok(!ehCallbackOAuth(p), 'não é callback: ' + p);

const get = (porta, p) => new Promise((ok) => {
  const r = http.get({ host: '127.0.0.1', port: porta, path: p, timeout: 15000 }, (res) => { let b = ''; res.on('data', (c) => { b += c; }); res.on('end', () => ok({ code: res.statusCode, body: b })); });
  r.on('error', (e) => ok({ code: 0, body: String(e.message) })); r.on('timeout', () => { r.destroy(); ok({ code: 0, body: 'timeout' }); });
});
(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'porteiro-'));
  const env = Object.assign({}, process.env, { ADMIN_KEY: 'adm-teste', PORT: String(39000 + Math.floor(Math.random() * 900)) });
  const EMP = [['girassol-backup-offline', 'GIRABKP_CACHE_DIR'], ['amb-checkout-offline', 'AMBBKP_CACHE_DIR'], ['good-checkout-offline', 'GOODBKP_CACHE_DIR']];
  for (const [, v] of EMP) { env[v] = path.join(tmp, v); fs.mkdirSync(path.join(env[v], '123'), { recursive: true }); fs.writeFileSync(path.join(env[v], '123', 'pedido.json'), JSON.stringify({ id: 123, numero: 123, cliente: 'CLIENTE SINTETICO', itens: [] })); }
  env.TIKTOK_CACHE_DIR = path.join(tmp, 'tiktok'); fs.mkdirSync(env.TIKTOK_CACHE_DIR, { recursive: true });
  const srv = spawn(process.execPath, [path.join(raiz, 'index.js')], { cwd: raiz, env, stdio: ['ignore', 'ignore', 'ignore'] });
  const porta = Number(env.PORT);
  try {
    let pronto = false;
    for (let i = 0; i < 80 && !pronto; i++) { await new Promise((r) => setTimeout(r, 500)); const r = await get(porta, '/'); pronto = r.code > 0; }
    assert.ok(pronto, 'o servidor não subiu');
    const vazou = [];
    for (const [pasta] of EMP) {
      for (const c of ['/pedido/123', '/pedido/callback/123', '/pedido/debugging/123', '/pedido/runner/123', '/pedido/DEBUG/123', '/pedido/x/callback']) {
        const r = await get(porta, '/' + pasta + c);
        if (r.code === 200 || /CLIENTE SINTETICO/.test(r.body)) vazou.push(pasta + c + ' → ' + r.code);
      }
      const k = await get(porta, '/' + pasta + '/pedido/123?k=adm-teste');
      assert.ok(k.code === 200 && /CLIENTE SINTETICO/.test(k.body), pasta + ': com a chave de admin o pedido tinha que continuar saindo (' + k.code + ')');
      const d = await get(porta, '/' + pasta + '/debug-cobertura');
      assert.ok(d.code !== 200, pasta + ': rota de debug sem a chave tinha que ser trancada pelo porteiro central (' + d.code + ')');
    }
    assert.deepStrictEqual(vazou, [], 'caminho sem credencial devolveu o pedido:\n  ' + vazou.join('\n  '));
    const cb = await get(porta, '/magalu/callback');
    assert.ok(cb.code !== 0 && !(cb.code === 404 && /"not found"/.test(cb.body) && /"path"/.test(cb.body)), 'o callback de verdade não pode ser trancado pelo porteiro central (' + cb.code + ')');
    console.log('ok — porteiro por caminho: nenhum caminho sem credencial devolve o pedido nas três empresas; com a chave sai; debug exige a chave; callback de verdade passa');
  } finally { srv.kill('SIGKILL'); }
  process.exit(0);
})().catch((e) => { console.error('FALHOU:', e.message); process.exit(1); });
