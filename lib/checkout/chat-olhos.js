'use strict';

/* ─────────────────────────────────────────────────────────────────────────────
   OS "OLHOS" DO CHAT DE ANÁLISE (14/11/2026) — o que o chat enxerga ALÉM das vendas. As três empresas.

   Pedido do dono, depois da 1ª resposta em produção: "ele podia ter analisado … se tinha disponível ainda ou se estoque
   já tava zerado … se tava ativo ads … considerar também a reputação no marketplace … ou tá com atraso na expedição de
   pedidos … enfim, dar mais sabedoria ao chat".

   SETE CONSULTAS, todas de LEITURA, sobre dados que o sistema JÁ guarda (mais as leituras ao vivo dos marketplaces):
     gasto_anuncios           Ads por dia — Shopee (o arquivo da coleta diária, na régua do painel da Shopee) e Mercado
                              Livre (a publicidade lançada na fatura, o mesmo número do card do dashboard).
     reputacao_mercado_livre  o nível, a medalha, reclamações, ATRASO NO DESPACHO e cancelamentos — agora, e o que mudou
                              desde a foto mais antiga guardada (lib/checkout/reputacao-ml.js).
     estoque_atual            o saldo do Bling de até 8 itens — o mesmo do Plano de Compra; consulta ao vivo só quando o
                              saldo guardado está velho, e pouco (teto por pergunta).
     expedicao_do_galpao      a fila de pedidos esperando conferência AGORA e, dos últimos dias, quantos foram conferidos
                              por dia e quanto tempo levaram entre a nota e a conferência.
     anuncios_mercado_livre   (15/11) quantos anúncios da conta estão ativos, pausados, inativos por pendência/infração,
                              perdendo exposição e no Full, as promoções abertas pra conta — agora, e o que mudou desde
                              as fotos guardadas (lib/checkout/anuncios-ml.js). É a CONTA, não um produto.
     saude_conta_shopee       (15/11) as métricas da conta na Shopee contra a meta, penalidades, punições, anúncios com
                              problema e por situação — agora, e o que mudou (lib/checkout/saude-shopee.js).
     anuncios_do_item         (15/11) UM produto de perto, por SKU, no ML e na Shopee: os anúncios dele, situação,
                              estoque por local (galpão × Full), visitas, promoções, qualidade, Product Ads
                              (lib/checkout/anuncio-produto.js). Ao vivo, sem foto.

   A REGRA É A DO CHAT: nenhum número sai "da cabeça" da IA e NÚMERO ERRADO É PIOR QUE NÚMERO AUSENTE. Cada consulta diz
   de quando é o dado e o que ele NÃO cobre; dia sem dado é "sem dado", nunca zero; loja sem a fonte responde "não
   disponível". `anuncios_do_item` diz como UM anúncio está AGORA (ativo, estoque, Full, promoção) — não como estava no
   dia da venda: a peça não guarda foto por anúncio.
   ───────────────────────────────────────────────────────────────────────────── */

const fs = require('fs');
const path = require('path');
const REP = require('./reputacao-ml');
const ANU = require('./anuncios-ml');
const SAU = require('./saude-shopee');
const PROD = require('./anuncio-produto');
const { comPrazo } = require('./com-prazo');

const MAX_PONTOS_POR_DIA = 92;       /* acima disso, os Ads vêm por mês */
const MAX_SKUS = 8;                  /* itens por consulta de estoque */
const MAX_AO_VIVO = 8;               /* itens consultados ao vivo no Bling por PERGUNTA (cada um: 1 ou 2 chamadas) — a cota do Bling é da conta inteira */
const SALDO_VELHO_H = 2;             /* saldo guardado há mais que isto é consultado de novo */
const PAUSA_BLING_MS = 350;
const PRAZO_ESTOQUE_MS = 40000;      /* Codex #883: todas as idas ao Bling de UMA consulta de estoque — o Bling que emudece não pode prender a pergunta */
const MINIMO_PRA_IR_AO_BLING_MS = 300;   /* com menos que isto de prazo sobrando nem começa outra ida ao Bling: ela seria cancelada no meio. (O relógio do
                                            Node pode disparar uns milissegundos ANTES do prazo — "sobrou 2 ms" não é tempo, e ia virar uma ida a mais.) */
/* Codex #886: o arquivo dos conferidos NÃO é histórico — a limpeza do galpão (`purgarConferidos`, no `arquivo.js` de cada
   empresa, a cada ciclo) apaga a conferência já sincronizada com mais de 30 dias. Passar disso contaria só as que
   sobraram e leria como "queda" o que é só arquivo apagado. O teto fica em 28 dias (o mesmo do painel pra esta fonte):
   dentro dele, todo dia está inteiro. */
const DIAS_EXPEDICAO = 14, DIAS_EXPEDICAO_MAX = 28;
const DIAS_REPUTACAO = 30, DIAS_REPUTACAO_MAX = 365;
const DIAS_CONTA = 30, DIAS_CONTA_MAX = 365;   /* a janela das fotos dos anúncios do ML e da saúde da conta na Shopee */
const MAX_PONTOS_DE_FOTO = 40;                 /* fotos que vão pro modelo numa janela (a primeira, a última e as do meio, espaçadas) */
const TZ = 'America/Sao_Paulo';

