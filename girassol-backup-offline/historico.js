'use strict';
// ════════════════════════════════════════════════════════════════════════
//  GIRASSOL · BACKUP OFFLINE — MÓDULO DE HISTÓRICO E ANÁLISE
//  (extraído do index.js em 04/08/2026 — Lote 3 da modularização)
// ════════════════════════════════════════════════════════════════════════
//  Aqui moram as rotas que alimentam os NÚMEROS do dashboard:
//    /historico        — o que o checkout bipou (disco), com custo e cancelado prontos
//    /historico-longo  — agregados do período vindos do Supabase (cards do Mês/Ano)
//    /historico-linhas — a lista paginada do mesmo período, filtrada no servidor
//    /previsao-vendas  — projeção por SKU
//    /buscar-pedido    — busca de um pedido e seu lucro
//    /buscar-lucro     — busca GLOBAL no Supabase (qualquer data), agrupada por pedido
//
//  ⚠️ CUIDADO AO MEXER: é este arquivo que decide faturamento, custo, imposto e
//  M.C. dos períodos longos. Qualquer alteração aqui tem que ser conferida contra
//  a foto de referência dos 7 períodos ANTES de considerar pronta.
//
//  Contrato (igual ao diagnostico.js): o index chama rotasHistorico(ctx) UMA vez e
//  recebe um handler; o handler devolve true se tratou a rota, false se não é dele.
//  A delegação fica no FIM do handle(), logo antes do return false — conferi que
//  nenhum prefixo declarado antes (/pedido/, /etiqueta/, /imprimir/ …) casa com
//  estas cinco rotas, então a ordem de casamento continua idêntica.
//
//  ctx = { validarSessao, supaCfg, DEFAULT_ALIQ_BK, histCache }
//  histCache é o MESMO objeto do index (passado por referência, nunca copiado):
//  o backfill e o /backfill-limpar continuam esvaziando o cache de lá e isso
//  precisa valer aqui também.
// ════════════════════════════════════════════════════════════════════════

const path = require('path');
const fetch = require('node-fetch');

const base = require('./base');
const { CACHE_DIR, PAUSA_MS, CONFERIDOS_FILE, sleep, readJson, writeJson, json, ehAdmin, blingGet } = base;
const { nfDoPedido } = require('./nf');
const { detalhePedido } = require('./ciclo');

