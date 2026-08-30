'use strict';

/**
 * lib/magalu-cruzar.js — separa "NF de produto que nunca saiu" de "produto perdido" (30/08).
 *
 * O caso: os pedidos classificados como `pago_cancelado_com_nf` (pagou, NF emitida, cancelou,
 * SEM devolução registrada) são ambíguos. Podem ser duas coisas muito diferentes:
 *   a) cancelou ANTES de despachar → a NF existe mas o produto nunca saiu. Cancelar a nota
 *      (ou emitir devolução sem entrada de estoque) recupera o imposto.
 *   b) despachou e o cliente ficou com a mercadoria → além do imposto, perdeu-se o produto.
 *
 * Nenhuma das duas pontas responde sozinha:
 *   • a conversa do Devoluções responde "VOLTOU?" (remessa reversa do ticket Magalu, com
 *     reverse_code) — eles montam o índice varrendo /seller/v0/tickets e casando order.code;
 *   • daqui responde "SAIU?" — se houve etiqueta anexada no checkout daquele pedido.
 *
 * Regra deles que vale registrar: NÃO filtrar por ticket aberto. O Magalu fecha o ticket com
 * o pacote ainda na rua, e o endpoint de reversas responde para ticket fechado — filtrar por
 * abertos pula justamente os que importam.
 */

function cruzar(cancelados, reversasPorCodigo, saiuPorCodigo) {
  const rev = reversasPorCodigo || {};
  const saiu = saiuPorCodigo || {};
  const linhas = [];
  for (const c of (cancelados || [])) {
    if (!c || !c.tem_nf) continue;            // sem NF não há imposto a recuperar
    const code = String(c.code || '');
    const temReversa = !!(rev[code] && rev[code].tem_reversa);
    const despachou = saiu[code] === true;
    const naoSabeSeSaiu = saiu[code] == null;

    /* a devolução já registrada no pedido também conta como "voltou" */
    const voltou = temReversa || !!c.tem_devolucao;

    /* 30/08 — o serviço de Devoluções devolve mais do que eu pedi, e é útil: motivo do
       ticket, status e se o cliente chegou a abrir protocolo. Nos 5 maiores da GOOD vieram
       3 com 'shipping_address_issues' — problema de ENDEREÇO, ou seja, o pedido não chegou
       ao cliente. Isso é um forte indício de que não há produto na mão de ninguém, mas NÃO
       é prova de que ele não saiu do CD: pode ter voltado pela transportadora sem virar
       remessa reversa formal. Por isso entra como PISTA na resposta, não como conclusão. */
    const info = rev[code] || {};
    const enderecoRuim = /address/i.test(String(info.motivo || ''));
    const semProtocolo = info.tem_ticket === false;

    let situacao, acao;
    if (voltou) {
      situacao = 'produto_voltou';
      acao = 'devolução física — fluxo normal de NF de devolução com entrada de estoque';
    } else if (despachou) {
      situacao = 'saiu_e_nao_voltou';
      acao = 'PREJUÍZO REAL: produto foi e não voltou — além do imposto, perdeu-se a mercadoria';
    } else if (naoSabeSeSaiu) {
      situacao = 'indefinido';
      acao = 'não há registro de etiqueta nem de reversa — conferir manualmente antes de agir';
    } else {
      situacao = 'nf_sem_saida';
      acao = 'NF emitida e produto NÃO saiu — cancelar a NF (se no prazo) ou devolução SEM entrada de estoque, só pro imposto';
    }

    linhas.push({
      code, situacao, acao,
      valor_pedido: c.valor_pedido, comissao: c.comissao,
      nf: (c.notas && c.notas[0]) || null,
      data_evento: c.data_evento,
      voltou, tem_reversa: temReversa, reverse_code: info.reverse_code || null,
      motivo_ticket: info.motivo || null, tem_ticket: info.tem_ticket == null ? null : !!info.tem_ticket,
      /* pistas — ajudam a decidir, não decidem sozinhas */
      pista: enderecoRuim ? 'problema de endereço: o pedido não chegou ao cliente — confira se voltou pela transportadora antes de tratar como \"nunca saiu\"'
           : semProtocolo ? 'cliente nem abriu protocolo — indício de cancelamento antes da entrega'
           : null,
      saiu: despachou, saiu_conhecido: !naoSabeSeSaiu,
    });
  }
  const por = {};
  for (const l of linhas) por[l.situacao] = (por[l.situacao] || 0) + 1;
  const soma = (f) => Math.round(linhas.filter(f).reduce((s, l) => s + (l.valor_pedido || 0), 0) * 100) / 100;
  return {
    total: linhas.length,
    por_situacao: por,
    valor_nf_sem_saida: soma(l => l.situacao === 'nf_sem_saida'),
    valor_prejuizo_real: soma(l => l.situacao === 'saiu_e_nao_voltou'),
    valor_indefinido: soma(l => l.situacao === 'indefinido'),
    linhas,
  };
}

module.exports = { cruzar };
