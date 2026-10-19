'use strict';
/* 17/10 — a venda do dia virou peça única (lib/checkout/vendas-dia.js), nascida da versão da Girassol. Prova de que,
   pra Girassol, NADA muda: roda a função ORIGINAL (recortada do gbo-app.js de antes da migração, guardada em
   scripts/fixtures, como .txt) e a PEÇA com a configuração da Girassol, no MESMO cenário de mentira (Bling, ML, Shopee, Magalu,
   arquivos), e compara: as chamadas externas, na ordem, e tudo o que foi gravado. Dois cenários: dia vazio e um dia
   com pedidos de ML, Shopee e Magalu passando pelas fases. */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const raiz = path.join(__dirname, '..');
const { criarVendasSync, criarVendasSyncDaEmpresa } = require('../lib/checkout/vendas-dia');

/* .txt de propósito: é a função antiga SOLTA (sem o módulo em volta) — como .js, o checador de órfãos a leria como código do repo */
const ORIG = fs.readFileSync(path.join(__dirname, 'fixtures', 'vendasSync-girassol-antes.txt'), 'utf8');
const ISO = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z/g;
const limpa = (x) => JSON.parse(JSON.stringify(x === undefined ? null : x).replace(ISO, '<ts>'));

function ambiente(cen) {
  const log = [], disco = {};
  const tkML = { garantirTokenML: async () => 'tk-ml' };
  const resp = (ok, corpo) => ({ ok, status: ok ? 200 : 404, json: async () => corpo, text: async () => JSON.stringify(corpo) });
  const d = {
    CACHE_DIR: '/c', CONFERIDOS_FILE: '/c/conferidos.json', LOJA_MKT: { '1': 'ml', '2': 'shopee', '3': 'magalu' }, path,
    _vsy: {},
    _inferCanal: (nl) => /^2\d{15}$/.test(String(nl)) ? 'ml' : 'outro',
    readJson: (p, def) => (p in disco ? JSON.parse(JSON.stringify(disco[p])) : (cen.disco && p in cen.disco ? JSON.parse(JSON.stringify(cen.disco[p])) : def)),
    writeJson: (p, v) => { log.push(['grava', p]); disco[p] = JSON.parse(JSON.stringify(v)); return true; },
    blingGet: async (u) => { log.push(['bling', u]); return (cen.bling && cen.bling(u)) || { ok: true, data: { data: [] } }; },
    json: () => {},
    _faseDireta: async () => { log.push(['fase-direta']); },
    pescarDadosML: async (nl) => { log.push(['pesca-ml', nl]); return (cen.pesca && cen.pesca(nl)) || null; },
    buscarDevolucoesML: async () => { log.push(['devolucoes-ml']); return []; },
    nfDoPedido: async (id) => { log.push(['nf-do-pedido', id]); return null; },
    magaluFreteProvisorio: async (v) => { log.push(['frete-prov', v && v.numero]); return null; },
    magaluFreteSkuGravar: (sku) => { log.push(['frete-sku', sku]); },
  };
  const fetch = async (u) => { log.push(['fetch', String(u).replace(/k=[^&]*/, 'k=<k>')]); const r = cen.fetch && cen.fetch(String(u)); return r || resp(false, null); };
  return { d, fetch, log, disco, tkML };
}

async function rodar(qual, cen) {
  const amb = ambiente(cen);
  let vs;
  if (qual === 'original') {
    const i = ORIG.indexOf('\nasync function vendasSync'), j = ORIG.lastIndexOf('\n}');
    const corpo = ORIG.slice(i + 1, j + 2);
    const req = (m) => (m === '../girassol/mlTokenManager' ? amb.tkML : m === '../tiktok-oauth' ? require('../tiktok-oauth') : require(m));
    const nomes = Object.keys(amb.d);
    vs = new Function(...nomes, 'fetch', 'require', 'ML_REAL_V', corpo + '\nreturn vendasSync;')(...nomes.map(n => amb.d[n]), amb.fetch, req, 2);
  } else {
    /* 19/10 (Fase 3): a peça montada pela configuração ÚNICA (config-empresa) — a equivalência prova que ela dá o mesmo */
    vs = criarVendasSyncDaEmpresa('girassol', { mlTokenManager: () => amb.tkML, deps: () => amb.d, fetch: amb.fetch });

  }
  let erro = null; try { await vs(); } catch (e) { erro = String(e && e.message); }
  return { log: amb.log, disco: limpa(amb.disco), vsy: limpa(amb.d._vsy), erro };
}

