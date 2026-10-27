'use strict';

/* 14/09 (auditoria, P2): a chave passa a ser lida do HEADER primeiro; a query
   continua aceita porque há dezenas de URLs salvas com &k= — cortar de uma vez
   quebraria o trabalho de quem opera pelo navegador. */
const { lerChaveAdmin } = require('../http/chave-admin');
// ════════════════════════════════════════════════════════════════════════
//  AMBTOTAL · CANÁRIO DAS INTEGRAÇÕES (porte da Girassol)  (05/08/2026)
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


function rotasCanarioDe(o, ctx) {
  const { json, ehAdmin, CACHE_DIR, CONFERIDOS_FILE, readJson, blingGet } = o.base;
  const fetch = o.fetch || require('node-fetch');
  const { VERSAO, validarSessao } = ctx;

  function admOk(req, urlObj) {
    const k = lerChaveAdmin(req, urlObj);
    const s = validarSessao(req.headers['cookie']);
    return (process.env.ADMIN_KEY && k === process.env.ADMIN_KEY) || (s && ehAdmin(s));
  }

  const temCampo = (o, c) => o && Object.prototype.hasOwnProperty.call(o, c);
  const horasDesde = iso => { const t = Date.parse(iso || ''); return isFinite(t) ? Math.round((Date.now() - t) / 36e5 * 10) / 10 : null; };

  // ── 0. SHOPEE: quanto falta pra Partner Key vencer? ───────────────────────
  // A Live API Partner Key do app da Shopee vence em 23/10/2026 12:59. No dia em
  // que vencer, TODA chamada assinada para de funcionar de uma vez — escrow,
  // devoluções, carteira, etiqueta. Não é degradação, é apagão.
  // Este check não chama ninguém: é aritmética de calendário. Fica amarelo com
  // 30 dias de antecedência e vermelho com 7, pra dar tempo de renovar com calma.
  // A data vem da env SHOPEE_KEY_VENCE (AAAA-MM-DD); sem ela, usa a conhecida.
  /* 27/10: a data é só LEMBRETE — a prova de que a chave vale é a Shopee aceitar a assinatura. A conferência do serviço
     (logo antes, nesta mesma rodada) chama /interno/pedidos-do-dia, que lista os pedidos na API da Shopee ASSINANDO com
     a Partner Key DESTA loja. Então: listou → a chave está valendo agora (data vencida vira só aviso pra atualizar a
     data); a Shopee recusou → erro de verdade; não deu pra conferir → fica o calendário. A data pode ser por empresa
     (<TAG>_SHOPEE_KEY_VENCE) — cada loja tem a sua Partner Key no serviço (<LOJA>_SYNC_SHOPEE_PARTNER_KEY). */
  let _provaShopee = null;
  function checaChaveShopee() {
    const t0 = Date.now();
    const NOME = 'Shopee · validade da Partner Key';
    const tagE = String((require('./config-empresa').configCheckout(o.empresa) || {}).tag || '').trim();
    const envDia = (tagE && process.env[tagE + '_SHOPEE_KEY_VENCE']) ? tagE + '_SHOPEE_KEY_VENCE' : 'SHOPEE_KEY_VENCE';
    const venc = String(process.env[envDia] || '2026-10-23').slice(0, 10);
    /* 27/10: a variável que o aviso SUGERE é a DA EMPRESA — a geral vale pras três, e cada loja tem a sua Partner Key
       (datas diferentes): cadastrar a da Girassol na geral calaria o lembrete da AMB e da GOOD com a data errada */
    const envSugerido = tagE ? tagE + '_SHOPEE_KEY_VENCE' : 'SHOPEE_KEY_VENCE';
    const pv = _provaShopee || {};
    /* 27/10: a prova CONCLUSIVA (aceitou ou recusou) fica gravada pro aviso da barra dos painéis
       (lib/checkout/aviso-chave-shopee) — o aviso não chama a Shopee a cada tela aberta */
    if (pv.assinaturaOk || pv.recusou) {
      try { o.base.writeJson(require('path').join(o.base.CACHE_DIR, require('./aviso-chave-shopee').ARQ_PROVA), Object.assign({ quando: new Date().toISOString() }, pv)); } catch (e) { /* o aviso é bônus */ }
    }
    const envChaveServ = String(pv.loja || o.empresa || '').toUpperCase() + '_SYNC_SHOPEE_PARTNER_KEY';
    if (pv.recusou) {
      return { nome: NOME, estado: 'erro', detalhe: 'a Shopee RECUSOU a chamada assinada da loja ' + pv.loja + ' agora (' + pv.recusou + ') — se for assinatura/partner, a Partner Key desta loja venceu ou está errada: gere a nova no console da Open Platform e troque ' + envChaveServ + ' no serviço da Shopee', ms: Date.now() - t0 };
    }
    const tv = Date.parse(venc + 'T12:00:00Z');
    if (!isFinite(tv)) return { nome: NOME, estado: 'alerta', detalhe: 'data de vencimento inválida em ' + envDia + ': ' + venc + (pv.assinaturaOk ? ' · a assinatura da loja ' + pv.loja + ' foi aceita agora' : ''), ms: Date.now() - t0 };
    const dias = Math.floor((tv - Date.now()) / 864e5);
    const quando = venc.split('-').reverse().join('/');
    const provaTxt = pv.assinaturaOk ? ' · assinatura conferida agora: a Shopee aceitou (loja ' + pv.loja + ' listou ' + pv.listados + ' pedido(s))' : (pv.semProva ? ' · não deu pra conferir a assinatura agora (' + pv.semProva + ')' : '');
    if (dias < 0 && pv.assinaturaOk) {
      return { nome: NOME, estado: 'alerta', detalhe: 'a data cadastrada (' + quando + ') já passou, mas a Shopee ACEITOU a assinatura agora (loja ' + pv.loja + ' listou ' + pv.listados + ' pedido(s)) — a chave desta loja está valendo. Cadastre a validade nova em ' + envSugerido + ' (AAAA-MM-DD) pro lembrete voltar a contar', ms: Date.now() - t0 };
    }
    if (dias < 0) return { nome: NOME, estado: 'erro', detalhe: 'VENCEU em ' + quando + ' (pela data em ' + envDia + ') — as chamadas assinadas podem estar falhando. Gere a chave nova no console da Open Platform e troque ' + envChaveServ + ' no serviço da Shopee' + provaTxt, ms: Date.now() - t0 };
    if (dias <= 7) return { nome: NOME, estado: 'erro', detalhe: 'vence em ' + dias + ' dia(s), em ' + quando + ' — renove AGORA, senão escrow/devoluções/carteira/etiqueta param de uma vez' + provaTxt, ms: Date.now() - t0 };
    if (dias <= 30) return { nome: NOME, estado: 'alerta', detalhe: 'vence em ' + dias + ' dias (' + quando + ') — dá pra renovar com calma agora' + provaTxt, ms: Date.now() - t0 };
    return { nome: NOME, estado: 'ok', detalhe: 'vence em ' + quando + ' (faltam ' + dias + ' dias)' + provaTxt, ms: Date.now() - t0 };
  }

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
    try { const { garantirTokenML } = o.mlTokenManager(); tk = await garantirTokenML(); }
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


  // ── 5. SERVIÇOS VIZINHOS: o que o dashboard consome por HTTP está de pé? ────
  //  11/08 — nasceu de um prejuízo real: o host do serviço da Shopee estava
  //  errado no código (era o nome do REPO, não o do serviço no Render). Toda
  //  chamada voltava 404 e o sistema anotava "escrow sem resposta", como se a
  //  Shopee é que não tivesse respondido. Passou DESPERCEBIDO DE JANEIRO A
  //  AGOSTO — 8 meses de tarifa estimada em vez de real, em metade das vendas.
  //  Serviço separado é um contrato como outro qualquer: tem que ser vigiado.
  async function checaServicos() {
    const t0 = Date.now();
    /* 26/10: o serviço, a chave e a loja vêm da configuração única DA empresa (as mesmas que a venda do dia usa) */
    const sh = o.shopee();
    const shURL = String(sh.url || '').replace(/\/+$/, '');
    const shKey = String(sh.key || '').trim();
    const loja = sh.loja;
    const partes = [];
    let estado = 'ok';
    _provaShopee = { loja, semProva: 'o serviço não chegou a listar' };
    // (a) o host existe e é o serviço certo?
    try {
      const r = await fetch(shURL + '/', { timeout: 20000 });
      const txt = await r.text().catch(() => '');
      if (!r.ok) { estado = 'erro'; partes.push('host ' + shURL + ' respondeu HTTP ' + r.status + ' (' + txt.slice(0, 40).replace(/\s+/g, ' ') + ') — SERVIÇO ERRADO OU FORA'); }
      else if (!/\{/.test(txt)) { estado = 'alerta'; partes.push('host respondeu, mas não parece o serviço (sem JSON na raiz)'); }
      else partes.push('host de pé');
    } catch (e) { estado = 'erro'; partes.push('host ' + shURL + ' inacessível: ' + String(e.message || e).slice(0, 60)); }
    // (b) a loja da AMB é atendida E a chave é aceita? (1 pedido, só leitura)
    if (estado !== 'erro') {
      if (!shKey) { estado = 'alerta'; partes.push('sem chave configurada (' + (sh.envsChave || []).join(' / ') + ')'); }
      else {
        try {
          const r2 = await fetch(shURL + '/' + loja + '/interno/pedidos-do-dia?horas=24&k=' + encodeURIComponent(shKey), { timeout: 45000 });
          const j2 = await r2.json().catch(() => null);
          /* 27/10: a resposta da listagem é a PROVA da Partner Key: listou = a Shopee aceitou a assinatura; 'Shopee recusou a
             listagem' (502 do serviço) = recusou; 401/404/rede = o problema é antes da Shopee, não prova nada da chave */
          if (r2.ok && j2 && j2.ok) _provaShopee = { loja, assinaturaOk: true, listados: j2.listados != null ? j2.listados : '?' };
          /* a Shopee recusa a chave de dois jeitos: na listagem (502 'Shopee recusou a listagem') e ANTES dela, ao renovar o
             token da loja (500 'Shopee refresh falhou: {"error":"error_partner_key"…}' — o caso da Girassol em 27/10) */
          else if (j2 && /Shopee recusou|refresh falhou|error_partner|error_sign|invalid_partner/i.test(String(j2.erro || ''))) _provaShopee = { loja, recusou: String(j2.erro).replace(/^Shopee recusou a listagem:\s*/i, '').replace(/^\[[a-z]+\]\s*/i, '').slice(0, 200) };
          else _provaShopee = { loja, semProva: r2.status === 401 ? 'a chave interna foi recusada antes de chegar na Shopee' : ('HTTP ' + r2.status) };
          if (r2.status === 401) { estado = 'erro'; partes.push('loja ' + loja + ': chave RECUSADA (401) — a env não bate com a INTERNAL_KEY do serviço'); }
          else if (r2.status === 404) { estado = 'erro'; partes.push('loja ' + loja + ': rota não existe (404) — serviço desatualizado ou loja não configurada'); }
          else if (!r2.ok || !j2 || !j2.ok) { estado = 'erro'; partes.push('loja ' + loja + ': HTTP ' + r2.status + ' ' + String((j2 && j2.erro) || '').slice(0, 200)); }   /* 27/10: 60 cortava o erro da Shopee no meio ('error_partner_ke') */
          else {
            partes.push('loja ' + loja + ': responde (' + (j2.listados != null ? j2.listados : '?') + ' pedido(s) em 24h)');
            // Codex PR#19: o serviço dizendo "minha lista está INCOMPLETA" não pode sair
            // verde — o canário ficaria calado justamente quando falta venda.
            if (j2.parcial) { estado = (estado === 'erro' ? 'erro' : 'alerta'); partes.push('⚠️ resposta PARCIAL' + (j2.erro_lista ? ': ' + String(j2.erro_lista).slice(0, 60) : '') + (j2.truncado ? ' (truncada)' : '')); }
          }
        } catch (e) { estado = 'erro'; partes.push('loja ' + loja + ': ' + String(e.message || e).slice(0, 60)); }
      }
    }
    return { nome: 'Serviço Shopee (sync) · host, loja e chave', estado, detalhe: partes.join(' · '), ms: Date.now() - t0 };
  }

  return async function handleCanario(req, res, urlObj) {
    const { method } = req;
    const p = urlObj.pathname;

    if (method === 'GET' && p === o.prefixo + '/saude-integracoes') {
      if (!admOk(req, urlObj)) { json(res, 404, { error: 'not found' }); return true; }
      const t0 = Date.now();
      const checagens = [];
      for (const fn of [checaBling, checaML, checaServicos]) {
        try { checagens.push(await fn()); }
        catch (e) { checagens.push({ nome: fn.name, estado: 'erro', detalhe: 'exceção: ' + String(e.message || e) }); }
      }
      for (const fn of [checaBilling, checaDisco, checaChaveShopee]) {
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
async function canarioCronDe(o, ctx) {
  try {
    const handler = rotasCanarioDe(o, ctx);
    const res = { writeHead() {}, end() {}, setHeader() {} };
    const fake = { method: 'GET', headers: {} };
    const url = new URL('https://interno' + o.prefixo + '/saude-integracoes?k=' + (process.env.ADMIN_KEY || ''));
    await handler(fake, res, url);
  } catch (e) { console.log('[CANARIO] falhou: ' + String(e.message || e)); }
}

/* criarCanarioIntegracoes({ base, prefixo, mlTokenManager, empresa, fetch? }) — tudo que é da empresa vem de fora: o base
   (Bling, pasta, json, admin), o prefixo das rotas, o token do ML e a empresa (o serviço da Shopee da configuração única) */
function criarCanarioIntegracoes(o) {
  if (!o || !o.base || !o.prefixo || typeof o.mlTokenManager !== 'function' || !o.empresa) {
    throw new Error('lib/checkout/canario-integracoes: falta peça da empresa (base, prefixo, mlTokenManager, empresa)');
  }
  const cfgE = require('./config-empresa');
  const oo = Object.assign({}, o, {
    shopee: o.shopee || (() => {
      const c = cfgE.configCheckout(o.empresa), v = c.vendasDia || {};
      return { url: c.ler(v.shopeeUrl), key: c.ler(v.shopeeKey), loja: c.ler(v.shopeeLoja), envsChave: (v.shopeeKey && v.shopeeKey.envs) || [] };
    }),
  });
  return { rotasCanario: (ctx) => rotasCanarioDe(oo, ctx), canarioCron: (ctx) => canarioCronDe(oo, ctx) };
}

module.exports = { criarCanarioIntegracoes };
