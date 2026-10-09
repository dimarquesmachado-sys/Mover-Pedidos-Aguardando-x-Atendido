/* 02/10 — DEVOLUÇÕES DO ML no painel, peça compartilhada.

   Mesmo desenho que deu certo no Plano de Compra (#582/#583) e pelo mesmo motivo: extrair do
   painel da AMB não funciona (ele monta a tela concatenando strings dentro do JS), e colar
   entre painéis quebra os testes próprios de cada empresa. A seção é escrita contra a resposta
   REAL da rota, com a empresa como parâmetro.

   E o teste EXERCITA o script num DOM de mentira — foi o que faltou no #581 e deixou passar uma
   peça que mostraria lixo na tela. */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const raiz = path.join(__dirname, '..');
const { scriptDasDevolucoes } = require(path.join(raiz, 'lib', 'checkout', 'painel-devolucoes-ml'));

const PREFIXOS = ['/good-checkout-offline', '/amb-checkout-offline', '/girassol-backup-offline'];
for (const base of PREFIXOS) {
  const s = scriptDasDevolucoes(base);
  assert.doesNotThrow(() => new Function(s), 'o script de ' + base + ' não compila — a seção sumiria sem erro');
  assert.ok(s.includes(base), base + ': sem o prefixo da empresa');
  for (const outra of PREFIXOS) {
    if (outra !== base) assert.ok(!s.includes(outra), base + ' carrega o prefixo de ' + outra);
  }
  assert.ok(!/onclick=/.test(s), base + ': onclick inline');
}

