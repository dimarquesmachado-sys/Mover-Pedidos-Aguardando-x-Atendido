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

/* 18/09 — O CARD TEM QUE DIZER DE ONDE VEIO A ALÍQUOTA. O dono olhou "15% do faturamento"
   logo depois de eu carregar as alíquotas apuradas da GOOD e teve que perguntar se tinham
   pegado. Tinham: agosto não está na lista dele e caiu no padrão, que é o certo — mas a tela
   não dizia, e número sem origem obriga a perguntar toda vez. */
{
  const jsTela = /<script>([\s\S]*?)<\/script>/.exec(html)[1];
  const legenda = new Function(
    /const PCT = [^\n]*/.exec(jsTela)[0] + ';' +
    /function legendaImposto[\s\S]*?\n\}/.exec(jsTela)[0] + '; return legendaImposto;')();

  const soPadrao = legenda({ __aliquotas: { '2026-08': { valor: null, fonte: 'padrao' } } }, 100, 15);
  assert.ok(/PADRÃO/.test(soPadrao) && /2026-08/.test(soPadrao),
    'mês sem alíquota apurada tem que AVISAR, e dizer qual mês — senão o dono lê 15% e acha que a apurada não pegou');

  const apurada = legenda({ __aliquotas: { '2026-07': { valor: 15.03, fonte: 'apurada' } } }, 100, 15);
  assert.ok(/apurada/.test(apurada) && !/PADRÃO/.test(apurada), 'mês apurado não pode ser marcado como padrão');

  const misto = legenda({ __aliquotas: { '2026-07': { fonte: 'apurada' }, '2026-08': { fonte: 'padrao' } } }, 100, 15);
  assert.ok(/2026-08/.test(misto) && !/2026-07/.test(misto),
    'no período misto, o aviso tem que citar SÓ os meses que precisam de ação — os apurados não pedem nada');

  /* rota antiga, sem o campo: a tela não pode quebrar nem inventar origem */
  assert.ok(!/PADRÃO|apurada|⚙️/.test(legenda({}, 100, 15)),
    'sem informação de origem, o card não pode afirmar nada sobre a alíquota');
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
   Campo em branco que esconde um valor ativo é a mesma armadilha do card sem origem. */
{
  const jsT = /<script>([\s\S]*?)<\/script>/.exec(html)[1];

  assert.ok(/d\.apuradas/.test(jsT), 'o ⚙️ não lê as alíquotas apuradas — as linhas ficariam sem valor');
  assert.ok(/apurada/.test(jsT) && /salva aqui/.test(jsT),
    'cada linha precisa dizer de ONDE vem a alíquota daquele mês');

  /* alíquota vai com a precisão informada: o dono passou 11,819396% e arredondar esconde
     justamente o dígito que ele conferiu no DAS */
  assert.ok(/String\(v\)\.replace\('\.', ','\)/.test(jsT),
    'a alíquota do ⚙️ não pode passar pelo PCT de uma casa — perde a precisão informada');

  /* mês corrente e futuro NÃO levam alarme: o dono não tem como apurar o que não fechou, e
     alarme que não se pode atender ensina a ignorar o alarme */
  assert.ok(/k === hoje/.test(jsT), 'falta tratar o mês em andamento — ele apareceria como "falta apurar"');
  assert.ok(/mês ainda não fechou/.test(jsT), 'falta tratar os meses futuros');
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
   Tela dizendo uma coisa e imposto seguindo outra é a classe de erro mais cara deste painel. */
{
  const jsZ = /<script>([\s\S]*?)<\/script>/.exec(html)[1];

  /* não EXIBE zero */
  assert.ok(/salvo!=null&&Number\(salvo\)>0\?salvo:''/.test(jsZ),
    'o campo mostra "0" como valor configurado — o cálculo ignora esse zero, então a tela mente');

  /* não SALVA zero: manda null, que o servidor apaga */
  assert.ok(/if\(n === 0\)\{ aliquotas\[k\] = null; continue; \}/.test(jsZ),
    'zero é enviado como alíquota válida — fica gravado na config sem valer nada no cálculo');
}

console.log('OK: dashboard da GOOD — a tela existe, o JS compila, e ela só chama rotas que a GOOD responde');
