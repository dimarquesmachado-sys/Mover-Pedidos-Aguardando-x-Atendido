'use strict';
/* ═══════════════════════════════════════════════════════════════════════════
   lib/checkout/rotas-contagem.js — CONTAGEM DE ESTOQUE (registro interno)

   O que o dono pediu (22/09): uma tela pro funcionário procurar um produto por
   SKU, EAN ou PARTE DO NOME, ver o nome completo e a foto, e lançar a
   quantidade que ele contou.

   Três decisões que ele tomou e que moldam tudo aqui:

   1) NÃO GRAVA NO BLING. É registro interno; ele revisa depois e decide o que
      enviar. Por isso nenhuma rota daqui chama blingWrite — a única coisa que
      este módulo escreve é o próprio arquivo de contagens.
   2) É CONTAGEM, não entrada/saída. O funcionário informa o saldo que contou,
      não um delta. A divergência contra o Bling é calculada na hora do
      lançamento e guardada junto: é ela que interessa na revisão.
   3) Girassol primeiro. Mas o código nasce com a empresa como parâmetro, como
      toda peça nova — plugar as outras duas é passar o contexto.

   ⚠️ BUSCA POR NOME É LOCAL, DE PROPÓSITO. O funcionário digitando um nome
   dispararia uma consulta ao Bling por tecla, e a cota é da conta — a operação
   perde primeiro. O índice de EAN já guarda { sku, nome, id } de tudo que
   passou pela busca ou pela indexação, então o nome é procurado ali. SKU e EAN
   continuam indo ao Bling, porque precisam do saldo e da foto do momento.
   ═══════════════════════════════════════════════════════════════════════════ */

const fs = require('fs');
const path = require('path');

/* ctx precisa de: prefixo, json, validarSessao, blingGet, lerIndiceEan, CACHE_DIR,
   readJson, writeJson, empresa */
