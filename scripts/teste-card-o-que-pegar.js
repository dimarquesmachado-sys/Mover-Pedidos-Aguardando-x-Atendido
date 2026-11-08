'use strict';
/* 07/11 — O CARD DA LISTA MOSTRA O QUE O ESTOQUISTA PEGA (pedido do dono). O "SKU · 1 item(s)" contava LINHAS do pedido:
   o kit 30-AE-8F-125mm-KIT80 (3 lixas: g60, g80, g150) e o pendente LTJ30-CINZA-B ×2 apareciam "1 item(s)" e confundiam
   o estoquista. Prova:
   · a regra (lib/checkout/pick-pedido): kit vira os componentes (quantidade do componente), item normal com a quantidade,
     SKU repetido soma, SKU vazio fica de fora; total em unidades; os SKUs dos kits;
   · o CARD DE VERDADE (o trecho do painel-galpao.html, avaliado como o navegador avalia): os dois casos reais; e o pedido
     sem a lista (cache antigo) continua do jeito de antes ("1 item(s)");
   · a /lista (a rota de produção, peça comum) completa UMA vez o que pegar dos pedidos que já estavam no cache, lendo o
     pedido.json — e não lê de novo na próxima chamada. */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const raiz = path.join(__dirname, '..');
const { listaDoQuePegar } = require('../lib/checkout/pick-pedido');

const KIT = [{ sku: '30-AE-8F-125mm-KIT80', tipo: 'kit', qtd: 1, componentes: [
  { sku: '10-AE-8F-125mm-g60', qtd: 1 }, { sku: '10-AE-8F-125mm-g80', qtd: 1 }, { sku: '10-AE-8F-125mm-g150', qtd: 1 }] }];
const PENDENTE = [{ sku: 'LTJ30-CINZA-B', tipo: 'simples', qtd: 2 }];
let r = listaDoQuePegar(KIT);
assert.deepStrictEqual(r, { pick: [{ sku: '10-AE-8F-125mm-g60', qtd: 1 }, { sku: '10-AE-8F-125mm-g80', qtd: 1 }, { sku: '10-AE-8F-125mm-g150', qtd: 1 }], unidades: 3, kits: ['30-AE-8F-125mm-KIT80'] }, 'o kit tinha que virar as 3 lixas: ' + JSON.stringify(r));
r = listaDoQuePegar(PENDENTE);
assert.deepStrictEqual(r, { pick: [{ sku: 'LTJ30-CINZA-B', qtd: 2 }], unidades: 2, kits: [] });
r = listaDoQuePegar([{ sku: 'A', qtd: 1 }, { sku: 'B', tipo: 'kit', componentes: [{ sku: 'A', qtd: 2 }, { sku: '', qtd: 5 }] }, null, { sku: 'C' }]);
assert.deepStrictEqual(r.pick, [{ sku: 'A', qtd: 3 }, { sku: 'C', qtd: 1 }], 'SKU repetido soma (do item e do componente); SKU vazio fica de fora; sem quantidade conta 1');
assert.strictEqual(r.unidades, 4);

/* o card de verdade: os dois trechos do painel, avaliados com o esc() do painel */
const html = fs.readFileSync(path.join(raiz, 'lib', 'checkout', 'painel', 'painel-galpao.html'), 'utf8');
const i = html.indexOf('      (function(){\n        var pk=Array.isArray(p.pick)');
const j = html.indexOf("})()+' · NF '", i) + 4;
assert.ok(i > 0 && j > i, 'não achei o trecho do card no painel');
const trecho = html.slice(i, j).replace(/^\s*\/\*[\s\S]*?\*\/\s*/, '');
const iEsc = html.indexOf('const esc = s =>');   /* o esc() de verdade do painel */
assert.ok(iEsc > 0, 'não achei o esc() do painel');
const esc = html.slice(iEsc, html.indexOf('\n', iEsc));
const iQ = html.indexOf('const qtdHtml = q =>');   /* 08/11: a quantidade em destaque */
assert.ok(iQ > 0, 'não achei o qtdHtml do painel');
const qtdH = html.slice(iQ, html.indexOf('\n', iQ));
const card = (p) => vm.runInNewContext(esc + '\n' + qtdH + '\n(' + trecho.replace(/\+\s*$/, '') + ')', { p });
const kit = card(Object.assign({ skus: ['30-AE-8F-125mm-KIT80'], itens: 1 }, listaDoQuePegar(KIT)));
for (const s of ['🧩 kit 30-AE-8F-125mm-KIT80', '📦 <b>10-AE-8F-125mm-g60</b> <span class="sqtd">×1</span>', '📦 <b>10-AE-8F-125mm-g80</b> <span class="sqtd">×1</span>', '📦 <b>10-AE-8F-125mm-g150</b> <span class="sqtd">×1</span>', '<b class="sun">3 un</b>'])
  assert.ok(kit.includes(s), 'o card do kit não mostra "' + s + '": ' + kit);
