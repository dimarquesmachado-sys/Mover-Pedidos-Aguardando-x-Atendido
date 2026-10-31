'use strict';
/* 31/10 — passo 3 do DIAGNÓSTICO em peça única: a AMB e a GOOD deixam de ter as CÓPIAS das rotas de raio-X que a peça já
   serve (16 rotas: /backup, /restaurar, /debug-*, /debug/…) — elas tinham as cópias no index.js (~480 linhas cada). Antes de
   tirar, cada cópia foi comparada com a peça: 13 iguais; /debug-ml da peça é a da Girassol, mais completa (a das duas
   cabia dentro dela); /backup e /restaurar da AMB/GOOD tinham os RESGATES PARADOS (Codex #651), que a peça não tinha — e
   a peça tinha a CONTAGEM DE ESTOQUE, que as cópias delas não tinham. Nivelado por cima: a peça ganhou os resgates (as
   três têm o arquivo) e a AMB/GOOD ganham a contagem no backup. Prova:
   · nenhuma das 16 rotas tem mais cópia no index da AMB e da GOOD (a peça, chamada por último, responde);
   · o /backup da peça, de verdade (pasta de mentira), traz os resgates parados E a contagem; o /restaurar (POST) devolve os
     dois pro disco — nas três empresas. */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const raiz = path.join(__dirname, '..');
/* a pasta de cache de cada empresa vai pra uma pasta TEMPORÁRIA antes de carregar os bases — o padrão (/data/cache-offline/…)
   não é gravável no GitHub (o teste caiu lá no #779) e não se escreve em pasta de produção num teste */
