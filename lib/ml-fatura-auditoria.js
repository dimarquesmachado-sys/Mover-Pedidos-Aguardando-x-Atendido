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
      /* 30/09 — o que o crédito CANCELAVA. "Anulación del cargo por campaña de publicidad" tem
         categoria `credito` e perde o "publicidade" — sem isto, o estorno de um Ads não se
         parece com Ads e não dá pra casar com a cobrança que ele abate. */
      assunto: t.a || null,
      /* o texto original que o ML mandou: é dele que sai qualquer regra nova */
      texto: t.t || null,
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

    /* 30/09 — O raio-x da AMB deu `creditos.no_cartao: 0` enquanto R$ 3.019,14 de créditos
       ficaram fora. Implausível: a fatura do ML lista "Cancelamentos de tarifas" e o Ads é
       ~73% da fatura do cartão. Suspeita: o ML devolve o crédito com `debited_from_operation`
       diferente de NO, e a cobrança vai pro cartão sem o estorno.
       Esta quebra mostra a CATEGORIA dos créditos marcados EXPLICITAMENTE como fora do cartão
       (sem marca fica em sem_marca).
       Codex #541: `_mlbCategoria` manda anulación/cancelamento/bonifica pra 'credito' ANTES de
       olhar ads/full, então o estorno de um Ads NÃO tem categoria 'ads' no cache. Por isso não
       há cruzamento "crédito × categoria de cartão": com o que o cache guarda ele daria zero
       justo no caso que quer diagnosticar. Atribuir o crédito à cobrança exigiria a descrição
       original, que o cache não tem. */
    creditos_fora_por_categoria: (() => {
      const m = {};
      for (const l of linhas) {
        /* o filtro é `!== false` (dele): SEM MARCA é destino desconhecido, não "fora do
           cartão" — misturar os dois apontaria hipótese errada.
           E agrupa pelo ASSUNTO (meu): a categoria de todo crédito é `credito`, então agrupar
           por ela devolveria um balde só, que não responde nada. */
        if (l.cartao !== false || l.valor >= 0) continue;
        const k = l.assunto || l.categoria;
        m[k] = r2((m[k] || 0) + l.valor);
      }
      return m;
    })(),

    /* o subtotal que RESPONDE a pergunta: crédito cujo assunto é categoria que SÓ existe no
       cartão não tem cobrança fora pra abater — ele só pode ser do cartão, e é ele que explica
       a diferença entre o painel e o débito real.
       O claude[bot] tinha REMOVIDO este cruzamento por ver que o estorno vem como `credito`;
       com o assunto gravado, ele volta a funcionar — e é o número que o dono precisa. */
    creditos_fora_de_categoria_de_cartao: (() => {
      const doCartao = new Set(linhas.filter(l => l.cartao === true).map(l => l.categoria));
      let t = 0;
      for (const l of linhas) {
        if (l.cartao !== false || l.valor >= 0) continue;
        if (doCartao.has(l.assunto || l.categoria)) t = r2(t + l.valor);
      }
      return t;
    })(),
    /* 01/10 — OS TEXTOS DOS CRÉDITOS, agrupados. O raio-x real devolveu os R$ 3.019 num balde
       só (`credito`), o que diz que o texto NÃO informa o que está sendo cancelado — bate com
       a fatura do ML, que lista "Cancelamentos de tarifas" sem dizer de quê.
       Sem o texto não dá pra atribuir por regra. Isto mostra os textos distintos e quanto cada
       um soma, que é o que permite decidir o caminho: ou aparece um padrão novo pra regra, ou
       fica provado que a atribuição tem que vir de outro campo (pedido, data, valor casado). */
    creditos_textos: (() => {
      /* Map: o texto vem do ML e pode ser `constructor`/`__proto__` — num objeto comum o grupo
         sumiria. Sem corte nos N maiores: grupos pequenos podem somar justo a diferença
         procurada. `total` = tudo; no_cartao/fora_do_cartao/sem_marca o decompõem, pra não
         misturar crédito marcado fora do cartão com destino desconhecido (cartao null). */
      const m = new Map();
      for (const l of linhas) {
        if (l.valor >= 0) continue;
        const k = String(l.texto || '(sem texto guardado)').slice(0, 90);
        let g = m.get(k);
        if (!g) { g = { linhas: 0, total: 0, no_cartao: 0, fora_do_cartao: 0, sem_marca: 0 }; m.set(k, g); }
        g.linhas++;
        g.total = r2(g.total + l.valor);
        if (l.cartao === true) g.no_cartao = r2(g.no_cartao + l.valor);
        else if (l.cartao === false) g.fora_do_cartao = r2(g.fora_do_cartao + l.valor);
        else g.sem_marca = r2(g.sem_marca + l.valor);
      }
      /* os maiores primeiro: é onde mora a explicação de uma diferença de centenas de reais */
      return Array.from(m, ([texto, g]) => Object.assign({ texto }, g))
        .sort((x, y) => x.total - y.total);
    })(),

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
  const fechado = ciclos.find(c => c.ate < h);
  if (!fechado) return { erro: 'sem_ciclo_fechado: so ha ciclo em andamento; peca-o explicitamente com ?ciclo=', sem_dado: true, ciclos };
  return { ref: fechado.ciclo, ciclos };
}

module.exports = { abrirCiclo, ciclosDisponiveis, escolherCiclo };