function rotasHistorico(ctx) {
  const { validarSessao, supaCfg, DEFAULT_ALIQ_BK } = ctx;
      /* 21/08 — sobreposição do custo MANUAL, atrás do Bling. Codex (P2): eu tinha posto isto só
         no agregado; as LINHAS do Mês/Ano continuavam lendo só o _custos.json, então o card
         mostrava o custo corrigido e a lista logo abaixo marcava o pedido como sem custo. */
      const _comManual = (mapa) => {
        const b = mapa || {};
        let man = {};
        try { man = readJson(path.join(CACHE_DIR, '_custos-manuais.json'), {}) || {}; } catch (e) { man = {}; }
        const tem = k => { const c = b[k]; return c && Number(c.custo) > 0; };
        for (const K of Object.keys(man)) {
          const v = Number(man[K].custo); if (!(v > 0)) continue;
          const nome = man[K].sku || K;
          if (!tem(K) && !tem(nome)) b[nome] = { custo: v, manual: true };
        }
        return b;
      };
  const _histCache = ctx.histCache;   // mesma referência do index — NÃO copiar

  return async function handleHistorico(req, res, urlObj) {
    const { method } = req;
    const p = urlObj.pathname;

    // 🔮 PREVISÃO DE VENDAS POR PRODUTO — usa o histórico do Supabase.
    // Uso: /girassol-backup-offline/previsao-vendas?base=180  (dias de histórico usados como base)
    // Devolve, por SKU: o que vendeu na base, a média por dia, a TENDÊNCIA (últimos 30d x 30d
    // anteriores) e a projeção pra 7 / 30 / 90 / 180 / 365 dias.
    if (method === 'GET' && p === '/girassol-backup-offline/previsao-vendas') {
      const kP = (urlObj.searchParams && urlObj.searchParams.get('k')) || '';
      const sessP = validarSessao(req.headers['cookie']);
      if (!((process.env.ADMIN_KEY && kP === process.env.ADMIN_KEY) || (sessP && ehAdmin(sessP)))) { json(res, 404, { error: 'not found' }); return true; }
      const baseDias = Math.min(730, Math.max(30, parseInt((urlObj.searchParams && urlObj.searchParams.get('base')) || '180', 10) || 180));
      const hojeP = new Date();
      const dePV = new Date(hojeP.getTime() - baseDias * 86400000).toISOString().slice(0, 10);
      const atePV = hojeP.toISOString().slice(0, 10);
      const ck = 'prev|' + baseDias + '|' + atePV;
      // ?fresh=1 ignora o cache de 30 min — útil logo depois de um custo-sync
      const _frH = (urlObj.searchParams && urlObj.searchParams.get('fresh')) === '1';
      if (!_frH && _histCache[ck] && (Date.now() - _histCache[ck].ts) < 1800000) { json(res, 200, Object.assign({ cache: true }, _histCache[ck].dados)); return true; }
      const { url: uP, key: kkP } = supaCfg('girassol');
      if (!uP || !kkP) { json(res, 500, { ok: false, erro: 'Supabase não configurado' }); return true; }
      const HP = { apikey: kkP, Authorization: 'Bearer ' + kkP };
      const corte30 = new Date(hojeP.getTime() - 30 * 86400000).toISOString().slice(0, 10);
      const corte60 = new Date(hojeP.getTime() - 60 * 86400000).toISOString().slice(0, 10);
      const porSku = {};
      let diasComVenda = new Set(), offP = 0, linhasLidas = 0;
      try {
        while (offP < 120000) {
          const rq = await fetch(uP.replace(/\/+$/, '') + '/rest/v1/vendas_historico?empresa=eq.girassol&data_venda=gte.' + dePV + '&data_venda=lte.' + atePV +
                    '&select=sku,descricao,quantidade,valor_produto,margem,data_venda&order=data_venda.asc,numero_pedido.asc,sku.asc&limit=1000&offset=' + offP, { headers: HP });
          if (!rq.ok) break;
          const ln = await rq.json().catch(() => []);
          if (!Array.isArray(ln) || !ln.length) break;
          linhasLidas += ln.length;
          for (const l of ln) {
            const sk = l.sku || '(sem sku)';
            if (!porSku[sk]) porSku[sk] = { sku: sk, desc: l.descricao || '', un: 0, fat: 0, mar: 0, un30: 0, un3060: 0, dias: new Set() };
            const o = porSku[sk], q = Number(l.quantidade) || 0, d = String(l.data_venda || '').slice(0, 10);
            o.un += q; o.fat += Number(l.valor_produto) || 0; o.mar += Number(l.margem) || 0;
            if (d >= corte30) o.un30 += q; else if (d >= corte60) o.un3060 += q;
            if (d) { o.dias.add(d); diasComVenda.add(d); }
          }
          if (ln.length < 1000) break;
          offP += 1000;
        }
      } catch (e) { json(res, 500, { ok: false, erro: String(e.message || e) }); return true; }
      const lista = Object.values(porSku).map(o => {
        const mediaDia = o.un / baseDias;
        // tendência: últimos 30 dias contra os 30 anteriores
        const tend = o.un3060 > 0 ? ((o.un30 - o.un3060) / o.un3060) : (o.un30 > 0 ? 1 : 0);
        // ── 09/08: o PESO DO RECENTE AGORA CAI CONFORME O HORIZONTE CRESCE ────────
        // Antes era 70% recente + 30% média geral em TODOS os prazos. Num produto que
        // acelerou (o KP16 vendeu 726 no último mês contra 432 no anterior), isso
        // esticava o mês quente por um ano inteiro: 8,7/dia de média virava 19,5/dia
        // na projeção, e o ano dava 7.135 un. contra 1.564 vendidas em 6 meses.
        // O Diego estranhou com razão. A correção é estatística, não de gosto: o ritmo
        // recente prevê BEM o curto prazo e MAL o longo. Então quanto mais longe o
        // horizonte, mais a média longa manda.
        const mediaRec = o.un30 / 30;
        const pesoRec = d => (d <= 7 ? 0.70 : d <= 30 ? 0.55 : d <= 90 ? 0.40 : d <= 180 ? 0.30 : 0.20);
        const pr = d => {
          if (!(o.un30 > 0)) return Math.round(mediaDia * d);
          const w = pesoRec(d);
          // (tinha posto um teto em `mediaRec` aqui e TIREI: a mistura já fica sempre
          //  entre as duas médias, então o teto nunca pegava no produto SUBINDO — e no
          //  produto CAINDO ele jogava a projeção pro ritmo recente, subestimando de
          //  propósito o que não devia. Previsão é previsão; quem tem que ser
          //  conservador é o plano de compra, e lá o teto continua, de caso pensado.)
          return Math.round((mediaRec * w + mediaDia * (1 - w)) * d);
        };
        const base = (o.un30 > 0 ? (mediaRec * 0.30 + mediaDia * 0.70) : mediaDia);   // referência de 180d, só p/ exibir
        return {
          sku: o.sku, desc: o.desc, un: o.un, fat: Math.round(o.fat * 100) / 100,
          margem: Math.round(o.mar * 100) / 100,
          dias_com_venda: o.dias.size,
          media_dia: Math.round(mediaDia * 1000) / 1000,
          un30: o.un30, un_30_60: o.un3060,
          tendencia: Math.round(tend * 100),
          p7: pr(7), p30: pr(30), p90: pr(90), p180: pr(180), p365: pr(365)
        };
      }).filter(x => x.un > 0).sort((a, b) => b.p365 - a.p365).slice(0, 400);
      const dados = { ok: true, base_dias: baseDias, de: dePV, ate: atePV, linhas: linhasLidas,
                      dias_com_venda: diasComVenda.size, skus: lista.length, produtos: lista };
      _histCache[ck] = { ts: Date.now(), dados };
      json(res, 200, dados);
      return true;
    }

    // LISTA do histórico, paginada por PEDIDO (o banco guarda 1 linha por ITEM, então agrupa antes).
    // Uso: /girassol-backup-offline/historico-linhas?de=&ate=&off=0&lim=100
    if (method === 'GET' && p === '/girassol-backup-offline/historico-linhas') {
      const kR = (urlObj.searchParams && urlObj.searchParams.get('k')) || '';
      const sessR = validarSessao(req.headers['cookie']);
      if (!((process.env.ADMIN_KEY && kR === process.env.ADMIN_KEY) || (sessR && ehAdmin(sessR)))) { json(res, 404, { error: 'not found' }); return true; }
      const deR = String((urlObj.searchParams && urlObj.searchParams.get('de')) || '').slice(0, 10);
      const ateR = String((urlObj.searchParams && urlObj.searchParams.get('ate')) || '').slice(0, 10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(deR) || !/^\d{4}-\d{2}-\d{2}$/.test(ateR)) { json(res, 400, { ok: false, erro: 'passe &de=&ate=' }); return true; }
      const lim = Math.min(200, Math.max(10, parseInt((urlObj.searchParams && urlObj.searchParams.get('lim')) || '100', 10) || 100));
      const pagina = Math.max(1, parseInt((urlObj.searchParams && urlObj.searchParams.get('pagina')) || '1', 10) || 1);
      const { url: uR, key: kkR } = supaCfg('girassol');
      if (!uR || !kkR) { json(res, 500, { ok: false, erro: 'Supabase não configurado' }); return true; }
      const HH = { apikey: kkR, Authorization: 'Bearer ' + kkR };
      const BASE = uR.replace(/\/+$/, '') + '/rest/v1/vendas_historico?empresa=eq.girassol&data_venda=gte.' + deR + '&data_venda=lte.' + ateR;
      // ÍNDICE DE PEDIDOS do período (só o número — leve) pra saber onde cada página começa.
      // Cacheado 10 min: permite pular direto pra qualquer página, sem varrer o banco de novo.
      // 01/08 — FILTRO DE CANAL NO SERVIDOR. Antes a lista do Mês/Ano IGNORAVA o canal escolhido:
      // os cards filtravam, a lista mostrava todos, e o contador vinha de um terceiro lugar (o cache
      // local de ~6 dias). Três fontes discordando — dropdown 762, card 876, lista sem filtro.
      const canalR = String((urlObj.searchParams && urlObj.searchParams.get('canal')) || '').trim().toLowerCase();
      const filtroCanal = /^[a-z0-9_]{1,20}$/.test(canalR) ? canalR : '';
      const qCanal = filtroCanal ? ('&canal=eq.' + encodeURIComponent(filtroCanal)) : '';
      // 18/08 — BUSCA POR TEXTO NO SERVIDOR (mesmo buraco que o card 🔍 tinha, um andar acima):
      // no período longo a LISTA vem paginada daqui, e o campo 🔎 da Análise só filtrava a memória
      // do navegador — digitar o nº de um pedido de julho não filtrava NADA, e a tela ainda dizia
      // que a busca filtrava a lista. Agora o termo chega aqui e vale pro período inteiro.
      // Mesmas regras da rota /buscar-lucro: termo INTEIRO entre aspas do PostgREST (pontuação
      // preservada), coringa escapado, corte por CARACTERE e as três classes (nº exato, pedaço de
      // identificador, SKU/descrição) — o exato entra primeiro.
      const qTxt = Array.from(String((urlObj.searchParams && urlObj.searchParams.get('q')) || '').trim())
                   .slice(0, 60).join('').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
      const usaQ = qTxt.length >= 2;
      const citaR = v => '"' + String(v).replace(/([\\"])/g, '\\$1') + '"';
      const ck = 'idx|' + deR + '|' + ateR + '|' + (filtroCanal || 'todos') + (usaQ ? ('|q:' + qTxt.toLowerCase()) : '');
      let idx = (_histCache[ck] && (Date.now() - _histCache[ck].ts) < 600000) ? _histCache[ck].dados : null;
      if (!idx && usaQ) {
        // ÍNDICE FILTRADO: descobre os pedidos que casam e ordena por data (mais novos em cima),
        // como o resto da lista. Cada classe traz no máx. 1.000 linhas; o teto de 3.000 pedidos
        // evita varrer o ano inteiro por um termo genérico.
        const eqR = encodeURIComponent(citaR(qTxt));
        const likeR = encodeURIComponent(citaR('*' + qTxt.replace(/([\\%_*])/g, '\\$1') + '*'));
        const puxaAlvos = async filtro => {
          const out = [];
          try {
            const rA = await fetch(BASE + qCanal + filtro + '&select=numero_pedido,data_venda&order=data_venda.desc,numero_pedido.desc&limit=1000', { headers: HH });
            if (!rA.ok) return out;
            const ln = await rA.json().catch(() => []);
            for (const l of (Array.isArray(ln) ? ln : [])) {
              if (l && l.numero_pedido != null) out.push({ n: String(l.numero_pedido), d: String(l.data_venda || '') });
            }
          } catch (e) {}
          return out;
        };
        const achados = new Map();   // numero → data mais recente
        const junta = arr => { for (const a of arr) { const at = achados.get(a.n); if (!at || a.d > at) achados.set(a.n, a.d); } };
        junta(await puxaAlvos('&or=(numero_pedido.eq.' + eqR + ',numero_loja.eq.' + eqR + ')'));
        junta(await puxaAlvos('&or=(numero_pedido.ilike.' + likeR + ',numero_loja.ilike.' + likeR + ')'));
        junta(await puxaAlvos('&or=(sku.ilike.' + likeR + ',descricao.ilike.' + likeR + ')'));
        idx = Array.from(achados.entries()).map(([n, d]) => ({ n, d, c: 0 }))
              .sort((a, b) => (b.d.localeCompare(a.d)) || (b.n.localeCompare(a.n)))
              .slice(0, 3000);
        _histCache[ck] = { ts: Date.now(), dados: idx };
      }
      if (!idx) {
        idx = [];
        try {
          let o2 = 0;
          while (o2 < 80000) {
          // 01/08: FALTAVA O DESEMPATE POR SKU aqui. Pedido com vários itens tem várias linhas com
          // a MESMA (data, número) — sem um terceiro critério a ordem varia entre as páginas e linhas
          // são puladas. Era por isso que a lista dizia 3.541 e os cards 3.669 no mesmo julho.
            const ri = await fetch(BASE + qCanal + '&select=numero_pedido&order=data_venda.desc,numero_pedido.desc,sku.desc&limit=1000&offset=' + o2, { headers: HH });
            const ln = await ri.json().catch(() => []);
            if (!Array.isArray(ln) || !ln.length) break;
            for (const l of ln) {
              const k = String(l.numero_pedido || '(sem número)');
              if (idx.length && idx[idx.length - 1].n === k) idx[idx.length - 1].c++;
              else idx.push({ n: k, c: 1 });
            }
            if (ln.length < 1000) break;
            o2 += 1000;
          }
        } catch (e) {}
        _histCache[ck] = { ts: Date.now(), dados: idx };
      }
      const totalPedidos = idx.length, totalPaginas = Math.max(1, Math.ceil(totalPedidos / lim));
      const pg = Math.min(pagina, totalPaginas);
      const iniPed = (pg - 1) * lim, fimPed = Math.min(totalPedidos, iniPed + lim);
      let off = 0; for (let i = 0; i < iniPed; i++) off += idx[i].c;
      let qtdItens = 0; for (let i = iniPed; i < fimPed; i++) qtdItens += idx[i].c;
      const campos = 'numero_pedido,numero_loja,canal,data_venda,sku,descricao,quantidade,valor_produto,valor_nota,custo,comissao,frete_vendedor,imposto,margem,uf'   // 17/08: uf entra pro card Vendas por Estado;
      let linhas = [];
      try {
        // Com termo o índice não conta linhas por pedido (o offset por linha não se aplica):
        // a página é a FATIA de pedidos e as linhas vêm por numero_pedido=in.(…) — assim o pedido
        // multi-item vem INTEIRO, e não só as linhas que casaram com o termo.
        const alvosPg = usaQ ? idx.slice(iniPed, fimPed).map(x => x.n) : null;
        const url = usaQ
          ? (alvosPg.length
              ? BASE + qCanal + '&numero_pedido=in.(' + alvosPg.map(encodeURIComponent).join(',') + ')&select=' + campos + '&order=data_venda.desc,numero_pedido.desc,sku.desc&limit=4000'
              : null)
          : BASE + qCanal + '&select=' + campos + '&order=data_venda.desc,numero_pedido.desc,sku.desc&limit=' + Math.max(1, qtdItens) + '&offset=' + off;
        if (url) {
          const rq = await fetch(url, { headers: HH });
          linhas = await rq.json().catch(() => []);
          if (!Array.isArray(linhas)) linhas = [];
        }
      } catch (e) { json(res, 500, { ok: false, erro: String(e.message || e) }); return true; }
      const _ccR = _comManual(readJson(path.join(CACHE_DIR, '_custos.json'), {}));
      // 01/08: mesmo recálculo do imposto na lista de vendas do período longo
      const _cfgR = readJson(path.join(CACHE_DIR, '_config-fiscal.json'), { aliquotas: {} });
      const _aliqR = mes => { const a = _cfgR.aliquotas && _cfgR.aliquotas[mes];
        /* 19/08: mês salvo como 0% era campo em BRANCO gravado por engano — zero não é
           alíquota, cai no padrão. */
        if (a != null && isFinite(Number(a)) && Number(a) > 0) return Number(a);
        return (DEFAULT_ALIQ_BK && DEFAULT_ALIQ_BK[mes] != null) ? Number(DEFAULT_ALIQ_BK[mes]) : null; };
      const _cuR = sk => { const c = _ccR[String(sk || '').trim()]; return (c && c.custo != null && isFinite(Number(c.custo))) ? Number(c.custo) : null; };
      const ordem = [], mapa = {};
      for (const l of linhas) {
        const k = String(l.numero_pedido || '(sem número)');
        if (!mapa[k]) { mapa[k] = { numero: k, numero_loja: l.numero_loja || null, canal: l.canal || 'outro', data: l.data_venda, itens: [], un: 0, vprod: 0, vnota: 0, custo: 0, semCusto: 0, comissao: 0, frete: 0, imposto: 0, margem: 0 }; ordem.push(k); }
        const o = mapa[k], q = Number(l.quantidade) || 0;
        o.itens.push({ sku: l.sku || '', qtd: q });
        o.un += q; o.vprod += Number(l.valor_produto) || 0; o.vnota += Number(l.valor_nota) || 0;
        // 28/07: mesmo reparo do agregado — custo cadastrado depois do backfill entra na leitura
        { const _ig = Number(l.imposto) || 0, _vn = Number(l.valor_nota) || 0;
          const _aq = _aliqR(String(l.data_venda || '').slice(0, 7));
          if (_aq != null && _vn > 0) { const _nv = Math.round(_vn * _aq / 100 * 100) / 100;
            if (Math.abs(_nv - _ig) > 0.005) { o.imposto += (_nv - _ig); o.margem -= (_nv - _ig); } } }
        if (l.custo != null) o.custo += Number(l.custo);
        else { const cxR = _cuR(l.sku); if (cxR != null) o.custo += cxR * q; else o.semCusto += q; }
        o.comissao += Number(l.comissao) || 0; o.frete += Number(l.frete_vendedor) || 0;
        o.imposto += Number(l.imposto) || 0; if (l.margem != null) o.margem += Number(l.margem);
      }
      const pedidos = ordem.map(k => {
        const o = mapa[k];
        ['vprod','vnota','custo','comissao','frete','imposto','margem'].forEach(c => { o[c] = Math.round(o[c] * 100) / 100; });
        return o;
      });
      json(res, 200, { ok: true, pedidos, pagina: pg, total_paginas: totalPaginas, total_pedidos: totalPedidos, por_pagina: lim, q: (usaQ ? qTxt : null), filtrado: usaQ });
      return true;
    }

    // HISTÓRICO LONGO (Supabase): períodos que não cabem na janela local (Ano, 6 meses...).
    // Agrega no servidor e devolve pronto — o navegador não aguenta 23 mil linhas.
    // Uso: /girassol-backup-offline/historico-longo?de=YYYY-MM-DD&ate=YYYY-MM-DD
    if (method === 'GET' && p === '/girassol-backup-offline/historico-longo') {
      const kL = (urlObj.searchParams && urlObj.searchParams.get('k')) || '';
      const sessL = validarSessao(req.headers['cookie']);
      if (!((process.env.ADMIN_KEY && kL === process.env.ADMIN_KEY) || (sessL && ehAdmin(sessL)))) { json(res, 404, { error: 'not found' }); return true; }
      const deL = String((urlObj.searchParams && urlObj.searchParams.get('de')) || '').slice(0, 10);
      const ateL = String((urlObj.searchParams && urlObj.searchParams.get('ate')) || '').slice(0, 10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(deL) || !/^\d{4}-\d{2}-\d{2}$/.test(ateL)) { json(res, 400, { ok: false, erro: 'passe &de=&ate=' }); return true; }
      const cacheKey = deL + '|' + ateL;
      // 17/08 — o cache de 10 min escondia o resultado do backfill que acabou de rodar: a
      // conferência da UF voltava o retorno ANTIGO (ufs vazio) e parecia que o conserto não
      // tinha funcionado. `&fresh=1` ignora o cache — o mesmo parâmetro que a rota de previsão
      // já tinha. Sem ele nada muda (o cache continua valendo pro dashboard).
      const _freshL = (urlObj.searchParams && urlObj.searchParams.get('fresh')) === '1';
      if (!_freshL && _histCache[cacheKey] && (Date.now() - _histCache[cacheKey].ts) < 600000) { json(res, 200, Object.assign({ cache: true }, _histCache[cacheKey].dados)); return true; }
      const { url: uL, key: kkL } = supaCfg('girassol');
      if (!uL || !kkL) { json(res, 500, { ok: false, erro: 'Supabase não configurado' }); return true; }
      const H = { apikey: kkL, Authorization: 'Bearer ' + kkL };
      const campos = 'numero_pedido,canal,data_venda,sku,descricao,quantidade,valor_produto,valor_nota,custo,comissao,frete_vendedor,imposto,margem,uf'   // 17/08: sem isto o historico-longo lia uf vazio em TODA linha (havia dois `campos` no arquivo e o uf tinha entrado no outro);
      // 28/07: o backfill gravou o custo que existia NAQUELE dia. Depois o banco de custos cresceu
      // (de 288 pra 541 SKUs), então muita linha antiga ficou sem custo à toa. Aqui completamos na
      // LEITURA com o _custos.json atual — sem precisar refazer o backfill inteiro.
      /* 21/08 — o custo MANUAL também vale no período longo: sem isto o número apareceria
         em Hoje/7 dias e sumiria no Mês/Ano — o mesmo padrão que o Diego encontrou 3× em
         20/08 (links, tarifa do TikTok, frete da Magalu). Atrás do Bling, como na tela. */
      const _ccL = _comManual(readJson(path.join(CACHE_DIR, '_custos.json'), {}));
      // 01/08 — IMPOSTO CALCULADO NA LEITURA (mesma ideia do custo). Antes ele ficava CONGELADO na
      // linha, gravado no momento do backfill: editar a alíquota de um mês não mudava nada no
      // Mês/Ano, e só re-rodando o backfill daquele período. Agora a alíquota atual manda — editou,
      // valeu na hora, sem rodar nada.
      const _cfgL = readJson(path.join(CACHE_DIR, '_config-fiscal.json'), { aliquotas: {} });
      const _aliqL = mes => {
        const a = _cfgL.aliquotas && _cfgL.aliquotas[mes];
        /* 19/08: mês salvo como 0% era campo em BRANCO gravado por engano — zero não é
           alíquota, cai no padrão. */
        if (a != null && isFinite(Number(a)) && Number(a) > 0) return Number(a);
        return (DEFAULT_ALIQ_BK && DEFAULT_ALIQ_BK[mes] != null) ? Number(DEFAULT_ALIQ_BK[mes]) : null;
      };
      let _impRecalc = 0;
      const _cuL = sk => { const c = _ccL[String(sk || '').trim()]; return (c && c.custo != null && isFinite(Number(c.custo))) ? Number(c.custo) : null; };
      let _repostos = 0;
      const T = { fat: 0, prod: 0, imp: 0, cus: 0, com: 0, fre: 0, mar: 0, un: 0, itens: 0, semCusto: 0 };
      const peds = new Set(), porCanal = {}, porSku = {}, porDia = {}, porUF = {}, semCustoSet = new Set();
      /* ═══════════════ 20/08 — O QUE O CACHE CALCULA, O HISTÓRICO TAMBÉM CALCULA ═══════════════
         Terceira vez no mesmo dia que o Diego encontra o mesmo padrão: um número aparece em
         Hoje/Ontem/7 dias e some no Mês/Ano. Aconteceu com os links do marketplace, com a tarifa
         do TikTok e agora com o frete PREVISTO da Magalu (106 pedidos da AMB com frete "—" e a
         margem inflada). A causa é sempre a mesma: o período curto passa pelo `calcPL`, que
         COMPLETA o que falta; o período longo lê o banco cru, onde só está o que o backfill gravou.
         Ele pediu: "já ajusta pra resolver em qqer marketplace e pra todos e sempre".
         ESTE É O PONTO ÚNICO onde o histórico completa o que falta — para acrescentar um caso novo
         (outro canal, outro campo), é aqui, e vale para qualquer canal.
         Hoje trata: FRETE do vendedor ausente, pela mesma fonte do cache (a média do frete REAL
         por SKU, que se corrige sozinha conforme os pedidos liquidam). Entra na soma e SAI da
         margem, como qualquer custo. */
      const _freteSkuBanco = (() => { try { return readJson(path.join(CACHE_DIR, '_magalu_frete_sku.json'), {}) || {}; } catch (e) { return {}; } })();
      const _fretePrevistoDe = (canal, sku, qtd) => {
        const ck = String(canal || '').toLowerCase();
        if (ck !== 'magalu') return null;          // só a Magalu tem banco por SKU hoje; outros canais entram AQUI
        const b = _freteSkuBanco[String(sku || '').trim()];
        const m = b && Number(b.media);
        if (!(m > 0)) return null;
        return Math.round(m * Math.max(1, Number(qtd) || 1) * 100) / 100;
      };
      let _fretesPrevistos = 0;   // linhas em que o frete do vendedor foi completado pelo previsto
      let _tkEstimadas = 0;
      const _tkPed = {};   // TikTok agrupado por PEDIDO: a faixa e a taxa fixa são do pedido inteiro   // linhas do TikTok em que a regra substituiu a taxa do Bling
      // 31/07: o dashboard mostrava "17.351 pedidos sem alíquota" no filtro Ano porque cruzava o
      // TOTAL do histórico com a contagem dos dados LOCAIS (só ~6 dias). Agora o servidor conta de
      // verdade: pedido cujas linhas somam imposto ZERO, e de quais meses são.
      const pedImposto = {}, pedData = {}, semImpMeses = new Set();   // 01/08: +pedData p/ dizer QUAL pedido está sem alíquota, e de quando
      let offset = 0, paginas = 0;
      try {
        while (offset < 60000) {
          const rq = await fetch(uL.replace(/\/+$/, '') + '/rest/v1/vendas_historico?empresa=eq.girassol&data_venda=gte.' + deL + '&data_venda=lte.' + ateL + '&select=' + campos + '&order=data_venda.asc,numero_pedido.asc,sku.asc&limit=1000&offset=' + offset, { headers: H });
          if (!rq.ok) break;
          const linhas = await rq.json().catch(() => []);
          if (!Array.isArray(linhas) || !linhas.length) break;
          paginas++;
          for (const l of linhas) {
            const q = Number(l.quantidade) || 0, vp = Number(l.valor_produto) || 0, vn = Number(l.valor_nota) || 0;
            let cu = (l.custo == null ? null : Number(l.custo));
            if (cu == null) { const cx = _cuL(l.sku); if (cx != null) { cu = cx * q; _repostos++; } }   // custo cadastrado DEPOIS do backfill
            let co = Number(l.comissao) || 0; const _coGrav = co;
            let fr = Number(l.frete_vendedor) || 0;
            /* frete ausente: completa com o previsto (mesma fonte do cache) e conta como custo */
            let _frPrev = 0;
            if (!(fr > 0)) {
              const _fp = _fretePrevistoDe(l.canal, l.sku, q);
              if (_fp != null) { fr = _fp; _frPrev = _fp; _fretesPrevistos++; }
            }
            /* ═══ 20/08 — TikTok: enquanto a comissão gravada ainda é a do BLING, vale a REGRA ═══
               O extrato do TikTok chega dias depois e o completar substitui a comissão pela real —
               e a coleta fecha 100% (0 sobras em 5.610 pedidos na Girassol e 33 na AMB), então o
               ano já está certo em tudo que liquidou. Fica só a ponta recente com a taxa do Bling
               (~12% cravados dos produtos, sem a taxa fixa por item — sempre otimista).
               Aqui a regra oficial entra NA LEITURA, como já acontece com o imposto: Mês e Ano
               passam a mostrar o número próximo do real sem regravar nada, e a substituição some
               sozinha quando o extrato chega. Não inclui afiliado (só existe se veio de creator).
               Vale a partir de 15/07/2026, quando a tabela passou a valer. */
            /* ═══ 20/08 — TikTok: a REGRA vale enquanto a comissão gravada é a do Bling ═══
               Codex (P2): a faixa dos R$ 50 e a taxa fixa por item são do PEDIDO INTEIRO, não da
               linha — dois itens de R$ 30 no mesmo pedido não são dois pedidos abaixo de 50. E a
               base é o valor EFETIVO (com desconto), o mesmo que a margem reconhece. Por isso aqui
               só JUNTO as linhas por pedido; a conta sai depois do laço, uma vez por pedido. */
            if (String(l.canal || '').toLowerCase() === 'tiktok' && String(l.data_venda || '') >= '2026-07-15') {
              const kTk = String(l.numero_pedido || l.numero_loja || '');
              if (kTk) {
                let g = _tkPed[kTk];
                if (!g) g = _tkPed[kTk] = { vp: 0, vn: 0, q: 0, co: 0, linhas: 0 };
                g.vp += vp; g.vn += vn; g.q += q; g.co += _coGrav; g.linhas++;
              }
            }
            const _imGrav = Number(l.imposto) || 0;
            let im = _imGrav;
            { const _aq = _aliqL(String(l.data_venda || '').slice(0, 7));
              if (_aq != null && vn > 0) { const _novo = Math.round(vn * _aq / 100 * 100) / 100;
                if (Math.abs(_novo - _imGrav) > 0.005) { im = _novo; _impRecalc++; } } }
            T.itens++; T.un += q; T.prod += vp; T.fat += vn; T.imp += im; T.com += co; T.fre += fr;
            if (cu != null) T.cus += cu; else { T.semCusto += q; if (l.sku) semCustoSet.add(String(l.sku)); }
            { const kp = String(l.numero_pedido || l.numero_loja || '');
              if (kp) { pedImposto[kp] = (pedImposto[kp] || 0) + im;
                        if (!pedData[kp]) pedData[kp] = String(l.data_venda || '').slice(0, 10); } }
            let mg = (l.margem == null ? null : Number(l.margem));
            if (mg != null) mg -= (im - _imGrav);   // imposto recalculado: a margem acompanha
            if (mg != null && _frPrev > 0) mg -= _frPrev;   // frete completado: sai da margem, como qualquer custo

            if (mg != null && l.custo == null && cu != null) mg -= cu;   // margem gravada sem custo: desconta o custo reposto
            if (mg != null) T.mar += mg;
            if (l.numero_pedido) peds.add(String(l.numero_pedido));
            const cn = l.canal || 'outro';
            // 01/08: o resumo da Análise no período longo mostrava sempre o total do período, mesmo
            // filtrando por canal — porque o agregado por canal só tinha fat/un/margem. Agora traz
            // imposto, comissão, frete, custo e itens, e o filtro passa a valer no resumo também.
            if (!porCanal[cn]) porCanal[cn] = { fat: 0, un: 0, mar: 0, imp: 0, com: 0, fre: 0, cus: 0, itens: 0, peds: new Set() };
            porCanal[cn].fat += vn; porCanal[cn].un += q; porCanal[cn].mar += (mg || 0);
            porCanal[cn].imp += im; porCanal[cn].com += co; porCanal[cn].fre += fr; porCanal[cn].cus += (cu || 0); porCanal[cn].itens++;
            if (l.numero_pedido) porCanal[cn].peds.add(String(l.numero_pedido));
            const sk = l.sku || '(sem sku)';
            if (!porSku[sk]) porSku[sk] = { sku: sk, desc: l.descricao || '', un: 0, fat: 0, cus: 0, mar: 0 };
            porSku[sk].un += q; porSku[sk].fat += vp; porSku[sk].cus += (cu != null ? cu : 0); porSku[sk].mar += (mg || 0);
            const dd = String(l.data_venda || '').slice(0, 10);
            // 17/08 — o card "Progressão do Período" desenhava a curva a partir do CACHE do
            // checkout, que guarda poucos dias: de ~7 dias pra trás o gráfico ficava vazio ou
            // errado (o Diego viu na AMB e na Girassol). O histórico já tem tudo por linha —
            // faltava só devolver margem, imposto, tarifa e frete POR DIA, como aqui.
            if (dd) { if (!porDia[dd]) porDia[dd] = { fat: 0, mar: 0, imp: 0, com: 0, fre: 0, peds: new Set() };
              porDia[dd].fat += vn; porDia[dd].mar += (mg || 0); porDia[dd].imp += im; porDia[dd].com += co; porDia[dd].fre += fr;
              if (l.numero_pedido) porDia[dd].peds.add(String(l.numero_pedido)); }
            // 17/08 — POR ESTADO: este card era o último lendo só o cache do checkout (~6 dias),
            // então em Mês/Ano mostrava um pedaço do período como se fosse o todo. Linha antiga
            // (gravada antes da UF entrar no backfill) cai em "—" e o painel avisa, sem mentir.
            const ufL = String(l.uf || '').trim().toUpperCase().slice(0, 2);
            const kUF = ufL || '—';
            if (!porUF[kUF]) porUF[kUF] = { uf: kUF, fat: 0, un: 0, mar: 0, peds: new Set() };
            porUF[kUF].fat += vn; porUF[kUF].un += q; porUF[kUF].mar += (mg || 0);
            if (l.numero_pedido) porUF[kUF].peds.add(String(l.numero_pedido));
          }
          if (linhas.length < 1000) break;
          offset += 1000;
        }
      } catch (e) { json(res, 500, { ok: false, erro: String(e.message || e) }); return true; }
      /* A conta do TikTok, uma vez por PEDIDO (faixa e fixa são do pedido inteiro):
         só entra quando a comissão somada tem a assinatura do Bling (~12% do produto, ou zero) e a
         regra dá um valor MAIOR — nunca reduz tarifa já real. A margem acompanha na mesma medida. */
      for (const g of Object.values(_tkPed)) {
        const base = (g.vn > 0 && g.vn < g.vp) ? g.vn : g.vp;   // valor efetivo, como no calcPL
        if (!(base > 0)) continue;
        const tol = Math.min(1.00, Math.max(0.10, base * 0.005));
        const daBling = !(g.co > 0) || Math.abs(g.co - base * 0.12) <= tol;
        if (!daBling) continue;
        const abaixo = base < 50;
        const est = Math.round((base * (abaixo ? 0.10 : 0.06) + (abaixo ? 4 : 6) * Math.max(1, g.q) + base * 0.06) * 100) / 100;
        if (!(est > g.co)) continue;
        const dif = Math.round((est - g.co) * 100) / 100;
        T.com += dif; T.mar -= dif; _tkEstimadas++;
        // o canal também: senão o card Por Canal mostra número diferente do total
        const ct = porCanal['tiktok'];
        if (ct) { ct.com = (ct.com || 0) + dif; ct.mar = (ct.mar || 0) - dif; }
      }
      const canais = {}; for (const c of Object.keys(porCanal)) canais[c] = {
        fat: Math.round(porCanal[c].fat * 100) / 100, un: porCanal[c].un,
        mar: Math.round(porCanal[c].mar * 100) / 100, pedidos: porCanal[c].peds.size,
        imp: Math.round((porCanal[c].imp || 0) * 100) / 100, com: Math.round((porCanal[c].com || 0) * 100) / 100,
        fre: Math.round((porCanal[c].fre || 0) * 100) / 100, cus: Math.round((porCanal[c].cus || 0) * 100) / 100,
        itens: porCanal[c].itens || 0 };
      const dias = {}; for (const d of Object.keys(porDia)) dias[d] = {
        fat: Math.round(porDia[d].fat * 100) / 100, pedidos: porDia[d].peds.size,
        mar: Math.round((porDia[d].mar || 0) * 100) / 100, imp: Math.round((porDia[d].imp || 0) * 100) / 100,
        com: Math.round((porDia[d].com || 0) * 100) / 100, fre: Math.round((porDia[d].fre || 0) * 100) / 100 };
      const ufs = Object.values(porUF).filter(u => u.uf !== '—').map(u => ({ uf: u.uf,
        fat: Math.round(u.fat * 100) / 100, un: u.un, mar: Math.round(u.mar * 100) / 100, pedidos: u.peds.size }))
        .sort((a, b) => b.fat - a.fat);
      const pedSemUF = (porUF['—'] && porUF['—'].peds.size) || 0;
      const skus = Object.values(porSku).sort((a, b) => b.mar - a.mar).slice(0, 300)
        .map(x => ({ sku: x.sku, desc: x.desc, un: x.un, fat: Math.round(x.fat * 100) / 100, cus: Math.round(x.cus * 100) / 100, mar: Math.round(x.mar * 100) / 100 }));
      const dados = { ok: true, de: deL, ate: ateL, fonte: 'supabase', paginas, ufs, pedidos_sem_uf: pedSemUF,
        totais: { faturamento: Math.round(T.fat * 100) / 100, produtos: Math.round(T.prod * 100) / 100, imposto: Math.round(T.imp * 100) / 100,
                  custo: Math.round(T.cus * 100) / 100, comissao: Math.round(T.com * 100) / 100, frete: Math.round(T.fre * 100) / 100,
                  margem: Math.round(T.mar * 100) / 100, pedidos: peds.size, unidades: T.un, itens: T.itens, un_sem_custo: T.semCusto,
                  tiktok_tarifa_estimada: _tkEstimadas,
                  fretes_previstos: _fretesPrevistos,   // frete que não estava gravado e foi completado na leitura   // quantos PEDIDOS ainda usam a REGRA (o extrato não chegou)
                  skus_sem_custo: Array.from(semCustoSet).slice(0, 60), custos_repostos: _repostos, impostos_recalculados: _impRecalc,
                  pedidos_sem_imposto: Object.values(pedImposto).filter(v => !(v > 0)).length,
                  // 01/08: não basta contar — o Diego perguntou "qual é o pedido?". Agora vai a lista,
                  // com a data, pra ele achar no Bling sem caçar.
                  pedidos_sem_imposto_lista: Object.keys(pedImposto).filter(k2 => !(pedImposto[k2] > 0))
                                               .slice(0, 20).map(k2 => ({ pedido: k2, data: pedData[k2] || null })) },
        canais, dias, skus };
      _histCache[cacheKey] = { ts: Date.now(), dados };
      json(res, 200, dados);
      return true;
    }

    // HISTÓRICO — últimos pedidos finalizados (do conferidos.json), mais recentes primeiro
    if (method === 'GET' && p === '/girassol-backup-offline/historico') {
      // Codex PR#38 (P1): o "NUNCA estoquista" vale pra INFORMAÇÃO, não só pra página do
      // dashboard. Em camadas: ADMIN (sessão de admin OU ?k=ADMIN_KEY) → resposta completa;
      // operador logado (estoquista) → itens SEM os campos financeiros (o modal 🕘 do painel
      // só precisa de identificação/etiqueta); sem sessão e sem chave → 401.
      const sessH9 = validarSessao(req.headers['cookie']);
      const kH9 = urlObj.searchParams.get('k') || '';
      const admH9 = (process.env.ADMIN_KEY && kH9 === process.env.ADMIN_KEY) || (sessH9 && ehAdmin(sessH9));
      if (!admH9 && !sessH9) { json(res, 401, { ok: false, erro: 'Sessão necessária. Faça login.' }); return true; }
      const conf = readJson(CONFERIDOS_FILE, {});
      // BUGFIX d45: o backfill de nf_emissao rodava DEPOIS do map — a resposta do 1º carregamento saía sem a hora
      // da NF (só o 2º F5 pegava). Agora completa o conf ANTES de montar os itens.
      let _mudouNF=false;
      for (const [cid2,c3] of Object.entries(conf)) { if (c3 && (c3.nf_emissao === undefined || c3.nf_id === undefined)) { const sn2 = readJson(path.join(CACHE_DIR, String(cid2), 'pedido.json'), null); if (c3.nf_emissao === undefined) c3.nf_emissao = (sn2 && sn2.nf && sn2.nf.dataEmissao) || null; if (c3.nf_id === undefined) c3.nf_id = (sn2 && sn2.nf && sn2.nf.id) || null; _mudouNF=true; } }
      if (_mudouNF) { try { writeJson(CONFERIDOS_FILE, conf); } catch(e){} }
      const itens = Object.keys(conf).map(id => ({ id, ...conf[id] }))
        .sort((a, b) => String(b.conferido_em || '').localeCompare(String(a.conferido_em || '')));
      const reenvios = readJson(CONFERIDOS_FILE.replace('conferidos.json', 'reenvios.json'), {});
      const reenvioDireto = String(process.env.CHECKOUT_REENVIO_DIRETO_EMPRESAS || '').toLowerCase().split(',').map(s => s.trim()).includes('girassol');
      const vendasB = Object.values(readJson(path.join(CACHE_DIR, '_vendas_dia.json'), {}));
      // CANCELADO PRONTO (27/07): o servidor decide, o navegador só desenha. Antes o dashboard tentava
      // casar cada pedido bipado com a lista de vendas pra descobrir se estava cancelado — se o pedido
      // não estivesse na lista (ou o nº não casasse), a marca nunca aparecia. Agora vai no payload.
      try {
        const _vdC = readJson(path.join(CACHE_DIR, '_vendas_dia.json'), {});
        const _porNum = {}, _porId = {};
        for (const v of Object.values(_vdC)) {
          if (!v) continue;
          const canc = (/cancel/i.test(String(v.situacao || '')) || !!v.cancelado_mkt) ? 1 : 0;
          if (v.numero != null) _porNum[String(v.numero)] = { canc, sit: v.situacao || null };
          if (v.id != null) _porId[String(v.id)] = { canc, sit: v.situacao || null };
        }
        for (const h of itens) {
          const reg = _porNum[String(h.numero)] || _porId[String(h.id)] || null;
          if (reg) { h.cancelado = reg.canc; if (!h.situacao_mkt && reg.sit) h.situacao_mkt = reg.sit; }
          else h.cancelado = 0;
        }
        for (const v of vendasB) { v.cancelado = (/cancel/i.test(String(v.situacao || '')) || !!v.cancelado_mkt) ? 1 : 0; }
      } catch (e) {}
      // CUSTO PRONTO (27/07): o backend já tem o banco permanente de custos (_custos.json) — manda o custo
      // junto de cada item, em vez de o dashboard consultar o Bling ao vivo (lento e falha quando o Bling satura).
      try {
        const _ccH = _comManual(readJson(path.join(CACHE_DIR, '_custos.json'), {}));
        const _cuH = sk => { const c = _ccH[String(sk || '').trim()]; return (c && c.custo != null && isFinite(Number(c.custo))) ? Number(c.custo) : null; };
        for (const h of itens) if (Array.isArray(h.itens)) h.itens = h.itens.map(it => Object.assign({}, it, { custo: _cuH(it.sku) }));
        for (const v of vendasB) if (Array.isArray(v.it)) v.it = v.it.map(it => Object.assign({}, it, { custo: _cuH(it.sku) }));
      } catch (e) {}
      if (!admH9) {
        // camada estoquista: some o financeiro dos itens e a lista de vendas (só o modal 🕘 usa esta rota sem admin)
        const FIN9 = ['custo','margem','tarifa_ml','frete_ml','credito_ml','credito_fonte','frete_recebido','renda_canal','comissao','imposto','valor_produto','valor_nota','valor','vprod_nf','taxa_mkt','frete_mkt','logistica_ml','venda_em','dev_frete_retorno','ml_costs_v3'];   // Codex 4ª rodada: vprod_nf/taxa_mkt/frete_mkt também no TOPO do conferido persistido
        for (const it9 of itens) {
          for (const c9 of FIN9) { if (c9 in it9) delete it9[c9]; }
          // Codex PR#38 (2ª rodada): o financeiro TAMBÉM mora dentro de h.itens — o injetor de
          // custo-pronto acabou de pôr `custo` por linha, e o bipe grava valor_unit/valor_total
          if (Array.isArray(it9.itens)) it9.itens = it9.itens.map(li9 => { const o9 = Object.assign({}, li9); for (const c9 of ['custo','valor_unit','valor_total','valor','preco','vprod_nf','taxa_mkt','frete_mkt']) { if (c9 in o9) delete o9[c9]; } return o9; });
        }
        while (vendasB.length) vendasB.pop();
      }
      json(res, 200, { ok: true, total: Object.keys(conf).length, itens, reenvios, reenvio_direto: reenvioDireto, vendas_bling: vendasB });
      return true;
    }

    // BUSCAR PEDIDO por número (ou ID) em QUALQUER status — ao vivo no Bling.
    // Pra achar a NF de um pedido que não passou pelo Checkout Offline.
    if (method === 'GET' && p === '/girassol-backup-offline/buscar-pedido') {
      const q = String(urlObj.searchParams.get('q') || '').trim();
      if (!q) { json(res, 400, { ok: false, erro: 'use ?q=NUMERO' }); return true; }
      let ids = [], via = null;
      // 1) tenta filtrar por número — e confiro no código (caso o Bling ignore o filtro, igual no /nfe)
      const r1 = await blingGet(`/pedidos/vendas?numero=${encodeURIComponent(q)}&limite=20`);
      if (r1.ok && r1.data && Array.isArray(r1.data.data)) {
        const match = r1.data.data.filter(p => String(p.numero) === String(q));
        if (match.length) { ids = match.map(p => p.id); via = 'numero'; }
      }
      // 2) fallback: trata q como ID interno do Bling
      if (!ids.length) {
        const r2 = await blingGet(`/pedidos/vendas/${encodeURIComponent(q)}`);
        if (r2.ok && r2.data && r2.data.data && String(r2.data.data.id) === String(q)) { ids = [r2.data.data.id]; via = 'id'; }
      }
      const pedidos = [];
      for (const id of ids.slice(0, 10)) {
        const det = await detalhePedido(id);
        if (!det) continue;
        const nf = await nfDoPedido(id);
        pedidos.push({
          id: det.id,
          numero: det.numero || null,
          data: det.data || null,
          situacao_id: (det.situacao && (det.situacao.id || det.situacao)) || null,
          cliente: (det.contato && det.contato.nome) || '',
          total: det.total || null,
          loja_id: (det.loja && det.loja.id) || null,
          itens: Array.isArray(det.itens) ? det.itens.map(it => ({ descricao: it.descricao || (it.produto && it.produto.nome) || '', sku: it.codigo || (it.produto && it.produto.codigo) || '', qtd: it.quantidade || 0 })) : [],
          nf: nf ? { id: nf.id, numero: nf.numero, chave: nf.chave } : null
        });
        await sleep(PAUSA_MS);
      }
      // também busca NOTAS FISCAIS por número (a NF tem numeração própria, diferente do pedido)
      const notas = [];
      const rnf = await blingGet(`/nfe?numero=${encodeURIComponent(q)}&limite=10`);
      if (rnf.ok && rnf.data && Array.isArray(rnf.data.data)) {
        for (const n of rnf.data.data.filter(x => String(x.numero) === String(q)).slice(0, 10)) {
          notas.push({
            id: n.id,
            numero: n.numero,
            chave: n.chaveAcesso || n.chave || null,
            cliente: (n.contato && n.contato.nome) || '',
            situacao_id: (n.situacao && (n.situacao.id || n.situacao)) || null,
            data: n.dataEmissao || n.data || null,
            valor: n.valorNota || n.valor || null
          });
        }
      }
      json(res, 200, { ok: pedidos.length > 0 || notas.length > 0, via, q, pedidos, notas });
      return true;
    }

    // 🔎 BUSCA GLOBAL DE PEDIDO E LUCRO — qualquer data, direto no Supabase (18/08).
    // O card do dashboard só filtrava a memória da página (cache de ~6 dias): pedido
    // antigo dava "nada encontrado" mesmo existindo no histórico — caso real: TikTok
    // 585044523947951326 de 15/07 (pedido 2200 da AMB, margem 87,77 no banco).
    // q SÓ DÍGITOS casa numero_loja/sku por igualdade (e numero_pedido quando cabe em
    // int4 — venda de marketplace tem 15-19 dígitos e estouraria a coluna, quebrando o
    // or= inteiro); q com letras casa sku/descricao por ilike. Agrupa por pedido e
    // devolve total e M.C. prontos do banco. Vírgula/parênteses/aspas saem do termo
    // porque quebram a sintaxe do or=() do PostgREST.
    if (method === 'GET' && p === '/girassol-backup-offline/buscar-lucro') {
      const kB = (urlObj.searchParams && urlObj.searchParams.get('k')) || '';
      const sessB = validarSessao(req.headers['cookie']);
      if (!((process.env.ADMIN_KEY && kB === process.env.ADMIN_KEY) || (sessB && ehAdmin(sessB)))) { json(res, 404, { error: 'not found' }); return true; }
      const qB = Array.from(String((urlObj.searchParams && urlObj.searchParams.get('q')) || '').trim()).slice(0, 60).join('');   // Codex (P2, PR#128 r9): slice(0,60) corta no meio de emoji/caractere astral e o encodeURIComponent estoura URIError ANTES do try — 500 em vez de resultado. Cortar por CARACTERE, não por unidade UTF-16
      if (qB.length < 2) { json(res, 400, { ok: false, erro: 'use ?q= com 2+ caracteres' }); return true; }
      const ckB = 'bq|' + qB.toLowerCase();
      if (_histCache[ckB] && (Date.now() - _histCache[ckB].ts) < 120000) { json(res, 200, Object.assign({ cache: true }, _histCache[ckB].dados)); return true; }
      // Codex (P2, PR#128 r5): eu APAGAVA vírgula/parênteses/aspas do termo — "Kit (10 unidades)"
      // virava "Kit 10 unidades" e deixava de casar com o texto gravado, enquanto a busca em
      // memória (que não mexe no termo) continuava achando. Agora o termo vai INTEIRO, entre
      // aspas duplas, que é como o PostgREST aceita valor com vírgula/parêntese; só a aspa e a
      // contrabarra precisam de escape dentro delas. Sobra o controle de tamanho e de brancos.
      const limpoB = qB.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
      if (!limpoB) { json(res, 400, { ok: false, erro: 'termo inválido' }); return true; }
      const citaB = v => '"' + String(v).replace(/([\\"])/g, '\\$1') + '"';   // valor citado do PostgREST
      const { url: uB, key: kkB } = supaCfg('girassol');
      if (!uB || !kkB) { json(res, 500, { ok: false, erro: 'Supabase não configurado' }); return true; }
      const HB = { apikey: kkB, Authorization: 'Bearer ' + kkB };
      // Codex (P1, PR#128): casar por SKU/descrição numa venda MULTI-ITEM devolvia só as
      // linhas que casaram — e a soma delas era apresentada como o total do PEDIDO,
      // subestimando receita e margem. Agora em DUAS FASES: (1) descobrir QUAIS pedidos
      // casam; (2) buscar TODAS as linhas desses pedidos e só então agregar.
      // Codex (P2, PR#128): termo numérico também busca por SUBSTRING em sku/descrição
      // (a UI promete "SKU · parte do título" — fragmento tipo "2200" de lumens sumia).
      // Os EXATOS (nº do pedido / venda do marketplace) vêm numa consulta separada e
      // entram PRIMEIRO na lista — 15 achados recentes por título nunca expulsam o
      // pedido exato que motivou a busca.
      const baseB = uB.replace(/\/+$/, '') + '/rest/v1/vendas_historico?empresa=eq.girassol';
      const eqB = encodeURIComponent(citaB(limpoB));            // valor exato, citado
      // Codex (P2, PR#128 r6): `_` `%` `*` no termo viravam CORINGA do ilike — SKU "ABC_1"
      // casava "ABCX1" e o lixo podia empurrar o SKU pedido pra fora das 400 linhas lidas.
      // A busca em memória trata esses caracteres ao pé da letra; aqui passa a tratar também.
      const likeB = encodeURIComponent(citaB('*' + limpoB.replace(/([\\%_*])/g, '\\$1') + '*'));
      const achouB = new Set();
      // Codex (P2, PR#128 r5): antes eu SÓ consultava sku/descrição se a fase de
      // identificadores não tivesse enchido as 15 vagas — buscar "ML" devolvia 15 pedidos
      // ML-… e nenhum produto, contrariando o "SKU · parte do título" que a tela promete.
      // Agora as três classes SEMPRE são consultadas e a cota é dividida na hora de montar:
      // exatos primeiro (assento garantido), depois id-fuzzy e produto se revezando.
      const puxaNums = async (filtro, lim) => {
        const out = [];
        const rN = await fetch(baseB + filtro + '&select=numero_pedido&order=data_venda.desc,numero_pedido.desc&limit=' + lim, { headers: HB });
        if (!rN.ok) throw new Error('Supabase HTTP ' + rN.status);
        const ln = await rN.json().catch(() => []);
        for (const l of (Array.isArray(ln) ? ln : [])) {
          const nk = l && l.numero_pedido != null ? String(l.numero_pedido) : '';
          if (nk && !out.includes(nk)) out.push(nk);
          if (out.length >= 60) break;
        }
        return out;
      };
      const numsB = [];
      const juntaB = nk => { if (nk && !achouB.has(nk) && numsB.length < 15) { achouB.add(nk); numsB.push(nk); } };
      let linhasB = [];
      try {
        // Codex r4: numero_pedido é TEXT no schema (o backfill grava 'ML-…'), então eq com
        // número longo é seguro — o guard de 9 dígitos só impedia achar pedido de nº comprido.
        const exatosB = await puxaNums('&or=(numero_pedido.eq.' + eqB + ',numero_loja.eq.' + eqB + ')', 200);
        // Codex (P2, PR#128 r5): venda marketplace-only de CARRINHO grava numero_pedido='ML-<oid>'
        // e numero_loja=<pack_id> — digitar o ID nativo do pedido não casava em NENHUM eq. A
        // substring em numero_pedido resolve (e vale pro ID da Amazon com hífen também).
        const idFuzzyB = await puxaNums('&or=(numero_pedido.ilike.' + likeB + ',numero_loja.ilike.' + likeB + ')', 300);
        const prodB = await puxaNums('&or=(sku.ilike.' + likeB + ',descricao.ilike.' + likeB + ')', 400);
        for (const nk of exatosB) juntaB(nk);                       // exato tem assento garantido
        for (let i = 0; i < Math.max(idFuzzyB.length, prodB.length) && numsB.length < 15; i++) {
          if (i < prodB.length) juntaB(prodB[i]);                   // produto e id-fuzzy se revezam,
          if (i < idFuzzyB.length) juntaB(idFuzzyB[i]);             // nenhuma classe fica zerada
        }
        if (numsB.length) {
          const camposB = 'numero_pedido,numero_loja,canal,data_venda,sku,descricao,quantidade,valor_produto,valor_nota,custo,comissao,frete_vendedor,imposto,margem,uf';   // Codex r4: a GIRASSOL não tem credito_ml no vendas_historico (só a AMB grava/lê essa coluna) — selecioná-la faria o PostgREST responder 400 e TODA busca viraria 'histórico indisponível'
          const rB = await fetch(baseB + '&numero_pedido=in.(' + numsB.map(encodeURIComponent).join(',') + ')' +
                     '&select=' + camposB + '&order=data_venda.desc,numero_pedido.desc,sku.asc&limit=1000', { headers: HB });
          if (!rB.ok) { json(res, 502, { ok: false, erro: 'Supabase HTTP ' + rB.status }); return true; }
          linhasB = await rB.json().catch(() => []);
          if (!Array.isArray(linhasB)) linhasB = [];
        }
      } catch (e) { json(res, 500, { ok: false, erro: String(e.message || e) }); return true; }
      const r2c = v => Math.round((Number(v) || 0) * 100) / 100;
      // Codex (P1, PR#128 r2): o historico-longo REPÕE o custo cadastrado depois do backfill
      // e RECALCULA o imposto com a alíquota atual do mês — a busca agregava os valores
      // CONGELADOS da linha e a M.C. divergia dos cards pro MESMO pedido. Mesma normalização.
      const _ccB = _comManual(readJson(path.join(CACHE_DIR, '_custos.json'), {}));
      const _cuB = sk => { const c = _ccB[String(sk || '').trim()]; return (c && c.custo != null && isFinite(Number(c.custo))) ? Number(c.custo) : null; };
      const _cfgB = readJson(path.join(CACHE_DIR, '_config-fiscal.json'), { aliquotas: {} });
      const _aliqB = mes => {
        const a = _cfgB.aliquotas && _cfgB.aliquotas[mes];
        /* 19/08: mês salvo como 0% era campo em BRANCO gravado por engano — zero não é
           alíquota, cai no padrão. */
        if (a != null && isFinite(Number(a)) && Number(a) > 0) return Number(a);
        return (DEFAULT_ALIQ_BK && DEFAULT_ALIQ_BK[mes] != null) ? Number(DEFAULT_ALIQ_BK[mes]) : null;
      };
      const porPed = new Map();
      for (const l of linhasB) {
        const nk = String(l.numero_pedido || '(sem número)');
        let g = porPed.get(nk);
        if (!g) { g = { numero: nk, numero_loja: l.numero_loja || null, canal: l.canal || null, data: String(l.data_venda || '').slice(0, 10), uf: l.uf || null, itens: [], vprod: 0, vnota: 0, custo: 0, comissao: 0, frete: 0, imposto: 0, credito: 0, mc: 0, mc_incompleta: false, sem_custo: false }; porPed.set(nk, g); }
        const qLn = Number(l.quantidade) || 0, vnLn = Number(l.valor_nota) || 0;
        let cuLn = (l.custo == null ? null : Number(l.custo));
        if (cuLn == null) { const cx = _cuB(l.sku); if (cx != null) cuLn = cx * qLn; }
        const _imGravB = Number(l.imposto) || 0;
        let imLn = _imGravB;
        { const _aq = _aliqB(String(l.data_venda || '').slice(0, 7));
          if (_aq != null && vnLn > 0) { const _novo = Math.round(vnLn * _aq / 100 * 100) / 100;
            if (Math.abs(_novo - _imGravB) > 0.005) imLn = _novo; } }
        let mgLn = (l.margem == null ? null : Number(l.margem));
        if (mgLn != null) mgLn -= (imLn - _imGravB);                       // imposto recalculado: a margem acompanha
        if (mgLn != null && l.custo == null && cuLn != null) mgLn -= cuLn;  // margem gravada sem custo: desconta o reposto
        // Codex (P1, PR#128 r9): linha que foi pro banco ANTES de o SKU ter custo cadastrado tem
        // custo E margem nulos. Eu repunha o custo, mas os dois ajustes acima só agem em margem
        // já existente — a margem seguia nula, o pedido inteiro virava "incompleto" e a busca
        // mostrava "—" mesmo com o custo hoje disponível. Reconstrói pela MESMA fórmula do
        // backfill (index.js): valor_produto − custo − comissão − frete − imposto.
        if (mgLn == null && cuLn != null) {
          mgLn = Math.round(((Number(l.valor_produto) || 0) - cuLn - (Number(l.comissao) || 0) - (Number(l.frete_vendedor) || 0) - imLn) * 100) / 100;
        }
        g.itens.push({ sku: l.sku || '', descricao: l.descricao || '', qtd: qLn });
        g.vprod = r2c(g.vprod + (Number(l.valor_produto) || 0));
        g.vnota = r2c(g.vnota + vnLn);
        if (cuLn != null) g.custo = r2c(g.custo + cuLn); else g.sem_custo = true;
        g.comissao = r2c(g.comissao + (Number(l.comissao) || 0));
        g.frete = r2c(g.frete + (Number(l.frete_vendedor) || 0));
        g.imposto = r2c(g.imposto + imLn);
        // (sem credito_ml aqui — ver comentário no camposB; g.credito fica 0 e a M.C. não soma crédito, igual ao resto do histórico da Girassol)
        if (mgLn == null) g.mc_incompleta = true; else g.mc = r2c(g.mc + mgLn);
      }
      // Codex (P1, PR#128): o historico-longo soma o credito_ml na margem — aqui a M.C.
      // saía sem o crédito e o detalhamento não reconciliava. Mesma regra dos cards agora.
      const pedidosB = numsB.map(nk => porPed.get(nk)).filter(Boolean).slice(0, 15)
        .map(g => Object.assign({}, g, { mc: g.mc_incompleta ? null : Math.round((g.mc + g.credito) * 100) / 100 }));
      const dadosB = { ok: true, q: qB, pedidos: pedidosB, linhas_lidas: linhasB.length, pedidos_achados: porPed.size };
      _histCache[ckB] = { ts: Date.now(), dados: dadosB };
      json(res, 200, dadosB);
      return true;
    }

    return false;   // não é rota de histórico
  };
}

module.exports = { rotasHistorico };
