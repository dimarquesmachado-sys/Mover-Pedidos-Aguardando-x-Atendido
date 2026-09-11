'use strict';
/* ─────────────────────────────────────────────────────────────────────────────
   SKU → PRODUTO CERTO NO BLING — fatia 2 da desduplicação dos checkouts (11/09).

   Estas 111 linhas eram byte a byte iguais na AMB e na Girassol. O que elas
   guardam é caro: a regra de NUNCA usar cadastro EXCLUÍDO, que nasceu de um
   caso real do dono — o SKU 10xE14-5W-3000K-BIV tinha dois cadastros no Bling,
   o ativo (kit de 10) e um excluído (composição de 6), a busca devolvia os dois,
   pegava-se o primeiro, e o custo do kit virava 20,40 em vez de 34,00. Margem
   inflada em 13,60 por venda, com número vindo de cadastro já apagado.

   Duas cópias dessa regra significam duas chances de ela divergir — e é
   exatamente o tipo de regra que ninguém revisa de novo depois de escrita.

   O módulo não conhece empresa: recebe a pasta de cache e o leitor de JSON por
   injeção, e devolve as mesmas funções com os mesmos nomes.
   ──────────────────────────────────────────────────────────────────────────── */

const path = require('path');

function criar(deps) {
  /* O lint de órfãos acusou writeJson e _skuInfoCache assim que a fatia saiu do arquivo —
     e o segundo revelou algo mais sério do que injeção faltando: esse cache é do HOST, que
     escreve nele em OUTRO ponto do checkout. Se a lib tivesse cópia própria, seriam dois
     caches divergindo em silêncio (e o valor errado do sku-info é justamente o que causa
     custo de cadastro errado). Por isso ela recebe ACESSORES do dono do estado. */
  const { CACHE_DIR, readJson, writeJson, lerSkuInfoCache, gravarSkuInfoCache } = deps;
  for (const [nome, v] of Object.entries({ CACHE_DIR, readJson, writeJson, lerSkuInfoCache, gravarSkuInfoCache })) {
    if (v == null) throw new Error('lib/checkout/produto-ativo: falta a dependência ' + nome);
  }

  // ─── 19/08: SÓ PRODUTO ATIVO ────────────────────────────────────────────────────
  // Caso real trazido pelo Diego: o SKU 10xE14-5W-3000K-BIV tinha DOIS cadastros no Bling —
  // o ativo (kit de 10, R$ 99,90) e um EXCLUÍDO (composição de 6, R$ 81,00). A busca por
  // código devolve os dois, a gente pegava o PRIMEIRO sem olhar a situação, e o custo do kit
  // virou 6 × 3,40 = R$ 20,40 em vez de 10 × 3,40 = R$ 34,00. Margem inflada em R$ 13,60 por
  // venda, com o número saindo de um cadastro que ele já tinha apagado.
  // Regra: cadastro excluído NUNCA é usado. Entre os que sobram, o ativo tem preferência.
  // Se sobrar mais de um ativo, devolve o primeiro E avisa no log — ambiguidade real merece
  // registro, não escolha silenciosa.
  function _prodExcluido(p) {
    const s = String((p && (p.situacao || p.situacaoProduto)) || '').trim().toUpperCase();
    return s === 'E' || s.startsWith('EXCL');
  }
  function _prodAtivo(p) {
    const s = String((p && (p.situacao || p.situacaoProduto)) || '').trim().toUpperCase();
    return s === 'A' || s.startsWith('ATIV');
  }
  // `info` (opcional) volta preenchido: {todos_excluidos:true} quando a busca ACHOU cadastros mas
  // todos estavam excluídos. Codex (P1): sem essa distinção, quem chama não sabe diferenciar
  // "o Bling não respondeu" de "o produto foi apagado" — e no segundo caso o custo velho precisa
  // ser JOGADO FORA do cache, senão o ?fresh=1 regrava o número do cadastro deletado.
  // `limitePedido`: quantos cabiam na resposta. Codex (P2): com mais de 10 cadastros duplicados, o
  // ativo pode estar FORA da página — concluir "todos excluídos" ali e apagar o custo destruiria um
  // dado bom. Página cheia = conclusão inconclusiva, e nada é apagado.

  // ─── RESOLVER SKU → PRODUTO (reescrito 19/08, 4ª rodada do Codex no PR#143) ──────
  // Eu vinha empilhando guarda em cima de guarda e cada rodada achava um buraco novo, porque o
  // problema tem MAIS ESTADOS do que eu estava enxergando: três variantes de caixa do SKU, cada
  // busca podendo falhar, cada página podendo vir cheia (logo, incompleta), e o produto podendo
  // estar ativo, inativo, excluído ou ausente. Agora tudo isso é decidido num lugar só, com os
  // estados explícitos, e quem chama recebe um veredito pronto.
  //
  // Devolve { produto, ativo, todosExcluidos, inconclusivo, motivo }:
  //   · produto        — o cadastro escolhido (ativo tem prioridade absoluta), ou null
  //   · todosExcluidos — TODOS os cadastros encontrados estão excluídos, e vimos todos
  //   · inconclusivo   — alguma busca falhou OU alguma página veio cheia: NÃO dá pra concluir
  //                      que o produto sumiu, então nada pode ser apagado
  // limpa o cache de 6h do sku-info para um SKU (usado quando o produto some E quando ele é
  // re-resolvido: nos dois casos o valor guardado ali pode ser do cadastro errado)
  function _limparSkuInfo(sku) {
    try {
      const f = path.join(CACHE_DIR, '_skus-info.json');
      const cache = lerSkuInfoCache() || readJson(f, {});
      if (cache[sku]) { delete cache[sku]; gravarSkuInfoCache(cache); writeJson(f, cache); }
    } catch (e) { console.log('[CUSTO] ' + sku + ': não consegui limpar o cache de sku-info (' + e.message + ')'); }
  }
  async function resolverProdutoPorSku(sku, buscar, limite) {
    const lim = limite || 10;
    const variantes = [...new Set([sku, String(sku).toUpperCase(), String(sku).toLowerCase()])];
    let ativo = null, reserva = null, achouAlgum = false, algumVivo = false;
    let inconclusivo = false, motivo = '';
    for (const v of variantes) {
      const r = await buscar(`/produtos?codigo=${encodeURIComponent(v)}&limite=${lim}&criterio=5`);
      if (!r || !r.ok) {   // Codex (P2, 4ª rodada): variante que falhou (429, timeout) pode ser
        inconclusivo = true;    // justamente a que tinha o cadastro ativo — nunca concluir sem ela
        motivo = motivo || 'uma das buscas falhou (' + v + ')';
        continue;
      }
      const arr = ((r.data && r.data.data) || []).filter(Boolean);
      if (arr.length) achouAlgum = true;
      if (arr.length >= lim) {   // página cheia = pode haver mais adiante
        inconclusivo = true;
        motivo = motivo || 'página cheia (' + arr.length + ' resultados para ' + v + '): pode haver cadastro fora dela';
      }
      for (const p of arr) {
        if (_prodExcluido(p)) continue;
        algumVivo = true;
        if (_prodAtivo(p)) { if (!ativo) ativo = p; }
        else if (!reserva) reserva = p;   // inativo ou sem status: só serve se nenhuma variante der ativo
      }
      if (ativo) break;   // ativo encontrado vence na hora; sem ele, continua procurando nas outras
    }
    // Codex (P2, 4ª rodada): a reserva (cadastro sem status ou inativo) só pode ser aceita DEPOIS de
    // tentar todas as variantes — antes, a primeira variante devolvia a reserva e abortava o laço,
    // deixando o ativo de outra variante para trás.
    const produto = ativo || reserva || null;
    return {
      produto, ativo: !!ativo,
      todosExcluidos: !produto && achouAlgum && !algumVivo && !inconclusivo,
      inconclusivo, motivo
    };
  }

  function escolherProdutoAtivo(lista, sku, info, limitePedido) {
    const arr = (Array.isArray(lista) ? lista : []).filter(Boolean);
    if (!arr.length) return null;
    const vivos = arr.filter(p => !_prodExcluido(p));
    if (!vivos.length) {
      const paginaCheia = limitePedido && arr.length >= limitePedido;
      // Codex (P2, 3ª rodada): o mesmo `info` atravessa as três variantes de caixa do SKU, e a flag
      // era PEGAJOSA — uma variante com página curta marcava "todos excluídos" e a seguinte, com
      // página cheia (logo, inconclusiva), não conseguia desmarcar. Agora o inconclusivo é registrado
      // à parte e VENCE: basta uma variante inconclusiva para nada ser apagado.
      if (info) {
        if (paginaCheia) info.inconclusivo = true;
        else info.todos_excluidos = true;
      }
      if (paginaCheia) console.log('[PRODUTO] ' + (sku || '?') + ': ' + arr.length + ' cadastros na página e todos excluídos, MAS a página veio cheia — pode haver ativo adiante; não concluo nada (e não apago custo)');
      console.log('[PRODUTO] ' + (sku || '?') + ': todos os ' + arr.length + ' cadastros estão EXCLUÍDOS no Bling — ignorando (melhor sem dado do que com dado de cadastro apagado)');
      return null;
    }
    const ativos = vivos.filter(_prodAtivo);
    const escolha = ativos.length ? ativos : vivos;
    if (escolha.length > 1) {
      console.log('[PRODUTO] ⚠ ' + (sku || '?') + ': ' + escolha.length + ' cadastros ATIVOS com o mesmo código (ids ' + escolha.map(p => p.id).join(', ') + ') — usando o primeiro, mas isso é duplicidade no Bling e merece conferência');
    }
    if (arr.length !== vivos.length) {
      console.log('[PRODUTO] ' + (sku || '?') + ': ' + (arr.length - vivos.length) + ' cadastro(s) excluído(s) descartado(s)');
    }
    return escolha[0];
  }

  return { resolverProdutoPorSku, escolherProdutoAtivo, _prodExcluido, _prodAtivo, _limparSkuInfo };
}

module.exports = { criar };
