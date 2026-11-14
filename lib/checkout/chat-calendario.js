'use strict';

/* ─────────────────────────────────────────────────────────────────────────────
   CALENDÁRIO COMERCIAL DO CHAT DE ANÁLISE (14/11/2026) — peça única, sem dado de loja nenhuma.

   Pedido do dono, depois da 1ª resposta do chat em produção: "11/11 foi data promocional mesmo, tem o ano todo 1/1 2/2
   3/3 etc até 12/12, isso pode ter influenciado" — o chat tinha levantado a hipótese sem saber que o dia era data dupla.

   O que mora aqui é CALENDÁRIO, calculado em código (o modelo não faz conta de data): as datas duplas dos marketplaces,
   as datas do varejo brasileiro e os feriados nacionais. É conhecimento GERAL — não diz se a loja participou de alguma
   campanha, se tinha cupom ou anúncio ativo. Por isso todo resultado leva essa ressalva: a data é fato; o efeito dela na
   venda da loja é hipótese.

   eventosDoDia('2026-11-11') → [{ tipo: 'data dupla', nome: '11.11 …' }]      (lista vazia = dia comum)
   calendario(de, ate)        → [{ dia, dia_da_semana, eventos }]               só os dias que têm evento
   proximos(dia, raio)        → [{ dia, dias_de_distancia, eventos }]           eventos a até `raio` dias (antes < 0)
   ───────────────────────────────────────────────────────────────────────────── */

