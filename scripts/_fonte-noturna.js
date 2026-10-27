'use strict';
/* 26/10 — a madrugada virou a peça única lib/checkout/noturna-empresa; os arquivos das empresas são uma linha que passa a
   EMPRESA e o PREFIXO. Os testes que conferem o TEXTO da madrugada de uma empresa leem por aqui: se o arquivo é o
   embrulho da peça, devolve o texto da peça "como ficaria" naquela empresa (EMP e PREFIXO trocados pelos dela) —
   o que eles conferiam continua valendo, agora contra o código que de fato roda. */
const fs = require('fs');
const path = require('path');
const raiz = path.join(__dirname, '..');
function fonteNoturna(arq) {
  const s = fs.readFileSync(path.join(raiz, arq), 'utf8');
  const m = /empresa: '([a-z]+)', prefixo: '([^']+)'/.exec(s);
  if (!/lib\/checkout\/noturna-empresa/.test(s) || !m) return s;
  const peca = fs.readFileSync(path.join(raiz, 'lib', 'checkout', 'noturna-empresa.js'), 'utf8');
  return peca.replace(/PREFIXO \+ '/g, "'" + m[2]).replace(/\bEMP\b(?![A-Z_])/g, "'" + m[1] + "'");
}
module.exports = { fonteNoturna };
