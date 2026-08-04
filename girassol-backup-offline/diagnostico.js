'use strict';
// ════════════════════════════════════════════════════════════════════════
//  GIRASSOL · BACKUP OFFLINE — MÓDULO DE DIAGNÓSTICO  (extraído do index.js em 03/08/2026)
// ════════════════════════════════════════════════════════════════════════
//  Aqui moram TODAS as rotas de raio-X, sonda e manutenção do módulo:
//  debug-*, sonda-*, diag-*, /backup e /restaurar.
//
//  Por que existe: o index.js passou de 5.200 linhas e virou um risco pra
//  qualquer edição. Estas rotas são as mais isoladas do arquivo — não tocam
//  em NENHUM estado do index (nada de _bf, _mlb, _varre, _vsy…), só leem
//  disco/Bling/ML/Supabase e respondem JSON. Por isso foram as primeiras.
//
//  Contrato: o index chama rotasDiagnostico(ctx) UMA vez e recebe um
//  handler; o handler devolve true se tratou a rota, false se não é dele.
//  A delegação fica no FIM do handle() do index, logo antes do return false,
//  então a ordem de casamento das rotas continua idêntica à de antes.
//
//  ctx = { VERSAO, validarSessao, supaCfg, readBody }  ← só isso.
// ════════════════════════════════════════════════════════════════════════

const fs = require('fs');
const path = require('path');
const fetch = require('node-fetch');
const AdmZip = require('adm-zip');
const https = require('https');

const base = require('./base');
const { CACHE_DIR, SIT_VERIFICADO, PAUSA_MS, ETIQ_FORMATO, CONFERIDOS_FILE, LOC_FILE, LOC_LOG_FILE, EAN_INDEX_FILE, LOJA_MKT,
  sleep, readJson, writeJson, json, html, manifest, salvarManifest, locCache, ehAdmin, blingGet, moverSituacao } = base;
const { acharNFporRange, nfDoPedido, dadosNFSimp } = require('./nf');
const { servicoDoPedido, ehFlex } = require('./comum');
const { localizacaoDeProduto, produtoDetalhe } = require('./produtos');
const { detalhePedido } = require('./ciclo');
const { gerarDanfeSimplificado } = require('./danfe-simplificado');

