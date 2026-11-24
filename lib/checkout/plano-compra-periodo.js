'use strict';
/* ─────────────────────────────────────────────────────────────────────────────
   PLANO DE COMPRA — O PERÍODO EM QUE O RITMO É MEDIDO, E A ÚLTIMA VENDA (20/11/2026).

   O plano media o ritmo sempre nos últimos 180 dias. O dono: "acho legal ter um filtro... últimos 30 dias, últimos 60
   dias, últimos 90 dias, 180, ano 2026. e um período pra eu escolher... de tal data até tal data. de repente eu queira
   ver como performou um produto só no mês de Janeiro, até quando eu tinha estoque do produto". E: "adicionar 1 coluna
   no excel mostrando quando o estoque acabou... se tiver saldo 0, mostrando estoque zerado em e aí a data".

   Esta peça decide, sem tocar em rede nem em disco:

   periodo({ de, ate, periodo, base }, agora) → { ok, tipo, de, ate, dias, mistura } ou { ok:false, erro }
       · de + ate (AAAA-MM-DD)  → tipo 'datas': o intervalo pedido, as duas pontas contando;
       · periodo=ano            → tipo 'ano': de 1º de janeiro até hoje (o dia de São Paulo);
       · senão                  → tipo 'dias': os últimos `base` dias (30 a 730; padrão 180) — como sempre foi.
       `mistura` diz se o ritmo leva o peso do ÚLTIMO MÊS (a conta de sempre): só quando o período TERMINA HOJE e tem
       30 dias ou mais. Período que termina no passado (ou curto demais) é a MÉDIA PURA dele — é o que serve pra medir
       um produto "até quando eu tinha estoque": misturar o último mês (zerado, sem estoque) estragaria a medida.

   ritmo({ un, un30, dias, horizonteDias, mistura }) → unidades por dia
       A conta que a rota já fazia, sem mudar um número: média do período, puxada pro ritmo dos últimos 30 dias com um
       peso que cai conforme o horizonte cresce, e nunca ACIMA do ritmo recente (produto em queda compra pelo ritmo
       novo). Sem `mistura`, é a média do período.

   ultimasVendas(skus, buscar, simultaneas) → Promise<{ sku: 'AAAA-MM-DD' | null }>
       Pergunta a data da última venda de cada SKU, poucas por vez. O que não respondeu fica null — "não sei" não vira
       data.

   janelaComVenda({ pri, ult, ate, terminaHoje, temSaldo }) → { de, ate, dias } ou null
       23/11 (o dono): "o outro ponto, de contar o período em que teve venda. acho legal também, pode ter 1 coluna só disso".
       No ano inteiro, o produto que ficou meses SEM estoque sai com ritmo baixo demais (os dias zerados entram na conta e
       ele não tinha como vender neles). Ninguém guarda o histórico do estoque; o que dá pra medir é a janela em que o
       produto VENDEU: da primeira venda do período até a última — ou até o fim do período, se ele termina hoje e o produto
       ainda tem saldo (está vendendo até agora). Janela curta demais (menos de 14 dias) não mede ritmo: null (sem valor,
       não um número inventado).

   O "estoque zerado em" que o dono pediu: nem o Bling nem o nosso banco guardam o dia em que o saldo chegou a zero. O
   que existe de verdade é a data da ÚLTIMA VENDA — pra um produto zerado, é o dia em que saiu a última unidade vendida.
   É isso que vai na coluna, com esse nome.
   ───────────────────────────────────────────────────────────────────────────── */

const DIA_MS = 86400000;
const BASE_PADRAO = 180, BASE_MIN = 30, BASE_MAX = 730;
const DIAS_PRA_MISTURA = 30;
const DIAS_MIN_JANELA = 14;   /* menos que isso, uma venda solta vira um "ritmo" enorme */   /* a mistura usa as vendas dos últimos 30 dias: período menor que isso não tem como */

/* o dia de hoje em São Paulo, AAAA-MM-DD */
function diaSP(agora) { return new Date(agora).toLocaleDateString('sv-SE', { timeZone: 'America/Sao_Paulo' }); }

/* 'AAAA-MM-DD' de um dia que existe → milissegundos (UTC, meia-noite); qualquer outra coisa → null */
function msDoDia(t) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(t == null ? '' : t).trim());
  if (!m) return null;
  const ms = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return new Date(ms).toISOString().slice(0, 10) === m[0] ? ms : null;   /* 2026-02-31 "vira" março: não é um dia */
}

