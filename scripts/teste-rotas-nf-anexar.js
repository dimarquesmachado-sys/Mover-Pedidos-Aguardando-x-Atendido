'use strict';
/* 16/09 — 4ª fatia do passo 4. `nf-anexar` era a MAIOR das rotas idênticas que restavam (80
   linhas) e a única com diferença real entre as empresas: o ID DA EMPRESA no aviso ao serviço
   de Devoluções. Isso é configuração, não regra — virou parâmetro. Junto vieram
   `shopee-sessao` e `ml-sync-fees`, do mesmo assunto: estado vivo das integrações. */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { criar } = require('../lib/checkout/rotas-nf-anexar');
const raiz = path.join(__dirname, '..');

const deps = {
  prefixo: '/x', empresaId: 'x', json: () => {}, readBody: async () => ({}), readJson: () => ({}),
  writeJson: () => {}, ensureDir: () => {}, ehAdmin: () => true, lerChaveAdmin: () => 'k',
  mlSyncFees: async () => ({}), shopeeKeepAlive: async () => ({}), shopeeSessaoLer: () => ({}),
  CACHE_DIR: '/tmp', MANIFEST_FILE: '/tmp/m.json', SHOPEE_ENV_COOKIE: 'X_COOKIE',
  VERSAO: 'teste', statusMlSync: { rodando: false },
};

assert.throws(() => criar({}), /falta prefixo/);
for (const faltando of ['empresaId', 'statusMlSync', 'MANIFEST_FILE', 'shopeeSessaoLer']) {
  const parcial = Object.assign({}, deps); delete parcial[faltando];
  assert.throws(() => criar(parcial), new RegExp('falta ' + faltando),
    'dependência ausente derruba na criação, não na primeira chamada');
}
assert.strictEqual(typeof criar(deps), 'function');

/* o ID DA EMPRESA no aviso ao Devoluções é parâmetro, não texto fixo — era a única diferença
   real entre as três, e deixá-la cravada faria uma empresa avisar em nome de outra */
{
  const s = fs.readFileSync(path.join(raiz, 'lib', 'checkout', 'rotas-nf-anexar.js'), 'utf8');
  assert.ok(/avisar-devolucoes'\)\(empresaId,/.test(s),
    'o aviso tem que usar o empresaId injetado — cravado, uma empresa avisaria em nome de outra');
  for (const id of ["'amb'", "'good'", "'girassol'"]) {
    assert.ok(!new RegExp("avisar-devolucoes'\\)\\(" + id).test(s), 'id de empresa cravado no aviso: ' + id);
  }
  /* estado vivo entra por referência, como na fatia do backfill */
  assert.ok(/const _mls = cfg\.statusMlSync;/.test(s), 'o status do sync tem que ser a MESMA referência');
}

/* cada empresa passa o próprio id e o próprio estado */
{
  const ids = new Set();
  for (const arq of ['amb-checkout-offline/index.js', 'girassol-backup-offline/gbo-app.js', 'good-checkout-offline/index.js']) {
    const s = fs.readFileSync(path.join(raiz, arq), 'utf8');
    /* 14/11: a ligação é a peça lib/checkout/rotas-operacao, e o id sai da configuração da empresa — confere o que a lib
       RECEBE com a ligação de hoje rodando (scripts/_rotas-operacao-ligacao.js), não mais o texto do bloco */
    const rN = require('./_rotas-operacao-ligacao').daEmpresa(arq).recebe['rotas-nf-anexar'];
    const m = rN && /^[\w-]+$/.test(String(rN.empresaId)) ? [null, rN.empresaId] : null;
    assert.ok(m, arq + ': não achei o empresaId passado');
    assert.ok(arq.startsWith(m[1] + '-'), arq + ': o empresaId não é o desta empresa: ' + m[1]);
    assert.ok(!ids.has(m[1]), 'duas empresas com o mesmo empresaId: ' + m[1]);
    ids.add(m[1]);
    assert.ok(/statusMlSync: _mls/.test(s) && rN.statusMlSync === '«_mls»', arq + ': tem que passar o estado do próprio módulo');
  }
}

/* A POSIÇÃO É PARTE DA SEGURANÇA (lição do #480) */
for (const arq of ['amb-checkout-offline/index.js', 'girassol-backup-offline/gbo-app.js', 'good-checkout-offline/index.js']) {
  const s = fs.readFileSync(path.join(raiz, arq), 'utf8');
  const portao = s.indexOf("erro: 'Sessão necessária. Faça login.'");
  /* 14/11: quem o arquivo da empresa chama agora é a peça lib/checkout/rotas-operacao (a ligação das cinco peças de rota
     da operação, uma pras três) — é ELA que tem que estar depois do portão, e é dentro dela que esta peça é chamada.
     (Com pedido de verdade, pelo routes real das três: scripts/teste-rotas-operacao-respondem.js.) */
  const delega = s.indexOf('_rotasOperacao(req, res, urlObj');
  assert.ok(portao > 0 && delega > 0, arq + ': faltou o portão ou a delegação');
  assert.ok(delega > portao, arq + ': a delegação está ANTES do portão — as rotas responderiam sem autenticação');
  assert.ok(require('fs').readFileSync(require('path').join(__dirname, '..', 'lib', 'checkout', 'rotas-operacao.js'), 'utf8').includes('if (await _rotasNfAnexar(req, res, urlObj, method, validarSessao)) return true;'), 'a peça rotas-operacao não chama mais esta peça de rota');
  for (const rota of ['nf-anexar', 'shopee-sessao', 'ml-sync-fees']) {
    assert.ok(!new RegExp("p === '/[\\w-]+/" + rota + "'").test(s), arq + ': a cópia de /' + rota + ' voltou');
  }
}

console.log('OK: rotas de NF anexada — uma lib para as três, o id da empresa é parâmetro e o estado do sync vai por referência');
