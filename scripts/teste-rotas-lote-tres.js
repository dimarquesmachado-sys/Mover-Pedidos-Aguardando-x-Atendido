'use strict';
/* 30/10 — passo 2 das ROTAS DE LOTE (lib/checkout/rotas-lote): a AMB e a Girassol GANHAM o que só a GOOD tinha — etiquetas
   em MASSA (o ZIP da Shopee: cada etiqueta casa com o pedido pela NF de dentro dela), a página de envio, as DANFEs em lote
   e o botão 📎 no painel (só admin). O comportamento da peça está provado em scripts/teste-rotas-lote-peca.js (inclusive
   com o prefixo da AMB); aqui: as três montam a peça com o prefixo, o log, o nome e a empresa DELAS, chamam DENTRO do
   handler (depois do porteiro de sessão), deixam o lote de DANFEs com o guard próprio (como a GOOD), e o painel de cada
   uma tem o botão apontando pra rota DELA. */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const raiz = path.join(__dirname, '..');
const EMP = [
  ['GOOD', 'good-checkout-offline/index.js', 'good-checkout-offline', "prefixo: '/good-checkout-offline', tag: 'GOODBKP', nome: 'GOOD', empresaAviso: 'good',"],
  ['AMB', 'amb-checkout-offline/index.js', 'amb-checkout-offline', "prefixo: '/amb-checkout-offline', tag: 'AMBBKP', nome: 'AMB', empresaAviso: 'amb',"],
  ['Girassol', 'girassol-backup-offline/gbo-app.js', 'girassol-backup-offline', "prefixo: '/girassol-backup-offline', tag: 'GIRABKP', nome: 'Girassol', empresaAviso: 'girassol',"],
];
const painel = require('../lib/checkout/painel/painel-galpao');
for (const [nome, arq, pasta, cfg] of EMP) {
  const s = fs.readFileSync(path.join(raiz, arq), 'utf8');
  assert.ok(s.includes("require('../lib/checkout/rotas-lote').criarRotasLote({") && s.includes(cfg), nome + ': não monta a peça com a configuração dela');
  assert.ok(s.includes('    validarSessao, ehAdmin, baixarDanfe,'), nome + ': a peça não recebe a sessão/admin/DANFE da empresa');
  const iH = s.indexOf('  return async function handle(req, res, urlObj) {'), iC = s.indexOf('if (await _rotasLote(readBody).handle(req, res, p, method, urlObj)) return true;');
  assert.ok(iH > 0 && iC > iH, nome + ': a chamada das rotas de lote não está dentro do handler');
  assert.ok(s.includes("p === '/" + pasta + "/danfes-lote' ||"), nome + ': o lote de DANFEs não tem o guard próprio (o porteiro devolveria 401 em vez de voltar pro painel)');
  const h = painel.renderizar(require(path.join(raiz, pasta, 'painel-marca.js')));
  assert.ok(h.includes('id="btnEtqMassa"') && h.includes("window.open('/" + pasta + "/etiquetas-massa'"), nome + ': o painel não tem o botão 📎 apontando pra rota DELA');
  assert.ok(!(pasta !== 'good-checkout-offline' && /good-checkout-offline\/etiquetas-massa/.test(h)), nome + ': o botão aponta pra GOOD');
}
console.log('ok — etiquetas em massa, página de envio e DANFEs em lote nas três (prefixo, log e empresa de cada uma); botão 📎 no painel de cada uma');
