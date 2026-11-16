'use strict';
/* 15/11 — O BACKUP SÓ SOBE CIFRADO E SÓ PRA REPO PRIVADO (auditoria geral do Codex de 15/11/2026, P2 nº 8).

   O /data leva os tokens do Bling e do ML das três empresas, o ponto e os conferidos. O backup zipava tudo e subia pra
   onde BACKUP_GITHUB_REPO mandasse, em claro, sem olhar se o destino era privado. Agora (backup-github/index.js +
   lib/backup-cifra): antes de qualquer upload o repo tem que responder `private: true` (público, 404 ou erro = nada sobe);
   o arquivo é cifrado com BACKUP_CHAVE (AES-256-GCM, em fluxo) — sem chave não sobe, salvo BACKUP_SEM_CIFRA=1 dito pelo
   dono; e scripts/backup-decifrar.js abre o .enc com a mesma senha (senha errada = nada escrito).

   Prova com o módulo DE PRODUÇÃO, um /data de mentira (tar de verdade) e o GitHub de mentira (node-fetch trocado). */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const raiz = path.join(__dirname, '..');
const vigia = setTimeout(() => { console.error('FALHOU: o teste travou — 60s'); process.exit(1); }, 60000);

/* o /data de mentira */
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'data-'));
fs.mkdirSync(path.join(DATA, 'ambtotal'), { recursive: true });
fs.writeFileSync(path.join(DATA, 'tokens.json'), JSON.stringify({ access_token: 'SEGREDO-BLING-GIRASSOL', refresh_token: 'R1' }));
fs.writeFileSync(path.join(DATA, 'ambtotal', 'ml-tokens.json'), JSON.stringify({ access_token: 'SEGREDO-ML-AMB' }));
fs.writeFileSync(path.join(DATA, 'grande.bin'), crypto.randomBytes(3 * 1024 * 1024));   /* 3 MB: o fluxo tem que aguentar mais de um pedaço */
process.env.BACKUP_DATA_DIR = DATA;
process.env.BACKUP_GITHUB_TOKEN = 'ghp_teste';
process.env.BACKUP_GITHUB_REPO = 'dono/backup-teste';
process.env.BACKUP_APELIDO = 'teste';

