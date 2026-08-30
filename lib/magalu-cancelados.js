'use strict';

/**
 * lib/magalu-cancelados.js — cancelamentos e devoluções do Magalu (30/08).
 *
 * DESCOBERTO POR SONDA, com o pedido real 1535770109894199 (Girassol):
 * a API FINANCEIRA do Magalu (/seller/v1/financial-analysis/orders) NÃO mostra o estorno —
 * ela agrupa transações pela janela da COMPRA (limite de 15 dias por chamada), e o
 * cancelamento de 30/05 de uma venda de 11/05 simplesmente não aparece. O pedido continua
 * somando R$ 37,81 de "lucro" que não existe.
 *
 * Quem conta a verdade é a API de PEDIDOS: status 'cancelled' no pedido e na entrega, e
 * `deliveries[].returns[]` com external_id e a DATA do estorno (2026-05-30, batendo com o
 * portal). Então o desenho aqui é diferente do TikTok: lá a fonte era o extrato, aqui é o
 * pedido.
 *
 * Multi-empresa por parâmetro, como as outras libs.
 */

const CANCELADO = /cancel/i;

/* o que fazer com cada classe — escrito aqui porque é a regra de negócio que o dono
   levantou conferindo 4 casos no portal, um por um */
const ACOES = {
  nf_sem_saida: 'produto NUNCA saiu do CD — cancelar a NF (se no prazo) ou devolucao SEM entrada de estoque, so pra recuperar o imposto',
  saiu_e_nao_entregou: 'saiu e nao foi entregue (insucesso/recusa) — o produto deve ter voltado: conferir no recebimento e emitir devolucao COM entrada de estoque',
  entregue_e_cancelado: 'foi ENTREGUE ao cliente e depois cancelado — conferir se houve devolucao fisica antes de dar baixa',
  entregue_apos_estorno: 'ENTREGUE DEPOIS DO ESTORNO: o cliente ficou com a mercadoria e com o dinheiro — prejuizo integral, vale contestar com o Magalu',
  estornado_apos_envio: 'devolucao registrada apos o envio — fluxo normal de NF de devolucao COM entrada de estoque',
  nao_pago: 'nunca virou faturamento — nada a fazer',
  pago_cancelado_sem_nf: 'sem NF — nada a recuperar',
  pedido_teste: 'pedido de homologacao do Magalu — ignorar',
};

const cent = (v) => {
  /* o Magalu manda valores em centavos com o divisor no próprio objeto */
  if (!v || typeof v !== 'object') return 0;
  const n = Number(v.normalizer) || 100;
  return Math.round((Number(v.total) || 0) / n * 100) / 100;
};

