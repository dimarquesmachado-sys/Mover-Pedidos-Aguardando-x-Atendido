'use strict';
/* 17/09 — PORTE achado ao classificar a `/sku-info`. A AMB e a Girassol pedem 10 cadastros ao
   Bling e escolhem o ATIVO (`escolherProdutoAtivo`, conserto de 19/08); a GOOD pedia
   `limite=1` e ficava com o PRIMEIRO que viesse.

   Se um SKU tem cadastro antigo EXCLUÍDO no Bling, a GOOD lia o custo dele. E custo errado
   vira MARGEM ERRADA no dashboard — que é pior que margem ausente, porque ninguém desconfia
   de um número plausível. Eram DOIS pontos, não um: o /sku-info e a rotina irmã.

   r4 — Codex apontou, em três rodadas, buracos numa cópia inline do laço de variantes de caixa
   que cada empresa reimplementava sozinha nos DOIS call-sites (sku-info e custo-sync): um
   cadastro sem `situacao` na 1ª variante travava o laço como se fosse ATIVO (a variante seguinte,
   com o ativo de verdade, nunca era tentada), e se o detalhe da reserva falhasse o produto virava
   `null` em vez de manter a reserva. Cada correção fechava a cópia apontada sem tocar as outras
   cinco (2 call-sites × 3 empresas) — exatamente o tipo de duplicação que este arquivo já existe
   para vigiar. A resposta foi parar de reimplementar: as seis cópias agora chamam
   resolverProdutoPorSku (lib/checkout/produto-ativo.js), que já tratava esses casos e cujo
   comportamento este arquivo passa a testar diretamente. */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const raiz = path.join(__dirname, '..');
const { criar } = require('../lib/checkout/produto-ativo');

/* 1. As TRÊS empresas usam resolverProdutoPorSku nos DOIS call-sites (sku-info e custo-sync) —
   nenhuma reimplementa o laço de variantes de caixa por conta própria, e nenhuma pede limite=1 */
