'use strict';

/**
 * lib/ml-fatura-cartao.js — a fatura mensal do Mercado Livre que vai pro CARTÃO (02/09).
 *
 * O dono pediu: "um indicador no card do ML: Débito Cartão, o valor total e do que ele é
 * composto (Ads, armazenagem Full, Minha Página, Impostos), mostrando o valor de cada pra
 * ver que dá o total".
 *
 * O que descobrimos conferindo a fatura real de agosto/2026 da AMB (R$ 45.926,80):
 *   • o ML desconta na própria venda tudo que tem venda pra abater — comissão, envio,
 *     parcelamento, antecipação (R$ 40.836,49 "cobrado na operação");
 *   • o que NÃO tem venda associada vai pro cartão: publicidade, armazenagem Full, Minha
 *     página, impostos (R$ 4.656,00 "débito automático");
 *   • a API marca cada tarifa com debited_from_operation YES/NO — é isso que a coleta
 *     passou a gravar em `cartao`. Não precisa deduzir por categoria.
 *
 * O PROBLEMA DE APRESENTAÇÃO, que o dono apontou: é cobrança MENSAL, e o ciclo do ML fecha
 * no dia 12 — não bate com o mês do calendário. Ratear por dia mentiria. A solução é mostrar
 * a fatura pelo CICLO DELA (13 do mês anterior a 12 deste), com data de fechamento e de
 * débito (dia 18), independente do período que o dashboard está exibindo. Assim o número
 * bate com o que ele vê no cartão.
 */

const DIA_FECHAMENTO = 12;   // ciclo: 13/M-1 → 12/M
const DIA_DEBITO = 18;       // débito automático no cartão

/* 01/10 — as categorias que a empresa SÓ paga no cartão: o ML não tem venda pra descontá-las.
   É a lista que decide se um crédito marcado como "descontado na venda" pertence, na verdade,
   ao cartão. Curta e justificada, não um balde: cada item aqui é uma cobrança que não existe
   sem fatura.
     ads        — campanha de publicidade, inclusive "Publicidade de Seguidores"
     full       — armazenamento no fulfillment
     assinatura — Minha página
     imposto    — DIFAL/ICMS cobrado no débito automático (ver cabeçalho do módulo)
   Frete, comissão, parcelamento e Mercado Pago FICAM DE FORA de propósito: esses são
   descontados no repasse, onde o estorno já abate. Trazê-los pra cá descontaria duas vezes. */
const CATEGORIAS_SO_DO_CARTAO = new Set(['ads', 'full', 'assinatura', 'imposto']);

/* 01/10 — DEVOLUÇÃO NUNCA É DO CARTÃO, mesmo quando o ML marca que é.

   Cruzei a fatura oficial da AMB (set/2026) com o raio-x, e a conta fecha NA VÍRGULA:

       painel                          6.455,32
       − devolução                      −207,98   (esta linha)
       − estorno de Ads                 −322,33   (o abatimento acima)
       + Full que faltava                 +3,22   (ainda em aberto)
                                      ──────────
                                        5.928,23  = o débito do e-mail

   A prova não é só aritmética: a fatura do ML NÃO TEM linha "Devoluções" entre as tarifas —
   elas entram em "Tarifas de envios no Mercado Livre", que o ML desconta na venda. A marca
   `debited_from_operation: NO` nessas linhas está errada, ou significa outra coisa.

   ⚠️ E a COMISSÃO (24,73) FICA, de propósito: era a outra candidata, e tirá-la poria o painel
   abaixo do débito. A conta acima é o que distingue as duas — sem ela eu teria tirado as duas
   por parecerem o mesmo caso ("tarifa com pedido"). */
const CATEGORIAS_NUNCA_DO_CARTAO = new Set(['devolucao']);

function r2(v) { return Math.round((Number(v) || 0) * 100) / 100; }

/** data de hoje no fuso de São Paulo (AAAA-MM-DD) — o ciclo do ML e o débito são em horário local */
function hojeSP() {
  try {
    const p = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
    return p;   // en-CA formata como AAAA-MM-DD
  } catch (e) { return new Date(Date.now() - 3 * 3600000).toISOString().slice(0, 10); }
}

