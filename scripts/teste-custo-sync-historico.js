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
  assert.ok(/function _agendarCustoSync/.test(good),
    'sumiu a remarcação — sync recusado pela trava pesada nunca mais tentaria');
  assert.ok(/return false;/.test(good.slice(good.indexOf('async function custoSyncTravado'), good.indexOf('async function custoSyncTravado') + 700)),
    '`custoSyncTravado` voltou a devolver undefined na recusa — quem chama não distingue ' +
    '"recusado" de "rodou", e a remarcação deixa de funcionar em silêncio');
  assert.ok(/if \(_remarcado\) return;/.test(good),
    'cada abertura do painel enfileiraria um relógio novo');
  assert.ok(/tentativa > 12/.test(good), 'sumiu o teto de tentativas — remarcaria pra sempre');

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
  assert.ok(/todos\.add\(_orig\)/.test(_tr),
    'o sync voltou a guardar só o DESTINO do de-para — SKU com caixa diferente no histórico ' +
    'seguiria sem custo pra sempre');
  assert.ok(/if \(_dest && String\(_dest\)\.trim\(\) !== _orig\)/.test(_tr),
    'não pergunta pelo destino, ou pergunta duas vezes pelo mesmo');
}

console.log('OK: custo-sync resolve o conjunto que a tela cobra (historico + conferidos), nao so o checkout');
