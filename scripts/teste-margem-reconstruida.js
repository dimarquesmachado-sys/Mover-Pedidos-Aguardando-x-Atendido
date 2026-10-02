/* 02/10 — A MARGEM NULA NÃO VOLTAVA, NEM DEPOIS DE O CUSTO CHEGAR.

   Apontamento P1 do Codex no #560, que eu deixei pro PR de acerto porque o PR já estava na
   sexta rodada e o bug que o motivou estava resolvido.

   O que acontecia: quando o backfill não sabia o custo de um item, gravou `custo: null` E
   `margem: null` juntos. O agregado só ajusta margem que JÁ EXISTE — então essas linhas ficavam
   fora do Lucro Bruto PRA SEMPRE, inclusive depois de o custo-sync preencher o custo, que é
   exatamente o que o #560 passou a fazer.

   O efeito que o dono veria: rodar o custo-sync, ver "SKUs sem custo" cair, e o Lucro Bruto não
   mexer. Sem erro nenhum na tela. */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const hist = fs.readFileSync(path.join(__dirname, '..', 'lib', 'checkout', 'historico.js'), 'utf8');

assert.ok(/_margReconstruida\+\+/.test(hist),
  'a margem nula voltou a ficar fora do total mesmo com o custo preenchido — o dono rodaria o ' +
  'custo-sync e o Lucro Bruto não mexeria');
assert.ok(/margens_reconstruidas/.test(hist),
  'a tela não recebe quantas margens foram reconstruídas — número que muda sozinho sem a tela ' +
  'poder dizer por quê');

/* ⚠️ SÓ COM TODAS AS PARCELAS. Meia margem é número errado, e aqui número errado é pior que
   número ausente — o painel inteiro existe pra decidir preço e compra em cima dele. */
const m = hist.match(/if \(mg == null && cu != null && ([^)]+)\) \{/);
assert.ok(m, 'sumiu a guarda da reconstrução');
for (const parcela of ['vn > 0', 'Number.isFinite(im)', 'Number.isFinite(co)', 'Number.isFinite(fr)']) {
  assert.ok(m[0].includes(parcela),
    'a reconstrução deixou de exigir `' + parcela + '` — montaria margem com parcela faltando');
}

/* a fórmula é a MESMA do card (venda − imposto − comissão − frete − custo), conferida contra
   uma linha real do painel da GOOD: 147,90 − 22,19 − 17,01 − 26,05 − 64,53 = 18,12 */
const f = (vn, im, co, fr, cu) => Math.round((vn - im - co - fr - cu) * 100) / 100;
assert.strictEqual(f(147.90, 22.19, 17.01, 26.05, 64.53), 18.12,
  'a fórmula da margem reconstruída divergiu da que o painel mostra por pedido');
assert.ok(/mg = Math\.round\(\(vn - im - co - fr - cu\) \* 100\) \/ 100;/.test(hist),
  'a fórmula no código não é venda − imposto − comissão − frete − custo');

console.log('OK: margem nula se reconstroi quando o custo chega, e so com todas as parcelas');
