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
    if (c.classe === 'pedido_teste') continue;   /* Codex #300 r2: homologação do Magalu não entra */
    const code = String(c.code || '');
    /* Codex #300 r2: tem_reversa true sem reverse_code não prova pacote — o próprio serviço
       diz que "protocolo aberto e pacote a caminho são coisas diferentes". Exige o código. */
    const temReversa = !!(rev[code] && rev[code].reverse_code);
    const despachou = saiu[code] === true;
    const naoSabeSeSaiu = saiu[code] == null;

    /* Codex #300 (P1): eu tratava returns[] do pedido como prova de que o produto VOLTOU
       fisicamente. Não é: returns[] é o REGISTRO da devolução (estorno autorizado), e o
       caso real 1540670112009168 provou a diferença dos dois lados — lá a remessa reversa
       do Magalu respondeu false e mesmo assim havia pacote a caminho (coletado 05/08,
       entregue no galpão 06/08). Registro e pacote são coisas independentes. Só o
       reverse_code prova pacote; o returns[] vira PISTA. */
    const voltou = temReversa;
    const temRegistroDevolucao = !!c.tem_devolucao;

    /* 30/08 — o serviço de Devoluções devolve mais do que eu pedi, e é útil: motivo do
       ticket, status e se o cliente chegou a abrir protocolo. Nos 5 maiores da GOOD vieram
       3 com 'shipping_address_issues' — problema de ENDEREÇO, ou seja, o pedido não chegou
       ao cliente. Isso é um forte indício de que não há produto na mão de ninguém, mas NÃO
       é prova de que ele não saiu do CD: pode ter voltado pela transportadora sem virar
       remessa reversa formal. Por isso entra como PISTA na resposta, não como conclusão. */
    const info = rev[code] || {};
    const enderecoRuim = /address/i.test(String(info.motivo || ''));
    const semProtocolo = info.tem_ticket === false;

    /* Codex #300 r2: NF já cancelada não precisa de ação nenhuma — mandar alguém "cancelar
       a nota" de novo é retrabalho e confunde. O status vem em notas[].status. */
    const notas = Array.isArray(c.notas) ? c.notas : [];
    const todasCanceladas = notas.length > 0 && notas.every(n => /cancel/i.test(String(n && n.status || '')));

    let situacao, acao;
    if (todasCanceladas) {
      linhas.push({ code, situacao: 'nf_ja_cancelada', acao: 'nada a fazer — a NF já está cancelada',
        valor_pedido: c.valor_pedido, comissao: c.comissao, nf: notas[0] || null, nf_todas: notas,
        data_evento: c.data_evento, voltou: temReversa, tem_reversa: temReversa });
      continue;
    }
    if (voltou) {
      situacao = 'produto_voltou';
      acao = 'remessa reversa confirmada (há reverse_code) — NF de devolução COM entrada de estoque';
    } else if (temRegistroDevolucao) {
      /* estorno autorizado mas sem remessa: pode haver pacote vindo por fora (coleta que
         falhou e o cliente postou, ou reversa que o índice não pegou). NÃO decidir sozinho. */
      situacao = 'estorno_sem_remessa';
      acao = 'estorno autorizado sem remessa reversa localizada — CONFERIR se há pacote a caminho antes de dar baixa; já aconteceu de o produto chegar sem aviso';
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
      tem_registro_devolucao: temRegistroDevolucao,   /* returns[] do pedido — registro, não pacote */
      nf_todas: Array.isArray(c.notas) ? c.notas : [],   /* Codex #300: pedido pode ter mais de uma NF */
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