const hojeBling = new Date().toISOString().slice(0, 10);
const CENARIOS = {
  'dia vazio': {},
  'dia com ML, Shopee e Magalu': {
    disco: { '/c/conferidos.json': { '501': { conferido_em: '2026-10-17T10:00:00Z' } } },
    bling: (u) => {
      if (/^\/pedidos\/vendas\?/.test(u) && /pagina=1&/.test(u)) return { ok: true, data: { data: [
        { id: 501, numero: 9001, numeroLoja: '2000019000000001', data: hojeBling, total: 150, loja: { id: 1 }, situacao: { id: 9 }, contato: { nome: 'A' } },
        { id: 502, numero: 9002, numeroLoja: '251017ABCDEF', data: hojeBling, total: 80, loja: { id: 2 }, situacao: { id: 6 }, contato: { nome: 'B' } },
        { id: 503, numero: 9003, numeroLoja: 'LU-123', data: hojeBling, total: 60, loja: { id: 3 }, situacao: { id: 6 }, contato: { nome: 'C' } } ] } };
      if (/^\/pedidos\/vendas\/50\d$/.test(u)) { const id = Number(u.split('/').pop());
        return { ok: true, data: { data: { id, loja: { id: id - 500 }, itens: [{ codigo: 'SKU' + id, quantidade: 1, valor: 50, descricao: 'X' }], taxas: { taxaComissao: 5, custoFrete: 3 } } } }; }
      return null;
    },
    fetch: (u) => /api\.mercadolibre\.com\/orders\//.test(u) ? { ok: true, status: 200, json: async () => ({ id: 1, date_created: '2026-10-17T09:00:00.000-03:00', shipping: { id: 77 } }) } : null,
    pesca: () => ({ comissao: 10, frete: 5, costs_ok: true, ship_ok: true }),
  },
};

