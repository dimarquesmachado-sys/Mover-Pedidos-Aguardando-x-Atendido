'use strict';

/* 13/09 — FACHADA (passo 2.5 do plano multiloja). AMB e GOOD diferiam por UM comentário;
   a regra foi pra lib/fiscal/ml-api.js. A Girassol NÃO entrou: ela devolve o status do
   shipment além do substatus e tem getShipmentRaw — comportamento a mais, que ninguém
   decidiu portar nem apagar. Ver docs/fase2-diferencas-girassol.md. */

module.exports = require('../lib/fiscal/ml-api').criarMlApi({ rotulo: 'AMB' });
