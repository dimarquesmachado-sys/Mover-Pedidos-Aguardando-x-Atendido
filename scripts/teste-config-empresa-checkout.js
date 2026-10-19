'use strict';
/* 19/10 — Fase 3 do plano multiloja: a configuração do checkout por empresa sai de UM lugar (lib/checkout/config-empresa).
   Prova de que não muda nada pras três: pra CADA combinação das 12 envs envolvidas (ligadas/desligadas), o que a peça
   lê é EXATAMENTE o que cada pasta lia à mão antes (as expressões antigas estão escritas aqui, como referência). E a
   empresa nova: sem escrever código, segue a convenção — e NUNCA cai numa env sem prefixo que é da Girassol. */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { configCheckout, URL_SHOPEE_PADRAO: D } = require('../lib/checkout/config-empresa');

const NOMES = ['MAGALU_EMPRESA', 'SHOPEE_SYNC_URL', 'SHOPEE_SYNC_KEY', 'SHOPEE_SYNC_LOJA',
  'AMBBKP_MAGALU_EMPRESA', 'AMBBKP_SHOPEE_SYNC_URL', 'AMBBKP_SHOPEE_SYNC_KEY', 'AMBBKP_SHOPEE_SYNC_LOJA',
  'GOODBKP_MAGALU_EMPRESA', 'GOODBKP_SHOPEE_SYNC_URL', 'GOODBKP_SHOPEE_SYNC_KEY', 'GOODBKP_SHOPEE_SYNC_LOJA',
  'GBO_SHOPEE_SYNC_URL', 'GBO_SHOPEE_SYNC_KEY', 'GBO_SHOPEE_SYNC_LOJA'];