function periodo(q, agora) {
  q = q || {};
  const t0 = agora == null ? Date.now() : new Date(agora).getTime();
  const de = String(q.de == null ? '' : q.de).trim(), ate = String(q.ate == null ? '' : q.ate).trim();
  const hoje = diaSP(t0);
  if (de || ate) {
    if (!de || !ate) return { ok: false, erro: 'pra escolher o período, informe as duas datas (de e até)' };
    const a = msDoDia(de), b = msDoDia(ate);
    if (a == null || b == null) return { ok: false, erro: 'data inválida — use o formato AAAA-MM-DD' };
    if (a > b) return { ok: false, erro: 'a data inicial é depois da final' };
    if (b > msDoDia(hoje)) return { ok: false, erro: 'a data final não pode ser depois de hoje' };
    const dias = Math.round((b - a) / DIA_MS) + 1;
    if (dias > BASE_MAX) return { ok: false, erro: 'período grande demais — o máximo são ' + BASE_MAX + ' dias' };
    return { ok: true, tipo: 'datas', de, ate, dias, mistura: ate === hoje && dias >= DIAS_PRA_MISTURA };
  }
  if (String(q.periodo == null ? '' : q.periodo).trim().toLowerCase() === 'ano') {
    const ini = hoje.slice(0, 4) + '-01-01';
    const dias = Math.round((msDoDia(hoje) - msDoDia(ini)) / DIA_MS) + 1;
    return { ok: true, tipo: 'ano', de: ini, ate: hoje, dias, mistura: dias >= DIAS_PRA_MISTURA };
  }
  /* os últimos N dias — exatamente a conta que a rota fazia (as datas saem do relógio UTC, como sempre saíram) */
  const n = Number(q.base);
  const base = Math.min(BASE_MAX, Math.max(BASE_MIN, (isFinite(n) && n) || BASE_PADRAO));
  return { ok: true, tipo: 'dias', de: new Date(t0 - base * DIA_MS).toISOString().slice(0, 10), ate: new Date(t0).toISOString().slice(0, 10), dias: base, mistura: true };
}

function ritmo(o) {
  const un = Number(o && o.un) || 0, un30 = Number(o && o.un30) || 0, dias = Number(o && o.dias), hz = Number(o && o.horizonteDias) || 0;
  if (!(dias > 0)) return 0;
  const mdBase = un / dias;
  if (!(o && o.mistura) || !(un30 > 0)) return Math.max(0, mdBase);
  const mdRec = un30 / 30;
  const pesoRec = hz <= 30 ? 0.55 : hz <= 90 ? 0.40 : hz <= 180 ? 0.30 : 0.25;
  return Math.max(0, Math.min(mdRec, mdRec * pesoRec + mdBase * (1 - pesoRec)));
}

function janelaComVenda(o) {
  o = o || {};
  const pri = msDoDia(o.pri), ult = msDoDia(o.ult), ate = msDoDia(o.ate);
  if (pri == null || ult == null || ate == null || pri > ult || ult > ate) return null;
  const fim = (o.terminaHoje && o.temSaldo) ? ate : ult;
  const dias = Math.round((fim - pri) / DIA_MS) + 1;
  if (dias < DIAS_MIN_JANELA) return null;
  return { de: new Date(pri).toISOString().slice(0, 10), ate: new Date(fim).toISOString().slice(0, 10), dias };
}

/* 24/11 — o EAN que vai pra planilha: só código de barras de verdade (8 a 14 dígitos); qualquer outra coisa → null */
function eanValido(v) {
  const d = String(v == null ? '' : v).trim();
  return /^\d{8,14}$/.test(d) ? d : null;
}

async function ultimasVendas(skus, buscar, simultaneas) {
  const lista = Array.from(new Set((Array.isArray(skus) ? skus : []).map((s) => String(s == null ? '' : s)).filter(Boolean)));
  const saida = {};
  let prox = 0;
  async function fila() {
    while (prox < lista.length) {
      const sku = lista[prox++];
      let d = null;
      try { d = await buscar(sku); } catch (e) { d = null; }
      saida[sku] = msDoDia(String(d == null ? '' : d).slice(0, 10)) != null ? String(d).slice(0, 10) : null;
    }
  }
  const n = Math.max(1, Math.min(8, Number(simultaneas) || 6));
  await Promise.all(Array.from({ length: n }, fila));
  return saida;
}

module.exports = { periodo, ritmo, janelaComVenda, ultimasVendas, eanValido, diaSP, msDoDia, BASE_PADRAO, BASE_MIN, BASE_MAX, DIAS_PRA_MISTURA, DIAS_MIN_JANELA };
