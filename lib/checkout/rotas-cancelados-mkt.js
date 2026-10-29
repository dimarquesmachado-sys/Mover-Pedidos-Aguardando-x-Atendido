'use strict';
/* ─────────────────────────────────────────────────────────────────────────────
   CANCELADO NO MARKETPLACE ANTES DA POSTAGEM — a SONDA (29/10/2026, peça única, as três empresas).

   O caso (Diego, 29/10): pedido TikTok cancelado pelo cliente logo depois da compra, NF já emitida no Bling, e o pedido
   seguia na fila do galpão ("⚠️ sem etiqueta" — o TikTok não gera etiqueta pra pedido cancelado). Se ninguém percebe:
   NF válida (imposto), estoque baixado de um produto que está no CD, e o card sujando a tela do estoquista.

   ⚠️ A REGRA QUE MANDA EM TUDO (dele): só pedido NÃO POSTADO. Pedido que saiu do CD e foi cancelado pode ser venda
   devolvida — isso é do sistema de Devoluções, não daqui. Por isso o veredito exige as DUAS pontas:
     · NOSSA: o pedido está na fila do galpão e NÃO foi conferido (o checkout nunca o despachou);
     · DO MARKETPLACE: cancelado E sem nenhum sinal de envio (coleta, entrega, item em trânsito/entregue).
   Cancelado com sinal de envio → "cancelado_depois_de_postado" (é do Devoluções; aqui não se mexe). Resposta que falha
   ou vem sem o pedido → "nao_sei" — nunca vira veredito (regra da casa: "não sei" ≠ "não está").

   Esta peça é SÓ LEITURA: não cancela NF, não mexe no Bling, não tira nada da fila. Serve pra ver, com os pedidos de
   verdade, o que o marketplace responde (os campos crus vêm junto, pra calibrar o veredito) antes de qualquer ação.
   Começa pelo TikTok (o caso); ML, Shopee e Magalu entram nos próximos passos.

   criar({ prefixo, empresa, tiktokConta, manifest(), lerConferidos(), json, validarSessao, ehAdmin, tiktokOAuth? })
   → async (req, res, urlObj, method) — GET <prefixo>/cancelados-antes-postagem (admin: ?k= ou sessão de admin)
   ───────────────────────────────────────────────────────────────────────────── */
const { lerChaveAdmin } = require('../http/chave-admin');

const SINAIS_ITEM = /IN_TRANSIT|DELIVERED|COMPLETED|SHIPPED|COLLECTED/;
const CAMPOS_PEDIDO = ['status', 'cancellation_initiator', 'cancel_reason', 'cancel_time', 'rts_time', 'collection_time',
  'delivery_time', 'tracking_number', 'shipping_provider', 'shipping_type', 'update_time'];

/* o veredito de UM pedido do TikTok, só pelo que o TikTok respondeu (a nossa ponta — fila, não conferido — é de quem chama) */
function classificarTikTok(o) {
  if (!o || typeof o !== 'object') return { veredito: 'nao_sei', via: 'tiktok_sem_o_pedido', sinais: [] };
  const st = String(o.status || '').toUpperCase();
  if (!st) return { veredito: 'nao_sei', via: 'tiktok_sem_status', sinais: [] };
  const sinais = [];
  if (o.collection_time) sinais.push('coletado');
  if (o.delivery_time) sinais.push('entregue');
  for (const li of (Array.isArray(o.line_items) ? o.line_items : [])) {
    const ds = String((li && (li.display_status || li.package_status)) || '').toUpperCase();
    if (SINAIS_ITEM.test(ds)) sinais.push('item_' + ds.toLowerCase());
  }
  if (st !== 'CANCELLED') return { veredito: 'ativo', via: 'tiktok_status_' + st.toLowerCase(), sinais };
  if (sinais.length) return { veredito: 'cancelado_depois_de_postado', via: 'tiktok_cancelado_com_sinal_de_envio', sinais };
  return { veredito: 'cancelado_antes_postagem', via: 'tiktok_cancelado_sem_sinal_de_envio', sinais };
}

function _horasDesde(iso) {
  const t = Date.parse(String(iso || '').replace(' ', 'T'));
  return isFinite(t) ? Math.round((Date.now() - t) / 36e5 * 10) / 10 : null;
}

