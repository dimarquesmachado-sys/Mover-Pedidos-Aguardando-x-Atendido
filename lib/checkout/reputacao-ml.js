'use strict';

/* ─────────────────────────────────────────────────────────────────────────────
   REPUTAÇÃO DO VENDEDOR NO MERCADO LIVRE (14/11/2026) — leitura ao vivo + uma FOTO por dia.

   Pedido do dono, sobre o chat de análise: "vale considerar também a reputação no marketplace, vai que deu algum
   problema, mudou, caiu, ou tá com atraso na expedição de pedidos e implica em envios tardios".

   O Mercado Livre entrega a reputação da conta em `GET /users/me` → `seller_reputation`: o nível (a "cor do termômetro"),
   a medalha de MercadoLíder e três métricas do período dele — reclamações, ATRASO NO DESPACHO e cancelamentos —, cada
   uma com a quantidade e a taxa.

   O ML só diz como está AGORA. Pra responder "mudou? caiu?" é preciso ter guardado como estava: por isso cada leitura
   grava a foto do dia em `<cache da empresa>/_reputacao_ml.json` (a rotina da madrugada tira uma por dia; perguntar no
   chat também grava). O histórico começa no dia em que esta peça entrou no ar — antes disso NÃO HÁ registro, e a peça
   diz isso em vez de supor que "estava igual".

   ⚠️ A TAXA. O ML informa `rate` como FRAÇÃO (0,0123 = 1,23%). Como este formato nunca foi conferido contra a conta real
   daqui de dentro, a taxa só vira percentual quando a própria resposta confirma: com quantidade e vendas do período na
   mão, fração dá `rate ≈ quantidade ÷ vendas`. Se não bater nem como fração nem como percentual, a taxa fica "não
   disponível" (a quantidade e as vendas seguem valendo) — número errado é pior que número ausente.
   A rota `<prefixo>/chat-analise?reputacao=1` (admin) mostra o bloco cru do ML ao lado do resumo, pra conferir.
   ───────────────────────────────────────────────────────────────────────────── */

const path = require('path');

const ARQUIVO = '_reputacao_ml.json';
const MAX_FOTOS = 400;   /* dias guardados */
const NIVEIS = { '1_red': 'vermelho (o pior nível)', '2_orange': 'laranja', '3_yellow': 'amarelo', '4_light_green': 'verde-claro', '5_green': 'verde (o melhor nível)' };
const MEDALHAS = { silver: 'MercadoLíder', gold: 'MercadoLíder Gold', platinum: 'MercadoLíder Platinum' };

const r2 = (v) => Math.round(Number(v) * 100) / 100;
const numero = (x) => { if (x == null || x === '' || typeof x === 'boolean') return null; const n = Number(x); return Number.isFinite(n) ? n : null; };

/* a taxa em % — só quando dá pra ter certeza da unidade (ver o cabeçalho) */
function taxaPct(rate, quantidade, vendas) {
  const t = numero(rate);
  if (t == null || t < 0) return null;
  if (t === 0) return 0;
  const q = numero(quantidade), v = numero(vendas);
  if (q != null && q > 0 && v != null && v > 0) {
    const razao = t / (q / v);
    if (razao >= 0.5 && razao <= 2) return r2(t * 100);      /* veio como fração */
    if (razao >= 50 && razao <= 200) return r2(t);            /* veio já em percentual */
    return null;
  }
  return null;   /* sem quantidade e vendas pra conferir a unidade: não arrisca */
}

function metrica(m, vendas) {
  if (!m || typeof m !== 'object') return null;
  const quantidade = numero(m.value);
  return { quantidade, taxa_pct: taxaPct(m.rate, quantidade, vendas), periodo: typeof m.period === 'string' ? m.period : null };
}

