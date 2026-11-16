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

/* 15/11: os nomes que a rota sugere saíram do arquivo da empresa pra lib/checkout/config-empresa (descobrirIds.envNomes),
   lidos pela cabeça comum do routes (lib/checkout/cabeca-routes) — o teste lê de lá, e confere que a cabeça passa exatamente isso */
const { configCheckout } = require('../lib/checkout/config-empresa');
const EMPRESAS = [
  { id: 'amb', entrypoint: 'amb-checkout-offline/index.js', base: 'amb-checkout-offline/base.js', fiscal: 'ambtotal/blingApi.js' },
  { id: 'good', entrypoint: 'good-checkout-offline/index.js', base: 'good-checkout-offline/base.js', fiscal: 'good/blingApi.js' },
  { id: 'girassol', entrypoint: 'girassol-backup-offline/gbo-app.js', base: 'girassol-backup-offline/base.js', fiscal: 'girassol/blingApi.js' },
];
assert.ok(/envNomes: di\.envNomes,/.test(ler('lib/checkout/cabeca-routes.js')), 'a cabeça comum tem que passar os envNomes da configuração ao /descobrir-ids');
const nomesDe = (e) => { const n = configCheckout(e.id).descobrirIds.envNomes; assert.ok(n && Object.keys(n).length, e.entrypoint + ': não achei o envNomes — sem ele a rota não sugere nada'); return n; };

for (const e of EMPRESAS) {
  assert.ok(ler(e.entrypoint).includes("require('../lib/checkout/cabeca-routes').criar('" + e.id + "', {"), e.entrypoint + ': a rota /descobrir-ids tem que vir da cabeça comum, com o id da empresa');
  const nomes = nomesDe(e);

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
  const nomes = nomesDe(e);
  assert.ok(nomes.meLojaIds, e.entrypoint + ': falta sugerir a env do canal do ML');
  assert.ok(ler(e.fiscal).includes("envMeLojaIds: '" + nomes.meLojaIds + "'"),
    e.entrypoint + ': o nome sugerido pro canal do ML não é o que o blingApi desta empresa lê');
}

console.log('OK: as envs sugeridas EXISTEM — cada nome confere com o que o código daquela empresa realmente lê');
