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

function r2(v) { return Math.round((Number(v) || 0) * 100) / 100; }

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
function faturas(tarifas, opcoes) {
  const o = opcoes || {};
  const porCiclo = {};
  let semMarca = 0;
  for (const t of Object.values(tarifas || {})) {
    if (!t || !t.d) continue;
    if (t.cartao == null) { semMarca++; continue; }   // registro antigo, sem o campo — não dá pra saber
    if (!t.cartao) continue;                          // descontado na venda: não é fatura do cartão
    const c = cicloDe(t.d);
    const f = porCiclo[c.chave] || (porCiclo[c.chave] = Object.assign({}, c, { total: 0, categorias: {}, linhas: 0 }));
    const cat = t.c || 'outros';
    f.categorias[cat] = r2((f.categorias[cat] || 0) + (Number(t.v) || 0));
    f.total = r2(f.total + (Number(t.v) || 0));
    f.linhas++;
  }
  /* Codex #322: no dia 13 o ciclo novo ainda não tem nenhuma tarifa do cartão, e como as
     entradas só nascem ao iterar tarifas, o ciclo "em andamento" não existiria — sumiria
     justo no dia que este desenho veio tratar. Garante que o ciclo de HOJE sempre exista,
     mesmo zerado. */
  const hojeISO = new Date().toISOString().slice(0, 10);
  const atual = cicloDe(hojeISO);
  if (!porCiclo[atual.chave]) porCiclo[atual.chave] = Object.assign({}, atual, { total: 0, categorias: {}, linhas: 0 });
  const lista = Object.values(porCiclo).sort((a, b) => b.chave.localeCompare(a.chave));
  for (const f of lista) {
    f.composicao = Object.keys(f.categorias).map(k => ({ categoria: k, rotulo: ROTULO[k] || k, valor: f.categorias[k] }))
      .sort((a, b) => Math.abs(b.valor) - Math.abs(a.valor));
    delete f.categorias;
  }
  const hoje = new Date().toISOString().slice(0, 10);
  for (const f of lista) f.situacao = f.ate < hoje ? (f.debito <= hoje ? 'debitada' : 'fechada, débito em ' + f.debito) : 'em andamento';
  if (o.referencia) {
    const alvo = cicloDe(o.referencia).chave;
    return { fatura: lista.find(f => f.chave === alvo) || null, sem_marca: semMarca };
  }
  return { faturas: lista.slice(0, o.limite || 6), sem_marca: semMarca };
}

module.exports = { faturas, cicloDe };
