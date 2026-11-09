'use strict';
/* 08/11 — GRUPO DO ML, PARTE 1, NA FÁBRICA (plano, Fase 3 4c). Rotas em que a cópia e a fábrica (lib/checkout/rotas-painel-ml)
   diferiam SÓ na empresa escrita à mão × a empresa como parâmetro (comparação linha a linha):
   · Girassol: /ml-billing, /ml-vendas-faltando;
   · AMB: /ml-billing, /ml-vendas-faltando, /raio-x-venda, /ml-creditos-flex, /ml-flex-debug — a cópia do raio-x e do
     flex-debug fazia o require do token do ML da AMB DENTRO da rota; agora a AMB entrega o token dela à fábrica.
   Prova (este teste): as cópias saíram, as rotas saíram de rotasProprias e as peças que cada rota da fábrica exige
   (semPeca) chegam à fábrica — conferido contra as guardas DA PRÓPRIA rota, então rota nova que peça outra peça cai aqui.
   (O boot real do PR mostrou as rotas respondendo pela fábrica nas duas, sem "falta peça".) */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const raiz = path.join(__dirname, '..');
const ML = fs.readFileSync(path.join(raiz, 'lib', 'checkout', 'rotas-painel-ml.js'), 'utf8');

function bloco(src, ini) { let n = 0, j = src.indexOf('{', ini); for (; j < src.length; j++) { const c = src[j]; if (c === '{') n++; else if (c === '}') { n--; if (!n) break; } } return j + 1; }
function exigidas(rota) {
  const i = ML.search(new RegExp("p === \\(PREFIXO \\+ '/" + rota.replace(/[-/]/g, '\\$&') + "'\\)"));
  assert.ok(i > 0, 'a fábrica (rotas-painel-ml) não trata /' + rota);
  return [...ML.slice(i, bloco(ML, i)).matchAll(/semPeca\(res, '([^']+)'\)/g)].map((m) => m[1]);
}
for (const [arq, pfx, rotas] of [
  ['girassol-backup-offline/gbo-app.js', '/girassol-backup-offline', ['ml-billing', 'ml-vendas-faltando']],
  ['amb-checkout-offline/index.js', '/amb-checkout-offline', ['ml-billing', 'ml-vendas-faltando', 'raio-x-venda', 'ml-creditos-flex', 'ml-flex-debug']]]) {
  const s = fs.readFileSync(path.join(raiz, arq), 'utf8');
  const ch = s.slice(s.indexOf('criarRotasPainel({'), s.indexOf('\n        });', s.indexOf('criarRotasPainel({')));
  const prop = new Set([...(/rotasProprias:\s*\[([^\]]*)\]/.exec(ch) || ['', ''])[1].matchAll(/'([^']+)'/g)].map((m) => m[1]));
  const pecas = ch.slice(ch.indexOf('pecas:')).replace(/\/\*[\s\S]*?\*\//g, '');
  for (const rt of rotas) {
    assert.ok(!new RegExp("p === '" + pfx.replace(/[-/]/g, '\\$&') + '/' + rt + "'").test(s), arq + ': sobrou cópia de /' + rt);
    assert.ok(!prop.has(rt), arq + ': /' + rt + ' continua em rotasProprias — a fábrica não atenderia');
    for (const n of exigidas(rt)) assert.ok(new RegExp('\\b' + n + '\\b').test(pecas), arq + ': /' + rt + ' exige a peça ' + n + ', que não chega à fábrica (a rota responderia "falta peça")');
  }
}
console.log('ok — grupo do ML (parte 1) na fábrica: as cópias da Girassol e da AMB saíram e cada rota tem as peças que pede');