const r2 = (v) => Math.round(Number(v) * 100) / 100;
const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const somaDias = (iso, n) => { const d = new Date(iso + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const diaSP = (iso) => { const t = Date.parse(iso); return Number.isFinite(t) ? new Date(t).toLocaleString('sv-SE', { timeZone: TZ }).slice(0, 10) : null; };
const mediana = (a) => { const o = a.slice().sort((x, y) => x - y); const m = Math.floor(o.length / 2); return o.length % 2 ? o[m] : (o[m - 1] + o[m]) / 2; };
const inteiroEntre = (v, padrao, min, max) => { const n = parseInt(v, 10); return Math.min(max, Math.max(min, Number.isFinite(n) ? n : padrao)); };

/* a fatura do ML é um arquivo GRANDE (dezenas de MB em memória por leitura — já derrubou o serviço, 04/09). Aqui ela é
   lida uma vez por versão do arquivo e só o que interessa (a publicidade por dia) fica guardado. */
const _faturaML = new Map();   /* caminho → { mtimeMs, v } */
function publicidadeDaFaturaML(o) {
  const arq = path.join(o.CACHE_DIR, '_ml_billing.json');
  let st; try { st = fs.statSync(arq); } catch (e) { return null; }
  const c = _faturaML.get(arq);
  if (c && c.mtimeMs === st.mtimeMs && c.tam === st.size) return c.v;
  const b = o.readJson(arq, null);
  let v = null;
  if (b && b.porDia && typeof b.porDia === 'object' && !Array.isArray(b.porDia)) {
    const dias = Object.keys(b.porDia).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort();
    const ads = {};
    for (const d of dias) { const x = b.porDia[d] && b.porDia[d].ads; if (x != null && Number.isFinite(Number(x))) ads[d] = r2(x); }
    v = { ads, cobre: dias.length ? { de: dias[0], ate: dias[dias.length - 1] } : null, atualizado: b.atualizado || null };
  }
  _faturaML.set(arq, { mtimeMs: st.mtimeMs, tam: st.size, v });
  return v;
}

/* o saldo consultado ao vivo fica guardado uns minutos (várias perguntas seguidas sobre o mesmo item não repetem a chamada) */
const _saldoVivo = new Map();   /* empresa|SKU → { saldo, nome, ts } */

function criarOlhos(o) {
  for (const n of ['hoje', 'empresa', 'CACHE_DIR', 'readJson', 'writeJson', 'validarPeriodo']) if (o[n] == null) throw new Error('lib/checkout/chat-olhos: falta ' + n);
  const hoje = o.hoje;
  const agora = () => (typeof o.agora === 'function' ? o.agora() : Date.now());
  const dorme = o.dorme || ((ms) => new Promise((r) => setTimeout(r, ms)));
  let aoVivo = 0;   /* consultas ao Bling já feitas NESTA pergunta (os olhos nascem a cada pergunta): o teto vale pra pergunta inteira, não por consulta */

  const F = {
    /* ── Ads por dia ── */
    async gasto_anuncios(inp) {
      const per = o.validarPeriodo(inp.de, inp.ate, hoje);
      const fim = per.ate > hoje ? hoje : per.ate;   /* dia que ainda não chegou não é "dia sem dado" */
      const porMes = per.dias > MAX_PONTOS_POR_DIA;
      const avisos = [];

      /* SHOPEE — o arquivo da coleta diária; o total do período é o da função de produção (a régua do painel da Shopee) */
      let shopee;
      const arqS = o.readJson(path.join(o.CACHE_DIR, '_shopee_ads.json'), null);
      const diasS = (arqS && arqS.dias && typeof arqS.dias === 'object' && !Array.isArray(arqS.dias)) ? arqS.dias : {};
      const todosS = Object.keys(diasS).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort();
      if (!todosS.length) shopee = { disponivel: false, motivo: 'esta loja não tem coleta de Ads da Shopee gravada' };
      else {
        const res = require('../shopee-ads').resumoAds({ path, CACHE_DIR: o.CACHE_DIR, readJson: o.readJson }, per.de, per.ate);
        const noPeriodo = todosS.filter((d) => d >= per.de && d <= per.ate);
        const linha = (d) => { const x = diasS[d] || {}; return { consumo: r2(num(x.gasto)), impressoes: num(x.impressoes), cliques: num(x.cliques), pedidos_atribuidos: num(x.pedidos_amplos), vendas_atribuidas: r2(num(x.gmv_amplo)) }; };
        let pontos;
        if (!porMes) pontos = noPeriodo.map((d) => Object.assign({ dia: d }, linha(d)));
        else {
          const acc = {};
          for (const d of noPeriodo) { const m = d.slice(0, 7), l = linha(d); const a = acc[m] || (acc[m] = { mes: m, consumo: 0, impressoes: 0, cliques: 0, pedidos_atribuidos: 0, vendas_atribuidas: 0, dias_com_dado: 0 });
            a.consumo = r2(a.consumo + l.consumo); a.impressoes += l.impressoes; a.cliques += l.cliques; a.pedidos_atribuidos += l.pedidos_atribuidos; a.vendas_atribuidas = r2(a.vendas_atribuidas + l.vendas_atribuidas); a.dias_com_dado++; }
          pontos = Object.keys(acc).sort().map((m) => acc[m]);
        }
        const diasAteHoje = Math.max(0, Math.round((Date.parse(fim + 'T12:00:00Z') - Date.parse(per.de + 'T12:00:00Z')) / 86400000) + 1);
        shopee = { disponivel: true, coleta_atualizada_em: (arqS && arqS.atualizado) || null, coleta_cobre: { de: todosS[0], ate: todosS[todosS.length - 1] },
          dias_com_dado: noPeriodo.length, dias_sem_dado: Math.max(0, diasAteHoje - noPeriodo.length),
          total: { consumo: res.gasto, impressoes: res.impressoes, cliques: res.cliques, taxa_de_clique_pct: res.ctr, pedidos_atribuidos: res.pedidos, vendas_atribuidas: res.vendas,
            retorno_roas: res.roas, custo_sobre_vendas_acos_pct: res.acos, consumo_por_pedido: res.cac },
          [porMes ? 'por_mes' : 'por_dia']: pontos,
          leia: 'É o CONSUMO de crédito de anúncio na Shopee, não o desembolso (parte sai de crédito grátis e de bônus de recarga). Pedidos e vendas "atribuídos" seguem a régua do painel da Shopee: qualquer produto comprado depois do clique no anúncio. Dia que não aparece é dia SEM DADO coletado — não é "gasto zero" nem "Ads desligado".' };
        if (shopee.dias_sem_dado > 0) avisos.push('Shopee Ads: ' + shopee.dias_sem_dado + ' dia(s) de ' + per.de + ' a ' + fim + ' estão SEM dado coletado — o total do período cobre só os ' + noPeriodo.length + ' dia(s) com dado.');
      }

      /* MERCADO LIVRE — a publicidade lançada na fatura, por dia do lançamento (o card "Publicidade (Ads)" do dashboard) */
      let ml;
      const fat = publicidadeDaFaturaML(o);
      if (!fat || !fat.cobre) ml = { disponivel: false, motivo: 'esta loja não tem a fatura do Mercado Livre gravada' };
      else {
        const dias = Object.keys(fat.ads).filter((d) => d >= per.de && d <= per.ate).sort();
        let pontos;
        if (!porMes) pontos = dias.map((d) => ({ dia: d, publicidade: fat.ads[d] }));
        else { const acc = {}; for (const d of dias) { const m = d.slice(0, 7); const a = acc[m] || (acc[m] = { mes: m, publicidade: 0, dias_com_lancamento: 0 }); a.publicidade = r2(a.publicidade + fat.ads[d]); a.dias_com_lancamento++; } pontos = Object.keys(acc).sort().map((m) => acc[m]); }
        ml = { disponivel: true, fatura_atualizada_em: fat.atualizado, fatura_cobre: fat.cobre, dias_com_lancamento: dias.length,
          total_publicidade: r2(dias.reduce((t, d) => t + fat.ads[d], 0)), [porMes ? 'por_mes' : 'por_dia']: pontos,
          leia: 'É a cobrança de PUBLICIDADE (Product Ads) lançada na fatura do Mercado Livre, pelo dia do LANÇAMENTO na fatura (pode não ser o dia em que o anúncio rodou) — o mesmo número do card "Publicidade (Ads)" do dashboard. Estorno de publicidade entra na fatura como crédito e NÃO está descontado aqui. Dia sem lançamento não é "sem anúncio": a fatura chega dias depois e pode cobrar vários dias de uma vez.' };
        if (per.ate > fat.cobre.ate) avisos.push('Mercado Livre: a fatura gravada vai só até ' + fat.cobre.ate + ' — de ' + somaDias(fat.cobre.ate, 1) + ' em diante a publicidade ainda não foi lançada/coletada (não é zero).');
        if (per.de < fat.cobre.de) avisos.push('Mercado Livre: a fatura gravada começa em ' + fat.cobre.de + ' — antes disso não há dado de publicidade.');
      }
      return { periodo: per, shopee, mercado_livre: ml, nao_cobre: 'Não há aqui Ads de outros canais (Magalu, TikTok), nem quais anúncios ou campanhas estavam ativos, nem vendas por campanha.', avisos };
    },

    /* ── reputação do Mercado Livre ── */
    async reputacao_mercado_livre(inp) {
      if (typeof o.garantirTokenML !== 'function' || typeof o.fetch !== 'function') return { disponivel: false, motivo: 'esta loja não tem a conta do Mercado Livre ligada ao dashboard' };
      const dias = inteiroEntre(inp && inp.dias, DIAS_REPUTACAO, 1, DIAS_REPUTACAO_MAX);
      const r = await REP.consultar({ fetch: o.fetch, garantirTokenML: o.garantirTokenML });
      const cx = { CACHE_DIR: o.CACHE_DIR, readJson: o.readJson, writeJson: o.writeJson };
      const fotoGravada = r.ok ? REP.fotografar(Object.assign({ dia: hoje, resumo: r.resumo, em: new Date(agora()).toISOString() }, cx)) : null;
      const fotos = REP.historico(Object.assign({ de: somaDias(hoje, -dias), ate: hoje }, cx));
      const todas = REP.historico(Object.assign({ de: '0000-00-00', ate: '9999-99-99' }, cx));
      const avisos = [];
      if (!r.ok) avisos.push('Não consegui ler a reputação AGORA (' + r.erro + ') — o que segue é só o histórico guardado.');
      if (fotoGravada === false) avisos.push('Li a reputação, mas não consegui guardar a foto de hoje (o disco recusou): o histórico fica sem este dia.');
      if (!todas.length) avisos.push('Ainda não há nenhuma foto da reputação guardada.');
      else if (fotos.length < 2) avisos.push('O histórico da reputação começa em ' + todas[0].dia + ' (uma foto por dia, a partir de quando esta consulta entrou no ar): não dá pra dizer se a reputação mudou antes disso.');
      return { agora: r.ok ? r.resumo : null, historico_guardado_desde: todas.length ? todas[0].dia : null, janela: { de: somaDias(hoje, -dias), ate: hoje, fotos: fotos.length },
        o_que_mudou_na_janela: REP.comparar(fotos), fotos_da_janela: fotos.length > 40 ? fotos.filter((f, i) => i === 0 || i === fotos.length - 1 || i % Math.ceil(fotos.length / 40) === 0) : fotos,
        leia: 'Reputação da conta no Mercado Livre, como o próprio ML informa: o nível (a cor do termômetro), a medalha de MercadoLíder e, no período que ele usa (campo "periodo"), a quantidade e a taxa de reclamações, de ATRASO NO DESPACHO (envio postado depois do prazo) e de cancelamentos. "taxa_pct" nula = o ML não informou de um jeito que dê pra confirmar a unidade; use a quantidade. Em "o_que_mudou_na_janela", "nivel_mudou" / "medalha_mudou" nulo = o ML NÃO INFORMOU o nível / a medalha na primeira ou na última foto da janela: não dá pra dizer se mudou — não trate como mudança nem como "ficou igual"; as trocas listadas são só as confirmadas (entre duas fotos em que o ML informou). Medalha: "sem medalha de MercadoLíder" é o ML dizendo que a conta não tem; medalha nula é "não informada". Os limites de cada nível são regra do Mercado Livre e não estão aqui. Não há reputação de outros canais (Shopee, Magalu, TikTok).',
        avisos };
    },

    /* ── estoque atual (Bling) ── */
    async estoque_atual(inp) {
      const pedidos = Array.from(new Set((Array.isArray(inp && inp.skus) ? inp.skus : []).map((s) => String(s == null ? '' : s).trim()).filter(Boolean)));
      if (!pedidos.length) throw new Error('diga os SKUs (de 1 a ' + MAX_SKUS + '); use buscar_item pra achar o SKU pelo nome');
      const lista = pedidos.slice(0, MAX_SKUS);
      const guardado = o.readJson(path.join(o.CACHE_DIR, '_prod_compra.json'), {}) || {};
      const doGuardado = (sku) => { for (const k of [sku, sku.toUpperCase(), sku.toLowerCase()]) { const c = guardado[k]; if (c && typeof c === 'object' && c.ts) return c; } return null; };
      const t = agora();
      let falhasAoVivo = 0, semVez = 0, semTempo = 0;
      /* Codex #883: o prazo é da consulta INTEIRA, no relógio de verdade (o `agora()` é o das idades dos saldos) */
      const prazoTotal = Number(o.prazoEstoqueMs) > 0 ? Number(o.prazoEstoqueMs) : PRAZO_ESTOQUE_MS;
      const acaba = Date.now() + prazoTotal;
      const itens = [];
      for (const sku of lista) {
        const chave = o.empresa + '|' + sku.toUpperCase();
        const g = doGuardado(sku), v = _saldoVivo.get(chave);
        const idadeH = (ts) => r2((t - ts) / 3600000);
        const item = (saldo, fonte, ts, nome) => ({ sku, produto: nome || null, saldo: (saldo != null && Number.isFinite(Number(saldo))) ? Number(saldo) : null, fonte, consultado_em: new Date(ts).toISOString(), ha_horas: idadeH(ts) });
        /* a leitura mais nova que já existe (a feita há pouco por este chat ou a do Plano de Compra) */
        const melhor = (v && (!g || v.ts >= g.ts)) ? { saldo: v.saldo, nome: v.nome, ts: v.ts, fonte: 'Bling, consultado por este chat' } : (g ? { saldo: g.saldo, nome: g.nome, ts: g.ts, fonte: 'Bling, última consulta do Plano de Compra' } : null);
        if (melhor && melhor.saldo != null && idadeH(melhor.ts) <= SALDO_VELHO_H) { itens.push(item(melhor.saldo, melhor.fonte, melhor.ts, melhor.nome)); continue; }
        /* velho ou ausente: pergunta ao Bling — poucas vezes por pergunta (a cota do Bling é da conta inteira) */
        let novo = null;
        if (typeof o.blingGet === 'function' && aoVivo >= MAX_AO_VIVO) semVez++;
        if (typeof o.blingGet === 'function' && aoVivo < MAX_AO_VIVO && acaba - Date.now() < MINIMO_PRA_IR_AO_BLING_MS) semTempo++;
        else if (typeof o.blingGet === 'function' && aoVivo < MAX_AO_VIVO) {
          if (aoVivo) await dorme(PAUSA_BLING_MS);
          aoVivo++;
          let estourou = false;
          try { novo = await comPrazo(acaba - Date.now(), (sinal) => saldoNoBling(o.blingGet, sku, dorme, sinal), () => { estourou = true; return null; }); } catch (e) { novo = null; }
          if (novo && novo.saldo != null) _saldoVivo.set(chave, { saldo: novo.saldo, nome: novo.nome, ts: agora() });
          else { novo = null; if (estourou) semTempo++; else falhasAoVivo++; }
        }
        if (novo) itens.push(item(novo.saldo, 'Bling, consultado agora', agora(), novo.nome));
        else if (melhor && melhor.saldo != null) itens.push(Object.assign(item(melhor.saldo, melhor.fonte, melhor.ts, melhor.nome), { desatualizado: true }));
        else itens.push({ sku, saldo: null, motivo: 'não tenho o saldo deste item (não consegui consultar o Bling agora e não há consulta guardada)' });
      }
      const avisos = [];
      if (pedidos.length > lista.length) avisos.push('Vieram ' + pedidos.length + ' SKUs; consultei os ' + lista.length + ' primeiros (máximo por consulta).');
      if (itens.some((x) => x.desatualizado)) avisos.push('Item marcado "desatualizado": o saldo é de uma consulta antiga (veja "ha_horas") — pode não ser o de agora.');
      if (falhasAoVivo) avisos.push(falhasAoVivo + ' consulta(s) ao Bling não responderam com o saldo.');
      if (semTempo) avisos.push('O Bling demorou demais: ' + semTempo + ' item(ns) ficaram sem a consulta de agora (a consulta de estoque tem prazo de ' + Math.round(prazoTotal / 1000) + ' s). Pra eles vale o saldo guardado, se houver.');
      if (semVez) avisos.push(semVez + ' item(ns) não foram consultados no Bling agora: esta pergunta já fez as ' + MAX_AO_VIVO + ' consultas ao vivo que pode (o limite protege a cota do Bling). Pra eles vale o saldo guardado, se houver.');
      return { itens, leia: 'É o saldo do Bling AGORA (ou da consulta indicada em cada item) — o mesmo número do Plano de Compra. NÃO é o saldo do dia em que a venda caiu (o sistema não guarda histórico de estoque), não diz se o anúncio estava ativo no marketplace e não é o estoque do Full que o Mercado Livre enxerga. Saldo zero HOJE é fato; "faltou estoque naquele dia" é hipótese.', avisos };
    },

    /* ── a expedição do galpão ── */
    async expedicao_do_galpao(inp) {
      if (!o.MANIFEST_FILE || !o.CONFERIDOS_FILE) return { disponivel: false, motivo: 'esta loja não tem a fila do galpão ligada ao dashboard' };
      const dias = inteiroEntre(inp && inp.dias, DIAS_EXPEDICAO, 1, DIAS_EXPEDICAO_MAX);
      const man = o.readJson(o.MANIFEST_FILE, {}) || {}, conf = o.readJson(o.CONFERIDOS_FILE, {}) || {};
      const t = agora();
      /* a fila: os MESMOS filtros da tela do galpão (rota /lista, lib/checkout/rotas-comuns.js) */
      const ids = Object.keys(man).filter((i) => man[i] && typeof man[i] === 'object');
      const prontos = ids.filter((i) => man[i].tem_etiqueta && !conf[i]);
      const semEtiqueta = ids.filter((i) => !man[i].tem_etiqueta && !conf[i] && !man[i].full_ml && !man[i].aguardando_disp);
      const espera = (lista) => {
        const horas = [];
        for (const i of lista) { const v = Date.parse(man[i].visto_em || ''); if (Number.isFinite(v) && v <= t) horas.push((t - v) / 3600000); }
        return { pedidos: lista.length, com_hora_de_chegada: horas.length, o_mais_antigo_espera_ha_horas: horas.length ? r2(Math.max(...horas)) : null,
          esperando_ha_mais_de_24h: horas.filter((h) => h > 24).length, esperando_ha_mais_de_48h: horas.filter((h) => h > 48).length };
      };
      const porCanal = {}; for (const i of prontos) { const c = man[i].marketplace || 'outro'; porCanal[c] = (porCanal[c] || 0) + 1; }
      /* os conferidos dos últimos dias, pelo dia (de Brasília) da conferência */
      const de = somaDias(hoje, -(dias - 1));
      const porDia = {}; let semHoraDaNota = 0;
      for (const c of Object.values(conf)) {
        if (!c || typeof c !== 'object' || !c.conferido_em) continue;
        const tc = Date.parse(c.conferido_em); const d = diaSP(c.conferido_em);
        if (!d || d < de || d > hoje) continue;
        const a = porDia[d] || (porDia[d] = { dia: d, conferidos: 0, _h: [] });
        a.conferidos++;
        /* a hora da nota vem do Bling no horário de Brasília, sem fuso ("AAAA-MM-DD HH:MM:SS") */
        const m = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}(?::\d{2})?)/.exec(String(c.nf_emissao || ''));
        const tn = m ? Date.parse(m[1] + 'T' + (m[2].length === 5 ? m[2] + ':00' : m[2]) + '-03:00') : NaN;
        if (Number.isFinite(tn) && tn <= tc && (tc - tn) <= 60 * 86400000) a._h.push((tc - tn) / 3600000); else semHoraDaNota++;
      }
      const serie = Object.keys(porDia).sort().map((d) => { const a = porDia[d]; return { dia: d, conferidos: a.conferidos, com_hora_da_nota: a._h.length,
        horas_da_nota_ate_a_conferencia_mediana: a._h.length ? r2(mediana(a._h)) : null, levaram_mais_de_24h: a._h.filter((h) => h > 24).length, levaram_mais_de_48h: a._h.filter((h) => h > 48).length }; });
      const todasH = Object.values(porDia).reduce((acc, a) => acc.concat(a._h), []);
      return { agora: { esperando_conferencia: Object.assign(espera(prontos), { por_canal: porCanal }), sem_etiqueta: espera(semEtiqueta) },
        ultimos_dias: { de, ate: hoje, conferidos: serie.reduce((s, x) => s + x.conferidos, 0), dias_com_conferencia: serie.length,
          horas_da_nota_ate_a_conferencia_mediana: todasH.length ? r2(mediana(todasH)) : null, levaram_mais_de_24h: todasH.filter((h) => h > 24).length, levaram_mais_de_48h: todasH.filter((h) => h > 48).length,
          conferidos_sem_hora_da_nota: semHoraDaNota, por_dia: serie },
        leia: 'É a fila do GALPÃO desta loja: "esperando conferência" = pedido com etiqueta pronto pra ser conferido (bipado) e ainda não conferido; "sem etiqueta" = pedido liberado que ainda não tem etiqueta. A espera conta desde que o pedido chegou na fila do sistema. Nos últimos dias: quantos pedidos foram conferidos por dia e quantas horas se passaram entre a NOTA FISCAL e a conferência (horas corridas — fim de semana e feriado entram na conta). Dia que não aparece não teve conferência. A consulta cobre no máximo os últimos ' + DIAS_EXPEDICAO_MAX + ' dias (conferência mais antiga é apagada do arquivo do galpão): pra antes disso NÃO HÁ dado aqui — não conclua nada sobre a expedição de meses atrás. NÃO é o prazo de despacho do marketplace nem diz se o pedido foi postado com atraso: o atraso que o Mercado Livre conta está em reputacao_mercado_livre. Venda do Full não passa pelo galpão.',
        avisos: (semHoraDaNota ? [semHoraDaNota + ' pedido(s) conferido(s) no período estão sem a hora da nota: ficam fora da conta das horas (entram na contagem de conferidos).'] : [])
          .concat(Number(inp && inp.dias) > DIAS_EXPEDICAO_MAX ? ['Foram pedidos ' + Math.floor(Number(inp.dias)) + ' dias, mas o galpão só guarda as conferências dos últimos 30 dias (as já sincronizadas são apagadas depois disso): respondi os últimos ' + DIAS_EXPEDICAO_MAX + ', que estão inteiros. Não há como comparar com antes disso por esta consulta.'] : []) };
    },

    /* ── os anúncios da conta no Mercado Livre (15/11) ── */
    async anuncios_mercado_livre(inp) {
      if (typeof o.garantirTokenML !== 'function' || typeof o.fetch !== 'function') return { disponivel: false, motivo: 'esta loja não tem a conta do Mercado Livre ligada ao dashboard' };
      const r = await ANU.consultar({ fetch: o.fetch, garantirTokenML: o.garantirTokenML, prazoMs: o.prazoContaMs, prazoPedidoMs: o.prazoContaPedidoMs });
      const j = comFotos(ANU, r, inp, 'os anúncios do Mercado Livre');
      return { agora: r.ok ? r.resumo : null, nao_veio_agora: r.ok ? r.faltou : null, historico_guardado_desde: j.desde, janela: j.janela, o_que_mudou_na_janela: ANU.comparar(j.fotos), por_dia: espacadas(j.fotos).map(ANU.linhaDoDia),
        leia: 'Os anúncios da CONTA no Mercado Livre, como o próprio ML conta: o total e quantos estão em cada situação — "ativos", "pausados" (pausado pelo vendedor ou por falta de estoque), "inativos_por_pendencia_ou_infracao" (o ML tirou do ar por pendência ou por violar política), "encerrados" —; "por_motivo" são os códigos de motivo do ML pros parados (forbidden = proibido pelo ML; waiting_for_patch = o ML pediu correção e espera); "perdendo_exposicao" = anúncios que o ML marca como prejudicados na busca; "no_full_ativos" = anúncios ativos com envio pelo Full. "promocoes_abertas" são as campanhas e promoções ABERTAS pra conta (a que a loja pode ter entrado) — NÃO diz quais anúncios entraram em qual. É a conta inteira: dá QUANTOS, não QUAIS — não diz se um anúncio específico estava ativo. O ML só informa o AGORA; "o_que_mudou_na_janela" e "por_dia" vêm das fotos guardadas (uma por dia): número nulo = não informado naquele dia (não é zero), e "diferenca" nula = não dá pra dizer. "promocoes_que_entraram/sairam" só existem quando as duas fotos trazem a lista COMPLETA ("promocoes_comparaveis"); nulo = não dá pra dizer, não é "nada mudou".',
        avisos: j.avisos.concat(r.ok && r.resumo.a_soma_das_situacoes_bate_com_o_total === false ? ['A soma dos anúncios por situação não bate com o total que o Mercado Livre informou — use os números por situação com cuidado.'] : [])
          .concat(r.ok && r.faltou.length ? ['O Mercado Livre não respondeu a tudo agora — ficou sem: ' + r.faltou.map((f) => f.o_que + ' (' + f.motivo + ')').join('; ') + '. O que falta está nulo, não é zero.'] : []) };
    },

    /* ── a saúde da conta na Shopee (15/11) ── */
    async saude_conta_shopee(inp) {
      if (typeof o.pedirAoSync !== 'function') return { disponivel: false, motivo: 'esta loja não tem a Shopee ligada ao dashboard' };
      const r = await SAU.consultar({ pedirAoSync: o.pedirAoSync, prazoMs: o.prazoContaMs, prazoPedidoMs: o.prazoContaPedidoMs });
      const j = comFotos(SAU, r, inp, 'a saúde da conta na Shopee');
      const expira = r.ok && r.resumo.loja ? r.resumo.loja.autorizacao_do_app_vale_ate : null;
      const diasAteExpirar = expira ? Math.round((Date.parse(expira + 'T12:00:00Z') - Date.parse(hoje + 'T12:00:00Z')) / 86400000) : null;
      return { agora: r.ok ? r.resumo : null, nao_veio_agora: r.ok ? r.faltou : null, historico_guardado_desde: j.desde, janela: j.janela, o_que_mudou_na_janela: SAU.comparar(j.fotos),
        leia: 'A saúde da conta na Shopee, como a própria Shopee informa. "metricas": cada indicador com o valor atual, o do período anterior, a meta dela ("meta": comparador e valor) e "dentro_da_meta" — a comparação do valor atual com essa meta, feita aqui (nulo = sem valor ou sem meta pra comparar); "area" diz se é de envio, de anúncios ou de atendimento; "sub_metrica_de" = o indicador é um detalhe de outro. "reprovadas_por_area" é quantos indicadores a PRÓPRIA Shopee conta como reprovados em cada área. "nota_geral_codigo" é um código da Shopee cujo significado NÃO foi conferido no painel da loja — não traduza em "bom/ruim"; use as métricas. "lancamentos_de_penalidade" é quantos lançamentos o histórico de penalidades devolve — o TOTAL de pontos de penalidade a Shopee não entregou. "anuncios" = quantos anúncios ativos, desativados e banidos. A Shopee só informa o AGORA; "o_que_mudou_na_janela" vem das fotos guardadas (uma por dia): "diferenca" nula = não dá pra dizer. "sairam_da_meta"/"voltaram_pra_meta" só contam métrica com resultado conhecido nas DUAS fotos; as de "metricas_sem_estado_conhecido" não entram (não informou não é mudou). "fora_da_meta" vazio NÃO quer dizer "todas dentro": as de "sem_resultado_contra_a_meta" não têm resultado.',
        avisos: j.avisos.concat(r.ok && r.faltou.length ? ['A Shopee não respondeu a tudo agora — ficou sem: ' + r.faltou.map((f) => f.o_que + ' (' + f.motivo + ')').join('; ') + '. O que falta está nulo, não é zero.'] : [])
          .concat(diasAteExpirar != null && diasAteExpirar <= 30 ? ['A autorização do app na Shopee vale até ' + expira + ' (' + (diasAteExpirar < 0 ? 'JÁ VENCEU' : 'faltam ' + diasAteExpirar + ' dia(s)') + ') — sem renovar, as coletas da Shopee param.'] : []) };
    },

    /* ── um produto de perto (15/11) ── */
    async anuncios_do_item(inp) {
      const skus = PROD.skusPedidos(inp && inp.skus);
      if (!skus.length) throw new Error('diga os SKUs (de 1 a ' + PROD.MAX_SKUS + '); use buscar_item pra achar o SKU pelo nome');
      const dias = inteiroEntre(inp && inp.dias_de_visitas, PROD.DIAS_VISITAS, 1, PROD.DIAS_VISITAS_MAX);
      const temML = typeof o.garantirTokenML === 'function' && typeof o.fetch === 'function';
      const ml = temML ? await PROD.consultarML({ fetch: o.fetch, garantirTokenML: o.garantirTokenML, skus, diasVisitas: dias, hoje, prazoMs: o.prazoContaMs, prazoPedidoMs: o.prazoContaPedidoMs }) : { ok: false, erro: 'esta loja não tem a conta do Mercado Livre ligada ao dashboard' };
      const sh = await PROD.consultarShopee({ pedirAoSync: o.pedirAoSync, skus, prazoMs: o.prazoContaMs, prazoPedidoMs: o.prazoContaPedidoMs });   /* (sem a peça, ela mesma diz) */
      const avisos = [];
      if (!ml.ok) avisos.push('Mercado Livre: não consegui ler (' + ml.erro + ').');
      if (!sh.ok) avisos.push('Shopee: não consegui ler (' + sh.erro + ').');
      for (const [canal, r] of [['Mercado Livre', ml], ['Shopee', sh]]) if (r.ok) for (const p of r.por_sku) {
        if (p.anuncios_encontrados === 0) avisos.push(canal + ': nenhum anúncio com o SKU "' + p.sku + '" (o SKU do anúncio pode ser outro — confira com buscar_item ou pelo painel).');
        else if (p.anuncios_encontrados == null) avisos.push(canal + ': não deu pra saber se há anúncio com o SKU "' + p.sku + '" (a busca não respondeu — veja o que faltou).');
        else if (p.busca_incompleta) avisos.push(canal + ': do SKU "' + p.sku + '" só uma das duas buscas respondeu — pode haver anúncio a mais do que os ' + p.anuncios_encontrados + ' vistos.');
        else if (p.anuncios_encontrados != null && p.anuncios_encontrados > p.anuncios_lidos) avisos.push(canal + ': o SKU "' + p.sku + '" tem ' + (p.contagem_exata === false ? 'pelo menos ' : '') + p.anuncios_encontrados + ' anúncios; li os ' + p.anuncios_lidos + ' primeiros.');
        if (p.faltou.length) avisos.push(canal + ', SKU "' + p.sku + '": não veio ' + p.faltou.map((f) => f.o_que + ' (' + f.motivo + ')').join('; ') + ' — o que falta está nulo, não é zero.');
      }
      if ((Array.isArray(inp && inp.skus) ? inp.skus.length : 0) > PROD.MAX_SKUS) avisos.push('Foram pedidos ' + inp.skus.length + ' SKUs; li os ' + PROD.MAX_SKUS + ' primeiros.');
      return { skus, mercado_livre: ml.ok ? { dias_de_visitas: ml.dias_de_visitas, por_sku: ml.por_sku } : null, shopee: sh.ok ? { por_sku: sh.por_sku } : null,
        leia: 'Como cada anúncio do SKU está AGORA (não no dia da venda). Mercado Livre: "situacao" (active/paused/closed) e "sub_situacao"; "estoque_anunciado" é o que o anúncio mostra; "estoque_por_local" separa "galpao" (seu estoque) de "full" (o estoque no Full do ML) — "full" nulo com "tem_linha_do_full" false = o produto NÃO está no Full; "variacoes" trazem SKU, estoque e vendidos de cada uma (anúncio com variação: o estoque está nelas). "visitas.por_dia" só traz os dias que o ML listou — dia que não aparece é sem dado, não zero. "promocoes.participando" = está na promoção; "pode_entrar" = o ML oferece, o anúncio NÃO entrou. "qualidade.nota" é 0–100 e "pendencias" é o que o ML diz que falta. "product_ads.em_campanha" false = o anúncio não está em campanha de Ads; nulo = não deu pra ler. Shopee: "estoque.galpao" × "estoque.full_shopee" (por centro); "acumulado" são totais desde sempre (a Shopee não dá por dia); "rebaixado_na_busca" true = a Shopee está rebaixando o anúncio; "promocoes_como_a_shopee_mandou" é a resposta crua (formato de promoção ativa ainda não conferido). "anuncios_encontrados" nulo = a busca não respondeu (não se sabe se há anúncio); "busca_incompleta" true = só uma das duas buscas respondeu (pode haver anúncio a mais); "contagem_exata" false = o número de anúncios é um PISO ("pelo menos") — as buscas paginam. Tudo que veio nulo é "não informado".',
        avisos };
    },
  };

  /* o que as duas consultas de "conta" têm em comum: gravar a foto de hoje (se leu), ler as fotos da janela e dizer o
     que o histórico NÃO cobre. `LIB`: a peça que lê (anuncios-ml ou saude-shopee) — as duas guardam fotos do mesmo jeito */
  function comFotos(LIB, r, inp, deQue) {
    const dias = inteiroEntre(inp && inp.dias, DIAS_CONTA, 1, DIAS_CONTA_MAX);
    const cx = { CACHE_DIR: o.CACHE_DIR, readJson: o.readJson, writeJson: o.writeJson };
    const gravou = r.ok ? LIB.fotografar(Object.assign({ dia: hoje, resumo: r.resumo, em: new Date(agora()).toISOString() }, cx)) : null;
    const fotos = LIB.historico(Object.assign({ de: somaDias(hoje, -dias), ate: hoje }, cx));
    const todas = LIB.historico(Object.assign({ de: '0000-00-00', ate: '9999-99-99' }, cx));
    const avisos = [];
    if (!r.ok) avisos.push('Não consegui ler ' + deQue + ' AGORA (' + r.erro + ') — o que segue é só o histórico guardado.');
    if (gravou === false) avisos.push('Li ' + deQue + ', mas não consegui guardar a foto de hoje (o disco recusou): o histórico fica sem este dia.');
    if (!todas.length) avisos.push('Ainda não há nenhuma foto guardada de ' + deQue + '.');
    else if (fotos.length < 2) avisos.push('O histórico de ' + deQue + ' começa em ' + todas[0].dia + ' (uma foto por dia, a partir de quando esta consulta entrou no ar): não dá pra dizer o que mudou antes disso.');
    return { fotos, desde: todas.length ? todas[0].dia : null, janela: { de: somaDias(hoje, -dias), ate: hoje, fotos: fotos.length }, avisos };
  }
  /* janela longa: a primeira foto, a última e as do meio espaçadas — o modelo não precisa de 365 linhas */
  function espacadas(fotos) {
    if (fotos.length <= MAX_PONTOS_DE_FOTO) return fotos;
    const passo = Math.ceil(fotos.length / MAX_PONTOS_DE_FOTO);
    return fotos.filter((f, i) => i === 0 || i === fotos.length - 1 || i % passo === 0);
  }
  return { F };
}

