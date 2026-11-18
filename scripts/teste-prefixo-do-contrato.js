'use strict';
/* 17/11 — NORTE C, montarCheckout, passo 20: O PREFIXO DAS ROTAS É DO CONTRATO (lib/checkout/config-empresa.prefixoDe).

   Cinco peças de rota recebiam o prefixo da empresa ESCRITO À MÃO no arquivo de cada uma: o catálogo (rotas-catalogo), as
   rotas do canário (canario-empresa.rotas), a sessão da Shopee (rotas-shopee-sessao), o plano do backfill
   (backfill-plano-empresa) e o de-para de SKU (rota-depara-sku). Agora o arquivo entrega a EMPRESA e a peça tira o prefixo
   do contrato ('/' + módulo); quem passar o prefixo (os testes antigos) fica com o seu.

   Aqui, RODANDO, nas três: cada peça montada só com a empresa responde no prefixo do contrato DELA e não no de outra; o
   prefixo escrito ainda manda quando vem; e os três arquivos entregam a empresa (nenhum prefixo escrito) às cinco. */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const raiz = path.join(__dirname, '..');
const CE = require('../lib/checkout/config-empresa');
const EMP = [['girassol', 'girassol-backup-offline', 'girassol-backup-offline/gbo-app.js'], ['amb', 'amb-checkout-offline', 'amb-checkout-offline/index.js'], ['good', 'good-checkout-offline', 'good-checkout-offline/index.js']];
const nada = () => null;
const fn = () => () => null;
process.env.ADMIN_KEY = 'adm-prefixo';

/* as cinco peças, montadas com o que vier em `quem` ({ empresa } ou { empresa, prefixo }) — devolvem (method, caminho) → tratou? */
const PECAS = {
  catalogo: (quem) => {
    const h = require('../lib/checkout/rotas-catalogo').criar(Object.assign({ json: (res, c) => { res.c = c; }, blingGet: fn(), ehAdmin: () => false, skuEanCache: {}, lerIndiceEan: fn(),
      salvarNoIndiceEan: fn(), getPossiveisGtins: fn(), produtoDetalhe: fn(), primeiraImagem: fn(), locCache: {}, localizacaoDeProduto: fn(), indexarCatalogoCompleto: fn(), getIdxStatus: () => ({}) }, quem));
    return { rota: '/indexar-catalogo', chamar: (u) => h({ headers: {} }, {}, u, 'GET') };
  },
  canario: (quem) => {
    const C = require('../lib/checkout/canario-empresa').criarCanarioDaEmpresa(quem.empresa, { deps: () => ({}), ocupado: () => ({ rodando: false }) });
    const r = C.rotas(Object.assign({ json: (res, c) => { res.c = c; }, validarSessao: nada, ehAdmin: () => false, lerChaveAdmin: () => '' }, quem.prefixo ? { PREFIXO: quem.prefixo } : {}));
    return { rota: '/canario-estado', chamar: (u) => r({ headers: {} }, {}, u, 'GET', u.pathname) };
  },
  shopeeSessao: (quem) => {
    const r = require('../lib/checkout/rotas-shopee-sessao').criar(Object.assign({ VERSAO: 'v', CACHE_DIR: os.tmpdir(), json: (res, c) => { res.c = c; }, lerChaveAdmin: () => '', validarSessao: nada,
      ehAdmin: () => false, readBody: async () => ({}), readJson: (f, p) => p, writeJson: fn(), ensureDir: fn(), fetch: async () => ({}), SHOPEE_ENV_COOKIE: 'X_SHOPEE_COOKIE',
      sessao: { shopeeSessaoLer: fn(), shopeeSessaoAtualiza: fn(), _shopeeHash: () => 'h', SHOPEE_SESSAO_FILE: path.join(os.tmpdir(), 'x.json') } }, quem.prefixo ? { PREFIXO: quem.prefixo, empresa: quem.empresa } : quem));
    return { rota: '/shopee-semear', metodo: 'POST', chamar: (u) => r({ method: 'POST', headers: {} }, {}, u, 'POST', u.pathname) };
  },
  plano: (quem) => {
    const p = require('../lib/checkout/backfill-plano-empresa').criar(Object.assign({ cacheDir: fs.mkdtempSync(path.join(os.tmpdir(), 'prefixo-plano-')), json: (res, c) => { res.c = c; },
      lerChaveAdmin: () => '', rodarFatia: async () => ({ ok: true }), ocupado: () => false, agendar: () => {} }, quem));
    return { rota: '/backfill-plano', chamar: (u) => p.rota({ headers: {} }, {}, u, 'GET', u.pathname) };
  },
  depara: (quem) => {
    const r = require('../lib/checkout/rota-depara-sku').criarRotaDeParaSku(Object.assign({ path, CACHE_DIR: os.tmpdir(), json: (res, c) => { res.c = c; }, readJson: (f, p) => p,
      validarSessao: nada, ehAdmin: () => false, lerDeParaSku: () => ({}), gravarDeParaSku: fn(), resolverDeParaSku: (s) => s, sugerirDeParaSku: () => [] }, quem));
    return { rota: '/sku-depara-manual', chamar: (u) => r({ headers: {} }, {}, u, 'GET', u.pathname) };
  },
};

