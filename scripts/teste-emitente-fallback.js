'use strict';
/* 14/09 — ACHADO AO UNIFICAR OS ESPELHADOS: o emitente de reserva da AMB e da GOOD carregava
   o CNPJ e a IE da MAGAZINE GIRASSOL. Não é detalhe de organização: esse objeto é IMPRESSO
   na DANFE simplificada (razão, CNPJ, IE) quando o XML não traz o emitente — ou seja, um
   documento da AMB podia sair, na caixa do cliente, com o CNPJ de outra empresa.
   A linha estava na lista de exceções do verificador de espelhos, então a divergência era
   conhecida como "diferença esperada" — e ninguém tinha olhado o CONTEÚDO dela.
   O teste guarda: nenhuma empresa pode ter o CNPJ de outra no fallback, e empresa sem dados
   próprios sai SEM o bloco (documento incompleto é problema visível; documento com CNPJ
   errado é erro fiscal que passa despercebido). */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const EMPRESAS = ['amb-checkout-offline', 'girassol-backup-offline', 'good-checkout-offline'];
/* 14/09: os dados saíram do nf.js e viraram emitente-fallback.js em cada pasta — dado de
   empresa dentro de código compartilhado foi exatamente o que permitiu o CNPJ cruzado passar
   despercebido (a linha vivia na lista de exceções do espelho, então a divergência era
   "esperada" e ninguém olhava o conteúdo). */
const fonte = (p) => fs.readFileSync(path.join(__dirname, '..', p, 'nf.js'), 'utf8');
const dados = (p) => require('../' + p + '/emitente-fallback.js');

const cnpjs = {};
for (const emp of EMPRESAS) {
  const d = dados(emp);
  cnpjs[emp] = d ? String(d.cnpj || '') : null;
  assert.ok(/require\('\.\/emitente-fallback'\)/.test(fonte(emp)),
    emp + ': o nf.js tem que LER os dados do arquivo da empresa, não trazê-los embutido');
}

/* o CNPJ de uma empresa não pode aparecer no fallback de outra */
const usados = Object.entries(cnpjs).filter(([, c]) => c);
for (const [emp, cnpj] of usados) {
  const outros = usados.filter(([e2]) => e2 !== emp).map(([, c]) => c);
  assert.ok(!outros.includes(cnpj),
    emp + ': o fallback usa o CNPJ ' + cnpj + ', que é de outra empresa — sairia impresso na DANFE');
}

/* quem não tem dados próprios não pode inventar: fallback nulo e bloco vazio */
for (const emp of EMPRESAS) {
  const s = fonte(emp);
  /* o tratamento do nulo vale nas TRÊS: regra que existe só numa empresa é a porta por onde a
     divergência volta (e aqui quebraria o espelho, que é o que acusou isso). */
  assert.ok(/EMITENTE_FALLBACK \|\|/.test(s), emp + ': falta tratar o fallback nulo');
  assert.ok(/razao: '', cnpj: '', ie: ''/.test(s), emp + ': o bloco vazio tem que ser explícito');
}

console.log('OK: emitente de reserva — nenhuma empresa imprime o CNPJ de outra, e quem não tem dados próprios sai sem o bloco');