assert.ok(!/item\(s\)/.test(kit), 'o card do kit ainda mostra "item(s)"');
const pend = card(Object.assign({ skus: ['LTJ30-CINZA-B'], itens: 1 }, listaDoQuePegar(PENDENTE)));
assert.ok(pend.includes('📦 <b>LTJ30-CINZA-B</b> <span class="sqtd sqtd-mais">×2</span>') && pend.includes('<b class="sun">2 un</b>') && !/item\(s\)/.test(pend), 'o card do pendente ×2 não mostra a quantidade em destaque (mais de 1 = etiqueta laranja): ' + pend);
const antigo = card({ skus: ['X1'], itens: 1 });
assert.ok(antigo.includes('📦 <b>X1</b> · ') && antigo.includes('1 item(s)'), 'pedido sem a lista (cache antigo) tinha que continuar como antes: ' + antigo);

/* a /lista de produção completa os pedidos antigos uma vez */
(async () => {
  const { criarRotasComuns, PECAS } = require('../lib/checkout/rotas-comuns');
  const o = { prefixo: '/x', tag: 'T', empresa: 'good' };
  for (const k of PECAS) o[k] = () => undefined;
  const man = { 900: { numero: 1, tem_etiqueta: true, cliente: 'Fulano', nf_numero: '1', nf_emissao: 'x', nf_id: 1, skus: ['30-AE-8F-125mm-KIT80'], itens: 1 } };
  let leituras = 0, salvou = 0, resp = null;
  Object.assign(o, {
    CACHE_DIR: '/c', CONFERIDOS_FILE: '/c/conf.json', manifest: () => man, salvarManifest: () => { salvou++; }, lerReservas: () => ({}),
    readJson: (f, d) => { if (/pedido\.json$/.test(f)) { leituras++; return { cliente: 'Fulano', nf: { numero: '1', dataEmissao: 'x', id: 1 }, itens: KIT }; } return d; },
    json: (res, code, body) => { resp = body; } });
  const R = criarRotasComuns(o);
  await R.handle({ method: 'GET', headers: {} }, {}, '/x/lista', 'GET', new URL('http://h/x/lista'));
  const p = (resp.pedidos || resp.prontos || resp.lista || []).find((x) => String(x.id) === '900') || (Array.isArray(resp) ? resp.find((x) => String(x.id) === '900') : null);
  assert.ok(p && Array.isArray(p.pick) && p.pick.length === 3 && p.unidades === 3 && p.kits[0] === '30-AE-8F-125mm-KIT80', 'a /lista não completou o que pegar do pedido antigo: ' + JSON.stringify(p || resp).slice(0, 300));
  assert.ok(leituras === 1 && salvou === 1, 'tinha que ler o pedido.json e gravar o manifesto uma vez');
  await R.handle({ method: 'GET', headers: {} }, {}, '/x/lista', 'GET', new URL('http://h/x/lista'));
  assert.strictEqual(leituras, 1, 'na segunda chamada não podia ler o pedido.json de novo (já completou)');
  /* Codex #806: pedido com a NF ANEXADA à mão (a data dela está no manifesto, o pedido.json ainda tem a da nota antiga):
     completar o que pegar NÃO pode regravar a data da NF (nem cliente/número/id) */
  man[901] = { numero: 2, tem_etiqueta: true, cliente: 'Ciclana', nf_numero: '999', nf_emissao: '2026-11-07T10:00:00', nf_id: 77, nf_anexada: true, skus: ['LTJ30-CINZA-B'], itens: 1 };
  o.readJson = (f, d) => { if (/pedido\.json$/.test(f)) { leituras++; return { cliente: 'Antiga', nf: { numero: '111', dataEmissao: '2026-11-01T08:00:00', id: 11 }, itens: PENDENTE }; } return d; };
  const R2 = criarRotasComuns(o);
  await R2.handle({ method: 'GET', headers: {} }, {}, '/x/lista', 'GET', new URL('http://h/x/lista'));
  assert.ok(man[901].nf_emissao === '2026-11-07T10:00:00' && man[901].nf_numero === '999' && man[901].nf_id === 77 && man[901].cliente === 'Ciclana', 'completar o que pegar regravou os dados da NF anexada: ' + JSON.stringify(man[901]));
  assert.ok(Array.isArray(man[901].pick) && man[901].pick[0].qtd === 2 && man[901].unidades === 2, 'o que pegar não foi completado no pedido com NF anexada');
  console.log('ok — o card da lista mostra o que pegar: o kit vira as 3 lixas (×1 cada, 3 un), o pendente ×2 (2 un); pedido antigo sem a lista continua como antes; a /lista completa os antigos uma vez');
  process.exit(0);
})().catch((e) => { console.error('FALHOU:', e.message); process.exit(1); });
