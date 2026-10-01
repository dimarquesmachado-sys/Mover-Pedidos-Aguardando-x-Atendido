'use strict';
/* ============================================================
 * lib/indice-ean-disco.js
 * ------------------------------------------------------------
 * O INDICE EAN -> PRODUTO (do estoque-girassol e do fragil) SOBREVIVE AO
 * REINICIO.
 *
 * ⚠️ O PROBLEMA (medido em 01/10, na conta Bling da Girassol): 9 segundos
 * depois de CADA boot do Mover-Pedidos, o estoque-girassol varre as ~90
 * paginas de produtos e depois busca o DETALHE de cada um dos ~9.000
 * produtos, UM POR SEGUNDO, so pra pegar o EAN — duas horas e meia a
 * 1 req/s na conta. O indice ficava so em memoria: todo deploy ou reinicio
 * recomecava do zero. Somado a fila do Devolucoes (3/s), passava do limite
 * do Bling e o bipe da Girassol tomava 429 por duas horas e meia ("deploy
 * no Mover-Pedidos = bipe lento"). O fragil faz o mesmo na GOOD.
 *
 * 📌 AGORA: o indice (ean -> id) e a lista de ids JA VERIFICADOS (com ou
 * sem EAN — produto sem EAN tambem conta, senao seria buscado toda vez)
 * vao pra um JSON no mesmo disco persistente dos tokens
 * (/data/<app>/indice-ean.json). No boot, carrega do disco e so busca os
 * produtos NOVOS. Depois da primeira carga completa, um reinicio custa a
 * listagem (90 paginas, ~30s) e os novos — nao 9.000 chamadas.
 *
 * Uma lib, as duas empresas: o caminho do arquivo e parametro.
 * ============================================================ */

const fs = require('fs');
const path = require('path');

/**
 * Le o indice do disco. Nunca lanca — sem arquivo, corrompido ou disco
 * ausente devolve vazio (e o boot faz a carga inteira, como antes).
 * @returns {{ eans: Map<string,string>, verificados: Map<string,number>, produtos: Map<string,object>, salvo_em: string|null, erro: string|null }}
 */
function carregar(arquivo) {
  const vazio = { eans: new Map(), verificados: new Map(), produtos: new Map(), salvo_em: null, erro: null };
  try {
    if (!arquivo || !fs.existsSync(arquivo)) return vazio;
    const j = JSON.parse(fs.readFileSync(arquivo, 'utf8'));
    const eans = new Map(Object.entries(j.eans || {}).map(([e, id]) => [String(e), String(id)]));
    // Codex #559: verificados e id -> quando (ms). Arquivo antigo (lista) vale
    // como "verificado agora"; o vencimento espalhado reconfere com o tempo.
    const agora = Date.now();
    const verificados = new Map();
    if (Array.isArray(j.verificados)) for (const id of j.verificados) verificados.set(String(id), agora);
    else for (const [id, ts] of Object.entries(j.verificados || {})) verificados.set(String(id), Number(ts) || agora);
    // todo id que tem EAN tambem e "verificado" (arquivo antigo pode nao ter a lista)
    for (const id of eans.values()) if (!verificados.has(id)) verificados.set(id, agora);
    // Codex #559: o fragil exibe nome/imagem/EAN varrendo o cache de detalhes —
    // sem repovoar, a busca dele ficava vazia depois do reinicio. Quem precisa
    // persiste um produto ENXUTO (id, codigo, sku, nome, gtin, imagem); quem
    // nao precisa (estoque-girassol: estoque e localizacao mudam, busca sob
    // demanda) nao passa nada.
    const produtos = new Map(Object.entries(j.produtos || {}).map(([id, pe]) => [String(id), pe]));
    return { eans, verificados, produtos, salvo_em: j.salvo_em || null, erro: null };
  } catch (e) {
    return { ...vazio, erro: e.message };
  }
}

/**
 * Grava o indice (e, opcionalmente, produtos enxutos por id). Atomico
 * (tmp + rename) pra um reinicio no meio nao deixar JSON pela metade. Nunca lanca.
 * @returns {{ ok: boolean, erro?: string, eans: number, verificados: number }}
 */
