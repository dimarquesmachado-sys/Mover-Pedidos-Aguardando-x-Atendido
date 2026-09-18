'use strict';
/* 17/09 — PORTE achado ao classificar a `/config-fiscal`, a penúltima divergente. A conta foi
   a mesma das outras: 32 linhas só na AMB e na Girassol, 3 na GOOD. E o que faltava não era
   rótulo — era a REAPLICAÇÃO DO IMPOSTO.

   O efeito: na GOOD, corrigir a alíquota do Simples de um mês passado salvava a alíquota nova e
   NÃO MEXIA em nada do que já estava gravado. A tela seguia mostrando a margem calculada com a
   alíquota velha, sem erro nenhum — e margem errada é pior que margem ausente, porque um número
   plausível não levanta suspeita.

   Duas peças, e as duas importam: limpar o cache do histórico (senão o agregado de até 30 min
   atrás continua servindo e parece que "não pegou") e reaplicar nas linhas do Supabase, só nos
   meses que mudaram de verdade.

   A lib existe desde 25/08 e servia as outras duas; a GOOD nunca foi ligada. */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const raiz = path.join(__dirname, '..');

const MODULOS = {
  amb: 'amb-checkout-offline/index.js',
  girassol: 'girassol-backup-offline/gbo-app.js',
  good: 'good-checkout-offline/index.js',
};

for (const [emp, arq] of Object.entries(MODULOS)) {
  const s = fs.readFileSync(path.join(raiz, arq), 'utf8');
  const codigo = s.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n');

  assert.ok(/reaplicarImposto\(/.test(codigo),
    emp + ': não reaplica o imposto ao salvar a config fiscal — corrigir a alíquota de um mês ' +
    'passado deixaria a margem antiga na tela, sem erro nenhum');

  /* só os meses que mudaram: reaplicar tudo a cada salvamento varre o histórico inteiro à toa
     e come cota do Supabase */
  assert.ok(/_aliqAntes/.test(codigo),
    emp + ': não guarda a alíquota ANTERIOR — sem comparar, ou reaplica tudo sempre ou não reaplica nada');

  /* e o cache do histórico tem que ser limpo junto, senão o agregado velho continua servindo */
  assert.ok(/delete _histCache/.test(codigo),
    emp + ': não limpa o cache do histórico ao salvar a config — o agregado de até 30 min atrás ' +
    'continuaria servindo e pareceria que a correção "não pegou"');
}

/* Codex #506 (P2) — a GOOD checava `Number(v2)` ANTES de checar null. Como `Number(null)`
   é 0, e 0 passa em `isFinite && n2 >= 0`, o `else if (v2 === null)` nunca era alcançado: um
   mês limpo no ⚙️ (que manda `null` pra apagar) ficava gravado como 0% em vez de apagado —
   e zero salvo aparecia de novo como "valor configurado" no próximo carregamento da tela. */
for (const [emp, arq] of Object.entries(MODULOS)) {
  const s = fs.readFileSync(path.join(raiz, arq), 'utf8');
  assert.ok(/v2 === null \|\| v2 === '' \|\| v2 === undefined\) \{ delete atual\.aliquotas\[k2\]; continue; \}/.test(s),
    emp + ': o `null` (campo limpo/zero) precisa ser tratado ANTES da coerção Number(v2) — ' +
    'Number(null) é 0 e passa no teste de faixa, deixando o delete inalcançável');
}

/* a lib é a mesma para as três: ninguém pode ter uma cópia própria do cálculo */
{
  const lib = fs.readFileSync(path.join(raiz, 'lib', 'imposto-cancelados.js'), 'utf8');
  assert.ok(/async function reaplicarImposto\(ctx, meses, empresa\)/.test(lib),
    'a assinatura da lib mudou — conferir os três chamadores junto');
  assert.ok(/empresa é obrigatória/.test(lib),
    'a lib precisa exigir a empresa: sem ela, uma reaplicação atravessaria o histórico de outra');
}

console.log('OK: reaplicação de imposto — as três reaplicam só nos meses que mudaram e limpam o cache do histórico junto');
