'use strict';
/* 27/10 — o PAINEL DO GALPÃO virou PEÇA ÚNICA (lib/checkout/painel/painel-galpao.html + .js): eram três cópias de ~2.300
   linhas, ~96% iguais. Passo 1 (este): a Girassol serve o painel da peça. Prova:
   · o painel renderizado com a marca da Girassol é BYTE A BYTE o painel.html dela de antes (sha256 de antes da troca);
   · marca incompleta não sobe (erro em vez de {{…}} na tela); não sobra marcador;
   · a rota do painel da Girassol entrega a peça, e a versão do painel (o servidor compara com a do navegador) vem da marca. */
const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const raiz = path.join(__dirname, '..');
const P = require('../lib/checkout/painel/painel-galpao');

const SHA_GIRASSOL_ANTES = 'd74373c3987f97de10a77fad5db98c9be49cb47596db67cda5cc7f0719dd9eb0';   /* girassol-backup-offline/painel.html em 27/10, antes da troca */
const marca = require('../girassol-backup-offline/painel-marca');
const html = P.renderizar(marca);
assert.strictEqual(crypto.createHash('sha256').update(html, 'utf8').digest('hex'), SHA_GIRASSOL_ANTES, 'o painel da Girassol pela peça NÃO é o de antes (byte a byte)');
assert.ok(!/\{\{[A-Z_]+\}\}/.test(html), 'sobrou marcador no painel');
let erro = null; try { P.renderizar(Object.assign({}, marca, { LOGO: '' })); } catch (e) { erro = e.message; }
assert.ok(erro && /não tem LOGO/.test(erro), 'marca incompleta tinha que recusar: ' + erro);
const gbo = fs.readFileSync(path.join(raiz, 'girassol-backup-offline', 'gbo-app.js'), 'utf8');
assert.ok(gbo.includes("const htmlContent = require('../lib/checkout/painel/painel-galpao').painelDaEmpresa(require('./painel-marca'));"), 'a rota do painel da Girassol não entrega a peça');
assert.ok(gbo.includes("uiBuild: require('./painel-marca').UI_BUILD,"), 'a versão do painel da Girassol não vem da marca');
assert.ok(!fs.existsSync(path.join(raiz, 'girassol-backup-offline', 'painel.html')), 'sobrou a cópia do painel na pasta da Girassol');
assert.strictEqual(require('../lib/checkout/contexto-api').montar ? 'ok' : 'x', 'ok');
console.log('ok — painel do galpão em peça única: a Girassol recebe byte a byte o painel de antes');
