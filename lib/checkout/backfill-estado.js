'use strict';
/* 15/11 — O ANDAMENTO E A VAGA DO BACKFILL, POR EMPRESA (norte C: zero `require` cruzado entre pastas de empresa).

   Até aqui o andamento do backfill de TODAS as empresas morava dentro de girassol-backup-offline/gbo-app.js
   (`_estadosBackfill`, `backfillEstado`, `reservarVagaBackfill`, `liberarVagaBackfill`, `backfillOcupado`): a AMB e a GOOD
   faziam `require('../girassol-backup-offline/gbo-app')` pra ler o próprio andamento. Desligar a Girassol (ou renomear a
   pasta) derrubava o backfill das outras duas. Agora o registro é esta peça, uma por processo; a Girassol registra aqui as
   travas EXTRAS dela (canário, rodada do ano, reparo de SKU) por `travaExtra`, e cada empresa só fala desta peça.

   O objeto de estado é o MESMO que o motor (lib/checkout/backfill-motor) e as rotas da empresa leem e escrevem — a
   identidade importa: quem monta pode entregar o objeto dele (`ctx.estadoBackfill`), como a AMB faz. */
const PARADO = () => ({ rodando: false, empresa: null, de: null, ate: null, pagina: 0, pedidos: 0, itens: 0, gravados: 0, erros: 0, fase: 'parado', inicio: null, fim: null, msg: '' });
const _estados = {};
const _travasExtras = {};   /* empresa → () => boolean (o que mais segura a vaga além do próprio andamento) */

/* o andamento DESTA empresa (criado parado na 1ª vez); `ctx.estadoBackfill` (objeto) passa a ser o andamento dela —
   menos o da Girassol, cujo objeto é o `_backfill` do gbo-app desde o boot (ninguém troca por ctx) */
function estado(emp, ctx) {
  const k = String(emp || 'girassol');
  if (k !== 'girassol' && ctx && ctx.estadoBackfill && typeof ctx.estadoBackfill === 'object') _estados[k] = ctx.estadoBackfill;
  if (!_estados[k]) _estados[k] = PARADO();
  return _estados[k];
}
/* zera o objeto no lugar (a identidade se mantém — quem guardou a referência continua vendo o andamento) */
function reiniciar(obj, novo) { for (const k of Object.keys(obj)) delete obj[k]; return Object.assign(obj, novo); }
/* a foto do andamento (cópia) — pra rotas e status */
function foto(emp) { return Object.assign({}, estado(emp)); }
/* quem monta a empresa diz o que MAIS segura a vaga dela (a Girassol: canário, rodada do ano, reparo de SKU) */
function travaExtra(emp, fn) { _travasExtras[String(emp || 'girassol')] = typeof fn === 'function' ? fn : null; }
function _extra(emp) { const f = _travasExtras[String(emp || 'girassol')]; try { return !!(f && f()); } catch (e) { return true; } }
/* ocupado = tudo que a vaga recusaria: o andamento rodando ou a trava extra da empresa */
function ocupado(emp) { return !!(estado(emp).rodando || _extra(emp)); }
/* a vaga do resgate (quem roda o backfill de fora do motor): false se ocupado */
function reservarVaga(msg, emp) {
  const b = estado(emp);
  if (b.rodando || _extra(emp)) return false;
  b.rodando = true; b.fase = 'resgate'; b.msg = msg || 'resgate'; return true;
}
function liberarVaga(emp) { const b = estado(emp); if (b.rodando && b.fase === 'resgate') { b.rodando = false; b.fase = 'resgate-liberado'; } }

/* 17/11 (montarCheckout, passo 22; Codex #937): o DESFECHO da última rodada MANUAL de um período (lib/checkout/
   rota-backfill-periodo), por empresa. O andamento acima é o do motor — e o motor recusa ANTES de mexer nele (o reparo de
   SKU, o canário ou a caça da Magalu rodando: `desfecho: 'adiado'`): sem isto, a rodada recusada sumia e o /backfill-status
   seguia mostrando a anterior. A GOOD guardava isso num objeto dela (`_bfGood`); agora as três, aqui. */
const _manuais = {};
function manual(emp) { const k = String(emp || 'girassol'); if (!_manuais[k]) _manuais[k] = { estado: 'nunca rodou neste processo' }; return _manuais[k]; }
function marcarManual(emp, novo) { return reiniciar(manual(emp), Object.assign({}, novo || {})); }

module.exports = { estado, reiniciar, foto, ocupado, reservarVaga, liberarVaga, travaExtra, PARADO, manual, marcarManual };
