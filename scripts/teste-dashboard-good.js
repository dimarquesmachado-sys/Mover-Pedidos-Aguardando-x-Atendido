'use strict';
/* 17/09 — a GOOD não tinha dashboard: a rota existe nas três e procura `dashboard.html` na
   pasta do módulo, e o arquivo dela nunca foi criado. Quem abria recebia
   "dashboard ainda não habilitado nesta empresa".

   A tela nasceu MENOR que a da AMB de propósito. Medindo pela resposta do servidor (não pelo
   texto do arquivo — errei isso três vezes hoje), a GOOD responde 15 das 27 rotas que a tela
   da AMB consome. O que falta não são rotas: é a CAMADA DE COLETA (ML billing, ML devoluções,
   Magalu, TikTok, vendas-sync), que nunca foi portada — só o `vendasSync` são 521 linhas.

   Montar a tela cheia daria cards vazios, e card vazio é pior que card ausente: número que não
   aparece o dono procura, número errado ele acredita.

   Este teste guarda as duas coisas: que a tela existe e que ela NÃO chama rota que a GOOD não
   tem. */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const raiz = path.join(__dirname, '..');

const TELA = path.join(raiz, 'good-checkout-offline', 'dashboard.html');
assert.ok(fs.existsSync(TELA), 'a GOOD voltou a ficar sem dashboard.html — a rota devolve 404 e o dono vê "não habilitado"');

const html = fs.readFileSync(TELA, 'utf8');

/* o JS da tela tem que COMPILAR — `node --check` não olha dentro de HTML, e foi assim que
   `onclick` quebrado já passou despercebido aqui antes */
const js = /<script>([\s\S]*?)<\/script>/.exec(html);
assert.ok(js, 'a tela não tem bloco <script>');
assert.doesNotThrow(() => new Function(js[1]), 'o JS da tela não compila');

/* toda rota que a tela chama tem que existir na GOOD — no módulo ou numa lib que ela registra */
const modulo = fs.readFileSync(path.join(raiz, 'good-checkout-offline', 'index.js'), 'utf8');
/* seguir a cadeia de require, não só um nível: a /historico-longo chega na GOOD por
   index.js → ./historico-good (fachada LOCAL) → lib/checkout/historico.js. Meu varredor olhava
   só `../lib/` e acusou uma rota que eu tinha acabado de provar no ar respondendo 200 — o
   mesmo erro de medição que já me custou três correções hoje. */
function seguir(arq, vistos) {
  if (vistos.has(arq) || !fs.existsSync(arq)) return '';
  vistos.add(arq);
  const s = fs.readFileSync(arq, 'utf8');
  let junto = s;
  for (const m of s.matchAll(/require\('(\.[\w./-]+)'\)/g)) {
    const alvo = path.resolve(path.dirname(arq), m[1]) + '.js';
    junto += seguir(alvo, vistos);
  }
  return junto;
}
const deLibs = seguir(path.join(raiz, 'good-checkout-offline', 'index.js'), new Set());
const chamadas = [...new Set([...js[1].matchAll(/MOD\s*\+\s*'\/([\w-]+)/g)].map((m) => m[1]))];
assert.ok(chamadas.length > 0, 'não achei nenhuma chamada ao backend na tela');
for (const rota of chamadas) {
  const existe = modulo.includes("'/good-checkout-offline/" + rota + "'") ||
                 deLibs.includes("prefixo + '/" + rota + "'") ||
                 deLibs.includes("R('" + rota + "')");
  assert.ok(existe,
    'a tela chama /' + rota + ', que a GOOD não responde — o card ficaria vazio, e card vazio ' +
    'é pior que card ausente: o dono acredita no número que aparece e procura o que não aparece');
}

/* cada onclick tem função declarada — o teste que já existe pra AMB e Girassol, aplicado aqui */
for (const m of html.matchAll(/onclick="(\w+)\(/g)) {
  assert.ok(new RegExp('function\\s+' + m[1] + '\\s*\\(').test(js[1]),
    'onclick chama ' + m[1] + '(), que não existe no script da tela');
}

/* a lição de 16/09 da tabela do banco: quantidade SEMPRE, nome quando houver */
assert.ok(/Number\(i\.qtd\)\s*\|\|\s*1/.test(js[1]),
  'a tabela precisa mostrar a quantidade mesmo quando é 1 — foi o conserto de 16/09 na AMB');
assert.ok(/i\.descricao/.test(js[1]),
  'a tabela precisa mostrar o NOME do produto, não só o SKU');

console.log('OK: dashboard da GOOD — a tela existe, o JS compila, e ela só chama rotas que a GOOD responde');
