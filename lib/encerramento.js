'use strict';
/* 15/11 — ENCERRAMENTO COM DRENAGEM (auditoria do Codex de 15/11/2026, P2 nº 9).

   Antes: SIGTERM → `server.close(); process.exit(0)` na mesma linha. O Render manda SIGTERM a cada deploy e dá ~30 s;
   saindo na hora, um ciclo no meio do PATCH, um backfill no meio da troca ou uma correção de NF eram cortados sem registro
   nenhum — o próximo boot não sabia que algo tinha ficado pela metade.

   Agora, ao sinal:
     1. fecha a porta: as AGENDAS param (os crons do index.js) e nenhuma rotina de fundo nova começa (contexto-fundo);
     2. para de aceitar conexão nova (`server.close`), mas as abertas terminam;
     3. ESPERA o que está em curso (as rotinas de fundo registradas em contexto-fundo.emCurso) até um prazo
        (ENCERRAMENTO_PRAZO_MS, padrão 20 s — abaixo dos 30 s do Render);
     4. REGISTRA o encerramento num arquivo (o que terminou a tempo, o que não terminou — "trabalho recuperável": as
        rotinas são idempotentes/retomáveis por desenho e voltam na próxima agenda, mas agora fica dito o que foi cortado)
        e sai com código 0. Segundo sinal durante a espera = sai na hora.
   `diagnostico()` entra no /health: versão do Node, teto do heap, o último encerramento e o que está em curso agora. */
const fs = require('fs');
const path = require('path');

const PRAZO_MS = parseInt(process.env.ENCERRAMENTO_PRAZO_MS || '', 10) > 0 ? parseInt(process.env.ENCERRAMENTO_PRAZO_MS, 10) : 20000;
const ARQUIVO = () => process.env.ENCERRAMENTO_FILE || (fs.existsSync('/data') ? '/data/_ultimo-encerramento.json' : path.join(require('os').tmpdir(), 'mp-ultimo-encerramento.json'));

function criar(o) {
  const fundo = o.fundo || require('./checkout/contexto-fundo');
  const log = o.log || ((m) => console.log(m));
  const sair = o.sair || ((c) => process.exit(c));
  const agora = o.agora || (() => Date.now());
  const esperar = o.esperar || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const paradas = [];          /* funções que param agendas (crons, intervalos) */
  let emAndamento = null;      /* o encerramento em curso (segundo sinal = sai na hora) */

  function registrarParada(nome, fn) { paradas.push({ nome, fn }); }

  function gravar(reg) {
    try { fs.writeFileSync(ARQUIVO(), JSON.stringify(reg, null, 1)); return true; } catch (e) { log('[encerramento] não consegui registrar em ' + ARQUIVO() + ': ' + e.message); return false; }
  }

  async function encerrar(sinal) {
    if (emAndamento) {
      log('[encerramento] ' + sinal + ' de novo durante a drenagem — saindo agora');
      /* Codex #901: fecha o registro ANTES de gravar — o que ainda roda é o que foi cortado, o resto terminou a tempo */
      const reg = emAndamento.reg;
      if (!reg.fim) {
        const restam = fundo.emCurso();
        const chaves = new Set(restam.map((x) => x.servico + '@' + x.desde));
        reg.terminaram_a_tempo = reg.em_curso_no_sinal.filter((x) => !chaves.has(x.servico + '@' + x.desde)).map((x) => x.servico);
        reg.cortadas = restam.map((x) => ({ servico: x.servico, rodava_ha_s: x.segundos }));
        reg.fim = new Date(agora()).toISOString(); reg.esperou_ms = agora() - Date.parse(reg.inicio);
      }
      reg.saiu_forcado = true; gravar(reg); sair(0); return reg;
    }
    const t0 = agora();
    const reg = { sinal: String(sinal), inicio: new Date(t0).toISOString(), fim: null, agendas_paradas: [], em_curso_no_sinal: fundo.emCurso(), terminaram_a_tempo: [], cortadas: [], prazo_ms: o.prazoMs || PRAZO_MS };
    emAndamento = { reg };
    log('[encerramento] ' + sinal + ': fechando a porta — ' + reg.em_curso_no_sinal.length + ' rotina(s) de fundo em curso' + (reg.em_curso_no_sinal.length ? ' (' + reg.em_curso_no_sinal.map((x) => x.servico).join(', ') + ')' : ''));
    fundo.marcarEncerrando();
    for (const p of paradas) { try { p.fn(); reg.agendas_paradas.push(p.nome); } catch (e) { log('[encerramento] parar ' + p.nome + ': ' + e.message); } }
    if (o.server && typeof o.server.close === 'function') { try { o.server.close(); } catch (e) {} }
    /* espera o que já roda */
    const prazo = reg.prazo_ms;
    while (fundo.emCurso().length && (agora() - t0) < prazo) await esperar(o.passoMs || 250);
    const restam = fundo.emCurso();
    const nomesRestam = new Set(restam.map((x) => x.servico + '@' + x.desde));
    reg.terminaram_a_tempo = reg.em_curso_no_sinal.filter((x) => !nomesRestam.has(x.servico + '@' + x.desde)).map((x) => x.servico);
    reg.cortadas = restam.map((x) => ({ servico: x.servico, rodava_ha_s: x.segundos }));
    reg.fim = new Date(agora()).toISOString(); reg.esperou_ms = agora() - t0;
    if (reg.cortadas.length) log('[encerramento] prazo de ' + Math.round(prazo / 1000) + ' s esgotado — CORTANDO ' + reg.cortadas.map((c) => c.servico + ' (há ' + c.rodava_ha_s + ' s)').join(', ') + ' — registrado em ' + ARQUIVO() + '; volta na próxima agenda');
    else log('[encerramento] tudo drenado em ' + reg.esperou_ms + ' ms — saindo');
    gravar(reg);
    sair(0);
    return reg;
  }

  function ultimoEncerramento() { try { return JSON.parse(fs.readFileSync(ARQUIVO(), 'utf8')); } catch (e) { return null; } }
  function diagnostico() {
    let heap = null; try { heap = Math.round(require('v8').getHeapStatistics().heap_size_limit / 1048576); } catch (e) {}
    return { node: process.version, heap_limite_mb: heap, no_ar_ha_s: Math.round(process.uptime()), encerrando: fundo.encerrando(), rotinas_em_curso: fundo.emCurso(), ultimo_encerramento: ultimoEncerramento() };
  }
  function instalar() {
    for (const s of ['SIGTERM', 'SIGINT']) process.on(s, () => { encerrar(s).catch((e) => { log('[encerramento] falhou: ' + (e && e.message)); sair(0); }); });
  }
  return { encerrar, registrarParada, diagnostico, ultimoEncerramento, instalar, ARQUIVO };
}

module.exports = { criar, PRAZO_MS };
