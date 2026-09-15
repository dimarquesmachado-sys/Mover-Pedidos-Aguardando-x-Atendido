'use strict';

/* ─────────────────────────────────────────────────────────────────────────────
   DESCOBRIR O EMITENTE SOZINHO — menos uma coisa pra o dono digitar (15/09/2026).

   Nasceu de um atrito real e recente: ontem, ao consertar o emitente da DANFE, eu
   precisei PEDIR ao dono a razão social, o CNPJ, a IE e o endereço da GOOD. E o
   dado estava disponível o tempo todo — toda NF-e autorizada carrega o bloco
   `<emit>` no XML, e o sistema já sabe lê-lo (parseXmlNF).

   Então o sistema passa a se descobrir: na primeira NF autorizada que ele ler,
   grava os dados do emitente em disco e passa a usá-los. Numa empresa nova, isso
   significa que ninguém precisa digitar nada — basta a primeira nota sair.

   Três cuidados, e cada um vem de um erro que já aconteceu nesta casa:

   1. o dado descoberto NUNCA sobrescreve o declarado. Se alguém escreveu o
      emitente à mão, foi por um motivo; adivinhação não ganha de decisão.
   2. só aceita NF com CNPJ E razão presentes. Meio emitente é pior que nenhum —
      sai impresso incompleto e ninguém desconfia.
   3. grava por EMPRESA, no diretório dela. Um arquivo compartilhado era
      exatamente como a AMB e a GOOD acabaram imprimindo o CNPJ da Girassol.
   ──────────────────────────────────────────────────────────────────────────── */

const fs = require('fs');
const path = require('path');

function criar(cfg) {
  for (const n of ['rotulo', 'arquivo']) {
    if (!cfg || cfg[n] == null) throw new Error('lib/checkout/emitente-descobrir: falta ' + n);
  }
  const { rotulo, arquivo } = cfg;

  function lerDescoberto() {
    try { return JSON.parse(fs.readFileSync(arquivo, 'utf8')); } catch (e) { return null; }
  }

  /* Recebe o `emit` que o parseXmlNF já monta e persiste, se for confiável.
     Devolve o que ficou valendo, pra quem chamou poder logar. */
  function aprender(emit) {
    if (!emit || !emit.cnpj || !emit.razao) return null;      // meio emitente não serve
    const atual = lerDescoberto();
    if (atual && atual.cnpj === emit.cnpj) return atual;       // já sabia, nada a fazer

    if (atual && atual.cnpj !== emit.cnpj) {
      /* CNPJ diferente do que estava gravado: isso é sinal de que a pasta desta empresa
         está lendo NF de OUTRA — o erro mais caro que já apareceu aqui. Não sobrescreve
         em silêncio; grita e mantém o que tinha. */
      console.error('[' + rotulo + ' emitente] a NF trouxe CNPJ ' + emit.cnpj + ' mas o gravado é ' +
                    atual.cnpj + ' — NÃO vou sobrescrever. Se a empresa mudou de CNPJ, apague ' + arquivo +
                    '; se não mudou, esta pasta está lendo nota de outra empresa.');
      return atual;
    }

    try {
      fs.mkdirSync(path.dirname(arquivo), { recursive: true });
      fs.writeFileSync(arquivo, JSON.stringify(Object.assign({
        _origem: 'descoberto do XML de uma NF-e autorizada em ' + new Date().toISOString(),
      }, emit), null, 2));
      console.log('[' + rotulo + ' emitente] aprendido do XML da NF: ' + emit.razao + ' / ' + emit.cnpj);
    } catch (e) {
      console.warn('[' + rotulo + ' emitente] não consegui gravar em ' + arquivo + ': ' + (e.message || e));
      return null;
    }
    return emit;
  }

  /* O que vale na hora de imprimir: o DECLARADO ganha sempre; o descoberto é a rede
     pra empresa nova que ainda não teve ninguém preenchendo nada. */
  function vigente(declarado) {
    if (declarado && declarado.cnpj && declarado.razao) return declarado;
    const d = lerDescoberto();
    if (d && d.cnpj && d.razao) return d;
    return null;
  }

  return { aprender, vigente, lerDescoberto };
}

module.exports = { criar };
