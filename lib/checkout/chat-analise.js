'use strict';

/* ─────────────────────────────────────────────────────────────────────────────
   CHAT DE ANÁLISE DO DASHBOARD (14/11/2026) — peça única, as três empresas (e a próxima).

   Pedido do dono: "tem alguma forma de incluirmos um botão de chat Claude dentro do dashboard de cada loja? … eu
   pergunto qual item teve maior queda nas vendas nos últimos 3 meses, ou por que poderia ter diminuído meu faturamento
   da semana retrasada pra última semana".

   COMO FUNCIONA
     · o botão do dashboard (lib/checkout/painel-chat-analise.js) manda a pergunta pra rota `<prefixo>/chat-analise`;
     · esta peça entrega a pergunta ao Claude (API da Anthropic) junto com uma lista de CONSULTAS que ele pode pedir;
     · o Claude escolhe as consultas, ESTA PEÇA as executa e devolve o resultado, e ele escreve a análise.

   A REGRA QUE DEFINE A PEÇA — NENHUM NÚMERO SAI "DA CABEÇA" DA IA.
     Toda consulta é respondida pelo MESMO agregado que o dashboard mostra (o `/historico-longo` de produção, chamado
     por dentro — `consultarHistorico`), e toda conta (diferença, %, ranking, preço médio, efeito de volume × preço, as
     datas de "semana passada") é feita AQUI, em código. O modelo só escolhe o que consultar e interpreta. Número
     errado é pior que número ausente: o que o dado não cobre vira AVISO na resposta da consulta (período truncado,
     unidade sem custo, dia de hoje ainda aberto), e o que não existe vem como "não disponível", nunca como zero.

   O QUE VAI PRA API: a pergunta do dono e agregados de venda (SKU, descrição do produto, canal, valores). NADA de
     cliente — nome, CPF, endereço e número de pedido não saem daqui.

   QUEM USA: só admin (a chave de admin ou sessão de admin), como o resto do dashboard.

   SÓ LEITURA: a consulta do chat não dispara a busca de custo no Bling (lib/checkout/historico.js sabe que a chamada
     veio por dentro) e não grava nada além do contador de uso do dia. Se quem perguntou fecha a tela, a peça para de
     consultar e de chamar o modelo; enquanto uma consulta demora, manda um sinal de vida pra conexão não cair.

   CUSTO: a API é cobrada por uso. Cada resposta devolve os tokens gastos (e a estimativa em dólar quando o preço do
     modelo é conhecido — modelo desconhecido mostra só os tokens, sem inventar preço); há teto de perguntas por dia
     (DASHBOARD_CHAT_MAX_DIA, padrão 200 por empresa) e de consultas por pergunta. O teto de GASTO de verdade é o do
     workspace da chave, no Console da Anthropic.

   ENVS: ANTHROPIC_API_KEY_DASHBOARD_CHAT (a chave; sem ela a rota responde "não configurado" e não chama nada),
         DASHBOARD_CHAT_MODELO (padrão claude-sonnet-5-5), DASHBOARD_CHAT_MAX_DIA.
   ───────────────────────────────────────────────────────────────────────────── */

const ENV_CHAVE = 'ANTHROPIC_API_KEY_DASHBOARD_CHAT';
const MODELO_PADRAO = 'claude-sonnet-5-5';
const API_URL = 'https://api.anthropic.com/v1/messages';
const API_VERSAO = '2023-06-01';
/* US$ por MILHÃO de tokens (tabela pública de preços, lida em 14/11/2026; prompts até 100 mil tokens). Só serve pra
   ESTIMATIVA mostrada na tela — modelo fora da tabela não ganha preço inventado. */
const PRECO_USD_MTOK = {
  'claude-sonnet-5-5': { entrada: 2, saida: 10 },
  'claude-haiku-5-5': { entrada: 0.10, saida: 0.50 },
  'claude-opus-5-5': { entrada: 4, saida: 20 },
};
const MAX_RODADAS = 8;            /* idas e voltas com consultas numa pergunta */
const MAX_TOKENS_ENTRADA_PERGUNTA = 250000;   /* a cada ida a conversa inteira é reenviada: passou disto, para (teto de custo de UMA pergunta) */
const BATIMENTO_MS = 15000;       /* enquanto consulta, manda um sinal de vida — conexão muda por muito tempo é cortada no caminho */
const PRAZO_API_MS = 180000;      /* a API que aceita a conexão e nunca responde não pode prender a pergunta pra sempre */
const MAX_PONTOS_POR_DIA = 92;    /* evolução dia a dia só até ~3 meses; acima disso agrupa por semana (o resultado vai inteiro pro modelo) */
const MAX_TOKENS_RESPOSTA = 2500;
const MAX_DIAS_PERIODO = 400;
const MAX_PERGUNTA = 2000;        /* caracteres */
const MAX_HISTORICO = 12;         /* mensagens anteriores que voltam pro modelo */
const MAX_CORPO = 64 * 1024;
const TZ = 'America/Sao_Paulo';

const r2 = (v) => Math.round(Number(v) * 100) / 100;
const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const pct = (parte, todo) => (todo > 0 ? r2((parte / todo) * 100) : null);
const variacao = (a, b) => ({ antes: r2(a), depois: r2(b), diferenca: r2(b - a), diferenca_pct: a > 0 ? r2(((b - a) / a) * 100) : null });

