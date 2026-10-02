/* 01/10 — O CUSTO-SYNC SÓ OLHAVA OS PEDIDOS CONFERIDOS.

   O dono abriu o PT-06-PRETO-1xLED no Bling, mostrou o custo lá (R$ 15,81, na aba
   Fornecedores) e foi direto: "tem custo no Bling sim. Vc q não tá pegando direito".

   Estava certo. A rodada do custo-sync terminou 209/209 com ZERO falhas e o painel seguiu
   acusando 217 SKUs sem custo — porque os dois conjuntos são diferentes:
     · `conferidos.json`  → o que passou pelo CHECKOUT (recente)
     · o painel           → o HISTÓRICO inteiro, jan a set, 13.327 pedidos do backfill

   SKU vendido em fevereiro e não bipado agora NUNCA entrava na lista de alvos, então nunca era
   perguntado ao Bling. Zero falhas não significava "resolvi tudo": significava "não perguntei".

   A lição que este teste trava: o conjunto que o sync RESOLVE tem que ser o mesmo que a tela
   COBRA. Enquanto forem dois, a rodada termina limpa e o número continua errado — e "número
   errado é pior que número ausente". */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const raiz = path.join(__dirname, '..');

/* 1) quem CALCULA os sem-custo grava a lista em disco */
{
  const hist = fs.readFileSync(path.join(raiz, 'lib', 'checkout', 'historico.js'), 'utf8');
  assert.ok(/_hist_skus\.json/.test(hist),
    'o histórico não grava mais a lista de SKUs sem custo — sem ela o custo-sync volta a ' +
    'perguntar só pelos pedidos conferidos e a rodada termina "limpa" com o número errado');
  /* acumula (união) a lista INTEIRA — não a cortada em 60, nem só a do último período */
  assert.ok(/for \(const sk of semCustoSet\) _uniao\.add/.test(hist),
    'não acumula mais — um período curto apagaria os SKUs dos outros');
  assert.ok(/aoPublicarSkusSemCusto\(\)/.test(hist), 'não dispara o sync ao publicar SKU novo');
}

