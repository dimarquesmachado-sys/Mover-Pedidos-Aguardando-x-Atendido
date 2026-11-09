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

/* 08/11 (plano, Fase 3 4c — grupo do backfill na fábrica): a rota /backfill da Girassol e da AMB deixou de ser CÓPIA no
   arquivo de cada uma e passou a ser a da FÁBRICA (lib/checkout/fabrica-rotas-painel), uma só pras três. As travas do eco
   continuam todas — agora conferidas na rota da fábrica — e a comparação da empresa dona da rodada usa a MESMA variável
   (EMPRESA) que o disparo, então elas não podem mais divergir. Em cada empresa: sem cópia, fora das rotas próprias e
   entregando `_backfill`/`backfillVendas` à fábrica. */
const FAB = fs.readFileSync(path.join(raiz, 'lib', 'checkout', 'fabrica-rotas-painel.js'), 'utf8');
const iB = FAB.indexOf("p === (PREFIXO + '/backfill'))");
assert.ok(iB > 0, 'a rota /backfill não está na fábrica');
const s = FAB.slice(iB, iB + 6000);
assert.ok(/const mesmoPeriodo = _backfill\.empresa === EMPRESA && _backfill\.de === de && _backfill\.ate === ate;/.test(s),
  'fábrica: o eco não distingue a empresa dona da rodada -- a 2ª requisição do navegador mostra como recusa o backfill que o usuário acabou de criar');
assert.ok(/backfillVendas\(de, ate, EMPRESA\)/.test(s.slice(s.indexOf('const mesmoPeriodo'))), 'fábrica: o disparo não usa a mesma empresa da comparação');
assert.ok(/segundos < 30/.test(s), 'fábrica: sem janela de tempo, qualquer rechamada viraria eco');
assert.ok(/_backfill\.inicio \? \(Date\.now\(\) - Date\.parse\(_backfill\.inicio\)\) \/ 1000 : 1e9/.test(s),
  'fábrica: estado sem carimbo de início viraria eco e a recusa legítima sumiria');
assert.ok(/_backfill\.de \+ ' a ' \+ _backfill\.ate/.test(s), 'fábrica: recusa sem dizer qual período está rodando');
assert.ok(/inicio:/.test(fs.readFileSync(path.join(raiz, 'girassol-backup-offline', 'gbo-app.js'), 'utf8')),
  'o início da rodada não é gravado (backfillVendas) -- a janela nunca funcionaria');
for (const [emp, arq, pfx] of [['girassol', 'girassol-backup-offline/gbo-app.js', '/girassol-backup-offline'], ['amb', 'amb-checkout-offline/index.js', '/amb-checkout-offline']]) {
  const e = fs.readFileSync(path.join(raiz, arq), 'utf8');
  const ch = e.slice(e.indexOf('criarRotasPainel({'), e.indexOf('\n        });', e.indexOf('criarRotasPainel({')));
  assert.ok(!new RegExp("p === '" + pfx.replace(/[-/]/g, '\\$&') + "/backfill'").test(e), emp + ': sobrou cópia da rota /backfill (e ela atenderia no lugar da fábrica)');
  assert.ok(!/rotasProprias:\s*\[[^\]]*'backfill'[,\s\]]/.test(ch), emp + ': /backfill continua nas rotas próprias -- a fábrica não atenderia');
  assert.ok(/\b_backfill\b/.test(ch.slice(ch.indexOf('pecas:'))) && /\bbackfillVendas\b/.test(ch.slice(ch.indexOf('pecas:'))), emp + ': não entrega _backfill/backfillVendas à fábrica');
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
