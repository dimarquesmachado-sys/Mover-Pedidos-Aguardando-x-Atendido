/* 04/10 — FICHA DO PRODUTO no painel, peça compartilhada.

   Busca um SKU e mostra o histórico de custo: cada faixa de vigência, o custo do Bling hoje, o
   manual e qual está valendo agora.

   Por que importa: a margem de um pedido antigo usa o custo que valia NAQUELA data. Quando um
   número do painel parece errado, é aqui que se confere — e isso só existia na AMB.

   ⚠️ OS DOIS CUIDADOS QUE ESTE TESTE TRAVA:
   1. custo AUSENTE não pode virar "R$ 0,00" — zero diria que o produto não custa nada e a
      margem sairia INFLADA. Número errado é pior que número ausente;
   2. busca nova DESCARTA a resposta da anterior — sem isso, digitar um SKU e logo outro pode
      mostrar o custo do primeiro embaixo do nome do segundo, e a conferência vira ruído.

   ⚠️ MEDI ANTES: `/sku-info` não é tratada na GOOD, `/produto-fotos` exige sessão e
   `/config-frete-magalu` recusa — nenhuma entrou.

   Marcador estável [FICHA]. */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const raiz = path.join(__dirname, '..');
const { scriptDaFicha } = require(path.join(raiz, 'lib', 'checkout', 'painel-ficha-produto'));

const PREFIXOS = ['/good-checkout-offline', '/amb-checkout-offline', '/girassol-backup-offline'];
for (const base of PREFIXOS) {
  const s = scriptDaFicha(base);
  assert.doesNotThrow(() => new Function(s), '[FICHA] o script de ' + base + ' não compila');
  assert.ok(s.includes(base), '[FICHA] ' + base + ': sem o prefixo da empresa');
  for (const outra of PREFIXOS) {
    if (outra !== base) assert.ok(!s.includes(outra),
      '[FICHA] ' + base + ' carrega o prefixo de ' + outra + ' — buscaria o custo na loja errada');
  }
  assert.ok(!/onclick=/.test(s), '[FICHA] ' + base + ': onclick inline');
}

function montar(responder) {
  const els = {};
  const novo = (id) => ({
    id, innerHTML: '', textContent: '', value: '', disabled: false, _ev: {},
    addEventListener(e, f) { this._ev[e] = f; },
    click() { this._ev.click && this._ev.click(); },
  });
  els['fichaProdutoAqui'] = novo('fichaProdutoAqui');
  global.document = { getElementById: (id) => els[id] || (els[id] = novo(id)) };
  global.window = { location: { search: '?k=teste' } };
  global.URLSearchParams = URLSearchParams;
  global.fetch = responder;
  new Function(scriptDaFicha('/good-checkout-offline'))();
  return els;
}

const resp = (corpo, atraso) => async () => {
  if (atraso) await new Promise((r) => setTimeout(r, atraso));
  return { json: async () => corpo };
};

