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

let _dono = null;          // { nome, desde, sinal }
const TETO_MS = 90 * 60 * 1000;   // 90 min SEM sinal de vida: só então é rodada travada

function tentarEntrar(nome) {
  const agora = Date.now();
  /* Codex P1: o teto media desde o INÍCIO, não desde o último sinal — uma rodada legítima
     e longa (fila grande o bastante: a 1,2s/SKU, ~4.500 SKUs já passam de 90 min) tinha a
     trava tomada por baixo dela, e as duas empresas voltavam a rodar juntas — a própria
     sobreposição que esta trava existe pra evitar. E a premissa "processo que morreu sem
     soltar" nunca foi verdadeira: _dono é estado EM MEMÓRIA, um processo morto não deixa
     nada pra trás (o restart já nasce com _dono null). O que existe de verdade é rodada
     PRESA (bug que nunca chama sair()) sem o processo cair — e só o SILÊNCIO por 90 min
     prova isso; renovar() é o sinal de vida que rodada longa e viva usa pra não ser
     confundida com uma travada. */
  if (_dono && (agora - _dono.sinal) > TETO_MS) {
    console.warn('[trava-pesada] "' + _dono.nome + '" sem sinal de vida há mais de 90 min — liberando à força');
    _dono = null;
  }
  if (_dono) return { ok: false, ocupadoPor: _dono.nome, haMin: Math.round((agora - _dono.desde) / 60000) };
  _dono = { nome: String(nome || '?'), desde: agora, sinal: agora };
  return { ok: true };
}

function sair(nome) {
  if (_dono && _dono.nome === String(nome || '?')) _dono = null;
}

/* chamado de dentro do laço da rodada pesada (não por quem só está ESPERANDO a trava):
   só existe UMA trava no processo, e só o código que já está rodando sob ela tem como
   chamar isto no meio do próprio trabalho — por isso não checa nome, só renova quem
   já é dono. */
function renovar() {
  if (_dono) _dono.sinal = Date.now();
}

function quemEsta() {
  if (!_dono) return null;
  return { nome: _dono.nome, ha_min: Math.round((Date.now() - _dono.desde) / 60000) };
}

module.exports = { tentarEntrar, sair, renovar, quemEsta };
