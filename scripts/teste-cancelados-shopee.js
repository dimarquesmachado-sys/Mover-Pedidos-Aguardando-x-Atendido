'use strict';
/* 13/09 (Codex #391) — varrerCancelados passou a perguntar à Shopee além do Bling. A
   revisão achou (entre outros) que o Bling podia abortar a função ANTES da fase Shopee
   rodar de dois jeitos: sc.ids vazio (já coberto por uma prova executada, sem teste
   permanente) e token vencido em garantirToken()/garantirSitCancel() — este último ainda
   lançava direto, matando a função inteira antes mesmo de _setVarre inicializar o estado,
   e a Shopee (a fonte da verdade) nunca era consultada. Este teste prova os dois casos e
   mais dois achados da mesma rodada: o contador da_shopee soma mesmo quando o pedido já
   veio do Bling, e a situação cacheada é sobrescrita (não só preenchida se vazia).

   13/09 (2ª leitura, Codex #391) — indicePorNumeroLoja passou a devolver um ARRAY por
   numero_loja (duplicata do Bling — lib/bling-duplicatas.js — não podia sumir atrás de um
   mapa escalar) e a lib passou a chamar ctx.marcarCanceladoMkt (tombstone pro backfill não
   trazer de volta o que a Shopee já cancelou). Os testes abaixo cobrem os dois.

   13/09 (PR #392, Codex P2) — o teste de "dias > 60 avisa" foi removido: o serviço da
   Shopee passou a fatiar de 15 em 15 dias e paginar por dentro, então o teto de 60 por
   chamada que motivava o aviso não existe mais (o teto real agora é o Math.min(400, ...)
   da própria varrerCancelados). Manter aquele teste faria a lib avisar cobertura que ela
   já não tem mais o problema de não ter. */
const assert = require('assert');
const { varrerCancelados } = require('../lib/imposto-cancelados');

function mkCtx(overrides) {
  return Object.assign({
    blingGet: async () => ({ ok: true, status: 200, data: { data: [] } }),
    garantirToken: async () => 'tok',
    garantirSitCancel: async () => ({ ids: [], nomes: [], erro: null }),
    supaCfg: () => ({ url: 'https://x.supabase.co', key: 'k' }),
    histCache: {},
  }, overrides);
}

const respDeletePedido = (n) => ({ ok: true, headers: { get: (h) => h === 'content-range' ? ('0-0/' + n) : null } });

