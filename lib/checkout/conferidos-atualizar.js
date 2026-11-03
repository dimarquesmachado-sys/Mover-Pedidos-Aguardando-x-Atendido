'use strict';
/* ─────────────────────────────────────────────────────────────────────────────
   ATUALIZAR UM CONFERIDO SOBRE O ESTADO ATUAL (01/11/2026, auditoria do Codex no SHA 208fdb7d, achado F02).

   O defeito: quem finalizava/sincronizava LIA a lista de conferidos, ESPERAVA o Bling (ou o e-mail) e depois REGRAVAVA a
   lista INTEIRA que tinha lido. Tudo o que outro pedido gravou durante a espera sumia — no "verificado" (dois pedidos
   finalizados juntos: o primeiro a voltar do Bling apagava o segundo), na sincronização do ciclo (que regravava no fim a
   lista do começo, apagando os pedidos bipados durante ela) e no reenvio direto de documentos.

   A correção: depois de qualquer espera, a mudança é feita sobre a lista ATUAL do arquivo e só na entrada DAQUELE pedido —
   ler, mudar e gravar sem espera no meio (o Node não troca de tarefa no meio disso). Se a entrada sumiu durante a espera
   (desfazer, reabrir), ela NÃO é ressuscitada. */
function atualizarConferido(readJson, writeJson, arquivo, id, mudar) {
  const atual = readJson(arquivo, {}) || {};
  const chave = String(id);
  if (!atual[chave]) return false;   // sumiu durante a espera (desfazer/reabrir): não ressuscita
  mudar(atual[chave]);
  writeJson(arquivo, atual);
  return true;
}

module.exports = { atualizarConferido };
