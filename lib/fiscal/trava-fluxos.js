'use strict';

/* ─────────────────────────────────────────────────────────────────────────────
   TRAVA E ESTADO DO F1/F2 (20/10/2026) — peça única das três empresas.

   O dono (20/10): pedidos com a etiqueta liberada no ML ficaram no AGUARDANDO — o F2 não levou pro ATENDIDO. Sem acesso
   ao log, não dava pra saber se o F2 rodou, se travou ou o que decidiu de cada pedido. Duas coisas mudam aqui:
   · a TRAVA ("já em execução — pulando") tinha um furo: se uma rodada nunca termina (uma chamada sem resposta), a trava
     nunca solta e TODAS as rodadas seguintes são puladas até o servidor reiniciar. Agora, passados FLUXOS_TRAVA_MAX_MIN
     (30) minutos, a rodada nova roda mesmo assim (e conta a liberação forçada); a velha, se um dia terminar, não mexe na
     trava da nova;
   · o ESTADO de cada fluxo (última rodada, duração, erro, contagens e uma amostra do que decidiu de cada pedido) fica em
     memória e sai na rota /diagnostico/fluxos do Mover-Pedidos — dá pra ver sem caçar no log.
   ───────────────────────────────────────────────────────────────────────────── */

const { AsyncLocalStorage } = require('async_hooks');

function criarTravaFluxos(rotulo, opts) {
  const o = opts || {};
  const agora = typeof o.agoraFn === 'function' ? o.agoraFn : () => Date.now();
  const maxMs = () => Math.max(1, Number(process.env.FLUXOS_TRAVA_MAX_MIN || 30)) * 60000;
  const _rodando = {};
  const _estado = {};
  const _als = new AsyncLocalStorage();   /* quem é a rodada dona de cada chamada — anotar/decidiu da rodada velha não mexem na nova */
  const est = (f) => _estado[f] || (_estado[f] = { rodando: false, desde: null, ultimoInicio: null, ultimoFim: null, ultimaDuracaoMs: null,
    ultimoErro: null, rodadas: 0, pulados: 0, liberacoesForcadas: 0, ultimo: {}, amostra: [] });

  async function comGuard(fluxo, fn) {
    const st = est(fluxo);
    if (_rodando[fluxo]) {
      const ha = agora() - (st.desde || agora());
      if (ha < maxMs()) { st.pulados++; console.log(`[${rotulo} fluxos] ${fluxo} já em execução -- pulando`); return; }
      st.liberacoesForcadas++;
      console.warn(`[${rotulo} fluxos] ${fluxo} preso há ${Math.round(ha / 60000)} min -- liberando a trava e rodando de novo`);
    }
    const meu = {};
    _rodando[fluxo] = meu;
    st.rodando = true; st.desde = agora(); st.ultimoInicio = new Date(st.desde).toISOString(); st.ultimo = {}; st.amostra = [];
    const inicio = st.desde;
    const vigente = () => _rodando[fluxo] === meu;   /* Codex #722: só a rodada vigente escreve no estado */
    try { await _als.run({ fluxo, meu }, fn); if (vigente()) st.ultimoErro = null; }
    catch (e) { if (vigente()) st.ultimoErro = String((e && e.message) || e).slice(0, 300); throw e; }
    finally {
      if (vigente()) {
        st.ultimoFim = new Date(agora()).toISOString(); st.ultimaDuracaoMs = agora() - inicio; st.rodadas++;
        _rodando[fluxo] = false; st.rodando = false;
      }
    }
  }
  /* contagens da rodada (somadas ao que já tem) e a amostra do que foi decidido de cada pedido (até 60) */
  function _dono(fluxo) { const c = _als.getStore(); return !c || (c.fluxo === fluxo && _rodando[fluxo] === c.meu); }
  function anotar(fluxo, campos) { if (_dono(fluxo)) Object.assign(est(fluxo).ultimo, campos || {}); }
  function decidiu(fluxo, item) { if (!_dono(fluxo)) return; const a = est(fluxo).amostra; if (a.length < 60) a.push(item); }
  function estado() { return JSON.parse(JSON.stringify(_estado)); }
  return { comGuard, anotar, decidiu, estado };
}

module.exports = { criarTravaFluxos };
