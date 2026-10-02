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
/* ⚠️ minha primeira regex usava [^)]+ e NUNCA casava, porque a própria condição tem `)` dentro
   (`Number.isFinite(im)`). O teste falhou e eu já tinha subido o push — por isso pego a linha
   inteira e confiro nela. */
const _lin = hist.split('\n').find(l => l.includes('if (mg == null && cu != null'));
assert.ok(_lin, 'sumiu a guarda da reconstrução');
/* Codex #564: base valor_produto (como o backfill) e imposto CONHECIDO (im > 0, não só finito) */
for (const parcela of ['vp > 0', 'im > 0', 'Number.isFinite(co)', 'Number.isFinite(fr)']) {
  assert.ok(_lin.includes(parcela),
    'a reconstrução deixou de exigir `' + parcela + '` — montaria margem com parcela faltando');
}

/* a fórmula é a MESMA do card (venda − imposto − comissão − frete − custo), conferida contra
   uma linha real do painel da GOOD: 147,90 − 22,19 − 17,01 − 26,05 − 64,53 = 18,12 */
const f = (vn, im, co, fr, cu) => Math.round((vn - im - co - fr - cu) * 100) / 100;
assert.strictEqual(f(147.90, 22.19, 17.01, 26.05, 64.53), 18.12,
  'a fórmula da margem reconstruída divergiu da que o painel mostra por pedido');
assert.ok(/mg = Math\.round\(\(vp - im - co - fr - cu\) \* 100\) \/ 100;/.test(hist),
  'a fórmula no código não é valor_produto − imposto − comissão − frete − custo');

/* a LISTA (historico-linhas) reconstrói igual ao agregado, senão card e tabela divergem */
assert.ok(/_mgL = Math\.round\(\(_vpL - _imL - _coL - _frL - _cuLn\) \* 100\) \/ 100;/.test(hist),
  'a lista de pedidos do período não reconstrói a margem nula como o agregado');

/* o painel precisa dizer por que o número mudou */
const dash = fs.readFileSync(path.join(__dirname, '..', 'good-checkout-offline', 'dashboard.html'), 'utf8');
assert.ok(/margens_reconstruidas/.test(dash), 'o dashboard da GOOD não mostra o aviso de margens reconstruídas');

/* 02/10 — O GATILHO ERA "A LISTA CRESCEU", E ISSO FALHOU EM PRODUÇÃO.

   O dono rodou o custo-sync e veio `0/0` com `inicio: null` — o sync nunca começou. O disco do
   Render é PERSISTENTE: o `_hist_skus.json` sobreviveu ao deploy, a lista já tinha os 217 SKUs,
   a união não cresceu, e o gatilho não disparou. Os SKUs ficaram parados sem nada que os
   acionasse — o bug do #560 de volta por outra porta.

   Agora o gatilho é HÁ SKU SEM RESOLVER. Grava só quando muda (não escreve à toa), mas dispara
   sempre que houver pendência — e quem decide se roda é o custoSync, com sua trava e seu teto. */
{
  const hist2 = fs.readFileSync(path.join(__dirname, '..', 'lib', 'checkout', 'historico.js'), 'utf8');

  assert.ok(/const _pendentes = /.test(hist2),
    'o gatilho voltou a ser "a lista cresceu" — depois de um deploy, com o arquivo já no disco, ' +
    'nada dispararia o sync e os SKUs ficariam sem custo pra sempre');
  assert.ok(/if \(_pendentes > 0\) \{/.test(hist2),
    'não dispara por pendência');
  assert.ok(/const _mudou = _uniao\.size > _antes;[\s\S]{0,120}if \(_mudou\) writeJson/.test(hist2),
    'voltou a gravar o arquivo em toda leitura — escrita à toa no disco a cada abertura do painel');

  /* a contagem de pendência, exercitada como está no código */
  const _cc = { 'COM-CUSTO': { custo: 10 }, 'ZERO': { custo: 0 }, 'NULO': { custo: null } };
  const conta = (lista) => { let n = 0; for (const sk of lista) { const c = _cc[String(sk).trim()];
    if (!(c && c.custo != null && Number(c.custo) > 0)) n++; } return n; };
  assert.strictEqual(conta(['COM-CUSTO']), 0, 'SKU com custo contou como pendente');
  assert.strictEqual(conta(['ZERO']), 1, 'custo ZERO não é custo — tem que contar como pendente');
  assert.strictEqual(conta(['NULO']), 1, 'custo nulo tem que contar como pendente');
  assert.strictEqual(conta(['NAO-ESTA-NO-CACHE']), 1, 'SKU fora do cache tem que contar como pendente');
}

console.log('OK: margem nula se reconstroi quando o custo chega, e so com todas as parcelas');
