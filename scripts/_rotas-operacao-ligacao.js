'use strict';
/* COMO CADA EMPRESA LIGA AS ROTAS DA OPERAÇÃO — o que cada peça de rota RECEBE e em que ordem é CHAMADA (14/11).

   Desde 14/11 a ligação das cinco peças de rota da operação (contagem, separação, backfill, NF anexada, conferido) não é
   mais escrita à mão em cada arquivo de empresa: é a peça lib/checkout/rotas-operacao, que tira da configuração da
   empresa o que é dela (prefixo, pasta, env do depósito, id). Os testes que conferiam "o que a empresa passa pra peça X"
   lendo o TEXTO do arquivo dela não têm mais esse texto pra ler — e conferir texto da peça nova provaria menos do que
   provavam. Este ajudante RODA a ligação e devolve o que cada peça de rota recebeu de verdade:

     · `daEmpresa(arq)`  — pega no arquivo VIVO da empresa o trecho `require('../lib/checkout/rotas-operacao').criar(…)`,
       e o executa com a peça de PRODUÇÃO (lib/checkout/rotas-operacao.js + lib/checkout/config-empresa.js). Só as cinco
       peças de rota são dublês (anotam o que receberam e as chamadas), e cada nome do arquivo da empresa vira uma
       SENTINELA com o próprio nome («blingGet», «base.tag», «_bf»…) — assim dá pra dizer exatamente QUAL peça do
       arquivo chegou em cada chave;
     · `deAntes(texto)`  — faz o mesmo com o bloco escrito à mão de antes (scripts/fixtures/rotas-operacao-antes-*).

   Os dois devolvem { recebe: { 'rotas-contagem': {…}, … }, chamar(respostas) → [[peça, [args…]], …] } já em "retrato"
   (sentinela vira o texto «nome»), pra comparar com deepStrictEqual. */
const fs = require('fs');
const path = require('path');

const RAIZ = path.join(__dirname, '..');
const PECAS = ['rotas-contagem', 'rotas-separacao', 'rotas-backfill', 'rotas-nf-anexar', 'rotas-conferido'];
const ARQ_DA_PECA = (n) => path.join(RAIZ, 'lib', 'checkout', n + '.js');
const ARQ_OPERACAO = path.join(RAIZ, 'lib', 'checkout', 'rotas-operacao.js');
const SEPARADOR = '/*@@ CHAMADAS @@*/\n';

function novoMundo(opts) {
  opts = opts || {};
  const nomes = new WeakMap(), cache = new Map();
  /* sentinela: um objeto que só sabe o próprio nome; ler uma propriedade dele dá outra sentinela (`base.tag` → «base.tag») */
  function sent(nome) {
    if (cache.has(nome)) return cache.get(nome);
    const s = new Proxy({}, { get: (t, k) => (typeof k !== 'string' || k === 'then' ? undefined : sent(nome + '.' + k)) });
    nomes.set(s, nome); cache.set(nome, s);
    return s;
  }
  function retrato(v) {
    if (v && (typeof v === 'object' || typeof v === 'function') && nomes.has(v)) return '«' + nomes.get(v) + '»';
    if (Array.isArray(v)) return v.map(retrato);
    if (v && typeof v === 'object') { const o = {}; for (const k of Object.keys(v).sort()) o[k] = retrato(v[k]); return o; }
    if (typeof v === 'function') return '«função sem nome»';
    return v;
  }
  const recebe = {}, chamadas = [], respostas = {};
  const dubles = {};
  for (const n of PECAS) {
    dubles[n] = { criar: (cfg) => {
      if (recebe[n]) throw new Error('a peça ' + n + ' foi criada duas vezes');
      recebe[n] = cfg;
      return async function (...args) { chamadas.push([n, retrato(args)]); return respostas[n] === true; };
    } };
  }
  /* o `require` que o trecho enxerga: o que é da pasta da empresa vira sentinela; `./base` entrega o destino do Full */
  function requireDoTrecho(daLib) {
    return (alvo) => {
      if (alvo === './base') return { SIT_DESPACHADOS: opts.sitDespachados === undefined ? 745123 : opts.sitDespachados };
      const m = /^\.\.\/lib\/checkout\/(rotas-[\w-]+)$/.exec(alvo);
      if (m && daLib[m[1]]) return daLib[m[1]];
      return sent("require('" + alvo + "')");
    };
  }
  /* roda um trecho de código com TODO nome livre resolvido pra sentinela do mesmo nome */
  function rodar(codigo, req) {
    const S = new Proxy({}, {
      has: (t, k) => typeof k === 'string',
      get: (t, k) => (typeof k !== 'string' ? undefined : k === 'require' ? req : k === 'undefined' ? undefined : sent(k)),
    });
    return new Function('S', 'with (S) { ' + codigo + '\n}')(S);   // eslint-disable-line no-new-func
  }
  async function chamar(handler, resp) {
    chamadas.length = 0;
    for (const k of Object.keys(respostas)) delete respostas[k];
    Object.assign(respostas, resp || {});
    const tratou = await handler(sent('req'), sent('res'), sent('urlObj'), sent('method'));
    return { tratou, chamadas: chamadas.map((c) => [c[0], c[1]]) };
  }
  return { sent, retrato, recebe, dubles, requireDoTrecho, rodar, chamar };
}

