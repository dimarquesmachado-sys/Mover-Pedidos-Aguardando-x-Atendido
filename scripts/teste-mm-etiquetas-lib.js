'use strict';
/* 23/10 — o módulo das etiquetas do Madeira (mapa dos lotes, sync da Toolbox, download) virou PEÇA ÚNICA
   (lib/checkout/mm-etiquetas). Eram duas cópias de 341 linhas (GOOD e Girassol) e a rota de impressão da AMB carregava o
   módulo da GIRASSOL. Prova, com a peça de produção e um mapa em pasta temporária por empresa:
   · as pastas da GOOD e da Girassol são uma linha (a peça) e cada uma responde SÓ às rotas dela;
   · o sync da Toolbox grava no mapa DA empresa (o da outra não muda), com a chave DA empresa; só lote pronto entra;
   · acharLote acha pelo pedido do Madeira e pela NF; health conta o mapa da empresa;
   · a AMB não carrega o módulo de outra empresa. */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const raiz = path.join(__dirname, '..');

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mmlib-'));
  process.env.GOOD_MM_DATA = path.join(dir, 'good.json'); process.env.GIRASSOL_MM_DATA = path.join(dir, 'gir.json');
  process.env.GOOD_MM_SYNC_KEY = 'kg'; process.env.GIRASSOL_MM_SYNC_KEY = 'kr';
  delete process.env.GOOD_MM_TOKEN; delete process.env.GIRASSOL_MM_TOKEN;   /* sem token: o enriquecimento não sai pra rede */
  const good = require('../good-mm-etiquetas'), gir = require('../girassol-mm-etiquetas');
  for (const [arq, emp] of [['good-mm-etiquetas/index.js', 'good'], ['girassol-mm-etiquetas/index.js', 'girassol']]) {
    const s = fs.readFileSync(path.join(raiz, arq), 'utf8');
    assert.ok(new RegExp("require\\('\\.\\./lib/checkout/mm-etiquetas'\\)\\.criarMmEtiquetas\\('" + emp + "'\\)").test(s) && s.split('\n').length < 12, arq + ': não é a peça (sobrou cópia)');
  }
  assert.ok(good !== gir && good.id === 'good-mm-etiquetas' && gir.id === 'girassol-mm-etiquetas', 'as duas empresas têm que ter instâncias próprias');
  // rotas: cada uma só responde as dela
  const chama = async (mod, metodo, url, corpo, chave) => {
    const u = new URL('http://h' + url); const res = { _c: 0, _b: '', writeHead(c) { this._c = c; }, setHeader() {}, end(b) { this._b = String(b || ''); } };
    const req = { method: metodo, headers: chave ? { 'x-mm-key': chave } : {}, on(ev, fn) { if (ev === 'data' && corpo) fn(Buffer.from(JSON.stringify(corpo))); if (ev === 'end') fn(); return this; } };
    const t = await mod.routes()(req, res, u); let j = null; try { j = JSON.parse(res._b); } catch (e) {}
    return { t, c: res._c, j };
  };
  assert.strictEqual((await chama(good, 'GET', '/girassol-mm-etiquetas/health')).t, false, 'a GOOD respondeu rota da Girassol');
  assert.strictEqual((await chama(gir, 'GET', '/good-mm-etiquetas/health')).t, false, 'a Girassol respondeu rota da GOOD');
  // sync com a chave errada (a da outra empresa) recusa
  assert.strictEqual((await chama(good, 'POST', '/good-mm-etiquetas/sync', { lotes: [] }, 'kr')).c, 401, 'a chave da Girassol abriu o sync da GOOD');
  // sync da GOOD grava no mapa DA GOOD; só lote pronto entra
  const lotes = [{ batch: 304893, status: 2, order_id: 10051765, nf: '80809', objects: ['AP1'] }, { batch: 999, status: 1, order_id: 1 }];
  const r = await chama(good, 'POST', '/good-mm-etiquetas/sync', { lotes }, 'kg');
  assert.ok(r.c === 200 && r.j && r.j.ok && r.j.novos === 1, 'sync da GOOD: ' + JSON.stringify(r.j));
  assert.ok(fs.existsSync(process.env.GOOD_MM_DATA) && !fs.existsSync(process.env.GIRASSOL_MM_DATA), 'o sync da GOOD mexeu no mapa da Girassol');
  assert.ok(good.acharLote('10051765') && good.acharLote('80809') && good.acharLote('10051765').batch === '304893', 'acharLote pelo pedido/NF');
  assert.strictEqual(gir.acharLote('10051765'), null, 'a Girassol achou lote da GOOD');
  const h = await chama(good, 'GET', '/good-mm-etiquetas/health');
  assert.ok(h.j && h.j.modulo === 'good-mm-etiquetas' && h.j.pedidos_no_mapa === 1 && h.j.arquivo === process.env.GOOD_MM_DATA, 'health da GOOD: ' + JSON.stringify(h.j));
  // a AMB não carrega o módulo de outra empresa
  const amb = fs.readFileSync(path.join(raiz, 'amb-checkout-offline', 'index.js'), 'utf8');
  assert.ok(!/require\('\.\.\/girassol-mm-etiquetas'\)/.test(amb) && !/require\('\.\.\/good-mm-etiquetas'\)/.test(amb), 'a AMB ainda carrega o módulo do Madeira de outra empresa');
  fs.rmSync(dir, { recursive: true, force: true });
  console.log('ok — Madeira: módulo único por empresa (GOOD e Girassol, cada uma com o mapa, a chave e as rotas dela); a AMB não usa o de outra');
  process.exit(0);
})().catch(e => { console.error('FALHOU:', e.message); process.exit(1); });
