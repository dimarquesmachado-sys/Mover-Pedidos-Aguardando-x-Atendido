'use strict';

/* ─────────────────────────────────────────────────────────────────────────────
   OS ANÚNCIOS DA CONTA NO MERCADO LIVRE (15/11/2026) — leitura ao vivo + uma FOTO por dia.

   Pedido do dono, sobre o chat de análise: enxergar "se o anúncio estava ativo", as promoções e o Full. A sonda (#887)
   rodou na Girassol em 15/11 e mostrou o formato REAL da conta; este leitor lê SÓ o que ela conferiu:
     · `GET /users/{id}/items/search?include_filters=true` → `paging.total` e, em `available_filters`, quantos anúncios
       há em cada SITUAÇÃO (`status`: active, paused, pending, closed…) e por MOTIVO (`sub_status`: forbidden,
       waiting_for_patch…);
     · `…?reputation_health_gauge=unhealthy` → `paging.total` = anúncios perdendo exposição;
     · `…?logistic_type=fulfillment&status=active` → `paging.total` = anúncios ativos no Full;
     · `GET /seller-promotions/users/{id}?app_version=v2` → as promoções/campanhas ABERTAS pra conta.

   É A CONTA INTEIRA, NÃO UM PRODUTO: diz QUANTOS anúncios estão em cada situação — não QUAIS. ("ESTE anúncio estava
   ativo?" depende da leitura por produto, que ainda está na sonda.) E a lista de promoções é a das campanhas abertas
   pra conta — não diz quais anúncios entraram em qual.

   O ML só diz como está AGORA. Pra responder "pausaram anúncio? caiu o número de ativos?" é preciso ter guardado como
   estava: cada leitura grava a foto do dia em `<cache da empresa>/_anuncios_ml.json` (a madrugada tira uma; perguntar
   no chat também grava). Antes da primeira foto NÃO HÁ registro — e a peça diz isso.

   NÚMERO ERRADO É PIOR QUE NÚMERO AUSENTE:
     · parte que o ML não respondeu fica `null` e entra em "faltou" com o motivo — nunca vira zero;
     · situação que o ML não listou fica de fora (não é "zero anúncios");
     · a soma das situações é conferida contra o total; se não bater, a peça diz.
   PRAZO: um por pedido e um pro conjunto (lib/checkout/com-prazo.js) — o ML que emudece não prende a pergunta do chat
   nem a etapa da madrugada, e o que já respondeu continua valendo.
   ───────────────────────────────────────────────────────────────────────────── */

const { prazoEmSequencia } = require('./com-prazo');

const ARQUIVO = '_anuncios_ml.json';
const MAX_FOTOS = 400;
const PRAZO_MS = 30000;         /* a consulta inteira: o token + as cinco idas ao ML */
const PRAZO_PEDIDO_MS = 10000;  /* cada ida */
const MAX_PROMOCOES = 30;
const ML = 'https://api.mercadolibre.com';
const FOTOS = require('./fotos-diarias').criar({ arquivo: ARQUIVO, maxFotos: MAX_FOTOS });

/* as situações que o ML lista (os nomes dele, conferidos em 15/11) → o nome que o chat lê */
const SITUACOES = { active: 'ativos', paused: 'pausados', pending: 'inativos_por_pendencia_ou_infracao', closed: 'encerrados', not_yet_active: 'recem_criados_ainda_nao_ativos', programmed: 'programados' };

const contagem = (x) => (typeof x === 'number' && Number.isInteger(x) && x >= 0 ? x : null);
const texto = (x) => (typeof x === 'string' && x ? x : null);
/* o código vem do ML: só vale o que está NA tabela (um código "constructor" não pode achar o que o objeto herda) */
const daTabela = (tabela, codigo) => (Object.prototype.hasOwnProperty.call(tabela, codigo) ? tabela[codigo] : null);
const totalDe = (corpo) => contagem(corpo && corpo.paging && corpo.paging.total);

/* as respostas do ML → o resumo que o chat lê. `p`: { todos, perdendo, full, promocoes } (o que não veio fica de fora).
   null = o ML não mandou a contagem por situação (sem ela não há leitura). */
