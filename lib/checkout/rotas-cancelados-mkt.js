'use strict';
/* ─────────────────────────────────────────────────────────────────────────────
   CANCELADO NO MARKETPLACE ANTES DA POSTAGEM — a SONDA (29/10/2026, peça única, as três empresas).

   O caso (Diego, 29/10): pedido TikTok cancelado pelo cliente logo depois da compra, NF já emitida no Bling, e o pedido
   seguia na fila do galpão ("⚠️ sem etiqueta" — o TikTok não gera etiqueta pra pedido cancelado). Se ninguém percebe:
   NF válida (imposto), estoque baixado de um produto que está no CD, e o card sujando a tela do estoquista.

   ⚠️ A REGRA QUE MANDA EM TUDO (dele): só pedido NÃO POSTADO. Pedido que saiu do CD e foi cancelado pode ser venda
   devolvida — isso é do sistema de Devoluções, não daqui. Por isso o veredito exige as DUAS pontas:
     · NOSSA: o pedido está na fila do galpão e NÃO foi conferido (o checkout nunca o despachou);
     · DO MARKETPLACE: cancelado E sem nenhum sinal de envio (coleta, entrega, item em trânsito/entregue). Etiqueta
       gerada (pronto pra envio, rastreio) NÃO é envio — calibrado com um caso real em 26/11.
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
  if (!o || typeof o !== 'object') return { veredito: 'nao_sei', via: 'tiktok_sem_o_pedido', sinais: [], etiqueta: [] };
  const st = String(o.status || '').toUpperCase();
  if (!st) return { veredito: 'nao_sei', via: 'tiktok_sem_status', sinais: [], etiqueta: [] };
  /* Codex #763: cada campo é conferido por si (um display_status "CANCELLED" não pode esconder um package_status "SHIPPED").
     26/11 — CALIBRADO COM O CASO REAL (pedido da Girassol que o dono confirmou: "nem foi postado"). O TikTok respondeu
     CANCELLED com `rts_time` e `tracking_number` preenchidos e SEM `collection_time`: o pedido foi cancelado pelo comprador
     74 segundos depois de ficar "pronto pra envio". `rts_time` e o rastreio nascem quando a ETIQUETA é gerada (a integração
     arruma o envio assim que a nota sai) — não quando o pacote sai do galpão. Com a regra antiga ("na dúvida é sinal"),
     esse pedido caía em "cancelado depois de postado" e a lista nunca mostraria o caso pra que ela existe.
     SINAL DE ENVIO (tira da lista, é do Devoluções): a transportadora COLETOU (`collection_time`), ENTREGOU
     (`delivery_time`) ou algum item está em trânsito/entregue/coletado/enviado.
     ETIQUETA GERADA (não é envio): `rts_time` e rastreio, do pedido ou do item — vão anotados em `etiqueta`, pra quem lê.
     A outra ponta continua sendo de quem chama: na fila do galpão e NUNCA conferido pelo checkout. */
  const sinais = [], etiqueta = [];
  if (o.collection_time) sinais.push('coletado');
  if (o.delivery_time) sinais.push('entregue');
  if (o.rts_time) etiqueta.push('pronto_pra_envio');
  if (o.tracking_number) etiqueta.push('rastreio');
  for (const li of (Array.isArray(o.line_items) ? o.line_items : [])) {
    if (!li) continue;
    for (const campo of ['display_status', 'package_status']) {
      const ds = String(li[campo] || '').toUpperCase();
      if (SINAIS_ITEM.test(ds)) sinais.push('item_' + campo + '_' + ds.toLowerCase());
    }
    if (li.tracking_number) etiqueta.push('item_rastreio');
    if (li.rts_time) etiqueta.push('item_pronto_pra_envio');
  }
  if (st !== 'CANCELLED') return { veredito: 'ativo', via: 'tiktok_status_' + st.toLowerCase(), sinais, etiqueta };
  if (sinais.length) return { veredito: 'cancelado_depois_de_postado', via: 'tiktok_cancelado_com_sinal_de_envio', sinais, etiqueta };
  return { veredito: 'cancelado_antes_postagem', via: etiqueta.length ? 'tiktok_cancelado_com_etiqueta_gerada_sem_coleta' : 'tiktok_cancelado_sem_sinal_de_envio', sinais, etiqueta };
}

/* ── MERCADO LIVRE (26/11) — a mesma regra, lida do pedido (/orders/{id}) e do envio dele (/shipments/{id}).
   SINAL DE ENVIO (é do Devoluções): o envio está/esteve "shipped", "delivered" ou "not_delivered", ou o histórico dele tem
   data de envio, entrega, não-entrega ou retorno. ETIQUETA (não é envio): "ready_to_ship", data de pronto pra envio, rastreio.
   Pedido cancelado que TEM envio mas o envio não pôde ser lido → "nao_sei" (sem ver o envio não dá pra dizer "não postado").
   ⚠️ Ainda NÃO calibrado com caso real — por isso esta leitura só existe na sonda (só leitura), com os campos crus junto. */
