'use strict';
// ════════════════════════════════════════════════════════════════════════
//  GIRASSOL · CANÁRIO DAS INTEGRAÇÕES  (05/08/2026)
// ════════════════════════════════════════════════════════════════════════
//  POR QUE EXISTE: ler comunicado de marketplace não protege ninguém. O que
//  quebra o sistema é um campo que some ou muda de forma — e isso a gente só
//  descobre meses depois, quando o número já está errado. Foi exatamente o que
//  aconteceu com a comissão zerada de janeiro: ninguém percebeu por 7 meses.
//
//  O QUE ELE FAZ: chama as APIs DE VERDADE e confere se os campos de que a
//  gente depende AINDA EXISTEM. Não valida valor, valida CONTRATO — se o campo
//  sumiu, mudou de nome ou virou outro tipo, ele grita.
//
//  Só lê. Não grava nada, não altera pedido nenhum.
//
//  Semáforo por checagem:
//    ok     = o contrato está de pé
//    alerta = algo mudou ou está velho — olhar hoje, não urgente
//    erro   = campo que a gente usa SUMIU, ou a API não respondeu
// ════════════════════════════════════════════════════════════════════════

const fs = require('fs');
const path = require('path');
const fetch = require('node-fetch');

const base = require('./base');
const { json, ehAdmin, CACHE_DIR, CONFERIDOS_FILE, readJson, blingGet } = base;

