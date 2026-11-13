'use strict';
/* 11/11 (plano multiloja, Fase 3 item 5) — A SINCRONIZAÇÃO DE CUSTO VIROU PEÇA ÚNICA (lib/checkout/custo-sync.js).
   O `custoSync` era igual, linha a linha, no arquivo da Girassol e no da AMB (236 linhas; só o nome da empresa mudava).
   Prova:
   1) o corpo da peça é BYTE A BYTE o que os dois arquivos tinham (guardado em scripts/fixtures) — mover não é reescrever;
   2) Girassol e AMB não têm mais o corpo: montam a peça com a empresa certa e entregam TODAS as peças que ela pede, por
      acessor (lidas a cada rodada), e `custoSync` continua existindo com o mesmo nome (quem chama não muda);
   3) a peça recusa montagem sem empresa ou sem alguma peça — dizendo qual; e lê o que é da empresa A CADA RODADA (não na
      montagem): rodando duas vezes com a peça trocada no meio, a segunda rodada usa a nova;
   4) a rodada usa a EMPRESA da montagem pra falar com o banco (o nome não fica escrito à mão). */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const raiz = path.join(__dirname, '..');
const pecaSrc = fs.readFileSync(path.join(raiz, 'lib', 'checkout', 'custo-sync.js'), 'utf8');
const antes = fs.readFileSync(path.join(__dirname, 'fixtures', 'custo-sync-corpo-antes.txt'), 'utf8');
const { criar, PECAS } = require('../lib/checkout/custo-sync');

/* 1) o corpo */
const ini = pecaSrc.indexOf('    const { ' + PECAS.join(', ') + ' } = G;\n');
assert.ok(ini > 0, 'a peça tem que ler o que é da empresa a cada rodada (desestruturando DENTRO da função)');
const corpo = pecaSrc.slice(ini + ('    const { ' + PECAS.join(', ') + ' } = G;\n').length, pecaSrc.lastIndexOf('};\n}\n\nmodule.exports'));
/* 13/11 — a GOOD entra na peça nivelando por cima: os três comportamentos que só ela tinha viraram OPÇÕES, e três melhorias
   valem pra todas (a falha que diz "busca inconclusiva", o cadastro excluído contado como resolvido e a contagem devolvida no fim). São mudanças de propósito; cada
   uma está registrada aqui — o trecho novo tem que aparecer UMA vez e, desfeito, o corpo volta a ser o de antes, byte a
   byte. Sem as opções declaradas (Girassol e AMB), nenhum desses trechos muda o que a rodada faz. */
