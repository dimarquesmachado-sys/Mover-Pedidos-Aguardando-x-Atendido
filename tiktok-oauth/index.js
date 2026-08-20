'use strict';
// ════════════════════════════════════════════════════════════════════════════════
//  TIKTOK SHOP — conexão e SONDA (14/08/2026)
// ════════════════════════════════════════════════════════════════════════════════
//  Objetivo do Diego: trazer do TikTok o MESMO conjunto que já vem de ML/Shopee/Magalu
//  — taxas, comissões, fretes, ads, devoluções, custos — direto do marketplace.
//
//  Por que este módulo só CONECTA e SONDA, sem interpretar nada:
//  é a regra que salvou os outros dois. No ML eu errei o formato 5× supondo estrutura;
//  na Shopee a fórmula só ficou certa depois de ver o JSON cru (e ainda apareceu campo
//  que só existe na AMB, o `shipping_seller_protection_fee_amount`). Aqui: conectar →
//  sondar → ver o cru → só então escrever o parser.
//
//  App do Diego (TikTok Shop Partner Center): "Checkout-Coleta-Transportadora-Status-Bling",
//  app_key 6jj99q5hog1do, BETA (até 25 vendedores autorizados), Brasil, segurança aprovada.
//  ⚠️ O redirect cadastrado hoje aponta pro serviço de coleta, que NÃO usa TikTok (conferido:
//  zero menções no código dele). Então não há risco de brigar por token — mas o redirect
//  precisa apontar pra cá, ou o `code` é capturado na barra de endereços (rota /tiktok/trocar-code).
//
//  ENV: TIKTOK_APP_KEY · TIKTOK_APP_SECRET · TIKTOK_REDIRECT_URI (opcional)
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');

const APP_KEY = process.env.TIKTOK_APP_KEY || '';
const APP_SECRET = process.env.TIKTOK_APP_SECRET || '';
const REDIRECT = process.env.TIKTOK_REDIRECT_URI || '';
const BASE = process.env.TIKTOK_BASE || 'https://open-api.tiktokglobalshop.com';
const AUTH = process.env.TIKTOK_AUTH_BASE || 'https://auth.tiktok-shops.com';
// ── MULTI-EMPRESA DESDE O NASCIMENTO (pedido do Diego, 14/08) ────────────────────
// "se der pra fazer algo que fica fácil plugar outras empresas no futuro, melhor —
//  faz tudo assim a partir de agora". Então: o app do TikTok é UM só (mesma app_key),
// e cada loja autoriza separadamente → um token por loja, num arquivo por loja.
// Plugar uma empresa nova = autorizar e pronto; nenhuma linha de código muda.
// A lista sai da env TIKTOK_LOJAS (padrão: as três de hoje).
const LOJAS = String(process.env.TIKTOK_LOJAS || 'girassol,amb,good')
  .split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
const LOJA_PADRAO = LOJAS[0] || 'girassol';
const lojaDe = q => {
  const l = String((q && q.get && q.get('loja')) || '').trim().toLowerCase();
  return LOJAS.indexOf(l) >= 0 ? l : LOJA_PADRAO;
};
const ARQ = loja => path.join(process.env.TIKTOK_CACHE_DIR || '/data', '_tiktok_token_' + (loja || LOJA_PADRAO) + '.json');

function lerToken(loja) { try { return JSON.parse(fs.readFileSync(ARQ(loja), 'utf8')); } catch (e) { return null; } }
function salvarToken(loja, t) {
  try { fs.mkdirSync(path.dirname(ARQ(loja)), { recursive: true }); } catch (e) {}
  fs.writeFileSync(ARQ(loja), JSON.stringify(t, null, 2));
}

