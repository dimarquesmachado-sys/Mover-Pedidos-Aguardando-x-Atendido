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
    const m = /_rotasNfAnexar = require[\s\S]{0,200}?empresaId: '([\w-]+)'/.exec(s);
    assert.ok(m, arq + ': não achei o empresaId passado');
    assert.ok(!ids.has(m[1]), 'duas empresas com o mesmo empresaId: ' + m[1]);
    ids.add(m[1]);
    assert.ok(/statusMlSync: _mls/.test(s), arq + ': tem que passar o estado do próprio módulo');
  }
}

/* A POSIÇÃO É PARTE DA SEGURANÇA (lição do #480) */
for (const arq of ['amb-checkout-offline/index.js', 'girassol-backup-offline/gbo-app.js', 'good-checkout-offline/index.js']) {
  const s = fs.readFileSync(path.join(raiz, arq), 'utf8');
  const portao = s.indexOf("erro: 'Sessão necessária. Faça login.'");
  const delega = s.indexOf('_rotasNfAnexar(req, res, urlObj');
  assert.ok(portao > 0 && delega > 0, arq + ': faltou o portão ou a delegação');
  assert.ok(delega > portao, arq + ': a delegação está ANTES do portão — as rotas responderiam sem autenticação');
  for (const rota of ['nf-anexar', 'shopee-sessao', 'ml-sync-fees']) {
    assert.ok(!new RegExp("p === '/[\\w-]+/" + rota + "'").test(s), arq + ': a cópia de /' + rota + ' voltou');
  }
}

console.log('OK: rotas de NF anexada — uma lib para as três, o id da empresa é parâmetro e o estado do sync vai por referência');
