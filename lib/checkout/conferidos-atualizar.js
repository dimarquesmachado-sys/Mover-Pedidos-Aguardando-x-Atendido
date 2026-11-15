'use strict';
/* ─────────────────────────────────────────────────────────────────────────────
   ATUALIZAR UM CONFERIDO SOBRE O ESTADO ATUAL (01/11/2026, auditoria do Codex no SHA 208fdb7d, achado F02).

   O defeito: quem finalizava/sincronizava LIA a lista de conferidos, ESPERAVA o Bling (ou o e-mail) e depois REGRAVAVA a
   lista INTEIRA que tinha lido. Tudo o que outro pedido gravou durante a espera sumia — no "verificado" (dois pedidos
   finalizados juntos: o primeiro a voltar do Bling apagava o segundo), na sincronização do ciclo (que regravava no fim a
   lista do começo, apagando os pedidos bipados durante ela) e no reenvio direto de documentos.

   A correção: depois de qualquer espera, a mudança é feita sobre a lista ATUAL do arquivo e só na entrada DAQUELE pedido —
   ler, mudar e gravar sem espera no meio (o Node não troca de tarefa no meio disso). Se a entrada sumiu durante a espera
   (desfazer, reabrir), ela NÃO é ressuscitada.

   15/11 (auditoria do Codex, P1 nº 7): a GERAÇÃO. Cada finalização ganha um `geracao` próprio (rotas-conferido). Quem
   esperou o Bling passa a geração que viu ANTES da espera: se o pedido foi reaberto e finalizado DE NOVO no meio, a
   entrada atual é de outra geração e o resultado velho NÃO a marca (um "sincronizado" da finalização antiga não pode
   valer pra nova). Entrada antiga sem `geracao` (de antes desta versão) casa só com `geracao` ausente.
   Devolve: true = mudou e GRAVOU · false = entrada ausente, de outra geração, ou a gravação falhou (writeJson false). */
function atualizarConferido(readJson, writeJson, arquivo, id, mudar, geracao) {
  const atual = readJson(arquivo, {}) || {};
  const chave = String(id);
  if (!atual[chave]) return false;   // sumiu durante a espera (desfazer/reabrir): não ressuscita
  if (geracao !== undefined && String(atual[chave].geracao || '') !== String(geracao || '')) return false;   // é OUTRA finalização
  mudar(atual[chave]);
  return writeJson(arquivo, atual) !== false;
}

/* a geração de uma finalização nova: única por processo e por instante */
function novaGeracao() {
  return new Date().toISOString() + ':' + require('crypto').randomBytes(4).toString('hex');
}

module.exports = { atualizarConferido, novaGeracao };