// Assinatura das chamadas: HMAC-SHA256 sobre app_secret + path + params ordenados (sem
// `sign` e sem `access_token`) + body, fechando com app_secret. Formato documentado pelo
// TikTok Shop; a sonda confirma na prática antes de qualquer parser.
function assinar(caminho, params, body) {
  const chaves = Object.keys(params).filter(k => k !== 'sign' && k !== 'access_token').sort();
  let base = caminho;
  for (const k of chaves) base += k + params[k];
  if (body) base += body;
  const alvo = APP_SECRET + base + APP_SECRET;
  return crypto.createHmac('sha256', APP_SECRET).update(alvo).digest('hex');
}

async function chamar(caminho, extras, opts, loja) {
  const t = lerToken(loja);
  const o = opts || {};
  const params = Object.assign({
    app_key: APP_KEY,
    timestamp: String(Math.floor(Date.now() / 1000))
  }, extras || {});
  if (t && t.shop_cipher && !('shop_cipher' in params) && o.comShop !== false) params.shop_cipher = t.shop_cipher;
  params.sign = assinar(caminho, params, o.body ? JSON.stringify(o.body) : '');
  const qs = Object.keys(params).map(k => k + '=' + encodeURIComponent(params[k])).join('&');
  const headers = { 'content-type': 'application/json' };
  if (t && t.access_token) headers['x-tts-access-token'] = t.access_token;
  const r = await fetch(BASE + caminho + '?' + qs, {
    method: o.metodo || 'GET', headers,
    body: o.body ? JSON.stringify(o.body) : undefined
  });
  const txt = await r.text();
  let j = null; try { j = JSON.parse(txt); } catch (e) {}
  return { http: r.status, ok: r.ok, corpo: j, cru: j ? null : txt.slice(0, 600) };
}

