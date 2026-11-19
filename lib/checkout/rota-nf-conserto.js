'use strict';
/* ─────────────────────────────────────────────────────────────────────────────
   O ENSAIO DO CONSERTO DA NF RECUSADA PELO ML POR ENDEREÇO — rota (18/11/2026), nas três empresas.

   GET <prefixo>/nf-conserto-ensaio?nf=<id da nota no Bling>[&pedido=<nº da venda no ML>]

   SÓ LÊ: a nota no Bling e o envio da venda no ML. Não cria, não altera, não cancela, não devolve nada — é a prova, com um
   caso real, de que os dados dos dois lados são os que o conserto automático supõe (lib/fiscal/nf-conserto-endereco, onde
   está o porquê). A resposta não leva dado de gente: por campo do endereço, só se a nota e a venda dizem o mesmo.

   · trava: chave OU sessão de admin; sem as duas, 404 (rota de admin não confirma que existe);
   · cada leitura que falha diz QUAL (`etapa`) e o que voltou — "não consegui ler" nunca vira "não precisa consertar".
   ───────────────────────────────────────────────────────────────────────────── */
const path = require('path');
const _RAIZ = path.join(__dirname, '..', '..');

function caminhoDe(prefixo) { return prefixo + '/nf-conserto-ensaio'; }
function atende(prefixo, method, p) { return method === 'GET' && p === caminhoDe(prefixo); }

