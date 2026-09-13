'use strict';

/* 13/09 — FACHADA (passo 2.5, união). A Girassol entrou na lib junto com AMB e GOOD pela
   decisão do dono: "uma tem, outra não; agora ambas têm". Ela levou o getShipmentRaw pras
   outras e ganhou o baixarXmlNFe exportado, que existia aqui mas não saía do módulo. */

module.exports = require('../lib/fiscal/ml-api').criarMlApi({ rotulo: 'GIRASSOL' });
