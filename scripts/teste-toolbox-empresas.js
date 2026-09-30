/* 30/09 — A TOOLBOX TEM QUE CONHECER AS MESMAS EMPRESAS QUE A PONTE DE DEVOLUÇÕES.

   O que aconteceu: a Girassol entrou no Devoluções em 28/09, o `bg-devolucoes.js` foi acertado,
   e o POPUP ficou pra trás — o dono não tinha por onde chegar na Devoluções da Girassol pela
   extensão. Mesma classe de erro que a regra da casa chama de "portar tudo, sempre", e que já
   tinha aparecido no próprio bg ("empresa desconhecida na extensao" ao emitir a 1a NF dela).

   ⚠️ A FONTE DA VERDADE AQUI É O `ENDERECO_IDS` DO bg-devolucoes.js, não o contrato: tentei
   amarrar no `ativa_em.devolucoes` do contrato e descobri que ele só está preenchido na
   GIRASSOL — GOOD e AMB, que são as originais, têm `ativa_em` VAZIO. Amarrar ali daria falso
   negativo pras duas empresas que mais usam a ponte.
   O `ENDERECO_IDS` é o que a extensão realmente usa pra emitir: se uma empresa está lá, a
   ponte funciona pra ela, e então o popup PRECISA ter como chegar nela. */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const raiz = path.join(__dirname, '..');

const popup = fs.readFileSync(path.join(raiz, 'toolbox-extensao', 'popup.js'), 'utf8');
const bg = fs.readFileSync(path.join(raiz, 'toolbox-extensao', 'bg-devolucoes.js'), 'utf8');

/* as empresas que a PONTE atende, lidas do próprio código dela */
const bloco = /const ENDERECO_IDS = \{([\s\S]*?)\};/.exec(bg);
assert.ok(bloco, 'sumiu o ENDERECO_IDS do bg-devolucoes — é ele que diz quais empresas a ponte atende');
const naPonte = [...bloco[1].matchAll(/^\s*(\w+):\s*'/gm)].map(m => m[1]);
assert.ok(naPonte.length >= 3,
  'a ponte de Devoluções conhece só ' + naPonte.length + ' empresa(s) — eram 3 em 30/09 (girassol, good, ambtotal)');

/* como cada empresa aparece no rótulo do popup */
const rotulo = { girassol: 'Girassol', good: 'GOOD', ambtotal: 'AMB' };

for (const chave of naPonte) {
  const nome = rotulo[chave];
  assert.ok(nome, 'empresa "' + chave + '" está na ponte e não tem rótulo conhecido — se é empresa ' +
    'nova, acrescente aqui E no popup, senão ela fica sem link');
  assert.ok(new RegExp("\\['↩️ Devoluções " + nome + "', '[^']+'\\]").test(popup),
    'a ponte atende a ' + nome + ' mas o popup não tem link de Devoluções dela — foi exatamente ' +
    'isso que aconteceu com a Girassol em 28/09');
}

/* ⚠️ A BARRA NO FIM: sem ela o módulo da empresa não abre (o dono testou na tela) */
const links = [...popup.matchAll(/\['↩️ Devoluções ([^']*)', '([^']*)'\]/g)];
assert.strictEqual(links.length, naPonte.length,
  'o popup tem ' + links.length + ' links de Devoluções e a ponte atende ' + naPonte.length + ' empresas');
for (const [, nome, url] of links) {
  assert.ok(url.endsWith('/'),
    'o link de Devoluções da ' + nome + ' está sem barra no fim (' + url + ') — sem ela o módulo ' +
    'não abre, e isso só apareceria pra quem clicasse');
}

/* a versão do manifest precisa subir quando a extensão muda: sem isso ele não sabe se
   instalou a nova (ele instala à mão nos três navegadores) */
const manifesto = JSON.parse(fs.readFileSync(path.join(raiz, 'toolbox-extensao', 'manifest.json'), 'utf8'));
assert.ok(/^\d+\.\d+\.\d+$/.test(manifesto.version), 'a versão do manifest saiu do formato X.Y.Z');

console.log('OK: Toolbox — toda empresa atendida pela ponte tem link no popup, com barra no fim (' + naPonte.join(', ') + ')');
