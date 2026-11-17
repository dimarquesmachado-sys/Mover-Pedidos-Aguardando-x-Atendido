'use strict';
/* 26/10 — a madrugada virou a peça única lib/checkout/noturna-empresa. 17/11 (montarCheckout, passo 12): o CONTEXTO dela
   também — os embrulhos de uma linha (girassol-backup-offline/noturna.js, amb-checkout-offline/amb-noturna.js) saíram e
   cada arquivo de entrada monta a madrugada pela peça: `require('../lib/checkout/noturna-empresa').criar({ empresa: 'x', … })`.
   Os testes que conferem o TEXTO da madrugada de uma empresa leem por aqui:
     · `montagem(emp)` — o bloco do arquivo da empresa que monta a madrugada pela peça (lança se o arquivo não monta);
     · `fonteNoturnaDe(emp)` — o texto da peça "como ficaria" naquela empresa (EMP e PREFIXO trocados pelos dela, o
       prefixo do contrato), depois de conferir que o arquivo dela monta a madrugada pela peça. */
const fs = require('fs');
const path = require('path');
const raiz = path.join(__dirname, '..');
const ARQ = { girassol: 'girassol-backup-offline/gbo-app.js', amb: 'amb-checkout-offline/index.js', good: 'good-checkout-offline/index.js' };
const INICIO = "require('../lib/checkout/noturna-empresa').criar({\n  empresa: '";
function montagem(emp) {
  if (!ARQ[emp]) throw new Error('_fonte-noturna: empresa sem arquivo de entrada conhecido: ' + emp);
  const s = fs.readFileSync(path.join(raiz, ARQ[emp])).toString('utf8');   /* cru (o _gbo-com-motor troca o texto lido com 'utf8') */
  const i0 = s.indexOf(INICIO + emp + "',");
  if (i0 < 0 || s.indexOf(INICIO, i0 + 1) >= 0) throw new Error(ARQ[emp] + ': não monta a madrugada pela peça (exatamente uma vez) com a empresa dela');
  const i1 = s.indexOf('\n});\n', i0);
  return s.slice(i0, i1 + 4);
}
function fonteNoturnaDe(emp) {
  montagem(emp);
  const pref = '/' + require('../lib/checkout/config-empresa').configCheckout(emp).modulo;
  const peca = fs.readFileSync(path.join(raiz, 'lib', 'checkout', 'noturna-empresa.js'), 'utf8');
  return peca.replace(/PREFIXO \+ '/g, "'" + pref).replace(/\bEMP\b(?![A-Z_])/g, "'" + emp + "'");
}
/* peças de mentira completas pra montar a madrugada pela peça num teste (`troca` substitui as que o teste quer olhar) */
function pecasFalsas(troca) {
  const nada = async () => ({ ok: true });
  return Object.assign({
    backfill: { backfillVendas: nada, resgatarHistorico: nada }, canario: { conferir: nada, consertar: nada }, cancelados: { varrerCancelados: nada },
    mlBilling: { mlBillingSync: nada }, vendasDia: { mlSyncFees: nada }, shopee: { pedirAoSync: nada, coletarDevolucoes: nada, coletarCarteira: nada },
    tiktokFinanceiro: nada, tiktokCompletar: nada, canarioCron: nada, podarExpedicao: null,
    CACHE_DIR: null, readJson: (f, p) => p, writeJson: () => {}, VERSAO: 'v-teste', validarSessao: () => null, ehAdmin: () => false, json: (res, c, b) => { res.c = c; res.b = b; },
  }, troca || {});
}
module.exports = { montagem, fonteNoturnaDe, pecasFalsas, ARQ };
