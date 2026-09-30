/* 30/09 — LINK DO APP DE DEVOLUÇÕES na barra dos painéis, só para ADMIN, nas três empresas.

   ⚠️ ESTE TESTE NASCEU ERRADO E FOI REESCRITO NO MESMO DIA. Eu pus um botão à mão em cada
   painel.html sem ver que `public/comum/nav.js` JÁ FAZIA ISSO — barra comum, por empresa, e
   já carregada com `data-so-admin`. Ou seja: a parte de "só admin" que eu construí do zero já
   existia pronta, e o resultado teriam sido DOIS botões de Devoluções em cada tela.

   O teste agora trava o lugar CERTO: a nav comum. É lá que a regra por empresa vive, e é lá
   que ela precisa continuar valendo quando a 4ª empresa entrar. */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const raiz = path.join(__dirname, '..');

const nav = fs.readFileSync(path.join(raiz, 'public', 'comum', 'nav.js'), 'utf8');
const DEV = 'https://good-devolucoes-x-marketplaces-x-nfsbling.onrender.com';

assert.ok(nav.includes("var DEV_HOST = '" + DEV + "'"),
  'o host do app de Devoluções mudou na nav — confira se é intencional');

/* 30/09 — OS TRÊS LINKS EM TODO PAINEL. Antes era só o da própria empresa; o dono pediu os
   três, e faz sentido porque esta barra é `data-so-admin`: quem a vê é ele, e pula entre as
   empresas o tempo todo.
   O teste EXECUTA a função e confere a lista que sai, em vez de olhar o texto do arquivo. */
{
  const m = /function itensDevolucoes\(\)[\s\S]*?\n  \}/.exec(nav);
  assert.ok(m, 'sumiu a função que monta os links de Devoluções');
  const itens = new Function('DEV_HOST', m[0] + '; return itensDevolucoes;')(DEV)();
  const urls = itens.map(i2 => i2[1]).sort();
  assert.deepStrictEqual(urls, [DEV + '/', DEV + '/amb/', DEV + '/girassol/'].sort(),
    'a barra não mostra as TRÊS Devoluções — o dono pula entre as empresas e precisa das três');

  /* ⚠️ A BARRA NO FIM É OBRIGATÓRIA. O dono testou na tela: sem ela, `/girassol` não abre a
     Girassol. É um erro que NÃO aparece em nenhuma checagem daqui — a URL é válida, o link
     existe, o teste de sintaxe passa; só clicando é que se descobre. Por isso vira teste. */
  for (const [rotulo, url] of itens) {
    assert.ok(url.endsWith('/'),
      'o link "' + rotulo + '" está sem a barra no fim (' + url + ') — sem ela o módulo da ' +
      'empresa não abre, e isso só apareceria pra quem clicasse');
  }

  /* o nome da empresa em TODOS: num painel de empresa, "Devoluções" sem sobrenome seria lido
     como "a desta tela", e ele abriria a errada achando que está na certa */
  for (const [rotulo] of itens) {
    assert.ok(/Girassol|GOOD|AMB/.test(rotulo),
      'link de Devoluções sem o nome da empresa no rótulo: ' + rotulo);
  }
}

/* ⚠️ O ESTOQUE CONTINUA POR EMPRESA, de propósito: ali quem usa é o GALPÃO, e mostrar o
   estoque de outra empresa pro conferente é convite a bipar na errada. São públicos
   diferentes na mesma barra — se alguém "uniformizar" as duas funções, isto reprova. */
assert.ok(/function itensEstoque[\s\S]*?girassol-backup-offline/.test(nav),
  'o Estoque deixou de ser por empresa — ele é usado pelo galpão, não pelo dono');

/* e o contrato espelhado precisa concordar: é ele que diz quais apps cada empresa tem */
const contrato = JSON.parse(fs.readFileSync(path.join(raiz, 'contrato-empresas.json'), 'utf8'));
assert.strictEqual(contrato.empresas.girassol.ativa_em.devolucoes, true,
  'o contrato diz que a Girassol não tem Devoluções, mas a nav mostra o link — um dos dois ' +
  'está desatualizado, e o do repo do Devoluções é quem manda');

/* a barra é carregada só pra admin: o galpão usa esta tela o dia inteiro */
for (const pasta of ['girassol-backup-offline', 'good-checkout-offline', 'amb-checkout-offline']) {
  const html = fs.readFileSync(path.join(raiz, pasta, 'painel.html'), 'utf8');
  assert.ok(/<script src="\/comum\/nav\.js" data-so-admin><\/script>/.test(html),
    pasta + ': a nav comum perdeu o `data-so-admin` — os links de admin apareceriam pro galpão');
  /* e ninguém pode ter posto um botão à mão de novo: seriam dois links iguais na tela */
  assert.ok(!/btnDevolucoes/.test(html),
    pasta + ': há um botão de Devoluções à mão ALÉM do da nav comum — dois links iguais na tela');
}

console.log('OK: Devolucoes na nav comum — as 3 empresas em todo painel (Estoque segue por empresa), so pra admin e sem duplicata');
