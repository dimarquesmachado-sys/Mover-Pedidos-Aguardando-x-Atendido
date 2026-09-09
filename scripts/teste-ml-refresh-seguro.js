'use strict';
/* Regressão da janela de corte multiempresa (auditoria Codex 09/09 + fato de campo do
   Devoluções): sonda 429/5xx é TRANSITÓRIA e não pode consumir o refresh de uso único;
   401 E 403 são vencimento provado (o ML responde 403 com token vencido — documentado
   em produção no Devoluções desde março) e renovam exatamente uma vez.
   Rodar: node scripts/teste-ml-refresh-seguro.js */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const fetchPath = require.resolve('node-fetch');
const fetchOriginal = require('node-fetch');
const casos = [
  { modulo: '../girassol/mlTokenManager', prefixo: '', rotulo: 'Girassol' },
  { modulo: '../good/mlTokenManager', prefixo: 'GOOD_', rotulo: 'GOOD' },
  { modulo: '../ambtotal/mlTokenManager', prefixo: 'AMB_', rotulo: 'AMB' },
];

async function testar(caso) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ml-refresh-seguro-'));
  const arquivo = path.join(dir, 'tokens.json');
  const escrever = () => fs.writeFileSync(arquivo, JSON.stringify({ access_token: 'access-velho', refresh_token: 'refresh-unico' }));
  escrever();
  process.env[caso.prefixo + 'ML_TOKEN_FILE'] = arquivo;
  process.env[caso.prefixo + 'ML_CLIENT_ID'] = 'cliente';
  process.env[caso.prefixo + 'ML_CLIENT_SECRET'] = 'segredo';

  let statusSonda = 503;
  let postsOAuth = 0;
  require.cache[fetchPath].exports = async (url, opcoes) => {
    if (String(url).endsWith('/users/me')) return { ok: false, status: statusSonda };
    postsOAuth++;
    assert.strictEqual(opcoes.method, 'POST');
    return { ok: true, status: 200, json: async () => ({ access_token: 'access-novo', refresh_token: 'refresh-novo' }) };
  };

  const moduloPath = require.resolve(caso.modulo);
  delete require.cache[moduloPath];
  const manager = require(caso.modulo);

  await assert.rejects(manager.garantirTokenML(), /HTTP 503.*refresh preservado/, caso.rotulo + ': 5xx preserva o refresh');
  assert.strictEqual(postsOAuth, 0, caso.rotulo + ': 5xx disparou OAuth indevidamente');

  statusSonda = 429;
  await assert.rejects(manager.garantirTokenML(), /HTTP 429.*refresh preservado/, caso.rotulo + ': 429 preserva o refresh');
  assert.strictEqual(postsOAuth, 0, caso.rotulo + ': 429 disparou OAuth indevidamente');

  statusSonda = 403;
  assert.strictEqual(await manager.garantirTokenML(), 'access-novo', caso.rotulo + ': 403 é vencimento provado (fato do ML) e RENOVA');
  assert.strictEqual(postsOAuth, 1, caso.rotulo + ': 403 renovou exatamente uma vez');

  escrever(); postsOAuth = 0;
  statusSonda = 401;
  assert.strictEqual(await manager.garantirTokenML(), 'access-novo', caso.rotulo + ': 401 renova');
  assert.strictEqual(postsOAuth, 1, caso.rotulo + ': 401 renovou exatamente uma vez');
  fs.rmSync(dir, { recursive: true, force: true });
}

(async () => {
  try {
    for (const caso of casos) await testar(caso);
    console.log('OK: refresh ML preservado em 429/5xx; renovado exatamente uma vez em 401 E 403 (3 empresas)');
  } finally {
    require.cache[fetchPath].exports = fetchOriginal;
  }
})().catch(e => { console.error('FALHOU:', e.message); process.exit(1); });
