'use strict';
/* 18/11 — NORTE C, montarCheckout, passo 24: A LISTA DAS ROTAS EM QUE A FÁBRICA CEDE A VEZ É DA FÁBRICA, NÃO DE CADA ARQUIVO.

   Cada arquivo de entrada escrevia à mão, na montagem da fábrica do painel, `rotasProprias: [...]` — as rotas que "são da
   empresa", pra fábrica não responder no lugar. Só que essas rotas já não são de nenhum arquivo: quem as atende, nas três,
   são PEÇAS da fila que vêm antes da fábrica (o canário da empresa e as rotas comuns). A lista era a mesma nas três (a AMB
   tinha `reaplicar-status` a mais — que as rotas comuns também atendem nas três). Agora ela é uma constante da fábrica
   (`ROTAS_DAS_PECAS`) e os três arquivos não a escrevem; `rotasProprias` segue valendo pra quem tiver rota só sua.

   O QUE SE PROVA:
   A. RODANDO pelo `routes` real das três, sondando cada passo da fila sozinho com cada rota da lista (GET e POST): quem
      responde é uma PEÇA (canário da empresa ou rotas comuns) e a fábrica cede a vez — nas três, inclusive
      `reaplicar-status` na Girassol e na GOOD, que não a declaravam;
   B. a fábrica: cede nas rotas da lista sem ninguém pedir; `rotasProprias` da empresa SOMA à lista (rota que a fábrica
      atende passa a ser cedida); e fora dela a fábrica segue respondendo;
   C. os três arquivos não escrevem mais a lista. */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const raiz = path.join(__dirname, '..');
for (const m of ['http', 'https']) { const mod = require(m); for (const f of ['request', 'get']) mod[f] = () => { throw new Error('rede bloqueada no teste'); }; }
const nf = require.resolve('node-fetch'); require.cache[nf] = { id: nf, filename: nf, loaded: true, exports: async () => { throw new Error('rede bloqueada no teste'); } };
global.fetch = async () => { throw new Error('rede bloqueada no teste'); };
process.env.ADMIN_KEY = 'chave-pecas';
const PASTAS = fs.mkdtempSync(path.join(os.tmpdir(), 'rotas-pecas-'));
for (const [tag, e] of [['GIRABKP', 'girassol'], ['AMBBKP', 'amb'], ['GOODBKP', 'good']]) { process.env[tag + '_CACHE_DIR'] = path.join(PASTAS, e); process.env[tag + '_ADMIN'] = 'dono-teste'; }
process.on('exit', () => { try { fs.rmSync(PASTAS, { recursive: true, force: true }); } catch (e) {} });

const F = require('../lib/checkout/fabrica-rotas-painel');
const CE = require('../lib/checkout/config-empresa');
const EMP = [['girassol', 'girassol-backup-offline/gbo-app.js'], ['amb', 'amb-checkout-offline/index.js'], ['good', 'good-checkout-offline/index.js']];
const resFalso = () => ({ _s: 0, _b: '', writeHead(s) { this._s = s; }, setHeader() {}, end(b) { this._b = String(b || ''); } });

