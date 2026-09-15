'use strict';
/* 15/09 — O TESTE QUE IMPEDE A SUGESTÃO DE MENTIR. Eu montava os nomes das envs juntando um
   prefixo com um sufixo que eu inventei, e o resultado NÃO EXISTIA no código:

     sugeri AMBBKP_SITUACAO_ATENDIDO  ·  o código lê AMBBKP_SIT_ATENDIDO
     sugeri AMBBKP_ME_LOJA_IDS        ·  o código lê AMB_ME_LOJA_IDS

   São dois espaços de nome no mesmo serviço: o checkout usa AMBBKP_ e o módulo fiscal usa
   AMB_ (a Girassol, no fiscal, não usa prefixo). Colar env errada é PIOR que não colar — o
   dono acha que configurou, o valor continua o herdado, e o sintoma aparece como pedido que
   o F1 ignora, sem erro nenhum.
   Este teste compara cada nome que a rota SUGERE com o nome que o código REALMENTE lê. */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const raiz = path.join(__dirname, '..');
const ler = (p) => fs.readFileSync(path.join(raiz, p), 'utf8');

const EMPRESAS = [
  { entrypoint: 'amb-checkout-offline/index.js', base: 'amb-checkout-offline/base.js', fiscal: 'ambtotal/blingApi.js' },
  { entrypoint: 'good-checkout-offline/index.js', base: 'good-checkout-offline/base.js', fiscal: 'good/blingApi.js' },
  { entrypoint: 'girassol-backup-offline/gbo-app.js', base: 'girassol-backup-offline/base.js', fiscal: 'girassol/blingApi.js' },
];

for (const e of EMPRESAS) {
  const ep = ler(e.entrypoint);
  const m = /envNomes:\s*(\{[^}]*\})/.exec(ep);
  assert.ok(m, e.entrypoint + ': não achei o envNomes — sem ele a rota não sugere nada');
  const nomes = JSON.parse(m[1]);

  const base = ler(e.base);
  const fiscal = ler(e.fiscal);

  /* cada nome sugerido tem que aparecer em quem o LÊ */
  const ondeVive = {
    atendido: [base], despachados: [base], verificado: [base],
    aguardando: [fiscal], meLojaIds: [fiscal],
  };
  for (const [chave, nome] of Object.entries(nomes)) {
    const fontes = ondeVive[chave];
    assert.ok(fontes, e.entrypoint + ': chave desconhecida em envNomes: ' + chave);
    const achou = fontes.some(f => f.includes(nome));
    assert.ok(achou, e.entrypoint + ': a rota sugeriria "' + nome + '", mas NENHUM código lê essa env — ' +
      'colar isso faria o dono achar que configurou enquanto o valor segue o padrão herdado');
  }
}

/* e o inverso: a env do canal do ML tem que estar coberta nas três, porque é a que, errada,
   faz o F1 ignorar TODOS os pedidos da empresa em silêncio */
for (const e of EMPRESAS) {
  const nomes = JSON.parse(/envNomes:\s*(\{[^}]*\})/.exec(ler(e.entrypoint))[1]);
  assert.ok(nomes.meLojaIds, e.entrypoint + ': falta sugerir a env do canal do ML');
  assert.ok(ler(e.fiscal).includes("envMeLojaIds: '" + nomes.meLojaIds + "'"),
    e.entrypoint + ': o nome sugerido pro canal do ML não é o que o blingApi desta empresa lê');
}

console.log('OK: as envs sugeridas EXISTEM — cada nome confere com o que o código daquela empresa realmente lê');
