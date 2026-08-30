'use strict';

/**
 * lib/tiktok-custo-devolucoes.js — o CUSTO das devoluções do TikTok num período (29/08).
 *
 * É a peça que o dashboard consome. Junta as três partes que hoje ninguém soma:
 *   1. IMPACTO NO EXTRATO — reembolso parcial, débito de mediação, estorno. Vem do
 *      desfecho por pedido (nunca do valor da tela, que é o reembolso ao cliente e difere:
 *      no caso real, tela R$ 36,00 × extrato R$ 41,01).
 *   2. FRETE DE DEVOLUÇÃO PAGO PELA LOJA — a API sempre mandou e nós não líamos.
 *   3. COMPENSAÇÃO recebida do TikTok — entra como CRÉDITO, senão o custo fica inflado.
 *
 * Regras herdadas do que aprendemos hoje: agrupa por PEDIDO (solicitações repetidas não
 * contam duas vezes); solicitação cancelada não vira custo; pedido sem lançamento fica
 * PENDENTE e não é somado como zero.
 */

const { desfechoDoPedido } = require('./tiktok-desfecho');
const r2 = v => Math.round((Number(v) || 0) * 100) / 100;
const CANCELADA = /CANCEL/i;

function custoNoPeriodo(cacheDevolucoes, cacheFinanceiro, deTs, ateTs) {
  const devs = (cacheDevolucoes && cacheDevolucoes.devolucoes) || {};
  const fin = (cacheFinanceiro && cacheFinanceiro.pedidos) || {};
  const ini = Number(deTs) || 0;
  const fim = Number(ateTs) || Math.floor(Date.now() / 1000);

  const porPedido = Object.create(null);
  let canceladas = 0, foraDoPeriodo = 0;
  for (const d of Object.values(devs)) {
    if (!d || !d.order_id) continue;
    /* a data que importa é a do EVENTO financeiro; sem ela, a criação da devolução */
    const t = Number((d.eventos && (d.eventos.revelia_em || d.eventos.reembolsado_em)) || d.criado_em) || 0;
    if (!(t >= ini && t <= fim)) { foraDoPeriodo++; continue; }
    if (CANCELADA.test(String(d.status || ''))) { canceladas++; continue; }
    const oid = String(d.order_id);
    /* frete é POR SOLICITAÇÃO (duas caixas = dois fretes), mas fica ACUMULADO POR PEDIDO
       porque a decisão de contá-lo depende do extrato daquele pedido — ver abaixo. */
    if (!porPedido[oid]) porPedido[oid] = { frete: 0 };
    porPedido[oid].frete = r2(porPedido[oid].frete + (Number(d.frete_devolucao_vendedor) || 0));
  }

  let debito = 0, credito = 0, pendentes = 0, freteLoja = 0, freteJaNoExtrato = 0, custoDeVendaAnterior = 0;
  const detalhe = [];
  for (const oid of Object.keys(porPedido)) {
    const freteDoPedido = porPedido[oid].frete || 0;
    const reg = fin[oid];
    /* Codex #287 r2: o impacto vinha do extrato SEM olhar a data — um débito de outro mês
       entrava no total do período pedido. O registro tem `liquidado_em`; quando ele existe e
       cai fora da janela, o pedido conta como fora, não como custo deste período. */
    /* Codex #287 r3: liquidado_em é da VENDA ORIGINAL — o coletor o mantém mesmo quando o
       estorno posterior entra em ajustes_depois. Filtrar por ele excluiria o caso mais comum
       (venda liquidada em julho, devolução debitada em agosto), que é justamente o que este
       relatório existe pra mostrar. Então: quando há ajuste posterior, quem manda é a data
       do EVENTO da devolução (já filtrada acima); o liquidado_em só descarta quando NÃO há
       ajuste — aí o impacto é da própria venda e pertence ao período dela. */
    const temAjustePosterior = !!(reg && Number(reg.ajustes_depois || 0) !== 0);
    const liq = reg ? Number(reg.liquidado_em || 0) : 0;
    if (reg && liq && !temAjustePosterior && !(liq >= ini && liq <= fim)) { foraDoPeriodo++; continue; }
    const desf = reg ? desfechoDoPedido(reg) : null;
    if (!desf) {
      pendentes++;
      /* Codex #287: o LANÇAMENTO está pendente, mas o frete já é conhecido e já saiu do
         bolso — deixá-lo de fora subestima o custo do período. Entra; quando o extrato cair
         com débito, a regra acima passa a considerá-lo embutido e não haverá dobra. */
      if (freteDoPedido > 0) freteLoja = r2(freteLoja + freteDoPedido);
      detalhe.push({ order_id: oid, situacao: 'sem_lancamento', impacto: null, frete: freteDoPedido });
      continue;
    }
    const imp = Number(desf.impacto || 0);
    if (imp < 0) debito = r2(debito + imp);
    if (imp > 0) credito = r2(credito + imp);
    /* 29/08 — NÃO CONTAR O FRETE DUAS VEZES. O extrato do pedido 584628284730475569 mostrou
       o débito de R$ 276,70 composto por frete (R$ 226,70, dos quais R$ 153,70 de devolução)
       + taxa (R$ 50): ou seja, quando HÁ débito no extrato, o frete de devolução JÁ ESTÁ
       DENTRO dele. Somar o campo da API por cima dobraria o custo. O frete só entra quando
       o pedido NÃO teve débito — aí é custo que ninguém contou. */
    /* Codex #287 (P1): impacto negativo NÃO implica frete embutido. Em 'reversao_total' o
       impacto é a NEGAÇÃO do repasse da venda original — não vem da transação de estorno e
       portanto não contém o frete de devolução; ali o frete é custo à parte. Só o
       'debito_estorno'/'debito_ajuste' vem do lançamento negativo real, que é o caso do
       macaco (R$ 276,70 já com R$ 153,70 de frete dentro). */
    /* Codex #287 r2: quando o próprio registro traz o componente de frete de devolução
       (frete_devolucao), use-o pra decidir — é o dado, não a inferência pelo tipo. */
    /* Codex #287 r3: o coletor SEMPRE grava frete_devolucao (inclusive 0). Zero explícito
       significa que o lançamento não tem frete dentro — nesse caso o frete da API é custo
       à parte e o fallback por tipo não pode passar por cima do dado. */
    const temCampoFrete = !!(reg && reg.frete_devolucao != null);
    const freteNoRegistro = Number((reg && reg.frete_devolucao) || 0);
    const debitoTemFrete = temCampoFrete
      ? freteNoRegistro > 0
      : (desf.desfecho === 'debito_estorno' || desf.desfecho === 'debito_ajuste' || desf.desfecho === 'reembolso_parcial');
    if (freteDoPedido > 0) {
      if (imp < 0 && debitoTemFrete) freteJaNoExtrato = r2(freteJaNoExtrato + freteDoPedido);
      else freteLoja = r2(freteLoja + freteDoPedido);
    }
    /* 30/08 (apontado pela conversa do Devoluções): receita <= 0 com débito significa que
       a VENDA ORIGINAL ficou fora da janela coletada — só o estorno entrou. O custo em si
       está certo (contamos o lançamento negativo, não a diferença), MAS o mês fica torto:
       a venda entrou no faturamento de um período e o estorno cai em outro. Marcamos o caso
       pra tela poder dizer 'este custo é de venda anterior ao período'. */
    const vendaForaDaJanela = imp < 0 && Number(desf.receita || 0) <= 0;
    if (vendaForaDaJanela) custoDeVendaAnterior = r2(custoDeVendaAnterior + imp);
    if (imp !== 0 || freteDoPedido > 0) detalhe.push({ order_id: oid, situacao: desf.desfecho, impacto: imp, frete: freteDoPedido, frete_ja_no_debito: imp < 0 && freteDoPedido > 0, venda_fora_da_janela: vendaForaDaJanela });
  }
  detalhe.sort((a, b) => (a.impacto == null ? 1 : b.impacto == null ? -1 : a.impacto - b.impacto));

  const custoTotal = r2(Math.abs(debito) + freteLoja - credito);
  return {
    periodo: { de: ini, ate: fim },
    pedidos_afetados: Object.keys(porPedido).length,
    solicitacoes_canceladas_ignoradas: canceladas,
    fora_do_periodo: foraDoPeriodo,
    debito_extrato: debito,                       // negativo — JÁ inclui o frete quando houve débito
    frete_devolucao_loja: freteLoja,              // positivo — só de pedidos SEM débito, pra não dobrar
    frete_ja_embutido_no_debito: freteJaNoExtrato, // informativo: quanto do débito é frete de devolução
    compensacao_recebida: credito,     // positivo (crédito)
    custo_total: custoTotal,           // o número que vai pro dashboard
    /* quanto do custo é de venda que NÃO está neste período (estorno tardio). O total
       fecha no acumulado, mas o mês isolado precisa saber disso pra não parecer pior
       do que foi — e o mês da venda parecia melhor do que foi, na mesma proporção. */
    custo_de_venda_anterior: custoDeVendaAnterior,
    pedidos_sem_lancamento: pendentes, // ainda vai cair: nem zero, nem custo
    detalhe: detalhe.slice(0, 100),
  };
}

