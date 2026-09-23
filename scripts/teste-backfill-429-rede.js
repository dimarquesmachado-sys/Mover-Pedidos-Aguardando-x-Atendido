/* 23/09 — RETOMADA DO #324, que ficou 575 commits pra trás e já não aplicava.
   Dois problemas, e o primeiro CORROMPE DADO:

   1) A listagem do backfill ganhou 2/4/8 MINUTOS de espera no limite do Bling, mas o DETALHE
      de cada pedido seguia com 3/8/20/40 SEGUNDOS. Se o limite pegasse ali, as 4 tentativas
      queimavam em ~71s, o pedido virava `sem_detalhe` — e a rodada SEGUIA até o DELETE,
      trocando o histórico antigo por um novo COM BURACOS. Foram 30 assim em janeiro.

   2) O `blingGet` devolvia `status: 429` tanto pro limite REAL quanto pra rede caída. Com a
      espera longa, uma queda de rede custava ~14 min por página sem ajudar em nada.

   O PR original consertava o `base.js` das TRÊS empresas; desde setembro o `blingGet` virou
   uma função só em lib/checkout/base-funcoes.js, então o conserto é num lugar. */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const raiz = path.join(__dirname, '..');

const src = fs.readFileSync(path.join(raiz, 'lib', 'checkout', 'base-funcoes.js'), 'utf8');

/* exercita o blingGet DE PRODUÇÃO (recortado do arquivo), não uma cópia da lógica */
const ini = src.indexOf('async function blingGet');
let corpo = src.slice(ini, src.indexOf('async function blingWrite', ini)).trimEnd();
while (corpo.endsWith('}')) {
  try { new Function(corpo); break; } catch (e) { corpo = corpo.slice(0, corpo.lastIndexOf('}')).trimEnd(); }
}
const montar = (respostas) => {
  let i = 0;
  const fetch = async () => {
    const r = respostas[i++];
    if (r === 'rede') throw new Error('ENOTFOUND');
    return { status: r, ok: r < 400, text: async () => '{}' };
  };
  return new Function('fetch', 'garantirToken', 'sleep', 'BLING_BASE', corpo + '; return blingGet;')(
    fetch, async () => 'tok', async () => {}, 'https://x');
};
const esperaLongo = (r) => !!(r && r.status === 429 && r.limite !== false);

(async () => {
  const soRede = await montar(['rede', 'rede', 'rede'])('/x', 3);
  assert.strictEqual(soRede.limite, false, 'rede caída marcada como limite do Bling');
  assert.strictEqual(esperaLongo(soRede), false,
    'queda de rede dispara a espera de 2/4/8 min — ~14 min por página sem ajudar em nada');

  const so429 = await montar([429, 429, 429])('/x', 3);
  assert.strictEqual(esperaLongo(so429), true, 'limite REAL do Bling não espera — a cota não se recupera');

  /* o segundo apontamento do PR original: `limite` exigia NENHUMA falha de rede no lote, então
     429 → rede → 429 perdia um limite real */
  const misto = await montar([429, 'rede', 429])('/x', 3);
  assert.strictEqual(misto.limite, true,
    'limite real perdido porque o mesmo lote também viu rede — 429 seguido de queda é comum');
  assert.strictEqual(esperaLongo(misto), true, 'lote misto não espera, e o limite era real');

  /* compatibilidade: quem já lia só o status não pode mudar de comportamento */
  assert.strictEqual(esperaLongo({ status: 429 }), true,
    'resposta sem os campos novos mudou de comportamento — há chamadores que só leem o status');
  assert.strictEqual(esperaLongo({ status: 500 }), false, 'erro comum não pode virar espera longa');

  /* o detalhe do pedido precisa da MESMA espera da listagem, nas duas empresas */
  for (const [emp, arq] of Object.entries({
    girassol: 'girassol-backup-offline/gbo-app.js',
    amb: 'amb-checkout-offline/index.js',
  })) {
    const s = fs.readFileSync(path.join(raiz, arq), 'utf8');
    assert.ok(/let esperas429det = 0;/.test(s),
      emp + ': o DETALHE do pedido não tem espera longa — um limite do Bling ali derruba o ' +
      'pedido do histórico, e a rodada segue até o DELETE trocando o histórico bom por um com buracos');
    assert.ok(/_rdet\.limite !== false/.test(s),
      emp + ': o detalhe espera longo também em queda de rede');
    assert.ok(/\[120, 240, 480\]\[esperas429det - 1\]/.test(s),
      emp + ': a espera do detalhe não é a mesma da listagem');
    assert.ok(/r\.limite !== false/.test(s), emp + ': a LISTAGEM espera longo em queda de rede');
  }

  console.log('OK: 429 real x rede caida — espera longa so no limite do Bling, e o DETALHE do pedido espera igual a listagem');
})().catch(e => { console.error(e); process.exit(1); });
