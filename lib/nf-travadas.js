'use strict';

/**
 * lib/nf-travadas.js — NFs que o marketplace recusa e SÓ MÃO HUMANA resolve (04/09).
 *
 * O caso que motivou: o Bling importa o CEP errado de uma venda do ML, a NF sai com esse
 * CEP, e o ML recusa o envio com "NFe receiver zipcode must be the same as the sale". O
 * conserto é manual e trabalhoso — o dono precisa cancelar a NF, emitir outra e subir o XML
 * à mão no ML.
 *
 * A rotina F3 não sabia disso e retransmitia a cada 10 minutos, para sempre: nos logs de
 * 04/09 a mesma NF 126595 aparece de 04:22 a 08:31, dezenas de tentativas idênticas. Nunca
 * ia passar, e ninguém ficava sabendo — o erro só existia no log.
 *
 * Esta lista guarda essas NFs pra: (1) a F3 parar de tentar, e (2) o checkout mostrar quais
 * precisam de intervenção. Multi-empresa: o arquivo fica no cache de cada uma.
 */

const fs = require('fs');
const path = require('path');

/* Erros que NUNCA passam sozinhos — dado o mesmo pedido e a mesma NF, tentar de novo dá o
   mesmo resultado. Só entram aqui os que exigem AÇÃO no Bling/marketplace. */
const PERMANENTES = [
  { re: /wrong_receiver_zipcode|zipcode must be the same/i, motivo: 'CEP da NF diferente do CEP da venda no ML',
    comoResolver: 'o Bling importou o CEP errado do pedido. Cancele a NF, corrija o endereço, emita outra e suba o XML no ML.' },
  { re: /invalid_cnpj|cnpj.*inv[áa]lid/i, motivo: 'CNPJ/CPF do destinatário inválido',
    comoResolver: 'corrija o documento do cliente no Bling, cancele e reemita a NF.' },
  { re: /invalid_document|documento.*inv[áa]lid/i, motivo: 'documento do destinatário inválido',
    comoResolver: 'corrija o documento no Bling, cancele e reemita a NF.' },
];

function classificar(msg) {
  const t = String(msg || '');
  for (const p of PERMANENTES) if (p.re.test(t)) return p;
  return null;
}

function arquivo(cacheDir) { return path.join(cacheDir, '_nf_travadas.json'); }

function ler(cacheDir) {
  try { return JSON.parse(fs.readFileSync(arquivo(cacheDir), 'utf8')); } catch (e) { return {}; }
}

/** Registra uma NF travada. Devolve true se é NOVA (pra avisar só uma vez). */
function registrar(cacheDir, dados) {
  const p = classificar(dados.erro);
  if (!p) return { permanente: false };
  const todas = ler(cacheDir);
  const chave = String(dados.nfeId || dados.numero);
  const nova = !todas[chave];
  todas[chave] = {
    nfe_id: dados.nfeId || null, numero: dados.numero || null,
    pedido_ml: dados.pedidoML || null, shipment: dados.shipment || null,
    motivo: p.motivo, como_resolver: p.comoResolver,
    erro_do_ml: String(dados.erro || '').slice(0, 300),
    desde: (todas[chave] && todas[chave].desde) || new Date().toISOString(),
    tentativas: ((todas[chave] && todas[chave].tentativas) || 0) + 1,
    ultima: new Date().toISOString(),
  };
  try { fs.mkdirSync(cacheDir, { recursive: true }); fs.writeFileSync(arquivo(cacheDir), JSON.stringify(todas, null, 2)); } catch (e) {}
  return { permanente: true, nova, registro: todas[chave] };
}

/** Já está travada? A F3 usa isso pra nem tentar. */
function estaTravada(cacheDir, nfeId) {
  return !!ler(cacheDir)[String(nfeId)];
}

/** Some da lista — o dono resolveu (cancelou e reemitiu). */
function resolver(cacheDir, nfeId) {
  const todas = ler(cacheDir);
  if (!todas[String(nfeId)]) return false;
  delete todas[String(nfeId)];
  try { fs.writeFileSync(arquivo(cacheDir), JSON.stringify(todas, null, 2)); } catch (e) {}
  return true;
}

function lista(cacheDir) {
  return Object.values(ler(cacheDir)).sort((a, b) => String(b.ultima).localeCompare(String(a.ultima)));
}

module.exports = { classificar, registrar, estaTravada, resolver, lista, PERMANENTES };
