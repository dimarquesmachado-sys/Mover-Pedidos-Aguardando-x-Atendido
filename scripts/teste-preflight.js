'use strict';
/* 15/09 — bloqueador nº 5 da auditoria de prontidão: testar Supabase e credenciais ANTES de
   liberar cron. A diferença pro `empresa.js validar` é a que importa: validar pergunta se a
   env EXISTE; preflight pergunta se ela FUNCIONA. Env preenchida com valor errado passa no
   primeiro e quebra no primeiro cron, de madrugada.
   O teste guarda as duas regras que não podem falhar nunca:
     • nenhum valor de credencial é impresso — só o que respondeu e o código HTTP;
     • NÃO escreve no Supabase sem --escrever. Gravar em base de produção porque "ia testar"
       é o tipo de ajuda que ninguém pediu; o isolamento é provado com uma linha sentinela
       que o próprio comando remove no fim. */
const assert = require('assert');
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const CLI = path.join(__dirname, 'preflight-empresa.js');
function roda(args, env) {
  try { return { saida: execFileSync('node', [CLI].concat(args), { encoding: 'utf8', env: Object.assign({}, process.env, env || {}) }), code: 0 }; }
  catch (e) { return { saida: (e.stdout || '') + (e.stderr || ''), code: e.status }; }
}

/* sem credenciais, tem que FALHAR dizendo o nome exato da env */
const r1 = roda(['good']);
assert.strictEqual(r1.code, 1, 'sem credenciais o preflight tem que falhar — ele é portão antes do cron');
assert.ok(/SUPABASE_URL_VENDAS_GOOD/.test(r1.saida), 'tem que dizer o nome EXATO da env que falta');

/* nenhum valor de segredo impresso */
const seg = 'SEGREDO-QUE-NAO-PODE-APARECER';
const r2 = roda(['good'], {
  SUPABASE_URL_VENDAS_GOOD: 'https://exemplo.invalido', SUPABASE_KEY_VENDAS_GOOD: seg,
  GOOD_BLING_CLIENT_ID: seg, GOOD_BLING_CLIENT_SECRET: seg, GOOD_ML_CLIENT_ID: seg, GOOD_ML_CLIENT_SECRET: seg,
});
assert.ok(!r2.saida.includes(seg), 'o preflight IMPRIMIU uma credencial — isso não pode acontecer nunca');

/* sem --escrever, nada de INSERT/DELETE: a leitura do fonte prova a intenção, e a saída
   prova o comportamento */
const fonte = fs.readFileSync(CLI, 'utf8');
assert.ok(/const ESCREVER = process\.argv\.includes\('--escrever'\)/.test(fonte), 'a escrita tem que ser opt-in');
assert.ok(/if \(!ESCREVER\)[\s\S]{0,200}return problemas;/.test(fonte),
  'sem --escrever o comando tem que SAIR antes de qualquer POST');
const posEscrever = fonte.indexOf('if (!ESCREVER)');
const posPost = fonte.indexOf("'POST'");
assert.ok(posEscrever > 0 && posPost > posEscrever, 'o POST tem que estar DEPOIS da guarda do --escrever');

/* e a sentinela precisa ser removida — linha de teste esquecida vira número errado no histórico */
assert.ok(/'DELETE'[\s\S]{0,120}numero_loja=eq/.test(fonte), 'a sentinela tem que ser removida no fim');
assert.ok(/remova à mão/.test(fonte), 'se a remoção falhar, tem que avisar pra remover à mão');

console.log('OK: preflight — falha sem credencial dizendo a env exata, nunca imprime segredo, e só escreve com --escrever (removendo a sentinela)');
