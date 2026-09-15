'use strict';
/* 15/09 — segunda fatia do passo 4: separação e localização. Seis rotas de corpo idêntico
   nas três empresas e coesas de verdade — localização física do produto, log de quem mudou o
   quê, montagem da separação, e o par reservar/liberar que impede dois estoquistas de pegarem
   o mesmo pedido.
   Esta fatia foi escolhida com o critério CORRIGIDO depois do P1 do #480: além do corpo
   igual, conferi que as seis ficam DEPOIS do portão de sessão nas três empresas. */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { criar } = require('../lib/checkout/rotas-separacao');

const deps = {
  prefixo: '/x', json: () => {}, readBody: async () => ({}), readJson: () => ({}), writeJson: () => {},
  blingGet: async () => ({}), blingWrite: async () => ({}), lerReservas: () => ({}),
  locCache: {}, localizacaoDeProduto: () => null, salvarLoc: () => {},
  montarSeparacao: async () => [], montarSeparacaoPorPedido: async () => [],
  RESERVAS_FILE: '/tmp/r.json', LOC_LOG_FILE: '/tmp/l.json',
};

assert.throws(() => criar({}), /falta prefixo/);
for (const faltando of ['lerReservas', 'montarSeparacao', 'RESERVAS_FILE']) {
  const parcial = Object.assign({}, deps); delete parcial[faltando];
  assert.throws(() => criar(parcial), new RegExp('falta ' + faltando),
    'dependência ausente derruba na criação, não na primeira chamada');
}
assert.strictEqual(typeof criar(deps), 'function');

/* A POSIÇÃO É PARTE DA SEGURANÇA — a lição do #480, aplicada aqui desde o começo.
   Sem este teste, a delegação pode subir num refactor e as seis rotas passam a responder sem
   autenticação, sem nada quebrar e sem nada logar. */
for (const arq of ['amb-checkout-offline/index.js', 'girassol-backup-offline/gbo-app.js', 'good-checkout-offline/index.js']) {
  const s = fs.readFileSync(path.join(__dirname, '..', arq), 'utf8');
  const portao = s.indexOf("erro: 'Sessão necessária. Faça login.'");
  const delega = s.indexOf('_rotasSeparacao(req, res, urlObj');
  assert.ok(portao > 0 && delega > 0, arq + ': faltou o portão ou a delegação');
  assert.ok(delega > portao, arq + ': a delegação está ANTES do portão — as rotas responderiam sem autenticação');

  /* e nenhuma cópia pode voltar pras pastas */
  for (const rota of ['salvar-localizacao', 'localizacoes-log', 'separacao-por-pedido', 'reservar', 'liberar']) {
    assert.ok(!new RegExp("p === '/[\\w-]+/" + rota + "'").test(s),
      arq + ': a cópia de /' + rota + ' voltou — é por aí que a divergência retorna');
  }
}

console.log('OK: rotas de separação — uma lib para as três, dependência ausente derruba na criação e a delegação fica depois do portão');
