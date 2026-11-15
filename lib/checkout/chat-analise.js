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

   CONTEXTO (14/11, depois da 1ª resposta em produção): além das vendas, o modelo recebe o CALENDÁRIO comercial
     (lib/checkout/chat-calendario.js — datas duplas, varejo, feriados; é calendário geral, não diz se a loja entrou em
     campanha) e tem a consulta do dia contra o MESMO dia da semana de 13 semanas. E os dias recentes levam um aviso: a
     base histórica só é refeita de madrugada, o card Hoje/Ontem do dashboard usa o cache ao vivo — são duas fontes.

   OS "OLHOS" (14/11, lib/checkout/chat-olhos.js): além das vendas, o modelo pode consultar os anúncios pagos por dia
     (Shopee e Mercado Livre), a reputação da conta no Mercado Livre (com uma foto por dia, pra saber o que mudou), o
     estoque de hoje no Bling e a fila/expedição do galpão. Cada uma diz de quando é o dado e o que ele NÃO cobre.

   O QUE VAI PRA API: a pergunta do dono e agregados — de venda (SKU, descrição do produto, canal, valores), de anúncio
     (consumo, cliques, vendas atribuídas por dia), a reputação da conta no Mercado Livre (nível e métricas), o saldo de
     estoque dos SKUs perguntados e a CONTAGEM de pedidos na fila do galpão. NADA de cliente — nome, CPF, endereço e
     número de pedido não saem daqui.

   QUEM USA: só admin (a chave de admin ou sessão de admin), como o resto do dashboard.

   SÓ LEITURA: a consulta do chat não dispara a busca de custo no Bling (lib/checkout/historico.js sabe que a chamada
     veio por dentro) e não grava nada além do contador de uso do dia. Se quem perguntou fecha a tela, a peça para de
     consultar e de chamar o modelo; enquanto uma consulta demora, manda um sinal de vida pra conexão não cair.

   CUSTO: a API é cobrada por uso. Cada resposta devolve os tokens gastos (e a estimativa em dólar quando o preço do
     modelo é conhecido — modelo desconhecido mostra só os tokens, sem inventar preço); há teto de perguntas por dia
     (DASHBOARD_CHAT_MAX_DIA, padrão 200 por empresa) e de consultas por pergunta. O teto de GASTO de verdade é o do
     workspace da chave, no Console da Anthropic.

   CONVERSAS GUARDADAS (14/11, lib/checkout/chat-conversas.js): cada troca TERMINADA é guardada no disco da empresa pelo
     servidor (não pela tela) — o dono volta nela depois, renomeia ou apaga. Pela mesma rota, só admin:
     `?conversas=1` (a lista), `?conversa=<id>` (uma, inteira) e POST `{ acao: 'renomear' | 'apagar', id, titulo? }`.
     O estado do chat (`GET` simples) traz também o gasto estimado do MÊS, somado dos dias guardados.

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
/* 14/11 (pedido do dono, depois da 1ª resposta em produção: "puxou só mês 10 em diante, podia no mínimo considerar 3
   meses"): julgar se um dia foi bom ou ruim é comparar com o MESMO dia da semana de pelo menos 3 meses */
const SEMANAS_PADRAO = 13, SEMANAS_MIN = 4, SEMANAS_MAX = 26;
/* 14/11 — AS DUAS FONTES DO DASHBOARD, medidas no 1º dia de uso (AMB, sexta 13/11; o dono mandou a lista da tela e a da
   base, e elas foram cruzadas pedido a pedido):
   · o card Hoje/Ontem/7 dias usa o cache ao vivo (a cada 5 min) e conta a venda pela HORA REAL, em Brasília;
   · as consultas do chat (e Mês/30 dias/Ano do dashboard) leem a base histórica, que (a) só recebe venda nova na
     atualização da madrugada (03:30, últimos 3 dias — lib/checkout/noturna-empresa, lib/checkout/diario-historico);
     (b) nesses dias ainda está com comissão e frete PROVISÓRIOS — nos mesmos 30 pedidos: tarifa R$ 468,55 na base ×
     R$ 559,30 na tela, frete R$ 219,90 × R$ 447,30, margem R$ 1.158 (37%) × R$ 833 (26%); e (c) grava o DIA como o
     Bling/marketplace escreveu — os 2 pedidos que "faltavam" na sexta eram do Mercado Livre, vendidos 00:43 e 00:59
     (CORRIGIDO no motor no mesmo dia: lib/checkout/dia-venda-ml.js; só dia antigo segue na regra velha). O grosso de (b)
     era a venda direta do ML gravada com comissão 0 e frete 0 — também corrigido (lib/checkout/venda-direta-ml.js); o que
     sobra de provisório são as tarifas que cada canal só fecha depois (TikTok, Magalu) e o frete do Flex.
   O modelo, sem saber de nada disso, mandou o dono "conferir de onde vem o seu número" e afirmou que "a margem não
   piorou" (36,5% × 31,8%) com a margem inflada do dia recente. As consultas agora AVISAM cada uma dessas coisas. */
const DIAS_RECENTES = 3;
/* a partir de quando a base está com o dia de Brasília na venda do ML: o motor mudou em 14/11/2026 e a 1ª madrugada depois
   refaz os 3 dias anteriores. É data APROXIMADA (depende da noite em que cada empresa rodou) — por isso o aviso fala de
   "dia antigo", e só aparece em leitura dia a dia. */
