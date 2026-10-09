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
     · a empresa só pode incluir o script da peça se a linha dela estiver marcada PRONTA
       (conferida e sem "Falta" pendente);
     · peça que desenha em elemento criado pelo `montar()` não entra por <script src> estático.

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

/* 1) quais peças têm equivalente embutido em alguma tela.
   Codex #638: a descoberta de rotas olha as DUAS formas que as peças usam — `BASE + '/rota'` direto
   e `rota: '/rota'` declarada numa tabela (manutenção faz `BASE + l.rota`) — e a tela embutida pode
   chamar a rota por `MOD` ou por `BASE` (ficha-produto e ferramentas-custo usam `BASE`; os dois
   valem o mesmo prefixo da empresa). A rota só casa se terminar ali: `/historico` não é `/historico-longo`. */
const dir = path.join(raiz, 'lib', 'checkout');
const pecas = fs.readdirSync(dir).filter((f) => /^painel-.*\.js$/.test(f));
assert.ok(pecas.length >= 5, '[PECA-MENOS] achei só ' + pecas.length + ' peça(s) — teste viraria decoração');

const telas = {};
for (const [emp, arq] of TELAS) {
  try { telas[emp] = fs.readFileSync(path.join(raiz, arq), 'utf8'); } catch (e) { telas[emp] = ''; }
}

const comEmbutida = [];
for (const fn of pecas) {
  const s = fs.readFileSync(path.join(dir, fn), 'utf8');
  const rotas = [...new Set([
    ...[...s.matchAll(/\bBASE\s*\+\s*'(\/[\w-]+)/g)].map((m) => m[1]),
    ...[...s.matchAll(/\brota\s*:\s*'(\/[\w-]+)/g)].map((m) => m[1]),
  ])];
  if (!rotas.length) continue;

  for (const [emp] of TELAS) {
    const semEspaco = telas[emp].replace(/\s+/g, '');
    const usa = rotas.filter((r) => new RegExp("\\b(?:MOD|BASE)\\+'" + r + "(?![\\w-])").test(semEspaco));
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

const reLinha = (peca, empresa) => new RegExp('^\\|\\s*' + peca + '\\s*\\|\\s*' + empresa + '\\s*\\|([^\n]*)', 'm');

const semRegistro = comEmbutida.filter(({ peca, empresa }) => !reLinha(peca, empresa).test(doc));

assert.deepStrictEqual(semRegistro.map((x) => x.peca + '×' + x.empresa), [],
  '[PECA-MENOS] estes pares peça×empresa consomem a MESMA rota que a tela embutida e não estão em ' +
  'docs/paridade-pecas.md:\n  ' + semRegistro.map((x) => x.peca + ' × ' + x.empresa + ' (' + x.rotas.join(', ') + ')').join('\n  ') +
  '\nCada linha precisa dizer se a conferência foi feita e o que a embutida tem a mais.');

/* ⚠️ 3) o ponto central: empresa só inclui a peça se a linha estiver PRONTA.
   Codex #638: o universo dos pares é a UNIÃO do que a varredura acha com as linhas do documento. Quem
   troca a tela embutida pela peça tira a rota da tela — e o par sumiria da varredura bem na hora em
   que a checagem importa. A linha do documento é o inventário que não some. */
const documentados = [...doc.matchAll(/^\|\s*([a-z][\w-]*)\s*\|\s*(\w+)\s*\|/gm)]
  .filter((m) => telas[m[2]] !== undefined)
  .map((m) => ({ peca: m[1], empresa: m[2] }));
const pares = new Map();
for (const { peca, empresa } of [...comEmbutida, ...documentados]) pares.set(peca + '×' + empresa, { peca, empresa });

/* A peça entra na tela de qualquer jeito: `<script src>`, ou `MOD + '/js/peca.js'` montado por JS —
   o que importa é o arquivo da peça aparecer como script servido por `/js/`. */
const incluiPeca = (empresa, peca) => telas[empresa].replace(/\s+/g, '').includes('/js/' + peca + '.js');

/* ⚠️ Pronta = marca explícita PRONTA, sem negativa e sem pendência registrada. A primeira versão
   tratava "CONFERIDA" como licença — mas conferir é achar o que falta, não é ter consertado: as linhas
   de previsão dizem CONFERIDA e **Falta** ao mesmo tempo. E "não conferida" CONTÉM "conferida". */
const pronta = (linha) => /\bPRONTA\b/.test(linha) && /\bCONFERIDA\b/.test(linha) &&
  !/n[ãa]o\s+conferid/i.test(linha) && !/\bfalta(m)?\b/i.test(linha);

/* previsão: a peça só desenha dentro de `#previsaoVendasAqui`, que o `montar()` dessas telas cria
   DEPOIS (o painel nasce por innerHTML). `<script src>` estático roda antes e a peça sai sem fazer
   nada — a seção some inteira. Tem de ser injetado depois do innerHTML (docs/good-painel-o-que-falta.md). */
const POS_MONTAR = ['previsao-vendas', 'plano-compra', 'ferramentas-custo'];   /* Codex #648: o plano também nasce dentro do montar() na AMB/Girassol; Codex #652: idem as ferramentas de custo */

const naoProntas = [];
const estaticas = [];
for (const { peca, empresa } of pares.values()) {
  if (!incluiPeca(empresa, peca)) continue;
  const linha = (doc.match(reLinha(peca, empresa)) || [])[1] || '';
  if (!pronta(linha)) naoProntas.push(peca + ' × ' + empresa);
  if (POS_MONTAR.includes(peca) && new RegExp('<script[^>]*\\bsrc=[^>]*/js/' + peca + '\\.js', 'i').test(telas[empresa])) {
    estaticas.push(peca + ' × ' + empresa);
  }
}

assert.deepStrictEqual(naoProntas, [],
  '[PECA-MENOS] estas empresas JÁ INCLUEM a peça sem a linha de docs/paridade-pecas.md estar PRONTA ' +
  '(conferida, sem "Falta" pendente): ' + naoProntas.join(', ') +
  '. Migração que entrega menos é regressão com nome de melhoria — e sai num PR chamado ' +
  '"unificar", onde ninguém procura regressão.');

assert.deepStrictEqual(estaticas, [],
  '[PECA-MENOS] <script src> estático para peça que desenha em elemento criado pelo montar(): ' +
  estaticas.join(', ') + '. Injete por document.createElement("script") DEPOIS do innerHTML do montar() — ' +
  'senão o alvo ainda não existe e a seção some.');

console.log('OK: ' + comEmbutida.length + ' par(es) peca x empresa com tela embutida, ' + pares.size + ' no inventário, todos registrados');
