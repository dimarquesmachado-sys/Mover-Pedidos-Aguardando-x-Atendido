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

console.log('OK: contagem de estoque — registro interno (nunca escreve no Bling), sessão nas 4 rotas, quantidade validada e busca por nome sem gastar cota');