/* o trecho da ligação no arquivo da empresa: do `require('../lib/checkout/rotas-operacao').criar(` até o `\n  });\n` */
function trechoDaLigacao(src) {
  const marca = "const _rotasOperacao = require('../lib/checkout/rotas-operacao').criar(";
  const i = src.indexOf(marca);
  if (i < 0 || src.indexOf(marca, i + 1) >= 0) throw new Error('o arquivo não liga a peça rotas-operacao exatamente uma vez');
  const f = src.indexOf('\n  });\n', i);
  if (f < 0) throw new Error('não achei o fim da ligação da peça rotas-operacao');
  return src.slice(i, f + '\n  });\n'.length);
}

function daEmpresa(arq, opts) {
  const src = fs.readFileSync(path.join(RAIZ, arq), 'utf8');
  const trecho = trechoDaLigacao(src);
  const M = novoMundo(opts);
  /* a peça de PRODUÇÃO, com as cinco peças de rota trocadas por dublês só durante a montagem */
  const salvos = {};
  const chaves = PECAS.map((n) => require.resolve(ARQ_DA_PECA(n))).concat([require.resolve(ARQ_OPERACAO)]);
  for (const k of chaves) salvos[k] = require.cache[k];
  let handler;
  try {
    PECAS.forEach((n) => { const k = require.resolve(ARQ_DA_PECA(n)); require.cache[k] = { id: k, filename: k, loaded: true, exports: M.dubles[n] }; });
    delete require.cache[require.resolve(ARQ_OPERACAO)];
    const operacao = require(ARQ_OPERACAO);
    handler = M.rodar(trecho + '\nreturn _rotasOperacao;', M.requireDoTrecho({ 'rotas-operacao': operacao }));
  } finally {
    for (const k of chaves) { if (salvos[k]) require.cache[k] = salvos[k]; else delete require.cache[k]; }
  }
  const recebe = {};
  for (const n of PECAS) recebe[n] = M.recebe[n] === undefined ? undefined : M.retrato(M.recebe[n]);
  return { recebe, trecho, chamar: (resp) => M.chamar(handler, resp) };
}

function deAntes(texto, opts) {
  const p = texto.indexOf(SEPARADOR);
  if (p < 0) throw new Error('a fixture não tem o separador das chamadas');
  const criacao = texto.slice(0, p), chamadas = texto.slice(p + SEPARADOR.length);
  const M = novoMundo(opts);
  const handler = M.rodar(criacao + '\nreturn async function () {\n' + chamadas + '\nreturn false;\n};', M.requireDoTrecho(M.dubles));
  const recebe = {};
  for (const n of PECAS) recebe[n] = M.recebe[n] === undefined ? undefined : M.retrato(M.recebe[n]);
  return { recebe, chamar: (resp) => M.chamar(handler, resp) };
}

module.exports = { PECAS, daEmpresa, deAntes, trechoDaLigacao, RAIZ };
