'use strict';
/* 14/10 — parecer do Codex (6.7): gravação direta que falha no meio (ENOSPC, deploy matando o processo)
   deixava o arquivo ANTERIOR truncado — no token, a credencial que funcionava virava JSON quebrado.
   Prova por EXECUÇÃO: injeta um disco que enche no meio da escrita e exige que o arquivo anterior
   continue legível com o conteúdo antigo — no helper, nos três gerenciadores de token de PRODUÇÃO
   (Bling, ML, NF, com uma renovação OAuth VÁLIDA) e no writeJson compartilhado do checkout.
   A falha é injetada nas DUAS primitivas (writeFileSync e writeSync): assim o código antigo também
   cai nela, e o teste prova que pega o defeito. */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const raiz = path.join(__dirname, '..');

let _responder = async () => { throw new Error('sem resposta configurada'); };
require.cache[require.resolve('node-fetch')] = { id: require.resolve('node-fetch'), filename: require.resolve('node-fetch'), loaded: true, exports: (...a) => _responder(...a) };
const { gravarAtomico } = require('../lib/escrita-atomica');
const { criarTokenManager } = require('../lib/fiscal/token-manager');
const { criarMlTokenManager } = require('../lib/fiscal/ml-token-manager');
const { criarNfTokenManager } = require('../lib/fiscal/nf-token-manager');

