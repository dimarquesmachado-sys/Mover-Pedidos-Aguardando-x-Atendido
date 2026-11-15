'use strict';

/* ─────────────────────────────────────────────────────────────────────────────
   A SAÚDE DA CONTA NA SHOPEE (15/11/2026) — leitura ao vivo + uma FOTO por dia.

   Pedido do dono, sobre o chat de análise: "considerar também a reputação no marketplace, vai que deu algum problema,
   mudou, caiu". A do Mercado Livre o chat já lê (lib/checkout/reputacao-ml.js); esta é a da Shopee.

   A sonda (#887) rodou em 15/11 e mostrou o formato REAL; este leitor lê SÓ o que ela conferiu, pelo serviço que tem o
   token (`pedirAoSync('shopee-raw', { caminho, q })`):
     · `account_health/get_shop_performance` → `overall_performance { rating, fulfillment_failed, listing_failed,
       custom_service_failed }` + `metric_list[{ metric_name, metric_type, parent_metric_id, current_period,
       last_period, unit, target { value, comparator }, exemption_end_date }]`;
     · `account_health/get_penalty_point_history`, `get_punishment_history` (em andamento) e `get_listings_with_issues`
       → `total_count`;
     · `product/get_item_list` por situação (NORMAL, UNLIST, BANNED) → `total_count`;
     · `shop/get_shop_info` → `status` e `expire_time` (até quando vale a autorização do app).

   O QUE NÃO SE LÊ (e a peça diz): o TOTAL de pontos de penalidade — o pedido que traz isso (`shop_penalty`) a Shopee
   recusou ("api_suspended"); aqui só há QUANTOS lançamentos o histórico devolve. E a nota geral vem como um CÓDIGO
   (veio 3): o significado de cada código não foi conferido no painel da loja — a peça entrega o código e quantas
   métricas a própria Shopee diz que estão reprovadas em cada área, que é o que não depende de interpretação.

   O QUE É CONTA DAQUI: `dentro_da_meta` de cada métrica (o valor atual contra a meta que a Shopee mandou, com o
   comparador dela). Só com valor, meta e um comparador conhecido (<, <=, >, >=); senão fica nulo. A área (envio,
   anúncios, atendimento) e a unidade (número, %) saem do código que a Shopee manda — só os códigos vistos na conta
   real; código desconhecido fica nulo, não chutado.

   A Shopee só diz como está AGORA: cada leitura grava a foto do dia em `<cache da empresa>/_saude_shopee.json`.
   (Codex #889) "NÃO INFORMOU" NÃO É "MUDOU": a foto guarda, de cada métrica, o resultado contra a meta em três estados
   (dentro, fora, não dá pra dizer). Uma métrica que estava fora e ficou sem valor NÃO "voltou pra meta"; uma que não
   tinha valor e passou a ter NÃO "saiu da meta". Só há transição entre duas fotos em que o estado é conhecido.
   Foto antiga, sem esse estado, não entra em transição nenhuma.
   NÚMERO ERRADO É PIOR QUE NÚMERO AUSENTE: parte que não veio fica `null` e entra em "faltou" com o motivo.
   PRAZO: um por pedido e um pro conjunto (lib/checkout/com-prazo.js).
   ───────────────────────────────────────────────────────────────────────────── */

const { prazoEmSequencia } = require('./com-prazo');

const ARQUIVO = '_saude_shopee.json';
const MAX_FOTOS = 400;
const PRAZO_MS = 45000;         /* a consulta inteira: oito idas à Shopee, pelo serviço que tem o token */
const PRAZO_PEDIDO_MS = 10000;  /* cada ida */
const MAX_METRICAS = 60;
const FOTOS = require('./fotos-diarias').criar({ arquivo: ARQUIVO, maxFotos: MAX_FOTOS });