/* ── datas (sempre em código: "semana retrasada" calculada pelo modelo é número errado esperando pra acontecer) ── */
function hojeSP(agora) { return new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(agora || new Date()); }
function somaDias(iso, n) { const d = new Date(iso + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
function diasEntre(de, ate) { return Math.round((Date.parse(ate + 'T12:00:00Z') - Date.parse(de + 'T12:00:00Z')) / 86400000) + 1; }
function diaDaSemana(iso) { return new Date(iso + 'T12:00:00Z').getUTCDay(); }   /* 0 = domingo */
const NOME_DIA = ['domingo', 'segunda-feira', 'terça-feira', 'quarta-feira', 'quinta-feira', 'sexta-feira', 'sábado'];
function fimDoMes(anoMes) { const [a, m] = anoMes.split('-').map(Number); return new Date(Date.UTC(a, m, 0, 12)).toISOString().slice(0, 10); }
function mesAnterior(anoMes, n) { const [a, m] = anoMes.split('-').map(Number); const d = new Date(Date.UTC(a, m - 1 - n, 1, 12)); return d.toISOString().slice(0, 7); }

/* os períodos que as pessoas pedem pelo nome, já calculados. Semana = segunda a domingo. */
function periodosNomeados(hoje) {
  const dow = diaDaSemana(hoje);
  const segDestaSemana = somaDias(hoje, -((dow + 6) % 7));
  const ultSeg = somaDias(segDestaSemana, -7), retSeg = somaDias(segDestaSemana, -14);
  const mesAtual = hoje.slice(0, 7), m1 = mesAnterior(mesAtual, 1), m3 = mesAnterior(mesAtual, 3), m6 = mesAnterior(mesAtual, 6);
  const ontem = somaDias(hoje, -1);
  return {
    hoje: { de: hoje, ate: hoje },
    ontem: { de: ontem, ate: ontem },
    esta_semana_ate_hoje: { de: segDestaSemana, ate: hoje },
    ultima_semana_completa: { de: ultSeg, ate: somaDias(ultSeg, 6) },
    semana_retrasada: { de: retSeg, ate: somaDias(retSeg, 6) },
    ultimos_7_dias_fechados: { de: somaDias(hoje, -7), ate: ontem },
    ultimos_30_dias_fechados: { de: somaDias(hoje, -30), ate: ontem },
    ultimos_90_dias_fechados: { de: somaDias(hoje, -90), ate: ontem },
    mes_atual_ate_hoje: { de: mesAtual + '-01', ate: hoje },
    mes_passado: { de: m1 + '-01', ate: fimDoMes(m1) },
    ultimos_3_meses_fechados: { de: m3 + '-01', ate: fimDoMes(m1) },
    os_3_meses_antes_desses: { de: m6 + '-01', ate: fimDoMes(mesAnterior(mesAtual, 4)) },
  };
}

function validarPeriodo(de, ate, hoje) {
  const ok = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s + 'T12:00:00Z')) && new Date(s + 'T12:00:00Z').toISOString().slice(0, 10) === s;
  if (!ok(de) || !ok(ate)) throw new Error('período inválido: use datas no formato AAAA-MM-DD (recebi de=' + JSON.stringify(de) + ', ate=' + JSON.stringify(ate) + ')');
  if (de > ate) throw new Error('período inválido: "de" (' + de + ') é depois de "ate" (' + ate + ')');
  if (de > hoje) throw new Error('período no futuro: hoje é ' + hoje);
  if (diasEntre(de, ate) > MAX_DIAS_PERIODO) throw new Error('período grande demais (' + diasEntre(de, ate) + ' dias): o máximo por consulta é ' + MAX_DIAS_PERIODO);
  return { de, ate, dias: diasEntre(de, ate) };
}

/* ── as contas, sobre o agregado do /historico-longo ── */
function avisosDoPeriodo(d, per, hoje) {
  const a = [];
  if (d.truncado) a.push('ATENÇÃO: o período passou de 60 mil linhas de venda e a leitura foi cortada — os números de ' + per.de + ' a ' + per.ate + ' estão INCOMPLETOS. Peça um período menor.');
  const t = d.totais || {};
  if (num(t.un_sem_custo) > 0) a.push(num(t.un_sem_custo) + ' unidade(s) vendidas de ' + per.de + ' a ' + per.ate + ' estão sem custo cadastrado: a margem desse período está SUPERESTIMADA.');
  /* Codex #873: o que o dashboard avisa sobre a margem, o chat avisa também — sem isto o modelo recebia um total de
     margem PARCIAL (vendas fora da soma) como se fosse o do período inteiro */
  if (num(t.margens_sem_parcela) > 0) a.push(num(t.margens_sem_parcela) + ' venda(s) de ' + per.de + ' a ' + per.ate + ' estão FORA do total de margem (comissão ou frete ainda não gravados): a margem desse período é PARCIAL — não é a do período inteiro, e não dá pra comparar com outro período como se fosse.');
  if (num(t.pedidos_sem_imposto) > 0) a.push(num(t.pedidos_sem_imposto) + ' pedido(s) de ' + per.de + ' a ' + per.ate + ' estão sem imposto calculado (alíquota do mês não configurada): a margem desse período está SUPERESTIMADA.');
  if (num(t.tiktok_tarifa_estimada) > 0) a.push(num(t.tiktok_tarifa_estimada) + ' pedido(s) do TikTok de ' + per.de + ' a ' + per.ate + ' estão com a tarifa ESTIMADA pela regra (o extrato ainda não chegou): a comissão e a margem do TikTok nesse período são aproximadas.');
  if (num(t.fretes_previstos) > 0) a.push(num(t.fretes_previstos) + ' venda(s) de ' + per.de + ' a ' + per.ate + ' estão com o frete PREVISTO pela tabela (o real ainda não foi gravado): o frete e a margem desse período são aproximados.');
  if (per.ate >= hoje) a.push('O período inclui hoje (' + hoje + '), que ainda está em andamento — o último dia está parcial.');
  if (!d.truncado && Array.isArray(d.skus) && num(d.skus_total) > d.skus.length) a.push('A lista de itens deste período veio parcial (' + d.skus.length + ' de ' + d.skus_total + ' SKUs): item fora da lista NÃO é item sem venda.');
  return a;
}
function totaisDe(d) {
  const t = d.totais || {};
  const fat = num(t.faturamento), ped = num(t.pedidos);
  return { faturamento: r2(fat), pedidos: ped, unidades: num(t.unidades), ticket_medio: ped > 0 ? r2(fat / ped) : null,
    custo_produtos: r2(num(t.custo)), comissao_marketplace: r2(num(t.comissao)), frete_pago_pelo_vendedor: r2(num(t.frete)), imposto: r2(num(t.imposto)),
    margem: r2(num(t.margem)), margem_pct_sobre_faturamento: pct(num(t.margem), fat),
    vendas_fora_do_total_de_margem: num(t.margens_sem_parcela) };
}
function canaisDe(d) {
  const fatTotal = Object.values(d.canais || {}).reduce((s, c) => s + num(c.fat), 0);
  return Object.entries(d.canais || {}).map(([canal, c]) => ({ canal, faturamento: r2(num(c.fat)), pedidos: num(c.pedidos), unidades: num(c.un),
    margem: r2(num(c.mar)), margem_pct_sobre_faturamento: pct(num(c.mar), num(c.fat)), participacao_no_faturamento_pct: pct(num(c.fat), fatTotal) }))
    .sort((a, b) => b.faturamento - a.faturamento);
}
function serieDe(d, per, agrupar) {
  const pedido = agrupar || (per.dias <= 45 ? 'dia' : (per.dias <= 190 ? 'semana' : 'mes'));
  const modo = pedido === 'dia' && per.dias > MAX_PONTOS_POR_DIA ? 'semana' : pedido;
  const chave = (dia) => (modo === 'dia' ? dia : modo === 'mes' ? dia.slice(0, 7) : somaDias(dia, -((diaDaSemana(dia) + 6) % 7)));
  const acc = {};
  for (const [dia, v] of Object.entries(d.dias || {})) {
    const k = chave(dia); const o = acc[k] || (acc[k] = { fat: 0, ped: 0, mar: 0, n: 0 });
    o.fat += num(v.fat); o.ped += num(v.pedidos); o.mar += num(v.mar); o.n++;
  }
  const rotulo = modo === 'dia' ? 'dia' : modo === 'mes' ? 'mes' : 'semana_iniciada_em';
  return { agrupado_por: modo, observacao: modo !== pedido ? 'período de ' + per.dias + ' dias: a evolução veio por semana (dia a dia só até ' + MAX_PONTOS_POR_DIA + ' dias)' : undefined, pontos: Object.keys(acc).sort().map((k) => ({ [rotulo]: k, faturamento: r2(acc[k].fat), pedidos: acc[k].ped, margem: r2(acc[k].mar), dias_com_venda: acc[k].n })) };
}
function itemDe(x, fatTotal) {
  const un = num(x.un), fat = num(x.fat);
  return { sku: x.sku, descricao: x.desc || null, unidades: un, faturamento: r2(fat), custo: r2(num(x.cus)), margem: r2(num(x.mar)),
    margem_pct_sobre_faturamento: pct(num(x.mar), fat), preco_medio: un > 0 ? r2(fat / un) : null, curva_abc: x.curva || null,
    participacao_no_faturamento_pct: fatTotal == null ? undefined : pct(fat, fatTotal),
    variantes_do_sku_somadas: Array.isArray(x.variantes) && x.variantes.length > 1 ? x.variantes : undefined };
}
/* Codex #873: com o histórico TRUNCADO (teto de 60 mil linhas), `skus_total` conta só os SKUs das linhas LIDAS — a lista
   "bate" com o total e mesmo assim falta gente. Lista completa é: leitura inteira E todos os SKUs dela na lista. Só
   com a lista completa um item ausente pode ser lido como "não vendeu". */