function criar(ctx) {
  const c = ctx || {};
  for (const k of ['prefixo', 'empresa', 'tiktokConta', 'json', 'validarSessao', 'ehAdmin']) {
    if (!c[k]) throw new Error('rotas-cancelados-mkt: falta ' + k);
  }
  if (typeof c.manifest !== 'function' || typeof c.lerConferidos !== 'function') throw new Error('rotas-cancelados-mkt: falta manifest/lerConferidos');
  const ROTA = c.prefixo + '/cancelados-antes-postagem';

  function admOk(req, urlObj) {
    const k = lerChaveAdmin(req, urlObj);
    if (process.env.ADMIN_KEY && k === process.env.ADMIN_KEY) return true;
    const s = c.validarSessao(req.headers && req.headers['cookie']);
    return !!(s && c.ehAdmin(s));
  }

  /* a fila do galpão que o checkout ainda NÃO despachou, só TikTok, com o número do pedido no TikTok */
  function filaTikTok() {
    const man = c.manifest() || {};
    const conf = c.lerConferidos() || {};
    const fila = [];
    let conferidos = 0;
    for (const id of Object.keys(man)) {
      const m = man[id] || {};
      if (String(m.marketplace || '').toLowerCase() !== 'tiktok') continue;
      if (conf[id]) { conferidos++; continue; }
      fila.push({ id, numero: m.numero || null, numero_loja: m.numero_loja ? String(m.numero_loja) : null, cliente: m.cliente || '',
        nf_numero: m.nf_numero || null, nf_emissao: m.nf_emissao || null, tem_etiqueta: !!m.tem_etiqueta });
    }
    return { fila, conferidos };
  }

  async function consultarTikTok(ids) {
    let tk = null;
    try { tk = c.tiktokOAuth ? c.tiktokOAuth() : require('../../tiktok-oauth'); } catch (e) { return { erro: 'cliente do TikTok indisponível' }; }
    if (!tk || typeof tk.chamar !== 'function') return { erro: 'cliente do TikTok indisponível' };
    if (tk.lerToken && !tk.lerToken(c.tiktokConta)) return { erro: 'empresa sem autorização no TikTok (' + c.tiktokConta + ')' };
    const porId = {};
    let chaves = null;
    for (let i = 0; i < ids.length; i += 50) {
      const lote = ids.slice(i, i + 50);
      let r = null;
      try { r = await tk.chamar('/order/202309/orders', { ids: lote.join(',') }, { metodo: 'GET' }, c.tiktokConta); }
      catch (e) { return { erro: 'TikTok: ' + String(e.message || e).slice(0, 120), porId, chaves }; }
      if (!r || !r.ok || !r.corpo || r.corpo.code !== 0) {
        return { erro: 'TikTok não respondeu: ' + String((r && r.corpo && r.corpo.message) || ('HTTP ' + (r && r.http))).slice(0, 120), porId, chaves };
      }
      for (const o of ((r.corpo.data && r.corpo.data.orders) || [])) {
        if (!o || !o.id) continue;
        porId[String(o.id)] = o;
        if (!chaves) chaves = Object.keys(o).sort();
      }
    }
    return { porId, chaves };
  }

  return async function rotasCanceladosMkt(req, res, urlObj, method) {
    if (method !== 'GET' || urlObj.pathname !== ROTA) return false;
    if (!admOk(req, urlObj)) { c.json(res, 404, { error: 'not found' }); return true; }
    const { fila, conferidos } = filaTikTok();
    const comNumero = fila.filter((p) => p.numero_loja);
    const tk = comNumero.length ? await consultarTikTok(comNumero.map((p) => p.numero_loja)) : { porId: {}, chaves: null };
    const contagem = { cancelado_antes_postagem: 0, cancelado_depois_de_postado: 0, ativo: 0, nao_sei: 0 };
    const pedidos = [];
    for (const p of fila) {
      const o = p.numero_loja && tk.porId ? tk.porId[p.numero_loja] : null;
      /* resposta que falhou no meio: o que não veio é "não sei", nunca "ativo" */
      const v = !p.numero_loja ? { veredito: 'nao_sei', via: 'pedido_sem_numero_no_tiktok', sinais: [] }
        : (o ? classificarTikTok(o) : { veredito: 'nao_sei', via: tk.erro ? 'tiktok_falhou' : 'tiktok_nao_devolveu_o_pedido', sinais: [] });
      contagem[v.veredito]++;
      if (v.veredito === 'ativo') continue;
      const campos = {};
      if (o) for (const k of CAMPOS_PEDIDO) if (o[k] != null && o[k] !== '') campos[k] = o[k];
      pedidos.push(Object.assign({}, p, {
        horas_desde_nf: _horasDesde(p.nf_emissao), veredito: v.veredito, via: v.via, sinais: v.sinais, campos,
        itens: o && Array.isArray(o.line_items) ? o.line_items.slice(0, 10).map((li) => ({
          display_status: li.display_status || null, package_status: li.package_status || null,
          tracking_number: li.tracking_number || null, cancel_reason: li.cancel_reason || null })) : [],
      }));
    }
    c.json(res, 200, {
      ok: !tk.erro, empresa: c.empresa, so_leitura: true,
      regra: 'só pedido NÃO POSTADO: na fila do galpão sem conferência E cancelado no marketplace sem sinal de envio; o resto é do Devoluções ou "não sei"',
      tiktok: { na_fila: fila.length, ja_conferidos_ignorados: conferidos, consultados: comNumero.length, erro: tk.erro || null, contagem, pedidos,
        chaves_do_pedido: tk.chaves || null },
      proximos: 'ML, Shopee e Magalu entram nos próximos passos',
    });
    return true;
  };
}

module.exports = { criar, classificarTikTok };