(async () => {
  assert.deepStrictEqual(F.ROTAS_DAS_PECAS.slice(), ['canario-marketplaces', 'custo-historico', 'custo-sync', 'magalu-cancelados', 'reaplicar-status', 'tiktok-custo-devolucoes'], 'a lista das rotas que as peças atendem mudou');
  assert.ok(Object.isFrozen(F.ROTAS_DAS_PECAS), 'a lista é constante');

  const _l = console.log, _w = console.warn, _e = console.error; console.log = () => {}; console.warn = () => {}; console.error = () => {};
  try {
    /* ═══ A. pelo routes real das três ═══ */
    for (const [emp, arq] of EMP) {
      const pref = CE.prefixoDe(emp);
      const h = require(path.join(raiz, arq)).routes(async () => ({}));
      const painel = h.passos.find((x) => x.nome === 'painel'); assert.ok(painel, emp + ': cadê a fábrica na fila?');
      assert.strictEqual(h.passos[h.passos.length - 1].nome, 'painel', emp + ': a fábrica é a última da fila');
      for (const rota of F.ROTAS_DAS_PECAS) {
        let alguem = false;
        for (const method of ['GET', 'POST']) {
          const donos = [];
          for (const passo of h.passos) {
            const u = new URL('http://x' + pref + '/' + rota + '?k=chave-pecas&status=1');
            let t = false;
            try { t = await Promise.race([passo.fn({ method, url: u.pathname + u.search, headers: {} }, resFalso(), u, method, u.pathname), new Promise((r) => setTimeout(() => r('demorou'), 1500))]); } catch (e) { t = true; }   /* quem estoura lendo o corpo de mentira tinha pegado a rota */
            if (t === true) donos.push(passo.nome);
          }
          assert.ok(!donos.includes('painel'), emp + ': ' + method + ' /' + rota + ' — a fábrica respondeu numa rota que é das peças (' + donos.join(', ') + ')');
          for (const d of donos) assert.ok(d === 'comuns' || d === 'canEmp', emp + ': ' + method + ' /' + rota + ' — quem responde não é a peça esperada: ' + d);
          if (donos.length) alguem = true;
        }
        assert.ok(alguem, emp + ': /' + rota + ' está na lista das peças e NENHUMA peça responde (a fábrica cederia a vez pra ninguém)');
      }
    }

    /* ═══ B. a fábrica ═══ */
    {
      const [emp, arq] = EMP[0], pref = CE.prefixoDe(emp);
      const base = { empresa: emp, pecas: { json: (res, st, o) => { res.writeHead(st); res.end(JSON.stringify(o)); }, validarSessao: () => null, lerChaveAdmin: (req, u) => u.searchParams.get('k') || '', ehAdmin: () => false,
        readJson: () => ({}), writeJson: () => {}, CACHE_DIR: path.join(PASTAS, 'fab'), fsx: fs, pathx: path, readBody: async () => ({}), estadoRotinas: { custo: {}, vendas: {} },
        /* 18/11 (passo 25): SEM `custoSyncTravado` — era obrigatória só por causa do /custo-sync, que saiu da fábrica */
        travaPesada: { quemEsta: () => null }, _urlStatus: () => '', LOJA_MKT: {}, CONFERIDOS_FILE: path.join(PASTAS, 'fab', '_conferidos.json') } };
      const pedir = async (fab, rota) => { const u = new URL('http://x' + pref + rota + '?k=chave-pecas'); const res = resFalso(); const t = await fab({ method: 'GET', url: u.pathname + u.search, headers: {} }, res, u.pathname, 'GET', u); return [t, res._s]; };
      const fab = F.criarRotasPainel(base);
      assert.deepStrictEqual(await pedir(fab, '/custos-manuais'), [true, 200], 'o teste supõe que a fábrica serve a tela de custo manual');
      for (const rota of F.ROTAS_DAS_PECAS) assert.deepStrictEqual(await pedir(fab, '/' + rota), [false, 0], 'a fábrica não cedeu a vez em /' + rota + ' (sem a empresa declarar nada)');
      const fab2 = F.criarRotasPainel(Object.assign({}, base, { rotasProprias: ['custos-manuais'] }));
      assert.deepStrictEqual(await pedir(fab2, '/custos-manuais'), [false, 0], '`rotasProprias` da empresa deixou de valer');
      assert.deepStrictEqual(await pedir(fab2, '/custo-sync'), [false, 0], '`rotasProprias` da empresa SOMA à lista das peças, não substitui');
    }
  } finally { console.log = _l; console.warn = _w; console.error = _e; }

  /* ═══ C. os três arquivos ═══ */
  for (const [emp, arq] of EMP) {
    const s = fs.readFileSync(path.join(raiz, arq), 'utf8');
    assert.ok(s.includes("require('../lib/checkout/fabrica-rotas-painel').criarRotasPainel({"), arq + ': não monta a fábrica do painel');
    assert.ok(!/\brotasProprias\s*:/.test(s), arq + ': voltou a escrever a lista das rotas próprias à mão (' + emp + ')');
  }
  console.log('ok — as rotas em que a fábrica cede a vez são uma lista da fábrica (as que o canário da empresa e as rotas comuns atendem, nas três); os arquivos não a escrevem; `rotasProprias` segue somando');
  process.exit(0);
})().catch((e) => { console.error('FALHOU:', e && (e.stack || e.message)); process.exit(1); });
