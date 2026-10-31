'use strict';
/* 31/10 — passo 2 do DIAGNÓSTICO em peça única (lib/checkout/diagnostico-empresa): a AMB e a GOOD GANHAM as rotas que só a
   Girassol tinha (sondas do ML/Mercado Pago/Bling, raio-X da venda ML, custo, NF de emissão, vendas cruas). A peça é chamada
   POR ÚLTIMO no handler delas: as rotas de raio-X que elas já tinham no arquivo continuam valendo primeiro. Prova:
   · cada uma monta a peça com o prefixo, a empresa, os módulos e o token do ML DELA, dentro do routes, e chama no fim do
     handler, logo antes do "não tratou";
   · o handler da peça atende a rota no prefixo DELA (uma que só a peça tem: /sonda-mp) — sem admin, 404; com a chave de
     admin e sem o token do Mercado Pago, avisa o token DA EMPRESA (MP_ACCESS_TOKEN_AMB / _GOOD — antes era fixo na Girassol);
   · nada fixo da Girassol no código da peça. */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const raiz = path.join(__dirname, '..');
const codigo = require('./_codigo-ciclo');
const EMP = [
  ['AMB', 'amb-checkout-offline', 'amb-diagnostico.js', 'amb', "require('../ambtotal/mlTokenManager')", 'supaCfg, readBody });'],
  ['GOOD', 'good-checkout-offline', 'good-diagnostico.js', 'good', "require('../good/mlTokenManager')", 'supaCfg: (empresa) => _supaGood.cfg(empresa), readBody });'],
];
(async () => {
  for (const [nome, pasta, arq, emp, ml, ctxFim] of EMP) {
    const w = fs.readFileSync(path.join(raiz, pasta, arq), 'utf8');
    assert.ok(w.includes("prefixo: '/" + pasta + "', empresa: '" + emp + "',") && w.includes(ml), nome + ': o diagnóstico não é montado com a configuração dela');
    const s = fs.readFileSync(path.join(raiz, pasta, 'index.js'), 'utf8');
    assert.ok(s.includes("const diag = require('./" + arq.replace('.js', '') + "').rotasDiagnostico({ VERSAO, validarSessao, " + ctxFim), nome + ': o routes não monta o diagnóstico');
    const iD = s.indexOf('    if (await diag(req, res, urlObj)) return true;'), iF = s.indexOf('    return false; // não tratou');
    assert.ok(iD > 0 && iF > iD && !/p ===|p\.startsWith/.test(s.slice(iD, iF)), nome + ': o diagnóstico não é a ÚLTIMA coisa do handler');
    // o handler da peça, no prefixo dela
    const mod = require(path.join(raiz, pasta, arq));
    const respostas = [];
    const json = (res, code, o) => respostas.push({ code, o });
    const h = mod.rotasDiagnostico({ VERSAO: 'x', validarSessao: () => null, supaCfg: () => ({ url: 'http://s', key: 'k' }), readBody: async () => ({}) });
    const res = { _c: 0, _b: '', writeHead(c) { this._c = c; }, setHeader() {}, end(b) { this._b += String(b || ''); } };
    const u = new URL('http://x/' + pasta + '/sonda-mp?pid=1');
    const tratou = await h({ method: 'GET', url: u.pathname + u.search, headers: {} }, res, u);
    assert.ok(tratou === true && (res._c === 404 || /not found/.test(res._b)), nome + ': a sonda do Mercado Pago não respondeu no prefixo dela (ou não barrou quem não é admin): ' + res._c);
    process.env.ADMIN_KEY = 'adm-teste'; delete process.env['MP_ACCESS_TOKEN_' + emp.toUpperCase()];
    const u2 = new URL('http://x/' + pasta + '/sonda-mp?pid=1&k=adm-teste');
    const res2 = { _c: 0, _b: '', writeHead(c) { this._c = c; }, setHeader() {}, end(b) { this._b += String(b || ''); } };
    await h({ method: 'GET', url: u2.pathname + u2.search, headers: {} }, res2, u2);
    assert.ok(res2._b.includes('MP_ACCESS_TOKEN_' + emp.toUpperCase()) && !res2._b.includes('MP_ACCESS_TOKEN_GIRASSOL'), nome + ': o aviso não é do token do Mercado Pago DELA: ' + res2._b.slice(0, 160));
    const u3 = new URL('http://x/' + pasta + '/nao-existe');
    assert.strictEqual(await h({ method: 'GET', url: u3.pathname, headers: {} }, res, u3), false, nome + ': rota que não é do diagnóstico tinha que passar adiante');
  }
  const presa = codigo(fs.readFileSync(path.join(raiz, 'lib', 'checkout', 'diagnostico-empresa.js'), 'utf8')).filter((l) => /girassol/i.test(l));
  assert.deepStrictEqual(presa, [], 'sobrou Girassol fixa no código da peça: ' + JSON.stringify(presa).slice(0, 200));
  console.log('ok — diagnóstico nas três: AMB e GOOD montam a peça com a configuração delas e chamam por último; a sonda do Mercado Pago responde no prefixo e com o token de cada uma');
  process.exit(0);
})().catch((e) => { console.error('FALHOU:', e.message); process.exit(1); });
