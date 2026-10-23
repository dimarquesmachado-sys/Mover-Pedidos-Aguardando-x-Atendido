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
  /* 15/10: atômico (#691) — o plano é o que permite retomar depois de uma queda; gravação cortada
     no meio não pode deixá-lo ilegível. Devolve se GRAVOU (Codex #696: quem cria o plano precisa
     saber — plano que não foi pro disco não pode ser anunciado como aceito). */
  try { require('./escrita-atomica').gravarAtomico(arq(cacheDir), JSON.stringify(p, null, 2)); return true; } catch (e) { return false; }
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
  /* Codex #696: plano que não foi pro disco não existe — lança em vez de devolver um objeto que
     parece aceito (o motor lê do disco e não faria nada) */
  if (!gravar(cacheDir, p)) throw new Error('não consegui gravar o plano em ' + arq(cacheDir));
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
    motivo_parada: p.parado ? (p.motivo_parada || null) : null,   /* 23/10: por que pausou sozinho (banco não preparado) */
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
const MSG_DISCO = 'não consegui gravar o plano (disco cheio ou sem permissão)';
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
    p.atualizado = f.inicio;
    /* Codex #696 r4: se o disco não guardou o 'rodando', NÃO roda — senão o próximo toque relê a mesma fatia e refaz o backfill */
    if (!gravar(cacheDir, p)) return { ok: false, armazenamento: true, motivo: MSG_DISCO, feitas };
    let r = null, erro = null;
    try { r = await rodarUma({ de: f.de, ate: f.ate }); }
    catch (e) { erro = String(e.message || e).slice(0, 200); }
    p = ler(cacheDir) || p;
    const alvo = p.fatias.find(x => x.de === f.de && x.ate === f.ate) || f;
    const desfecho = r && r.desfecho;
    /* 15/10: "já tem outro rodando" e "adiado" não são falha da fatia — com `adiadoVoltaPraFila`
       (o motor, que tem quem tente de novo) ela volta pra fila e o executar para. Sem a opção (o
       plano da Girassol, que não tem quem retome — Codex #696) segue como antes: vira erro visível. */
    if (o.adiadoVoltaPraFila && !erro && r && (desfecho === 'ja_rodando' || desfecho === 'adiado' || r.adiado)) {
      alvo.estado = 'pendente'; delete alvo.inicio;
      p.atualizado = new Date().toISOString();
      if (!gravar(cacheDir, p)) return { ok: false, armazenamento: true, motivo: MSG_DISCO, feitas };
      return { ok: false, motivo: 'outro backfill em curso', feitas };
    }
    /* Codex #696 r4: 'com_erros' (gravou, mas lotes falharam) não é sucesso — fatia com erro fixo, visível no plano */
    if (erro || (r && r.ok === false) || desfecho === 'erro' || desfecho === 'abortado' || desfecho === 'com_erros') {
      alvo.estado = 'erro'; alvo.msg = erro || (r && r.msg) || (desfecho === 'com_erros' ? 'terminou com ' + (Number(r.erros) || '?') + ' erro(s) em itens — faltam linhas' : desfecho) || 'falhou';
      /* Codex #696: só falha que melhora com o tempo (Bling limitado, rede) merece retentativa
         automática — a trava de sanidade, spool inválido e erro do Supabase são determinísticos */
      alvo.transitorio = !erro && !!(r && r.transitorio);
      /* 23/10: BANCO NÃO PREPARADO (falta o script da troca segura no Supabase) vale pra TODAS as fatias — seguir é só
         gastar cota do Bling pra falhar igual (o ano da GOOD queimou 5 fatias assim). Pausa o plano com o motivo; o
         `retentar` (depois de rodar o script) devolve as fatias com erro pra fila e tira a pausa. */
      if (r && r.nao_preparado) {
        p.parado = true; p.motivo_parada = alvo.msg; alvo.fim = new Date().toISOString(); p.atualizado = alvo.fim;
        if (!gravar(cacheDir, p)) return { ok: false, armazenamento: true, motivo: MSG_DISCO, feitas };
        return { ok: false, motivo: 'plano pausado: ' + alvo.msg, pausado: true, feitas: feitas + 1 };
      }
    } else {
      alvo.estado = 'ok'; alvo.pedidos = (r && r.pedidos) || null; alvo.gravados = (r && r.gravados) || null;
    }
    alvo.fim = new Date().toISOString();
    p.atualizado = alvo.fim;
    if (!gravar(cacheDir, p)) return { ok: false, armazenamento: true, motivo: MSG_DISCO, feitas };
    feitas++;
    if (o.pausaMs) await new Promise(s => setTimeout(s, o.pausaMs));
  }
  return { ok: true, feitas, resumo: resumo(ler(cacheDir)) };
}

