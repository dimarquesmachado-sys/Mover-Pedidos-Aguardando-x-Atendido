'use strict';

/* ─────────────────────────────────────────────────────────────────────────────
   ROTAS DE CATÁLOGO — busca de produto e indexação de EAN (15/09/2026).

   Primeira fatia do passo 4 da Fase 3, escolhida por MEDIÇÃO e por COESÃO: das 45
   rotas comuns aos três checkouts, 18 têm corpo idêntico, e estas três andam
   juntas — buscar produto usa o índice de EAN que as outras duas constroem e
   acompanham. Extrair rota solta de um grupo que se apoia seria a meia-porta que
   já aconteceu duas vezes hoje.

   O prefixo vem por parâmetro, como no `criar-modulo.js` do fiscal. Tudo o que é
   da empresa entra por injeção: cache do índice, cliente do Bling, leitura de
   admin. Nada aqui sabe de qual CNPJ se trata.
   ──────────────────────────────────────────────────────────────────────────── */

function criar(cfg) {
  for (const n of ['prefixo', 'json', 'blingGet', 'ehAdmin', 'skuEanCache', 'lerIndiceEan',
                   'salvarNoIndiceEan', 'getPossiveisGtins', 'produtoDetalhe', 'primeiraImagem',
                   'locCache', 'localizacaoDeProduto', 'indexarCatalogoCompleto', 'getIdxStatus']) {
    if (!cfg || cfg[n] == null) throw new Error('lib/checkout/rotas-catalogo: falta ' + n);
  }
  const { prefixo, json, blingGet, ehAdmin, skuEanCache, lerIndiceEan, salvarNoIndiceEan,
          getPossiveisGtins, produtoDetalhe, primeiraImagem, locCache, localizacaoDeProduto,
          indexarCatalogoCompleto, getIdxStatus } = cfg;

  return async function handle(req, res, urlObj, method, validarSessao) {
    const p = urlObj.pathname;

    if (method === 'GET' && p === (prefixo + '/buscar-produto')) {
      const q = String(urlObj.searchParams.get('q') || '').trim();
      if (!q) { json(res, 200, { ok: false, erro: 'busca vazia' }); return true; }
      const dig = q.replace(/\D/g, '');
      const pareceEan = dig.length >= 8 && dig.length <= 14 && /^\d+$/.test(q.replace(/\s/g, ''));
      let prod = null;
      const porSku = async (codigo) => {
        const base = String(codigo || '').trim();
        const variantes = [...new Set([base, base.toUpperCase(), base.toLowerCase()])];
        for (const v of variantes) {                           // ?codigo= do Bling é case-sensitive → tenta as 3 caixas
          const r = await blingGet(`/produtos?codigo=${encodeURIComponent(v)}&limite=1`);
          const it = r.ok && r.data && r.data.data && r.data.data[0];
          if (it && it.id) return await produtoDetalhe(it.id);
        }
        return null;
      };
      if (!pareceEan) prod = await porSku(q);                 // SKU é o caminho 100%
      if (!prod && dig.length >= 8) {                          // EAN: cache reverso → API do Bling
        const se = skuEanCache();
        let achou = null;
        for (const sku of Object.keys(se)) { if (String(se[sku]).replace(/\D/g, '') === dig) { achou = sku; break; } }
        if (achou) prod = await porSku(achou);
        if (!prod) {                                           // índice de EAN (cresce sozinho / indexação total) — rápido e confiável
          const hit = lerIndiceEan()[dig];
          if (hit && hit.id) prod = await produtoDetalhe(hit.id);
        }
        if (!prod) {                                           // último recurso: filtro do Bling (lento, pouco confiável)
          for (const campo of ['gtin', 'gtinTributario', 'ean', 'codigoBarras']) {
            const r = await blingGet(`/produtos?${campo}=${encodeURIComponent(q)}&limite=5`);
            const itens = (r.ok && r.data && r.data.data) || [];
            for (const it of itens) {
              if (!it.id) continue;
              const det = await produtoDetalhe(it.id);
              if (det && getPossiveisGtins(det).some(e => String(e).replace(/\D/g, '') === dig)) { prod = det; break; }
            }
            if (prod) break;
          }
        }
      }
      if (!prod && pareceEan) prod = await porSku(q);          // às vezes o código É o número digitado
      if (!prod) { json(res, 200, { ok: false, erro: 'nada encontrado p/ "' + q + '"' }); return true; }
      salvarNoIndiceEan(prod);                                 // alimenta o índice — toda resolução entra no cache
      const est = prod.estoque || {};
      let localizacao = localizacaoDeProduto(prod);            // 1º: Bling (fonte da verdade)
      if (!localizacao) {                                      // 2º: cache local (localização editada pelo painel)
        const lc = locCache(); const sk = prod.codigo || '';
        localizacao = lc[sk] || lc[sk.toUpperCase()] || lc[sk.toLowerCase()] || '';
      }
      json(res, 200, { ok: true, produto: {
        sku: prod.codigo || '',
        nome: prod.nome || '',
        ean: getPossiveisGtins(prod)[0] || '',
        estoque: (est.saldoVirtualTotal != null ? est.saldoVirtualTotal : (est.saldoVirtual != null ? est.saldoVirtual : null)),
        localizacao: localizacao,
        img: primeiraImagem(prod)
      } });
      return true;
    }
    if (method === 'GET' && p === (prefixo + '/indexar-catalogo')) {
      const op = String(urlObj.searchParams.get('op') || '');
      if (!ehAdmin(op)) { json(res, 200, { ok: false, precisa_admin: true, erro: 'só admin pode indexar' }); return true; }
      if (getIdxStatus().rodando) { json(res, 200, { ok: true, started: false, jaRodando: true, status: getIdxStatus() }); return true; }
      indexarCatalogoCompleto();                       // dispara em background (não aguarda)
      json(res, 200, { ok: true, started: true });
      return true;
    }
    if (method === 'GET' && p === (prefixo + '/indexar-status')) {
      json(res, 200, { ok: true, status: getIdxStatus() });
      return true;
    }
    return false;
  };
}

module.exports = { criar };
