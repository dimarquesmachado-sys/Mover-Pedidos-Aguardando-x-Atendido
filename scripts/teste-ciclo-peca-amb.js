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

/* compara o CÓDIGO (sem comentários, sem indentação) — é o que decide o comportamento; comentário da peça é das três */
const limpa = (t) => require('./_codigo-ciclo')(t).filter((l) => l !== "'use strict';");
/* passo 2 (30/10): a peça ganhou da GOOD o log verdadeiro da série vencida quando o despacho não está configurado (Codex
   #199) — aplica ESSA mudança, e só ela, no texto de antes da AMB; o resto tem que continuar idêntico */
const _velhoLog = "        console.log(`[AMBBKP] série não veio em ${Math.round(ESPERA_FULL_MS/60000)}min — movendo assim mesmo (a unidade diz Full e a NF do marketplace não chegou): ` + venceuEspera.join(', '));\n";
const _fx = fs.readFileSync(path.join(__dirname, 'fixtures', 'ciclo-amb-antes.js'), 'utf8');
assert.ok(_fx.split('if (venceuEspera.length) {\n' + _velhoLog).length === 2, 'a fixture mudou: o trecho da série vencida não está lá uma vez');
const antes = limpa(_fx.replace('if (venceuEspera.length) {\n' + _velhoLog, 'if (venceuEspera.length) {\n' +
  '/* Codex #199 (P2, vinha da GOOD): com o destino DESLIGADO (SIT_DESPACHADOS=0, id da conta nunca configurado) o\n' +
  'bloco do move lá embaixo nem roda — anunciar "movendo" mentiria a cada ciclo, escondendo exatamente a condição\n' +
  'de pedido preso que este log existe pra diagnosticar */\n' +
  'if (SIT_DESPACHADOS) {\n' + _velhoLog + '} else {\n' +
  "console.log(`[AMBBKP] série não veio em ${Math.round(ESPERA_FULL_MS/60000)}min em ${venceuEspera.length} pedido(s), mas o move está DESLIGADO (AMBBKP_SIT_DESPACHADOS não configurado) — ficam em ATENDIDO: ` + venceuEspera.join(', '));\n}\n"));
const agora = limpa(F.ler(raiz, 'amb-checkout-offline/ciclo.js'));
if (JSON.stringify(agora) !== JSON.stringify(antes)) {
  const i = agora.findIndex((l, k) => l !== antes[k]);
  assert.fail('o ciclo como a AMB o roda NÃO é o de antes — 1ª diferença na linha ' + i + ':\n  agora: ' + String(agora[i]).slice(0, 160) + '\n  antes: ' + String(antes[i]).slice(0, 160));
}
assert.ok(antes.length > 900, 'a fixture veio curta (a comparação não provaria nada)');
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
