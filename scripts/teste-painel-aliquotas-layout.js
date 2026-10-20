'use strict';
/* 20/10 — a grade das alíquotas do Simples (seção "Impostos e Taxas") aparecia embaralhada: cada mês era um <label> com
   OUTRO <label> (o da caixinha "apurada") dentro — HTML inválido, o navegador fechava o de fora no meio e o "apurada" de
   um mês ia parar em cima do nome do mês seguinte. Confere nas duas telas (a da Girassol e o modelo da AMB, que a GOOD
   também usa): cada mês é um bloco <div> com UM <label> só (o da caixinha), a grade tem largura pra caber, e existe um
   Salvar ao lado das alíquotas (o mesmo salvarCfg do fim da seção). */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
for (const arq of ['girassol-backup-offline/dashboard.html', 'amb-checkout-offline/amb-dashboard.html']) {
  const s = fs.readFileSync(path.join(__dirname, '..', arq), 'utf8');
  const i = s.indexOf("data-aliq=\"'+m+'\"");
  assert.ok(i > 0, arq + ': a grade das alíquotas sumiu');
  const ini = s.lastIndexOf("return '<", i), fim = s.indexOf("}).join('')", i);
  const celula = s.slice(ini, fim);
  assert.ok(/^return '<div /.test(celula), arq + ': o mês voltou a ser um <label> (com outro label dentro)');
  assert.strictEqual((celula.match(/'<label /g) || []).length, 1, arq + ': o mês tem mais de um <label> (aninhado quebra a tela)');
  assert.ok(/'<\/div>';\s*$/.test(celula.trim()) || /'<\/div>';/.test(celula), arq + ': o bloco do mês não fecha com </div>');
  assert.ok(!/'<\/label>';\s*$/.test(celula.trim()), arq + ': sobrou o </label> do bloco antigo');
  assert.ok(/grid-template-columns:repeat\(auto-fill,minmax\(240px,1fr\)\)/.test(s), arq + ': a grade voltou a ser estreita demais pro mês + campo + caixinha');
  assert.ok(/onclick="salvarCfg\(\)">💾 Salvar alíquotas<\/button>/.test(s), arq + ': falta o Salvar ao lado das alíquotas');
  assert.ok(/function salvarCfg\(/.test(s) || /salvarCfg\s*=/.test(s), arq + ': salvarCfg não existe');
}
console.log('ok — grade das alíquotas: cada mês é um bloco com um rótulo só (nada sobreposto), largura certa e Salvar ao lado — nas duas telas');
