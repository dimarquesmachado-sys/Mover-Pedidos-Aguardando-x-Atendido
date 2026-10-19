'use strict';

/* ─────────────────────────────────────────────────────────────────────────────
   PEDIDOS ADIADOS PELO ML (17/10/2026) — lista durável, por empresa, pro F2.

   O F2 (AGUARDANDO → ATENDIDO e "a nota quando o ML pede") só olha pedidos da janela curta (JANELA_ULTIMOS_DIAS,
   15 em produção). Venda com prazo de disponibilidade ou coleta programada (manufacturing / buffered) fica parada
   SEMANAS: vendida em 18/10 com coleta em 7/11, quando o ML liberar a etiqueta ou pedir a nota o pedido já saiu da
   janela — não voltaria pro ATENDIDO nem ganharia a nota (Codex #712). Esta lista guarda esses pedidos; o F2 consulta
   uma janela maior e, do que passa da janela curta, só trata quem está aqui — o resto do AGUARDANDO antigo (pedido
   esquecido, já entregue) não é tocado. Arquivo por empresa em CACHE_DIR, gravação atômica.
   ───────────────────────────────────────────────────────────────────────────── */

const fs = require('fs');
const path = require('path');
const { gravarAtomico } = require('../escrita-atomica');

const MAX_DIAS = 120;   // ninguém fica adiado mais que isso: sai da lista

function _chave(e) { return String(e || '').toLowerCase().replace(/[^a-z0-9]+/g, '-'); }
function arquivo(empresa) { return path.join(process.env.CACHE_DIR || '/data', 'f2-adiados-' + _chave(empresa) + '.json'); }
function ler(empresa) {
  try { const m = JSON.parse(fs.readFileSync(arquivo(empresa), 'utf8')); return (m && typeof m === 'object') ? m : {}; } catch (e) { return {}; }
}
function _gravar(empresa, m) { try { gravarAtomico(arquivo(empresa), JSON.stringify(m)); return true; } catch (e) { return false; } }
/* o envio está adiado pelo ML? (aguardando estoque ou coleta programada) */
function adiado(substatus) { return /manufacturing|buffered/i.test(String(substatus || '')); }
function registrar(empresa, idPedido, info) {
  const m = ler(empresa); const k = String(idPedido);
  if (m[k]) return true;
  m[k] = Object.assign({ desde: new Date().toISOString() }, info || {});
  return _gravar(empresa, m);
}
function remover(empresa, idPedido) {
  const m = ler(empresa); const k = String(idPedido);
  if (!m[k]) return true;
  delete m[k]; return _gravar(empresa, m);
}
/* poda quem passou de MAX_DIAS; devolve o mapa atual */
function podar(empresa, agora) {
  const m = ler(empresa); const t = agora || Date.now(); let mudou = false;
  for (const k of Object.keys(m)) if (t - (Date.parse(m[k] && m[k].desde) || t) > MAX_DIAS * 86400000) { delete m[k]; mudou = true; }
  if (mudou) _gravar(empresa, m);
  return m;
}

module.exports = { arquivo, ler, registrar, remover, podar, adiado, MAX_DIAS };
