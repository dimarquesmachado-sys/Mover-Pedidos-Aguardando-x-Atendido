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
for (const proibido of ['blingWrite', 'blingPost', 'blingPut', 'blingPatch']) {
  assert.ok(!libCodigo.includes(proibido),
    'a lib da contagem usa ' + proibido + ' — esta tela é REGISTRO INTERNO; o dono decide depois ' +
    'o que enviar, e gravar daqui mexeria no saldo real sem ninguém ter pedido');
}
{
  /* e o contexto passado a ela também não pode carregar uma porta de escrita */
  const m = /require\('\.\.\/lib\/checkout\/rotas-contagem'\)\.criar\(\{[\s\S]*?\}\);/.exec(gbo);
  assert.ok(m, 'a Girassol não registra a lib da contagem');
  const ctxCodigo = m[0].replace(/\/\*[\s\S]*?\*\//g, '');
  assert.ok(!/blingWrite|blingPost|blingPut/.test(ctxCodigo),
    'o contexto da contagem recebe uma função de ESCRITA no Bling — tira ela: o que não chega lá, ' +
    'não vaza por engano depois');
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
assert.ok(/divergencia: \(saldoBling != null/.test(lib),
  'a divergência não é calculada no lançamento');
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
  const usadas = new Set([...html.matchAll(/class="([^"]+)"/g)]
    .flatMap(m => m[1].split(/\s+/)).filter(c => c && !c.includes("'")));
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
  assert.ok(/par\.forEach\(b => b\.disabled = true\)/.test(js3),
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
  assert.ok(/\.mais-menos button/.test(editarQtd6) && /disabled = true/.test(editarQtd6),
    'editar a quantidade não trava os botões + / − / excluir da mesma linha — o blur do ' +
    'campo e o clique num deles correm sem ordem garantida');
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
    assert.ok(/let ehKit = _semVeredito \? null/.test(c),
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

/* Codex #515 (P2, r4) — apontamentos do Codex que sobraram depois do conserto do ReferenceError:
   1) resolverComponentes só lia `produto.id`/`.codigo`/`.nome`; componentes no formato
      `componente: { id, codigo, nome }` (a MESMA forma que amb-drive-imagens/blingProdutos.js lê
      e escreve ao preservar composição num PATCH) chegavam sem sku nem nome, o filtro
      `sku || nome` os derrubava, e a recusa saía com a mensagem genérica de novo.
   2) a varredura NORMAL (sem `profundo=1`) reconstrói `novo` do zero a cada rodada e não busca o
      detalhe de quem já tem EAN — só a listagem, cujo `formato` pode dizer "S" pra algo que uma
      varredura profunda anterior já classificou como kit de verdade (via composição, só visível
      no detalhe). O botão "Indexar" comum do painel roda sem `profundo=1`; sem consultar o
      índice velho, essa passagem sem evidência própria apagava o veredito caro em silêncio a
      cada reindexação normal seguinte. */
{
  const rc = fs.readFileSync(path.join(raiz, 'lib', 'checkout', 'rotas-contagem.js'), 'utf8');
  const rcBloco = /async function resolverComponentes\(comps, sinal\) \{[\s\S]*?\n  \}/.exec(rc);
  assert.ok(rcBloco, 'resolverComponentes sumiu ou mudou de forma — o teste abaixo não acha a função');

  /* exercita a função DE PRODUÇÃO, não uma cópia da regra */
  const resolverComponentes = new Function('ctx',
    rcBloco[0] + '; return resolverComponentes;')({ blingGet: async () => ({ ok: false }) });

  /* async por causa do fallback de busca — sem `await` aqui, o processo pode encerrar antes da
     promise assentar e a asserção nunca reprova nada. `process.exitCode` garante que uma
     falha aqui vermelhe o teste mesmo tendo rodado depois do resto do arquivo (síncrono). */
  resolverComponentes([
    { componente: { id: 99, codigo: 'C-1', nome: 'Componente Um' }, quantidade: 3 },
    { produto: { id: 1, codigo: 'P-1', nome: 'Produto Um' }, quantidade: 2 },
    { componente: { id: 7 }, quantidade: 1 },   // só id, nem no formato produto — cai na busca (que falha aqui) e sai como "id 7"
  ], null).then(saida => {
    assert.deepStrictEqual(saida, [
      { sku: 'C-1', nome: 'Componente Um', qtd: 3 },
      { sku: 'P-1', nome: 'Produto Um', qtd: 2 },
      { sku: 'id 7', nome: '', qtd: 1 },
    ], 'componente no formato `componente: { id, codigo, nome }` não foi resolvido — a mensagem ' +
       'de recusa sairia sem dizer o que contar');
  }).catch(e => { console.error(e); process.exitCode = 1; });
}

{
  for (const [emp, arq] of Object.entries({
    girassol: 'girassol-backup-offline', amb: 'amb-checkout-offline', good: 'good-checkout-offline',
  })) {
    const ciclo = fs.readFileSync(path.join(raiz, arq, 'ciclo.js'), 'utf8');

    assert.ok(/const indiceAntigo = lerIndiceEan\(\);/.test(ciclo),
      emp + '/ciclo.js: não lê o índice velho antes da varredura — não tem como preservar o ' +
      'veredito de uma varredura profunda anterior');

    const bloco = /const _alvo = det \|\| it;[\s\S]*?\n {8}\}\n/.exec(ciclo);
    assert.ok(bloco, emp + '/ciclo.js: não achei o bloco de classificação de kit — mudou de forma');

    /* exercita a classificação DE PRODUÇÃO com um item que já tem EAN na listagem (não busca
       detalhe: profundo=false e eans.length>0, o caso comum de uma reindexação normal) */
    const calcEhKit = (det, it, profundo, eans, sku, indiceAntigo) =>
      new Function('det', 'it', 'profundo', 'eans', 'sku', 'indiceAntigo',
        bloco[0] + '; return ehKit;')(det, it, profundo, eans, sku, indiceAntigo);

    const itSemEvidencia = { formato: 'S' };   // listagem não traz composição nem E/V — sem evidência própria
    assert.strictEqual(
      calcEhKit(null, itSemEvidencia, false, ['789'], null, { '789': { kit: true } }),
      true,
      emp + '/ciclo.js: reindexação normal sem evidência própria APAGOU o kit que a varredura ' +
      'profunda anterior tinha marcado — o kit volta a aparecer na busca por nome');
    assert.strictEqual(
      calcEhKit(null, itSemEvidencia, false, [], 'SKU1', { 'sku:SKU1': { kit: true } }),
      true,
      emp + '/ciclo.js: o mesmo vale pro produto sem GTIN (chave sintética `sku:`)');
    assert.strictEqual(
      calcEhKit(null, itSemEvidencia, false, ['789'], null, {}),
      false,
      emp + '/ciclo.js: sem veredito anterior nenhum, o produto sem evidência não pode nascer kit');
    const detReal = { formato: 'S', estrutura: { componentes: [] } };   // detalhe FOI buscado e não achou composição — evidência real
    assert.strictEqual(
      calcEhKit(detReal, { formato: 'S' }, false, ['789'], null, { '789': { kit: true } }),
      false,
      emp + '/ciclo.js: quando o detalhe FOI buscado e não achou kit, isso é evidência real — não ' +
      'deveria herdar um veredito antigo por cima dela');
  }
}

console.log('OK: contagem de estoque — registro interno (nunca escreve no Bling), sessão nas 4 rotas, quantidade validada e busca por nome sem gastar cota');
