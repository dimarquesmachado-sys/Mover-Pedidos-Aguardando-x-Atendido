/* 04/10 — HISTÓRICO DE PEDIDOS no painel, peça compartilhada.

   Lista os pedidos do período com canal, valor, custo e margem. É a seção que responde "quais
   pedidos formaram esse número" — sem ela, o painel da GOOD mostrava totais sem como abrir.

   ⚠️ OS TRÊS CUIDADOS QUE ESTE TESTE TRAVA, e todos vêm de erro já cometido aqui:

   1. A PÁGINA QUE FALHOU não pode fazer o botão repetir a anterior. Se eu atualizasse a página
      vigente ANTES de a resposta chegar, falhar na 2 e clicar "próxima" traria a 2 de novo —
      ou pior, a 1 disfarçada de 3;
   2. `catch` VAZIO deixa a tela em "carregando" pra sempre (apontado no PR #131 da AMB);
   3. custo ausente NÃO vira "R$ 0,00" nem margem calculada — zero mente sobre a margem, e esta
      é a tela onde se confere pedido a pedido.

   Marcador estável [HIST-PED]. */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const raiz = path.join(__dirname, '..');
const { scriptDoHistorico } = require(path.join(raiz, 'lib', 'checkout', 'painel-historico-pedidos'));

const PREFIXOS = ['/good-checkout-offline', '/amb-checkout-offline', '/girassol-backup-offline'];
for (const base of PREFIXOS) {
  const s = scriptDoHistorico(base);
  assert.doesNotThrow(() => new Function(s), '[HIST-PED] o script de ' + base + ' não compila');
  assert.ok(s.includes(base), '[HIST-PED] ' + base + ': sem o prefixo da empresa');
  for (const outra of PREFIXOS) {
    if (outra !== base) assert.ok(!s.includes(outra),
      '[HIST-PED] ' + base + ' carrega o prefixo de ' + outra + ' — listaria os pedidos da loja errada');
  }
  assert.ok(!/onclick=/.test(s), '[HIST-PED] ' + base + ': onclick inline');
}

function montar(responder) {
  const els = {};
  const novo = (id) => ({
    id, innerHTML: '', textContent: '', value: '', disabled: false, _ev: {},
    addEventListener(e, f) { this._ev[e] = f; },
    click() { this._ev.click && this._ev.click(); },
  });
  els['historicoPedidosAqui'] = novo('historicoPedidosAqui');
  global.document = { getElementById: (id) => els[id] || (els[id] = novo(id)) };
  global.window = { location: { search: '?k=teste' } };
  global.URLSearchParams = URLSearchParams;
  global.fetch = responder;
  new Function(scriptDoHistorico('/good-checkout-offline'))();
  return els;
}

const pedido = (n, extra) => Object.assign({
  numero: 'P-' + n, data: '2026-09-15', canal: 'Mercado Livre', valor: 100, custo: 60, margem: 40,
}, extra || {});

