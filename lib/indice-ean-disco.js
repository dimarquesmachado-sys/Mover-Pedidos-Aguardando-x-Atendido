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
 * @returns {{ eans: Map<string,string>, verificados: Set<string>, salvo_em: string|null, erro: string|null }}
 */
function carregar(arquivo) {
  const vazio = { eans: new Map(), verificados: new Set(), salvo_em: null, erro: null };
  try {
    if (!arquivo || !fs.existsSync(arquivo)) return vazio;
    const j = JSON.parse(fs.readFileSync(arquivo, 'utf8'));
    const eans = new Map(Object.entries(j.eans || {}).map(([e, id]) => [String(e), String(id)]));
    const verificados = new Set((j.verificados || []).map(String));
    // todo id que tem EAN tambem e "verificado" (arquivo antigo pode nao ter a lista)
    for (const id of eans.values()) verificados.add(id);
    return { eans, verificados, salvo_em: j.salvo_em || null, erro: null };
  } catch (e) {
    return { ...vazio, erro: e.message };
  }
}

/**
 * Grava o indice. Atomico (tmp + rename) pra um reinicio no meio nao deixar
 * JSON pela metade. Nunca lanca.
 * @returns {{ ok: boolean, erro?: string, eans: number, verificados: number }}
 */
function salvar(arquivo, indiceEan, verificados) {
  try {
    if (!arquivo) return { ok: false, erro: 'sem caminho', eans: 0, verificados: 0 };
    const eans = {};
    for (const [e, id] of indiceEan) eans[String(e)] = String(id);
    const lista = [...verificados].map(String);
    fs.mkdirSync(path.dirname(arquivo), { recursive: true });
    const tmp = arquivo + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({ salvo_em: new Date().toISOString(), eans, verificados: lista }));
    fs.renameSync(tmp, arquivo);
    return { ok: true, eans: indiceEan.size, verificados: lista.length };
  } catch (e) {
    return { ok: false, erro: e.message, eans: indiceEan ? indiceEan.size : 0, verificados: verificados ? verificados.size : 0 };
  }
}

module.exports = { carregar, salvar };
