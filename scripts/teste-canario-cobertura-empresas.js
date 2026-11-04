'use strict';
/* 01/11 — O CANÁRIO CONFERE A SHOPEE NAS TRÊS (auditoria do Codex no SHA 208fdb7d, achado F09). Os comentários prometiam a
   Shopee nas três empresas, mas o canário da GOOD (montado em 23/10, quando ela não tinha o módulo da Shopee) ficou com
   `pedirAoSync: null` — e a GOOD ganhou a peça da Shopee em 27/10 (good-shopee). Venda da Shopee da GOOD que não chegasse
   ao Bling não era vista. Prova, por empresa:
   · a montagem do canário entrega à peça o pedirAoSync do MÓDULO DA SHOPEE DA EMPRESA (amb-shopee, gbo-shopee,
     good-shopee) — nunca null;
   · DE VERDADE: o pedirAoSync de produção de cada empresa (o serviço da Shopee de mentira no lugar da rede) + a peça do
     canário → a listagem da Shopee volta com as vendas, perguntando à LOJA CERTA (/amb, /girassol, /good). */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');
const raiz = path.join(__dirname, '..');

const EMP = [
  ['amb', 'amb-checkout-offline/index.js', 'amb-checkout-offline/amb-shopee.js', 'amb', 'AMBBKP_SHOPEE_SYNC_KEY'],
  ['girassol', 'girassol-backup-offline/gbo-app.js', 'girassol-backup-offline/gbo-shopee.js', 'girassol', 'SHOPEE_SYNC_KEY'],
  ['good', 'good-checkout-offline/index.js', 'good-checkout-offline/good-shopee.js', 'good', 'GOODBKP_SHOPEE_SYNC_KEY'],
];
/* 1) a montagem do canário de cada empresa entrega o pedirAoSync do módulo da Shopee dela */
for (const [emp, arq, modShopee] of EMP) {
  const s = fs.readFileSync(path.join(raiz, arq), 'utf8');
  const i = s.indexOf("criarCanarioDaEmpresa('" + emp + "'");
  assert.ok(i > 0, emp + ': não achei a montagem do canário');
  const deps = /deps: \(\) => \(\{([^\n]*)\}\)/.exec(s.slice(i, i + 800));
  assert.ok(deps, emp + ': não achei as dependências do canário');
  const m = /pedirAoSync(?:: ([A-Za-z_$][\w$]*))?\s*[,}]/.exec(deps[1] + '}');
  assert.ok(m, emp + ': o canário não recebe pedirAoSync');
  const nome = m[1] || 'pedirAoSync';
  assert.ok(nome !== 'null', emp + ': o canário recebe pedirAoSync: null — a Shopee fica de fora');
  const base = path.basename(modShopee, '.js');
  const reImport = new RegExp('pedirAoSync(?::\\s*' + nome.replace(/\$/g, '\\$') + ')?[^;]*\\} = require\\(\'\\./' + base + '\'\\)');
  assert.ok(reImport.test(s), emp + ': o pedirAoSync do canário (' + nome + ') não é o do módulo da Shopee da empresa (' + base + ')');
}
/* 2) de verdade: o pedirAoSync de produção de cada empresa + a peça do canário, com o serviço da Shopee de mentira */
(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cancob-'));
  for (const v of ['GIRABKP_CACHE_DIR', 'AMBBKP_CACHE_DIR', 'GOODBKP_CACHE_DIR']) process.env[v] = path.join(tmp, v);
  const pedidas = [];
  const _load = Module._load;
  Module._load = function (req) {
    if (req === 'node-fetch') return async (u) => { pedidas.push(String(u)); const corpo = { ok: true, resposta: { response: { order_list: [{ order_sn: 'SN-' + (String(u).match(/\/(amb|girassol|good)\/interno\//) || [])[1], order_status: 'READY_TO_SHIP' }, { order_sn: 'SN-CANC', order_status: 'CANCELLED' }], more: false } } };
      return { ok: true, status: 200, text: async () => JSON.stringify(corpo), json: async () => corpo }; };
    return _load.apply(this, arguments);
  };
  const { criarCanarioDaEmpresa } = require('../lib/checkout/canario-empresa');
  for (const [emp, , modShopee, loja, envKey] of EMP) {
    process.env[envKey] = 'chave-teste';
    const { pedirAoSync } = require(path.join(raiz, modShopee));
    assert.strictEqual(typeof pedirAoSync, 'function', emp + ': o módulo da Shopee não exporta pedirAoSync');
    const C = criarCanarioDaEmpresa(emp, { deps: () => ({ blingGet: async () => ({ ok: true, data: { data: [] } }), LOJA_MKT: {}, irmasDoPack: () => null, CACHE_DIR: tmp, pedirAoSync, fetch: async () => ({ ok: false }) }) });
    pedidas.length = 0;
    const agora = Math.floor(Date.now() / 1000);
    const lista = await C.listarNoMarketplace('shopee', agora - 3 * 86400, agora);
    assert.ok(Array.isArray(lista) && lista.includes('SN-' + loja) && !lista.includes('SN-CANC'), emp + ': o canário não conferiu a Shopee da empresa (veio ' + JSON.stringify(lista) + ')');
    assert.ok(pedidas.length && pedidas.every((u) => u.includes('/' + loja + '/interno/shopee-raw')), emp + ': o canário perguntou à loja errada da Shopee: ' + pedidas[0]);
  }
  Module._load = _load;
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('ok — o canário confere a Shopee nas três: cada uma entrega o pedirAoSync do módulo da Shopee dela, e a listagem pergunta à loja certa (/amb, /girassol, /good)');
  process.exit(0);
})().catch((e) => { console.error('FALHOU:', e.message); process.exit(1); });
