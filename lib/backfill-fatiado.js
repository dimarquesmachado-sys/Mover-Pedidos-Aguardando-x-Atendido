'use strict';

/**
 * lib/backfill-fatiado.js — backfill de período longo em FATIAS, com retomada (05/09).
 *
 * POR QUE EXISTE: o serviço roda num container de 512 MB (Render Starter) e o backfill de um
 * MÊS da Girassol (~3.000 pedidos) estoura a memória — status 134, cinco quedas medidas, três
 * delas já com o heap limitado a 407 MB pelo #329. O Bling não é o gargalo aqui: as rodadas
 * de hoje foram a zero erro até o processo morrer. É tamanho de trabalho contra tamanho de
 * container.
 *
 * COMO RESOLVE: fatia o período em blocos de N dias (10 por padrão) e roda um de cada vez,
 * esperando o anterior terminar. Cada fatia é uma rodada curta, que acaba antes de acumular.
 * E o progresso fica EM DISCO: se o processo cair no meio, ao subir de novo a rotina vê o
 * que falta e retoma sozinha, sem ninguém disparar nada.
 *
 * O dono dispara uma vez ("ano todo") e volta horas depois com tudo pronto.
 */

const fs = require('fs');
const path = require('path');

function arq(cacheDir) { return path.join(cacheDir, '_backfill_plano.json'); }

function ler(cacheDir) {
  try { return JSON.parse(fs.readFileSync(arq(cacheDir), 'utf8')); } catch (e) { return null; }
}
function gravar(cacheDir, p) {
  try { fs.mkdirSync(cacheDir, { recursive: true }); fs.writeFileSync(arq(cacheDir), JSON.stringify(p, null, 2)); } catch (e) {}
}

/** Corta [de, ate] em fatias de `dias`. A última pode ser menor. */
function fatiar(de, ate, dias) {
  const out = [];
  let ini = new Date(de + 'T12:00:00Z');
  const fim = new Date(ate + 'T12:00:00Z');
  while (ini <= fim) {
    const f = new Date(ini); f.setUTCDate(f.getUTCDate() + (dias - 1));
    out.push({ de: ini.toISOString().slice(0, 10), ate: (f > fim ? fim : f).toISOString().slice(0, 10), estado: 'pendente' });
    ini = new Date(f); ini.setUTCDate(ini.getUTCDate() + 1);
  }
  return out;
}

/** Cria o plano. Não roda nada — quem roda é o executar(). */
function criar(cacheDir, de, ate, dias) {
  const p = {
    de, ate, dias: dias || 10,
    fatias: fatiar(de, ate, dias || 10),
    criado: new Date().toISOString(), atualizado: new Date().toISOString(),
    parado: false,
  };
  gravar(cacheDir, p);
  return p;
}

function proxima(p) { return (p && p.fatias || []).find(f => f.estado === 'pendente' || f.estado === 'rodando') || null; }

function resumo(p) {
  if (!p) return { existe: false };
  const c = { pendente: 0, rodando: 0, ok: 0, erro: 0 };
  for (const f of p.fatias) c[f.estado] = (c[f.estado] || 0) + 1;
  const feitas = c.ok + c.erro;
  return {
    existe: true, de: p.de, ate: p.ate, dias: p.dias, parado: !!p.parado,
    total: p.fatias.length, concluidas: c.ok, com_erro: c.erro, faltam: c.pendente + c.rodando,
    progresso: p.fatias.length ? Math.round((feitas / p.fatias.length) * 100) + '%' : '0%',
    proxima: (proxima(p) || {}).de || null,
    fatias: p.fatias,
  };
}

/**
 * Roda as fatias pendentes, UMA POR VEZ. Se o processo cair, o disco guarda onde parou e a
 * próxima chamada (inclusive a automática do boot) retoma dali.
 * @param rodarUma  async ({de, ate}) => resultado  — o backfill de verdade
 * @param estaOcupado  () => bool — pra não atropelar um backfill manual em curso
 */
async function executar(cacheDir, rodarUma, opcoes) {
  const o = opcoes || {};
  let p = ler(cacheDir);
  if (!p || p.parado) return { ok: false, motivo: p ? 'plano parado' : 'sem plano' };
  let feitas = 0;
  while (true) {
    p = ler(cacheDir);                       // relê: o dono pode ter parado no meio
    if (!p || p.parado) break;
    const f = proxima(p);
    if (!f) break;
    if (o.estaOcupado && o.estaOcupado()) return { ok: false, motivo: 'outro backfill em curso', feitas };
    f.estado = 'rodando'; f.inicio = new Date().toISOString();
    p.atualizado = f.inicio; gravar(cacheDir, p);
    let r = null, erro = null;
    try { r = await rodarUma({ de: f.de, ate: f.ate }); }
    catch (e) { erro = String(e.message || e).slice(0, 200); }
    p = ler(cacheDir) || p;
    const alvo = p.fatias.find(x => x.de === f.de && x.ate === f.ate) || f;
    const desfecho = r && r.desfecho;
    if (erro || (r && r.ok === false) || desfecho === 'erro' || desfecho === 'abortado') {
      alvo.estado = 'erro'; alvo.msg = erro || (r && r.msg) || desfecho || 'falhou';
    } else {
      alvo.estado = 'ok'; alvo.pedidos = (r && r.pedidos) || null; alvo.gravados = (r && r.gravados) || null;
    }
    alvo.fim = new Date().toISOString();
    p.atualizado = alvo.fim; gravar(cacheDir, p);
    feitas++;
    if (o.pausaMs) await new Promise(s => setTimeout(s, o.pausaMs));
  }
  return { ok: true, feitas, resumo: resumo(ler(cacheDir)) };
}

function parar(cacheDir) {
  const p = ler(cacheDir); if (!p) return false;
  p.parado = true; p.atualizado = new Date().toISOString(); gravar(cacheDir, p);
  return true;
}
/** Refaz as que deram erro (volta pra pendente). */
function retentar(cacheDir) {
  const p = ler(cacheDir); if (!p) return false;
  let n = 0;
  for (const f of p.fatias) if (f.estado === 'erro') { f.estado = 'pendente'; delete f.msg; n++; }
  p.parado = false; gravar(cacheDir, p);
  return n;
}

module.exports = { criar, executar, resumo, ler, parar, retentar, fatiar, proxima };