const BASE_NO_DIA_DE_BRASILIA_DESDE = '2026-11-13';
const TZ = 'America/Sao_Paulo';
const CAL = require('./chat-calendario');
const OLHOS = require('./chat-olhos');

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
function avisosDoPeriodo(d, per, hoje, opc) {
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
  if (per.ate >= hoje) a.push('O período inclui hoje (' + hoje + '): na base histórica o dia de HOJE só tem as vendas que existiam na última atualização dela (de madrugada) — o número de hoje aqui está MUITO incompleto. Pra hoje vale o card do dashboard; não compare hoje com outros dias nem diga que hoje caiu.');
  const _rec = somaDias(hoje, -DIAS_RECENTES);
  if (per.ate >= _rec) a.push('DIAS RECENTES: de ' + (per.de > _rec ? per.de : _rec) + ' em diante a base histórica ainda pode estar com COMISSÃO e FRETE PROVISÓRIOS (a tarifa real de alguns canais e parte dos fretes entram nos dias seguintes): a MARGEM desses dias pode estar SUPERESTIMADA. Faturamento, pedidos e unidades desses dias são os da última atualização da base (de madrugada): cancelamento ou venda que entrou depois ainda não aparece — se o dono citar um número do card que não bate com o seu, NÃO trate o número dele como errado nem mande conferir: mostre os dois e diga que o card é o mais atual. Sobre a MARGEM desses dias não conclua nada — nem "melhorou", nem "não piorou": diga que a margem de dia recente ainda é provisória e que a que vale é a do card do dashboard (Hoje/Ontem/7 dias, cache ao vivo).');
  /* o DIA da venda: até meados de novembro/2026 a base gravava a venda do ML da primeira hora no dia ANTERIOR; o motor
     passou a gravar o dia de Brasília (lib/checkout/dia-venda-ml.js) e a rotina da madrugada refaz os últimos dias — então
     só dia ANTIGO ainda está na regra velha. O aviso vai onde UM dia pesa (período de até 3 dias, e a consulta do dia da
     semana) e só quando a leitura alcança esses dias. Em semana, mês ou ano a diferença fica na borda e seria barulho. */
  if ((per.dias <= DIAS_RECENTES || (opc && opc.diaADia)) && per.de < BASE_NO_DIA_DE_BRASILIA_DESDE) a.push('DIA DA VENDA: nos dias anteriores a ' + BASE_NO_DIA_DE_BRASILIA_DESDE + ' a base histórica contava a venda do Mercado Livre feita na primeira hora do dia (00:00 a 00:59, horário de Brasília) no dia ANTERIOR (o relógio do Mercado Livre é 1 hora atrás); daí em diante ela usa o dia de Brasília, igual ao card do dashboard. Ao olhar UM dia antigo isolado, alguns pedidos do Mercado Livre podem estar no dia vizinho (em período longo a diferença some).');
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

/* as datas do calendário comercial que caem DENTRO do período (datas duplas, varejo, feriados) — vão junto do resumo e da
   comparação pra o modelo ver "a semana retrasada teve o 11.11" sem precisar pedir. Lista vazia = nenhuma. */
function calendarioDe(per) { return CAL.calendario(per.de, per.ate).map((x) => ({ dia: x.dia, dia_da_semana: x.dia_da_semana, eventos: x.eventos.map((e) => e.nome) })); }

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
      return { periodo: per, totais: totaisDe(d), por_canal: canaisDe(d), evolucao: serieDe(d, per, inp.agrupar), itens_no_periodo: contarItens(d), calendario_do_periodo: calendarioDe(per), avisos: avisosDoPeriodo(d, per, hoje) };
    },

    /* 14/11 — "e comparado a outras sextas?": o dia contra o MESMO dia da semana das semanas anteriores. Uma leitura só
       (o período inteiro), e as contas — média, mediana, posição — feitas aqui. Dia sem venda nenhuma é ZERO de verdade:
       a base não tem linha pra ele. A exceção é a leitura CORTADA (o período passou do teto de linhas): ela vem das
       vendas mais antigas pras mais novas, então o que falta é justamente o FIM — o dia analisado. Aí não há comparação
       honesta a fazer: recusa e pede menos semanas (zero inventado viraria "o pior dia" que não existiu). */
    async comparar_mesmo_dia_da_semana(inp) {
      const n = parseInt(inp.semanas, 10);
      const semanas = Math.min(SEMANAS_MAX, Math.max(SEMANAS_MIN, Number.isFinite(n) ? n : SEMANAS_PADRAO));
      validarPeriodo(inp.dia, inp.dia, hoje);
      const { per, d } = await periodo(somaDias(inp.dia, -7 * semanas), inp.dia);
      if (d.truncado) throw new Error('a leitura de ' + per.de + ' a ' + per.ate + ' foi cortada (período grande demais) e o dia ' + inp.dia + ' ficou de fora ou pela metade — peça menos semanas');
      const ponto = (dia) => {
        const v = (d.dias || {})[dia];
        const fat = v ? num(v.fat) : 0, ped = v ? num(v.pedidos) : 0;
        const ev = CAL.eventosDoDia(dia);
        return { dia, faturamento: r2(fat), pedidos: ped, ticket_medio: ped > 0 ? r2(fat / ped) : null, margem: r2(v ? num(v.mar) : 0),
          sem_venda_no_dia: v ? undefined : true, calendario: ev.length ? ev : undefined };
      };
      const alvo = ponto(inp.dia);
      const anteriores = []; for (let k = 1; k <= semanas; k++) anteriores.push(ponto(somaDias(inp.dia, -7 * k)));
      const media = (a) => a.reduce((t, x) => t + x, 0) / a.length;
      const mediana = (a) => { const o = a.slice().sort((x, y) => x - y); const m = Math.floor(o.length / 2); return o.length % 2 ? o[m] : (o[m - 1] + o[m]) / 2; };
      const fats = anteriores.map((x) => x.faturamento), peds = anteriores.map((x) => x.pedidos);
      const menor = anteriores.reduce((m, x) => (x.faturamento < m.faturamento ? x : m)), maior = anteriores.reduce((m, x) => (x.faturamento > m.faturamento ? x : m));
      const somaFat = fats.reduce((t, x) => t + x, 0), somaPed = peds.reduce((t, x) => t + x, 0);
      const ticketAnt = somaPed > 0 ? somaFat / somaPed : null;
      const acima = anteriores.filter((x) => x.faturamento > alvo.faturamento).length;
      const nome = NOME_DIA[diaDaSemana(inp.dia)];
      return { dia_analisado: Object.assign({ dia_da_semana: nome }, alvo), datas_do_calendario_perto_do_dia: CAL.proximos(inp.dia, 3),
        comparado_com: anteriores.length + ' ' + nome + '(s) anteriores, de ' + anteriores[anteriores.length - 1].dia + ' a ' + anteriores[0].dia,
        nas_anteriores: { faturamento_medio: r2(media(fats)), faturamento_mediano: r2(mediana(fats)), pedidos_medio: r2(media(peds)), pedidos_mediano: r2(mediana(peds)),
          ticket_medio: ticketAnt == null ? null : r2(ticketAnt), menor_faturamento: { dia: menor.dia, faturamento: menor.faturamento }, maior_faturamento: { dia: maior.dia, faturamento: maior.faturamento },
          dias_sem_venda: anteriores.filter((x) => x.sem_venda_no_dia).length },
        o_dia_contra_a_media: { faturamento: variacao(media(fats), alvo.faturamento), pedidos: variacao(media(peds), alvo.pedidos),
          ticket_medio: ticketAnt == null || alvo.ticket_medio == null ? null : variacao(ticketAnt, alvo.ticket_medio) },
        o_dia_contra_a_mediana: { faturamento: variacao(mediana(fats), alvo.faturamento), pedidos: variacao(mediana(peds), alvo.pedidos) },
        o_dia_contra_a_semana_anterior: { dia: anteriores[0].dia, faturamento: variacao(anteriores[0].faturamento, alvo.faturamento), pedidos: variacao(anteriores[0].pedidos, alvo.pedidos) },
        posicao_do_dia: { posicao: acima + 1, de: anteriores.length + 1, leia: '1 = o maior faturamento entre o dia analisado e as ' + anteriores.length + ' anteriores',
          foi_o_menor: anteriores.every((x) => x.faturamento > alvo.faturamento), foi_o_maior: anteriores.every((x) => x.faturamento < alvo.faturamento) },
        semana_a_semana_da_mais_recente_pra_mais_antiga: anteriores, ressalva_do_calendario: CAL.RESSALVA, avisos: avisosDoPeriodo(d, per, hoje, { diaADia: true }) };
    },

    /* 14/11 — as datas duplas (1/1 … 12/12), as datas do varejo e os feriados de um período. Não lê a base de vendas
       (não conta como consulta) e aceita data futura ("quais datas vêm aí?") */
    async calendario_comercial(inp) {
      const ok = (x) => typeof x === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(x) && !Number.isNaN(Date.parse(x + 'T12:00:00Z')) && new Date(x + 'T12:00:00Z').toISOString().slice(0, 10) === x;
      if (!ok(inp.de) || !ok(inp.ate)) throw new Error('período inválido: use datas no formato AAAA-MM-DD (recebi de=' + JSON.stringify(inp.de) + ', ate=' + JSON.stringify(inp.ate) + ')');
      if (inp.de > inp.ate) throw new Error('período inválido: "de" (' + inp.de + ') é depois de "ate" (' + inp.ate + ')');
      if (diasEntre(inp.de, inp.ate) > MAX_DIAS_PERIODO) throw new Error('período grande demais (' + diasEntre(inp.de, inp.ate) + ' dias): o máximo por consulta é ' + MAX_DIAS_PERIODO);
      const datas = CAL.calendario(inp.de, inp.ate);
      return { periodo: { de: inp.de, ate: inp.ate, dias: diasEntre(inp.de, inp.ate) }, hoje, datas: datas.map((x) => Object.assign({}, x, { ja_passou: x.dia < hoje, e_hoje: x.dia === hoje ? true : undefined })),
        total_de_datas: datas.length, ressalva: CAL.RESSALVA };
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
      return { antes: { periodo: A.per, totais: tA, faturamento_por_dia: r2(tA.faturamento / A.per.dias), pedidos_por_dia: r2(tA.pedidos / A.per.dias), calendario_do_periodo: calendarioDe(A.per) },
        depois: { periodo: B.per, totais: tB, faturamento_por_dia: r2(tB.faturamento / B.per.dias), pedidos_por_dia: r2(tB.pedidos / B.per.dias), calendario_do_periodo: calendarioDe(B.per) },
        variacao: { faturamento: variacao(tA.faturamento, tB.faturamento), pedidos: variacao(tA.pedidos, tB.pedidos), unidades: variacao(tA.unidades, tB.unidades),
          ticket_medio: tA.ticket_medio == null || tB.ticket_medio == null ? null : variacao(tA.ticket_medio, tB.ticket_medio), margem: variacao(tA.margem, tB.margem),
          faturamento_por_dia: variacao(tA.faturamento / A.per.dias, tB.faturamento / B.per.dias) },
        por_canal_da_maior_queda_pra_maior_alta: canais,
        itens_que_mais_cairam: quedas.slice(0, top), itens_que_mais_subiram: altas.slice(0, top),
        contagem_de_itens: { cairam: quedas.length, subiram: altas.length, pararam_de_vender: itens.filter((x) => x.situacao === 'parou de vender').length, nao_vendiam_antes: itens.filter((x) => x.situacao === 'não vendia antes').length },
        soma_das_quedas_de_faturamento: r2(quedas.reduce((s, x) => s + x.faturamento.diferenca, 0)), soma_das_altas_de_faturamento: r2(altas.reduce((s, x) => s + x.faturamento.diferenca, 0)),
        /* a regra do dia da venda não cita o período: com dois períodos curtos viria duas vezes, igual — vai uma só */
        avisos: avisos.filter((a, i) => !/^DIA DA VENDA:/.test(a) || avisos.indexOf(a) === i) };
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
  /* 14/11 — os "olhos" (anúncios, reputação, estoque, expedição): consultas próprias, que não leem a base de vendas */
  if (o.olhos) Object.assign(F, o.olhos.F);
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
  { name: 'comparar_mesmo_dia_da_semana',
    description: 'Compara UM dia com o MESMO dia da semana das semanas anteriores (padrão ' + SEMANAS_PADRAO + ' semanas ≈ 3 meses; de ' + SEMANAS_MIN + ' a ' + SEMANAS_MAX + '): faturamento, pedidos e ticket de cada uma, a média e a mediana das anteriores, o dia contra elas, a posição do dia no ranking e as datas do calendário (data dupla, feriado, Black Friday) no dia, perto dele e em cada semana. Use SEMPRE que a pergunta for se um dia foi bom ou ruim, "por que caiu ontem / na sexta", "comparado a outras sextas". Não julgue um dia olhando só poucos dias vizinhos.',
    input_schema: { type: 'object', properties: { dia: { type: 'string', description: 'o dia analisado, AAAA-MM-DD' }, semanas: { type: 'integer', description: 'quantas semanas pra trás (padrão ' + SEMANAS_PADRAO + ', máximo ' + SEMANAS_MAX + ')' } }, required: ['dia'] } },
  { name: 'calendario_comercial',
    description: 'As datas do calendário comercial num período: datas duplas dos marketplaces (1/1, 2/2 … 11/11, 12/12), datas do varejo (Dia do Consumidor, Dia das Mães, Dia dos Namorados, Dia dos Pais, Dia das Crianças, Black Friday, Cyber Monday), feriados nacionais e os de São Paulo (estado e capital). Aceita datas futuras. É calendário GERAL: não diz se a loja participou de campanha. (O resumo e a comparação de períodos já trazem as datas de dentro do período; use esta pra olhar outro intervalo ou o que vem pela frente.)',
    input_schema: { type: 'object', properties: PERIODO_PROPS(''), required: ['de', 'ate'] } },
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
    '2. Separe FATO de HIPÓTESE. Fato é o que as consultas mostram (em qual canal caiu, quais itens puxaram, se foi menos unidade ou preço menor, se a margem mudou, se o dia era data dupla ou feriado). Hipótese é o motivo por trás — e você só pode levantar hipótese marcando como hipótese. O que NÃO está nos dados você não sabe: ' + (o.comOlhos ? 'preço de concorrente, se um anúncio estava ativo ou pausado, em quais campanhas a loja entrou, cupom' : 'preço de concorrente, anúncio pausado, falta de estoque, em quais campanhas a loja entrou, cupom, anúncio patrocinado, reputação da conta') + '. Pode citar como coisa a conferir, nunca como causa.',
    '3. Se uma consulta trouxer "avisos", eles valem pra sua resposta: repita pro dono o que afeta a conclusão (período incompleto, margem superestimada por falta de custo, dia de hoje parcial).',
    '4. Períodos de tamanhos diferentes se comparam pela média por dia, que já vem calculada.',
    '5. Você só enxerga vendas agregadas (por período, canal e item)' + (o.comOlhos ? ', o calendário comercial e o que as consultas de anúncios, reputação, estoque e expedição trazem' : ' e o calendário comercial') + '. Não tem dados de clientes nem de pedidos individuais, e não altera nada no sistema. Se pedirem algo fora disso, diga que este chat não faz.',
    '6. CONTEXTO ANTES DE CONCLUIR. Pra dizer que um dia foi bom ou ruim, compare com o MESMO dia da semana de pelo menos ' + SEMANAS_PADRAO + ' semanas (comparar_mesmo_dia_da_semana) — nunca só com poucos dias ou semanas vizinhas. Pra dizer que uma semana ou um mês foi "o pior" ou "o melhor", olhe pelo menos 3 meses. Diga sempre contra quantas semanas/meses você comparou.',
    '7. CALENDÁRIO. Datas duplas (1/1, 2/2 … 11/11, 12/12) são dias de campanha dos marketplaces e costumam concentrar venda — e podem ANTECIPAR ou ADIAR a compra dos dias vizinhos. Feriado e véspera de feriado também mexem — os nacionais e os de São Paulo (estado e capital), que vêm marcados com o alcance. As consultas trazem as datas do calendário do período e as que ficam perto do dia analisado: quando houver, MENCIONE (é fato que a data existia) e levante o efeito como hipótese. O calendário não diz se a loja participou da campanha.',
    '8. NÚMERO DO DASHBOARD DIFERENTE DO SEU. Se o dono citar um valor da tela que não bate com a consulta, não diga que o número dele está errado nem mande ele conferir: mostre os dois e explique a causa que a consulta informar nos avisos (a regra do dia da venda; comissão e frete provisórios nos dias recentes; hoje incompleto). Sem aviso que explique, diga que não sabe a causa da diferença.',
    '9. MARGEM DE DIA RECENTE. Quando o aviso DIAS RECENTES vier, a margem desses dias está inflada: não use ela pra concluir nada e não compare com a margem de períodos antigos. Fale de faturamento, pedidos, ticket e itens — e diga que a margem ainda é provisória.',
  ].concat(o.comOlhos ? OLHOS.REGRAS.map((r, i) => (10 + i) + '. ' + r) : []).concat([
    '',
    'FORMATO: comece pela resposta à pergunta, em uma ou duas frases, com os números principais. Depois, se ajudar, os detalhes em lista curta. Valores em reais no formato R$ 1.234,56; percentuais com uma casa. Sem títulos grandes, sem tabela larga (a tela é estreita). No fim, se couber, UMA sugestão do que olhar em seguida.',
  ]).join('\n');
}