function parar(cacheDir) {
  const p = ler(cacheDir); if (!p) return false;
  p.parado = true; p.atualizado = new Date().toISOString();
  return gravar(cacheDir, p);   /* Codex #696 r2: "parei" só se o disco disse que parou */
}
/** Codex #696: refaz SÓ as que deram erro passageiro (transitorio) — devolve quantas voltaram. */
function retentarTransitorios(cacheDir) {
  const p = ler(cacheDir); if (!p) return 0; let n = 0;
  for (const f of p.fatias) if (f.estado === 'erro' && f.transitorio) { f.estado = 'pendente'; delete f.msg; delete f.transitorio; n++; }
  if (n) { p.atualizado = new Date().toISOString(); if (!gravar(cacheDir, p)) return -1; }   /* -1 = não gravou */
  return n;
}
/** Codex #696 r3: devolve as fatias de erro PASSAGEIRO pra fila E conta a rodada numa gravação SÓ —
    ou as duas coisas vão pro disco, ou nenhuma. { ok, n, rodada } ou { ok:false, motivo }. */
function requeueTransitoriosContando(cacheDir) {
  const p = ler(cacheDir); if (!p) return { ok: false, n: 0, motivo: 'sem plano' };
  let n = 0;
  for (const f of p.fatias) if (f.estado === 'erro' && f.transitorio) { f.estado = 'pendente'; delete f.msg; delete f.transitorio; n++; }
  if (!n) return { ok: true, n: 0, rodada: Number(p.retentativas_auto || 0) };
  p.retentativas_auto = Number(p.retentativas_auto || 0) + 1; p.atualizado = new Date().toISOString();
  return gravar(cacheDir, p) ? { ok: true, n, rodada: p.retentativas_auto } : { ok: false, n: 0, motivo: MSG_DISCO };
}
/** Refaz as que deram erro (volta pra pendente). */
function retentar(cacheDir) {
  const p = ler(cacheDir); if (!p) return false;
  let n = 0;
  for (const f of p.fatias) if (f.estado === 'erro') { f.estado = 'pendente'; delete f.msg; n++; }
  p.parado = false; delete p.motivo_parada; if (!gravar(cacheDir, p)) return -1;   /* Codex #696 r2: -1 = não gravou */
  return n;
}

/* ═══ 15/10 — MOTOR AUTOMÁTICO ═══════════════════════════════════════════════════════════════
   Pedido do dono: "esse backfill tinha que ser automático" e "já tivemos problema disso antes"
   (rodada que morre num deploy e recomeça do zero). O plano já ficava em disco; faltava quem o
   tocasse sozinho. Este motor:
   - roda as fatias SÓ quando `podeRodarAgora()` deixa (a empresa passa a janela fora do galpão);
     fora dela, agenda a volta pra quando a janela abrir;
   - cede a vez quando `ocupado()` (outro backfill na mesma trava) e tenta de novo em 10 min;
   - fatia que deu erro volta pra fila sozinha, até `maxRetentativas` rodadas (15 min entre elas);
   - é chamado no boot: fatia que estava "rodando" quando o processo morreu é refeita inteira
     (o período é reescrito do zero, então meia gravação não fica).
   Tudo que ele decide fica em `estado()` (próximo toque, motivo, último resultado). */
