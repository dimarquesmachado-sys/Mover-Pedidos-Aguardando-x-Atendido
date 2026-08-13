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
      const ck = 'idx|' + deR + '|' + ateR + '|' + (filtroCanal || 'todos');
      let idx = (_histCache[ck] && (Date.now() - _histCache[ck].ts) < 600000) ? _histCache[ck].dados : null;
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
      const campos = 'numero_pedido,numero_loja,canal,data_venda,sku,descricao,quantidade,valor_produto,valor_nota,custo,comissao,frete_vendedor,imposto,margem,credito_ml';
      let linhas = [];
      try {
        const rq = await fetch(BASE + qCanal + '&select=' + campos + '&order=data_venda.desc,numero_pedido.desc,sku.desc&limit=' + Math.max(1, qtdItens) + '&offset=' + off, { headers: HH });
        linhas = await rq.json().catch(() => []);
        if (!Array.isArray(linhas)) linhas = [];
      } catch (e) { json(res, 500, { ok: false, erro: String(e.message || e) }); return true; }
      const _ccR = readJson(path.join(CACHE_DIR, '_custos.json'), {});
      // 01/08: mesmo recálculo do imposto na lista de vendas do período longo
      const _cfgR = readJson(path.join(CACHE_DIR, '_config-fiscal.json'), { aliquotas: {} });
      const _aliqR = mes => { const a = _cfgR.aliquotas && _cfgR.aliquotas[mes];
        if (a != null && isFinite(Number(a))) return Number(a);
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
      json(res, 200, { ok: true, pedidos, pagina: pg, total_paginas: totalPaginas, total_pedidos: totalPedidos, por_pagina: lim });
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
      if (_histCache[cacheKey] && (Date.now() - _histCache[cacheKey].ts) < 600000) { json(res, 200, Object.assign({ cache: true }, _histCache[cacheKey].dados)); return true; }
      const { url: uL, key: kkL } = supaCfg('girassol');
      if (!uL || !kkL) { json(res, 500, { ok: false, erro: 'Supabase não configurado' }); return true; }
      const H = { apikey: kkL, Authorization: 'Bearer ' + kkL };
      const campos = 'numero_pedido,canal,data_venda,sku,descricao,quantidade,valor_produto,valor_nota,custo,comissao,frete_vendedor,imposto,margem,credito_ml';
      // 28/07: o backfill gravou o custo que existia NAQUELE dia. Depois o banco de custos cresceu
      // (de 288 pra 541 SKUs), então muita linha antiga ficou sem custo à toa. Aqui completamos na
      // LEITURA com o _custos.json atual — sem precisar refazer o backfill inteiro.
      const _ccL = readJson(path.join(CACHE_DIR, '_custos.json'), {});
      // 01/08 — IMPOSTO CALCULADO NA LEITURA (mesma ideia do custo). Antes ele ficava CONGELADO na
      // linha, gravado no momento do backfill: editar a alíquota de um mês não mudava nada no
      // Mês/Ano, e só re-rodando o backfill daquele período. Agora a alíquota atual manda — editou,
      // valeu na hora, sem rodar nada.
      const _cfgL = readJson(path.join(CACHE_DIR, '_config-fiscal.json'), { aliquotas: {} });
      const _aliqL = mes => {
        const a = _cfgL.aliquotas && _cfgL.aliquotas[mes];
        if (a != null && isFinite(Number(a))) return Number(a);
        return (DEFAULT_ALIQ_BK && DEFAULT_ALIQ_BK[mes] != null) ? Number(DEFAULT_ALIQ_BK[mes]) : null;
      };
      let _impRecalc = 0;
      const _cuL = sk => { const c = _ccL[String(sk || '').trim()]; return (c && c.custo != null && isFinite(Number(c.custo))) ? Number(c.custo) : null; };
      let _repostos = 0;
      const T = { fat: 0, prod: 0, imp: 0, cus: 0, com: 0, fre: 0, mar: 0, un: 0, itens: 0, semCusto: 0 };
      const peds = new Set(), porCanal = {}, porSku = {}, porDia = {}, semCustoSet = new Set();
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
            const co = Number(l.comissao) || 0, fr = Number(l.frete_vendedor) || 0;
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
            if (mg != null && l.custo == null && cu != null) mg -= cu;   // margem gravada sem custo: desconta o custo reposto
            if (mg != null) T.mar += mg;
            // Codex PR#48: bônus de envio Flex (gravado na 1ª linha do pedido) entra na margem
            // agregada — sem isto Mês/30 dias/Ano seguiriam subestimados mesmo após a re-pesca
            const crdL = Number(l.credito_ml) || 0;
            if (crdL) { T.mar += crdL; T.cred = Math.round(((T.cred || 0) + crdL) * 100) / 100; }
            if (l.numero_pedido) peds.add(String(l.numero_pedido));
            const cn = l.canal || 'outro';
            // 01/08: o resumo da Análise no período longo mostrava sempre o total do período, mesmo
            // filtrando por canal — porque o agregado por canal só tinha fat/un/margem. Agora traz
            // imposto, comissão, frete, custo e itens, e o filtro passa a valer no resumo também.
            if (!porCanal[cn]) porCanal[cn] = { fat: 0, un: 0, mar: 0, imp: 0, com: 0, fre: 0, cus: 0, itens: 0, peds: new Set() };
            porCanal[cn].fat += vn; porCanal[cn].un += q; porCanal[cn].mar += (mg || 0) + (Number(l.credito_ml) || 0);   // Codex PR#48: crédito Flex também no por-canal
            porCanal[cn].imp += im; porCanal[cn].com += co; porCanal[cn].fre += fr; porCanal[cn].cus += (cu || 0); porCanal[cn].itens++;
            if (l.numero_pedido) porCanal[cn].peds.add(String(l.numero_pedido));
            const sk = l.sku || '(sem sku)';
            if (!porSku[sk]) porSku[sk] = { sku: sk, desc: l.descricao || '', un: 0, fat: 0, cus: 0, mar: 0 };
            porSku[sk].un += q; porSku[sk].fat += vp; porSku[sk].cus += (cu != null ? cu : 0); porSku[sk].mar += (mg || 0);
            const dd = String(l.data_venda || '').slice(0, 10);
            if (dd) { if (!porDia[dd]) porDia[dd] = { fat: 0, peds: new Set() }; porDia[dd].fat += vn; if (l.numero_pedido) porDia[dd].peds.add(String(l.numero_pedido)); }
          }
          if (linhas.length < 1000) break;
          offset += 1000;
        }
      } catch (e) { json(res, 500, { ok: false, erro: String(e.message || e) }); return true; }
      const canais = {}; for (const c of Object.keys(porCanal)) canais[c] = {
        fat: Math.round(porCanal[c].fat * 100) / 100, un: porCanal[c].un,
        mar: Math.round(porCanal[c].mar * 100) / 100, pedidos: porCanal[c].peds.size,
        imp: Math.round((porCanal[c].imp || 0) * 100) / 100, com: Math.round((porCanal[c].com || 0) * 100) / 100,
        fre: Math.round((porCanal[c].fre || 0) * 100) / 100, cus: Math.round((porCanal[c].cus || 0) * 100) / 100,
        itens: porCanal[c].itens || 0 };
      const dias = {}; for (const d of Object.keys(porDia)) dias[d] = { fat: Math.round(porDia[d].fat * 100) / 100, pedidos: porDia[d].peds.size };
      const skus = Object.values(porSku).sort((a, b) => b.mar - a.mar).slice(0, 300)
        .map(x => ({ sku: x.sku, desc: x.desc, un: x.un, fat: Math.round(x.fat * 100) / 100, cus: Math.round(x.cus * 100) / 100, mar: Math.round(x.mar * 100) / 100 }));
      const dados = { ok: true, de: deL, ate: ateL, fonte: 'supabase', paginas,
        totais: { faturamento: Math.round(T.fat * 100) / 100, produtos: Math.round(T.prod * 100) / 100, imposto: Math.round(T.imp * 100) / 100,
                  custo: Math.round(T.cus * 100) / 100, comissao: Math.round(T.com * 100) / 100, frete: Math.round(T.fre * 100) / 100,
                  margem: Math.round(T.mar * 100) / 100, pedidos: peds.size, unidades: T.un, itens: T.itens, un_sem_custo: T.semCusto,
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
        const _ccH = readJson(path.join(CACHE_DIR, '_custos.json'), {});
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

    return false;   // não é rota de histórico
  };
}

module.exports = { rotasHistorico };
