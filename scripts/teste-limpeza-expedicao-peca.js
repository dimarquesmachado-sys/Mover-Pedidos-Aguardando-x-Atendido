'use strict';
/* 25/10 — a poda do bucket da expedição virou PEÇA ÚNICA (lib/checkout/limpeza-expedicao): era limpeza.js (Girassol) e
   amb-limpeza.js (AMB), idênticos a menos do prefixo da rota. Prova de EQUIVALÊNCIA com o código de antes (fixture),
   contra um Storage de mentira local (o formato da API do Supabase): a poda (rotina da madrugada) e a rota (simular e
   apagar) fazem as MESMAS chamadas e respondem igual; sem admin, 404; cada empresa no prefixo dela. */
const assert = require('assert');
const fs = require('fs');
const http = require('http');
const path = require('path');
const raiz = path.join(__dirname, '..');

(async () => {
  const velhosArq = Array.from({ length: 5 }, (_, i) => ({ name: 'velho' + i + '.jpg', created_at: '2026-01-0' + (i + 1) + 'T00:00:00Z', metadata: { size: 1048576 } }));
  const novos = [{ name: 'novo.jpg', created_at: new Date().toISOString(), metadata: { size: 2048 } }];
  let log = [];
  const srv = http.createServer((req, res) => {
    let corpo = ''; req.on('data', (c) => { corpo += c; }); req.on('end', () => {
      log.push(req.method + ' ' + req.url + ' ' + corpo);
      res.setHeader('Content-Type', 'application/json');
      if (req.method === 'POST' && /\/storage\/v1\/object\/list\//.test(req.url)) {
        const b = JSON.parse(corpo || '{}'); const todos = velhosArq.concat(novos);
        return res.end(JSON.stringify(todos.slice(b.offset || 0, (b.offset || 0) + (b.limit || 100))));
      }
      if (req.method === 'DELETE') return res.end(JSON.stringify(JSON.parse(corpo || '{}').prefixes.map((n) => ({ name: n }))));
      res.statusCode = 404; res.end('{}');
    });
  });
  await new Promise((r) => srv.listen(0, r));
  process.env.EXPEDICAO_SUPABASE_URL = 'http://127.0.0.1:' + srv.address().port;
  process.env.EXPEDICAO_STORAGE_KEY = 'k-teste';
  process.env.ADMIN_KEY = 'adm-teste';
  const _st = global.setTimeout; global.setTimeout = (fn) => _st(fn, 0);   /* sem as pausas entre lotes */
  const _agora = Date.now; const FIXO = Date.now(); Date.now = () => FIXO;   /* o mesmo "agora" nas duas rodadas (o corte da poda) */

  const arqAntigo = path.join(raiz, 'amb-checkout-offline', '_limpeza_antiga_teste.js');
  fs.writeFileSync(arqAntigo, fs.readFileSync(path.join(__dirname, 'fixtures', 'limpeza-antes-da-peca.js'), 'utf8'));
  try {
    const velho = require(arqAntigo), novo = require(path.join(raiz, 'amb-checkout-offline', 'amb-limpeza.js'));
    const rodar = async (fn) => { log = []; const r = await fn(); return JSON.stringify({ r, log }); };
    // a poda da madrugada
    assert.strictEqual(await rodar(() => novo.podarExpedicao(45, 3)), await rodar(() => velho.podarExpedicao(45, 3)), 'a poda (madrugada) fez diferente');
    // a rota: sem admin, simular e apagar
    const chamar = async (mod, q) => {
      const h = mod.rotasLimpeza({ validarSessao: () => null });
      const res = { c: 0, b: '', writeHead(c) { this.c = c; }, setHeader() {}, end(x) { this.b = String(x || ''); } };
      const u = new URL('http://h/amb-checkout-offline/limpar-expedicao' + q);
      const tratou = await h({ method: 'GET', headers: {} }, res, u);
      return { tratou, c: res.c, b: res.b };
    };
    for (const q of ['', '?k=adm-teste&dias=3', '?k=adm-teste&dias=3&gravar=1']) {
      assert.strictEqual(await rodar(() => chamar(novo, q)), await rodar(() => chamar(velho, q)), 'a rota respondeu diferente (' + (q || 'sem chave') + ')');
    }
    const semChave = await chamar(novo, '');
    assert.ok(semChave.tratou && semChave.c === 404, 'a rota da limpeza respondeu sem admin');
    const apagou = JSON.parse((await chamar(novo, '?k=adm-teste&dias=30&gravar=1')).b);
    assert.ok(apagou && (apagou.apagados > 0 || apagou.ok), 'o caso de teste não apagou nada (a comparação não provaria nada): ' + JSON.stringify(apagou).slice(0, 200));
  } finally { try { fs.unlinkSync(arqAntigo); } catch (e) {} global.setTimeout = _st; Date.now = _agora; srv.close(); }

  // cada empresa no prefixo dela, pela peça
  for (const [arq, pref] of [['girassol-backup-offline/limpeza.js', '/girassol-backup-offline'], ['amb-checkout-offline/amb-limpeza.js', '/amb-checkout-offline']]) {
    const s = fs.readFileSync(path.join(raiz, arq), 'utf8');
    assert.ok(s.includes("criarLimpeza({ base: require('./base'), prefixo: '" + pref + "' })") && s.split('\n').length < 8, arq + ': não é a peça com o prefixo da empresa');
  }
  console.log('ok — limpeza da expedição em peça única: a poda e a rota fazem as mesmas chamadas ao Storage e respondem igual ao código de antes');
  process.exit(0);
})().catch((e) => { console.error('FALHOU:', e.message); process.exit(1); });