async function tratar(req, res, urlObj, json) {
  const p = urlObj.pathname;
  const q = urlObj.searchParams;
  const ADM = process.env.ADMIN_KEY || '';
  const admOk = () => ADM && q.get('k') === ADM;

  if (p === '/tiktok/status') {
    if (!admOk()) { json(res, 404, { error: 'not found' }); return true; }
    const porLoja = {};
    for (const l of LOJAS) {
      const t = lerToken(l);
      porLoja[l] = t ? {
        conectada: !!t.access_token,
        shop: { id: t.shop_id || null, nome: t.shop_name || null, cipher: t.shop_cipher ? 'ok' : 'FALTA — rode /tiktok/lojas' },
        token_expira_em: t.expira_em || null, refresh_expira_em: t.refresh_expira_em || null
      } : { conectada: false };
    }
    json(res, 200, {
      ok: true,
      falta_env: [!APP_KEY && 'TIKTOK_APP_KEY', !APP_SECRET && 'TIKTOK_APP_SECRET'].filter(Boolean),
      app_key: APP_KEY ? APP_KEY.slice(0, 4) + '…' : null,
      lojas: LOJAS, loja_padrao: LOJA_PADRAO, por_loja: porLoja,
      redirect_configurado: REDIRECT || '(não definido — o code pode ser copiado da barra)',
      leia: 'cada loja autoriza separadamente: /tiktok/conectar?loja=girassol&k=… · depois /tiktok/lojas?loja=…&k= · empresa nova entra em TIKTOK_LOJAS'
    });
    return true;
  }

  // ── PAINEL (17/08) — uma tela só, pra não depender de decorar URL ────────────────
  // O Diego, depois de conectar a 2ª loja: "difícil, não tem como criar nada mais fácil pras
  // próximas lojas?". Tinha razão: eram 4 URLs na mão, e a `/tiktok/conectar` devolvia o link
  // mesmo com a loja JÁ conectada — o que parecia falha. Aqui: status das lojas e um botão por
  // etapa, na ordem, com o que já está pronto marcado.
  if (p === '/tiktok/painel') {
    if (!admOk()) { json(res, 404, { error: 'not found' }); return true; }
    const k = encodeURIComponent(q.get('k') || '');
    const linhas = LOJAS.map(l => {
      const t = lerToken(l) || {};
      const conectada = !!t.access_token, temCipher = !!t.shop_cipher;
      const passo = !conectada ? 1 : (!temCipher ? 2 : 3);
      const btn = (txt, href, cor) => '<a href="' + href + '" style="display:inline-block;padding:6px 12px;margin:2px;border-radius:8px;background:' + cor + ';color:#fff;text-decoration:none;font-size:13px">' + txt + '</a>';
      return '<tr><td style="padding:10px 8px;font-weight:700">' + l + '</td>' +
        '<td style="padding:10px 8px">' + (conectada ? (temCipher ? '✅ pronta' : '⚠️ falta o identificador da loja') : '— não conectada') +
        (t.shop_name ? '<div style="font-size:12px;opacity:.7">' + t.shop_name + '</div>' : '') + '</td>' +
        '<td style="padding:10px 8px">' +
          (passo === 1 ? btn('1 · Autorizar no TikTok', '/tiktok/conectar?loja=' + l + '&ir=1&k=' + k, '#2563eb') : '') +
          (passo === 2 ? btn('2 · Pegar identificador', '/tiktok/lojas?loja=' + l + '&k=' + k, '#7c3aed') : '') +
          (passo === 3 ? btn('Coletar financeiro (180d)', '/tiktok/financeiro-coletar?loja=' + l + '&dias=180&k=' + k, '#16a34a') +
                         btn('Reconectar', '/tiktok/conectar?loja=' + l + '&ir=1&forcar=1&k=' + k, '#64748b') : '') +
        '</td></tr>';
    }).join('');
    const html = '<!doctype html><meta charset="utf-8"><title>TikTok — lojas</title>' +
      '<body style="font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:#0f172a;color:#e2e8f0;padding:24px">' +
      '<h2 style="margin:0 0 4px">TikTok Shop — conexão por loja</h2>' +
      '<div style="opacity:.7;font-size:13px;margin-bottom:16px">app ' + (APP_KEY ? APP_KEY.slice(0, 4) + '…' : '(sem APP_KEY)') +
      ' · empresa nova: acrescente o nome em <code>TIKTOK_LOJAS</code> e ela aparece aqui</div>' +
      '<table style="width:100%;max-width:820px;border-collapse:collapse;background:#1e293b;border-radius:12px;overflow:hidden">' +
      '<tr style="background:#334155;font-size:12px;text-transform:uppercase;letter-spacing:.04em">' +
      '<th style="text-align:left;padding:8px">loja</th><th style="text-align:left;padding:8px">situação</th><th style="text-align:left;padding:8px">próximo passo</th></tr>' +
      linhas + '</table>' +
      '<p style="opacity:.7;font-size:12.5px;max-width:820px;margin-top:16px">Depois de autorizar, o TikTok volta para o endereço cadastrado no app. ' +
      'Se ele apontar para outro serviço, copie o <b>code</b> da barra e cole em <code>/tiktok/trocar-code?loja=…&amp;code=…&amp;k=…</code>. ' +
      'Para eliminar esse passo de vez, mude o <b>Redirect URL</b> do app para <code>' + (REDIRECT || 'https://…/tiktok/callback') + '</code>.</p>';
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(html);
    return true;
  }

  if (p === '/tiktok/conectar') {
    if (!admOk()) { json(res, 404, { error: 'not found' }); return true; }
    if (!APP_KEY) { json(res, 400, { ok: false, erro: 'falta TIKTOK_APP_KEY no ambiente' }); return true; }
    const loja = lojaDe(q);
    const jaT = lerToken(loja);
    // 17/08: a rota devolvia o link mesmo com a loja JÁ conectada, e isso parecia falha ("rodei
    // e não funcionou"). Agora ela DIZ que já está conectada; `&forcar=1` reconecta de propósito.
    if (jaT && jaT.access_token && q.get('forcar') !== '1') {
      json(res, 200, { ok: true, loja, ja_conectada: true,
        shop: { id: jaT.shop_id || null, nome: jaT.shop_name || null, cipher: jaT.shop_cipher ? 'ok' : 'FALTA — rode /tiktok/lojas?loja=' + loja },
        leia: 'esta loja já está conectada. Para reconectar mesmo assim, use &forcar=1. Painel com tudo: /tiktok/painel?k=' });
      return true;
    }
    // o `state` volta no callback e diz PARA QUAL LOJA é o token
    const url = AUTH + '/oauth/authorize?app_key=' + encodeURIComponent(APP_KEY) + '&state=' + encodeURIComponent(loja);
    if (q.get('ir') === '1') { res.writeHead(302, { Location: url, 'Cache-Control': 'no-store' }); res.end(); return true; }
    json(res, 200, { ok: true, loja, url, leia: 'abra logado como dono da loja (ou use &ir=1 pra ir direto); ao autorizar, o TikTok volta pro redirect com ?code=… — se o redirect apontar pra outro serviço, copie o code e chame /tiktok/trocar-code?loja=' + loja + '&code=…&k=' });
    return true;
  }

  if (p === '/tiktok/callback' || p === '/tiktok/trocar-code') {
    // no callback a loja vem do `state`; no trocar-code, do ?loja=
    const loja = (p === '/tiktok/callback')
      ? (LOJAS.indexOf(String(q.get('state') || '').trim().toLowerCase()) >= 0 ? String(q.get('state')).trim().toLowerCase() : lojaDe(q))
      : lojaDe(q);
    const code = String(q.get('code') || q.get('auth_code') || '').trim();
    if (p === '/tiktok/trocar-code' && !admOk()) { json(res, 404, { error: 'not found' }); return true; }
    if (!code) { json(res, 400, { ok: false, erro: 'sem ?code=' }); return true; }
    try {
      const r = await fetch(AUTH + '/api/v2/token/get?app_key=' + encodeURIComponent(APP_KEY) +
        '&app_secret=' + encodeURIComponent(APP_SECRET) + '&auth_code=' + encodeURIComponent(code) +
        '&grant_type=authorized_code');
      const j = await r.json().catch(() => null);
      const d = (j && j.data) || null;
      if (!d || !d.access_token) { json(res, 502, { ok: false, erro: 'TikTok não devolveu token', resposta: j }); return true; }
      salvarToken(loja, {
        access_token: d.access_token, refresh_token: d.refresh_token,
        expira_em: d.access_token_expire_in ? new Date(d.access_token_expire_in * 1000).toISOString() : null,
        refresh_expira_em: d.refresh_token_expire_in ? new Date(d.refresh_token_expire_in * 1000).toISOString() : null,
        obtido_em: new Date().toISOString()
      });
      json(res, 200, { ok: true, loja, msg: '✅ TikTok conectado para ' + loja + '. Agora rode /tiktok/lojas?loja=' + loja + '&k=… para pegar o shop_cipher.' });
    } catch (e) { json(res, 500, { ok: false, erro: String(e.message || e).slice(0, 200) }); }
    return true;
  }

  // o shop_cipher identifica a loja em toda chamada — vem de get_authorized_shops
  if (p === '/tiktok/lojas') {
    if (!admOk()) { json(res, 404, { error: 'not found' }); return true; }
    const loja = lojaDe(q);
    const r = await chamar('/authorization/202309/shops', {}, { comShop: false }, loja);
    const lista = (r.corpo && r.corpo.data && r.corpo.data.shops) || [];
    if (lista.length && q.get('salvar') !== '0') {
      const t = lerToken(loja) || {};
      const alvo = lista.find(s => String(s.id) === String(q.get('shop_id'))) || lista[0];
      t.shop_id = alvo.id; t.shop_name = alvo.name; t.shop_cipher = alvo.cipher;
      salvarToken(loja, t);
    }
    json(res, 200, { ok: r.ok, http: r.http, loja, lojas: lista, resposta_crua: r.corpo || r.cru,
      leia: 'a primeira loja (ou ?shop_id=) foi salva com o cipher; use ?salvar=0 para só olhar' });
    return true;
  }

  // ── FINANCEIRO (15/08): coleta e resumo, pela lib compartilhada ─────────────────
  // A fórmula foi MEDIDA no dado real antes de existir parser: identidade
  // `receita − tarifa + frete = repasse` fechou em 3 de 3, e a tarifa é R$ 2,00 + 12%.
  if (p === '/tiktok/financeiro' || p === '/tiktok/financeiro-coletar') {
    if (!admOk()) { json(res, 404, { error: 'not found' }); return true; }
    const loja = lojaDe(q);
    const finLib = require('../lib/tiktok-financeiro');
    const ctxFin = {
      CACHE_DIR: process.env.TIKTOK_CACHE_DIR || '/data', path,
      readJson: (arqv, padrao) => { try { return JSON.parse(fs.readFileSync(arqv, 'utf8')); } catch (e) { return padrao; } },
      writeJson: (arqv, v) => { try { fs.mkdirSync(path.dirname(arqv), { recursive: true }); } catch (e) {} fs.writeFileSync(arqv, JSON.stringify(v, null, 2)); },
      chamar
    };
    if (p.endsWith('-coletar')) {
      const r = await finLib.coletarFinanceiro(ctxFin, loja, q.get('dias'), { refazer: q.get('refazer') === '1' });
      json(res, 200, r);
      return true;
    }
    const de = String(q.get('de') || '').slice(0, 10), ate = String(q.get('ate') || '').slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(de) || !/^\d{4}-\d{2}-\d{2}$/.test(ate)) { json(res, 400, { ok: false, erro: 'passe &de=AAAA-MM-DD&ate=AAAA-MM-DD' }); return true; }
    if (de > ate) { json(res, 400, { ok: false, erro: 'período invertido' }); return true; }
    json(res, 200, Object.assign({ ok: true, loja, de, ate }, finLib.resumoFinanceiro(ctxFin, loja, de, ate)));
    return true;
  }

  // ── DEVOLUÇÕES (16/08): fecha o TikTok — ML e Shopee já tinham ──────────────────
  if (p === '/tiktok/devolucoes' || p === '/tiktok/devolucoes-coletar') {
    if (!admOk()) { json(res, 404, { error: 'not found' }); return true; }
    const loja = lojaDe(q);
    const finLib = require('../lib/tiktok-financeiro');
    const ctxD = {
      CACHE_DIR: process.env.TIKTOK_CACHE_DIR || '/data', path,
      readJson: (arqv, padrao) => { try { return JSON.parse(fs.readFileSync(arqv, 'utf8')); } catch (e) { return padrao; } },
      writeJson: (arqv, v) => { try { fs.mkdirSync(path.dirname(arqv), { recursive: true }); } catch (e) {} fs.writeFileSync(arqv, JSON.stringify(v, null, 2)); },
      chamar
    };
    if (p.endsWith('-coletar')) {
      const r = await finLib.coletarDevolucoesTikTok(ctxD, loja, q.get('dias'));
      json(res, 200, r);
      return true;
    }
    const de = String(q.get('de') || '').slice(0, 10), ate = String(q.get('ate') || '').slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(de) || !/^\d{4}-\d{2}-\d{2}$/.test(ate)) { json(res, 400, { ok: false, erro: 'passe &de=AAAA-MM-DD&ate=AAAA-MM-DD' }); return true; }
    if (de > ate) { json(res, 400, { ok: false, erro: 'período invertido' }); return true; }
    json(res, 200, Object.assign({ ok: true, loja, de, ate }, finLib.resumoDevolucoesTikTok(ctxD, loja, de, ate)));
    return true;
  }

  // ── DEVOLUÇÕES CRUAS (20/08): raio-X pro app de Devoluções ──────────────────────
  // O resumo acima agrega e devolve só o top-20 por valor; pra frente de devoluções
  // (bipe/espreita no app de Devoluções) o que importa é VER o que a API realmente
  // mandou — os `cru_campos` que a coleta guarda por registro respondem, por exemplo,
  // se existe campo de rastreio da reversa. Só LEITURA do cache; nada chama o TikTok.
  if (p === '/tiktok/devolucoes-cru') {
    if (!admOk()) { json(res, 404, { error: 'not found' }); return true; }
    const loja = lojaDe(q);
    const arqD = path.join(process.env.TIKTOK_CACHE_DIR || '/data', '_tiktok_devolucoes_' + loja + '.json');
    // Só ENOENT significa "nunca coletou" — o caso é rastreado EXPLICITAMENTE.
    // Arquivo corrompido/ilegível é OUTRA coisa e sai em `cache_erro`; e JSON
    // válido com a forma errada (`null`, array, primitivo) também é cache_erro,
    // porque o arquivo EXISTE — senão a corrupção se disfarça de "sem cache"
    // (apontado pelo Codex no PR #155, rodadas 1 e 2).
    let g = null, cacheErro = null, semCache = false;
    try {
      const parsed = JSON.parse(fs.readFileSync(arqD, 'utf8'));
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) g = parsed;
      else cacheErro = 'conteudo do cache nao tem a forma esperada (veio ' + (parsed === null ? 'null' : Array.isArray(parsed) ? 'array' : typeof parsed) + ')';
    } catch (e) {
      if (e && e.code === 'ENOENT') semCache = true;
      else cacheErro = String((e && e.message) || e).slice(0, 160);
    }
    const todos = Object.values((g && g.devolucoes) || {})
      .sort((a, b) => (Number(b.criado_em) || 0) - (Number(a.criado_em) || 0));
    let limite = parseInt(q.get('limite') || '', 10);
    if (!Number.isFinite(limite) || limite < 1 || limite > 200) limite = 30;
    const cruCampos = {};
    for (const d of todos) for (const c of (d.cru_campos || [])) cruCampos[c] = (cruCampos[c] || 0) + 1;
    json(res, 200, { ok: true, loja,
      guardadas: todos.length,
      // `sem_cache` separa "NUNCA coletou" (arquivo nem existe) de "coletou e veio
      // vazio" — sem isso, loja recém-conectada pareceria loja sem devoluções.
      sem_cache: semCache,
      cache_erro: cacheErro,
      atualizado: (g && g.atualizado) || null, coleta_ok_em: (g && g.ok_em) || null,
      cru_campos_uniao: cruCampos,
      registros: todos.slice(0, limite) });
    return true;
  }

  // ── QUEM NÃO FECHOU A IDENTIDADE (18/08) ────────────────────────────────────────
  // A coleta guarda `confere` por pedido: 0 = `receita − tarifa + frete + ajuste = repasse`.
  // Apareceu 1 pedido com sobra na AMB e 9 na Girassol — quero VER o que mudou, em vez de
  // deixar o contador subindo em silêncio. Se a Shopee/TikTok criar cobrança nova, é aqui
  // que ela aparece primeiro (foi assim que achamos o campo de proteção de frete na Shopee).
  if (p === '/tiktok/nao-fecharam') {
    if (!admOk()) { json(res, 404, { error: 'not found' }); return true; }
    const loja = lojaDe(q);
    const arqNF = path.join(process.env.TIKTOK_CACHE_DIR || '/data', '_tiktok_financeiro_' + loja + '.json');
    let ped = {};
    try { ped = (JSON.parse(fs.readFileSync(arqNF, 'utf8')) || {}).pedidos || {}; } catch (e) {}
    const fora = [];
    let total = 0;
    for (const x of Object.values(ped)) {
      total++;
      const dif = Number(x.confere || 0);
      if (Math.abs(dif) < 0.01) continue;
      fora.push({
        order_id: x.order_id, tipo: x.tipo, extrato: x.extrato_id,
        criado_em: x.criado_em ? new Date(x.criado_em * 1000).toISOString() : null,
        receita: x.receita, tarifa: x.tarifa, frete_liquido: x.frete_liquido, ajuste: x.ajuste, repasse: x.repasse,
        deveria_dar: Math.round(((x.receita || 0) - (x.tarifa || 0) + (x.frete_liquido || 0) + (x.ajuste || 0)) * 100) / 100,
        sobra: dif,
        comissao_plataforma: x.comissao_plataforma, afiliado: x.afiliado,
        subsidio_frete: x.subsidio_frete, frete_real: x.frete_real,
        reembolso_cliente: x.reembolso_cliente, frete_devolucao: x.frete_devolucao,
        taxa_adm_reembolso: x.taxa_adm_reembolso, desconto_plataforma: x.desconto_plataforma,
        ajustes_depois: x.ajustes_depois, tipos_vistos: x.tipos_vistos
      });
    }
    fora.sort((a, b) => Math.abs(b.sobra) - Math.abs(a.sobra));
    json(res, 200, {
      ok: true, loja, pedidos_guardados: total, nao_fecharam: fora.length,
      soma_das_sobras: Math.round(fora.reduce((s, x) => s + x.sobra, 0) * 100) / 100,
      lista: fora.slice(0, 50),
      leia: 'sobra = repasse − (receita − tarifa + frete + ajuste). Positiva: o TikTok pagou MAIS do que a conta prevê (algum crédito que ainda não lemos). Negativa: cobrou algo que não está em nenhum campo conhecido.'
    });
    return true;
  }

  // SONDA GENÉRICA — não interpreta nada, devolve o JSON como o TikTok mandou
  if (p === '/tiktok/sonda') {
    if (!admOk()) { json(res, 404, { error: 'not found' }); return true; }
    const caminho = String(q.get('caminho') || '').trim();
    // 14/08: ids de statement/pedido do TikTok trazem HÍFEN — sem ele no filtro, sondar o
    // detalhe de um extrato era recusado antes de sair. Segue sem aceitar espaço, query ou
    // caractere estranho: é uma sonda de leitura, não passagem livre.
    if (!/^\/[a-z0-9_\-\/\.]+$/i.test(caminho)) {
      json(res, 400, { ok: false, erro: 'use ?caminho=/order/202309/orders/search (só letras, números, / . _)',
        exemplos: [
          '/finance/202309/statements  (exige &sort_field=statement_time)',
          '/finance/202309/statements/{id}/statement_transactions',
          '/finance/202309/payments',
          '/order/202309/orders/search  (&metodo=POST)',
          '/return_refund/202309/return_orders/search  (&metodo=POST)'
        ] });
      return true;
    }
    const extras = {};
    for (const [k, v] of q.entries()) { if (['k', 'caminho', 'metodo', 'body', 'loja'].indexOf(k) < 0) extras[k] = v; }
    let body = null;
    if (q.get('body')) { try { body = JSON.parse(q.get('body')); } catch (e) { json(res, 400, { ok: false, erro: 'body não é JSON válido' }); return true; } }
    const loja = lojaDe(q);
    const r = await chamar(caminho, extras, { metodo: (q.get('metodo') || 'GET').toUpperCase(), body }, loja);
    json(res, 200, { ok: r.ok, http: r.http, loja, caminho, params: extras, resposta_crua: r.corpo || r.cru,
      leia: 'resposta CRUA do TikTok — nada interpretado ainda. Com ela na mão eu escrevo o parser sem chutar formato.' });
    return true;
  }

  return false;
}

module.exports = { tratar, chamar, lerToken, LOJAS, LOJA_PADRAO };
