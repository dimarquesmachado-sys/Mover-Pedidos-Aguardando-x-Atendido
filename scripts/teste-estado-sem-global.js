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
   logado no painel dela não conseguia consultar o backfill sem colar a chave na URL */
for (const arq of MODULOS) {
  const s = fs.readFileSync(path.join(raiz, arq), 'utf8');
  /* 17/09 — extrair a DECLARAÇÃO, não a primeira menção: na GOOD o nome também aparece na
     lista de exceções do portão de sessão, e foi exatamente esse engano que inflou a medição
     das rotas (#493). Exigir `{` no fim da linha é o que distingue os dois. */
  const decl = /^( *)if \([^\n]*p === (?:R\('backfill-status'\)|'\/[\w-]+\/backfill-status')[^\n]*\{ *$/m.exec(s);
  assert.ok(decl, arq + ': não achei a DECLARAÇÃO da rota /backfill-status');
  const fim = s.indexOf('\n' + decl[1] + '}', decl.index);
  const m = [s.slice(decl.index, fim)];
  assert.ok(/ehAdmin\(/.test(m[0]),
    arq + ': /backfill-status não aceita sessão de admin — o admin logado no painel precisaria colar a chave na URL');
  assert.ok(/ADMIN_KEY/.test(m[0]),
    arq + ': /backfill-status não aceita chave de admin — rotina automática não tem sessão de navegador');
}

console.log('OK: backfill-status — nenhum estado de empresa em variável global, e as três aceitam chave OU sessão');