function resumir(p) {
  const t = p && p.todos;
  const filtros = t && Array.isArray(t.available_filters) ? t.available_filters : [];
  const valores = (id) => { const f = filtros.find((x) => x && x.id === id); return f && Array.isArray(f.values) ? f.values : null; };
  const st = valores('status');
  if (!st) return null;
  const porSituacao = {}, outras = {};
  let soma = 0, lidas = 0;
  for (const v of st) {
    const n = contagem(v && v.results);
    if (n == null || typeof v.id !== 'string' || !v.id) continue;
    soma += n; lidas++;
    const nome = daTabela(SITUACOES, v.id);
    if (nome) porSituacao[nome] = n;
    else if (n > 0 && !(v.id in Object.prototype)) outras[v.id] = n;
  }
  if (!lidas) return null;
  const sub = valores('sub_status');
  const total = totalDe(t);
  const pr = p.promocoes && Array.isArray(p.promocoes.results) ? p.promocoes.results.filter((x) => x && typeof x === 'object') : null;
  return {
    total,
    por_situacao: porSituacao,
    outras_situacoes: outras,
    a_soma_das_situacoes_bate_com_o_total: total == null ? null : soma === total,
    /* o motivo de anúncios parados, como o ML chama — só os que têm anúncio */
    por_motivo: sub ? sub.filter((v) => v && typeof v.id === 'string' && v.id && contagem(v.results) > 0).map((v) => ({ codigo: v.id, nome_no_mercado_livre: texto(v.name), anuncios: v.results })) : null,
    perdendo_exposicao: totalDe(p.perdendo),
    no_full_ativos: totalDe(p.full),
    promocoes_abertas: pr ? pr.slice(0, MAX_PROMOCOES).map((x) => ({ id: texto(x.id), tipo: texto(x.type), nome: texto(x.name), situacao: texto(x.status), comeca: texto(x.start_date), termina: texto(x.finish_date), data_limite: texto(x.deadline_date) })) : null,
    promocoes_abertas_total: pr ? (contagem(p.promocoes.paging && p.promocoes.paging.total) != null ? p.promocoes.paging.total : pr.length) : null,
  };
}

/* pergunta ao ML. Nunca lança e nunca fica pendurada:
   { ok:true, resumo, faltou:[{ o_que, motivo }], cru } | { ok:false, erro } */
async function consultar(o) {
  const ir = prazoEmSequencia(Number(o && o.prazoMs) > 0 ? Number(o.prazoMs) : PRAZO_MS, Number(o && o.prazoPedidoMs) > 0 ? Number(o.prazoPedidoMs) : PRAZO_PEDIDO_MS);
  const semTempo = () => ({ erro: 'o prazo da consulta acabou antes deste pedido' });
  const falhou = (e) => ({ erro: 'não respondeu (' + String((e && e.message) || e).slice(0, 100) + ')' });

  const tk = await ir(async () => ({ token: o && typeof o.garantirTokenML === 'function' ? await o.garantirTokenML() : null }), () => ({ erro: 'a renovação do token não respondeu no prazo' }), semTempo)
    .catch((e) => ({ erro: String((e && e.message) || e).slice(0, 100) }));
  if (tk.erro) return { ok: false, erro: 'o acesso ao Mercado Livre não está disponível (' + tk.erro + ')' };
  if (!tk.token) return { ok: false, erro: 'esta loja está sem acesso ao Mercado Livre agora' };

  /* um GET. Devolve { corpo } (um objeto) ou { erro } */
  const get = (caminho) => ir(async (sinal) => {
    const r = await o.fetch(ML + caminho, { method: 'GET', headers: { Authorization: 'Bearer ' + tk.token }, signal: sinal });
    if (!r || !r.ok) return { erro: 'o Mercado Livre respondeu HTTP ' + (r ? r.status : '?') };
    let d = null;
    try { d = await r.json(); } catch (e) { d = null; }
    return d && typeof d === 'object' ? { corpo: d } : { erro: 'o Mercado Livre respondeu sem JSON' };
  }, () => ({ erro: 'o Mercado Livre não respondeu no prazo' }), semTempo).catch(falhou);

  const eu = await get('/users/me');
  const id = eu.corpo && /^\d+$/.test(String(eu.corpo.id)) ? String(eu.corpo.id) : null;
  if (!id) return { ok: false, erro: 'o Mercado Livre não disse de quem é a conta (' + (eu.erro || 'a resposta veio sem o id') + ')' };
  const busca = '/users/' + id + '/items/search?';
  const PARTES = [
    ['todos', 'os anúncios por situação', busca + 'include_filters=true&limit=5'],
    ['perdendo', 'os anúncios perdendo exposição', busca + 'reputation_health_gauge=unhealthy&limit=3'],
    ['full', 'os anúncios ativos no Full', busca + 'logistic_type=fulfillment&status=active&limit=5'],
    ['promocoes', 'as promoções abertas pra conta', '/seller-promotions/users/' + id + '?app_version=v2'],
  ];
  const cru = {}, faltou = [];
  for (const [chave, nome, caminho] of PARTES) {
    const r = await get(caminho);
    if (r.erro) faltou.push({ o_que: nome, motivo: r.erro }); else cru[chave] = r.corpo;
  }
  if (!cru.todos) return { ok: false, erro: 'não consegui ler os anúncios da conta (' + faltou[0].motivo + ')' };
  const resumo = resumir(cru);
  if (!resumo) return { ok: false, erro: 'o Mercado Livre respondeu sem a contagem dos anúncios por situação' };
  return { ok: true, resumo, faltou, cru };
}

