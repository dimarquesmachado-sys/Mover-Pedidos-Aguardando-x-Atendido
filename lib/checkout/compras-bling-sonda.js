'use strict';
/* ─────────────────────────────────────────────────────────────────────────────
   COMPRAS — A SONDA DO PEDIDO DE COMPRA NO BLING (24/11/2026).

   O Plano de Compra vai ler e criar Pedidos de Compra no Bling (o "a caminho", com a data prevista; e lançar o pedido
   do fornecedor a partir da planilha). O app de cada empresa no Bling é cadastrado com uma lista de permissões, e a de
   Pedidos de Compra pode não estar marcada. Esta peça pergunta UMA vez (uma página, um registro) e diz o que achou:

   sondarCompras(blingGet) → { permissao: 'sim' | 'nao' | 'nao_sei', status, tipo_erro, motivo }
       · 'sim'     — o Bling respondeu a lista (200 com `data` em lista);
       · 'nao'     — o Bling RECUSOU por permissão (403): é marcar a permissão no app da empresa;
       · 'nao_sei' — qualquer outra coisa: token (401), limite (429), rede, erro do Bling, resposta torta. "Não sei" não
                     vira "não tem": a sonda é repetida depois.
   Nunca devolve dado de pedido nem de fornecedor — só o veredito, o código HTTP e o TIPO do erro do Bling (um código
   curto, sem texto livre).
   ───────────────────────────────────────────────────────────────────────────── */

const CAMINHO = '/pedidos/compras?pagina=1&limite=1';

function tipoDoErro(data) {
  const t = data && data.error && data.error.type;
  return typeof t === 'string' && /^[A-Za-z0-9_.-]{1,60}$/.test(t) ? t : null;
}

async function sondarCompras(blingGet) {
  if (typeof blingGet !== 'function') return { permissao: 'nao_sei', status: null, tipo_erro: null, motivo: 'sem acesso ao Bling nesta empresa' };
  let r;
  try { r = await blingGet(CAMINHO); } catch (e) { r = null; }
  if (!r || typeof r !== 'object') return { permissao: 'nao_sei', status: null, tipo_erro: null, motivo: 'o Bling não respondeu' };
  const status = Number.isFinite(Number(r.status)) ? Number(r.status) : null;
  const tipo = tipoDoErro(r.data);
  if (r.ok && status === 200 && r.data && Array.isArray(r.data.data)) return { permissao: 'sim', status, tipo_erro: null, motivo: 'o Bling respondeu a lista de pedidos de compra' };
  if (status === 403) return { permissao: 'nao', status, tipo_erro: tipo, motivo: 'o Bling recusou: falta marcar a permissão de Pedidos de Compra no app desta empresa' };
  const motivo = status === 401 ? 'token do Bling recusado — tente de novo depois'
    : status === 429 ? (r.rede && !r.limite ? 'a rede caiu — tente de novo' : 'limite do Bling — tente de novo daqui a pouco')
    : r.ok ? 'resposta do Bling num formato que não reconheço'
    : 'o Bling respondeu ' + (status == null ? 'sem código' : status) + ' — tente de novo';
  return { permissao: 'nao_sei', status, tipo_erro: tipo, motivo };
}

module.exports = { sondarCompras, CAMINHO };