/* ════ desenha? ════ */
{
  const els = {};
  const novo = (id) => ({ id, innerHTML: '', textContent: '', value: '', disabled: false, _ev: {},
    addEventListener(e, f) { this._ev[e] = f; }, click() { this._ev.click && this._ev.click(); } });
  els['devolucoesMlAqui'] = novo('devolucoesMlAqui');
  /* o painel da GOOD guarda o período em PERIODO + janela(), não em campos #de/#ate */
  const JANELAS = {
    mesant: { de: '2026-09-01', ate: '2026-09-30' }, hoje: { de: '2026-10-03', ate: '2026-10-03' },
    sem: { de: '2026-09-26', ate: '2026-10-02' }, ano: { de: '2026-01-01', ate: '2026-10-03' },
    novo: { de: '2025-01-01', ate: '2025-01-31' },
    a: { de: '2024-01-01', ate: '2024-01-31' }, b: { de: '2024-02-01', ate: '2024-02-29' } };
  global.PERIODO = 'mesant';
  global.janela = (p) => JANELAS[p];
  global.document = { getElementById: (id) => els[id] || (els[id] = novo(id)) };
  /* a peça liga um setInterval de verdade; sem isto ele seguraria o processo vivo até o timeout
     do verifica.js. Guardo o callback pra disparar o "olhar" na mão. */
  let olhar = null;
  global.setInterval = (fn) => { olhar = fn; return 0; };
  const pausa = (ms) => new Promise(r => setTimeout(r, ms || 20));
  const resp = (extra) => ({ json: async () => Object.assign({ ok: true, quantidade: 0, valor_devolvido: 0, coleta_ok_em: new Date().toISOString() }, extra) });
  let urls = [];
  global.fetch = async (u) => { urls.push(u); return resp({
    quantidade: 7, valor_devolvido: 1850.4, custo_retorno_informado: 120,
    nao_concretizadas: 3, ainda_com_dinheiro_retido: 2, reclamacoes_sem_devolucao: 1,
    por_motivo: { 'produto com defeito': 4, 'arrependimento': 3 },
    por_status: { 'finalizada': 5, 'em análise': 2 },
    por_sku: [{ sku: 'SKU-A', nome: 'Peça A', qtd: 4, valor: 925.2 }, { sku: 'SKU-B', nome: 'Peça B', qtd: 3, valor: 925.2 }] }); };

  new Function(scriptDasDevolucoes('/good-checkout-offline'))();
  assert.ok(/Devoluções do Mercado Livre/.test(els['devolucoesMlAqui'].innerHTML), 'a seção não foi montada');
  assert.strictEqual(typeof olhar, 'function', 'sem carga automática: a peça não observa o período');

  module.exports = (async () => {
    await pausa(60);
    /* carga automática: abriu e já pediu o período do painel, sem clicar */
    assert.strictEqual(urls.length, 1, 'não carregou sozinha ao abrir');
    /* ⚠️ usa o MESMO período do painel, não um inventado: número de outro período ao lado dos
       cards do período escolhido é a pior forma de errar — parece certo */
    assert.ok(/de=2026-09-01/.test(urls[0]) && /ate=2026-09-30/.test(urls[0]),
      'a seção não respeita o período escolhido no painel — mostraria outro intervalo');

    const info = els['dvInfo'].textContent;
    assert.ok(/01\/09\/2026 → 30\/09\/2026/.test(info), 'não mostra o período consultado');
    assert.ok(/7 devolução/.test(info), 'não mostra a quantidade');
    assert.ok(/1\.850,40/.test(info), 'não mostra o valor devolvido');
    assert.ok(/frete de retorno/.test(info), 'esconde o custo do frete de retorno, que é prejuízo real');
    assert.ok(/dinheiro ainda retido/.test(info), 'não avisa das que ainda têm dinheiro retido');
    assert.ok(/3 não concretizada/.test(info), 'não explica as expiradas/canceladas que ficam fora do total');
    assert.ok(!/desatualizado|não foram coletadas/.test(info), 'coleta fresca não deveria avisar');
    assert.ok(/ML atualizado em \d\d\/\d\d\/\d{4}/.test(info), 'não mostra a data da coleta (a embutida mostra sempre)');

    const t = els['dvTab'].innerHTML;
    assert.ok(/produto com defeito/.test(t) && /finalizada/.test(t), 'faltam os quadros por motivo/status');
    assert.ok(t.indexOf('produto com defeito') < t.indexOf('arrependimento'),
      'não ordena por quantidade — o motivo mais comum tem que vir primeiro');
    /* a embutida da AMB/Girassol lista os SKUs que mais voltaram */
    assert.ok(/SKU que mais voltou/.test(t) && /SKU-A/.test(t) && /50%/.test(t), 'faltam os SKUs que mais voltaram');

    /* CACHE: clicar de novo no mesmo período não vai à rede e desenha igual */
    els['dvCalc'].click();
    await pausa();
    assert.strictEqual(urls.length, 1, 'o mesmo período foi consultado de novo — cache não funcionou');
    assert.ok(/7 devolução/.test(els['dvInfo'].textContent) && /SKU-A/.test(els['dvTab'].innerHTML), 'o cache desenhou diferente');

    /* cache nunca coletado: zero NÃO pode parecer "sem devolução" */
    global.PERIODO = 'hoje';
    global.fetch = async (u) => { urls.push(u); return resp({ coleta_ok_em: null }); };
    els['dvCalc'].click();
    await pausa();
    assert.ok(/ainda não foram coletadas/.test(els['dvInfo'].textContent), 'cache vazio apareceria como zero devoluções');
    /* coleta velha */
    global.PERIODO = 'sem';
    global.fetch = async (u) => { urls.push(u); return resp({ coleta_ok_em: '2026-01-01T00:00:00Z' }); };
    els['dvCalc'].click();
    await pausa();
    assert.ok(/desatualizado/.test(els['dvInfo'].textContent), 'coleta velha sem aviso');

    /* Codex: a resposta vai pra chave do que foi PEDIDO, não do período de quando ela chega */
    global.PERIODO = 'ano';
    let solta1; urls = [];
    global.fetch = (u) => { urls.push(u); return new Promise((ok) => { solta1 = () => ok(resp({ quantidade: 99 })); }); };
    els['dvCalc'].click();
    assert.strictEqual(els['dvCalc'].disabled, true, 'não travou o botão durante a consulta');
    global.PERIODO = 'hoje';          /* troca com a consulta de "ano" em voo */
    solta1(); await pausa();
    global.PERIODO = 'ano';
    global.fetch = async (u) => { urls.push(u); return resp({ quantidade: 5 }); };
    els['dvCalc'].click(); await pausa();
    assert.strictEqual(urls.length, 1, 'a resposta de "ano" não foi guardada sob "ano"');
    assert.ok(/99 devolução/.test(els['dvInfo'].textContent), 'cache de "ano" servido errado');
    global.PERIODO = 'hoje'; els['dvCalc'].click(); await pausa();
    assert.ok(!/99 devolução/.test(els['dvInfo'].textContent), 'a resposta de "ano" vazou pro período "hoje"');

    /* Codex: voltar a um período em cache com outra consulta em voo solta o botão */
    urls = []; let solta2;
    global.fetch = (u) => { urls.push(u); return new Promise((ok) => { solta2 = () => ok(resp({})); }); };
    global.PERIODO = 'novo'; olhar();
    assert.strictEqual(els['dvCalc'].disabled, true);
    global.PERIODO = 'mesant'; olhar(); await pausa();     /* automático: em cache, pinta e destrava */
    assert.strictEqual(els['dvCalc'].disabled, false, 'botão ficou "carregando…" depois de pintar o cache');
    assert.strictEqual(els['dvCalc'].textContent, 'carregar');
    solta2(); await pausa();

    /* Codex: o automático adiado por haver consulta em voo é refeito quando ela termina */
    urls = []; let solta3;
    global.fetch = (u) => { urls.push(u); return urls.length === 1 ? new Promise((ok) => { solta3 = () => ok(resp({})); }) : Promise.resolve(resp({ quantidade: 8 })); };
    global.PERIODO = 'a'; olhar();                 /* inicia a consulta de "a" */
    global.PERIODO = 'b'; olhar();                 /* "b" chega com "a" em voo: adiada */
    assert.strictEqual(urls.length, 1);
    solta3(); await pausa();
    olhar(); await pausa();                        /* próxima rodada do relógio */
    assert.strictEqual(urls.length, 2, 'o período "b" nunca foi consultado depois que a consulta em voo terminou');
    assert.ok(/de=2024-02-01/.test(urls[1]));

    /* AMB/Girassol expõem o período em intervalo(), não em janela(PERIODO) */
    delete global.janela; delete global.PERIODO;
    global.intervalo = () => ({ de: '2023-05-01', ate: '2023-05-31' });
    urls = []; global.fetch = async (u) => { urls.push(u); return resp({ quantidade: 2 }); };
    els['dvCalc'].click(); await pausa();
    assert.ok(urls.length === 1 && /de=2023-05-01/.test(urls[0]), 'não lê o período de intervalo() (AMB/Girassol)');

    /* sem período legível: não pede sem datas */
    delete global.intervalo;
    let pediu = false; global.fetch = async () => { pediu = true; return { json: async () => ({}) }; };
    els['dvCalc'].click();
    await pausa();
    assert.ok(!pediu, 'pediu a rota sem período (levaria 400)');

    console.log('OK: devolucoes do ML desenham, respeitam o periodo do painel, ordenam por motivo e usam cache');
  })();
}

/* a fábrica serve e a GOOD liga */
{
  const fab = fs.readFileSync(path.join(raiz, 'lib', 'checkout', 'fabrica-rotas-painel.js'), 'utf8');
  assert.ok(/devolucoes-ml\.js/.test(fab), 'a fábrica não serve o script');
  assert.ok(/devolucoes-ml indisponível/.test(fab), 'erro ao gerar derrubaria o painel');
  const tela = fs.readFileSync(path.join(raiz, 'good-checkout-offline', 'dashboard.html'), 'utf8');
  assert.ok(/id="devolucoesMlAqui"/.test(tela), 'GOOD: sem o espaço da seção');
  assert.ok(/js\/devolucoes-ml\.js/.test(tela), 'GOOD: não inclui o script');
  const idx = fs.readFileSync(path.join(raiz, 'good-checkout-offline', 'index.js'), 'utf8');
  assert.ok(/js\/devolucoes-ml\.js' \|\|/.test(idx),
    'o script não está liberado na guarda — quem abre por ?k= tomaria 401 e a seção não carregaria');
}
