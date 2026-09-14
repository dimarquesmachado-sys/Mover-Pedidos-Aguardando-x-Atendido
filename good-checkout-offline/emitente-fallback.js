'use strict';

/* ⚠️ SEM DADOS PRÓPRIOS AINDA. Até 14/09 este arquivo trazia o CNPJ e a IE da MAGAZINE
   GIRASSOL — e eles são IMPRESSOS na DANFE quando o XML não traz o emitente, ou seja, um
   documento da GOOD podia sair com o CNPJ de outra empresa.
   Enquanto a razão, o CNPJ, a IE e o endereço da GOOD não forem informados, o fallback é
   NULO de propósito: a DANFE sai sem o bloco do emitente. Documento incompleto é problema
   visível, que alguém conserta; documento com CNPJ errado é erro fiscal que passa batido. */
module.exports = null;
