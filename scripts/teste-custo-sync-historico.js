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

console.log('OK: custo-sync resolve o conjunto que a tela cobra (historico + conferidos), nao so o checkout');