/* os códigos vistos na conta real (15/11): a área bate com as falhas por área que a própria Shopee soma */
const AREAS = { 1: 'envio', 2: 'anuncios', 3: 'atendimento' };
const UNIDADES = { 1: 'número', 2: '%' };
const COMPARA = { '<': (a, b) => a < b, '<=': (a, b) => a <= b, '>': (a, b) => a > b, '>=': (a, b) => a >= b };
/* o código vem da Shopee: só vale o que está NA tabela (um código "toString" não pode achar a função herdada do objeto) */
const daTabela = (tabela, codigo) => (Object.prototype.hasOwnProperty.call(tabela, codigo) ? tabela[codigo] : null);

/* os pedidos, na ordem: [chave, o que é (pro "faltou"), caminho, consulta] — os mesmos que a sonda conferiu */
const pag = 'page_no=1&page_size=5';
const ROTEIRO = [
  ['desempenho', 'o desempenho da loja (as métricas)', '/api/v2/account_health/get_shop_performance', ''],
  ['penalidades', 'o histórico de pontos de penalidade', '/api/v2/account_health/get_penalty_point_history', pag],
  ['punicoes', 'as punições em andamento', '/api/v2/account_health/get_punishment_history', 'punishment_status=1&' + pag],
  ['com_problema', 'os anúncios com problema', '/api/v2/account_health/get_listings_with_issues', pag],
  ['ativos', 'os anúncios ativos', '/api/v2/product/get_item_list', 'offset=0&page_size=5&item_status=NORMAL'],
  ['desativados', 'os anúncios desativados', '/api/v2/product/get_item_list', 'offset=0&page_size=1&item_status=UNLIST'],
  ['banidos', 'os anúncios banidos', '/api/v2/product/get_item_list', 'offset=0&page_size=1&item_status=BANNED'],
  ['loja', 'os dados da loja', '/api/v2/shop/get_shop_info', ''],
];

const numero = (x) => { if (x == null || x === '' || typeof x === 'boolean') return null; const n = Number(x); return Number.isFinite(n) ? n : null; };
const contagem = (x) => (typeof x === 'number' && Number.isInteger(x) && x >= 0 ? x : null);
const texto = (x) => (typeof x === 'string' && x ? x : null);
const miolo = (x) => (x && x.response) || null;
const totalDe = (x) => { const m = miolo(x); return m ? contagem(m.total_count) : null; };

function metricaDe(m, nomes) {
  if (!m || !texto(m.metric_name)) return null;
  const atual = numero(m.current_period);
  const alvo = m.target && typeof m.target === 'object' ? { comparador: texto(m.target.comparator), valor: numero(m.target.value) } : null;
  const compara = alvo ? daTabela(COMPARA, alvo.comparador) : null;
  return { nome: m.metric_name, area: daTabela(AREAS, m.metric_type), atual, periodo_anterior: numero(m.last_period), unidade: daTabela(UNIDADES, m.unit), meta: alvo,
    dentro_da_meta: compara && atual != null && alvo.valor != null ? compara(atual, alvo.valor) : null,
    sub_metrica_de: m.parent_metric_id ? (nomes.get(m.parent_metric_id) || null) : null, isenta_ate: texto(m.exemption_end_date) };
}

/* as respostas da Shopee → o resumo que o chat lê. `p`: { desempenho, penalidades, punicoes, com_problema, ativos,
   desativados, banidos, loja } (o que não veio fica de fora). null = não veio NADA */
function resumir(p) {
  if (!p || !ROTEIRO.some(([k]) => p[k])) return null;
  const d = miolo(p.desempenho);
  const geral = d && d.overall_performance && typeof d.overall_performance === 'object' ? d.overall_performance : null;
  const lista = d && Array.isArray(d.metric_list) ? d.metric_list.slice(0, MAX_METRICAS) : null;
  const nomes = new Map();
  for (const m of (lista || [])) if (m) nomes.set(m.metric_id, texto(m.metric_name));
  const metricas = lista ? lista.map((m) => metricaDe(m, nomes)).filter(Boolean) : null;
  const expira = p.loja && contagem(p.loja.expire_time) ? new Date(p.loja.expire_time * 1000).toISOString().slice(0, 10) : null;
  return {
    nota_geral_codigo: geral ? numero(geral.rating) : null,
    reprovadas_por_area: geral ? { envio: contagem(geral.fulfillment_failed), anuncios: contagem(geral.listing_failed), atendimento: contagem(geral.custom_service_failed) } : null,
    metricas,
    fora_da_meta: metricas ? metricas.filter((m) => m.dentro_da_meta === false).map((m) => m.nome) : null,
    lancamentos_de_penalidade: totalDe(p.penalidades),
    punicoes_em_andamento: totalDe(p.punicoes),
    anuncios_com_problema: totalDe(p.com_problema),
    anuncios: { ativos: totalDe(p.ativos), desativados: totalDe(p.desativados), banidos: totalDe(p.banidos) },
    loja: p.loja ? { situacao: texto(p.loja.status), autorizacao_do_app_vale_ate: expira } : null,
  };
}

