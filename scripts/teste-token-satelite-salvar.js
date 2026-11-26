'use strict';
/* 26/11 — TOKEN DO BLING DOS MÓDULOS SATÉLITES: UMA RESPOSTA RUIM NÃO APAGA O TOKEN QUE FUNCIONAVA.
   O aviso do dono: "Token do Bling vencido em um módulo" — o canário disse, do Frágil: "arquivo de token existe mas está
   sem refresh_token (apagado/corrompido)".

   O que o código fazia (frágil, estoque e estoque-girassol): gravava o que o OAuth devolvesse, sem olhar. Uma resposta
   sem `error` e sem os tokens (ex.: "{}") virava um arquivo `{}` — o refresh_token era apagado e o módulo ficava fora do
   ar até reautorizar à mão. E os seis satélites gravavam direto no arquivo (reinício no meio = arquivo truncado).

   O que se prova:
   A. a peça (lib/token-satelite-salvar): só grava com os DOIS tokens em texto; senão lança (dizendo qual faltou, sem
      valor nenhum) e o arquivo fica como estava; grava por temporário + rename, com permissão só do dono;
   B. os SEIS gerenciadores de produção, com um Bling de mentira: renovação e autorização que voltam sem token NÃO
      apagam o arquivo; renovação sem refresh_token novo mantém o antigo; resposta boa grava os dois. */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const raiz = path.join(__dirname, '..');

process.exitCode = 1;
let terminou = false;
process.on('exit', () => { if (!terminou) { console.log('FALHOU: o teste não chegou ao fim (promessa presa)'); process.exitCode = 1; } });

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tok-sat-'));
const ler = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));

