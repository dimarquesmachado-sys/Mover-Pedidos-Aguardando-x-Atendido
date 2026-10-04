/* 04/10 — MANUTENÇÃO DO HISTÓRICO no painel, peça compartilhada.

   Reúne as três rotinas que mantêm a MARGEM correta e que só a AMB enxergava: custo dos SKUs,
   imposto reaplicado e detalhes dos pedidos. Sem elas visíveis, o painel da GOOD podia mostrar
   margem errada sem nada avisando — e número errado é pior que número ausente.

   Mostra o ESTADO, não dispara nada: rotina pesada come cota do Bling, e em dia de galpão a
   operação perde primeiro.

   O teste MONTA a seção num DOM e confere o que cada linha DIZ — porque o valor da seção é o
   texto ("3 SKUs sem custo"), não a existência do card.

   ⚠️ E cobre o caso que mais importa: quando há pendência, a linha precisa AVISAR. Uma seção que
   mostra "3 SKUs sem custo" com a mesma cara de "tudo certo" não serve pra nada.

   Marcador estável [MANUTENCAO]. */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const raiz = path.join(__dirname, '..');
const { scriptDaManutencao } = require(path.join(raiz, 'lib', 'checkout', 'painel-manutencao'));

const PREFIXOS = ['/good-checkout-offline', '/amb-checkout-offline', '/girassol-backup-offline'];
for (const base of PREFIXOS) {
  const s = scriptDaManutencao(base);
  assert.doesNotThrow(() => new Function(s), '[MANUTENCAO] o script de ' + base + ' não compila');
  assert.ok(s.includes(base), '[MANUTENCAO] ' + base + ': sem o prefixo da empresa');
  for (const outra of PREFIXOS) {
    if (outra !== base) assert.ok(!s.includes(outra),
      '[MANUTENCAO] ' + base + ' carrega o prefixo de ' + outra + ' — chamaria as rotas da loja errada');
  }
  assert.ok(!/onclick=/.test(s), '[MANUTENCAO] ' + base + ': onclick inline');
}

/* ── monta num DOM e lê o que cada linha diz ──────────────────────────────────────── */
function montar(respostas) {
  const els = {};
  /* ⚠️ `outerHTML` num DOM de mentira NÃO substitui o elemento no pai — ler dali me dava o
     markup INICIAL ("carregando…") e duas mutações passavam batidas. Aqui o `outerHTML` escreve
     de volta no innerHTML do corpo, que é o que o navegador de fato mostraria. */
  const novo = (id) => {
    const el = {
      id, innerHTML: '', textContent: '', disabled: false, _ev: {}, _outer: '',
      addEventListener(e, f) { this._ev[e] = f; },
      click() { this._ev.click && this._ev.click(); },
    };
    Object.defineProperty(el, 'outerHTML', {
      get() { return this._outer; },
      set(v) {
        this._outer = v;
        const corpo = els['mtCorpo'];
        if (corpo && this._marcador) corpo.innerHTML = corpo.innerHTML.replace(this._marcador, v);
      },
    });
    return el;
  };
  els['manutencaoAqui'] = novo('manutencaoAqui');
  global.document = { getElementById: (id) => els[id] || (els[id] = novo(id)) };
  global.window = { location: { search: '?k=teste' } };
  global.URLSearchParams = URLSearchParams;
  global.fetch = async (url) => {
    const achou = Object.keys(respostas).find((r) => url.includes(r));
    return { json: async () => (achou ? respostas[achou] : { ok: false, erro: 'rota não simulada' }) };
  };
  new Function(scriptDaManutencao('/good-checkout-offline'))();
  return els;
}