/* ── as fotos ── uma por dia (a última leitura do dia vence) */
function fotoDe(resumo, em) {
  return { em, total: resumo.total, por_situacao: resumo.por_situacao, perdendo_exposicao: resumo.perdendo_exposicao, no_full_ativos: resumo.no_full_ativos,
    promocoes: resumo.promocoes_abertas ? resumo.promocoes_abertas.filter((x) => x.id).map((x) => ({ id: x.id, tipo: x.tipo, nome: x.nome })) : null };
}
/* grava a foto do dia. Devolve true se gravou (falha de disco não derruba quem chamou) */
function fotografar(o) {
  if (!o || !o.resumo) return false;
  return FOTOS.gravar(o, o.dia, fotoDe(o.resumo, o.em || new Date().toISOString()));
}
const historico = (o) => FOTOS.historico(o, o.de, o.ate);

/* o que mudou entre a foto mais antiga da janela e a mais nova — as contas em código.
   Cada número: { antes, depois, diferenca }; `diferenca` nula = uma das duas fotos não tem o número (não dá pra dizer). */
const naFoto = (f, k) => contagem(f.por_situacao && f.por_situacao[k]);
function comparar(fotos) {
  if (!Array.isArray(fotos) || fotos.length < 2) return null;
  const a = fotos[0], b = fotos[fotos.length - 1];
  const delta = (x, y) => ({ antes: x, depois: y, diferenca: x != null && y != null ? y - x : null });
  const out = { de: a.dia, ate: b.dia, fotos: fotos.length, total: delta(contagem(a.total), contagem(b.total)) };
  for (const k of ['ativos', 'pausados', 'inativos_por_pendencia_ou_infracao']) out[k] = delta(naFoto(a, k), naFoto(b, k));
  out.perdendo_exposicao = delta(contagem(a.perdendo_exposicao), contagem(b.perdendo_exposicao));
  out.no_full_ativos = delta(contagem(a.no_full_ativos), contagem(b.no_full_ativos));
  /* promoções que entraram / saíram: só quando as DUAS fotos trazem a lista */
  const ids = (f) => (Array.isArray(f.promocoes) ? f.promocoes.filter((x) => x && x.id) : null);
  const pa = ids(a), pb = ids(b);
  out.promocoes_que_entraram = pa && pb ? pb.filter((x) => !pa.some((y) => y.id === x.id)) : null;
  out.promocoes_que_sairam = pa && pb ? pa.filter((x) => !pb.some((y) => y.id === x.id)) : null;
  return out;
}
/* a linha de cada dia, pro chat achar EM QUE DIA mudou */
const linhaDoDia = (f) => ({ dia: f.dia, total: contagem(f.total), ativos: naFoto(f, 'ativos'), pausados: naFoto(f, 'pausados'), inativos_por_pendencia_ou_infracao: naFoto(f, 'inativos_por_pendencia_ou_infracao'),
  perdendo_exposicao: contagem(f.perdendo_exposicao), no_full_ativos: contagem(f.no_full_ativos) });

/* a etapa da madrugada: lê e grava a foto de hoje. Devolve o texto pro resumo da noite; LANÇA se não conseguiu ler ou
   gravar (a etapa aparece como erro — foto que faltou é dia sem histórico) */
async function fotoDaMadrugada(o) {
  const r = await consultar(o);
  if (!r.ok) throw new Error(r.erro);
  const dia = o.dia || new Date().toLocaleString('sv-SE', { timeZone: 'America/Sao_Paulo' }).slice(0, 10);
  if (!fotografar({ CACHE_DIR: o.CACHE_DIR, readJson: o.readJson, writeJson: o.writeJson, dia, resumo: r.resumo })) throw new Error('li os anúncios mas não consegui gravar a foto do dia');
  const s = r.resumo.por_situacao;
  const n = (k) => (s[k] != null ? s[k] : '?');
  return n('ativos') + ' ativos · ' + n('pausados') + ' pausados · ' + n('inativos_por_pendencia_ou_infracao') + ' inativos por pendência/infração' + (r.faltou.length ? ' (faltou: ' + r.faltou.map((f) => f.o_que).join('; ') + ')' : '');
}

module.exports = { consultar, resumir, fotografar, historico, comparar, linhaDoDia, fotoDaMadrugada, ARQUIVO, MAX_FOTOS, PRAZO_MS, PRAZO_PEDIDO_MS, MAX_PROMOCOES, SITUACOES };