/** Ciclo da fatura que contém a data dada: { de, ate, fechamento, debito, rotulo } */
function cicloDe(dataISO) {
  const d = new Date(dataISO + 'T12:00:00Z');
  let ano = d.getUTCFullYear(), mes = d.getUTCMonth();       // 0-11
  if (d.getUTCDate() > DIA_FECHAMENTO) { mes += 1; if (mes > 11) { mes = 0; ano += 1; } }
  const iso = (a, m, dia) => new Date(Date.UTC(a, m, dia)).toISOString().slice(0, 10);
  const mesAnt = mes === 0 ? 11 : mes - 1, anoAnt = mes === 0 ? ano - 1 : ano;
  return {
    de: iso(anoAnt, mesAnt, DIA_FECHAMENTO + 1),
    ate: iso(ano, mes, DIA_FECHAMENTO),
    fechamento: iso(ano, mes, DIA_FECHAMENTO),
    debito: iso(ano, mes, DIA_DEBITO),
    rotulo: ['jan','fev','mar','abr','mai','jun','jul','ago','set','out','nov','dez'][mes] + '/' + ano,
    chave: iso(ano, mes, 1),
  };
}

const ROTULO = {
  ads: 'Publicidade (Ads)', full: 'Armazenagem Full', assinatura: 'Minha página',
  imposto: 'Impostos (DIFAL)', decola: 'Programa Decola', devolucao: 'Devoluções',
  credito: 'Estornos', outros: 'Outros',
};

/**
 * Monta as faturas do cartão a partir das tarifas gravadas.
 * @param tarifas  objeto base.tarifas do cache (_ml_billing.json)
 * @param opcoes   { referencia: 'AAAA-MM-DD' } → devolve o ciclo que contém essa data; sem
 *                 referência, devolve os últimos ciclos ordenados do mais novo pro mais antigo
 */
/**
 * Monta as faturas do cartão a partir das tarifas gravadas.
 * @param tarifas  objeto base.tarifas do cache (_ml_billing.json)
 * @param opcoes   { referencia, limite, atualizado, maxHoras }
 *   referencia → devolve só o ciclo que contém essa data
 *   atualizado → ISO da última sincronização BEM-SUCEDIDA do cache (b.atualizado). É o que
 *                decide se o dado é atual. Sem ele, a função não sintetiza nada.
 *   maxHoras   → idade máxima pra considerar o dado fresco (padrão 36h: a noturna roda 1x/dia)
 *
 * CONSERTO DE RAIZ (r4, depois de 3 rodadas de review sobre o mesmo tema): a pergunta que
 * decide se o ciclo atual pode aparecer zerado é "o dado é ATUAL?", e eu tentava responder
 * por dentro (tem tarifa? tem marca?) quando a resposta está fora — no `atualizado` do
 * cache. Cada guarda interna tapava um caso e deixava outro: cache vazio, cache só com
 * registro velho, cache cheio mas parado desde uma sincronização que falhou. Agora a
 * função recebe a idade do dado, sintetiza só quando é fresco, e devolve essa idade sempre
 * — pro card dizer "dados de X horas atrás" em vez de esconder.
 */