/* pergunta à Shopee (pelo serviço que tem o token). Nunca lança e nunca fica pendurada:
   { ok:true, resumo, faltou:[{ o_que, motivo }], cru } | { ok:false, erro } */
async function consultar(o) {
  if (!o || typeof o.pedirAoSync !== 'function') return { ok: false, erro: 'esta loja não tem a Shopee ligada ao dashboard' };
  const ir = prazoEmSequencia(Number(o.prazoMs) > 0 ? Number(o.prazoMs) : PRAZO_MS, Number(o.prazoPedidoMs) > 0 ? Number(o.prazoPedidoMs) : PRAZO_PEDIDO_MS);
  const cru = {}, faltou = [];
  for (const [chave, nome, caminho, q] of ROTEIRO) {
    const r = await ir(() => o.pedirAoSync('shopee-raw', { caminho, q }, o.loja), () => ({ ok: false, erro: 'a Shopee não respondeu no prazo' }), () => ({ ok: false, erro: 'o prazo da consulta acabou antes deste pedido' }))
      .catch((e) => ({ ok: false, erro: 'não respondeu (' + String((e && e.message) || e).slice(0, 100) + ')' }));
    /* a resposta da Shopee vem dentro de `dados.resposta` (o envelope do serviço); o erro dela, em `error` */
    const corpo = r && r.dados ? (r.dados.resposta !== undefined ? r.dados.resposta : r.dados) : null;
    const erro = (r && r.erro) || (corpo && corpo.error ? String(corpo.error) + (corpo.message ? ' — ' + String(corpo.message).slice(0, 160) : '') : null)
      || (corpo && typeof corpo === 'object' ? null : 'a Shopee respondeu sem conteúdo');
    if (erro) faltou.push({ o_que: nome, motivo: String(erro).slice(0, 240) }); else cru[chave] = corpo;
  }
  const resumo = resumir(cru);
  if (!resumo) return { ok: false, erro: 'a Shopee não respondeu a nenhum dos pedidos (' + faltou[0].motivo + ')' };
  return { ok: true, resumo, faltou, cru };
}

/* ── as fotos ── uma por dia (a última leitura do dia vence) */
function fotoDe(r, em) {
  const valores = {};
  for (const m of (r.metricas || [])) valores[m.nome] = m.atual;
  const naMeta = {};
  for (const m of (r.metricas || [])) naMeta[m.nome] = m.dentro_da_meta;   /* true | false | null — os três estados */
  return { em, nota_geral_codigo: r.nota_geral_codigo, reprovadas_por_area: r.reprovadas_por_area, metricas: r.metricas ? valores : null, fora_da_meta: r.fora_da_meta, na_meta: r.metricas ? naMeta : null,
    lancamentos_de_penalidade: r.lancamentos_de_penalidade, punicoes_em_andamento: r.punicoes_em_andamento, anuncios_com_problema: r.anuncios_com_problema, anuncios: r.anuncios };
}
function fotografar(o) {
  if (!o || !o.resumo) return false;
  return FOTOS.gravar(o, o.dia, fotoDe(o.resumo, o.em || new Date().toISOString()));
}
const historico = (o) => FOTOS.historico(o, o.de, o.ate);