module.exports = (async () => {
  /* 1) COM histórico: as faixas aparecem com data e valor */
  {
    const els = montar(resp({
      ok: true, sku: 'PT-06', custo_atual_bling: 42.5, custo_manual: null, vigente_hoje: 42.5,
      faixas: [
        { de: '2026-01-01', ate: '2026-05-31', custo: 38.9, origem: 'bling' },
        { de: '2026-06-01', ate: null, custo: 42.5, origem: 'bling' },
      ],
    }));
    els['fpSku'].value = 'PT-06';
    els['fpBuscar'].click();
    await new Promise((r) => setTimeout(r, 50));

    const tab = String(els['fpTab'].innerHTML || '');
    assert.ok(/<table/.test(tab), '[FICHA] não desenhou a tabela de faixas');
    assert.ok(/38,90/.test(tab),
      '[FICHA] o custo ANTIGO não aparece — é com ele que a margem do pedido antigo foi calculada');
    assert.ok(/2026-01-01/.test(tab), '[FICHA] faltam as datas de vigência');
    assert.ok(/hoje/.test(tab), '[FICHA] a faixa aberta não aparece como vigente');

    const info = String(els['fpInfo'].innerHTML || els['fpInfo'].textContent || '');
    assert.ok(/42,50/.test(info), '[FICHA] o resumo não diz o custo vigente');
  }

  /* 2) ⚠️ SEM custo: não pode virar R$ 0,00 */
  {
    const els = montar(resp({
      ok: true, sku: 'SEM-CUSTO', custo_atual_bling: null, custo_manual: null,
      vigente_hoje: null, faixas: [],
    }));
    els['fpSku'].value = 'SEM-CUSTO';
    els['fpBuscar'].click();
    await new Promise((r) => setTimeout(r, 50));

    const tudo = String(els['fpInfo'].innerHTML || '') + ' ' + String(els['fpTab'].innerHTML || '');
    assert.ok(!/R\$\s*0,00/.test(tudo),
      '[FICHA] SKU sem custo aparece como "R$ 0,00" — isso diria que o produto não custa nada e ' +
      'a margem sairia INFLADA. Número errado é pior que número ausente.');
    assert.ok(/sem custo|sem histórico/.test(tudo),
      '[FICHA] não diz que o custo está ausente → ' + tudo.slice(0, 120));
  }

  /* 3) ⚠️ BUSCA NOVA descarta a anterior: a lenta não pode sobrescrever a rápida */
  {
    let qual = 0;
    const els = montar(async (url) => {
      qual++;
      const lenta = qual === 1;
      if (lenta) await new Promise((r) => setTimeout(r, 80));
      return { json: async () => ({
        ok: true, sku: lenta ? 'PRIMEIRO' : 'SEGUNDO',
        custo_atual_bling: lenta ? 11.11 : 99.99,
        vigente_hoje: lenta ? 11.11 : 99.99,
        faixas: [{ de: '2026-01-01', ate: null, custo: lenta ? 11.11 : 99.99, origem: 'bling' }],
      }) };
    });

    els['fpSku'].value = 'PRIMEIRO';
    els['fpBuscar'].click();
    els['fpSku'].value = 'SEGUNDO';
    els['fpBuscar'].click();
    await new Promise((r) => setTimeout(r, 140));

    const tudo = String(els['fpInfo'].innerHTML || '') + ' ' + String(els['fpTab'].innerHTML || '');
    assert.ok(/99,99/.test(tudo),
      '[FICHA] a segunda busca não apareceu → ' + tudo.slice(0, 110));
    assert.ok(!/11,11/.test(tudo),
      '[FICHA] a resposta ATRASADA da primeira busca sobrescreveu a segunda — o painel mostraria ' +
      'o custo de um SKU embaixo do nome de outro, bem na tela usada pra CONFERIR número');
  }

  /* ⚠️ 4) Codex #612: EDITAR O CAMPO durante a busca invalida o resultado. Sem clicar de novo o
     `seq` não muda, e a resposta do SKU A era desenhada embaixo de um campo que já diz B. */
  {
    const els = montar(async () => {
      await new Promise((r) => setTimeout(r, 60));
      return { json: async () => ({ ok: true, sku: 'ANTIGO', custo_atual_bling: 11.11,
        vigente_hoje: 11.11, faixas: [{ de: '2026-01-01', ate: null, custo: 11.11, origem: 'bling' }] }) };
    });
    els['fpSku'].value = 'ANTIGO';
    els['fpBuscar'].click();
    els['fpSku'].value = 'OUTRO';          /* o dono digitou outro SKU enquanto carregava */
    await new Promise((r) => setTimeout(r, 120));

    const tudo = String(els['fpInfo'].innerHTML || '') + ' ' + String(els['fpTab'].innerHTML || '');
    assert.ok(!/11,11/.test(tudo),
      '[FICHA] o campo já diz OUTRO e a tela mostra o custo do ANTIGO — o dono atribuiria esse ' +
      'custo ao produto errado, na tela que existe pra CONFERIR número');
  }

  /* ⚠️ 5) Codex #612: resposta SEM `ok:true` é falha, não "sem custo". Com sessão não-admin ou
     chave vencida a rota devolve 404 `{error:'not found'}` — o fetch RESOLVE e `d.ok` fica
     `undefined`, então a tela dizia "sem histórico" como se faltasse cadastro. */
  {
    const els = montar(resp({ error: 'not found' }));
    els['fpSku'].value = 'PT-06';
    els['fpBuscar'].click();
    await new Promise((r) => setTimeout(r, 50));

    /* ⚠️ o aviso vai pro \, não pro \ — ler só um dos dois me fez achar
       que a mensagem não existia */
    const tudo = String(els['fpInfo'].innerHTML || '') + ' ' + String(els['fpInfo'].textContent || '') +
                 ' ' + String(els['fpTab'].innerHTML || '');
    assert.ok(!/sem histórico|sem custo/.test(tudo),
      '[FICHA] 404 por falta de permissão virou "sem custo" — o dono concluiria que falta ' +
      'cadastro quando o que falta é sessão/chave válida');
    assert.ok(/⚠️|não consegui/.test(tudo),
      '[FICHA] a falha de permissão não é avisada → ' + tudo.slice(0, 110));
  }

  /* ⚠️ 6) Codex #612: faixa aberta que começa no FUTURO não é "hoje" (custo manual agendado) */
  {
    const els = montar(resp({
      ok: true, sku: 'AGENDADO', custo_atual_bling: 50, vigente_hoje: 50,
      faixas: [
        { de: '2026-01-01', ate: '2030-12-31', custo: 50, origem: 'bling' },
        { de: '2030-01-01', ate: null, custo: 77, origem: 'manual' },
      ],
    }));
    els['fpSku'].value = 'AGENDADO';
    els['fpBuscar'].click();
    await new Promise((r) => setTimeout(r, 50));

    const tab = String(els['fpTab'].innerHTML || '');
    assert.ok(/a partir de 2030-01-01/.test(tab),
      '[FICHA] custo agendado pro futuro aparece como vigente "hoje" — o dono leria um custo que ' +
      'ainda não vale → ' + tab.slice(0, 140));
  }

  /* ⚠️ 7) Codex #612: "hoje" é a data de negócio do backend (UTC−3), não o relógio do navegador.
     01:00 UTC de 05/10 ainda é 04/10 em SP — faixa que começa em 05/10 é FUTURO. */
  {
    const realNow = Date.now;
    Date.now = () => Date.parse('2026-10-05T01:00:00Z');
    try {
      const els = montar(resp({
        ok: true, sku: 'FUSO', custo_atual_bling: 50, vigente_hoje: 50,
        faixas: [{ de: '2026-10-05', ate: null, custo: 77, origem: 'manual' }],
      }));
      els['fpSku'].value = 'FUSO';
      els['fpBuscar'].click();
      await new Promise((r) => setTimeout(r, 50));
      const tab = String(els['fpTab'].innerHTML || '');
      assert.ok(/a partir de 2026-10-05/.test(tab),
        '[FICHA] faixa que começa amanhã (data do servidor, UTC−3) aparece como "hoje" → ' + tab.slice(0, 140));
    } finally { Date.now = realNow; }
  }

  /* a fábrica serve, a tela inclui e a guarda libera */
  {
    const fab = fs.readFileSync(path.join(raiz, 'lib', 'checkout', 'fabrica-rotas-painel.js'), 'utf8');
    assert.ok(/'\/js\/ficha-produto\.js'/.test(fab), '[FICHA] a fábrica não serve o script');
    const tela = fs.readFileSync(path.join(raiz, 'good-checkout-offline', 'dashboard.html'), 'utf8');
    assert.ok(/id="fichaProdutoAqui"/.test(tela), '[FICHA] a tela da GOOD não abre o espaço');
    const idx = fs.readFileSync(path.join(raiz, 'good-checkout-offline', 'index.js'), 'utf8');
    assert.ok(idx.indexOf("js/ficha-produto.js' ||") >= 0,
      '[FICHA] o script não está liberado na guarda — quem abre por ?k= tomaria 401');
  }

  console.log('OK: ficha mostra o custo de cada periodo, nao inventa zero e descarta busca antiga');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