/* o bloco `seller_reputation` do ML → o resumo que o chat lê. null = o ML não mandou reputação */
function resumir(rep) {
  if (!rep || typeof rep !== 'object' || Array.isArray(rep)) return null;
  const mt = (rep.metrics && typeof rep.metrics === 'object') ? rep.metrics : {};
  const vendas = numero(mt.sales && mt.sales.completed);
  const nivelCodigo = typeof rep.level_id === 'string' && rep.level_id ? rep.level_id : null;
  const medalhaCodigo = typeof rep.power_seller_status === 'string' && rep.power_seller_status ? rep.power_seller_status : null;
  const tr = (rep.transactions && typeof rep.transactions === 'object') ? rep.transactions : null;
  return {
    nivel_codigo: nivelCodigo,
    nivel: nivelCodigo ? (NIVEIS[nivelCodigo] || null) : null,
    medalha_codigo: medalhaCodigo,
    /* `power_seller_status: null` é o jeito de o ML dizer "não é MercadoLíder"; campo AUSENTE é "não informado" */
    medalha: medalhaCodigo ? (MEDALHAS[medalhaCodigo] || medalhaCodigo) : (Object.prototype.hasOwnProperty.call(rep, 'power_seller_status') ? 'sem medalha de MercadoLíder' : null),
    vendas_concluidas_no_periodo: vendas,
    periodo_das_vendas: (mt.sales && typeof mt.sales.period === 'string') ? mt.sales.period : null,
    reclamacoes: metrica(mt.claims, vendas),
    atraso_no_despacho: metrica(mt.delayed_handling_time, vendas),
    cancelamentos: metrica(mt.cancellations, vendas),
    desde_sempre: tr ? { vendas_concluidas: numero(tr.completed), vendas_canceladas: numero(tr.canceled), total: numero(tr.total) } : null,
  };
}

/* pergunta ao ML. Nunca lança: { ok:true, resumo, cru } | { ok:false, erro } */
async function consultar(o) {
  let token = null;
  try { token = o && typeof o.garantirTokenML === 'function' ? await o.garantirTokenML() : null; }
  catch (e) { return { ok: false, erro: 'o acesso ao Mercado Livre não está disponível (' + String((e && e.message) || e).slice(0, 100) + ')' }; }
  if (!token) return { ok: false, erro: 'esta loja está sem acesso ao Mercado Livre agora' };
  let r;
  try { r = await o.fetch('https://api.mercadolibre.com/users/me', { headers: { Authorization: 'Bearer ' + token } }); }
  catch (e) { return { ok: false, erro: 'o Mercado Livre não respondeu (' + String((e && e.message) || e).slice(0, 100) + ')' }; }
  if (!r || !r.ok) return { ok: false, erro: 'o Mercado Livre respondeu HTTP ' + (r ? r.status : '?') };
  let d = null;
  try { d = await r.json(); } catch (e) { d = null; }
  const cru = d && d.seller_reputation;
  const resumo = resumir(cru);
  if (!resumo) return { ok: false, erro: 'o Mercado Livre respondeu sem o bloco de reputação' };
  return { ok: true, resumo, cru };
}

/* ── as fotos ── uma por dia (a última leitura do dia vence) */
const arquivo = (cacheDir) => path.join(cacheDir, ARQUIVO);
const DIA = /^\d{4}-\d{2}-\d{2}$/;
function lerFotos(o) {
  const a = o.readJson(arquivo(o.CACHE_DIR), null);
  const d = (a && a.dias && typeof a.dias === 'object' && !Array.isArray(a.dias)) ? a.dias : {};
  const out = {};
  for (const k of Object.keys(d)) if (DIA.test(k) && d[k] && typeof d[k] === 'object') out[k] = d[k];
  return out;
}
function fotoDe(resumo, em) {
  const m = (x) => (x ? { quantidade: x.quantidade, taxa_pct: x.taxa_pct } : null);
  return { em, nivel_codigo: resumo.nivel_codigo, nivel: resumo.nivel, medalha_codigo: resumo.medalha_codigo, medalha: resumo.medalha,
    vendas_concluidas_no_periodo: resumo.vendas_concluidas_no_periodo,
    reclamacoes: m(resumo.reclamacoes), atraso_no_despacho: m(resumo.atraso_no_despacho), cancelamentos: m(resumo.cancelamentos) };
}
/* grava a foto do dia. Devolve true se gravou. Falha de disco não derruba quem chamou. */
function fotografar(o) {
  if (!o || !DIA.test(String(o.dia || '')) || !o.resumo) return false;
  try {
    const dias = lerFotos(o);
    dias[o.dia] = fotoDe(o.resumo, o.em || new Date().toISOString());
    const guardar = {};
    for (const k of Object.keys(dias).sort().slice(-MAX_FOTOS)) guardar[k] = dias[k];
    o.writeJson(arquivo(o.CACHE_DIR), { dias: guardar, atualizado: o.em || new Date().toISOString() });
    return true;
  } catch (e) { return false; }
}
/* as fotos de [de, ate], da mais antiga pra mais nova */
function historico(o) {
  const dias = lerFotos(o);
  return Object.keys(dias).sort().filter((k) => k >= o.de && k <= o.ate).map((k) => Object.assign({ dia: k }, dias[k]));
}

