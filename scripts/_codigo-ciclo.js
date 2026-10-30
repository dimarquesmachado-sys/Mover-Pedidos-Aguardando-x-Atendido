'use strict';
/* 30/10 — normaliza o texto do ciclo pra comparar CÓDIGO (sem comentários, sem indentação): usado pelos testes da peça do ciclo */
module.exports = function codigo(t) {
  const out = []; let com = false;
  for (const l of t.split('\n')) {
    let x = l.trim();
    if (com) { if (x.includes('*/')) com = false; continue; }
    if (x.startsWith('/*') && !x.includes('*/')) { com = true; continue; }
    if (!x || x.startsWith('//') || x.startsWith('*') || (x.startsWith('/*') && x.endsWith('*/'))) continue;
    x = x.replace(/\s*\/\*.*?\*\/\s*/g, ' ').replace(/\s+\/\/.*$/, '').replace(/\s+/g, ' ').trim();
    if (x) out.push(x);
  }
  return out;
};