function criar(o) {
  if (!o || !o.empresa) throw new Error('lib/checkout/rota-nf-conserto: falta empresa');
  for (const k of ['json', 'lerChaveAdmin', 'validarSessao', 'ehAdmin', 'blingGet']) {
    if (typeof o[k] !== 'function') throw new Error('lib/checkout/rota-nf-conserto (' + o.empresa + '): falta ' + k);
  }
  const cfg = require('./config-empresa').configCheckout(o.empresa);   /* empresa fora do contrato derruba no boot */
  const prefixo = o.prefixo != null ? o.prefixo : require('./config-empresa').prefixoDe(o.empresa);
  const { empresa, json, lerChaveAdmin, validarSessao, ehAdmin, blingGet } = o;
  const tokenML = o.tokenML || (async () => require(path.join(_RAIZ, cfg.mlTokenManager)).garantirTokenML());   /* o token do ML DA EMPRESA, do contrato */
  const buscar = o.fetch || require('node-fetch');
  const C = require('../fiscal/nf-conserto-endereco');
  const prazoMs = Number.isFinite(Number(o.prazoMs)) ? Number(o.prazoMs) : 15000;

  /* leitura do ML com prazo: { status, data } — status 0 = não respondeu (rede, prazo) */
  async function mlGet(token, caminho) {
    const ac = new AbortController(); const tm = setTimeout(() => ac.abort(), prazoMs);
    try {
      const r = await buscar('https://api.mercadolibre.com' + caminho, { headers: { Authorization: 'Bearer ' + token, 'x-format-new': 'true' }, signal: ac.signal });
      let data = null; try { data = await r.json(); } catch (e) { data = null; }
      return { status: r.status, data };
    } catch (e) { return { status: 0, data: null, erro: String((e && e.message) || e).slice(0, 120) }; }
    finally { clearTimeout(tm); }
  }

  return async function rotaNfConsertoEnsaio(req, res, urlObj, method, p) {
    if (!atende(prefixo, method, p)) return false;
    const k = lerChaveAdmin(req, urlObj);
    const sess = validarSessao(req.headers['cookie']);
    if (!((process.env.ADMIN_KEY && k === process.env.ADMIN_KEY) || (sess && ehAdmin(sess)))) { json(res, 404, { error: 'not found' }); return true; }
    const base = { empresa, ensaio: true, escreveu_algo: false };
    const nfId = String((urlObj.searchParams && urlObj.searchParams.get('nf')) || '').trim();
    if (!/^\d{1,20}$/.test(nfId)) { json(res, 400, Object.assign({ ok: false, erro: 'use ?nf=<id da nota no Bling> (só dígitos) — é o número que aparece no endereço da página quando você abre a nota no Bling; opcional: &pedido=<nº da venda no ML>' }, base)); return true; }
    const pedParam = String((urlObj.searchParams && urlObj.searchParams.get('pedido')) || '').trim();
    if (pedParam && !/^\d{1,25}$/.test(pedParam)) { json(res, 400, Object.assign({ ok: false, erro: 'pedido: só dígitos (o nº da venda no ML)' }, base)); return true; }
    const falha = (etapa, erro, mais) => { json(res, 200, Object.assign({ ok: false, etapa, erro }, mais || {}, base)); return true; };
    try {
      /* 1) a nota, no Bling */
      const rN = await blingGet('/nfe/' + nfId);
      const nf = rN && rN.ok && rN.data && rN.data.data;
      if (!nf || typeof nf !== 'object') return falha('nota_no_bling', 'não consegui ler a nota ' + nfId + ' no Bling', { status: (rN && rN.status) || null });
      const pedidoML = pedParam || String(nf.numeroPedidoLoja || '').trim();
      if (!/^\d{1,25}$/.test(pedidoML)) return falha('pedido_do_ml', 'a nota não diz de qual venda do ML é (numeroPedidoLoja) — passe &pedido=<nº da venda no ML>');
      /* 2) o token do ML da empresa */
      let tok = null;
      try { tok = await tokenML(); } catch (e) { return falha('token_do_ml', 'sem token do ML: ' + String((e && e.message) || e).slice(0, 120)); }
      if (!tok) return falha('token_do_ml', 'sem token do ML');
      /* 3) o envio da venda: pela venda; se o número for de carrinho, pelo carrinho */
      let envioId = null, via = null;
      const rO = await mlGet(tok, '/orders/' + pedidoML);
      if (rO.status === 200 && rO.data && rO.data.shipping && rO.data.shipping.id) { envioId = rO.data.shipping.id; via = 'venda'; }
      else {
        const rP = await mlGet(tok, '/packs/' + pedidoML);
        if (rP.status === 200 && rP.data && rP.data.shipment && rP.data.shipment.id) { envioId = rP.data.shipment.id; via = 'carrinho'; }
        else return falha('envio_da_venda', 'não achei o envio da venda ' + pedidoML + ' no ML', { status_venda: rO.status, status_carrinho: rP.status });
      }
      /* 4) o envio, com o endereço de entrega */
      const rE = await mlGet(tok, '/shipments/' + envioId);
      if (rE.status !== 200 || !rE.data || typeof rE.data !== 'object') return falha('envio_no_ml', 'o ML não devolveu o envio da venda', { status: rE.status });
      const plano = C.semDadoDeGente(C.planejar(nf, rE.data, Date.now()));
      json(res, 200, Object.assign({}, plano, { nf: { id: nfId, numero: nf.numero || null }, pedido_ml: pedidoML, envio_achado_por: via,
        envio: { status: rE.data.status || null, substatus: rE.data.substatus || null, campos: Object.keys(rE.data).sort() },
        leia: 'ENSAIO: nada foi criado, alterado, cancelado nem devolvido. `campos` diz, por campo do endereço, se a nota e a venda no ML dizem o mesmo; `nota_errada` é o que seria feito com a nota recusada (cancelar até 24 h da emissão; depois, devolução); `pronta` = o conserto teria tudo o que precisa. `etiqueta` é a mesma comparação com o endereço de ENTREGA da nota; `forma` mostra quais campos a nota traz preenchidos (sem o valor); `tam_*` e `um_contem_o_outro` dizem se a diferença é de formato; `fica_de_fora_na_criacao` é o que a API do Bling só devolve na leitura.' }, base));
      return true;
    } catch (e) { return falha('erro', String((e && e.message) || e).slice(0, 160)); }
  };
}

module.exports = { criar, atende, caminhoDe };
