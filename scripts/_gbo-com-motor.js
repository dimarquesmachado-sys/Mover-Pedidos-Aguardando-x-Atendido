'use strict';
/* 13/11 — APOIO DE TESTE (não é teste: o nome começa com `_`).

   O motor do histórico de vendas (`backfillVendas`, 790 linhas) saiu de girassol-backup-offline/gbo-app.js pra peça
   lib/checkout/backfill-motor.js. Vários testes antigos conferem o TEXTO do motor "no arquivo da Girassol" — e o que eles
   protegem continua valendo, só mudou de arquivo.

   `texto()` devolve o arquivo da Girassol COM o motor no lugar, como esses testes o conhecem — mas montado a partir da
   PEÇA VIVA (o corpo de hoje, com os caminhos relativos e o token padrão escritos como eram lá). Se alguém mexer no motor,
   é o texto mexido que os testes antigos veem.

   `instalar()` faz as leituras de TEXTO deste processo (fs.readFileSync com 'utf8') do gbo-app.js devolverem isso. O
   carregamento de módulo (`require` do gbo-app.js) NÃO é afetado: quem roda o motor roda o arquivo de verdade, com a peça. */
const fs = require('fs');
const path = require('path');
const raiz = path.join(__dirname, '..');
const ARQ_GBO = path.join(raiz, 'girassol-backup-offline', 'gbo-app.js');
const ARQ_PECA = path.join(raiz, 'lib', 'checkout', 'backfill-motor.js');
const lerCru = fs.readFileSync.bind(fs);

/* [na peça, como era no arquivo da Girassol] — as mesmas trocas registradas em scripts/teste-backfill-motor-peca.js */
const TROCAS = [
  ["require('./backfill-deps')", "require('../lib/checkout/backfill-deps')"],
  ["require('./troca-periodo-historico')", "require('../lib/checkout/troca-periodo-historico')"],
  ["require('./config-empresa')", "require('../lib/checkout/config-empresa')"],
  ["require('./magalu-frete-pacote')", "require('../lib/checkout/magalu-frete-pacote')"],
  ["require('./repasse-pendente')", "require('../lib/checkout/repasse-pendente')"],
  ['    garantirTokenML: () => G.garantirTokenML(),', "    garantirTokenML: () => require('../girassol/mlTokenManager').garantirTokenML(),"],
];

function corpoComoEra() {
  const peca = lerCru(ARQ_PECA, 'utf8');
  const cab = peca.indexOf('  return async function backfillVendas(de, ate, empresa, ctx){\n');
  const ini = peca.indexOf(' } = G;\n', cab) + ' } = G;\n'.length, fim = peca.lastIndexOf('};\n}\n\nmodule.exports');
  if (cab < 0 || fim < ini) throw new Error('_gbo-com-motor: não achei o corpo do motor na peça');
  let corpo = peca.slice(ini, fim);
  for (const [nova, velha] of TROCAS) corpo = corpo.split(nova).join(velha);
  return corpo;
}

function texto() {
  const gbo = lerCru(ARQ_GBO, 'utf8');
  const i = gbo.indexOf('/* 13/11 (plano multiloja, Fase 3 item 5): o MOTOR do histórico de vendas saiu deste arquivo');
  const fecho = 'async function backfillVendas(de, ate, empresa, ctx){ return _backfillMotorPeca(de, ate, empresa, ctx); }';
  const j = gbo.indexOf(fecho, i);
  if (i < 0 || j < 0) throw new Error('_gbo-com-motor: não achei a montagem do motor no arquivo da Girassol');
  return gbo.slice(0, i) + 'async function backfillVendas(de, ate, empresa, ctx){\n' + corpoComoEra() + '}' + gbo.slice(j + fecho.length);
}

function instalar() {
  if (fs.readFileSync.__gboComMotor) return;
  const patch = function (arq, opt) {
    const enc = typeof opt === 'string' ? opt : (opt && opt.encoding);
    if (typeof arq === 'string' && enc && /^utf-?8$/i.test(enc) && path.resolve(arq) === ARQ_GBO && !/node:internal\/modules/.test(String(new Error().stack).split('\n')[2] || '')) return texto();   /* só o CHAMADOR direto conta: o carregador de módulos lê por conta própria; um teste que lê no nível do arquivo tem o carregador logo acima, e é teste */
    return lerCru.apply(fs, arguments);
  };
  patch.__gboComMotor = true;
  fs.readFileSync = patch;
}

module.exports = { texto, corpoComoEra, instalar, ARQ_GBO };
