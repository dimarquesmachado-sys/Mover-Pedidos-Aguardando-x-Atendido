'use strict';
/* 15/11 — OS TRÊS VEREDITOS DA PARIDADE REMOTA (auditoria do Codex de 15/11/2026, P2 nº 14).

   A paridade do contrato com o Devoluções é online; quando a rede falha ela não consegue concluir — e antes saía 0 com
   "AVISO", que o verifica somava como ✓ e o agregado dizia "TUDO CERTO". Agora o script separa VERIFICADO (0),
   INCONCLUSIVO (2) e DIVERGENTE/AUSENTE (1), e o verifica mostra o inconclusivo à parte (⚠, agregado sem "TUDO CERTO";
   com VERIFICA_EXIGE_CONCLUSIVO=1 — o CI — vira falha).

   Prova com o script DE PRODUÇÃO (scripts/teste-contrato-paridade-remota.js) apontado pra servidores locais: contrato
   igual, igual só em fim de linha, diferente, 404, 503, servidor que não responde, porta fechada, corpo cortado. */
const assert = require('assert');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { execFile } = require('child_process');
const raiz = path.join(__dirname, '..');
const local = fs.readFileSync(path.join(raiz, 'contrato-empresas.json'), 'utf8');

function servidor(resposta) {
  return new Promise((ok) => {
    const s = http.createServer((req, res) => resposta(req, res));
    s.listen(0, '127.0.0.1', () => ok({ url: 'http://127.0.0.1:' + s.address().port + '/contrato.json', fechar: () => s.close() }));
  });
}
/* assíncrono: o servidor de mentira mora NESTE processo — um spawnSync travaria o laço e ele nunca responderia */
function rodar(url, timeoutMs) {
  return new Promise((ok) => {
    execFile(process.execPath, [path.join(raiz, 'scripts', 'teste-contrato-paridade-remota.js')], { encoding: 'utf8', timeout: 20000, env: Object.assign({}, process.env, { CONTRATO_REMOTO_URL: url, CONTRATO_REMOTO_TIMEOUT_MS: String(timeoutMs || 10000) }) },
      (err, stdout, stderr) => { const saida = (String(stdout || '') + String(stderr || '')).trim(); ok({ codigo: err ? err.code : 0, ultima: saida.split('\n').pop() || '', saida }); });
  });
}

