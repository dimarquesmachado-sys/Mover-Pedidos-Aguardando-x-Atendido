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

/* Codex #431 (P2): checar só unicidade entre pares deixa passar troca de dono (ex.: a AMB
   recebendo o objeto da GOOD) ou um CNPJ inventado mas único — nenhum dos dois bate com
   outra empresa, então o teste antigo não via nada de errado. Aqui é dado fiscal (CNPJ/IE não
   mudam à toa), então travar o valor exato de cada empresa é o certo, não um exagero. */
const ESPERADO = {
  'amb-checkout-offline': { razao: 'AMBTOTAL MAGAZINE LTDA', cnpj: '64289091000100', ie: '157362152117' },
  'girassol-backup-offline': { razao: 'Magazine Girassol Ltda', cnpj: '27548456000147', ie: '675.374.241.113' },
  'good-checkout-offline': { razao: 'GOOD IMPORT MAGAZINE LTDA', cnpj: '32461988000182', ie: '675.374.437.111' },
};

for (const emp of EMPRESAS) {
  const d = dados(emp);
  const esperado = ESPERADO[emp];
  assert.ok(/require\('\.\/emitente-fallback'\)/.test(fonte(emp)),
    emp + ': o nf.js tem que LER os dados do arquivo da empresa, não trazê-los embutido');
  if (esperado === null) {
    assert.strictEqual(d, null, emp + ': era pra continuar sem dados próprios (fallback nulo)');
  } else {
    assert.ok(d, emp + ': devia ter dados próprios e o fallback está nulo');
    assert.strictEqual(d.razao, esperado.razao, emp + ': razão social não é a desta empresa — ' + JSON.stringify(d));
    assert.strictEqual(d.cnpj, esperado.cnpj, emp + ': CNPJ não é o desta empresa — ' + JSON.stringify(d));
    assert.strictEqual(d.ie, esperado.ie, emp + ': IE não é a desta empresa — ' + JSON.stringify(d));
  }
}

/* quem não tem dados próprios não pode inventar: fallback nulo e bloco vazio */
for (const emp of EMPRESAS) {
  const s = fonte(emp);
  /* desde 14/09 as TRÊS têm dados próprios (o dono informou os da GOOD no mesmo dia), então
     nenhuma pode voltar a ficar sem: fallback ausente significaria DANFE sem emitente, e o
     conserto é dado, não código. */
  assert.ok(dados(emp), emp + ': perdeu os dados próprios do emitente — a DANFE sairia sem o bloco');
  assert.ok(String(dados(emp).cnpj || '').length >= 14, emp + ': CNPJ do emitente parece inválido');
  assert.ok(String(dados(emp).ie || '').length > 0, emp + ': falta a IE do emitente');

  /* 15/09 — a promessa CRESCEU: além de tratar o fallback nulo, o sistema agora APRENDE o
     emitente do XML da primeira NF autorizada. Foi um atrito real — ontem eu tive que pedir
     ao dono o CNPJ da GOOD, e o dado estava no XML o tempo todo. Numa empresa nova, ninguém
     digita nada: basta a primeira nota sair. */
  assert.ok(/_emitAuto\.vigente\(EMITENTE_FALLBACK\)/.test(s), emp + ': falta a rede do emitente aprendido');
  assert.ok(/_emitAuto\.aprender\(x\.emit\)/.test(s), emp + ': a NF tem que ENSINAR o emitente quando ele vem no XML');
  assert.ok(/razao: '', cnpj: '', ie: ''/.test(s), emp + ': o bloco vazio tem que ser explícito');
}

console.log('OK: emitente de reserva — nenhuma empresa imprime o CNPJ de outra, e quem não tem dados próprios sai sem o bloco');
