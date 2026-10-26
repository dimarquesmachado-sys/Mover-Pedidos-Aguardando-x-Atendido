'use strict';
/* ─────────────────────────────────────────────────────────────────────────────
   DEVOLUÇÕES DO TIKTOK — a rotina diária, peça única (26/10/2026). Era um bloco na madrugada da Girassol e outro na da
   AMB (o mesmo código, só a empresa mudava); a GOOD não tinha — a linha de devoluções do TikTok dela envelhecia e
   voltava a depender de alguém coletar na mão. Duas partes, as mesmas de antes:
   · coletar(empresa, dias) — as devoluções da janela (lib/tiktok-financeiro.coletarDevolucoesTikTok);
   · completarLinhaDoTempo(empresa) — postagem, reembolso e revelia (/records) das que ainda não têm, no máximo 40
     por vez (cada uma é uma chamada à API, e o limite de taxa já nos mordeu antes), 250 ms entre elas.
   ───────────────────────────────────────────────────────────────────────────── */
const fs = require('fs');
const path = require('path');

function ctxDev(o) {
  const CACHE = process.env.TIKTOK_CACHE_DIR || '/data';
  return {
    CACHE_DIR: CACHE, path,
    readJson: (a, p) => { try { return JSON.parse(fs.readFileSync(a, 'utf8')); } catch (e) { return p; } },
    writeJson: (a, v) => { try { fs.mkdirSync(path.dirname(a), { recursive: true }); } catch (e) {} fs.writeFileSync(a, JSON.stringify(v, null, 2)); },
    chamar: (o && o.chamar) || require('../tiktok-oauth').chamar,
  };
}

/* devolve o resultado da coleta ({ vistas, novas, ... } ou { erro }) */
async function coletar(empresa, dias, o) {
  const devLib = (o && o.devLib) || require('./tiktok-financeiro');
  return devLib.coletarDevolucoesTikTok(ctxDev(o), empresa, dias);
}

/* devolve { semCache: true } ou { ok, revelias, semEventos } */
async function completarLinhaDoTempo(empresa, o) {
  const evLib = (o && o.evLib) || require('./tiktok-eventos');
  const c = ctxDev(o);
  const arqD = path.join(c.CACHE_DIR, '_tiktok_devolucoes_' + empresa + '.json');
  const g = c.readJson(arqD, null);
  if (!g || !g.devolucoes) return { semCache: true };
  const faltam = Object.values(g.devolucoes).filter((d) => d && d.id && !d.eventos).slice(0, 40);
  let ok = 0, revelias = 0;
  for (const d of faltam) {
    try {
      const r = await c.chamar('/return_refund/202309/returns/' + encodeURIComponent(d.id) + '/records', {}, {}, empresa);
      const recs = r && r.corpo && r.corpo.data && r.corpo.data.records;
      if (!Array.isArray(recs)) continue;
      d.eventos = evLib.resumirEventos(recs);
      if (d.eventos.perdeu_por_revelia) revelias++;
      ok++;
    } catch (e) { /* uma falhar não derruba a rotina */ }
    await new Promise((s2) => setTimeout(s2, 250));
  }
  c.writeJson(arqD, g);
  const semEventos = Object.values(g.devolucoes).filter((d) => d && !d.eventos).length;
  return { ok, revelias, semEventos };
}

/* o texto que a madrugada mostra em cada etapa (o mesmo de antes) */
const textoColeta = (r) => r.vistas + ' vista(s) · ' + r.novas + ' nova(s)';
const textoLinha = (r) => (r.semCache ? 'sem cache — nada a fazer' : (r.ok + ' processada(s) · ' + r.revelias + ' com revelia · ' + r.semEventos + ' ainda sem linha do tempo'));

module.exports = { coletar, completarLinhaDoTempo, textoColeta, textoLinha };
