/* 23/09 — O BUG QUE O DONO ACHOU, e que eu diagnostiquei errado duas vezes antes de olhar o
   dado: ele procurava "lixas" na contagem, via "30 resultado(s)" e faltavam as variações que
   ele queria contar.

   MINHA PRIMEIRA HIPÓTESE (errada): o nome da variação seria só "GRÃO:g100", sem "lixa". Eu
   li isso na coluna Descrição de uma planilha dele e não confirmei na fonte. O JSON de
   /debug-produto-cru mostrou que o Bling manda o nome COMPLETO ("10 X Lixas Disco Grão Liso
   125mm … GRÃO:g100") tanto na listagem quanto no detalhe; "GRÃO:g100" é o `variacao.nome`,
   que é outro campo.

   A CAUSA REAL estava no meu próprio código: o corte em 30 acontecia ANTES da ordenação, então
   sobravam os 30 primeiros na ordem interna do índice — que é a ordem de inserção, arbitrária.
   Com 200 lixas ele via 30 SORTEADAS, não as 30 primeiras. O "30 resultado(s)" exato no print
   era o sinal, e eu demorei a ver.

   LIÇÃO: o número redondo bem no teto era a pista. Antes de teorizar sobre o dado do Bling, era
   pra eu ter olhado o que o MEU código faz com um resultado grande. */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const raiz = path.join(__dirname, '..');

const { criar } = require(path.join(raiz, 'lib', 'checkout', 'rotas-catalogo'));

/* índice com 50 lixas EMBARALHADAS na ordem de inserção — é assim que ele fica de verdade,
   porque a varredura grava na ordem em que o Bling devolve */
const idx = {};
const nomes = [];
for (let i = 1; i <= 50; i++) nomes.push('Lixa Disco GRÃO:' + String(i * 10).padStart(4, '0'));
nomes.sort(() => Math.random() - 0.5);
nomes.forEach((n, i) => { idx['sku:L' + i] = { sku: 'L' + i, nome: n, id: i }; });

const handler = criar({
  prefixo: '/x', json: (r, st, o) => { r._o = o; }, blingGet: async () => ({ ok: false }),
  ehAdmin: () => true, skuEanCache: () => ({}), lerIndiceEan: () => idx,
  salvarNoIndiceEan: () => {}, getPossiveisGtins: () => [], produtoDetalhe: async () => null,
  primeiraImagem: () => '', locCache: () => ({}), localizacaoDeProduto: () => '',
  indexarCatalogoCompleto: async () => {}, getIdxStatus: () => ({ fim: 'x' }),
});
const pagina = async (aposNome, aposSku, lim) => {
  const r = {};
  const qs = 'q=lixa&apos_nome=' + encodeURIComponent(aposNome || '') +
    '&apos_sku=' + encodeURIComponent(aposSku || '') + (lim ? '&limite=' + lim : '');
  await handler({ headers: {} }, r, new URL('http://x/x/buscar-produto-nome?' + qs), 'GET');
  return r._o;
};

