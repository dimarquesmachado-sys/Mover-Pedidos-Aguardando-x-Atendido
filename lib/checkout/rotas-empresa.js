'use strict';
/* 16/11 — O TRATADOR DE ROTAS DE UMA EMPRESA, NUMA PEÇA SÓ (docs/NORTE-2026-11.md, item C: a caminho do `montarCheckout`).

   Depois da cabeça comum (lib/checkout/cabeca-routes), o `handle` das três empresas era a MESMA fila de peças de rota, em
   ordens diferentes e com os nomes da empresa à mão: as rotas comuns, as de lote, as fotos do produto, o plano em fatias
   (ano e período), o PWA, o canário, o /backfill-status, o de-para de SKU, histórico, pescaria, canário das integrações,
   limpeza, noturna, Shopee, diagnóstico e, por fim, a fábrica de rotas do painel. Agora a FILA é esta peça, numa ordem
   só; a empresa entrega cada passo (ou null, quando não tem — a GOOD não tem ícone PNG nem limpeza) e as rotas que só
   ela tem (`proprias`).

   A ORDEM é regra, e é segurança (Codex #480; teste-fabrica-nao-rouba-rota): o portão vem na cabeça, antes de tudo; as
   rotas PRÓPRIAS da empresa vêm antes das peças compartilhadas que também as tratariam; a fábrica do painel vem por
   ÚLTIMO (é a mais genérica — quem tem rota própria declara em `rotasProprias` dela). scripts/teste-rotas-empresa.js
   sonda cada passo das três com cada rota conhecida e prova que quem responde primeiro é quem respondia antes.

   Um passo pode ser:
     · uma função (req, res, urlObj, method, p) → boolean | Promise<boolean>;
     · { montar: () => função } — montado na PRIMEIRA chamada (a fábrica do painel e as fotos eram assim: peças que nascem
       depois do boot); se a montagem falhar, o passo vira "não trata" e o erro fica no log, como era;
     · null/undefined — a empresa não tem esse passo. */
const ORDEM = ['cabeca', 'comuns', 'lote', 'fotos', 'planoAno', 'plano', 'pwa', 'canEmp', 'backfillStatus', 'shopeeSessao', 'proprias', 'deParaSku',
  'hist', 'pesca', 'canario', 'limpeza', 'noturna', 'shopee', 'diag', 'painel'];   /* 16/11 (passo 2): + shopeeSessao (semear/devolução — eram as próprias da AMB) */
const OBRIGATORIOS = ['cabeca', 'comuns', 'lote', 'planoAno', 'plano', 'canEmp', 'backfillStatus', 'shopeeSessao', 'deParaSku', 'hist', 'pesca', 'canario', 'noturna', 'shopee', 'diag', 'painel'];

function _passo(nome, def, log) {
  if (def == null) return null;
  if (typeof def === 'function') return def;
  if (def && typeof def.montar === 'function') {
    let fn = null, tentou = false;
    return async function montadoNaPrimeira(req, res, urlObj, method, p) {
      if (!tentou) {
        tentou = true;
        try { fn = def.montar(); if (typeof fn !== 'function') throw new Error('montar() não devolveu função'); log('[' + nome + '] montado'); }
        catch (e) { console.error('[' + nome + '] falha ao montar: ' + (e && e.message)); fn = null; }
      }
      return fn ? fn(req, res, urlObj, method, p) : false;
    };
  }
  throw new Error('lib/checkout/rotas-empresa: o passo ' + nome + ' tem que ser função, { montar } ou null');
}

function criar(empresa, P) {
  const o = P || {};
  const falta = OBRIGATORIOS.filter((k) => o[k] == null);
  if (falta.length) throw new Error('lib/checkout/rotas-empresa (' + empresa + '): falta ' + falta.join(', '));
  const proprias = Array.isArray(o.proprias) ? o.proprias : (o.proprias ? [o.proprias] : []);
  const log = (m) => console.log('[' + String(empresa).toUpperCase() + '] ' + m);
  /* a fila, na ordem: cada item { nome, fn } (as próprias entram uma a uma, na posição de `proprias`) */
  const passos = [];
  for (const nome of ORDEM) {
    if (nome === 'proprias') { proprias.forEach((fn, i) => { const f = _passo('propria' + (i + 1), fn, log); if (f) passos.push({ nome: 'propria' + (i + 1), fn: f }); }); continue; }
    const f = _passo(nome, o[nome], log);
    if (f) passos.push({ nome, fn: f });
  }
  async function handle(req, res, urlObj) {
    const { method } = req;
    const p = urlObj.pathname;
    for (const passo of passos) {
      if (await passo.fn(req, res, urlObj, method, p)) return true;
    }
    return false;   // não tratou
  }
  return { handle, passos, ORDEM };
}

module.exports = { criar, ORDEM, OBRIGATORIOS };