(async () => {
  for (const [nome, cen] of Object.entries(CENARIOS)) {
    for (const env of [{}, { SHOPEE_SYNC_KEY: 'chave', ADMIN_KEY: 'adm' }]) {
      const salvo = {}; for (const k of Object.keys(env)) { salvo[k] = process.env[k]; process.env[k] = env[k]; }
      const a = await rodar('original', cen), b = await rodar('peca', cen);
      for (const k of Object.keys(env)) { if (salvo[k] === undefined) delete process.env[k]; else process.env[k] = salvo[k]; }
      const rot = nome + (Object.keys(env).length ? ' (com Shopee e Magalu ligados)' : '');
      assert.strictEqual(b.erro, a.erro, rot + ': erro diferente: ' + b.erro + ' x ' + a.erro);
      assert.deepStrictEqual(b.log, a.log, rot + ': as chamadas externas mudaram');
      assert.deepStrictEqual(b.disco, a.disco, rot + ': o que foi gravado mudou');
      assert.deepStrictEqual(b.vsy, a.vsy, rot + ': o estado da rodada (_vsy) mudou');
      assert.ok(a.log.length > 0, rot + ': o cenário não exercitou nada');
    }
  }
  /* 17/10 — a AMB também: a função ORIGINAL dela x a peça com a configuração dela. A ÚNICA diferença permitida é a
     melhoria que só a Girassol tinha — a versão do custo real do ML (a AMB gravava ml_real = 1; a peça grava 2 quando
     o custo E a classificação do envio vieram) — e ela tem que aparecer no cenário com pedido do ML. */
  const ORIG_AMB = fs.readFileSync(path.join(__dirname, 'fixtures', 'vendasSync-amb-antes.txt'), 'utf8');
  const rodarAmb = async (qual, cen) => {
    const amb = ambiente(cen); let vs;
    if (qual === 'original') {
      const i = ORIG_AMB.indexOf('\nasync function vendasSync'), j = ORIG_AMB.lastIndexOf('\n}');
      const req = (m) => (m === '../ambtotal/mlTokenManager' ? amb.tkML : m === '../tiktok-oauth' ? require('../tiktok-oauth') : require(m));
      const nomes = Object.keys(amb.d);
      vs = new Function(...nomes, 'fetch', 'require', ORIG_AMB.slice(i + 1, j + 2) + '\nreturn vendasSync;')(...nomes.map(n => amb.d[n]), amb.fetch, req);
    } else {
      vs = criarVendasSyncDaEmpresa('amb', { mlTokenManager: () => amb.tkML, deps: () => amb.d, fetch: amb.fetch });

    }
    let erro = null; try { await vs(); } catch (e) { erro = String(e && e.message); }
    return { log: amb.log, disco: limpa(amb.disco), vsy: limpa(amb.d._vsy), erro };
  };
  let viuMelhoria = false;
  for (const [nome, cen] of Object.entries(CENARIOS)) {
    for (const env of [{}, { AMBBKP_SHOPEE_SYNC_KEY: 'chave', ADMIN_KEY: 'adm' }]) {
      const salvo = {}; for (const k of Object.keys(env)) { salvo[k] = process.env[k]; process.env[k] = env[k]; }
      const a = await rodarAmb('original', cen), b = await rodarAmb('peca', cen);
      for (const k of Object.keys(env)) { if (salvo[k] === undefined) delete process.env[k]; else process.env[k] = salvo[k]; }
      const rot = 'AMB · ' + nome + (Object.keys(env).length ? ' (com Shopee e Magalu ligados)' : '');
      // a melhoria documentada: ml_real 1 (AMB) → 2 (peça). Qualquer outra diferença derruba.
      const norm = (d) => JSON.parse(JSON.stringify(d).replace(/"ml_real":2/g, () => { viuMelhoria = true; return '"ml_real":1'; }));
      assert.strictEqual(b.erro, a.erro, rot + ': erro diferente');
      assert.deepStrictEqual(b.log, a.log, rot + ': as chamadas externas mudaram');
      assert.deepStrictEqual(norm(b.disco), a.disco, rot + ': o que foi gravado mudou além da versão do custo real do ML');
      assert.deepStrictEqual(b.vsy, a.vsy, rot + ': o estado da rodada mudou');
    }
  }
  assert.ok(viuMelhoria, 'o cenário com pedido do ML não mostrou a melhoria do custo real (ml_real 2)');
  const am = fs.readFileSync(path.join(raiz, 'amb-checkout-offline', 'index.js'), 'utf8');
  assert.ok(/require\('\.\.\/lib\/checkout\/vendas-dia'\)\.criarVendasSyncDaEmpresa\('amb', \{/.test(am), 'a AMB não usa a peça');
  /* a configuração que o teste usou é a MESMA que está nos módulos (senão a prova valeria pra outra coisa) */
  /* 19/10 (Fase 3): a configuração NÃO mora mais nos módulos (vem de lib/checkout/config-empresa, conferida linha a linha
     em scripts/teste-config-empresa-checkout.js). Se alguém voltar a escrever à mão numa pasta, cai aqui. */
  for (const arq of ['girassol-backup-offline/gbo-app.js', 'amb-checkout-offline/index.js', 'good-checkout-offline/index.js']) {
    const src = fs.readFileSync(path.join(raiz, arq), 'utf8');
    assert.ok(!/criarVendasSync\(\{\s*\n\s*tag:/.test(src), arq + ': a configuração da venda do dia voltou a ser escrita à mão na pasta');
  }
  /* Codex #711 (P1 ×2): a repesca do custo real (ml_real 1 → 2) NÃO apaga o crédito do billing (que no cache do dia
     pode estar SEM credito_fonte) e LIMPA o frete velho quando a leitura completa diz que não há frete do vendedor */
  { const hojeB = new Date().toISOString().slice(0, 10);
    const linha = (extra) => Object.assign({ id: 601, numero: 9601, numero_loja: '2000019000000601', data: hojeB, marketplace: 'ml', ml_real: 1, credito_ml: 5, frete_ml: 10 }, extra);
    const cen = { disco: { '/c/_vendas_dia.json': { '601': linha({}), '602': linha({ id: 602, numero: 9602, numero_loja: '2000019000000602', credito_fonte: 'costs' }) } },
      pesca: () => ({ costs_ok: true, ship_ok: true, credito: null, frete: null }) };
    const r = await rodar('peca', cen);
    const dia = r.disco['/c/_vendas_dia.json'] || {};
    const a601 = Object.values(dia).find(v => String(v.numero) === '9601'), a602 = Object.values(dia).find(v => String(v.numero) === '9602');
    assert.ok(a601 && a602, 'o cenário da repesca não gravou as linhas: ' + JSON.stringify(Object.keys(dia)));
    assert.strictEqual(a601.credito_ml, 5, 'a repesca apagou o crédito do billing (sem fonte no cache do dia)');
    assert.ok(!('credito_ml' in a602), 'crédito que a própria pesca pôs (fonte costs) e o ML não confirma tinha que sair');
    assert.ok(!('frete_ml' in a601), 'leitura completa sem frete do vendedor e o frete velho ficou na margem');
    assert.strictEqual(a601.ml_real, 2, 'a linha não avançou pra versão 2'); }
  /* 19/10 — a GOOD também (ela não tinha venda do dia): a peça com a configuração dela roda o dia com pedidos de ML,
     Shopee e Magalu, grava o _vendas_dia.json e chama o serviço da Shopee pela loja DELA */
  { const amb = ambiente(CENARIOS['dia com ML, Shopee e Magalu']);
    const antesK = process.env.GOODBKP_SHOPEE_SYNC_KEY; process.env.GOODBKP_SHOPEE_SYNC_KEY = 'chave-good';
    const vsG = criarVendasSyncDaEmpresa('good', { mlTokenManager: () => amb.tkML, deps: () => amb.d, fetch: amb.fetch });

    let erroG = null; try { await vsG(); } catch (e) { erroG = e.message; }
    if (antesK === undefined) delete process.env.GOODBKP_SHOPEE_SYNC_KEY; else process.env.GOODBKP_SHOPEE_SYNC_KEY = antesK;
    assert.strictEqual(erroG, null, 'GOOD: a venda do dia estourou: ' + erroG);
    const diaG = amb.disco['/c/_vendas_dia.json'] || {};
    assert.ok(Object.keys(diaG).length >= 3, 'GOOD: a venda do dia não gravou as vendas do dia: ' + JSON.stringify(Object.keys(diaG)));
    assert.ok(amb.log.some(l => l[0] === 'fetch' && /\/good\/interno\/margem-pedidos\?k=/.test(l[1])), 'GOOD: a Shopee não foi chamada pela loja da GOOD');
    const g = fs.readFileSync(path.join(raiz, 'good-checkout-offline', 'index.js'), 'utf8');
    assert.ok(/require\('\.\.\/lib\/checkout\/vendas-dia'\)\.criarVendasSyncDaEmpresa\('good', \{/.test(g), 'a GOOD não usa a peça');
    assert.ok(/vendasSync: \(\.\.\.a\) => vendasSync\(\.\.\.a\), _inferCanal: \(\.\.\.a\) => _inferCanal\(\.\.\.a\),/.test(g), 'GOOD: a fábrica do painel não recebe a venda do dia (a rota /vendas-sync responderia semPeca)');
    assert.ok(/setInterval\(\(\) => \{ try \{ vendasSync\(\)\.catch\(\(\) => \{\}\); \} catch \(e\) \{\} \}, 5 \* 60 \* 1000\);/.test(g), 'GOOD: a venda do dia não está agendada a cada 5 min'); }
  /* o canal pelo nº do pedido (peça nova da lib) é o MESMO da AMB */
  { const { inferirCanal } = require('../lib/checkout/inferir-canal');
    const srcA = fs.readFileSync(path.join(raiz, 'amb-checkout-offline', 'index.js'), 'utf8');
    const iA = srcA.indexOf('function _inferCanal(nl) {'); const fA = new Function(srcA.slice(iA, srcA.indexOf('\n}\n', iA) + 2) + '\nreturn _inferCanal;')();
    for (const nl of ['', '2000019040179196', '251017ABCDEF', '585123', '1512345', '111-2222222-3333333', '99999']) assert.strictEqual(inferirCanal(nl), fA(nl), 'canal diferente da AMB pra ' + nl); }
  // a Girassol usa a peça, com a configuração dela
  const g = fs.readFileSync(path.join(raiz, 'girassol-backup-offline', 'gbo-app.js'), 'utf8');
  assert.ok(/require\('\.\.\/lib\/checkout\/vendas-dia'\)\.criarVendasSyncDaEmpresa\('girassol', \{/.test(g), 'a Girassol não usa a peça');
  assert.ok(!/\nasync function vendasSync\(\) \{\n  const MAG_EMPRESA/.test(g), 'a cópia antiga da venda do dia continua na Girassol');
  console.log('ok — venda do dia: a peça única faz o que a função da Girassol fazia, e o que a da AMB fazia mais a melhoria do custo real do ML (chamadas, gravações e estado)');
})().catch(e => { console.error('FALHOU:', e.message); process.exit(1); });