/* o que mudou entre a foto mais antiga da janela e a mais nova — as contas em código */
function comparar(fotos) {
  if (!Array.isArray(fotos) || fotos.length < 2) return null;
  const a = fotos[0], b = fotos[fotos.length - 1];
  const delta = (campo) => {
    const x = a[campo], y = b[campo];
    return { antes: x || null, depois: y || null,
      quantidade_diferenca: x && y && x.quantidade != null && y.quantidade != null ? y.quantidade - x.quantidade : null,
      taxa_diferenca_em_pontos_percentuais: x && y && x.taxa_pct != null && y.taxa_pct != null ? r2(y.taxa_pct - x.taxa_pct) : null };
  };
  const trocas = [];
  for (let i = 1; i < fotos.length; i++) {
    if (fotos[i].nivel_codigo !== fotos[i - 1].nivel_codigo) trocas.push({ dia: fotos[i].dia, o_que: 'nível', de: fotos[i - 1].nivel || fotos[i - 1].nivel_codigo || null, para: fotos[i].nivel || fotos[i].nivel_codigo || null });
    if (fotos[i].medalha_codigo !== fotos[i - 1].medalha_codigo) trocas.push({ dia: fotos[i].dia, o_que: 'medalha', de: fotos[i - 1].medalha || fotos[i - 1].medalha_codigo || null, para: fotos[i].medalha || fotos[i].medalha_codigo || null });
  }
  return { de: a.dia, ate: b.dia, fotos: fotos.length, nivel_mudou: a.nivel_codigo !== b.nivel_codigo, medalha_mudou: a.medalha_codigo !== b.medalha_codigo,
    trocas_de_nivel_ou_medalha: trocas, reclamacoes: delta('reclamacoes'), atraso_no_despacho: delta('atraso_no_despacho'), cancelamentos: delta('cancelamentos') };
}

/* a etapa da madrugada: lê e grava a foto de hoje. Devolve o texto pro resumo da noite; LANÇA se não conseguiu ler
   (a etapa aparece como erro — foto que faltou é dia sem histórico) */
async function fotoDaMadrugada(o) {
  const r = await consultar(o);
  if (!r.ok) throw new Error(r.erro);
  const dia = o.dia || new Date().toLocaleString('sv-SE', { timeZone: 'America/Sao_Paulo' }).slice(0, 10);
  if (!fotografar({ CACHE_DIR: o.CACHE_DIR, readJson: o.readJson, writeJson: o.writeJson, dia, resumo: r.resumo })) throw new Error('li a reputação mas não consegui gravar a foto do dia');
  return 'nível ' + (r.resumo.nivel || r.resumo.nivel_codigo || 'não informado') + ' · ' + (r.resumo.medalha || 'medalha não informada');
}

module.exports = { consultar, resumir, taxaPct, fotografar, historico, comparar, fotoDaMadrugada, ARQUIVO, MAX_FOTOS, NIVEIS, MEDALHAS };
