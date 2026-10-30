'use strict';
/* 30/10 — o CICLO do checkout vira PEÇA ÚNICA (lib/checkout/ciclo-empresa), passo 1: a peça nasce do ciclo da AMB (o mais
   completo — 1.511 linhas) e a AMB passa a usá-la (o ciclo.js dela vira só a configuração). Prova:
   · o ciclo COMO A AMB O RODA (a peça com os parâmetros dela no lugar — scripts/_fonte-ciclo.js) é, linha por linha e na
     mesma ordem, o ciclo.js de antes da AMB (fixture) — a única mudança é de onde vêm as peças, não o que o código faz;
   · a AMB exporta exatamente as mesmas funções de antes;
   · o estado do ciclo é de cada instância (duas empresas não dividem o "rodando" nem o último resumo). */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const raiz = path.join(__dirname, '..');
const F = require('./_fonte-ciclo');

const limpa = (t) => t.split('\n').map((l) => l.trim()).filter((l) => l && l !== "'use strict';");
const antes = limpa(fs.readFileSync(path.join(__dirname, 'fixtures', 'ciclo-amb-antes.js'), 'utf8'));
const agora = limpa(F.ler(raiz, 'amb-checkout-offline/ciclo.js'));
if (JSON.stringify(agora) !== JSON.stringify(antes)) {
  const i = agora.findIndex((l, k) => l !== antes[k]);
  assert.fail('o ciclo como a AMB o roda NÃO é o de antes — 1ª diferença na linha ' + i + ':\n  agora: ' + String(agora[i]).slice(0, 160) + '\n  antes: ' + String(antes[i]).slice(0, 160));
}
assert.ok(antes.length > 1000, 'a fixture veio curta (a comparação não provaria nada)');
// a AMB exporta as mesmas funções
const mod = require(path.join(raiz, 'amb-checkout-offline', 'ciclo.js'));
const exportsAntes = /module\.exports = \{([^}]*)\}/.exec(fs.readFileSync(path.join(__dirname, 'fixtures', 'ciclo-amb-antes.js'), 'utf8'))[1].split(',').map((x) => x.trim().split(':')[0].trim()).filter(Boolean);
assert.deepStrictEqual(Object.keys(mod).sort(), exportsAntes.sort(), 'a AMB não exporta as mesmas funções de antes');
// o estado é de cada instância
const { criarCiclo } = require('../lib/checkout/ciclo-empresa');
const baseFake = require(path.join(raiz, 'amb-checkout-offline', 'base.js'));
const cfg = (env) => ({ base: baseFake, nf: {}, etiquetas: {}, comum: {}, produtos: {}, arquivo: {}, separacao: {}, prefixoEnv: env, empresaFiscal: env.toLowerCase(),
  mlTokenManager: () => ({}), mlApi: () => ({}), unsFullCasa: ['1'], unsEmissaoPropriaCasa: [] });
const c1 = criarCiclo(cfg('XBKP')), c2 = criarCiclo(cfg('YBKP'));
assert.ok(c1.getUltimoResumo !== c2.getUltimoResumo && c1.unsFullEfetivas !== c2.unsFullEfetivas, 'as instâncias dividem as funções/estado');
let erro = null; try { criarCiclo({ base: baseFake }); } catch (e) { erro = e.message; }
assert.ok(erro && /falta peça da empresa/.test(erro), 'peça sem a configuração da empresa tinha que recusar: ' + erro);
console.log('ok — ciclo em peça única (passo 1, AMB): o ciclo como a AMB roda é, linha por linha, o de antes; mesmas funções; estado por instância');