const listaCompleta = (d) => !d.truncado && Array.isArray(d.skus) && d.skus.length >= num(d.skus_total);
const chaveSku = (s) => String(s == null ? '' : s).trim().toLowerCase();
/* Codex #873: o `/historico-longo` agrupa pelo texto do SKU como veio na venda — "PM1" e "pm1" (ou com espaço sobrando)
   saem em linhas separadas. Aqui o item é UM: as variantes são SOMADAS antes de qualquer conta (comparar por chave sem
   somar jogava uma das linhas fora — venda de verdade sumindo da comparação). O item leva o SKU da variante de maior
   faturamento, a lista das variantes, e fica sem curva ABC (a curva do histórico é por variante). */
function itensDe(d) {
  const m = new Map();
  for (const x of (d.skus || [])) {
    const k = chaveSku(x.sku);
    const o = m.get(k);
    if (!o) { m.set(k, { sku: x.sku, desc: x.desc, un: num(x.un), fat: num(x.fat), cus: num(x.cus), mar: num(x.mar), curva: x.curva, _maior: num(x.fat), variantes: [x.sku] }); continue; }
    o.un += num(x.un); o.fat += num(x.fat); o.cus += num(x.cus); o.mar += num(x.mar);
    o.variantes.push(x.sku); o.curva = null;
    if (num(x.fat) > o._maior) { o._maior = num(x.fat); o.sku = x.sku; o.desc = x.desc || o.desc; }
  }
  return m;
}

/* quantos itens o período tem: com a lista completa, os itens JÁ com as variantes somadas; senão, o total que o histórico informou */
const contarItens = (d) => (listaCompleta(d) ? itensDe(d).size : num(d.skus_total));

