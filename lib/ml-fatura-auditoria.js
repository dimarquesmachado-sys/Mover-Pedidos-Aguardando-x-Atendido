'use strict';

/**
 * lib/ml-fatura-auditoria.js — POR QUE a fatura do cartão do painel não bate com o débito real.
 *
 * O caso que motivou (30/09, AMB): painel R$ 6.455,32 no ciclo 13/08→12/09, débito real no
 * cartão R$ 5.928,23. Diferença de R$ 527,09, com o dado FRESCO (2h) — ou seja, não é atraso
 * de sincronização. Duas categorias batiam byte a byte com a fatura oficial (Publicidade
 * 5.537,84 e Minha página 99,00), o que diz que a COLETA está lendo certo e o problema é de
 * CLASSIFICAÇÃO: alguma linha entra como cartão sem ser, ou algum crédito não é subtraído.
 *
 * Esta lib NÃO corrige nada e não decide quem está certo: ela ABRE o ciclo linha a linha, com
 * a marca que o próprio ML mandou em cada tarifa, pra comparação direta com o relatório de
 * Faturamento. Achar a causa por dedução é o que já custou caro aqui; o caminho é ver o dado.
 *
 * Multiempresa por construção: recebe o cache de tarifas e devolve o raio-x. Quem chama passa
 * o cache da sua empresa.
 */

const { cicloDe, hojeSP } = require('./ml-fatura-cartao');

function r2(v) { return Math.round((Number(v) || 0) * 100) / 100; }

/**
 * Abre UM ciclo. `tarifas` é o mapa do cache; `ref` é a chave do ciclo (ex.: '2026-09') ou
 * null pro último fechado.
 * Devolve: total, categorias, e as LINHAS — cada uma com data, valor, categoria, a marca do
 * ML e se tem pedido associado (tarifa com pedido que cai no cartão é justamente o caso
 * suspeito: o ML costuma descontar essas no repasse).
 */
function abrirCiclo(tarifas, ref) {
  const linhas = [];
  let semMarca = 0;

  for (const id of Object.keys(tarifas || {})) {
    const t = tarifas[id];
    if (!t || !t.d) continue;
    const c = cicloDe(t.d);
    if (ref && c.chave !== ref) continue;
    if (t.cartao == null) { semMarca++; }
    linhas.push({
      id,
      data: t.d,
      valor: r2(t.v),
      categoria: t.c || 'outros',
      /* a marca do ML: true = debited_from_operation NO = vai pro cartão */
      cartao: t.cartao == null ? null : !!t.cartao,
      pedido: t.o || null,
      ciclo: c.chave,
    });
  }

  linhas.sort((a, b) => (a.data === b.data ? b.valor - a.valor : (a.data < b.data ? -1 : 1)));

  const soma = (f) => r2(linhas.filter(f).reduce((s, l) => s + l.valor, 0));
  const noCartao = linhas.filter(l => l.cartao === true);

  /* as quebras que respondem a pergunta, cada uma isolando uma hipótese */
  const porCategoria = {};
  for (const l of noCartao) porCategoria[l.categoria] = r2((porCategoria[l.categoria] || 0) + l.valor);

  return {
    ciclo: ref || null,
    total_no_cartao: soma(l => l.cartao === true),
    por_categoria: porCategoria,

    /* HIPÓTESE 1: linha marcada como cartão mas COM pedido associado. O ML desconta no repasse
       o que tem venda pra abater — se isto tem valor, são candidatas a estar no lugar errado. */
    no_cartao_com_pedido: {
      total: soma(l => l.cartao === true && l.pedido),
      linhas: noCartao.filter(l => l.pedido).length,
    },

    /* HIPÓTESE 2: créditos (cancelamento, estorno, bonificação) que o painel não subtraiu
       porque foram marcados como descontados na venda (fora_do_cartao). Os SEM marca vão
       separados: destino desconhecido não é evidência desta hipótese. */
    creditos: {
      no_cartao: soma(l => l.cartao === true && l.valor < 0),
      /* só o que o ML marcou EXPLICITAMENTE como fora do cartão; sem marca é "não sei" e
         fica à parte em sem_marca, senão as hipóteses se sobrepõem */
      fora_do_cartao: soma(l => l.cartao === false && l.valor < 0),
      sem_marca: soma(l => l.cartao == null && l.valor < 0),
    },

    /* HIPÓTESE 3: registros anteriores à migração, que a lib da fatura ignora de propósito —
       se forem muitos, o total do painel está incompleto por outro motivo. */
    sem_marca: { linhas: semMarca, total: soma(l => l.cartao == null) },

    linhas_total: linhas.length,
    linhas: linhas,
  };
}

/** Lista os ciclos disponíveis no cache, do mais novo pro mais velho. */
function ciclosDisponiveis(tarifas) {
  const vistos = {};
  for (const id of Object.keys(tarifas || {})) {
    const t = tarifas[id];
    if (!t || !t.d) continue;
    const c = cicloDe(t.d);
    const v = vistos[c.chave] || (vistos[c.chave] = { ciclo: c.chave, rotulo: c.rotulo, de: c.de, ate: c.ate, linhas: 0, no_cartao: 0 });
    v.linhas++;
    if (t.cartao === true) v.no_cartao = r2(v.no_cartao + (Number(t.v) || 0));
  }
  return Object.values(vistos).sort((a, b) => (a.ciclo < b.ciclo ? 1 : -1));
}

/**
 * Escolhe o ciclo a auditar. Sem `pedido`, o ÚLTIMO FECHADO (ate < hoje) — o que o cartão já
 * debitou ou vai debitar; o ciclo em andamento só por pedido explícito. Recusa ciclo
 * inexistente ou cache vazio em vez de devolver zero: zero de dado ausente é indistinguível
 * de fatura zerada num diagnóstico financeiro.
 * Devolve { ref, ciclos } ou { erro, ciclos }.
 */
function escolherCiclo(tarifas, pedido, hoje) {
  const ciclos = ciclosDisponiveis(tarifas);
  if (!ciclos.length) return { erro: 'sem_dado: cache de tarifas vazio', sem_dado: true, ciclos };
  if (pedido) {
    if (!ciclos.some(c => c.ciclo === pedido)) return { erro: 'ciclo_inexistente: ' + pedido, ciclos };
    return { ref: pedido, ciclos };
  }
  const h = hoje || hojeSP();
  const fechado = ciclos.find(c => c.ate < h) || ciclos[ciclos.length - 1];
  return { ref: fechado.ciclo, ciclos };
}

module.exports = { abrirCiclo, ciclosDisponiveis, escolherCiclo };