for (const v of ['GIRABKP_CACHE_DIR', 'AMBBKP_CACHE_DIR', 'GOODBKP_CACHE_DIR']) process.env[v] = fs.mkdtempSync(path.join(os.tmpdir(), v.toLowerCase() + '-'));
const ROTAS = ['/backup', '/debug-cobertura', '/debug-danfe/', '/debug-estrutura/', '/debug-etiqueta-fmt/', '/debug-loc/', '/debug-ml', '/debug-mover/', '/debug-nf', '/debug-nf-simp/', '/debug-nfped/', '/debug-pedido', '/debug-produto', '/debug-sku', '/debug/', '/restaurar'];
for (const [nome, arq, pref] of [['AMB', 'amb-checkout-offline/index.js', '/amb-checkout-offline'], ['GOOD', 'good-checkout-offline/index.js', '/good-checkout-offline']]) {
  const s = fs.readFileSync(path.join(raiz, arq), 'utf8');
  for (const r of ROTAS) {
    const re = new RegExp("\\bp(?: ===|\\.startsWith\\() ?'" + (pref + r).replace(/[/.*+?^${}()|[\]\\-]/g, '\\$&') + "'");
    assert.ok(!re.test(s), nome + ': sobrou a cópia de ' + r + ' no index (a peça é quem responde agora)');
  }
}
(async () => {
  for (const [nome, pasta, arq] of [['Girassol', 'girassol-backup-offline', 'diagnostico.js'], ['AMB', 'amb-checkout-offline', 'amb-diagnostico.js'], ['GOOD', 'good-checkout-offline', 'good-diagnostico.js']]) {
    const base = require(path.join(raiz, pasta, 'base.js'));
    const dir = path.dirname(base.RESGATES_FILE);
    fs.mkdirSync(dir, { recursive: true });
    const guardar = (f) => (fs.existsSync(f) ? fs.readFileSync(f) : null);
    const CONT = path.join(base.CACHE_DIR, '_contagem-estoque.json');
    const salvos = [[base.RESGATES_FILE, guardar(base.RESGATES_FILE)], [CONT, guardar(CONT)]];
    try {
      fs.writeFileSync(base.RESGATES_FILE, JSON.stringify({ _resgate_1: { degrau: 'x' } }));
      fs.writeFileSync(CONT, JSON.stringify({ lancamentos: [{ sku: 'A', qtd: 2 }] }));
      const mod = require(path.join(raiz, pasta, arq));
      const h = mod.rotasDiagnostico({ VERSAO: 'x', validarSessao: () => 'diego', supaCfg: () => ({ url: 'http://s', key: 'k' }), readBody: async (req) => req._body });
      process.env.ADMIN_KEY = 'adm';
      const res = { _c: 0, _b: '', writeHead(c) { this._c = c; }, setHeader() {}, end(b) { this._b += String(b || ''); } };
      const u = new URL('http://x/' + pasta + '/backup?k=adm&op=diego');
      const req = { method: 'GET', url: u.pathname + u.search, headers: { cookie: 's=1' }, _op: 'diego' };
      await h(req, res, u);
      let dump = null; try { dump = JSON.parse(res._b); } catch (e) {}
      assert.ok(dump && dump.resgates_parados && dump.resgates_parados._resgate_1 && dump.contagem_estoque && dump.contagem_estoque.lancamentos.length === 1,
        nome + ': o backup não traz os resgates parados E a contagem: ' + String(res._b).slice(0, 200));
      fs.writeFileSync(base.RESGATES_FILE, '{}'); fs.writeFileSync(CONT, JSON.stringify({ lancamentos: [] }));
      const res2 = { _c: 0, _b: '', writeHead(c) { this._c = c; }, setHeader() {}, end(b) { this._b += String(b || ''); } };
      const u2 = new URL('http://x/' + pasta + '/restaurar?k=adm&op=diego');
      await h({ method: 'POST', url: u2.pathname + u2.search, headers: { cookie: 's=1' }, _op: 'diego', _body: Object.assign({ op: 'diego' }, dump) }, res2, u2);
      assert.ok(JSON.parse(fs.readFileSync(base.RESGATES_FILE, 'utf8'))._resgate_1 && JSON.parse(fs.readFileSync(CONT, 'utf8')).lancamentos.length === 1,
        nome + ': o restaurar não devolveu os resgates parados e a contagem: ' + String(res2._b).slice(0, 200));
    } finally {
      for (const [f, conteudo] of salvos) { if (conteudo === null) { try { fs.unlinkSync(f); } catch (e) {} } else fs.writeFileSync(f, conteudo); }
    }
  }
  /* Codex #779: o /debug-ml SEM ?id= lista as vendas ML recentes (a AMB e a GOOD usavam pra achar um pedido pra testar
     etiqueta) — antes o raio-X por pedido respondia 'passe ?id' e a listagem nunca rodava; e a listagem usa a loja do ML
     DA EMPRESA (era fixa na da Girassol, inclusive nas cópias das duas). A peça, com um base de mentira por empresa. */
  const { criarDiagnostico } = require('../lib/checkout/diagnostico-empresa');
  for (const [emp, pref, loja] of [['amb', '/amb-checkout-offline', '206017293'], ['good', '/good-checkout-offline', '203296034'], ['girassol', '/girassol-backup-offline', '203146903']]) {
    const chamadas = [], respostas = [];
    const fake = { LOJA_MKT: { [loja]: 'ml', '999': 'shopee' }, CACHE_DIR: '/tmp', ehAdmin: () => true, readJson: (f, d) => d, writeJson: () => {},
      json: (res, code, o) => respostas.push({ code, o }), blingGet: async (p) => { chamadas.push(p); return { data: { data: [{ id: 1, numero: 10, situacao: { id: 6 }, data: '2026-10-30' }] } }; } };
    const base = new Proxy(fake, { get: (t, k) => (k in t ? t[k] : () => undefined) });
    const d = criarDiagnostico({ prefixo: pref, empresa: emp, base, nf: {}, comum: {}, produtos: {}, ciclo: {}, danfeSimplificado: {}, mlTokenManager: () => ({ garantirTokenML: async () => null }) });
    const h = d.rotasDiagnostico({ VERSAO: 'x', validarSessao: () => 'diego', supaCfg: () => ({}), readBody: async () => ({}) });
    process.env.ADMIN_KEY = 'adm';
    const u = new URL('http://x' + pref + '/debug-ml?k=adm&op=diego');
    await h({ method: 'GET', url: u.pathname + u.search, headers: { cookie: 's=1' }, _op: 'diego' }, {}, u);
    const r = respostas[respostas.length - 1];
    assert.ok(r && r.code === 200 && r.o && r.o.total === 1 && Array.isArray(r.o.pedidos), emp + ': /debug-ml sem id não listou as vendas ML: ' + JSON.stringify(r).slice(0, 160));
    assert.ok(chamadas.length === 1 && chamadas[0].includes('idLoja=' + loja) && !(emp !== 'girassol' && chamadas[0].includes('203146903')), emp + ': a listagem não usou a loja do ML da empresa: ' + chamadas[0]);
  }
  console.log('ok — diagnóstico sem cópias na AMB e na GOOD; backup e restaurar com os resgates parados e a contagem nas três; /debug-ml sem id lista as vendas ML da loja de cada empresa');
  process.exit(0);
})().catch((e) => { console.error('FALHOU:', e.message); process.exit(1); });