function criarFerramentas(o) {
  const hoje = o.hoje;
  const cache = new Map();
  let consultas = 0;
  async function periodo(de, ate) {
    const per = validarPeriodo(de, ate, hoje);
    const k = per.de + '|' + per.ate;
    if (!cache.has(k)) {
      consultas++;
      const d = await o.consultarHistorico(per.de, per.ate);
      if (!d || d.ok !== true || !d.totais) throw new Error('o histórico de vendas não respondeu pra ' + per.de + ' a ' + per.ate + (d && d.erro ? ' (' + d.erro + ')' : ''));
      cache.set(k, d);
    }
    return { per, d: cache.get(k) };
  }
  const topDe = (v, padrao) => Math.min(30, Math.max(1, parseInt(v, 10) || padrao));

  const F = {
    async resumo_periodo(inp) {
      const { per, d } = await periodo(inp.de, inp.ate);
      if (inp.agrupar != null && !['dia', 'semana', 'mes'].includes(inp.agrupar)) throw new Error('agrupar tem que ser dia, semana ou mes');
      return { periodo: per, totais: totaisDe(d), por_canal: canaisDe(d), evolucao: serieDe(d, per, inp.agrupar), itens_no_periodo: contarItens(d), avisos: avisosDoPeriodo(d, per, hoje) };
    },

    async comparar_periodos(inp) {
      const A = await periodo(inp.antes_de, inp.antes_ate), B = await periodo(inp.depois_de, inp.depois_ate);
      const top = topDe(inp.top, 10);
      const tA = totaisDe(A.d), tB = totaisDe(B.d);
      const avisos = avisosDoPeriodo(A.d, A.per, hoje).concat(avisosDoPeriodo(B.d, B.per, hoje));
      if (A.per.dias !== B.per.dias) avisos.push('Os dois períodos têm tamanhos diferentes (' + A.per.dias + ' e ' + B.per.dias + ' dias): compare pelas médias por dia, não pelos totais.');
      const cA = Object.fromEntries(canaisDe(A.d).map((c) => [c.canal, c])), cB = Object.fromEntries(canaisDe(B.d).map((c) => [c.canal, c]));
      const canais = Array.from(new Set(Object.keys(cA).concat(Object.keys(cB)))).map((canal) => {
        const a = cA[canal] || { faturamento: 0, pedidos: 0, unidades: 0, margem: 0 }, b = cB[canal] || { faturamento: 0, pedidos: 0, unidades: 0, margem: 0 };
        return { canal, faturamento: variacao(a.faturamento, b.faturamento), pedidos: variacao(a.pedidos, b.pedidos), unidades: variacao(a.unidades, b.unidades), margem: variacao(a.margem, b.margem) };
      }).sort((x, y) => x.faturamento.diferenca - y.faturamento.diferenca);
      /* itens: só dá pra dizer "não vendeu" quando a lista do período veio COMPLETA; senão o item fora da lista fica de fora
         da comparação (e o aviso diz) — zero inventado viraria "queda de 100%" que não existiu */
      const compA = listaCompleta(A.d), compB = listaCompleta(B.d);
      const mA = itensDe(A.d), mB = itensDe(B.d);
      const itens = []; let foraDaBase = 0;
      for (const k of new Set(Array.from(mA.keys()).concat(Array.from(mB.keys())))) {
        const a = mA.get(k), b = mB.get(k);
        if ((!a && !compA) || (!b && !compB)) { foraDaBase++; continue; }
        const unA = a ? num(a.un) : 0, unB = b ? num(b.un) : 0, fA = a ? num(a.fat) : 0, fB = b ? num(b.fat) : 0;
        const pA = unA > 0 ? fA / unA : null, pB = unB > 0 ? fB / unB : null;
        itens.push({ sku: (b || a).sku, descricao: (b || a).desc || null,
          variantes_do_sku_somadas: [a, b].some((v) => v && v.variantes.length > 1) ? Array.from(new Set((a ? a.variantes : []).concat(b ? b.variantes : []))) : undefined,
          faturamento: variacao(fA, fB), unidades: variacao(unA, unB), margem: variacao(a ? num(a.mar) : 0, b ? num(b.mar) : 0),
          preco_medio_antes: pA == null ? null : r2(pA), preco_medio_depois: pB == null ? null : r2(pB),
          /* a diferença de faturamento aberta em duas parcelas que somam ela: quanto veio de vender mais/menos UNIDADES
             (ao preço de antes) e quanto veio de mudar o PREÇO médio (nas unidades de depois) */
          efeito_volume: pA == null || pB == null ? null : r2((unB - unA) * pA), efeito_preco: pA == null || pB == null ? null : r2((pB - pA) * unB),
          situacao: !a || unA === 0 && fA === 0 ? 'não vendia antes' : (!b || unB === 0 && fB === 0 ? 'parou de vender' : 'vendeu nos dois') });
      }
      const quedas = itens.filter((x) => x.faturamento.diferenca < 0).sort((x, y) => x.faturamento.diferenca - y.faturamento.diferenca);
      const altas = itens.filter((x) => x.faturamento.diferenca > 0).sort((x, y) => y.faturamento.diferenca - x.faturamento.diferenca);
      if (foraDaBase) avisos.push(foraDaBase + ' item(ns) ficaram fora da comparação item a item porque a lista de itens de um dos períodos está incompleta (leitura cortada ou lista parcial): pra esses não dá pra dizer se venderam ou não.');
      return { antes: { periodo: A.per, totais: tA, faturamento_por_dia: r2(tA.faturamento / A.per.dias), pedidos_por_dia: r2(tA.pedidos / A.per.dias) },
        depois: { periodo: B.per, totais: tB, faturamento_por_dia: r2(tB.faturamento / B.per.dias), pedidos_por_dia: r2(tB.pedidos / B.per.dias) },
        variacao: { faturamento: variacao(tA.faturamento, tB.faturamento), pedidos: variacao(tA.pedidos, tB.pedidos), unidades: variacao(tA.unidades, tB.unidades),
          ticket_medio: tA.ticket_medio == null || tB.ticket_medio == null ? null : variacao(tA.ticket_medio, tB.ticket_medio), margem: variacao(tA.margem, tB.margem),
          faturamento_por_dia: variacao(tA.faturamento / A.per.dias, tB.faturamento / B.per.dias) },
        por_canal_da_maior_queda_pra_maior_alta: canais,
        itens_que_mais_cairam: quedas.slice(0, top), itens_que_mais_subiram: altas.slice(0, top),
        contagem_de_itens: { cairam: quedas.length, subiram: altas.length, pararam_de_vender: itens.filter((x) => x.situacao === 'parou de vender').length, nao_vendiam_antes: itens.filter((x) => x.situacao === 'não vendia antes').length },
        soma_das_quedas_de_faturamento: r2(quedas.reduce((s, x) => s + x.faturamento.diferenca, 0)), soma_das_altas_de_faturamento: r2(altas.reduce((s, x) => s + x.faturamento.diferenca, 0)),
        avisos };
    },

    async ranking_itens(inp) {
      const { per, d } = await periodo(inp.de, inp.ate);
      const top = topDe(inp.top, 15);
      const fatTotal = num((d.totais || {}).faturamento);
      const itens = Array.from(itensDe(d).values()).map((x) => itemDe(x, fatTotal));
      const ORD = {
        maior_faturamento: (a, b) => b.faturamento - a.faturamento,
        mais_unidades: (a, b) => b.unidades - a.unidades,
        maior_margem: (a, b) => b.margem - a.margem,
        menor_margem: (a, b) => a.margem - b.margem,
        maior_margem_pct: (a, b) => (b.margem_pct_sobre_faturamento == null ? -Infinity : b.margem_pct_sobre_faturamento) - (a.margem_pct_sobre_faturamento == null ? -Infinity : a.margem_pct_sobre_faturamento),
        menor_margem_pct: (a, b) => (a.margem_pct_sobre_faturamento == null ? Infinity : a.margem_pct_sobre_faturamento) - (b.margem_pct_sobre_faturamento == null ? Infinity : b.margem_pct_sobre_faturamento),
      };
      const crit = inp.criterio || 'maior_faturamento';
      if (!ORD[crit]) throw new Error('criterio tem que ser um de: ' + Object.keys(ORD).join(', '));
      return { periodo: per, criterio: crit, itens: itens.slice().sort(ORD[crit]).slice(0, top), itens_no_periodo: contarItens(d), faturamento_total_do_periodo: r2(fatTotal), avisos: avisosDoPeriodo(d, per, hoje) };
    },

    async buscar_item(inp) {
      const { per, d } = await periodo(inp.de, inp.ate);
      const palavras = String(inp.texto || '').toLowerCase().split(/\s+/).filter(Boolean);
      if (!palavras.length) throw new Error('diga o texto a procurar (parte do nome do produto ou do SKU)');
      const fatTotal = num((d.totais || {}).faturamento);
      const achados = Array.from(itensDe(d).values()).filter((x) => { const alvo = (x.variantes.join(' ') + ' ' + String(x.desc || '')).toLowerCase(); return palavras.every((w) => alvo.includes(w)); })
        .sort((a, b) => b.fat - a.fat);
      return { periodo: per, texto: inp.texto, encontrados: achados.length, itens: achados.slice(0, 20).map((x) => itemDe(x, fatTotal)),
        avisos: avisosDoPeriodo(d, per, hoje).concat(achados.length ? [] : [listaCompleta(d)
          ? 'Nenhum item VENDIDO nesse período tem esse texto no nome ou no SKU. (A busca só enxerga o que vendeu no período.)'
          : 'Não achei item com esse texto — mas a lista de itens deste período está INCOMPLETA (leitura cortada ou lista parcial): não dá pra afirmar que ele não vendeu.']) };
    },

    async evolucao_item(inp) {
      const alvo = chaveSku(inp.sku);
      if (!alvo) throw new Error('diga o SKU (use buscar_item pra achar o SKU pelo nome)');
      if (!Array.isArray(inp.periodos) || !inp.periodos.length || inp.periodos.length > 6) throw new Error('passe de 1 a 6 períodos');
      const pontos = []; let avisos = []; let descricao = null;
      for (const p of inp.periodos) {
        const { per, d } = await periodo(p && p.de, p && p.ate);
        const x = itensDe(d).get(alvo);
        if (x) { descricao = descricao || x.desc || null; pontos.push(Object.assign({ periodo: per }, itemDe(x, num((d.totais || {}).faturamento)))); }
        else if (listaCompleta(d)) pontos.push({ periodo: per, sku: inp.sku, vendeu: false, unidades: 0, faturamento: 0 });
        else pontos.push({ periodo: per, sku: inp.sku, vendeu: null, observacao: 'não disponível: a lista de itens deste período está incompleta (leitura cortada ou lista parcial)' });
        avisos = avisos.concat(avisosDoPeriodo(d, per, hoje));
      }
      if (!pontos.some((x) => x.unidades > 0)) avisos.push('Esse SKU não aparece com venda em nenhum dos períodos pedidos. Confira o SKU com buscar_item.');
      return { sku: inp.sku, descricao, pontos, avisos: Array.from(new Set(avisos)) };
    },
  };
  return { F, consultas: () => consultas };
}

