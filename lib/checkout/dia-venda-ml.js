'use strict';

/* ─────────────────────────────────────────────────────────────────────────────
   O DIA DA VENDA DO MERCADO LIVRE É O DE BRASÍLIA (14/11/2026) — peça única do motor do histórico (lib/checkout/backfill-motor).

   O CASO (AMB, sexta 13/11): o card "Ontem" do dashboard dizia R$ 3.490,91 · 32 pedidos; a base histórica — que alimenta
   Mês / Ano / 30 dias e o chat de análise — tinha R$ 3.158,22 · 30. O dono mandou as duas listas e elas foram cruzadas
   pedido a pedido: 30 batem no centavo; os 2 que faltavam eram do Mercado Livre, vendidos 00:43 e 00:59 (R$ 48,69 +
   R$ 284,00 = R$ 332,69, a diferença exata) — e estavam gravados na QUINTA. Confirmado na base: pedido 6660, venda
   2000019519701474, `data: 2026-11-12`.

   A CAUSA: a tela põe a venda no dia pela HORA REAL, em Brasília (`diaVenda`: `venda_em` primeiro). O motor gravava o dia
   como o Bling / o ML escrevem — e o relógio do ML é 1 hora atrás de Brasília: venda feita na primeira hora do dia caía
   no dia ANTERIOR. Só o ML (a Shopee das 00:21 daquela sexta estava no dia certo; TikTok e Magalu idem).

   O QUE ESTA PEÇA FAZ:
     · `mapaDosDias`  — pergunta ao ML as vendas da janela (até 00:59 do dia seguinte) e devolve, por nº de venda/carrinho,
                        o dia de Brasília de cada uma;
     · `decidir`      — em que dia a venda entra (ou se fica de fora desta rodada);
     · `copiasNaBase` — onde a base JÁ tem as vendas que encostam na borda da janela.

   POR QUE A BORDA PRECISA DE CUIDADO. O motor reescreve o período [de, ate] inteiro numa troca só (apaga e regrava). Uma
   venda feita 00:30 do dia D aparece no Bling com a data D−1. Enquanto as rodadas antigas (dia do Bling) e as novas (dia
   de Brasília) convivem, a mesma venda pode estar gravada num dia que esta rodada NÃO reescreve:
     · se eu gravar no dia D e já existir a cópia antiga em D−1 (fora da janela) → venda DOBRADA;
     · se a venda é do dia seguinte ao fim da janela e eu só tirar a cópia antiga de dentro → venda SUMIDA.
   A regra é uma só, e não depende de saber qual regra a rodada anterior usou:
       "nunca crio uma segunda cópia; nunca apago a única."
     1. a base já tem a venda num dia VIZINHO da janela (de−1 ou ate+1)  → não mexo: ela fica onde está;
     2. o dia de Brasília cai DENTRO da janela                           → grava nesse dia;
     3. o dia de Brasília é ate+1 (primeira hora do dia seguinte)        → grava no dia antigo (não some); quem a leva
                                                                           pro dia certo é a rodada que cobrir ate+1;
     4. o dia é ANTES da janela (não sei a hora real e o Bling diz de−1) → só regrava se a base a tinha DENTRO da janela
                                                                           (no mesmo dia em que estava); senão não é minha.
   Na rotina de toda madrugada (últimos 3 dias + hoje) isso converge sozinho: cada dia passa por dentro da janela antes de
   virar a borda. Quando o ML não responde a lista, não se sabe a hora real: vale o dia do Bling — com as mesmas quatro
   regras, então nada dobra nem some; a rodada seguinte recoloca.

   Só o que PODE mudar de dia é consultado na base (venda do ML na borda). Shopee, TikTok, Magalu e o resto seguem
   exatamente como eram: dia do Bling, sem consulta nenhuma.
   ───────────────────────────────────────────────────────────────────────────── */

