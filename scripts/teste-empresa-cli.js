'use strict';
/* 14/09 — Fase 5 da auditoria: o onboarding vira comando. Antes, saber se uma empresa estava
   pronta significava abrir o Render, conferir env por env e descobrir o resto no primeiro
   erro de produção — de madrugada, porque é quando os crons rodam.
   O teste guarda três coisas:
     • o validar FALHA (código 1) quando falta env obrigatória — ele é portão, não relatório;
     • NENHUM valor de segredo é impresso, só o nome da env. O dono já teve a ADMIN_KEY
       exposta num link; ferramenta de diagnóstico que vaza chave é pior que não ter;
     • o plano mostra os callbacks com URL COMPLETA e o sufixo certo de cada empresa. */
const assert = require('assert');
const { execFileSync } = require('child_process');
const path = require('path');

const CLI = path.join(__dirname, 'empresa.js');
function roda(args, env) {
  try { return { saida: execFileSync('node', [CLI].concat(args), { encoding: 'utf8', env: Object.assign({}, process.env, env || {}) }), code: 0 }; }
  catch (e) { return { saida: (e.stdout || '') + (e.stderr || ''), code: e.status }; }
}

/* portão: sem envs, falha */
const semEnv = {};
for (const n of ['GOOD_BLING_CLIENT_ID', 'GOOD_ML_CLIENT_ID', 'GOOD_ADMIN']) semEnv[n] = '';
const r1 = roda(['validar', 'good'], semEnv);
assert.strictEqual(r1.code, 1, 'validar tem que SAIR COM ERRO quando falta env — é portão de deploy, não relatório');
assert.ok(/falta GOOD_BLING_CLIENT_ID/.test(r1.saida), 'tem que dizer QUAL env falta, pelo nome exato do Render');

/* com tudo presente MENOS ME_LOJA_IDS, ainda falha — 16/09 (Codex #485, P2): o padrão
   herdado saiu de lib/fiscal/bling-api.js, então good também derruba o boot sem a env
   própria agora, igual quem nasce sem pasta. "validar" tem que dizer isso ANTES do deploy,
   não deixar a pessoa descobrir no primeiro require em produção. */
/* Codex #485 (P2): `{}` só ACRESCENTA ao process.env — num ambiente que já define a env
   (diagnosticar o Render configurado, por exemplo), o teste herdava o valor e passava por
   acaso, provando o contrário do que diz provar. Apagar explicitamente é o único jeito. */
const semLoja = { ME_LOJA_IDS: '', AMB_ME_LOJA_IDS: '', GOOD_ME_LOJA_IDS: '', GIRASSOL_ME_LOJA_IDS: '' };
for (const n of ['BLING_CLIENT_ID', 'BLING_CLIENT_SECRET', 'BLING_REDIRECT_URI', 'NF_BLING_CLIENT_ID',
                 'NF_BLING_CLIENT_SECRET', 'NF_BLING_REDIRECT_URI', 'ML_CLIENT_ID',
                 'ML_CLIENT_SECRET', 'ML_REDIRECT_URI', 'OPERADORES', 'ADMIN']) semLoja['GOOD_' + n] = 'valor-secreto-do-teste';
const r1b = roda(['validar', 'good'], semLoja);
assert.strictEqual(r1b.code, 1, 'sem GOOD_ME_LOJA_IDS, "validar good" tem que sair com erro — a empresa não sobe mais sem ela');
assert.ok(/GOOD_ME_LOJA_IDS/.test(r1b.saida), 'tem que apontar GOOD_ME_LOJA_IDS como a pendência');

/* 17/09 (Codex #485, P2): presente mas malformada ("abc") também tem que falhar — o
   parse de lib/fiscal/bling-api.js filtra isso pra lista vazia no runtime, e o F1/F2/F3
   param igual a env ausente. "validar" tinha só `!process.env[nome]`, que aprovava isso. */
const comLojaInvalida = Object.assign({}, semLoja, { GOOD_ME_LOJA_IDS: 'abc' });
const r1c = roda(['validar', 'good'], comLojaInvalida);
assert.strictEqual(r1c.code, 1, 'GOOD_ME_LOJA_IDS=abc tem que sair com erro — não sobra id numérico depois do parse');
assert.ok(/GOOD_ME_LOJA_IDS/.test(r1c.saida), 'tem que apontar GOOD_ME_LOJA_IDS como a pendência mesmo estando presente');

/* com tudo presente, passa */
const comEnv = Object.assign({}, semLoja, { GOOD_ME_LOJA_IDS: '203296034' });
const r2 = roda(['validar', 'good'], comEnv);
assert.strictEqual(r2.code, 0, 'com as envs no lugar, tem que passar: ' + r2.saida.slice(-200));