const PERIODO_PROPS = (pre) => ({ [pre + 'de']: { type: 'string', description: 'primeiro dia, AAAA-MM-DD' }, [pre + 'ate']: { type: 'string', description: 'último dia (incluído), AAAA-MM-DD' } });
const FERRAMENTAS = [
  { name: 'resumo_periodo',
    description: 'Totais de vendas de um período (faturamento, pedidos, unidades, ticket médio, custo, comissão, frete, imposto, margem), a divisão por canal de venda e a evolução no tempo. Use pra "quanto vendi", "como foi o mês", "qual canal vende mais".',
    input_schema: { type: 'object', properties: Object.assign(PERIODO_PROPS(''), { agrupar: { type: 'string', enum: ['dia', 'semana', 'mes'], description: 'como agrupar a evolução (se omitido, escolhe pelo tamanho do período)' } }), required: ['de', 'ate'] } },
  { name: 'comparar_periodos',
    description: 'Compara dois períodos (ANTES e DEPOIS) e devolve as diferenças já calculadas: totais, médias por dia, por canal, e os itens que mais caíram e mais subiram em faturamento — com unidades, preço médio e a diferença aberta em efeito de volume e efeito de preço. Use pra "por que caiu", "o que mudou", "qual item teve maior queda".',
    input_schema: { type: 'object', properties: Object.assign(PERIODO_PROPS('antes_'), PERIODO_PROPS('depois_'), { top: { type: 'integer', description: 'quantos itens em cada lista (padrão 10, máximo 30)' } }), required: ['antes_de', 'antes_ate', 'depois_de', 'depois_ate'] } },
  { name: 'ranking_itens',
    description: 'Os itens (SKUs) de um período ordenados por um critério, com unidades, faturamento, custo, margem, preço médio, curva ABC e participação no faturamento.',
    input_schema: { type: 'object', properties: Object.assign(PERIODO_PROPS(''), { criterio: { type: 'string', enum: ['maior_faturamento', 'mais_unidades', 'maior_margem', 'menor_margem', 'maior_margem_pct', 'menor_margem_pct'] }, top: { type: 'integer', description: 'quantos itens (padrão 15, máximo 30)' } }), required: ['de', 'ate'] } },
  { name: 'buscar_item',
    description: 'Acha o SKU de um produto por parte do nome ou do SKU, entre os itens VENDIDOS num período. Use antes de evolucao_item quando o dono disser o nome do produto em vez do SKU.',
    input_schema: { type: 'object', properties: Object.assign(PERIODO_PROPS(''), { texto: { type: 'string', description: 'palavras que aparecem no nome ou no SKU' } }), required: ['de', 'ate', 'texto'] } },
  { name: 'evolucao_item',
    description: 'As vendas de UM SKU em até 6 períodos (unidades, faturamento, margem, preço médio em cada um). Use pra ver a tendência de um produto.',
    input_schema: { type: 'object', properties: { sku: { type: 'string' }, periodos: { type: 'array', minItems: 1, maxItems: 6, items: { type: 'object', properties: PERIODO_PROPS(''), required: ['de', 'ate'] } } }, required: ['sku', 'periodos'] } },
];

function promptDoSistema(o) {
  const P = periodosNomeados(o.hoje);
  return [
    'Você é o analista de vendas do dashboard da loja ' + o.nomeEmpresa + ', um e-commerce brasileiro que vende em marketplaces (Mercado Livre, Shopee, Magalu, TikTok Shop e outros). Quem pergunta é o dono da empresa. Responda em português do Brasil, direto e sem enrolar.',
    '',
    'HOJE é ' + o.hoje + ' (' + NOME_DIA[diaDaSemana(o.hoje)] + '), no horário de Brasília. Semana = segunda a domingo. Períodos já calculados (use ESTES, não refaça a conta de datas):',
    JSON.stringify(P),
    'Nos dados os canais vêm com nomes curtos: ml = Mercado Livre, shopee = Shopee, magalu = Magalu, tiktok = TikTok Shop; outros nomes, repita como vieram. Na resposta use o nome por extenso.',
    'Quando o dono disser "última semana" ou "semana passada", é ultima_semana_completa; "semana retrasada" é semana_retrasada; "últimos 3 meses" é ultimos_3_meses_fechados (compare com os_3_meses_antes_desses quando ele pedir queda/alta sem dizer contra o quê). Diga sempre, na resposta, as datas do período que você usou.',
    '',
    'REGRAS QUE NÃO SE QUEBRAM:',
    '1. TODO número da sua resposta tem que ter vindo de uma consulta desta conversa. Não estime, não arredonde pra "cerca de", não faça conta de cabeça: diferenças, percentuais, médias e rankings já vêm calculados nas consultas — use os valores como vieram. Se o número que você precisa não veio, faça outra consulta ou diga que não tem.',
    '2. Separe FATO de HIPÓTESE. Fato é o que as consultas mostram (em qual canal caiu, quais itens puxaram, se foi menos unidade ou preço menor, se a margem mudou). Hipótese é o motivo por trás — e você só pode levantar hipótese marcando como hipótese. O que NÃO está nos dados você não sabe: preço de concorrente, anúncio pausado, falta de estoque, campanha, feriado, reputação da conta. Pode citar como coisa a conferir, nunca como causa.',
    '3. Se uma consulta trouxer "avisos", eles valem pra sua resposta: repita pro dono o que afeta a conclusão (período incompleto, margem superestimada por falta de custo, dia de hoje parcial).',
    '4. Períodos de tamanhos diferentes se comparam pela média por dia, que já vem calculada.',
    '5. Você só enxerga vendas agregadas (por período, canal e item). Não tem dados de clientes nem de pedidos individuais, e não altera nada no sistema. Se pedirem algo fora disso, diga que este chat não faz.',
    '',
    'FORMATO: comece pela resposta à pergunta, em uma ou duas frases, com os números principais. Depois, se ajudar, os detalhes em lista curta. Valores em reais no formato R$ 1.234,56; percentuais com uma casa. Sem títulos grandes, sem tabela larga (a tela é estreita). No fim, se couber, UMA sugestão do que olhar em seguida.',
  ].join('\n');
}