/** Resume um pedido do Magalu do ponto de vista de cancelamento/devolução. */
function resumirPedido(p) {
  if (!p || typeof p !== 'object') return null;
  const entregas = Array.isArray(p.deliveries) ? p.deliveries : [];
  const devolucoes = [];
  let algumaEntregaCancelada = false;
  for (const d of entregas) {
    if (CANCELADO.test(String(d && d.status || ''))) algumaEntregaCancelada = true;
    const rs = Array.isArray(d && d.returns) ? d.returns : [];
    for (const r of rs) {
      devolucoes.push({
        external_id: r && r.external_id ? String(r.external_id) : null,
        /* a data do return é quando o estorno foi autorizado — é ela que manda no período */
        em: r && r.date ? String(r.date) : null,
      });
    }
  }
  const cancelado = CANCELADO.test(String(p.status || '')) || algumaEntregaCancelada;
  if (!cancelado && !devolucoes.length) return null;   // pedido normal: não interessa aqui

  /* 30/08 — CLASSIFICAÇÃO (o dono separou os casos, e são bem diferentes):
       1. cancelado SEM pagamento aprovado e SEM NF → cliente desistiu / pagamento não passou.
          Nunca entrou no faturamento. NÃO é prejuízo e não pode ser descontado — era isso que
          inflava o número da AMB (73 pedidos, muitos de R$ 5,90).
       2. PAGO e cancelado antes de postar → entrou no histórico se virou NF; precisa sair.
       3. PAGO, POSTADO e estornado/devolvido → o pior: sai do faturamento E pode ter custado
          produto e frete. É o caso do 1535770109894199 da Girassol.
     O que separa: nota fiscal emitida e pagamento aprovado (o pedido traz os dois). */
  const notas = [];
  for (const d of entregas) for (const nf of (Array.isArray(d && d.invoices) ? d.invoices : [])) {
    if (nf && (nf.key || nf.issued_at)) notas.push({ chave: nf.key || null, em: nf.issued_at || null, status: (nf.status && nf.status.id) || null });
  }
  const pagamentos = Array.isArray(p.payments) ? p.payments : [];
  const pagoAprovado = !!p.approved_at || pagamentos.some(pg => /approv|paid|captur|authoriz/i.test(String(pg && (pg.status || pg.state) || '')));
  const temNF = notas.length > 0;

  /* 30/08 — PEDIDO DE TESTE DO MAGALU: apareceu no topo da lista da AMB com cliente
     'Treinamento Luiza Labs' e destinatário 'Pedido teste ambtotal'. É homologação da
     plataforma, não venda — não pode entrar em conta nenhuma. */
  const nomes = [p.customer && p.customer.name, ...entregas.map(d => d && d.shipping && d.shipping.recipient && d.shipping.recipient.name)];
  const ehTeste = nomes.filter(Boolean).some(n => /treinamento|luiza\s*labs|pedido\s*teste|teste\s+/i.test(String(n)));

  /* 30/08 — AS DATAS DO SHIPPING CLASSIFICAM SOZINHAS (achado da sonda, com os 2 casos
     extremos da GOOD). Eu procurava eventos com TEXTO e eles não existem: a API manda só
     event_external_id numérico, e /events e /tracking dao 404. Mas o shipping traz:
       shipped_at    -> saiu do CD
       delivered_at  -> chegou ao cliente (o campo NEM EXISTE quando nao foi entregue)
       cancelled_at  -> quando a entrega foi cancelada
     No 1537370110606484 (nunca saiu) havia cancelled_at e nenhum delivered_at.
     No 1545570114294804 havia delivered_at 14/07 12:10 contra cancelled_at 14/07 00:02:
     ENTREGUE DEPOIS DO ESTORNO — cliente ficou com a mercadoria E com o dinheiro. */
  /* Codex #303: pedido DIVIDIDO tem várias entregas e eu olhava só a primeira — se a
     primeira nunca saiu e a segunda foi entregue, o pedido apareceria como 'nunca saiu' e
     alguém cancelaria a NF de um produto que está com o cliente. Agora vale o conjunto:
     saiu se QUALQUER entrega saiu; entregue se QUALQUER foi entregue (a mais recente). */
  const ships = entregas.map(d => d && d.shipping).filter(Boolean);
  const maisRecente = (campo) => ships.map(s => s && s[campo]).filter(Boolean).sort().pop() || null;
  const enviadoEm = maisRecente('shipped_at');
  const entregueEm = maisRecente('delivered_at');
  const canceladoEm = maisRecente('cancelled_at');
  const entregasParciais = ships.length > 1 && ships.some(s => s && s.delivered_at) && ships.some(s => s && !s.delivered_at);
  /* Codex #303 r2: eu caía no cancelled_at quando não havia devolução registrada, mas
     cancelamento de ENTREGA não é estorno de pagamento. Comparar a entrega com ele podia
     acusar 'entregue após estorno' (prejuízo integral, contestar com o Magalu) num caso em
     que nenhum estorno aconteceu — acusação séria feita com o dado errado. Só a data da
     devolução registrada vale como estorno. */
  const estornoEm = devolucoes.map(d => d.em).filter(Boolean).sort()[0] || null;
  /* Codex #304 r2: quando NÃO há devolução registrada, o cancelled_at é o melhor marco
     temporal que existe — usá-lo pra ORDENAR (entrega veio antes ou depois?) é diferente de
     usá-lo pra ACUSAR estorno. Aqui só ordena, e o resultado vai pra entregue_e_cancelado,
     que manda conferir, nunca pra a classe que manda contestar. */
  const marcoCancelamento = estornoEm || canceladoEm || null;

  let classe, conta_no_faturamento;
  if (ehTeste) { classe = 'pedido_teste'; conta_no_faturamento = false; }
  else if (!pagoAprovado && !temNF) { classe = 'nao_pago'; conta_no_faturamento = false; }
  /* Codex #304 r2: esta condição vinha ANTES do bloco das datas, então qualquer pedido com
     returns[] virava 'estornado_apos_envio' e a classe 'entregue_apos_estorno' ficou
     INALCANÇÁVEL depois que passei a exigir devolução registrada como estorno (#303 r2).
     Resultado: o caso mais grave — cliente que recebeu DEPOIS do estorno e ficou com produto
     e dinheiro, como o 1545570114294804 — deixaria de ser detectado. A entrega posterior ao
     estorno é testada primeiro. E sem NF não houve faturamento: não conta. */
  else if (devolucoes.length && entregueEm && estornoEm && Date.parse(entregueEm) > Date.parse(estornoEm)) {
    classe = 'entregue_apos_estorno'; conta_no_faturamento = temNF;
  }
  else if (devolucoes.length) { classe = 'estornado_apos_envio'; conta_no_faturamento = temNF; }
  else if (temNF) {
    /* 30/08: refina com o que as DATAS dizem — cada caso tem tratamento diferente, e tratar
       todos igual gera erro de estoque (dar entrada de produto que nunca saiu) ou perda de
       imposto (deixar de cancelar NF que dava). */
    conta_no_faturamento = true;
    /* sem estorno REGISTRADO não se declara 'entregue após estorno'; fica em
       entregue_e_cancelado, que manda conferir em vez de acusar. */
    if (entregueEm && estornoEm && Date.parse(entregueEm) > Date.parse(estornoEm)) classe = 'entregue_apos_estorno';
    else if (entregueEm && marcoCancelamento && Date.parse(entregueEm) > Date.parse(marcoCancelamento)) classe = 'entregue_e_cancelado';   /* entregue depois do cancelamento, mas sem estorno registrado: conferir */
    else if (entregueEm) classe = 'entregue_e_cancelado';
    else if (enviadoEm) classe = 'saiu_e_nao_entregou';
    else classe = 'nf_sem_saida';
  }
  else { classe = 'pago_cancelado_sem_nf'; conta_no_faturamento = false; }

  /* 30/08: guarda canal e seller — apareceram pedidos que o token alcança mas não são da
     empresa (R$ 5,90 e R$ 10,00 num catálogo sem nada abaixo de R$ 100). Sem esses campos
     não dava nem pra perceber. */
  /* 30/08: o seller vem como OBJETO {id, name} — eu lia como string e dava null em todos.
     Guardo o NOME, que é o que dá pra conferir contra a empresa ('ambtotal'). */
  const sellerObj = entregas.map(d => d && d.seller).filter(Boolean)[0] || null;
  const sellerEntrega = sellerObj ? (sellerObj.name || sellerObj.id || null) : null;
  return {
    classe, conta_no_faturamento, acao_sugerida: ACOES[classe] || null,
    pago: pagoAprovado, tem_nf: temNF, notas,
    /* as datas que decidiram a classe — pra quem confere não precisar abrir o portal */
    enviado_em: enviadoEm, entregue_em: entregueEm, cancelado_em: canceladoEm,
    entregas_parciais: entregasParciais,   /* Codex #303: split com parte entregue e parte não */
    canal: p.channel || null, canal_origem: p.source_channel || null, seller: sellerEntrega ? String(sellerEntrega) : null,
    code: String(p.code || p.id || ''),
    status: String(p.status || ''),
    cancelado,
    tem_devolucao: devolucoes.length > 0,
    devolucoes,
    /* a data que vale pro período é a do estorno; sem ela, a atualização do pedido */
    data_evento: devolucoes.map(d => d.em).filter(Boolean).sort().pop() || p.updated_at || null,
    comprado_em: p.purchased_at || p.created_at || null,
    valor_pedido: cent(p.amounts),
    comissao: cent(p.amounts && p.amounts.commission),
    frete: cent(p.amounts && p.amounts.freight),
  };
}

