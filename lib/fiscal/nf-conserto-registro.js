'use strict';
/* ─────────────────────────────────────────────────────────────────────────────
   O REGISTRO DO CONSERTO DA NF (19/11/2026) — o que impede a MESMA nota de ser clonada duas vezes.

   Criar nota fiscal não é operação que se repete "pra garantir": cada POST que o Bling aceita vira uma nota com número.
   Então, por nota recusada (o id dela no Bling), fica anotado em disco, no cache da empresa, em que pé o conserto está:

     · `criando`  — o registro foi aberto e o pedido de criação saiu. Se aparecer assim numa chamada nova, a anterior não
                    terminou (o servidor reiniciou no meio, ou não deu pra gravar o fim) — NÃO SE SABE se a nota existe;
     · `incerta`  — o Bling não respondeu de forma conclusiva (rede, 5xx) — também não se sabe;
     · `criada`   — a nota nova existe: guarda o id e o número dela.

   "Não sei" nunca vira "não criou": só uma recusa CONCLUSIVA do Bling apaga o registro e deixa tentar de novo. Do estado
   de dúvida só se sai por decisão de quem olhou o Bling (`soltar`). Nota `criada` não se solta.

   Arquivo ilegível NÃO é arquivo vazio: `ler` lança, e quem chama para — sem registro não há como garantir que a nota não
   foi clonada antes.
   ───────────────────────────────────────────────────────────────────────────── */
const fs = require('fs');
const path = require('path');

function arquivo(dir) { return path.join(dir, '_nf_conserto.json'); }

function ler(dir) {
  let bruto;
  try { bruto = fs.readFileSync(arquivo(dir), 'utf8'); }
  catch (e) { if (e && e.code === 'ENOENT') return {}; throw e; }
  const o = JSON.parse(bruto);
  if (!o || typeof o !== 'object' || Array.isArray(o)) throw new Error('registro do conserto com formato estranho');
  return o;
}
function gravar(dir, todas) { require('../escrita-atomica').gravarAtomico(arquivo(dir), JSON.stringify(todas, null, 2)); }

/** o registro de uma nota (ou null). Lança se o arquivo existe e não dá pra ler. */
function de(dir, nfId) { return ler(dir)[String(nfId)] || null; }

/** abre o conserto de uma nota. Devolve false (sem gravar) se já havia registro — quem chegou primeiro fica com ele. */
function abrir(dir, nfId, dados) {
  const todas = ler(dir);
  const k = String(nfId);
  if (todas[k]) return false;
  todas[k] = Object.assign({}, dados || {}, { estado: 'criando', desde: new Date().toISOString() });
  gravar(dir, todas);
  return true;
}
/** a nota nova existe */
function fechar(dir, nfId, nova) {
  const todas = ler(dir);
  const k = String(nfId);
  todas[k] = Object.assign({}, todas[k] || {}, { estado: 'criada', nova_id: String(nova.id), nova_numero: nova.numero != null ? String(nova.numero) : null, criada_em: new Date().toISOString() });
  gravar(dir, todas);
}
/** o Bling não respondeu de forma conclusiva */
function duvida(dir, nfId, motivo) {
  const todas = ler(dir);
  const k = String(nfId);
  todas[k] = Object.assign({}, todas[k] || {}, { estado: 'incerta', motivo: String(motivo || '').slice(0, 200), em: new Date().toISOString() });
  gravar(dir, todas);
}
/** anota no registro de uma nota CRIADA o andamento das etapas seguintes (pedido à SEFAZ, XML no ML). Devolve false se
    não há nota criada pra anotar. */
function anotar(dir, nfId, campos) {
  const todas = ler(dir);
  const k = String(nfId);
  if (!todas[k] || todas[k].estado !== 'criada') return false;
  todas[k] = Object.assign({}, todas[k], campos || {}, { estado: 'criada', nova_id: todas[k].nova_id, nova_numero: todas[k].nova_numero });
  gravar(dir, todas);
  return true;
}
/** tira o registro — NUNCA o de nota criada. Devolve true se tirou. */
function soltar(dir, nfId) {
  const todas = ler(dir);
  const k = String(nfId);
  if (!todas[k] || todas[k].estado === 'criada') return false;
  delete todas[k];
  gravar(dir, todas);
  return true;
}

module.exports = { arquivo, ler, de, abrir, fechar, duvida, soltar, anotar };