(async () => {
  /* ═══ A. a peça ═══ */
  {
    const { salvarTokensSatelite } = require('../lib/token-satelite-salvar');
    const arq = path.join(tmp, 'a', 'b', 'tokens.json');
    salvarTokensSatelite(arq, 'ACESSO-1', 'RENOVA-1', 'mod');
    assert.deepStrictEqual(ler(arq), { access_token: 'ACESSO-1', refresh_token: 'RENOVA-1' }, 'cria a pasta e grava os dois');
    assert.strictEqual(fs.statSync(arq).mode & 0o777, 0o600, 'permissão só do dono');
    assert.deepStrictEqual(fs.readdirSync(path.dirname(arq)), ['tokens.json'], 'não sobra arquivo temporário');
    for (const [a, r, falta] of [[undefined, 'R', 'access_token'], ['A', undefined, 'refresh_token'], [undefined, undefined, 'access_token e sem refresh_token'], ['', 'R', 'access_token'], ['A', '   ', 'refresh_token'],
      [null, 'R', 'access_token'], ['A', 123, 'refresh_token'], [{}, 'R', 'access_token'], ['A', ['x'], 'refresh_token']]) {
      let erro = null;
      try { salvarTokensSatelite(arq, a, r, 'mod'); } catch (e) { erro = e; }
      assert.ok(erro, 'tinha que recusar: ' + JSON.stringify([a, r]));
      assert.strictEqual(erro.message, '[mod] o Bling respondeu sem ' + falta + ' — nada foi gravado; o token que estava no disco foi mantido');
      assert.deepStrictEqual(ler(arq), { access_token: 'ACESSO-1', refresh_token: 'RENOVA-1' }, 'o arquivo ficou como estava');
    }
    let e2 = null; try { salvarTokensSatelite(arq, 'SEGREDO-A', undefined); } catch (e) { e2 = e; }
    assert.ok(e2 && /^\[tokenManager\] /.test(e2.message) && !/SEGREDO-A/.test(e2.message), 'sem rótulo, um padrão; o valor do token nunca vai na mensagem');
    salvarTokensSatelite(arq, 'ACESSO-2', 'RENOVA-2', 'mod');
    assert.deepStrictEqual(ler(arq), { access_token: 'ACESSO-2', refresh_token: 'RENOVA-2' }, 'resposta boa substitui');
    /* a gravação é temporário + rename: não escreve direto no arquivo */
    const fonte = fs.readFileSync(path.join(raiz, 'lib/token-satelite-salvar.js'), 'utf8');
    assert.ok(/gravarAtomico\(arquivo, JSON\.stringify\(\{ access_token, refresh_token \}, null, 2\), \{ sincronizar: true, modo: 0o600 \}\)/.test(fonte) && !/writeFileSync/.test(fonte));
  }

  /* ═══ B. os seis gerenciadores de produção ═══ */
  const MODS = [
    ['fragil', 'FRAGIL', 'renovarToken', 'gerarTokenInicial'], ['estoque', 'ESTOQUE', 'renovarToken', 'gerarTokenInicial'], ['estoque-girassol', 'ESTOQUE_GIRASSOL', 'renovarToken', 'gerarTokenInicial'],
    ['lixas-combinar', 'LIXAS', 'refreshTokens', 'trocarCodePorTokens'], ['amb-drive-imagens', 'AMBIMG', 'refreshTokens', 'trocarCodePorTokens'], ['good-drive-imagens', 'GOODIMG', 'refreshTokens', 'trocarCodePorTokens']];
  /* o Bling de mentira: o node-fetch que os módulos carregam devolve o que o teste mandar */
  let resposta = null; const pedidos = [];
  const nf = require.resolve('node-fetch');
  require(nf);
  require.cache[nf].exports = async (url, opts) => { pedidos.push(String(opts && opts.body)); const r = resposta; return { status: r.status || 200, ok: (r.status || 200) < 400, text: async () => r.corpo }; };
  for (const [mod, env, fRenovar, fInicial] of MODS) {
    const arq = path.join(tmp, mod, 'bling-tokens.json');
    process.env[env + '_TOKEN_FILE'] = arq; process.env[env + '_BLING_CLIENT_ID'] = 'id'; process.env[env + '_BLING_CLIENT_SECRET'] = 'seg'; process.env[env + '_BLING_REDIRECT_URI'] = 'https://x/cb';
    const tm = require(path.join(raiz, mod, 'tokenManager.js'));
    const fonte = fs.readFileSync(path.join(raiz, mod, 'tokenManager.js'), 'utf8');
    assert.ok(fonte.includes("require('../lib/token-satelite-salvar').salvarTokensSatelite(TOKEN_FILE, access_token, refresh_token, '" + mod + "');") && !/writeFileSync\(TOKEN_FILE/.test(fonte), mod + ': grava pela peça, não direto no arquivo');
    const tenta = async (f, arg) => { try { await tm[f](arg); return 'ok'; } catch (e) { return 'erro: ' + e.message; } };
    /* autorização boa: grava os dois */
    resposta = { corpo: JSON.stringify({ access_token: 'ACESSO-INICIAL', refresh_token: 'RENOVA-INICIAL' }) };
    assert.strictEqual(await tenta(fInicial, 'codigo'), 'ok', mod);
    assert.deepStrictEqual(ler(arq), { access_token: 'ACESSO-INICIAL', refresh_token: 'RENOVA-INICIAL' }, mod + ': a autorização grava os dois');
    /* renovação boa: troca os dois, mandando o refresh que estava no disco */
    resposta = { corpo: JSON.stringify({ access_token: 'ACESSO-2', refresh_token: 'RENOVA-2' }) };
    assert.strictEqual(await tenta(fRenovar), 'ok', mod);
    assert.ok(/refresh_token=RENOVA-INICIAL/.test(pedidos[pedidos.length - 1]), mod + ': renovou com o refresh do disco');
    assert.deepStrictEqual(ler(arq), { access_token: 'ACESSO-2', refresh_token: 'RENOVA-2' }, mod + ': a renovação grava os dois');
    /* ⚠️ o defeito: o Bling respondeu sem os tokens (e sem `error`) — o arquivo NÃO pode virar `{}` */
    for (const corpo of ['{}', JSON.stringify({ token_type: 'Bearer' }), JSON.stringify({ refresh_token: 'SO-ESSE' }), JSON.stringify({ access_token: '', refresh_token: '' })]) {
      resposta = { corpo };
      const r1 = await tenta(fRenovar);
      assert.ok(/^erro: /.test(r1), mod + ': renovação com resposta ' + corpo + ' tinha que falhar: ' + r1);
      assert.deepStrictEqual(ler(arq), { access_token: 'ACESSO-2', refresh_token: 'RENOVA-2' }, mod + ': renovação com ' + corpo + ' apagou o token que funcionava');
      const r2 = await tenta(fInicial, 'codigo');
      assert.ok(/^erro: /.test(r2), mod + ': autorização com resposta ' + corpo + ' tinha que falhar: ' + r2);
      assert.deepStrictEqual(ler(arq), { access_token: 'ACESSO-2', refresh_token: 'RENOVA-2' }, mod + ': autorização com ' + corpo + ' apagou o token que funcionava');
    }
    /* autorização que volta só com o access_token: não grava meio token */
    resposta = { corpo: JSON.stringify({ access_token: 'SO-ACESSO' }) };
    assert.ok(/^erro: .*sem refresh_token/.test(await tenta(fInicial, 'codigo')), mod);
    assert.deepStrictEqual(ler(arq), { access_token: 'ACESSO-2', refresh_token: 'RENOVA-2' }, mod + ': autorização pela metade não grava');
    /* renovação que volta sem refresh_token novo: guarda o access novo e MANTÉM o refresh que estava */
    resposta = { corpo: JSON.stringify({ access_token: 'ACESSO-3' }) };
    assert.strictEqual(await tenta(fRenovar), 'ok', mod);
    assert.deepStrictEqual(ler(arq), { access_token: 'ACESSO-3', refresh_token: 'RENOVA-2' }, mod + ': renovação sem refresh novo mantém o antigo');
    /* o erro do OAuth segue sendo erro, sem mexer no arquivo */
    resposta = { status: 400, corpo: JSON.stringify({ error: { type: 'invalid_grant' } }) };
    assert.ok(/^erro: /.test(await tenta(fRenovar)), mod);
    assert.deepStrictEqual(ler(arq), { access_token: 'ACESSO-3', refresh_token: 'RENOVA-2' }, mod + ': erro do OAuth não mexe no arquivo');
    assert.deepStrictEqual(fs.readdirSync(path.dirname(arq)), ['bling-tokens.json'], mod + ': sem temporário sobrando');
  }

  terminou = true; process.exitCode = 0;
  console.log('ok — token do Bling dos seis módulos satélites (frágil, estoque, estoque-girassol, lixas-combinar, amb-drive-imagens, good-drive-imagens): resposta do OAuth sem os tokens não apaga o que funcionava (falha dizendo qual faltou, sem valor nenhum); renovação sem refresh novo mantém o antigo; gravação por temporário + rename, só do dono');
})().catch((e) => { console.log('FALHOU: ' + (e && e.stack || e)); terminou = true; process.exitCode = 1; });
