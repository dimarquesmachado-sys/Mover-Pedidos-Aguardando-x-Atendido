'use strict';
/* 22/09 — CONTAGEM DE ESTOQUE (registro interno), pedida pelo dono: o funcionário acha o
   produto por SKU, EAN ou parte do nome, vê o nome completo e a foto, e lança o que contou.

   Três decisões dele que este teste guarda, porque são o que separa esta tela de um ajuste de
   estoque:

   1) NÃO GRAVA NO BLING. Ele revisa depois e decide o que enviar. Se um dia alguém ligar um
      blingWrite aqui, a tela passa a mexer no saldo real de um galpão inteiro sem que ninguém
      tenha pedido isso.
   2) É CONTAGEM (saldo contado), não entrada/saída — e o saldo do Bling é guardado COMO ESTAVA
      NA HORA, senão a revisão compara a contagem de ontem com o saldo de hoje.
   3) Busca por nome é LOCAL. O funcionário digitando nome dispararia uma consulta ao Bling por
      tecla, e a cota é da conta: a operação perde primeiro. */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const raiz = path.join(__dirname, '..');

const LIB = path.join(raiz, 'lib', 'checkout', 'rotas-contagem.js');
const TELA = path.join(raiz, 'girassol-backup-offline', 'contagem.html');

assert.ok(fs.existsSync(LIB), 'a lib da contagem sumiu');
assert.ok(fs.existsSync(TELA), 'a tela da contagem sumiu — a rota devolve 404');

const lib = fs.readFileSync(LIB, 'utf8');
const html = fs.readFileSync(TELA, 'utf8');
const gbo = fs.readFileSync(path.join(raiz, 'girassol-backup-offline', 'gbo-app.js'), 'utf8');

/* ── 1) NADA aqui pode escrever no Bling ── */
/* olha o CÓDIGO, não os comentários: a primeira versão deste teste acusou a própria frase que
   explica por que a lib não escreve no Bling. Falso positivo ensina a ignorar o vermelho — foi
   o que já aconteceu aqui antes com o campo-tem-produtor. */
