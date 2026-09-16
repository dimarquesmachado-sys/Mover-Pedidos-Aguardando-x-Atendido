'use strict';

/* ─────────────────────────────────────────────────────────────────────────────
   ROTAS DE SEPARAÇÃO E LOCALIZAÇÃO — segunda fatia do passo 4 (15/09/2026).

   Seis rotas, corpo idêntico nas três empresas, e coesas de verdade: localização
   física do produto, log de quem mudou o quê, montagem da separação e o par
   reservar/liberar que o estoquista usa para não dois pegarem o mesmo pedido.

   ⚠️ COMO A PRIMEIRA FATIA ENSINOU: este handler NÃO valida sessão. Quem o
   registra PRECISA fazê-lo DEPOIS do portão de sessão do módulo — no #480 a
   delegação foi parar no topo do handle e duas rotas passaram a responder sem
   autenticação, porque o corpo idêntico não garantia o mesmo contexto antes dela.
   Conferido para estas seis, nas três empresas, que todas ficam depois do portão.
   `scripts/teste-rotas-separacao.js` trava a posição.

   O que entra por parâmetro: a TAG do log (GIRABKP, AMBBKP, GOODBKP) — Codex #482
   apontou que o log de /salvar-localizacao vinha com [AMBBKP] fixo no corpo
   compartilhado, atribuindo mudanças de localização da Girassol e da GOOD à AMB.
   ──────────────────────────────────────────────────────────────────────────── */

function criar(cfg) {
  for (const n of ['prefixo', 'tag', 'json', 'readBody', 'readJson', 'writeJson', 'blingGet', 'blingWrite',
                   'lerReservas', 'locCache', 'localizacaoDeProduto', 'salvarLoc',
                   'montarSeparacao', 'montarSeparacaoPorPedido', 'RESERVAS_FILE', 'LOC_LOG_FILE']) {
    if (!cfg || cfg[n] == null) throw new Error('lib/checkout/rotas-separacao: falta ' + n);
  }
  const { prefixo, tag, json, readBody, readJson, writeJson, blingGet, blingWrite, lerReservas,
          locCache, localizacaoDeProduto, salvarLoc, montarSeparacao, montarSeparacaoPorPedido,
          RESERVAS_FILE, LOC_LOG_FILE } = cfg;

  return async function handle(req, res, urlObj, method) {
    const p = urlObj.pathname;

    if (method === 'POST' && p === (prefixo + '/salvar-localizacao')) {
      let body = {};
      try { body = await readBody(req); } catch (e) {}
      const sku = String(body.sku || '').trim();
      const localizacao = String(body.localizacao == null ? '' : body.localizacao).trim();
      const op = String(body.op || '').trim();
      if (!sku || sku === '(sem SKU)') { json(res, 200, { ok: false, erro: 'SKU inválido' }); return true; }
      const busca = await blingGet(`/produtos?codigo=${encodeURIComponent(sku)}&limite=1`);
      /* 16/09 — ACHADO DO REPO DE DEVOLUÇÕES: lá, "não encontrado" e "não consigo enxergar"
         chegavam iguais na tela, e o dono concluiu que um pedido não existia quando ele estava
         no Bling. Aqui era o mesmo: `busca.ok` falso caía no mesmo "produto não encontrado".
         São coisas diferentes e mandam fazer coisas diferentes — uma é cadastrar o produto, a
         outra é esperar e tentar de novo. */
      if (!busca.ok) {
        json(res, 200, { ok: false, erro: 'não consegui consultar o Bling agora (HTTP ' + busca.status +
          ') — isto NÃO quer dizer que o SKU ' + sku + ' não existe; tente de novo em instantes' });
        return true;
      }
      /* Codex #484 (P2): 2xx com corpo ilegível (JSON quebrado, formato inesperado) deixa
         `ok: true` e `data` null no blingGet — e eu declarava o SKU inexistente com a
         autoridade de quem leu a resposta. É o mesmo erro do commit anterior, um passo mais
         fundo: não basta a resposta ter CHEGADO, ela precisa ter sido ENTENDIDA. */
      if (!busca.data || !Array.isArray(busca.data.data)) {
        json(res, 200, { ok: false, erro: 'o Bling respondeu de um jeito que não consegui ler — ' +
          'isto NÃO quer dizer que o SKU ' + sku + ' não existe; tente de novo em instantes' });
        return true;
      }
      const item = busca.data.data[0];
      if (!item || !item.id) { json(res, 200, { ok: false, erro: 'produto não encontrado p/ SKU ' + sku + ' (o Bling respondeu uma lista vazia — não há produto com esse código)' }); return true; }
      const patch = await blingWrite('PATCH', `/produtos/${item.id}`, { estoque: { localizacao } });
      if (!patch.ok) { json(res, 200, { ok: false, erro: (patch.data && patch.data.error && (patch.data.error.description || patch.data.error.type)) || ('erro Bling ' + patch.status) }); return true; }
      const locC = locCache();
      const locAntiga = locC[sku] || localizacaoDeProduto(item) || '';
      locC[sku] = localizacao; salvarLoc(locC);
      const log = readJson(LOC_LOG_FILE, []);
      log.push({ op: op || '?', sku, de: locAntiga, para: localizacao, em: new Date().toISOString() });
      if (log.length > 3000) log.splice(0, log.length - 3000);    // mantém os últimos 3000
      writeJson(LOC_LOG_FILE, log);
      console.log(`[${tag}] localização ${sku}: "${locAntiga}" → "${localizacao}" por ${op || '?'}`);
      json(res, 200, { ok: true, sku, localizacao, de: locAntiga });
      return true;
    }
    if (method === 'GET' && p === (prefixo + '/localizacoes-log')) {
      const log = readJson(LOC_LOG_FILE, []);
      json(res, 200, { ok: true, total: log.length, log: log.slice(-500).reverse() });
      return true;
    }
    if (method === 'GET' && p === (prefixo + '/separacao')) {
      const mkt = urlObj.searchParams.get('mkt');
      json(res, 200, montarSeparacao(mkt && mkt !== 'todos' ? mkt : null));
      return true;
    }
    if (method === 'GET' && p === (prefixo + '/separacao-por-pedido')) {
      const mkt = urlObj.searchParams.get('mkt');
      json(res, 200, montarSeparacaoPorPedido(mkt && mkt !== 'todos' ? mkt : null));
      return true;
    }
    if (method === 'POST' && p === (prefixo + '/reservar')) {
      const body = await readBody(req);
      const id = String(body.id || '');
      const user = String(body.user || '').trim();
      if (!id) { json(res, 400, { erro: 'id obrigatório' }); return true; }
      const r = lerReservas();
      const dono = r[id] && r[id].user;
      if (dono && user && dono !== user && !body.forcar) {   // já tem OUTRO operador nesse pedido
        json(res, 200, { ok: false, reservado_por: dono, em: r[id].em });
        return true;
      }
      r[id] = { user, em: new Date().toISOString() };
      writeJson(RESERVAS_FILE, r);
      json(res, 200, { ok: true });
      return true;
    }
    if (method === 'POST' && p === (prefixo + '/liberar')) {
      const body = await readBody(req);
      const id = String(body.id || '');
      const r = lerReservas();
      if (r[id]) { delete r[id]; writeJson(RESERVAS_FILE, r); }
      json(res, 200, { ok: true });
      return true;
    }
    return false;
  };
}

module.exports = { criar };
