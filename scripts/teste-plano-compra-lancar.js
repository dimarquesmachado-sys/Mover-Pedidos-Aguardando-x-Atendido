'use strict';
/* 26/11 — PLANO DE COMPRA: A CAIXA "LANÇAR NO BLING" (cria o Pedido de Compra com os itens marcados).

   O que se prova — o script de PRODUÇÃO da tela (lib/checkout/painel-plano-compra) num navegador de mentira:
   · o botão só liga com item marcado com quantidade; abre a caixa, busca os fornecedores e monta a lista;
   · CONFERIR manda o ensaio (fornecedor, data, SKU e quantidade de cada marcado, na ordem da tela) e mostra o resumo;
     só depois de conferir o CRIAR liga; qualquer mexida (item, quantidade, fornecedor, data) desliga e pede conferir;
   · CRIAR manda o mesmo pedido com a CHAVE; durante o envio nada mais pode ser clicado (sem pedido em dobro);
   · criado: avisa o número, desmarca os itens, recalcula o plano e troca a chave;
   · recusado: mostra o que o Bling disse e deixa tentar de novo com a MESMA chave;
   · "não sei" (do servidor, resposta que não chega, resposta torta): TRAVA — nada de conferir/criar até o dono dizer
     que olhou o Bling; liberar troca a chave e exige conferir de novo;
   · falha ao ler fornecedores: diz o motivo e não deixa conferir. */
const assert = require('assert');
const { scriptDoPlano } = require('../lib/checkout/painel-plano-compra');

process.exitCode = 1;
let terminou = false;
process.on('exit', () => { if (!terminou) { console.log('FALHOU: o teste não chegou ao fim (promessa presa)'); process.exitCode = 1; } });

const it = (sku, nome, o) => Object.assign({ sku, ean: null, nome, img: null, curva: 'A', un: 1, md: 1, md_estoque: null, saldo: 1, a_caminho: 0, precisa: 9, un30: 1, acaba_em: 1, comprar: 1, custo_un: 1, investir: 1, mc_un: 1, risco: 1 }, o || {});
const ITENS = () => [it('S3', 'Érico', { comprar: 20, md: 2 }), it('S1', 'banana', { comprar: 0, md: 9 }), it('S10', 'Abacate', { comprar: 5, md: 1 }), it('S<2>', 'damasco "x"', { comprar: 7, md: 3 })];
const FORN = [{ id: '501', nome: 'Álfa <Import>' }, { id: '502', nome: 'Zeta' }];
const RESUMO = { fornecedor: 'Álfa <Import>', data_prevista: '2027-02-28', itens: 3, unidades: 32, total: 1256.5, sem_custo: [] };

const cena = async (op) => {
  op = op || {};
  const els = {}; const obs = { pedidos: [], plano: 0 };
  const novo = (id) => ({ id, innerHTML: '', textContent: '', value: '', disabled: false, style: {}, _ev: {}, addEventListener(e, f) { this._ev[e] = f; }, click() { return this._ev.click && this._ev.click(); } });
  els.planoCompraAqui = novo('planoCompraAqui');
  const doc = { getElementById: (id) => els[id] || (els[id] = novo(id)), createElement: () => ({ click() {}, href: '', download: '' }) };
  const c = { els, obs, forn: () => ({ ok: true, fornecedores: FORN, incompleto: false }), ensaio: () => ({ ok: true, ensaio: true, resumo: RESUMO }), criar: () => ({ ok: true, id: '4242', numero: 12, resumo: RESUMO }), segura: null };
  const fetch = async (u, o) => {
    const metodo = (o && o.method) || 'GET';
    if (/\/plano-compra\?/.test(u)) { obs.plano++; return { json: async () => ({ ok: true, lead: 4, cob: 5, horizonte_dias: 274, skus: 4, totais: { investir: 1, risco: 1, skus_a_comprar: 1 }, itens: ITENS() }) }; }
    const corpo = o && o.body ? JSON.parse(o.body) : null;
    obs.pedidos.push({ metodo, u, corpo, cred: o && o.credentials, tipo: o && o.headers && o.headers['Content-Type'] });
    let r;
    if (/\/compras-fornecedores$/.test(u)) r = c.forn();
    else if (corpo && corpo.ensaio === true) r = c.ensaio(corpo);
    else { if (c.segura) await new Promise((ok) => { c.solta = ok; }); r = c.criar(corpo); }
    if (r instanceof Error) throw r;
    return { json: async () => { if (r === 'TORTO') throw new Error('json'); return r; } };
  };
  const Blob = function (p) { this.texto = p.join(''); };
  new Function('document', 'window', 'fetch', 'URL', 'Blob', 'setTimeout', scriptDoPlano('/emp'))(doc, op.janela || {}, fetch, { createObjectURL: () => 'blob:x', revokeObjectURL: () => {} }, Blob, (f) => setImmediate(f));
  c.fim = async () => { for (let i = 0; i < 12; i++) await new Promise((r) => setImmediate(r)); };
  c.estado = () => [els.pcLancar.disabled, els.pcConferir.disabled, els.pcCriar.disabled];
  c.info = () => els.pcLancarInfo.innerHTML;
  c.marca = (sku, ligado) => els.pcTab._ev.change({ target: { getAttribute: (n) => (n === 'data-pc-marca' ? sku : null), checked: ligado } });
  c.digita = (sku, v) => els.pcTab._ev.input({ target: { getAttribute: (n) => (n === 'data-pc-qtd' ? sku : null), value: v } });
  c.escolhe = (id) => { els.pcForn.value = id; els.pcForn._ev.change(); };
  c.data = (d, ev) => { els.pcDataPrev.value = d; els.pcDataPrev._ev[ev || 'change'](); };
  if (!op.semPlano) { els.pcCalc.click(); await c.fim(); }
  return c;
};