/* descrição curta do que está sendo consultado, pra tela mostrar enquanto espera */
function descreverConsulta(nome, inp) {
  const br = (iso) => (typeof iso === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(iso) ? iso.slice(8, 10) + '/' + iso.slice(5, 7) : '?');
  inp = inp || {};
  if (nome === 'comparar_periodos') return 'Comparando ' + br(inp.antes_de) + '–' + br(inp.antes_ate) + ' com ' + br(inp.depois_de) + '–' + br(inp.depois_ate);
  if (nome === 'resumo_periodo') return 'Lendo as vendas de ' + br(inp.de) + ' a ' + br(inp.ate);
  if (nome === 'ranking_itens') return 'Ordenando os itens de ' + br(inp.de) + ' a ' + br(inp.ate);
  if (nome === 'buscar_item') return 'Procurando o item "' + String(inp.texto || '').slice(0, 40) + '"';
  if (nome === 'evolucao_item') return 'Vendo a evolução do item ' + String(inp.sku || '').slice(0, 40);
  return 'Consultando';
}

/* ── a conversa com a API (streaming): devolve os blocos de conteúdo, o motivo da parada e os tokens ── */
async function chamarModelo(o) {
  /* Codex #873: o `timeout` do node-fetch 2 só vale até chegarem os CABEÇALHOS — a API que manda o cabeçalho e depois
     emudece prendia a pergunta pra sempre (tela travada em "pensando", sinal de vida rodando sem fim). O prazo agora é do
     pedido INTEIRO, cabeçalho e fluxo: estourou, a chamada é abortada e vira erro que dá pra ler. */
  const prazo = o.prazoMs || PRAZO_API_MS;
  const ac = new AbortController();
  let estourou = false;
  let recusar = null;
  const noPrazo = new Promise((_, rej) => { recusar = rej; });
  const relogio = setTimeout(() => { estourou = true; try { ac.abort(); } catch (e) {} recusar(new Error('prazo')); }, prazo);
  /* Codex #873 r2: os tokens que a API JÁ cobrou desta chamada (ela informa a entrada logo no começo do fluxo) não podem
     sumir se a chamada falhar no meio — o medidor é preenchido enquanto o fluxo chega e vai junto no erro */
  const medidor = { entrada: 0, saida: 0 };
  try {
    /* a corrida não depende de o fluxo "obedecer" o abort: estourou o prazo, a pergunta segue pro erro de qualquer jeito */
    const conversa = _conversarComModelo(o, ac.signal, medidor);
    conversa.catch(() => {});
    return await Promise.race([conversa, noPrazo]);
  } catch (e) {
    const e2 = estourou ? Object.assign(new Error('a API da Anthropic não respondeu em ' + Math.round(prazo / 1000) + ' s — tente de novo'), { prazo: true }) : (e instanceof Error ? e : new Error(String(e)));
    e2.usoParcial = { entrada: medidor.entrada, saida: medidor.saida };
    throw e2;
  } finally { clearTimeout(relogio); }
}
async function _conversarComModelo(o, signal, medidor) {
  const r = await o.fetch(API_URL, { method: 'POST', signal,
    headers: { 'content-type': 'application/json', 'x-api-key': o.chave, 'anthropic-version': API_VERSAO },
    body: JSON.stringify({ model: o.modelo, max_tokens: MAX_TOKENS_RESPOSTA, system: o.system, tools: FERRAMENTAS, messages: o.messages, stream: true }) });
  if (!r.ok) {
    let corpo = ''; try { corpo = await r.text(); } catch (e) {}
    let msg = ''; try { msg = (JSON.parse(corpo).error || {}).message || ''; } catch (e) {}
    const e = new Error('a API da Anthropic respondeu ' + r.status + (msg ? ': ' + msg : '')); e.status = r.status; throw e;
  }
  const blocos = []; const parciais = {};
  let parada = null, resto = '';
  const dec = new (require('string_decoder').StringDecoder)('utf8');
  const tratar = (ev) => {
    if (!ev || typeof ev !== 'object') return;
    if (ev.type === 'message_start') { const u = (ev.message && ev.message.usage) || {}; medidor.entrada = num(u.input_tokens) + num(u.cache_creation_input_tokens) + num(u.cache_read_input_tokens); medidor.saida = num(u.output_tokens); }
    else if (ev.type === 'content_block_start') { const b = ev.content_block || {}; blocos[ev.index] = b.type === 'tool_use' ? { type: 'tool_use', id: b.id, name: b.name, input: {} } : (b.type === 'text' ? { type: 'text', text: '' } : { type: b.type, _ignorar: true }); if (b.type === 'tool_use') parciais[ev.index] = ''; }
    else if (ev.type === 'content_block_delta') { const d = ev.delta || {}, b = blocos[ev.index];
      if (d.type === 'text_delta' && b && b.type === 'text') { b.text += d.text || ''; if (d.text) o.aoTexto(d.text); }
      else if (d.type === 'input_json_delta' && parciais[ev.index] != null) parciais[ev.index] += d.partial_json || ''; }
    else if (ev.type === 'content_block_stop') { if (parciais[ev.index] != null) { const b = blocos[ev.index]; try { b.input = parciais[ev.index] ? JSON.parse(parciais[ev.index]) : {}; } catch (e) { b.input = {}; b._entradaInvalida = true; } delete parciais[ev.index]; } }
    else if (ev.type === 'message_delta') { if (ev.delta && ev.delta.stop_reason) parada = ev.delta.stop_reason; if (ev.usage && ev.usage.output_tokens != null) medidor.saida = num(ev.usage.output_tokens); }
    else if (ev.type === 'error') { const e = new Error('a API da Anthropic interrompeu a resposta: ' + ((ev.error && (ev.error.message || ev.error.type)) || 'erro')); throw e; }
  };
  const linhas = (txt) => {
    resto += txt;
    let i;
    while ((i = resto.indexOf('\n')) >= 0) {
      const l = resto.slice(0, i).replace(/\r$/, ''); resto = resto.slice(i + 1);
      if (l.startsWith('data:')) { const j = l.slice(5).trim(); if (j && j !== '[DONE]') { let ev = null; try { ev = JSON.parse(j); } catch (e) {} tratar(ev); } }
    }
  };
  for await (const pedaco of r.body) linhas(typeof pedaco === 'string' ? pedaco : dec.write(Buffer.from(pedaco)));
  linhas(dec.end() + '\n');
  /* Codex #873 r3: fluxo que ACABA sem o fecho da mensagem (a conexão caiu "limpa" no meio) não é resposta. Sem esta
     conferência, a frase cortada ("A queda foi de R$") saía como resposta pronta, com `fim`, e a tela ainda a guardava
     no histórico da conversa. O motivo da parada só chega no fim da mensagem: sem ele, a resposta está incompleta —
     vira erro (e o que a API já tinha cobrado segue contando, pelo medidor). */
  if (parada == null) throw new Error('a resposta da API da Anthropic foi interrompida antes do fim — tente de novo');
  return { blocos: blocos.filter((b) => b && !b._ignorar), parada, entrada: medidor.entrada, saida: medidor.saida };
}