const MODULOS = {
  amb: 'amb-checkout-offline/index.js',
  girassol: 'girassol-backup-offline/gbo-app.js',
  good: 'good-checkout-offline/index.js',
};
for (const [emp, arq] of Object.entries(MODULOS)) {
  const s = fs.readFileSync(path.join(raiz, arq), 'utf8');
  const codigo = s.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n');

  const usosResolver = (codigo.match(/resolverProdutoPorSku\(sku,/g) || []).length;
  assert.strictEqual(usosResolver, 2,
    emp + ': esperava 2 usos de resolverProdutoPorSku (sku-info + custo-sync), achei ' + usosResolver +
    ' — um call-site pode ter voltado a reimplementar o laço de variantes de caixa por conta própria');

  // Codex #497 (P2, r3): reimplementar o laço na empresa (em vez de usar o resolvedor) foi
  // exatamente como o bug do "status-less vira ativo" e o do "reserva perdida" se espalharam.
  assert.ok(!/escolherProdutoAtivo\(/.test(codigo),
    emp + ': chama escolherProdutoAtivo diretamente — a busca por SKU tem que passar por resolverProdutoPorSku, ' +
    'que trata reserva/inconclusivo/falha; chamar o seletor sozinho reabre os bugs já corrigidos ali');

  assert.ok(!/limite=1&criterio=5/.test(codigo),
    emp + ': ainda pede `limite=1` na busca por código — com um só resultado não há o que escolher, ' +
    'e se ele for o cadastro excluído o custo sai errado sem erro nenhum');

  // Codex #497 (P2, r3): "Retain the reserve when its detail request fails" — se o /produtos/{id}
  // do produto resolvido falhar, tem que sobrar o resultado da BUSCA (com id, saldo, nome), não null.
  const usosComFallback = (codigo.match(/\|\| _res\.produto;/g) || []).length;
  assert.strictEqual(usosComFallback, 2,
    emp + ': o detalhe do produto resolvido tem que cair de volta pro resultado da busca (_res.produto) ' +
    'se a consulta de detalhe falhar — sem isso, uma falha de rede depois de já ter achado o cadastro certo apaga saldo/preço/custo à toa');
}

/* 2. Codex #497 (P1 e P2) — o conserto tem que alcançar o DADO JÁ GRAVADO pela lógica antiga */
{
  const s = fs.readFileSync(path.join(raiz, 'good-checkout-offline/index.js'), 'utf8');

  /* P1: o filtro do custo-sync tem que revalidar o que o seletor ANTIGO gravou. Sem isso, os
     SKUs com custo do cadastro excluído ficariam 7 dias intocados — o conserto não alcançaria
     justamente o dado errado que existe pra corrigir. */
  assert.ok(/k\.sel !== SEL_ATUAL/.test(s),
    'o filtro do custo-sync não revalida o que a lógica antiga gravou — o dado errado sobrevive 7 dias');
  assert.ok(/sel: SEL_ATUAL/.test(s),
    'a gravação não carimba o seletor — sem a marca, ou revalida pra sempre ou nunca corrige o legado');

  /* P1: consulta concluindo "todos excluídos" NÃO pode restaurar o custo em cache: ele veio do
     cadastro excluído. Isso é diferente de consulta que FALHOU, onde o cache é a proteção certa.
     r4: a distinção falha×inconclusivo×excluído agora vive dentro de resolverProdutoPorSku
     (testada na seção 3, abaixo); aqui só resta conferir que o call-site usa o veredito dela. */
  assert.ok(/_soExcluidos \? null : _custoLib\.custoDeSku/.test(s),
    'com todos os cadastros excluídos, o custo em cache seria restaurado — é o dado ruim voltando');
  assert.ok(/_soExcluidos = !!_res\.todosExcluidos/.test(s),
    'o descarte do custo em cache não está usando o veredito todosExcluidos do resolvedor compartilhado');
  assert.ok(/\} else if \(_res\.todosExcluidos\) \{/.test(s),
    'o custo-sync não usa o veredito todosExcluidos do resolvedor compartilhado pra apagar o custo permanente');

  /* P2: id novo invalida o sku-info, senão saldo e preço continuam vindo do cadastro velho */
  assert.ok(/_limparSkuInfo\(sku\)/.test(s), 'trocou o id e não invalidou o sku-info em cache');

  /* P1 (r2): a /sku-info descarta o custo em cache quando conclui "só excluído", mas quem
     POPULA `_custos.json` é o custo-sync — sem apagar `cc[sku]` também aqui, o custo do
     cadastro apagado sobrevive indefinidamente nesse cache (o "sister cost-sync path" que o
     Codex apontou). Tem que virar lápide, e a lápide tem que ter grace no filtro de alvos
     (senão bate o Bling de novo a cada rodada pro mesmo SKU já confirmado apagado). */
  assert.ok(/apagado_em: Date\.now\(\)/.test(s),
    'custo-sync não apaga/tumba cc[sku] quando conclui que só há cadastro excluído — sobrevive indefinidamente no cache permanente');
  assert.ok(/k\.apagado_em/.test(s),
    'o filtro de alvos não conhece a lápide — sem grace, bate o Bling de novo a cada rodada pro mesmo SKU confirmado apagado');
}

/* 3. resolverProdutoPorSku — a função que as SEIS cópias (2 call-sites × 3 empresas) usam agora */
function libProdutoAtivo() {
  let cache = {};
  return criar({
    CACHE_DIR: '/tmp', readJson: () => ({}), writeJson: () => {},
    lerSkuInfoCache: () => cache, gravarSkuInfoCache: (v) => { cache = v; },
  });
}
// fila de respostas: uma por variante de caixa tentada, na ordem em que resolverProdutoPorSku pede
function filaBuscar(respostas) {
  let i = 0;
  return async () => (i < respostas.length ? respostas[i++] : { ok: true, data: { data: [] } });
}
const okData = arr => ({ ok: true, data: { data: arr } });

(async () => {
  const { resolverProdutoPorSku } = libProdutoAtivo();
  const excluido = { id: 1, situacao: 'E', codigo: 'X' };
  const ativo = { id: 2, situacao: 'A', codigo: 'X' };
  const semStatus = { id: 3, codigo: 'X' };   // sem `situacao`: nem excluído, nem confirmadamente ativo

  // a) excluído e ativo na mesma página: escolhe o ativo, nunca o excluído
  {
    const r = await resolverProdutoPorSku('X', filaBuscar([okData([excluido, ativo])]), 10);
    assert.ok(r.produto && r.produto.id === 2, 'tinha um ATIVO na página e não escolheu ele');
    assert.strictEqual(r.ativo, true);
  }

  // b) só excluído em TODAS as variantes: produto nulo, todosExcluidos, não inconclusivo
  {
    const r = await resolverProdutoPorSku('X', filaBuscar([okData([excluido]), okData([excluido]), okData([excluido])]), 10);
    assert.strictEqual(r.produto, null, 'só havia excluído e ainda assim devolveu produto');
    assert.strictEqual(r.todosExcluidos, true, 'todas as variantes só tinham excluído — tinha que concluir todosExcluidos');
    assert.strictEqual(r.inconclusivo, false);
  }

  // c) Codex #497 (P2, r3): 1ª variante devolve um cadastro SEM `situacao` (viraria reserva), a
  // 2ª devolve o ATIVO de verdade — o ativo da variante seguinte tem que vencer, não a reserva
  // travando o laço na 1ª. É o bug que "Treat status-less matches as reserves" apontou.
  {
    const r = await resolverProdutoPorSku('X', filaBuscar([okData([semStatus]), okData([ativo])]), 10);
    assert.ok(r.produto && r.produto.id === 2,
      'um cadastro sem situacao na 1ª variante engoliu o ativo da 2ª variante — a reserva não pode travar o laço');
    assert.strictEqual(r.ativo, true);
  }

  // d) Codex #497 (P1, r2): uma variante FALHA (429/timeout) enquanto outra confirma só excluído
  // — a falha não pode virar "confirmado apagado" (o ativo podia estar bem ali, na que falhou)
  {
    const r = await resolverProdutoPorSku('X', filaBuscar([{ ok: false }, okData([excluido]), okData([excluido])]), 10);
    assert.strictEqual(r.inconclusivo, true, 'uma busca falhou e o resultado não ficou inconclusivo');
    assert.strictEqual(r.todosExcluidos, false, 'busca falhou em uma variante, mas ainda assim concluiu todosExcluidos');
  }

  // e) página cheia (>= limite pedido): pode haver ativo fora dela — inconclusivo, nada se apaga
  {
    const r = await resolverProdutoPorSku('X', filaBuscar([okData([excluido, excluido, excluido])]), 3);
    assert.strictEqual(r.inconclusivo, true, 'página veio cheia (pode haver mais cadastros fora dela) e não marcou inconclusivo');
  }

  // f) Codex #497 (P2, r3/#186): nenhuma variante traz ATIVO, mas uma traz reserva (sem situacao ou
  // inativo) — a reserva tem que ser o último recurso, não simplesmente perdida
  {
    const r = await resolverProdutoPorSku('X', filaBuscar([okData([semStatus]), okData([]), okData([])]), 10);
    assert.ok(r.produto && r.produto.id === 3, 'guardou a reserva e não a usou — SKU só com cadastro sem status ficaria sem custo');
    assert.strictEqual(r.ativo, false);
  }

  console.log('OK: produto ativo — resolverProdutoPorSku trata reserva/status-less/falha/página-cheia, e as três empresas usam o mesmo resolvedor nos dois call-sites, sem limite=1');
})().catch(e => { console.error(e); process.exit(1); });