/* 2) quem RESOLVE lê essa lista */
{
  const good = fs.readFileSync(path.join(raiz, 'good-checkout-offline', 'index.js'), 'utf8');
  const i = good.indexOf('async function custoSync(');
  assert.ok(i > 0, 'sumiu o custoSync da GOOD');
  const corpo = good.slice(i, good.indexOf('const SETE_D', i));
  assert.ok(/_hist_skus\.json/.test(corpo),
    'o custo-sync voltou a montar os alvos só do conferidos.json — SKU do histórico não seria ' +
    'perguntado ao Bling, e a rodada terminaria 100% sem resolver nada do que a tela cobra');
  assert.ok(/resolverDeParaSku\(/.test(corpo), 'SKU antigo do histórico não passa pelo de-para');
  assert.ok(/aoPublicarSkusSemCusto:/.test(good), 'a GOOD não liga o disparo do sync');
  assert.ok(/CONFERIDOS_FILE/.test(corpo),
    'perdeu os pedidos conferidos — o recente é que alimenta o checkout do dia');
}

/* Codex #560 — OS TRÊS FUROS DO GATILHO AUTOMÁTICO, que o robô e eu escrevemos em cima do
   conserto original. Todos têm o mesmo formato: o sync parece ter rodado e o número continua
   errado — pior que não rodar, porque ninguém vai atrás. */
{
  const good = fs.readFileSync(path.join(raiz, 'good-checkout-offline', 'index.js'), 'utf8');
  const hist = fs.readFileSync(path.join(raiz, 'lib', 'checkout', 'historico.js'), 'utf8');

  /* P1 — RECUSADO PELA TRAVA tem que REMARCAR. Os SKUs já foram gravados, então a publicação
     seguinte não vê novidade e não dispara: sem remarcar, ficam pra sempre sem ser perguntados
     ao Bling — o bug original com outra cara. */
  /* ⚠️ A FORMA É A DO claude[bot], que eu preferi à minha: o retry mora DENTRO do próprio
     `custoSyncTravado` (parâmetro `retentar`) em vez de numa função separada. Entrega o mesmo
     e não espalha a lógica por dois lugares. O teste cobra o COMPORTAMENTO, não a minha forma. */
  assert.ok(/_custoRetentando/.test(good),
    'sumiu a remarcação — sync recusado pela trava pesada nunca mais tentaria, e os SKUs já ' +
    'gravados na lista não disparam nada de novo');
  assert.ok(/custoSyncTravado\(fresh, retentar\)|function custoSyncTravado\(fresh, retentar\)/.test(good),
    '`custoSyncTravado` perdeu o parâmetro que distingue "pedido do histórico" de chamada comum');
  assert.ok(/aoPublicarSkusSemCusto: \(\) => \{[^}]*custoSyncTravado\(false, true\)/.test(good),
    'o gatilho do histórico parou de pedir retry — volta a ser descartado quando a trava recusa');

  /* P2 — NÃO CACHEAR O TOTAL PRÉ-SYNC. O `dados` foi calculado ANTES do sync rodar; o painel
     não manda `fresh=1`, então atualizar depois serviria o número velho por 10 min — o dono
     diria "rodou e não mudou nada". */
  assert.ok(/!_disparouCustoSync/.test(hist),
    'o histórico voltou a cachear o total calculado ANTES do sync disparado na mesma requisição');
  assert.ok(/_disparouCustoSync = true;/.test(hist), 'a bandeira nunca é marcada');

  /* P2 — GUARDAR ORIGINAL E DESTINO do de-para. O resolvedor casa ignorando a caixa, mas quem
     herda o custo procura pela chave COMO ESTÁ no pedido: histórico `pm1` com de-para `Pm1`
     resolveria o destino e o histórico continuaria sem achar. */
  /* ⚠️ `_hist_skus.json` aparece DUAS vezes no arquivo e eu mirei na primeira, que é outra
     coisa — o teste acusou um conserto que estava lá. Ancora no custoSync, que é o trecho
     certo. */
  const _iS = good.indexOf('async function custoSync(');
  assert.ok(_iS > 0, 'sumiu o custoSync da GOOD');
  const _tr = good.slice(_iS, good.indexOf('const SETE_D', _iS));
  /* ⚠️ ESTA REGRA MUDOU DE VERDADE (Codex #560 r5), e o teste mudou junto em vez de ser
     contornado. Eu tinha posto o SKU ANTIGO e o DESTINO na fila, pra o histórico achar o custo
     pela grafia dele. Com a busca que ignora caixa (`_custoDe`), o `_comManual` já expõe o
     custo do destino sob a grafia antiga — então perguntar pelo código aposentado só gasta
     cota: o Bling não acha, vira falha registrada, e a falha SE REPETE a cada retry porque não
     fica cache nenhum. Com muitos renomeados, atrasa as buscas que resolvem.
     Agora vai só o DESTINO; SKU sem de-para continua indo como ele é. */
  assert.ok(/todos\.add\(_dest \? String\(_dest\)\.trim\(\) : _orig\)/.test(_tr),
    'o sync voltou a perguntar pelo SKU ANTIGO do de-para — código morto no Bling, falha ' +
    'registrada a cada rodada e cota gasta à toa');
  assert.ok(!/todos\.add\(_orig\);\s*\n\s*const _dest/.test(_tr),
    'voltou a enfileirar os DOIS (antigo e destino)');
}

/* Codex #560 r4 — OS DOIS QUE FECHAM O CICLO. */
{
  const good2 = fs.readFileSync(path.join(raiz, 'good-checkout-offline', 'index.js'), 'utf8');
  const hist2 = fs.readFileSync(path.join(raiz, 'lib', 'checkout', 'historico.js'), 'utf8');

  /* P1 — SKU QUE RODOU E NÃO RESOLVEU também precisa de nova chance. O retry anterior só
     cobria a trava ocupada; falha passageira do Bling ou custo vazio deixava o SKU na lista,
     a união não crescia mais e o callback nunca disparava de novo — o total ficava errado até
     alguém rodar à mão. Mesma armadilha do bug original. */
  /* ⚠️ A FORMA É A DO claude[bot] e é melhor que a minha: o `custoSync` DEVOLVE quantos
     sobraram, em vez de eu reler `_custos.json` do disco pra contar. Menos I/O e sem o risco
     de a contagem divergir do que a rodada realmente viu. O teste cobra o COMPORTAMENTO. */
  assert.ok(/const _sobrou = await custoSync\(fresh\)/.test(good2),
    'o custoSync parou de devolver quantos SKUs sobraram — sem isso não dá pra saber se a ' +
    'rodada resolveu tudo');
  assert.ok(/_sobrou > 0 && \+\+_custoTentativas < CUSTO_TENTATIVAS_MAX/.test(good2),
    'o sync não remarca quando TERMINA deixando SKU sem custo — a união não cresce mais e ' +
    'nada dispara o callback de novo, que é a armadilha do bug original');
  assert.ok(/CUSTO_TENTATIVAS_MAX = \d+/.test(good2),
    'sumiu o teto de remarcações — custo que não existe no Bling faria o sync insistir pra ' +
    'sempre, queimando cota');
  /* Codex #560 (P2, r5): mas o teto NÃO pode virar parada definitiva. Bling fora durante as 5
     tentativas deixaria os SKUs sem custo até alguém rodar à mão — nada mais dispara, porque a
     lista já está no disco. Falha de REQUISIÇÃO segue tentando, devagar (1h). */
  assert.ok(/_sobrou > 0 && _cst\.falhas > 0\) _agendarRetryCusto\(60 \* 60 \* 1000\)/.test(good2),
    'depois do teto, sobra por FALHA DE REQUISIÇÃO parou de ser retentada — uma queda longa do ' +
    'Bling deixaria o custo velho até deploy ou rodada manual');
  assert.ok(/function _agendarRetryCusto\(esperaMs\)/.test(good2),
    'o retry não aceita espera própria — o ritmo lento pós-teto martelaria de 3 em 3 min');

  /* P2 — O ÍNDICE DE CAIXA SE MONTA UMA VEZ POR MAPA. A versão anterior varria
     `Object.keys(mapa)` DENTRO da busca, e a busca roda por LINHA do histórico (teto 60.000)
     contra um cache de milhares de SKUs. Medido: ~30s de tela travada contra 19ms. E só
     acontecia nos SKUs de grafia diferente — ou seja, o conserto de caixa travava a tela que
     ele existe pra consertar. */
  assert.ok(/_idxMaiusc = new WeakMap\(\)/.test(hist2),
    'o índice de caixa voltou a ser montado a cada linha — o painel trava no período longo');
  assert.ok(!/const achou = Object\.keys\(mapa\)\.find/.test(hist2),
    'voltou a varredura linear dentro da busca de custo');
  assert.ok(/if \(!idx\.has\(X\)\) idx\.set\(X, x\)/.test(hist2),
    'empate de grafia não é estável — o mesmo SKU poderia pegar custo diferente na mesma tela');

  /* e o comportamento, exercitado como está no arquivo */
  const _i = hist2.indexOf('const _idxMaiusc = new WeakMap();');
  const _corpo = hist2.slice(_i, hist2.indexOf('const _histCacheBruto', _i));
  const _custoDe = new Function(_corpo + '; return _custoDe;')();
  const mapa = { 'Pm1': { custo: 5 }, 'OUTRO': { custo: 9 } };
  assert.strictEqual(_custoDe(mapa, 'Pm1').custo, 5, 'perdeu a busca exata');
  assert.strictEqual(_custoDe(mapa, 'pm1').custo, 5, 'perdeu a busca ignorando caixa');
  assert.strictEqual(_custoDe(mapa, 'PM1').custo, 5, 'perdeu a busca em maiúsculas');
  assert.strictEqual(_custoDe(mapa, 'NAOEXISTE'), undefined, 'inventou custo pra SKU inexistente');
}

console.log('OK: custo-sync resolve o conjunto que a tela cobra (historico + conferidos), nao so o checkout');
