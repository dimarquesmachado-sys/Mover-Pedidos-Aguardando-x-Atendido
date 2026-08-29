'use strict';

/**
 * lib/tiktok-conciliar.js — junta DEVOLUÇÕES × FINANCEIRO por PEDIDO (29/08).
 *
 * O problema que o dono levantou olhando a tela de reembolsos: são ~60 solicitações, e o
 * MESMO pedido aparece mais de uma vez (585225096729101357, 585234469423907917 e
 * 585175614217684389 aparecem 2x cada na lista dele). Contar solicitação = contar duas
 * vezes o mesmo prejuízo. E o valor que a tela mostra é o REEMBOLSO AO CLIENTE, que não é
 * o que saiu da loja: no 585514776487560610 a tela diz R$ 36,00 e o extrato debitou 41,01.
 *
 * Então a regra desta peça:
 *   • a chave é o ORDER_ID, nunca o return_id — solicitações do mesmo pedido colapsam em 1;
 *   • o VALOR vem sempre do extrato (desfecho financeiro), nunca da tela de devoluções;
 *   • solicitação cancelada não vira perda (36% das solicitações são canceladas);
 *   • pedido com devolução mas SEM lançamento no extrato fica marcado como pendente, não
 *     como zero — é a diferença entre "não teve custo" e "ainda não caiu".
 */

const { desfechoDoPedido } = require('./tiktok-desfecho');

const r2 = v => Math.round((Number(v) || 0) * 100) / 100;
const CANCELADA = /CANCEL/i;

function conciliar(cacheDevolucoes, cacheFinanceiro, opcoes) {
  const o = opcoes || {};
  const devs = (cacheDevolucoes && cacheDevolucoes.devolucoes) || {};
  const pedidosFin = (cacheFinanceiro && cacheFinanceiro.pedidos) || {};

  /* 1) agrupa as solicitações POR PEDIDO */
  const porPedido = {};
  for (const d of Object.values(devs)) {
    if (!d || typeof d !== 'object') continue;
    const oid = String(d.order_id || '').trim();
    if (!oid) continue;                       // sem pedido não dá pra conciliar
    if (!porPedido[oid]) porPedido[oid] = { order_id: oid, solicitacoes: 0, canceladas: 0, motivos: [], status: [], reembolso_pedido: 0 };
    const p = porPedido[oid];
    p.solicitacoes++;
    if (CANCELADA.test(String(d.status || ''))) p.canceladas++;
    if (d.motivo && p.motivos.indexOf(d.motivo) < 0) p.motivos.push(d.motivo);
    if (d.status && p.status.indexOf(d.status) < 0) p.status.push(d.status);
    /* o maior reembolso pedido, só como referência — NÃO é o valor contábil */
    const v = Number(d.valor || d.reembolso || 0);
    if (isFinite(v) && v > p.reembolso_pedido) p.reembolso_pedido = r2(v);
  }

  /* 2) casa com o extrato e classifica */
  const linhas = [];
  let perda = 0, ganho = 0, pendentes = 0, sóCanceladas = 0;
  for (const oid of Object.keys(porPedido)) {
    const p = porPedido[oid];
    const fin = pedidosFin[oid] || null;
    const desf = fin ? desfechoDoPedido(fin) : null;

    if (p.canceladas === p.solicitacoes) {
      sóCanceladas++;
      linhas.push(Object.assign(p, { situacao: 'so_solicitacoes_canceladas', impacto: 0,
        nota: 'todas as solicitações deste pedido foram canceladas — não vira perda' }));
      continue;
    }
    if (!desf) {
      pendentes++;
      linhas.push(Object.assign(p, { situacao: 'sem_lancamento_ainda', impacto: null,
        nota: 'devolução existe mas o extrato ainda não tem lançamento — PENDENTE, não é zero' }));
      continue;
    }
    const imp = Number(desf.impacto || 0);
    if (imp < 0) perda = r2(perda + imp);
    if (imp > 0) ganho = r2(ganho + imp);
    linhas.push(Object.assign(p, {
      situacao: desf.desfecho, impacto: imp, receita: desf.receita, liquido: desf.liquido,
      /* 29/08: só compara quando HÁ impacto — com impacto 0 a conta virava
         "-reembolso_pedido" e parecia um erro gigante em toda linha limpa. */
      diferenca_tela_x_extrato: (imp && p.reembolso_pedido) ? r2(Math.abs(imp) - p.reembolso_pedido) : null,
      nota: desf.nota
    }));
  }
  linhas.sort((a, b) => (a.impacto == null ? 1 : b.impacto == null ? -1 : a.impacto - b.impacto));

  return {
    pedidos_com_devolucao: linhas.length,
    solicitacoes_totais: Object.values(devs).length,
    duplicadas_colapsadas: Object.values(devs).length - linhas.length,
    so_canceladas: sóCanceladas,
    sem_lancamento: pendentes,
    perda_confirmada: perda,          // sai do bolso da loja e hoje não está no dashboard
    compensacao_recebida: ganho,      // o TikTok pagou de volta — também não está
    linhas: o.limite ? linhas.slice(0, o.limite) : linhas
  };
}

module.exports = { conciliar };
