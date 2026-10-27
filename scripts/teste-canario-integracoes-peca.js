'use strict';
/* 26/10 — o CANÁRIO DAS INTEGRAÇÕES virou PEÇA ÚNICA (lib/checkout/canario-integracoes): era canario.js (Girassol) e
   amb-canario.js (AMB); só a AMB conferia o SERVIÇO DA SHOPEE (o host errado que custou 8 meses de tarifa estimada foi
   pego por essa conferência); a GOOD não tinha nenhuma. Prova, com Bling, ML e serviço da Shopee de mentira (fetch, base
   e token falsos, no formato real):
   · a AMB responde EXATAMENTE como o código de antes (fixture), conferência por conferência (sem os tempos);
   · a Girassol e a GOOD ganham a conferência do serviço da Shopee, com a loja e a chave DELAS (configuração única);
   · a rota é só pra admin (404 sem a chave); cada empresa no prefixo dela; a GOOD agenda 1x/dia fora do galpão. */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const raiz = path.join(__dirname, '..');

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cint-'));
  fs.writeFileSync(path.join(dir, '_ml_billing.json'), JSON.stringify({ atualizado: new Date().toISOString(), periodos: {} }));
  fs.writeFileSync(path.join(dir, '_vendas_dia.json'), JSON.stringify({ atualizado: new Date().toISOString(), vendas: [] }));
  const readJson = (a, d) => { try { return JSON.parse(fs.readFileSync(a, 'utf8')); } catch (e) { return d; } };
  const base = { json: (res, c, b) => { res.c = c; res.b = b; }, ehAdmin: () => false, CACHE_DIR: dir, CONFERIDOS_FILE: path.join(dir, 'conf.json'), readJson,
    blingGet: async (p) => (/\/pedidos\/vendas\?/.test(p) ? { ok: true, data: { data: [{ id: 11, numero: 1, data: '2026-10-25', situacao: { id: 9 } }] } }
      : { ok: true, data: { data: { id: 11, numero: 1, itens: [{ codigo: 'SKU', quantidade: 1, valor: 10 }], contato: { nome: 'X' }, loja: { id: 1 }, situacao: { id: 9 } } } }) };
  const log = [];
  let modoPedidos = 'ok';   /* 27/10: como o serviço da Shopee responde a listagem (ok / recusou / 401) */
  const fakeFetch = async (url) => {
    log.push(String(url).replace(/k=[^&]+/, 'k=*'));
    const r = (st, b, txt) => ({ status: st, ok: st >= 200 && st < 300, json: async () => b, text: async () => (txt != null ? txt : JSON.stringify(b)) });
    if (/onrender\.com\/$/.test(url)) return r(200, { ok: true, servico: 'shopee-sync' });
    if (/\/interno\/pedidos-do-dia/.test(url)) {
      if (modoPedidos === 'recusou') return r(502, { ok: false, erro: 'Shopee recusou a listagem: error_sign Wrong sign.', loja: 'amb' });
      if (modoPedidos === '401') return r(401, { ok: false, erro: 'chave invalida' });
      if (modoPedidos === 'refresh') return r(500, { ok: false, erro: '[amb] Shopee refresh falhou: {"error":"error_partner_key","message":"partner key is invalid","request_id":"x1"}' });
      return r(200, { ok: true, listados: 4 });
    }
    if (/mercadolibre\.com/.test(url)) return r(200, { results: [{ id: 1, status: 'paid', order_items: [{ item: { id: 'MLB1' }, quantity: 1, unit_price: 10 }], payments: [{ id: 1 }], shipping: { id: 1 } }], paging: { total: 1 } });
    return r(404, {});
  };
  const tok = { garantirTokenML: async () => 'tok' };
  process.env.ADMIN_KEY = 'adm-t';
  process.env.AMBBKP_SHOPEE_SYNC_KEY = 'k-amb'; process.env.SHOPEE_SYNC_KEY = 'k-gir'; process.env.GOODBKP_SHOPEE_SYNC_KEY = 'k-good';
  // a versão de ANTES da AMB, com o base, o token e o fetch de mentira (cache de require)
  const pasta = path.join(raiz, 'amb-checkout-offline');
  const rb = require.resolve(path.join(pasta, 'base.js')), rt = require.resolve(path.join(raiz, 'ambtotal', 'mlTokenManager.js')), rf = require.resolve('node-fetch');
  const salvo = { [rb]: require.cache[rb], [rt]: require.cache[rt], [rf]: require.cache[rf] };
  require.cache[rb] = { id: rb, filename: rb, loaded: true, exports: base };
  require.cache[rt] = { id: rt, filename: rt, loaded: true, exports: tok };
  require.cache[rf] = { id: rf, filename: rf, loaded: true, exports: fakeFetch };
  const arqAntigo = path.join(pasta, '_canario_antigo_teste.js');
  fs.writeFileSync(arqAntigo, fs.readFileSync(path.join(__dirname, 'fixtures', 'canario-integracoes-amb-antes.js'), 'utf8'));
  let velho; try { velho = require(arqAntigo); } finally { try { fs.unlinkSync(arqAntigo); } catch (e) {} }
  /* (o código de antes pede o token do ML na HORA da conferência — os falsos ficam até ele rodar) */
  const restaurar = () => { for (const [k, v] of Object.entries(salvo)) { if (v) require.cache[k] = v; else delete require.cache[k]; } };
  const { criarCanarioIntegracoes } = require('../lib/checkout/canario-integracoes');
  const nova = (emp, pref) => criarCanarioIntegracoes({ base, prefixo: pref, mlTokenManager: () => tok, empresa: emp, fetch: fakeFetch });
  const chamar = async (rotas, pref, q) => {
    const res = { c: 0, b: null };
    const tratou = await rotas({ VERSAO: 'v', validarSessao: () => null })({ method: 'GET', headers: {} }, res, new URL('http://h' + pref + '/saude-integracoes' + q));
    return { tratou, c: res.c, b: res.b };
  };
  const limpo = (b) => JSON.stringify(b, (k, v) => (['duracao_ms', 'ms', 'rodou_em'].includes(k) ? undefined : v));
  // AMB: igual ao de antes
  const rn = await chamar(nova('amb', '/amb-checkout-offline').rotasCanario, '/amb-checkout-offline', '?k=adm-t');
  const rv = await chamar(velho.rotasCanario, '/amb-checkout-offline', '?k=adm-t');
  restaurar();
  assert.ok(rn.c === 200 && rn.b && rn.b.checagens.length === 6, 'a AMB não rodou as 6 conferências: ' + limpo(rn.b).slice(0, 200));
  /* 27/10: a conferência da VALIDADE da Partner Key mudou de propósito (usa a prova da chamada assinada) — o resto,
     conferência por conferência, igual ao código de antes */
  const semValidade = (b) => Object.assign({}, b, { checagens: b.checagens.filter((c) => !/validade da Partner Key/.test(c.nome)), ok: undefined, resumo: undefined });
  assert.strictEqual(limpo(semValidade(rn.b)), limpo(semValidade(rv.b)), 'AMB: o canário respondeu diferente do código de antes');
  const val = (b) => b.checagens.find((c) => /validade da Partner Key/.test(c.nome));
  // (a) a data cadastrada passou, mas a Shopee ACEITOU a assinatura agora → aviso (a chave vale), não erro
  delete process.env.SHOPEE_KEY_VENCE; delete process.env.AMBBKP_SHOPEE_KEY_VENCE;
  { const v = val((await chamar(nova('amb', '/amb-checkout-offline').rotasCanario, '/amb-checkout-offline', '?k=adm-t')).b);
    assert.ok(v.estado === 'alerta' && /ACEITOU a assinatura agora \(loja amb listou 4/.test(v.detalhe) && /AMBBKP_SHOPEE_KEY_VENCE|SHOPEE_KEY_VENCE/.test(v.detalhe), 'data vencida com a assinatura aceita tinha que ser AVISO: ' + JSON.stringify(v)); }
  // (b) a Shopee RECUSOU a assinatura → erro, apontando a variável da Partner Key DA loja no serviço
  modoPedidos = 'recusou';
  { const v = val((await chamar(nova('amb', '/amb-checkout-offline').rotasCanario, '/amb-checkout-offline', '?k=adm-t')).b);
    assert.ok(v.estado === 'erro' && /RECUSOU a chamada assinada da loja amb/.test(v.detalhe) && /AMB_SYNC_SHOPEE_PARTNER_KEY/.test(v.detalhe), 'assinatura recusada tinha que ser ERRO com a variável da loja: ' + JSON.stringify(v)); }
  // (b2) a Shopee recusou a chave AO RENOVAR O TOKEN da loja (o caso real da Girassol em 27/10) → erro, e o erro inteiro aparece
  modoPedidos = 'refresh';
  { const b = (await chamar(nova('amb', '/amb-checkout-offline').rotasCanario, '/amb-checkout-offline', '?k=adm-t')).b;
    const v = val(b), sv = b.checagens.find((c) => /Serviço Shopee/.test(c.nome));
    assert.ok(v.estado === 'erro' && /RECUSOU a chamada assinada da loja amb/.test(v.detalhe) && /error_partner_key/.test(v.detalhe) && /AMB_SYNC_SHOPEE_PARTNER_KEY/.test(v.detalhe), 'refresh recusado pela chave tinha que ser ERRO de Partner Key: ' + JSON.stringify(v));
    assert.ok(/partner key is invalid/.test(sv.detalhe), 'o erro da Shopee saiu cortado na conferência do serviço: ' + sv.detalhe); }
  // (c) não deu pra conferir (chave interna recusada antes da Shopee) → fica o calendário, dizendo que não conferiu
  modoPedidos = '401';
  { const v = val((await chamar(nova('amb', '/amb-checkout-offline').rotasCanario, '/amb-checkout-offline', '?k=adm-t')).b);
    assert.ok(v.estado === 'erro' && /VENCEU em 23\/10\/2026/.test(v.detalhe) && /não deu pra conferir a assinatura agora/.test(v.detalhe), 'sem prova, tinha que valer o calendário dizendo que não conferiu: ' + JSON.stringify(v)); }
  // (d) a data POR EMPRESA vale antes da geral
  modoPedidos = 'ok'; process.env.SHOPEE_KEY_VENCE = '2026-10-23'; process.env.AMBBKP_SHOPEE_KEY_VENCE = '2027-10-23';
  { const v = val((await chamar(nova('amb', '/amb-checkout-offline').rotasCanario, '/amb-checkout-offline', '?k=adm-t')).b);
    assert.ok(v.estado === 'ok' && /vence em 23\/10\/2027/.test(v.detalhe) && /assinatura conferida agora/.test(v.detalhe), 'a data da empresa não valeu: ' + JSON.stringify(v)); }
  delete process.env.SHOPEE_KEY_VENCE; delete process.env.AMBBKP_SHOPEE_KEY_VENCE;
  // sem a chave: 404
  const r404 = await chamar(nova('amb', '/amb-checkout-offline').rotasCanario, '/amb-checkout-offline', '');
  assert.ok(r404.tratou && r404.c === 404, 'o canário respondeu sem a chave de admin');
  // Girassol e GOOD: ganham o serviço da Shopee, com a loja e a chave DELAS
  for (const [emp, pref, loja] of [['girassol', '/girassol-backup-offline', 'girassol'], ['good', '/good-checkout-offline', 'good']]) {
    log.length = 0;
    const r = await chamar(nova(emp, pref).rotasCanario, pref, '?k=adm-t');
    const sv = r.b && r.b.checagens.find((c) => /Shopee \(sync\)/.test(c.nome));
    assert.ok(sv && sv.estado === 'ok' && new RegExp('loja ' + loja + ': responde').test(sv.detalhe), emp + ': sem a conferência do serviço da Shopee com a loja dela: ' + JSON.stringify(sv));
    assert.ok(log.some((u) => u.includes('/' + loja + '/interno/pedidos-do-dia')), emp + ': conferiu a loja de outra empresa: ' + log.join(' ; '));
    const outro = await chamar(nova(emp, pref).rotasCanario, emp === 'good' ? '/girassol-backup-offline' : '/good-checkout-offline', '?k=adm-t');
    assert.strictEqual(outro.tratou, false, emp + ': respondeu a rota de outra empresa');
  }
  // as três pela peça; a GOOD monta a rota e agenda
  for (const [arq, emp] of [['girassol-backup-offline/canario.js', 'girassol'], ['amb-checkout-offline/amb-canario.js', 'amb'], ['good-checkout-offline/good-canario.js', 'good']]) {
    const s = fs.readFileSync(path.join(raiz, arq), 'utf8');
    assert.ok(s.includes("empresa: '" + emp + "'") && /criarCanarioIntegracoes\(\{/.test(s), arq + ': não é a peça');
  }
  const gs = fs.readFileSync(path.join(raiz, 'good-checkout-offline', 'index.js'), 'utf8');
  assert.ok(/if \(await rotasCanarioIntegracoes\(\{ VERSAO, validarSessao \}\)\(req, res, urlObj\)\) return true;/.test(gs), 'a GOOD não monta a rota');
  /* 27/10: na GOOD, o canário das integrações roda na madrugada única */
  assert.ok(/_noturnaGood = require\('\.\.\/lib\/checkout\/noturna-empresa'\)\.criarNoturna\(\{\s*\n\s*empresa: 'good', prefixo: '\/good-checkout-offline',/.test(gs) && /noturna: \(\) => _noturnaGood\.rotinaNoturna\('cron'\)/.test(gs) && /noturna: '0 4 \* \* \*'/.test(gs) && /canarioCron: \(\) => canarioCronIntegracoes\(\{ VERSAO, validarSessao \}\)/.test(gs), 'a GOOD não roda o canário das integrações na madrugada');
  fs.rmSync(dir, { recursive: true, force: true });
  console.log('ok — canário das integrações em peça única: a AMB igual ao de antes; a Girassol e a GOOD ganham a conferência do serviço da Shopee com a loja delas');
  process.exit(0);
})().catch((e) => { console.error('FALHOU:', e.message); process.exit(1); });