const somaDias = (d, n) => { const x = new Date(d + 'T12:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
const diaAnterior = (d) => somaDias(d, -1);
const diaSeguinte = (d) => somaDias(d, 1);

/* o INSTANTE da venda → o dia em Brasília. A mesma conversão da tela (lib/checkout/historico.js). Só aceita instante
   completo (hora + fuso): uma data solta ("2026-11-12") viraria meia-noite UTC e cairia no dia errado — devolve null,
   que quer dizer "não sei a hora real". */
function diaSP(x) {
  if (typeof x !== 'string' || !/T\d{2}:\d{2}/.test(x) || !/(Z|[+-]\d{2}:?\d{2})$/.test(x.trim())) return null;
  const t = new Date(x.trim());
  if (isNaN(t.getTime())) return null;
  return t.toLocaleString('sv-SE', { timeZone: 'America/Sao_Paulo' }).slice(0, 10);
}

/* as janelas de 5 dias em que a lista do ML é pedida (o /orders/search só entrega 1.000 por consulta) — as mesmas do motor */
function janelasML(de, ate) {
  const out = [];
  for (let c = de; c <= ate; c = somaDias(c, 5)) { const f = somaDias(c, 4); out.push([c, f > ate ? ate : f]); }
  return out;
}
/* até quando a janela vai: a ÚLTIMA entra 1 hora no dia seguinte (até 00:59:59 de Brasília) — é nessa hora que estão as
   vendas que o relógio do ML ainda conta no último dia */
function fimDaJanelaML(jAte, ate) { return jAte === ate ? diaSeguinte(ate) + 'T00:59:59.999-03:00' : jAte + 'T23:59:59.999-03:00'; }

/* A LISTA DO ML → o dia de Brasília de cada venda, por nº da venda e do carrinho.
   o: { fetch, token, de, ate, dorme }
   Devolve sempre (não lança): { lidas, completo, motivo, diaDe(id) → 'AAAA-MM-DD' | null, idsDe(id) → [venda, carrinho…] }.
   `completo: false` não aborta nada: quem não está no mapa segue pelo dia do Bling (regras acima). */
async function mapaDosDias(o) {
  const dias = new Map(), irmaos = new Map();
  let lidas = 0, completo = true, motivo = null;
  const dorme = o.dorme || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const falta = (m) => { completo = false; if (!motivo) motivo = m; };
  const guardar = (id, dia, grupo) => { const a = dias.get(id); if (!a || dia < a) dias.set(id, dia); irmaos.set(id, grupo); };
  try {
    if (!o.token) falta('sem token do Mercado Livre');
    else {
      const H = { headers: { Authorization: 'Bearer ' + o.token } };
      const rme = await o.fetch('https://api.mercadolibre.com/users/me', H);
      const me = rme && rme.ok ? await rme.json().catch(() => null) : null;
      const seller = me && me.id;
      if (!seller) falta('o Mercado Livre não disse de quem é a conta (HTTP ' + (rme && rme.status) + ')');
      else {
        for (const [jDe, jAte] of janelasML(o.de, o.ate)) {
          const base = 'https://api.mercadolibre.com/orders/search?seller=' + seller +
            '&order.date_created.from=' + encodeURIComponent(jDe + 'T00:00:00.000-03:00') +
            '&order.date_created.to=' + encodeURIComponent(fimDaJanelaML(jAte, o.ate)) + '&sort=date_asc&limit=50';
          let total = Infinity;
          for (let off = 0; off < 1000 && off < total; off += 50) {
            const r = await o.fetch(base + '&offset=' + off, H);
            if (!r || !r.ok) { falta('a lista de vendas do Mercado Livre respondeu HTTP ' + (r && r.status) + ' (de ' + jDe + ' a ' + jAte + ')'); break; }
            const d = await r.json().catch(() => null);
            if (!d || !Array.isArray(d.results)) { falta('a lista de vendas do Mercado Livre veio ilegível (de ' + jDe + ' a ' + jAte + ')'); break; }
            for (const v of d.results) {
              if (!v || v.id == null) continue;
              const dia = diaSP(v.date_created);
              if (!dia) continue;
              const oid = String(v.id), pk = v.pack_id ? String(v.pack_id) : null;
              const grupo = pk ? [oid, pk] : [oid];
              guardar(oid, dia, grupo);
              if (pk) { const ja = irmaos.get(pk); guardar(pk, dia, ja ? Array.from(new Set(ja.concat(grupo))) : grupo); }
              lidas++;
            }
            const tt = Number(d.paging && d.paging.total);
            total = isFinite(tt) ? tt : 0;
            if (total > 1000) falta('a janela de ' + jDe + ' a ' + jAte + ' passou de 1.000 vendas no Mercado Livre');
            if (d.results.length < 50) break;
            await dorme(300);
          }
          await dorme(250);
        }
      }
    }
  } catch (e) { falta('a lista de vendas do Mercado Livre falhou: ' + String((e && e.message) || e).slice(0, 120)); }
  return { lidas, completo, motivo,
    diaDe: (id) => { const k = String(id == null ? '' : id).trim(); return (k && dias.get(k)) || null; },
    idsDe: (id) => { const k = String(id == null ? '' : id).trim(); return (k && irmaos.get(k)) || []; } };
}

/* a venda ENCOSTA NA BORDA da janela quando a regra antiga e a nova podem tê-la gravado num dia que esta rodada não
   reescreve: o dia antigo é de−1 (pode ser do 1º dia) ou é o último (pode ser do dia seguinte), ou o dia que vale caiu fora */
function naBorda(v, de, ate) {
  const antigo = v.antigo || null, alvo = v.real || antigo;
  if (!alvo) return false;
  return antigo === diaAnterior(de) || antigo === ate || alvo < de || alvo > ate;
}

/* EM QUE DIA A VENDA ENTRA — só pra venda que PODE mudar de dia (a do Mercado Livre). As outras nem passam por aqui.
   v: { antigo, real, de, ate, copias }
     antigo — o dia pela regra de antes (a data do Bling; na venda direta do ML, o dia no relógio do ML)
     real   — o dia de Brasília da hora real, ou null quando não se sabe
     copias — os dias em que a base JÁ tem esta venda, entre de−1 e ate+1. OBRIGATÓRIO quando a venda encosta na borda —
              sem ele, lança: decidir a borda sem olhar a base é o que dobra ou some com a venda.
   → { incluir: true, dia, pelo_bling } | { incluir: false, porque }
     `pelo_bling: true` = não sei a hora real e a venda fica no dia do Bling: o motor grava a data que sempre gravou. */
function decidir(v) {
  const antigo = v.antigo || null, real = v.real || null, de = v.de, ate = v.ate;
  if (!antigo && !real) return { incluir: true, dia: null, pelo_bling: true };          /* pedido sem data na lista: como sempre foi */
  const alvo = real || antigo;
  const antes = diaAnterior(de), depois = diaSeguinte(ate);
  const copias = v.copias;
  if (naBorda(v, de, ate) && !Array.isArray(copias)) throw new Error('dia-venda-ml: venda na borda da janela sem a consulta à base (antigo ' + antigo + ', real ' + real + ', janela ' + de + ' a ' + ate + ')');
  const tem = (dia) => Array.isArray(copias) && copias.indexOf(dia) >= 0;
  /* 1. cópia num dia vizinho, que esta rodada não reescreve: fica onde está */
  if (tem(antes)) return { incluir: false, porque: 'a base já tem esta venda em ' + antes + ', fora da janela — fica lá (não crio segunda cópia)' };
  if (tem(depois)) return { incluir: false, porque: 'a base já tem esta venda em ' + depois + ', fora da janela — fica lá (não crio segunda cópia)' };
  /* 2. o dia cai dentro da janela */
  if (alvo >= de && alvo <= ate) return { incluir: true, dia: alvo, pelo_bling: !real };
  /* 3. é da primeira hora do dia seguinte: fica no dia antigo, pra não sumir */
  if (alvo === depois && antigo && antigo >= de && antigo <= ate) return { incluir: true, dia: antigo, pelo_bling: false, adiada: true };
  /* 4. é de antes da janela: só regravo se a base a tinha aqui dentro (no dia em que estava) */
  if (alvo < de) {
    const dentro = (copias || []).filter((d) => d >= de && d <= ate).sort();
    if (dentro.length) return { incluir: true, dia: dentro[dentro.length - 1], pelo_bling: false, mantida: true };
  }
  return { incluir: false, porque: 'fora do período' };
}

/* ONDE A BASE JÁ TEM as vendas que encostam na borda.
   o: { supaReq, empresa, de, ate, vendas: [{ antigo, real, numero, lojas: [...] }] }
   Consulta só quem precisa (borda). Devolve { ok: true, de(venda) → [dias] | undefined } | { ok: false, erro }.
   `de(venda)` é undefined pra quem não foi consultado (não está na borda). */
const CHAVE_OK = /^[A-Za-z0-9-]{1,40}$/;
async function copiasNaBase(o) {
  const antes = diaAnterior(o.de), depois = diaSeguinte(o.ate);
  const borda = (v) => naBorda(v, o.de, o.ate);
  const chavesDe = (v) => ({ numero: (v.numero != null && CHAVE_OK.test(String(v.numero))) ? String(v.numero) : null,
    lojas: Array.from(new Set((v.lojas || []).map((x) => String(x == null ? '' : x).trim()).filter((x) => x && CHAVE_OK.test(x)))) });
  const alvo = (o.vendas || []).filter(borda);
  if (!alvo.length) return { ok: true, consultadas: 0, de: () => undefined };
  const porNumero = new Map(), porLoja = new Map();   /* chave → Set(dias) */
  const numeros = new Set(), lojas = new Set();
  for (const v of alvo) { const k = chavesDe(v); if (k.numero) numeros.add(k.numero); for (const l of k.lojas) lojas.add(l); }
  const ler = async (coluna, valores, destino) => {
    const lista = Array.from(valores);
    for (let i = 0; i < lista.length; i += 60) {
      const lote = lista.slice(i, i + 60);
      const q = 'vendas_historico?empresa=eq.' + encodeURIComponent(o.empresa) + '&data_venda=gte.' + antes + '&data_venda=lte.' + depois +
        '&' + coluna + '=in.(' + lote.map(encodeURIComponent).join(',') + ')&select=numero_pedido,numero_loja,data_venda&limit=5000';
      const rr = await o.supaReq(o.empresa, 'GET', q, null);
      if (!rr || !rr.ok) return 'o banco respondeu ' + (rr && rr.status) + (rr && rr.erro ? ' — ' + rr.erro : '');
      let arr;
      try { arr = JSON.parse(rr.body || '[]'); } catch (e) { return 'o banco devolveu corpo ilegível'; }
      if (!Array.isArray(arr)) return 'o banco devolveu algo que não é lista';
      if (arr.length >= 5000) return 'o banco devolveu linhas demais pra conferir a borda';
      for (const l of arr) {
        if (!l || l[coluna] == null || !l.data_venda) continue;
        const k = String(l[coluna]).trim(), dia = String(l.data_venda).slice(0, 10);
        if (!destino.has(k)) destino.set(k, new Set());
        destino.get(k).add(dia);
      }
    }
    return null;
  };
  let erro = null;
  try { erro = await ler('numero_pedido', numeros, porNumero) || await ler('numero_loja', lojas, porLoja); }
  catch (e) { erro = String((e && e.message) || e).slice(0, 120); }
  if (erro) return { ok: false, erro };
  return { ok: true, consultadas: alvo.length, de: (v) => {
    if (!borda(v)) return undefined;
    const k = chavesDe(v), dias = new Set();
    if (k.numero && porNumero.has(k.numero)) for (const d of porNumero.get(k.numero)) dias.add(d);
    for (const l of k.lojas) if (porLoja.has(l)) for (const d of porLoja.get(l)) dias.add(d);
    return Array.from(dias).sort();
  } };
}

module.exports = { diaSP, diaAnterior, diaSeguinte, janelasML, fimDaJanelaML, mapaDosDias, naBorda, decidir, copiasNaBase };
