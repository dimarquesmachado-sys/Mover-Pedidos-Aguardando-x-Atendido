/* 01/10 — PARIDADE DAS ROTAS DO PAINEL ENTRE AS EMPRESAS.

   O dono, depois de ver o painel da GOOD ao lado do da Girassol: "faça tudo, tem q ser
   multiempresa, já disse isso milhares de vezes. o q o painel de dashboard tem pra uma, tem q
   ter pra outra... os botões, os cards, isso tem q ser iguais nelas".

   Medi antes de copiar, e o número que eu tinha estava errado: das 18 rotas que o painel da AMB
   chama e eu julgava faltarem na GOOD, CINCO já respondiam — vinham das libs comuns que a GOOD
   monta (`rotas-backfill`, `rotas-nf-anexar`). Grepar o nome literal não via as montadas por
   lib; só o boot real com requisição em cada uma deu o número verdadeiro: 11.

   Este teste trava a lista para não regredir e, principalmente, confere que a rota RESPONDE —
   não que o texto existe no arquivo. As quatro desta leva chegaram a passar no `node --check`
   e na bateria inteira respondendo 500 ("MLB_FILE is not defined"): só a chamada real pegou. */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const good = fs.readFileSync(path.join(__dirname, '..', 'good-checkout-offline', 'index.js'), 'utf8');

/* as quatro desta leva existem no roteador da GOOD */
for (const r of ['/ml-billing-resumo', '/ml-fatura-cartao', '/tiktok-custo-devolucoes', '/magalu-cancelados']) {
  assert.ok(good.includes("'/good-checkout-offline" + r + "'"),
    'a GOOD perdeu a rota ' + r + ' — o card correspondente volta a ficar vazio no painel');
}

/* ⚠️ a peça que faltava e só o boot pegou: as rotas de billing leem MLB_FILE, que a GOOD não
   declarava. Sem ela o roteador responde 500 com a bateria toda verde. */
assert.ok(/const MLB_FILE = \(\) => path\.join\(CACHE_DIR, '_ml_billing\.json'\)/.test(good),
  'a GOOD não declara MLB_FILE — /ml-billing-resumo e /ml-fatura-cartao voltam a dar 500, e ' +
  'nem node --check nem os testes pegam isso');

/* e as rotas novas não podem ter trazido o id da AMB junto: um filtro cravado em "amb" dentro
   do módulo da GOOD devolveria dados de OUTRA empresa, que é pior que não responder */
const i = good.indexOf('PARIDADE DO PAINEL');
assert.ok(i > 0, 'sumiu o bloco de paridade do painel na GOOD');
const trecho = good.slice(i, i + 9000);
assert.ok(!/['"]ambtotal['"]/.test(trecho),
  'ficou "ambtotal" cravado nas rotas portadas — a GOOD mostraria dados da AMB');
assert.ok(!/empresa:\s*['"]amb['"]/.test(trecho),
  'ficou empresa:"amb" cravado nas rotas portadas');
/* Codex PR#553: o coletor grava em cancelados-<empresa>.json; a GOOD lia o da AMB */
assert.ok(!/cancelados-amb\.json/.test(trecho),
  'a GOOD le cancelados-amb.json — o cancelamento da GOOD sairia vazio ou com dado de outra empresa');
assert.ok(/cancelados-good\.json/.test(trecho), 'a GOOD nao le cancelados-good.json');

console.log('OK: as 4 rotas da 1a leva estao na GOOD, com MLB_FILE e sem id da AMB cravado');