/* o saldo de UM item no Bling — a mesma busca do Plano de Compra (lib/checkout/fabrica-rotas-painel.js): pelo código,
   e o detalhe do produto quando a busca não traz o saldo. { saldo, nome } | null */
async function saldoNoBling(blingGet, sku, dorme, sinal) {
  /* `sinal` (opcional): o 3º parâmetro do `blingGet` de produção cancela a conexão de verdade quando o prazo estoura */
  const rb = await blingGet('/produtos?codigo=' + encodeURIComponent(sku) + '&criterio=5&limite=1', 3, sinal);
  const it = (rb && rb.ok && rb.data && rb.data.data && rb.data.data[0]) || null;
  if (!it) return null;
  const sv = (e) => (e ? (e.saldoVirtualTotal != null ? e.saldoVirtualTotal : e.saldoFisicoTotal) : null);
  let saldo = sv(it.estoque);
  if (saldo == null && it.id != null) {
    await dorme(PAUSA_BLING_MS);
    if (sinal && sinal.aborted) return null;
    const dd = await blingGet('/produtos/' + it.id, 3, sinal);
    const det = (dd && dd.ok && dd.data && dd.data.data) || null;
    saldo = det ? sv(det.estoque) : null;
  }
  return (saldo != null && Number.isFinite(Number(saldo))) ? { saldo: Number(saldo), nome: it.nome || null } : null;
}