function rotasDiagnostico(ctx) {
  const { VERSAO, validarSessao, supaCfg, readBody } = ctx;

  return async function handleDiag(req, res, urlObj) {
    const { method } = req;
    const p = urlObj.pathname;

    // 🔬 DIAGNÓSTICO DO CUSTO — separa as duas perguntas que a gente não consegue responder de fora:
    //   (a) o NOSSO banco (_custos.json) tem esse SKU, e com que valor?
    //   (b) as linhas do HISTÓRICO desse SKU estão com custo nulo, e o fallback pega?
    // Uso: /girassol-backup-offline/debug-custo?sku=90-lisa-125mm-KIT62&k=SUA_CHAVE
    if (method === 'GET' && p === '/girassol-backup-offline/debug-custo') {
      const kD = (urlObj.searchParams && urlObj.searchParams.get('k')) || '';
      const sD = validarSessao(req.headers['cookie']);
      if (!((process.env.ADMIN_KEY && kD === process.env.ADMIN_KEY) || (sD && ehAdmin(sD)))) { json(res, 404, { error: 'not found' }); return true; }
      const skuD = String((urlObj.searchParams && urlObj.searchParams.get('sku')) || '').trim();
      if (!skuD) { json(res, 200, { ok: false, erro: 'passe ?sku=CODIGO' }); return true; }

      const F = path.join(CACHE_DIR, '_custos.json');
      let banco = {}; let erroLer = null;
      try { banco = readJson(F, {}); } catch (e) { erroLer = String(e.message || e); }
      const chaves = Object.keys(banco);
      // procura tolerante: exato, e depois ignorando caixa/espaços — pra flagrar diferença de grafia
      const norm = t => String(t || '').trim().toLowerCase();
      const exato = banco[skuD] || null;
      const parecidas = chaves.filter(k => norm(k) === norm(skuD) && k !== skuD);

      // e o que o histórico tem desse SKU
      let linhas = 0, comCusto = 0, semCusto = 0, unidades = 0, amostra = [];
      try {
        const { url: uD, key: kkD } = supaCfg('girassol');
        if (uD && kkD) {
          const r = await fetch(uD.replace(/\/+$/, '') + '/rest/v1/vendas_historico?empresa=eq.girassol&sku=eq.' +
                    encodeURIComponent(skuD) + '&select=sku,quantidade,custo,data_venda&limit=200',
                    { headers: { apikey: kkD, Authorization: 'Bearer ' + kkD } });
          const ln = r.ok ? await r.json().catch(() => []) : [];
          for (const l of (Array.isArray(ln) ? ln : [])) {
            linhas++; unidades += Number(l.quantidade) || 0;
            if (l.custo == null) semCusto++; else comCusto++;
            if (amostra.length < 3) amostra.push({ data: l.data_venda, qtd: l.quantidade, custo: l.custo, sku_cru: l.sku });
          }
        }
      } catch (e) {}

      json(res, 200, {
        ok: true, sku: skuD,
        banco: {
          arquivo: F, existe: !erroLer, erro_ler: erroLer, total_skus: chaves.length,
          tem_esse_sku: !!exato,
          entrada: exato,
          chaves_parecidas_com_grafia_diferente: parecidas.slice(0, 5),
          exemplos_de_chaves: chaves.slice(0, 5)
        },
        historico: { linhas, unidades, linhas_com_custo: comCusto, linhas_sem_custo: semCusto, amostra },
        veredito: exato && exato.custo != null
          ? 'o banco TEM o custo — se o card ainda diz "sem custo", o problema é na leitura/cache do dashboard'
          : (exato ? 'o SKU está no banco mas com custo NULO — o custo-sync não conseguiu resolver'
                   : 'o SKU NÃO está no banco — ele não entrou na fila do custo-sync')
      });
      return true;
    }

    // 02/08 — CA\u00c7ADOR DE VENDAS FALTANDO. O faturamento do ML traz o n\u00famero da venda em 100%
    // das comiss\u00f5es \u2014 ou seja, temos a lista COMPLETA das vendas do ML, vinda do pr\u00f3prio ML.
    // Aqui cruzamos com o nosso hist\u00f3rico e listamos o que existe l\u00e1 e n\u00e3o existe aqui.
    // 02/08 - POR QUE ESTA VENDA NAO ESTA NO NOSSO HISTORICO?
    // Diego conferiu 3 das faltantes e as TRES existem no Bling, com NF emitida. Ou seja, o furo
    // e nosso, nao da integracao ML->Bling. Esta rota pergunta ao Bling de varios jeitos e diz
    // exatamente onde a venda esta (ou nao esta), em vez de eu deduzir.
    if (method === 'GET' && p === '/girassol-backup-offline/diag-venda-ml') {
      const kD = (urlObj.searchParams && urlObj.searchParams.get('k')) || '';
      const sD = validarSessao(req.headers['cookie']);
      if (!((process.env.ADMIN_KEY && kD === process.env.ADMIN_KEY) || (sD && ehAdmin(sD)))) { json(res, 404, { error: 'not found' }); return true; }
      const vend = String(urlObj.searchParams.get('venda') || '').trim();
      const pack = String(urlObj.searchParams.get('pack') || '').trim();
      const dia  = String(urlObj.searchParams.get('data') || '').slice(0, 10);
      if (!vend) { json(res, 400, { ok: false, erro: 'informe ?venda=2000016971863870 (opcional &pack= e &data=AAAA-MM-DD)' }); return true; }
      const out = { ok: true, venda: vend, pack: pack || null, data_informada: dia || null, tentativas: [], no_supabase: null, achado_no_bling: null };

      // 1) o Bling aceita filtrar por numero da loja? testamos as variantes e guardamos o CRU
      const queries = ['?numeroLoja=' + encodeURIComponent(vend), '?numeroPedidoLoja=' + encodeURIComponent(vend)];
      if (pack) queries.push('?numeroLoja=' + encodeURIComponent(pack));
      for (const q of queries) {
        try {
          const r = await blingGet('/pedidos/vendas' + q + '&limite=5');
          const arr = (r && r.ok && r.data && r.data.data) || [];
          // 02/08 - CONFERIR se o que voltou e MESMO o que pedimos. O Bling IGNORA parametro que
          // nao conhece e devolve a lista padrao: as 3 consultas voltaram com os mesmos 5 pedidos
          // recentes. Pegar arr[0] as cegas dava falso positivo e, pior, pulava a varredura do dia.
          const casou = arr.filter(x => { const nl = String(x.numeroLoja || ''); return nl === vend || (pack && nl === pack); });
          out.tentativas.push({ query: q, status: r && r.status, quantos: arr.length,
            filtro_funcionou: casou.length > 0 ? 'SIM' : 'NAO - o Bling ignorou o parametro e devolveu a lista padrao',
            casou: casou.length,
            amostra: arr.slice(0, 3).map(x => ({ id: x.id, numero: x.numero, numeroLoja: x.numeroLoja, data: x.data, situacao: x.situacao && x.situacao.id })) });
          if (casou.length && !out.achado_no_bling) out.achado_no_bling = { via: q, pedido: casou[0] };
        } catch (e) { out.tentativas.push({ query: q, erro: String(e.message || e).slice(0, 140) }); }
        await new Promise(r2 => setTimeout(r2, 400));
      }

      // 2) se veio a data, varre aquele DIA e procura pelo numero - e como o backfill enxerga
      if (dia && !out.achado_no_bling) {
        const achados = [];
        for (let pg = 1; pg <= 8; pg++) {
          const r = await blingGet('/pedidos/vendas?dataInicial=' + dia + '&dataFinal=' + dia + '&pagina=' + pg + '&limite=100');
          const arr = (r && r.ok && r.data && r.data.data) || [];
          if (!arr.length) break;
          for (const x of arr) {
            const nl = String(x.numeroLoja || '');
            if (nl === vend || (pack && nl === pack)) achados.push({ id: x.id, numero: x.numero, numeroLoja: nl, data: x.data, situacao: x.situacao && x.situacao.id });
          }
          if (arr.length < 100) break;
          await new Promise(r2 => setTimeout(r2, 350));
        }
        out.varredura_do_dia = { dia, encontrados: achados.length, achados };
        if (achados.length) out.achado_no_bling = { via: 'varredura do dia ' + dia, pedido: achados[0] };
      }

      // 3) e esta no nosso historico?
      try {
        const cfgD = supaCfg('girassol');
        if (cfgD.url && cfgD.key) {
          const alvo = [vend].concat(pack ? [pack] : []).map(x => '"' + x + '"').join(',');
          const rq = await fetch(cfgD.url.replace(/\/+$/, '') + '/rest/v1/vendas_historico?empresa=eq.girassol&numero_loja=in.(' + encodeURIComponent(alvo) + ')&select=numero_pedido,numero_loja,data_venda,sku,valor_nota,canal',
            { headers: { apikey: cfgD.key, Authorization: 'Bearer ' + cfgD.key } });
          const ln = rq.ok ? await rq.json().catch(() => []) : [];
          out.no_supabase = { quantos: Array.isArray(ln) ? ln.length : 0, linhas: (ln || []).slice(0, 6) };
        }
      } catch (e) { out.erro_supabase = String(e.message || e).slice(0, 140); }

      out.veredito = out.achado_no_bling
        ? ((out.no_supabase && out.no_supabase.quantos) ? 'existe nos DOIS - o problema e so de casamento de numero'
                                                        : 'existe no BLING e NAO no nosso historico - o backfill deixou passar')
        : 'nao encontrei no Bling pelas buscas testadas - veja tentativas pra saber se o filtro funciona';
      json(res, 200, out); return true;
    }

    // 01/08 — RAIO-X DO CUSTO DE UM PEDIDO. Diego relatou que pedido com 2 peças parece contar
    // custo de 1. Auditei os 7 caminhos de cálculo e todos multiplicam por qtd — então o suspeito
    // é a QUANTIDADE que chega, não a conta. Esta rota mostra item a item o que o servidor tem.
    if (method === 'GET' && p === '/girassol-backup-offline/debug-custo-pedido') {
      const kQ = (urlObj.searchParams && urlObj.searchParams.get('k')) || '';
      const sQ = validarSessao(req.headers['cookie']);
      if (!((process.env.ADMIN_KEY && kQ === process.env.ADMIN_KEY) || (sQ && ehAdmin(sQ)))) { json(res, 404, { error: 'not found' }); return true; }
      const num = String((urlObj.searchParams && urlObj.searchParams.get('numero')) || '').trim();
      if (!num) { json(res, 400, { ok: false, erro: 'informe ?numero=117610' }); return true; }
      const cc = readJson(path.join(CACHE_DIR, '_custos.json'), {});
      const cUn = sk => { const c = cc[String(sk || '').trim()]; return (c && c.custo != null && isFinite(Number(c.custo))) ? Number(c.custo) : null; };
      const detalhar = (itens, ondeVeio) => {
        const linhas = (itens || []).map(it => {
          const q = Number(it.qtd != null ? it.qtd : (it.quantidade != null ? it.quantidade : 1)) || 1;
          const cu = cUn(it.sku);
          return { sku: it.sku || null, qtd_lida: q, campo_qtd_presente: (it.qtd != null ? 'qtd' : (it.quantidade != null ? 'quantidade' : 'NENHUM — assumiu 1')),
                   custo_unitario: cu, custo_da_linha: (cu != null ? Math.round(cu * q * 100) / 100 : null),
                   custo_que_veio_no_item: (it.custo != null ? Number(it.custo) : null),
                   valor_total: (it.valor_total != null ? Number(it.valor_total) : null) };
        });
        return { onde: ondeVeio, itens: linhas,
                 unidades: linhas.reduce((a, c) => a + c.qtd_lida, 0),
                 custo_total: Math.round(linhas.reduce((a, c) => a + (c.custo_da_linha || 0), 0) * 100) / 100 };
      };
      const out = { ok: true, numero: num, encontrado_em: [] };
      try {
        const conf = readJson(CONFERIDOS_FILE, {});
        for (const [id, c] of Object.entries(conf)) {
          if (String(c && c.numero) === num) { out.conferido = Object.assign({ id }, detalhar(c.itens, 'pedido BIPADO (_conferidos.json)')); out.encontrado_em.push('bipado'); }
        }
        const vd = readJson(path.join(CACHE_DIR, '_vendas_dia.json'), {});
        for (const [id, v] of Object.entries(vd)) {
          if (String(v && v.numero) === num) { out.venda_ao_vivo = Object.assign({ id }, detalhar(v.it, 'venda do cache ao vivo (_vendas_dia.json)')); out.encontrado_em.push('ao_vivo'); }
        }
      } catch (e) { out.erro_local = String(e.message || e); }
      try {
        const { url: uD, key: kD } = supaCfg('girassol');
        if (uD && kD) {
          const rq = await fetch(uD.replace(/\/+$/, '') + '/rest/v1/vendas_historico?empresa=eq.girassol&numero_pedido=eq.' + encodeURIComponent(num) +
            '&select=sku,quantidade,valor_produto,valor_nota,custo,imposto,comissao,frete_vendedor,margem,data_venda', { headers: { apikey: kD, Authorization: 'Bearer ' + kD } });
          const ln = rq.ok ? await rq.json().catch(() => []) : [];
          if (Array.isArray(ln) && ln.length) {
            out.historico = { onde: 'Supabase (usado no filtro M\u00eas/Ano)', linhas: ln.map(l => ({
              sku: l.sku, quantidade: Number(l.quantidade) || 0, custo_gravado: (l.custo == null ? null : Number(l.custo)),
              custo_unitario_no_banco: cUn(l.sku),
              confere: (l.custo != null && cUn(l.sku) != null) ? (Math.abs(Number(l.custo) - cUn(l.sku) * (Number(l.quantidade) || 1)) < 0.02 ? 'OK \u2014 custo = unit\u00e1rio \u00d7 qtd' : '\u26a0 N\u00c3O BATE') : 'sem custo p/ comparar',
              valor_produto: Number(l.valor_produto) || 0, imposto: Number(l.imposto) || 0, margem: (l.margem == null ? null : Number(l.margem)) })),
              unidades: ln.reduce((a, c) => a + (Number(c.quantidade) || 0), 0),
              custo_total: Math.round(ln.reduce((a, c) => a + (Number(c.custo) || 0), 0) * 100) / 100 };
            out.encontrado_em.push('historico');
          }
        }
      } catch (e) { out.erro_supabase = String(e.message || e); }
      if (!out.encontrado_em.length) out.veredito = 'pedido n\u00e3o encontrado em nenhuma fonte';
      else out.veredito = 'compare "custo_da_linha" (unit\u00e1rio \u00d7 qtd) com o que o painel mostra; e veja se "qtd_lida" bate com as pe\u00e7as reais do pedido';
      json(res, 200, out); return true;
    }

    // DIAGNÓSTICO de um pedido: mostra o que o servidor sabe (venda + conferido). Uso: ?numero=117238
    if (method === 'GET' && p === '/girassol-backup-offline/diag-pedido') {
      const kX = (urlObj.searchParams && urlObj.searchParams.get('k')) || '';
      const sessX = validarSessao(req.headers['cookie']);
      if (!((process.env.ADMIN_KEY && kX === process.env.ADMIN_KEY) || (sessX && ehAdmin(sessX)))) { json(res, 404, { error: 'not found' }); return true; }
      const numX = String((urlObj.searchParams && urlObj.searchParams.get('numero')) || '').trim();
      if (!numX) { json(res, 400, { ok: false, erro: 'passe &numero=' }); return true; }
      const vdX = readJson(path.join(CACHE_DIR, '_vendas_dia.json'), {});
      const confX = readJson(CONFERIDOS_FILE, {});
      const venda = Object.values(vdX).find(v => v && String(v.numero) === numX) || null;
      const confId = Object.keys(confX).find(k => confX[k] && String(confX[k].numero) === numX) || null;
      json(res, 200, { ok: true, numero: numX,
        na_lista_de_vendas: !!venda,
        venda: venda ? { id: venda.id, numero: venda.numero, situacao: venda.situacao, cancelado_mkt: venda.cancelado_mkt || 0, marketplace: venda.marketplace, numero_loja: venda.numero_loja, tem_itens: !!(venda.it && venda.it.length), det: venda.det || 0 } : null,
        esta_bipado: !!confId,
        conferido: confId ? { id: confId, numero: confX[confId].numero, cancelado: confX[confId].cancelado || 0, nf_numero: confX[confId].nf_numero } : null,
        veredito: (venda && (/cancel/i.test(String(venda.situacao || '')) || venda.cancelado_mkt)) ? 'CANCELADO (o dashboard deve pintar cinza)' : 'NAO cancelado segundo o servidor' });
      return true;
    }

    // SONDA (sessão OU ?k=): investiga um ID INTERNO de pedido do Bling (o que apareceu cru na Análise).
    // Uso: /girassol-backup-offline/sonda-bling-pedido?id=26341228931
    if (method === 'GET' && p === '/girassol-backup-offline/sonda-bling-pedido') {
      const kD = (urlObj.searchParams && urlObj.searchParams.get('k')) || '';
      const sessD = validarSessao(req.headers['cookie']);
      if (!((process.env.ADMIN_KEY && kD === process.env.ADMIN_KEY) || (sessD && ehAdmin(sessD)))) { json(res, 404, { error: 'not found' }); return true; }
      const idQ = String((urlObj.searchParams && urlObj.searchParams.get('id')) || '').replace(/\D/g, '');
      if (!idQ) { json(res, 200, { ok: false, erro: 'passe ?id=ID_INTERNO_DO_BLING' }); return true; }
      const out = { ok: true, id: idQ };
      try {
        const r = await blingGet('/pedidos/vendas/' + idQ);
        out.status = r && r.status;
        out.ok_resp = r && r.ok;
        const d = (r && r.data && r.data.data) ? r.data.data : (r && r.data) || null;
        if (d && (d.id || d.numero)) {
          out.resumo = {
            numero: d.numero, numeroLoja: d.numeroLoja, data: d.data,
            situacao: d.situacao || null, total: d.total,
            cliente: d.contato && (d.contato.nome || d.contato.id) || null,
            loja: d.loja && d.loja.id || null, itens: Array.isArray(d.itens) ? d.itens.length : null
          };
          out.cru = d;   // cru completo pra eu ver tudo
        } else { out.vazio = true; out.cru = d; }
      } catch (e) { out.erro = String(e.message || e); }
      json(res, 200, out);
      return true;
    }

    // SONDA (sessão admin OU ?k=): financeiro REAL de um pagamento no MERCADO PAGO — reembolso,
    // estornos, taxas. Usa MP_ACCESS_TOKEN_GIRASSOL (app do MP da Girassol). Temporária.
    // Uso: /girassol-backup-offline/sonda-mp?pid=PAYMENT_ID  (ou &nl=NUMERO_DA_VENDA pra achar o payment_id via ML)
    if (method === 'GET' && p === '/girassol-backup-offline/sonda-mp') {
      const kD = (urlObj.searchParams && urlObj.searchParams.get('k')) || '';
      const sessD = validarSessao(req.headers['cookie']);
      if (!((process.env.ADMIN_KEY && kD === process.env.ADMIN_KEY) || (sessD && ehAdmin(sessD)))) { json(res, 404, { error: 'not found' }); return true; }
      const mpTok = process.env.MP_ACCESS_TOKEN_GIRASSOL;
      const out = { ok: true };
      if (!mpTok) { out.ok = false; out.erro = 'falta MP_ACCESS_TOKEN_GIRASSOL no env do Render'; json(res, 200, out); return true; }
      out.mp_token_prefixo = String(mpTok).slice(0, 8);   // confirma o token certo (deve começar com APP_USR-) sem expor
      let pid = String((urlObj.searchParams && urlObj.searchParams.get('pid')) || '').replace(/\D/g, '');
      const nlQ = String((urlObj.searchParams && urlObj.searchParams.get('nl')) || '').replace(/\D/g, '');
      if (!pid && nlQ) {   // veio o nº da venda ML: busca o pedido pra achar o payment_id
        try {
          const { garantirTokenML: _g7 } = require('../girassol/mlTokenManager');
          const tkML = await _g7();
          const rr = await fetch('https://api.mercadolibre.com/orders/' + nlQ, { headers: { Authorization: 'Bearer ' + tkML } });
          const dd = await rr.json().catch(() => null);
          if (dd && Array.isArray(dd.payments) && dd.payments[0]) { pid = String(dd.payments[0].id).replace(/\D/g, ''); out.payment_id_do_pedido = pid; }
        } catch (e) { out.erro_ml = String(e.message || e); }
      }
      if (!pid) { out.ok = false; out.erro = 'passe ?pid=PAYMENT_ID ou &nl=NUMERO_DA_VENDA'; json(res, 200, out); return true; }
      out.payment_id = pid;
      const H = { headers: { Authorization: 'Bearer ' + mpTok } };
      try {
        const rp = await fetch('https://api.mercadopago.com/v1/payments/' + pid, H);
        out.pagamento_status = rp.status;
        out.pagamento = await rp.json().catch(() => null);   // CRU: transaction_amount, transaction_amount_refunded, status, fee_details, charges_details, taxes_amount...
      } catch (e) { out.erro_pag = String(e.message || e); }
      try {
        const rf = await fetch('https://api.mercadopago.com/v1/payments/' + pid + '/refunds', H);
        out.refunds_status = rf.status;
        out.refunds = await rf.json().catch(() => null);   // lista de estornos (reembolsos ao comprador)
      } catch (e) { out.erro_ref = String(e.message || e); }
      json(res, 200, out);
      return true;
    }

    // SONDA (sessão admin): mapeia a estrutura REAL de devoluções/claims do ML antes de integrar
    // o prejuízo. Roda /claims/search (claims do seller) e, pros primeiros, busca returns +
    // return-cost (frete de retorno). É temporária — sai depois que a integração estiver validada.
    // Uso: /girassol-backup-offline/sonda-ml-claims
    if (method === 'GET' && p === '/girassol-backup-offline/sonda-ml-claims') {
      const kD = (urlObj.searchParams && urlObj.searchParams.get('k')) || '';
      const sessD = validarSessao(req.headers['cookie']);
      if (!((process.env.ADMIN_KEY && kD === process.env.ADMIN_KEY) || (sessD && ehAdmin(sessD)))) { json(res, 404, { error: 'not found' }); return true; }
      let tk = null;
      try { const { garantirTokenML: _g4 } = require('../girassol/mlTokenManager'); tk = await _g4(); }
      catch (e) { json(res, 200, { ok: false, erro: 'sem token ML: ' + String(e.message || e) }); return true; }
      const H = { headers: { Authorization: 'Bearer ' + tk } };
      const out = { ok: true, detalhes: [] };
      // Client ID do app que gerou o token (o ML embute no token: APP_USR-{app_id}-...).
      // É NESSE app que a permissão de pós-venda/devoluções precisa ser habilitada.
      out.app_id_do_token = (String(tk).match(/APP_USR-(\d+)-/) || [])[1] || 'nao-identificado';
      try {
        // o /claims/search exige pelo menos 1 filtro; o ML recomenda players.user_id + players.role=respondent
        // (o vendedor é o "respondent" da reclamação). Pega o seller_id via /users/me.
        let sellerId = null;
        try { const rm = await fetch('https://api.mercadolibre.com/users/me', H); const dm = await rm.json().catch(() => null); if (rm.ok && dm && dm.id) sellerId = dm.id; } catch (e) {}
        out.seller_id = sellerId;
        const base = sellerId ? ('players.user_id=' + sellerId + '&players.role=respondent&') : '';
        // o filtro obrigatório do /claims/search é status/stage/type — players.user_id sozinho não conta.
        // Faz 2 buscas (abertas + fechadas) pra trazer TODAS as reclamações/devoluções da conta.
        out.buscas = {};
        let listaAll = [];
        for (const st of ['opened', 'closed']) {
          try {
            const rc = await fetch('https://api.mercadolibre.com/post-purchase/v1/claims/search?' + base + 'status=' + st + '&sort=date_created:desc&limit=30', H);
            const dc = await rc.json().catch(() => null);
            out.buscas[st] = { status: rc.status, total: (dc && dc.paging && dc.paging.total), raw: dc };
            const l = (dc && (dc.data || [])) || [];
            if (Array.isArray(l)) listaAll = listaAll.concat(l);
          } catch (e) { out.buscas[st] = { erro: String(e.message || e) }; }
        }
        out.total_claims = ((out.buscas.opened && out.buscas.opened.total) || 0) + ((out.buscas.closed && out.buscas.closed.total) || 0);
        const amostra = listaAll.slice(0, 3);
        for (const c of amostra) {
          const cid = c && (c.id || c.claim_id || c.resource_id);
          if (!cid) continue;
          const det = { claim_id: cid };
          try { const r1 = await fetch('https://api.mercadolibre.com/post-purchase/v2/claims/' + cid + '/returns', H); det.returns_status = r1.status; det.returns = await r1.json().catch(() => null); } catch (e) {}
          try { const r2 = await fetch('https://api.mercadolibre.com/post-purchase/v1/claims/' + cid + '/charges/return-cost', H); det.return_cost_status = r2.status; det.return_cost = await r2.json().catch(() => null); } catch (e) {}
          out.detalhes.push(det);
        }
      } catch (e) { out.erro = String(e.message || e); }
      json(res, 200, out);
      return true;
    }

    // SONDA (sessão admin): mapeia os COMPONENTES DE PAGAMENTO de vendas ML reais — cupom,
    // desconto, promoção, bônus, pagamento, carrinho — mostrando order+shipment CRUS de 2 pedidos
    // ML recentes. Pra eu ver a estrutura exata e integrar quem-paga-o-quê. Temporária.
    // Uso: /girassol-backup-offline/sonda-ml-pagamento  (opcional &nl=NUMERO_DA_VENDA pra um pedido específico)
    if (method === 'GET' && p === '/girassol-backup-offline/sonda-ml-pagamento') {
      const kD = (urlObj.searchParams && urlObj.searchParams.get('k')) || '';
      const sessD = validarSessao(req.headers['cookie']);
      if (!((process.env.ADMIN_KEY && kD === process.env.ADMIN_KEY) || (sessD && ehAdmin(sessD)))) { json(res, 404, { error: 'not found' }); return true; }
      let tk = null;
      try { const { garantirTokenML: _g5 } = require('../girassol/mlTokenManager'); tk = await _g5(); }
      catch (e) { json(res, 200, { ok: false, erro: 'sem token ML: ' + String(e.message || e) }); return true; }
      const H = { headers: { Authorization: 'Bearer ' + tk } };
      let alvos = [];
      const nlQ = String((urlObj.searchParams && urlObj.searchParams.get('nl')) || '').replace(/\D/g, '');
      if (nlQ) { alvos = [{ numero: null, numero_loja: nlQ }]; }
      else {
        const vd = readJson(path.join(CACHE_DIR, '_vendas_dia.json'), {});
        alvos = Object.values(vd).filter(v => v && (v.marketplace === 'ml' || v.marketplace === 'mercadolivre') && v.numero_loja)
          .sort((a, b) => String(b.data || '').localeCompare(String(a.data || '')))
          .slice(0, 2);
      }
      const out = { ok: true, pedidos: [] };
      for (const v of alvos) {
        const nl = String(v.numero_loja).replace(/\D/g, '');
        const reg = { numero: v.numero, numero_loja: nl };
        try {
          let r = await fetch('https://api.mercadolibre.com/orders/' + nl, H);
          let d = await r.json().catch(() => null);
          if (!r.ok && r.status === 404) {   // 404 = pack (carrinho): abre o pack e pega a 1ª order
            const rp = await fetch('https://api.mercadolibre.com/packs/' + nl, H);
            reg.pack_raw = await rp.json().catch(() => null);
            const o1 = reg.pack_raw && reg.pack_raw.orders && reg.pack_raw.orders[0];
            if (o1) { r = await fetch('https://api.mercadolibre.com/orders/' + (o1.id || o1), H); d = await r.json().catch(() => null); }
          }
          reg.order_status = r.status;
          reg.order_raw = d;   // CRU: coupon, payments, order_items (unit_price/full_unit_price), taxes, discounts...
          const shipId = d && d.shipping && d.shipping.id;
          if (shipId) { try { const rs = await fetch('https://api.mercadolibre.com/shipments/' + shipId, H); reg.shipment_raw = await rs.json().catch(() => null); } catch (e) {} }
        } catch (e) { reg.erro = String(e.message || e); }
        out.pedidos.push(reg);
      }
      json(res, 200, out);
      return true;
    }

    // ADMIN (?k= ou sessão): RAIO-X da cobertura por mês — onde estão os buracos de valor/UF
    if (method === 'GET' && p === '/girassol-backup-offline/debug-cobertura') {
      const k = (urlObj.searchParams && urlObj.searchParams.get('k')) || '';
      const sessX = validarSessao(req.headers['cookie']);
      if (!((process.env.ADMIN_KEY && k === process.env.ADMIN_KEY) || (sessX && ehAdmin(sessX)))) { json(res, 404, { error: 'not found' }); return true; }
      const confX = readJson(CONFERIDOS_FILE, {});
      const porMes = {}; const exemplos = [];
      for (const [cid, c] of Object.entries(confX)) {
        if (!c || !c.conferido_em) continue;
        const mes = new Date(c.conferido_em).toLocaleString('sv-SE', { timeZone: 'America/Sao_Paulo' }).slice(0, 7);
        if (!porMes[mes]) porMes[mes] = { pedidos: 0, sem_uf: 0, sem_vprod_nf: 0, unidades: 0, unid_sem_valor: 0 };
        const g = porMes[mes]; g.pedidos++;
        if (c.uf == null) g.sem_uf++;
        if (c.vprod_nf == null) g.sem_vprod_nf++;
        let semV = 0;
        for (const it of (c.itens || [])) { const q = Number(it.qtd || 1); g.unidades += q; if (it.valor_total == null) { g.unid_sem_valor += q; semV += q; } }
        if (semV && exemplos.length < 8) exemplos.push({ id: cid, mes, numero: c.numero, skus: (c.itens || []).filter(i => i.valor_total == null).map(i => i.sku) });
      }
      json(res, 200, { ok: true, por_mes: porMes, exemplos_itens_sem_valor: exemplos });
      return true;
    }

    // ADMIN (?k= ou sessão): RAIO-X DO PEDIDO CRU do Bling — mostra TODAS as chaves e qualquer campo
    // com cara de data/hora, pra decidirmos com o payload real se o Bling guarda a hora da venda.
    // Uso: /girassol-backup-offline/debug-pedido?id=116063  (o nº que aparece na coluna Pedido)
    if (method === 'GET' && p === '/girassol-backup-offline/debug-pedido') {
      const k = (urlObj.searchParams && urlObj.searchParams.get('k')) || '';
      const sessP = validarSessao(req.headers['cookie']);
      if (!((process.env.ADMIN_KEY && k === process.env.ADMIN_KEY) || (sessP && ehAdmin(sessP)))) { json(res, 404, { error: 'not found' }); return true; }
      const idQ = String(urlObj.searchParams.get('id') || '').trim();
      if (!idQ) { json(res, 200, { ok: false, erro: 'passe ?id=NUMERO (nº do pedido) ou ?id=ID_BLING' }); return true; }
      // aceita nº do pedido (procura no conferidos) ou id do Bling direto
      const idClean = idQ.replace(/\D/g, '');   // aceita nº do pedido, nº da venda no marketplace ou id do Bling (limpa sufixos tipo _ML)
      let alvoId = idClean || idQ;
      const confP = readJson(CONFERIDOS_FILE, {});
      for (const [cid, c] of Object.entries(confP)) {
        if (!c) continue;
        if (String(c.numero) === idClean || (c.numero_loja && String(c.numero_loja) === idClean)) { alvoId = cid; break; }
      }
      try {
        const det = await detalhePedido(alvoId);
        if (!det) { json(res, 200, { ok: false, erro: 'pedido não encontrado no Bling (id ' + alvoId + ')' }); return true; }
        const comHora = {};
        const varre = (obj, pref) => {
          for (const [k2, v2] of Object.entries(obj || {})) {
            const cam = pref ? pref + '.' + k2 : k2;
            if (v2 && typeof v2 === 'object' && !Array.isArray(v2)) { varre(v2, cam); continue; }
            const sv = String(v2 == null ? '' : v2);
            if (/data|hora|date|time/i.test(k2) || /\d{4}-\d{2}-\d{2}/.test(sv) || /\d{2}:\d{2}/.test(sv)) comHora[cam] = v2;
          }
        };
        varre(det, '');
        json(res, 200, { ok: true, id_bling: alvoId, numero: det.numero,
          chaves_do_pedido: Object.keys(det),
          todos_os_campos_com_data_ou_hora: comHora,
          veredito_hora: (Object.values(comHora).some(v => /\d{2}:\d{2}/.test(String(v))) ? 'TEM campo com HORA — cola aqui que eu implemento' : 'só DATAS (sem hora) — o Bling não guarda a hora da venda'),
          taxas: det.taxas || null,                       // 💎 se vier taxaComissao/custoFrete: tarifa+frete de TODOS os canais sem app!
          intermediador: det.intermediador || null,
          totais: { totalProdutos: det.totalProdutos, total: det.total, desconto: det.desconto, outrasDespesas: det.outrasDespesas },
          itens_do_bling: (det.itens || []).map(i => ({ codigo: i.codigo || null, codigo_produto: (i.produto && i.produto.codigo) || null, descricao: String(i.descricao || '').slice(0, 60), qtd: i.quantidade, valor: i.valor })),
          itens_do_conferido: ((confP[alvoId] && confP[alvoId].itens) || []).map(i => ({ sku: i.sku, qtd: i.qtd, valor_total: i.valor_total })),
          conferido_campos: (function(){ const c = confP[alvoId] || {}; return { tarifa_ml: c.tarifa_ml != null ? c.tarifa_ml : null, frete_ml: c.frete_ml != null ? c.frete_ml : null, venda_em: c.venda_em || null, taxa_mkt: c.taxa_mkt != null ? c.taxa_mkt : null, frete_mkt: c.frete_mkt != null ? c.frete_mkt : null, vprod_nf: c.vprod_nf != null ? c.vprod_nf : null, numero_loja: c.numero_loja || null, marketplace: c.marketplace || null }; })() });
      } catch (e) { json(res, 200, { ok: false, erro: String(e.message || e).slice(0, 200) }); }
      return true;
    }

    // ADMIN (?k= obrigatorio — trava central intercepta rotas 'debug'): RAIO-X DO PRODUTO no Bling.
    // Mostra TODAS as chaves do produto + campos de preco/custo + o que /estoques/saldos e /produtos/fornecedores devolvem.
    // Uso: /girassol-backup-offline/debug-sku?sku=KP16&k=SUA_CHAVE
    if (method === 'GET' && p === '/girassol-backup-offline/debug-sku') {
      const k = (urlObj.searchParams && urlObj.searchParams.get('k')) || '';
      const sessP = validarSessao(req.headers['cookie']);
      if (!((process.env.ADMIN_KEY && k === process.env.ADMIN_KEY) || (sessP && ehAdmin(sessP)))) { json(res, 404, { error: 'not found' }); return true; }
      const skuQ = String(urlObj.searchParams.get('sku') || '').trim();
      if (!skuQ) { json(res, 200, { ok: false, erro: 'passe ?sku=CODIGO' }); return true; }
      try {
        const rb = await blingGet('/produtos?codigo=' + encodeURIComponent(skuQ) + '&criterio=5');
        const p0 = rb && rb.ok && rb.data && rb.data.data && rb.data.data[0];   // envelope do blingGet: {ok, data:{data:[...]}}
        if (!p0) { json(res, 200, { ok: false, erro: 'produto nao encontrado por codigo ' + skuQ }); return true; }
        const rd = await blingGet('/produtos/' + p0.id);
        const det = (rd && rd.ok && rd.data && rd.data.data) || {};
        const precos = {};
        const cata = (obj, pref) => { for (const [k2, v2] of Object.entries(obj || {})) { const cam = pref ? pref + '.' + k2 : k2; if (v2 && typeof v2 === 'object' && !Array.isArray(v2)) { cata(v2, cam); continue; } if (/pre[cç]o|custo|cost|price/i.test(k2)) precos[cam] = v2; } };
        cata(det, '');
        let saldos = null, fornecedores = null;
        try { const rs = await blingGet('/estoques/saldos?idsProdutos[]=' + p0.id); saldos = (rs && rs.data && rs.data.data) || (rs && rs.data) || rs; } catch (e) { saldos = { erro: String(e.message || e).slice(0, 120) }; }
        try { const rf = await blingGet('/produtos/fornecedores?idProduto=' + p0.id); fornecedores = (rf && rf.data && rf.data.data) || (rf && rf.data) || rf; } catch (e) { fornecedores = { erro: String(e.message || e).slice(0, 120) }; }
        json(res, 200, { ok: true, sku: skuQ, id_produto: p0.id,
          chaves_do_produto: Object.keys(det),
          todos_os_campos_de_preco_ou_custo: precos,
          saldo_estoques: saldos,
          endpoint_fornecedores: fornecedores,
          veredito: (precos.precoCusto != null && Number(precos.precoCusto) > 0) ? 'precoCusto EXISTE no produto — vou ler daqui' : 'sem precoCusto no detalhe — olhar os outros campos acima' });
      } catch (e) { json(res, 200, { ok: false, erro: String(e.message || e).slice(0, 200) }); }
      return true;
    }

    // ADMIN (?k=): RAIO-X DO DINHEIRO NO ML — order + shipment + /costs crus, p/ mapear estorno/tarifas.
    // Uso: /girassol-backup-offline/debug-ml?id=116454&k=SUA_CHAVE   (nº do pedido, da venda ou id Bling)
    if (method === 'GET' && p === '/girassol-backup-offline/debug-ml') {
      const k = (urlObj.searchParams && urlObj.searchParams.get('k')) || '';
      const sessM = validarSessao(req.headers['cookie']);
      if (!((process.env.ADMIN_KEY && k === process.env.ADMIN_KEY) || (sessM && ehAdmin(sessM)))) { json(res, 404, { error: 'not found' }); return true; }
      const q0 = String(urlObj.searchParams.get('id') || '').replace(/\D/g, '');
      if (!q0) { json(res, 200, { ok: false, erro: 'passe ?id=NUMERO' }); return true; }
      const confM = readJson(CONFERIDOS_FILE, {});
      let alvo = null, cidM = null;
      for (const [cid, c] of Object.entries(confM)) {
        if (!c) continue;
        if (String(c.numero) === q0 || (c.numero_loja && String(c.numero_loja) === q0) || cid === q0) { alvo = c; cidM = cid; break; }
      }
      if (!alvo) { json(res, 200, { ok: false, erro: 'pedido nao encontrado no conferido' }); return true; }
      const { garantirTokenML: _gtok } = require('../girassol/mlTokenManager');   // require local, igual aos outros blocos deste arquivo
      const tk = await _gtok().catch(() => null);
      if (!tk) { json(res, 200, { ok: false, erro: 'sem token ML' }); return true; }
      const H2 = { headers: { Authorization: 'Bearer ' + tk } };
      const nl2 = String(alvo.numero_loja || '').replace(/\D/g, '');
      const out2 = { ok: true, pedido: alvo.numero, numero_loja: nl2, conferido: { tarifa_ml: alvo.tarifa_ml, frete_ml: alvo.frete_ml, credito_ml: alvo.credito_ml, venda_em: alvo.venda_em, flex: !!alvo.flex } };
      try {
        let ords2 = null;
        const r1 = await fetch('https://api.mercadolibre.com/orders/' + nl2, H2);
        const d1 = await r1.json().catch(() => null);
        if (r1.ok && d1) ords2 = [d1];
        else {
          const rp2 = await fetch('https://api.mercadolibre.com/packs/' + nl2, H2);
          const dp2 = await rp2.json().catch(() => null);
          out2.pack = rp2.ok ? { orders: (dp2 && dp2.orders) || null } : { erro: rp2.status };
          if (rp2.ok && dp2 && Array.isArray(dp2.orders)) {
            ords2 = [];
            for (const oq of dp2.orders) { const ro = await fetch('https://api.mercadolibre.com/orders/' + (oq.id || oq), H2); const doo = await ro.json().catch(() => null); if (ro.ok && doo) ords2.push(doo); }
          }
        }
        if (!ords2 || !ords2.length) { out2.erro_order = 'nem order nem pack'; json(res, 200, out2); return true; }
        out2.orders = ords2.map(od => ({
          id: od.id, date_created: od.date_created, total_amount: od.total_amount, paid_amount: od.paid_amount,
          itens: (od.order_items || []).map(it => ({ sku: (it.item && (it.item.seller_sku || it.item.id)) || null, qtd: it.quantity, preco: it.unit_price, sale_fee: it.sale_fee, listing_type: it.listing_type_id })),
          taxes: od.taxes || null,
          payments: (od.payments || []).map(pg => ({ status: pg.status, transaction_amount: pg.transaction_amount, shipping_cost: pg.shipping_cost, overpaid_amount: pg.overpaid_amount, marketplace_fee: pg.marketplace_fee, total_paid_amount: pg.total_paid_amount })),
          shipping_id: (od.shipping && od.shipping.id) || null
        }));
        const shId = out2.orders.map(o3 => o3.shipping_id).filter(Boolean)[0];
        if (shId) {
          const rs2 = await fetch('https://api.mercadolibre.com/shipments/' + shId, H2);
          const ds2 = await rs2.json().catch(() => null);
          if (rs2.ok && ds2) out2.shipment = { id: ds2.id, logistic_type: (ds2.logistic && ds2.logistic.type) || ds2.logistic_type || null, mode: ds2.mode, status: ds2.status, cost: ds2.cost, base_cost: ds2.base_cost, list_cost: ds2.list_cost, shipping_option: ds2.shipping_option || null };
          const rc2 = await fetch('https://api.mercadolibre.com/shipments/' + shId + '/costs', H2);
          const dc2 = await rc2.json().catch(() => null);
          out2.shipment_costs = rc2.ok ? dc2 : { erro: rc2.status, msg: (dc2 && (dc2.message || dc2.error)) || null };
        }
      } catch (e) { out2.erro = String(e.message || e).slice(0, 200); }
      json(res, 200, out2);
      return true;
    }

    // ADMIN/sessão: sincronizador de vendas do Bling (todas as situações). ?status=1 mostra o estado.
    // DEBUG (?k=): raio-X do 🧾 — pega 3 conferidos recentes SEM hora de NF e mostra, pra cada um:
    // o que tem no conf, o que tem no snapshot (snap.nf) e o resultado CRU da chamada /nfe/{id} feita AGORA.
    // Revela na hora onde o preenchimento tranca: snapshot sem nf.id? Bling recusando? campo com outro nome?
    if (method === 'GET' && p === '/girassol-backup-offline/debug-nf-emissao') {
      const kE = (urlObj.searchParams && urlObj.searchParams.get('k')) || '';
      if (!process.env.ADMIN_KEY || kE !== process.env.ADMIN_KEY) { json(res, 404, { error: 'not found' }); return true; }
      const confE = readJson(CONFERIDOS_FILE, {});
      const corteE = Date.now() - 4 * 86400000;
      const alvosE = Object.entries(confE)
        .filter(([idE, cE]) => cE && (cE.nf_emissao == null || cE.nf_emissao === '') && cE.nf_numero && cE.conferido_em && Date.parse(cE.conferido_em) >= corteE)
        .sort((a, b) => String(b[1].conferido_em || '').localeCompare(String(a[1].conferido_em || '')))
        .slice(0, 3);
      const saidaE = [];
      for (const [idE, cE] of alvosE) {
        const snE = readJson(path.join(CACHE_DIR, String(idE), 'pedido.json'), null);
        const item = {
          pedido_id: idE, nf_numero: cE.nf_numero, nf_emissao_no_conf: cE.nf_emissao === '' ? '(sentinela vazia)' : cE.nf_emissao,
          conferido_em: cE.conferido_em, marketplace: cE.marketplace || null,
          snapshot_existe: !!snE, snap_nf: (snE && snE.nf) || null, chamada_nfe: null
        };
        try {
          const nfE2 = await nfDoPedido(idE);   // b16: mesmo caminho que a fase NF usa agora
          item.chamada_nfe = { via: 'nfDoPedido', achou: !!nfE2, nf: nfE2 || null };
        } catch (e) { item.chamada_nfe = { via: 'nfDoPedido', achou: false, erro: String(e.message || e).slice(0, 200) }; }
        await new Promise(r5 => setTimeout(r5, 350));
        saidaE.push(item);
      }
      json(res, 200, { ok: true, sem_hora_no_conf: alvosE.length, amostra: saidaE });
      return true;
    }

    // DEBUG (?k=): 3 itens CRUS da listagem /pedidos/vendas — confirma se o Bling manda loja.id e numeroLoja
    if (method === 'GET' && p === '/girassol-backup-offline/debug-vendas-raw') {
      const kD = (urlObj.searchParams && urlObj.searchParams.get('k')) || '';
      if (!process.env.ADMIN_KEY || kD !== process.env.ADMIN_KEY) { json(res, 404, { error: 'not found' }); return true; }
      const isoDD = dt => dt.toISOString().slice(0, 10);
      const hjD = new Date(); const inD = new Date(hjD); inD.setDate(inD.getDate() - 3); const fiD = new Date(hjD); fiD.setDate(fiD.getDate() + 1);
      // 28/07: parâmetro CERTO da API v3 (dataInicial/dataFinal). O antigo dataEmissaoInicial não existe
      // e era ignorado pelo Bling, que devolvia pedidos de qualquer data.
      const rD = await blingGet('/pedidos/vendas?dataInicial=' + isoDD(inD) + '&dataFinal=' + isoDD(fiD) + '&pagina=1&limite=3');
      json(res, 200, { ok: !!(rD && rD.ok), itens_crus: (rD && rD.data && rD.data.data) || [], loja_mkt_mapa: LOJA_MKT });
      return true;
    }

    // ─── debug: onde o Bling guarda a localização de um SKU ───
    if (method === 'GET' && p === '/girassol-backup-offline/debug-produto') {
      if (!ehAdmin((urlObj.searchParams && urlObj.searchParams.get('op')) || '')) { json(res, 403, { ok: false, erro: 'apenas admin (use ?op=SEU_NOME)' }); return true; }
      const q = String(urlObj.searchParams.get('q') || '').trim();
      let prod = null;
      for (const v of [...new Set([q, q.toUpperCase(), q.toLowerCase()])]) {
        const r = await blingGet(`/produtos?codigo=${encodeURIComponent(v)}&limite=1`);
        const it = r.ok && r.data && r.data.data && r.data.data[0];
        if (it && it.id) { prod = await produtoDetalhe(it.id); break; }
      }
      json(res, 200, {
        ok: !!prod,
        sku: prod && prod.codigo,
        estoque: prod && prod.estoque,                 // <- onde deve estar localizacao
        localizacaoRoot: prod && prod.localizacao,     // <- ou aqui
        cacheLocal: locCache()[q] || locCache()[String(q).toUpperCase()] || null
      });
      return true;
    }

    // DEBUG — mostra onde o Bling guarda a localização de um SKU (confirma o campo)
    // uso: /girassol-backup-offline/debug-loc/{SKU}
    if (method === 'GET' && p.startsWith('/girassol-backup-offline/debug-loc/')) {
      if (!ehAdmin((urlObj.searchParams && urlObj.searchParams.get('op')) || '')) { json(res, 403, { ok: false, erro: 'apenas admin (use ?op=SEU_NOME)' }); return true; }
      const sku = decodeURIComponent(p.split('/').pop() || '');
      const { ok, data } = await blingGet(`/produtos?codigo=${encodeURIComponent(sku)}&limite=1`);
      const item = ok && data && data.data && data.data[0];
      let det = null;
      if (item && item.id) det = await produtoDetalhe(item.id);
      json(res, 200, {
        sku,
        da_lista: { estoque: (item && item.estoque) || null, localizacao_raiz: (item && item.localizacao) || null },
        do_detalhe: { estoque: (det && det.estoque) || null, localizacao_raiz: (det && det.localizacao) || null },
        extraido: localizacaoDeProduto(det || item)
      });
      return true;
    }

    // DEBUG — testa mover UM pedido p/ VERIFICADO (ou outro id via ?situacao=). Mostra resposta crua do Bling.
    // uso: /girassol-backup-offline/debug-mover/{idDoPedido}
    if (method === 'GET' && p.startsWith('/girassol-backup-offline/debug-mover/')) {
      if (!ehAdmin((urlObj.searchParams && urlObj.searchParams.get('op')) || '')) { json(res, 403, { ok: false, erro: 'apenas admin (use ?op=SEU_NOME)' }); return true; }
      const id = p.split('/').pop();
      const sit = Number(urlObj.searchParams.get('situacao') || SIT_VERIFICADO);
      const r = await moverSituacao(id, sit);
      json(res, 200, { pedido: id, situacao_destino: sit, resultado: r });
      return true;
    }

    // DEBUG: por que a NF do pedido não veio? mostra a resposta crua do link pedido→nota + campos do pedido
    if (method === 'GET' && p.startsWith('/girassol-backup-offline/debug-nfped/')) {
      if (!ehAdmin((urlObj.searchParams && urlObj.searchParams.get('op')) || '')) { json(res, 403, { ok: false, erro: 'apenas admin (use ?op=SEU_NOME)' }); return true; }
      const id = p.split('/').filter(Boolean).pop();
      const out = { id };
      const r = await blingGet(`/pedidos/vendas/${id}/nfe`); await sleep(PAUSA_MS);
      out.endpoint_pedido_nfe = { ok: r.ok, status: r.status, data: r.data };
      const det = await detalhePedido(id);
      out.pedido_keys = det ? Object.keys(det) : null;
      out.pedido_situacao = det ? det.situacao : null;
      out.pedido_campos_nf = det ? { notaFiscal: det.notaFiscal, nfe: det.nfe, notasFiscais: det.notasFiscais, idNotaFiscal: det.idNotaFiscal } : null;
      json(res, 200, out);
      return true;
    }

    // BACKUP: baixa um JSON com o estado que NÃO vem do Bling (fila + localizações + índice + log). Só admin.
    if (method === 'GET' && p === '/girassol-backup-offline/backup') {
      const op = String(urlObj.searchParams.get('op') || '');
      if (!ehAdmin(op)) { json(res, 200, { ok: false, precisa_admin: true, erro: 'só admin — use ?op=SEUNOME' }); return true; }
      const dump = {
        versao: VERSAO,
        gerado_em: new Date().toISOString(),
        conferidos: readJson(CONFERIDOS_FILE, {}),
        localizacoes: readJson(LOC_FILE, {}),
        indice_ean: readJson(EAN_INDEX_FILE, {}),
        localizacoes_log: readJson(LOC_LOG_FILE, [])
      };
      const nome = 'backup-good-offline-' + new Date().toISOString().slice(0, 10) + '.json';
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Disposition': 'attachment; filename="' + nome + '"' });
      res.end(JSON.stringify(dump, null, 2));
      return true;
    }

    // RESTAURAR (página): cola o JSON do backup e restaura. Só admin (?op=SEUNOME).
    if (method === 'GET' && p === '/girassol-backup-offline/restaurar') {
      const op = String(urlObj.searchParams.get('op') || '');
      if (!ehAdmin(op)) { html(res, 200, '<meta charset=utf-8><p style="font-family:Arial;margin:40px">Acesso só pra admin. Use <b>?op=SEUNOME</b> no fim da URL.</p>'); return true; }
      const pg = '<!doctype html><meta charset=utf-8><title>Restaurar backup</title>' +
        '<style>body{font-family:Arial;max-width:720px;margin:40px auto;padding:0 16px;color:#111}textarea{width:100%;height:300px;font-family:monospace;font-size:12px;box-sizing:border-box}button{padding:10px 20px;font-size:15px;font-weight:700;background:#f59e0b;border:0;border-radius:8px;cursor:pointer;margin-top:12px}#r{margin-top:14px;font-weight:700}</style>' +
        '<h2>Restaurar backup — Checkout Offline</h2>' +
        '<p>Cola o conteúdo do arquivo de backup (JSON) e clica em Restaurar. <b style="color:#c00">Isso sobrescreve o estado atual.</b></p>' +
        '<textarea id=j placeholder="cola aqui o JSON do backup"></textarea>' +
        '<button onclick="rest()">Restaurar</button><div id=r></div>' +
        '<script>async function rest(){var el=document.getElementById("r");var o;try{o=JSON.parse(document.getElementById("j").value)}catch(e){el.textContent="JSON inválido: "+e.message;return}o.op=' + JSON.stringify(op) + ';try{var x=await fetch("/girassol-backup-offline/restaurar",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(o)});x=await x.json();el.textContent=x.ok?("\\u2713 Restaurado: "+x.restaurados.join(", ")):("Falhou: "+(x.erro||"erro"))}catch(e){el.textContent="Erro: "+e.message}}<\/script>';
      html(res, 200, pg);
      return true;
    }

    // RESTAURAR (ação): grava de volta só o que veio no corpo. Só admin.
    if (method === 'POST' && p === '/girassol-backup-offline/restaurar') {
      let body = {};
      try { body = await readBody(req); } catch (e) {}
      if (!ehAdmin(String(body.op || ''))) { json(res, 200, { ok: false, precisa_admin: true, erro: 'só admin' }); return true; }
      const restaurados = [];
      if (body.conferidos && typeof body.conferidos === 'object') { writeJson(CONFERIDOS_FILE, body.conferidos); restaurados.push('fila finalizados (' + Object.keys(body.conferidos).length + ')'); }
      if (body.localizacoes && typeof body.localizacoes === 'object') { writeJson(LOC_FILE, body.localizacoes); restaurados.push('localizações (' + Object.keys(body.localizacoes).length + ')'); }
      if (body.indice_ean && typeof body.indice_ean === 'object') { writeJson(EAN_INDEX_FILE, body.indice_ean); restaurados.push('índice EAN (' + Object.keys(body.indice_ean).length + ')'); }
      if (Array.isArray(body.localizacoes_log)) { writeJson(LOC_LOG_FILE, body.localizacoes_log); restaurados.push('log (' + body.localizacoes_log.length + ')'); }
      json(res, 200, { ok: restaurados.length > 0, restaurados });
      return true;
    }

    // DEBUG: dumpa as respostas cruas do Bling p/ um pedido (diagnóstico NF/etiqueta)
    if (method === 'GET' && p.startsWith('/girassol-backup-offline/debug/')) {
      const id = p.split('/').filter(Boolean).pop();
      const out = { id, versao: VERSAO };
      try {
        const ped = await blingGet(`/pedidos/vendas/${id}`);
        out.pedido_status = ped.status;
        const d = ped.data && ped.data.data;
        out.pedido = d ? {
          numero: d.numero,
          situacao: d.situacao,
          loja: d.loja,
          numeroLoja: d.numeroLoja,
          contato: d.contato && { nome: d.contato.nome },
          itens: (d.itens || []).map(it => ({ codigo: it.codigo, quantidade: it.quantidade, produto: it.produto }))
        } : ped.data;
        out.servico = d ? servicoDoPedido(d) : null;       // o campo que o checkout usa pra decidir FLEX
        out.seria_flex = d ? ehFlex(servicoDoPedido(d)) : null;

        const nfe = await blingGet(`/pedidos/vendas/${id}/nfe`);
        out.nfe_direto_status = nfe.status;
        out.nfe_direto_raw = nfe.data;
        out.nf_por_range = await acharNFporRange(id);

        // testa as 2 formas do parâmetro de etiqueta p/ cravar qual o Bling aceita
        const etqA = await blingGet(`/logisticas/etiquetas?formato=${ETIQ_FORMATO}&idsVendas[]=${id}`);
        out.etiqueta_bracket = { status: etqA.status, raw: etqA.data };
        const etqB = await blingGet(`/logisticas/etiquetas?formato=${ETIQ_FORMATO}&idsVendas%5B%5D=${id}`);
        out.etiqueta_encoded = { status: etqB.status, raw: etqB.data };

        const bom = (etqA.ok && etqA.data) ? etqA : (etqB.ok ? etqB : null);
        const link = bom && bom.data && bom.data.data && bom.data.data[0] && bom.data.data[0].link;
        out.etiqueta_link = link ? link.slice(0, 90) + '...' : null;
        if (link) {
          try {
            const r = await fetch(link);
            const buf = await r.buffer();
            const ehZip = buf && buf.length >= 2 && buf[0] === 0x50 && buf[1] === 0x4B;
            let zpl = null, arquivos = null;
            if (ehZip) {
              const zip = new AdmZip(buf);
              arquivos = zip.getEntries().map(e => e.entryName);
              const ent = zip.getEntries().find(e => /\.(txt|zpl)$/i.test(e.entryName)) || zip.getEntries()[0];
              zpl = ent ? ent.getData().toString('utf8') : null;
            } else {
              zpl = buf.toString('utf8');
            }
            out.etiqueta_download = {
              status: r.status,
              contentType: r.headers.get('content-type'),
              tamanho_zip: buf ? buf.length : 0,
              eh_zip: ehZip,
              arquivos_no_zip: arquivos,
              zpl_tamanho: zpl ? zpl.length : 0,
              zpl_inicio: zpl ? zpl.slice(0, 200) : null,
              zpl_marcadores: zpl ? {                        // desempate coleta vs entrega direta
                retirada_pelo_comprador: /RETIRADA\s+PELO\s+COMPRADOR/i.test(zpl),
                coleta: /COLETA/i.test(zpl),
                entrega_direta: /ENTREGA\s+DIRETA/i.test(zpl),
                blocos_grafico_gfa: (zpl.match(/\^GFA/g) || []).length
              } : null
            };
          } catch (e) { out.etiqueta_download = { erro: e.message }; }
        }
      } catch (e) { out.erro = e.message; }
      json(res, 200, out);
      return true;
    }

    // DEBUG: lista vendas ML recentes (loja 203146903) p/ achar uma pra testar etiqueta
    if (method === 'GET' && p === '/girassol-backup-offline/debug-ml') {
      if (!ehAdmin((urlObj.searchParams && urlObj.searchParams.get('op')) || '')) { json(res, 403, { ok: false, erro: 'apenas admin (use ?op=SEU_NOME)' }); return true; }
      const { data } = await blingGet(`/pedidos/vendas?idLoja=203146903&limite=20&pagina=1`);
      const lista = (data && data.data) || [];
      json(res, 200, {
        versao: VERSAO,
        total: lista.length,
        pedidos: lista.map(o => ({
          id: o.id,
          numero: o.numero,
          situacao: o.situacao && o.situacao.id,
          data: o.data
        }))
      });
      return true;
    }

    // DEBUG: dumpa o produto CRU por SKU — vê formato + estrutura/componentes da composição
    // uso: /girassol-backup-offline/debug-produto/{SKU}
    if (method === 'GET' && p.startsWith('/girassol-backup-offline/debug-produto/')) {
      if (!ehAdmin((urlObj.searchParams && urlObj.searchParams.get('op')) || '')) { json(res, 403, { ok: false, erro: 'apenas admin (use ?op=SEU_NOME)' }); return true; }
      const sku = decodeURIComponent(p.split('/').filter(Boolean).pop() || '');
      const lista = await blingGet(`/produtos?codigo=${encodeURIComponent(sku)}&limite=1`);
      const item = lista.data && lista.data.data && lista.data.data[0];
      let raw = null, detStatus = null;
      if (item && item.id) { const r = await blingGet(`/produtos/${item.id}`); detStatus = r.status; raw = (r.data && r.data.data) || null; await sleep(PAUSA_MS); }
      json(res, 200, {
        sku,
        da_lista: item ? { id: item.id, formato: item.formato, idProdutoPai: item.idProdutoPai } : null,
        detalhe_status: detStatus,
        campos_detalhe: raw ? Object.keys(raw) : null,
        formato_detalhe: raw && raw.formato,
        tem_estrutura: !!(raw && raw.estrutura),
        estrutura: (raw && raw.estrutura) || null,
        variacao: (raw && raw.variacao) || null
      });
      return true;
    }

    // DEBUG: dumpa a ESTRUTURA dos produtos de um pedido (variação / composição / kit)
    // uso: /girassol-backup-offline/debug-estrutura/{idDoPedido}
    if (method === 'GET' && p.startsWith('/girassol-backup-offline/debug-estrutura/')) {
      if (!ehAdmin((urlObj.searchParams && urlObj.searchParams.get('op')) || '')) { json(res, 403, { ok: false, erro: 'apenas admin (use ?op=SEU_NOME)' }); return true; }
      const id = p.split('/').filter(Boolean).pop();
      const out = { pedido: id, versao: VERSAO, itens: [] };
      try {
        // probe: o escopo Produtos funciona? (lista 1 produto)
        const probe = await blingGet(`/produtos?limite=1`);
        out.probe_produtos = {
          status: probe.status, ok: probe.ok,
          corpo: probe.data && probe.data.data && probe.data.data[0]
            ? { campos: Object.keys(probe.data.data[0]) }
            : probe.data
        };
        await sleep(PAUSA_MS);

        const ped = await blingGet(`/pedidos/vendas/${id}`);
        const d = ped.data && ped.data.data;
        out.numero = d && d.numero;
        for (const it of ((d && d.itens) || [])) {
          const prodId = it.produto && it.produto.id;
          let status = null, raw = null;
          if (prodId) {
            const r = await blingGet(`/produtos/${prodId}`);
            status = r.status;
            raw = r.data;               // corpo CRU do /produtos/{id}
            await sleep(PAUSA_MS);
          }
          out.itens.push({
            item_descricao: it.descricao,
            item_codigo: it.codigo,
            item_qtd: it.quantidade,
            item_produto: it.produto,   // o que vem dentro do item do pedido
            produto_id: prodId,
            produtos_status: status,    // HTTP status do /produtos/{id}
            produtos_raw: raw           // corpo cru (aqui vejo formato/estrutura/erro)
          });
        }
      } catch (e) { out.erro = e.message; }
      json(res, 200, out);
      return true;
    }

    // DEBUG: dumpa o objeto NF + TESTA baixar o DANFE em PDF (linkPDF) de dentro do Render
    if (method === 'GET' && p === '/girassol-backup-offline/debug-nf') {
      if (!ehAdmin((urlObj.searchParams && urlObj.searchParams.get('op')) || '')) { json(res, 403, { ok: false, erro: 'apenas admin (use ?op=SEU_NOME)' }); return true; }
      const out = { versao: VERSAO };
      try {
        const r = await blingGet(`/nfe?limite=1`);
        out.lista_status = r.status;
        const nf0 = r.data && r.data.data && r.data.data[0];
        if (nf0 && nf0.id) {
          await sleep(PAUSA_MS);
          const det = await blingGet(`/nfe/${nf0.id}`);
          const nf = det.data && det.data.data;
          out.numero = nf && nf.numero;
          out.tem_linkPDF = !!(nf && nf.linkPDF);
          out.tem_linkDanfe = !!(nf && nf.linkDanfe);
          out.tem_xml = !!(nf && nf.xml);
          out.campos_nf = nf ? Object.keys(nf) : null;
          out.links_e_danfe = nf ? Object.keys(nf).filter(k => /link|danfe|pdf|simpl|etiq|impress/i.test(k)).reduce((o, k) => { o[k] = nf[k]; return o; }, {}) : null;
          if (nf && nf.linkPDF) {
            try {
              const resp = await fetch(nf.linkPDF, { redirect: 'follow' });
              const buf = Buffer.from(await resp.arrayBuffer());
              const head = buf.slice(0, 8).toString('latin1');
              out.download_pdf = {
                status: resp.status,
                content_type: resp.headers.get('content-type'),
                tamanho_bytes: buf.length,
                primeiros_bytes: head,
                eh_pdf: head.startsWith('%PDF'),
                parece_bloqueio: /^<|html|cloudflare/i.test(head)
              };
            } catch (e) { out.download_pdf = { erro: e.message }; }
          }
        }
      } catch (e) { out.erro = e.message; }
      json(res, 200, out);
      return true;
    }

    // DEBUG/PREVIEW: gera o DANFE Simplificado 10x15 de um pedido REAL (pra ver e validar)
    // uso: /girassol-backup-offline/debug-nf-simp/{idDoPedido}        → abre o PDF
    //      /girassol-backup-offline/debug-nf-simp/{idDoPedido}?json=1 → mostra os dados extraídos
    if (method === 'GET' && p.startsWith('/girassol-backup-offline/debug-nf-simp/')) {
      if (!ehAdmin((urlObj.searchParams && urlObj.searchParams.get('op')) || '')) { json(res, 403, { ok: false, erro: 'apenas admin (use ?op=SEU_NOME)' }); return true; }
      const pedidoId = p.split('/').filter(Boolean).pop();
      let snap = readJson(path.join(CACHE_DIR, String(pedidoId), 'pedido.json'), null);
      if (!snap) {  // talvez seja o NÚMERO do pedido (o que você vê na tela) → procura no manifest
        const man = manifest();
        const achado = Object.keys(man).find(k => String(man[k].numero) === String(pedidoId));
        if (achado) snap = readJson(path.join(CACHE_DIR, String(achado), 'pedido.json'), null);
      }
      if (!snap || !snap.nf || !snap.nf.id) { json(res, 404, { erro: 'pedido sem NF cacheada', pedido: pedidoId }); return true; }
      let dados;
      try { dados = await dadosNFSimp(snap.nf.id, snap.numero); }
      catch (e) { json(res, 502, { erro: 'falha ao montar dados', detalhe: e.message }); return true; }
      if (!dados) { json(res, 502, { erro: 'NF não retornou dados' }); return true; }
      if (/[?&]json=1/.test(urlObj.search || '')) { json(res, 200, dados); return true; }
      try {
        const pdf = await gerarDanfeSimplificado(dados);
        res.writeHead(200, { 'Content-Type': 'application/pdf', 'Content-Disposition': 'inline; filename="danfe-simplificado.pdf"' });
        res.end(pdf);
      } catch (e) { json(res, 500, { erro: 'falha ao gerar PDF', detalhe: e.message }); }
      return true;
    }

    // testa o caminho do DANFE p/ UM pedido (id do pedido) e cacheia se der certo
    // uso: /girassol-backup-offline/debug-danfe/{idDoPedido}
    if (method === 'GET' && p.startsWith('/girassol-backup-offline/debug-danfe/')) {
      if (!ehAdmin((urlObj.searchParams && urlObj.searchParams.get('op')) || '')) { json(res, 403, { ok: false, erro: 'apenas admin (use ?op=SEU_NOME)' }); return true; }
      const id = p.split('/').filter(Boolean).pop();
      const out = { pedido: id, versao: VERSAO };
      try {
        const dir = path.join(CACHE_DIR, String(id));
        out.dir_existe = fs.existsSync(dir);
        out.danfe_ja_cacheado = fs.existsSync(path.join(dir, 'danfe.pdf'));
        const snap = readJson(path.join(dir, 'pedido.json'), null);
        out.snapshot_existe = !!snap;
        out.nf_no_snapshot = (snap && snap.nf) || null;
        let nfId = snap && snap.nf && snap.nf.id;
        out.nf_id_snapshot = nfId || null;
        if (!nfId) { // fallback: tenta achar a NF do pedido na hora
          const nf = await nfDoPedido(id); await sleep(PAUSA_MS);
          out.nf_via_fallback = nf;
          nfId = nf && nf.id;
        }
        out.nf_id_usado = nfId || null;
        if (nfId) {
          const det = await blingGet(`/nfe/${nfId}`);
          out.nfe_get_ok = det.ok; out.nfe_get_status = det.status;
          const nf = det.data && det.data.data;
          out.tem_linkPDF = !!(nf && nf.linkPDF);
          if (nf && nf.linkPDF) {
            const resp = await fetch(nf.linkPDF, { redirect: 'follow' });
            const buf = Buffer.from(await resp.arrayBuffer());
            const head = buf.slice(0, 8).toString('latin1');
            out.download = { status: resp.status, tamanho: buf.length, primeiros: head, eh_pdf: head.startsWith('%PDF') };
            if (head.startsWith('%PDF')) {
              fs.writeFileSync(path.join(dir, 'danfe.pdf'), buf);
              if (snap) { snap.tem_danfe = true; writeJson(path.join(dir, 'pedido.json'), snap); }
              const man = manifest(); if (man[id]) { man[id].tem_danfe = true; salvarManifest(man); }
              out.salvou = true;
            }
          }
        }
      } catch (e) { out.erro = e.message; }
      json(res, 200, out);
      return true;
    }

    // testa se o Bling devolve a ETIQUETA em PDF (vs ZPL) p/ um pedido
    // uso: /girassol-backup-offline/debug-etiqueta-fmt/{idDoPedido}
    if (method === 'GET' && p.startsWith('/girassol-backup-offline/debug-etiqueta-fmt/')) {
      if (!ehAdmin((urlObj.searchParams && urlObj.searchParams.get('op')) || '')) { json(res, 403, { ok: false, erro: 'apenas admin (use ?op=SEU_NOME)' }); return true; }
      const id = p.split('/').filter(Boolean).pop();
      const out = { pedido: id, versao: VERSAO };
      try {
        for (const fmt of ['PDF', 'ZPL']) {
          const r = await blingGet(`/logisticas/etiquetas?formato=${fmt}&idsVendas[]=${id}`); await sleep(PAUSA_MS);
          const item = r.data && r.data.data && r.data.data[0];
          const link = item && item.link;
          const info = { api_ok: r.ok, api_status: r.status, tem_link: !!link };
          if (!link && r.data) info.resposta = JSON.stringify(r.data).slice(0, 300);
          if (link) {
            try {
              const resp = await fetch(link); await sleep(PAUSA_MS);
              const buf = Buffer.from(await resp.arrayBuffer());
              const head = buf.slice(0, 8).toString('latin1');
              info.download = {
                status: resp.status,
                content_type: resp.headers.get('content-type'),
                tamanho: buf.length,
                primeiros: head,
                eh_pdf: head.startsWith('%PDF'),
                eh_zip: head.charCodeAt(0) === 0x50 && head.charCodeAt(1) === 0x4B
              };
            } catch (e) { info.download = { erro: e.message }; }
          }
          out[fmt] = info;
        }
      } catch (e) { out.erro = e.message; }
      json(res, 200, out);
      return true;
    }

    return false;   // não é rota de diagnóstico
  };
}

module.exports = { rotasDiagnostico };
