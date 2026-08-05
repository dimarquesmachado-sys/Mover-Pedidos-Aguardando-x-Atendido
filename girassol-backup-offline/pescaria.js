'use strict';
// ════════════════════════════════════════════════════════════════════════
//  GIRASSOL · BACKUP OFFLINE — PESCARIA RETROATIVA DE TARIFAS DO ML
//  (04/08/2026 — pedido do Diego: "faz pescaria")
// ════════════════════════════════════════════════════════════════════════
//  O PROBLEMA: o backfill do histórico grava a comissão que o BLING importou
//  (det.taxas.taxaComissao). Quando o Bling não importou, a linha foi pro
//  Supabase com comissao = 0 — e a margem daquele pedido saiu INFLADA. É o
//  que a pílula "tarifa real 88%" do Ano está denunciando.
//
//  O QUE ESTA ROTA FAZ: acha esses pedidos do Mercado Livre no histórico,
//  pesca a comissão REAL na API do ML (sale_fee, a mesma fonte que o
//  pescarDadosML já usa no dia a dia) e regrava comissão e margem.
//
//  ⚠️ ELA REESCREVE HISTÓRICO FINANCEIRO. Por isso vem em três velocidades,
//  nesta ordem — não pule etapa:
//    1) SIMULAR  — mede quantos pedidos estão sem comissão, por mês, e pesca
//                  uma amostra pra você VER a diferença. Não grava nada.
//    2) UM PEDIDO — grava um só, devolvendo antes/depois linha a linha.
//    3) MASSA    — roda o período inteiro em segundo plano, com status.
//
//  Só mexe em pedido cuja comissão gravada é ZERO (ou nula). Pedido que já
//  tem comissão nunca é tocado — rodar de novo é inofensivo.
// ════════════════════════════════════════════════════════════════════════

const fetch = require('node-fetch');
const path = require('path');

const base = require('./base');
const { json, ehAdmin, readJson, CACHE_DIR } = base;

// estado da rodada em massa (memória; um deploy no meio zera e é só rodar de novo)
let _pes = {
  rodando: false, fase: 'parado', de: null, ate: null,
  alvos: 0, pescados: 0, gravados: 0, sem_fee: 0, erros: 0, linhas_gravadas: 0,
  comissao_recuperada: 0, inicio: null, fim: null, msg: '', ultimo: null,
  // 04/08 v2: sem isto a rodada de 21:08 devolveu 1.948 "sem_fee" e não deu pra saber POR QUÊ.
  http: { ok: 0, r404: 0, r429: 0, outros: 0, pack_ok: 0, pack_falhou: 0, esperas: 0 },
  sem_fee_prefixo_ml: 0,   // quantos dos "sem fee" são linhas ML- (as que vieram do marketplace, não do Bling)
  exemplos_sem_fee: []     // até 8 amostras dos que falharam, com o status HTTP — pra não ficar no escuro de novo
};