const FERRAMENTAS = [
  { name: 'gasto_anuncios',
    description: 'Anúncios pagos (Ads) num período: o consumo de Ads da Shopee por dia (com impressões, cliques, pedidos e vendas atribuídos, ROAS) e a publicidade do Mercado Livre lançada na fatura por dia. Use quando a pergunta envolver anúncio/Ads, ou pra checar se uma queda ou alta de vendas coincide com mudança no gasto de anúncio. Não diz quais anúncios ou campanhas estavam ativos.',
    input_schema: { type: 'object', properties: { de: { type: 'string', description: 'primeiro dia, AAAA-MM-DD' }, ate: { type: 'string', description: 'último dia (incluído), AAAA-MM-DD' } }, required: ['de', 'ate'] } },
  { name: 'reputacao_mercado_livre',
    description: 'A reputação da conta no Mercado Livre AGORA (nível/cor do termômetro, medalha de MercadoLíder, reclamações, atraso no despacho e cancelamentos, com quantidade e taxa) e o que mudou desde as fotos guardadas (uma por dia). Use quando a pergunta for sobre reputação, atraso de envio, reclamação — ou pra checar se uma queda no Mercado Livre coincide com piora da reputação.',
    input_schema: { type: 'object', properties: { dias: { type: 'integer', description: 'quantos dias de histórico olhar (padrão ' + DIAS_REPUTACAO + ', máximo ' + DIAS_REPUTACAO_MAX + ')' } }, required: [] } },
  { name: 'estoque_atual',
    description: 'O saldo de estoque no Bling, AGORA, de até ' + MAX_SKUS + ' itens (por SKU). Use pra checar se um item que caiu de venda está sem estoque hoje. É o saldo de agora — não o do dia da venda —, e não diz se o anúncio estava ativo nem o estoque do Full. Peça só os itens que importam pra pergunta.',
    input_schema: { type: 'object', properties: { skus: { type: 'array', minItems: 1, maxItems: MAX_SKUS, items: { type: 'string' }, description: 'os SKUs (use buscar_item pra achar o SKU pelo nome)' } }, required: ['skus'] } },
  { name: 'expedicao_do_galpao',
    description: 'A expedição do galpão desta loja: quantos pedidos estão esperando conferência AGORA (e há quanto tempo o mais antigo espera) e, nos últimos dias, quantos foram conferidos por dia e quantas horas levaram entre a nota fiscal e a conferência. Use quando a pergunta for sobre atraso na expedição, fila, pedido parado.',
    input_schema: { type: 'object', properties: { dias: { type: 'integer', description: 'quantos dias pra trás (padrão ' + DIAS_EXPEDICAO + ', máximo ' + DIAS_EXPEDICAO_MAX + ')' } }, required: [] } },
  { name: 'anuncios_mercado_livre',
    description: 'Os anúncios da conta no Mercado Livre AGORA: o total e quantos estão ativos, pausados, inativos por pendência ou infração, perdendo exposição e no Full, mais as promoções/campanhas abertas pra conta — e o que mudou desde as fotos guardadas (uma por dia). Use quando a pergunta for sobre anúncios pausados/inativos, ou pra checar se uma queda no Mercado Livre coincide com queda no número de anúncios ativos. É a conta inteira: dá QUANTOS, não QUAIS — não diz se um anúncio específico estava ativo.',
    input_schema: { type: 'object', properties: { dias: { type: 'integer', description: 'quantos dias de histórico olhar (padrão ' + DIAS_CONTA + ', máximo ' + DIAS_CONTA_MAX + ')' } }, required: [] } },
  { name: 'saude_conta_shopee',
    description: 'A saúde da conta na Shopee AGORA: cada indicador (envio atrasado, cancelamento, resposta do chat, nota da loja…) com o valor, a meta da Shopee e se está dentro dela; quantos indicadores a Shopee reprova por área; penalidades, punições em andamento, anúncios com problema e quantos anúncios ativos/desativados/banidos — e o que mudou desde as fotos guardadas (uma por dia). Use quando a pergunta for sobre a conta da Shopee, ou pra checar se uma queda na Shopee coincide com piora da conta.',
    input_schema: { type: 'object', properties: { dias: { type: 'integer', description: 'quantos dias de histórico olhar (padrão ' + DIAS_CONTA + ', máximo ' + DIAS_CONTA_MAX + ')' } }, required: [] } },
  { name: 'anuncios_do_item',
    description: 'UM produto de perto, por SKU, nos marketplaces AGORA: os anúncios dele no Mercado Livre (ativo/pausado, estoque anunciado e por local — galpão × Full —, cada variação com estoque, visitas por dia, promoções em que está ou pode entrar, nota de qualidade e pendências, se está em campanha de Product Ads) e na Shopee (situação, estoque galpão × Full da Shopee, vendas/visitas/nota acumuladas, promoções). Use quando a pergunta for sobre UM item que caiu ou sumiu — "o anúncio está ativo? tem estoque no Full? está em promoção? está em Ads?". É o estado de AGORA, não o do dia da venda. Até ' + PROD.MAX_SKUS + ' SKUs por vez; peça só os que importam (cada anúncio são várias idas ao marketplace).',
    input_schema: { type: 'object', properties: { skus: { type: 'array', minItems: 1, maxItems: PROD.MAX_SKUS, items: { type: 'string' }, description: 'os SKUs (use buscar_item pra achar o SKU pelo nome)' }, dias_de_visitas: { type: 'integer', description: 'quantos dias de visitas por dia no ML (padrão ' + PROD.DIAS_VISITAS + ', máximo ' + PROD.DIAS_VISITAS_MAX + ')' } }, required: ['skus'] } },
];

