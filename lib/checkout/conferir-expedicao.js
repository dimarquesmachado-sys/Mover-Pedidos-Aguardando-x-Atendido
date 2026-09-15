'use strict';

/* ─────────────────────────────────────────────────────────────────────────────
   A CAPACIDADE E A ENV TÊM QUE CONCORDAR (15/09/2026).

   O dono perguntou se dá pra deixar a porta aberta pra a empresa nova ganhar um
   app de Expedição no futuro. Dá — declara `expedicao` nas capacidades e troca a
   env de VERIFICADO. O problema é que são DOIS passos, e nada obriga o segundo:

     · declarou `expedicao` mas deixou VERIFICADO = id do DESPACHADOS
       → o pedido conferido continua indo direto pra DESPACHADOS, e o app de
         Expedição nunca recebe nada pra bipar. Ninguém vê: o fluxo "funciona".

     · não declarou `expedicao` mas VERIFICADO ≠ DESPACHADOS
       → o pedido conferido para em VERIFICADO e FICA LÁ, porque não existe app
         pra movê-lo adiante. Some da esteira sem ninguém notar.

   Os dois são silenciosos, e é por isso que esta checagem existe: ela roda no
   boot e grita. Não corrige sozinha de propósito — qual dos dois lados está
   certo é decisão de operação, e adivinhar aqui seria escolher pelo dono.
   ──────────────────────────────────────────────────────────────────────────── */

function conferir(cfg) {
  const { rotulo, temExpedicao, SIT_VERIFICADO, SIT_DESPACHADOS } = cfg || {};
  const ver = Number(SIT_VERIFICADO);
  const desp = Number(SIT_DESPACHADOS);

  /* DESPACHADOS ausente ou desligado (0): não há com o que comparar, e isso já é
     tratado em outro lugar — aqui só avisamos se a Expedição depende dele. */
  if (!desp) {
    if (temExpedicao) return { ok: true };
    return { ok: true, nota: 'sem DESPACHADOS configurado não dá pra conferir a coerência com a Expedição' };
  }
  if (!ver) return { ok: true, nota: 'sem VERIFICADO configurado não dá pra conferir' };

  if (temExpedicao && ver === desp) {
    return { ok: false, aviso:
      '[' + rotulo + '] INCOERENTE: esta empresa DECLARA a capacidade "expedicao", mas o destino do pedido ' +
      'conferido é ' + ver + ', que é o próprio DESPACHADOS. Com Expedição o conferido deve ir pra VERIFICADO ' +
      'e o app move pra DESPACHADOS depois — do jeito que está, o app de Expedição nunca recebe nada pra bipar.' };
  }
  if (!temExpedicao && ver !== desp) {
    return { ok: false, aviso:
      '[' + rotulo + '] INCOERENTE: esta empresa NÃO declara "expedicao", mas o destino do pedido conferido é ' +
      ver + ' em vez de ' + desp + ' (DESPACHADOS). Sem app de Expedição não existe etapa seguinte: o pedido ' +
      'conferido vai ficar parado nesse estado, sumindo da esteira sem ninguém notar.' };
  }
  return { ok: true };
}

module.exports = { conferir };