function faturas(tarifas, opcoes) {
  const o = opcoes || {};
  const vazio = (extra) => Object.assign(o.referencia ? { fatura: null } : { faturas: [] }, { sem_marca: 0, sem_dado: true }, extra || {});

  /* 1) idade do dado — vem do cache, não é deduzida */
  const atualizadoMs = o.atualizado ? Date.parse(o.atualizado) : NaN;
  const idadeHoras = isFinite(atualizadoMs) ? Math.round((Date.now() - atualizadoMs) / 36e5) : null;
  const fresco = idadeHoras != null && idadeHoras <= (o.maxHoras || 36);
  const meta = { atualizado: o.atualizado || null, idade_horas: idadeHoras, fresco };

  /* 2) sem tarifa nenhuma = sem dado, nunca zero */
  if (!tarifas || !Object.keys(tarifas).length) return vazio(meta);

  const porCiclo = {};
  let semMarca = 0, comMarca = 0;
  for (const t of Object.values(tarifas)) {
    if (!t || !t.d) continue;
    if (t.cartao == null) { semMarca++; continue; }   // registro anterior à migração: não dá pra saber
    comMarca++;
    /* 01/10 — O ESTORNO DE UMA COBRANÇA DO CARTÃO ABATE NO CARTÃO.
       O raio-x da AMB (set/2026) mostrou o caso com nome e sobrenome: 14 linhas de
       "Cancelamento da tarifa por campanha de Publicidade de Seguidores", R$ 322,33, TODAS
       marcadas como descontadas na venda. Mas Ads NÃO é cobrado na venda — só no cartão —,
       então esse crédito não tinha onde abater e simplesmente sumia: o painel cobrava a
       publicidade e nunca devolvia o estorno dela.
       A regra é estreita de propósito: só entra o crédito cujo ASSUNTO é uma categoria que a
       empresa só paga no cartão. Um estorno de frete ou de comissão continua fora, porque
       esses SÃO descontados na venda e lá eles já abatem — trazer esses pra cá seria descontar
       duas vezes. */
    const ehCreditoDeCartao = (!t.cartao) && (Number(t.v) || 0) < 0
      && CATEGORIAS_SO_DO_CARTAO.has(String(t.a || ''));
    if (!t.cartao && !ehCreditoDeCartao) continue;    // descontado na venda: não é fatura do cartão
    /* a marca do ML diz cartão, mas a fatura não tem essa linha: ver o bloco acima */
    if ((Number(t.v) || 0) > 0 && CATEGORIAS_NUNCA_DO_CARTAO.has(String(t.c || ''))) continue;
    const c = cicloDe(t.d);
    const f = porCiclo[c.chave] || (porCiclo[c.chave] = Object.assign({}, c, { total: 0, categorias: {}, linhas: 0 }));
    const cat = ehCreditoDeCartao ? String(t.a) : (t.c || 'outros');
    f.categorias[cat] = r2((f.categorias[cat] || 0) + (Number(t.v) || 0));
    f.total = r2(f.total + (Number(t.v) || 0));
    /* 01/10 — o dono quis os DOIS números: `total` é o que o cartão vai debitar (já com o
       estorno abatido), e `cobrado` é o que o ML cobrou fora da venda no período, sem abater.
       Os dois são verdade sobre coisas diferentes, e o painel mostrava só um — o que fazia a
       conferência contra o e-mail do débito não fechar sem explicação. */
    if ((Number(t.v) || 0) > 0) f.cobrado = r2((f.cobrado || 0) + (Number(t.v) || 0));
    else f.estornado = r2((f.estornado || 0) + (Number(t.v) || 0));
    f.linhas++;
  }

  /* 3) nenhuma tarifa com a marca = ainda não re-sincronizou depois da migração */
  if (!comMarca) return vazio(Object.assign({ sem_marca: semMarca }, meta));

  /* 4) o ciclo de hoje aparece zerado SÓ se o dado é fresco — senão um zero seria mentira
        (ex.: sincronização falhando há dias; o cache tem marca mas parou no ciclo passado) */
  const hoje = hojeSP();
  const atual = cicloDe(hoje);
  if (fresco && !porCiclo[atual.chave]) porCiclo[atual.chave] = Object.assign({}, atual, { total: 0, categorias: {}, linhas: 0 });

  const lista = Object.values(porCiclo).sort((a, b) => b.chave.localeCompare(a.chave));
  for (const f of lista) {
    f.composicao = Object.keys(f.categorias).map(k => ({ categoria: k, rotulo: ROTULO[k] || k, valor: f.categorias[k] }))
      .sort((a, b) => Math.abs(b.valor) - Math.abs(a.valor));
    delete f.categorias;
    f.situacao = f.ate < hoje ? (f.debito <= hoje ? 'debitada' : 'fechada, débito em ' + f.debito) : 'em andamento';
    /* ciclo atual com dado velho: diz que está desatualizado em vez de fingir que é de hoje */
    if (f.situacao === 'em andamento' && !fresco) f.situacao = 'em andamento (dado desatualizado)';
  }
  const base = Object.assign({ sem_marca: semMarca }, meta);
  if (o.referencia) return Object.assign({ fatura: lista.find(f => f.chave === cicloDe(o.referencia).chave) || null }, base);
  return Object.assign({ faturas: lista.slice(0, o.limite || 6) }, base);
}

module.exports = { faturas, cicloDe, hojeSP };