function descrever(nome, inp) {
  const br = (iso) => (typeof iso === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(iso) ? iso.slice(8, 10) + '/' + iso.slice(5, 7) : '?');
  inp = inp || {};
  if (nome === 'gasto_anuncios') return 'Olhando os anúncios pagos de ' + br(inp.de) + ' a ' + br(inp.ate);
  if (nome === 'reputacao_mercado_livre') return 'Consultando a reputação no Mercado Livre';
  if (nome === 'estoque_atual') return 'Consultando o estoque de ' + (Array.isArray(inp.skus) ? Math.min(MAX_SKUS, inp.skus.length) : '?') + ' item(ns)';
  if (nome === 'expedicao_do_galpao') return 'Olhando a expedição do galpão';
  if (nome === 'anuncios_mercado_livre') return 'Olhando os anúncios da conta no Mercado Livre';
  if (nome === 'saude_conta_shopee') return 'Consultando a saúde da conta na Shopee';
  if (nome === 'anuncios_do_item') return 'Olhando os anúncios de ' + (Array.isArray(inp.skus) ? Math.min(PROD.MAX_SKUS, inp.skus.length) : '?') + ' item(ns) nos marketplaces';
  return null;
}

/* o que estas consultas acrescentam às regras do chat */
const REGRAS = [
  'OUTROS OLHOS. Além das vendas você pode consultar: os anúncios pagos por dia (gasto_anuncios — Shopee e Mercado Livre), a reputação da conta no Mercado Livre (reputacao_mercado_livre — nível, medalha, reclamações, atraso no despacho, cancelamentos, e o que mudou), os anúncios da conta no Mercado Livre (anuncios_mercado_livre — quantos ativos, pausados, inativos por pendência ou infração, perdendo exposição e no Full, as promoções abertas, e o que mudou), a saúde da conta na Shopee (saude_conta_shopee — os indicadores contra a meta, penalidades, punições, e o que mudou), o estoque de hoje no Bling (estoque_atual), a expedição do galpão (expedicao_do_galpao) e UM produto de perto nos marketplaces (anuncios_do_item — por SKU: anúncio ativo ou pausado, estoque no galpão e no Full, variações, visitas, promoções, qualidade, Ads). Quando a pergunta for "por que caiu/subiu", CONSULTE o que fizer sentido antes de responder (anúncio do canal que caiu; reputação e anúncios da conta se a queda foi no Mercado Livre; saúde da conta se foi na Shopee; estoque dos itens que mais caíram; anuncios_do_item pros 1–3 itens que mais caíram; expedição se houver suspeita de atraso) — sem exagero: só o que ajuda a responder.',
  'O QUE ESSES DADOS PROVAM. Eles mostram COINCIDÊNCIA, não causa: "o consumo de Ads da Shopee caiu de X pra Y nos mesmos dias" é fato; "a venda caiu POR CAUSA disso" é hipótese — diga assim. Estoque é o de HOJE: item zerado hoje é fato, "estava zerado no dia" é hipótese. Leia o campo "leia" de cada consulta: ele diz o que o número é e o que NÃO é. Dia "sem dado" não é zero. Os anúncios do Mercado Livre e a saúde da Shopee são da CONTA inteira; anuncios_do_item é UM produto, mas AGORA: "o anúncio está pausado hoje" é fato; "estava pausado no dia da queda" é hipótese (não há foto por anúncio). Você continua SEM enxergar: cupom, preço de concorrente, em que dia uma promoção começou pra aquele item, e a reputação de outros canais (Magalu, TikTok) — isso só como coisa a conferir.',
];

module.exports = { criarOlhos, FERRAMENTAS, descrever, REGRAS, saldoNoBling, publicidadeDaFaturaML, MAX_SKUS, MAX_AO_VIVO, SALDO_VELHO_H, PRAZO_ESTOQUE_MS, DIAS_EXPEDICAO, DIAS_EXPEDICAO_MAX, DIAS_REPUTACAO, DIAS_CONTA, DIAS_CONTA_MAX, MAX_PONTOS_DE_FOTO };