(async () => {
  // ── token do Bling vencido: a função não pode morrer antes de perguntar à Shopee ──────
  {
    global.fetch = async (url) => {
      if (String(url).includes('numero_pedido=in.')) return respDeletePedido(1);
      throw new Error('chamada inesperada: ' + url);
    };
    const v1 = { numero: '100', numero_loja: 'SN1', situacao: 'Atendido', cancelado_mkt: 0 };
    const marcados = [];
    const ctx = mkCtx({
      garantirToken: async () => { throw new Error('token vencido'); },
      canceladosNoMarketplace: async () => ['SN1'],
      indicePorNumeroLoja: () => ({ SN1: [v1] }),
      marcarCanceladoMkt: (nl) => marcados.push(nl),
      gravarIndice: () => {},
    });
    const r = await varrerCancelados(ctx, 45, 'teste-token-vencido');
    assert.ok(r.aviso_bling, 'tem que avisar que o Bling falhou, não estourar: ' + JSON.stringify(r));
    assert.strictEqual(r.do_bling, 0, 'nada veio do Bling');
    assert.strictEqual(r.da_shopee, 1, 'a Shopee rodou e achou o cancelamento mesmo com o token do Bling vencido');
    assert.strictEqual(v1.cancelado_mkt, 1);
    assert.strictEqual(v1.situacao, 'Cancelado na Shopee', 'a situação cacheada tem que ser SUBSTITUÍDA, não só preenchida se vazia');
    assert.deepStrictEqual(marcados, ['SN1'], 'tombstone tem que ser gravado pro backfill não trazer a venda de volta');
  }
  console.log('OK 1/5: token do Bling vencido não impede a fase Shopee (antes matava a função inteira)');

  // ── mesmo pedido cancelado nos DOIS lados — da_shopee conta o match, não só o exclusivo ──
  {
    global.fetch = async (url) => {
      if (String(url).includes('numero_pedido=in.')) return respDeletePedido(1);
      throw new Error('chamada inesperada: ' + url);
    };
    const v2 = { numero: '200', numero_loja: 'SN2', situacao: 'Atendido' };
    const ctx = mkCtx({
      garantirSitCancel: async () => ({ ids: ['9'], nomes: ['Cancelado'], erro: null }),
      blingGet: async () => ({ ok: true, status: 200, data: { data: [{ numero: '200' }] } }),
      canceladosNoMarketplace: async () => ['SN2'],
      indicePorNumeroLoja: () => ({ SN2: [v2] }),
      gravarIndice: () => {},
    });
    const r = await varrerCancelados(ctx, 45, 'teste-overlap');
    assert.strictEqual(r.do_bling, 1, 'o Bling achou o 200');
    assert.strictEqual(r.da_shopee, 1, 'a Shopee TAMBÉM confirmou o 200 — tem que contar, não ficar em 0');
  }
  console.log('OK 2/5: cancelamento visto pelos DOIS lados soma 1 em cada contador, não zera a Shopee');

  // ── serviço da Shopee fora do ar: não derruba a varredura, vale o que veio do Bling ──
  {
    global.fetch = async (url) => {
      if (String(url).includes('numero_pedido=in.')) return respDeletePedido(1);
      throw new Error('chamada inesperada: ' + url);
    };
    const ctx = mkCtx({
      garantirSitCancel: async () => ({ ids: ['9'], nomes: ['Cancelado'], erro: null }),
      blingGet: async () => ({ ok: true, status: 200, data: { data: [{ numero: '300' }] } }),
      canceladosNoMarketplace: async () => { throw new Error('serviço fora do ar'); },
      indicePorNumeroLoja: () => ({}),
      gravarIndice: () => {},
    });
    const r = await varrerCancelados(ctx, 45, 'teste-shopee-fora');
    assert.ok(r.aviso_shopee, 'tem que avisar que a Shopee falhou: ' + JSON.stringify(r));
    assert.strictEqual(r.do_bling, 1);
    assert.strictEqual(r.encontrados, 1, 'vale o que veio do Bling');
  }
  console.log('OK 3/5: Shopee fora do ar não derruba a varredura — vale o que veio do Bling');

  // ── duplicata do Bling: DOIS pedidos com o mesmo numero_loja — as duas têm que sumir ──
  {
    global.fetch = async (url) => {
      if (String(url).includes('numero_pedido=in.')) return respDeletePedido(2);
      throw new Error('chamada inesperada: ' + url);
    };
    const v4a = { numero: '400', numero_loja: 'SN4', situacao: 'Atendido', cancelado_mkt: 0 };
    const v4b = { numero: '401', numero_loja: 'SN4', situacao: 'Atendido', cancelado_mkt: 0 };
    const ctx = mkCtx({
      canceladosNoMarketplace: async () => ['SN4'],
      indicePorNumeroLoja: () => ({ SN4: [v4a, v4b] }),
      gravarIndice: () => {},
    });
    const r = await varrerCancelados(ctx, 45, 'teste-duplicata');
    assert.strictEqual(v4a.cancelado_mkt, 1, 'duplicata 1 tem que ser marcada');
    assert.strictEqual(v4b.cancelado_mkt, 1, 'duplicata 2 (mesmo numero_loja) não pode sumir atrás da primeira — era o P1 da 2ª leitura');
    assert.strictEqual(v4b.situacao, 'Cancelado na Shopee');
    assert.strictEqual(r.encontrados, 2, 'os DOIS pedidos do Bling com o mesmo numero_loja saem do histórico');
  }
  console.log('OK 4/5: duplicata do Bling com o mesmo numero_loja — as DUAS linhas são marcadas, não só a última');

  // ── tombstone grava mesmo quando o cancelamento está fora da janela do índice local ──
  {
    global.fetch = async (url) => {
      if (String(url).includes('numero_loja=in.')) return respDeletePedido(1);
      throw new Error('chamada inesperada: ' + url);
    };
    const marcados6 = [];
    const ctx = mkCtx({
      canceladosNoMarketplace: async () => ['SN6'],
      indicePorNumeroLoja: () => ({}),
      marcarCanceladoMkt: (nl) => marcados6.push(nl),
      gravarIndice: () => {},
    });
    const r = await varrerCancelados(ctx, 45, 'teste-fora-indice');
    assert.deepStrictEqual(marcados6, ['SN6'], 'tombstone tem que ser gravado mesmo pro cancelamento fora da janela do índice — é o que o backfill vai consultar');
    assert.strictEqual(r.fora_do_indice, 1);
  }
  console.log('OK 5/5: tombstone grava mesmo quando o pedido está fora da janela do índice local');

  console.log('OK: varredura de cancelados — token do Bling vencido não bloqueia a Shopee, contagem soma quando os dois lados concordam, Shopee fora do ar não derruba a varredura, duplicata do Bling não perde linha, tombstone grava sempre');
})().catch(e => { console.error('FALHOU (cancelados-shopee):', e.message); process.exit(1); });