/** Percorre uma lista de pedidos crus e devolve só os que têm cancelamento ou devolução. */
function resumirLista(pedidos) {
  const out = [];
  for (const p of (Array.isArray(pedidos) ? pedidos : [])) {
    const r = resumirPedido(p);
    if (r) out.push(r);
  }
  out.sort((a, b) => String(b.data_evento || '').localeCompare(String(a.data_evento || '')));
  return out;
}

/** Total do período, pela DATA DO EVENTO (estorno), não pela data da compra. */
function totalNoPeriodo(resumidos, deISO, ateISO) {
  const de = deISO || '0000', ate = ateISO || '9999';
  const dentro = (resumidos || []).filter(r => {
    const d = String(r.data_evento || '').slice(0, 10);
    return d && d >= de && d <= ate;
  });
  const cancelados = dentro.filter(r => r.cancelado);
  /* 30/08: só entra na conta o que CHEGOU a contar como venda. Desistência antes do
     pagamento não é prejuízo — descontá-la seria inventar perda. */
  /* acerto #304: NF já CANCELADA não tem imposto a recuperar nem venda a tratar — some da
     lista de trabalho, mas fica contada à parte pra não parecer que sumiu dado. */
    const jaCancelada = (r) => Array.isArray(r.notas) && r.notas.length > 0 && r.notas.every(n => /cancel/i.test(String(n && n.status || '')));
  const nfsJaCanceladas = dentro.filter(r => r.conta_no_faturamento && jaCancelada(r));
  const contam = dentro.filter(r => r.conta_no_faturamento && !jaCancelada(r));
  const naoPagos = dentro.filter(r => r.classe === 'nao_pago');
  const testes = dentro.filter(r => r.classe === 'pedido_teste');
  const porClasse = {};
  for (const r of dentro) porClasse[r.classe] = (porClasse[r.classe] || 0) + 1;
  const soma = (arr, campo) => Math.round(arr.reduce((s, r) => s + (r[campo] || 0), 0) * 100) / 100;
  return {
    pedidos_no_periodo: dentro.length,
    cancelados: cancelados.length,
    com_devolucao: dentro.filter(r => r.tem_devolucao).length,
    por_classe: porClasse,
    /* o número que vale pro dashboard */
    a_descontar: contam.length,
    valor_a_descontar: soma(contam, 'valor_pedido'),
    comissao_a_descontar: soma(contam, 'comissao'),
    /* ruído, mostrado à parte pra ninguém achar que sumiu dado */
    nfs_ja_canceladas: nfsJaCanceladas.length,
    valor_nfs_ja_canceladas: soma(nfsJaCanceladas, 'valor_pedido'),
    pedidos_teste_ignorados: testes.length,
    nao_pagos_ignorados: naoPagos.length,
    valor_nao_pago_ignorado: soma(naoPagos, 'valor_pedido'),
    linhas: dentro.slice(0, 200),
  };
}

module.exports = { resumirPedido, resumirLista, totalNoPeriodo };