/* ── 30/08: a MESMA rota estava copiada na Girassol e na AMB, e a review do #291 achou 5
   defeitos que existiam nas DUAS. Em vez de consertar duas vezes (e divergir na terceira),
   a montagem inteira vira função de lib: os módulos só dizem qual loja e qual período. */
function responderCusto(opcoes) {
  const fs = require('fs'), path = require('path');
  const o = opcoes || {};
  const loja = String(o.loja || '').toLowerCase();
  const CACHE = process.env.TIKTOK_CACHE_DIR || '/data';
  const ler = (a) => { try { return JSON.parse(fs.readFileSync(a, 'utf8')); } catch (e) { return null; } };
  const dev = ler(path.join(CACHE, '_tiktok_devolucoes_' + loja + '.json'));
  const fin = ler(path.join(CACHE, '_tiktok_financeiro_' + loja + '.json'));

  /* Codex #291 (P1): array passa por typeof 'object' — {} ou [] viravam "custo zero" com
     cara de resposta boa. Exige objeto NÃO-array com pelo menos a chave certa. */
  const mapaOk = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
  const faltando = [];
  if (!mapaOk(dev) || !mapaOk(dev.devolucoes)) faltando.push('devoluções');
  if (!mapaOk(fin) || !mapaOk(fin.pedidos)) faltando.push('financeiro');
  if (faltando.length) {
    return { http: 200, corpo: { ok: false, indisponivel: 'cache de ' + faltando.join(' e ') + ' ausente ou inválido — rode as coletas do TikTok de ' + loja, custo_total: null } };
  }

  /* Codex #291: data sintaticamente válida mas INEXISTENTE (2026-02-31) o JS normaliza pra
     03/03 e a resposta sairia certa pra outro período. Confere se o dia sobreviveu. */
  function tsDe(txt, fimDoDia) {
    if (!txt) return null;
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(txt).trim());
    if (!m) return NaN;
    const [_, A, M, D] = m;
    const d = new Date(Number(A), Number(M) - 1, Number(D));
    if (d.getFullYear() !== Number(A) || d.getMonth() !== Number(M) - 1 || d.getDate() !== Number(D)) return NaN;
    return Math.floor(Date.parse(txt + (fimDoDia ? 'T23:59:59-03:00' : 'T00:00:00-03:00')) / 1000);
  }
  const iniPedido = tsDe(o.de, false), fimPedido = tsDe(o.ate, true);
  if (Number.isNaN(iniPedido) || Number.isNaN(fimPedido)) {
    return { http: 400, corpo: { ok: false, erro: 'data inexistente ou fora do formato — use ?de=AAAA-MM-DD&ate=AAAA-MM-DD', custo_total: null } };
  }
  const ini = iniPedido != null ? iniPedido : Math.floor((Date.now() - 30 * 86400000) / 1000);
  const fim = fimPedido != null ? fimPedido : Math.floor(Date.now() / 1000);
  if (!isFinite(ini) || !isFinite(fim) || ini > fim) {
    return { http: 400, corpo: { ok: false, erro: 'período inválido — use ?de=AAAA-MM-DD&ate=AAAA-MM-DD', custo_total: null } };
  }

  /* Codex #291: idade da coleta tem que olhar as DUAS — se o financeiro parou e as
     devoluções continuam, a resposta parecia fresca. Vale a mais velha. */
  const tDev = dev.atualizado ? Date.parse(dev.atualizado) : null;
  const tFin = fin.atualizado ? Date.parse(fin.atualizado) : null;
  const maisVelha = [tDev, tFin].filter(x => x).sort((a, b) => a - b)[0] || null;
  const horas = maisVelha ? Math.round((Date.now() - maisVelha) / 3600000) : null;

  const r = custoNoPeriodo(dev, fin, ini, fim);

  /* Codex #291: período ANTERIOR ao que foi coletado devolvia total com cara de completo,
     contando só o que por acaso caiu na janela. Avisa que é parcial. */
  let coberturaDesde = null;
  for (const d of Object.values(dev.devolucoes)) {
    const t = Number(d && d.criado_em) || 0;
    if (t && (!coberturaDesde || t < coberturaDesde)) coberturaDesde = t;
  }
  const parcial = !!(coberturaDesde && ini < coberturaDesde);

  return { http: 200, corpo: Object.assign({
    ok: true,
    cache_atualizado_em: dev.atualizado || null,
    horas_desde_a_coleta: horas,
    periodo_parcial: parcial,
    coberto_desde: coberturaDesde ? new Date(coberturaDesde * 1000).toISOString().slice(0, 10) : null,
  }, r) };
}

module.exports = { custoNoPeriodo, responderCusto };