const libCodigo = lib.replace(/\/\*[\s\S]*?\*\//g, '').split('\n')
  .filter(l => !l.trim().startsWith('//')).join('\n');
/* 24/09 — A REGRA MUDOU, E A PROTEÇÃO PRECISOU MUDAR JUNTO, NÃO SUMIR.
   Até ontem esta tela NÃO podia escrever no Bling em nenhuma hipótese, e este teste proibia
   qualquer verbo de escrita na lib inteira. Hoje o dono pediu justamente isso: é o mesmo app
   que ele descreveu em 22/09 (funcionário informa a quantidade, ele aprova, um botão lança no
   estoque).
   Então a proibição virou CERCA: a escrita existe, mas SÓ no caminho de aplicar, e só com as
   travas que impedem estoque errado — que é o que a regra antiga realmente protegia. */
{
  const iAplicar = libCodigo.indexOf("'/contagem-aplicar'");
  assert.ok(iAplicar > 0, 'sumiu a rota de aplicar no Bling');

  /* nenhuma escrita FORA do caminho de aplicar: lançar, ajustar, editar e excluir continuam
     sendo registro interno puro */
  /* A fiação (passar `blingWrite` pra lib de entrada, numa linha só) é permitida; o que não
     pode é CHAMAR escrita fora do caminho de aplicar. Por isso a checagem ignora a linha que
     monta a lib e olha as chamadas de verdade. */
  const antesDeAplicar = libCodigo.slice(0, iAplicar)
    .split('\n').filter(l => !l.includes("require('./estoque-entrada')")).join('\n');
  for (const proibido of ['blingWrite(', 'blingPost(', 'blingPut(', 'blingPatch(']) {
    assert.ok(!antesDeAplicar.includes(proibido),
      'a lib CHAMA escrita no Bling (' + proibido + ') fora do caminho de aplicar — lançar, ' +
      'ajustar, editar e excluir uma contagem nunca podem mexer no saldo real');
  }
  /* e a lib de entrada é a ÚNICA porta: nada de montar o POST na mão aqui */
  assert.ok(!/\/estoques'/.test(libCodigo.slice(0, iAplicar)),
    'o endpoint de estoque aparece fora da lib de entrada — a porta tem que ser uma só');

  /* e as travas do caminho que escreve. Cada uma existe porque a operação é de MÃO ÚNICA:
     aplicado só se desfaz com outro lançamento. */
  assert.ok(/if \(l\.aplicado_em\)/.test(libCodigo),
    'dá pra aplicar o mesmo lançamento duas vezes — o estoque somaria em dobro');
  assert.ok(/l\.tipo !== 'somar'/.test(libCodigo),
    'aceita aplicar uma CONTAGEM — ela diz quanto TEM, e somar esse número duplicaria o saldo');
  assert.ok(/l\.aplicando_em/.test(libCodigo),
    'dois cliques quase juntos viram duas entradas no Bling');
  assert.ok(/ctx\.ehAdmin\(String\(sess\.nome/.test(libCodigo),
    'qualquer um pode lançar no estoque — o desenho é o funcionário informar e o dono aprovar');
  assert.ok(/depósito desta empresa não configurado/.test(lib),
    'sem depósito configurado ele chutaria um id — o da GOOD é 4956031259, o da Girassol é outro');
}
{
  /* e o contexto passado a ela também não pode carregar uma porta de escrita */
  const m = /require\('\.\.\/lib\/checkout\/rotas-contagem'\)\.criar\(\{[\s\S]*?\}\);/.exec(gbo);
  assert.ok(m, 'a Girassol não registra a lib da contagem');
  const ctxCodigo = m[0].replace(/\/\*[\s\S]*?\*\//g, '');
  /* 24/09 — o `blingWrite` agora CHEGA de propósito: é ele que aplica a entrada. O que a regra
     antiga protegia continua valendo por outro caminho — as travas do /contagem-aplicar acima.
     O que este bloco passa a exigir é que, se a porta de escrita está aberta, venham JUNTO as
     duas coisas que impedem estoque errado: quem pode aplicar, e em qual depósito. */
  if (/blingWrite/.test(ctxCodigo)) {
    assert.ok(/ehAdmin/.test(ctxCodigo),
      'o contexto passa a porta de ESCRITA sem passar `ehAdmin` — qualquer um lançaria no ' +
      'estoque, e o desenho é o funcionário informar e o dono aprovar');
    assert.ok(/envDeposito/.test(ctxCodigo),
      'o contexto passa a porta de ESCRITA sem dizer o DEPÓSITO da empresa — o id é diferente ' +
      'em cada uma (GOOD: 4956031259), e chutar põe saldo no lugar errado');
  }
  assert.ok(!/blingPost|blingPut|blingPatch/.test(ctxCodigo),
    'o contexto recebe outra porta de escrita além da usada pela entrada de estoque');
}

/* ── 2) as quatro rotas exigem sessão ── */
/* 22/09 — a busca por nome MUDOU DE CASA: virou /buscar-produto-nome na lib de CATÁLOGO, que
   as três empresas já registram, pra o 🔎 do painel ganhar junto e sumir a cópia. Aqui ficam
   as rotas que são mesmo da contagem. */
for (const rota of ['/contagem', '/contagem-lancar', '/contagem-lista']) {
  const i = lib.indexOf("prefixo + '" + rota + "'");
  assert.ok(i > 0, 'rota ' + rota + ' sumiu da lib');
  const trecho = lib.slice(i, i + 400);
  assert.ok(/validarSessao\(req\.headers\['cookie'\]\)/.test(trecho),
    rota + ' não valida sessão — ficaria aberta pra qualquer um lançar contagem');
}

/* ── 3) a quantidade é o ponto do recurso: número errado aqui vira inventário errado ── */
{
  const m = /const bruto = [\s\S]*?json\(res, 200, \{ ok: false, erro: 'quantidade inválida[\s\S]*?\}\n/.exec(lib);
  assert.ok(m, 'não achei a validação da quantidade');
  const valida = (v) => {
    const bruto = String(v == null ? '' : v).trim().replace(',', '.');
    const n = Number(bruto);
    return !(bruto === '' || !isFinite(n) || n < 0 || Math.floor(n) !== n);
  };
  for (const mau of ['', 'abc', '-1', '2.5', null, undefined]) {
    assert.ok(!valida(mau), 'quantidade ' + JSON.stringify(mau) + ' devia ser recusada');
  }
  for (const bom of ['0', '7', '1200', 0, 7]) {
    assert.ok(valida(bom), 'quantidade ' + JSON.stringify(bom) + ' devia ser aceita');
  }
  assert.ok(/n > 1000000/.test(lib), 'falta o teto — um zero a mais no teclado vira contagem absurda salva');
}

/* ── 4) o saldo do Bling é guardado COMO ESTAVA NA HORA ── */
assert.ok(/saldo_bling_na_hora/.test(lib),
  'a contagem não guarda o saldo do Bling do momento — a divergência deixaria de ser auditável, ' +
  'porque a revisão compararia a contagem de ontem com o saldo de hoje');
/* 23/09 — a divergência só existe em CONTAGEM. No modo somar, "10" é "chegaram 10", não "a
   prateleira tem 10": comparar com o saldo daria um número sem significado, e número errado é
   pior que número ausente. */
assert.ok(/divergencia: \(String\(body\.tipo \|\| ''\) !== 'somar' && saldoBling != null/.test(lib),
  'a divergência não é calculada no lançamento, ou é calculada também no modo somar');
assert.ok(/tipo: \(String\(body\.tipo \|\| ''\) === 'somar'\) \? 'somar' : 'contagem'/.test(lib),
  'o lançamento não grava O QUE o número significa — na revisão, "10" não diz se o Bling ' +
  'recebe 10 ou +10, e aplicar o errado põe o estoque errado sem ninguém descobrir por quê');
assert.ok(/enviado_ao_bling: false/.test(lib),
  'falta a marca de "ainda não enviado" — é ela que deixa o dono saber o que já tratou');

/* ── 5) busca por nome: mora no CATÁLOGO e não pode ir ao Bling ── */
{
  const cat = fs.readFileSync(path.join(raiz, 'lib', 'checkout', 'rotas-catalogo.js'), 'utf8');
  const i = cat.indexOf("'/buscar-produto-nome'");
  assert.ok(i > 0, 'a busca por nome não está na lib de catálogo — o painel das três não a teria');
  const trecho = cat.slice(i, cat.indexOf("'/buscar-produto'", i)).replace(/\/\*[\s\S]*?\*\//g, '');
  assert.ok(!/blingGet/.test(trecho),
    'a busca por NOME consulta o Bling — o funcionário digitando dispararia uma chamada por tecla, ' +
    'e a cota é da conta: a operação perde primeiro');
  assert.ok(/lerIndiceEan\(\)/.test(trecho), 'a busca por nome não usa o índice local');
  assert.ok(/q\.length < 3/.test(trecho), 'falta o piso de 3 letras — com 1 ou 2 a lista vem inútil');
  assert.ok(/indice_vazio/.test(trecho) && /indice_completo/.test(trecho),
    'não distingue "índice vazio" de "catálogo nunca indexado" de "não achei" — mandam ações diferentes');

  /* e a contagem não pode ter ficado com uma CÓPIA da busca */
  assert.ok(!lib.includes("'/contagem-buscar-nome'"),
    'sobrou a cópia da busca por nome na lib da contagem — duas cópias divergem, e foi justamente ' +
    'o que o dono perguntou ao ver duas buscas parecidas');
}

/* ── 6) a tela ── */
{
  const js = /<script>([\s\S]*?)<\/script>/.exec(html);
  assert.ok(js, 'a tela não tem script');
  assert.doesNotThrow(() => new Function(js[1]), 'o JS da tela não compila');

  for (const m of html.matchAll(/onclick="(\w+)\(/g)) {
    assert.ok(new RegExp('function\\s+' + m[1] + '\\s*\\(').test(js[1]),
      'onclick chama ' + m[1] + '(), que não existe na tela');
  }

  /* o campo NÃO pode vir preenchido com o saldo do Bling: a pessoa confirmaria o número da
     tela em vez de contar, e a contagem perderia o sentido */
  assert.ok(/q\.value = '';/.test(js[1]),
    'o campo de quantidade é pré-preenchido — quem conta acabaria confirmando o saldo da tela');

  /* a tela precisa dizer que NÃO mexe no Bling: sem isso o funcionário acha que ajustou */
  assert.ok(/registro interno/i.test(html) && /não<\/b> é alterado|<b>não<\/b>/.test(html),
    'a tela não avisa que o saldo do Bling não é alterado — o funcionário acharia que ajustou o estoque');

  /* "não salvou" tem que aparecer como falha, não como sucesso */
  assert.ok(/Não salvou/.test(js[1]),
    'a tela não trata a falha ao salvar — a pessoa seguiria pro próximo item e a contagem se perderia');
}

/* 22/09 — MOSTRA ENQUANTO DIGITA, pedido do dono: "ele digitar lixa e já ir mostrando todos os
   produtos com esse nome". As duas travas abaixo não estão no pedido, mas sem elas a tela fica
   pior do que era: sem a espera, cada tecla vira uma busca; sem o contador de ordem, a resposta
   de "lix" chega depois e sobrescreve a lista de "lixa". */
{
  const js = /<script>([\s\S]*?)<\/script>/.exec(html)[1];
  assert.ok(/oninput="aoDigitar\(this\.value\)"/.test(html),
    'a busca não acontece enquanto digita — o dono pediu ver a lista aparecendo');
  assert.ok(/setTimeout\(\(\) => buscarPorNome\(q, false\), 300\)/.test(js),
    'falta a espera antes de buscar — "lixa" dispararia 4 buscas seguidas');
  assert.ok(/const meu = \+\+_seqBusca;/.test(js) && /if\(meu !== _seqBusca\) return;/.test(js),
    'sem controle de ordem, a resposta de "lix" pode chegar depois e sobrescrever a de "lixa"');
  assert.ok(/q\.length < 3/.test(js), 'falta o piso de 3 letras na tela');
}

/* 22/09 (Codex #509, 7 apontamentos) — os dois P1 são sobre PERDER DADO, que é o pior que esta
   tela pode fazer: ela existe pra registrar trabalho físico que ninguém vai refazer. */
{
  const lib2 = fs.readFileSync(LIB, 'utf8');

  /* P1: o saldo tem que ser o do INSTANTE do lançamento. Vinha do navegador, capturado quando o
     produto foi aberto — e entre abrir e salvar cabe a contagem física inteira, com venda ou
     ajuste no meio. A divergência nascia errada e fica assim pra sempre: é registro. */
  assert.ok(/let saldoBling = await saldoAoVivo\(sku\);/.test(lib2),
    'o lançamento ainda confia no saldo que o NAVEGADOR mandou — a divergência gravada nasce ' +
    'comparando o contado de agora com o saldo de minutos atrás');
  assert.ok(/saldo_conferido_na_hora/.test(lib2),
    'não registra se o saldo foi conferido na hora ou herdado da tela — a revisão precisa saber ' +
    'antes de confiar na divergência');

  /* P1: gravação atômica. writeJson trunca o arquivo; disco cheio no meio deixava o histórico
     vazio, e o ler() devolvia lista vazia em silêncio — a gravação seguinte apagava o resto. */
  assert.ok(/fs\.renameSync\(tmp, alvo\)/.test(lib2),
    'a gravação não é atômica — uma falha no meio deixa o histórico do dia truncado ou vazio');
  assert.ok(/throw new Error\('arquivo de contagens ilegível'\)/.test(lib2),
    'arquivo ilegível ainda vira lista vazia — a próxima gravação apagaria o que sobrou');

  /* P2: dia de São Paulo, não UTC */
  assert.ok(/toLocaleString\('sv-SE', \{ timeZone: 'America\/Sao_Paulo' \}\)/.test(lib2),
    'o filtro compara carimbo UTC com dia local — o turno das 21h-23h59 aparecia no dia seguinte inteiro');

  /* P2: "vazio" e "incompleto" mandam fazer coisas diferentes — conferido na lib de CATÁLOGO,
     que é onde a busca por nome passou a morar (22/09) */
  {
    const cat2 = fs.readFileSync(path.join(raiz, 'lib', 'checkout', 'rotas-catalogo.js'), 'utf8');
    assert.ok(/indice_completo/.test(cat2),
      'a busca não distingue índice VAZIO de catálogo NUNCA INDEXADO — com um produto só no índice, ' +
      'a tela diria "nada encontrado" pra tudo, como se os produtos não existissem');
  }
}

/* os três P2 da tela */
{
  const js2 = /<script>([\s\S]*?)<\/script>/.exec(html)[1];

  assert.ok(/if\(_salvando\) return;/.test(js2),
    'clique duplo ou Enter repetido manda dois POST iguais — a mesma contagem entra em dobro');
  assert.ok(/btnSalvar\.disabled = true/.test(js2), 'o botão não é travado durante o envio');

  assert.ok(/if\(meuPed !== _seqBusca\) return;/.test(js2) && /if\(meu !== _seqBusca\) return;/.test(js2),
    'bipar um segundo código com o primeiro em voo deixa valer a resposta que chegar por último — ' +
    'a contagem iria pro produto errado');

  assert.ok(/d\.tem_mais && d\.proximo_offset != null/.test(js2),
    'a lista ignora a paginação — num dia com mais de 500 lançamentos os primeiros somem em silêncio');
}

/* 22/09 — O 🔎 DO PAINEL GANHOU A BUSCA POR NOME, nas TRÊS. O dono perguntou por que a
   contagem não usava a busca do painel: usava, pra SKU e EAN — a mesma rota /buscar-produto.
   O que só a contagem tinha era procurar por PARTE DO NOME. Em vez de deixar duas buscas
   parecidas convivendo, a por nome mudou pra lib de catálogo, que as três registram. */
for (const [emp, arq] of Object.entries({
  amb: 'amb-checkout-offline/painel.html',
  girassol: 'girassol-backup-offline/painel.html',
  good: 'good-checkout-offline/painel.html',
})) {
  const pn = fs.readFileSync(path.join(raiz, arq), 'utf8');
  const jsP = (pn.match(/<script>([\s\S]*?)<\/script>/g) || []).join('\n');

  assert.ok(/oninput="buscarPorNomeAoDigitar\(this\.value\)"/.test(pn),
    emp + ': o 🔎 do painel não busca por nome enquanto digita');
  assert.ok(/buscar-produto-nome/.test(pn),
    emp + ': o painel não chama a rota de busca por nome');
  assert.ok(/setTimeout\(\(\) => rodarBuscaNome\(q\), 300\)/.test(jsP),
    emp + ': falta a espera — cada tecla viraria uma requisição');
  assert.ok(/if\(meu !== _seqNome\) return;/.test(jsP),
    emp + ': sem controle de ordem, a resposta de "lix" sobrescreve a de "lixa"');

  /* o fazerBusca original é async e continua sendo: a inserção não pode ter comido o `async`,
     que foi exatamente o que aconteceu na primeira tentativa */
  assert.ok(/async function fazerBusca\(\)/.test(jsP),
    emp + ': o fazerBusca perdeu o `async` — o `await` dentro dele quebra a tela inteira');
}

/* 22/09 — A TELA ESTAVA FEIA, e por um motivo concreto: eu tinha copiado o bloco de estilo do
   dashboard e as classes que usava (wrap, bloco, campo, tab…) NÃO EXISTIAM lá — só `aviso`.
   Saiu sem caixa, sem tabela e com fonte enorme. Copiar CSS de outra tela e torcer pra as
   classes baterem foi o erro; agora elas são definidas onde são usadas, e o teste confere. */
{
  const css = /<style>([\s\S]*?)<\/style>/.exec(html)[1];
  /* 24/09: só as classes LITERAIS — mas sem jogar fora o atributo INTEIRO quando ele é
     montado em runtime (`class="item'+(x ? ' marcado' : '')+'"`). A versão anterior exigia
     que o `class="..."` fechasse sozinho, sem `'`/`(`/`&&` no meio; um atributo composto por
     concatenação simplesmente não batia, e as classes dele (ex.: `item`, `aba`, `marcado`)
     saíam do conjunto — a MESMA regressão que este teste existe pra pegar (CSS removido) ficava
     invisível pra ele. Codex #527 (P2). Pega o prefixo literal antes do `'+` (a classe base,
     ex.: "item") e, separado disso, só os dois lados de um TERNÁRIO (`? '...' : '...'`) dentro
     da concatenação — nunca o texto da condição, que pode ser qualquer string comparada (tipo
     `ABA==='nao'`) e não é nome de classe. */
  const usadas = new Set();
  for (const m of html.matchAll(/class="([a-zA-Z0-9 _-]*)/g)) {
    m[1].split(/\s+/).filter(Boolean).forEach(c => usadas.add(c));
  }
  for (const m of html.matchAll(/class="[a-zA-Z0-9 _-]*'\+([\s\S]*?)\+'"/g)) {
    for (const t of m[1].matchAll(/\?\s*'([a-zA-Z0-9 _-]*)'\s*:\s*'([a-zA-Z0-9 _-]*)'/g)) {
      [t[1], t[2]].forEach(frag => frag.trim().split(/\s+/).filter(Boolean).forEach(c => usadas.add(c)));
    }
  }
  const semCss = [...usadas].filter(c => !new RegExp('\\.' + c.replace(/-/g, '\\-') + '[\\s,{:.]').test(css));
  assert.deepStrictEqual(semCss, [],
    'classe(s) usadas na tela sem CSS: ' + semCss.join(', ') + ' — foi assim que ela saiu sem ' +
    'caixa e com fonte gigante');
}

/* + e − na lista do dia, pedido do dono */
{
  const lib3 = fs.readFileSync(LIB, 'utf8');
  const js3 = /<script>([\s\S]*?)<\/script>/.exec(html)[1];

  assert.ok(/prefixo \+ '\/contagem-ajustar'/.test(lib3), 'não há rota pra ajustar a quantidade');
  assert.ok(/const id = Date\.now\(\)\.toString\(36\)/.test(lib3),
    'o lançamento não tem id — ajustar por posição no array atinge a linha errada quando outro ' +
    'funcionário lança ao mesmo tempo');

  /* o ajuste NÃO pode apagar o valor anterior: esta tela existe pra conferir depois */
  assert.ok(/l\.ajustes\.push\(\{ de: l\.contado, para: novo/.test(lib3),
    'o ajuste sobrescreve a quantidade sem guardar de onde veio — o registro vira caixa preta');
  assert.ok(/if \(novo < 0\)/.test(lib3), 'deixa a contagem ficar negativa');
  assert.ok(/l\.divergencia = novo - Number\(l\.saldo_bling_na_hora\)/.test(lib3),
    'a divergência não acompanha o ajuste — é justamente ela que o dono olha na revisão');

  /* botões por addEventListener, não por onclick montado com o id — é o XSS do #510 */
  assert.ok(/addEventListener\('click'/.test(js3) && /data-ajuste/.test(js3),
    'os botões + e − montam código a partir de dado gravado — mesmo buraco que o Codex achou no painel');

  /* Codex #523 (P2): +/−, editar a quantidade e trocar o tipo (⇄) mutam o MESMO registro —
     controlesLinha() é o que trava as três rotas juntas; se ela parar de cobrir alguma, a
     omitida some do array e volta a correr destravada durante as outras. */
  const controlesLinhaSrc = js3.slice(js3.indexOf('function controlesLinha'), js3.indexOf('function controlesLinha') + 400);
  assert.ok(/\.mais-menos button/.test(controlesLinhaSrc) && /data-editar/.test(controlesLinhaSrc) && /\.trocar-tipo/.test(controlesLinhaSrc),
    'controlesLinha não cobre mais-menos, editar e trocar-tipo juntos — as três rotas mutam a mesma linha sem travar as outras');

  const ajustarSrc = js3.slice(js3.indexOf('async function ajustar'), js3.indexOf('let _seqLista'));
  assert.ok(/controlesLinha\(item\)/.test(ajustarSrc) && /disabled = true/.test(ajustarSrc),
    'clique repetido no + manda vários ajustes e a tela fica diferente do que foi gravado');
}

/* 22/09 (Codex #511, 4 P2) — o primeiro é o que apareceria no PRIMEIRO DEPLOY por cima de um
   arquivo existente: os lançamentos gravados antes desta versão não têm `id`, e apareceriam sem
   os botões + e − — umas linhas ajustáveis e outras não, sem explicação na tela. */
{
  const lib4 = fs.readFileSync(LIB, 'utf8');
  const js4 = /<script>([\s\S]*?)<\/script>/.exec(html)[1];

  assert.ok(/const carimbarIds = \(d\) =>/.test(lib4),
    'lançamento antigo não ganha id — ficaria sem os botões pra sempre');
  assert.ok((lib4.match(/if \(carimbarIds\(d\)\) gravar\(d\);/g) || []).length >= 2,
    'o carimbo não roda nos dois caminhos (lista e ajuste)');

  /* a rota é chamável direto, sem passar pelos botões: sem esta trava, um inteiro qualquer
     levaria a contagem acima do teto que o LANÇAMENTO recusa — dois caminhos, duas regras */
  assert.ok(/if \(delta !== 1 && delta !== -1\)/.test(lib4),
    'o ajuste aceita qualquer inteiro — a rota não passa só pelos botões');

  /* duas recargas simultâneas misturavam o mesmo ACUMULADO */
  assert.ok(/if\(recomecar !== false\)\{ _seqLista\+\+;/.test(js4) && /if\(minhaLista !== _seqLista\) return;/.test(js4),
    'ajustar dois cartões juntos dispara duas recargas que se misturam no mesmo array');

  /* O NOME DO PRODUTO NÃO PODE SER CORTADO, de jeito nenhum. Com prefixo longo igual — "Lixa
     4 Pol. 100mm Diamantada … GRÃO:50" e "… GRÃO:3000" — truncar esconde justamente o que
     diferencia, e o `title` não existe pra quem usa o dedo.
     A regra é essa, não uma forma específica de CSS: a primeira versão deste assert EXIGIA
     `-webkit-line-clamp:2`, que era o próprio corte; quando ele foi removido de vez, o teste
     passou a reprovar o conserto. Teste que trava a implementação em vez do comportamento
     envelhece contra quem está melhorando o código. */
  const css4 = /<style>([\s\S]*?)<\/style>/.exec(html)[1];
  const regraNome = /\.item \.nome\{([^}]*)\}/.exec(css4);
  assert.ok(regraNome, 'não achei a regra do nome do produto');
  for (const corte of ['line-clamp', 'white-space:nowrap', 'text-overflow:ellipsis']) {
    assert.ok(!regraNome[1].includes(corte),
      'o nome do produto é cortado por `' + corte + '` — com prefixo longo igual, some justamente ' +
      'o que diferencia um produto do outro, e no celular não há mouse pra revelar o title');
  }
}

/* 22/09 — DIGITAR A QUANTIDADE NA LINHA E EXCLUIR, pedidos do dono depois de usar a tela:
   "pra eu não ter que digitar de novo o 404 caso queira adicionar mais 1". Os botões resolvem
   de 1 em 1; com diferença grande, digitar erra menos que clicar dez vezes. */
{
  const lib5 = fs.readFileSync(LIB, 'utf8');
  const js5 = /<script>([\s\S]*?)<\/script>/.exec(html)[1];

  assert.ok(/prefixo \+ '\/contagem-definir'/.test(lib5), 'não há rota pra digitar a quantidade');
  assert.ok(/prefixo \+ '\/contagem-excluir'/.test(lib5), 'não há rota pra excluir');

  /* a mesma validação do lançamento: o número é o ponto do recurso inteiro */
  const defin = lib5.slice(lib5.indexOf("'/contagem-definir'"), lib5.indexOf("'/contagem-excluir'"));
  assert.ok(/Math\.floor\(n\) !== n/.test(defin) && /n > 1000000/.test(defin),
    'digitar a quantidade não passa pela mesma validação do lançamento — dois caminhos, duas regras');
  assert.ok(/l\.ajustes\.push\(\{ de: l\.contado, para: n/.test(defin),
    'digitar sobrescreve sem guardar de onde veio — o registro vira caixa preta');

  /* excluir NÃO apaga do arquivo: some da lista e fica a trilha */
  assert.ok(/l\.excluido = true;/.test(lib5) && /l\.excluido_por/.test(lib5),
    'a exclusão apaga o registro — o dono perderia a chance de saber que alguém contou e desfez');
  assert.ok(/const vivos = d\.lancamentos\.filter\(l => l && !l\.excluido\)/.test(lib5),
    'o excluído continua aparecendo na lista');
  assert.ok(/x\.id === id && !x\.excluido/.test(lib5),
    'dá pra ajustar um lançamento já excluído');

  /* na tela: confirmação antes de excluir, e o número editável não usa prompt() */
  assert.ok(/confirm\('Excluir a contagem/.test(js5), 'exclui sem confirmar');
  /* olha o CÓDIGO, não os comentários: a frase que explica POR QUE não uso prompt() contém a
     palavra, e a primeira versão deste assert acusou o próprio comentário. Já caí nisso hoje
     com o blingWrite — falso positivo ensina a ignorar o vermelho. */
  const js5codigo = js5.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter(l => !l.trim().startsWith('//')).join('\n');
  assert.ok(/data-editar/.test(js5) && !/prompt\(/.test(js5codigo),
    'a edição usa prompt() — no celular ele tapa a tela e não mostra qual produto está sendo editado');
  assert.ok(/ev\.key === 'Escape'/.test(js5), 'não dá pra desistir da edição');
}

/* 22/09 (Codex #511, 2ª rodada) — dois furos que só apareceram DEPOIS de digitar a quantidade
   na linha e excluir entrarem: o botão + isolado ainda não tinha o mesmo teto dos outros dois
   caminhos pro campo, e editar a linha não travava os botões vizinhos dela. */
{
  const lib6 = fs.readFileSync(LIB, 'utf8');
  const js6 = /<script>([\s\S]*?)<\/script>/.exec(html)[1];

  /* um lançamento já no teto de 1.000.000 aceitava +1 e ia pra 1.000.001 — o ajuste não tinha
     o mesmo teto do lançamento e do /contagem-definir pro mesmo campo */
  const ajustar6 = lib6.slice(lib6.indexOf("'/contagem-ajustar'"), lib6.indexOf("'/contagem-definir'"));
  assert.ok(/if \(novo > 1000000\)/.test(ajustar6),
    'o ajuste (+) não tem teto — um lançamento no limite passa de 1.000.000 clicando +');

  /* editar a quantidade na linha e tocar no + ou − logo em seguida disparava o blur (que salva
     o valor digitado) e o click (que ajusta) sem ordem garantida entre os dois — o ajuste podia
     ser sobrescrito pelo valor absoluto do blur, perdendo o toque em silêncio */
  const editarQtd6 = js6.slice(js6.indexOf('function editarQtd'), js6.indexOf('function excluir'));
  assert.ok(/controlesLinha\(item\)/.test(editarQtd6) && /disabled = true/.test(editarQtd6),
    'editar a quantidade não trava os botões + / − / excluir / trocar-tipo da mesma linha — o blur do ' +
    'campo e o clique num deles correm sem ordem garantida');

  /* Codex #523 (P2): o mesmo furo do parágrafo acima existia entre editar e o botão ⇄ de trocar
     o tipo — trocarTipo() só travava a si mesmo, deixando +/−/editar livres durante o POST. */
  const trocarTipo6 = js6.slice(js6.indexOf('async function trocarTipo'), js6.indexOf('async function excluir'));
  assert.ok(/controlesLinha\(item\)/.test(trocarTipo6) && /disabled = true/.test(trocarTipo6),
    'trocar o tipo (⇄) não trava os botões + / − / editar da mesma linha — uma resposta pode ' +
    'sobrescrever a outra em silêncio');
}

/* 22/09 — KIT NÃO PODE SER CONTADO. O dono explicou a regra: `80-AE-8F-125mm-KIT40` é um kit,
   e lançar estoque nele no Bling DÁ ERRO — quem conta inventário são os COMPONENTES
   (`10-AE-8F-125mm-g24` e `-g40`), que são produtos normais. Variação é contável.
   Contar um kit geraria um número que NUNCA poderia ser lançado, e quem conferisse depois
   gastaria tempo entendendo por quê. */
{
  const lib6 = fs.readFileSync(LIB, 'utf8');
  const cat6 = fs.readFileSync(path.join(raiz, 'lib', 'checkout', 'rotas-catalogo.js'), 'utf8');
  const ciclo = fs.readFileSync(path.join(raiz, 'girassol-backup-offline', 'ciclo.js'), 'utf8');

  /* a marca nasce na indexação — `formato === 'E'` é composição no Bling, já documentado em
     amb-drive-imagens (que preserva a estrutura justamente porque o Bling recusa sem ela) */
  /* 23/09 — o `formato` da LISTAGEM não basta, e os três casos vieram do dono:
     · a lista pode dizer "S" pra algo que tem composição;
     · `V` é pai de grade, que também não tem estoque próprio;
     · quem decide é `estrutura.componentes`.
     A primeira versão deste assert travava a forma antiga (só `formato === 'E'`) e teria
     reprovado esta melhoria — trava o comportamento. */
  assert.ok(/\(Array\.isArray\(_comps\) && _comps\.length > 0\) \|\| _fmt === 'E' \|\| _fmt === 'V'/.test(ciclo),
    'a indexação decide kit só pelo `formato` — a listagem pode dizer "S" pra algo com composição');

  /* Codex #515: detalhe que FALHOU no modo profundo não pode ser publicado como "não é kit" —
     é exatamente o caso que o modo profundo foi feito pra resolver, e afirmar o contrário do
     que se foi verificar é pior que não saber. */
  assert.ok(/const _semVeredito = profundo && !det;/.test(ciclo),
    'detalhe que falhou vira "não é kit" — a varredura cara publicaria o oposto do que apurou');

  /* exercita a regra nos quatro casos */
  const decide = (comps, fmt) => (Array.isArray(comps) && comps.length > 0) || fmt === 'E' || fmt === 'V';
  assert.ok(decide([{ codigo: 'A' }], 'S'), 'kit que a lista diz "S" tem que ser pego pela composição');
  assert.ok(decide([], 'E'), 'kit declarado tem que ser pego');
  assert.ok(decide([], 'V'), 'pai de grade não tem estoque próprio — não é contável');
  assert.ok(!decide([], 'S'), 'produto simples não pode ser barrado');
  assert.ok(/kit: ehKit/.test(ciclo), 'a marca não vai pro índice');

  assert.ok(/if \(it\.kit === true\) continue;/.test(cat6),
    'a busca por nome mostra kit — o funcionário contaria algo que não dá pra lançar');

  /* e a trava que NÃO depende do índice: índice antigo não tem a marca, e o SKU do kit pode
     ser digitado direto */
  assert.ok(/async function ehKitNoBling\(sku\)/.test(lib6),
    'o lançamento não confere kit no Bling — a busca sozinha não basta, porque o índice antigo ' +
    'não tem a marca e o SKU pode ser digitado direto');
  assert.ok(/esse SKU é um KIT/.test(lib6), 'o lançamento aceita kit');

  /* falha de rede NÃO pode bloquear produto legítimo: recusar o certo é pior que deixar passar
     um kit que a busca já escondeu */
  assert.ok(/return \{ kit: false, sabido: false \};/.test(lib6),
    'falha na consulta bloquearia o lançamento de um produto legítimo');

  /* Codex #511 (P1, 2ª leva): sem abort, um Bling que aceita a conexão e nunca responde
     deixava /contagem-lancar pendurado pra sempre — mesmo bug que o #509 já tinha achado (e
     corrigido) em saldoAoVivo, só que aqui ainda faltava o remédio */
  const ehKit6 = lib6.slice(lib6.indexOf('async function ehKitNoBling'), lib6.indexOf('async function saldoAoVivo'));
  assert.ok(/new AbortController\(\)/.test(ehKit6) && /setTimeout\(\(\) => controle\.abort\(\), 15000\)/.test(ehKit6),
    'ehKitNoBling sem abort — um Bling que nunca responde trava o lançamento pra sempre');

  /* Codex #511 (P2, 2ª leva): `?codigo=` do Bling é case-sensitive — só tentar a grafia
     recebida deixava um SKU de kit em caixa diferente da cadastrada passar batido aqui,
     mesmo que saldoAoVivo achasse o mesmo produto pela variante certa logo depois */
  assert.ok(/const variantes = \[\.\.\.new Set\(\[sku, sku\.toUpperCase\(\), sku\.toLowerCase\(\)\]\)\];/.test(ehKit6),
    'ehKitNoBling só tenta a grafia recebida — um SKU de kit em outra caixa escapa da trava');

  /* Codex #511 (P2, 2ª leva): salvarNoIndiceEan regrava a entrada inteira sem o campo `kit` —
     abrir um kit por SKU/EAN exato apagava a marca que a indexação completa tinha posto, e
     ele voltava a aparecer na busca por nome até a próxima reindexação total */
  /* 23/09: este assert travava a FORMA (`kit: String(prod.formato) === 'E'`), e o conserto do
     #515 a substituiu — composição decide, formato reforça, e veredito anterior é preservado
     quando o objeto não permite afirmar. Trava o comportamento: a marca não pode ser perdida
     nem negada por engano. É a terceira vez hoje que um assert de forma reprova uma melhoria. */
  const prod6 = fs.readFileSync(path.join(raiz, 'lib', 'checkout', 'produtos.js'), 'utf8');
  const regraKit = /kit: \(\(\) => \{[\s\S]*?\}\)\(\),/.exec(prod6);
  assert.ok(regraKit, 'salvarNoIndiceEan não calcula mais a marca de kit — ela some ao reabrir o produto');
  assert.ok(/estrutura\.componentes/.test(regraKit[0]),
    'a marca é recalculada só pelo formato — composição é quem decide');
  assert.ok(/antes === true/.test(regraKit[0]),
    'não preserva o veredito da varredura profunda quando o objeto não permite afirmar');
}

/* 22/09 — A FOTO NA LINHA das contagens, pedido do dono. Num inventário de lixas com nomes
   quase iguais, a imagem distingue mais rápido que ler o nome inteiro.
   Guardada NO LANÇAMENTO, não buscada na hora de listar: buscá-la por linha custaria uma
   chamada ao Bling POR ITEM da lista, e a cota é da conta. A tela já tem a URL na mão quando
   o produto foi escolhido. */
{
  const lib7 = fs.readFileSync(LIB, 'utf8');
  const js7 = /<script>([\s\S]*?)<\/script>/.exec(html)[1];

  assert.ok(/img: produto\.img/.test(js7), 'a tela não manda a foto ao lançar');
  assert.ok(/class="thumb"/.test(js7), 'a linha das contagens não mostra a foto');

  /* só http(s): outro esquema não tem o que fazer num <img> a não ser surpresa */
  const guarda = /img: \(\(\) => \{[\s\S]*?\}\)\(\),/.exec(lib7);
  assert.ok(guarda, 'o lançamento não guarda a foto');
  assert.ok(/\^https\?:\\\/\\\//.test(guarda[0]),
    'a foto é guardada sem checar o esquema da URL');

  const filtra = (u) => /^https?:\/\//i.test(String(u||'').trim());
  assert.ok(filtra('https://bling.com/f.jpg'), 'url http(s) devia passar');
  assert.ok(!filtra('javascript:alert(1)'), 'javascript: devia ser recusado');
  assert.ok(!filtra(''), 'vazio devia ser recusado');
}

/* 23/09 — o LOGO da Girassol na tela, pedido do dono. É a MESMA imagem do painel, copiada de
   lá em vez de recriada: duas versões da marca em telas irmãs é o tipo de coisa que ninguém
   nota até ficar errada numa delas. */
{
  const pega = (arq) => [...fs.readFileSync(path.join(raiz, arq), 'utf8')
    .matchAll(/base64,([A-Za-z0-9+/=]{400,})/g)].map(m => m[1]);
  const naContagem = pega('girassol-backup-offline/contagem.html');
  const noPainel = pega('girassol-backup-offline/painel.html');
  assert.ok(naContagem.length > 0, 'a tela de contagem não tem o logo');
  assert.ok(naContagem.every(img => noPainel.includes(img)),
    'o logo da contagem não é o mesmo do painel — duas versões da marca divergem sem ninguém notar');
}

/* 23/09 (Codex #512) — dois erros meus no PR que existia justamente pra consertar o visual. */
{
  const cssT = /<style>([\s\S]*?)<\/style>/.exec(html)[1].replace(/\/\*[\s\S]*?\*\//g, '');
  const corpo = html.slice(html.indexOf('<body>'));

  /* `font:500 19px/1.2 inherit` é inválido: `inherit` é palavra-chave de valor único e não
     entra no atalho junto de peso e tamanho. O navegador descarta a declaração INTEIRA — e o
     campo herói voltava ao tamanho padrão do input, que é o "campo pequeno" reclamado. */
  const atalhos = [...cssT.matchAll(/font:([^;}]*)/g)].map(m => m[1].trim());
  const invalidos = atalhos.filter(v => v.includes('inherit') && v !== 'inherit');
  assert.deepStrictEqual(invalidos, [],
    'atalho `font` com `inherit` misturado a outros valores: ' + invalidos.join(' | ') +
    ' — o navegador descarta a regra toda e o campo perde tamanho e peso');

  /* o aviso de que o Bling NÃO muda tem que vir antes de qualquer ação: é o que impede o
     mal-entendido mais caro desta tela. Empurrado pra baixo dos resultados, uma busca por nome
     desenha até 30 produtos antes dele e ninguém lê. */
  assert.ok(corpo.indexOf('nota-interna') < corpo.indexOf('busca-hero'),
    'o aviso de que o saldo do Bling não muda ficou depois da busca — alguém contaria achando ' +
    'que ajustou o estoque');
  assert.ok(/\.nota-interna\{[^}]*girassol/.test(cssT),
    'o aviso perdeu o destaque e virou texto apagado');
}

/* 23/09 — O NCM ESTAVA ENTRANDO NO ÍNDICE DE CÓDIGO DE BARRAS. O dono viu na tela ("está
   trazendo a informação do NCM") e o rótulo errado era o MENOR dos problemas: NCM tem 8
   dígitos, que é exatamente o formato de um EAN-8. Ele virava chave do índice de EAN, então
   bipar um EAN-8 de verdade podia cair no produto errado.
   A causa: `getPossiveisGtins` varria TODOS os valores de `tributacao` aceitando qualquer
   string com 8+ caracteres — e ncm, cest e afins moram ali. */
{
  const prod = fs.readFileSync(path.join(raiz, 'lib', 'checkout', 'produtos.js'), 'utf8');
  const m = /for \(const \[k, v\] of Object\.entries\(obj\.tributacao\)\)[\s\S]*?\n    \}/.exec(prod);
  assert.ok(m, 'a varredura de `tributacao` voltou a aceitar qualquer campo — o NCM entra como código de barras');
  assert.ok(/gtin\|ean\|barras/i.test(m[0]),
    'a varredura não filtra pelo NOME do campo — ncm e cest entram como se fossem GTIN');

  /* exercita a regra: só chave de código de barras passa */
  const passa = (k) => /gtin|ean|barras/i.test(k);
  for (const k of ['ncm', 'cest', 'origem', 'codigoListaServicos']) {
    assert.ok(!passa(k), k + ' não pode entrar como código de barras');
  }
  for (const k of ['gtinTributario', 'codigoBarrasTributario', 'eanTributario']) {
    assert.ok(passa(k), k + ' devia entrar');
  }
}

/* a foto e o SKU na PRIMEIRA lista de resultados, pedidos do dono */
{
  const cat8 = fs.readFileSync(path.join(raiz, 'lib', 'checkout', 'rotas-catalogo.js'), 'utf8');
  const js8 = /<script>([\s\S]*?)<\/script>/.exec(html)[1];
  const ciclo8 = fs.readFileSync(path.join(raiz, 'girassol-backup-offline', 'ciclo.js'), 'utf8');

  assert.ok(/img: foto/.test(ciclo8) && /primeiraImagem\(det \|\| it\)/.test(ciclo8),
    'a indexação não guarda a foto — mostrá-la na busca custaria uma chamada ao Bling POR ' +
    'RESULTADO, a cada tecla digitada');
  assert.ok(/img: it\.img \|\| ''/.test(cat8), 'a busca não devolve a foto');
  assert.ok(/class="thumb"/.test(js8) && js8.indexOf('class="thumb"') < js8.indexOf('sku-tag'),
    'a lista de resultados não mostra a foto antes de clicar');
  assert.ok(/sku-tag">SKU</.test(js8),
    'o SKU aparece solto como um número qualquer — é o que se confere contra a etiqueta da prateleira');
}

/* 23/09 (Codex #514, P1) — consertar o coletor impede NCM NOVO, mas o índice SE REALIMENTA DE
   SI MESMO: os três indexadores completos partem de lerIndiceEan() e regravam o que leram, então
   os NCM já gravados sobreviveriam a toda varredura futura. E são eles o problema: 8 dígitos é
   o formato de um EAN-8, e um bipe legítimo pode cair no produto errado. */
{
  const base = fs.readFileSync(path.join(raiz, 'lib', 'checkout', 'base-funcoes.js'), 'utf8');
  const bloco = /const lerIndiceEan = \(\) => \{[\s\S]*?\n  \};/.exec(base);
  assert.ok(bloco, 'lerIndiceEan voltou a ser leitura crua — o NCM já gravado nunca sai');

  /* exercita a limpeza DE PRODUÇÃO, não uma cópia da regra */
  const tmp = fs.mkdtempSync(path.join(require('os').tmpdir(), 'idx-'));
  const arq = path.join(tmp, 'ean-indice.json');
  fs.writeFileSync(arq, JSON.stringify({
    '84672100':      { sku: '404', nome: 'Martelete', id: 1 },                    // NCM
    '79088401':      { sku: 'X8', nome: 'EAN-8 real', id: 3, ean: '79088401' },   // EAN-8 legítimo
    '7908840107701': { sku: 'L', nome: 'Lixa', id: 2 },                           // EAN-13
    'sku:SEMEAN':    { sku: 'SEMEAN', nome: 'Sem código', id: 4 },
  }));
  const ler = new Function('readJson', 'writeJson', 'EAN_INDEX_FILE', bloco[0] + '; return lerIndiceEan;')(
    (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return d; } },
    (f, o) => fs.writeFileSync(f, JSON.stringify(o)),
    arq);
  const chaves = Object.keys(ler());

  assert.ok(!chaves.includes('84672100'), 'o NCM já gravado continua no índice de código de barras');
  assert.ok(chaves.includes('79088401'),
    'a limpeza levou junto um EAN-8 LEGÍTIMO — o produto declara esse número como código dele');
  assert.ok(chaves.includes('7908840107701') && chaves.includes('sku:SEMEAN'),
    'a limpeza mexeu em chave que não devia (EAN-13 ou chave sintética)');
  assert.deepStrictEqual(Object.keys(JSON.parse(fs.readFileSync(arq, 'utf8'))), chaves,
    'a limpeza não foi gravada — voltaria a sujar na próxima leitura');
}

/* P2: a foto sobrevive a abrir o produto pela busca */
{
  const prod2 = fs.readFileSync(path.join(raiz, 'lib', 'checkout', 'produtos.js'), 'utf8');
  assert.ok(/img: primeiraImagem\(prod\) \|\| imgAntes \|\| ''/.test(prod2),
    'abrir o produto pela busca apaga a foto que a indexação guardou — o resultado aparece com ' +
    'foto, o funcionário clica, e da próxima busca vem sem');
}

/* 23/09 (Codex #514, P1, 2ª leva) — o teste acima provou que a REGRA de lerIndiceEan preserva um
   EAN-8 que declara `ean: chave`. Mas nenhum escritor de produção (salvarNoIndiceEan nem os três
   indexarCatalogoCompleto) gravava esse campo — todo EAN-8 real caía no mesmo balde do NCM e
   era apagado na leitura seguinte. A regra "estreita" nunca preservou nada de verdade. Este teste
   olha os ESCRITORES, não a regra: sem ele, a lacuna passa despercebida de novo. */
{
  const prod3 = fs.readFileSync(path.join(raiz, 'lib', 'checkout', 'produtos.js'), 'utf8');
  assert.ok(/idx\[e\] = comMarca/.test(prod3) && /ean: e/.test(prod3),
    'salvarNoIndiceEan não declara `ean` na entrada — lerIndiceEan vai apagar todo EAN-8 real ' +
    'na leitura seguinte, junto com o NCM');

  for (const [emp, arq] of Object.entries({
    girassol: 'girassol-backup-offline', amb: 'amb-checkout-offline', good: 'good-checkout-offline',
  })) {
    const ciclo = fs.readFileSync(path.join(raiz, arq, 'ciclo.js'), 'utf8');
    assert.ok(/novo\[e\] = \{[^}]*ean: e[^}]*\}/.test(ciclo),
      emp + '/ciclo.js: a indexação completa não declara `ean` na entrada — lerIndiceEan vai ' +
      'apagar todo EAN-8 real na leitura seguinte, junto com o NCM');
  }
}

/* 23/09 (Codex #514, P2) — a trava de 500 páginas (50 mil produtos) existia só pra não rodar pra
   sempre, mas ao ESTOURAR ela publicava `novo` do mesmo jeito que uma varredura terminada de
   verdade — e como `novo` nasce vazio (P1), um catálogo maior que 50 mil produtos faria a
   varredura APAGAR do índice tudo além da página 500, o oposto de "trava de segurança". */
{
  for (const [emp, arq] of Object.entries({
    girassol: 'girassol-backup-offline', amb: 'amb-checkout-offline', good: 'good-checkout-offline',
  })) {
    const ciclo = fs.readFileSync(path.join(raiz, arq, 'ciclo.js'), 'utf8');
    assert.ok(/catalogoCompleto = true.*break/.test(ciclo) || /catalogoCompleto = true;\s*break;/.test(ciclo),
      emp + '/ciclo.js: a página vazia final não marca o catálogo como completo');
    assert.ok(/if \(!catalogoCompleto\)/.test(ciclo),
      emp + '/ciclo.js: estourar a trava de 500 páginas publica o índice truncado em vez de abortar');
  }
}

/* 23/09 — a TRAVA DO LANÇAMENTO é o ponto onde não pode passar: ela roda uma vez por
   lançamento (não por produto do catálogo), então buscar o detalhe ali é barato — e é o único
   lugar que alcança o kit que a listagem não denunciou. */
{
  const libK = fs.readFileSync(LIB, 'utf8');
  assert.ok(/const det = await ctx\.blingGet\(`\/produtos\/\$\{it\.id\}`/.test(libK),
    'a trava do lançamento só olha a listagem — kit com EAN passaria');
  assert.ok(/estrutura\.componentes \|\| prod\.estrutura\.itens/.test(libK),
    'a trava não olha a composição, que é quem decide de verdade');
  assert.ok(/fmt === 'V'/.test(libK), 'o pai de grade passa como produto contável');
  /* o que importa é a pessoa sair sabendo o que contar, não a forma de montar a lista —
     o conserto do #515 moveu isso pra resolverComponentes, que ainda resolve por id */
  assert.ok(/componentes: await resolverComponentes\(comps\.slice\(0, 12\)/.test(libK),
    'barra o kit sem dizer QUAIS produtos contar — a pessoa fica parada');
}

/* o modo profundo existe nas três, e NÃO é o padrão (custa ~9.000 chamadas na Girassol) */
for (const [emp, arq] of Object.entries({
  amb: 'amb-checkout-offline/ciclo.js',
  girassol: 'girassol-backup-offline/ciclo.js',
  good: 'good-checkout-offline/ciclo.js',
})) {
  const c = fs.readFileSync(path.join(raiz, arq), 'utf8');
  assert.ok(/const profundo = !!\(opcoes && opcoes\.profundo\)/.test(c),
    emp + ': não tem modo profundo — sem ele, a marca de kit depende de um campo que a listagem ' +
    'nem sempre traz');
  assert.ok(/if \(!eans\.length \|\| profundo\)/.test(c), emp + ': o modo profundo não busca o detalhe');
  assert.ok(!/indexarCatalogoCompleto\(\{ *profundo: *true/.test(c),
    emp + ': o modo profundo virou padrão — são ~9.000 chamadas a mais, com o galpão operando');
}

/* Codex #515 (P2, r2) — os três buracos que sobraram do meu conserto. */
{
  const prodK = fs.readFileSync(path.join(raiz, 'lib', 'checkout', 'produtos.js'), 'utf8');
  const libK2 = fs.readFileSync(LIB, 'utf8');

  /* abrir o produto pela busca apagava o veredito da varredura profunda */
  assert.ok(/if \(antes === true && !Array\.isArray\(cmp\)\) return true;/.test(prodK),
    'abrir o produto pela busca nega o kit que a varredura profunda tinha marcado — ele volta ' +
    'a aparecer na busca até a próxima varredura');

  /* componente que vem só com id precisa de nome, senão a mensagem sai vazia */
  assert.ok(/async function resolverComponentes/.test(libK2),
    'componente que vem só com `produto.id` sairia sem sku nem nome — a mensagem ficaria ' +
    '"conte os produtos que o compõem:" e nada depois');
  assert.ok(/buscados < 6/.test(libK2),
    'resolver componente sem teto transforma uma recusa em rajada de chamadas');
  assert.ok(/if \(!sku && !nome && id\) sku = 'id ' \+ id;/.test(libK2),
    'componente que não resolveu sai vazio da lista');

  /* AMB e GOOD também classificam: eu tinha ligado o modo profundo nelas SEM a decisão */
  for (const [emp, arq] of Object.entries({
    amb: 'amb-checkout-offline/ciclo.js', good: 'good-checkout-offline/ciclo.js',
  })) {
    const c = fs.readFileSync(path.join(raiz, arq), 'utf8');
    assert.ok(/const ehKit = _semVeredito \? null/.test(c),
      emp + ': o modo profundo busca o detalhe mas NÃO classifica — a varredura cara não serve ' +
      'pro que foi feita');
    assert.ok(/novo\[e\] = \{ kit: ehKit/.test(c), emp + ': a marca não vai pro índice');

    /* Codex #515 (P2, r3) — a classificação usa `det` FORA do `if (!eans.length || profundo)`
       que o declara. Sem hoistar a variável pra fora desse bloco, `det` não existe naquele
       escopo: toda vez que o produto JÁ tinha EAN (o caso comum), a leitura de `det` explode
       com ReferenceError — e como isso roda dentro do loop de páginas, a excecão sobe, o
       `catch` externo aborta a varredura inteira, e o índice de AMB/GOOD nunca mais atualiza. */
    assert.ok(/let det = null;/.test(c),
      emp + ': `det` não está declarado fora do `if` que o preenche — ReferenceError sempre ' +
      'que o produto já tem EAN, abortando toda reindexação completa');
    const idxIf = c.indexOf('if (!eans.length || profundo)');
    const idxUsoAlvo = c.indexOf('const _alvo = det || it;');
    assert.ok(idxIf > 0 && idxUsoAlvo > idxIf,
      emp + ': não achei a classificação de kit depois do bloco que busca o detalhe');
    const idxFimIf = c.indexOf('}', idxIf);
    assert.ok(idxUsoAlvo > idxFimIf,
      emp + ': a classificação de kit usa `det` de dentro do próprio bloco que o declara — ' +
      'fora dele (produto que já tinha EAN) é ReferenceError');

    /* e o produto SEM GTIN (chave sintética `sku:`) também precisa da marca — não só quem tem EAN */
    assert.ok(/novo\['sku:' \+ sku\] = \{ kit: ehKit/.test(c),
      emp + ': produto sem GTIN não ganha a marca de kit — só quem tem EAN é classificado');
  }
}

/* 23/09 — DOIS MODOS, e a diferença entre eles é a coisa mais perigosa desta tela.
   O dono: "eu quero olhar aqui do meu lado, se tem 10 produtos A, e só digitar 10, pra
   ADICIONAR 10 ao total". Isso é ENTRADA. O que a tela fazia era CONTAGEM: "há 10 na
   prateleira", com divergência contra o Bling.
   Os dois usos são legítimos — hoje ele registra estoque que não está na prateleira; amanhã
   quer inventário —, mas o registro precisa dizer qual é: na hora de aplicar no Bling, "10"
   sozinho não diz se o estoque vai PRA 10 ou SOMA 10. Aplicar o errado põe o estoque errado e
   ninguém descobre por quê. */
{
  const os2 = require('os');
  const dir2 = fs.mkdtempSync(path.join(os2.tmpdir(), 'modo-'));
  let corpo2 = {};
  const { criar: criarContagem } = require(LIB.replace(/\.js$/, ''));
  const rc2 = criarContagem({
    prefixo: '/x', json: (r, st, o) => { r._o = o; }, validarSessao: () => ({ nome: 'Diego' }),
    lerIndiceEan: () => ({}), CACHE_DIR: dir2,
    readJson: (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return d; } },
    writeJson: () => true, readBody: async () => corpo2, empresa: { pasta: 'girassol-backup-offline' },
    /* o #522 ampliou o contrato do contexto (produtoDetalhe, localizacaoDeProduto, locCache —
       o card inline usa). Estes testes nasceram antes e não passavam, o que derrubava a lib
       inteira já no `criar`. */
    produtoDetalhe: async () => null, localizacaoDeProduto: () => '', locCache: () => ({}),
    blingGet: async (u) => u.includes('/estoques/saldos')
      ? { ok: true, data: { data: [{ saldoVirtualTotal: 3 }] } }
      : { ok: true, data: { data: [{ id: 1, codigo: 'A', formato: 'S' }] } },
  });
  const lancar2 = async (tipo) => {
    corpo2 = { sku: 'A', nome: 'Produto A', contado: 10, tipo };
    const res = {};
    await rc2({ headers: {} }, res, new URL('http://x/x/contagem-lancar'), 'POST');
    return res._o;
  };

  (async () => {
    await lancar2('somar');
    await lancar2('contagem');
    await lancar2(undefined);            // sem tipo: tem que cair no seguro
    const ls = JSON.parse(fs.readFileSync(path.join(dir2, '_contagem-estoque.json'), 'utf8')).lancamentos;

    assert.strictEqual(ls[0].tipo, 'somar', 'o tipo somar não foi gravado');
    assert.strictEqual(ls[0].divergencia, null,
      'o modo SOMAR gravou divergência — "chegaram 10" comparado com o saldo dá um número sem ' +
      'significado, e número errado é pior que número ausente');

    assert.strictEqual(ls[1].tipo, 'contagem', 'o tipo contagem não foi gravado');
    assert.strictEqual(ls[1].divergencia, 7,
      'a CONTAGEM perdeu a divergência — contou 10, o sistema dizia 3, e é esse 7 que o dono revisa');

    assert.strictEqual(ls[2].tipo, 'contagem',
      'lançamento sem tipo não caiu em contagem — o padrão tem que ser o que calcula divergência, ' +
      'porque um acréscimo aplicado como total zeraria o resto do estoque daquele produto');
  })().catch(e => { console.error(e); process.exit(1); });
}

/* e a TELA tem que deixar claro o que o número significa, antes e depois de digitar */
{
  const js9 = /<script>([\s\S]*?)<\/script>/.exec(html)[1];
  assert.ok(/let MODO_LANC = 'somar';/.test(js9), 'a tela não tem modo de lançamento');
  /* Codex #523: passou a capturar `const tipo = MODO_LANC` antes do envio (mesma trava contra
     corrida de `produto = ESCOLHIDO`), então o valor viaja como `tipo` e não mais como
     `tipo: MODO_LANC` — o que importa é que MODO_LANC ainda alimenta o campo enviado. */
  assert.ok(/tipo: MODO_LANC/.test(js9) || /const tipo = MODO_LANC;/.test(js9),
    'a tela não manda o tipo ao lançar — o servidor cairia no padrão');
  /* os botões do seletor estão no HTML, não no script */
  assert.ok(/data-lanc="somar"/.test(html) && /data-lanc="contagem"/.test(html),
    'não há como escolher o modo na tela');
  assert.ok(/\.modo-lanc \.chip\[data-lanc\]/.test(js9),
    'os botões do seletor não têm handler — trocar o modo não faria nada');
  /* Codex #523 (P1): o rótulo é a ÚNICA defesa contra digitar no modo errado — o erro que
     ninguém corrige depois, porque "10" não diz sozinho se era total ou acréscimo. Com 'somar'
     como padrão, os resultados da busca nasciam dizendo "quantidade contada".
     UMA função só: quatro pontos escrevem esse texto (o input dos resultados, as duas mensagens
     de campo vazio e o seletor), e texto na mão em qualquer um deles fica pra trás. */
  assert.ok(/'quantidade a somar' : 'total contado'/.test(js9),
    'o campo não diz o que digitar — o rótulo é a única defesa contra digitar no modo errado');
  assert.ok(!/placeholder="quantidade contada"/.test(html),
    'o campo dos resultados nasce com texto FIXO — no modo somar ele pediria o total contado');

  /* Codex #523 (P1, r2): eu escapei as aspas ao interpolar e a EXPRESSÃO virou texto — o campo
     mostrava literalmente "+esc(rotuloQtd())+" pro funcionário. `node --check` não pega: a
     string é válida, só diz outra coisa.
     Este teste EXECUTA a linha que monta o input e confere o HTML que sai. */
  {
    const linha = html.split('\n').find(l => l.includes('campo qtd') && l.includes('placeholder'));
    assert.ok(linha, 'sumiu o input de quantidade dos resultados');
    const gerado = new Function('esc', 'rotuloQtd',
      'return ' + linha.trim().replace(/\s*\+\s*$/, ''))(String, () => 'quantidade a somar');
    assert.ok(gerado.includes('placeholder="quantidade a somar"'),
      'o placeholder do campo não é avaliado — sai literal na tela: ' + gerado.slice(-60));
    assert.ok(!/rotuloQtd|JSON\.stringify/.test(gerado),
      'a expressão vazou pra dentro do texto do campo');
  }
  const defs = (js9.match(/function rotuloQtd|const rotuloQtd/g) || []).length;
  assert.strictEqual(defs, 1,
    'há ' + defs + ' definições do rótulo do modo — duas cópias divergem, e é exatamente o que ' +
    'essa função existe pra evitar');
  assert.ok((js9.match(/rotuloQtd\(\)/g) || []).length >= 4,
    'algum ponto que mostra o texto do campo não passa pela função — vai ficar pra trás na troca de modo');
  assert.ok(/l\.tipo === 'somar' \? 'a somar' : 'contado'/.test(js9),
    'a lista do dia não distingue os dois — na revisão "10" não diz se o Bling recebe 10 ou +10');
  assert.ok(/Você tem quantidades digitadas e não salvas\. Trocar o modo agora\?/.test(js9),
    'trocar de modo com quantidades digitadas as reinterpreta em silêncio');
}

/* 24/09 — CORRIGIR O QUE JÁ FOI GRAVADO. O dono lançou ~10 itens antes de os dois modos
   existirem, querendo SOMAR, e tudo ficou como contagem: "Bling tinha 1115, contado 7,
   divergência −1108". Os números que ele digitou estão certos; o que estava errado é o que
   eles SIGNIFICAM — e isso não dá pra adivinhar por ele (reescrever sozinho seria o mesmo erro
   ao contrário), então ele marca e fica a trilha de quem marcou. */
{
  const os3 = require('os');
  const { criar: criarC3 } = require(LIB.replace(/\.js$/, ''));
  const dir3 = fs.mkdtempSync(path.join(os3.tmpdir(), 'tipo-'));
  const arq3 = path.join(dir3, '_contagem-estoque.json');
  /* a linha exatamente como ficou gravada: SEM tipo, com divergência absurda */
  fs.writeFileSync(arq3, JSON.stringify({ lancamentos: [{
    id: 'x1', sku: '10-AE-8F-125mm-g100', nome: 'Lixas g100', contado: 7,
    saldo_bling_na_hora: 1115, divergencia: -1108, quando: new Date().toISOString(), quem: 'Diego',
  }] }));
  let corpo3 = {};
  const rc3 = criarC3({
    prefixo: '/x', json: (r, st, o) => { r._o = o; }, validarSessao: () => ({ nome: 'Diego' }),
    lerIndiceEan: () => ({}), CACHE_DIR: dir3,
    readJson: (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return d; } },
    writeJson: () => true, readBody: async () => corpo3, empresa: { pasta: 'girassol-backup-offline' },
    produtoDetalhe: async () => null, localizacaoDeProduto: () => '', locCache: () => ({}),
    blingGet: async () => ({ ok: false }),
  });
  const trocar = async (c) => {
    corpo3 = c; const res = {};
    await rc3({ headers: {} }, res, new URL('http://x/x/contagem-tipo'), 'POST');
    return res._o;
  };
  const ler3 = () => JSON.parse(fs.readFileSync(arq3, 'utf8')).lancamentos[0];

  (async () => {
    const r1 = await trocar({ id: 'x1', tipo: 'somar' });
    assert.ok(r1 && r1.ok, 'não dá pra corrigir o tipo de um lançamento já gravado');
    const l1 = ler3();
    assert.strictEqual(l1.tipo, 'somar', 'o tipo não mudou');
    assert.strictEqual(l1.contado, 7, 'a QUANTIDADE foi alterada — ela estava certa, só o significado não');
    assert.strictEqual(l1.divergencia, null,
      'virou acréscimo mas manteve a divergência de −1108 contra o Bling');
    assert.ok(Array.isArray(l1.tipo_trocas) && l1.tipo_trocas[0].de === 'contagem',
      'a troca não deixa trilha — num registro de conferência, mudar o significado sem rastro ' +
      'é pior que não mudar');

    /* e o caminho de volta: a divergência é recalculada do saldo guardado NO MOMENTO do
       lançamento, não de um saldo de agora */
    await trocar({ id: 'x1', tipo: 'contagem' });
    assert.strictEqual(ler3().divergencia, -1108,
      'voltando pra contagem, a divergência não foi recalculada do saldo guardado');

    assert.ok(!(await trocar({ id: 'x1', tipo: 'xxx' })).ok, 'aceitou um tipo inválido');
    assert.ok(!(await trocar({ id: 'naoexiste', tipo: 'somar' })).ok, 'aceitou id inexistente');
  })().catch(e => { console.error(e); process.exit(1); });
}

/* 24/09 (Codex #523, 2 P1 + 2 P2) — o painel de baixo (bipe / busca direta por SKU-EAN, via
   mostrarProduto) tinha rótulo e mensagem de sucesso FIXOS, alheios ao modo somar/contagem que
   só o card inline da lista de resultados acompanhava. Quem bipa e segue o rótulo do painel
   digitava o total da prateleira mesmo no modo somar. Os outros dois são efeitos colaterais dos
   dois modos: o botão "+10" quebrando o editor de número, e a divergência nula do somar sendo
   lida como "consulta ao Bling falhou". */
{
  const js10 = /<script>([\s\S]*?)<\/script>/.exec(html)[1];

  /* P1: rótulo e placeholder do painel legado vêm da MESMA função usada pelo seletor de modo —
     duas fontes de texto foi como ele ficou desatualizado da primeira vez */
  assert.ok(/id="lblQtd"/.test(html), 'o rótulo da quantidade não tem id — não dá pra atualizar com o modo');
  assert.ok(js10.includes("const rotuloQtd = () => MODO_LANC === 'somar' ? 'quantidade a somar' : 'total contado';"),
    'falta a função única de rótulo/placeholder — texto duplicado diverge de novo entre o painel e o card inline');
  assert.ok(js10.includes("document.getElementById('lblQtd').textContent = lblQtdTexto();"),
    'mostrarProduto (bipe / SKU direto) não atualiza o rótulo do painel legado ao abrir — quem bipa vê o texto do modo errado');
  assert.ok(js10.includes('q.placeholder = rotuloQtd();'),
    'mostrarProduto não atualiza o placeholder do campo #qtd ao abrir');

  /* P1: a mensagem de sucesso e a divergência do painel legado seguem o TIPO capturado no
     envio, não o MODO_LANC de agora — mesma regra do servidor (divergência só existe fora do
     modo somar), e a mesma trava de corrida que já protege `produto = ESCOLHIDO` */
  assert.ok((js10.match(/const tipo = MODO_LANC;/g) || []).length >= 2,
    'o tipo do lançamento não é capturado antes do await (painel legado e card inline) — pode ' +
    'mudar por baixo enquanto a resposta está a caminho');
  assert.ok(js10.includes("tipo !== 'somar' && produto.estoque != null"),
    'a divergência do painel legado ainda é calculada no modo somar — "diferença" sem significado, igual ao servidor evita');
  assert.ok(js10.includes("tipo === 'somar' ? 'Acréscimo salvo' : 'Contagem salva'"),
    'a mensagem de sucesso do painel legado diz sempre "Contagem salva", mesmo no modo somar');

  /* P1: trocar o modo com o painel legado aberto e uma quantidade digitada tem que avisar,
     igual já acontecia só para os cards inline */
  assert.ok(js10.includes("painelAberto && qtdAntigo && qtdAntigo.value.trim() !== ''"),
    'trocar o modo não confere a quantidade pendente do painel legado (#qtd) — só a dos cards ' +
    'inline, deixando o número do painel ser reinterpretado em silêncio');

  /* P2: o botão do modo somar mostra "+10", que um <input type="number"> rejeita como valor —
     o editor da linha tem que tirar o prefixo antes de preencher o campo */
  assert.ok(js10.includes("botao.textContent.trim().replace(/^\\+/, '')"),
    'editarQtd copia o texto do botão (com "+") direto pro campo numérico — o navegador zera o campo');

  /* P2: divergência nula no modo somar é intencional (não há saldo pra comparar), não "sem
     saldo" (que soa como falha da consulta ao Bling) */
  /* 24/09: o problema que este assert protege continua valendo — "sem saldo" num lançamento
     somar sugere falha de consulta que não houve. O que mudou é o texto: o claude[bot] pôs
     "não se aplica", o dono leu e perguntou o que não se aplicava, e agora o selo mostra a
     própria operação ("+2 estoque"). Trava o COMPORTAMENTO: somar tem texto próprio, e não é
     nenhum dos dois que sugerem falha. */
  assert.ok(js10.includes("const ehSomar = l.tipo === 'somar';"),
    'a lista do dia não distingue o lançamento somar na hora de montar o selo');
  const textoSomar = /const textoDif = ehSomar \? ([^:]+):/.exec(js10);
  assert.ok(textoSomar, 'o selo não tem texto próprio pro lançamento somar');
  assert.ok(!/sem saldo/.test(textoSomar[1]),
    'o selo de um lançamento somar diz "sem saldo" — parece que a consulta ao Bling falhou, e ' +
    'não falhou: não há o que comparar');
  const cssT10 = /<style>([\s\S]*?)<\/style>/.exec(html)[1];
  assert.ok(/\.dif\.na\{/.test(cssT10), 'a classe "na" do badge de divergência não tem CSS — sai sem estilo');
}

/* Codex #523 (P2): editar a quantidade e clicar no ⇄ disparava DOIS envios sobre o MESMO
   lançamento — o blur manda /contagem-definir, o clique manda /contagem-tipo. Os dois leem e
   regravam, então o segundo pode gravar por cima com o valor antigo: o número digitado some,
   ou o tipo volta sozinho. */
{
  const jsT = /<script>([\s\S]*?)<\/script>/.exec(html)[1];
  const corpo = /async function trocarTipo[\s\S]*?\n\}/.exec(jsT);
  assert.ok(corpo, 'sumiu a troca de tipo');
  assert.ok(/const editando = item\.querySelector\('\.qtd-edit'\);/.test(corpo[0]),
    'trocar o tipo com a quantidade em edição dispara dois envios no mesmo lançamento — um ' +
    'grava por cima do outro e o número digitado some');
}

/* 24/09 — APLICAR NO ESTOQUE DO BLING. É a última etapa do app que o dono descreveu em 22/09:
   o funcionário informa a quantidade, ele aprova, um botão lança. O caminho é o MESMO que já
   roda em produção no ciclo de defeitos (ele mandou a função inteira pra não redescobrirmos as
   armadilhas).
   ⚠️ É a única operação deste projeto que escreve no Bling, e é de MÃO ÚNICA: aplicado só se
   desfaz com outro lançamento, de saída. Toda dúvida aqui recusa. */
{
  const ent = fs.readFileSync(path.join(raiz, 'lib', 'checkout', 'estoque-entrada.js'), 'utf8');

  /* a armadilha que erra CALADO: pegar o primeiro da lista lança no produto errado, porque a
     busca do Bling é "contém" — `10-lisa-125mm-100` e `-1000` convivem no catálogo dele */
  assert.ok(/lista\.find\(x => String\(x\.codigo \|\| ''\)\.toUpperCase\(\) === alvo\.toUpperCase\(\)\)/.test(ent),
    'a entrada aceita o primeiro produto da lista — casamento tem que ser EXATO por código, ' +
    'senão lança no produto errado e ninguém descobre olhando a tela');
  assert.ok(/produto: \{ id: ach\.produto\.id \}/.test(ent),
    'manda o SKU onde o Bling quer o id do produto');
  assert.ok(/operacao: 'E'/.test(ent), 'a operação não é entrada');

  /* kit e pai de grade não têm estoque próprio: lançar neles não soma em lugar nenhum */
  assert.ok(/if \(fmt === 'V'\) return \{ pode: false/.test(ent) && /motivo: 'kit'/.test(ent),
    'a entrada aceita KIT ou pai de grade — o saldo mora nos componentes/variações');

  /* sem custo a peça entra valendo ZERO e distorce a margem depois */
  assert.ok(/corpo\.precoUnitario = custo/.test(ent),
    'a entrada não manda o custo — a peça entraria valendo zero');

  /* e o depósito: o id é diferente em cada empresa, chutar põe saldo no lugar errado */
  assert.ok(/depósito não configurado para esta empresa/.test(ent),
    'sem depósito configurado a lib tenta mesmo assim');
}

/* 24/09 (Codex #524, 5 P1 + 7 P2) — a escrita no Bling é de MÃO ÚNICA, então cada um destes
   existe porque o erro correspondente não teria conserto pela tela. */
{
  const libA = fs.readFileSync(LIB, 'utf8');
  const entA = fs.readFileSync(path.join(raiz, 'lib', 'checkout', 'estoque-entrada.js'), 'utf8');
  const baseA = fs.readFileSync(path.join(raiz, 'lib', 'checkout', 'base-funcoes.js'), 'utf8');

  /* P1: `ehAdmin` devolve TRUE com a lista de admins VAZIA (comportamento antigo). Eu me apoiei
     nele sem ler isso: com a env não configurada, QUALQUER pessoa logada lançaria no estoque. */
  /* o claude[bot] extraiu `ehAdminExplicito`, que é melhor que a minha versão: eu repetia a
     leitura da env em duas rotas, ele usa o `lerAdmins` que já existe e centraliza a regra. */
  assert.ok(/const ehAdminExplicito = \(sess\) => \{/.test(libA),
    'não há checagem de admin EXPLÍCITA — o `ehAdmin` comum devolve true com a lista vazia');
  assert.ok(/if \(ctx\.lerAdmins\(\)\.length === 0\) return false;/.test(libA),
    'sem lista de admins configurada, qualquer um lança no estoque real — ausência de lista ' +
    'não é permissão, é configuração faltando');
  /* TODA rota que expõe ou escreve estoque precisa da checagem explícita. Conta por baixo, pra
     rota nova nascer coberta em vez de reprovar o teste por existir. */
  const rotasEstoque = ['/contagem-aplicar', '/contagem-lancar-todas', '/contagem-depositos']
    .filter(r => libA.includes("'" + r + "'"));
  assert.ok((libA.match(/ehAdminExplicito\(sess\)/g) || []).length >= rotasEstoque.length,
    'há ' + rotasEstoque.length + ' rotas que expõem ou escrevem estoque e menos checagens ' +
    'explícitas de admin — alguma delas aceita qualquer sessão');

  /* P1: o POST de estoque NÃO é idempotente, e o blingWrite repete quando o fetch estoura —
     Bling grava, conexão cai, repete, soma em DOBRO no estoque real */
  /* o claude[bot] chegou numa versão MAIS PRECISA que a minha e ficou com ela: eu cortava TODAS
     as tentativas (`tentativas: 1`), mas repetir no 429 é seguro — o 429 significa que a
     requisição NÃO foi processada. O perigoso é só a repetição em cima de EXCEÇÃO DE REDE, que
     é quando não dá pra saber se o Bling gravou antes de a conexão cair. */
  assert.ok(/semRetryDeRede/.test(entA),
    'a entrada de estoque repete em cima de exceção de rede — se o Bling gravou e a conexão caiu ' +
    'antes da resposta, o envio repetido soma em DOBRO no estoque real');
  assert.ok(/semRetryDeRede/.test(baseA),
    'o blingWrite não deixa desligar a repetição de rede — quem chama sabe se o POST é ' +
    'idempotente, essa função não');

  /* P1: sem o detalhe do produto eu não sei se é kit nem o custo — e aprovava mesmo assim */
  assert.ok(/if \(!det\) return \{ pode: false/.test(entA),
    'sem conseguir ler o cadastro, a entrada era aprovada às cegas: kit aceito põe saldo onde ' +
    'ele não existe, e a escrita não tem desfazer');

  /* P1: se o marcador local não grava, a linha continua com o botão e o próximo clique soma de novo */
  assert.ok(/let marcado = false;/.test(libA) && /if \(r\.ok && !marcado\)/.test(libA),
    'o Bling pode receber a entrada sem que o registro local saiba — e aí o botão continua lá, ' +
    'convidando a lançar de novo no estoque real');

  /* P2: lançamento aplicado vira histórico; alterar depois descola o registro do que foi enviado */
  /* são CINCO recusas: as quatro rotas que alteram (ajustar, definir, excluir, trocar tipo) e a
     própria rota de aplicar, que não pode reaplicar. Conta pelo número pra que tirar qualquer
     uma delas reprove — sem as cinco, o registro descola do que foi enviado ao Bling, ou o
     estoque soma em dobro. */
  assert.ok((libA.match(/já foi aplicado no Bling/g) || []).length >= 5,
    'falta alguma recusa de lançamento já aplicado: as quatro rotas que ALTERAM (ajustar, ' +
    'definir, excluir, trocar tipo) e a de APLICAR, que não pode reaplicar');

  /* P2: a busca por código é "contém" e eu olhava 5 resultados — o exato pode estar na página 2 */
  assert.ok(/for \(let pagina = 1; pagina <= 5; pagina\+\+\)/.test(entA) && /limite=100/.test(entA),
    'a busca do produto olha poucos resultados — com `10-lisa-125mm-100` e `-1000` no catálogo, ' +
    'o exato pode ficar de fora e a entrada diria "não encontrado"');

  /* P2: falha na listagem de depósitos virava lista vazia e ok */
  assert.ok(/if \(!r \|\| !r\.ok\) throw new Error\('não consegui consultar os depósitos/.test(entA),
    'falha ao listar depósitos vira lista vazia com ok — o dono concluiria que a empresa não ' +
    'tem depósito e iria caçar no Bling à toa');

  /* P2: a observação é irreversível, e a data vinha em UTC */
  assert.ok(/timeZone: 'America\/Sao_Paulo' \}\)\.slice\(0, 10\)/.test(libA),
    'a data da observação usa UTC — lançamento das 21h-23h59 grava o dia seguinte no Bling');

  /* P2: sucesso depois de falha mostrava os dois na mesma linha */
  assert.ok(/delete l2\.ultima_falha;/.test(libA),
    'depois de um retry bem-sucedido a linha mostra "no Bling" E "falhou" ao mesmo tempo');

  /* P2: a rota dos depósitos era documentada como admin e aceitava qualquer sessão */
  assert.ok(/só o responsável pode consultar os depósitos do Bling/.test(libA),
    'a rota de depósitos não exige admin — é metadado de configuração da empresa');

  /* P2: o aviso da tela ainda prometia que ela NUNCA mexe no Bling, enquanto o botão novo
     escreve de verdade. Um aviso que virou mentira é pior que nenhum: a pessoa confia nele. */
  assert.ok(!/O saldo do Bling <b>não muda<\/b> por aqui/.test(html),
    'a tela ainda promete que o saldo do Bling nunca muda, e agora existe um botão que muda');
  assert.ok(/📦/.test(html) && /lança no Bling/.test(html),
    'o aviso não diz QUAL ação escreve no Bling — é a única que não tem desfazer');
}

/* 24/09 — CONVERTER TODAS DE UMA VEZ. Ele lançou ~10 itens de manhã querendo SOMAR, antes de
   os dois modos existirem, e cada um ficou como contagem (com divergências absurdas: "Bling
   tinha 382, contado 2, −380"). Trocar uma a uma existia; isto faz de uma vez.
   ⚠️ O perigo é justamente ser em lote: varrer o arquivo inteiro transformaria um inventário
   legítimo de outro dia em acréscimos, e a intenção original se perde pra sempre. */
{
  const libL = fs.readFileSync(LIB, 'utf8');
  assert.ok(/prefixo \+ '\/contagem-marcar-todas'/.test(libL), 'não há conversão em lote');

  /* o dia é OBRIGATÓRIO — sem ele a rota varreria tudo */
  assert.ok(/informe o dia \(AAAA-MM-DD\)/.test(libL),
    'a conversão em lote aceita rodar sem dia — varreria o arquivo inteiro, inclusive ' +
    'inventários de outros dias');
  assert.ok(/if \(diaSP\(l\.quando\) !== dia\) continue;/.test(libL),
    'o lote não filtra por dia');

  /* e não toca no que já foi pro Bling nem no que está em envio */
  assert.ok(/if \(l\.aplicado_em \|\| emAndamento\(l\)\) \{ puladas\+\+; continue; \}/.test(libL),
    'o lote altera lançamento já aplicado no Bling — o registro descolaria do que foi enviado');

  /* a trilha diz que foi em lote: numa revisão, importa saber se a pessoa decidiu item a item */
  assert.ok(/em_lote: true/.test(libL), 'a troca em lote não se identifica como tal na trilha');

  /* a tela só mostra o botão quando há o que converter */
  const jsL = /<script>([\s\S]*?)<\/script>/.exec(html)[1];
  assert.ok(/const paraTrocar = ACUMULADO\.filter/.test(jsL),
    'o aviso de conversão aparece sempre — botão que não muda nada é ruído');
  assert.ok(/!l\.aplicado_em/.test(jsL), 'o aviso conta lançamentos já aplicados, que não serão tocados');
}

/* 24/09 — LANÇAR TODOS DE UMA VEZ. O dono: "esses eu lancei de manhã quando eu achava que já
   tava certo... só pra eu não perder tempo de novo". Dez cliques no 📦 era o que existia.
   ⚠️ São N escritas IRREVERSÍVEIS seguidas — por isso o lote NÃO tem trava própria. */
{
  const libT = fs.readFileSync(LIB, 'utf8');
  assert.ok(/prefixo \+ '\/contagem-lancar-todas'/.test(libT), 'não há lançamento em lote');

  /* a razão principal: recusas duplicadas divergem, e a que ficar frouxa deixa passar o que a
     outra recusa — aparecendo só como estoque errado no Bling, sem desfazer */
  assert.ok(/r = await aplicarUm\(f\.id, sess, dep, marcaAtual\);/.test(libT),
    'o lote não reusa a `aplicarUm` do botão individual — travas duplicadas divergem, e o erro ' +
    'só apareceria como estoque errado no Bling');
  const iLote = libT.indexOf("'/contagem-lancar-todas'");
  const iFim = libT.indexOf("'/contagem-aplicar'", iLote);
  const corpoLote = libT.slice(iLote, iFim > 0 ? iFim : iLote + 3000);
  assert.ok(!/lib\.entrada\(/.test(corpoLote),
    'o lote chama a entrada direto, pulando as recusas da aplicarUm');

  /* a fila é uma FOTO: aplicarUm relê o arquivo a cada item, e trabalhar sobre lista viva
     faria o mesmo item entrar duas vezes */
  assert.ok(/\.map\(l => \(\{ id: l\.id, sku: l\.sku, qtd: Number\(l\.contado\) \}\)\)/.test(libT),
    'a fila do lote é a lista viva — o mesmo item pode entrar duas vezes');

  /* sequencial e com respiro: a cota é da conta, e em paralelo o Bling recusa por limite */
  assert.ok(/setTimeout\(s2 => /.test(libT) || /await new Promise\(s2/.test(libT),
    'o lote dispara sem respiro entre os itens — a cota do Bling é da conta');
  assert.ok(/if \(seguidas >= 3\)/.test(libT),
    'o lote insiste depois de falhas seguidas — três seguidas é problema geral (token, cota, ' +
    'depósito), e insistir só queima cota');

  /* e o dia é obrigatório, como no outro lote */
  assert.ok(/informe o dia \(AAAA-MM-DD\)/.test(corpoLote),
    'o lote aceita rodar sem dia — lançaria acréscimos de outros dias no estoque real');

  /* a tela precisa dizer QUAIS falharam: "3 de 10" sem os nomes não ajuda ninguém */
  const jsT2 = /<script>([\s\S]*?)<\/script>/.exec(html)[1];
  assert.ok(/filter\(i => !i\.ok && !i\.parou\)/.test(jsT2),
    'a tela mostra quantos falharam mas não quais — sem o SKU não dá pra agir');
  assert.ok(/somando <b>'\+soma\+'<\/b>/.test(jsT2),
    'o aviso não mostra a soma total — é a última chance de ver um número errado antes de uma ' +
    'escrita sem desfazer');
}

/* 24/09 (Codex #526, 3 P1 + 2 P2) — os três P1 são formas diferentes do mesmo risco: o lote
   prometer uma coisa e o Bling receber outra, numa escrita sem desfazer. */
{
  const libB = fs.readFileSync(LIB, 'utf8');
  const jsB = /<script>([\s\S]*?)<\/script>/.exec(html)[1];

  /* P1: só o item da vez ficava reservado; os outros seguiam editáveis, e a `aplicarUm` relê o
     registro — mexer no + / − de uma linha ainda não enviada mandava um número DIFERENTE do
     que ele confirmou na tela */
  assert.ok(/if \(fila\.some\(f => f\.id === l\.id\)\) l\.aplicando_em = marca;/.test(libB),
    'o lote não reserva a fila inteira antes de começar — dá pra alterar uma linha que ainda ' +
    'não foi enviada, e o Bling recebe outro número');
  assert.ok(/l\.aplicando_em !== reservaDoLote/.test(libB),
    'a própria reserva do lote seria lida como concorrência e recusaria todos os itens');

  /* P1: o lote devolve ok:true COM aviso quando o Bling aceitou mas o marcador não gravou */
  assert.ok(/filter\(i => i\.ok && i\.aviso\)/.test(jsB),
    'o aviso de "aceito no Bling mas não registrado aqui" passa como sucesso comum — quando a ' +
    'reserva expira o item volta a parecer pendente e o próximo clique soma de novo');

  /* P1: lista truncada faria o botão prometer menos do que o servidor executa */
  assert.ok(/if\(truncado\) return/.test(jsB),
    'com a lista do dia truncada, o botão diz "lançar os 30" e o servidor lança o dia inteiro');

  /* P2: as recusas mais comuns são DO ITEM (kit, sem custo, sem SKU) — parar em 3 seguidas
     abortava todos os válidos que vinham depois, e a nova tentativa parava no mesmo lugar */
  assert.ok(/não consegui consultar\|HTTP 401/.test(libB),
    'o lote para em 3 falhas seguidas mesmo quando elas são do ITEM — três kits em sequência ' +
    'abortariam todos os válidos seguintes');

  /* P2: "lance por partes" sem existir parte nenhuma */
  assert.ok(/const restantes = Math\.max\(0, fila\.length - 200\)/.test(libB),
    'acima de 200 o lote manda "lançar por partes", mas remontava a mesma fila e recusava de novo');
  assert.ok(/d\.restantes/.test(jsB), 'a tela não oferece a rodada seguinte quando sobra fila');

  /* P1 (r2, minha auditoria em cima do fix acima): a fila inteira reserva com UM carimbo, mas o
     TTL de 120s do `emAndamento` foi pensado pra detectar um APLICAR ÚNICO que caiu no meio —
     não um lote de até 200 itens com chamadas ao Bling (mais ainda sob 429). Passados 120s do
     início do lote, os itens que ainda esperam a vez voltariam a aparecer como "não em
     andamento" pras rotas de edição, reabrindo a MESMA janela que a reserva upfront existe pra
     fechar. Sem renovar o carimbo a cada item, um lote de umas dezenas de itens pra cima reabre
     a corrida que este PR inteiro existe pra fechar. */
  assert.ok(/let marcaAtual = marca;/.test(libB),
    'o lote usa um só carimbo (`marca`) do início ao fim — passados 120s, os itens que ainda ' +
    'esperam a vez voltam a parecer "livres" pras rotas de edição, e a reserva upfront deixa de ' +
    'proteger justamente quem mais precisa (o fim de uma fila grande)');
  assert.ok(/if \(l && l\.aplicando_em === marcaAtual && !l\.aplicado_em\) \{ l\.aplicando_em = agora; mexeu = true; \}/.test(libB),
    'o lote não renova o carimbo do resto da fila a cada item — o TTL de 120s expira antes de ' +
    'um lote grande terminar');
}

/* 24/09 (Codex #526, r3) — P1 + P2 achados depois que os dois rounds acima já tinham fechado a
   corrida DENTRO de um lote. Estes dois são sobre o que acontece EM VOLTA dele. */
{
  const libC = fs.readFileSync(LIB, 'utf8');

  /* P1: `blingWrite` perdendo a resposta devolve "não recebi confirmação do Bling (falha de
     rede)" — a escrita pode JÁ ter chegado no Bling, só a confirmação que se perdeu. Esse é
     o pior caso possível pra continuar insistindo: sem contar como falha GERAL, o lote seguia
     mandando as próximas escritas sobre a mesma conexão ruim, multiplicando os lançamentos que
     podem estar duplicados no Bling sem ninguém saber. */
  assert.ok(/const geral = .*\/[^/]*falha de rede[^/]*\/i\.test/.test(libC),
    'uma falha de rede AMBÍGUA do Bling (pode já ter escrito, só a confirmação que se perdeu) ' +
    'não conta como falha geral — o lote segue mandando escritas sobre a mesma conexão ruim');

  /* P2: duas abas (ou dois admins) chamando /contagem-lancar-todas quase juntas liam a mesma
     fila ANTES de qualquer uma reservar — cada uma disparava seu próprio laço sequencial, mas
     os dois laços rodavam em PARALELO um do outro: duas rodadas de chamadas ao Bling ao mesmo
     tempo pra mesma conta, o cenário de 429 que o laço sequencial existe pra evitar. */
  const iLoteC = libC.indexOf("'/contagem-lancar-todas'");
  const iFimC = libC.indexOf("'/contagem-aplicar'", iLoteC);
  const corpoLoteC = libC.slice(iLoteC, iFimC > 0 ? iFimC : iLoteC + 4000);
  assert.ok(/_loteLancandoTodas/.test(corpoLoteC),
    'duas chamadas simultâneas a /contagem-lancar-todas disparam dois laços sequenciais em ' +
    'PARALELO um do outro — mesma conta, duas rodadas de chamadas ao Bling ao mesmo tempo');
  assert.ok(/if \(_loteLancandoTodas\) \{/.test(corpoLoteC) && /_loteLancandoTodas = true;/.test(corpoLoteC),
    'a trava do lote não recusa uma segunda chamada concorrente antes de montar a fila');
  assert.ok(/\} finally \{\s*_loteLancandoTodas = false;/.test(corpoLoteC),
    'a trava do lote não é liberada em TODO caminho de saída (erro de leitura, fila vazia, ' +
    'falha ao reservar, fim normal) — uma vez presa, ninguém lança o dia de novo sem reiniciar');
}

/* 24/09 (Codex #526, 3 P1 na 2ª rodada) — os três são sobre o lote mandar pro Bling algo
   diferente do que o dono confirmou, ou mandar DUAS vezes. */
{
  const libF = fs.readFileSync(LIB, 'utf8');
  const entF = fs.readFileSync(path.join(raiz, 'lib', 'checkout', 'estoque-entrada.js'), 'utf8');
  const jsF = /<script>([\s\S]*?)<\/script>/.exec(html)[1];

  /* P1: a tela mandava só o dia e o servidor remontava a fila. Se alguém criasse um acréscimo
     ou mudasse uma quantidade entre carregar a página e clicar, ele confirmava "10 somando 47"
     e o Bling recebia outra coisa — sem desfazer. */
  /* 24/09: a foto agora também ESCOLHE (caixinhas de seleção). Continua sendo a foto do que ele
     viu — o que muda é que pode ser um subconjunto. */
  assert.ok(/const marcados = prontosNaTela\.filter\(l => SELECIONADOS\.has\(l\.id\)\);/.test(jsF),
    'a tela não manda a FOTO do que confirmou — o servidor lançaria uma fila diferente da que ' +
    'ele viu na tela');
  assert.ok(/Number\(i2\.qtd\) !== f\.qtd/.test(libF),
    'com seleção, a conferência de QUANTIDADE se perdeu — escolher 3 de 10 não pode abrir mão ' +
    'de lançar exatamente o número que ele viu');
  assert.ok(/const foto = Array\.isArray\(body\.itens\)/.test(libF) && /desatualizado: true/.test(libF),
    'o servidor não confere a foto contra o arquivo — divergir do confirmado é o erro mais caro ' +
    'possível numa escrita sem desfazer');

  /* P1: POST que perde a resposta PODE ter entrado no Bling. Sem marca, a rodada seguinte
     pegaria o mesmo item e somaria de novo. */
  assert.ok(/ambiguo: true/.test(entF) && /ambiguo: semResposta/.test(entF),
    'timeout e "sem resposta" no POST não são marcados como AMBÍGUOS — viram "não lançou", e ' +
    'relançar duplicaria o estoque');
  assert.ok(/if \(r\.ambiguo\) l2\.ultima_falha_ambigua = true/.test(libF),
    'a marca de escrita ambígua não é gravada no lançamento');
  assert.ok(/\.filter\(l => !l\.ultima_falha_ambigua\)/.test(libF),
    'a fila do lote inclui escrita ambígua — o item pode já ter entrado no Bling e entraria de novo');

  /* P1: `blingGet` não tem timeout; uma conexão pendurada travava a rodada e as reservas */
  assert.ok(/function comTeto\(promessa, ms, oQue\)/.test(entF),
    'a entrada não tem teto de tempo — uma conexão que não responde pendura a rodada inteira e ' +
    'deixa as reservas presas');
  assert.ok((entF.match(/comTeto\(/g) || []).length >= 4,
    'alguma etapa da entrada ficou sem teto de tempo');
  /* e o teto do POST não pode dizer "nada foi lançado" */
  assert.ok(/NÃO SEI se a entrada foi registrada/.test(entF),
    'o timeout do POST afirma que nada entrou — pode ter entrado, e o dono lançaria de novo');
}

/* 24/09 (Codex #526, r4) — a 3ª rodada de revisão achou furos nos próprios consertos da 2ª:
   o `ambiguo: true` se perdia no caminho de volta, o classificador de falha geral não via essa
   marca, a renovação do lock só rodava ENTRE itens (não durante um item lento), a tela mandava
   uma foto que incluía linha que o servidor já tinha excluído, e nada espaçava as 3 chamadas ao
   Bling de dentro de UM item. */
{
  const libF2 = fs.readFileSync(LIB, 'utf8');
  const entF2 = fs.readFileSync(path.join(raiz, 'lib', 'checkout', 'estoque-entrada.js'), 'utf8');
  const jsF2 = /<script>([\s\S]*?)<\/script>/.exec(html)[1];

  /* P1: o classificador de falha geral do lote precisa da marca ESTRUTURADA, não só do texto —
     o teto de 45s por etapa devolve mensagens nova que não batem em nenhuma palavra do regex
     antigo. */
  assert.ok(/const geral = \(r && r\.ambiguo\) \|\|/.test(libF2),
    'o lote ainda classifica falha geral só por TEXTO — o timeout de 45s por etapa devolve ' +
    'mensagens que não batem no regex, e a rodada seguiria mandando escritas sobre uma conexão ' +
    'travada sem nunca parar');

  /* P1: a renovação da reserva tem que rodar TAMBÉM enquanto o item da vez está em andamento —
     um item pode encadear até 3 tetos de 45s (135s), mais que o TTL de 120s do emAndamento. */
  assert.ok(/function renovarReserva\(\)/.test(libF2) && /setInterval\(renovarReserva/.test(libF2)
    && /clearInterval\(batendo\)/.test(libF2),
    'a reserva só é renovada ENTRE itens — um item que sozinho passa dos 120s (3 tetos de 45s ' +
    'encadeados) deixa os OUTROS da fila com o carimbo velho, liberando a edição de uma linha ' +
    'que o lote ainda vai processar');

  /* P2: a FOTO que a tela manda tem que excluir o que o servidor também exclui da fila —
     senão um item com escrita ambígua (fora da fila automática) aparece como "sumiu" e recusa
     o lote inteiro. */
  assert.ok(/ACUMULADO\.filter\(l => l\.id && l\.tipo === 'somar' && !l\.aplicado_em && !l\.ultima_falha_ambigua\)/.test(jsF2),
    'a tela monta a foto sem excluir quem tem `ultima_falha_ambigua` — o servidor tira essa ' +
    'linha da fila, a foto ainda a inclui, e a comparação recusa o lote inteiro por causa de um ' +
    'item que nem deveria estar nela');

  /* P2: nada espaçava as chamadas DE DENTRO de um item (busca, cadastro, POST) — só o laço de
     fora, entre itens. */
  assert.ok(/async function blingGet\(\.\.\.args\) \{ await _sleep\(_PAUSA_MS\)/.test(entF2)
    && /async function blingWrite\(\.\.\.args\) \{ await _sleep\(_PAUSA_MS\)/.test(entF2),
    'as chamadas ao Bling de dentro de um item não são espaçadas — 3 chamadas rápidas seguidas ' +
    'por item bastam pra estourar sozinhas o limite de ~3 req/s da conta');

  /* funcional: o `ambiguo: true` que o blingWrite devolve (escrita que PODE ter chegado no
     Bling) tem que sobreviver até o retorno de `entrada` — é o que `aplicarUm` usa pra marcar
     `ultima_falha_ambigua` e tirar o item da fila automática do lote. */
  const { criar: criarEntrada } = require(path.join(raiz, 'lib', 'checkout', 'estoque-entrada'));
  let chamadasSleep = 0;
  const libEnt = criarEntrada({
    blingGet: async (u) => /\/produtos\?codigo=/.test(u)
      ? { ok: true, data: { data: [{ id: 1, codigo: 'SKU1' }] } }
      : { ok: true, data: { data: { id: 1, formato: 'S', precoCusto: 10 } } },
    blingWrite: async () => ({ ok: false, status: 0, ambiguo: true, erro: 'rede: caiu no meio' }),
    sleep: async () => { chamadasSleep++; },
  });
  (async () => {
    const r = await libEnt.entrada({ sku: 'SKU1', quantidade: 5, depositoId: 999 });
    assert.strictEqual(r.ok, false, 'a escrita ambígua não devolveu ok:false');
    assert.strictEqual(r.ambiguo, true,
      'o retorno perdeu o `ambiguo: true` que o blingWrite mandou — sem ele, aplicarUm não marca ' +
      '`ultima_falha_ambigua`, e o item volta pra fila automática podendo somar DE NOVO um ' +
      'lançamento que talvez já tenha entrado no Bling');
    assert.ok(chamadasSleep >= 3,
      'a pausa entre chamadas ao Bling não está de fato sendo chamada — foram só ' + chamadasSleep +
      ' (busca, cadastro e POST deveriam gerar pelo menos 3)');
  })().catch(e => { console.error(e); process.exit(1); });
}

/* 24/09 — ABAS E SELEÇÃO. Pedido do dono depois de lançar pela primeira vez: as linhas
   continuavam misturadas, e lançar TODOS nem sempre é o que ele quer. */
{
  const jsS = /<script>([\s\S]*?)<\/script>/.exec(html)[1];
  const libS = fs.readFileSync(LIB, 'utf8');

  assert.ok(/data-aba="nao"/.test(jsS) && /data-aba="sim"/.test(jsS) && /data-aba="todos"/.test(jsS),
    'faltam as abas de lançados / a lançar / todos');
  assert.ok(/let ABA = 'nao';/.test(jsS),
    'a tela não abre no que FALTA lançar — é o que ele precisa ver primeiro');

  /* a caixinha só no que pode ser lançado: caixa desabilitada em linha já enviada é convite a
     clicar e achar que não funcionou. Codex #527 (P2): tem que ser o MESMO critério de
     `prontos` (o que o lote de fato aceita) — sem `!ultima_falha_ambigua` aqui, marcar uma
     linha ambígua marcava uma caixinha que não entrava em `prontosNaTela`, e a seleção
     "efetiva" ficava vazia. */
  assert.ok(/const selecionavel = !!\(l\.id && l\.tipo === 'somar' && !l\.aplicado_em && !l\.ultima_falha_ambigua\);/.test(jsS),
    'a caixinha de seleção aparece em linha que não pode ser lançada (falta excluir ultima_falha_ambigua)');

  /* nada marcado = vão todos, e o botão DIZ isso */
  assert.ok(/marcados\.length \? marcados : prontos/.test(jsS),
    'sem seleção o lote não cai de volta em "todos" — o botão prometeria algo que não faz');

  /* e no servidor, a foto passou a ESCOLHER sem deixar de CONFERIR */
  assert.ok(/fila\.length = 0;/.test(libS) && /fila\.push\(\.\.\.escolhidos\)/.test(libS),
    'o servidor ignora a seleção e lança a fila inteira do dia');
  assert.ok(/nenhum item selecionado/.test(libS),
    'uma seleção vazia cairia em "lançar tudo" — o oposto do que ele pediu');

  /* trocar de aba não pode perder a seleção nem repintar à toa */
  assert.ok(/atualizarAvisoLote\(\)/.test(jsS),
    'marcar uma caixinha repinta a lista inteira — perderia o rolamento numa lista de dezenas');
}

/* 24/09 — o dono leu "não se aplica" no selo e perguntou o que não se aplicava. O selo mostra
   a DIVERGÊNCIA, mas quem olha o card não sabe que aquele lugar é o da divergência: o texto
   tem que dizer o que a linha É, não o que ela não tem. */
{
  const jsD = /<script>([\s\S]*?)<\/script>/.exec(html)[1];
  assert.ok(!/'não se aplica'/.test(jsD),
    'o selo diz "não se aplica" sem dizer o que — o dono leu e não entendeu, que é a prova');
  assert.ok(/ehSomar \? \('\+' \+ l\.contado \+ ' estoque'\)/.test(jsD),
    'o selo de um acréscimo não mostra a operação — é ela que ele confere antes de mandar pro Bling');
}

/* 24/09 (Codex #527, r2, 2 P2) — a 2ª rodada de revisão da seleção achou dois furos de
   concorrência/promessa em volta do lote. */
{
  const jsG = /<script>([\s\S]*?)<\/script>/.exec(html)[1];
  const libG = fs.readFileSync(LIB, 'utf8');

  /* P2: o 📦 individual não olhava a trava do lote — enquanto /contagem-lancar-todas
     rodava, uma linha de fora da reserva ainda podia ser lançada por /contagem-aplicar ao
     mesmo tempo, reabrindo o paralelismo que `_loteLancandoTodas` existe pra impedir. */
  const iAplicar = libG.indexOf("'/contagem-aplicar'");
  const corpoAplicar = libG.slice(iAplicar, iAplicar + 1500);
  assert.ok(/if \(_loteLancandoTodas\) \{/.test(corpoAplicar),
    'o lançamento individual (📦) não recusa enquanto há um lote em andamento — corrida com ' +
    '/contagem-lancar-todas de volta');

  /* P2: "sem marcar nada, vão todos" é uma promessa sobre a fila INTEIRA. Sem o modo, a foto
     de "todos" era tratada igual a uma seleção parcial: um item que apareceu depois da tela
     carregar (alguém criou ou converteu um acréscimo novo) simplesmente ficava de fora, sem
     avisar ninguém — "todos" saía incompleto e reportava sucesso. */
  assert.ok(/modo: marcados\.length \? 'selecao' : 'todos'/.test(jsG),
    'a tela não diz ao servidor se a foto é "todos" ou uma seleção — sem isso ele não pode ' +
    'exigir que "todos" cubra a fila inteira');
  assert.ok(/const modoSelecao = body\.modo === 'selecao';/.test(libG),
    'o servidor ignora o modo mandado pela tela');
  assert.ok(/if \(!modoSelecao\) \{[\s\S]{0,300}sobrando/.test(libG),
    'no modo "todos" o servidor não confere se sobrou item elegível fora da foto — um acréscimo ' +
    'criado depois que a tela carregou sairia sem lançar e sem avisar');

  /* P2: com ABA === 'sim' (aba "no Bling"), `visiveis` só mostra o que já foi lançado — o
     painel de lote não pode oferecer "lançar todos" ali, porque quem revisa não vê produto
     nem quantidade dos pendentes antes de confirmar uma escrita sem desfazer. */
  const iAviso = jsG.indexOf("id=\"avisoLancar\"");
  const iIifeAviso = jsG.lastIndexOf('(() => {', iAviso);
  const corpoAvisoLote = jsG.slice(iIifeAviso, iAviso);
  assert.ok(/if\(ABA === 'sim'\) return '';/.test(corpoAvisoLote),
    'o painel de lançar em lote aparece na aba "no Bling", onde os itens pendentes não estão ' +
    'visíveis pra conferir antes de uma escrita sem desfazer');
}

/* 24/09 — O SKU VIRA LINK pra tela de estoque do produto no Bling. Pedido do dono, com os dois
   exemplos que ele mesmo levantou: 10-AE-8F-125mm-g240 → buscaid=16473065044, e o -g320 →
   16473065046. */
{
  const libK2 = fs.readFileSync(LIB, 'utf8');
  const catK2 = fs.readFileSync(path.join(raiz, 'lib', 'checkout', 'rotas-catalogo.js'), 'utf8');
  const jsK2 = /<script>([\s\S]*?)<\/script>/.exec(html)[1];

  /* o id vem do ÍNDICE LOCAL: zero chamada ao Bling por linha, e a cota é da conta */
  assert.ok(/const idx = lerIndiceEan\(\) \|\| \{\};/.test(libK2) && /idPorSku\[it\.sku\] = it\.id/.test(libK2),
    'a lista não resolve o id do produto — ou resolve consultando o Bling, o que custaria uma ' +
    'chamada por linha');
  /* Codex #528 (P2): SKU "constructor"/"toString"/"__proto__" resolvia pra propriedade
     herdada de {} em vez de dado real — precisa de um mapa sem protótipo */
  assert.ok(/const idPorSku = Object\.create\(null\)/.test(libK2),
    'idPorSku é um objeto comum — um SKU tipo "constructor" ou "__proto__" perde o id real');
  /* o do lançamento já aplicado vence: foi com ele que a entrada foi feita */
  assert.ok(/!l\.bling_produto_id && idPorSku\[l\.sku\]/.test(libK2),
    'o id do índice sobrescreve o do lançamento aplicado — o certo é o que foi usado na entrada');

  assert.ok(/estoque\.php\?buscaid='\+esc\(l\.bling_produto_id\)/.test(jsK2),
    'a lista do dia não linka o SKU pro estoque no Bling');
  assert.ok(/estoque\.php\?buscaid='\+esc\(it\.id\)/.test(jsK2),
    'o resultado da busca não linka o SKU — a busca já devolve o id, é de graça');

  /* sem id, TEXTO: link que abre a tela errada é pior que link nenhum */
  assert.ok(/: '<span class="sku">'\+esc\(l\.sku\)\+'<\/span>'/.test(jsK2),
    'sem id conhecido o SKU vira link mesmo assim — abriria a tela errada no Bling');

  /* o clique no link não pode disparar o cartão (foco no campo, seleção) — a 3ª ocorrência
     (mostrarProduto) não precisa: não está dentro de um cartão clicável */
  assert.strictEqual((jsK2.match(/onclick="event\.stopPropagation\(\)"/g) || []).length, 2,
    'o link do SKU dispara o clique do cartão — conferir o saldo no Bling mexeria na seleção aqui');
  assert.strictEqual((jsK2.match(/rel="noopener"/g) || []).length, 3,
    'link que abre em aba nova sem `noopener`');

  /* Codex #528 (P2): o caminho do leitor de código de barras (SKU/EAN exato) ia direto a
     mostrarProduto() sem passar pela lista — sem o id aqui, esse caminho nunca linkava */
  assert.ok(/id: prod\.id \|\| null/.test(catK2),
    '/buscar-produto não devolve o id do produto — o caminho de SKU/EAN escaneado fica sem link');
  assert.ok(/estoque\.php\?buscaid='\+esc\(p\.id\)/.test(jsK2),
    'mostrarProduto não linka o SKU pro estoque no Bling');

  /* Codex #528 (P2): era um <button> envolvendo o <a> do Bling — HTML não permite conteúdo
     interativo dentro de <button>. Virou div[role=button][tabindex=0], com Enter/Espaço
     tratados manualmente já que o navegador não ativa mais sozinho. */
  assert.ok(!/'<button class="lista-nome"/.test(jsK2),
    'o cartão do resultado da busca voltou a ser um <button> — não pode conter o <a> do Bling');
  assert.ok(/'<div class="lista-nome" role="button" tabindex="0"/.test(jsK2),
    'o cartão do resultado da busca não tem role="button"/tabindex — perde acessibilidade por teclado');
  assert.ok(/nomeEl\.addEventListener\('keydown'/.test(jsK2),
    'sem <button> nativo, Enter/Espaço no cartão do resultado da busca não faz mais nada');
}

console.log('OK: contagem de estoque — registro interno (nunca escreve no Bling), sessão nas 4 rotas, quantidade validada e busca por nome sem gastar cota');
