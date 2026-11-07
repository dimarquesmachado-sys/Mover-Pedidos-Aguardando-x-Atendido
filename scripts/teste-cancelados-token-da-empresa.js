'use strict';
/* 05/11 — OS CANCELADOS DE CADA EMPRESA USAM O TOKEN DO BLING DELA (auditoria do Codex no SHA 208fdb7d, achado F05). A AMB e
   a Girassol importavam o gerenciador de token do Bling da GOOD (`../good/tokenManager`) e o entregavam à varredura de
   cancelados — que chama garantirToken() antes de consultar o Bling: com o token da GOOD vencido (ou a GOOD desligada),
   a AMB e a Girassol perdiam a fase do Bling sem nada errado com o Bling delas. Prova, por empresa:
   · o garantirToken entregue à varredura de cancelados vem do MESMO gerenciador de token que a base da empresa usa pro
     Bling (ambtotal / girassol / good) — nunca o de outra empresa;
   · de verdade: com o token da GOOD QUEBRANDO, o garantirToken que a AMB e a Girassol carregam continua respondendo (é o
     delas), e o da GOOD é o da GOOD. */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const Module = require('module');
const raiz = path.join(__dirname, '..');

const EMP = [['amb', 'amb-checkout-offline/index.js', 'amb-checkout-offline/base.js'], ['girassol', 'girassol-backup-offline/gbo-app.js', 'girassol-backup-offline/base.js'], ['good', 'good-checkout-offline/index.js', 'good-checkout-offline/base.js']];
const tokenDe = (s) => { const m = /const \{ garantirToken \} = require\('\.\.\/([a-z]+)\/tokenManager'\);/.exec(s); return m ? m[1] : null; };
for (const [emp, arqIdx, arqBase] of EMP) {
  const idx = fs.readFileSync(path.join(raiz, arqIdx), 'utf8');
  const base = fs.readFileSync(path.join(raiz, arqBase), 'utf8');
  const i = idx.indexOf("require('../lib/checkout/cancelados-empresa').criarCanceladosDaEmpresa('" + emp + "'");
  assert.ok(i > 0, emp + ': não achei a montagem da varredura de cancelados');
  assert.ok(/deps: \(\) => \(\{[^\n]*\bgarantirToken\b/.test(idx.slice(i, i + 600)), emp + ': a varredura de cancelados não recebe garantirToken');
  const doIndex = tokenDe(idx), daBase = tokenDe(base);
  assert.ok(daBase, emp + ': não achei o token do Bling da base');
  assert.strictEqual(doIndex, daBase, emp + ': a varredura de cancelados usa o token do Bling de "' + doIndex + '", mas o Bling da empresa é o de "' + daBase + '"');
}
/* de verdade: o token da GOOD quebrando não derruba o da AMB nem o da Girassol (o require resolve o módulo de cada uma) */
const pedidos = [];
const _load = Module._load;
Module._load = function (req, parent) {
  const alvo = /\/(ambtotal|girassol|good)\/tokenManager$/.exec(req.replace(/\.js$/, ''));
  if (alvo && parent && /amb-checkout-offline|girassol-backup-offline|good-checkout-offline/.test(parent.filename || '')) {
    pedidos.push(alvo[1]);
    return { garantirToken: async () => { if (alvo[1] === 'good') throw new Error('token da GOOD vencido'); return 'tk-' + alvo[1]; } };
  }
  return _load.apply(this, arguments);
};
(async () => {
  for (const [emp, arqIdx] of EMP.slice(0, 2)) {
    const src = fs.readFileSync(path.join(raiz, arqIdx), 'utf8');
    const linha = /const \{ garantirToken \} = require\('\.\.\/[a-z]+\/tokenManager'\);/.exec(src)[0];
    const m = new Module(path.join(raiz, arqIdx), null); m.filename = path.join(raiz, arqIdx); m.paths = Module._nodeModulePaths(path.dirname(m.filename));
    m._compile(linha + '\nmodule.exports = garantirToken;', m.filename);
    const tk = await m.exports();
    assert.strictEqual(tk, 'tk-' + (emp === 'amb' ? 'ambtotal' : 'girassol'), emp + ': o token entregue aos cancelados não é o do Bling da empresa');
  }
  Module._load = _load;
  console.log('ok — os cancelados de cada empresa usam o token do Bling dela (o mesmo da base); o token da GOOD quebrando não derruba a AMB nem a Girassol');
  process.exit(0);
})().catch((e) => { console.error('FALHOU:', e.message); process.exit(1); });