/* ── uma pergunta, do começo ao fim ── */
async function responder(o) {
  const hoje = o.hoje || hojeSP();
  const ferr = criarFerramentas({ hoje, consultarHistorico: o.consultarHistorico });
  const system = promptDoSistema({ hoje, nomeEmpresa: o.nomeEmpresa });
  const messages = [];
  for (const m of (Array.isArray(o.historico) ? o.historico : []).slice(-MAX_HISTORICO)) {
    if (!m || (m.role !== 'user' && m.role !== 'assistant') || typeof m.content !== 'string' || !m.content.trim()) continue;
    /* a API exige alternância começando no usuário: junta seguidas do mesmo papel */
    const texto = m.content.slice(0, 6000);
    if (messages.length && messages[messages.length - 1].role === m.role) messages[messages.length - 1].content += '\n\n' + texto;
    else if (messages.length || m.role === 'user') messages.push({ role: m.role, content: texto });
  }
  if (messages.length && messages[messages.length - 1].role === 'user') messages[messages.length - 1].content += '\n\n' + o.pergunta;
  else messages.push({ role: 'user', content: o.pergunta });

  let entrada = 0, saida = 0, texto = '', terminou = false, rodadas = 0, cancelada = false;
  const saiu = () => typeof o.cancelado === 'function' && o.cancelado();
  const preco = PRECO_USD_MTOK[o.modelo];
  const usoAteAqui = () => ({ tokens_entrada: entrada, tokens_saida: saida, consultas: ferr.consultas(), idas_ao_modelo: rodadas, modelo: o.modelo,
    usd_estimado: preco ? Math.round(((entrada * preco.entrada + saida * preco.saida) / 1e6) * 10000) / 10000 : null });
  /* Codex #873 r2: se uma ida ao modelo falha DEPOIS de outras terem dado certo (a 1ª pediu uma consulta, a 2ª levou 429),
     o que já foi gasto não pode sumir da conta do dia — o erro sai daqui carregando o uso acumulado (`e.uso`) */
  try {
  while (rodadas < MAX_RODADAS && !terminou) {
    /* quem perguntou fechou a tela: para de gastar (nem modelo, nem consulta) */
    if (saiu()) { cancelada = true; break; }
    if (entrada > MAX_TOKENS_ENTRADA_PERGUNTA) break;
    rodadas++;
    const r = await chamarModelo({ fetch: o.fetch, chave: o.chave, modelo: o.modelo, prazoMs: o.prazoApiMs, system, messages, aoTexto: (t) => { texto += t; o.enviar({ t: 'texto', d: t }); } });
    entrada += r.entrada; saida += r.saida;
    const usos = r.blocos.filter((b) => b.type === 'tool_use');
    if (r.parada === 'tool_use' && usos.length) {
      messages.push({ role: 'assistant', content: r.blocos.map((b) => (b.type === 'tool_use' ? { type: 'tool_use', id: b.id, name: b.name, input: b.input } : { type: 'text', text: b.text })).filter((b) => b.type !== 'text' || b.text) });
      const resultados = [];
      for (const u of usos) {
        o.enviar({ t: 'passo', texto: descreverConsulta(u.name, u.input) });
        let conteudo, erro = false;
        try {
          if (saiu()) throw new Error('a conversa foi encerrada');
          if (u._entradaInvalida) throw new Error('os parâmetros da consulta vieram ilegíveis — refaça a chamada');
          if (!Object.prototype.hasOwnProperty.call(ferr.F, u.name)) throw new Error('consulta desconhecida: ' + u.name);
          conteudo = JSON.stringify(await ferr.F[u.name](u.input || {}));
        } catch (e) { erro = true; conteudo = String((e && e.message) || e).slice(0, 500); }
        resultados.push(Object.assign({ type: 'tool_result', tool_use_id: u.id, content: conteudo }, erro ? { is_error: true } : {}));
      }
      messages.push({ role: 'user', content: resultados });
      if (texto && !/\n$/.test(texto)) { texto += '\n\n'; o.enviar({ t: 'texto', d: '\n\n' }); }
      continue;
    }
    terminou = true;
    if (r.parada === 'max_tokens') { const av = '\n\n_(a resposta foi cortada pelo limite de tamanho — peça a continuação ou uma pergunta mais específica)_'; texto += av; o.enviar({ t: 'texto', d: av }); }
    else if (r.parada === 'refusal') { const av = (texto ? '\n\n' : '') + '_(o modelo não respondeu a essa pergunta)_'; texto += av; o.enviar({ t: 'texto', d: av }); }
  }
  } catch (e) {
    const e2 = e instanceof Error ? e : new Error(String(e));
    if (e2.usoParcial) { entrada += num(e2.usoParcial.entrada); saida += num(e2.usoParcial.saida); }
    e2.uso = usoAteAqui();
    throw e2;
  }
  if (!terminou && !cancelada) { const av = (texto ? '\n\n' : '') + '_(parei aqui: essa pergunta pediu consultas demais de uma vez. Tente dividir em perguntas menores.)_'; texto += av; o.enviar({ t: 'texto', d: av }); }
  return { texto, cancelada, uso: usoAteAqui() };
}

/* ── a rota ── */
function lerCorpo(req) {
  return new Promise((resolve, reject) => {
    if (req && req.body !== undefined && typeof req.on !== 'function') { resolve(typeof req.body === 'string' ? req.body : JSON.stringify(req.body)); return; }
    let tam = 0; const partes = [];
    req.on('data', (c) => { tam += c.length; if (tam > MAX_CORPO) { reject(new Error('pergunta grande demais')); try { req.destroy(); } catch (e) {} return; } partes.push(Buffer.from(c)); });
    req.on('end', () => resolve(Buffer.concat(partes).toString('utf8')));
    req.on('error', reject);
  });
}

