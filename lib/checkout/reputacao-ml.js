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

   15/11 (Codex #883):
   · A consulta tem PRAZO pro pedido inteiro (token + ida ao ML + leitura do corpo). Sem ele, o ML que aceitasse a
     conexão e emudecesse prendia a pergunta do chat — e, na madrugada, a etapa: as seguintes nunca rodavam.
   · "NÃO INFORMOU" não é "MUDOU". Se o ML deixa de mandar o nível ou a medalha num dia, a comparação não inventa troca:
     só há mudança entre duas fotos em que o ML INFORMOU o campo. A medalha tem três estados — tem (o código), não tem
     (`power_seller_status: null`, que o ML manda de propósito) e não informada (campo ausente) —, e a foto guarda qual.
   ───────────────────────────────────────────────────────────────────────────── */

const path = require('path');
const { comPrazo } = require('./com-prazo');

const ARQUIVO = '_reputacao_ml.json';
const MAX_FOTOS = 400;   /* dias guardados */
const PRAZO_MS = 20000;  /* a consulta inteira: token + ida ao ML + leitura do corpo */
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

/* 16/11 (NORTE, item D) — AS AVALIAÇÕES: `transactions.ratings { positive, neutral, negative }`. O ML manda as três como
   FRAÇÃO (0,97 / 0,02 / 0,01), mas o formato nunca foi conferido daqui de dentro — a unidade só é aceita quando a própria
   resposta confirma: as três somam ≈1 (fração → ×100) ou ≈100 (já em %). Senão, "não disponível"; número errado é pior que
   número ausente. Negativa que SOBE é o que o dono quer saber ("vai que deu algum problema, mudou, caiu"). */
function avaliacoes(ratings) {
  if (!ratings || typeof ratings !== 'object') return null;
  const p = numero(ratings.positive), n = numero(ratings.neutral), g = numero(ratings.negative);
  if (p == null || n == null || g == null || p < 0 || n < 0 || g < 0) return null;
  const soma = p + n + g;
  let f = null;
  if (soma >= 0.98 && soma <= 1.02) f = 100;          /* frações */
  else if (soma >= 98 && soma <= 102) f = 1;          /* já em percentual */
  if (f == null) return null;
  return { positivas_pct: r2(p * f), neutras_pct: r2(n * f), negativas_pct: r2(g * f) };
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
  /* a medalha foi INFORMADA quando o ML mandou o campo com um código ou com `null` (o jeito de ele dizer "não é
     MercadoLíder"); campo ausente — ou com um valor que não é nem uma coisa nem outra — é "não informada" */
  const medalhaInformada = !!medalhaCodigo || (Object.prototype.hasOwnProperty.call(rep, 'power_seller_status') && rep.power_seller_status === null);
  return {
    nivel_codigo: nivelCodigo,
    nivel: nivelCodigo ? (NIVEIS[nivelCodigo] || null) : null,
    medalha_codigo: medalhaCodigo,
    medalha: medalhaCodigo ? (MEDALHAS[medalhaCodigo] || medalhaCodigo) : (medalhaInformada ? 'sem medalha de MercadoLíder' : null),
    medalha_informada: medalhaInformada,
    vendas_concluidas_no_periodo: vendas,
    periodo_das_vendas: (mt.sales && typeof mt.sales.period === 'string') ? mt.sales.period : null,
    reclamacoes: metrica(mt.claims, vendas),
    atraso_no_despacho: metrica(mt.delayed_handling_time, vendas),
    cancelamentos: metrica(mt.cancellations, vendas),
    desde_sempre: tr ? { vendas_concluidas: numero(tr.completed), vendas_canceladas: numero(tr.canceled), total: numero(tr.total) } : null,
    avaliacoes: tr ? avaliacoes(tr.ratings) : null,   /* 16/11: positivas/neutras/negativas em % (ou null — ver `avaliacoes`) */
  };
}

/* pergunta ao ML. Nunca lança e nunca fica pendurada: { ok:true, resumo, cru } | { ok:false, erro } */
function consultar(o) {
  const prazo = (o && Number(o.prazoMs) > 0) ? Number(o.prazoMs) : PRAZO_MS;
  return comPrazo(prazo, (sinal) => perguntarAoML(o, sinal),
    () => ({ ok: false, erro: 'o Mercado Livre não respondeu no prazo (' + Math.round(prazo / 1000) + ' s) — a consulta foi interrompida' }));
}
async function perguntarAoML(o, sinal) {
  let token = null;
  try { token = o && typeof o.garantirTokenML === 'function' ? await o.garantirTokenML() : null; }
  catch (e) { return { ok: false, erro: 'o acesso ao Mercado Livre não está disponível (' + String((e && e.message) || e).slice(0, 100) + ')' }; }
  if (!token) return { ok: false, erro: 'esta loja está sem acesso ao Mercado Livre agora' };
  let r;
  try { r = await o.fetch('https://api.mercadolibre.com/users/me', { headers: { Authorization: 'Bearer ' + token }, signal: sinal }); }
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
  return { em, nivel_codigo: resumo.nivel_codigo, nivel: resumo.nivel, medalha_codigo: resumo.medalha_codigo, medalha: resumo.medalha, medalha_informada: resumo.medalha_informada === true,
    vendas_concluidas_no_periodo: resumo.vendas_concluidas_no_periodo,
    reclamacoes: m(resumo.reclamacoes), atraso_no_despacho: m(resumo.atraso_no_despacho), cancelamentos: m(resumo.cancelamentos),
    avaliacoes: resumo.avaliacoes ? { positivas_pct: resumo.avaliacoes.positivas_pct, neutras_pct: resumo.avaliacoes.neutras_pct, negativas_pct: resumo.avaliacoes.negativas_pct } : null };
}
/* grava a foto do dia. Devolve true se gravou. Falha de disco não derruba quem chamou.
   (Codex #886: o gravador de produção — `writeJson` do base-funcoes — NÃO lança quando o disco falha: devolve `false`.
   Sem conferir o retorno, a foto que não foi gravada era dada como gravada.) */
function fotografar(o) {
  if (!o || !DIA.test(String(o.dia || '')) || !o.resumo) return false;
  try {
    const dias = lerFotos(o);
    dias[o.dia] = fotoDe(o.resumo, o.em || new Date().toISOString());
    const guardar = {};
    for (const k of Object.keys(dias).sort().slice(-MAX_FOTOS)) guardar[k] = dias[k];
    return o.writeJson(arquivo(o.CACHE_DIR), { dias: guardar, atualizado: o.em || new Date().toISOString() }) !== false;
  } catch (e) { return false; }
}
/* as fotos de [de, ate], da mais antiga pra mais nova */
function historico(o) {
  const dias = lerFotos(o);
  return Object.keys(dias).sort().filter((k) => k >= o.de && k <= o.ate).map((k) => Object.assign({ dia: k }, dias[k]));
}

/* o ML informou o campo nesta foto? (nível: veio um código; medalha: veio um código ou o "não tem" explícito) */
const nivelSabido = (f) => !!f && f.nivel_codigo != null;
const medalhaSabida = (f) => !!f && (f.medalha_codigo != null || f.medalha_informada === true);

/* o que mudou entre a foto mais antiga da janela e a mais nova — as contas em código.
   `nivel_mudou` / `medalha_mudou`: true ou false quando o ML informou o campo NAS DUAS pontas; null = não dá pra dizer.
   As trocas listadas são só as confirmadas: entre duas fotos em que o ML informou (a foto sem o campo, no meio, é pulada). */
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
  let ultNivel = null, ultMedalha = null;   /* a última foto em que o ML INFORMOU cada campo */
  for (const f of fotos) {
    if (nivelSabido(f)) {
      if (ultNivel && ultNivel.nivel_codigo !== f.nivel_codigo) trocas.push({ dia: f.dia, o_que: 'nível', de: ultNivel.nivel || ultNivel.nivel_codigo, para: f.nivel || f.nivel_codigo, foto_anterior: ultNivel.dia });
      ultNivel = f;
    }
    if (medalhaSabida(f)) {
      if (ultMedalha && ultMedalha.medalha_codigo !== f.medalha_codigo) trocas.push({ dia: f.dia, o_que: 'medalha', de: ultMedalha.medalha || ultMedalha.medalha_codigo || null, para: f.medalha || f.medalha_codigo || null, foto_anterior: ultMedalha.dia });
      ultMedalha = f;
    }
  }
  return { de: a.dia, ate: b.dia, fotos: fotos.length,
    nivel_mudou: nivelSabido(a) && nivelSabido(b) ? a.nivel_codigo !== b.nivel_codigo : null,
    medalha_mudou: medalhaSabida(a) && medalhaSabida(b) ? a.medalha_codigo !== b.medalha_codigo : null,
    fotos_sem_o_nivel: fotos.filter((f) => !nivelSabido(f)).length, fotos_sem_a_medalha: fotos.filter((f) => !medalhaSabida(f)).length,
    trocas_de_nivel_ou_medalha: trocas, reclamacoes: delta('reclamacoes'), atraso_no_despacho: delta('atraso_no_despacho'), cancelamentos: delta('cancelamentos'),
    /* 16/11: as avaliações — só entre duas fotos em que o ML informou (foto antiga, sem o campo, não vira "mudou") */
    avaliacoes: { antes: a.avaliacoes || null, depois: b.avaliacoes || null,
      negativas_diferenca_em_pontos_percentuais: a.avaliacoes && b.avaliacoes ? r2(b.avaliacoes.negativas_pct - a.avaliacoes.negativas_pct) : null,
      positivas_diferenca_em_pontos_percentuais: a.avaliacoes && b.avaliacoes ? r2(b.avaliacoes.positivas_pct - a.avaliacoes.positivas_pct) : null } };
}

