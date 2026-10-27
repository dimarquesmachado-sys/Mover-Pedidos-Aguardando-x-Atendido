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
/* passo 2 (27/10): o modelo ganhou o liga/desliga do botão de etiquetas em massa (só a GOOD tem o botão; sem ele, a linha
   não faz nada) — tirando ESSA linha, a Girassol continua byte a byte o painel de antes */
const B3 = " const b3=document.getElementById('btnEtqMassa'); if(b3) b3.style.display = souAdmin()? '' : 'none';";
assert.strictEqual(html.split(B3).length, 2, 'o liga/desliga do botão de etiquetas em massa não está no modelo (uma vez)');
assert.strictEqual(crypto.createHash('sha256').update(html.replace(B3, ''), 'utf8').digest('hex'), SHA_GIRASSOL_ANTES, 'o painel da Girassol pela peça mudou além do liga/desliga (byte a byte)');
assert.ok(!/\{\{[A-Z_]+\}\}/.test(html), 'sobrou marcador no painel');
let erro = null; try { P.renderizar(Object.assign({}, marca, { LOGO: '' })); } catch (e) { erro = e.message; }
assert.ok(erro && /não tem LOGO/.test(erro), 'marca incompleta tinha que recusar: ' + erro);
const gbo = fs.readFileSync(path.join(raiz, 'girassol-backup-offline', 'gbo-app.js'), 'utf8');
assert.ok(gbo.includes("const htmlContent = require('../lib/checkout/painel/painel-galpao').painelDaEmpresa(require('./painel-marca'));"), 'a rota do painel da Girassol não entrega a peça');
assert.ok(gbo.includes("uiBuild: require('./painel-marca').UI_BUILD,"), 'a versão do painel da Girassol não vem da marca');
assert.ok(!fs.existsSync(path.join(raiz, 'girassol-backup-offline', 'painel.html')), 'sobrou a cópia do painel na pasta da Girassol');
assert.strictEqual(require('../lib/checkout/contexto-api').montar ? 'ok' : 'x', 'ok');
/* passo 2 (27/10) — a AMB e a GOOD servem a mesma peça, NIVELANDO POR CIMA: tudo o que o painel delas tinha (funções,
   elementos e rotas — a lista guardada antes de apagar as cópias) continua; e cada uma ganha o que faltava */
const antes = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'painel-amb-good-antes.json'), 'utf8'));
const re = require('../scripts/fixtures/_feats-painel-helper.js');
for (const [pasta, emp] of [['amb-checkout-offline', 'amb'], ['good-checkout-offline', 'good']]) {
  const mk = require('../' + pasta + '/painel-marca');
  const h = P.renderizar(mk);
  const f = re.feats(h);
  for (const k of ['funcoes', 'ids', 'rotas']) {
    const perdeu = antes[pasta][k].filter((x) => !f[k].includes(x));
    assert.deepStrictEqual(perdeu, [], pasta + ': o painel único PERDEU ' + k + ' que ela tinha: ' + perdeu.join(', '));
  }
  for (const [ganho, rx] of [['aviso do canário', /id="canarioAviso"/], ['checar o canário', /async function checarCanario\(\)/], ['📎 anexar NF', /async function anexarNF\(/],
                             ['agrupar por produto (maior grupo primeiro)', /GRUPOS MAIORES PRIMEIRO/], ['Shein', /shein:\{n:'Shein'/], ['📈 Dashboard', /id="btnDashboard"/]]) {
    assert.ok(rx.test(h), pasta + ': não ganhou ' + ganho);
  }
  assert.ok(h.includes("fetch('/" + pasta + "/canario-estado'") && h.includes('/magalu/ir/' + emp + '?n=') && h.includes('/fragil/api/skus?empresa=' + emp), pasta + ': rota de outra empresa no painel');
  for (const outra of ['girassol-backup-offline', 'amb-checkout-offline', 'good-checkout-offline'].filter((x) => x !== pasta)) assert.ok(!h.includes('/' + outra + '/'), pasta + ': o painel tem rota da ' + outra);
  assert.ok(h.includes("const UI_BUILD = '" + mk.UI_BUILD + "';") && h.includes('<title>' + mk.TITULO + '</title>'), pasta + ': versão ou título não são os da marca');
  assert.strictEqual(/id="btnEtqMassa"/.test(h), emp === 'good', pasta + ': o botão de etiquetas em massa só existe onde o servidor tem a rota (a GOOD)');
  const ix = fs.readFileSync(path.join(raiz, pasta, 'index.js'), 'utf8');
  assert.ok(ix.includes("const htmlContent = require('../lib/checkout/painel/painel-galpao').painelDaEmpresa(require('./painel-marca'));") && ix.includes("uiBuild: require('./painel-marca').UI_BUILD,"), pasta + ': a rota não entrega a peça (ou a versão não vem da marca)');
  assert.ok(!fs.existsSync(path.join(raiz, pasta, 'painel.html')), pasta + ': sobrou a cópia do painel');
}
console.log('ok — painel do galpão em peça única nas três: a Girassol byte a byte (fora o liga/desliga inerte); AMB e GOOD com tudo o que tinham e mais o que faltava');