/* o GitHub de mentira */
let repo = { private: true, visibility: 'private', default_branch: 'main' };
let statusRepo = 200;
const chamadas = [];
let assetRecebido = null;
const fakeFetch = async (url, opts) => {
  const u = String(url); const m = (opts && opts.method) || 'GET';
  chamadas.push(m + ' ' + u.replace('https://api.github.com', '').replace('https://uploads.github.com', 'UP'));
  const resp = (status, body) => ({ status, ok: status >= 200 && status < 300, json: async () => body, text: async () => JSON.stringify(body) });
  if (m === 'GET' && u === 'https://api.github.com/repos/dono/backup-teste') return resp(statusRepo, statusRepo === 200 ? repo : { message: 'Not Found' });
  if (m === 'GET' && /\/releases\/tags\//.test(u)) return resp(404, { message: 'Not Found' });
  if (m === 'POST' && /\/releases$/.test(u)) return resp(201, { id: 77, assets: [] });
  if (m === 'POST' && /uploads\.github\.com/.test(u)) {
    const partes = []; for await (const c of opts.body) partes.push(Buffer.from(c));
    assetRecebido = { nome: decodeURIComponent(/name=([^&]+)/.exec(u)[1]), bytes: Buffer.concat(partes), tipo: opts.headers['Content-Type'] };
    return resp(201, { id: 1, name: assetRecebido.nome, size: assetRecebido.bytes.length });
  }
  if (m === 'GET' && /\/releases\?per_page/.test(u)) return resp(200, []);
  return resp(204, null);
};
require.cache[require.resolve('node-fetch')] = { id: 'node-fetch', filename: 'node-fetch', loaded: true, exports: fakeFetch };

function modulo() {   /* o módulo lê as envs ao carregar — recarrega a cada cenário */
  delete require.cache[require.resolve('../backup-github/index.js')];
  return require('../backup-github/index.js');
}
const SENHA = 'uma-senha-bem-comprida-de-teste-com-mais-de-32-chars';
const zerar = () => { chamadas.length = 0; assetRecebido = null; };
const subiu = () => chamadas.some((c) => c.startsWith('POST UP'));
const gravouNoGitHub = () => chamadas.some((c) => /^(POST|DELETE|PATCH)/.test(c));

(async () => {
  const _log = console.log; console.log = () => {};
  let falhou = null;
  try {
    /* A. sem BACKUP_CHAVE e sem autorização: NÃO sobe, nada é gravado no GitHub, o erro diz o que falta */
    delete process.env.BACKUP_CHAVE; delete process.env.BACKUP_SEM_CIFRA; zerar();
    let r = await modulo()._interno.rodarBackup('teste', 'essencial');
    assert.ok(r.ok === false && /BACKUP_CHAVE/.test(r.erro) && /em claro/.test(r.erro), 'sem chave tinha que recusar dizendo o motivo: ' + JSON.stringify(r));
    assert.ok(!subiu() && !gravouNoGitHub(), 'sem chave NADA pode ter sido gravado no GitHub: ' + chamadas.join(' | '));
    /* B. destino PÚBLICO: não sobe (mesmo com chave) */
    process.env.BACKUP_CHAVE = SENHA; repo = { private: false, visibility: 'public' }; zerar();
    r = await modulo()._interno.rodarBackup('teste', 'essencial');
    assert.ok(r.ok === false && /NÃO é privado/.test(r.erro) && r.destino_privado === false, 'repo público tinha que abortar: ' + JSON.stringify(r));
    assert.ok(!subiu() && !gravouNoGitHub(), 'repo público: nada gravado: ' + chamadas.join(' | '));
    /* Codex #903: falha DEPOIS de cifrar não pode deixar o .enc (nem o tar) no tmp */
    assert.ok(fs.readdirSync(os.tmpdir()).filter((f) => /-essencial-\d{4}-\d{2}-\d{2}\.tar\.gz(\.enc)?$/.test(f)).length === 0, 'falha no destino deixou temporário no tmp: ' + fs.readdirSync(os.tmpdir()).join(','));
    /* B2. `private: true` mas visibility 'public' (inconsistente) também não serve */
    repo = { private: true, visibility: 'public' }; zerar();
    r = await modulo()._interno.rodarBackup('teste', 'essencial');
    assert.ok(r.ok === false && /NÃO é privado/.test(r.erro) && !gravouNoGitHub(), 'visibility public: ' + JSON.stringify(r));
    /* C. destino não conferido (404 / 500): não sobe */
    for (const st of [404, 500]) { statusRepo = st; repo = { private: true, visibility: 'private' }; zerar();
      r = await modulo()._interno.rodarBackup('teste', 'essencial');
      assert.ok(r.ok === false && /destino não conferido/.test(r.erro) && r.destino_privado === null && !gravouNoGitHub(), 'repo ' + st + ': ' + JSON.stringify(r) + ' ' + chamadas.join(' | ')); }
    statusRepo = 200;
    /* C2. upload que falha (500 no uploads) depois de cifrar: erro dito, tmp limpo */
    { const guarda = fakeFetch; const falhaUpload = async (url, opts) => { if (/uploads\.github\.com/.test(String(url))) return { status: 500, ok: false, json: async () => ({ message: 'boom' }), text: async () => 'boom' }; return guarda(url, opts); };
      require.cache[require.resolve('node-fetch')].exports = falhaUpload; zerar();
      r = await modulo()._interno.rodarBackup('teste', 'essencial');
      require.cache[require.resolve('node-fetch')].exports = guarda;
      assert.ok(r.ok === false && /upload asset 500/.test(r.erro), 'upload com 500: ' + JSON.stringify(r));
      const sobras = fs.readdirSync(os.tmpdir()).filter((f) => /^teste-.*\.tar\.gz(\.enc)?$/.test(f));
      assert.deepStrictEqual(sobras, [], 'falha no upload deixou temporário no tmp: ' + sobras.join(', ')); }
    /* senha curta (cifra falha antes de criar o .enc): nada fica */
    { process.env.BACKUP_CHAVE = 'curta'; zerar();
      r = await modulo()._interno.rodarBackup('teste', 'essencial');
      assert.ok(r.ok === false && /pelo menos 32/.test(r.erro) && !gravouNoGitHub(), 'senha curta: ' + JSON.stringify(r));
      const sobras = fs.readdirSync(os.tmpdir()).filter((f) => /^teste-.*\.tar\.gz(\.enc)?$/.test(f)); assert.deepStrictEqual(sobras, [], 'senha curta deixou temporário: ' + sobras.join(', '));
      process.env.BACKUP_CHAVE = SENHA; }
    /* D. tudo certo: sobe CIFRADO — o asset não é um gzip, é o nosso formato; nenhum segredo em claro; e decifra de volta no tar original */
    repo = { private: true, visibility: 'private' }; zerar();
    r = await modulo()._interno.rodarBackup('teste', 'essencial');
    assert.ok(r.ok === true && r.cifrado === true && r.destino_privado === true && /\.tar\.gz\.enc$/.test(r.arquivo), 'cenário bom: ' + JSON.stringify(r));
    assert.ok(subiu() && assetRecebido && assetRecebido.nome === r.arquivo, 'o asset tinha que subir com o nome .enc: ' + JSON.stringify(assetRecebido && assetRecebido.nome));
    const b = assetRecebido.bytes;
    assert.ok(b.subarray(0, 5).equals(Buffer.from('MPBK1')) && !(b[0] === 0x1f && b[1] === 0x8b), 'o que subiu tem que ser o formato cifrado, não gzip');
    assert.ok(!b.includes(Buffer.from('SEGREDO-BLING-GIRASSOL')) && !b.includes(Buffer.from('SEGREDO-ML-AMB')) && !b.includes(Buffer.from('access_token')), 'segredo em claro dentro do que subiu');
    assert.ok(b.length > 3 * 1024 * 1024, 'o arquivo grande tinha que estar dentro (fluxo): ' + b.length);
    const enc = path.join(os.tmpdir(), 'recebido-' + Date.now() + '.enc'); fs.writeFileSync(enc, b);
    const CIFRA = require('../lib/backup-cifra');
    assert.strictEqual(CIFRA.ehCifrado(enc), true);
    const tar = enc.replace(/\.enc$/, '.tar.gz');
    await CIFRA.decifrarArquivo(enc, SENHA, tar);
    assert.ok(fs.readFileSync(tar).subarray(0, 2).equals(Buffer.from([0x1f, 0x8b])), 'decifrado tem que ser o gzip');
    const lista = execFileSync('tar', ['-tzf', tar], { encoding: 'utf8' });
    assert.ok(/tokens\.json/.test(lista) && /ml-tokens\.json/.test(lista) && /grande\.bin/.test(lista), 'o tar decifrado tem que listar o /data: ' + lista.slice(0, 200));
    const dirX = fs.mkdtempSync(path.join(os.tmpdir(), 'x-')); execFileSync('tar', ['-xzf', tar, '-C', dirX]);
    const base = path.basename(DATA);
    assert.strictEqual(fs.readFileSync(path.join(dirX, base, 'tokens.json'), 'utf8'), fs.readFileSync(path.join(DATA, 'tokens.json'), 'utf8'), 'o conteúdo restaurado tem que ser o original');
    assert.ok(fs.readFileSync(path.join(dirX, base, 'grande.bin')).equals(fs.readFileSync(path.join(DATA, 'grande.bin'))), 'o arquivo grande tem que voltar byte a byte');
    /* o .enc temporário e o tar foram apagados do tmp do servidor */
    assert.ok(!fs.existsSync(path.join(os.tmpdir(), r.arquivo)) && !fs.existsSync(path.join(os.tmpdir(), r.arquivo.replace(/\.enc$/, ''))), 'os temporários (tar e .enc) têm que ser apagados');
    /* E. senha errada / arquivo mexido: não decifra e NÃO deixa saída */
    const saida2 = tar + '.2';
    await assert.rejects(CIFRA.decifrarArquivo(enc, 'outra-senha-comprida-que-nao-e-a-certa-xxxxxxx', saida2), /senha errada ou arquivo alterado/);
    assert.ok(!fs.existsSync(saida2) && !fs.existsSync(saida2 + '.parcial'), 'senha errada não pode deixar arquivo de saída');
    const mexido = enc + '.mexido'; const bm = Buffer.from(b); bm[bm.length - 10] ^= 0xff; fs.writeFileSync(mexido, bm);
    await assert.rejects(CIFRA.decifrarArquivo(mexido, SENHA, saida2), /senha errada ou arquivo alterado/); assert.ok(!fs.existsSync(saida2));
    await assert.rejects(CIFRA.decifrarArquivo(tar, SENHA, saida2), /cabeçalho MPBK1 ausente/, 'um gzip não é um backup cifrado');
    /* restaurar POR CIMA de um arquivo que já existe com a senha errada não pode destruí-lo */
    fs.writeFileSync(saida2, 'o backup anterior, bom');
    await assert.rejects(CIFRA.decifrarArquivo(enc, 'outra-senha-comprida-que-nao-e-a-certa-xxxxxxx', saida2), /senha errada/);
    assert.strictEqual(fs.readFileSync(saida2, 'utf8'), 'o backup anterior, bom', 'a senha errada não pode ter mexido no arquivo que já existia'); fs.unlinkSync(saida2);
    /* cifra que quebra no meio (origem que some) não deixa .enc pela metade */
    { const sumida = path.join(os.tmpdir(), 'sumida-' + Date.now() + '.tar.gz');
      await assert.rejects(CIFRA.cifrarArquivo(sumida, SENHA), /ENOENT/);
      assert.ok(!fs.existsSync(sumida + '.enc'), 'cifra que falhou no meio deixou o .enc pela metade'); }
    /* senha curta não serve pra cifrar (e nada é criado) */
    await assert.rejects(CIFRA.cifrarArquivo(tar, 'curta'), /pelo menos 32/); assert.ok(!fs.existsSync(tar + '.enc'));
    /* dois backups com a mesma senha não compartilham sal/iv (o sal muda a chave) */
    const e1 = await CIFRA.cifrarArquivo(tar, SENHA); const h1 = fs.readFileSync(e1.caminho).subarray(5, 33); fs.unlinkSync(e1.caminho);
    const e2 = await CIFRA.cifrarArquivo(tar, SENHA); const h2 = fs.readFileSync(e2.caminho).subarray(5, 33); fs.unlinkSync(e2.caminho);
    assert.ok(!h1.equals(h2), 'sal/iv têm que mudar a cada backup');
    /* F. o script de restauração */
    const out = execFileSync(process.execPath, [path.join(raiz, 'scripts', 'backup-decifrar.js'), enc, tar + '.3'], { encoding: 'utf8', env: Object.assign({}, process.env, { BACKUP_CHAVE: SENHA }) });
    assert.ok(/✓ decifrado/.test(out) && fs.readFileSync(tar + '.3').equals(fs.readFileSync(tar)), 'o script tinha que decifrar: ' + out);
    let falhouScript = null; try { execFileSync(process.execPath, [path.join(raiz, 'scripts', 'backup-decifrar.js'), enc, tar + '.4'], { encoding: 'utf8', stdio: 'pipe', env: Object.assign({}, process.env, { BACKUP_CHAVE: 'errada-mas-comprida-o-suficiente-pra-passar-xxxx' }) }); } catch (e) { falhouScript = e; }
    assert.ok(falhouScript && falhouScript.status === 1 && !fs.existsSync(tar + '.4'), 'o script com a senha errada tem que falhar sem saída');
    /* G. BACKUP_SEM_CIFRA=1 (decisão explícita do dono): sobe em claro, dito como tal; destino continua tendo que ser privado */
    delete process.env.BACKUP_CHAVE; process.env.BACKUP_SEM_CIFRA = '1'; zerar();
    r = await modulo()._interno.rodarBackup('teste', 'essencial');
    assert.ok(r.ok === true && r.cifrado === false && /\.tar\.gz$/.test(r.arquivo) && assetRecebido.bytes[0] === 0x1f, 'em claro autorizado: ' + JSON.stringify(r));
    repo = { private: false, visibility: 'public' }; zerar();
    r = await modulo()._interno.rodarBackup('teste', 'essencial');
    assert.ok(r.ok === false && /NÃO é privado/.test(r.erro) && !gravouNoGitHub(), 'em claro autorizado + repo público: ainda não sobe');
    /* H. /health e /testar dizem o estado da cifra e do destino */
    repo = { private: true, visibility: 'private' }; delete process.env.BACKUP_SEM_CIFRA;
    const mod = modulo(); const h = mod.routes(async () => ({}));
    const chama = async (p) => { let saida = null; const res = { writeHead() {}, end(b) { saida = JSON.parse(b); } }; await h({ method: 'GET' }, res, new URL('http://x' + p)); return saida; };
    let hs = await chama('/backup-github/health');
    assert.ok(/sem BACKUP_CHAVE — o backup NÃO sobe/.test(hs.cifra) && hs.destino && 'privado' in hs.destino, 'health sem chave: ' + JSON.stringify(hs.cifra) + ' ' + JSON.stringify(hs.destino));
    process.env.BACKUP_CHAVE = SENHA; hs = await chama('/backup-github/health'); assert.ok(/BACKUP_CHAVE definida/.test(hs.cifra));
    let t = await chama('/backup-github/testar'); assert.ok(t.ok && /\(privado\)/.test(t.mensagem) && t.cifra === 'ok', JSON.stringify(t));
    repo = { private: false, visibility: 'public' }; t = await chama('/backup-github/testar'); assert.ok(/NÃO É PRIVADO: o backup não vai subir/.test(t.mensagem), JSON.stringify(t));
    /* a chave nunca aparece no health/testar */
    assert.ok(!JSON.stringify(hs).includes(SENHA) && !JSON.stringify(t).includes(SENHA) && !JSON.stringify(hs).includes('ghp_teste'), 'segredo vazou no health/testar');
  } catch (e) { falhou = e; }
  finally { console.log = _log; clearTimeout(vigia); }
  if (falhou) { console.error('FALHOU:', falhou.stack || falhou.message); process.exit(1); }
  console.log('ok — backup: sem BACKUP_CHAVE não sobe (salvo BACKUP_SEM_CIFRA=1, dito); destino público/404/erro aborta antes de gravar; com chave sobe CIFRADO (AES-256-GCM em fluxo, sem segredo em claro) e decifra de volta ao tar byte a byte; senha errada/arquivo mexido não deixa saída; health/testar dizem o estado sem vazar a chave');
  process.exit(0);
})();
