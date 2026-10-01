/* 01/10 — O BACKFILL DO ANO NA GOOD, mês a mês, sozinho.

   O dono: "não dá pra fazer aquele esquema de ir sozinho, mês a mês, e se der problema, parar...
   pra eu não ter q ficar fazendo isso um por um?". A AMB e a Girassol tinham isto desde agosto;
   a GOOD ficou pra trás — e é justamente a empresa com o histórico mais incompleto.

   O que este teste trava não é "rodou": é PARAR NA HORA CERTA. Um ano que segue em frente
   depois de um mês abortado termina dizendo "concluído" com um buraco no meio, e o buraco só
   aparece meses depois, quando alguém olhar o dashboard e achar que o mês foi fraco. */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '..', 'good-checkout-offline', 'index.js'), 'utf8');

/* exercita a função DE PRODUÇÃO, recortada do arquivo — não uma cópia da lógica */
const i = src.indexOf('async function backfillAnoGood');
assert.ok(i > 0, 'sumiu a função do backfill do ano da GOOD');
const j = src.indexOf('\n}', src.indexOf('_bfGoodAno.fim = new Date', i)) + 2;
const corpo = src.slice(i, j);
const pre = "let _bfGood = {}; let _bfGoodAno = { rodando:false }; " +
  "const ULTIMO_DIA_GOOD = {'01':'31','02':'28','03':'31','04':'30','05':'31','06':'30','07':'31','08':'31','09':'30','10':'31','11':'30','12':'31'};";

function montar(resultados) {
  const f = new Function(pre + corpo + '; return { backfillAnoGood, est: () => _bfGoodAno, mes: () => _bfGood };')();
  let n = 0;
  return { f, gbo: { backfillVendas: async () => resultados[n++] || { desfecho: 'ok' } } };
}

(async () => {
  /* 1) caminho bom: roda todos os meses pedidos */
  {
    const { f, gbo } = montar([{ desfecho: 'ok' }, { desfecho: 'ok' }, { desfecho: 'ok' }]);
    await f.backfillAnoGood('03', '2026', {}, gbo);
    assert.strictEqual(f.est().feitos.length, 3, 'não rodou os três meses');
    assert.ok(!f.est().parou_em, 'parou sem motivo');
  }

  /* 2) mês ABORTADO para o ano — e diz onde parou e o que falta */
  {
    const { f, gbo } = montar([{ desfecho: 'ok' }, { desfecho: 'abortado', msg: '6 falhas seguidas do Bling' }, { desfecho: 'ok' }]);
    await f.backfillAnoGood('03', '2026', {}, gbo);
    assert.strictEqual(f.est().feitos.length, 1,
      'o ano seguiu depois de um mês abortado — terminaria "concluído" com um buraco no meio');
    assert.strictEqual(f.est().parou_em, '2026-02', 'não registrou onde parou');
    assert.deepStrictEqual(f.est().faltam, ['02', '03'],
      'não diz o que falta — sem isso o dono não sabe de onde retomar');
    assert.ok(/falhas seguidas/.test(f.est().motivo), 'perdeu o motivo original do Bling');
  }

  /* 3) ADIADO (canário ou reparo de SKU usando a cota) também para: insistir por cima é o que
        derrubou o serviço antes */
  {
    const { f, gbo } = montar([{ desfecho: 'ok' }, { adiado: 'canário conferindo o Bling' }]);
    await f.backfillAnoGood('03', '2026', {}, gbo);
    assert.strictEqual(f.est().parou_em, '2026-02', 'o adiamento não parou o ano');
    assert.ok(/canário/.test(f.est().motivo), 'perdeu o motivo do adiamento');
  }

  /* 4) ERRO LANÇADO não pode deixar a trava presa: com ela de pé, NENHUM backfill novo começa
        até o serviço reiniciar — foi assim na Girassol antes do `finally` */
  {
    const f = new Function(pre + corpo + '; return { backfillAnoGood, est: () => _bfGoodAno };')();
    const gbo = { backfillVendas: async () => { throw new Error('estourou'); } };
    await f.backfillAnoGood('02', '2026', {}, gbo);
    assert.strictEqual(f.est().rodando, false,
      'a trava do ano ficou presa depois de um erro — nenhum backfill novo começaria até ' +
      'reiniciar o serviço');
    assert.ok(f.est().fim, 'não marcou o fim');
  }

  /* 5) respiro entre os meses: a cota do Bling é da conta inteira */
  assert.ok(/setTimeout\(ok, 2500\)/.test(corpo),
    'sumiu o respiro entre os meses — o ano emendaria um mês no outro em cima da cota');

  console.log('OK: backfill do ano da GOOD — roda em sequencia, PARA no abortado/adiado dizendo o que falta, e nao prende a trava');
})().catch(e => { console.error(e); process.exit(1); });