(async () => {
  /* 23/09 — o dono pediu TUDO de uma vez como PADRÃO: sem `limite`, vem a lista inteira.
     O modo em partes continua existindo pra quando a lista ficar grande demais pro celular
     do galpão, com passos que crescem (50 → 100 → 200). */
  const tudo = await pagina();
  assert.strictEqual(tudo.itens.length, 50,
    'sem `limite` a busca tinha que devolver TUDO — é o padrão que o dono pediu');
  assert.strictEqual(tudo.tem_mais, false, 'diz que há mais quando mandou tudo');
  assert.deepStrictEqual(tudo.itens.map(i => i.nome), [...tudo.itens.map(i => i.nome)].sort((a, b) => a.localeCompare(b, 'pt-BR')),
    'a lista completa não veio ordenada');

  const p1 = await pagina(null, null, 30);

  assert.strictEqual(p1.total, 50,
    '`total` tem que ser quantos CASARAM (50), não quantos couberam na página — senão a tela ' +
    'diz "30 resultado(s)" e o dono acha que só existem 30');
  assert.strictEqual(p1.itens.length, 30, 'a página deveria trazer 30');
  assert.strictEqual(p1.tem_mais, true, 'não avisa que há mais — o resto fica invisível');

  /* O CORAÇÃO DO BUG: o primeiro item tem que ser o primeiro da ORDEM ALFABÉTICA de todos os
     50, não o primeiro que o índice devolveu. */
  assert.strictEqual(p1.itens[0].nome, 'Lixa Disco GRÃO:0010',
    'a lista foi cortada ANTES de ordenar — o que aparece são resultados SORTEADOS da ordem ' +
    'interna do índice, e o que o dono procura pode simplesmente não cair no sorteio');

  const p2 = await pagina(p1.proximo_apos_nome, p1.proximo_apos_sku, 30);
  const todos = [...p1.itens, ...p2.itens].map(i => i.nome);
  assert.strictEqual(new Set(todos).size, 50, 'a paginação repetiu ou perdeu item');
  assert.deepStrictEqual(todos, [...todos].sort((a, b) => a.localeCompare(b, 'pt-BR')),
    'as páginas não formam uma ordem contínua — item da página 2 deveria vir depois de todos da 1');
  assert.strictEqual(p2.tem_mais, false, 'diz que há mais quando acabou');

  /* Codex #521 (P2): com offset NUMÉRICO, um item inserido no índice ANTES da posição 30
     empurrava tudo uma casa pra frente — a página 2 (slice 30..60) repetia o último item que a
     página 1 já tinha mostrado. O cursor por (nome, sku) reposiciona pelo CONTEÚDO do último
     item mostrado (não pela posição), então essa mesma inserção não pode fazer a página
     seguinte repetir item. */
  const ultimoDaP1 = p1.itens[p1.itens.length - 1].nome;   // 'Lixa Disco GRÃO:0300'
  idx['sku:NOVA'] = { sku: 'NOVA', nome: 'Lixa Disco GRÃO:0015', id: 999 };   // entra ANTES da posição 30
  const p2depoisDeInserir = await pagina(p1.proximo_apos_nome, p1.proximo_apos_sku, 30);
  const nomesP2 = p2depoisDeInserir.itens.map(i => i.nome);
  /* Codex #521 (P2, retomado): `total` já foi `itens.length` (51, contando o item inserido) e
     depois virou `inicio + itens.slice(inicio).length` — que é sempre igual a `itens.length` de
     novo (`inicio + (itens.length - inicio)`), um "conserto" que não mudava nada e ainda dizia
     51. Um item inserido ANTES do cursor nunca é alcançado por nenhuma página seguinte — contá-lo
     fazia a tela prometer "1 a mais" que a paginação jamais entregava, e a página final vinha
     vazia. `total` tem que ser só o que é alcançável A PARTIR deste cursor: igual ao de `p2`
     (20), porque a inserção ficou pra trás dele e não muda nada do que vem depois. */
  assert.strictEqual(p2depoisDeInserir.total, p2.total,
    'o item inserido ANTES do cursor entrou no total — a paginação promete um item que nunca alcança');
  assert.ok(!nomesP2.includes(ultimoDaP1),
    'a página 2 repetiu o último item da página 1 — é o bug do offset numérico voltando');
  assert.deepStrictEqual(nomesP2, p2.itens.map(i => i.nome),
    'inserção ANTES do cursor não deveria mudar nada do que vem DEPOIS dele');
  delete idx['sku:NOVA'];

  console.log('OK: cursor por (nome, sku) sobrevive a inserção no índice entre páginas');

  /* Codex #521 (P1): o `break` em 2000 (era 30) cortava ANTES de ordenar de novo, num teto
     mais alto — o mesmo bug, só que escondido atrás de um número redondo maior. Índice com
     2200 casando prova que não sobrou teto nenhum: TODOS entram no total, mesmo sem `limite`. */
  const idxGrande = {};
  for (let i = 1; i <= 2200; i++) {
    const nome = 'Parafuso ' + String(i).padStart(4, '0');
    idxGrande['sku:P' + i] = { sku: 'P' + i, nome, id: i };
  }
  const handlerGrande = criar({
    prefixo: '/x', json: (r, st, o) => { r._o = o; }, blingGet: async () => ({ ok: false }),
    ehAdmin: () => true, skuEanCache: () => ({}), lerIndiceEan: () => idxGrande,
    salvarNoIndiceEan: () => {}, getPossiveisGtins: () => [], produtoDetalhe: async () => null,
    primeiraImagem: () => '', locCache: () => ({}), localizacaoDeProduto: () => '',
    indexarCatalogoCompleto: async () => {}, getIdxStatus: () => ({ fim: 'x' }),
  });
  const rGrande = {};
  await handlerGrande({ headers: {} }, rGrande, new URL('http://x/x/buscar-produto-nome?q=parafuso'), 'GET');
  assert.strictEqual(rGrande._o.total, 2200,
    'o corte em 2000 ANTES de ordenar voltou — resultado além do teto some sem avisar');
  assert.strictEqual(rGrande._o.itens.length, 2200, 'modo "tudo" (sem limite) tem que trazer todos os 2200');

  console.log('OK: sem teto escondido cortando antes de ordenar, nem em catálogo grande');

  /* a TELA: 'tudo' é o padrão, e o modo em partes cresce 50 → 100 → 200 */
  const html = fs.readFileSync(path.join(raiz, 'girassol-backup-offline', 'contagem.html'), 'utf8');
  const cat = fs.readFileSync(path.join(raiz, 'lib', 'checkout', 'rotas-catalogo.js'), 'utf8');
  const js = /<script>([\s\S]*?)<\/script>/.exec(html)[1];

  assert.ok(/let MODO_LISTA = 'tudo';/.test(js),
    "a tela não abre mostrando tudo — o dono pediu 'tudo' como padrão");
  assert.ok(/const PASSOS = \[50, 100, 200\];/.test(js), 'os passos do modo em partes mudaram');
  assert.ok(/MODO_LISTA === 'partes'\) \? PASSOS\[Math\.min\(_nPassos/.test(js),
    'o modo em partes não manda limite — viria tudo de qualquer jeito');
  assert.ok(/_nPassos\+\+/.test(js), 'o passo não cresce — ficaria 50 em 50 pra sempre');
  assert.ok(/_nPassos = 0;/.test(js), 'trocar de modo não recomeça a lista');
  assert.ok(/data-modo="tudo"/.test(js) && /data-modo="partes"/.test(js),
    'o seletor dos dois modos sumiu da tela');
  /* o seletor só aparece quando há o que escolher */
  assert.ok(/total > PASSOS\[0\]/.test(js),
    'o seletor aparece mesmo com lista curta — botão que não muda nada é ruído');

  /* Codex #521 (P2): "ver mais" que falha não pode apagar a lista já carregada */
  assert.ok(/function renderListaBusca\(/.test(js),
    'a renderização da lista não foi extraída — não dá pra reusar no caminho de erro sem duplicar tudo');
  assert.ok(/if\(acumulado && acumulado\.length\)\{\s*\n\s*renderListaBusca\(acumulado, totalConhecido/.test(js),
    'falha ao carregar mais página ainda apaga a lista já acumulada em vez de manter e oferecer retry');
  assert.ok(/if\(!falhouCarregarMais\) _nPassos\+\+;/.test(js),
    'um retry depois de falha avança o passo — deveria pedir de novo o MESMO tamanho que falhou');

  console.log('OK: tudo por padrao, em partes 50/100/200, e "ver mais" que falha preserva a lista');

  /* 23/09 — o clique ABRE O CARD na própria lista. Antes ele apagava `#resultado` e trocava
     de tela: "some com todos os outros e me mostra só o produto que cliquei". Num inventário
     ele desce a lista contando um atrás do outro, e perder o lugar a cada item custa tempo e
     faz recontar pra achar onde parou. */
  assert.ok(/function abrirNaLista\(sku\)/.test(js),
    'o clique não abre o formulário na lista — ainda troca de tela a cada produto');
  assert.ok(/b\.addEventListener\('click', \(\) => abrirNaLista\(b\.dataset\.sku\)\)/.test(js),
    'o resultado da busca ainda chama o caminho que apaga a lista');
  assert.ok(/data-abre=/.test(js), 'não há espaço no card pra o formulário abrir');

  /* só um aberto por vez: dois formulários na tela convidam a digitar no errado */
  assert.ok(/querySelectorAll\('\.abre\[data-aberto="1"\]'\)/.test(js),
    'abre vários formulários ao mesmo tempo');

  /* fechar não pode perder o que foi digitado sem avisar */
  assert.ok(/confirm\('Fechar sem salvar a quantidade digitada\?'\)/.test(js),
    'fechar o card descarta a quantidade digitada em silêncio');

  /* e salvar não pode dizer "ok" sem ter salvo */
  assert.ok(/'não consegui salvar — a contagem NÃO foi registrada'/.test(js),
    'a falha ao salvar não é mostrada — a pessoa segue pro próximo e a contagem se perde');
  assert.ok(/CSS\.escape\(sku\)/.test(js),
    'o SKU entra num seletor CSS sem escapar — SKU com caractere especial quebra a abertura');

  /* ★ O FLUXO QUE O DONO DESCREVEU, e que é o motivo de tudo isto existir:
     "posso procurar lixa e ir colocando de várias outras. Assim só clico, abro o card, informo
     a quantidade e salvo. E já posso ir pra outras mais embaixo e fazer o mesmo. Senão vou ter
     que buscar de novo, rolar a página etc."
     Ou seja: SALVAR NÃO PODE MEXER NA LISTA DE RESULTADOS. O fluxo antigo limpava o campo de
     busca e agendava um reset da tela 1,2s depois de lançar (fazia sentido quando cada
     lançamento trocava de tela) — e esse caminho continua existindo pro bipe. O caminho novo
     não pode encostar nele. */
  const corpoSalvar = /async function salvarNaLista[\s\S]*?\n\}/.exec(js);
  assert.ok(corpoSalvar, 'sumiu o salvamento inline');
  for (const [trecho, porque] of [
    ['limpar()', 'chama limpar() — a lista de resultados seria apagada depois de cada lançamento'],
    ["getElementById('busca')", 'mexe no campo de busca — o texto procurado sumiria a cada item'],
    ['LIMPAR_TIMER', 'agenda o reset da tela — a lista sumiria 1,2s depois de salvar'],
    ["resultado').innerHTML", 'apaga a lista de resultados ao salvar'],
  ]) {
    assert.ok(!corpoSalvar[0].includes(trecho),
      'salvar pela lista ' + porque + ', e aí ele teria que buscar de novo e rolar a página a cada produto');
  }
  assert.ok(/carregarHoje\(\)/.test(corpoSalvar[0]),
    'salvar não atualiza a lista de contagens do dia');

  /* 23/09 — a barra de busca fica FIXA no alto. Pedido do dono, e o motivo é o fluxo: com
     "tudo" por padrão a lista pode ter centenas de itens e ele desce lançando um a um; rolar
     de volta pro topo pra trocar a busca quebra a sequência. */
  const cssT = /<style>([\s\S]*?)<\/style>/.exec(html)[1];
  const regraBusca = /\.busca-hero\{([^}]*)\}/.exec(cssT);
  assert.ok(regraBusca, 'sumiu a regra da barra de busca');
  assert.ok(/position:sticky/.test(regraBusca[1]),
    'a barra de busca não fica fixa — numa lista longa ele teria que rolar até o topo a cada troca');
  assert.ok(/z-index:\s*\d+/.test(regraBusca[1]),
    'a barra fixa sem z-index fica ATRÁS dos cartões que passam por baixo');
  assert.ok(/background:var\(--carta\)/.test(regraBusca[1]),
    'a barra fixa precisa de fundo opaco — os cartões passam por baixo dela');
  assert.ok(/scroll-padding-top/.test(cssT),
    'sem scroll-padding o item clicado pode ficar escondido atrás da barra fixa');

  /* 23/09 (Codex #521, 6 apontamentos no card inline) — dois P1: */

  /* P1: `Number('')` é 0. Clicar Salvar com o campo VAZIO gravava contagem ZERO — e zero é um
     número legítimo (produto que acabou), então nem o servidor nem quem revisa depois consegue
     distinguir "contei zero" de "cliquei sem digitar". */
  assert.ok(/const bruto = String\(campo\.value \|\| ''\)\.trim\(\);/.test(js) && /if\(bruto === ''\)/.test(js),
    'campo vazio vira contagem ZERO — indistinguível de uma contagem real de zero');
  const validar = (v) => {
    const bruto = String(v || '').trim();
    if (bruto === '') return 'vazio';
    const n = Number(bruto);
    return (isFinite(n) && n >= 0 && Math.floor(n) === n) ? n : 'invalido';
  };
  assert.strictEqual(validar(''), 'vazio', 'vazio passou');
  assert.strictEqual(validar('   '), 'vazio', 'só espaços passou');
  assert.strictEqual(validar('0'), 0, 'ZERO DIGITADO tem que passar — produto que acabou conta zero');
  assert.strictEqual(validar('-3'), 'invalido', 'negativo passou');

  /* P1: o card inline NÃO pode mexer no `ESCOLHIDO` global, que é do fluxo do bipe. Os dois
     podem estar abertos: bipa um código (painel abre), depois procura por nome e abre um card.
     Trocar o global fazia o Salvar DAQUELE painel lançar o produto DESTE card. */
  const corpoAbrir = /async function abrirNaLista[\s\S]*?\n\}/.exec(js);
  assert.ok(corpoAbrir, 'sumiu a abertura inline');
  assert.ok(!/ESCOLHIDO = p;/.test(corpoAbrir[0]),
    'o card inline sobrescreve o ESCOLHIDO global — o painel do bipe lançaria o produto errado');
  assert.ok(/painelVelho\.style\.display = 'none'/.test(corpoAbrir[0]),
    'o painel do fluxo antigo fica aberto junto com o card — dois formulários apontando pra produtos diferentes');

  /* P2: abrir outro card descartava o que já estava digitado no anterior, sem perguntar */
  assert.ok(/Você digitou uma quantidade no produto aberto e ainda não salvou/.test(js),
    'abrir outro produto joga fora a quantidade digitada no anterior em silêncio');
  assert.ok(/Espere o lançamento em andamento terminar/.test(js),
    'abrir outro card durante um salvamento em voo descarta o formulário no meio do envio');

  /* P2: abrir um card cancelava a paginação em voo (contador compartilhado com a busca) */
  assert.ok(/const meu = \+\+_seqAbrir;/.test(js),
    'abrir um card usa o contador da BUSCA — clicar num produto enquanto o "ver mais" carrega ' +
    'descarta aquela resposta e o botão fica em "carregando…" pra sempre');

  /* P2: o saldo do card vinha de cache sem TTL, rotulado "agora" */
  assert.ok(/contagem-saldo\?sku=/.test(corpoAbrir[0]),
    'o card mostra saldo de cache sem revalidar, mas o chama de "agora" — e a divergência ' +
    'gravada nasce desse número');

  console.log('OK: ordena antes de cortar; tudo por padrao; card inline sem tocar no estado antigo; vazio nao vira zero');

  /* 23/09 (Codex #521, retomado) — a correção anterior de `total` no servidor
     (`inicio + itens.slice(inicio).length`) era um NO-OP: sempre igual a `itens.length`, o
     mesmo valor de antes. `total` no cliente também nunca somava o que já tinha vindo em
     páginas anteriores — cada resposta pisava na anterior. */
  assert.ok(/total: itens\.length - inicio,/.test(cat),
    'o servidor ainda manda `total` = itens.length inteiro (com quem ficou pra trás do cursor) ' +
    'em vez de só o alcançável a partir daqui — o "conserto" anterior era um no-op');
  assert.ok(/const totalAcumulado = \(acumulado \? acumulado\.length : 0\) \+ d\.total;/.test(js),
    'o total mostrado na tela não soma o que já veio em páginas anteriores — cada "ver mais" ' +
    'reseta a contagem pro tamanho só desta página');

  /* e a página final de uma paginação (0 itens, porque não sobra nada depois do cursor) não
     pode cair no aviso de "nada encontrado" e apagar a lista já acumulada */
  assert.ok(/if\(acumulado && acumulado\.length && !d\.itens\.length\)\{/.test(js),
    'uma página vazia com lista já acumulada ainda cai no aviso de "nada encontrado" e apaga ' +
    'os resultados já mostrados — fim de paginação não é o mesmo que não achar nada');

  /* e o painel do fluxo ANTIGO (bipe) não pode ser fechado em silêncio se tinha uma quantidade
     digitada ou um salvamento em voo — mesma trava que já existe pro card inline */
  const corpoAbrir2 = /async function abrirNaLista[\s\S]*?\n\}/.exec(js);
  assert.ok(/if\(_salvando\)\{[\s\S]{0,80}alert\(/.test(corpoAbrir2[0]),
    'abrir um card fecha o painel antigo mesmo com um "Salvar contagem" dele em voo');
  assert.ok(/qtdVelho[\s\S]{0,40}!== ''[\s\S]{0,40}confirm\(/.test(corpoAbrir2[0]),
    'abrir um card fecha o painel antigo e descarta uma quantidade já digitada nele, sem perguntar');

  console.log('OK: total da paginacao soma paginas anteriores e nao e mais um no-op; painel antigo nao perde dado em silencio');
})().catch(e => { console.error(e); process.exit(1); });