module.exports = (async () => {
  /* 1) lista os pedidos com os números */
  {
    const els = montar(async () => ({ json: async () => ({ ok: true, total: 2, pedidos: [pedido(1), pedido(2)] }) }));
    els['hpCarregar'].click();
    await new Promise((r) => setTimeout(r, 50));

    const tab = String(els['hpTab'].innerHTML || '');
    assert.ok(/<table/.test(tab), '[HIST-PED] não desenhou a tabela');
    assert.ok(/P-1/.test(tab) && /P-2/.test(tab), '[HIST-PED] faltam os pedidos na tabela');
    assert.ok(/Mercado Livre/.test(tab), '[HIST-PED] falta o canal — é por ele que se separa a origem');
    assert.ok(/100,00/.test(tab), '[HIST-PED] falta o valor do pedido');
  }

  /* 2) ⚠️ custo ausente: nem R$ 0,00 nem margem inventada */
  {
    const els = montar(async () => ({ json: async () => ({ ok: true, total: 1,
      pedidos: [pedido(9, { custo: null, margem: 100 })] }) }));
    els['hpCarregar'].click();
    await new Promise((r) => setTimeout(r, 50));

    const tab = String(els['hpTab'].innerHTML || '');
    assert.ok(!/R\$\s*0,00/.test(tab),
      '[HIST-PED] pedido sem custo aparece com "R$ 0,00" — diria que o produto não custou nada');
    /* ⚠️ minha asserção anterior procurava "100,0%" com VÍRGULA, mas `toFixed` gera PONTO —
       ela NUNCA podia falhar. Agora cobro o que importa: na linha sem custo não pode haver
       percentual nenhum. */
    /* ⚠️ e nem "sem % nenhum": o `%` aparece no ESTILO (`width:100%`). Miro no percentual de
       verdade — dígito seguido de %, que é como a margem sai (`40.0%`). */
    assert.ok(!/\d+[.,]\d+%/.test(tab),
      '[HIST-PED] sem custo a margem foi exibida mesmo assim — é um número INVENTADO, e esta é ' +
      'a tela onde se confere pedido a pedido → ' + tab.slice(0, 170));
  }

  /* 3) ⚠️ PÁGINA QUE FALHOU não pode avançar a paginação */
  {
    let chamada = 0;
    const paginasPedidas = [];
    const els = montar(async (url) => {
      chamada++;
      paginasPedidas.push((url.match(/pagina=(\d+)/) || [])[1]);
      if (chamada === 1) return { json: async () => ({ ok: true, total: 400, pedidos: Array.from({ length: 200 }, (_, i) => pedido(i)) }) };
      return { json: async () => ({ ok: false, erro: 'banco fora' }) };   /* a página 2 falha */
    });

    els['hpCarregar'].click();
    await new Promise((r) => setTimeout(r, 40));
    els['hpProxima'].click();                      /* tenta a 2 → falha */
    await new Promise((r) => setTimeout(r, 40));
    els['hpProxima'].click();                      /* clica de novo */
    await new Promise((r) => setTimeout(r, 40));

    assert.ok(/⚠️|banco fora/.test(String(els['hpInfo'].textContent || '')),
      '[HIST-PED] a falha da página não foi avisada');
    assert.strictEqual(paginasPedidas[2], '2',
      '[HIST-PED] depois de a página 2 FALHAR, o botão "próxima" pediu a página ' +
      paginasPedidas[2] + ' — a paginação avançou sobre uma página que nunca carregou, e o dono ' +
      'leria uma lista com buraco achando que viu tudo');
  }

  /* ⚠️ 3b) E O CASO QUE DE FATO DISTINGUE: página que DÁ CERTO precisa AVANÇAR a paginação.
     Meu caso anterior (página que falha) dava o mesmo resultado com e sem o conserto — não
     provava nada. Sem atualizar a página vigente no sucesso, "próxima" pede SEMPRE a 2 e o dono
     fica preso, lendo a mesma página achando que está avançando. */
  {
    const pedidas = [];
    const els = montar(async (url) => {
      pedidas.push((url.match(/pagina=(\d+)/) || [])[1]);
      return { json: async () => ({ ok: true, total: 600,
        pedidos: Array.from({ length: 200 }, (_, i) => pedido(i)) }) };
    });
    els['hpCarregar'].click();
    await new Promise((r) => setTimeout(r, 40));
    els['hpProxima'].click();
    await new Promise((r) => setTimeout(r, 40));
    els['hpProxima'].click();
    await new Promise((r) => setTimeout(r, 40));

    assert.deepStrictEqual(pedidas, ['1', '2', '3'],
      '[HIST-PED] a paginação não avança: pedi 1 → próxima → próxima e as páginas chamadas foram ' +
      JSON.stringify(pedidas) + '. O dono clicaria "próxima" lendo SEMPRE a mesma página, achando ' +
      'que está percorrendo o período.');
  }

  /* 4) ⚠️ rota fora do ar: avisa e não fica em "carregando" */
  {
    const els = montar(async () => { throw new Error('rede fora'); });
    els['hpCarregar'].click();
    await new Promise((r) => setTimeout(r, 50));
    const info = String(els['hpInfo'].textContent || '');
    assert.ok(!/carregando/.test(info),
      '[HIST-PED] ficou preso em "carregando…" — foi o defeito apontado no PR #131 da AMB');
    assert.ok(/rede fora|⚠️/.test(info), '[HIST-PED] a falha de rede não aparece → ' + info.slice(0, 90));
  }

  /* 5) ⚠️ resposta SEM ok:true é falha, não período vazio */
  {
    const els = montar(async () => ({ json: async () => ({ error: 'not found' }) }));
    els['hpCarregar'].click();
    await new Promise((r) => setTimeout(r, 50));
    const tudo = String(els['hpInfo'].textContent || '') + ' ' + String(els['hpTab'].innerHTML || '');
    assert.ok(!/nenhum pedido neste período/.test(tudo),
      '[HIST-PED] 404 por sessão/chave vencida virou "nenhum pedido no período" — o dono ' +
      'concluiria que não vendeu nada');
  }

  /* a fábrica serve, a tela inclui e a guarda libera */
  {
    const fab = fs.readFileSync(path.join(raiz, 'lib', 'checkout', 'fabrica-rotas-painel.js'), 'utf8');
    assert.ok(/'\/js\/historico-pedidos\.js'/.test(fab), '[HIST-PED] a fábrica não serve o script');
    const tela = fs.readFileSync(path.join(raiz, 'good-checkout-offline', 'dashboard.html'), 'utf8');
    assert.ok(/id="historicoPedidosAqui"/.test(tela), '[HIST-PED] a tela da GOOD não abre o espaço');
    assert.ok(/js\/historico-pedidos\.js/.test(tela), '[HIST-PED] a tela não inclui o script');
    const idx = fs.readFileSync(path.join(raiz, 'good-checkout-offline', 'index.js'), 'utf8');
    assert.ok(idx.indexOf("js/historico-pedidos.js' ||") >= 0,
      '[HIST-PED] o script não está liberado na guarda — quem abre por ?k= tomaria 401');
  }

  console.log('OK: historico lista, pagina sem pular pagina que falhou e nao inventa custo nem margem');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