const ML_ENVIADO = /^(shipped|delivered|not_delivered)$/;
const ML_DATAS_ENVIO = ['date_shipped', 'date_delivered', 'date_not_delivered', 'date_returned', 'date_first_visit'];
function classificarML(pedido, envio, envioFalhou) {
  if (!pedido || typeof pedido !== 'object') return { veredito: 'nao_sei', via: 'ml_sem_o_pedido', sinais: [], etiqueta: [] };
  const st = String(pedido.status || '').toLowerCase();
  if (!st) return { veredito: 'nao_sei', via: 'ml_sem_status', sinais: [], etiqueta: [] };
  if (st !== 'cancelled') return { veredito: 'ativo', via: 'ml_status_' + st, sinais: [], etiqueta: [] };
  const temEnvio = !!(pedido.shipping && pedido.shipping.id);
  if (!temEnvio) return { veredito: 'cancelado_antes_postagem', via: 'ml_cancelado_sem_envio_criado', sinais: [], etiqueta: [] };
  if (!envio || typeof envio !== 'object' || envioFalhou) return { veredito: 'nao_sei', via: 'ml_cancelado_sem_ler_o_envio', sinais: [], etiqueta: [] };
  const sinais = [], etiqueta = [];
  const se = String(envio.status || '').toLowerCase();
  if (!se) return { veredito: 'nao_sei', via: 'ml_envio_sem_status', sinais, etiqueta };
  if (ML_ENVIADO.test(se)) sinais.push('envio_' + se);
  const hist = envio.status_history && typeof envio.status_history === 'object' ? envio.status_history : {};
  for (const d of ML_DATAS_ENVIO) if (hist[d]) sinais.push(d);
  if (se === 'ready_to_ship') etiqueta.push('pronto_pra_envio');
  if (hist.date_ready_to_ship) etiqueta.push('data_pronto_pra_envio');
  if (envio.tracking_number) etiqueta.push('rastreio');
  if (sinais.length) return { veredito: 'cancelado_depois_de_postado', via: 'ml_cancelado_com_sinal_de_envio', sinais, etiqueta };
  return { veredito: 'cancelado_antes_postagem', via: etiqueta.length ? 'ml_cancelado_com_etiqueta_gerada_sem_envio' : 'ml_cancelado_sem_sinal_de_envio', sinais, etiqueta };
}

function _horasDesde(iso) {
  const t = Date.parse(String(iso || '').replace(' ', 'T'));
  return isFinite(t) ? Math.round((Date.now() - t) / 36e5 * 10) / 10 : null;
}

/* 26/11: as duas leituras (a fila do galpão não despachada e a consulta ao TikTok) saíram de dentro da rota pra servir
   também a quem TRATA o cancelado (lib/checkout/rota-cancelados-tratar) — a mesma regra, lida do mesmo jeito.
   leitura({ manifest(), lerConferidos(), tiktokConta, tiktokOAuth? }) → { filaTikTok(), consultarTikTok(ids) } */