/* o que cada pasta escrevia à mão até 19/10 (a referência) */
const ANTES = {
  girassol: (e) => ({ mag: e.MAGALU_EMPRESA || 'girassol', url: e.SHOPEE_SYNC_URL || D, key: e.SHOPEE_SYNC_KEY || '', loja: 'girassol' }),
  amb:      (e) => ({ mag: e.AMBBKP_MAGALU_EMPRESA || 'amb', url: e.AMBBKP_SHOPEE_SYNC_URL || D, key: e.AMBBKP_SHOPEE_SYNC_KEY || e.SHOPEE_SYNC_KEY || '', loja: e.AMBBKP_SHOPEE_SYNC_LOJA || 'amb' }),
  good:     (e) => ({ mag: e.GOODBKP_MAGALU_EMPRESA || 'good', url: e.GOODBKP_SHOPEE_SYNC_URL || e.SHOPEE_SYNC_URL || D, key: e.GOODBKP_SHOPEE_SYNC_KEY || e.SHOPEE_SYNC_KEY || '', loja: e.GOODBKP_SHOPEE_SYNC_LOJA || 'good' }),
};
/* 19/10: o que a VARREDURA DE CANCELADOS de cada pasta lia à mão (o _ctxImp da AMB e da Girassol; a GOOD não tinha) */
const ANTES_CANC = {
  girassol: (e) => ({ url: e.GBO_SHOPEE_SYNC_URL || e.SHOPEE_SYNC_URL || D, key: e.GBO_SHOPEE_SYNC_KEY || e.SHOPEE_SYNC_KEY || '', loja: e.GBO_SHOPEE_SYNC_LOJA || 'girassol' }),
  amb:      (e) => ({ url: e.AMBBKP_SHOPEE_SYNC_URL || e.SHOPEE_SYNC_URL || D, key: e.AMBBKP_SHOPEE_SYNC_KEY || e.SHOPEE_SYNC_KEY || '', loja: e.AMBBKP_SHOPEE_SYNC_LOJA || 'amb' }),
  good:     (e) => ({ url: e.GOODBKP_SHOPEE_SYNC_URL || e.SHOPEE_SYNC_URL || D, key: e.GOODBKP_SHOPEE_SYNC_KEY || e.SHOPEE_SYNC_KEY || '', loja: e.GOODBKP_SHOPEE_SYNC_LOJA || 'good' }),
};
const FIXOS = {
  girassol: { tag: 'GIRABKP', modulo: 'girassol-backup-offline', mlTokenManager: 'girassol/mlTokenManager', tiktokConta: 'girassol' },
  amb:      { tag: 'AMBBKP', modulo: 'amb-checkout-offline', mlTokenManager: 'ambtotal/mlTokenManager', tiktokConta: 'amb' },
  good:     { tag: 'GOODBKP', modulo: 'good-checkout-offline', mlTokenManager: 'good/mlTokenManager', tiktokConta: 'good' },
};
const salvo = {}; for (const n of NOMES) salvo[n] = process.env[n];
try {
  for (const [emp, antes] of Object.entries(ANTES)) {
    const c = configCheckout(emp);
    for (const [k, v] of Object.entries(FIXOS[emp])) assert.strictEqual(c[k], v, emp + ': ' + k + ' mudou');
    assert.ok(fs.existsSync(path.join(__dirname, '..', c.mlTokenManager + '.js')), emp + ': o token do ML aponta pra arquivo que não existe');
    assert.ok(fs.existsSync(path.join(__dirname, '..', c.modulo)), emp + ': a pasta do módulo não existe');
    for (let m = 0; m < (1 << NOMES.length); m++) {
      const env = {};
      NOMES.forEach((n, i) => { if (m & (1 << i)) { env[n] = 'v-' + n; process.env[n] = env[n]; } else delete process.env[n]; });
      const agora = { mag: c.ler(c.vendasDia.magEmpresa), url: c.ler(c.vendasDia.shopeeUrl), key: c.ler(c.vendasDia.shopeeKey), loja: c.ler(c.vendasDia.shopeeLoja) };
      assert.deepStrictEqual(agora, antes(env), emp + ': com as envs ' + Object.keys(env).join(',') + ' a peça leu diferente do que a pasta lia');
      const agoraC = { url: c.ler(c.cancelados.shopeeUrl), key: c.ler(c.cancelados.shopeeKey), loja: c.ler(c.cancelados.shopeeLoja) };
      assert.deepStrictEqual(agoraC, ANTES_CANC[emp](env), emp + ' (cancelados): com as envs ' + Object.keys(env).join(',') + ' a peça leu diferente do que a pasta lia');
    }
  }
  /* empresa NOVA (registro de mentira): convenção, sem código */
  const regNova = { normalizar: (x) => x, obter: (id) => (id === 'nova' ? { id: 'nova', prefixoEnv: 'NOVA_' } : null) };
  const n = configCheckout('nova', { registro: regNova });
  assert.deepStrictEqual({ tag: n.tag, modulo: n.modulo, ml: n.mlTokenManager, tk: n.tiktokConta, loja: n.loja },
    { tag: 'NOVABKP', modulo: 'nova-checkout-offline', ml: 'nova/mlTokenManager', tk: 'nova', loja: 'nova' });
  for (const k of NOMES) delete process.env[k];
  process.env.MAGALU_EMPRESA = 'girassol'; process.env.SHOPEE_SYNC_KEY = 'chave-do-servico';
  assert.strictEqual(n.ler(n.vendasDia.magEmpresa), 'nova', 'empresa nova caiu na MAGALU_EMPRESA (sem prefixo — é da Girassol)');
  assert.strictEqual(n.ler(n.vendasDia.shopeeLoja), 'nova', 'empresa nova caiu na loja da Girassol');
  assert.strictEqual(n.ler(n.vendasDia.shopeeKey), 'chave-do-servico', 'a chave do serviço da Shopee (compartilhada) tinha que valer pra empresa nova');
  process.env.NOVABKP_MAGALU_EMPRESA = 'nova-mag'; assert.strictEqual(n.ler(n.vendasDia.magEmpresa), 'nova-mag');
  delete process.env.NOVABKP_MAGALU_EMPRESA;
  assert.throws(() => configCheckout('nao-existe', { registro: regNova }), /desconhecida/);
} finally {
  for (const n of NOMES) { if (salvo[n] === undefined) delete process.env[n]; else process.env[n] = salvo[n]; }
}
console.log('ok — configuração do checkout por empresa: as 3 leem exatamente o que liam — venda do dia e cancelados — em 32.768 combinações de env cada; empresa nova pela convenção, sem cair na Girassol');