function criarMotor(o) {
  if (!o || !o.cacheDir || typeof o.rodarFatia !== 'function') throw new Error('backfill-fatiado.criarMotor: falta cacheDir/rodarFatia');
  const agendar = o.agendar || ((fn, ms) => { const t = setTimeout(fn, ms); if (t && t.unref) t.unref(); return t; });
  const cancelar = o.cancelar || ((t) => clearTimeout(t));
  const maxRet = o.maxRetentativas != null ? o.maxRetentativas : 3;
  const esperaRet = o.esperaRetentarMs != null ? o.esperaRetentarMs : 15 * 60000;
  const esperaOcupado = o.esperaOcupadoMs != null ? o.esperaOcupadoMs : 10 * 60000;
  const janela = () => { try { return (o.podeRodarAgora ? o.podeRodarAgora() : null) || { ok: true }; } catch (e) { return { ok: true }; } };
  const est = { rodando: false, proximo: null, ultimo: null };
  let timer = null;
  function reagendar(ms, motivo) {
    if (timer) { try { cancelar(timer); } catch (e) {} }
    est.proximo = { em: new Date(Date.now() + ms).toISOString(), motivo };
    timer = agendar(() => { timer = null; est.proximo = null; tocar().catch(() => {}); }, ms);
  }
  async function tocar() {
    if (est.rodando) return { ok: false, motivo: 'já tocando' };
    const pl = ler(o.cacheDir);
    if (!pl) return { ok: false, motivo: 'sem plano' };
    if (pl.parado) return { ok: false, motivo: 'plano parado' };
    if (!proxima(pl)) {
      const r = resumo(pl);
      if (r.com_erro > 0) {
        const passageiras = pl.fatias.filter(x => x.estado === 'erro' && x.transitorio).length;
        const fixas = r.com_erro - passageiras;
        const feitas = Number(pl.retentativas_auto || 0);
        if (!passageiras || feitas >= maxRet) {
          est.ultimo = { ok: false, motivo: (fixas ? fixas + ' fatia(s) com erro que não melhora sozinho' : '') + (fixas && passageiras ? ' e ' : '') +
            (passageiras ? passageiras + ' com erro passageiro depois de ' + feitas + ' rodada(s) automáticas' : '') + ' — ver /backfill-plano' };
          return est.ultimo;
        }
        /* Codex #696 r3: fila e contador numa gravação só; se o disco recusar, NADA mudou — não gasta
           rodada, avisa e tenta de novo; 3 recusas seguidas = para dizendo que o problema é o disco */
        const rq = requeueTransitoriosContando(o.cacheDir);
        if (!rq.ok) {
          est.falhasGravacao = (est.falhasGravacao || 0) + 1;
          if (est.falhasGravacao >= 3) { est.ultimo = { ok: false, motivo: rq.motivo + ' — ' + est.falhasGravacao + ' vezes seguidas; parei. Ver /backfill-plano' }; return est.ultimo; }
          reagendar(esperaRet, rq.motivo + ' — tento de novo (' + est.falhasGravacao + '/3)');
          return { ok: false, motivo: rq.motivo };
        }
        est.falhasGravacao = 0;
        reagendar(esperaRet, 'refazer ' + rq.n + ' fatia(s) com erro passageiro (rodada ' + rq.rodada + ' de ' + maxRet + ')');
        return { ok: true, motivo: 'erros passageiros voltaram pra fila' };
      }
      est.ultimo = { ok: true, motivo: 'plano concluído', resumo: r };
      return est.ultimo;
    }
    const j = janela();
    if (!j.ok) { reagendar(Math.max(60000, Number(j.esperaMs) || 60 * 60000), j.motivo || 'fora da janela'); return { ok: false, motivo: j.motivo || 'fora da janela' }; }
    if (o.ocupado && o.ocupado()) { reagendar(esperaOcupado, 'outro backfill em curso'); return { ok: false, motivo: 'outro backfill em curso' }; }
    est.rodando = true;
    try {
      const r = await executar(o.cacheDir, o.rodarFatia, { estaOcupado: () => !!(o.ocupado && o.ocupado()) || !janela().ok, pausaMs: o.pausaMs != null ? o.pausaMs : 20000, adiadoVoltaPraFila: true });
      est.ultimo = r;
      if (r && r.armazenamento) {
        /* Codex #696 r4: progresso não gravou — não segue pra próxima fatia; espera e conta, 3 seguidas param */
        est.falhasGravacao = (est.falhasGravacao || 0) + 1;
        if (est.falhasGravacao >= 3) est.ultimo = { ok: false, motivo: r.motivo + ' — ' + est.falhasGravacao + ' vezes seguidas; parei. Ver /backfill-plano' };
        else reagendar(esperaRet, r.motivo + ' — tento de novo (' + est.falhasGravacao + '/3)');
      } else if (r && r.ok === false && r.motivo === 'outro backfill em curso') {
        const j2 = janela();
        reagendar(j2.ok ? esperaOcupado : Math.max(60000, Number(j2.esperaMs) || 60 * 60000), j2.ok ? 'outro backfill em curso' : (j2.motivo || 'fora da janela'));
      } else if (r && r.ok) { est.falhasGravacao = 0; reagendar(1000, 'conferir o fim do plano'); }
      return r;
    } finally { est.rodando = false; }
  }
  return { tocar, estado: () => Object.assign({}, est, { proximo: est.proximo ? Object.assign({}, est.proximo) : null }) };
}

module.exports = { criar, executar, resumo, ler, parar, retentar, retentarTransitorios, requeueTransitoriosContando, fatiar, proxima, criarMotor };
