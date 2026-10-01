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

  /* Codex #548 (P2, r2) — ESPERAR A VEZ NÃO É TENTATIVA FRACASSADA. O backfill da Girassol leva
     ~2h e segura a trava compartilhada. Com o contador único, cada `ja_rodando` queimava uma das
     3 tentativas do mês, e a GOOD desistia na terceira recusa SEM NUNCA TER RODADO — o pior
     desfecho possível, porque o motivo não era falha nenhuma, era fila. */
  {
    const f = new Function(pre + corpo + '; return { backfillAnoGood, est: () => _bfGoodAno };')();
    let n = 0; const vistos = [];
    const gbo = { backfillVendas: async (de) => {
      vistos.push(de.slice(0, 7));
      if (de.startsWith('2026-02') && ++n <= 5) return { desfecho: 'ja_rodando', msg: 'Girassol rodando' };
      return { desfecho: 'ok' };
    } };
    await f.backfillAnoGood('03', '2026', {}, gbo);

    assert.ok(f.est().feitos.some(x => x.mes === '2026-02'),
      'a GOOD desistiu de fevereiro só porque a Girassol segurou a trava — esperar a vez não ' +
      'pode consumir tentativa');
    assert.ok(!f.est().parou_em, 'o ano parou por causa de fila, não de falha');
    assert.deepStrictEqual(f.est().tentativas || {}, {},
      'a fila gastou tentativas do mês — elas são pra falha de verdade');
    /* o contador da fila é `esperasTrava` (nome da versão do claude[bot], que ficou): é um
       orçamento PRÓPRIO, separado das tentativas do mês */
    assert.strictEqual(f.est().esperasTrava, 5, 'não contou as esperas por trava ocupada');
  }

  /* mas a fila tem teto: senão o ano ficaria presa pra sempre atrás de uma trava que não solta */
  {
    const f = new Function(pre + corpo + '; return { backfillAnoGood, est: () => _bfGoodAno };')();
    const vistos = [];
    const gbo = { backfillVendas: async (de) => {
      vistos.push(de.slice(0, 7));
      return de.startsWith('2026-02') ? { desfecho: 'ja_rodando', msg: 'presa' } : { desfecho: 'ok' };
    } };
    await f.backfillAnoGood('03', '2026', {}, gbo);
    assert.ok(vistos.filter(v => v === '2026-02').length <= 20,
      'sem teto de espera, o ano fica preso pra sempre atrás de uma trava que não solta');
    assert.strictEqual(f.est().parou_em, '2026-02', 'não desistiu depois do teto de fila');
  }

  /* Codex #548 (P2, r2) — `transitorio` SÓ pro que melhora com o tempo. O laço da listagem
     aceitava qualquer falha não-429, então 400 e 403 chegavam nas 6 tentativas e saíam marcados
     como transitórios — e o ano da GOOD varria o mês duas vezes mais pra receber a mesma recusa. */
  {
    const gbo = fs.readFileSync(path.join(__dirname, '..', 'girassol-backup-offline', 'gbo-app.js'), 'utf8');
    assert.ok(/ultimoStatusLista/.test(gbo),
      'a listagem não guarda o último status — sem ele não dá pra saber se o aborto melhora com o tempo');
    const m = gbo.match(/const _trans(?:Lista|it) = ([^;]+);/);
    assert.ok(m, 'sumiu a decisão de transitório na saída da listagem');
    /* a expressão usa `ultimoStatusLista`; o teste a exercita com o nome que ela própria usa */
    const decide = new Function('ultimoStatusLista', '_st', 'return ' + m[1] + ';');
    for (const st of [429, 500, 503, 0, 408]) {
      assert.strictEqual(decide(st, st), true, 'HTTP ' + st + ' devia ser transitório (melhora com o tempo)');
    }
    for (const st of [400, 401, 403, 404]) {
      assert.strictEqual(decide(st, st), false,
        'HTTP ' + st + ' marcado como transitório — o ano varreria o mês duas vezes mais pra ' +
        'receber a mesma recusa, queimando cota da conta');
    }
  }

  /* 01/10 — A DATA DE SÃO PAULO, pega em PRODUÇÃO. Eu escrevi
     `new Date(new Date().toLocaleString('en-CA', { timeZone: 'America/Sao_Paulo' }))`, que
     PARECE certo e devolve Invalid Date no Node: o formato sai "2026-10-01, 2:33:12 a.m." e o
     construtor não lê isso. `getFullYear()` virava NaN e a rota recusava a própria chamada sem
     parâmetro — "use &ano=AAAA". E o mês padrão caía no `|| 12`, que era pior: rodaria o ano
     INTEIRO sem ninguém pedir.
     `node --check` não pega isso, e teste nenhum pegava: só apareceu quando o dono clicou. */
  {
    assert.ok(!/toLocaleString\([^)]*America\/Sao_Paulo[^)]*\)\s*\)/.test(src),
      'voltou a construir Date a partir de toLocaleString — isso dá Invalid Date no Node');
    assert.ok(/formatToParts/.test(src),
      'a data de SP deixou de vir por formatToParts — é o que entrega os campos já no fuso, ' +
      'sem texto pra parsear');

    /* a conta do ano e do mês, exercitada como está no código */
    const partes = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit' }).formatToParts(new Date());
    const anoSP = partes.find(x => x.type === 'year').value;
    assert.ok(/^\d{4}$/.test(anoSP),
      'o ano de SP não passa na própria validação da rota — foi exatamente o erro de produção');

    /* o mês passado, incluindo a virada de ano: em JANEIRO o anterior é DEZEMBRO, e o código
       antigo (`getMonth() || 12`) rodaria janeiro..dezembro do ano corrente, que nem existe */
    /* Codex #549: o ANO padrão recua junto com o mês, senão em janeiro roda jan..dez do ano novo */
    const padrao = (anoSP, mesSP, anoParam) => {
      const ano = String(anoParam || (mesSP === 1 ? anoSP - 1 : anoSP));
      const mes = Number(ano) < anoSP ? 12 : (Number(ano) === anoSP ? mesSP - 1 : 0);
      return { ano, mes };
    };
    assert.deepStrictEqual(padrao(2027, 1), { ano: '2026', mes: 12 }, 'em janeiro o padrão é dezembro DO ANO ANTERIOR');
    assert.deepStrictEqual(padrao(2026, 2), { ano: '2026', mes: 1 });
    assert.deepStrictEqual(padrao(2026, 10), { ano: '2026', mes: 9 });
    assert.deepStrictEqual(padrao(2026, 12), { ano: '2026', mes: 11 });
    assert.deepStrictEqual(padrao(2027, 1, '2027'), { ano: '2027', mes: 0 }, 'ano corrente em janeiro: nenhum mês fechado');
    assert.deepStrictEqual(padrao(2027, 3, '2026'), { ano: '2026', mes: 12 }, 'ano passado explícito: o ano inteiro');
    assert.ok(/Number\(ano\) < _anoNumSP \? 12/.test(src) && /_mesSP === 1 \? _anoNumSP - 1/.test(src),
      'a rota deixou de derivar ano e mês padrão da mesma conta');
  }

  console.log('OK: backfill do ano da GOOD — espera e RETOMA sozinho, desiste em 3 tentativas dizendo o que falta, nao prende a trava');
})().catch(e => { console.error(e); process.exit(1); });