/* o que mudou entre a foto mais antiga da janela e a mais nova — as contas em código.
   Cada número: { antes, depois, diferenca }; `diferenca` nula = uma das duas fotos não tem o número (não dá pra dizer). */
function comparar(fotos) {
  if (!Array.isArray(fotos) || fotos.length < 2) return null;
  const a = fotos[0], b = fotos[fotos.length - 1];
  const delta = (x, y) => { x = numero(x); y = numero(y); return { antes: x, depois: y, diferenca: x != null && y != null ? Math.round((y - x) * 100) / 100 : null }; };
  const de = (f, grupo, k) => (f[grupo] ? f[grupo][k] : null);
  const out = { de: a.dia, ate: b.dia, fotos: fotos.length, nota_geral_codigo: delta(a.nota_geral_codigo, b.nota_geral_codigo), reprovadas_por_area: {}, anuncios: {} };
  for (const k of ['envio', 'anuncios', 'atendimento']) out.reprovadas_por_area[k] = delta(de(a, 'reprovadas_por_area', k), de(b, 'reprovadas_por_area', k));
  for (const k of ['ativos', 'desativados', 'banidos']) out.anuncios[k] = delta(de(a, 'anuncios', k), de(b, 'anuncios', k));
  for (const k of ['lancamentos_de_penalidade', 'punicoes_em_andamento', 'anuncios_com_problema']) out[k] = delta(a[k], b[k]);
  /* as métricas que MUDARAM (só as que têm valor nas duas fotos) e as que entraram/saíram da lista das fora da meta */
  const ma = a.metricas || null, mb = b.metricas || null;
  out.metricas_que_mudaram = ma && mb ? Object.keys(mb).filter((k) => numero(ma[k]) != null && numero(mb[k]) != null && numero(ma[k]) !== numero(mb[k])).map((k) => Object.assign({ nome: k }, delta(ma[k], mb[k]))) : null;
  /* (Codex #889) saiu/voltou só entre dois estados CONHECIDOS (true/false) — "não dá pra dizer" não é nem um nem outro */
  const ea = a.na_meta && typeof a.na_meta === 'object' ? a.na_meta : null, eb = b.na_meta && typeof b.na_meta === 'object' ? b.na_meta : null;
  const transicao = (de, para) => (ea && eb ? Object.keys(eb).filter((k) => ea[k] === de && eb[k] === para) : null);
  out.sairam_da_meta = transicao(true, false);
  out.voltaram_pra_meta = transicao(false, true);
  out.metricas_sem_estado_conhecido = ea && eb ? Object.keys(Object.assign({}, ea, eb)).filter((k) => typeof ea[k] !== 'boolean' || typeof eb[k] !== 'boolean') : null;
  return out;
}

/* a etapa da madrugada: lê e grava a foto de hoje. Devolve o texto pro resumo da noite; LANÇA se não conseguiu ler ou
   gravar (a etapa aparece como erro — foto que faltou é dia sem histórico) */
async function fotoDaMadrugada(o) {
  const r = await consultar(o);
  if (!r.ok) throw new Error(r.erro);
  const dia = o.dia || new Date().toLocaleString('sv-SE', { timeZone: 'America/Sao_Paulo' }).slice(0, 10);
  if (!fotografar({ CACHE_DIR: o.CACHE_DIR, readJson: o.readJson, writeJson: o.writeJson, dia, resumo: r.resumo })) throw new Error('li a saúde da conta mas não consegui gravar a foto do dia');
  const fora = r.resumo.fora_da_meta;
  return (fora == null ? 'métricas não informadas' : (fora.length ? fora.length + ' métrica(s) fora da meta (' + fora.slice(0, 3).join(', ') + ')' : 'todas as métricas dentro da meta'))
    + (r.faltou.length ? ' (faltou: ' + r.faltou.map((f) => f.o_que).join('; ') + ')' : '');
}

module.exports = { consultar, resumir, fotografar, historico, comparar, fotoDaMadrugada, ROTEIRO, ARQUIVO, MAX_FOTOS, PRAZO_MS, PRAZO_PEDIDO_MS, MAX_METRICAS, AREAS, UNIDADES };
