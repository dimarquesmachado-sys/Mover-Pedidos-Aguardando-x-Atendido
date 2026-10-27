'use strict';
/* 26/10 — os CANCELAMENTOS DA MAGALU: a Girassol e a AMB coletam toda madrugada (desde 30/08); a GOOD só tinha a rota que
   LÊ a coleta, então o card dela dependia de alguém rodar na mão. Prova: a GOOD agenda a coleta 1x/dia FORA do galpão,
   com a MESMA função e a mesma janela das outras (magalu-oauth.coletarCancelados(empresa, 120)) e a chave dela ('good');
   as duas madrugadas seguem coletando; e a função aceita a GOOD (a lista de empresas vem do registro). */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const raiz = path.join(__dirname, '..');

const gs = fs.readFileSync(path.join(raiz, 'good-checkout-offline', 'index.js'), 'utf8');
/* 27/10: a coleta da GOOD roda na MADRUGADA ÚNICA (a etapa dos cancelamentos da Magalu, com a empresa dela) */
assert.ok(/_noturnaGood = require\('\.\.\/lib\/checkout\/noturna-empresa'\)\.criarNoturna\(\{\s*\n\s*empresa: 'good', prefixo: '\/good-checkout-offline',/.test(gs) && /noturna: \(\) => _noturnaGood\.rotinaNoturna\('cron'\)/.test(gs) && /noturna: '0 4 \* \* \*'/.test(gs), 'a GOOD não roda a madrugada (onde fica a coleta dos cancelamentos da Magalu)');
assert.ok(/p === '\/good-checkout-offline\/magalu-cancelados'/.test(gs), 'a GOOD perdeu a rota que lê os cancelamentos');
for (const [arq, emp] of [['girassol-backup-offline/noturna.js', 'girassol'], ['amb-checkout-offline/amb-noturna.js', 'amb']]) {
  const s = (/noturna\.js$/.test(arq) ? require('./_fonte-noturna').fonteNoturna(arq) : fs.readFileSync(path.join(raiz, arq), 'utf8'));
  assert.ok(new RegExp("magalu\\.coletarCancelados\\('" + emp + "', DIAS_MG\\)").test(s), arq + ': a madrugada parou de coletar');
}
const mo = require('../magalu-oauth');
assert.ok(typeof mo.coletarCancelados === 'function' && mo.EMPRESAS_VALIDAS.includes('good'), 'a coleta da Magalu não aceita a GOOD');
console.log('ok — cancelamentos da Magalu: a GOOD coleta 1x/dia fora do galpão, como a Girassol e a AMB');
process.exit(0);   /* o módulo da Magalu agenda o cron das NFs ao carregar — sem isto o processo não termina */