(async () => {
  const casos = [
    ['igual', (q, res) => { res.writeHead(200); res.end(local); }, 0, /^VERIFICADO: contrato IDÊNTICO/],
    /* Codex #902: o fim de linha OPOSTO ao do checkout (num checkout Windows com autocrlf o local já é CRLF — trocar \n por
       \r\n ali daria CRCRLF, uma divergência de verdade) */
    ['igual só em fim de linha', (q, res) => { res.writeHead(200); res.end(/\r\n/.test(local) ? local.replace(/\r\n/g, '\n') : local.replace(/\n/g, '\r\n')); }, 0, /^VERIFICADO: contrato idêntico \(difere só em fim de linha/],
    ['diferente', (q, res) => { res.writeHead(200); res.end(local.replace('{', '{ "x": 1,')); }, 1, /^DIVERGENTE: contrato DIVERGIU/],
    ['404', (q, res) => { res.writeHead(404); res.end('nada'); }, 1, /^AUSENTE: o contrato remoto NÃO EXISTE/],
    ['410', (q, res) => { res.writeHead(410); res.end(''); }, 1, /^AUSENTE:/],
    ['503', (q, res) => { res.writeHead(503); res.end('fora'); }, 2, /^INCONCLUSIVO: HTTP 503/],
    ['429', (q, res) => { res.writeHead(429); res.end(''); }, 2, /^INCONCLUSIVO: HTTP 429/],
    ['corpo cortado', (q, res) => { res.writeHead(200, { 'Content-Length': String(local.length) }); res.write(local.slice(0, 40)); setTimeout(() => res.destroy(), 50); }, 2, /^INCONCLUSIVO: (conexão abortada|erro na resposta|terminou sem veredito)/],
  ];
  for (const [nome, resp, codigo, re] of casos) {
    const s = await servidor(resp);
    try {
      const r = await rodar(s.url);
      assert.strictEqual(r.codigo, codigo, nome + ': código de saída ' + r.codigo + ' (esperava ' + codigo + ') — ' + r.ultima);
      assert.ok(re.test(r.ultima), nome + ': veredito errado: ' + r.ultima);
    } finally { s.fechar(); }
  }
  /* servidor que aceita e nunca responde: INCONCLUSIVO pelo timeout (não fica preso) */
  { const s = await servidor(() => {}); try { const ini = Date.now(); const r = await rodar(s.url, 300); assert.ok(r.codigo === 2 && /^INCONCLUSIVO: sem rede\/timeout/.test(r.ultima), 'timeout: ' + r.codigo + ' ' + r.ultima); assert.ok(Date.now() - ini < 5000, 'o timeout tinha que valer'); } finally { s.fechar(); } }
  /* porta fechada: INCONCLUSIVO (sem rede) */
  { const s = await servidor(() => {}); const url = s.url; s.fechar(); await new Promise((r) => setTimeout(r, 50)); const r = await rodar(url); assert.ok(r.codigo === 2 && /^INCONCLUSIVO: sem rede/.test(r.ultima), 'porta fechada: ' + r.codigo + ' ' + r.ultima); }
  /* nunca "AVISO"/"OK"/"FALHOU" — as palavras antigas que o verifica somava como ✓ */
  const src = fs.readFileSync(path.join(raiz, 'scripts', 'teste-contrato-paridade-remota.js'), 'utf8');
  assert.ok(!/'AVISO|'OK:|'FALHOU/.test(src), 'o script voltou às palavras antigas (AVISO/OK/FALHOU) — o verifica não as distingue');
  /* o verifica: só VERIFICADO é ✓; INCONCLUSIVO é ⚠ à parte e tira o "TUDO CERTO"; com VERIFICA_EXIGE_CONCLUSIVO=1 é falha */
  const v = fs.readFileSync(path.join(raiz, 'scripts', 'verifica.js'), 'utf8');
  assert.ok(/if \(r\.status === 0 && \/\^VERIFICADO:\/\.test\(ultima\)\) console\.log\('  ✓ ' \+ ultima\);/.test(v), 'o verifica só pode dar ✓ ao VERIFICADO');
  assert.ok(/else if \(r\.status === 2 \|\| \/\^INCONCLUSIVO:\/\.test\(ultima\)\) inconclusivo\(/.test(v), 'o verifica tem que tratar o INCONCLUSIVO à parte');
  assert.ok(/else if \(r\.status === 0\) falha\('paridade remota terminou com código 0 mas SEM o veredito VERIFICADO/.test(v), 'código 0 sem veredito não pode ser ✓');
  assert.ok(/const inconclusivo = m => \{ if \(process\.env\.VERIFICA_EXIGE_CONCLUSIVO === '1'\) \{ falha\(/.test(v), 'VERIFICA_EXIGE_CONCLUSIVO=1 tem que virar falha');
  assert.ok(/inconclusivas\.length \? '✓ sem falhas, mas ' \+ inconclusivas\.length \+ ' verificação\(ões\) INCONCLUSIVA\(S\)/.test(v), 'o agregado tem que dizer que há inconclusivas em vez de "TUDO CERTO"');
  assert.ok(/VERIFICA_EXIGE_CONCLUSIVO: '1'/.test(fs.readFileSync(path.join(raiz, '.github', 'workflows', 'verifica.yml'), 'utf8')), 'o CI (que tem rede) tem que exigir veredito conclusivo');
  console.log('ok — paridade remota: VERIFICADO (0) só com contrato igual; DIVERGENTE/AUSENTE (1); INCONCLUSIVO (2) em 5xx/429, timeout, porta fechada e corpo cortado; o verifica separa os três e o CI exige conclusivo');
})().catch((e) => { console.error('FALHOU:', e.stack || e.message); process.exit(1); });