function criar(ctx) {
  for (const n of ['empresa', 'caminho', 'json', 'validarSessao', 'ehAdmin', 'lerChaveAdmin', 'consultarHistorico', 'CACHE_DIR', 'readJson', 'writeJson']) {
    if (!ctx || ctx[n] == null) throw new Error('lib/checkout/chat-analise: falta ' + n);
  }
  const path = require('path');
  const { json, validarSessao, ehAdmin, lerChaveAdmin, readJson, writeJson } = ctx;
  const fetchApi = ctx.fetch || require('node-fetch');
  const ARQ_USO = () => path.join(ctx.CACHE_DIR, '_chat-analise-uso.json');
  const nomeEmpresa = ctx.nomeEmpresa || String(ctx.empresa);
  const limiteDia = () => { const n = parseInt(process.env.DASHBOARD_CHAT_MAX_DIA || '', 10); return Number.isFinite(n) && n > 0 ? n : 200; };
  const modelo = () => String(process.env.DASHBOARD_CHAT_MODELO || '').trim() || MODELO_PADRAO;
  const lerUso = () => { const u = readJson(ARQ_USO(), {}); return (u && typeof u === 'object' && !Array.isArray(u)) ? u : {}; };
  const diaDe = (u, dia) => u[dia] || (u[dia] = { perguntas: 0, tokens_entrada: 0, tokens_saida: 0, usd_estimado: 0 });
  /* Codex #873: a pergunta é RESERVADA no teto do dia ANTES da 1ª chamada paga — ler, conferir e gravar acontecem de uma
     vez só (sem `await` no meio), então duas abas perguntando juntas com UMA vaga sobrando não passam as duas. Contar só
     no fim deixava todas as que chegassem durante uma resposta passarem do teto. Pergunta que falha depois continua
     contando (o teto é de tentativas, não de acertos). */
  function reservarPergunta(dia) {
    const u = lerUso();
    const d = diaDe(u, dia);
    if (d.perguntas >= limiteDia()) return null;
    d.perguntas++;
    for (const k of Object.keys(u).sort().slice(0, -35)) delete u[k];   /* guarda os últimos 35 dias */
    try { writeJson(ARQ_USO(), u); } catch (e) {}
    return d;
  }
  /* no fim, os tokens e o custo estimado da pergunta que já estava contada */
  function somarTokens(dia, uso) {
    const u = lerUso();
    const d = diaDe(u, dia);
    d.tokens_entrada += num(uso && uso.tokens_entrada); d.tokens_saida += num(uso && uso.tokens_saida);
    if (uso && uso.usd_estimado != null) d.usd_estimado = Math.round((num(d.usd_estimado) + num(uso.usd_estimado)) * 10000) / 10000;
    try { writeJson(ARQ_USO(), u); } catch (e) {}
    return d;
  }

  return async function rotaChat(req, res, urlObj) {
    if (urlObj.pathname !== ctx.caminho) return false;
    const k = lerChaveAdmin(req, urlObj);
    const sess = validarSessao(req.headers && req.headers['cookie']);
    if (!((process.env.ADMIN_KEY && k === process.env.ADMIN_KEY) || (sess && ehAdmin(sess)))) { json(res, 404, { error: 'not found' }); return true; }
    const hoje = hojeSP();
    const chave = String(process.env[ENV_CHAVE] || '').trim();
    const usoHoje = lerUso()[hoje] || { perguntas: 0, tokens_entrada: 0, tokens_saida: 0, usd_estimado: 0 };

    if (req.method === 'GET') {
      json(res, 200, { ok: true, configurado: !!chave, env: ENV_CHAVE, modelo: modelo(), hoje: Object.assign({ dia: hoje, limite_perguntas: limiteDia() }, usoHoje) });
      return true;
    }
    if (req.method !== 'POST') { json(res, 405, { ok: false, erro: 'use POST' }); return true; }
    if (!chave) { json(res, 200, { ok: false, erro: 'O chat ainda não está ligado: falta a variável ' + ENV_CHAVE + ' neste serviço (Render → Environment).' }); return true; }
    const LIMITE_DIA = 'O limite de ' + limiteDia() + ' perguntas por dia desta loja foi atingido. Volta amanhã (ou aumente DASHBOARD_CHAT_MAX_DIA).';
    /* recusa barata antes de ler o corpo; a que VALE (a reserva) vem depois de validar a pergunta */
    if (usoHoje.perguntas >= limiteDia()) { json(res, 200, { ok: false, erro: LIMITE_DIA }); return true; }
    let corpo;
    try { corpo = JSON.parse(await lerCorpo(req) || '{}'); } catch (e) { json(res, 400, { ok: false, erro: 'não entendi o pedido: ' + String(e.message || e).slice(0, 80) }); return true; }
    const pergunta = String((corpo && corpo.pergunta) || '').trim();
    if (!pergunta) { json(res, 400, { ok: false, erro: 'escreva a pergunta' }); return true; }
    if (pergunta.length > MAX_PERGUNTA) { json(res, 400, { ok: false, erro: 'a pergunta passou de ' + MAX_PERGUNTA + ' caracteres — encurte' }); return true; }
    if (!reservarPergunta(hoje)) { json(res, 200, { ok: false, erro: LIMITE_DIA }); return true; }

    /* daqui pra frente a resposta vai em pedaços (text/event-stream): o texto aparece enquanto é escrito */
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', 'X-Accel-Buffering': 'no', Connection: 'keep-alive' });
    let aberto = true;
    /* `res` fechado antes da hora = quem perguntou saiu (fechou a aba, caiu a rede). O `close` do `req` não serve: ele
       dispara quando o CORPO do pedido termina de ser lido, com a resposta ainda no meio. */
    if (typeof res.on === 'function') res.on('close', () => { aberto = false; });
    try { if (typeof res.flushHeaders === 'function') res.flushHeaders(); } catch (e) {}
    const enviar = (ev) => { if (!aberto) return; try { res.write('data: ' + JSON.stringify(ev) + '\n\n'); } catch (e) { aberto = false; } };
    enviar({ t: 'inicio', modelo: modelo() });
    /* linha de comentário do SSE (a tela ignora): mantém a conexão viva enquanto uma consulta longa roda */
    const batimento = setInterval(() => { if (aberto) { try { res.write(': vivo\n\n'); } catch (e) { aberto = false; } } }, ctx.batimentoMs || BATIMENTO_MS);
    if (typeof batimento.unref === 'function') batimento.unref();
    try {
      const r = await responder({ fetch: fetchApi, chave, modelo: modelo(), hoje, nomeEmpresa, pergunta, historico: corpo.historico, enviar, cancelado: () => !aberto, prazoApiMs: ctx.prazoApiMs,
        consultarHistorico: (de, ate) => ctx.consultarHistorico(req, urlObj, de, ate) });
      const dia = somarTokens(hoje, r.uso);
      enviar({ t: 'fim', uso: r.uso, hoje: Object.assign({ dia: hoje, limite_perguntas: limiteDia() }, dia) });
    } catch (e) {
      /* (a pergunta já está contada no dia — foi reservada antes de gastar.) Codex #873 r2: e o que ela GASTOU antes de
         falhar entra na conta do dia e vai pra tela — pergunta de várias idas que cai na última não some do gasto */
      let dia = null;
      try { dia = somarTokens(hoje, e && e.uso); } catch (e2) {}
      const st = e && e.status;
      enviar({ t: 'erro', uso: (e && e.uso) || undefined, hoje: dia ? Object.assign({ dia: hoje, limite_perguntas: limiteDia() }, dia) : undefined, erro: st === 401 ? 'A chave da Anthropic foi recusada (401). Confira a variável ' + ENV_CHAVE + ' no Render.'
        : st === 429 ? 'A Anthropic limitou as chamadas agora (429). Tente de novo em um minuto.'
        : st === 400 && /credit|balance|billing/i.test(String(e.message)) ? 'A conta da Anthropic está sem saldo de API. ' + String(e.message).slice(0, 200)
        : String((e && e.message) || e).slice(0, 300) });
    }
    clearInterval(batimento);
    try { res.end(); } catch (e) {}
    return true;
  };
}

module.exports = { criar, responder, criarFerramentas, periodosNomeados, validarPeriodo, promptDoSistema, FERRAMENTAS, ENV_CHAVE, MODELO_PADRAO, PRECO_USD_MTOK, MAX_RODADAS, MAX_TOKENS_ENTRADA_PERGUNTA, hojeSP };
