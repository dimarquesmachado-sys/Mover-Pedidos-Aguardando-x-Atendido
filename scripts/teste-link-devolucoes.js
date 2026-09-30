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

/* cada painel de empresa mostra SÓ o link da sua: mandar o admin da AMB pro app da GOOD é
   pior que não ter link, porque ele age achando que está na empresa certa */
const porEmpresa = [
  ['/girassol-backup-offline', "DEV_HOST + '/girassol'"],
  ['/good-checkout-offline', "DEV_HOST + '/'"],
  ['/amb-checkout-offline', "DEV_HOST + '/amb'"],
];
for (const [rota, alvo] of porEmpresa) {
  const linha = new RegExp("aqui\\.indexOf\\('" + rota + "'\\) === 0[^\\n]*" + alvo.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  assert.ok(linha.test(nav),
    'o painel de ' + rota + ' não aponta para o app de Devoluções da PRÓPRIA empresa');
}

/* a Girassol entrou em 30/09 (o contrato do Devoluções virou devolucoes:true em 28/09).
   Antes disso a nav devolvia lista VAZIA nela — se voltar assim, o link some sem aviso. */
assert.ok(!/girassol-backup-offline'\) === 0\) return \[\];/.test(nav),
  'a nav voltou a dizer que a Girassol NÃO tem Devoluções — ela entrou como 3a empresa');

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

console.log('OK: Devolucoes na nav comum — link da propria empresa nas 3, Girassol incluida, so pra admin e sem duplicata');
