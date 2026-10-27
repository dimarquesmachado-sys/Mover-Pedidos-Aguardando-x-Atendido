'use strict';
/* 27/10 — o AVISO DA PARTNER KEY DA SHOPEE na barra dos painéis (o dono: "me apareça um aviso bem na cara no checkout
   tipo 5 dias antes"), depois que a chave da Girassol venceu em 23/10 sem ninguém ver. A Shopee não informa a validade
   pela API: o aviso junta a DATA cadastrada por empresa e a PROVA da última conferência do canário das integrações.
   Prova: a regra dia a dia (5 dias antes acende, 6 não; venceu; recusou; data velha com a chave funcionando; sem data),
   a variável da empresa antes da geral, a prova gravada pelo canário de verdade e lida pela rota, a rota pública montada
   do registro de empresas, a faixa na barra comum e as telas carregando a versão nova do script. */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const raiz = path.join(__dirname, '..');
const A = require('../lib/checkout/aviso-chave-shopee');

(async () => {
  const gir = { id: 'girassol', nome: 'Magazine Girassol', tag: 'GIRABKP', loja: 'girassol' };
  const dia = (iso) => Date.parse(iso + 'T09:00:00-03:00');
  const env = { GIRABKP_SHOPEE_KEY_VENCE: '2027-04-25' };
  // 5 dias antes acende (vermelho), 6 não; o dia do vencimento ainda é aviso
  const v5 = A.avaliar(gir, null, env, dia('2027-04-20'));
  assert.ok(v5 && v5.nivel === 'vermelho' && v5.tipo === 'vence' && v5.dias === 5 && v5.vence === '25/04/2027' && v5.env === 'GIRABKP_SHOPEE_KEY_VENCE' && v5.envChave === 'GIRASSOL_SYNC_SHOPEE_PARTNER_KEY', '5 dias antes: ' + JSON.stringify(v5));
  assert.strictEqual(A.avaliar(gir, null, env, dia('2027-04-19')), null, '6 dias antes ainda não é aviso');
  const v0 = A.avaliar(gir, null, env, dia('2027-04-25'));
  assert.ok(v0 && v0.tipo === 'vence' && v0.dias === 0, 'no dia do vencimento ("vence HOJE"): ' + JSON.stringify(v0));
  const v26 = A.avaliar(gir, null, env, dia('2027-04-26'));
  assert.ok(v26 && v26.tipo === 'venceu', 'no dia seguinte, venceu: ' + JSON.stringify(v26));
  // venceu: sem prova depois da data → vermelho; com a Shopee aceitando DEPOIS da data → amarelo (data velha)
  const vv = A.avaliar(gir, { quando: '2027-04-20T10:00:00Z', assinaturaOk: true }, env, dia('2027-04-27'));
  assert.ok(vv && vv.nivel === 'vermelho' && vv.tipo === 'venceu', 'venceu (prova é de ANTES da data): ' + JSON.stringify(vv));
  const dv = A.avaliar(gir, { quando: '2027-04-26T10:00:00Z', assinaturaOk: true }, env, dia('2027-04-27'));
  assert.ok(dv && dv.nivel === 'amarelo' && dv.tipo === 'data_velha', 'data velha com a chave funcionando: ' + JSON.stringify(dv));
  // a Shopee recusou: vermelho, mesmo com a data lá na frente
  const rc = A.avaliar(gir, { quando: '2026-10-27T04:12:00Z', recusou: 'error_partner_key' }, env, dia('2026-10-27'));
  assert.ok(rc && rc.nivel === 'vermelho' && rc.tipo === 'recusou' && /error_partner_key/.test(rc.motivo), 'recusou: ' + JSON.stringify(rc));
  // sem data → amarelo (cadastrar); a variável DA empresa vale antes da geral
  const sd = A.avaliar({ id: 'good', nome: 'GOOD', tag: 'GOODBKP', loja: 'good' }, null, {}, dia('2026-10-27'));
  assert.ok(sd && sd.nivel === 'amarelo' && sd.tipo === 'sem_data' && sd.env === 'GOODBKP_SHOPEE_KEY_VENCE', 'sem data: ' + JSON.stringify(sd));
  assert.strictEqual(A.avaliar(gir, null, { SHOPEE_KEY_VENCE: '2027-04-21', GIRABKP_SHOPEE_KEY_VENCE: '2027-10-01' }, dia('2027-04-20')), null, 'a data da EMPRESA tem que valer antes da geral');
  assert.ok(A.avaliar(gir, null, { SHOPEE_KEY_VENCE: '2027-04-21' }, dia('2027-04-20')).tipo === 'vence', 'sem a da empresa, vale a geral');

  // a PROVA de verdade: o canário das integrações (a peça) grava; a montagem do alerta lê da pasta da empresa
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'avs-'));
  const readJson = (a, d) => { try { return JSON.parse(fs.readFileSync(a, 'utf8')); } catch (e) { return d; } };
  const base = { json: (res, c, b) => { res.c = c; res.b = b; }, ehAdmin: () => false, CACHE_DIR: dir, CONFERIDOS_FILE: path.join(dir, 'c.json'), readJson,
    writeJson: (a, v) => fs.writeFileSync(a, JSON.stringify(v)), blingGet: async () => ({ ok: true, data: { data: [] } }) };
  const fakeFetch = async (url) => {
    const r = (st, b) => ({ status: st, ok: st >= 200 && st < 300, json: async () => b, text: async () => JSON.stringify(b) });
    if (/onrender\.com\/$/.test(url)) return r(200, { ok: true });
    if (/\/interno\/pedidos-do-dia/.test(url)) return r(500, { ok: false, erro: '[girassol] Shopee refresh falhou: {"error":"error_partner_key","message":"partner key expired"}' });
    return r(404, {});
  };
  process.env.ADMIN_KEY = 'adm-av'; process.env.SHOPEE_SYNC_KEY = 'k';
  const can = require('../lib/checkout/canario-integracoes').criarCanarioIntegracoes({ base, prefixo: '/girassol-backup-offline', mlTokenManager: () => ({ garantirTokenML: async () => 't' }), empresa: 'girassol', fetch: fakeFetch });
  await can.rotasCanario({ VERSAO: 'v', validarSessao: () => null })({ method: 'GET', headers: {} }, { c: 0 }, new URL('http://h/girassol-backup-offline/saude-integracoes?k=adm-av'));
  const gravada = readJson(path.join(dir, A.ARQ_PROVA), null);
  assert.ok(gravada && /error_partner_key/.test(gravada.recusou || '') && gravada.loja === 'girassol' && gravada.quando, 'o canário não gravou a prova da recusa: ' + JSON.stringify(gravada));
  const al = A.montarAlerta([Object.assign({ cacheDir: dir }, gir)], { lerJson: (a) => readJson(a, null), env: { GIRABKP_SHOPEE_KEY_VENCE: '2027-04-25' }, agora: dia('2026-10-27') });
  assert.ok(al.alerta && al.itens.length === 1 && al.itens[0].tipo === 'recusou', 'a montagem não leu a prova da pasta da empresa: ' + JSON.stringify(al));
  fs.rmSync(dir, { recursive: true, force: true });

  // a rota pública, a faixa na barra e as telas com a versão nova
  const ix = fs.readFileSync(path.join(raiz, 'index.js'), 'utf8');
  const iR = ix.indexOf("if (path === '/diagnostico/shopee-chave/alerta') {");
  assert.ok(iR > 0 && /regA\.ativas\(\)/.test(ix.slice(iR, iR + 2000)) && /montarAlerta\(emps,/.test(ix.slice(iR, iR + 2000)), 'a rota do alerta não monta as empresas do registro');
  const nav = fs.readFileSync(path.join(raiz, 'public', 'comum', 'nav.js'), 'utf8');
  assert.ok(nav.includes("fetch(HOST_NAV + '/diagnostico/shopee-chave/alerta')") && nav.includes("faixa.className = 'aviso-chave-shopee'"), 'a barra não mostra a faixa da chave');
  for (const t of ['recusou', 'venceu', 'vence', 'data_velha', 'sem_data']) assert.ok(nav.includes("it.tipo === '" + t + "'"), 'a barra não trata o caso ' + t);
  for (const h of ['girassol-backup-offline/painel.html', 'amb-checkout-offline/painel.html', 'good-checkout-offline/painel.html', 'public/respostas-rapidas/painel.html', 'public/fragil/index.html', 'public/ponto/admin.html']) {
    assert.ok(fs.readFileSync(path.join(raiz, h), 'utf8').includes('src="/comum/nav.js?v=20261027"'), h + ' carrega a versão velha da barra');
  }
  console.log('ok — aviso da Partner Key da Shopee: 5 dias antes acende, venceu, recusou, data velha e sem data; a prova do canário de verdade chega na barra dos painéis');
  process.exit(0);
})().catch((e) => { console.error('FALHOU:', e.message); process.exit(1); });