function rotasPescaria(ctx) {
  const { validarSessao, supaCfg, supaReq, pescarDadosML } = ctx;
  const dorme = ms => new Promise(r => setTimeout(r, ms));

  function admOk(req, urlObj) {
    const k = (urlObj.searchParams && urlObj.searchParams.get('k')) || '';
    const s = validarSessao(req.headers['cookie']);
    return (process.env.ADMIN_KEY && k === process.env.ADMIN_KEY) || (s && ehAdmin(s));
  }

  // ── v2 (04/08): buscador de sale_fee PRÓPRIO, leve e paciente ──────────────
  // Na 1ª rodada em massa eu usei o pescarDadosML, que faz 3 a 4 chamadas por pedido
  // (pedido + envio + custos). Pra pescaria só interessa o sale_fee — as outras duas
  // eram jogadas fora e ainda somavam pressão na API. Resultado: 2.947 pedidos em 38
  // minutos, ~4 chamadas/s sustentadas, e 1.948 voltaram "sem fee" SEM erro nenhum —
  // cara de 429 engolido (o pescarDadosML trata qualquer resposta ruim como "não achei").
  // Agora: 1 chamada por pedido, espera crescente no 429, e cada status contabilizado.
  async function feeDoML(nl, tk) {
    const id = String(nl || '').replace(/\D/g, '');
    if (!id || !tk) return { fee: null, status: 0, via: null };
    const H = { headers: { Authorization: 'Bearer ' + tk } };
    const esperas = [2000, 4000, 8000, 15000, 25000];
    for (let t2 = 0; t2 <= esperas.length; t2++) {
      let r;
      try { r = await fetch('https://api.mercadolibre.com/orders/' + id, H); }
      catch (e) { _pes.http.outros++; return { fee: null, status: 0, via: 'excecao' }; }
      if (r.status === 429) {                      // rate limit: espera e insiste
        _pes.http.r429++;
        if (t2 === esperas.length) return { fee: null, status: 429, via: 'desistiu' };
        _pes.http.esperas++;
        await dorme(esperas[t2]);
        continue;
      }
      if (r.ok) {
        const d = await r.json().catch(() => null);
        _pes.http.ok++;
        return { fee: somaFee(d ? [d] : []), status: 200, via: 'order' };
      }
      if (r.status === 404) {                      // pode ser PACK (carrinho)
        _pes.http.r404++;
        const rp = await fetch('https://api.mercadolibre.com/packs/' + id, H).catch(() => null);
        const dp = rp && rp.ok ? await rp.json().catch(() => null) : null;
        if (!dp || !Array.isArray(dp.orders) || !dp.orders.length) { _pes.http.pack_falhou++; return { fee: null, status: 404, via: 'nem-pack' }; }
        const ords = [];
        for (const oq of dp.orders) {
          try {
            const ro = await fetch('https://api.mercadolibre.com/orders/' + (oq.id || oq), H);
            if (ro.ok) { const doo = await ro.json().catch(() => null); if (doo) ords.push(doo); }
          } catch (e) {}
          await dorme(200);
        }
        if (!ords.length) { _pes.http.pack_falhou++; return { fee: null, status: 404, via: 'pack-vazio' }; }
        _pes.http.pack_ok++;
        return { fee: somaFee(ords), status: 200, via: 'pack' };
      }
      _pes.http.outros++;
      return { fee: null, status: r.status, via: 'http' };
    }
    return { fee: null, status: 0, via: null };
  }
  function somaFee(ords) {
    let fee = 0;
    for (const od of (ords || [])) {
      for (const it of (od.order_items || [])) {
        const q = Number(it.quantity || 1), sf = Number(it.sale_fee || 0);
        if (isFinite(sf)) fee += sf * q;
      }
    }
    return Math.round(fee * 100) / 100;
  }

  // GET direto no Supabase (o supaReq só devolve texto; aqui precisamos do JSON)
  async function supaGet(pathQuery) {
    const { url, key } = supaCfg('girassol');
    if (!url || !key) return null;
    const r = await fetch(url.replace(/\/+$/, '') + '/rest/v1/' + pathQuery,
      { headers: { apikey: key, Authorization: 'Bearer ' + key } });
    if (!r.ok) return null;
    return await r.json().catch(() => null);
  }

  // Varre o período e devolve os pedidos do ML cuja comissão somada é ZERO.
  // Pagina de 1000 em 1000 — o ano inteiro passa dos 24 mil registros.
  async function alvosDoPeriodo(de, ate) {
    const campos = 'id,numero_pedido,numero_loja,canal,data_venda,valor_produto,custo,imposto,frete_vendedor,comissao';
    const porPedido = new Map();
    let off = 0;
    for (let pag = 0; pag < 60; pag++) {
      const q = 'vendas_historico?empresa=eq.girassol&canal=eq.ml' +
        '&data_venda=gte.' + de + '&data_venda=lte.' + ate +
        '&select=' + campos + '&order=data_venda.asc&limit=1000&offset=' + off;
      const lote = await supaGet(q);
      if (!Array.isArray(lote) || !lote.length) break;
      for (const l of lote) {
        const np = String(l.numero_pedido);
        if (!porPedido.has(np)) porPedido.set(np, { numero_pedido: np, numero_loja: l.numero_loja || null, data_venda: l.data_venda, linhas: [], comissao: 0, valor: 0 });
        const reg = porPedido.get(np);
        reg.linhas.push(l);
        reg.comissao += Number(l.comissao || 0);
        reg.valor += Number(l.valor_produto || 0);
        if (!reg.numero_loja && l.numero_loja) reg.numero_loja = l.numero_loja;
      }
      off += lote.length;
      if (lote.length < 1000) break;
      await dorme(120);
    }
    const alvos = [];
    for (const reg of porPedido.values()) {
      if (reg.comissao > 0.005) continue;          // já tem comissão — não toca
      if (!reg.numero_loja) continue;              // sem nº da venda no ML não dá pra pescar
      if (!(reg.valor > 0)) continue;
      alvos.push(reg);
    }
    return { alvos, pedidos_no_periodo: porPedido.size };
  }

  // Rateia a comissão real entre as linhas do pedido e regrava comissão + margem.
  // A regra do rateio e da margem é a MESMA do backfill (proporcional ao valor do
  // item; margem = valor − custo − comissão − frete − imposto, nula quando falta custo).
  async function gravarPedido(reg, fee) {
    const soma = reg.linhas.reduce((s, l) => s + Number(l.valor_produto || 0), 0) || 1;
    const antes = [], depois = [];
    let linhas = 0;
    for (const l of reg.linhas) {
      const frac = Number(l.valor_produto || 0) / soma;
      const com = Math.round(fee * frac * 100) / 100;
      const cus = (l.custo != null && isFinite(Number(l.custo))) ? Number(l.custo) : null;
      const mg = cus != null
        ? Math.round((Number(l.valor_produto || 0) - cus - com - Number(l.frete_vendedor || 0) - Number(l.imposto || 0)) * 100) / 100
        : null;
      antes.push({ id: l.id, comissao: Number(l.comissao || 0) });
      const r = await supaReq('girassol', 'PATCH', 'vendas_historico?id=eq.' + encodeURIComponent(l.id), { comissao: com, margem: mg });
      if (!r || !r.ok) return { ok: false, erro: 'PATCH linha ' + l.id + ' status ' + (r && r.status), antes };
      depois.push({ id: l.id, comissao: com, margem: mg });
      linhas++;
      await dorme(120);
    }
    return { ok: true, linhas, antes, depois };
  }

  async function tokenDoML() {
    const { garantirTokenML } = require('../girassol/mlTokenManager');
    return await garantirTokenML();
  }

  // Rodada em massa, em segundo plano.
  async function rodarMassa(de, ate, max) {
    _pes = { rodando: true, fase: 'listando', de, ate, alvos: 0, pescados: 0, gravados: 0, sem_fee: 0, erros: 0,
             linhas_gravadas: 0, comissao_recuperada: 0, inicio: new Date().toISOString(), fim: null, msg: '', ultimo: null,
             http: { ok: 0, r404: 0, r429: 0, outros: 0, pack_ok: 0, pack_falhou: 0, esperas: 0 },
             sem_fee_prefixo_ml: 0, exemplos_sem_fee: [] };
    try {
      const { alvos } = await alvosDoPeriodo(de, ate);
      _pes.alvos = alvos.length;
      _pes.fase = 'pescando';
      const tk = await tokenDoML();
      if (!tk) throw new Error('sem token do ML');
      const lista = alvos.slice(0, max);
      for (const reg of lista) {
        try {
          const d2 = await feeDoML(reg.numero_loja, tk);
          _pes.pescados++;
          _pes.ultimo = reg.numero_pedido;
          const fee = Number(d2.fee);
          if (!isFinite(fee) || fee <= 0) {
            _pes.sem_fee++;
            if (/^ML-/i.test(reg.numero_pedido)) _pes.sem_fee_prefixo_ml++;
            if (_pes.exemplos_sem_fee.length < 8) _pes.exemplos_sem_fee.push({ pedido: reg.numero_pedido, numero_loja: reg.numero_loja, data: reg.data_venda, http: d2.status, via: d2.via });
            await dorme(260); continue;
          }
          const g = await gravarPedido(reg, fee);
          if (g.ok) { _pes.gravados++; _pes.linhas_gravadas += g.linhas; _pes.comissao_recuperada = Math.round((_pes.comissao_recuperada + fee) * 100) / 100; }
          else { _pes.erros++; _pes.msg = g.erro || ''; }
        } catch (e) { _pes.erros++; _pes.msg = String(e.message || e); }
        await dorme(260);   // fôlego pro ML e pro Supabase (1 chamada por pedido agora)
      }
      _pes.fase = 'concluido';
    } catch (e) {
      _pes.fase = 'erro';
      _pes.msg = String(e.message || e);
    }
    _pes.rodando = false;
    _pes.fim = new Date().toISOString();
  }

  return async function handlePescaria(req, res, urlObj) {
    const { method } = req;
    const p = urlObj.pathname;

    // STATUS da rodada em massa
    if (method === 'GET' && p === '/girassol-backup-offline/pescar-tarifas-status') {
      if (!admOk(req, urlObj)) { json(res, 404, { error: 'not found' }); return true; }
      json(res, 200, Object.assign({ ok: true }, _pes));
      return true;
    }

    if (method === 'GET' && p === '/girassol-backup-offline/pescar-tarifas') {
      if (!admOk(req, urlObj)) { json(res, 404, { error: 'not found' }); return true; }
      const q = urlObj.searchParams;
      const de = String((q && q.get('de')) || '').slice(0, 10);
      const ate = String((q && q.get('ate')) || '').slice(0, 10);
      const gravar = (q && q.get('gravar')) === '1';
      const massa = (q && q.get('massa')) === '1';
      const umPedido = String((q && q.get('pedido')) || '').trim();
      const amostra = Math.min(10, Math.max(1, parseInt((q && q.get('amostra')) || '3', 10) || 3));
      const max = Math.min(5000, Math.max(1, parseInt((q && q.get('max')) || '500', 10) || 500));

      const { url: uu, key: kk } = supaCfg('girassol');
      if (!uu || !kk) { json(res, 500, { ok: false, erro: 'Supabase não configurado' }); return true; }

      // ── MODO 2: um pedido só, com antes/depois ──────────────────────────────
      if (umPedido) {
        const campos = 'id,numero_pedido,numero_loja,canal,data_venda,valor_produto,custo,imposto,frete_vendedor,comissao';
        const linhas = await supaGet('vendas_historico?empresa=eq.girassol&numero_pedido=eq.' + encodeURIComponent(umPedido) + '&select=' + campos);
        if (!Array.isArray(linhas) || !linhas.length) { json(res, 404, { ok: false, erro: 'pedido não encontrado no histórico' }); return true; }
        const reg = {
          numero_pedido: umPedido,
          numero_loja: (linhas.find(l => l.numero_loja) || {}).numero_loja || null,
          linhas,
          comissao: linhas.reduce((s, l) => s + Number(l.comissao || 0), 0),
          valor: linhas.reduce((s, l) => s + Number(l.valor_produto || 0), 0)
        };
        if (!reg.numero_loja) { json(res, 400, { ok: false, erro: 'pedido sem numero_loja — não dá pra pescar no ML' }); return true; }
        let tk = null;
        try { tk = await tokenDoML(); } catch (e) { json(res, 500, { ok: false, erro: 'token ML: ' + e.message }); return true; }
        const dados = await pescarDadosML(reg.numero_loja, tk, dorme);
        const fee = dados && Number(dados.fee);
        const resp = {
          ok: true, pedido: umPedido, numero_loja: reg.numero_loja, valor_produtos: Math.round(reg.valor * 100) / 100,
          comissao_gravada: Math.round(reg.comissao * 100) / 100,
          comissao_real_ml: (isFinite(fee) ? fee : null),
          ml_bruto: dados || null, gravou: false
        };
        if (!gravar) { resp.aviso = 'simulação — nada foi gravado. Repita com &gravar=1 pra aplicar neste pedido.'; json(res, 200, resp); return true; }
        if (!isFinite(fee) || fee <= 0) { resp.erro = 'o ML não devolveu sale_fee pra esta venda'; json(res, 200, resp); return true; }
        const g = await gravarPedido(reg, fee);
        resp.gravou = !!g.ok; resp.linhas = g.linhas || 0; resp.antes = g.antes; resp.depois = g.depois;
        if (!g.ok) resp.erro = g.erro;
        json(res, 200, resp);
        return true;
      }

      if (!/^\d{4}-\d{2}-\d{2}$/.test(de) || !/^\d{4}-\d{2}-\d{2}$/.test(ate)) {
        json(res, 400, { ok: false, erro: 'passe &de=AAAA-MM-DD&ate=AAAA-MM-DD (ou &pedido=NUMERO)' });
        return true;
      }

      // ── MODO 3: massa, em segundo plano ─────────────────────────────────────
      if (massa && gravar) {
        if (_pes.rodando) { json(res, 409, { ok: false, erro: 'já tem uma pescaria rodando', status: _pes }); return true; }
        rodarMassa(de, ate, max).catch(e => { _pes.rodando = false; _pes.fase = 'erro'; _pes.msg = String(e.message || e); });
        json(res, 202, { ok: true, msg: 'pescando em segundo plano', de, ate, max, status: '/girassol-backup-offline/pescar-tarifas-status' });
        return true;
      }

      // ── MODO 1: simulação (o padrão) ────────────────────────────────────────
      const { alvos, pedidos_no_periodo } = await alvosDoPeriodo(de, ate);
      const porMes = {};
      let valorEnvolvido = 0;
      for (const a of alvos) {
        const m = String(a.data_venda || '').slice(0, 7);
        porMes[m] = (porMes[m] || 0) + 1;
        valorEnvolvido += a.valor;
      }
      const exemplos = [];
      _pes.http = { ok: 0, r404: 0, r429: 0, outros: 0, pack_ok: 0, pack_falhou: 0, esperas: 0 };
      let tk = null;
      try { tk = await tokenDoML(); } catch (e) {}
      if (tk) {
        for (const a of alvos.slice(0, amostra)) {
          try {
            const d = await feeDoML(a.numero_loja, tk);
            const fee = Number(d.fee);
            exemplos.push({
              pedido: a.numero_pedido, numero_loja: a.numero_loja, data: a.data_venda,
              valor_produtos: Math.round(a.valor * 100) / 100,
              comissao_gravada: Math.round(a.comissao * 100) / 100,
              comissao_real_ml: isFinite(fee) ? fee : null,
              pct: (isFinite(fee) && a.valor > 0) ? Math.round(fee / a.valor * 1000) / 10 : null,
              http: d.status, via: d.via
            });
          } catch (e) { exemplos.push({ pedido: a.numero_pedido, erro: String(e.message || e) }); }
          await dorme(300);
        }
      }
      json(res, 200, {
        ok: true, simulacao: true, de, ate,
        pedidos_ml_no_periodo: pedidos_no_periodo,
        pedidos_sem_comissao: alvos.length,
        valor_envolvido: Math.round(valorEnvolvido * 100) / 100,
        por_mes: porMes,
        exemplos,
        http_da_amostra: _pes.http,
        aviso: 'NADA foi gravado. Pra aplicar em UM pedido: &pedido=NUMERO&gravar=1. Pra rodar o período: &massa=1&gravar=1&max=N',
        token_ml: tk ? 'ok' : 'INDISPONÍVEL — sem ele a pescaria não roda'
      });
      return true;
    }

    // ════════════════════════════════════════════════════════════════════════
    //  AUDITORIA ML — o extrato do ML contra o que a gente tem gravado
    //  (04/08: nasceu da conciliação que revelou dois buracos além da comissão)
    //  SÓ LÊ. Não grava, não chama a API do ML — o billing já está no disco.
    //  Mês a mês: comissão, frete e o parcelamento (que hoje não entra em lugar
    //  nenhum da margem: o backfill soma comissao+mp e o card soma ads+full+devolução).
    // ════════════════════════════════════════════════════════════════════════
    if (method === 'GET' && p === '/girassol-backup-offline/auditoria-ml') {
      if (!admOk(req, urlObj)) { json(res, 404, { error: 'not found' }); return true; }
      const q = urlObj.searchParams;
      const de = String((q && q.get('de')) || '').slice(0, 10);
      const ate = String((q && q.get('ate')) || '').slice(0, 10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(de) || !/^\d{4}-\d{2}-\d{2}$/.test(ate)) {
        json(res, 400, { ok: false, erro: 'passe &de=AAAA-MM-DD&ate=AAAA-MM-DD' }); return true;
      }

      // ── lado do ML: o faturamento oficial que já está no disco ──
      const bill = readJson(path.join(CACHE_DIR, '_ml_billing.json'), { tarifas: {} });
      const ml = {};
      for (const x of Object.values(bill.tarifas || {})) {
        const d = String((x && x.d) || '');
        if (!d || d < de || d > ate) continue;
        const m = d.slice(0, 7);
        ml[m] = ml[m] || { comissao: 0, mp: 0, frete: 0, parcelamento: 0, ads: 0, full: 0, devolucao: 0, credito: 0, outros: 0 };
        const c = x.c || 'outros';
        if (ml[m][c] == null) ml[m].outros += Number(x.v) || 0;
        else ml[m][c] += Number(x.v) || 0;
      }

      // ── nosso lado: o histórico do canal ml, mês a mês ──
      const nosso = {};
      let off = 0;
      for (let pag = 0; pag < 60; pag++) {
        const lote = await supaGet('vendas_historico?empresa=eq.girassol&canal=eq.ml' +
          '&data_venda=gte.' + de + '&data_venda=lte.' + ate +
          '&select=data_venda,valor_produto,comissao,frete_vendedor&order=data_venda.asc&limit=1000&offset=' + off);
        if (!Array.isArray(lote) || !lote.length) break;
        for (const l of lote) {
          const m = String(l.data_venda || '').slice(0, 7);
          if (!m) continue;
          nosso[m] = nosso[m] || { produtos: 0, comissao: 0, frete: 0, linhas: 0 };
          nosso[m].produtos += Number(l.valor_produto || 0);
          nosso[m].comissao += Number(l.comissao || 0);
          nosso[m].frete += Number(l.frete_vendedor || 0);
          nosso[m].linhas++;
        }
        off += lote.length;
        if (lote.length < 1000) break;
        await dorme(120);
      }

      const r2 = v => Math.round((Number(v) || 0) * 100) / 100;
      const meses = [...new Set([...Object.keys(ml), ...Object.keys(nosso)])].sort();
      const por_mes = {};
      const tot = { ml_comissao_mp: 0, nossa_comissao: 0, ml_frete: 0, nosso_frete: 0, ml_parcelamento: 0, nossos_produtos: 0, estornos: 0 };
      for (const m of meses) {
        const a2m = ml[m] || {}, b2 = nosso[m] || {};
        // 05/08: desde o b111 o PARCELAMENTO entra na comissão do pedido (é custo da venda,
        // conforme a doc do ML). Se o comparador não somar ele deste lado, o "temos" aparece
        // ~R$ 84 mil maior que o "ml_cobrou" e parece erro grave — quando na verdade os dois
        // lados é que estariam medindo coisas diferentes.
        const mlCom = (a2m.comissao || 0) + (a2m.mp || 0) + (a2m.parcelamento || 0);
        // 05/08: o billing cobra a comissao da venda e ESTORNA quando ela e cancelada (categoria
        // 'credito', que vem NEGATIVA). Como o nosso historico nao guarda venda cancelada, esse
        // estorno tem que sair do "ml_cobrou" — senao a auditoria acusa uma falta que nao existe.
        const est = Math.abs(a2m.credito || 0);
        por_mes[m] = {
          nossos_produtos: r2(b2.produtos), linhas: b2.linhas || 0,
          comissao: { ml_cobrou: r2(mlCom), temos: r2(b2.comissao), falta: r2(mlCom - (b2.comissao || 0)),
                      estornos_do_ml: r2(est), falta_liquida: r2(mlCom - (b2.comissao || 0) - est) },
          frete:    { ml_cobrou: r2(a2m.frete), temos: r2(b2.frete), falta: r2((a2m.frete || 0) - (b2.frete || 0)) },
          parcelamento_dentro_da_comissao: r2(a2m.parcelamento)
        };
        tot.ml_comissao_mp += mlCom; tot.nossa_comissao += (b2.comissao || 0); tot.estornos += est;
        tot.ml_frete += (a2m.frete || 0); tot.nosso_frete += (b2.frete || 0);
        tot.ml_parcelamento += (a2m.parcelamento || 0); tot.nossos_produtos += (b2.produtos || 0);
      }
      json(res, 200, {
        ok: true, de, ate, so_leitura: true, canal: 'ml',
        total: {
          produtos_ml_no_historico: r2(tot.nossos_produtos),
          comissao: { ml_cobrou: r2(tot.ml_comissao_mp), temos: r2(tot.nossa_comissao), falta: r2(tot.ml_comissao_mp - tot.nossa_comissao),
                      estornos_do_ml: r2(tot.estornos), falta_liquida: r2(tot.ml_comissao_mp - tot.nossa_comissao - tot.estornos),
                      taxa_efetiva_ml: tot.nossos_produtos > 0 ? Math.round(tot.ml_comissao_mp / tot.nossos_produtos * 1000) / 10 : null },
          frete: { ml_cobrou: r2(tot.ml_frete), temos: r2(tot.nosso_frete), falta: r2(tot.ml_frete - tot.nosso_frete) },
          parcelamento_dentro_da_comissao: r2(tot.ml_parcelamento)
        },
        por_mes,
        leia: 'comissao.ml_cobrou = categorias comissao+mp+parcelamento do faturamento oficial (desde o b111 o parcelamento entra na comissao do pedido). falta_liquida ja desconta os estornos de venda cancelada (categoria credito), que o ML cobrou e devolveu e que o nosso historico nao guarda. E a falta_liquida que importa.'
      });
      return true;
    }

    return false;   // não é rota de pescaria
  };
}

module.exports = { rotasPescaria };