const TROCAS_13_11 = [
  ["  if (HIST_DO_ARQUIVO) {\n    try {\n      const _hs = readJson(path.join(CACHE_DIR, '_hist_skus.json'), null);\n      /* como a GOOD fazia: quando o de-para aposenta um SKU, só o DESTINO entra (não se pergunta ao Bling pelo antigo) */\n      if (_hs && Array.isArray(_hs.skus)) for (const sk of _hs.skus) { if (!sk) continue; const _orig = String(sk).trim(); const _dest = resolverDeParaSku(_orig); todos.add(_dest ? String(_dest).trim() : _orig); }\n    } catch (e) {}\n  }\n  try {\n    const { url: uH, key: kH } = supaCfg(EMPRESA);\n    if (uH && kH && !HIST_DO_ARQUIVO) {",
   "  try {\n    const { url: uH, key: kH } = supaCfg(EMPRESA);\n    if (uH && kH) {"],
  ["return fresh || !k || !k.id || (SELETOR != null && k.sel !== SELETOR) || (Date.now() - (k.ts || 0)) > SETE_D || k.custo == null; });",
   "return fresh || !k || !k.id || (Date.now() - (k.ts || 0)) > SETE_D || k.custo == null; });"],
  ["          if (pref) c = (FORNECEDOR_ESTRITO ? [pref.precoCusto, pref.precoCompra] : [pref.precoCusto, pref.precoCompra, pref.preco, pref.custo, pref.valor, pref.valorCusto])\n                        .map(Number).filter(v => isFinite(v) && v > 0);\n          if (!FORNECEDOR_ESTRITO && !c.length && arr.length) {",
   "          if (pref) c = [pref.precoCusto, pref.precoCompra, pref.preco, pref.custo, pref.valor, pref.valorCusto]\n                        .map(Number).filter(v => isFinite(v) && v > 0);\n          if (!c.length && arr.length) {"],
  ["custo: _custoFinal, ts: _tsFinal }, SELETOR != null ? { sel: SELETOR } : {}, _compsFinais && _compsFinais.length ? { comps: _compsFinais } : {});",
   "custo: _custoFinal, ts: _tsFinal }, _compsFinais && _compsFinais.length ? { comps: _compsFinais } : {});"],
  ["      } else if (_res && _res.todosExcluidos) {\n        /* 13/11 (nivelando pela GOOD): \"só havia cadastro excluído\" foi TRATADO ali em cima (a lápide) — é resposta conclusiva,\n           não falha. Contado como falha, o produto apagado acendia o alarme de custo e fazia a rotina das 23h achar que a\n           releitura tinha falhado (ela re-tenta até 3 vezes quando há falha). */\n        _cst.ok++;\n      } else { _cst.falhas++; _anotarFalhaCusto(sku, (_res && _res.inconclusivo) ? ('busca inconclusiva — ' + _res.motivo) : 'o Bling não devolveu o produto (resposta sem dados)'); }",
   "      } else { _cst.falhas++; _anotarFalhaCusto(sku, 'o Bling não devolveu o produto (resposta sem dados)'); }"],
  ["  return alvos.filter(sk => { const k = cc[sk]; return !(k && (k.apagado_em || Number(k.custo) > 0)); }).length;   /* quantos alvos seguem sem custo */\n", ""],
  /* 13/11 (passo 2, ainda nivelando pela GOOD): a resposta NULA do detalhe do produto cai no resumo em vez de estourar */
  ["        prod = (d && d.ok && d.data && d.data.data) || _res.produto;   /* 13/11 (como na GOOD): resposta NULA do Bling cai no resumo, em vez de estourar aqui e virar \"falha\" com mensagem de erro de programa */",
   "        prod = (d.ok && d.data && d.data.data) || _res.produto;"],
];
let corpoDeAntes = corpo;
for (const [nova, velha] of TROCAS_13_11) { assert.strictEqual(corpoDeAntes.split(nova).length, 2, 'troca registrada não está na peça (uma vez): ' + nova.slice(0, 70)); corpoDeAntes = corpoDeAntes.replace(nova, velha); }
assert.strictEqual(corpoDeAntes, antes.replace(/^\n/, ''), 'fora das trocas registradas, o corpo da peça tem que ser o que a Girassol e a AMB tinham (mover não é reescrever)');
/* as opções nascem desligadas: quem não as declara roda como antes */
assert.ok(/const SELETOR = G\.seletor \? String\(G\.seletor\) : null;/.test(pecaSrc) && /const FORNECEDOR_ESTRITO = !!G\.fornecedorEstrito;/.test(pecaSrc) && /const HIST_DO_ARQUIVO = !!G\.histSkusDoArquivo;/.test(pecaSrc), 'as três opções têm que nascer desligadas');
for (const arq of ['girassol-backup-offline/gbo-app.js', 'amb-checkout-offline/index.js']) { const sE = fs.readFileSync(path.join(raiz, arq), 'utf8'); const iE = sE.indexOf("require('../lib/checkout/custo-sync').criar({"); assert.ok(!/seletor:|fornecedorEstrito:|histSkusDoArquivo:/.test(sE.slice(iE, sE.indexOf('});', iE))), arq + ': a Girassol e a AMB não declaram as opções da GOOD'); }
/* 13/11 (passo 2): a GOOD monta a MESMA peça, declarando as três opções dela, entregando TODAS as peças (com os nomes que o
   arquivo dela usa) — e a cópia de 185 linhas saiu */
{ const sG = fs.readFileSync(path.join(raiz, 'good-checkout-offline/index.js'), 'utf8');
  const iG = sG.indexOf("require('../lib/checkout/custo-sync').criar({"); assert.ok(iG > 0, 'a GOOD não monta a peça do custo');
  const blocoG = sG.slice(iG, sG.indexOf('});', iG));
  assert.ok(/empresa: 'good',/.test(blocoG) && /seletor: 'ativo-v1',/.test(blocoG) && /fornecedorEstrito: true,/.test(blocoG) && /histSkusDoArquivo: true,/.test(blocoG), 'a GOOD tem que montar com a empresa dela e as três opções dela');
  for (const n of PECAS) assert.ok(new RegExp('get ' + n + '\\(\\) \\{ return ').test(blocoG), 'good-checkout-offline/index.js: não entrega ' + n + ' à peça (por acessor)');
  assert.ok(/get _histCache\(\) \{ return _histCacheGood; \}/.test(blocoG) && /get _limparSkuInfo\(\) \{ return \(sku\) => \{ try \{ _produtoAtivo\._limparSkuInfo\(sku\); \} catch \(e\) \{\} \}; \}/.test(blocoG) && /get supaCfg\(\) \{ return \(empresa\) => _supaGood\.cfg\(empresa\); \}/.test(blocoG), 'as três peças que na GOOD têm outro nome têm que ser as DELA (o cache do histórico, o limpador do sku-info e o banco)');
  assert.ok(/async function custoSync\(fresh\) \{ return _custoSyncPeca\(fresh\); \}/.test(sG) && sG.split('[CUSTO] sync concluiu').length === 1 && !/const SEL_ATUAL = /.test(sG), 'good-checkout-offline/index.js: sobrou o corpo antigo do custoSync');
  assert.ok(/const _sobrou = await custoSync\(fresh\);/.test(sG) && /return alvos\.filter\(sk => \{ const k = cc\[sk\]; return !\(k && \(k\.apagado_em \|\| Number\(k\.custo\) > 0\)\); \}\)\.length;/.test(pecaSrc), 'a rotina travada da GOOD usa o número que a rodada devolve — a peça tem que devolvê-lo'); }
