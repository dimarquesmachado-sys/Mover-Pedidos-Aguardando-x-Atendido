'use strict';
/* 13/11 — A GOOD ENTRA NA PEÇA DO CUSTO, NIVELANDO POR CIMA (lib/checkout/custo-sync.js; plano multiloja, Fase 3 item 5).
   A versão da GOOD tinha comportamentos que a peça (Girassol e AMB) não tinha, e vice-versa. Os três que são escolha da
   empresa viraram OPÇÕES; os que eram simplesmente melhores valem pra todas. Aqui a rodada roda DE VERDADE (a função de
   produção, com o Bling, o banco e o disco de mentira) e prova:
   SEM as opções (Girassol e AMB, como sempre):
   · os SKUs do histórico vêm do banco de vendas; o `_hist_skus.json` não é lido;
   · do fornecedor vale a lista larga de campos (inclusive o palpite por nome de campo);
   · nada de marca de seletor no custo gravado, e custo fresco não é relido.
   COM as opções (a GOOD):
   · `histSkusDoArquivo` — os SKUs vêm do `_hist_skus.json`, o banco NÃO é consultado, e SKU aposentado pelo de-para vira o
     destino (não se pergunta ao Bling pelo antigo);
   · `fornecedorEstrito` — só `precoCusto`/`precoCompra`; um fornecedor que só tem `preco` NÃO vira custo;
   · `seletor` — o custo gravado leva a marca, e o que foi gravado por outro seletor é relido mesmo fresco.
   PRA TODAS (como já era na GOOD):
   · produto que só tem cadastro excluído: lápide, conta como RESOLVIDO — sem falha e sem alarme;
   · busca inconclusiva: é falha, e a anotação diz "busca inconclusiva" com o motivo;
   · a rodada devolve quantos alvos seguem sem custo; o cache do histórico é limpo no fim. */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { criar, PECAS } = require('../lib/checkout/custo-sync');

function ambiente(o) {
  o = o || {};
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'custo-sync-op-'));
  const arq = (n) => path.join(dir, n);
  const gravar = (n, j) => fs.writeFileSync(arq(n), JSON.stringify(j));
  gravar('conferidos.json', { p1: { itens: (o.conferidos || ['A1']).map((sku) => ({ sku })) } });
  gravar('_custos.json', o.custos || {});
  if (o.vendasDia) gravar('_vendas_dia.json', { v1: { it: o.vendasDia.map((sku) => ({ sku })) } });
  if (o.histSkus) gravar('_hist_skus.json', { skus: o.histSkus });
  const produtos = o.produtos || {};          /* sku -> { id, fornecedores: [...] } */
  const porId = {}; for (const k of Object.keys(produtos)) porId[produtos[k].id] = Object.assign({ codigo: k }, produtos[k]);
  const ch = { bling: [], falhas: [], limpou: [], vig: [], supa: 0 };
  const cst = {}, histCache = { 'amb|a|b': 1, 'amb|c|d': 2 };
  const pecas = {
    CACHE_DIR: dir, CONFERIDOS_FILE: arq('conferidos.json'), _cst: cst, _histCache: histCache,
    _anotarFalhaCusto: (sku, m) => ch.falhas.push([sku, m]),
    _custoComp: require('../lib/custo-composicao'),
    _limparSkuInfo: (sku) => ch.limpou.push(sku),
    blingGet: async (p) => {
      ch.bling.push(p);
      let m = /^\/produtos\/(\d+)$/.exec(p);
      if (m) { const pr = porId[m[1]]; return pr ? { ok: true, data: { data: { id: pr.id, codigo: pr.codigo, preco: 50 } } } : { ok: false, status: 404 }; }
      m = /^\/produtos\/fornecedores\?idProduto=(\d+)/.exec(p);
      if (m) { const pr = porId[m[1]]; return { ok: true, data: { data: (pr && pr.fornecedores) || [] } }; }
      return { ok: false, status: 404 };
    },
    readJson: (f, pad) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return pad; } },
    writeJson: (f, j) => fs.writeFileSync(f, JSON.stringify(j)),
    registrarCustoVigente: (sku, c, origem) => ch.vig.push([sku, c, origem]),
    resolverDeParaSku: (sku) => (o.depara || {})[sku] || null,
    resolverProdutoPorSku: async (sku) => ((o.resolver || {})[sku]) || (produtos[sku] ? { produto: { id: produtos[sku].id } } : { produto: null }),
    supaCfg: () => ({ url: o.banco ? 'http://banco' : '', key: o.banco ? 'k' : '' }),
    travaPesada: { renovar() {} },
  };
  const G = Object.assign({ empresa: 'teste' }, o.opcoes || {});
  for (const n of PECAS) { assert.ok(n in pecas, 'o teste não tem a peça ' + n); Object.defineProperty(G, n, { enumerable: true, get() { return pecas[n]; } }); }
  const fn = criar(G);
  return { ch, cst, histCache, custos: () => JSON.parse(fs.readFileSync(arq('_custos.json'), 'utf8')),
    rodar: async (fresh) => {
      const fAntes = global.fetch, tAntes = global.setTimeout;
      global.setTimeout = (f, ms) => tAntes(f, ms >= 200 ? 1 : ms);   /* a "tartaruga" não segura o teste */
      global.fetch = async (u) => { ch.supa++; return { ok: true, json: async () => (/offset=0(&|$)/.test(String(u)) ? (o.banco || []).map((sku) => ({ sku })) : []) }; };
      try { return await fn(!!fresh); } finally { global.fetch = fAntes; global.setTimeout = tAntes; }
    } };
}
const pediuProduto = (e, id) => e.ch.bling.some((p) => p === '/produtos/' + id);
const OPCOES_GOOD = { seletor: 'ativo-v1', fornecedorEstrito: true, histSkusDoArquivo: true };

