/* 04/10 — FINANCEIRO DO MERCADO LIVRE no painel, peça compartilhada.

   Duas coisas que a AMB mostra e a GOOD não mostrava: as DESPESAS POR CATEGORIA (tarifa de
   venda, frete, Full, publicidade — o que explica a diferença entre o que a venda rende e o que
   cai na conta) e a FATURA NO CARTÃO (o ML fecha dia 12 e debita).

   ⚠️ O CASO QUE MAIS ENGANA, e que este teste existe pra travar: quando não há coleta no
   período, a seção NÃO pode mostrar "R$ 0,00". Zero faria o dono acreditar que o ML não cobrou
   nada — e decidir preço com base nisso. Tem que dizer que não há dado. É a regra da casa:
   número errado é pior que número ausente.

   ⚠️ MEDI ANTES DE ESCREVER: `/ml-fee` não é tratada na GOOD, `/status-mkt` exige período e
   `/tiktok-custo-devolucoes` recusa por falta de peça — nenhuma entrou. Seção que nasce
   mostrando erro é pior que seção ausente.

   Marcador estável [ML-FIN]. */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const raiz = path.join(__dirname, '..');
const { scriptDoMlFinanceiro } = require(path.join(raiz, 'lib', 'checkout', 'painel-ml-financeiro'));

const PREFIXOS = ['/good-checkout-offline', '/amb-checkout-offline', '/girassol-backup-offline'];
for (const base of PREFIXOS) {
  const s = scriptDoMlFinanceiro(base);
  assert.doesNotThrow(() => new Function(s), '[ML-FIN] o script de ' + base + ' não compila');
  assert.ok(s.includes(base), '[ML-FIN] ' + base + ': sem o prefixo da empresa');
  for (const outra of PREFIXOS) {
    if (outra !== base) assert.ok(!s.includes(outra),
      '[ML-FIN] ' + base + ' carrega o prefixo de ' + outra + ' — leria o financeiro da loja errada');
  }
  assert.ok(!/onclick=/.test(s), '[ML-FIN] ' + base + ': onclick inline');
}

function montar(respostas, rejeitar, periodoPainel) {
  const els = {};
  const novo = (id) => ({
    id, innerHTML: '', textContent: '', value: '', disabled: false, _ev: {},
    addEventListener(e, f) { this._ev[e] = f; },
    click() { this._ev.click && this._ev.click(); },
  });
  els['mlFinanceiroAqui'] = novo('mlFinanceiroAqui');
  global.document = { getElementById: (id) => els[id] || (els[id] = novo(id)) };
  global.window = { location: { search: '?k=teste' } };
  global.URLSearchParams = URLSearchParams;
  /* o painel da GOOD expõe PERIODO + janela(); não existem #de/#ate */
  global.PERIODO = 'custom';
  global.janela = () => periodoPainel || { de: '2026-09-01', ate: '2026-09-30' };
  const urls = [];
  global.fetch = async (url) => {
    urls.push(url);
    if (rejeitar) throw new Error('rede fora');   /* cai no .catch, como o navegador faria */
    const achou = Object.keys(respostas).find((r) => url.includes(r));
    return { json: async () => (achou ? respostas[achou] : { ok: false, erro: 'não simulada' }) };
  };
  new Function(scriptDoMlFinanceiro('/good-checkout-offline'))();
  return { els, urls };
}