function rotasCanario(ctx) {
  const { VERSAO, validarSessao } = ctx;

  function admOk(req, urlObj) {
    const k = (urlObj.searchParams && urlObj.searchParams.get('k')) || '';
    const s = validarSessao(req.headers['cookie']);
    return (process.env.ADMIN_KEY && k === process.env.ADMIN_KEY) || (s && ehAdmin(s));
  }

  const temCampo = (o, c) => o && Object.prototype.hasOwnProperty.call(o, c);
  const horasDesde = iso => { const t = Date.parse(iso || ''); return isFinite(t) ? Math.round((Date.now() - t) / 36e5 * 10) / 10 : null; };

  // ── 1. BLING: o pedido ainda traz as taxas? ────────────────────────────────
  // Não olha o VALOR (taxa zero é legítima). Olha se o CAMPO existe — se o Bling
  // parar de mandar `taxas`, a cascata inteira do backfill fica cega.
  async function checaBling() {
    const t0 = Date.now();
    const hoje = new Date(Date.now() - 3 * 864e5).toISOString().slice(0, 10);
    const ate = new Date().toISOString().slice(0, 10);
    const r = await blingGet('/pedidos/vendas?dataInicial=' + hoje + '&dataFinal=' + ate + '&pagina=1&limite=5');
    if (!r || !r.ok) return { nome: 'Bling · listagem de pedidos', estado: 'erro', detalhe: 'HTTP ' + (r && r.status) + ' — sem resposta útil', ms: Date.now() - t0 };
    const lista = (r.data && r.data.data) || [];
    if (!lista.length) return { nome: 'Bling · listagem de pedidos', estado: 'alerta', detalhe: 'nenhum pedido nos últimos 3 dias — sem amostra pra conferir', ms: Date.now() - t0 };
    const rd = await blingGet('/pedidos/vendas/' + lista[0].id);
    const det = (rd && rd.ok && rd.data && rd.data.data) || null;
    if (!det) return { nome: 'Bling · detalhe do pedido', estado: 'erro', detalhe: 'o detalhe do pedido ' + lista[0].id + ' não voltou', ms: Date.now() - t0 };
    const faltando = [];
    if (!temCampo(det, 'total')) faltando.push('total');
    if (!Array.isArray(det.itens)) faltando.push('itens[]');
    if (!temCampo(det, 'taxas')) faltando.push('taxas');
    else {
      if (!temCampo(det.taxas, 'taxaComissao')) faltando.push('taxas.taxaComissao');
      if (!temCampo(det.taxas, 'custoFrete')) faltando.push('taxas.custoFrete');
    }
    if (!temCampo(det, 'numeroLoja')) faltando.push('numeroLoja');
    return {
      nome: 'Bling · contrato do pedido', estado: faltando.length ? 'erro' : 'ok',
      detalhe: faltando.length ? 'SUMIRAM: ' + faltando.join(', ') + ' (amostra: pedido ' + det.id + ')' : 'todos os campos presentes (amostra: pedido ' + det.id + ')',
      ms: Date.now() - t0
    };
  }

  // ── 2. MERCADO LIVRE: a venda ainda traz o sale_fee? ───────────────────────
  async function checaML() {
    const t0 = Date.now();
    let tk = null;
    try { const { garantirTokenML } = require('../girassol/mlTokenManager'); tk = await garantirTokenML(); }
    catch (e) { return { nome: 'Mercado Livre · token', estado: 'erro', detalhe: 'não consegui token: ' + e.message, ms: Date.now() - t0 }; }
    if (!tk) return { nome: 'Mercado Livre · token', estado: 'erro', detalhe: 'token indisponível — reautorizar', ms: Date.now() - t0 };

    // pega uma venda de ML recente entre os bipados
    const conf = readJson(CONFERIDOS_FILE, {});
    const linhas = Array.isArray(conf) ? conf : Object.values(conf || {});
    const cand = linhas.filter(h => h && /ml|mercado/i.test(String(h.marketplace || h.canal || '')) && /^\d{10,}$/.test(String(h.numero_loja || '')))
      .sort((a, b) => String(b.conferido_em || b.cacheado_em || '').localeCompare(String(a.conferido_em || a.cacheado_em || '')));
    if (!cand.length) return { nome: 'Mercado Livre · venda', estado: 'alerta', detalhe: 'sem venda de ML no cache pra usar de amostra', ms: Date.now() - t0 };

    const nl = String(cand[0].numero_loja);
    const H = { headers: { Authorization: 'Bearer ' + tk } };
    let d = null, via = 'order';
    const r = await fetch('https://api.mercadolibre.com/orders/' + nl, H);
    if (r.ok) d = await r.json().catch(() => null);
    else if (r.status === 404) {
      via = 'pack';
      const rp = await fetch('https://api.mercadolibre.com/packs/' + nl, H);
      const dp = rp.ok ? await rp.json().catch(() => null) : null;
      const oid = dp && dp.orders && dp.orders[0] && (dp.orders[0].id || dp.orders[0]);
      if (oid) { const ro = await fetch('https://api.mercadolibre.com/orders/' + oid, H); if (ro.ok) d = await ro.json().catch(() => null); }
    } else {
      return { nome: 'Mercado Livre · venda', estado: 'erro', detalhe: 'HTTP ' + r.status + ' na venda ' + nl, ms: Date.now() - t0 };
    }
    if (!d) return { nome: 'Mercado Livre · venda', estado: 'erro', detalhe: 'não consegui ler a venda ' + nl + ' (via ' + via + ')', ms: Date.now() - t0 };

    const it = (d.order_items || [])[0];
    const faltando = [];
    if (!Array.isArray(d.order_items) || !d.order_items.length) faltando.push('order_items[]');
    else {
      if (!temCampo(it, 'sale_fee')) faltando.push('order_items[].sale_fee');
      if (!temCampo(it, 'quantity')) faltando.push('order_items[].quantity');
    }
    if (!temCampo(d, 'status')) faltando.push('status');
    return {
      nome: 'Mercado Livre · contrato da venda', estado: faltando.length ? 'erro' : 'ok',
      detalhe: faltando.length ? 'SUMIRAM: ' + faltando.join(', ') + ' (amostra: venda ' + nl + ')' : 'sale_fee e companhia presentes (amostra: venda ' + nl + ', via ' + via + ')',
      ms: Date.now() - t0
    };
  }

  // ── 3. FATURAMENTO OFICIAL: o extrato está fresco e com as categorias certas ─
  // É a fonte da cascata de comissão e frete. Se ele envelhecer, o backfill volta
  // a gravar zero sem ninguém perceber.
  function checaBilling() {
    const t0 = Date.now();
    const arq = path.join(CACHE_DIR, '_ml_billing.json');
    if (!fs.existsSync(arq)) return { nome: 'ML · faturamento oficial', estado: 'erro', detalhe: '_ml_billing.json não existe', ms: Date.now() - t0 };
    const bill = readJson(arq, { tarifas: {} });
    const tar = Object.values(bill.tarifas || {});
    if (!tar.length) return { nome: 'ML · faturamento oficial', estado: 'erro', detalhe: 'arquivo existe mas está vazio', ms: Date.now() - t0 };
    const cats = {}, dias = new Set();
    let ultima = '';
    for (const x of tar) {
      if (!x) continue;
      cats[x.c || 'sem_categoria'] = (cats[x.c || 'sem_categoria'] || 0) + 1;
      if (x.d) { dias.add(x.d); if (x.d > ultima) ultima = x.d; }
    }
    const esperadas = ['comissao', 'mp', 'frete', 'parcelamento', 'ads', 'credito'];
    const sumiram = esperadas.filter(c => !cats[c]);
    const diasAtras = ultima ? Math.round((Date.now() - Date.parse(ultima + 'T12:00:00Z')) / 864e5) : null;
    let estado = 'ok', detalhe = 'última tarifa em ' + ultima + ' · ' + tar.length + ' tarifas · ' + dias.size + ' dias';
    if (sumiram.length) { estado = 'erro'; detalhe = 'CATEGORIAS QUE SUMIRAM: ' + sumiram.join(', ') + ' — o ML pode ter mudado os nomes. ' + detalhe; }
    else if (diasAtras != null && diasAtras > 3) { estado = 'alerta'; detalhe = 'extrato parado há ' + diasAtras + ' dias — o /ml-billing não está rodando. ' + detalhe; }
    return { nome: 'ML · faturamento oficial', estado, detalhe, ms: Date.now() - t0 };
  }

  // ── 4. CACHES EM DISCO: o ciclo e o vendasSync ainda estão vivos? ──────────
  function checaDisco() {
    const t0 = Date.now();
    const alvos = [
      { arq: CONFERIDOS_FILE, nome: '_conferidos.json', limite: 48 },
      { arq: path.join(CACHE_DIR, '_vendas_dia.json'), nome: '_vendas_dia.json', limite: 6 }
    ];
    const partes = [];
    let estado = 'ok';
    for (const a of alvos) {
      if (!fs.existsSync(a.arq)) { estado = 'erro'; partes.push(a.nome + ': NÃO EXISTE'); continue; }
      const h = horasDesde(new Date(fs.statSync(a.arq).mtime).toISOString());
      partes.push(a.nome + ': ' + h + 'h');
      if (h != null && h > a.limite) { if (estado !== 'erro') estado = 'alerta'; partes[partes.length - 1] += ' (parado — esperado < ' + a.limite + 'h)'; }
    }
    return { nome: 'Disco · caches do ciclo', estado, detalhe: partes.join(' · '), ms: Date.now() - t0 };
  }

  return async function handleCanario(req, res, urlObj) {
    const { method } = req;
    const p = urlObj.pathname;

    if (method === 'GET' && p === '/girassol-backup-offline/saude-integracoes') {
      if (!admOk(req, urlObj)) { json(res, 404, { error: 'not found' }); return true; }
      const t0 = Date.now();
      const checagens = [];
      for (const fn of [checaBling, checaML]) {
        try { checagens.push(await fn()); }
        catch (e) { checagens.push({ nome: fn.name, estado: 'erro', detalhe: 'exceção: ' + String(e.message || e) }); }
      }
      for (const fn of [checaBilling, checaDisco]) {
        try { checagens.push(fn()); }
        catch (e) { checagens.push({ nome: fn.name, estado: 'erro', detalhe: 'exceção: ' + String(e.message || e) }); }
      }
      const erros = checagens.filter(c => c.estado === 'erro');
      const alertas = checagens.filter(c => c.estado === 'alerta');
      const resumo = erros.length ? '🔴 ' + erros.length + ' contrato(s) quebrado(s)'
                   : alertas.length ? '🟡 ' + alertas.length + ' aviso(s)'
                   : '🟢 tudo de pé';
      if (erros.length || alertas.length) {
        console.log('[CANARIO] ' + resumo + ' — ' + [...erros, ...alertas].map(c => c.nome + ': ' + c.detalhe).join(' | '));
      }
      json(res, 200, {
        ok: !erros.length, resumo, versao: VERSAO,
        rodou_em: new Date().toISOString(), duracao_ms: Date.now() - t0,
        checagens,
        leia: 'ok = o contrato está de pé · alerta = algo velho ou sem amostra · erro = campo que usamos SUMIU ou a API não respondeu. Só leitura: nada aqui altera dado.'
      });
      return true;
    }

    return false;   // não é rota do canário
  };
}

// chamada pelo cron: roda as mesmas checagens e só faz barulho no log se algo mudou
async function canarioCron(ctx) {
  try {
    const handler = rotasCanario(ctx);
    const res = { writeHead() {}, end() {}, setHeader() {} };
    const fake = { method: 'GET', headers: {} };
    const url = new URL('https://interno/girassol-backup-offline/saude-integracoes?k=' + (process.env.ADMIN_KEY || ''));
    await handler(fake, res, url);
  } catch (e) { console.log('[CANARIO] falhou: ' + String(e.message || e)); }
}

module.exports = { rotasCanario, canarioCron };
