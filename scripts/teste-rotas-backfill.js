'use strict';
/* 16/09 — terceira fatia do passo 4: as rotas de backfill do histórico. Três rotas de corpo
   idêntico nas três empresas e coesas: completar o detalhe do pedido, a NF e os valores — os
   três buracos que o histórico deixa quando a venda entra sem um dado que só aparece depois.
   Escolhida com o critério dos DOIS lados: corpo igual (diferença zero) E todas depois do
   portão de sessão nas três. */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { criar } = require('../lib/checkout/rotas-backfill');

const deps = {
  prefixo: '/x', json: () => {}, readJson: () => ({}), writeJson: () => {},
  ehAdmin: () => true, lerChaveAdmin: () => 'k', detalhePedido: async () => ({}),
  backfillNFLocal: async () => ({}), dorme: async () => {}, CONFERIDOS_FILE: '/tmp/c.json',
  statusValores: { rodando: false }, statusDetalhes: { rodando: false },
};

assert.throws(() => criar({}), /falta prefixo/);
for (const faltando of ['statusValores', 'statusDetalhes', 'CONFERIDOS_FILE', 'backfillNFLocal']) {
  const parcial = Object.assign({}, deps); delete parcial[faltando];
  assert.throws(() => criar(parcial), new RegExp('falta ' + faltando),
    'dependência ausente derruba na criação, não na primeira chamada');
}
assert.strictEqual(typeof criar(deps), 'function');

/* O ESTADO ENTRA POR REFERÊNCIA — foi o que o lint pegou nesta fatia. `_bf` e `_bfd` não são
   valores: são objetos de status VIVOS que as rotas leem e escrevem enquanto o backfill roda.
   Extrair as funções sem eles seria o mesmo erro do base.js (levar a função e deixar o que
   ela lê), e copiá-los faria a rota reportar um progresso que não é o do backfill de verdade. */
{
  const estado = { rodando: false, feitos: 0 };
  criar(Object.assign({}, deps, { statusValores: estado }));
  estado.feitos = 7;
  const fonte = fs.readFileSync(path.join(__dirname, '..', 'lib', 'checkout', 'rotas-backfill.js'), 'utf8');
  assert.ok(/const _bf = cfg\.statusValores;/.test(fonte), 'o status tem que ser a MESMA referência, não uma cópia');
  assert.ok(!/Object\.assign\(\{\}, cfg\.statusValores\)/.test(fonte), 'copiar o status faria a rota reportar progresso falso');
}

/* cada empresa passa o PRÓPRIO estado: dois backfills não podem dividir contador */
{
  const vistos = new Set();
  for (const arq of ['amb-checkout-offline/index.js', 'girassol-backup-offline/gbo-app.js', 'good-checkout-offline/index.js']) {
    const s = fs.readFileSync(path.join(__dirname, '..', arq), 'utf8');
    assert.ok(/statusValores: _bf, statusDetalhes: _bfd/.test(s), arq + ': tem que passar o estado do próprio módulo');
    /* 14/11: a ligação é a peça lib/checkout/rotas-operacao, e o prefixo sai da configuração da empresa — confere o que
       a lib de backfill RECEBE com a ligação de hoje rodando (scripts/_rotas-operacao-ligacao.js): o estado é o `_bf` /
       `_bfd` do arquivo da empresa (a sentinela diz de qual peça veio) e o prefixo é o dela, diferente das outras */
    const rB = require('./_rotas-operacao-ligacao').daEmpresa(arq).recebe['rotas-backfill'];
    assert.ok(rB && rB.statusValores === '«_bf»' && rB.statusDetalhes === '«_bfd»', arq + ': a lib de backfill não recebe o estado do próprio módulo');
    const m = /^\/([\w-]+)$/.exec(String(rB.prefixo));
    assert.ok(m && arq.startsWith(m[1] + '/'), arq + ': não achei o prefixo da lib de backfill (ou não é o da pasta dela): ' + rB.prefixo);
    assert.ok(!vistos.has(m[1]), 'duas empresas com o mesmo prefixo: ' + m[1]);
    vistos.add(m[1]);
  }
}

/* A POSIÇÃO É PARTE DA SEGURANÇA (lição do #480) */
for (const arq of ['amb-checkout-offline/index.js', 'girassol-backup-offline/gbo-app.js', 'good-checkout-offline/index.js']) {
  const s = fs.readFileSync(path.join(__dirname, '..', arq), 'utf8');
  /* 15/11: o portão e as delegações moram na CABEÇA COMUM (lib/checkout/cabeca-routes), que o arquivo da empresa monta e chama
     PRIMEIRO no tratador — a ordem é conferida na peça (com pedido de verdade: scripts/teste-cabeca-routes.js) */
  assert.ok(/cabeca-routes'\)\.criar\('[a-z]+', \{/.test(s) && s.includes('cabeca: _cabeca,'), arq + ': não monta/chama a cabeça comum');
  const cab = fs.readFileSync(path.join(__dirname, '..', 'lib', 'checkout', 'cabeca-routes.js'), 'utf8');
  const portao = cab.indexOf('portao(req, res, rota, urlObj)');
  /* 14/11: quem o arquivo da empresa chama agora é a peça lib/checkout/rotas-operacao (a ligação das cinco peças de rota
     da operação, uma pras três) — é ELA que tem que estar depois do portão, e é dentro dela que esta peça é chamada.
     (Com pedido de verdade, pelo routes real das três: scripts/teste-rotas-operacao-respondem.js.) */
  const delega = cab.indexOf('rotasOperacao(req, res, urlObj, m)');
  assert.ok(portao > 0 && delega > 0, arq + ': faltou o portão ou a delegação');
  assert.ok(delega > portao, arq + ': a delegação está ANTES do portão — as rotas responderiam sem autenticação');
  assert.ok(require('fs').readFileSync(require('path').join(__dirname, '..', 'lib', 'checkout', 'rotas-operacao.js'), 'utf8').includes('if (await _rotasBackfill(req, res, urlObj, method, validarSessao)) return true;'), 'a peça rotas-operacao não chama mais esta peça de rota');
  for (const rota of ['backfill-detalhes', 'backfill-nf', 'backfill-valores']) {
    assert.ok(!new RegExp("p === '/[\\w-]+/" + rota + "'").test(s),
      arq + ': a cópia de /' + rota + ' voltou — é por aí que a divergência retorna');
  }
}

console.log('OK: rotas de backfill — uma lib para as três, estado vivo por referência e por empresa, e a delegação depois do portão');
