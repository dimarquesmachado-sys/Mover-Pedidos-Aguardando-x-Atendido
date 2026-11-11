'use strict';
/* 11/11 (plano multiloja, Fase 3 4e) — O PERÍODO DO "BACKFILL DO ANO", num lugar só.

   A GOOD já resolvia isso direito na rota dela (01/10 e 15/10, com três consertos de revisão). A Girassol e a AMB tinham o
   ANO 2026 E O MÊS "07" FIXOS no código: chamar /backfill-ano sem &ate refazia só janeiro a julho, e em janeiro de 2027
   continuaria refazendo 2026. Agora as três usam esta regra (a da GOOD, sem mudar nada nela):

   · sem &ano: o ano corrente em São Paulo — em JANEIRO, o ano anterior (o mês passado é dezembro dele);
   · sem &ate: até o mês PASSADO (o mês corrente ainda recebe vendas; regravá-lo hoje o deixaria desatualizado amanhã);
     ano passado explícito → o ano inteiro (12); ano corrente em janeiro → não há mês fechado: pede &ate=MM;
   · o que a pessoa digitou (ano, ate) sempre vale — mas é validado: &ate=MM de 01 a 12, &ano=AAAA de 2020 até o ano que
     vem, e período que ainda não começou é recusado (plano vazio anunciado como aceito era o bug do Codex #696);
   · o fim do período é o último dia de `ate` (fevereiro bissexto incluído) e NUNCA depois de hoje.

   Função pura: recebe o que veio na URL e o relógio; devolve { ok, ano, ate, de, fim, hoje, meses } ou { ok:false, erro }. */

function _spPartes(agora) {
  const d = agora instanceof Date ? agora : new Date(agora == null ? Date.now() : agora);
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(d);
  const v = (t) => p.find((x) => x.type === t).value;
  return { ano: Number(v('year')), mes: Number(v('month')), hoje: v('year') + '-' + v('month') + '-' + v('day') };
}

function ultimoDiaDoMes(ano, mes) {
  return new Date(Date.UTC(Number(ano), Number(mes), 0)).toISOString().slice(0, 10);
}

function resolverPeriodoAno(entrada, agora) {
  const e = entrada || {};
  const sp = _spPartes(agora);
  const anoParam = e.ano == null || e.ano === '' ? null : String(e.ano);
  const ateParam = e.ate == null || e.ate === '' ? null : String(e.ate);
  const ano = String(anoParam || (sp.mes === 1 ? sp.ano - 1 : sp.ano));
  const mesPadrao = Number(ano) < sp.ano ? 12 : (Number(ano) === sp.ano ? sp.mes - 1 : 0);
  if (!ateParam && mesPadrao < 1) return { ok: false, erro: 'não há mês fechado em ' + ano + ' ainda — informe &ate=MM' };
  const ate = String(ateParam || mesPadrao).padStart(2, '0');
  if (!/^(0[1-9]|1[0-2])$/.test(ate)) return { ok: false, erro: 'use &ate=MM (01 a 12)' };
  if (!/^\d{4}$/.test(ano)) return { ok: false, erro: 'use &ano=AAAA' };
  if (Number(ano) < 2020 || Number(ano) > sp.ano + 1) return { ok: false, erro: 'ano fora da faixa: use de 2020 até o ano que vem' };
  const ultDia = ultimoDiaDoMes(ano, ate);
  const fim = ultDia > sp.hoje ? sp.hoje : ultDia;
  const de = ano + '-01-01';
  if (fim < de) return { ok: false, erro: 'período vazio: ' + de + ' a ' + fim + ' — nada a refazer ainda' };
  /* os meses, um a um (pra quem roda mês a mês): o último termina em `fim` (nunca depois de hoje) */
  const meses = [];
  for (let m = 1; m <= Number(ate); m++) {
    const mm = String(m).padStart(2, '0');
    const ini = ano + '-' + mm + '-01';
    if (ini > fim) break;
    const ult = ultimoDiaDoMes(ano, mm);
    meses.push({ mes: ano + '-' + mm, de: ini, ate: ult > fim ? fim : ult });
  }
  return { ok: true, ano, ate, de, fim, hoje: sp.hoje, meses };
}

module.exports = { resolverPeriodoAno, ultimoDiaDoMes };
