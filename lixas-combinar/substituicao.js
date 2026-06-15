'use strict';

/**
 * substituicao.js — Motor DETERMINÍSTICO de substituição de grãos (lixas-combinar)
 *
 * Usado em DUAS pontas, com o MESMO miolo:
 *   1) Botão manual do admin ("Montar com substituição + NF") — palavra do vendedor, executa já.
 *   2) Resolução automática da escada (último caso, pós-5ª mensagem, cliente calado).
 *
 * Regra de negócio (definida com o Diego em 15/06/2026):
 *   - Grão pedido SEM estoque → troca pelo grão DISPONÍVEL numericamente mais próximo.
 *   - Empate de distância → desempata pelo MAIOR estoque (mais folga operacional).
 *   - NÃO existe trava de "longe demais": a troca só roda como ÚLTIMO caso (admin ou
 *     pós-escada), então mesmo um salto grande (24→100) é aceito de propósito —
 *     é melhor despachar o mais perto possível do que deixar o pedido atrasar.
 *   - Grãos repetidos após a troca são FUNDIDOS (somam quantidades).
 *   - Valida que o total final bate com o esperado (lixas_por_kit). NÃO emite nada aqui.
 *
 * Nada de IA aqui: é aritmética + estoque. Puro e testável.
 */

/**
 * Extrai o pedido LITERAL do cliente de um texto livre, em pares {grao, quantidade}.
 * Foca nos casos com QUANTIDADE EXPLÍCITA (que é exatamente quando a substituição se aplica).
 * Tolera erros comuns: "grao"/"grão"/"garo"/"gr", "lixas"/"un"/"pacotes", "N do G".
 *
 * Retorna { ok, itens:[{grao,quantidade}], naoEntendido:bool }.
 * Se não conseguir extrair nada com quantidade, ok=false (cai pra tratamento humano/IA).
 */