const NOME_DIA = ['domingo', 'segunda-feira', 'terça-feira', 'quarta-feira', 'quinta-feira', 'sexta-feira', 'sábado'];
const iso = (ano, mes, dia) => new Date(Date.UTC(ano, mes - 1, dia, 12)).toISOString().slice(0, 10);
const somaDias = (d, n) => { const x = new Date(d + 'T12:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
const diaDaSemana = (d) => new Date(d + 'T12:00:00Z').getUTCDay();   /* 0 = domingo */

/* domingo de Páscoa (algoritmo de Meeus/Jones/Butcher, calendário gregoriano) */
function pascoa(ano) {
  const a = ano % 19, b = Math.floor(ano / 100), c = ano % 100, d = Math.floor(b / 4), e = b % 4, f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3), h = (19 * a + b - d - g + 15) % 30, i = Math.floor(c / 4), k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7, m = Math.floor((a + 11 * h + 22 * l) / 451);
  const mes = Math.floor((h + l - 7 * m + 114) / 31), dia = ((h + l - 7 * m + 114) % 31) + 1;
  return iso(ano, mes, dia);
}
/* o N-ésimo dia da semana `dow` do mês (ex.: 2º domingo de maio) */
function nEsimo(ano, mes, dow, n) {
  const primeiro = iso(ano, mes, 1);
  return somaDias(primeiro, ((dow - diaDaSemana(primeiro) + 7) % 7) + 7 * (n - 1));
}

const _porAno = new Map();
function eventosDoAno(ano) {
  if (_porAno.has(ano)) return _porAno.get(ano);
  const m = new Map();
  const add = (dia, tipo, nome) => { if (!m.has(dia)) m.set(dia, []); m.get(dia).push({ tipo, nome }); };
  /* datas duplas: o dia igual ao mês. Os marketplaces (Shopee, Mercado Livre, TikTok Shop, Magalu…) fazem campanha nelas */
  for (let k = 1; k <= 12; k++) add(iso(ano, k, k), 'data dupla', k + '.' + k + ' — data dupla, dia de campanha promocional dos marketplaces');
  /* datas do varejo */
  add(iso(ano, 3, 15), 'data do varejo', 'Dia do Consumidor');
  add(nEsimo(ano, 5, 0, 2), 'data do varejo', 'Dia das Mães');
  add(iso(ano, 6, 12), 'data do varejo', 'Dia dos Namorados');
  add(nEsimo(ano, 8, 0, 2), 'data do varejo', 'Dia dos Pais');
  add(iso(ano, 10, 12), 'data do varejo', 'Dia das Crianças');
  const blackFriday = somaDias(nEsimo(ano, 11, 4, 4), 1);   /* o dia seguinte à 4ª quinta-feira de novembro */
  add(blackFriday, 'data do varejo', 'Black Friday');
  add(somaDias(blackFriday, 3), 'data do varejo', 'Cyber Monday');
  /* feriados nacionais (e os pontos facultativos que param o comércio) */
  const p = pascoa(ano);
  add(iso(ano, 1, 1), 'feriado nacional', 'Confraternização Universal (Ano-Novo)');
  add(somaDias(p, -48), 'ponto facultativo', 'Carnaval (segunda-feira)');
  add(somaDias(p, -47), 'ponto facultativo', 'Carnaval (terça-feira)');
  add(somaDias(p, -2), 'feriado nacional', 'Sexta-feira Santa');
  add(p, 'data do varejo', 'Páscoa');
  add(iso(ano, 4, 21), 'feriado nacional', 'Tiradentes');
  add(iso(ano, 5, 1), 'feriado nacional', 'Dia do Trabalho');
  add(somaDias(p, 60), 'ponto facultativo', 'Corpus Christi');
  add(iso(ano, 9, 7), 'feriado nacional', 'Independência do Brasil');
  add(iso(ano, 10, 12), 'feriado nacional', 'Nossa Senhora Aparecida');
  add(iso(ano, 11, 2), 'feriado nacional', 'Finados');
  add(iso(ano, 11, 15), 'feriado nacional', 'Proclamação da República');
  add(iso(ano, 11, 20), 'feriado nacional', 'Dia da Consciência Negra');
  add(iso(ano, 12, 25), 'feriado nacional', 'Natal');
  _porAno.set(ano, m);
  return m;
}

const DIA_OK = /^\d{4}-\d{2}-\d{2}$/;
function eventosDoDia(dia) {
  if (!DIA_OK.test(String(dia))) return [];
  return (eventosDoAno(Number(dia.slice(0, 4))).get(dia) || []).map((e) => ({ tipo: e.tipo, nome: e.nome }));
}
function calendario(de, ate) {
  const out = [];
  if (!DIA_OK.test(String(de)) || !DIA_OK.test(String(ate)) || de > ate) return out;
  for (let ano = Number(de.slice(0, 4)); ano <= Number(ate.slice(0, 4)); ano++) {
    for (const [dia, evs] of eventosDoAno(ano)) if (dia >= de && dia <= ate) out.push({ dia, dia_da_semana: NOME_DIA[diaDaSemana(dia)], eventos: evs.map((e) => ({ tipo: e.tipo, nome: e.nome })) });
  }
  return out.sort((a, b) => (a.dia < b.dia ? -1 : a.dia > b.dia ? 1 : 0));
}
/* os eventos perto de um dia (sem o próprio dia): a venda de um dia comum pode ter sido antecipada ou adiada por eles */
function proximos(dia, raio) {
  const r = Math.max(1, Math.min(10, Number(raio) || 3));
  return calendario(somaDias(dia, -r), somaDias(dia, r)).filter((x) => x.dia !== dia)
    .map((x) => ({ dia: x.dia, dia_da_semana: x.dia_da_semana, dias_de_distancia: Math.round((Date.parse(x.dia + 'T12:00:00Z') - Date.parse(dia + 'T12:00:00Z')) / 86400000), eventos: x.eventos }));
}

const RESSALVA = 'Calendário GERAL (datas duplas dos marketplaces, datas do varejo, feriados). A data é fato; se a loja participou de campanha, teve cupom ou anúncio ativo nesse dia, este calendário NÃO diz — o efeito na venda é hipótese.';

module.exports = { eventosDoDia, calendario, proximos, pascoa, nEsimo, RESSALVA, NOME_DIA };
