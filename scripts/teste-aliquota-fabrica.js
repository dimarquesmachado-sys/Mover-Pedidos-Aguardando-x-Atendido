'use strict';
/* 18/09 — VALOR DE FÁBRICA NÃO PODE VIRAR CONFIGURAÇÃO AO SALVAR.

   O dono editou agosto da AMB (8,40952% apurado) e reparou que setembro a dezembro, que
   estavam CINZA (valor de fábrica, não salvo), "pularam pra 8" depois do Salvar. A tela já
   sabia quais eram de fábrica — é o que os pinta de cinza e escreve no `title` —, mas o salvar
   mandava os doze campos iguais. Salvar por causa de UM mês gravava os outros onze como se
   fossem escolha dele.

   Por que isso importa mais do que parece: o painel VENCE a tabela do código. Uma estimativa
   gravada ali passa a mandar, e quando a apuração chegar e a tabela for corrigida, o valor
   certo perde para o palpite antigo — sem erro, sem aviso.

   É a mesma classe do zero que a GOOD tinha, pelo avesso: lá a tela exibia algo que não valia;
   aqui ela gravava algo que não devia. */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const raiz = path.join(__dirname, '..');

const TELAS = {
  amb: 'amb-checkout-offline/amb-dashboard.html',
  girassol: 'girassol-backup-offline/dashboard.html',
};

/* a decisão do salvar, exercitada como o código faz (não uma cópia da regra) */
for (const [emp, arq] of Object.entries(TELAS)) {
  const html = fs.readFileSync(path.join(raiz, arq), 'utf8');

  const marca = /\(salvo==null&&padrao!=null\?' data-fabrica="1"':''\)/.test(html);
  assert.ok(marca, emp + ': o campo não marca quando está mostrando valor DE FÁBRICA — ' +
    'sem a marca, o salvar não tem como distinguir o que o dono digitou do que ele só viu');

  const m = /const deFabrica = i\.dataset\.fabrica === '1' && i\.dataset\.tocado !== '1';\s*\n\s*aliquotas\[i\.dataset\.aliq\] = \(i\.value === '' \|\| deFabrica\) \? null : Number\(i\.value\);/.exec(html);
  assert.ok(m, emp + ': o salvar ainda manda todos os campos igual — valor de fábrica viraria config');

  /* Codex (P2): decidir por comparação de valor (i.value === i.defaultValue) não distinguia
     "nunca tocou" de "digitou de propósito o mesmo número que já estava de fábrica" — os dois
     mandavam null e a confirmação do dono sumia. Quem decide agora é o TOQUE (marcado no
     oninput), não o valor final. */
  const oninput = /oninput="this\.dataset\.tocado=\\'1\\'"/.test(html);
  assert.ok(oninput, emp + ': o campo de alíquota não marca `tocado` ao editar — sem isso o salvar não ' +
    'distingue "nunca tocou" de "digitou de novo o valor de fábrica", e a confirmação do dono vira null');

  /* exercita a regra extraída do próprio arquivo, nos cinco casos reais */
  const decide = new Function('i', m[0].replace('aliquotas[i.dataset.aliq] =', 'return') + '\n');
  const campo = (value, tocado, fabrica) => ({ value, dataset: { fabrica, tocado, aliq: 'x' } });

  assert.strictEqual(decide(campo('8.82', undefined, '1')), null,
    emp + ': mês cinza NÃO tocado tem que ir como null — senão a estimativa vira config e vence o código depois');
  assert.strictEqual(decide(campo('8.40952', '1', '1')), 8.40952,
    emp + ': mês que o dono DIGITOU tem que virar config');
  assert.strictEqual(decide(campo('8.82', '1', '1')), 8.82,
    emp + ': mês cinza que o dono digitou de propósito o MESMO valor de fábrica (apuração bateu ' +
    'igual) tem que virar config — comparar só o valor final perdia essa confirmação');
  assert.strictEqual(decide(campo('6.0414', undefined, undefined)), 6.0414,
    emp + ': mês que já era salvo (sem marca de fábrica) tem que continuar salvo');
  assert.strictEqual(decide(campo('', '1', '1')), null,
    emp + ': campo limpo tem que apagar');

  /* Codex (P1): campo já SALVO (branco, sem marca de fábrica) cujo valor bate com o de fábrica
     atual precisa de um jeito explícito de limpar — pode ser sobra do bug antigo que gravava o
     valor de fábrica sozinho. O botão só aparece nesse caso; não apaga nada sozinho. */
  const botaoLimpar = /suspeita\s*=\s*salvo!=null\s*&&\s*padrao!=null\s*&&\s*Number\(salvo\)===Number\(padrao\)/.test(html) &&
    /suspeita\?\s*'<button/.test(html);
  assert.ok(botaoLimpar, emp + ': falta o botão explícito p/ limpar um mês salvo que bate igual com o ' +
    'valor de fábrica — sem ele, um mês poluído pelo bug antigo (já persistido antes deste conserto) ' +
    'fica preso como config pra sempre');
}

/* a GOOD resolve pelo outro caminho: o campo nasce VAZIO e o valor apurado aparece ao lado.
   O teste guarda isso pra ninguém "melhorar" preenchendo o campo com o valor de fábrica. */
{
  const html = fs.readFileSync(path.join(raiz, 'good-checkout-offline/dashboard.html'), 'utf8');
  /* o que importa aqui é a REGRA, não a forma exata: o campo da GOOD só pode ser preenchido
     com o que está SALVO (`salvo`), nunca com o valor apurado do código (`apur`). O valor
     apurado aparece ao lado, como legenda — se alguém o mover pra dentro do campo, ele vira
     config no primeiro Salvar. */
  const campoGood = /id="aliq_'\+k\+'" value="'\+esc\(([^)]*)\)\+'"/.exec(html);
  assert.ok(campoGood, 'GOOD: não achei a montagem do campo de alíquota');
  assert.ok(/salvo/.test(campoGood[1]) && !/\bapur\b/.test(campoGood[1]),
    'GOOD: o campo está sendo preenchido com o valor APURADO do código (' + campoGood[1] + ') — ' +
    'ao salvar, ele viraria configuração do dono, que é o bug que a AMB teve');
}

console.log('OK: alíquota de fábrica — só vira configuração o que o dono digitou; o que ele apenas viu vai como null');