(async () => {
  /* ── SEM as opções: Girassol e AMB, como sempre ── */
  let e = ambiente({ conferidos: ['A1'], vendasDia: ['V1'], banco: ['B1'], histSkus: ['SOARQUIVO'],
    produtos: { A1: { id: 11, fornecedores: [{ padrao: true, precoCusto: 5 }] }, V1: { id: 12, fornecedores: [{ padrao: true, preco: 9 }] }, B1: { id: 13, fornecedores: [{ padrao: true, precoCompra: 7 }] }, SOARQUIVO: { id: 14, fornecedores: [{ precoCusto: 1 }] } } });
  let sobrou = await e.rodar(false);
  let cc = e.custos();
  assert.ok(e.ch.supa >= 1 && cc.B1 && cc.B1.custo === 7, 'sem a opção, os SKUs do histórico vêm do BANCO de vendas: ' + JSON.stringify([e.ch.supa, cc.B1]));
  assert.ok(!cc.SOARQUIVO && !pediuProduto(e, 14), 'sem a opção, o _hist_skus.json não é lido');
  assert.ok(cc.A1.custo === 5 && cc.V1.custo === 9, 'sem a opção, a lista larga de campos do fornecedor vale (o `preco` virou custo): ' + JSON.stringify(cc.V1));
  assert.ok(!('sel' in cc.A1), 'sem a opção, nada de marca de seletor no custo gravado');
  assert.ok(sobrou === 0 && e.cst.ok === 3 && e.cst.falhas === 0 && e.cst.rodando === false && Object.keys(e.histCache).length === 0, 'a rodada devolve quantos seguem sem custo (0) e limpa o cache do histórico: ' + JSON.stringify([sobrou, e.cst.ok, e.cst.falhas]));
  assert.deepStrictEqual(e.ch.vig.map((v) => v[0] + '=' + v[1]).sort(), ['A1=5', 'B1=7', 'V1=9'], 'cada custo novo entra na linha do tempo');
  /* custo fresco (lido agora) não é relido sem a opção do seletor, mesmo com marca "de outro seletor" */
  e = ambiente({ conferidos: ['A1'], custos: { A1: { id: 11, custo: 3, ts: Date.now(), sel: 'antigo' } }, produtos: { A1: { id: 11, fornecedores: [{ precoCusto: 5 }] } } });
  await e.rodar(false);
  assert.ok(!pediuProduto(e, 11) && e.custos().A1.custo === 3, 'sem a opção, custo fresco não é relido');

  /* ── COM as opções: a GOOD ── */
  e = ambiente({ opcoes: OPCOES_GOOD, conferidos: ['A1'], banco: ['B1'], histSkus: ['H1', 'VELHO', '', 'SOPRECO'], depara: { VELHO: 'NOVO' },
    produtos: { A1: { id: 11, fornecedores: [{ padrao: true, precoCusto: 5 }] }, H1: { id: 21, fornecedores: [{ padrao: true, precoCompra: 4 }] }, NOVO: { id: 22, fornecedores: [{ precoCusto: 6 }] }, VELHO: { id: 23, fornecedores: [{ precoCusto: 99 }] },
      SOPRECO: { id: 24, fornecedores: [{ padrao: true, preco: 9, valor: 8 }] }, B1: { id: 13, fornecedores: [{ precoCusto: 7 }] } } });
  sobrou = await e.rodar(false); cc = e.custos();
  assert.ok(e.ch.supa === 0 && !cc.B1, 'com `histSkusDoArquivo`, o banco de vendas NÃO é consultado: ' + e.ch.supa);
  assert.ok(cc.H1 && cc.H1.custo === 4, 'com `histSkusDoArquivo`, os SKUs do _hist_skus.json entram');
  assert.ok(cc.NOVO && cc.NOVO.custo === 6 && !cc.VELHO && !pediuProduto(e, 23), 'SKU aposentado pelo de-para: só o DESTINO é perguntado ao Bling: ' + JSON.stringify(Object.keys(cc)));
  assert.ok(cc.SOPRECO && cc.SOPRECO.custo === null, 'com `fornecedorEstrito`, fornecedor que só tem `preco`/`valor` NÃO vira custo (número errado é pior que ausente): ' + JSON.stringify(cc.SOPRECO));
  assert.ok(cc.A1.sel === 'ativo-v1' && cc.H1.sel === 'ativo-v1' && cc.SOPRECO.sel === 'ativo-v1', 'com `seletor`, todo custo gravado leva a marca');
  assert.strictEqual(sobrou, 1, 'a rodada devolve quantos alvos seguem sem custo (o SOPRECO): ' + sobrou);
  /* gravado por OUTRO seletor: relido mesmo fresco; gravado pelo atual e fresco: não */
  e = ambiente({ opcoes: OPCOES_GOOD, conferidos: ['A1', 'A2'], custos: { A1: { id: 11, custo: 3, ts: Date.now(), sel: 'antigo' }, A2: { id: 12, custo: 8, ts: Date.now(), sel: 'ativo-v1' } },
    produtos: { A1: { id: 11, fornecedores: [{ precoCusto: 5 }] }, A2: { id: 12, fornecedores: [{ precoCusto: 1 }] } } });
  await e.rodar(false); cc = e.custos();
  assert.ok(pediuProduto(e, 11) && cc.A1.custo === 5 && cc.A1.sel === 'ativo-v1', 'custo gravado por outro seletor tem que ser relido, mesmo fresco: ' + JSON.stringify(cc.A1));
  assert.ok(!pediuProduto(e, 12) && cc.A2.custo === 8, 'custo do seletor atual e fresco não é relido');

  /* ── PRA TODAS ── */
  for (const opcoes of [{}, OPCOES_GOOD]) {
    /* só cadastro excluído: lápide, RESOLVIDO (não é falha, não gera alarme) */
    e = ambiente({ opcoes, conferidos: ['EXC', 'A1'], custos: { EXC: { id: 77, custo: 12, ts: 1 } }, resolver: { EXC: { produto: null, todosExcluidos: true } }, produtos: { A1: { id: 11, fornecedores: [{ precoCusto: 5 }] } } });
    sobrou = await e.rodar(false); cc = e.custos();
    assert.ok(cc.EXC && cc.EXC.apagado_em && cc.EXC.custo === undefined && e.ch.limpou.indexOf('EXC') !== -1, 'cadastro excluído vira lápide e limpa o outro cache: ' + JSON.stringify(cc.EXC));
    assert.ok(e.cst.ok === 2 && e.cst.falhas === 0 && e.ch.falhas.length === 0 && sobrou === 0, 'cadastro excluído é RESOLVIDO, não falha (' + JSON.stringify(opcoes) + '): ' + JSON.stringify([e.cst.ok, e.cst.falhas, e.ch.falhas, sobrou]));
    /* busca inconclusiva: falha, com o motivo; nada é apagado */
    e = ambiente({ opcoes, conferidos: ['INC'], custos: { INC: { id: 78, custo: 12, ts: 1 } }, resolver: { INC: { produto: null, inconclusivo: true, motivo: 'o Bling respondeu 429' } } });
    sobrou = await e.rodar(false); cc = e.custos();
    assert.ok(e.cst.falhas === 1 && e.ch.falhas.length === 1 && /^busca inconclusiva — o Bling respondeu 429$/.test(e.ch.falhas[0][1]) && cc.INC.custo === 12, 'busca inconclusiva é falha com o motivo, e não apaga o custo que havia: ' + JSON.stringify([e.ch.falhas, cc.INC]));
    /* o Bling não devolveu nada (sem ser inconclusivo): a anotação de sempre */
    e = ambiente({ opcoes, conferidos: ['NADA'] }); await e.rodar(false);
    assert.ok(e.cst.falhas === 1 && /o Bling não devolveu o produto/.test(e.ch.falhas[0][1]));
  }
  console.log('ok — custo-sync: as três opções da GOOD (seletor, fornecedor estrito, SKUs do arquivo) só valem pra quem as declara; cadastro excluído é resolvido e a falha inconclusiva diz o motivo, pra todas');
  process.exit(0);
})().catch((e) => { console.error('FALHOU:', e && e.message); process.exit(1); });