function leitura(c) {
  /* a fila do galpão que o checkout ainda NÃO despachou, só TikTok, com o número do pedido no TikTok */
  function filaTikTok() { return filaDe('tiktok'); }
  function filaML() { return filaDe('ml'); }
  function filaDe(mkt) {
    const man = c.manifest() || {};
    const conf = c.lerConferidos() || {};
    const fila = [];
    let conferidos = 0;
    for (const id of Object.keys(man)) {
      const m = man[id] || {};
      if (String(m.marketplace || '').toLowerCase() !== mkt) continue;
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

  /* ML: um pedido por chamada (e o envio, só de quem está cancelado). `teto` protege a cota: o que passar dele fica de fora
     e é dito. Devolve { porId: { <nº da venda>: { pedido, envio, envioFalhou } }, erro?, fora_do_teto } */
  async function consultarML(ids, teto) {
    if (typeof c.garantirTokenML !== 'function') return { erro: 'esta empresa não passa o token do Mercado Livre pra sonda', porId: {}, fora_do_teto: 0 };
    let token = null;
    try { token = await c.garantirTokenML(); } catch (e) { token = null; }
    if (!token) return { erro: 'sem token do Mercado Livre', porId: {}, fora_do_teto: 0 };
    const busca = c.fetch || require('node-fetch');
    const ler = async (caminho, extra) => {
      const r = await busca('https://api.mercadolibre.com' + caminho, { headers: Object.assign({ Authorization: 'Bearer ' + token }, extra || {}), timeout: 15000 });
      if (!r || !r.ok) return { falhou: (r && r.status) || 0 };
      const d = await r.json();
      return d && typeof d === 'object' ? { d } : { falhou: 0 };
    };
    const porId = {};
    const lote = ids.slice(0, teto);
    const PARA = (st) => st === 429 || st === 401 || st === 403;
    let parou = null;   /* limite ou autorização, em QUALQUER chamada (pedido, pack ou envio): não adianta seguir batendo */
    const lerSeguro = async (caminho, extra) => { try { return await ler(caminho, extra); } catch (e) { return { falhou: 0 }; } };
    /* um pedido já lido: o envio só de quem está cancelado e tem envio */
    async function parteDe(d) {
      const reg = { pedido: d, envio: null, envioFalhou: false };
      if (String(d.status || '').toLowerCase() === 'cancelled' && d.shipping && d.shipping.id) {
        const env = await lerSeguro('/shipments/' + encodeURIComponent(d.shipping.id), { 'x-format-new': 'true' });
        if (env.d) reg.envio = env.d; else { reg.envioFalhou = true; if (PARA(env.falhou)) parou = env.falhou; }
      }
      return reg;
    }
    for (const id of lote) {
      const ped = await lerSeguro('/orders/' + encodeURIComponent(id));
      if (PARA(ped.falhou)) { parou = ped.falhou; break; }
      if (ped.d) { porId[id] = await parteDe(ped.d); if (parou) break; continue; }
      /* 404 = o número guardado no Bling pode ser o PACK (carrinho): abre o pack e lê as vendas dele (como lib/ml-pesca.js) */
      if (ped.falhou !== 404) { porId[id] = { pedido: null, http: ped.falhou }; continue; }
      const pk = await lerSeguro('/packs/' + encodeURIComponent(id));
      if (PARA(pk.falhou)) { parou = pk.falhou; break; }
      const ordens = pk.d && Array.isArray(pk.d.orders) ? pk.d.orders.map((o) => (o && o.id != null ? o.id : o)).filter((x) => x != null && x !== '') : [];
      if (!ordens.length) { porId[id] = { pedido: null, http: 404 }; continue; }
      const partes = [];
      for (const oid of ordens) {
        const po = await lerSeguro('/orders/' + encodeURIComponent(oid));
        if (PARA(po.falhou)) { parou = po.falhou; break; }
        partes.push(po.d ? await parteDe(po.d) : { pedido: null, http: po.falhou });
        if (parou) break;
      }
      /* pack incompleto (parou no meio) não vira veredito: fica sem registro = "não sei" */
      if (parou) break;
      porId[id] = { pack: String(id), partes };
    }
    if (parou) return { erro: 'o Mercado Livre respondeu ' + parou, porId, fora_do_teto: ids.length - lote.length };
    return { porId, fora_do_teto: ids.length - lote.length };
  }
  return { filaTikTok, consultarTikTok, filaML, consultarML };
}

function criar(ctx) {
  const c = ctx || {};
  for (const k of ['prefixo', 'empresa', 'tiktokConta', 'json', 'validarSessao', 'ehAdmin']) {
    if (!c[k]) throw new Error('rotas-cancelados-mkt: falta ' + k);
  }
  if (typeof c.manifest !== 'function' || typeof c.lerConferidos !== 'function') throw new Error('rotas-cancelados-mkt: falta manifest/lerConferidos');
  const ROTA = c.prefixo + '/cancelados-antes-postagem';
  const { filaTikTok, consultarTikTok, filaML, consultarML } = leitura(c);

  function admOk(req, urlObj) {
    const k = lerChaveAdmin(req, urlObj);
    if (process.env.ADMIN_KEY && k === process.env.ADMIN_KEY) return true;
    const s = c.validarSessao(req.headers && req.headers['cookie']);
    return !!(s && c.ehAdmin(s));
  }


  /* ?mkt=ml — a sonda do Mercado Livre: só leitura, sem nome de cliente, com os campos crus pra calibrar */
  const TETO_ML = 150;
  const ENVIO_CAMPOS = ['status', 'substatus', 'logistic_type', 'mode', 'date_created', 'last_updated'];
  async function sondaML(res) {
    const { fila, conferidos } = filaML();
    const comNumero = fila.filter((p) => p.numero_loja);
    const ml = comNumero.length ? await consultarML(comNumero.map((p) => p.numero_loja), TETO_ML) : { porId: {}, fora_do_teto: 0 };
    const contagem = { cancelado_antes_postagem: 0, cancelado_depois_de_postado: 0, ativo: 0, nao_sei: 0 };
    const pedidos = [];
    for (const p of fila) {
      const reg = p.numero_loja ? ml.porId[p.numero_loja] : null;
      const v = !p.numero_loja ? { veredito: 'nao_sei', via: 'pedido_sem_numero_no_ml', sinais: [], etiqueta: [] }
        : (!reg ? { veredito: 'nao_sei', via: ml.erro ? 'ml_falhou' : 'ml_nao_consultado_(teto)', sinais: [], etiqueta: [] } : vereditoDoRegistro(reg));
      contagem[v.veredito]++;
      if (v.veredito === 'ativo') continue;
      /* pack: mostra a venda que decidiu o veredito */
      const parte = reg && reg.pack ? (reg.partes.find((x) => !x.pedido) || reg.partes.find((x) => String(x.pedido.status || '').toLowerCase() === 'cancelled') || reg.partes[0]) : reg;
      const o = parte && parte.pedido, e = parte && parte.envio;
      const cd = o && o.cancel_detail && typeof o.cancel_detail === 'object' ? o.cancel_detail : null;
      const envio = {};
      if (e) { for (const k of ENVIO_CAMPOS) if (e[k] != null && e[k] !== '') envio[k] = e[k]; envio.tem_rastreio = !!e.tracking_number; envio.status_history = e.status_history && typeof e.status_history === 'object' ? e.status_history : null; }
      pedidos.push({ id: p.id, numero: p.numero, numero_loja: p.numero_loja, nf_numero: p.nf_numero, nf_emissao: p.nf_emissao, tem_etiqueta: p.tem_etiqueta,
        horas_desde_nf: _horasDesde(p.nf_emissao), veredito: v.veredito, via: v.via, sinais: v.sinais, etiqueta: v.etiqueta,
        pedido: o ? { status: o.status || null, status_detail: o.status_detail || null, tags: Array.isArray(o.tags) ? o.tags.slice(0, 20) : null, date_created: o.date_created || null, date_closed: o.date_closed || null,
          pack_id: o.pack_id || (reg && reg.pack) || null, tem_envio: !!(o.shipping && o.shipping.id),
          cancel_detail: cd ? { group: cd.group || null, code: cd.code || null, description: cd.description || null, requested_by: cd.requested_by || null, date: cd.date || null } : null } : null,
        envio: e ? envio : null });
    }
    c.json(res, 200, { ok: !ml.erro, empresa: c.empresa, so_leitura: true,
      regra: 'só pedido NÃO POSTADO: na fila do galpão sem conferência E cancelado no marketplace sem sinal de envio; o resto é do Devoluções ou "não sei"',
      ml: { na_fila: fila.length, ja_conferidos_ignorados: conferidos, consultados: Math.min(comNumero.length, TETO_ML), fora_do_teto: ml.fora_do_teto || 0, erro: ml.erro || null, contagem, pedidos },
      aviso: 'leitura do Mercado Livre ainda não calibrada com caso real — nenhuma ação usa este veredito' });
    return true;
  }

  return async function rotasCanceladosMkt(req, res, urlObj, method) {
    if (method !== 'GET' || urlObj.pathname !== ROTA) return false;
    if (!admOk(req, urlObj)) { c.json(res, 404, { error: 'not found' }); return true; }
    if (String((urlObj.searchParams && urlObj.searchParams.get('mkt')) || '').toLowerCase() === 'ml') return sondaML(res);
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
        horas_desde_nf: _horasDesde(p.nf_emissao), veredito: v.veredito, via: v.via, sinais: v.sinais, etiqueta: v.etiqueta || [], campos,
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

/* o veredito de um registro da consulta: pedido avulso, ou PACK — o pack só é "não postado" se TODAS as vendas dele forem;
   qualquer "não sei" derruba tudo pra "não sei"; venda ativa no pack = ativo (o carrinho ainda tem o que despachar) */
function vereditoDoRegistro(reg) {
  if (!reg.pack) return !reg.pedido ? { veredito: 'nao_sei', via: 'ml_nao_devolveu_o_pedido_(http_' + (reg.http || 0) + ')', sinais: [], etiqueta: [] } : classificarML(reg.pedido, reg.envio, reg.envioFalhou);
  const vs = reg.partes.map((p) => (!p.pedido ? { veredito: 'nao_sei', via: 'ml_pack_venda_sem_resposta_(http_' + (p.http || 0) + ')', sinais: [], etiqueta: [] } : classificarML(p.pedido, p.envio, p.envioFalhou)));
  const pega = (ver) => vs.find((x) => x.veredito === ver);
  const sinais = [].concat(...vs.map((x) => x.sinais)), etiqueta = [].concat(...vs.map((x) => x.etiqueta));
  const ref = pega('nao_sei') || pega('ativo') || pega('cancelado_depois_de_postado') || vs[0];
  return { veredito: ref.veredito, via: 'ml_pack_' + vs.length + '_vendas_' + ref.via, sinais, etiqueta };
}

module.exports = { criar, vereditoDoRegistro, classificarTikTok, classificarML, leitura };