assert.ok(!/'girassol'|'amb'|eq\.girassol|eq\.amb/.test(corpo) && /supaCfg\(EMPRESA\)/.test(corpo) && /empresa=eq\.' \+ EMPRESA \+ '&data_venda/.test(corpo), 'o nome da empresa não pode ficar escrito à mão no corpo');

/* 2) as duas empresas */
for (const [arq, emp] of [['girassol-backup-offline/gbo-app.js', 'girassol'], ['amb-checkout-offline/index.js', 'amb']]) {
  const s = fs.readFileSync(path.join(raiz, arq), 'utf8');
  const i = s.indexOf("require('../lib/checkout/custo-sync').criar({"); assert.ok(i > 0, arq + ': não monta a peça do custo');
  const bloco = s.slice(i, s.indexOf('});', i));
  assert.ok(new RegExp("empresa: '" + emp + "',").test(bloco), arq + ': tem que montar com a empresa DELA');
  for (const n of PECAS) assert.ok(bloco.includes('get ' + n + '() { return ' + n + '; }'), arq + ': não entrega ' + n + ' à peça (por acessor)');
  assert.ok(/async function custoSync\(fresh\) \{ return _custoSyncPeca\(fresh\); \}/.test(s), arq + ': `custoSync` tem que continuar existindo com o mesmo nome');
  assert.ok(!s.includes("const CUSTO_FILE = path.join(CACHE_DIR, '_custos.json');\n  /* 23/08") && s.split('[CUSTO] sync concluiu').length === 1, arq + ': sobrou o corpo antigo do custoSync');
}

/* 3) e 4) a peça de verdade, com peças de mentira */
(async () => {
  assert.throws(() => criar({}), /falta empresa/);
  assert.throws(() => criar({ empresa: 'x' }), /falta CACHE_DIR/);
  const vistos = [];
  let cst = { rodando: true };   /* "já tem uma rodada": a função sai na primeira linha — sem rede nem disco */
  const G = { empresa: 'quarta' };
  for (const n of PECAS) Object.defineProperty(G, n, { enumerable: true, get() { vistos.push(n); return n === '_cst' ? cst : undefined; } });
  const fn = criar(G);
  assert.strictEqual(vistos.length, 0, 'montar a peça não pode LER as peças da empresa (a ordem do arquivo dela não pode importar)');
  await fn(false);
  assert.ok(vistos.includes('_cst') && vistos.includes('blingGet'), 'a rodada tinha que ler as peças na hora');
  const n1 = vistos.length; cst = { rodando: true, trocado: 1 }; await fn(false);
  assert.ok(vistos.length === n1 * 2, 'a segunda rodada tinha que ler as peças DE NOVO (nada de valor guardado da primeira)');
  console.log('ok — custo-sync em peça única: o corpo é o de antes (byte a byte), Girassol e AMB montam com a empresa e as peças delas, e a peça lê o que é da empresa a cada rodada');
})().catch((e) => { console.error('FALHOU:', e && e.message); process.exit(1); });
