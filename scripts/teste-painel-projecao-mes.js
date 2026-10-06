/* 05/10 — COMO O MÊS DEVE FECHAR, no painel.

   Projeta o fechamento do mês pelo ritmo diário. É a resposta pra "vamos bater o mês?" sem
   esperar o dia 30.

   ⚠️ O CUIDADO QUE DEFINE A SEÇÃO: ritmo de POUCOS DIAS não projeta mês. No dia 2, dois dias bons
   viram projeção eufórica e dois ruins viram pânico — e a decisão de compra sai disso. Abaixo de
   5 dias a seção NÃO projeta: mostra o faturado e diz por quê.

   ⚠️ E a conta usa os dias REAIS do mês (28/29/30/31), não "30" fixo — que erraria todo fevereiro
   e todo mês de 31 dias, sempre na mesma direção.

   O teste controla a data pra exercitar dia 2, dia 15 e meses de tamanhos diferentes.

   Marcador estável [PROJ-MES]. */
const assert = require('assert');
const path = require('path');

const raiz = path.join(__dirname, '..');
const { scriptDaProjecaoMes } = require(path.join(raiz, 'lib', 'checkout', 'painel-projecao-mes'));

const PREFIXOS = ['/good-checkout-offline', '/amb-checkout-offline', '/girassol-backup-offline'];
for (const base of PREFIXOS) {
  const s = scriptDaProjecaoMes(base);
  assert.doesNotThrow(() => new Function(s), '[PROJ-MES] o script de ' + base + ' não compila');
  for (const outra of PREFIXOS) {
    if (outra !== base) assert.ok(!s.includes(outra),
      '[PROJ-MES] ' + base + ' carrega o prefixo de ' + outra + ' — projetaria o mês da loja errada');
  }
  assert.ok(!/onclick=/.test(s), '[PROJ-MES] ' + base + ': onclick inline');
}

function montar(corpo, quando) {
  const els = {};
  const novo = (id) => ({
    id, innerHTML: '', textContent: '', value: '', disabled: false, _ev: {},
    addEventListener(e, f) { this._ev[e] = f; },
    click() { this._ev.click && this._ev.click(); },
  });
  els['projecaoMesAqui'] = novo('projecaoMesAqui');
  global.document = { getElementById: (id) => els[id] || (els[id] = novo(id)) };
  global.window = { location: { search: '?k=teste' } };
  global.URLSearchParams = URLSearchParams;
  global.fetch = async () => ({ json: async () => corpo });

  /* relógio controlado: a seção decide pelo DIA de hoje */
  const Real = Date;
  global.Date = class extends Real {
    constructor(...a) { if (a.length) return new Real(...a); return new Real(quando); }
    static now() { return new Real(quando).getTime(); }
  };
  try { new Function(scriptDaProjecaoMes('/good-checkout-offline'))(); }
  finally { setTimeout(() => { global.Date = Real; }, 200); }
  return els;
}

module.exports = (async () => {
  /* ⚠️ 1) DIA 2: não pode projetar */
  {
    const els = montar({ ok: true, totais: { faturamento: 20000 } }, '2026-10-02T12:00:00');
    await new Promise((r) => setTimeout(r, 60));
    const t = String(els['pmCorpo'].innerHTML || els['pmCorpo'].textContent || '');
    assert.ok(/ainda não dá pra projetar/.test(t),
      '[PROJ-MES] no dia 2 a seção PROJETOU o mês. Dois dias bons viram euforia e dois ruins viram ' +
      'pânico — e a decisão de compra sai daí. → ' + t.slice(0, 130));
    assert.ok(/20\.000,00/.test(t),
      '[PROJ-MES] mesmo sem projetar, precisa mostrar o faturado até aqui');
  }

  /* 2) DIA 15 de outubro (31 dias): projeta com os dias REAIS do mês */
  {
    const els = montar({ ok: true, totais: { faturamento: 150000 } }, '2026-10-15T12:00:00');
    await new Promise((r) => setTimeout(r, 60));
    const t = String(els['pmCorpo'].innerHTML || '');
    /* 150000/15 = 10.000/dia × 31 dias = 310.000 */
    assert.ok(/310\.000,00/.test(t),
      '[PROJ-MES] a projeção não usou os 31 dias REAIS de outubro → ' + t.slice(0, 160) +
      '. Usar 30 fixo erra todo mês de 31 dias, sempre pra menos.');
    assert.ok(/10\.000,00/.test(t), '[PROJ-MES] não mostra o ritmo por dia');
  }

  /* ⚠️ 3) FEVEREIRO (28 dias): o mesmo ritmo tem que dar OUTRO fechamento */
  {
    const els = montar({ ok: true, totais: { faturamento: 150000 } }, '2026-02-15T12:00:00');
    await new Promise((r) => setTimeout(r, 60));
    const t = String(els['pmCorpo'].innerHTML || '');
    /* 10.000/dia × 28 = 280.000 */
    assert.ok(/280\.000,00/.test(t),
      '[PROJ-MES] em fevereiro a projeção não usou 28 dias → ' + t.slice(0, 160) +
      '. Mês fixo de 30 dias infla fevereiro em ~7%, e é sobre esse número que se decide compra.');
  }

  /* 4) resposta sem ok:true é falha, não mês zerado */
  {
    const els = montar({ error: 'not found', totais: { faturamento: 0 } }, '2026-10-15T12:00:00');
    await new Promise((r) => setTimeout(r, 60));
    const t = String(els['pmCorpo'].innerHTML || '');
    assert.ok(!/R\$\s*0,00/.test(t),
      '[PROJ-MES] falha virou faturamento zero — o dono acharia que o mês não vendeu nada');
    assert.ok(/⚠️/.test(t), '[PROJ-MES] a falha não é avisada');
  }

  console.log('OK: projecao nao chuta mes com poucos dias e usa os dias REAIS de cada mes');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
