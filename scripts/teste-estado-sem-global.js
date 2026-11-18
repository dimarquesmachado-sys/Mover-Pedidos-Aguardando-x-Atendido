'use strict';
/* 17/09 — ESTADO DE EMPRESA NÃO MORA EM VARIÁVEL GLOBAL. Achado ao classificar a
   `/backfill-status`, a última das rotas divergentes: o status do backfill de vendas da GOOD
   ficava em `global.__bfGood`, e as três empresas rodam no MESMO processo.

   Hoje não havia colisão porque o nome tem "Good" dentro. A armadilha é o padrão: a empresa
   nova que copiar aquele bloco herda o nome junto, e aí duas empresas escrevem no mesmo
   status — cada uma lendo o progresso do backfill da outra, sem erro nenhum. É a mesma classe
   do id de canal herdado, que custou meia dúzia de rodadas pra sair.

   Este teste proíbe a classe inteira, não o caso: qualquer estado de empresa pendurado em
   `global.` reprova. */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const raiz = path.join(__dirname, '..');

const MODULOS = [
  'amb-checkout-offline/index.js',
  'girassol-backup-offline/gbo-app.js',
  'good-checkout-offline/index.js',
];

/* `global.<algo> =` guardando estado por empresa: proibido.
   Ficam de fora usos legítimos e raros de global que não são estado de empresa (nenhum hoje). */
for (const arq of MODULOS) {
  const s = fs.readFileSync(path.join(raiz, arq), 'utf8');
  const codigo = s.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n');
  const usos = codigo.match(/global\.\w+/g) || [];
  assert.deepStrictEqual(usos, [],
    arq + ' guarda estado em variável GLOBAL (' + [...new Set(usos)].join(', ') + '). ' +
    'As três empresas rodam no mesmo processo: a empresa nova que copiar o bloco herda o nome ' +
    'e passa a escrever no status da outra, sem erro nenhum. Use estado do módulo.');
}

/* e a rota tem que aceitar chave OU sessão nas três — a GOOD aceitava só chave, então o admin
   logado no painel dela não conseguia consultar o backfill sem colar a chave na URL.
   17/11 (montarCheckout, passo 21): a rota virou a peça única lib/checkout/rota-backfill-status — a trava mora nela (uma
   só pras três) e as três a montam. O comportamento (chave OU sessão de admin; sem as duas, 404) é provado RODANDO em
   scripts/teste-rota-backfill-status.js; aqui, que a trava está no corpo da rota da peça e que nenhuma das três voltou a
   escrever a rota à mão (a declaração de antes era onde a trava de UMA podia sumir sem as outras notarem). */
{
  const peca = fs.readFileSync(path.join(raiz, 'lib', 'checkout', 'rota-backfill-status.js'), 'utf8');
  const i = peca.indexOf('return async function rotaBackfillStatus(');
  assert.ok(i > 0, 'a peça do /backfill-status não devolve a rota');
  const corpo = peca.slice(i, peca.indexOf('\n  };', i));
  assert.ok(/ehAdmin\(/.test(corpo), 'a rota da peça não aceita sessão de admin — o admin logado no painel precisaria colar a chave na URL');
  assert.ok(/ADMIN_KEY/.test(corpo), 'a rota da peça não aceita chave de admin — rotina automática não tem sessão de navegador');
}
const EMP_DO = { 'amb-checkout-offline/index.js': 'amb', 'girassol-backup-offline/gbo-app.js': 'girassol', 'good-checkout-offline/index.js': 'good' };
for (const arq of MODULOS) {
  const s = fs.readFileSync(path.join(raiz, arq), 'utf8');
  assert.ok(s.includes("require('../lib/checkout/rota-backfill-status').criar({ empresa: '" + EMP_DO[arq] + "',"), arq + ': não monta o /backfill-status pela peça com a empresa dela');
  assert.ok(!/p === '\/[\w-]+\/backfill-status'/.test(s), arq + ': voltou a escrever o /backfill-status à mão');
}

console.log('OK: backfill-status — nenhum estado de empresa em variável global, e as três aceitam chave OU sessão');
