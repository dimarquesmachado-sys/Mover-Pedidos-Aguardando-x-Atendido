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
const pre = "let _bfGood = {}; let _bfGoodAno = { rodando:false }; const ESPERA_RETOMA_MS = 30; const MAX_ESPERAS_TRAVA = 16; " +
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

  /* 2) mês ABORTADO que NÃO se recupera: para e diz onde parou e o que falta.
        ⚠️ ESTE CASO MUDOU quando entrou a retomada: antes o ano morria na primeira falha. Agora
        ele espera e tenta de novo, e só desiste depois de 3 — por isso o mock precisa falhar
        TODAS as vezes pra provar a parada. */
  {
    const { f, gbo } = montar([{ desfecho: 'ok' },
                               { desfecho: 'abortado', transitorio: true, msg: '6 falhas seguidas do Bling' },
                               { desfecho: 'abortado', transitorio: true, msg: '6 falhas seguidas do Bling' },
                               { desfecho: 'abortado', transitorio: true, msg: '6 falhas seguidas do Bling' }]);
    await f.backfillAnoGood('03', '2026', {}, gbo);
    assert.strictEqual(f.est().feitos.length, 1,
      'o ano seguiu depois de um mês que falhou 3× — terminaria "concluído" com um buraco');
    assert.strictEqual(f.est().parou_em, '2026-02', 'não registrou onde parou');
    assert.deepStrictEqual(f.est().faltam, ['02', '03'],
      'não diz o que falta — sem isso o dono não sabe de onde retomar');
    assert.ok(/falhas seguidas/.test(f.est().motivo), 'perdeu o motivo original do Bling');
  }

  /* 3) ADIADO (canário ou reparo de SKU usando a cota) segue o MESMO caminho: espera e tenta de
        novo, e a espera longa é justamente o que o adiamento pede — o canário solta a cota */
  {
    const { f, gbo } = montar([{ desfecho: 'ok' }, { adiado: 'canário conferindo o Bling' }, { desfecho: 'ok' }, { desfecho: 'ok' }]);
    await f.backfillAnoGood('03', '2026', {}, gbo);
    assert.ok(!f.est().parou_em,
      'o adiamento matou o ano — era pra esperar o canário soltar a cota e seguir');
    assert.strictEqual(f.est().feitos.length, 3, 'não completou o ano depois do adiamento');
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

  /* 5) RETOMA SOZINHO depois de esperar — o dono pediu "parar, esperar e reiniciar sozinho", e
        a primeira versão só parava: ele teria que descobrir pelo status e disparar de novo mês
        a mês, que é o trabalho manual que ele queria tirar. */
  {
    let n = 0; const vistos = [];
    const f = new Function(pre + corpo + '; return { backfillAnoGood, est: () => _bfGoodAno };')();
    const seq = [{ desfecho: 'ok' }, { desfecho: 'abortado', transitorio: true, msg: 'Bling instável' }, { desfecho: 'ok' }, { desfecho: 'ok' }];
    const gbo = { backfillVendas: async (de) => { vistos.push(de.slice(0, 7)); return seq[n++] || { desfecho: 'ok' }; } };
    await f.backfillAnoGood('03', '2026', {}, gbo);

    assert.deepStrictEqual(vistos, ['2026-01', '2026-02', '2026-02', '2026-03'],
      'não voltou pro mês que falhou, ou perdeu os meses seguintes ao devolvê-lo pra fila');
    assert.strictEqual(f.est().feitos.length, 3,
      'uma falha passageira matou o ano inteiro — era pra esperar e seguir');
    assert.ok(!f.est().parou_em, 'parou mesmo tendo se recuperado');
  }

  /* 6) mas DESISTE depois de 3 tentativas no mesmo mês: se o terceiro ataque falha, o problema
        não é passageiro, e insistir a noite toda queima cota sem resolver */
  {
    let n = 0; const vistos = [];
    const f = new Function(pre + corpo + '; return { backfillAnoGood, est: () => _bfGoodAno };')();
    const gbo = { backfillVendas: async (de) => { vistos.push(de.slice(0, 7)); return n++ === 0 ? { desfecho: 'ok' } : { desfecho: 'abortado', transitorio: true, msg: 'cota' }; } };
    await f.backfillAnoGood('03', '2026', {}, gbo);

    assert.strictEqual(vistos.filter(v => v === '2026-02').length, 3,
      'número de tentativas no mesmo mês mudou — 3 é o teto pensado: menos desiste cedo, mais ' +
      'queima cota a noite toda');
    assert.strictEqual(f.est().parou_em, '2026-02', 'não parou depois de esgotar as tentativas');
    assert.deepStrictEqual(f.est().faltam, ['02', '03'],
      'o que falta não inclui o mês que falhou e os seguintes — é daí que o dono retoma');
    assert.ok(/3 tentativas/.test(f.est().motivo), 'o motivo não diz que já esgotou as tentativas');
  }

  /* 7) a espera entre tentativas é LONGA de propósito: os dois motivos de parada (cota do Bling,
        canário usando a mesma cota) pedem tempo, não insistência */
  assert.ok(/15 \* 60 \* 1000/.test(src),
    'a espera padrão entre tentativas deixou de ser 15 min — repetir rápido em cima da cota foi ' +
    'o que derrubou o serviço antes');

  /* 8) respiro entre os meses: a cota do Bling é da conta inteira */
  assert.ok(/setTimeout\(ok, 2500\)/.test(corpo),
    'sumiu o respiro entre os meses — o ano emendaria um mês no outro em cima da cota');

  /* 9) Codex #548 P1: `ja_rodando` (a Girassol pegou a trava compartilhada durante a espera) é
        RETENTÁVEL — antes o mês entrava em `feitos` sem ter rodado */
  {
    let n = 0; const vistos = [];
    const f = new Function(pre + corpo + '; return { backfillAnoGood, est: () => _bfGoodAno };')();
    const seq = [{ desfecho: 'ja_rodando', msg: 'outro backfill' }, { desfecho: 'ok' }, { desfecho: 'ok' }];
    const gbo = { backfillVendas: async (de) => { vistos.push(de.slice(0, 7)); return seq[n++] || { desfecho: 'ok' }; } };
    await f.backfillAnoGood('02', '2026', {}, gbo);
    assert.deepStrictEqual(vistos, ['2026-01', '2026-01', '2026-02'], 'ja_rodando não foi retentado');
    assert.strictEqual(f.est().feitos.length, 2, 'ja_rodando virou mês "feito" sem rodar');
  }

  /* 9b) Codex #548 P2: trava ocupada por MUITO tempo (>2 polls) não gasta as retentativas do mês —
         o mês só falha de verdade depois de rodar */
  {
    let n = 0; const vistos = [];
    const f = new Function(pre + corpo + '; return { backfillAnoGood, est: () => _bfGoodAno };')();
    const seq = [1, 2, 3, 4, 5].map(() => ({ desfecho: 'ja_rodando', msg: 'outro backfill' }));
    const gbo = { backfillVendas: async (de) => { vistos.push(de.slice(0, 7)); return seq[n++] || { desfecho: 'ok' }; } };
    await f.backfillAnoGood('01', '2026', {}, gbo);
    assert.ok(!f.est().parou_em, 'lock ocupado esgotou as retentativas do mês');
    assert.strictEqual(f.est().feitos.length, 1, 'o mês não rodou depois que a trava liberou');
    assert.strictEqual(vistos.length, 6);
  }

  /* 10) Codex #548 P2: aborto DETERMINÍSTICO (segurança/spool/disco) e erro inesperado NÃO
         são retentados — esperar não conserta e cada tentativa refaz a varredura cara */
  for (const falha of [{ desfecho: 'abortado', msg: 'ABORTADO por segurança' }, { desfecho: 'erro', msg: 'boom' }]) {
    const vistos = [];
    const f = new Function(pre + corpo + '; return { backfillAnoGood, est: () => _bfGoodAno };')();
    const gbo = { backfillVendas: async (de) => { vistos.push(de.slice(0, 7)); return falha; } };
    await f.backfillAnoGood('03', '2026', {}, gbo);
    assert.strictEqual(vistos.length, 1, 'retentou uma falha que esperar não resolve: ' + falha.desfecho);
    assert.strictEqual(f.est().parou_em, '2026-01');
    assert.deepStrictEqual(f.est().faltam, ['01', '02', '03']);
  }

  /* 11) Codex #548 P2: GOOD_ANO_ESPERA_MS inválida cai no padrão (e erro lançado solta o _bfGood) */
  {
    const trecho = src.slice(src.indexOf('const _espEnv'), src.indexOf('async function backfillAnoGood'));
    const calc = v => new Function('process', trecho + '; return ESPERA_RETOMA_MS;')({ env: { GOOD_ANO_ESPERA_MS: v } });
    for (const ruim of ['15m', '-5', 'NaN', '99999999999']) assert.strictEqual(calc(ruim), 900000, 'aceitou espera inválida: ' + ruim);
    assert.strictEqual(calc('30'), 30);
    assert.strictEqual(calc(undefined), 900000);
    const f = new Function(pre + corpo + '; return { backfillAnoGood, mes: () => _bfGood };')();
    await f.backfillAnoGood('02', '2026', {}, { backfillVendas: async () => { throw new Error('estourou'); } });
    assert.notStrictEqual(f.mes().estado, 'rodando', '_bfGood ficou "rodando" depois de exceção');
  }

  console.log('OK: backfill do ano da GOOD — espera e RETOMA sozinho, desiste em 3 tentativas dizendo o que falta, nao prende a trava');
})().catch(e => { console.error(e); process.exit(1); });
