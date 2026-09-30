/* 30/09 — LINK DO APP DE DEVOLUÇÕES na barra do checkout, SÓ PARA ADMIN, nas três empresas.
   Pedido do dono, com as três URLs.

   O ponto sensível não é o link: é ele aparecer pra quem não é admin. O galpão usa esta tela o
   dia inteiro, e o app de Devoluções tem ações que não são pra eles. Por isso o botão precisa
   de DUAS coisas — nascer com display:none E ser revelado pelo mesmo caminho dos outros de
   admin. Só a segunda deixaria o botão visível até o JS rodar. */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const raiz = path.join(__dirname, '..');

const DEV = 'https://good-devolucoes-x-marketplaces-x-nfsbling.onrender.com';
const esperado = {
  'girassol-backup-offline': DEV + '/girassol/',
  'good-checkout-offline': DEV + '/',
  'amb-checkout-offline': DEV + '/amb/',
};

for (const pasta of Object.keys(esperado)) {
  const html = fs.readFileSync(path.join(raiz, pasta, 'painel.html'), 'utf8');
  const js = /<script>([\s\S]*?)<\/script>/.exec(html)[1];

  const botao = /<button[^>]*id="btnDevolucoes"[^>]*>/.exec(html);
  assert.ok(botao, pasta + ': não tem o botão de Devoluções na barra');

  /* a URL de CADA empresa: mandar o admin da AMB pro app da GOOD seria pior que não ter link */
  assert.ok(html.includes("window.open('" + esperado[pasta] + "'"),
    pasta + ': o botão aponta para o app de Devoluções de OUTRA empresa (esperado ' + esperado[pasta] + ')');

  /* nasce escondido — sem isto o galpão vê o botão até o souAdmin() rodar */
  assert.ok(/style="display:none"/.test(botao[0]),
    pasta + ': o botão de Devoluções nasce VISÍVEL — quem não é admin o vê piscar antes de sumir');

  /* e some/aparece pelo mesmo caminho dos outros botões de admin */
  assert.ok(/bDev\.style\.display = souAdmin\(\)/.test(js),
    pasta + ': o botão não é revelado pelo souAdmin() — ficaria escondido até pro dono');
  assert.ok(js.indexOf('bDev') > js.indexOf('function _revelaRelatorio'),
    pasta + ': a revelação do botão está fora da função que revela os de admin');
}

console.log('OK: link de Devolucoes na barra das 3 empresas — URL certa por empresa, nasce escondido e so aparece pro admin');
