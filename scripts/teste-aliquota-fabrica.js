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
   aqui ela gravava algo que não devia.

   18/09 (revisão do Codex, P2): marcar "apurada" sobre um mês de fábrica intocado — a
   contabilidade confirmou exatamente o número que a tabela já mostrava — caía no MESMO `null`
   do mês nunca tocado, e a marca "apurada" não tinha valor pra salvar. Virou `confirmaApurada`:
   quando a caixinha está marcada, o valor de fábrica exibido vira config de verdade.

   22/09 (revisão do Codex, P2, 2ª rodada): "editado" era decidido comparando o TEXTO final com
   o defaultValue — então retypar de propósito o MESMO número que a fábrica já mostrava (o dono
   conferiu a apuração e bateu com o palpite) parecia campo intocado e virava null, mesmo ele
   tendo mexido no campo. Virou dataset.tocado, ligado por um oninput: intocado agora é só o que
   nunca disparou o evento, não "ainda tem o mesmo valor de antes". */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const raiz = path.join(__dirname, '..');

const TELAS = {
  amb: 'lib/checkout/painel/dashboard.html',
  girassol: 'girassol-backup-offline/dashboard.html',
  good: 'good-checkout-offline/dashboard.html',   /* 28/10: a GOOD usa a tela única (a tela velha saiu) */
};

/* a decisão do salvar, exercitada como o código faz (não uma cópia da regra) */
for (const [emp, arq] of Object.entries(TELAS)) {
  const html = require('./_tela-empresa').lerTela(arq);

  const marca = /\(salvo==null&&padrao!=null\?' data-fabrica="1"':''\)/.test(html);
  assert.ok(marca, emp + ': o campo não marca quando está mostrando valor DE FÁBRICA — ' +
    'sem a marca, o salvar não tem como distinguir o que o dono digitou do que ele só viu');

  assert.ok(/oninput="this\.dataset\.tocado=\\'1\\'"/.test(html),
    emp + ': o campo não rastreia que a mão do dono passou ali — "editado" volta a ser decidido comparando texto, ' +
    'e retypar o mesmo valor de fábrica de propósito vira null de novo');

  const m = /const deFabrica = i\.dataset\.fabrica === '1' && i\.dataset\.tocado !== '1';\s*\n\s*\/\*[\s\S]*?\*\/\s*\n\s*const apuradaEl = document\.querySelector\('\[data-apurada="'\+i\.dataset\.aliq\+'"\]'\);\s*\n\s*const confirmaApurada = deFabrica && apuradaEl && apuradaEl\.checked;\s*\n\s*aliquotas\[i\.dataset\.aliq\] = \(i\.value === '' \|\| \(deFabrica && !confirmaApurada\)\) \? null : Number\(i\.value\);/.exec(html);
  assert.ok(m, emp + ': o salvar ainda manda todos os campos igual — valor de fábrica viraria config');

  /* exercita a regra extraída do próprio arquivo, nos seis casos reais */
  const decide = new Function('i', 'document', m[0].replace('aliquotas[i.dataset.aliq] =', 'return') + '\n');
  const campo = (value, defaultValue, fabrica, tocado) => ({ value, defaultValue, dataset: { fabrica, aliq: 'x', tocado } });
  const fakeDoc = (apuradaChecked) => ({ querySelector: () => apuradaChecked ? { checked: true } : null });

  assert.strictEqual(decide(campo('8.82', '8.82', '1', undefined), fakeDoc(false)), null,
    emp + ': mês cinza NÃO tocado e SEM apurada marcada tem que ir como null — senão a estimativa vira config e vence o código depois');
  assert.strictEqual(decide(campo('8.40952', '8.82', '1', '1'), fakeDoc(false)), 8.40952,
    emp + ': mês que o dono DIGITOU tem que virar config');
  assert.strictEqual(decide(campo('6.0414', '6.0414', undefined, undefined), fakeDoc(false)), 6.0414,
    emp + ': mês que já era salvo (sem marca de fábrica) tem que continuar salvo');
  assert.strictEqual(decide(campo('', '8.82', '1', '1'), fakeDoc(false)), null,
    emp + ': campo limpo tem que apagar');
  assert.strictEqual(decide(campo('8.82', '8.82', '1', undefined), fakeDoc(true)), 8.82,
    emp + ': mês cinza com apurada MARCADA é o dono confirmando que a apuração bateu com a tabela — tem que virar config, senão a marca não salva nada');
  /* 22/09 (Codex P2): o dono RETYPOU de propósito o mesmo número que a fábrica mostrava — a
     apuração bateu com o palpite — sem marcar a caixinha de apurada. dataset.tocado tem que
     mandar aqui, não a comparação de texto: precisa virar config, não null. */
  assert.strictEqual(decide(campo('8.82', '8.82', '1', '1'), fakeDoc(false)), 8.82,
    emp + ': mês cinza RETYPADO com o mesmo valor de fábrica (sem marcar apurada) tem que virar config — ' +
    'comparar com defaultValue faz o dono perder a estimativa que ele digitou de propósito');
}

/* 28/10: o caminho próprio da GOOD (campo vazio + apurado ao lado) era da tela VELHA dela — saiu; a GOOD usa a tela única
   e passa pela mesma conferência das outras, no laço acima. */

console.log('OK: alíquota de fábrica — só vira configuração o que o dono digitou; o que ele apenas viu vai como null');
