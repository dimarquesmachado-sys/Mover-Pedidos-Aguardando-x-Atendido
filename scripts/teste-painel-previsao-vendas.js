/* 05/10 — PREVISÃO DE VENDAS no painel: os campos vêm do PRODUTOR, não do meu chute.

   A primeira versão desta peça lia `d.itens` e, no segundo ramo, `d.skus`. O produtor
   (`lib/checkout/historico.js:366`) devolve `{ skus: <CONTAGEM>, produtos: [...] }` — `skus` é
   NÚMERO e `itens` não existe. Com os dois ramos errados, a seção dizia "sem vendas na base"
   SEMPRE, mesmo com histórico cheio: um "não tem o que comprar" FALSO, bem na tela que serve pra
   decidir compra.

   Este teste alimenta a peça com a resposta REAL do produtor e exige que as linhas apareçam.

   ⚠️ E cobre os dois cuidados que a seção tem de propósito:
     · tendência exige 60 dias de base (compara 30 com os 30 anteriores). Com base menor, nada de
       seta — seta sobre meio período é informação de compra inventada;
     · lista vazia não vira "não vende": diz que não há histórico no período.

   Marcador estável [PREVISAO]. */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const raiz = path.join(__dirname, '..');
const { scriptDaPrevisao } = require(path.join(raiz, 'lib', 'checkout', 'painel-previsao-vendas'));

/* ⚠️ a forma da resposta é lida do PRODUTOR, não escrita de memória */
{
  const h = fs.readFileSync(path.join(raiz, 'lib', 'checkout', 'historico.js'), 'utf8');
  assert.ok(/skus:\s*lista\.length,\s*produtos:\s*lista/.test(h),
    '[PREVISAO] o produtor mudou a forma da resposta de /previsao-vendas — esta peça lê ' +
    '`produtos` (lista) e `skus` (contagem). Se inverteu, a seção volta a dizer "sem vendas" ' +
    'sempre. Confira `lib/checkout/historico.js` antes de mexer aqui.');
}

const PREFIXOS = ['/good-checkout-offline', '/amb-checkout-offline', '/girassol-backup-offline'];
for (const base of PREFIXOS) {
  const s = scriptDaPrevisao(base);
  assert.doesNotThrow(() => new Function(s), '[PREVISAO] o script de ' + base + ' não compila');
  for (const outra of PREFIXOS) {
    if (outra !== base) assert.ok(!s.includes(outra),
      '[PREVISAO] ' + base + ' carrega o prefixo de ' + outra + ' — projetaria a compra da loja errada');
  }
  assert.ok(!/onclick=/.test(s), '[PREVISAO] ' + base + ': onclick inline');
}

function montar(corpo) {
  const els = {};
  const novo = (id) => ({
    id, innerHTML: '', textContent: '', value: '', disabled: false, _ev: {},
    addEventListener(e, f) { this._ev[e] = f; },
    click() { this._ev.click && this._ev.click(); },
  });
  els['previsaoVendasAqui'] = novo('previsaoVendasAqui');
  global.document = { getElementById: (id) => els[id] || (els[id] = novo(id)) };
  global.window = { location: { search: '?k=teste' } };
  global.URLSearchParams = URLSearchParams;
  global.fetch = async () => ({ json: async () => corpo });
  new Function(scriptDaPrevisao('/good-checkout-offline'))();
  return els;
}

const RESPOSTA = (extra) => Object.assign({
  ok: true, base_dias: 90, de: '2026-07-01', ate: '2026-09-30', linhas: 1200, skus: 2,
  produtos: [
    { sku: 'PT-06', desc: 'Pote Teste Seis', un: 726, tendencia: 68, p7: 40, p30: 170, p90: 500 },
    { sku: 'KP16', un: 120, tendencia: -30, p7: 6, p30: 28, p90: 80 },
  ],
}, extra || {});

module.exports = (async () => {
  /* 1) ⚠️ COM a resposta real: as linhas TÊM que aparecer */
  {
    const els = montar(RESPOSTA());
    await new Promise((r) => setTimeout(r, 60));
    const tab = String(els['pvTab'].innerHTML || '');

    assert.ok(/<table/.test(tab), '[PREVISAO] não desenhou a tabela com a resposta REAL do produtor');
    assert.ok(!/sem vendas/.test(tab),
      '[PREVISAO] com 2 produtos na resposta a seção disse "sem vendas" — é o bug do #626: ler ' +
      '`itens`/`skus` em vez de `produtos` faz a tela dizer "não tem o que comprar" com histórico cheio');
    assert.ok(/PT-06/.test(tab) && /726/.test(tab),
      '[PREVISAO] faltam o SKU ou as unidades vendidas → ' + tab.slice(0, 140));
    assert.ok(/Pote Teste Seis/.test(tab),
      '[PREVISAO] falta a descrição (`desc`) do produto — SKU opaco não se identifica pra comprar');
    assert.ok(/170/.test(tab),
      '[PREVISAO] falta a projeção de 1 mês — é a coluna que o dono usa pra decidir compra');
  }

  /* 1b) ⚠️ mais de 50 produtos: TODOS aparecem (sem busca/paginação, cortar esconderia o resto) */
  {
    const muitos = Array.from({ length: 120 }, (_, i) => ({ sku: 'SKU' + i, un: 10, p7: 1, p30: 4, p90: 12 }));
    const els = montar(RESPOSTA({ produtos: muitos, skus: 120 }));
    await new Promise((r) => setTimeout(r, 60));
    const tab = String(els['pvTab'].innerHTML || '');
    assert.ok(/SKU119</.test(tab),
      '[PREVISAO] o 120º produto sumiu — a seção corta a lista sem dar caminho pra ver o resto');
  }

  /* 2) ⚠️ base curta: NÃO desenha tendência */
  {
    const els = montar(RESPOSTA({ base_dias: 30 }));
    await new Promise((r) => setTimeout(r, 60));
    const sel = els['pvBase'];
    sel.value = '30';
    sel._ev.change && sel._ev.change();
    await new Promise((r) => setTimeout(r, 60));
    const tab = String(els['pvTab'].innerHTML || '');
    assert.ok(!/68%/.test(tab),
      '[PREVISAO] com base de 30 dias a seção mostrou tendência — ela compara 30 dias com os 30 ' +
      'ANTERIORES, que não existem nessa base. Seta sobre meio período é informação de compra inventada.');
  }

  /* 3) lista vazia não vira "não vende" */
  {
    const els = montar(RESPOSTA({ produtos: [], skus: 0, linhas: 0 }));
    await new Promise((r) => setTimeout(r, 60));
    const tab = String(els['pvTab'].innerHTML || '');
    assert.ok(/não há histórico/.test(tab),
      '[PREVISAO] sem produtos no período a seção não explica que falta HISTÓRICO — lida como ' +
      '"estes produtos não vendem", vira decisão de não comprar baseada em ausência de dado');
  }

  /* 4) resposta sem ok:true é falha, não "nada a prever" */
  {
    const els = montar({ error: 'not found' });
    await new Promise((r) => setTimeout(r, 60));
    const tudo = String(els['pvInfo'].innerHTML || '') + String(els['pvTab'].innerHTML || '');
    assert.ok(!/sem vendas|não há histórico/.test(tudo),
      '[PREVISAO] 404 por chave vencida virou "sem vendas" — o dono concluiria que não vende nada');
  }

  console.log('OK: previsao le `produtos` do produtor, nao inventa tendencia e nao confunde falha com ausencia');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