/* disco que enche no meio: grava METADE e lança ENOSPC, nas duas primitivas */
const _wfs = fs.writeFileSync, _ws = fs.writeSync;
function discoCheio(alvoRe) {
  fs.writeFileSync = function (f, data, ...r) {
    if (typeof f === 'string' && alvoRe.test(f)) { const s = String(data); _wfs.call(fs, f, s.slice(0, Math.floor(s.length / 2))); const e = new Error('ENOSPC: no space left on device'); e.code = 'ENOSPC'; throw e; }
    return _wfs.call(fs, f, data, ...r);
  };
  fs.writeSync = function (fd, buf, off, len, ...r) {
    if (Buffer.isBuffer(buf) && len > 4) { _ws.call(fs, fd, buf, off || 0, Math.floor(len / 2)); const e = new Error('ENOSPC: no space left on device'); e.code = 'ENOSPC'; throw e; }
    return _ws.call(fs, fd, buf, off, len, ...r);
  };
}
function discoNormal() { fs.writeFileSync = _wfs; fs.writeSync = _ws; }
const ler = (f) => { try { return JSON.parse(_wfs && fs.readFileSync(f, 'utf8')); } catch (e) { return null; } };
const sobras = (dir) => fs.readdirSync(dir).filter(n => /\.tmp-/.test(n));

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atomico-'));
  try {
    // 1) helper: grava, troca, não deixa sobra
    const a = path.join(dir, 'sub', 'a.json');
    gravarAtomico(a, JSON.stringify({ v: 1 })); assert.deepStrictEqual(ler(a), { v: 1 });
    gravarAtomico(a, JSON.stringify({ v: 2 }), { sincronizar: true, modo: 0o600 }); assert.deepStrictEqual(ler(a), { v: 2 });
    assert.strictEqual((fs.statSync(a).mode & 0o777), 0o600, 'modo do arquivo novo');
    discoCheio(/a\.json/);
    assert.throws(() => gravarAtomico(a, JSON.stringify({ v: 3, grande: 'x'.repeat(5000) })), /ENOSPC/);
    discoNormal();
    assert.deepStrictEqual(ler(a), { v: 2 }, 'o arquivo anterior foi truncado'); assert.deepStrictEqual(sobras(path.dirname(a)), [], 'sobrou temporário');

    // 2) os três gerenciadores de token de PRODUÇÃO, com renovação OAuth VÁLIDA e disco cheio na hora de gravar
    const BOM = { access_token: 'token-bom-velho', refresh_token: 'refresh-bom-velho', expira_em: Date.now() - 1000 };
    const NOVO = { access_token: 'token-novo-valido-123456', refresh_token: 'refresh-novo-valido-123456', expires_in: 21600, token_type: 'Bearer' };
    _responder = async () => ({ ok: true, status: 200, json: async () => NOVO, text: async () => JSON.stringify(NOVO) });
    for (const k of ['T_ID', 'T_SEC', 'T_URI']) process.env[k] = 'x';
    const casos = [
      ['Bling', 'bling.json', (arq) => criarTokenManager({ rotulo: 'T', arquivoToken: arq, envTokenFile: 'T_TF', envBlingClientId: 'T_ID', envBlingClientSecret: 'T_SEC', envBlingRedirectUri: 'T_URI' }).renovarToken()],
      ['NF', 'nf.json', (arq) => criarNfTokenManager({ rotulo: 'T', arquivoToken: arq, envTokenFile: 'T_NTF', envId: 'T_ID', envSecret: 'T_SEC', envRedirect: 'T_URI', rotaSetup: '/t/setup-nf' }).renovarTokenNF()],
    ];
    for (const [nome, nomeArq, renovar] of casos) {
      const arq = path.join(dir, nomeArq); _wfs.call(fs, arq, JSON.stringify(BOM));
      discoCheio(new RegExp(nomeArq.replace('.', '\\.')));
      let lancou = false; try { await renovar(arq); } catch (e) { lancou = true; }
      discoNormal();
      assert.ok(lancou, nome + ': disco cheio na gravação tem que fazer a renovação falhar');
      const d = ler(arq);
      assert.ok(d, nome + ': o arquivo de token ficou ILEGÍVEL depois da falha de escrita');
      assert.strictEqual(d.refresh_token, BOM.refresh_token, nome + ': o token anterior não ficou intacto');
      assert.deepStrictEqual(sobras(dir), [], nome + ': sobrou temporário');
    }
    // ML: garantirTokenML renova o vencido
    { const arq = path.join(dir, 'ml.json'); _wfs.call(fs, arq, JSON.stringify(Object.assign({}, BOM, { expira_em: undefined, expires_at: Date.now() - 1000, criado_em: Date.now() - 999999999 })));
      const tm = criarMlTokenManager({ rotulo: 'T', arquivoToken: arq, envTokenFile: 'T_MTF', envClientId: 'T_ID', envClientSecret: 'T_SEC', envRedirect: 'T_URI' });
      discoCheio(/ml\.json/);
      try { await (tm.renovarTokenML ? tm.renovarTokenML() : tm.garantirTokenML()); } catch (e) {}
      discoNormal();
      const d = ler(arq); assert.ok(d, 'ML: o arquivo de token ficou ILEGÍVEL depois da falha de escrita');
      assert.strictEqual(d.refresh_token, BOM.refresh_token, 'ML: o token anterior não ficou intacto'); }

    // 3) writeJson compartilhado do checkout: falha devolve false e não trunca
    const bf = require('../lib/checkout/base-funcoes').criar({ tag: 'T', envOperadores: 'T_OPS', envAdmin: 'T_ADM', BLING_BASE: 'https://bling.invalid', garantirToken: async () => 'x',
      PAUSA_MS: 0, MANIFEST_FILE: path.join(dir, 'm.json'), SKU_EAN_FILE: path.join(dir, 's.json'), LOC_FILE: path.join(dir, 'l.json'),
      EAN_INDEX_FILE: path.join(dir, 'e.json'), RESERVAS_FILE: path.join(dir, 'r.json'), RESERVA_TTL_MS: 1000, sleep: async () => {}, CACHE_DIR: dir });
    const c = path.join(dir, 'conferidos.json'); _wfs.call(fs, c, JSON.stringify({ pedido: 1 }));
    discoCheio(/conferidos\.json/);
    const r = bf.writeJson(c, { pedido: 2, lixo: 'y'.repeat(4000) });
    discoNormal();
    assert.strictEqual(r, false, 'writeJson tem que devolver false na falha'); assert.deepStrictEqual(ler(c), { pedido: 1 }, 'writeJson truncou o arquivo anterior');
    assert.strictEqual(bf.writeJson(c, { pedido: 3 }), true); assert.deepStrictEqual(ler(c), { pedido: 3 });
    console.log('ok — gravação que falha no meio não trunca o arquivo anterior (helper, tokens Bling/ML/NF, writeJson)');
  } finally { discoNormal(); }
})().catch(e => { discoNormal(); console.error('FALHOU:', e.message); process.exit(1); });
