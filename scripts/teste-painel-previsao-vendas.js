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

/* a planilha agora é um Blob .xls (SpreadsheetML): capturo o Blob que a peça entrega ao navegador */
let ultimoBlob = null;
URL.createObjectURL = (b) => { ultimoBlob = b; return 'blob:teste'; };
URL.revokeObjectURL = () => {};

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

  /* 1c) ⚠️ Codex #636 (P2): média por dia e "30d vs 30d anteriores" que a tela da AMB mostrava */
  {
    const els = montar(RESPOSTA({ produtos: [
      { sku: 'PT-06', un: 726, media_dia: 4.5, un30: 100, un_30_60: 60, tendencia: 68, p7: 40, p30: 170, p90: 500 } ] }));
    await new Promise((r) => setTimeout(r, 60));
    const tab = String(els['pvTab'].innerHTML || '');
    assert.ok(/4,5\/dia/.test(tab), '[PREVISAO] sumiu a média por dia sob as unidades vendidas');
    assert.ok(/100 vs 60/.test(tab), '[PREVISAO] sumiu o "30d vs 30d anteriores" sob a tendência');
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

  /* ⚠️ 05/10 — A PEÇA É O ESPELHO DA VERSÃO MAIS RICA, não o menor denominador comum.
     Regra do dono: "se ver que tem mais funções, tem mais recursos, ela que tem que ser espelho
     pras outras". A tela embutida da AMB tinha três coisas que a peça não tinha — busca por SKU,
     download de planilha e base padrão de 180 dias. Agora a peça tem as três, e GOOD e Girassol
     GANHAM o que só a AMB tinha.

     Sem estes casos, a próxima mexida na peça pode derrubar qualquer uma delas em silêncio — e aí
     migrar a AMB viraria perda de recurso num PR chamado "unificar". */
  {
    const RESP = {
      ok: true, base_dias: 180, de: '2026-01-01', ate: '2026-09-30', linhas: 10, skus: 2,
      produtos: [
        { sku: 'PT-06', desc: 'Parafuso', un: 726, media_dia: 4, un30: 100, un_30_60: 60,
          tendencia: 68, p7: 40, p30: 170, p90: 500, p180: 1000, p365: 2000 },
        { sku: 'KP16', desc: 'Kit Porca', un: 120, media_dia: 1, un30: 10, un_30_60: 14,
          tendencia: -30, p7: 6, p30: 28, p90: 80, p180: 150, p365: 300 },
      ],
    };

    let baixado = null;
    const els = {};
    const novoEl = (id) => ({
      id, innerHTML: '', textContent: '', value: '', disabled: false, _ev: {},
      addEventListener(e, f) { this._ev[e] = f; },
      click() { this._ev.click && this._ev.click(); },
    });
    els['previsaoVendasAqui'] = novoEl('previsaoVendasAqui');
    global.document = {
      getElementById: (id) => els[id] || (els[id] = novoEl(id)),
      createElement: () => ({ set href(v) { baixado = v; }, set download(v) {}, click() {} }),
    };
    global.window = { location: { search: '' } };
    global.URLSearchParams = URLSearchParams;
    global.fetch = async () => ({ json: async () => RESP });
    new Function(scriptDaPrevisao('/good-checkout-offline'))();
    await new Promise((r) => setTimeout(r, 60));

    /* ⚠️ as 8 colunas (p180/p365 inclusive): sem elas, migrar a AMB tiraria previsão de longo prazo */
    const tab = String(els['pvTab'].innerHTML || '');
    assert.ok(/6 meses/.test(tab) && /1 ano/.test(tab),
      '[PREVISAO] a tabela perdeu as colunas de 6 meses e 1 ano — a AMB tem as duas, e migrar ' +
      'sem elas tiraria informação de compra de longo prazo');
    assert.ok(/1\.000/.test(tab) && /2\.000/.test(tab),
      '[PREVISAO] as colunas de 6 meses e 1 ano existem mas não trazem valor');

    /* ⚠️ base padrão 180, como na AMB: 90 dias não cobre sazonalidade, e quem abre a tela e não
       mexe no seletor decide compra com a base que veio por padrão. */
    /* ⚠️ o DOM falso não resolve `selected` sozinho — leio a opção marcada no markup do seletor,
       que é o que o navegador usaria. */
    const marcada = (String(els['pvBase'].innerHTML || '').match(/value="(\d+)"\s+selected/) || [])[1];
    assert.strictEqual(marcada, '180',
      '[PREVISAO] a base padrão marcada é ' + marcada + ' e a da AMB é 180 — quem abre a tela e ' +
      'não mexe no seletor decide compra com base mais curta do que a loja usava');

    /* busca por SKU, que a AMB tem */
    els['pvBusca'].value = 'KP';
    els['pvBusca']._ev.input();
    const filtrada = String(els['pvTab'].innerHTML || '');
    assert.ok(/KP16/.test(filtrada) && !/PT-06/.test(filtrada),
      '[PREVISAO] a busca por SKU não filtra a lista — a AMB filtra, e é como se acha um produto ' +
      'numa lista de 400');

    /* ⚠️ e filtrar NÃO pode rebuscar o servidor: seria uma chamada por tecla digitada */
    let chamadas = 0;
    global.fetch = async () => { chamadas++; return { json: async () => RESP }; };
    els['pvBusca'].value = 'PT';
    els['pvBusca']._ev.input();
    assert.strictEqual(chamadas, 0,
      '[PREVISAO] digitar no filtro chamou o servidor — a lista já está na memória, e isso vira ' +
      'uma consulta por TECLA digitada');

    /* planilha: 12 colunas, mesma ordem e mesmos nomes da AMB */
    els['pvBusca'].value = '';
    els['pvBusca']._ev.input();
    els['pvPlanilha'].click();
    assert.ok(baixado, '[PREVISAO] o botão de planilha não gerou arquivo');
    const xml = await ultimoBlob.text();
    const nLinhas = (xml.match(/<Row/g) || []).length;
    const cols = [...xml.match(/<Row ss:StyleID="cab">(.*?)<\/Row>/)[1].matchAll(/<Data[^>]*>(.*?)<\/Data>/g)].map((m) => m[1]);
    assert.ok(/<Data ss:Type="Number">726<\/Data>/.test(xml),
      '[PREVISAO] a planilha não leva número como NÚMERO — o Excel teria de converter texto antes de somar/ordenar');
    assert.ok(/Workbook/.test(xml) && /FreezePanes/.test(xml),
      '[PREVISAO] a planilha não é o .xls (SpreadsheetML) com cabeçalho congelado que a AMB baixava');
    assert.strictEqual(cols.length, 12,
      '[PREVISAO] a planilha tem ' + cols.length + ' colunas; a da AMB tem 12 — quem guarda os ' +
      'arquivos antigos confere um contra o outro');
    assert.strictEqual(cols[0], 'SKU', '[PREVISAO] a 1ª coluna mudou de nome/ordem');
    assert.strictEqual(cols[11], 'Previsao 1 ano', '[PREVISAO] a 12ª coluna mudou de nome/ordem');
    assert.strictEqual(nLinhas, 3, '[PREVISAO] a planilha não trouxe as 2 linhas de dados');

    /* ⚠️ e respeita o filtro: baixar "tudo" quando a tela mostra 1 produto confundiria */
    els['pvBusca'].value = 'KP';
    els['pvBusca']._ev.input();
    els['pvPlanilha'].click();
    const xml2 = await ultimoBlob.text();
    assert.strictEqual((xml2.match(/<Row/g) || []).length, 2,
      '[PREVISAO] a planilha ignorou o filtro da tela — o dono veria 1 produto e baixaria 400');
  }

  /* ⚠️ Codex #634: busca sem acento e por termo; filtro sem match != histórico vazio;
     base nova não reaproveita resposta velha; CSV com aspas e sem fórmula. */
  {
    const RESP = { ok: true, base_dias: 180, de: '2026-01-01', ate: '2026-09-30', linhas: 3, skus: 2,
      produtos: [
        { sku: 'KP9', desc: 'Porção; "dupla"', un: 5, p7: 1, p30: 2, p90: 3, p180: 4, p365: 5 },
        { sku: '=CMD', desc: 'linha1\nlinha2', un: 5, tendencia: -30, p7: 1, p30: 2, p90: 3, p180: 4, p365: 5 },
      ] };
    let baixado = null;
    const els = {};
    const novoEl = (id) => ({ id, innerHTML: '', textContent: '', value: '', disabled: false, _ev: {},
      addEventListener(e, f) { this._ev[e] = f; }, click() { this._ev.click && this._ev.click(); } });
    els['previsaoVendasAqui'] = novoEl('previsaoVendasAqui');
    global.document = { getElementById: (id) => els[id] || (els[id] = novoEl(id)),
      createElement: () => ({ set href(v) { baixado = v; }, set download(v) {}, click() {} }) };
    global.window = { location: { search: '' } };
    global.URLSearchParams = URLSearchParams;
    global.fetch = async () => ({ json: async () => RESP });
    new Function(scriptDaPrevisao('/good-checkout-offline'))();
    await new Promise((r) => setTimeout(r, 60));

    els['pvBusca'].value = 'porcao kp';
    els['pvBusca']._ev.input();
    assert.ok(/KP9/.test(els['pvTab'].innerHTML), '[PREVISAO] busca sem acento/por termo não achou "Porção" + SKU');

    els['pvBusca'].value = 'zzz';
    els['pvBusca']._ev.input();
    assert.ok(/nenhum produto bate/.test(els['pvTab'].innerHTML) && !/não há histórico/.test(els['pvTab'].innerHTML),
      '[PREVISAO] filtro sem resultado foi descrito como histórico vazio');

    els['pvBusca'].value = '';
    els['pvBusca']._ev.input();
    els['pvPlanilha'].click();
    const xml = await ultimoBlob.text();
    assert.ok(xml.includes('Porção; &quot;dupla&quot;'), '[PREVISAO] planilha não escapou aspas/ponto-e-vírgula do campo');
    assert.ok(xml.includes('<Data ss:Type="String">=CMD</Data>'), '[PREVISAO] "=CMD" não foi gravado como TEXTO — viraria fórmula');
    assert.ok(xml.includes('linha1\nlinha2'), '[PREVISAO] planilha não preservou a quebra de linha');

    /* base nova pendente: resposta velha não pode ser exportada */
    global.fetch = () => new Promise(() => {});
    baixado = null;
    els['pvBase'].value = '30';
    els['pvBase']._ev.change();
    els['pvPlanilha'].click();
    assert.strictEqual(baixado, null, '[PREVISAO] exportou a resposta da base anterior com a nova pendente');
  }

  /* ⚠️ as duas ÚLTIMAS funções da tela embutida da AMB: período livre e recalcular.
     Sem elas, migrar a AMB pra peça tiraria do dono olhar 45 ou 120 dias (o seletor fixo só tem
     5 opções) e refazer o cálculo na hora (a rota guarda o resultado por 30 min). */
  {
    const urls = [];
    const els = {};
    const novoEl = (id) => ({
      id, innerHTML: '', textContent: '', value: '', disabled: false, _ev: {},
      addEventListener(e, f) { this._ev[e] = f; },
      click() { this._ev.click && this._ev.click(); },
    });
    els['previsaoVendasAqui'] = novoEl('previsaoVendasAqui');
    global.document = {
      getElementById: (id) => els[id] || (els[id] = novoEl(id)),
      createElement: () => ({ set href(v) {}, set download(v) {}, click() {} }),
    };
    global.window = { location: { search: '' } };
    global.URLSearchParams = URLSearchParams;
    global.fetch = async (u) => {
      urls.push(u);
      return { json: async () => ({ ok: true, produtos: [{ sku: 'A', un: 1, p7: 1, p30: 1, p90: 1, p180: 1, p365: 1 }] }) };
    };
    new Function(scriptDaPrevisao('/good-checkout-offline'))();
    await new Promise((r) => setTimeout(r, 60));

    /* período livre entre 30 e 730 */
    els['pvDias'].value = '45';
    els['pvDias']._ev.change.call(els['pvDias']);
    await new Promise((r) => setTimeout(r, 50));
    assert.ok(urls.some((u) => /base=45/.test(u)),
      '[PREVISAO] o período livre não funciona — a AMB deixa olhar qualquer janela entre 30 e 730 ' +
      'dias, e o seletor fixo só tem 5 opções → ' + JSON.stringify(urls).slice(0, 130));

    /* ⚠️ e recusa período fora da faixa, em vez de pedir ao servidor um número sem sentido */
    els['pvDias'].value = '5';
    const antes = urls.length;
    els['pvDias']._ev.change.call(els['pvDias']);
    await new Promise((r) => setTimeout(r, 40));
    assert.strictEqual(urls.length, antes,
      '[PREVISAO] 5 dias foi aceito e consultou o servidor — fora da faixa 30-730 a projeção não ' +
      'tem base, e o número sairia tão confiável quanto os outros na tela');

    /* ⚠️ Codex #635 (P1): 15–29 o servidor trava em 30 — pedir 20 mostraria 20 e calcularia 30 */
    els['pvDias'].value = '20';
    const antes20 = urls.length;
    els['pvDias']._ev.change.call(els['pvDias']);
    await new Promise((r) => setTimeout(r, 40));
    assert.strictEqual(urls.length, antes20,
      '[PREVISAO] 20 dias foi aceito, mas a rota trava a base em 30 — a tela mostraria 20 e calcularia 30');

    /* ⚠️ Codex #635 (P2): select e campo de dias mostram a MESMA base ativa */
    els['pvDias'].value = '45';
    els['pvDias']._ev.change.call(els['pvDias']);
    await new Promise((r) => setTimeout(r, 40));
    assert.ok(/value="45"\s+selected/.test(String(els['pvBase'].innerHTML)),
      '[PREVISAO] com período livre de 45 o seletor continua mostrando outra base');
    els['pvBase'].value = '90';
    els['pvBase']._ev.change();
    await new Promise((r) => setTimeout(r, 40));
    assert.strictEqual(els['pvDias'].value, '',
      '[PREVISAO] escolhi 90 no seletor e o campo de dias continua mostrando o período livre antigo');

    /* recalcular força o recálculo (a rota guarda por 30 min) */
    els['pvRecalcular'].click();
    await new Promise((r) => setTimeout(r, 50));
    assert.ok(urls.some((u) => /fresh=1/.test(u)),
      '[PREVISAO] o botão "recalcular" não força — a rota guarda o resultado por 30 min, então ' +
      'ele devolveria o MESMO número e pareceria que nada mudou');
  }

  /* ⚠️ Codex #635 (P2): recalcular não dispara 2º fresh=1 enquanto o 1º está em voo */
  {
    const urls = [];
    const els = {};
    const novoEl = (id) => ({ id, innerHTML: '', textContent: '', value: '', disabled: false, _ev: {},
      addEventListener(e, f) { this._ev[e] = f; }, click() { this._ev.click && this._ev.click(); } });
    els['previsaoVendasAqui'] = novoEl('previsaoVendasAqui');
    global.document = { getElementById: (id) => els[id] || (els[id] = novoEl(id)),
      createElement: () => ({ set href(v) {}, set download(v) {}, click() {} }) };
    global.window = { location: { search: '' } };
    global.URLSearchParams = URLSearchParams;
    global.fetch = async () => ({ json: async () => ({ ok: true, produtos: [] }) });
    new Function(scriptDaPrevisao('/good-checkout-offline'))();
    await new Promise((r) => setTimeout(r, 40));
    global.fetch = (u) => { urls.push(u); return new Promise(() => {}); };
    els['pvRecalcular'].click();
    els['pvRecalcular'].click();
    els['pvRecalcular'].click();
    assert.strictEqual(urls.length, 1,
      '[PREVISAO] cliques repetidos em "recalcular" dispararam ' + urls.length + ' consultas fresh=1 — cada uma repagina o histórico inteiro');
    assert.strictEqual(els['pvRecalcular'].disabled, true, '[PREVISAO] o botão recalcular não ficou desabilitado durante o cálculo');

    /* ⚠️ Codex #635 (P2): o campo de dias também trava em voo, e aplica no 'change' (não só Enter) */
    assert.strictEqual(els['pvDias'].disabled, true, '[PREVISAO] o campo de dias ficou habilitado durante o cálculo');
    els['pvDias'].value = '45';
    els['pvDias']._ev.change.call(els['pvDias']);
    els['pvDias']._ev.change.call(els['pvDias']);
    assert.strictEqual(urls.length, 1, '[PREVISAO] o campo de dias disparou consulta com outra em voo');
  }

  /* ⚠️ ── PARIDADE COM A AMB, CONFERIDA ITEM A ITEM (05/10) ───────────────────────────
     Antes de a AMB trocar a tela embutida por esta peça, listei o que a embutida FAZ e conferi
     um a um. Oito recursos; a peça tem os oito:

       colunas 6 meses/1 ano · busca por SKU · download de planilha · base padrão 180 ·
       período livre · recalcular agora · descrição do produto · seletor de base

     ⚠️ O NONO ERA FALSO: os "chips de atalho" (`#prevChips`) oferecem EXATAMENTE as mesmas 5
     opções do seletor — mesma função em dois formatos — e a própria folha de estilo da AMB os
     ESCONDE no celular (`#prevChips{display:none!important}`). Não é recurso que a peça deva
     copiar; é duplicata de interface que a AMB carrega.

     Este bloco amarra os seis que podem sumir numa mexida distraída. Sem ele, a migração da AMB
     viraria perda de recurso num PR chamado "unificar". */
  {
    const script = scriptDaPrevisao('/amb-checkout-offline', { basePadrao: 180 });
    const exigidos = [
      ['colunas de 6 meses e 1 ano', /6 meses/],
      ['coluna de 1 ano', /1 ano/],
      /* ⚠️ a asserção é sobre a FUNÇÃO existir, não sobre o nome do elemento: renomear `pvBusca`
         pra `pvFiltro` mantém a busca funcionando, e um teste que cobra o nome acusaria uma
         troca inofensiva e deixaria passar a remoção de verdade. Cobro o que o usuário faz —
         um campo de filtro e um botão que gera arquivo. */
      ['campo de filtro', /<input[^>]*placeholder=[^>]*filtrar/i],
      ['botão de planilha', /<button[^>]*>[^<]*planilha/i],
      /* ⚠️ a planilha é `.xls` (SpreadsheetML), não CSV: a tela embutida da AMB gera assim, e CSV
         muda separador decimal e formatação no Excel de quem guarda os arquivos antigos. */
      ['geração do arquivo .xls', /ms-excel/],
      /* ⚠️ e a base padrão deixou de ser FIXA na peça: vem de quem chama (a AMB pede 180, a GOOD
         90). Cobrar `baseDias = 180` no código voltaria a exigir o valor global que mudou a base
         da GOOD em silêncio — o que se cobra é o SCRIPT GERADO PRA AMB trazer 180. */
      ['base padrão 180 na AMB', /var BASE_PADRAO = 180;/],
      ['descrição do produto na planilha', /x\.desc/],
    ];
    const ausentes = exigidos.filter(([, re_]) => !re_.test(script)).map(([nome]) => nome);
    assert.deepStrictEqual(ausentes, [],
      '[PREVISAO] a peça perdeu recurso(s) que a tela embutida da AMB tem: ' + ausentes.join(', ') +
      '. Migrar a AMB assim seria ENTREGAR MENOS — regressão com nome de unificação, num PR onde ' +
      'ninguém procura regressão. Nivelar é por cima: a versão mais rica é o espelho.');
  }

  /* ⚠️ ── A BASE PADRÃO É POR EMPRESA (05/10) ──────────────────────────────────────────
     Nivelar por cima vale pra RECURSO, não pra apagar escolha que a loja já tinha. Quando a peça
     ganhou `baseDias = 180` fixo (porque a AMB usa 180), a GOOD — que nasceu com 90 — passou a
     180 EM SILÊNCIO. Previsão de compra que muda sozinha é o pior tipo de alteração: a tela
     continua funcionando, e o número que decide compra mudou sem ninguém pedir. */
  {
    /* ⚠️ Codex #639 (P2): a versão anterior NÃO exercitava a fábrica. O módulo exporta
       `criarRotasPainel`, então `monta` virava o objeto do módulo, o ramo `typeof === function`
       era pulado e o teste caía no atalho que chamava a peça com o valor JÁ ESPERADO — ou seja,
       provava que 180 é 180. Agora monta a fábrica de verdade e pede o script pela ROTA.

       ⚠️ E usa `prefixo` DIFERENTE do nome da empresa de propósito: é assim que se prova que a
       base vem de `EMPRESA`, não do caminho. Com a derivação pelo prefixo, este caso dava 180
       para a GOOD — o bug que o PR conserta, voltando por outra porta. */
    const { criarRotasPainel } = require(path.join(raiz, 'lib', 'checkout', 'fabrica-rotas-painel'));
    /* as mesmas peças mínimas que o `teste-fabrica-rotas-painel` usa — a fábrica valida campo a
       campo, então um Proxy não serve (tentei, e ela recusa dizendo qual falta) */
    const pecasFalsas = () => ({ json: () => {}, lerChaveAdmin: () => '', validarSessao: () => true,
      readJson: () => ({}), writeJson: () => {}, CACHE_DIR: '/tmp', fsx: require('fs'), pathx: require('path'),
      ehAdmin: () => true, readBody: async () => ({}), estadoRotinas: { custo: {}, vendas: {} },
      travaPesada: { quemEsta: () => null }, custoSyncTravado: async () => {}, _urlStatus: () => '',
      _inferCanal: () => 'outro', _diaFechadoDoDisco: () => null, _cstDiario: {}, LOJA_MKT: {},
      CONFERIDOS_FILE: '/tmp/_conferidos.json' });

    const casos = [
      ['good', '/g', 90,  'a GOOD nasceu com 90'],
      ['amb',  '/a', 180, 'a AMB usa 180 (sazonalidade de compra)'],
      ['girassol', '/gi', 180, 'a Girassol acompanha a AMB'],
    ];
    /* a base entra por INJEÇÃO: lê o que o arquivo de CADA empresa realmente passa à fábrica —
       é ele que protege a GOOD; se alguém tirar o `basePrevisao`, ela cai em 180 calada */
    const doArquivo = { good: 'good-checkout-offline/index.js', amb: 'amb-checkout-offline/index.js',
                        girassol: 'girassol-backup-offline/gbo-app.js' };
    const baseDoArquivo = (empresa) => {
      const src = fs.readFileSync(path.join(raiz, doArquivo[empresa]), 'utf8');
      const m = src.match(new RegExp("empresa: '" + empresa + "',[^\\n]*\\n\\s*basePrevisao:\\s*(\\d+)"));
      return m ? Number(m[1]) : undefined;
    };
    for (const [empresa, prefixo, esperado, porque] of casos) {
      const base = baseDoArquivo(empresa);
      let handler;
      try {
        handler = criarRotasPainel({ empresa, nomeEmpresa: empresa, prefixo, basePrevisao: base,
                                     pecas: pecasFalsas(), rotasProprias: [] });
      } catch (e) {
        assert.fail('[PREVISAO] não consegui montar a fábrica para ' + empresa + ': ' +
          String(e.message).slice(0, 110) + ' — se o contrato mudou, este teste precisa acompanhar');
      }
      const res = { _s: 0, _b: '', writeHead(s) { this._s = s; }, setHeader() {}, end(b) { this._b = String(b || ''); } };
      const u = new URL('http://x' + prefixo + '/js/previsao-vendas.js');
      /* ⚠️ a assinatura da fábrica é (req, res, p, method, urlObj) — chamei com 3 argumentos na
         primeira tentativa e NADA era servido, o que parecia rota ausente. Ler a assinatura
         antes de chamar, que é a mesma regra de ler o produtor antes do consumidor. */
      const tratou = await handler({ method: 'GET', url: u.pathname, headers: {} }, res,
                                   u.pathname, 'GET', u);
      assert.strictEqual(tratou, true,
        '[PREVISAO] a fábrica de ' + empresa + ' não serve o script da previsão em ' + prefixo);

      const achado = (res._b.match(/var BASE_PADRAO = (\d+)/) || [])[1];
      assert.strictEqual(Number(achado), esperado,
        '[PREVISAO] base ' + achado + ' servida para ' + empresa + ' (prefixo ' + prefixo +
        '), esperado ' + esperado + ' — ' + porque + '. Note que o prefixo NÃO contém o nome da ' +
        'empresa: se a base for derivada do caminho, a loja cai no padrão de outra em silêncio.');
    }

    /* e a fábrica não pode voltar a chumbar empresa (Codex #639) */
    const fab = fs.readFileSync(path.join(raiz, 'lib', 'checkout', 'fabrica-rotas-painel.js'), 'utf8');
    const fabCodigo = fab.replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n').filter(l => !l.trim().startsWith('//')).join('\n');
    assert.ok(!/ambtotal|\bgood:\s*90/.test(fabCodigo),
      '[PREVISAO] a fábrica voltou a chumbar empresa no código');

    /* e a peça respeita o que recebe */
    /* ⚠️ não basta o `BASE_PADRAO` sair certo: o que vale é o `baseDias` que a tela USA. Uma peça
       que declara BASE_PADRAO=90 mas inicia `baseDias = 180` fixo passaria nesta checagem e
       mostraria a base errada — foi exatamente o defeito que esta mudança corrige. */
    {
      const s90 = scriptDaPrevisao('/x', { basePadrao: 90 });
      assert.ok(/var BASE_PADRAO = 90;/.test(s90),
        '[PREVISAO] a peça ignorou a base pedida por quem a chamou');
      assert.ok(/var baseDias = BASE_PADRAO;/.test(s90),
        '[PREVISAO] a peça declara a base pedida mas INICIA com outro valor — a tela abriria na ' +
        'base errada e a previsão de compra sairia de um período que ninguém escolheu');
    }
    /* ⚠️ Codex #639 (P2): o piso é 30, NÃO 15 — `historico.js` faz `Math.max(30, …)` em toda
       consulta. Aceitar 15-29 faria o seletor dizer "20 dias" e o servidor calcular com 30:
       o número na tela deixaria de ser o número do cálculo, que é a classe de bug que mais
       machuca aqui, porque ninguém desconfia de uma tela que responde. */
    for (const ruim of [5, 15, 29, 731, 0, -10]) {
      assert.ok(/var BASE_PADRAO = 180;/.test(scriptDaPrevisao('/x', { basePadrao: ruim })),
        '[PREVISAO] a peça aceitou base ' + ruim + ', fora da faixa 30-730 que o servidor atende — ' +
        'abaixo de 30 o backend arredonda pra 30 e a tela mostraria um período que não foi o calculado');
    }
    for (const bom of [30, 90, 365, 730]) {
      assert.ok(new RegExp('var BASE_PADRAO = ' + bom + ';').test(scriptDaPrevisao('/x', { basePadrao: bom })),
        '[PREVISAO] a peça recusou base ' + bom + ', que está dentro da faixa 30-730');
    }
    assert.ok(/var BASE_PADRAO = 180;/.test(scriptDaPrevisao('/x')),
      '[PREVISAO] sem opção, a peça deveria cair no padrão 180 (empresa nova)');
  }

  console.log('OK: previsao le `produtos` do produtor, nao inventa tendencia e nao confunde falha com ausencia');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
