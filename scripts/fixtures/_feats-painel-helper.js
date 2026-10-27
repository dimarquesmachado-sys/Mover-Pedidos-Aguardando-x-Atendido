'use strict';
/* as funções, os elementos (id) e as rotas que um painel do galpão usa — a mesma conta que gerou painel-amb-good-antes.json */
function feats(s) {
  const fn = [...new Set([...s.matchAll(/function\s+([A-Za-z_$][\w$]*)\s*\(/g)].map((m) => m[1]))].sort();
  const ids = [...new Set([...s.matchAll(/id="([A-Za-z_][\w-]*)"/g)].map((m) => m[1]))].sort();
  const rotas = [...new Set([...s.matchAll(/['"](\/(?:girassol-backup-offline|amb-checkout-offline|good-checkout-offline)\/[a-z0-9\-/]+)/g)].map((m) => m[1].replace(/\/(girassol-backup-offline|amb-checkout-offline|good-checkout-offline)\//, '/EMP/')))].sort();
  return { funcoes: fn, ids, rotas };
}
module.exports = { feats };

/* 27/10 (Codex #758) — a conta FINA: cada LINHA DE CÓDIGO do painel (sem comentário, sem imagem, com os escapes \uXXXX
   virando o caractere e o prefixo da empresa virando /EMP/), em hash curto. A lista de funções/elementos/rotas não pegou
   duas perdas reais (a chave do /fragil/ da AMB e o link da NF no histórico da GOOD); esta pega. */
function _normLinha(l) {
  let s = String(l).trim();
  s = s.replace(/\s{2,}\/\/.*$/, '');
  s = s.replace(/\\u([0-9a-fA-F]{4})/g, (m, h) => String.fromCharCode(parseInt(h, 16)));
  s = s.replace(/\/(girassol-backup-offline|amb-checkout-offline|good-checkout-offline)\//g, '/EMP/');
  return s.replace(/\s+/g, ' ');
}
function linhasCodigo(html) {
  const crypto = require('crypto');
  const out = new Set();
  for (const l of String(html).split('\n')) {
    if (l.includes('base64')) continue;
    const t = l.trim();
    if (!t || t.startsWith('//') || t.startsWith('/*') || t.startsWith('*')) continue;
    out.add(crypto.createHash('sha1').update(_normLinha(l)).digest('hex').slice(0, 10));
  }
  return out;
}
function textoDaLinha(html, hash) {
  const crypto = require('crypto');
  for (const l of String(html).split('\n')) if (crypto.createHash('sha1').update(_normLinha(l)).digest('hex').slice(0, 10) === hash) return _normLinha(l);
  return null;
}
module.exports.linhasCodigo = linhasCodigo;
module.exports.textoDaLinha = textoDaLinha;
