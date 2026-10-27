'use strict';
/* ─────────────────────────────────────────────────────────────────────────────
   DIAS DA SHOPEE SEM REPASSE — refeitos sozinhos (27/10/2026). Caso real: a Partner Key da Girassol venceu em 23/10;
   até a troca em 27/10, toda venda da Shopee que o backfill gravou ficou com a comissão do Bling (o repasse/escrow
   não respondia) — e NADA ficou anotado pra refazer: só um backfill manual daqueles dias consertava.
   Agora: cada backfill anota, ao TERMINAR com a troca feita, os dias do período em que algum pedido da Shopee ficou
   sem repasse (escrow_sem_resposta / escrow_erro) e LIMPA os dias do período que saíram completos. A madrugada
   refaz os pendentes mais antigos (até 3 por noite), só quando a Shopee não está recusando a chave; depois de 7
   tentativas, o dia sai da lista (avisa no log) — não fica tentando pra sempre.
   Um arquivo por empresa: <CACHE da empresa>/_shopee_repasse_pendente.json · os dias são a data do PEDIDO no Bling
   (a mesma que escolhe o período do backfill).
   ───────────────────────────────────────────────────────────────────────────── */
const fs = require('fs');
const path = require('path');
const ARQ = '_shopee_repasse_pendente.json';
const MAX_POR_NOITE = 3, MAX_TENTATIVAS = 7;

function _ler(cacheDir) { try { const j = JSON.parse(fs.readFileSync(path.join(cacheDir, ARQ), 'utf8')); return (j && j.dias && typeof j.dias === 'object') ? j : { dias: {} }; } catch (e) { return { dias: {} }; } }
function _gravar(cacheDir, j) { try { fs.mkdirSync(cacheDir, { recursive: true }); } catch (e) {} fs.writeFileSync(path.join(cacheDir, ARQ), JSON.stringify(j, null, 1)); }
function _diasEntre(de, ate) {
  const out = []; const ok = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));
  if (!ok(de) || !ok(ate) || de > ate) return out;
  for (let t = Date.parse(de + 'T00:00:00Z'), fim = Date.parse(ate + 'T00:00:00Z'); t <= fim && out.length < 800; t += 864e5) out.push(new Date(t).toISOString().slice(0, 10));
  return out;
}

/* chamado pelo backfill ao terminar COM a troca feita: semRepasse = { 'AAAA-MM-DD': n pedidos sem repasse }.
   Codex #755: só LIMPA (tira da lista o dia sem falha) quando a rodada foi COMPLETA — com erros, pedido que nem chegou
   a ser olhado (detalhe que não veio) não aparece em semRepasse, e a ausência de falha não prova que o repasse voltou.
   As TENTATIVAS são contadas pela madrugada (marcarTentativa), não aqui: rodada abortada nem chega aqui. */
function anotarRodada(cacheDir, de, ate, semRepasse, opts) {
  if (!cacheDir) return null;
  const o = opts || {};
  const completo = o.completo === true;
  const j = _ler(cacheDir), mapa = semRepasse || {}, quando = new Date(o.agora == null ? Date.now() : o.agora).toISOString();
  for (const d of _diasEntre(String(de || '').slice(0, 10), String(ate || '').slice(0, 10))) {
    const n = Number(mapa[d] || 0);
    if (n > 0) {
      const ant = j.dias[d];
      j.dias[d] = Object.assign({}, ant || {}, { pedidos: n, desde: (ant && ant.desde) || quando, tentativas: ant ? Number(ant.tentativas || 0) : 0, ultima: quando });
    } else if (completo) delete j.dias[d];
  }
  _gravar(cacheDir, j);
  return j;
}
function listar(cacheDir) { const j = _ler(cacheDir); return Object.keys(j.dias).sort().map((d) => Object.assign({ dia: d }, j.dias[d])); }
/* Codex #755: a madrugada conta CADA tentativa (mesmo a que aborta) e escolhe primeiro quem foi tentado há mais tempo
   (nunca tentado na frente) — 3 dias que sempre abortam não travam os outros, e chegam às 7 tentativas */
function marcarTentativa(cacheDir, dia, agora) {
  const j = _ler(cacheDir); const x = j.dias[dia]; if (!x) return null;
  x.tentativas = Number(x.tentativas || 0) + 1; x.ultima_tentativa = new Date(agora == null ? Date.now() : agora).toISOString();
  _gravar(cacheDir, j); return x;
}
function paraRefazer(cacheDir, n) {
  return listar(cacheDir).sort((a, b) => String(a.ultima_tentativa || '').localeCompare(String(b.ultima_tentativa || '')) || a.dia.localeCompare(b.dia)).slice(0, n == null ? MAX_POR_NOITE : n);
}
function desistir(cacheDir, dia) { const j = _ler(cacheDir); delete j.dias[dia]; _gravar(cacheDir, j); }

module.exports = { anotarRodada, listar, desistir, marcarTentativa, paraRefazer, ARQ, MAX_POR_NOITE, MAX_TENTATIVAS };