module.exports = (async () => {
  /* 1) COM PENDÊNCIA: cada linha tem que DIZER o problema */
  {
    const els = montar({
      '/custo-sync': { ok: true, rodando: false, sem_custo: 217 },
      '/reaplicar-status': { ok: true, status: { rodando: false, fila: ['2026-01', '2026-02'], meses: [] } },
      '/completar-detalhes': { ok: true, rodando: false, falhas: 5 },
    });
    await new Promise((r) => setTimeout(r, 60));

    const montado = els['manutencaoAqui'].innerHTML;
    assert.ok(/Manutenção do histórico/.test(montado), '[MANUTENCAO] a seção não foi montada');

    /* ⚠️ ler SÓ o outerHTML das linhas: o `innerHTML` do corpo guarda o markup INICIAL
       ("carregando…") e misturá-lo fazia o teste acusar o que já tinha sido substituído. */
    const tudo = ['custo', 'imposto', 'detalhes'].map((id) => String(els['mt-' + id].outerHTML || '')).join(' ');

    assert.ok(/217/.test(tudo),
      '[MANUTENCAO] 217 SKUs sem custo e a seção não diz o número — é por ele que o dono sabe ' +
      'que a margem está incompleta');
    assert.ok(/2026-01/.test(tudo),
      '[MANUTENCAO] há mês na fila de reaplicação e a seção não diz qual — alíquota corrigida ' +
      'sem reaplicar deixa a margem do mês errada');
    assert.ok(/5 pedido/.test(tudo),
      '[MANUTENCAO] há pedido sem detalhe e a seção não diz quantos');

    /* ⚠️ pendência tem que FICAR VISÍVEL como aviso, não com a mesma cara de "tudo certo" */
    /* ⚠️ mira a BORDA, não "a cor em qualquer lugar": o `fundo` usa a mesma família de cor, e
       com o padrão solto a mutação que apagava a borda passava batida. */
    assert.ok(/border:1px solid rgba\(220,160,40/.test(tudo),
      '[MANUTENCAO] as pendências aparecem com a mesma cara de "tudo certo" — uma seção que não ' +
      'destaca o problema não serve pra nada');
  }

  /* 2) SEM PENDÊNCIA: não pode inventar alarme */
  {
    const els = montar({
      '/custo-sync': { ok: true, rodando: false, sem_custo: 0 },
      '/reaplicar-status': { ok: true, status: { rodando: false, fila: [], meses: ['2026-09'] } },
      '/completar-detalhes': { ok: true, rodando: false, falhas: 0 },
    });
    await new Promise((r) => setTimeout(r, 60));
    const tudo = ['custo', 'imposto', 'detalhes'].map((id) => String(els['mt-' + id].outerHTML || '')).join(' ');
    assert.ok(!/border:1px solid rgba\(220,160,40/.test(tudo),
      '[MANUTENCAO] sem pendência nenhuma a seção ainda mostra aviso — alarme falso ensina a ' +
      'ignorar o aviso de verdade');
    assert.ok(/todos os SKUs com custo/.test(tudo), '[MANUTENCAO] não diz que o custo está completo');
  }

  /* 3) ROTA FORA DO AR: a seção não pode quebrar nem mentir */
  {
    const els = montar({});
    await new Promise((r) => setTimeout(r, 60));
    const tudo = ['custo', 'imposto', 'detalhes'].map((id) => String(els['mt-' + id].outerHTML || '')).join(' ');
    assert.ok(!/carregando/.test(tudo),
      '[MANUTENCAO] a seção ficou presa em "carregando…" — o dono olharia pra ela achando que ' +
      'ainda vem número');
  }

  /* a fábrica serve e a tela da GOOD inclui */
  {
    const fab = fs.readFileSync(path.join(raiz, 'lib', 'checkout', 'fabrica-rotas-painel.js'), 'utf8');
    assert.ok(/'\/js\/manutencao\.js'/.test(fab), '[MANUTENCAO] a fábrica não serve o script');
    const tela = fs.readFileSync(path.join(raiz, 'good-checkout-offline', 'dashboard.html'), 'utf8');
    assert.ok(/id="manutencaoAqui"/.test(tela), '[MANUTENCAO] a tela da GOOD não abre o espaço');
    const idx = fs.readFileSync(path.join(raiz, 'good-checkout-offline', 'index.js'), 'utf8');
    assert.ok(idx.indexOf("js/manutencao.js' ||") >= 0,
      '[MANUTENCAO] o script não está liberado na guarda — quem abre por ?k= tomaria 401');
  }

  console.log('OK: a manutencao mostra custo, imposto e detalhes — e destaca so quando ha pendencia');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