/* descrição curta do que está sendo consultado, pra tela mostrar enquanto espera */
function descreverConsulta(nome, inp) {
  const br = (iso) => (typeof iso === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(iso) ? iso.slice(8, 10) + '/' + iso.slice(5, 7) : '?');
  inp = inp || {};
  if (nome === 'comparar_periodos') return 'Comparando ' + br(inp.antes_de) + '–' + br(inp.antes_ate) + ' com ' + br(inp.depois_de) + '–' + br(inp.depois_ate);
  if (nome === 'resumo_periodo') return 'Lendo as vendas de ' + br(inp.de) + ' a ' + br(inp.ate);
  if (nome === 'comparar_mesmo_dia_da_semana') { const k = parseInt(inp.semanas, 10); return 'Comparando ' + br(inp.dia) + ' com o mesmo dia da semana de ' + Math.min(SEMANAS_MAX, Math.max(SEMANAS_MIN, Number.isFinite(k) ? k : SEMANAS_PADRAO)) + ' semanas'; }
  if (nome === 'calendario_comercial') return 'Olhando o calendário de ' + br(inp.de) + ' a ' + br(inp.ate);
  if (nome === 'ranking_itens') return 'Ordenando os itens de ' + br(inp.de) + ' a ' + br(inp.ate);
  if (nome === 'buscar_item') return 'Procurando o item "' + String(inp.texto || '').slice(0, 40) + '"';
  if (nome === 'evolucao_item') return 'Vendo a evolução do item ' + String(inp.sku || '').slice(0, 40);
  return OLHOS.descrever(nome, inp) || 'Consultando';
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
    body: JSON.stringify({ model: o.modelo, max_tokens: MAX_TOKENS_RESPOSTA, system: o.system, tools: o.tools || FERRAMENTAS, messages: o.messages, stream: true }) });
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
  /* os "olhos" só existem quando quem chama passou as peças da empresa (o cache dela, o token do ML dela…) */
  const olhos = o.olhos ? OLHOS.criarOlhos(Object.assign({ hoje, validarPeriodo }, o.olhos)) : null;
  const tools = olhos ? FERRAMENTAS.concat(OLHOS.FERRAMENTAS) : FERRAMENTAS;
  const ferr = criarFerramentas({ hoje, consultarHistorico: o.consultarHistorico, olhos });
  const system = promptDoSistema({ hoje, nomeEmpresa: o.nomeEmpresa, comOlhos: !!olhos });
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
  /* o registro das últimas perguntas (rota ?diag=1) anota por onde a pergunta passou — é o que diz ATÉ ONDE ela chegou
     quando alguma coisa cai no meio. Anotar nunca derruba a conversa. */
  const anotar = (txt) => { if (typeof o.aoPasso === 'function') { try { o.aoPasso(txt); } catch (e) {} } };
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
    anotar('ida ' + rodadas + ' ao modelo: chamando');
    const r = await chamarModelo({ fetch: o.fetch, chave: o.chave, modelo: o.modelo, prazoMs: o.prazoApiMs, system, tools, messages, aoTexto: (t) => { texto += t; o.enviar({ t: 'texto', d: t }); } });
    entrada += r.entrada; saida += r.saida;
    anotar('ida ' + rodadas + ' ao modelo: respondeu (' + r.parada + ', ' + r.entrada + ' + ' + r.saida + ' tokens)');
    const usos = r.blocos.filter((b) => b.type === 'tool_use');
    if (r.parada === 'tool_use' && usos.length) {
      messages.push({ role: 'assistant', content: r.blocos.map((b) => (b.type === 'tool_use' ? { type: 'tool_use', id: b.id, name: b.name, input: b.input } : { type: 'text', text: b.text })).filter((b) => b.type !== 'text' || b.text) });
      const resultados = [];
      for (const u of usos) {
        o.enviar({ t: 'passo', texto: descreverConsulta(u.name, u.input) });
        anotar('consulta: ' + descreverConsulta(u.name, u.input) + ' — começou');
        let conteudo, erro = false;
        try {
          if (saiu()) throw new Error('a conversa foi encerrada');
          if (u._entradaInvalida) throw new Error('os parâmetros da consulta vieram ilegíveis — refaça a chamada');
          if (!Object.prototype.hasOwnProperty.call(ferr.F, u.name)) throw new Error('consulta desconhecida: ' + u.name);
          conteudo = JSON.stringify(await ferr.F[u.name](u.input || {}));
        } catch (e) { erro = true; conteudo = String((e && e.message) || e).slice(0, 500); }
        anotar('consulta: ' + descreverConsulta(u.name, u.input) + (erro ? ' — ERRO: ' + conteudo.slice(0, 140) : ' — ok (' + conteudo.length + ' caracteres)'));
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
  /* 14/11 — REGISTRO DAS ÚLTIMAS PERGUNTAS (rota `<prefixo>/chat-analise?diag=1`, só admin).
     Pego no 1º teste do dono em produção: a tela mostrou "NetworkError" (a conexão com o servidor caiu) e NÃO havia como
     saber, daqui, se a pergunta tinha chegado, até onde tinha ido, nem se o serviço tinha reiniciado no meio — a rota não
     deixava rastro nenhum. Agora cada pergunta grava em disco quando começa, a cada passo (ida ao modelo, consulta) e
     quando termina. Pergunta que ficou "em andamento" de ANTES de o processo atual subir é pergunta que o reinício do
     serviço (deploy ou queda) cortou — e o registro diz isso com todas as letras. Guarda as últimas 30. */
  const ARQ_ULTIMAS = () => path.join(ctx.CACHE_DIR, '_chat-analise-ultimas.json');
  const MAX_ULTIMAS = 30, MAX_PASSOS = 40;
  const lerUltimas = () => { const l = readJson(ARQ_ULTIMAS(), []); return Array.isArray(l) ? l : []; };
  function gravarUltima(reg) {
    try {
      const l = lerUltimas().filter((x) => x && x.id !== reg.id);
      l.push(reg);
      writeJson(ARQ_ULTIMAS(), l.slice(-MAX_ULTIMAS));
    } catch (e) {}
  }
  const processoNoArDesde = () => new Date(Date.now() - Math.round(process.uptime() * 1000)).toISOString();
  function retratoDasUltimas() {
    const boot = processoNoArDesde();
    return lerUltimas().slice().reverse().map((x) => (x && x.estado === 'em andamento' && String(x.inicio) < boot
      ? Object.assign({}, x, { estado: 'interrompida pelo reinício do serviço', leia: 'esta pergunta começou ANTES de o processo atual subir e nunca terminou: o serviço reiniciou (deploy ou queda) no meio dela. Na tela isso aparece como erro de conexão ("NetworkError" / "Failed to fetch").' })
      : x));
  }
  const CONV = require('./chat-conversas').criar({ CACHE_DIR: ctx.CACHE_DIR, readJson, writeJson });
  /* o gasto do MÊS: a soma dos dias do mês que o contador guarda (ele guarda os últimos 35 dias, então o mês corrente
     está sempre inteiro). É ESTIMATIVA pela tabela de preços daqui — o valor cobrado de verdade é o do Console da Anthropic */
  function usoDoMes(dia) {
    const u = lerUso(), mes = String(dia).slice(0, 7);
    const t = { mes, dias_com_uso: 0, perguntas: 0, tokens_entrada: 0, tokens_saida: 0, usd_estimado: 0 };
    for (const k of Object.keys(u)) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(k) || k.slice(0, 7) !== mes || !u[k] || typeof u[k] !== 'object') continue;
      t.dias_com_uso++; t.perguntas += num(u[k].perguntas); t.tokens_entrada += num(u[k].tokens_entrada); t.tokens_saida += num(u[k].tokens_saida);
      t.usd_estimado = Math.round((t.usd_estimado + num(u[k].usd_estimado)) * 10000) / 10000;
    }
    return t;
  }
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

    if (req.method === 'GET' && urlObj.searchParams.get('diag') === '1') {
      json(res, 200, { ok: true, agora: new Date().toISOString(), processo_no_ar_desde: processoNoArDesde(), configurado: !!chave, modelo: modelo(),
        leia: 'as últimas perguntas, da mais nova pra mais antiga, com os passos de cada uma e o tempo em que aconteceram. "em andamento" = ainda respondendo; "interrompida pelo reinício do serviço" = o deploy/queda cortou no meio; "respondida no servidor, mas a tela fechou antes de receber" = a resposta ficou pronta aqui e a conexão com o navegador caiu antes (na tela aparece erro de conexão).',
        ultimas: retratoDasUltimas() });
      return true;
    }
    /* 14/11 — SONDA DA REPUTAÇÃO (`?reputacao=1`, só admin): o bloco de reputação como o Mercado Livre mandou, ao lado do
       resumo que o chat lê e das fotos guardadas. Existe pra conferir a leitura contra a conta de verdade (o formato foi
       escrito pela documentação do ML) — e não gasta pergunta nem chama o modelo. Também grava a foto do dia. */
    if (req.method === 'GET' && urlObj.searchParams.get('reputacao') === '1') {
      const ol = ctx.olhos || {};
      if (typeof ol.garantirTokenML !== 'function') { json(res, 200, { ok: false, erro: 'esta loja não tem a conta do Mercado Livre ligada ao dashboard' }); return true; }
      const REP = require('./reputacao-ml');
      const cx = { CACHE_DIR: ctx.CACHE_DIR, readJson, writeJson };
      const r = await REP.consultar({ fetch: ol.fetch || fetchApi, garantirTokenML: ol.garantirTokenML });
      if (r.ok) REP.fotografar(Object.assign({ dia: hoje, resumo: r.resumo }, cx));
      json(res, 200, { ok: r.ok, erro: r.ok ? undefined : r.erro, leia: '"como_o_mercado_livre_mandou" é a resposta crua do ML; "resumo" é o que o chat lê dela. Taxa nula no resumo = a unidade da taxa não pôde ser confirmada pela própria resposta.',
        resumo: r.ok ? r.resumo : null, como_o_mercado_livre_mandou: r.ok ? r.cru : null, fotos_guardadas: REP.historico(Object.assign({ de: '0000-00-00', ate: '9999-99-99' }, cx)) });
      return true;
    }
    /* 14/11 — as conversas guardadas: a lista (leve, sem o texto) e uma conversa inteira */
    if (req.method === 'GET' && urlObj.searchParams.get('conversas') === '1') { json(res, 200, { ok: true, conversas: CONV.listar() }); return true; }
    if (req.method === 'GET' && urlObj.searchParams.has('conversa')) {
      const c = CONV.abrir(urlObj.searchParams.get('conversa'));
      json(res, 200, c ? { ok: true, conversa: c } : { ok: false, erro: 'essa conversa não existe mais' });
      return true;
    }
    if (req.method === 'GET') {
      json(res, 200, { ok: true, configurado: !!chave, env: ENV_CHAVE, modelo: modelo(), hoje: Object.assign({ dia: hoje, limite_perguntas: limiteDia() }, usoHoje), mes: usoDoMes(hoje) });
      return true;
    }
    if (req.method !== 'POST') { json(res, 405, { ok: false, erro: 'use POST' }); return true; }
    let corpo;
    try { corpo = JSON.parse(await lerCorpo(req) || '{}'); } catch (e) { json(res, 400, { ok: false, erro: 'não entendi o pedido: ' + String(e.message || e).slice(0, 80) }); return true; }
    /* 14/11 — arrumar as conversas guardadas (renomear, apagar): não é pergunta — não gasta, não conta no limite do dia e
       funciona mesmo com o chat desligado (sem a chave da API). Quando NÃO dá (a conversa já não existe, título vazio), a
       resposta leva a lista como ela está no disco, pra tela mostrar a verdade; se foi o disco que falhou, vai sem lista
       e a tela fica com a que tinha — nunca some da tela o que não foi apagado. */
    if (corpo && corpo.acao != null) {
      try {
        if (corpo.acao === 'renomear') json(res, 200, CONV.renomear(corpo.id, corpo.titulo) ? { ok: true, conversas: CONV.listar() } : { ok: false, erro: 'não deu pra renomear: a conversa não existe mais ou o título veio vazio', conversas: CONV.listar() });
        else if (corpo.acao === 'apagar') json(res, 200, CONV.apagar(corpo.id) ? { ok: true, conversas: CONV.listar() } : { ok: false, erro: 'essa conversa já não existia', conversas: CONV.listar() });
        else json(res, 400, { ok: false, erro: 'ação desconhecida' });
      } catch (e) { json(res, 200, { ok: false, erro: 'não consegui gravar: ' + String((e && e.message) || e).slice(0, 120) }); }
      return true;
    }
    if (!chave) { json(res, 200, { ok: false, erro: 'O chat ainda não está ligado: falta a variável ' + ENV_CHAVE + ' neste serviço (Render → Environment).' }); return true; }
    const LIMITE_DIA = 'O limite de ' + limiteDia() + ' perguntas por dia desta loja foi atingido. Volta amanhã (ou aumente DASHBOARD_CHAT_MAX_DIA).';
    if (usoHoje.perguntas >= limiteDia()) { json(res, 200, { ok: false, erro: LIMITE_DIA }); return true; }
    const pergunta = String((corpo && corpo.pergunta) || '').trim();
    if (!pergunta) { json(res, 400, { ok: false, erro: 'escreva a pergunta' }); return true; }
    if (pergunta.length > MAX_PERGUNTA) { json(res, 400, { ok: false, erro: 'a pergunta passou de ' + MAX_PERGUNTA + ' caracteres — encurte' }); return true; }
    if (!reservarPergunta(hoje)) { json(res, 200, { ok: false, erro: LIMITE_DIA }); return true; }

    const t0 = Date.now();
    const reg = { id: t0.toString(36) + Math.random().toString(36).slice(2, 6), inicio: new Date(t0).toISOString(), fim: null, segundos: null, estado: 'em andamento',
      pergunta: pergunta.slice(0, 80) + (pergunta.length > 80 ? '…' : ''), quem: sess ? 'sessão de ' + sess : 'chave de admin', modelo: modelo(), passos: [] };
    const anotarPasso = (txt) => { if (reg.passos.length < MAX_PASSOS) { reg.passos.push(((Date.now() - t0) / 1000).toFixed(1) + ' s — ' + txt); gravarUltima(reg); } };
    const fecharRegistro = (estado, extra) => {
      Object.assign(reg, { fim: new Date().toISOString(), segundos: Math.round((Date.now() - t0) / 100) / 10, estado }, extra || {});
      /* como a conexão estava QUANDO a pergunta acabou — vale pra resposta, cancelamento e erro (o erro que acontece
         depois de a tela fechar não chegou a ninguém) */
      if (!aberto) reg.tela_fechou_antes_do_fim = true;
      gravarUltima(reg);
      console.log('[chat-analise ' + ctx.empresa + '] ' + estado + ' em ' + reg.segundos + ' s' + (reg.uso ? ' · ' + reg.uso.idas_ao_modelo + ' ida(s), ' + reg.uso.consultas + ' consulta(s), ' + reg.uso.tokens_entrada + '+' + reg.uso.tokens_saida + ' tokens' : '') + (reg.erro ? ' · ' + reg.erro : ''));
    };

    /* daqui pra frente a resposta vai em pedaços (text/event-stream): o texto aparece enquanto é escrito.
       (A peça não escreve o cabeçalho `Connection`: é cabeçalho de salto — quem cuida dele é o próprio servidor HTTP do
       Node e o proxy na frente; aplicação não põe a mão.) */
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', 'X-Accel-Buffering': 'no' });
    let aberto = true;
    /* `res` fechado antes da hora = quem perguntou saiu (fechou a aba, caiu a rede). O `close` do `req` não serve: ele
       dispara quando o CORPO do pedido termina de ser lido, com a resposta ainda no meio. */
    if (typeof res.on === 'function') res.on('close', () => { if (aberto && reg.estado === 'em andamento') anotarPasso('a conexão com a tela FECHOU antes de a resposta terminar'); aberto = false; });
    try { if (typeof res.flushHeaders === 'function') res.flushHeaders(); } catch (e) {}
    const enviar = (ev) => { if (!aberto) return; try { res.write('data: ' + JSON.stringify(ev) + '\n\n'); } catch (e) { aberto = false; } };
    enviar({ t: 'inicio', modelo: modelo() });
    /* linha de comentário do SSE (a tela ignora): mantém a conexão viva enquanto uma consulta longa roda */
    const batimento = setInterval(() => { if (aberto) { try { res.write(': vivo\n\n'); } catch (e) { aberto = false; } } }, ctx.batimentoMs || BATIMENTO_MS);
    if (typeof batimento.unref === 'function') batimento.unref();
    try {
      const r = await responder({ fetch: fetchApi, chave, modelo: modelo(), hoje, nomeEmpresa, pergunta, historico: corpo.historico, enviar, cancelado: () => !aberto, prazoApiMs: ctx.prazoApiMs, aoPasso: anotarPasso,
        consultarHistorico: (de, ate) => ctx.consultarHistorico(req, urlObj, de, ate),
        olhos: ctx.olhos ? Object.assign({ empresa: ctx.empresa, CACHE_DIR: ctx.CACHE_DIR, readJson, writeJson, fetch: fetchApi }, ctx.olhos) : null });
      const dia = somarTokens(hoje, r.uso);
      /* 14/11 — a troca que TERMINOU é guardada aqui, no servidor (a tela fechada não perde o que já foi respondido; a
         pergunta cancelada no meio não entra). Não conseguir guardar não derruba a resposta: ela segue, sem o id. */
      let conversa = null;
      if (!r.cancelada && r.texto.trim()) {
        try { conversa = CONV.registrar(corpo.conversa, { pergunta, resposta: r.texto, usd_estimado: r.uso.usd_estimado }); }
        catch (e) { anotarPasso('não consegui guardar a conversa: ' + String((e && e.message) || e).slice(0, 100)); }
      }
      enviar({ t: 'fim', uso: r.uso, hoje: Object.assign({ dia: hoje, limite_perguntas: limiteDia() }, dia), mes: usoDoMes(hoje), conversa });
      /* Codex #875: a ÚLTIMA ida ao modelo encerra a pergunta sem passar de novo pela conferência "a tela fechou?" do laço
         — se a conexão cai enquanto a resposta FINAL é escrita (inclusive na pergunta de uma ida só, sem consulta),
         `responder` devolve o texto inteiro com `cancelada: false`. Quem sabe se a resposta CHEGOU é a conexão: o registro
         olha o estado dela DEPOIS de tentar mandar o fim. Resposta pronta que a tela não recebeu não é "respondida" — na
         tela aquilo foi erro de conexão, e o registro tem que contar a mesma história. */
      fecharRegistro(r.cancelada ? 'cancelada (a tela fechou no meio)' : !aberto ? 'respondida no servidor, mas a tela fechou antes de receber' : 'respondida', { uso: r.uso, caracteres_da_resposta: r.texto.length });
    } catch (e) {
      try { fecharRegistro('erro', { uso: (e && e.uso) || undefined, erro: String((e && e.message) || e).slice(0, 300) }); } catch (e2) {}
      /* (a pergunta já está contada no dia — foi reservada antes de gastar.) Codex #873 r2: e o que ela GASTOU antes de
         falhar entra na conta do dia e vai pra tela — pergunta de várias idas que cai na última não some do gasto */
      let dia = null;
      try { dia = somarTokens(hoje, e && e.uso); } catch (e2) {}
      const st = e && e.status;
      enviar({ t: 'erro', uso: (e && e.uso) || undefined, hoje: dia ? Object.assign({ dia: hoje, limite_perguntas: limiteDia() }, dia) : undefined, mes: dia ? usoDoMes(hoje) : undefined, erro: st === 401 ? 'A chave da Anthropic foi recusada (401). Confira a variável ' + ENV_CHAVE + ' no Render.'
        : st === 429 ? 'A Anthropic limitou as chamadas agora (429). Tente de novo em um minuto.'
        : st === 400 && /credit|balance|billing/i.test(String(e.message)) ? 'A conta da Anthropic está sem saldo de API. ' + String(e.message).slice(0, 200)
        : String((e && e.message) || e).slice(0, 300) });
    }
    clearInterval(batimento);
    try { res.end(); } catch (e) {}
    return true;
  };
}

module.exports = { criar, responder, criarFerramentas, periodosNomeados, validarPeriodo, promptDoSistema, FERRAMENTAS, ENV_CHAVE, MODELO_PADRAO, PRECO_USD_MTOK, MAX_RODADAS, MAX_TOKENS_ENTRADA_PERGUNTA, SEMANAS_PADRAO, SEMANAS_MIN, SEMANAS_MAX, DIAS_RECENTES, BASE_NO_DIA_DE_BRASILIA_DESDE, hojeSP };