function criar(ctx) {
  for (const n of ['prefixo', 'json', 'validarSessao', 'lerIndiceEan', 'CACHE_DIR',
                   'readJson', 'writeJson', 'empresa', 'blingGet']) {
    if (!ctx || ctx[n] === undefined) throw new Error('rotas-contagem: falta ' + n + ' no contexto');
  }
  const { prefixo, json, validarSessao, lerIndiceEan, CACHE_DIR, readJson, writeJson, empresa } = ctx;

  const ARQ = () => path.join(CACHE_DIR, '_contagem-estoque.json');
  const ler = () => { const d = readJson(ARQ(), null); return (d && Array.isArray(d.lancamentos)) ? d : { lancamentos: [] }; };

  /* sem acento e sem caixa: o funcionário digita "luminaria" e o catálogo tem
     "Luminária" — exigir o acento seria uma busca que só funciona pra quem já
     sabe o nome exato, e quem sabe o nome exato usa o SKU */
  const simples = (s) => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();

  /* a assinatura segue a da casa — rotas-catalogo e as irmãs recebem
     (req, res, urlObj, method). Escrevi diferente primeiro e o próprio registro
     no módulo mostrou; alinhar aqui é mais barato que ter duas convenções. */
  return async function rotasContagem(req, res, urlObj, method) {
    const p = urlObj.pathname;
    /* ── tela ── */
    if (method === 'GET' && p === (prefixo + '/contagem')) {
      const f = path.join(__dirname, '..', '..', empresa.pasta, 'contagem.html');
      if (!fs.existsSync(f)) { json(res, 404, { ok: false, erro: 'tela de contagem não habilitada nesta empresa' }); return true; }
      const sess = validarSessao(req.headers['cookie']);
      if (!sess) { json(res, 401, { ok: false, erro: 'precisa estar logado' }); return true; }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(fs.readFileSync(f, 'utf8'));
      return true;
    }

    /* ── busca por PARTE DO NOME (local, sem tocar no Bling) ── */
    if (method === 'GET' && p === (prefixo + '/contagem-buscar-nome')) {
      const sess = validarSessao(req.headers['cookie']);
      if (!sess) { json(res, 401, { ok: false, erro: 'precisa estar logado' }); return true; }
      const q = simples(urlObj.searchParams.get('q'));
      /* 3 letras é o piso: com 1 ou 2 a lista vem com meio catálogo e não ajuda
         ninguém — e o funcionário ainda teria que rolar até achar */
      if (q.length < 3) { json(res, 200, { ok: true, itens: [], erro: 'digite ao menos 3 letras' }); return true; }

      const idx = lerIndiceEan();
      const vistos = new Set();
      const itens = [];
      for (const chave of Object.keys(idx)) {
        const it = idx[chave];
        if (!it || !it.sku || vistos.has(it.sku)) continue;
        if (!simples(it.nome).includes(q) && !simples(it.sku).includes(q)) continue;
        vistos.add(it.sku);
        /* produto sem EAN entra no índice com a chave sintética "sku:<codigo>"
           (ver salvarNoIndiceEan) — só é EAN de verdade se a chave for só dígitos */
        itens.push({ sku: it.sku, nome: it.nome || '', ean: /^\d+$/.test(chave) ? chave : '', id: it.id || null });
        if (itens.length >= 30) break;   // teto: lista longa demais ninguém lê
      }
      /* dizer que o índice está vazio é diferente de dizer que não achou: um
         manda indexar o catálogo, o outro manda digitar outra coisa */
      json(res, 200, {
        ok: true,
        itens,
        indice_vazio: Object.keys(idx).length === 0,
        total: itens.length,
      });
      return true;
    }

    /* ── lançar a contagem ── */
    if (method === 'POST' && p === (prefixo + '/contagem-lancar')) {
      const sess = validarSessao(req.headers['cookie']);
      if (!sess) { json(res, 401, { ok: false, erro: 'precisa estar logado' }); return true; }
      let body = {};
      try { body = await ctx.readBody(req); } catch (e) { body = {}; }

      const sku = String(body.sku || '').trim();
      if (!sku) { json(res, 200, { ok: false, erro: 'sem SKU' }); return true; }

      /* a quantidade é o ponto do recurso inteiro: número errado aqui vira
         inventário errado. Recusa o que não for inteiro >= 0 e diz por quê —
         não aceita texto, não arredonda, não assume zero */
      const bruto = String(body.contado == null ? '' : body.contado).trim().replace(',', '.');
      const n = Number(bruto);
      if (bruto === '' || !isFinite(n) || n < 0 || Math.floor(n) !== n) {
        json(res, 200, { ok: false, erro: 'quantidade inválida — use um número inteiro a partir de 0' });
        return true;
      }
      if (n > 1000000) { json(res, 200, { ok: false, erro: 'quantidade acima do razoável — confira o que digitou' }); return true; }

      const saldoBling = (body.saldo_bling == null || body.saldo_bling === '') ? null : Number(body.saldo_bling);
      const d = ler();
      d.lancamentos.push({
        sku,
        nome: String(body.nome || ''),
        ean: String(body.ean || ''),
        contado: n,
        /* o saldo do Bling é guardado COMO ESTAVA NO MOMENTO da contagem: é o
           que torna a divergência auditável depois. Recalcular na revisão
           compararia a contagem de ontem com o saldo de hoje */
        saldo_bling_na_hora: (saldoBling != null && isFinite(saldoBling)) ? saldoBling : null,
        divergencia: (saldoBling != null && isFinite(saldoBling)) ? (n - saldoBling) : null,
        quem: String(sess.nome || sess || ''),
        quando: new Date().toISOString(),
        enviado_ao_bling: false,   // o dono decide depois; nada aqui escreve no Bling
      });
      /* Codex #509 (P1): writeJson engole a exceção e só loga — se o disco estiver cheio
         ou read-only, a gravação falha e o retorno CONTINUAVA ok:true. O funcionário via
         "salva" e ia pro próximo item com a contagem perdida. Sem checar o retorno, esta
         checagem não existe pra ninguém. */
      if (!writeJson(ARQ(), d)) {
        json(res, 200, { ok: false, erro: 'não consegui gravar a contagem no disco — avise o responsável antes de continuar' });
        return true;
      }
      json(res, 200, { ok: true, total: d.lancamentos.length });
      return true;
    }

    /* ── lista pra revisão ── */
    if (method === 'GET' && p === (prefixo + '/contagem-lista')) {
      const sess = validarSessao(req.headers['cookie']);
      if (!sess) { json(res, 401, { ok: false, erro: 'precisa estar logado' }); return true; }
      const d = ler();
      const de = String(urlObj.searchParams.get('de') || '');
      const lista = de ? d.lancamentos.filter(l => String(l.quando).slice(0, 10) >= de) : d.lancamentos;
      /* mais recente primeiro, com paginação: sem isto, um dia com mais de 500
         lançamentos (contagem geral do galpão) perdia os mais antigos da revisão
         em silêncio — a lista dizia "acabou" sem ter mostrado tudo */
      const ordenada = lista.slice().reverse();
      const off = Math.max(0, parseInt(urlObj.searchParams.get('offset'), 10) || 0);
      const pagina = ordenada.slice(off, off + 500);
      json(res, 200, {
        ok: true,
        lancamentos: pagina,
        total_no_filtro: lista.length,
        total: d.lancamentos.length,
        tem_mais: off + pagina.length < ordenada.length,
        proximo_offset: off + pagina.length,
        com_divergencia: lista.filter(l => l.divergencia != null && l.divergencia !== 0).length,
      });
      return true;
    }

    /* ── saldo AO VIVO (sem cache) pro card de contagem ──
       Codex (P1): buscar-produto usa produtoDetalhe, cujo cache não tem TTL e só é
       limpo quando o ciclo do checkout roda — pra quem já foi resolvido no ciclo
       atual, o saldo mostrado pode ser de horas atrás. Aqui o saldo É o dado: uma
       venda ou ajuste no meio do caminho vira uma divergência gravada errada e
       permanente. Mesmo padrão do /estoque-pedido: vai direto ao Bling. */
    if (method === 'GET' && p === (prefixo + '/contagem-saldo')) {
      const sess = validarSessao(req.headers['cookie']);
      if (!sess) { json(res, 401, { ok: false, erro: 'precisa estar logado' }); return true; }
      const sku = String(urlObj.searchParams.get('sku') || '').trim();
      if (!sku) { json(res, 200, { ok: false, erro: 'sem SKU' }); return true; }
      const variantes = [...new Set([sku, sku.toUpperCase(), sku.toLowerCase()])];
      let saldo = null, achou = false;
      for (const v of variantes) {
        try {
          const r = await ctx.blingGet(`/produtos?codigo=${encodeURIComponent(v)}&limite=1`);
          const it = r.ok && r.data && r.data.data && r.data.data[0];
          if (!it || !it.id) continue;
          achou = true;
          let est = it.estoque || {};
          if (est.saldoVirtualTotal == null && est.saldoVirtual == null) {
            const d2 = await ctx.blingGet(`/produtos/${it.id}`);
            est = (d2.ok && d2.data && d2.data.data && d2.data.data.estoque) || {};
          }
          saldo = est.saldoVirtualTotal != null ? est.saldoVirtualTotal : (est.saldoVirtual != null ? est.saldoVirtual : null);
          break;
        } catch (e) {}
      }
      if (!achou) { json(res, 200, { ok: false, erro: 'produto não encontrado no Bling' }); return true; }
      json(res, 200, { ok: true, saldo });
      return true;
    }

    return false;
  };
}

module.exports = { criar };