/* a etapa da madrugada: lê e grava a foto de hoje. Devolve o texto pro resumo da noite; LANÇA se não conseguiu ler
   (a etapa aparece como erro — foto que faltou é dia sem histórico) */
async function fotoDaMadrugada(o) {
  const r = await consultar(o);
  if (!r.ok) throw new Error(r.erro);
  const dia = o.dia || new Date().toLocaleString('sv-SE', { timeZone: 'America/Sao_Paulo' }).slice(0, 10);
  if (!fotografar({ CACHE_DIR: o.CACHE_DIR, readJson: o.readJson, writeJson: o.writeJson, dia, resumo: r.resumo })) throw new Error('li a reputação mas não consegui gravar a foto do dia');
  const av = r.resumo.avaliacoes;
  return 'nível ' + (r.resumo.nivel || r.resumo.nivel_codigo || 'não informado') + ' · ' + (r.resumo.medalha || 'medalha não informada')
    + (av ? ' · avaliações: ' + av.positivas_pct + '% positivas, ' + av.negativas_pct + '% negativas' : ' · avaliações não informadas');   /* 16/11 (item D) */
}

module.exports = { avaliacoes, consultar, resumir, taxaPct, fotografar, historico, comparar, fotoDaMadrugada, ARQUIVO, MAX_FOTOS, PRAZO_MS, NIVEIS, MEDALHAS };
