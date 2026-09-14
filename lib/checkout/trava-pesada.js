'use strict';

/* ─────────────────────────────────────────────────────────────────────────────
   TRAVA ÚNICA DAS ROTINAS PESADAS (14/09/2026).

   Nasceu de um incidente real: 503 no /saude da Girassol às 23:16 de 13/09. Não foi
   deploy (o log mostra o anterior às 20:06 e o seguinte só no dia seguinte). Foi
   SOBREPOSIÇÃO: a rodada de custo da AMB (23h00) ainda estava em pé quando a da
   Girassol (23h15) começou, e o log mostra as duas entrelaçadas — "+SKUs do
   histórico: 6.848 linhas" de uma alternando com "28.410 linhas / fila com 1.768
   SKU(s)" da outra. A 1,2s por chamada, 1.768 SKUs são ~35 minutos de rodada; o
   heap do serviço é de 340MB e segurava os dois conjuntos ao mesmo tempo.

   O buraco de desenho: cada empresa tinha a PRÓPRIA trava e não sabia da outra.
   Separar os horários (23h00 e 23h15) ajudava, mas é combinação frágil — basta uma
   atrasar. Esta trava é do PROCESSO: enquanto uma rodada pesada estiver em pé,
   qualquer outra é adiada, não enfileirada. Adiar é de graça (o relógio tenta de
   novo em 1 min); enfileirar guardaria o trabalho na memória, que é justamente o
   recurso que faltou.
   ──────────────────────────────────────────────────────────────────────────── */

let _dono = null;          // { nome, desde }
const TETO_MS = 90 * 60 * 1000;   // 90 min: rodada que passa disso é rodada travada

function tentarEntrar(nome) {
  const agora = Date.now();
  /* dono antigo demais = processo que morreu sem soltar (ou rodada travada). Libera com
     aviso, porque um cadeado eterno seria pior que a sobreposição que ele evita. */
  if (_dono && (agora - _dono.desde) > TETO_MS) {
    console.warn('[trava-pesada] "' + _dono.nome + '" está em pé há mais de 90 min — liberando à força');
    _dono = null;
  }
  if (_dono) return { ok: false, ocupadoPor: _dono.nome, haMin: Math.round((agora - _dono.desde) / 60000) };
  _dono = { nome: String(nome || '?'), desde: agora };
  return { ok: true };
}

function sair(nome) {
  if (_dono && _dono.nome === String(nome || '?')) _dono = null;
}

function quemEsta() {
  if (!_dono) return null;
  return { nome: _dono.nome, ha_min: Math.round((Date.now() - _dono.desde) / 60000) };
}

module.exports = { tentarEntrar, sair, quemEsta };