(async () => {
  for (const [emp, pasta] of EMP) {
    const pref = '/' + pasta;
    assert.strictEqual(CE.prefixoDe(emp), pref, emp + ': o prefixo do contrato não é o da pasta');
    const outra = EMP.find((x) => x[0] !== emp)[1];
    for (const [nome, montar] of Object.entries(PECAS)) {
      /* só com a empresa: responde no prefixo do contrato DELA, não no de outra */
      const P = montar({ empresa: emp });
      const u = new URL('http://x' + pref + P.rota);
      assert.strictEqual(await P.chamar(u), true, emp + ' · ' + nome + ': montada só com a empresa, não respondeu no prefixo do contrato (' + pref + P.rota + ')');
      assert.strictEqual(await P.chamar(new URL('http://x/' + outra + P.rota)), false, emp + ' · ' + nome + ': respondeu no prefixo da ' + outra);
      /* o prefixo escrito ainda manda quando vem */
      const Q = montar({ empresa: emp, prefixo: '/teste-' + emp });
      assert.strictEqual(await Q.chamar(new URL('http://x/teste-' + emp + Q.rota)), true, emp + ' · ' + nome + ': o prefixo passado não foi respeitado');
      assert.strictEqual(await Q.chamar(u), false, emp + ' · ' + nome + ': com o prefixo passado, ainda respondeu no do contrato');
    }
  }
  /* empresa fora do contrato derruba */
  assert.throws(() => PECAS.catalogo({ empresa: 'empresa-que-nao-existe' }), /empresa desconhecida no contrato/);
  assert.throws(() => PECAS.plano({ empresa: 'empresa-que-nao-existe' }), /empresa desconhecida no contrato/);

  /* os três arquivos entregam a EMPRESA às cinco peças — nenhum prefixo escrito à mão nelas */
  for (const [emp, , arq] of EMP) {
    const s = fs.readFileSync(path.join(raiz, arq), 'utf8');
    const trecho = (marca, fim) => { const i = s.indexOf(marca); assert.ok(i > 0, arq + ': não achei ' + marca); return s.slice(i, s.indexOf(fim, i)); };
    const blocos = {
      catalogo: trecho("require('../lib/checkout/rotas-catalogo').criar({", '});'),
      shopeeSessao: trecho("require('../lib/checkout/rotas-shopee-sessao').criar({", '}),'),
      plano: trecho("require('../lib/checkout/backfill-plano-empresa').criar({", '\n});'),
      depara: trecho("require('../lib/checkout/rota-depara-sku').criarRotaDeParaSku({", '\n});'),
    };
    for (const [nome, b] of Object.entries(blocos)) {
      assert.ok(new RegExp("\\bempresa: '" + emp + "',").test(b), arq + ' · ' + nome + ": não entrega a empresa dela ('" + emp + "')");
      assert.ok(!/\bprefixo:|\bPREFIXO:/.test(b), arq + ' · ' + nome + ': voltou a escrever o prefixo à mão');
    }
    assert.ok(/\.rotas\(\{ json, validarSessao, ehAdmin, lerChaveAdmin \}\)\(req, res, urlObj, method, p\)/.test(s), arq + ': as rotas do canário voltaram a receber o prefixo escrito');
    assert.ok(new RegExp("criarCanarioDaEmpresa\\('" + emp + "', \\{").test(s), arq + ': o canário não é o da empresa dela');
  }
  console.log('ok — o prefixo das rotas é do contrato: catálogo, canário, sessão da Shopee, plano do backfill e de-para de SKU, montados só com a empresa, nas três');
  process.exit(0);
})().catch((e) => { console.error('FALHOU:', e.message); process.exit(1); });
