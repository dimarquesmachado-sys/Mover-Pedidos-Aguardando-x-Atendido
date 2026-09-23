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

   Codex (P1): este handler NÃO valida sessão — buscar-produto e indexar-status
   saem sem checagem nenhuma, e indexar-catalogo só confere `ehAdmin(op)`. Por
   isso o chamador PRECISA registrar esta lib depois da guarda de sessão do
   módulo, nunca antes (as três empresas caíram nisso na extração: a chamada
   veio colada no topo do `handle`, antes da guarda rodar).
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

  return async function handle(req, res, urlObj, method) {
    const p = urlObj.pathname;

    /* ── BUSCA POR PARTE DO NOME (22/09) ─────────────────────────────────────
       O dono perguntou por que a contagem não usava a mesma busca do 🔎 do painel. Usava: as
       duas chamam /buscar-produto. O que a contagem tinha a mais era procurar por PARTE DO
       NOME, e isso nasceu na lib dela — lugar errado. Busca de produto pertence ao catálogo,
       e assim o painel das TRÊS ganha junto.

       ⚠️ NÃO TOCA NO BLING, de propósito. O nome é procurado no índice local que já existe: o
       funcionário digitando dispararia uma consulta por tecla, e a cota é da conta — a
       operação perde primeiro. SKU e EAN seguem no /buscar-produto, que vai ao Bling porque
       precisa do saldo e da foto do momento. */
    if (method === 'GET' && p === (prefixo + '/buscar-produto-nome')) {
      const bruto = String(urlObj.searchParams.get('q') || '');
      /* sem acento e sem caixa: quem digita "luminaria" quer achar "Luminária", e quem sabe
         escrever com acento já usaria o SKU */
      const q = bruto.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
      if (q.length < 3) { json(res, 200, { ok: true, itens: [], erro: 'digite ao menos 3 letras' }); return true; }
      const simples = (x) => String(x || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();

      const idx = lerIndiceEan();
      const vistos = new Set();
      const itens = [];
      for (const chave of Object.keys(idx)) {
        const it = idx[chave];
        if (!it || !it.sku || vistos.has(it.sku)) continue;
        if (!simples(it.nome).includes(q) && !simples(it.sku).includes(q)) continue;
        /* 22/09 — KIT fora da lista. O dono: "80-AE-8F-125mm-KIT40 é um kit; se eu tentar
           incluir no Bling, vai dar erro — tenho que incluir o produto pai". Quem conta
           inventário são os COMPONENTES dele (10-AE-8F-125mm-g24 e -g40), que são produtos
           normais e continuam aparecendo aqui. Variação também aparece: ela é contável.
           A marca vem da indexação (`formato === 'E'`). Índice antigo, sem a marca, não
           esconde nada — e por isso o LANÇAMENTO também confere, que é onde não pode passar. */
        if (it.kit === true) continue;
        vistos.add(it.sku);
        /* produto sem EAN entra no índice com a chave sintética "sku:<codigo>" (ver
           salvarNoIndiceEan) — só é EAN de verdade se a chave for só dígitos */
        itens.push({
          sku: it.sku, nome: it.nome || '', id: it.id || null,
          ean: /^\d+$/.test(chave) ? chave : '',
          /* 23/09 — a foto vem do índice, gravada pela varredura do catálogo. Buscá-la aqui
             seria uma chamada ao Bling por resultado, a cada tecla digitada. */
          img: it.img || '',
        });
        if (itens.length >= 30) break;   // teto: lista longa demais ninguém lê
      }
      itens.sort((a, b) => String(a.nome).localeCompare(String(b.nome), 'pt-BR'));
      json(res, 200, {
        ok: true,
        itens,
        total: itens.length,
        /* "vazio" e "incompleto" mandam fazer coisas OPOSTAS: um pede indexar o catálogo, o
           outro pede digitar outra coisa. Basta um produto ter passado por uma busca pro
           índice deixar de estar vazio sem estar completo. */
        indice_vazio: Object.keys(idx).length === 0,
        indice_completo: !!(cfg.getIdxStatus && (cfg.getIdxStatus() || {}).fim),
      });
      return true;
    }

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
      /* 23/09 — `?profundo=1` busca o detalhe de TODOS os produtos, que é o único jeito de
         saber quem é kit: a listagem pode dizer "S" pra algo com composição. Custa ~9.000
         chamadas a mais na Girassol e mais de uma hora, então NÃO é o padrão — o dono dispara
         com o galpão parado. Sem o parâmetro, a varredura segue rápida e serve pra nome e foto. */
      const profundo = String(urlObj.searchParams.get('profundo') || '') === '1';
      indexarCatalogoCompleto({ profundo });                       // dispara em background (não aguarda)
      json(res, 200, { ok: true, started: true, profundo });
      return true;
    }
    /* 23/09 — DEBUG do produto CRU, portado da AMB (que já tinha) pras três empresas — e as
       três tinham o MESMO bloco duplicado depois da guarda de sessão. Ficam removidos daqui
       pra frente (Codex, P2): esta rota intercepta primeiro pelo mesmo prefixo e path, e as
       cópias das três empresas nunca mais eram alcançadas — inclusive perdendo silenciosamente
       o `campos_detalhe` que elas devolviam. Restaurado abaixo pra manter o contrato.
       Existe por um motivo prático: a varredura profunda leva 3 horas, e conserto baseado em
       suposição sobre o que o Bling devolve custa uma rodada inteira pra descobrir que errou.
       Esta rota responde em segundos: mostra `formato`, `estrutura` e `variacao` como vieram.
       Admin, e não é chamada por nada automático. */
    /* Codex #520 (P2): `/debug-produto/` JÁ EXISTE na AMB e na GOOD, com outro conteúdo
       (estoque e localização). Esta lib é registrada ANTES delas, então a minha rota tapava as
       duas — um nome repetido derrubando ferramenta de diagnóstico alheia, que é o tipo de
       coisa que só se descobre na hora em que se precisa dela.
       Renomeada pra `/debug-produto-cru/`, que também diz melhor o que ela faz. */
    if (method === 'GET' && p.startsWith(prefixo + '/debug-produto-cru/')) {
      const op = String(urlObj.searchParams.get('op') || '');
      if (!ehAdmin(op)) { json(res, 403, { ok: false, erro: 'só admin' }); return true; }
      const sku = decodeURIComponent(p.split('/').filter(Boolean).pop() || '');
      const lista = await blingGet(`/produtos?codigo=${encodeURIComponent(sku)}&limite=1`);
      const item = lista.data && lista.data.data && lista.data.data[0];
      let raw = null, detStatus = null;
      if (item && item.id) {
        const r = await blingGet(`/produtos/${item.id}`);
        detStatus = r.status;
        raw = (r.data && r.data.data) || null;
      }
      json(res, 200, {
        sku,
        da_lista: item ? { id: item.id, nome: item.nome, formato: item.formato, idProdutoPai: item.idProdutoPai } : null,
        detalhe_status: detStatus,
        nome_detalhe: raw && raw.nome,
        campos_detalhe: raw ? Object.keys(raw) : null,
        formato_detalhe: raw && raw.formato,
        tem_estrutura: !!(raw && raw.estrutura),
        estrutura: (raw && raw.estrutura) || null,
        variacao: (raw && raw.variacao) || null,
      });
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
