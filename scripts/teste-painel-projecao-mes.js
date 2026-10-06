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
    const els = montar({ ok: true, totais: { faturamento: 20000, itens: 120 } }, '2026-10-02T12:00:00');
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
    const els = montar({ ok: true, totais: { faturamento: 150000, itens: 900 } }, '2026-10-15T12:00:00');
    await new Promise((r) => setTimeout(r, 60));
    const t = String(els['pmCorpo'].innerHTML || '');
    /* ⚠️ a conta usa os dias FECHADOS (Codex #628): hoje ainda não acabou, então 150.000 em 14
       dias fechados = 10.714,29/dia × 31 = 332.142,86. Contar o dia em curso como completo
       subestimaria a projeção em ~7% no dia 15 — e em ~20% logo depois da virada do dia 5. */
    assert.ok(/332\.142,86/.test(t),
      '[PROJ-MES] a projeção não bate: esperado 332.142,86 (14 dias FECHADOS × 31 dias de outubro) → ' + t.slice(0, 160) +
      '. Usar 30 fixo erra todo mês de 31 dias, sempre pra menos.');
    assert.ok(/10\.714,29/.test(t), '[PROJ-MES] não mostra o ritmo por dia (sobre dias FECHADOS)');
  }

  /* ⚠️ 3) FEVEREIRO (28 dias): o mesmo ritmo tem que dar OUTRO fechamento */
  {
    const els = montar({ ok: true, totais: { faturamento: 150000, itens: 900 } }, '2026-02-15T12:00:00');
    await new Promise((r) => setTimeout(r, 60));
    const t = String(els['pmCorpo'].innerHTML || '');
    /* mesmo ritmo (10.714,29/dia sobre 14 dias fechados) × 28 dias = 300.000 */
    assert.ok(/300\.000,00/.test(t),
      '[PROJ-MES] em fevereiro a projeção não bate: esperado 300.000,00 (mesmo ritmo × 28 dias) → ' + t.slice(0, 160) +
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

  /* ⚠️ 5) RESPOSTA TRUNCADA não vira projeção (Codex #628) ─────────────────────────────
     Acima de 60.000 linhas a rota devolve `ok:true` com `truncado:true` e totais PARCIAIS.
     Projetar sobre isso mostra um mês MENOR do que é, com cara de número completo. */
  {
    const els = montar({ ok: true, truncado: true, totais: { faturamento: 150000, itens: 900 } }, '2026-10-15T12:00:00');
    await new Promise((r) => setTimeout(r, 60));
    const t = String(els['pmCorpo'].innerHTML || '');
    assert.ok(!/332\.142/.test(t),
      '[PROJ-MES] a resposta veio TRUNCADA (totais parciais) e a seção projetou mesmo assim — ' +
      'mostraria um mês menor do que é, com cara de número completo');
    assert.ok(/truncada|incompleto/.test(t),
      '[PROJ-MES] não avisa que o histórico veio truncado → ' + t.slice(0, 120));
  }

  /* ⚠️ 5b) HOJE JÁ TEM VENDA PARCIAL NO TOTAL (Codex #628, 2ª rodada) ───────────────────
     Dia 6, fim da tarde: o total pedido até hoje = 5 dias fechados (50.000) + 8.000 de hoje.
     Dividir 58.000 por 5 inflaria o ritmo (11.600/dia). O certo: 50.000/5 = 10.000 × 31. */
  {
    const hojeSP = '2026-10-06';
    const els = montar({ ok: true, totais: { faturamento: 58000, itens: 400 },
      dias: { [hojeSP]: { fat: 8000, pedidos: 20 } } }, '2026-10-06T18:00:00-03:00');
    await new Promise((r) => setTimeout(r, 60));
    const t = String(els['pmCorpo'].innerHTML || '');
    assert.ok(/310\.000,00/.test(t) && /10\.000,00/.test(t),
      '[PROJ-MES] o faturamento PARCIAL de hoje entrou no ritmo dos dias fechados (esperado ' +
      '310.000,00 = 50.000/5 × 31) → ' + t.slice(0, 200));
  }

  /* ⚠️ 5c) intervalo VAZIO não é "fecha em R$ 0,00" (Codex #628, 2ª rodada) */
  {
    const els = montar({ ok: true, totais: { faturamento: 0, itens: 0, pedidos: 0 } }, '2026-10-15T12:00:00');
    await new Promise((r) => setTimeout(r, 60));
    const t = String(els['pmCorpo'].innerHTML || '');
    assert.ok(!/deve fechar/.test(t) && !/R\$\s*0,00/.test(t),
      '[PROJ-MES] intervalo sem linhas virou projeção de R$ 0,00 — período não importado ' +
      'parece mês sem venda → ' + t.slice(0, 140));
    assert.ok(/⚠️/.test(t) && /base/.test(t), '[PROJ-MES] não avisa que não há base pra projetar');
  }

  /* ⚠️ 6) o botão "atualizar" precisa furar o cache de 10 min */
  {
    const urls = [];
    const els = (function () {
      const e = montar({ ok: true, totais: { faturamento: 150000, itens: 900 } }, '2026-10-15T12:00:00');
      const antes = global.fetch;
      global.fetch = async (u) => { urls.push(u); return antes(u); };
      return e;
    })();
    await new Promise((r) => setTimeout(r, 60));
    els['pmAtualizar'].click();
    await new Promise((r) => setTimeout(r, 60));
    assert.ok(urls.some((u) => /fresh=1/.test(u)),
      '[PROJ-MES] o clique em "atualizar" não manda `fresh=1` — a rota guarda o agregado por 30 ' +
      'min, então o botão devolveria o MESMO número e a venda recém-registrada não apareceria. ' +
      'Botão que não atualiza é pior que botão ausente. → ' + JSON.stringify(urls).slice(0, 130));
  }

  /* ⚠️ 7) FUSO DA LOJA, não do navegador (Codex #628) ──────────────────────────────────
     O dono está em Amsterdã. Às 23h30 do dia 31 em São Paulo já é dia 1 do mês seguinte lá — o
     card pediria OUTRO MÊS e dividiria por outro dia, discordando do painel ao lado, que usa
     America/Sao_Paulo explicitamente.

     ⚠️ O INSTANTE É FIXO de propósito: a primeira versão desta prova usava a hora atual, e nela
     Amsterdã e São Paulo caem no MESMO dia na maior parte das horas — a mutação passava batida.
     Uma prova que só funciona em certas horas do dia não é prova. */
  {
    const { spawnSync } = require('child_process');
    const INSTANTE = '2026-10-31T23:30:00-03:00';          /* SP: 31/10 · Amsterdã: 01/11 */
    const prova =
      'const Real = Date;' +
      'global.Date = class extends Real { constructor(...a){ if(a.length) return new Real(...a); return new Real(' + JSON.stringify(INSTANTE) + '); } static now(){ return new Real(' + JSON.stringify(INSTANTE) + ').getTime(); } };' +
      'const { scriptDaProjecaoMes } = require(' + JSON.stringify(path.join(raiz, 'lib', 'checkout', 'painel-projecao-mes')) + ');' +
      'const els={}; const novo=(id)=>({id,innerHTML:"",textContent:"",value:"",disabled:false,_ev:{},addEventListener(e,f){this._ev[e]=f;},click(){this._ev.click&&this._ev.click();}});' +
      'els["projecaoMesAqui"]=novo("x");' +
      'global.document={getElementById:(id)=>els[id]||(els[id]=novo(id))};' +
      'global.window={location:{search:""}}; global.URLSearchParams=URLSearchParams;' +
      'const urls=[]; global.fetch=async(u)=>{urls.push(u); return {json:async()=>({ok:true,totais:{faturamento:1}})};};' +
      'new Function(scriptDaProjecaoMes("/good-checkout-offline"))();' +
      'setTimeout(()=>{ console.log("U:"+JSON.stringify(urls)); }, 80);';
    const r = spawnSync(process.execPath, ['-e', prova], {
      encoding: 'utf8', timeout: 30000,
      env: Object.assign({}, process.env, { TZ: 'Europe/Amsterdam' }),
    });
    const linha = String(r.stdout || '').split('\n').filter((l) => l.startsWith('U:')).pop();
    assert.ok(linha, '[PROJ-MES] não consegui rodar a prova de fuso → ' + String(r.stderr || '').slice(0, 130));
    const urls = JSON.parse(linha.slice(2));

    assert.ok(urls.some((u) => u.includes('de=2026-10-01') && u.includes('ate=2026-10-31')),
      '[PROJ-MES] navegador em Amsterdã às 23h30 de 31/10 em São Paulo: o card pediu o intervalo ' +
      'pelo fuso do NAVEGADOR (já 01/11 lá) em vez do fuso da LOJA → ' +
      JSON.stringify(urls).slice(0, 150) + '. Na virada do mês isso busca o MÊS ERRADO e divide ' +
      'por outro dia, discordando do painel ao lado.');
  }

  console.log('OK: projecao nao chuta mes com poucos dias e usa os dias REAIS de cada mes');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
