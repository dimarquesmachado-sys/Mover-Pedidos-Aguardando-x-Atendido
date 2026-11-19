'use strict';
/* 19/11 — CASO REAL DO DONO (AMB no Firefox, Toolbox 2.1.20): a Central dizia "cookie salvo, mas sem a sessão (PHPSESSID)
   — entre de novo no Bling", e sair/entrar não mudava nada. A Toolbox só manda quando ACHOU o PHPSESSID no navegador;
   quem perdia era o servidor: a linha crua `cookie: ...` era lida até a primeira aspa (' ou "), e um valor de cookie com
   aspa cortava o header antes do PHPSESSID. O arquivo gravado ficava sem sessão e o importador do Magalu Full parava.
   Prova com o extrator de produção (magalu-oauth/index.js, blingExtrairCookie). A Toolbox instalada (2.1.20) já manda
   certo — o conserto é só no servidor, sem reinstalar extensão. */
const assert = require('assert');
const path = require('path');
const { blingExtrairCookie } = require(path.join(__dirname, '..', 'magalu-oauth', 'index.js'));

/* o formato que a Toolbox manda (tb-acoes.js: 'cookie: ' + header + '\nuser-agent: ' + ua) */
const comAspa = 'cookie: _ga=GA1.1; bling_pref="pt-BR"; PHPSESSID=abc123def456ghi789; outro=x\nuser-agent: Mozilla/5.0 Firefox/128';
const c1 = blingExtrairCookie(comAspa);
assert.ok(/PHPSESSID=abc123def456ghi789/.test(c1), 'valor com aspa dupla antes do PHPSESSID não pode cortar a sessão: ' + c1);
assert.ok(!/user-agent/i.test(c1), 'a linha do user-agent não entra no cookie');
const comApostrofo = "cookie: a=it's; PHPSESSID=zzz9999999999999999; b=2\nuser-agent: UA";
assert.ok(/PHPSESSID=zzz9999999999999999/.test(blingExtrairCookie(comApostrofo)), 'apóstrofo num valor não corta a sessão');
/* as formas cURL continuam valendo (as aspas delimitam SÓ nelas) */
assert.strictEqual(blingExtrairCookie("curl 'https://www.bling.com.br/x' -H 'cookie: PHPSESSID=q1; a=b' -H 'user-agent: UA'"), 'PHPSESSID=q1; a=b', 'cURL com -H cookie');
assert.strictEqual(blingExtrairCookie('curl -b "PHPSESSID=q2; a=b" https://www.bling.com.br/'), 'PHPSESSID=q2; a=b', 'cURL com -b');
console.log('ok — cookie do Bling: valor com aspa não corta o PHPSESSID; cURL continua aceito');
process.exit(0);   /* o módulo agenda um cron ao carregar */
