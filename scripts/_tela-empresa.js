'use strict';
/* Ajudante dos testes (21/10, tela única): a tela de cada empresa sai do GERADOR (lib/checkout/painel/empresas.js),
   não de arquivo. `lerTela(caminho)` devolve a tela GERADA quando o caminho é o da antiga cópia da Girassol
   (girassol-backup-offline/dashboard.html — os testes seguem usando esse nome pra dizer "a tela da Girassol") e, nos
   demais, lê o arquivo. As alíquotas de fábrica vêm do backend de cada empresa, como na rota de produção.
   (Não começa com "teste-": o verifica não roda este arquivo como teste.) */
const fs = require('fs');
const path = require('path');
const raiz = path.join(__dirname, '..');

function aliqDoBackend(arq, nome) {
  const s = fs.readFileSync(path.join(raiz, arq), 'utf8');
  const m = s.match(new RegExp('const ' + nome + ' = (\\{[^;]*\\});'));
  if (!m) throw new Error('_tela-empresa: ' + nome + ' não achado em ' + arq);
  return new Function('return ' + m[1])();
}
function telaDaEmpresa(id) {
  const { painelDaEmpresa } = require('../lib/checkout/painel/empresas');
  if (id === 'girassol') return painelDaEmpresa('girassol', { defaultAliq: aliqDoBackend('girassol-backup-offline/gbo-app.js', 'DEFAULT_ALIQ_BK') });
  if (id === 'good') return painelDaEmpresa('good', { defaultAliq: aliqDoBackend('good-checkout-offline/index.js', 'DEFAULT_ALIQ_BK_GOOD') });
  if (id === 'ambtotal') return painelDaEmpresa('ambtotal');
  throw new Error('_tela-empresa: empresa desconhecida ' + id);
}
/* 28/10: a tela velha da GOOD saiu — o nome dela passa a dizer "a tela da GOOD" (a gerada), como o da Girassol */
const VIRTUAL = { 'girassol-backup-offline/dashboard.html': 'girassol', 'good-checkout-offline/dashboard.html': 'good' };
function lerTela(rel) {
  const r = String(rel).split(path.sep).join('/').replace(/^\.\//, '');
  if (VIRTUAL[r]) return telaDaEmpresa(VIRTUAL[r]);
  return fs.readFileSync(path.join(raiz, r), 'utf8');
}
module.exports = { lerTela, telaDaEmpresa, aliqDoBackend };
