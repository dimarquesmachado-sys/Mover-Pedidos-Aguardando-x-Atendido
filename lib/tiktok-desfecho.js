'use strict';

/**
 * lib/tiktok-desfecho.js — o que ACONTECEU com cada venda do TikTok (29/08).
 *
 * O problema que motiva: hoje o sistema só sabe distinguir "venda boa" de "cancelada"
 * (repasse líquido zerou). Tudo no meio — reembolso PARCIAL, débito por culpa da loja,
 * ajuste avulso da mediação — deixa o repasse positivo e a venda segue no dashboard com
 * valor cheio. O prejuízo vira lucro fantasma, e é dinheiro real: no caso levantado, o
 * TikTok aprovou a devolução sozinho por falta de resposta no prazo e debitou R$ 41,01
 * contra R$ 21,12 já creditados.
 *
 * Esta peça NÃO coleta nada: lê o que coletarFinanceiro já guarda por pedido e classifica.
 * Vale pras 3 empresas — a loja é parâmetro, não cópia.
 *
 * Uma armadilha registrada pela conversa do Devoluções: a compensação vem como AJUSTE com
 * id próprio, que apenas REFERENCIA o pedido. Quem filtra o extrato por order_id não a
 * encontra. A coleta daqui já resolve isso acumulando em `ajustes_depois` por pedido — é
 * dele que sai o impacto abaixo.
 */

const CENTAVO = 0.01;
const r2 = v => Math.round((Number(v) || 0) * 100) / 100;

/**
 * Classifica um registro de pedido do cache financeiro.
 * Desfechos: 'limpa' | 'reversao_total' | 'reembolso_parcial' | 'debito_ajuste' | 'so_ajuste'
 */
function desfechoDoPedido(reg) {
  if (!reg || typeof reg !== 'object') return null;
  const receita = Number(reg.receita || 0);
  const repasseBruto = (reg.repasse != null && isFinite(Number(reg.repasse))) ? Number(reg.repasse) : null;
  const ajustes = Number(reg.ajustes_depois || 0);
  const liquido = repasseBruto == null ? null : r2(repasseBruto + ajustes);
  const estornouTarifa = Number(reg.tarifa_devolvida || 0) > 0;
  const reembolso = Number(reg.reembolso_cliente || 0);

  /* Registro que existe SÓ como ajuste: a venda é anterior à janela coletada. O impacto é
     real e precisa aparecer, mesmo sem a venda original em mãos — é o caso da mediação que
     acontece 50 dias depois. */
  if (reg.so_ajuste) {
    return { desfecho: 'so_ajuste', impacto: r2(ajustes), receita: null, liquido: null,
             nota: 'ajuste sem a venda na janela (ação tardia) — o impacto vale mesmo assim' };
  }

  if (liquido == null) return { desfecho: 'limpa', impacto: 0, receita, liquido: null, nota: 'sem repasse conhecido ainda' };

  /* Reversão total: o que o sistema já tratava. Fica aqui pra classificação ser completa. */
  if (estornouTarifa && receita > 0 && liquido <= CENTAVO) {
    return { desfecho: 'reversao_total', impacto: r2(-repasseBruto - ajustes + ajustes), receita, liquido,
             nota: 'venda revertida por inteiro — sai do faturamento' };
  }

  /* Qualquer ajuste negativo que NÃO zerou o repasse: reembolso parcial, débito de mediação,
     taxa administrativa. A venda continua existindo (o cliente ficou com algo), mas o
     resultado dela é menor — e é isso que hoje não chega ao dashboard. */
  if (ajustes < -CENTAVO) {
    const parcial = reembolso > 0 && reembolso < receita;
    return {
      desfecho: parcial ? 'reembolso_parcial' : 'debito_ajuste',
      impacto: r2(ajustes),           // negativo: quanto a venda PERDEU depois de fechada
      receita, liquido,
      nota: parcial
        ? 'reembolso parcial — cliente ficou com parte, a venda vale menos'
        : 'débito/ajuste posterior (mediação, taxa, compensação) — reduz o resultado da venda'
    };
  }

  /* Ajuste POSITIVO: o TikTok compensou a loja (ex.: reembolso de logística quando a culpa
     foi da transportadora). Também precisa aparecer — é receita que ninguém está contando. */
  if (ajustes > CENTAVO) {
    return { desfecho: 'credito_ajuste', impacto: r2(ajustes), receita, liquido,
             nota: 'compensação a favor da loja (ex.: reembolso de logística)' };
  }

  return { desfecho: 'limpa', impacto: 0, receita, liquido, nota: null };
}

/** Percorre o cache de uma loja e devolve os pedidos com desfecho diferente de 'limpa'. */
function desfechosDaLoja(cachePedidos, opcoes) {
  const o = opcoes || {};
  const pedidos = (cachePedidos && cachePedidos.pedidos) || {};
  const linhas = [];
  let impactoNegativo = 0, impactoPositivo = 0, limpas = 0;
  for (const sn of Object.keys(pedidos)) {
    const d = desfechoDoPedido(pedidos[sn]);
    if (!d) continue;
    if (d.desfecho === 'limpa') { limpas++; continue; }
    if (d.impacto < 0) impactoNegativo = r2(impactoNegativo + d.impacto);
    if (d.impacto > 0) impactoPositivo = r2(impactoPositivo + d.impacto);
    linhas.push(Object.assign({ order_id: sn }, d));
  }
  linhas.sort((a, b) => (a.impacto || 0) - (b.impacto || 0));   // pior primeiro
  const porDesfecho = {};
  for (const l of linhas) porDesfecho[l.desfecho] = (porDesfecho[l.desfecho] || 0) + 1;
  return {
    total_pedidos: Object.keys(pedidos).length,
    vendas_limpas: limpas,
    com_desfecho: linhas.length,
    por_desfecho: porDesfecho,
    impacto_negativo: impactoNegativo,     // prejuízo que hoje NÃO aparece no dashboard
    impacto_positivo: impactoPositivo,     // compensações que também não aparecem
    linhas: o.limite ? linhas.slice(0, o.limite) : linhas
  };
}

module.exports = { desfechoDoPedido, desfechosDaLoja };
