/* 23/09 — RETOMADA DO #330, que ficou 562 commits pra trás.
   O navegador faz DUAS requisições ao abrir a URL do backfill (a página e o favicon/retry). A
   primeira dispara a rodada; a segunda chega segundos depois, vê o estado já `rodando` e
   respondia "já tem um backfill rodando" — mostrando o backfill que o PRÓPRIO usuário acabou de
   criar. Parecia recusa, e confundiu o dono várias vezes.
   Se o período é o MESMO e a rodada começou há poucos segundos, é eco: responde iniciado. Só
   quando é outro período — ou rodada antiga — é recusa de verdade. */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const raiz = path.join(__dirname, '..');

for (const [emp, arq] of Object.entries({
  girassol: 'girassol-backup-offline/gbo-app.js',
  amb: 'amb-checkout-offline/index.js',
})) {
  const s = fs.readFileSync(path.join(raiz, arq), 'utf8');

  /* Codex (#519): gbo-app.js é o MESMO módulo que good-checkout-offline/index.js importa
     (gbo.backfillVendas) pra rodar o backfill da GOOD — o `_backfill` ali é compartilhado.
     Sem checar a empresa, um backfill da GOOD respondia "iniciado" na rota da Girassol.
     A AMB tem seu próprio `_backfill` e `backfillVendas` isolados (nunca chamado com outra
     empresa), então não precisa dessa checagem extra. */
  const regexMesmoPeriodo = emp === 'girassol'
    ? /const mesmoPeriodo = _backfill\.empresa === 'girassol' && _backfill\.de === de && _backfill\.ate === ate;/
    : /const mesmoPeriodo = _backfill\.de === de && _backfill\.ate === ate;/;
  assert.ok(regexMesmoPeriodo.test(s),
    emp + ': não distingue o eco da própria chamada — a 2ª requisição do navegador mostra ' +
    'como recusa o backfill que o usuário acabou de criar');
  assert.ok(/segundos < 30/.test(s), emp + ': sem janela de tempo, qualquer rechamada viraria eco');

  /* a janela precisa do carimbo de início; sem ele, `1e9` faz cair na recusa — e é o certo,
     porque um estado sem início é de uma rodada antiga, não de agora */
  assert.ok(/_backfill\.inicio \? \(Date\.now\(\) - Date\.parse\(_backfill\.inicio\)\) \/ 1000 : 1e9/.test(s),
    emp + ': estado sem carimbo de início viraria eco e a recusa legítima sumiria');
  assert.ok(/inicio:/.test(s), emp + ': o início da rodada não é gravado — a janela nunca funcionaria');

  /* a recusa legítima tem que dizer QUAL período está ocupando */
  assert.ok(/já tem um backfill rodando \(' \+ _backfill\.de/.test(s) || /_backfill\.de \+ ' a ' \+ _backfill\.ate/.test(s),
    emp + ': recusa sem dizer qual período está rodando — o dono não saberia o que o bloqueou');
}

/* exercita a decisão nos cinco casos — a da rota da Girassol, que também confere a empresa
   dona da rodada (gbo-app.js é compartilhado com a GOOD) */
const decidir = (bf, de, ate) => {
  const mesmo = bf.empresa === 'girassol' && bf.de === de && bf.ate === ate;
  const seg = bf.inicio ? (Date.now() - Date.parse(bf.inicio)) / 1000 : 1e9;
  return (mesmo && seg < 30) ? 'eco' : 'recusa';
};
const agora = new Date().toISOString();
const dezMin = new Date(Date.now() - 600000).toISOString();
assert.strictEqual(decidir({ empresa: 'girassol', de: 'a', ate: 'b', inicio: agora }, 'a', 'b'), 'eco',
  'a 2ª requisição do navegador ainda aparece como recusa');
assert.strictEqual(decidir({ empresa: 'girassol', de: 'a', ate: 'b', inicio: dezMin }, 'a', 'b'), 'recusa',
  'rodada de 10 min atrás virou eco — o usuário acharia que disparou de novo');
assert.strictEqual(decidir({ empresa: 'girassol', de: 'x', ate: 'y', inicio: agora }, 'a', 'b'), 'recusa',
  'outro período rodando virou eco — duas rodadas pesadas juntas derrubam o serviço');
assert.strictEqual(decidir({ empresa: 'girassol', de: 'a', ate: 'b' }, 'a', 'b'), 'recusa',
  'estado sem carimbo de início virou eco');
assert.strictEqual(decidir({ empresa: 'good', de: 'a', ate: 'b', inicio: agora }, 'a', 'b'), 'recusa',
  'Codex #519: um backfill da GOOD com o mesmo período apareceu como "iniciado" na rota da Girassol');

console.log('OK: a 2a requisicao do navegador nao aparece mais como recusa, e a recusa legitima diz qual periodo ocupa');