function salvar(arquivo, indiceEan, verificados, produtosEnxutos) {
  try {
    if (!arquivo) return { ok: false, erro: 'sem caminho', eans: 0, verificados: 0 };
    const eans = {};
    for (const [e, id] of indiceEan) eans[String(e)] = String(id);
    const lista = {};
    for (const [id, ts] of (verificados instanceof Map ? verificados : [...verificados].map((id) => [id, Date.now()]))) lista[String(id)] = Number(ts) || Date.now();
    const produtos = {};
    if (produtosEnxutos) for (const [id, pe] of produtosEnxutos) produtos[String(id)] = pe;
    fs.mkdirSync(path.dirname(arquivo), { recursive: true });
    const tmp = arquivo + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({ salvo_em: new Date().toISOString(), eans, verificados: lista, produtos }));
    fs.renameSync(tmp, arquivo);
    return { ok: true, eans: indiceEan.size, verificados: Object.keys(lista).length };
  } catch (e) {
    return { ok: false, erro: e.message, eans: indiceEan ? indiceEan.size : 0, verificados: verificados ? verificados.size : 0 };
  }
}

/** O produto ENXUTO que o fragil exibe (formatarProduto le id/nome/codigo/sku; getEans le gtin; extractImage acha a URL). */
function enxugar(p, imagem, ean) {
  return { id: p.id, codigo: p.codigo || '', sku: p.sku || '', nome: p.nome || '', gtin: ean || '', imagem: imagem || '' };
}

/**
 * Codex #559: um produto renomeado, com EAN trocado ou apagado nunca seria
 * revisto se "verificado" fosse pra sempre. Cada id vence entre 20 e 40 dias
 * depois da verificacao — ESPALHADO pelo id (determinístico), senao no dia 30
 * os 9.000 venceriam juntos e viraria a carga completa de novo.
 */
const DIA = 864e5;
function venceu(id, ts, agora = Date.now()) {
  if (!ts) return true;
  let h = 0; for (const ch of String(id)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  const validade = (20 + (h % 21)) * DIA;   // 20..40 dias
  return (agora - Number(ts)) > validade;
}

/**
 * Codex #559: produto APAGADO some da listagem — nunca entra nos "pendentes" montados a
 * partir dela, entao o disco o carregaria pra sempre. Depois de uma listagem COMPLETA,
 * tudo que o disco guarda e a listagem nao tem e podado (EAN, verificado, enxuto).
 * Listagem incompleta (erro no meio) NAO poda: ausencia ali nao prova nada.
 * @returns {number} quantos ids foram podados
 */
function podar(idsListados, indiceEan, verificados, produtos) {
  if (!idsListados || !idsListados.size) return 0;
  const mortos = new Set();
  for (const id of verificados.keys()) if (!idsListados.has(String(id))) mortos.add(String(id));
  for (const id of indiceEan.values()) if (!idsListados.has(String(id))) mortos.add(String(id));
  if (!mortos.size) return 0;
  for (const [e, id] of [...indiceEan]) if (mortos.has(String(id))) indiceEan.delete(e);
  for (const id of mortos) { verificados.delete(id); if (produtos) produtos.delete(id); }
  return mortos.size;
}

/**
 * Codex #559: o vencimento espalhado por id so espalha se o servico reiniciar
 * toda semana; no 1o boot depois de um mes metade venceria junto (~75 min a
 * 1 req/s de novo). Produto NUNCA verificado entra sempre (sem ele o indice
 * fica furado); as REVISOES de vencidos tem teto por boot, as mais antigas
 * primeiro — o resto fica pro proximo boot.
 */
const MAX_REVISOES_POR_BOOT = 300;
function selecionar(ids, verificados, max = MAX_REVISOES_POR_BOOT, agora = Date.now()) {
  const novos = [], revisoes = [];
  for (const id of ids) {
    const ts = verificados.get(String(id));
    if (!venceu(String(id), ts, agora)) continue;
    (verificados.has(String(id)) ? revisoes : novos).push(String(id));
  }
  revisoes.sort((a, b) => Number(verificados.get(a)) - Number(verificados.get(b)));
  return { novos, revisoes: revisoes.slice(0, max), adiadas: Math.max(0, revisoes.length - max) };
}

module.exports = { carregar, salvar, enxugar, venceu, podar, selecionar, MAX_REVISOES_POR_BOOT };
