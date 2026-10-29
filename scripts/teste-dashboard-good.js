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

/* 29/10: a tela velha da GOOD saiu — a tela dela é a ÚNICA (gerada), a que a rota serve */
const TELA = 'good-checkout-offline/dashboard.html';

const html = require('./_tela-empresa').lerTela(TELA);

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
                 deLibs.includes("PREFIXO + '/" + rota + "'") ||   /* a fábrica do painel (montada na GOOD) escreve PREFIXO */
                 deLibs.includes("PREFIXO + '/" + rota + "/") ||   /* e as rotas com subcaminho (a Shopee: PREFIXO + '/shopee/resumo') */
                 deLibs.includes("R('" + rota + "')");
  assert.ok(existe,
    'a tela chama /' + rota + ', que a GOOD não responde — o card ficaria vazio, e card vazio ' +
    'é pior que card ausente: o dono acredita no número que aparece e procura o que não aparece');
}

/* cada onclick tem função declarada — o teste que já existe pra AMB e Girassol, aplicado aqui */
/* a tela única tem onclick com código direto (`if(...)`, `event.stopPropagation()`) — palavra-chave e objeto não são
   função da tela; o resto tem que existir no script dela (ou ser global da página: window.X = function) */
const _NAO_FUNCAO = new Set(['if', 'for', 'while', 'return', 'typeof', 'event', 'this', 'window', 'document', 'location', 'history']);
for (const m of html.matchAll(/onclick="(\w+)\(/g)) {
  if (_NAO_FUNCAO.has(m[1])) continue;
  assert.ok(new RegExp('function\\s+' + m[1] + '\\s*\\(').test(js[1]) || new RegExp('window\\.' + m[1] + '\\s*=').test(js[1]),
    'onclick chama ' + m[1] + '(), que não existe no script da tela');
}

/* a lição de 16/09 da tabela do banco: quantidade SEMPRE, nome quando houver */
assert.ok(/Number\(i\.qtd\)\s*\|\|\s*1/.test(js[1]),
  'a tabela precisa mostrar a quantidade mesmo quando é 1 — foi o conserto de 16/09 na AMB');
assert.ok(/i\.descricao/.test(js[1]),
  'a tabela precisa mostrar o NOME do produto, não só o SKU');

/* 18/09 — O CARD TEM QUE DIZER DE ONDE VEIO A ALÍQUOTA. O dono olhou "15% do faturamento"
   logo depois de eu carregar as alíquotas apuradas da GOOD e teve que perguntar se tinham
   pegado. Tinham: agosto não está na lista dele e caiu no padrão, que é o certo — mas a tela
   não dizia, e número sem origem obriga a perguntar toda vez.
   29/10: a tela velha da GOOD saiu — a origem agora é da TELA ÚNICA (origemAliquota, as três), com os mesmos casos. */
{
  const jsTela = js[1];
  const m = /function origemAliquota\(orig\)\{[\s\S]*?\n\}/.exec(jsTela);
  assert.ok(m, 'a tela não tem a origem da alíquota no card de impostos');
  const escT = (x) => String(x);
  const legenda = new Function('esc', m[0] + '; return origemAliquota;')(escT);
  const soPadrao = legenda({ '2026-08': { valor: null, fonte: 'padrao' } });
  assert.ok(/PADR\\u00c3O|PADRÃO/.test(soPadrao) && /2026-08/.test(soPadrao),
    'mês sem alíquota apurada tem que AVISAR, e dizer qual mês — senão o dono lê 15% e acha que a apurada não pegou');
  const apurada = legenda({ '2026-07': { valor: 15.03, fonte: 'apurada' } });
  assert.ok(/apurada/.test(apurada) && !/PADR/.test(apurada), 'mês apurado não pode ser marcado como padrão');
  const misto = legenda({ '2026-07': { fonte: 'apurada' }, '2026-08': { fonte: 'padrao' } });
  assert.ok(/2026-08/.test(misto) && !/2026-07/.test(misto),
    'no período misto, o aviso tem que citar SÓ os meses que precisam de ação — os apurados não pedem nada');
  assert.strictEqual(legenda(null), '', 'sem informação de origem, o card não pode afirmar nada sobre a alíquota');
  assert.ok(/usaHist \? origemAliquota\(HIST\.aliquotas_usadas\) : ''/.test(jsTela), 'o card de impostos não mostra a origem que o histórico manda');
}

/* e o backend precisa REPORTAR a origem — card que lê campo inexistente não avisa nada */
{
  const lib = fs.readFileSync(path.join(raiz, 'lib', 'checkout', 'historico.js'), 'utf8');
  assert.ok(/aliquotas_usadas: _aliqOrigem/.test(lib),
    'a lib do histórico não devolve a origem da alíquota — o card não teria o que mostrar');
  for (const fonte of ['painel', 'apurada', 'padrao']) {
    assert.ok(new RegExp("fonte: '" + fonte + "'").test(lib), 'a lib não marca a origem ' + fonte);
  }
}

/* período vazio: dizer ONDE tem dado, em vez de deixar parecer que não há vendas */
assert.ok(/function avisarOndeTemDado/.test(js[1]),
  'período sem pedidos precisa dizer em que meses HÁ histórico — foi assim que a GOOD pareceu não ter venda alguma');

/* 18/09 — O ⚙️ MOSTRAVA DOZE CAMPOS VAZIOS. Vazio ali significa "usa a tabela do código", e a
   tabela o dono não vê — ele não tinha como saber qual alíquota estava valendo em cada mês.
   29/10: na TELA ÚNICA (a da GOOD agora) cada mês mostra o valor que vale: o de fábrica em cinza (data-fabrica), o salvo,
   e a marca de apurada; com a precisão informada (o campo aceita 4 casas — o dono passou 11,819396% e conferiu no DAS);
   e o mês que ainda não fechou não vira pendência. */
{
  const jsT = js[1];
  assert.ok(/\(salvo==null&&padrao!=null\?' data-fabrica="1"':''\)/.test(jsT), 'o ⚙️ não mostra o valor de fábrica quando não há salvo — o campo ficaria vazio');
  assert.ok(/step="0\.0001"/.test(jsT), 'a alíquota do ⚙️ perde a precisão informada');
  assert.ok(/_mesCorrente/.test(jsT), 'falta tratar o mês em andamento — ele apareceria como "falta apurar"');
  assert.ok(/CFG\.apuradas/.test(jsT), 'o ⚙️ não lê os meses marcados como apurados');
}

/* e as TRÊS rotas de config-fiscal devolvem as apuradas: contrato igual nas três, senão a
   próxima tela que precisar disso descobre que só uma empresa responde */
for (const [emp, arq] of Object.entries({
  amb: 'amb-checkout-offline/index.js',
  girassol: 'girassol-backup-offline/gbo-app.js',
  good: 'good-checkout-offline/index.js',
})) {
  const s = fs.readFileSync(path.join(raiz, arq), 'utf8');
  assert.ok(/ok: true, apuradas: DEFAULT_ALIQ_BK/.test(s),
    emp + ': /config-fiscal não devolve as alíquotas apuradas — o ⚙️ mostraria campos vazios sem dizer o que vale');
}

/* 18/09 — ZERO NÃO É ALÍQUOTA. O dono abriu o ⚙️ e viu set-dez com "0" no campo, como se
   alguém tivesse configurado alíquota zero. O backend já sabe disso desde 19/08 ("mês salvo
   como 0% era campo em BRANCO gravado por engano") e ignora o zero no cálculo — só a tela é
   que o exibia, e salvar de novo o REGRAVAVA.
   Tela dizendo uma coisa e imposto seguindo outra é a classe de erro mais cara deste painel.
   29/10: a regra veio da tela velha da GOOD pra TELA ÚNICA (as três). */
{
  const jsZ = js[1];
  /* não EXIBE zero: zero salvo conta como não salvo (volta pro cinza de fábrica) */
  assert.ok(/const salvo = \(CFG\.aliquotas\[m\]!=null && Number\(CFG\.aliquotas\[m\]\)>0\) \? CFG\.aliquotas\[m\] : null/.test(jsZ),
    'o campo mostra "0" como valor configurado — o cálculo ignora esse zero, então a tela mente');
  /* não SALVA zero: manda null, que o servidor apaga */
  assert.ok(/if\(aliquotas\[i\.dataset\.aliq\] === 0\) aliquotas\[i\.dataset\.aliq\] = null;/.test(jsZ),
    'zero é enviado como alíquota válida — fica gravado na config sem valer nada no cálculo');
}

console.log('OK: dashboard da GOOD — a tela existe, o JS compila, e ela só chama rotas que a GOOD responde');