module.exports = (async () => {
  /* 1) COM DESPESAS: tabela, total e percentual */
  {
    const { els, urls } = montar({
      '/ml-billing-resumo': { ok: true, de: '2026-09-01', ate: '2026-09-30',
        categorias: { 'tarifa de venda': 1200.5, 'frete': 800, 'publicidade': 200 }, atualizado: new Date().toISOString() },
      /* a forma REAL da rota: faturas[], cada uma com o próprio total — sem valor/total no topo */
      '/ml-fatura-cartao': { ok: true, atualizado: new Date().toISOString(),
        faturas: [{ rotulo: 'out/2026', total: 2200.5, situacao: 'em andamento' }],
        leia: 'a fatura do ML fecha dia 12' },
    });
    await new Promise((r) => setTimeout(r, 60));

    const tab = String(els['mlfTab'].innerHTML || '');
    assert.ok(/<table/.test(tab), '[ML-FIN] não desenhou a tabela de despesas');
    assert.ok(/tarifa de venda/.test(tab), '[ML-FIN] faltam as categorias na tabela');

    /* ⚠️ o TOTAL é o número que o dono compara com o extrato — não pode faltar nem vir errado */
    assert.ok(/2\.200,50/.test(tab),
      '[ML-FIN] o total das despesas não bate com a soma das categorias → ' + tab.slice(0, 150));

    /* a maior despesa tem que vir primeiro: é o que se olha primeiro */
    const iTarifa = tab.indexOf('tarifa de venda');
    const iPub = tab.indexOf('publicidade');
    assert.ok(iTarifa >= 0 && iPub > iTarifa,
      '[ML-FIN] as categorias não vêm da maior pra menor — a maior despesa é o que se olha primeiro');

    const fat = String(els['mlfFatura'].innerHTML || els['mlfFatura'].textContent || '');
    assert.ok(/2\.200,50/.test(fat), '[ML-FIN] a fatura do cartão não mostra o valor → ' + fat.slice(0, 110));

    /* o período do painel tem que ir na chamada */
    assert.ok(urls.some((u) => /de=2026-09-01&ate=2026-09-30/.test(u)),
      '[ML-FIN] a chamada não leva o período escolhido no painel (PERIODO/janela) — traria o resumo errado');
  }

  /* 2) ⚠️ SEM COLETA: não pode dizer R$ 0,00 */
  {
    const { els } = montar({
      '/ml-billing-resumo': { ok: true, de: '2026-09-01', ate: '2026-09-30', categorias: {}, atualizado: new Date().toISOString() },
      '/ml-fatura-cartao': { ok: true, faturas: [], atualizado: null },
    });
    await new Promise((r) => setTimeout(r, 60));

    const tab = String(els['mlfTab'].innerHTML || '');
    assert.ok(!/R\$\s*0,00/.test(tab),
      '[ML-FIN] sem coleta no período a seção mostra "R$ 0,00" — o dono acreditaria que o ML não ' +
      'cobrou nada e decidiria preço com base nisso. Número errado é pior que número ausente.');
    assert.ok(/não há coleta|sem despesas coletadas/.test(tab),
      '[ML-FIN] a seção não explica que a ausência é falta de COLETA, não ausência de cobrança');

    const fat = String(els['mlfFatura'].innerHTML || '');
    assert.ok(!/R\$\s*0,00/.test(fat),
      '[ML-FIN] a fatura sem valor aparece como R$ 0,00 — mesma mentira');
  }

  /* 3) ROTA FORA DO AR: avisa, não fica em "carregando"
     ⚠️ o `fetch` precisa REJEITAR de verdade. Meu dublê devolvia `{ok:false}` — que entra no
     `.then`, não no `.catch` — e as mutações que engoliam o erro de rede passavam batidas. */
  {
    const { els } = montar({}, true);
    await new Promise((r) => setTimeout(r, 60));
    const tudo = String(els['mlfTab'].innerHTML || '') + ' ' +
                 String(els['mlfFatura'].innerHTML || els['mlfFatura'].textContent || '');
    assert.ok(!/carregando/.test(tudo),
      '[ML-FIN] a seção ficou presa em "carregando…" — o dono olharia achando que ainda vem número');

    /* ⚠️ as DUAS partes precisam avisar: eu conferia o conjunto, e a mutação que engolia só o
       erro da FATURA passava batida porque a tabela já tinha avisado por ela. */
    const soFatura = String(els['mlfFatura'].innerHTML || els['mlfFatura'].textContent || '');
    assert.ok(!/carregando/.test(soFatura) && soFatura.length > 0,
      '[ML-FIN] a FATURA ficou presa em "carregando…" quando a rota caiu — a tabela avisar por ' +
      'ela não basta: são dois números diferentes');
    const soTabela = String(els['mlfTab'].innerHTML || '');
    assert.ok(!/carregando/.test(soTabela) && soTabela.length > 0,
      '[ML-FIN] a TABELA ficou presa em "carregando…" quando a rota caiu');
  }

  /* 2b) 404 {error} (sessão vencida / não-admin) é FALHA, não "sem despesas" */
  {
    const { els } = montar({
      '/ml-billing-resumo': { error: 'not found' },
      '/ml-fatura-cartao': { error: 'not found' },
    });
    await new Promise((r) => setTimeout(r, 60));
    const tab = String(els['mlfTab'].innerHTML || '');
    assert.ok(/⚠️/.test(tab) && !/sem despesas coletadas/.test(tab),
      '[ML-FIN] resposta 404 virou "sem despesas" — falha de autorização apresentada como ausência de cobrança');
    assert.ok(/⚠️/.test(String(els['mlfFatura'].textContent || '')),
      '[ML-FIN] resposta 404 da fatura não avisou');
  }

  /* 2c) coleta parada: o total aparece COM o aviso de idade */
  {
    const velho = new Date(Date.now() - 5 * 86400000).toISOString();
    const { els } = montar({
      '/ml-billing-resumo': { ok: true, categorias: { frete: 10 }, atualizado: velho },
      '/ml-fatura-cartao': { ok: true, atualizado: velho, faturas: [{ rotulo: 'out/2026', total: 5 }] },
    });
    await new Promise((r) => setTimeout(r, 60));
    assert.ok(/coleta parada/.test(String(els['mlfTab'].innerHTML)), '[ML-FIN] total de coleta velha sem aviso');
    assert.ok(/desatualizado/.test(String(els['mlfFatura'].innerHTML)), '[ML-FIN] fatura de coleta velha sem aviso');
  }

  /* painel da AMB: expõe intervalo() (e `periodo` minúsculo), não janela()/PERIODO (Codex #656) */
  {
    const antes = { j: global.janela, p: global.PERIODO };
    montar({});   /* prepara document/window; depois tira janela()/PERIODO e deixa só intervalo() */
    delete global.janela; delete global.PERIODO;
    global.intervalo = () => ({ de: '2026-10-01', ate: '2026-10-09' });
    const urlsAmb = [];
    global.fetch = async (url) => { urlsAmb.push(url); return { json: async () => ({ ok: true, categorias: { frete: 10 }, faturas: [] }) }; };
    new Function(scriptDoMlFinanceiro('/amb-checkout-offline'))();
    await new Promise((r) => setTimeout(r, 60));
    assert.ok(urlsAmb.some((u) => u.includes('/ml-billing-resumo?de=2026-10-01&ate=2026-10-09')),
      '[ML-FIN] na AMB (intervalo()) o widget não pediu as despesas do período → ' + urlsAmb.join(' | '));
    delete global.intervalo;
    global.janela = antes.j; global.PERIODO = antes.p;
  }

  /* a fábrica serve, a tela inclui e a guarda libera */
  {
    const fab = fs.readFileSync(path.join(raiz, 'lib', 'checkout', 'fabrica-rotas-painel.js'), 'utf8');
    assert.ok(/'\/js\/ml-financeiro\.js'/.test(fab), '[ML-FIN] a fábrica não serve o script');
    const tela = fs.readFileSync(path.join(raiz, 'good-checkout-offline', 'dashboard.html'), 'utf8');
    assert.ok(/id="mlFinanceiroAqui"/.test(tela), '[ML-FIN] a tela da GOOD não abre o espaço');
    const idx = fs.readFileSync(path.join(raiz, 'good-checkout-offline', 'index.js'), 'utf8');
    assert.ok(idx.indexOf("js/ml-financeiro.js' ||") >= 0,
      '[ML-FIN] o script não está liberado na guarda — quem abre por ?k= tomaria 401');
  }

  console.log('OK: financeiro do ML mostra despesas e fatura — e nao transforma "sem dado" em zero');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