/* NUNCA imprimir segredo */
assert.ok(!/valor-secreto-do-teste/.test(r2.saida), 'o CLI IMPRIMIU o valor de uma env — isso não pode acontecer nunca');
const r3 = roda(['plano', 'good'], comEnv);
assert.ok(!/valor-secreto-do-teste/.test(r3.saida), 'o plano imprimiu valor de env');

/* plano: URL completa e o slug da empresa certa */
assert.ok(/https:\/\/[^\s]+\/good\/callback\b/.test(r3.saida), 'o plano tem que trazer a URL COMPLETA do callback');
assert.ok(/empresa=eq\.good/.test(r3.saida), 'tem que dizer a fatia do Supabase da empresa');
assert.ok(/escalonad/i.test(r3.saida), 'tem que avisar do minuto escalonado do F3 — empresas no mesmo minuto brigam por cota');

/* empresa fora do contrato não inventa nada */
const r4 = roda(['plano', 'nao-existe'], comEnv);
assert.notStrictEqual(r4.code, 0, 'empresa fora do contrato tem que falhar');
assert.ok(/não está no contrato/.test(r4.saida));

/* 15/09 — a EXPEDIÇÃO entra no plano porque muda o destino do pedido conferido, e isso é
   decisão de operação que ninguém adivinha lendo código. A empresa nova que vem por aí NÃO
   terá o app, então o plano precisa dizer que a env de VERIFICADO dela recebe o id do
   DESPACHADOS — senão alguém "conserta" isso depois, como eu quase fiz com a AMB e a GOOD. */
{
  const comExp = roda(['plano', 'girassol'], comEnv);
  assert.ok(/TEM app de Expedição/.test(comExp.saida), 'o plano da Girassol tem que dizer que ela tem Expedição');
  assert.ok(/VERIFICADO/.test(comExp.saida));

  const semExp = roda(['plano', 'good'], comEnv);
  assert.ok(/NÃO tem app de Expedição/.test(semExp.saida), 'e o da GOOD, que não tem');
  assert.ok(/DIRETO pra DESPACHADOS/.test(semExp.saida), 'tem que dizer o EFEITO, não só a ausência');
  assert.ok(/não é engano/.test(semExp.saida),
    'e avisar que a env de VERIFICADO com id de DESPACHADOS é proposital — senão alguém conserta depois');
}

/* 16/09 (P2 do Codex) — PRESENÇA NÃO É VALIDADE. `GOOD_ME_LOJA_IDS=abc` passava como
   "presente" e o validar saía "pronta", mas em produção a lista de canais fica vazia e o F1
   e o F3 se recusam a rodar. Portão que APROVA configuração quebrada é pior que não ter
   portão: é ele que dá a confirmação pro dono seguir pro deploy. */
{
  const malformado = Object.assign({}, comEnv, { GOOD_ME_LOJA_IDS: 'abc' });
  const r = roda(['validar', 'good'], malformado);
  assert.notStrictEqual(r.code, 0, 'env presente mas malformada tem que reprovar');
  assert.ok(/MALFORMADA/.test(r.saida), 'e dizer que o problema é o FORMATO, não a ausência');
  assert.ok(/ids numéricos/.test(r.saida), 'com o formato esperado escrito — senão o dono não sabe o que corrigir');

  const bom = Object.assign({}, comEnv, { GOOD_ME_LOJA_IDS: '203296034,206069383' });
  const r2 = roda(['validar', 'good'], bom);
  assert.ok(!/MALFORMADA/.test(r2.saida), 'lista com vírgula é VÁLIDA — ML normal + ML Full na mesma env');
}

/* 16/09 — o contrato v12 mudou a forma do `dono_hoje`: é um OBJETO por integração com a LISTA
   de serviços que renovam. Lido como texto, o aviso saía "[object Object]" — e isso não era só
   feio: escondia o CONFLITO ATIVO de refresh, que é o risco nº 1 da auditoria. */
{
  const r = roda(['validar', 'good'], comEnv);
  assert.ok(!/\[object Object\]/.test(r.saida), 'o aviso de dono não pode imprimir objeto cru');
  assert.ok(/CONFLITO ATIVO/.test(r.saida),
    'mais de um serviço renovando a mesma integração é conflito de refresh e tem que aparecer — o token é de uso único');
}

console.log('OK: CLI de empresa — validar é portão, plano traz URL completa e fatia certa, e nenhum valor de segredo é impresso');
