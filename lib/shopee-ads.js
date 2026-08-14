'use strict';
// ════════════════════════════════════════════════════════════════════════════════
//  SHOPEE ADS — código ÚNICO, usado por todas as empresas (14/08/2026)
// ════════════════════════════════════════════════════════════════════════════════
//  Por que este arquivo existe: até aqui cada empresa tinha sua CÓPIA do módulo da
//  Shopee, então toda descoberta precisava ser aplicada 3 vezes — e foi assim que
//  nasceram os "consertei na AMB e esqueci na Girassol" desta semana. Aqui a lógica
//  mora UMA vez; cada empresa entra só como parâmetro (o `ctx`).
//
//  O QUE FOI MEDIDO E ESTÁ EMBUTIDO AQUI (AMB, 13-14/08):
//   · o gasto vem de /api/v2/ads/get_all_cpc_ads_daily_performance, UMA linha por dia,
//     datas em DD-MM-AAAA (formato da Shopee), campo `expense`;
//   · CONSUMO ≠ CUSTO: parte do consumo sai de "Free Ads Credit" (brinde) e de recarga
//     com bônus de 10%. O desembolso real aparece na CARTEIRA como `SPM_DEDUCT` — que já
//     é contado no sai_do_bolso. Por isso ads entra como INFORMATIVO, nunca como custo;
//   · a régua é a MESMA do painel da Shopee (e do Jodda): vendas/pedidos/ROAS usam o
//     AMPLO (broad = qualquer produto comprado após o clique). Conferido com julho:
//     ROAS 9,07 · ACOS 11,02% · CAC 16,67 · CTR 1,87% — os quatro batem;
//   · o domínio de ads tem limite de chamadas: cada janela é re-tentada.
//
//  ctx = { CACHE_DIR, readJson, writeJson, pedirAoSync, path }
const _num = v => { const n = Number(v); return isFinite(n) ? Math.round(n * 100) / 100 : 0; };
const arqAds = ctx => ctx.path.join(ctx.CACHE_DIR, '_shopee_ads.json');

async function coletarAds(ctx, dias, loja) {
  const total = Math.min(365, Math.max(1, Number(dias) || 30));
  const arq = ctx.readJson(arqAds(ctx), { dias: {}, atualizado: null });
  arq.dias = arq.dias || {};
  const ddmm = d => String(d.getUTCDate()).padStart(2, '0') + '-' + String(d.getUTCMonth() + 1).padStart(2, '0') + '-' + d.getUTCFullYear();
  const iso = d => d.toISOString().slice(0, 10);
  let novos = 0, vistos = 0, janelas = 0, erro = null;
  const hoje = new Date();
  for (let off = 0; off < total; off += 30) {
    const fim = new Date(Date.UTC(hoje.getUTCFullYear(), hoje.getUTCMonth(), hoje.getUTCDate() - off));
    const ini = new Date(Date.UTC(hoje.getUTCFullYear(), hoje.getUTCMonth(), hoje.getUTCDate() - Math.min(total, off + 29)));
    janelas++;
    let resp = null, motivo = '';
    for (let tent = 1; tent <= 4 && !Array.isArray(resp); tent++) {
      if (tent > 1) await new Promise(r => setTimeout(r, 4000 * (tent - 1)));
      const r = await ctx.pedirAoSync('shopee-raw', { caminho: '/api/v2/ads/get_all_cpc_ads_daily_performance', q: 'start_date=' + ddmm(ini) + '&end_date=' + ddmm(fim) }, loja);
      const cru = (r && r.dados && r.dados.resposta) || null;
      resp = cru && cru.response;
      if (!Array.isArray(resp)) { motivo = (cru && (cru.error || cru.message)) || (r && r.erro) || ('HTTP ' + ((r && r.status) || '?')); resp = null; }
    }
    if (!Array.isArray(resp)) { erro = erro || ('janela ' + iso(ini) + '..' + iso(fim) + ': ' + String(motivo).slice(0, 160)); continue; }
    for (const l of resp) {
      if (!l || !l.date) continue;
      const p = String(l.date).split('-');            // DD-MM-AAAA → AAAA-MM-DD
      if (p.length !== 3) continue;
      const dia = p[2] + '-' + p[1] + '-' + p[0];
      vistos++;
      if (arq.dias[dia] === undefined) novos++;
      arq.dias[dia] = {
        dia, gasto: _num(l.expense),
        impressoes: Number(l.impression) || 0, cliques: Number(l.clicks) || 0,
        pedidos_diretos: Number(l.direct_order) || 0, gmv_direto: _num(l.direct_gmv), roas_direto: _num(l.direct_roas),
        pedidos_amplos: Number(l.broad_order) || 0, gmv_amplo: _num(l.broad_gmv), roas_amplo: _num(l.broad_roas),
        itens_diretos: Number(l.direct_item_sold) || 0, itens_amplos: Number(l.broad_item_sold) || 0
      };
    }
    await new Promise(r => setTimeout(r, 400));
  }
  arq.atualizado = new Date().toISOString();
  ctx.writeJson(arqAds(ctx), arq);
  return { ok: !erro || vistos > 0, dias_pedidos: total, janelas, dias_vistos: vistos, dias_novos: novos, erro };
}

// resumo do período, na régua do painel da Shopee
function resumoAds(ctx, de, ate) {
  const ads = ctx.readJson(arqAds(ctx), { dias: {} }).dias || {};
  let gasto = 0, cliques = 0, imp = 0, gmvAmplo = 0, gmvDireto = 0, pedidos = 0, dias = 0;
  for (const d of Object.values(ads)) {
    const dia = String((d && d.dia) || '');
    if (!(dia >= de && dia <= ate)) continue;
    dias++;
    gasto = Math.round((gasto + _num(d.gasto)) * 100) / 100;
    cliques += Number(d.cliques) || 0;
    imp += Number(d.impressoes) || 0;
    gmvAmplo = Math.round((gmvAmplo + _num(d.gmv_amplo)) * 100) / 100;
    gmvDireto = Math.round((gmvDireto + _num(d.gmv_direto)) * 100) / 100;
    pedidos += Number(d.pedidos_amplos) || 0;
  }
  return {
    consumo: gasto, gasto, dias, cliques, impressoes: imp,
    ctr: imp > 0 ? Math.round((cliques / imp) * 10000) / 100 : null,
    vendas: gmvAmplo, pedidos,
    roas: gasto > 0 ? Math.round((gmvAmplo / gasto) * 100) / 100 : null,
    acos: gmvAmplo > 0 ? Math.round((gasto / gmvAmplo) * 10000) / 100 : null,
    cac: pedidos > 0 ? Math.round((gasto / pedidos) * 100) / 100 : null,
    gmv_amplo: gmvAmplo, pedidos_amplos: pedidos, roas_amplo: gasto > 0 ? Math.round((gmvAmplo / gasto) * 100) / 100 : null,
    gmv_direto: gmvDireto, roas_direto: gasto > 0 ? Math.round((gmvDireto / gasto) * 100) / 100 : null,
    entra_no_sai_do_bolso: false,
    nota: 'consumo de credito; o desembolso real aparece na carteira como SPM_DEDUCT (ja contado). Free Ads Credit e bonus de recarga nao sao custo',
    atualizado: ctx.readJson(arqAds(ctx), {}).atualizado || null
  };
}

module.exports = { coletarAds, resumoAds };