(async () => {
  /* ── a caixa nasce fechada e o botão desligado; sem plano ou sem item marcado, clicar não abre ── */
  let c = await cena({ semPlano: true });
  const h0 = c.els.planoCompraAqui.innerHTML;
  assert.ok(/<button id="pcLancar" type="button" disabled title="[^"]*">lançar no Bling…<\/button>/.test(h0) && /<div id="pcLancarBox" style="display:none;/.test(h0) && /<select id="pcForn" disabled>/.test(h0) && /<input id="pcDataPrev" type="date">/.test(h0) && /<button id="pcConferir" type="button" disabled>conferir<\/button><button id="pcCriar" type="button" disabled>criar o Pedido de Compra<\/button>/.test(h0), 'a caixa e os botões nascem fechados e desligados');
  await c.els.pcLancar.click(); await c.fim();
  assert.deepStrictEqual([c.obs.pedidos.length, c.els.pcLancarBox ? c.els.pcLancarBox.style.display : undefined], [0, undefined], 'sem item marcado, não abre nem chama o servidor');

  c = await cena();
  assert.deepStrictEqual(c.estado(), [true, true, true], 'plano calculado, nada marcado: tudo desligado');
  c.marca('S3', true); c.marca('S10', true); c.marca('S<2>', true);
  assert.deepStrictEqual(c.estado(), [false, true, true], 'com item marcado, o lançar liga');
  /* item marcado SEM quantidade não conta */
  c.digita('S3', ''); c.digita('S10', '0'); c.digita('S<2>', 'x');
  assert.strictEqual(c.estado()[0], true, 'marcados sem quantidade: não há o que lançar');
  c.digita('S3', '20'); c.digita('S10', '5'); c.digita('S<2>', '7');

  /* ── abrir: busca os fornecedores e monta a lista ── */
  await c.els.pcLancar.click(); await c.fim();
  assert.deepStrictEqual(c.obs.pedidos, [{ metodo: 'GET', u: '/emp/compras-fornecedores', corpo: null, cred: 'same-origin', tipo: undefined }]);
  assert.strictEqual(c.els.pcLancarBox.style.display, '');
  assert.deepStrictEqual([c.els.pcForn.innerHTML, c.els.pcForn.disabled], ['<option value="">escolha…</option><option value="501">Álfa &lt;Import&gt;</option><option value="502">Zeta</option>', false], 'a lista, com o nome protegido');
  assert.ok(/escolha o fornecedor, a chegada prevista e clique em conferir\. O preço de cada item é o custo cadastrado\./.test(c.info()) && !/incompleta/.test(c.info()));
  assert.deepStrictEqual(c.estado(), [false, false, true], 'conferir liga; criar só depois de conferir');

  /* ── conferir: manda o ensaio com o que está na tela, na ordem da tela ── */
  c.escolhe('501'); c.data('2027-02-28');
  c.els.pcTab._ev.click({ target: { getAttribute: (n) => (n === 'data-pc-ord' ? 'md' : null), parentNode: c.els.pcTab } });   /* ordena por ritmo: S<2>(3), S3(2), S10(1) */
  await c.els.pcConferir.click(); await c.fim();
  const PEDIDO = { fornecedor: '501', data_prevista: '2027-02-28', itens: [{ sku: 'S<2>', quantidade: 7 }, { sku: 'S3', quantidade: 20 }, { sku: 'S10', quantidade: 5 }] };
  assert.deepStrictEqual(c.obs.pedidos[1], { metodo: 'POST', u: '/emp/compras-pedido', corpo: Object.assign({ ensaio: true }, PEDIDO), cred: 'same-origin', tipo: 'application/json' }, 'o ensaio não leva chave');
  assert.ok(/^conferido: <b>Álfa &lt;Import&gt;<\/b> · 3 item\(ns\) · 32 unidade\(s\) · total <b>R\$\s1\.256,50<\/b> pelo custo cadastrado · chegada prevista 28\/02\/2027<div style="opacity:\.75">se está certo, clique em criar o Pedido de Compra\.<\/div>$/.test(c.info()), c.info());
  assert.deepStrictEqual(c.estado(), [false, false, false], 'conferido: o criar liga');

  /* ── qualquer mexida depois de conferir desliga o criar ── */
  const reconfere = async () => { await c.els.pcConferir.click(); await c.fim(); assert.strictEqual(c.estado()[2], false); };
  for (const [nome, mexe, desfaz] of [
    ['a quantidade', () => c.digita('S3', '21'), () => c.digita('S3', '20')],
    ['o fornecedor', () => c.escolhe('502'), () => c.escolhe('501')],
    ['a data (change)', () => c.data('2027-03-01'), () => c.data('2027-02-28')],
    ['a data (input)', () => c.data('', 'input'), () => c.data('2027-02-28', 'input')],
    ['um item a menos', () => c.marca('S10', false), () => { c.marca('S10', true); c.digita('S10', '5'); }],
    ['a ordem da tela', () => c.els.pcTab._ev.click({ target: { getAttribute: (n) => (n === 'data-pc-ord' ? 'md' : null), parentNode: c.els.pcTab } }), () => c.els.pcTab._ev.click({ target: { getAttribute: (n) => (n === 'data-pc-ord' ? 'md' : null), parentNode: c.els.pcTab } })]]) {
    mexe();
    assert.deepStrictEqual([c.estado()[2], c.info()], [true, '<span style="opacity:.75">o pedido mudou — clique em conferir de novo</span>'], 'mexeu em ' + nome + ': o criar desliga');
    await c.els.pcCriar.click(); await c.fim();
    assert.ok(!c.obs.pedidos.some((p) => p.corpo && p.corpo.chave), 'e clicar em criar não envia nada (' + nome + ')');
    desfaz(); assert.strictEqual(c.estado()[2], true, 'voltar ao que era não revalida sozinho (' + nome + ')');
    await reconfere();
  }
  /* sem fornecedor / sem data: o conferir vai (o servidor é quem diz o que falta) */
  c.ensaio = () => ({ ok: false, ensaio: true, erros: ['escolha o fornecedor', 'x <b>'] });
  c.escolhe(''); await c.els.pcConferir.click(); await c.fim();
  assert.deepStrictEqual([c.info(), c.estado()[2]], ['<span style="color:#f87171">⚠️ não dá pra criar o pedido:</span><ul style="margin:4px 0 0 18px;padding:0"><li>escolha o fornecedor</li><li>x &lt;b&gt;</li></ul>', true]);
  /* resumo com itens sem custo e sem data prevista */
  c.ensaio = () => ({ ok: true, ensaio: true, resumo: Object.assign({}, RESUMO, { data_prevista: null, sem_custo: ['S3', 'S<2>'] }) });
  c.escolhe('501'); c.data(''); await c.els.pcConferir.click(); await c.fim();
  assert.ok(/<span style="color:#fbbf24">sem data prevista<\/span><div style="color:#fbbf24">⚠️ 2 item\(ns\) sem custo cadastrado vão com preço R\$ 0,00 \(o total acima não conta com eles\): S3, S&lt;2&gt;<\/div>/.test(c.info()), c.info());
  c.ensaio = () => ({ ok: true, ensaio: true, resumo: RESUMO });
  c.data('2027-02-28'); await reconfere();
  /* o pedido mudou ENQUANTO conferia: o resumo que chegou não vale */
  { const p = c.els.pcConferir.click(); c.els.pcForn.value = '502'; await p; await c.fim();
    assert.deepStrictEqual([c.estado()[2], c.info()], [true, '<span style="opacity:.75">o pedido mudou — clique em conferir de novo</span>']);
    c.els.pcForn.value = '501'; await reconfere(); }

  /* o valor mudou SEM avisar a tela (nenhum evento): criar não envia o que não foi conferido */
  { const n = c.obs.pedidos.length; c.els.pcForn.value = '502'; await c.els.pcCriar.click(); await c.fim();
    assert.strictEqual(c.obs.pedidos.length, n, 'pedido diferente do conferido não é enviado, mesmo com o botão ainda ligado');
    c.els.pcForn.value = '501'; }
  /* o clique de "liberar" fora de um "não sei" não faz nada (não derruba a conferência nem troca o aviso) */
  { const antesInfo = c.info(); c.els.pcLancarInfo._ev.click({ target: { id: 'pcLancarDeNovo' } });
    assert.deepStrictEqual([c.info(), c.estado()[2]], [antesInfo, false]); }
  /* ── criar: o mesmo pedido, com a chave; durante o envio nada mais clica ── */
  const antes = c.obs.pedidos.length, planoAntes = c.obs.plano;
  c.segura = true;
  const envio = c.els.pcCriar.click();
  for (let i = 0; i < 6; i++) await new Promise((r) => setImmediate(r));
  assert.deepStrictEqual([c.estado(), /criando o Pedido de Compra no Bling… não feche a tela/.test(c.info())], [[false, true, true], true], 'enviando: conferir e criar desligados');
  await c.els.pcCriar.click(); await c.els.pcConferir.click(); await c.els.pcLancarFechar.click(); await c.els.pcLancar.click();
  assert.deepStrictEqual([c.obs.pedidos.length, c.els.pcLancarBox.style.display], [antes + 1, ''], 'clique duplo, conferir e fechar não fazem nada durante o envio');
  c.solta(); await envio; await c.fim();
  const env = c.obs.pedidos[antes];
  assert.deepStrictEqual([env.metodo, env.u, Object.keys(env.corpo).sort(), env.corpo.fornecedor, env.corpo.data_prevista, env.corpo.itens, 'ensaio' in env.corpo], ['POST', '/emp/compras-pedido', ['chave', 'data_prevista', 'fornecedor', 'itens'], '501', '2027-02-28', PEDIDO.itens, false]);
  assert.ok(/^pc[a-z0-9]{12,40}$/.test(env.corpo.chave), 'a chave: ' + env.corpo.chave);
  assert.ok(/^<span style="color:#4ade80">✅ Pedido de Compra nº <b>12<\/b> criado no Bling\.<\/span> <b>Álfa &lt;Import&gt;<\/b> · 3 item\(ns\)/.test(c.info()) && /o plano foi recalculado: os itens já aparecem na coluna a caminho\./.test(c.info()), c.info());
  assert.deepStrictEqual([c.obs.plano, c.els.pcSel.textContent, c.estado()], [planoAntes + 1, 'nenhum item marcado', [false, true, true]], 'criado: recalcula o plano, desmarca os itens, e o criar desliga');
  /* o próximo pedido tem OUTRA chave */
  c.segura = null; c.marca('S3', true); c.escolhe('502'); await c.els.pcConferir.click(); await c.fim(); await c.els.pcCriar.click(); await c.fim();
  const env2 = c.obs.pedidos[c.obs.pedidos.length - 1];
  assert.ok(env2.corpo.chave && env2.corpo.chave !== env.corpo.chave, 'chave nova pro pedido seguinte');
  /* criado sem número: avisa sem o nº */
  c.criar = () => ({ ok: true, id: '9', numero: null }); c.marca('S3', true); await c.els.pcConferir.click(); await c.fim(); await c.els.pcCriar.click(); await c.fim();
  assert.ok(/^<span style="color:#4ade80">✅ Pedido de Compra criado no Bling\.<\/span> <div/.test(c.info()), c.info());

  /* ── recusado: mostra o que o Bling disse, nada trava, a MESMA chave tenta de novo ── */
  c = await cena(); c.marca('S3', true); await c.els.pcLancar.click(); await c.fim(); c.escolhe('501');
  c.criar = () => ({ ok: false, recusado: true, status: 400, motivo: 'o Bling recusou o pedido (400)', bling: { tipo: 'VALIDATION_ERROR', mensagem: 'Não salvou', descricao: 'Dados <inválidos>', campos: [{ campo: 'itens[0].valor', msg: 'obrigatório' }, { campo: null, msg: 'outra' }] } });
  await c.els.pcConferir.click(); await c.fim(); await c.els.pcCriar.click(); await c.fim();
  assert.strictEqual(c.info(), '<span style="color:#f87171">⚠️ o Bling recusou o pedido (400) — nada foi criado.</span><div style="opacity:.85">Não salvou — Dados &lt;inválidos&gt; <span style="opacity:.6">(VALIDATION_ERROR)</span></div><ul style="margin:4px 0 0 18px;padding:0"><li>itens[0].valor: obrigatório</li><li>outra</li></ul>');
  assert.deepStrictEqual([c.estado(), c.els.pcSel.textContent !== 'nenhum item marcado', c.obs.plano], [[false, false, false], true, 1], 'recusado: os itens seguem marcados, nada recalcula, dá pra tentar de novo');
  const ch1 = c.obs.pedidos[c.obs.pedidos.length - 1].corpo.chave;
  c.criar = () => ({ ok: false, recusado: true, status: 429, motivo: 'limite do Bling — tente de novo daqui a pouco', bling: null });
  await c.els.pcCriar.click(); await c.fim();
  assert.deepStrictEqual([c.obs.pedidos[c.obs.pedidos.length - 1].corpo.chave, c.info()], [ch1, '<span style="color:#f87171">⚠️ limite do Bling — tente de novo daqui a pouco — nada foi criado.</span>'], 'a mesma chave na nova tentativa');
  /* não passou na conferência do servidor na hora de criar (ex.: o cadastro mudou): lista os erros, não trava */
  c.criar = () => ({ ok: false, erros: ['o SKU "S3" não tem o cadastro'] }); await c.els.pcCriar.click(); await c.fim();
  assert.ok(/não dá pra criar o pedido:.*<li>o SKU &quot;S3&quot; não tem o cadastro<\/li>/.test(c.info()) && c.estado()[1] === false);
  c.criar = () => ({ ok: false, em_andamento: true }); await c.els.pcCriar.click(); await c.fim();
  assert.ok(/este pedido já está sendo enviado ao Bling — aguarde/.test(c.info()));

  /* ── "não sei": TRAVA, de quatro jeitos — e só o dono libera ── */
  const FIM = 'NÃO SEI se o pedido foi criado. Confira em Pedidos de Compra no Bling antes de tentar de novo.';
  for (const [nome, resp, texto] of [
    ['o servidor disse', () => ({ ok: false, ambiguo: true, motivo: 'a conexão com o Bling caiu — ' + FIM }), 'a conexão com o Bling caiu — ' + FIM],
    ['a mesma chave já tinha um não-sei', () => ({ ok: false, repetido: true, anterior: { ok: false, ambiguo: true, motivo: 'x — ' + FIM } }), 'x — ' + FIM],
    ['a resposta não chegou', () => new Error('rede'), 'a resposta do servidor não chegou — ' + FIM],
    ['a resposta veio torta', () => 'TORTO', 'a resposta do servidor não chegou — ' + FIM],
    ['a resposta veio vazia', () => ({}), 'não consegui ler a resposta do servidor — ' + FIM],
    ['a resposta veio nula', () => null, 'não consegui ler a resposta do servidor — ' + FIM]]) {
    c = await cena(); c.marca('S3', true); await c.els.pcLancar.click(); await c.fim(); c.escolhe('501');
    await c.els.pcConferir.click(); await c.fim();
    c.criar = resp; await c.els.pcCriar.click(); await c.fim();
    const chaveVelha = c.obs.pedidos[c.obs.pedidos.length - 1].corpo.chave;
    assert.ok(c.info().indexOf('<div style="color:#f87171"><b>⚠️ ' + texto + '</b></div>') === 0 && /<button id="pcLancarDeNovo" type="button">já conferi no Bling: não foi criado, liberar pra tentar de novo<\/button>/.test(c.info()), nome + ': ' + c.info());
    assert.deepStrictEqual([c.estado(), c.obs.plano], [[false, true, true], 1], nome + ': conferir e criar travados; nada recalcula');
    const n = c.obs.pedidos.length;
    await c.els.pcConferir.click(); await c.els.pcCriar.click(); c.escolhe('502'); c.digita('S3', '99'); await c.fim();
    assert.deepStrictEqual([c.obs.pedidos.length, c.estado(), /pcLancarDeNovo/.test(c.info())], [n, [false, true, true], true], nome + ': travado mesmo mexendo; o aviso fica');
    /* clique em outro ponto do aviso não libera; no botão, libera — com chave NOVA e exigindo conferir */
    c.els.pcLancarInfo._ev.click({ target: { id: 'outro' } }); c.els.pcLancarInfo._ev.click({});
    assert.strictEqual(c.estado()[1], true);
    c.criar = () => ({ ok: true, id: '1', numero: 1, resumo: RESUMO });
    c.els.pcLancarInfo._ev.click({ target: { id: 'pcLancarDeNovo' } });
    assert.deepStrictEqual([c.estado(), c.info()], [[false, false, true], '<span style="opacity:.75">liberado — clique em conferir e depois em criar o Pedido de Compra.</span>'], nome + ': liberado, mas tem de conferir de novo');
    await c.els.pcConferir.click(); await c.fim(); await c.els.pcCriar.click(); await c.fim();
    const chaveNova = c.obs.pedidos[c.obs.pedidos.length - 1].corpo.chave;
    assert.ok(chaveNova && chaveNova !== chaveVelha && /criado no Bling/.test(c.info()), nome + ': a nova tentativa vai com outra chave');
  }
  /* ── Codex #990 (P1): a trava do "não sei" NÃO some fechando a caixa, nem recarregando a página ── */
  {
    const guarda = { _d: {}, getItem(k) { return k in this._d ? this._d[k] : null; }, setItem(k, v) { this._d[k] = String(v); }, removeItem(k) { delete this._d[k]; } };
    const janela = { localStorage: guarda };
    c = await cena({ janela }); c.marca('S3', true); await c.els.pcLancar.click(); await c.fim(); c.escolhe('501');
    await c.els.pcConferir.click(); await c.fim();
    c.criar = () => new Error('rede'); await c.els.pcCriar.click(); await c.fim();
    const chaveDoNaoSei = c.obs.pedidos[c.obs.pedidos.length - 1].corpo.chave;
    const aviso = c.info();
    assert.ok(/a resposta do servidor não chegou — NÃO SEI/.test(aviso) && /pcLancarDeNovo/.test(aviso));
    assert.deepStrictEqual(JSON.parse(guarda._d['pcLancarTrava:/emp'] || 'null'), { chave: chaveDoNaoSei, motivo: 'a resposta do servidor não chegou — ' + FIM }, 'a trava fica guardada no navegador, com a chave do envio');
    /* fechar e abrir: continua travado, com o MESMO aviso; conferir e criar não enviam */
    c.criar = () => ({ ok: true, id: '1', numero: 1, resumo: RESUMO });
    for (let volta = 0; volta < 2; volta++) {
      c.els.pcLancarFechar.click(); assert.strictEqual(c.els.pcLancarBox.style.display, 'none');
      assert.strictEqual(c.estado()[0], false, 'com o "não sei" pendente o botão de abrir fica ligado');
      await c.els.pcLancar.click(); await c.fim();
      const n = c.obs.pedidos.length;
      assert.deepStrictEqual([c.info(), c.estado()], [aviso, [false, true, true]], 'reabriu: o aviso e a trava continuam (a mensagem dos fornecedores não cobre o aviso)');
      c.escolhe('501'); await c.els.pcConferir.click(); await c.els.pcCriar.click(); await c.fim();
      assert.strictEqual(c.obs.pedidos.length, n, 'reabrir não libera: nada é conferido nem criado');
    }
    /* desmarcou tudo e fechou: o botão segue ligado e leva ao aviso */
    c.marca('S3', false); c.els.pcLancarFechar.click(); assert.strictEqual(c.estado()[0], false);
    await c.els.pcLancar.click(); await c.fim(); assert.strictEqual(c.info(), aviso);
    /* RECARREGOU A PÁGINA (tela nova, mesma guarda do navegador): a trava volta, com a MESMA chave */
    const c2 = await cena({ janela });
    assert.strictEqual(c2.estado()[0], false, 'página nova, nada marcado: o botão já está ligado por causa do "não sei" guardado');
    await c2.els.pcLancar.click(); await c2.fim();
    assert.deepStrictEqual([c2.info(), c2.estado()], [aviso, [false, true, true]], 'depois de recarregar, o aviso e a trava voltam');
    c2.marca('S3', true); c2.escolhe('501'); await c2.els.pcConferir.click(); await c2.els.pcCriar.click(); await c2.fim();
    assert.ok(!c2.obs.pedidos.some((p) => p.metodo === 'POST'), 'recarregar não libera');
    /* só o dono libera — aí a guarda é apagada e a chave é OUTRA */
    c2.els.pcLancarInfo._ev.click({ target: { id: 'pcLancarDeNovo' } });
    assert.deepStrictEqual([Object.keys(guarda._d), c2.estado()], [[], [false, false, true]], 'liberou: a trava guardada some');
    await c2.els.pcConferir.click(); await c2.fim(); await c2.els.pcCriar.click(); await c2.fim();
    const chaveNova2 = c2.obs.pedidos[c2.obs.pedidos.length - 1].corpo.chave;
    assert.ok(chaveNova2 && chaveNova2 !== chaveDoNaoSei && /criado no Bling/.test(c2.info()));
    /* e uma terceira página, depois de liberado: nasce sem trava */
    const c3 = await cena({ janela }); assert.strictEqual(c3.estado()[0], true);
    /* guarda do navegador quebrada ou com lixo: não estoura e não inventa trava */
    for (const g of [{ getItem() { throw new Error('x'); }, setItem() { throw new Error('x'); }, removeItem() { throw new Error('x'); } }, { getItem: () => '{torto', setItem() {}, removeItem() {} }, { getItem: () => '{"chave":"x"}', setItem() {}, removeItem() {} }, { getItem: () => 'null', setItem() {}, removeItem() {} }]) {
      const c4 = await cena({ janela: { localStorage: g } });
      assert.strictEqual(c4.estado()[0], true, 'sem trava válida guardada, o botão nasce desligado');
      c4.marca('S3', true); await c4.els.pcLancar.click(); await c4.fim(); c4.escolhe('501'); await c4.els.pcConferir.click(); await c4.fim();
      assert.strictEqual(c4.estado()[2], false);
      c4.criar = () => new Error('rede'); await c4.els.pcCriar.click(); await c4.fim();
      assert.deepStrictEqual([c4.estado(), /NÃO SEI/.test(c4.info())], [[false, true, true], true], 'mesmo sem conseguir guardar, a trava vale nesta tela');
    }
  }
  /* ── Codex #990 (2ª rodada, P1): a página fecha/recarrega COM O ENVIO NO AR — a tela nova nasce travada ── */
  {
    const guarda = { _d: {}, getItem(k) { return k in this._d ? this._d[k] : null; }, setItem(k, v) { this._d[k] = String(v); }, removeItem(k) { delete this._d[k]; } };
    const janela = { localStorage: guarda };
    const INTERROMPIDO = 'o envio do pedido foi interrompido (a página fechou ou recarregou no meio) — ' + FIM;
    const ate = async (cx, resp) => { cx.marca('S3', true); await cx.els.pcLancar.click(); await cx.fim(); cx.escolhe('501'); await cx.els.pcConferir.click(); await cx.fim(); cx.criar = resp; };
    c = await cena({ janela }); await ate(c, () => ({ ok: true, id: '1', numero: 5, resumo: RESUMO }));
    assert.deepStrictEqual(Object.keys(guarda._d), [], 'conferir não guarda trava');
    c.segura = true; const noAr = c.els.pcCriar.click();
    for (let i = 0; i < 6; i++) await new Promise((r) => setImmediate(r));
    const chaveNoAr = c.obs.pedidos[c.obs.pedidos.length - 1].corpo.chave;
    assert.deepStrictEqual(JSON.parse(guarda._d['pcLancarTrava:/emp'] || 'null'), { chave: chaveNoAr, motivo: INTERROMPIDO }, 'a trava é guardada ANTES da resposta, com a chave do envio');
    /* a página "recarregou" com o envio no ar: a tela nova não cria nada */
    const cR = await cena({ janela });
    assert.strictEqual(cR.estado()[0], false);
    await cR.els.pcLancar.click(); await cR.fim();
    assert.ok(cR.info().indexOf('<div style="color:#f87171"><b>⚠️ ' + INTERROMPIDO + '</b></div>') === 0 && /pcLancarDeNovo/.test(cR.info()), cR.info());
    cR.marca('S3', true); cR.escolhe('501'); await cR.els.pcConferir.click(); await cR.els.pcCriar.click(); await cR.fim();
    assert.ok(!cR.obs.pedidos.some((p) => p.metodo === 'POST'), 'a tela nova não confere nem cria enquanto o envio antigo não tem desfecho');
    /* o envio antigo termina CRIADO: desfecho certo, a trava guardada sai */
    c.solta(); await noAr; await c.fim();
    assert.deepStrictEqual([/criado no Bling/.test(c.info()), Object.keys(guarda._d)], [true, []], 'criado: a trava guardada é apagada');
    assert.strictEqual((await cena({ janela })).estado()[0], true, 'e a próxima tela nasce destravada');
    /* recusado e "não passou na conferência": nada foi criado — a trava guardada também sai */
    for (const resp of [() => ({ ok: false, recusado: true, status: 400, motivo: 'o Bling recusou o pedido (400)', bling: null }), () => ({ ok: false, erros: ['x'] })]) {
      const cx = await cena({ janela }); await ate(cx, resp); await cx.els.pcCriar.click(); await cx.fim();
      assert.deepStrictEqual([Object.keys(guarda._d), cx.estado()[1]], [[], false], 'desfecho certo sem pedido criado: sem trava');
    }
    /* "já está sendo enviado" NÃO é desfecho: a trava guardada fica (a tela aberta segue podendo reenviar a MESMA chave) */
    { const cx = await cena({ janela }); await ate(cx, () => ({ ok: false, em_andamento: true })); await cx.els.pcCriar.click(); await cx.fim();
      const ch = cx.obs.pedidos[cx.obs.pedidos.length - 1].corpo.chave;
      assert.deepStrictEqual([JSON.parse(guarda._d['pcLancarTrava:/emp'] || 'null'), cx.estado()[2]], [{ chave: ch, motivo: INTERROMPIDO }, false]);
      cx.criar = () => ({ ok: true, id: '2', numero: 6, resumo: RESUMO }); await cx.els.pcCriar.click(); await cx.fim();
      assert.deepStrictEqual([cx.obs.pedidos[cx.obs.pedidos.length - 1].corpo.chave, Object.keys(guarda._d)], [ch, []], 'reenviou com a mesma chave; criado apaga a trava'); }
    /* o "não sei" troca o motivo guardado pelo dele */
    { const cx = await cena({ janela }); await ate(cx, () => ({ ok: false, ambiguo: true, motivo: 'caiu — ' + FIM })); await cx.els.pcCriar.click(); await cx.fim();
      assert.strictEqual(JSON.parse(guarda._d['pcLancarTrava:/emp']).motivo, 'caiu — ' + FIM);
      cx.els.pcLancarInfo._ev.click({ target: { id: 'pcLancarDeNovo' } }); assert.deepStrictEqual(Object.keys(guarda._d), []); }
  }
  /* sem guarda no navegador (ou guarda que não grava): fechar e abrir, nesta mesma tela, NÃO solta a trava */
  for (const janela of [{}, { localStorage: { getItem: () => null, setItem() {}, removeItem() {} } }]) {
    c = await cena({ janela }); c.marca('S3', true); await c.els.pcLancar.click(); await c.fim(); c.escolhe('501'); await c.els.pcConferir.click(); await c.fim();
    c.criar = () => ({ ok: false, ambiguo: true, motivo: 'caiu — ' + FIM }); await c.els.pcCriar.click(); await c.fim();
    const avisoM = c.info(); c.criar = () => ({ ok: true, id: '1', numero: 1, resumo: RESUMO });
    c.els.pcLancarFechar.click(); await c.els.pcLancar.click(); await c.fim();
    const n = c.obs.pedidos.length; c.escolhe('501'); await c.els.pcConferir.click(); await c.els.pcCriar.click(); await c.fim();
    assert.deepStrictEqual([c.info(), c.estado(), c.obs.pedidos.length], [avisoM, [false, true, true], n], 'fechar e abrir não solta a trava, mesmo sem guarda no navegador');
  }
  /* ── Codex #990 (P2): o que o dono marcou ou alterou ENQUANTO o pedido era enviado não se perde ── */
  {
    c = await cena(); c.marca('S3', true); c.marca('S<2>', true); c.digita('S3', '20'); c.digita('S<2>', '7');
    await c.els.pcLancar.click(); await c.fim(); c.escolhe('501'); await c.els.pcConferir.click(); await c.fim();
    c.segura = true; const envio2 = c.els.pcCriar.click();
    for (let i = 0; i < 6; i++) await new Promise((r) => setImmediate(r));
    c.marca('S10', true); c.digita('S10', '12');   /* marcou outro item durante o envio */
    c.digita('S<2>', '9');                          /* e mudou a quantidade de um que estava indo */
    c.solta(); await envio2; await c.fim();
    const enviado = c.obs.pedidos[c.obs.pedidos.length - 1].corpo.itens;
    assert.deepStrictEqual(enviado, [{ sku: 'S3', quantidade: 20 }, { sku: 'S<2>', quantidade: 7 }], 'foi o que estava conferido');
    assert.ok(/criado no Bling/.test(c.info()));
    assert.strictEqual(c.els.pcSel.textContent, '2 item(ns) marcado(s) · 21 unidade(s)', 'S3 saiu (foi pedido); S10 (marcado no meio) e S<2> (quantidade alterada no meio) continuam marcados');
  }
  /* a mesma chave já tinha CRIADO (resposta perdida e reenviada): vale o criado de antes */
  c = await cena(); c.marca('S3', true); await c.els.pcLancar.click(); await c.fim(); c.escolhe('501'); await c.els.pcConferir.click(); await c.fim();
  c.criar = () => ({ ok: false, repetido: true, anterior: { ok: true, id: '77', numero: 31, resumo: RESUMO } }); await c.els.pcCriar.click(); await c.fim();
  assert.ok(/Pedido de Compra nº <b>31<\/b> criado no Bling/.test(c.info()) && c.els.pcSel.textContent === 'nenhum item marcado' && c.obs.plano === 2);

  /* ── falha ao ler os fornecedores: diz o motivo e não deixa conferir; fechar e abrir tenta de novo ── */
  for (const [resp, texto] of [[() => ({ ok: false, erro: 'o Bling <não> respondeu' }), 'o Bling &lt;não&gt; respondeu'], [() => ({ error: 'not found' }), 'not found'], [() => ({ ok: true }), 'não consegui ler os fornecedores do Bling'], [() => new Error('rede'), 'não consegui falar com o servidor']]) {
    c = await cena(); c.marca('S3', true); c.forn = resp;
    await c.els.pcLancar.click(); await c.fim();
    assert.deepStrictEqual([c.info(), c.els.pcForn.innerHTML, c.els.pcForn.disabled, c.estado()], ['<span style="color:#f87171">⚠️ ' + texto + '</span>', '<option value="">—</option>', true, [false, true, true]]);
    const n = c.obs.pedidos.length; await c.els.pcConferir.click(); await c.fim(); assert.strictEqual(c.obs.pedidos.length, n, 'sem fornecedores, conferir não envia');
    c.forn = () => ({ ok: true, fornecedores: FORN, incompleto: true });
    await c.els.pcLancar.click(); assert.strictEqual(c.els.pcLancarBox.style.display, 'none', 'o mesmo botão fecha');
    await c.els.pcLancar.click(); await c.fim();
    assert.ok(c.els.pcLancarBox.style.display === '' && c.estado()[1] === false && /a lista pode estar incompleta: há fornecedores demais no Bling/.test(c.info()), 'abrir de novo relê');
  }
  /* fechar zera a conferência; abrir de novo exige conferir */
  c = await cena(); c.marca('S3', true); await c.els.pcLancar.click(); await c.fim(); c.escolhe('501'); await c.els.pcConferir.click(); await c.fim();
  assert.strictEqual(c.estado()[2], false);
  c.els.pcLancarFechar.click(); assert.deepStrictEqual([c.els.pcLancarBox.style.display, c.estado()], ['none', [false, true, true]]);
  await c.els.pcLancar.click(); await c.fim(); c.escolhe('501'); assert.deepStrictEqual(c.estado(), [false, false, true]);
  /* com a caixa aberta, desmarcar tudo desliga conferir (mas o botão segue ligado pra fechar) */
  c.marca('S3', false); assert.deepStrictEqual(c.estado(), [false, true, true]);

  terminou = true; process.exitCode = 0;
  console.log('ok — Plano de Compra, lançar no Bling: a caixa abre com os fornecedores; conferir manda o ensaio do que está na tela; só o que foi conferido pode ser criado (qualquer mexida pede conferir de novo); criar vai com a chave e sem clique em dobro; criado desmarca e recalcula; recusado mostra o que o Bling disse; "não sei" trava até o dono liberar, com chave nova');
})().catch((e) => { console.log('FALHOU:', e && e.stack || e); process.exitCode = 1; });