function parsePedidoLiteral(texto) {
  if (!texto || typeof texto !== 'string') return { ok: false, itens: [], motivo: 'texto_vazio' };
  const t = ' ' + texto.toLowerCase().replace(/\s+/g, ' ') + ' ';

  const achados = [];
  const push = (q, g) => {
    const qn = parseInt(q, 10), gn = parseInt(g, 10);
    if (Number.isFinite(qn) && Number.isFinite(gn) && qn > 0 && gn > 0) achados.push({ grao: gn, quantidade: qn });
  };

  // Padrão A: "<qtd> [lixas|un|unidades|pacotes|pc] <grao|grão|garo|gr> <num>"
  //   ex: "50 lixas grao 24", "20 lixas garo 150", "30 un grão 80"
  const reA = /(\d+)\s*(?:lixas?|unidades?|un\.?|pacotes?|pc\.?|folhas?)?\s*(?:gr[aã]o|garo|gr\.?|#)\s*(\d+)/gi;
  let m;
  while ((m = reA.exec(t)) !== null) push(m[1], m[2]);

  // Padrão B: "<qtd> do <grao>"  ex: "50 do 24", "30 do 120"
  const reB = /(\d+)\s*do\s*(\d+)/gi;
  while ((m = reB.exec(t)) !== null) push(m[1], m[2]);

  // Padrão C: "<grao|grão> <num> : <qtd>"  ex: "grão 24: 50", "grao 80 = 20"
  const reC = /(?:gr[aã]o|garo)\s*(\d+)\s*[:=\-]\s*(\d+)/gi;
  while ((m = reC.exec(t)) !== null) push(m[2], m[1]);

  if (achados.length === 0) return { ok: false, itens: [], motivo: 'nenhum_par_com_quantidade' };

  // Dedup por (grao,quantidade) idêntico que os 3 regex possam ter capturado em dobro
  const vistos = new Set();
  const itens = [];
  for (const it of achados) {
    const k = `${it.grao}:${it.quantidade}`;
    if (vistos.has(k)) continue;
    vistos.add(k);
    itens.push(it);
  }
  return { ok: true, itens };
}

/**
 * Dado um grão pedido (sem estoque), devolve o grão DISPONÍVEL mais próximo.
 * graosDisponiveis: [{ grao:Number, estoque_pacotes:Number }, ...]
 * Empate de distância → maior estoque → menor grão (desempate final estável).
 * Retorna { grao, estoque, dist } ou null se não houver nenhum com estoque.
 */
function escolherGraoSubstituto(graoPedido, graosDisponiveis) {
  const alvo = Number(graoPedido);
  const cand = (graosDisponiveis || [])
    .filter(g => Number(g.estoque_pacotes) > 0)
    .map(g => ({ grao: Number(g.grao), estoque: Number(g.estoque_pacotes), dist: Math.abs(Number(g.grao) - alvo) }));
  if (cand.length === 0) return null;
  cand.sort((a, b) => a.dist - b.dist || b.estoque - a.estoque || a.grao - b.grao);
  return cand[0];
}

/**
 * Resolve o pedido inteiro aplicando substituição onde precisa, fundindo repetidos
 * e validando o total. NÃO emite nada.
 *
 * @param {Array}  pedidoCliente  [{grao, quantidade}] — o que o cliente pediu (literal)
 * @param {Array}  graosDisponiveis [{grao, estoque_pacotes}] — estoque real do Bling
 * @param {Number} totalEsperado  lixas_por_kit (ex: 100)
 * @param {Number} unidadesPorPacote  (ex: 10) — pra checar múltiplos
 *
 * Retorna {
 *   ok, total, totalEsperado, multiplosOk,
 *   trocas:[{de,para,qtd,dist}], pedidoFinal:[{grao,quantidade}],
 *   avisos:[...]
 * }
 */
function resolverPedidoComSubstituicao(pedidoCliente, graosDisponiveis, totalEsperado, unidadesPorPacote = 10) {
  const disponiveis = new Set(
    (graosDisponiveis || []).filter(g => Number(g.estoque_pacotes) > 0).map(g => Number(g.grao))
  );
  const trocas = [];
  const avisos = [];
  const mapa = new Map(); // grao final -> quantidade somada

  for (const item of (pedidoCliente || [])) {
    const g = Number(item.grao);
    const q = Number(item.quantidade);
    if (!Number.isFinite(g) || !Number.isFinite(q) || q <= 0) { avisos.push(`item inválido ignorado: ${JSON.stringify(item)}`); continue; }

    let finalGrao = g;
    if (!disponiveis.has(g)) {
      const sub = escolherGraoSubstituto(g, graosDisponiveis);
      if (!sub) return { ok: false, erro: 'sem_grao_disponivel', detalhe: `nenhum grão com estoque pra substituir ${g}`, trocas, pedidoFinal: [] };
      finalGrao = sub.grao;
      trocas.push({ de: g, para: sub.grao, qtd: q, dist: sub.dist });
    }
    mapa.set(finalGrao, (mapa.get(finalGrao) || 0) + q);
  }

  const pedidoFinal = [...mapa.entries()]
    .map(([grao, quantidade]) => ({ grao, quantidade }))
    .sort((a, b) => a.grao - b.grao);

  const total = pedidoFinal.reduce((s, x) => s + x.quantidade, 0);
  const multiplosOk = pedidoFinal.every(x => x.quantidade % unidadesPorPacote === 0);
  if (!multiplosOk) avisos.push(`alguma quantidade final não é múltipla de ${unidadesPorPacote}`);

  return {
    ok: total === Number(totalEsperado) && multiplosOk,
    total,
    totalEsperado: Number(totalEsperado),
    multiplosOk,
    trocas,
    pedidoFinal,
    avisos
  };
}

/**
 * Monta a mensagem de FECHAMENTO pro cliente quando houve substituição de grão.
 * Determinística, ≤350 chars (limite do ML), cita os grãos exatos. Tom: cordial,
 * benefício do cliente (não atrasar o envio) — sem citar penalidade interna do ML.
 * Retorna null se não houve troca (aí não manda nada).
 *
 * @param {Array}  trocas       [{de, para, qtd, dist}]
 * @param {Array}  pedidoFinal  [{grao, quantidade}]
 * @param {Number} totalLixas
 */
function montarMsgSubstituicao(trocas, pedidoFinal, totalLixas) {
  if (!Array.isArray(trocas) || trocas.length === 0) return null;

  let fraseTroca;
  if (trocas.length === 1) {
    const t = trocas[0];
    fraseTroca = `O grão ${t.de} estava sem estoque e não recebemos sua escolha a tempo. Para não atrasar o envio do seu pedido, substituímos pelo grão ${t.para}, o mais próximo disponível.`;
  } else {
    const des = trocas.map(t => t.de).join(', ');
    const par = trocas.map(t => `${t.de}→${t.para}`).join(', ');
    fraseTroca = `Os grãos ${des} estavam sem estoque e não recebemos sua escolha a tempo. Para não atrasar o envio, substituímos pelos mais próximos disponíveis: ${par}.`;
  }

  const comp = (pedidoFinal || []).map(g => `${g.quantidade}x${g.grao}`).join(', ');

  let msg = `Olá! ${fraseTroca} Seu pedido segue: ${comp} = ${totalLixas} lixas, já a caminho. Qualquer dúvida, estamos à disposição!`;
  if (msg.length > 350) {
    // Versão sem a composição detalhada (caso muitos grãos estourem o limite)
    msg = `Olá! ${fraseTroca} Seu pedido (${totalLixas} lixas) já está a caminho. Qualquer dúvida, estamos à disposição!`;
  }
  if (msg.length > 350) msg = msg.slice(0, 347) + '...';
  return msg;
}

module.exports = { parsePedidoLiteral, escolherGraoSubstituto, resolverPedidoComSubstituicao, montarMsgSubstituicao };
