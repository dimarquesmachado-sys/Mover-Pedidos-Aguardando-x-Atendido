'use strict';
/* 14/09 — FÁBRICA DE MÓDULO FISCAL (auditoria do Codex, P1). As rotas, os helpers e a forma
   do módulo eram o mesmo bloco nas três pastas, com prefixo e rótulo trocados; agora saem de
   lib/fiscal/criar-modulo.js e a pasta guarda só fiação e crons.
   O teste guarda o que a extração arrisca:
     • o CONTRATO com o orquestrador (id, nome, rotinas, routes, crons) — se mudar, a empresa
       some do serviço sem erro nenhum;
     • as cinco rotinas presentes: cron aponta pra nome, e nome que não existe vira rotina que
       simplesmente não acontece;
     • o PREFIXO de cada uma (o da Girassol é vazio — ela foi a primeira do serviço);
     • os crons ESCALONADOS do F3: 0, 2 e 4 são de propósito, pra não competirem por cota;
     • peça faltando derruba na fábrica, não em produção. */
const assert = require('assert');
const { criarModuloFiscal } = require('../lib/fiscal/criar-modulo');

const PECAS = [
  'rotinaExpediente', 'rotinaVirada', 'rotinaManha', 'corrigirNFsPendentes', 'retryNFManual',
  'getEstadoRetrySEFAZ', 'garantirToken', 'gerarTokenInicial', 'gerarTokenInicialNF',
  'garantirTokenNF', 'garantirTokenML', 'trocarCodigoPorToken', 'gerarUrlAutorizacao',
  'getPedidoDetalhe', 'rotinaNFeML', 'enviarNFeUnica',
];
const pecasFalsas = Object.fromEntries(PECAS.map(p => [p, async () => {}]));

assert.throws(() => criarModuloFiscal({}), /falta id/);
assert.throws(() => criarModuloFiscal({ id: 'x', nome: 'X', prefixo: '/x', rotulo: 'X', crons: {}, pecas: {} }),
  /está sem a\(s\) peça/, 'peça faltando tem que derrubar na fábrica, não em produção');

const mod = criarModuloFiscal({ id: 'x', nome: 'X', prefixo: '/x', rotulo: 'X', crons: { a: '* * * * *' }, pecas: pecasFalsas });
assert.deepStrictEqual(Object.keys(mod).sort(), ['crons', 'id', 'nome', 'rotinas', 'routes']);
assert.strictEqual(typeof mod.routes, 'function');

/* as três empresas, como o orquestrador as vê */
for (const [pasta, id, prefixo] of [['ambtotal', 'amb', '/amb'], ['good', 'good', '/good'], ['girassol', 'girassol', '']]) {
  const m = require('../' + pasta);
  assert.strictEqual(m.id, id, pasta + ': id mudou — o orquestrador identifica a empresa por ele');
  assert.ok(m.nome, pasta + ': falta nome');
  assert.strictEqual(typeof m.routes, 'function', pasta + ': routes tem que ser função');
  assert.deepStrictEqual(Object.keys(m.rotinas).sort(),
    ['corrigirNFs', 'nfeMl', 'rotinaExpediente', 'rotinaManha', 'rotinaVirada'],
    pasta + ': as cinco rotinas têm que estar presentes — cron aponta pra NOME, e nome que não existe é rotina que não acontece');
  for (const [k, v] of Object.entries(m.rotinas)) {
    assert.strictEqual(typeof v, 'function', pasta + ': a rotina ' + k + ' não é função');
  }
  /* toda chave de cron precisa ter rotina de mesmo nome (é assim que o agendador da raiz liga) */
  for (const chave of Object.keys(m.crons)) {
    assert.ok(m.rotinas[chave] || ['expediente', 'virada', 'manha'].includes(chave),
      pasta + ': o cron "' + chave + '" não tem rotina correspondente');
  }
  const fonte = require('fs').readFileSync(require('path').join(__dirname, '..', pasta, 'index.js'), 'utf8');
  assert.ok(new RegExp("prefixo: '" + prefixo + "'").test(fonte),
    pasta + ': o prefixo tem que ser exatamente "' + prefixo + '" — trocar muda a URL de todas as rotas da empresa');
}

/* o escalonamento do F3 é de propósito: 0, 2 e 4 evitam a disputa por cota */
const minutos = ['girassol', 'ambtotal', 'good'].map(p => {
  const c = require('../' + p).crons.nfeMl;
  return String(c).split(',')[0];
});
assert.strictEqual(new Set(minutos).size, 3,
  'os minutos do F3 têm que ser DIFERENTES nas três (escalonamento contra a cota do Bling): ' + minutos.join(', '));

console.log('OK: fábrica fiscal — contrato do módulo intacto nas três, cinco rotinas presentes, prefixo por empresa e F3 escalonado');
