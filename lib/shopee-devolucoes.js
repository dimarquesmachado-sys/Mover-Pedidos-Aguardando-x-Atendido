'use strict';

/**
 * lib/shopee-devolucoes.js — devoluções e carteira da Shopee, em UM lugar (31/08).
 *
 * Dívida nº 2 do docs/paridade-empresas.md, paga do mesmo jeito que a nº 1 (o escrow):
 * as duas funções viviam em cópia na Girassol e na AMB e estavam IDÊNTICAS byte a byte —
 * conferido antes de mexer. Iguais hoje porque foram consertadas à mão nas duas, uma de
 * cada vez; era questão de tempo até divergirem, como já aconteceu com o escrow (um campo
 * existia numa e não na outra, e o cálculo divergia em dinheiro sem ninguém ver).
 *
 * Extração, não reescrita: o corpo é o mesmo, com as duas únicas dependências de escopo
 * (readJson/writeJson) recebidas por ctx. A GOOD não tem Shopee, então não entra.
 *
 * Codex #310: eu tinha contado MAL as dependências — busquei por uma lista de nomes que eu
 * mesmo escrevi e deixei quatro de fora (ARQ_DEV, ARQ_CAR, _num, _dorme). A coleta quebraria
 * com ReferenceError na PRIMEIRA execução, em produção. Refiz o levantamento varrendo os
 * identificadores do corpo em vez de procurar o que eu esperava achar. Os utilitários puros
 * (_num, _dorme) passam a morar aqui; os caminhos de arquivo dependem do CACHE_DIR de cada
 * empresa e vêm por ctx.
 */

const _num = v => { const n = Number(v); return isFinite(n) ? n : 0; };
const _dorme = ms => new Promise(r => setTimeout(r, ms));

async function coletarDevolucoes(ctx, dias, pedirAoSync) {
  const { readJson, writeJson, ARQ_DEV } = ctx;
  const total = Math.min(180, Math.max(1, Number(dias) || 45));
  const agora = Math.floor(Date.now() / 1000);
  const arq = readJson(ARQ_DEV(), { devolucoes: {}, atualizado: null });
  arq.devolucoes = arq.devolucoes || {};
  let novas = 0, vistas = 0, janelas = 0, erro = null;
  for (let fim = agora; fim > agora - total * 86400; fim -= 15 * 86400) {
    const ini = Math.max(agora - total * 86400, fim - 15 * 86400 + 60);
    janelas++;
    for (let pag = 0; pag < 20; pag++) {
      const r = await pedirAoSync('devolucoes', { de: String(ini), ate: String(fim), page: String(pag), size: '50' });
      const resp = r && r.dados && r.dados.resposta && r.dados.resposta.response;
      if (!resp) { erro = erro || ('janela ' + ini + '-' + fim + ' pagina ' + pag + ': sem resposta'); break; }
      const lista = resp['return'] || [];
      for (const d of lista) {
        if (!d || !d.return_sn) continue;
        vistas++;
        if (!arq.devolucoes[d.return_sn]) novas++;
        arq.devolucoes[d.return_sn] = {
          return_sn: d.return_sn, order_sn: d.order_sn || null,
          refund_amount: _num(d.refund_amount), antes_do_desconto: _num(d.amount_before_discount),
          status: d.status || null, motivo: d.reason || null, motivo_texto: d.text_reason || null,
          criado_em: d.create_time || null, atualizado_em: d.update_time || null,
          precisa_logistica: !!d.needs_logistics, tipo: d.return_refund_type || null,
          // 14/08 — campos novos anunciados pela Shopee (vigentes a partir de 17/08/2026):
          // `is_partial_quantity_return` = o comprador devolveu só PARTE das unidades (comprou 3,
          // devolveu 1) · `is_refund_amount_adjusted` = o reembolso saiu MENOR que o máximo
          // reembolsável. Sem isso, toda devolução parecia total — e o card de devoluções por
          // SKU superestimava a quantidade que realmente voltou.
          devolucao_parcial: d.is_partial_quantity_return === true,
          reembolso_ajustado: d.is_refund_amount_adjusted === true,
          itens: (d.item || []).map(it => ({
            sku: it.variation_sku || it.item_sku || null, nome: it.name || null,
            qtd: _num(it.amount), preco: _num(it.item_price), devolvido: _num(it.refund_amount)
          }))
        };
      }
      if (!resp.more) break;
      await _dorme(300);
    }
    await _dorme(300);
  }
  arq.atualizado = new Date().toISOString();
  writeJson(ARQ_DEV(), arq);
  return { janelas, vistas, novas, guardadas: Object.keys(arq.devolucoes).length, erro };
}

async function coletarCarteira(ctx, dias, pedirAoSync) {
  const { readJson, writeJson, ARQ_CAR } = ctx;
  const total = Math.min(180, Math.max(1, Number(dias) || 30));
  const agora = Math.floor(Date.now() / 1000);
  const arq = readJson(ARQ_CAR(), { transacoes: {}, atualizado: null });
  arq.transacoes = arq.transacoes || {};
  let novas = 0, vistas = 0, janelas = 0, erro = null;
  for (let fim = agora; fim > agora - total * 86400; fim -= 15 * 86400) {
    const ini = Math.max(agora - total * 86400, fim - 15 * 86400 + 60);
    janelas++;
    for (let pag = 1; pag <= 40; pag++) {
      const r = await pedirAoSync('carteira', { de: String(ini), ate: String(fim), page: String(pag), size: '100' });
      const resp = r && r.dados && r.dados.resposta && r.dados.resposta.response;
      const lista = (resp && resp.transaction_list) || [];
      if (!resp) { erro = erro || ('janela ' + ini + '-' + fim + ' pagina ' + pag + ': sem resposta'); break; }
      for (const x of lista) {
        if (!x || x.transaction_id == null) continue;
        vistas++;
        const id = String(x.transaction_id);
        if (!arq.transacoes[id]) novas++;
        arq.transacoes[id] = {
          id, tipo: x.transaction_type || null, valor: _num(x.amount),
          entra_ou_sai: x.money_flow || null, quando: x.create_time || null,
          order_sn: x.order_sn || null, refund_sn: x.refund_sn || null,
          descricao: x.description || null, aba: x.transaction_tab_type || null,
          taxa: _num(x.transaction_fee), saldo_depois: _num(x.current_balance), status: x.status || null
        };
      }
      if (!lista.length) break;
      await _dorme(300);
    }
    await _dorme(300);
  }
  arq.atualizado = new Date().toISOString();
  // 14/08 (Codex): `atualizado` era gravado mesmo com falha, e a conciliação passou a
  // tratá-lo como prova de cobertura. `ok_em` só avança quando a coleta terminou SEM erro.
  if (!erro) arq.ok_em = arq.atualizado;
  writeJson(ARQ_CAR(), arq);
  return { janelas, vistas, novas, guardadas: Object.keys(arq.transacoes).length, erro };
}

module.exports = { coletarDevolucoes, coletarCarteira };
