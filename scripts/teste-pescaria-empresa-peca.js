'use strict';
/* 27/10 — a PESCARIA RETROATIVA DE TARIFAS DO ML (e a auditoria do ML no histórico) virou PEÇA ÚNICA
   (lib/checkout/pescaria-empresa): era pescaria.js (Girassol) e amb-pescaria.js (AMB) — idênticos a menos do nome; a GOOD
   não tinha. Prova, com o Supabase, o ML e o token de mentira:
   · a Girassol faz EXATAMENTE o que fazia (fixture): status, um pedido simulado e gravado, com as mesmas chamadas;
   · cada empresa com a chave DELA no Supabase e no histórico (empresa=eq.<dela>) e o token do ML DELA;
   · o estado da rodada é de cada empresa (uma rodada da Girassol não aparece no status da GOOD);
   · a GOOD monta as rotas. */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const raiz = path.join(__dirname, '..');

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pes-'));
  const readJson = (a, d) => { try { return JSON.parse(fs.readFileSync(a, 'utf8')); } catch (e) { return d; } };
  const base = { json: (res, c, b) => { res.c = c; res.b = b; }, ehAdmin: () => false, readJson, CACHE_DIR: dir };
  let log = [];
  const linhas = [{ id: 11, numero_pedido: '777', numero_loja: '2000099', canal: 'ml', data_venda: '2026-10-20', valor_produto: 100, custo: 40, imposto: 8, frete_vendedor: 12, comissao: 0 }];
  const fakeFetch = async (url, opt) => {
    log.push(((opt && opt.method) || 'GET') + ' ' + String(url).replace(/^https?:\/\/[^/]+/, ''));
    const r = (st, b) => ({ status: st, ok: st >= 200 && st < 300, json: async () => b, text: async () => JSON.stringify(b) });
    if (/vendas_historico\?/.test(url)) return r(200, linhas);
    return r(404, {});
  };
  const supaCfg = (e) => { log.push('cfg ' + e); return { url: 'https://supa.teste', key: 'k' }; };
  const supaReq = async (e, m, pq, b) => { log.push('req ' + e + ' ' + m + ' ' + pq + ' ' + JSON.stringify(b)); return { ok: true, status: 204, data: [] }; };
  const pescarDadosML = async (nl) => { log.push('pescar ' + nl); return { fee: 13.5, frete: 0 }; };
  const tok = { garantirTokenML: async () => 'tok' };
  process.env.ADMIN_KEY = 'adm-pes';
  const chamar = async (mod, pref, q) => {
    const res = { c: 0, b: null };
    const t = await mod.rotasPescaria({ validarSessao: () => null, supaCfg, supaReq, pescarDadosML })({ method: 'GET', headers: {} }, res, new URL('http://h' + pref + q));
    return { t, c: res.c, b: res.b };
  };
  // a Girassol de ANTES (fixture na pasta dela, com base, token e fetch de mentira)
  const pasta = path.join(raiz, 'girassol-backup-offline');
  const rb = require.resolve(path.join(pasta, 'base.js')), rt = require.resolve(path.join(raiz, 'girassol', 'mlTokenManager.js')), rf = require.resolve('node-fetch');
  const salvo = { [rb]: require.cache[rb], [rt]: require.cache[rt], [rf]: require.cache[rf] };
  require.cache[rb] = { id: rb, filename: rb, loaded: true, exports: base };
  require.cache[rt] = { id: rt, filename: rt, loaded: true, exports: tok };
  require.cache[rf] = { id: rf, filename: rf, loaded: true, exports: fakeFetch };
  const arq = path.join(pasta, '_pescaria_antiga_teste.js');
  fs.writeFileSync(arq, fs.readFileSync(path.join(__dirname, 'fixtures', 'pescaria-girassol-antes.js'), 'utf8'));
  let velho; try { velho = require(arq); } finally { try { fs.unlinkSync(arq); } catch (e) {} }
  const { criarPescaria } = require('../lib/checkout/pescaria-empresa');
  const novoG = criarPescaria({ base, prefixo: '/girassol-backup-offline', empresa: 'girassol', mlTokenManager: () => tok, fetch: fakeFetch });
  const rodar = async (mod) => {
    const out = {};
    for (const q of ['/pescar-tarifas-status?k=adm-pes', '/pescar-tarifas?k=adm-pes&pedido=777', '/pescar-tarifas?k=adm-pes&pedido=777&gravar=1', '/pescar-tarifas-status', '/auditoria-ml?k=adm-pes&de=2026-10-01&ate=2026-10-27']) {
      log = []; const r = await chamar(mod, '/girassol-backup-offline', q);
      out[q] = JSON.parse(JSON.stringify({ r, log }, (k, v) => (['inicio', 'fim', 'ultimo', 'duracao_ms', 'gerado_em'].includes(k) ? undefined : v)));
    }
    return out;
  };
  const a = await rodar(novoG), b = await rodar(velho);
  for (const [k, salvoV] of Object.entries(salvo)) { if (salvoV) require.cache[k] = salvoV; else delete require.cache[k]; }
  for (const q of Object.keys(b)) assert.deepStrictEqual(a[q], b[q], 'Girassol: ' + q + ' mudou em relação ao código de antes');
  assert.ok(a['/pescar-tarifas?k=adm-pes&pedido=777&gravar=1'].r.b && a['/pescar-tarifas?k=adm-pes&pedido=777&gravar=1'].log.some((l) => /^req girassol PATCH vendas_historico\?id=eq\.11/.test(l)), 'o caso de teste não gravou (a comparação não provaria nada)');
  assert.strictEqual(a['/pescar-tarifas-status'].r.c, 404, 'o status respondeu sem a chave de admin');
  // GOOD e AMB: a chave DELAS no Supabase e no histórico, o token DELAS
  for (const emp of ['good', 'amb']) {
    const m = criarPescaria({ base, prefixo: '/' + (emp === 'good' ? 'good' : 'amb') + '-checkout-offline', empresa: emp, mlTokenManager: () => tok, fetch: fakeFetch });
    log = []; const pref = '/' + emp + '-checkout-offline';
    const r = await chamar(m, pref, '/pescar-tarifas?k=adm-pes&pedido=777&gravar=1');
    assert.ok(r.t && r.c === 200 && log.some((l) => l.includes('empresa=eq.' + emp + '&')) && log.some((l) => l.startsWith('req ' + emp + ' PATCH')) && !log.some((l) => /girassol/.test(l)), emp + ': não usou a chave dela no Supabase/histórico: ' + log.join(' ; '));
  }
  // o estado da rodada é de CADA empresa
  const g2 = criarPescaria({ base, prefixo: '/girassol-backup-offline', empresa: 'girassol', mlTokenManager: () => tok, fetch: fakeFetch });
  const d2 = criarPescaria({ base, prefixo: '/good-checkout-offline', empresa: 'good', mlTokenManager: () => tok, fetch: fakeFetch });
  /* a rodada EM MASSA (massa=1&gravar=1) é a que mexe no estado: começa pela Girassol e o status da GOOD tem que seguir parado */
  const ini = await chamar(g2, '/girassol-backup-offline', '/pescar-tarifas?k=adm-pes&de=2026-10-01&ate=2026-10-02&massa=1&gravar=1');
  assert.strictEqual(ini.c, 202, 'a rodada em massa da Girassol não começou: ' + JSON.stringify(ini.b).slice(0, 160));
  const stGir = (await chamar(g2, '/girassol-backup-offline', '/pescar-tarifas-status?k=adm-pes')).b;
  assert.ok(stGir && stGir.de === '2026-10-01', 'o status da Girassol não mostra a rodada dela: ' + JSON.stringify(stGir).slice(0, 160));
  const stG = (await chamar(d2, '/good-checkout-offline', '/pescar-tarifas-status?k=adm-pes')).b;
  assert.ok(stG && stG.de == null && !stG.rodando, 'a rodada da Girassol apareceu no status da GOOD (estado dividido): ' + JSON.stringify(stG).slice(0, 160));
  await new Promise((r) => setTimeout(r, 300));
  // a GOOD monta as rotas; as três pela peça
  const gs = fs.readFileSync(path.join(raiz, 'good-checkout-offline', 'index.js'), 'utf8');
  assert.ok(/if \(!_pescaGood\) _pescaGood = require\('\.\/good-pescaria'\)\.rotasPescaria\(\{ validarSessao,/.test(gs) && gs.includes("if (await _pescaGood(req, res, urlObj)) return true;"), 'a GOOD não monta as rotas da pescaria');
  for (const [arq2, emp] of [['girassol-backup-offline/pescaria.js', 'girassol'], ['amb-checkout-offline/amb-pescaria.js', 'amb'], ['good-checkout-offline/good-pescaria.js', 'good']]) {
    assert.ok(fs.readFileSync(path.join(raiz, arq2), 'utf8').includes("empresa: '" + emp + "'"), arq2 + ': não é a peça com a chave dela');
  }
  fs.rmSync(dir, { recursive: true, force: true });
  console.log('ok — pescaria em peça única: a Girassol igual ao de antes; cada empresa com a chave e o token dela; estado por empresa; a GOOD ganha');
  process.exit(0);
})().catch((e) => { console.error('FALHOU:', e.message); process.exit(1); });
