/* 05/10 — MIGRAÇÃO NÃO PODE ENTREGAR MENOS. Regra do dono, dita hoje:

     "não tem q diminuir a AMB não. Vendo ela, ou qqer outra, se ver q tem mais funções, tem mais
      recursos, ela q tem que ser espelho pras outras"

   O caso que originou: migrei a previsão da AMB pra peça compartilhada DEPOIS de conferir
   paridade item a item — e ainda assim passaram TRÊS perdas (detalhe por linha, planilha .xls em
   vez de .csv, e o CSS do celular que mirava o id da tabela antiga). Minha conferência olhou
   recursos de alto nível ("tem busca? tem planilha?") e não os detalhes.

   ⚠️ ESTE TESTE NÃO TENTA ADIVINHAR o que cada tela embutida faz — varredura por palavra-chave
   não enxerga diferença de FORMATO nem de CSS, e foi assim que as três passaram. O que ele faz é
   garantir que ninguém troque uma tela embutida por peça SEM a conferência estar registrada:

     · toda peça que consome uma rota TAMBÉM usada por tela embutida precisa estar listada em
       `docs/paridade-pecas.md`, com a conferência feita e assinada;
     · a empresa só pode incluir o script da peça se a linha dela estiver marcada como conferida.

   Assim a conferência deixa de depender da minha memória no dia da migração.

   Marcador estável [PECA-MENOS]. */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const raiz = path.join(__dirname, '..');
const docPath = path.join(raiz, 'docs', 'paridade-pecas.md');

const TELAS = [
  ['amb',      'amb-checkout-offline/amb-dashboard.html', '/amb-checkout-offline'],
  ['girassol', 'girassol-backup-offline/dashboard.html',  '/girassol-backup-offline'],
];

/* 1) quais peças têm equivalente embutido em alguma tela */
const dir = path.join(raiz, 'lib', 'checkout');
const pecas = fs.readdirSync(dir).filter((f) => /^painel-.*\.js$/.test(f));
assert.ok(pecas.length >= 5, '[PECA-MENOS] achei só ' + pecas.length + ' peça(s) — teste viraria decoração');

const comEmbutida = [];
for (const fn of pecas) {
  const s = fs.readFileSync(path.join(dir, fn), 'utf8');
  const rotas = [...new Set([...s.matchAll(/BASE \+ '(\/[\w-]+)/g)].map((m) => m[1]))];
  if (!rotas.length) continue;

  for (const [emp, arq] of TELAS) {
    let tela;
    try { tela = fs.readFileSync(path.join(raiz, arq), 'utf8'); } catch (e) { continue; }
    const semEspaco = tela.replace(/\s+/g, '');
    const usa = rotas.filter((r) => semEspaco.includes("MOD+'" + r));
    if (usa.length) { comEmbutida.push({ peca: fn.replace(/^painel-|\.js$/g, ''), empresa: emp, rotas: usa }); }
  }
}

/* 2) o documento de paridade existe e cobre cada par peça×empresa */
let doc = '';
try { doc = fs.readFileSync(docPath, 'utf8'); }
catch (e) {
  assert.fail('[PECA-MENOS] falta `docs/paridade-pecas.md` — é onde a conferência item a item de ' +
    'cada migração fica registrada. Sem ele, trocar tela embutida por peça depende da memória de ' +
    'quem migra, e foi assim que a previsão perdeu 3 recursos num PR chamado "unificar".');
}

const semRegistro = comEmbutida.filter(({ peca, empresa }) =>
  !new RegExp('^\\|\\s*' + peca + '\\s*\\|\\s*' + empresa + '\\s*\\|', 'm').test(doc));

assert.deepStrictEqual(semRegistro.map((x) => x.peca + '×' + x.empresa), [],
  '[PECA-MENOS] estes pares peça×empresa consomem a MESMA rota que a tela embutida e não estão em ' +
  'docs/paridade-pecas.md:\n  ' + semRegistro.map((x) => x.peca + ' × ' + x.empresa + ' (' + x.rotas.join(', ') + ')').join('\n  ') +
  '\nCada linha precisa dizer se a conferência foi feita e o que a embutida tem a mais.');

/* ⚠️ 3) o ponto central: empresa só inclui a peça se a linha estiver CONFERIDA */
const naoConferidas = [];
for (const { peca, empresa } of comEmbutida) {
  const linha = (doc.match(new RegExp('^\\|\\s*' + peca + '\\s*\\|\\s*' + empresa + '\\s*\\|([^\n]*)', 'm')) || [])[1] || '';
  /* ⚠️ "não conferida" CONTÉM "conferida" — a primeira versão desta checagem aceitava exatamente
     o texto que deveria barrar, e a prova mostrou. Exijo a marca explícita e recuso a negativa. */
  const conferida = /\bCONFERIDA\b/.test(linha) && !/n[ãa]o\s+conferid/i.test(linha);
  const arq = TELAS.find(([e]) => e === empresa)[1];
  const pref = TELAS.find(([e]) => e === empresa)[2];
  let tela = '';
  try { tela = fs.readFileSync(path.join(raiz, arq), 'utf8'); } catch (e) {}
  const inclui = tela.includes(pref + '/js/' + peca + '.js');
  if (inclui && !conferida) naoConferidas.push(peca + ' × ' + empresa);
}

assert.deepStrictEqual(naoConferidas, [],
  '[PECA-MENOS] estas empresas JÁ INCLUEM a peça sem a conferência estar marcada como feita em ' +
  'docs/paridade-pecas.md: ' + naoConferidas.join(', ') +
  '. Migração que entrega menos é regressão com nome de melhoria — e sai num PR chamado ' +
  '"unificar", onde ninguém procura regressão.');

console.log('OK: ' + comEmbutida.length + ' par(es) peca x empresa com tela embutida, todos registrados');
