'use strict';
/* 17/09 — PORTE achado ao classificar as três últimas rotas quase-idênticas do passo 4. As
   diferenças de `ml-fee`, `ciclo-agora` e `backfill-nf-auto` eram TODAS a mesma coisa: a AMB e
   a Girassol aceitam CHAVE DE ADMIN ou sessão; a GOOD aceitava só sessão.

   Não é diferença de operação — é capacidade que ficou pra trás, e com efeito prático: rotina
   automática, cron externo e diagnóstico por URL não têm sessão de navegador. Essas rotas eram
   INALCANÇÁVEIS por chave na GOOD enquanto as outras duas respondiam, e o sintoma seria um 403
   que parece permissão negada quando é só o desenho faltando.

   O teste guarda a PARIDADE DO MODO DE AUTENTICAR: é aí que uma empresa fica inalcançável sem
   nada quebrar. */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const raiz = path.join(__dirname, '..');

const ARQS = {
  amb: 'amb-checkout-offline/index.js',
  girassol: 'girassol-backup-offline/gbo-app.js',
  good: 'good-checkout-offline/index.js',
};

/* nenhuma empresa pode ter rota admin que aceite SÓ sessão */
for (const [emp, arq] of Object.entries(ARQS)) {
  const s = fs.readFileSync(path.join(raiz, arq), 'utf8');
  const soSessao = (s.match(/if \(!opSess \|\| !ehAdmin\(opSess\)\) \{ json\(res, 403/g) || []).length;
  assert.strictEqual(soSessao, 0,
    emp + ' tem ' + soSessao + ' rota(s) admin que aceitam SÓ sessão — rotina automática e cron não têm ' +
    'sessão de navegador, então essas rotas ficam inalcançáveis por chave nesta empresa');

  /* e o caminho com chave tem que existir */
  const comChave = (s.match(/const _okAdm = \(process\.env\.ADMIN_KEY && _kAdm === process\.env\.ADMIN_KEY\)/g) || []).length;
  assert.ok(comChave > 0, emp + ': nenhuma rota admin aceita chave — o padrão das outras empresas não chegou aqui');
}

/* as três têm que ter o MESMO número de rotas admin por chave: divergir aqui é a mesma
   capacidade faltando voltando por outra rota */
const contagens = Object.entries(ARQS).map(([emp, arq]) => {
  const s = fs.readFileSync(path.join(raiz, arq), 'utf8');
  return [emp, (s.match(/const _okAdm = /g) || []).length];
});
const ref = contagens[0][1];
for (const [emp, n] of contagens) {
  assert.ok(Math.abs(n - ref) <= 8,
    emp + ' tem ' + n + ' rotas admin por chave e ' + contagens[0][0] + ' tem ' + ref +
    ' — diferença grande demais indica capacidade que ficou pra trás numa delas');
}

console.log('OK: admin por chave — nenhuma empresa tem rota admin que aceite só sessão, e as três têm o caminho por chave');
